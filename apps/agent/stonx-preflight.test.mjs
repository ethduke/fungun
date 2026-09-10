import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { preflight, validateSigned } from './preflight.mjs';
import { defaultLimits } from './index.mjs';
import { stonxFixture, syntheticAddress } from './stonx-fixture.mjs';
const run = f => preflight(f.plan, f.input, f.published, f.profile, f.rpc, defaultLimits, f.baseFeeOracle);
test('Stonx independently rebuilds and verifies Base pins, bindings and all network fees', async () => {
  const f = stonxFixture();
  assert.equal(await run(f), 31400n);
  assert.ok(f.calls.some(c => c.method === 'eth_call'));
});
for (const [name, modify, error] of [
  ['wrong chain', f => f.changes.eth_chainId = toHex(4663), 'wrong_chain'],
  ['RPC bytecode drift', f => f.changes.eth_getCode = '0x6002', 'contract_unverified'],
  ['beacon upgrade', f => f.changes.implementation = syntheticAddress(999), 'contract_unverified'],
  ['module disabled', f => f.changes.getModuleState = 0, 'contract_unverified'],
  ['owner changed', f => f.changes.owner = syntheticAddress(999), 'contract_unverified'],
  ['pool binding changed', f => f.changes.poolManager = syntheticAddress(999), 'contract_unverified'],
  ['oracle missing', f => f.baseFeeOracle = undefined, 'contract_unverified'],
  ['L1 fee understated', f => f.changes.getL1Fee = 1001n, 'spend_limit'],
  ['operator fee understated', f => f.changes.getOperatorFee = 201n, 'spend_limit'],
  ['fees omitted', f => delete f.plan.baseFees, 'spend_limit'],
  ['fees malformed', f => f.plan.baseFees.l1DataFeeWei = '-1', 'spend_limit'],
  ['fee cap', f => f.plan.maximumGasWei = '30000', 'spend_limit'],
  ['nonce changed', f => f.changes.eth_getTransactionCount = toHex(1), 'nonce_changed'],
  ['insufficient Base balance including fees', f => f.changes.eth_getBalance = toHex(31400n - 1n), 'insufficient_funds'],
  ['calldata altered', f => f.plan.transaction.data += '00', 'launch_transaction_changed'],
  ['prohibited tx field', f => f.plan.transaction.authorizationList = [], 'launch_transaction_changed'],
  ['input wallet changed', f => f.input.wallet = syntheticAddress(999), 'launch_transaction_changed'],
  ['input metadata changed', f => f.input.draft.name = 'Changed', 'launch_transaction_changed'],
  ['intent changed', f => f.plan.stonxBuildInput.intentId = 'b'.repeat(64), 'launch_transaction_changed'],
  ['expiry', f => f.plan.expiresAt = Date.now() - 1, 'quote_expired'],
]) test(`Stonx rejects ${name}`, async () => {
  const f = stonxFixture(); modify(f); await assert.rejects(run(f), { message: error });
});
test('signed transaction chain follows allowlisted expected chain', async () => {
  const account = privateKeyToAccount(toHex(123n, { size: 32 }));
  const tx = { chainId: toHex(8453), to: syntheticAddress(20), data: '0x01', value: '0x0', gas: toHex(21000), gasPrice: '0x1', nonce: '0x0' };
  const sign = chainId => account.signTransaction({ type: 'legacy', chainId, to: tx.to, data: tx.data, value: 0n, gas: 21000n, gasPrice: 1n, nonce: 0 });
  assert.match(validateSigned(await sign(8453), tx), /^0x/);
  assert.throws(() => validateSigned('0x', tx));
  assert.throws(() => validateSigned('', { ...tx, chainId: toHex(1) }));
  const wrong = await sign(4663);
  assert.throws(() => validateSigned(wrong, tx), { message: 'launch_transaction_changed' });
  const unsupported = await sign(1);
  assert.throws(() => validateSigned(unsupported, { ...tx, chainId: toHex(1) }), { message: 'launch_transaction_changed' });
});
