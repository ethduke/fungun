import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, toHex, zeroAddress } from 'viem';
import { PONS_ABI } from '../web/lib/long-encoding/pons-launch.mjs';
import { preflightPons } from './pons-preflight.mjs';
import { ponsFixture, syntheticAddress } from './pons-fixture.mjs';
const limits = { maxGas: '8000000', maxGasPriceWei: '1000000000000', maxTransactionWei: '50000000000000000' };
const run = f => preflightPons(f.plan, f.input, f.published, f.profile, f.rpc, f.limits ?? limits);
test('Pons independently verifies live economics, pinned dependencies and complete native cost', async () => {
  const f = ponsFixture(); assert.equal(await run(f), 31000n);
  assert.ok(f.calls.some(c => c.method === 'eth_call'));
});
test('Pons binds approved optional links and enforces zero creator tax, no opening buy and no buyback', async () => {
  const f = ponsFixture();
  f.input.draft.website = 'https://sample.example/'; f.input.draft.twitter = 'https://x.com/sample';
  f.plan = f.planFor(); assert.equal(await run(f), 31000n);
  const { args } = decodeFunctionData({ abi: PONS_ABI, data: f.plan.transaction.data });
  assert.deepEqual(args[0].socials, { website: f.input.draft.website, twitter: f.input.draft.twitter, telegram: '', discord: '', farcaster: '' });
  assert.equal(args[0].creatorTaxBps, 0); assert.equal(args[0].buybackEnabled, false);
  assert.equal(BigInt(f.plan.transaction.value), 1000n); assert.equal(args[2], zeroAddress);
});
for (const [name, modify, error] of [
  ['wrong chain', f => f.changes.eth_chainId = toHex(8453), 'wrong_chain'],
  ['code drift', f => f.changes.eth_getCode = '0x6002', 'contract_unverified'],
  ['module drift', f => f.changes.memeHook = syntheticAddress(999), 'contract_unverified'],
  ['disabled config', f => f.config.enabled = false, 'pons_launch_disabled'],
  ['restricted launcher', f => f.changes.canLaunch = false, 'pons_launch_restricted'],
  ['changed supply', f => f.config.supply += 1n, 'launch_transaction_changed'],
  ['changed graduation', f => f.config.graduationThreshold += 1n, 'launch_transaction_changed'],
  ['changed economics', f => f.changes.previewLaunchEconomics = toHex(9n, { size: 32 }), 'launch_transaction_changed'],
  ['changed fee', f => f.changes.launchFee = 1001n, 'launch_transaction_changed'],
  ['contract wallet', f => f.changes.walletCode = '0x6001', 'launch_eoa_required'],
  ['nonce changed', f => f.changes.eth_getTransactionCount = toHex(1), 'nonce_changed'],
  ['insufficient balance including launch fee', f => f.changes.eth_getBalance = toHex(30999), 'insufficient_funds'],
  ['gas padding', f => f.plan.transaction.gas = toHex(30001), 'spend_limit'],
  ['total cost cap including launch fee', f => f.limits = { ...limits, maxTransactionWei: '30999' }, 'spend_limit'],
  ['calldata altered', f => f.plan.transaction.data += '00', 'launch_transaction_changed'],
  ['extra tx field', f => f.plan.transaction.authorizationList = [], 'launch_transaction_changed'],
  ['draft changed', f => f.input.draft.name = 'Changed', 'launch_transaction_changed'],
  ['image changed', f => f.plan.ponsBuildInput.imageUri = f.plan.ponsBuildInput.imageUri + 'a', 'launch_transaction_changed'],
  ['intent changed', f => f.plan.ponsBuildInput.intentId = 'b'.repeat(64), 'launch_transaction_changed'],
  ['zero simulated token', f => f.changes.launchToken = [zeroAddress, f.plan.predictedPool], 'launch_simulation_failed'],
  ['identical predicted addresses', f => f.plan.predictedPool = f.plan.predictedAsset, 'launch_simulation_failed'],
  ['different simulated curve', f => f.changes.launchToken = [f.plan.predictedAsset, syntheticAddress(999)], 'launch_simulation_failed'],
  ['expired plan', f => f.plan.expiresAt = Date.now() - 1, 'quote_expired'],
]) test(`Pons rejects ${name}`, async () => { const f = ponsFixture(); modify(f); await assert.rejects(run(f), { message: error }); });

test('Pons draft binding accepts equivalent API-normalized property ordering', async () => {
  const f = ponsFixture();
  f.input.draft = { twitter: 'https://x.com/sample', website: 'https://sample.example/', description: '', ticker: 'SAMPLE', name: 'Sample' };
  f.plan = f.planFor();
  f.plan.ponsBuildInput.draft = { name: 'Sample', ticker: 'SAMPLE', description: '', website: 'https://sample.example/', twitter: 'https://x.com/sample' };
  assert.equal(await run(f), 31000n);
  f.plan.ponsBuildInput.draft.twitter = 'https://x.com/changed';
  await assert.rejects(run(f), { message: 'launch_transaction_changed' });
});

test('Pons accepts checksum signer address and lowercased API wallet as the same identity', async () => {
  const f = ponsFixture();
  f.input.wallet = getAddress(syntheticAddress(123456789));
  f.plan = f.planFor();
  f.plan.ponsBuildInput.wallet = f.input.wallet.toLowerCase();
  assert.notEqual(f.input.wallet, f.plan.ponsBuildInput.wallet);
  assert.equal(await run(f), 31000n);
  f.plan.ponsBuildInput.wallet = syntheticAddress(999);
  await assert.rejects(run(f), { message: 'launch_transaction_changed' });
});
