import test from 'node:test';
import assert from 'node:assert/strict';
import { LongRecovery } from './long-recovery.mjs';
const hash = `0x${'a'.repeat(64)}`, from = `0x${'b'.repeat(40)}`;
function fixture({ latest = 2, pending = latest, reorg = false, chain = '0x1237' } = {}) {
  const calls = [];
  const rpc = { batch: async (_chain, entries) => entries.map((e) => {
    calls.push(e);
    if (e.method === 'eth_chainId') return chain;
    if (e.method === 'eth_getTransactionCount') {
      const block = e.params[1];
      return '0x' + (block === 'pending' ? pending : block === 'latest' ? latest : BigInt(block) >= 50123n ? 2 : 1).toString(16);
    }
    if (e.method === 'eth_getBlockByNumber') {
      const number = e.params[0] === 'latest' ? '0xffff' : e.params[0];
      return { number, hash: reorg && e.params[0] !== 'latest' ? `0x${'c'.repeat(64)}` : hash,
        transactions: [{ from, nonce: '0x1', hash, blockHash: hash }] };
    }
    throw new Error('unexpected RPC');
  }) };
  return { recovery: new LongRecovery(rpc), calls };
}
test('an unused nonce permits a retry; pending or earlier nonces do not', async () => {
  for (const [latest, pending, status] of [[1, 1, 'retryable'], [1, 2, 'submitted'], [0, 0, 'submitted']]) {
    const f = fixture({ latest, pending });
    assert.deepEqual(await f.recovery.find('id', { from, nonce: '0x1' }), { status });
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every((c) => !/send|sign/.test(c.method)));
  }
});
test('lost hash recovery finds the original nonce across bounded polls without wallet input', async () => {
  const f = fixture(); let result;
  for (let i = 0; i < 4; i++) {
    const before = f.calls.length;
    result = await f.recovery.find('id', { from, nonce: '0x1' });
    assert.ok(f.calls.length - before <= 11);
    if (result.hash) break;
    assert.equal(result.status, 'locating');
  }
  assert.equal(result.hash, hash);
  assert.ok(f.calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === '0xc3cb' && c.params[1] === true));
});
test('a changed canonical search anchor never produces a trusted transaction hash', async () => {
  const f = fixture({ reorg: true });
  for (let i = 0; i < 3; i++) assert.equal((await f.recovery.find('id', { from, nonce: '0x1' })).hash, undefined);
  assert.equal(f.recovery.searches.size, 0);
});
test('wrong-chain reads cannot make a launch retryable', async () => {
  const f = fixture({ latest: 1, chain: '0x1' });
  await assert.rejects(f.recovery.find('id', { from, nonce: '0x1' }), /wrong_chain/);
});
