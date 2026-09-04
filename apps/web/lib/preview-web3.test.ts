import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewConfig, previewQueryDefaults } from './preview-web3.ts';

await test('every preview chain rejects app RPC without attempting fetch', async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('Network must not be used.');
  };
  try {
    const config = createPreviewConfig();
    assert.equal(config.storage, null);
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
