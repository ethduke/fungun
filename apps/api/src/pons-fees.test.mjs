import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex, zeroAddress } from 'viem';
import { readConfig } from './config.mjs';
import { Fees } from './fees.mjs';
import { validateInput } from './service.mjs';
import { apiEnvironment } from './runtime-env.mjs';
import { runtimeStatus } from './runtime-status.mjs';
import { readPonsFeeProfile, ponsEscrowAbi } from './pons-fees.mjs';

const addr = digit => `0x${digit.repeat(40)}`;
const owner = addr('a');
const bytecode = '0x60016000';
const profile = () => ({ chainId: 4663, escrow: { address: addr('1'), codeHash: keccak256(bytecode) }, assets: [{ address: addr('2'), symbol: 'QUOTE', decimals: 6 }] });
function fixture(options = {}) {
  const config = { ...readConfig({ PONS_FEE_PROFILE_JSON: JSON.stringify(profile()) }), rpcUrl: 'EXAMPLE', feesEnabled: true, claimsEnabled: true, ...options.config };
  let calls = 0;
  const upstream = { async json(provider, _url, request) {
    if (provider === 'market') return { data: { base: 'ETH', currency: 'USD', amount: '2000' } };
    return JSON.parse(request.body).map(call => {
      calls++;
      let result;
      if (call.method === 'eth_chainId') result = toHex(options.chain ?? 4663);
      else if (call.method === 'eth_blockNumber') result = '0x100';
      else if (call.method === 'eth_getCode') result = options.changedCode ? '0x6000' : bytecode;
      else if (call.method === 'eth_getBalance') result = toHex(options.balance ?? 10n ** 18n);
      else if (call.method === 'eth_gasPrice') result = '0x64';
      else if (call.method === 'eth_estimateGas') result = '0x186a0';
      else if (call.method === 'eth_call') {
        const decoded = decodeFunctionData({ abi: ponsEscrowAbi, data: call.params[0].data });
        if (options.reverted || (options.claimReverted && ['claim', 'claimToken'].includes(decoded.functionName)))
          return { jsonrpc: '2.0', id: call.id, error: { code: 3, message: 'execution reverted' } };
        const amount = options.owed ?? 100n;
        result = encodeFunctionResult({ abi: ponsEscrowAbi, functionName: decoded.functionName, result: amount });
      } else throw Error(call.method);
      return { jsonrpc: '2.0', id: call.id, result };
    });
  } };
  return { config, options, service: new Fees(config, upstream), count: () => calls };
}
const input = { address: owner, chainId: 4663, padId: 'pons' };

test('Pons fee profile is independent of launching, bounded, and server-only', () => {
  assert.equal(readPonsFeeProfile(), null);
  const valid = profile();
  for (const invalid of [[], {}, { ...valid, chainId: 8453 }, { ...valid, escrow: { ...valid.escrow, codeHash: 'bad' } }, { ...valid, assets: [...valid.assets, ...valid.assets] }, { ...valid, assets: [{ ...valid.assets[0], address: zeroAddress }] }, { ...valid, assets: [{ ...valid.assets[0], decimals: 37 }] }])
    assert.throws(() => readPonsFeeProfile(JSON.stringify(invalid)), /invalid_fee_configuration/);
  const env = { PONS_FEE_PROFILE_JSON: JSON.stringify(valid), ROBINHOOD_RPC: 'https://rpc.example.invalid', READ_FEES: 'true', WALLET_CLAIMS: 'true' };
  assert.equal(apiEnvironment(env).PONS_FEE_PROFILE_JSON, env.PONS_FEE_PROFILE_JSON);
  const config = readConfig(env);
  assert.equal(config.ponsLaunch, null);
  assert.equal(config.ponsFees.assets[0].address, zeroAddress);
  assert.equal(runtimeStatus(env).features.find(f => f.id === 'pons_escrow_claims').status, 'needs_live_verification');
  assert.deepEqual(validateInput('fees', input), input);
  assert.throws(() => validateInput('fees', { ...input, chainId: 8453 }), /invalid_request/);
});

test('Pons escrow coverage aggregates each asset once and never claims to cover unswept earnings', async () => {
  const f = fixture(); const page = await f.service.list(input);
  assert.equal(page.coverage, 'configured_escrow'); assert.equal(page.status, 'partial'); assert.equal(page.nextCursor, null);
  assert.equal(page.positions.length, 2); assert(page.positions.every(p => p.claimable && p.verification === 'live'));
  assert.deepEqual(page.positions.map(p => p.payouts[0].asset), [zeroAddress, addr('2')]);
  const count = f.count(); await f.service.list(input); assert.equal(f.count(), count);
});

test('Pons preparations bind wallet, live balance, escrow and exact native/token amount', async () => {
  const f = fixture(); const page = await f.service.list(input);
  for (const [i, position] of page.positions.entries()) {
    f.options.owed = 50n;
    const quote = await f.service.prepare({ address: owner, positionId: position.id });
    assert.equal(quote.kind, 'pons'); assert.equal(quote.chainId, 4663); assert.equal(quote.value, '0');
    assert.deepEqual(decodeFunctionData({ abi: ponsEscrowAbi, data: quote.data }), i === 0 ? { functionName: 'claim', args: [50n] } : { functionName: 'claimToken', args: [addr('2'), 50n] });
    assert.equal(quote.payouts[0].claimableRaw, '50');
    await assert.rejects(f.service.prepare({ address: addr('b'), positionId: position.id }), /quote_expired/);
  }
});

test('Pons missing configuration and disabled reads return unknown without RPC', async () => {
  for (const config of [{ ponsFees: null }, { rpcUrl: '' }, { feesEnabled: false }]) {
    const f = fixture({ config }); const page = await f.service.list(input);
    assert.equal(page.status, 'unavailable'); assert.deepEqual(page.positions, []); assert.equal(f.count(), 0);
  }
});

test('Pons wrong chain, changed code and failed reads never fabricate zero fees', async () => {
  for (const [options, error] of [[{ chain: 8453 }, /wrong_chain/], [{ changedCode: true }, /contract_unverified/], [{ reverted: true }, /reverted/]])
    await assert.rejects(fixture(options).service.list(input), error);
});

test('Pons preparation refuses empty balances, reverted withdrawals, profile changes and insufficient gas', async () => {
  for (const [change, error] of [[{ owed: 0n }, /nothing_to_claim/], [{ claimReverted: true }, /reverted/], [{ changedCode: true }, /contract_unverified/], [{ balance: 0n }, /insufficient_funds/]]) {
    const f = fixture(); const page = await f.service.list(input); Object.assign(f.options, change);
    await assert.rejects(f.service.prepare({ address: owner, positionId: page.positions[0].id }), error);
  }
  const f = fixture(); const page = await f.service.list(input); f.config.ponsFees.escrow.codeHash = keccak256('0x6000');
  await assert.rejects(f.service.prepare({ address: owner, positionId: page.positions[0].id }), /contract_unverified/);
  const disabled = fixture({ config: { claimsEnabled: false } });
  assert((await disabled.service.list(input)).positions.every(p => !p.claimable && p.claimDisabledReason === 'claims_disabled'));
});
