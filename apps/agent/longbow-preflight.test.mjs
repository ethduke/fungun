import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, toHex, zeroAddress } from 'viem';
import { LONG_CREATE_ABI, LONG_TOKEN_PARAMETERS, LONG_POOL_PARAMETERS } from '../web/lib/long-encoding/long-launch.mjs';
import { preflightLongbow } from './longbow-preflight.mjs';
import { longbowFixture, syntheticAddress } from './longbow-fixture.mjs';
const limits = { maxGas: '3000000', maxGasPriceWei: '1000000000000', maxTransactionWei: '50000000000000000' };
const run = f => preflightLongbow(f.plan, f.input, f.published, f.profile, f.rpc, limits);
test('Longbow independently binds canonical asset, 99% sale, 1% platform allocation and creator fees', async () => {
  const f = longbowFixture();
  assert.equal(await run(f), 30000n);
  const [create] = decodeFunctionData({ abi: LONG_CREATE_ABI, data: f.plan.transaction.data }).args;
  assert.equal(create.numTokensToSell * 100n, create.initialSupply * 99n);
  const token = decodeAbiParameters(LONG_TOKEN_PARAMETERS, create.tokenFactoryData);
  assert.deepEqual(token[3].map(a => a.toLowerCase()), [f.profile.platformAllocation]);
  assert.deepEqual(token[5], [create.initialSupply / 100n]);
  const [pool] = decodeAbiParameters(LONG_POOL_PARAMETERS, create.poolInitializerData);
  assert.equal(pool.beneficiaries.find(b => b.beneficiary.toLowerCase() === f.input.wallet).shares, 95n * 10n ** 16n);
  assert.ok(f.calls.every(c => !/send/i.test(c.method)));
});
for (const [name, modify, error] of [
  ['Base input', f => f.input.chainId = 8453, 'launch_transaction_changed'],
  ['missing marker', f => delete f.input.draft.launchpad, 'launch_transaction_changed'],
  ['other pair namespace', f => f.input.pairId = 'long-EXAMPLE', 'launch_transaction_changed'],
  ['RPC chain', f => f.changes.eth_chainId = toHex(8453), 'wrong_chain'],
  ['code drift', f => f.changes.eth_getCode = '0x6002', 'contract_unverified'],
  ['registry airlock', f => f.changes.AIRLOCK = syntheticAddress(999), 'contract_unverified'],
  ['registry factory', f => f.changes.TRUSTED_TOKEN_FACTORY = syntheticAddress(999), 'contract_unverified'],
  ['registry reservation period', f => f.changes.RESERVATION_DURATION = 1, 'contract_unverified'],
  ['paused registry', f => f.changes.paused = true, 'contract_unverified'],
  ['disabled module', f => f.changes.getModuleState = 0, 'contract_unverified'],
  ['token decimals', f => f.changes.decimals = 6, 'contract_unverified'],
  ['reserved ticker', f => f.changes.isTickerAvailable = false, 'ticker_reserved'],
  ['nonce drift', f => f.changes.eth_getTransactionCount = toHex(1), 'nonce_changed'],
  ['balance', f => f.changes.eth_getBalance = toHex(29999), 'insufficient_funds'],
  ['value', f => f.plan.transaction.value = toHex(1), 'launch_transaction_changed'],
  ['calldata', f => f.plan.transaction.data += '00', 'launch_transaction_changed'],
  ['extra tx field', f => f.plan.transaction.accessList = [], 'launch_transaction_changed'],
  ['fee', f => f.plan.launchpadFeeWei = '1', 'launch_transaction_changed'],
  ['review allocation', f => f.plan.review = { ...f.plan.review, tokensForSale: f.plan.review.totalSupply }, 'launch_transaction_changed'],
  ['intent', f => f.plan.intentId = f.plan.intentId.replace(/a/g, 'b'), 'launch_transaction_changed'],
  ['missing salt attempt', f => delete f.plan.saltAttempt, 'launch_transaction_changed'],
  ['gas cap', f => f.plan.transaction.gas = toHex(3000001), 'spend_limit'],
  ['zero estimate', f => f.plan.estimatedGas = '0', 'spend_limit'],
  ['gas maximum', f => f.plan.maximumGasWei = '1', 'spend_limit'],
  ['expiry', f => f.plan.expiresAt = Date.now() - 1, 'quote_expired'],
  ['future quote', f => { f.plan.quotedAt = Date.now() + 10000; f.plan.expiresAt = f.plan.quotedAt + 30000; }, 'quote_expired'],
  ['simulation asset', f => f.changes.create = [syntheticAddress(999), f.plan.predictedPool, zeroAddress, zeroAddress, zeroAddress], 'launch_simulation_failed'],
]) test(`Longbow rejects ${name}`, async () => { const f = longbowFixture(); modify(f); await assert.rejects(run(f), { message: error }); });
test('Longbow rejects reallocated calldata and independently changed profile recipient', async () => {
  const f = longbowFixture();
  const [create] = decodeFunctionData({ abi: LONG_CREATE_ABI, data: f.plan.transaction.data }).args;
  f.plan.transaction.data = encodeFunctionData({ abi: LONG_CREATE_ABI, functionName: 'create', args: [{ ...create, numTokensToSell: create.initialSupply }] });
  await assert.rejects(run(f), /launch_transaction_changed/);
  const g = longbowFixture();
  g.plan.profile = { ...g.profile, platformAllocation: syntheticAddress(999) };
  await assert.rejects(run(g), /contract_unverified/);
});
