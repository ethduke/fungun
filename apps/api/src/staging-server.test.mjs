import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { assertStagingRuntime, stagingServer } from './staging-server.mjs';

test('mock staging entry refuses production identities and provider or wallet credentials', () => {
  const env = { FLY_APP_NAME: 'farmgun-staging-api', FUNGUN_STAGING: 'mock', APP_ORIGIN: 'https://farmgun-staging-web.fly.dev' };
  assert.doesNotThrow(() => assertStagingRuntime(env));
  for (const extra of [{ FLY_APP_NAME: 'farmgun-api' }, { FUNGUN_STAGING: '' },
    { APP_ORIGIN: 'https://farmgun.fun' }, { PRIVATE_KEY: 'EXAMPLE' }, { BASE_RPC_URL: 'EXAMPLE' }, { O1_API_KEY: 'EXAMPLE' }])
    assert.throws(() => assertStagingRuntime({ ...env, ...extra }));
});

test('deployed mock boundary validates input and cannot produce or send a transaction', async t => {
  const origin = 'https://farmgun-staging-web.fly.dev';
  const server = stagingServer(origin);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Staging must not contact any provider');
  t.after(() => { globalThis.fetch = original; });
  const call = (path, body, source = origin) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: body ? 'POST' : 'GET', headers: { origin: source, 'content-type': 'application/json', 'x-fungun-intent': path.slice(4) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const health = await call('/healthz');
  assert.deepEqual(health.body, { status: 'ok' });
  assert.equal(health.headers['x-fungun-staging'], 'mock');
  const input = { chainId: 4663, wallet: `0x${'1'.repeat(40)}`, pairId: 'long-NVDA',
    draft: { name: 'Sample', ticker: 'SAMPLE', description: 'Mock smoke test' },
    publication: { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: 'c'.repeat(64) } };
  const prepared = await call('/v1/launch-prepare', input);
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.mode, 'mock');
  assert.equal(prepared.body.status, 'staging_only');
  assert.deepEqual(prepared.body.transactions, []);
  assert.ok(!JSON.stringify(prepared.body).includes(input.wallet));
  assert.equal((await call('/v1/launch-prepare', { ...input, transaction: '0x1234' })).status, 400);
  assert.equal((await call('/v1/launch-prepare', input, 'https://farmgun.fun')).status, 403);
  assert.equal((await call('/v1/launch-send', input)).status, 404);
  assert.equal((await call('/v1/claim-prepare', { address: input.wallet, positionId: 'a'.repeat(64) })).status, 503);
});
