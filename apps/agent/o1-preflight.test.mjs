import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from 'viem';
import { o1Fixture } from './o1-fixture.mjs';
import { preflightO1 } from './o1-preflight.mjs';
const limits = { maxGas: '8000000', maxGasPriceWei: '1000000000000', maxTransactionWei: '50000000000000000' };
const run = f => preflightO1(f.plan, f.input, f.published, f.profile, f.rpc, limits, f.baseFeeOracle);
for (const chain of [4663, 8453]) {
  test(`O1 ${chain} validates exact launch`, async () => { const f = o1Fixture(chain); assert.equal(await run(f), chain === 8453 ? 31500n : 30100n); });
  for (const [name, mutate] of [
    ['draft', f => { f.input.draft.name = 'Changed'; }],
    ['metadata', f => { f.published.ipfs.imageCid = `b${'a'.repeat(58)}`; }],
    ['mutable', f => { f.input.editableMetadata = true; }],
    ['chain', f => { f.changes.eth_chainId = toHex(1); }],
    ['fee', f => { f.changes.nativeLaunchFee = 101n; }],
    ['supply', f => { f.changes.launchSupply = 10n ** 26n; }],
    ['config', f => { f.changes.configVersion = 2n; }],
    ['disabled', f => { f.changes.launchCreationEnabled = false; }],
    ['binding', f => { f.changes.hook = toHex(100n, { size: 20 }); }],
    ['quote', f => { f.changes.quoteConfig = [false, 18, 0]; }],
    ['nonce', f => { f.changes.eth_getTransactionCount = toHex(1); }],
    ['balance', f => { f.changes.eth_getBalance = toHex(0); }],
    ['gas', f => { f.plan.transaction.gas = toHex(30001); }],
    ['simulation', f => { f.changes.createLaunch = [toHex(999n, { size: 20 }), f.plan.predictedPool]; }],
  ]) test(`O1 ${chain} rejects changed ${name}`, async () => { const f = o1Fixture(chain); mutate(f); await assert.rejects(run(f)); });
}
for (const [name, mutate] of [
  ['activation', f => { f.changes.isActivated = false; }],
  ['B20 occupied', f => { f.changes.isB20Initialized = true; }],
  ['L1 fee', f => { f.changes.getL1Fee = 1001n; }],
  ['operator fee', f => { f.changes.getOperatorFee = 201n; }],
  ['oracle', f => { f.baseFeeOracle = undefined; }],
]) test(`O1 Base rejects ${name}`, async () => { const f = o1Fixture(8453); mutate(f); await assert.rejects(run(f)); });
test('O1 Robinhood rejects changed init code', async () => { const f = o1Fixture(); f.changes.launchTokenBytecodeHash = toHex(123n, { size: 32 }); await assert.rejects(run(f)); });

for (const chain of [4663, 8453]) test(`O1 ${chain} verifies non-native quote`, async () => { const f = o1Fixture(chain, true); assert.equal(await run(f), chain === 8453 ? 31500n : 30100n); });
