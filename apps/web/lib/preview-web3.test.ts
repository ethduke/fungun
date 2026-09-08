import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewConfig, previewQueryDefaults } from './preview-web3.ts';
import { connect, disconnect, getConnection, reconnect } from 'wagmi/actions';
import { injected } from 'wagmi/connectors';
import type { EIP1193Provider } from 'viem';
import { hasPreviousWalletConnection, walletStorage } from './connection-session.ts';

await test('every preview chain rejects app RPC without attempting fetch', async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('Network must not be used.');
  };
  try {
    const config = createPreviewConfig();
    assert.deepEqual(
      config.chains.map((chain) => chain.id),
      [4663, 8453],
    );
    assert.equal(config.storage?.key, 'fungun.wallet');
    assert.equal(config._internal.ssr, false);
    assert.equal(config.connectors.length, 0);
    for (const chain of config.chains)
      await assert.rejects(
        config
          .getClient({ chainId: chain.id })
          .request({ method: 'eth_blockNumber' }),
        /disabled/,
      );
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

await test('background refetches and automatic retries are off', () => {
  assert.equal(previewQueryDefaults.queries.refetchInterval, false);
  assert.equal(previewQueryDefaults.queries.refetchOnMount, false);
  assert.equal(previewQueryDefaults.queries.refetchOnReconnect, false);
  assert.equal(previewQueryDefaults.queries.refetchOnWindowFocus, false);
  assert.equal(previewQueryDefaults.queries.retry, false);
  assert.equal(previewQueryDefaults.mutations.retry, false);
});

await test('a fresh page restores the wallet silently and respects disconnect and revoked access', async (t) => {
  const stored = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const address = `0x${'11'.repeat(20)}`;
  let accounts = [address];
  const requests: string[] = [];
  const provider = {
    on() {},
    removeListener() {},
    async request({ method }: { method: string }) {
      requests.push(method);
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return accounts;
      if (method === 'eth_chainId') return '0x2105';
      // Exercise the disconnect shim for wallets without revokePermissions.
      throw new Error(`Unsupported: ${method}`);
    },
  } as unknown as EIP1193Provider;
  const connector = () => injected({
    target: { id: 'test-wallet', name: 'Test Wallet', provider },
  });
  const configs: ReturnType<typeof createPreviewConfig>[] = [];
  const freshPage = async () => {
    const config = createPreviewConfig();
    configs.push(config);
    return config;
  };
  try {
    assert.equal(hasPreviousWalletConnection(), false);
    const launch = await freshPage();
    await connect(launch, { connector: connector() });
    assert.equal(hasPreviousWalletConnection(), true);

    requests.length = 0;
    const fees = await freshPage();
    await reconnect(fees, { connectors: [connector()] });
    assert.equal(getConnection(fees).address, address);
    assert.equal(getConnection(fees).chainId, 8453);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((method) => ['eth_accounts', 'eth_chainId'].includes(method)));

    await disconnect(fees);
    requests.length = 0;
    const backToLaunch = await freshPage();
    await reconnect(backToLaunch, { connectors: [connector()] });
    assert.equal(getConnection(backToLaunch).isConnected, false);
    assert.deepEqual(requests, []);

    await connect(backToLaunch, { connector: connector() });
    accounts = [];
    requests.length = 0;
    const revoked = await freshPage();
    await reconnect(revoked, { connectors: [connector()] });
    assert.equal(getConnection(revoked).isConnected, false);
    assert.ok(requests.every((method) => method === 'eth_accounts'));
  } finally {
    for (const config of configs) config._internal.mipd?.destroy();
  }
});

await test('wallet persistence tolerates unavailable browser storage', (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { get localStorage() { throw new Error('Storage blocked'); } },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  assert.equal(hasPreviousWalletConnection(), false);
  assert.doesNotThrow(() => walletStorage.setItem('test', 'value'));
  assert.doesNotThrow(() => walletStorage.removeItem('test'));
});
