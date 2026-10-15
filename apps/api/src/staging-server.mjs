import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Budget } from './budget.mjs';
import { createHandler } from './service.mjs';
import { ServiceError } from './errors.mjs';

export function assertStagingRuntime(env) {
  if (env.FLY_APP_NAME !== 'farmgun-staging-api' || env.FUNGUN_STAGING !== 'mock'
    || env.APP_ORIGIN !== 'https://farmgun-staging-web.fly.dev'
    || Object.entries(env).some(([name, value]) => value && /PRIVATE_KEY|MNEMONIC|SEED_PHRASE|RPC_URL|RPC_ENDPOINT|API_KEY|WALLET_CLAIMS/.test(name)))
    throw new Error('Staging runtime configuration required.');
}

// Deliberately does not instantiate Upstream, Launches, a facilitator, or a wallet.
// It exercises the real HTTP validation boundary with an ephemeral request budget.
export function stagingServer(origin) {
  const budget = new Budget(':memory:');
  const disabled = () => { throw new ServiceError('not_configured'); };
  const adapters = {
    async catalog(chainId) {
      const unavailable = { status: 'unavailable', pairs: [] };
      return { chainId, mode: 'mock', expiresAt: Date.now() + 60_000,
        pads: chainId === 4663 ? { o1: unavailable, long: unavailable } : { o1: unavailable, stonks: unavailable } };
    },
    async ticker(chainId, ticker, pads) {
      return { chainId, ticker, mode: 'mock', results: Object.fromEntries(
        pads.map(pad => [pad, { status: 'unverified', reason: 'not_configured' }]),
      ) };
    },
  };
  const launches = {
    async run(kind, input) {
      if (kind !== 'launch-prepare' && kind !== 'launch-estimate') return disabled();
      return { mode: 'mock', status: 'staging_only', transactions: [],
        id: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    },
  };
  const handler = createHandler({ origin }, budget, adapters,
    { list: async () => ({ mode: 'mock', status: 'unavailable', positions: [] }), prepare: disabled },
    { list: disabled }, launches, { snapshot: () => ({ mode: 'mock', events: [] }) }, { get: disabled });
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader('x-fungun-staging', 'mock');
    response.setHeader('x-robots-tag', 'noindex, nofollow');
    return handler(request, response);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  server.once('close', () => budget.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertStagingRuntime(process.env);
    const server = stagingServer(process.env.APP_ORIGIN);
    server.on('error', () => { console.error('Staging API unavailable.'); process.exitCode = 1; });
    server.listen(8787, '0.0.0.0', () => console.log('Mock staging API ready.'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
      setTimeout(() => process.exit(1), 25_000).unref();
    });
  } catch {
    console.error('Staging API configuration rejected.');
    process.exitCode = 1;
  }
}
