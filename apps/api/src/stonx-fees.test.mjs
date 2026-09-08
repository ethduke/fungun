import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, toHex, zeroAddress } from 'viem';
import { STONX_ROLES, stonxPairId, stonxWrapperCodeHash, stonxWrapperBytecode, STONX_ABI } from '../../web/lib/long-encoding/stonx-launch.mjs';
import { Fees } from './fees.mjs';
import { readStonxFeeMulticall } from './stonx-fees.mjs';
import { readConfig } from './config.mjs';
import { managerAbi, poolId } from './fee-contracts.mjs';
import { validateInput } from './service.mjs';
import { runtimeStatus } from './runtime-status.mjs';
import { claimAbi, parseFees, validateClaim, mergeFeePages } from '../../web/lib/fee-service.ts';
import { FEE_SOURCES, groupFeeBalances } from '../../web/lib/fees-model.ts';
import { receiptPayouts, sendWalletClaim } from '../../web/lib/claim-wallet.ts';
import { claimQueueItems } from '../../web/lib/claim-queue.ts';
const addr = n => toHex(BigInt(n), { size: 20 });
const pin = n => ({ address: addr(n), codeHash: keccak256('0x01') });
const owner = addr(700), asset = addr(200), quoteToken = addr(2n ** 159n);
function fixture(options = {}) {
  const profile = { chainId: 8453, launchpad: 'stonx', ...Object.fromEntries(STONX_ROLES.map((r, i) => [r, pin(i + 1)])), integrator: addr(500), protocolBeneficiary: addr(600),
    quotes: [{ id: stonxPairId(quoteToken), token: { address: quoteToken, codeHash: stonxWrapperCodeHash(addr(123)) }, beacon: pin(123), implementation: pin(124), symbol: 'wtNVDA', decimals: 18 }] };
  const config = { ...readConfig({ STONX_BASE_PROFILE_JSON: JSON.stringify(profile) }), baseRpcUrl: 'EXAMPLE', feesEnabled: true, claimsEnabled: true };
  config.feeContracts.baseOracle = pin(800);
  config.stonxFeeMulticall = pin(801);
  const pool = { currency0: { address: asset }, currency1: { address: quoteToken }, fee: options.fee ?? 500, tickSpacing: 10 }, id = poolId(pool, profile.poolInitializer.address);
  const changes = {}, calls = [], verified = [];
  const rpc = {
    block: async () => '0x100',
    verify: async (chain, pins) => { assert.equal(chain, 8453); verified.push(...pins); if (changes.code) throw Error('contract_unverified'); },
    calls: async (chain, entries) => {
      assert.equal(chain, 8453);
      return entries.map(e => {
        calls.push(e);
        if (e.functionName === 'aggregate3') return e.args[0].map(c => ({ success: !changes.multicallFailed, returnData: encodeFunctionResult({ abi: managerAbi, functionName: 'getShares', result: changes.zeroShares ? 0n : c.target === profile.poolInitializer.address ? (changes.lpShares ?? 5n * 10n ** 17n) : 7n * 10n ** 17n }) }));
        if (e.functionName === 'collectFees' && changes.reverted) throw Error('reverted');
        const values = {
          owner: profile.protocolBeneficiary, airlock: profile.launcher.address, poolManager: profile.poolManager.address,
          getModuleState: ['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].findIndex(r => profile[r].address === e.args[0]) + 1,
          getAssetData: [quoteToken, zeroAddress, zeroAddress, profile.liquidityMigrator.address, profile.poolInitializer.address, asset, zeroAddress, 1n, 1n, changes.integrator ?? profile.integrator],
          getState: [quoteToken, 1n, profile.dopplerHook.address, '0x', 2, { currency0: asset, currency1: quoteToken, fee: pool.fee, tickSpacing: 10, hooks: profile.poolInitializer.address }, 0],
          getShares: changes.zeroShares ? 0n : e.address === profile.poolInitializer.address ? (changes.lpShares ?? 5n * 10n ** 17n) : 7n * 10n ** 17n,
          getCumulatedFees0: 1000n, getCumulatedFees1: 2000n, getLastCumulatedFees0: 100n, getLastCumulatedFees1: 200n,
          collectFees: [100n, 200n], symbol: 'COIN', decimals: 18, implementation: changes.implementation ?? profile.quotes[0].implementation.address,
          getL1Fee: 100n, getOperatorFee: 20n,
        };
        if (!Object.hasOwn(values, e.functionName)) throw Error(e.functionName);
        return values[e.functionName];
      });
    },
    batch: async (_chain, entries) => entries.map(e => ({ eth_estimateGas: toHex(100000), eth_gasPrice: toHex(100), eth_getBalance: toHex(changes.balance ?? 10n ** 18n),
      eth_call: encodeFunctionResult({ abi: managerAbi, functionName: 'collectFees', result: [100n, 200n] }), eth_getTransactionCount: '0x1' })[e.method]),
  };
  const upstream = { json: async (provider, _url, request) => {
    if (provider === 'market') return { data: { base: 'ETH', currency: 'USD', amount: '2500' } };
    assert.equal(provider, 'stonx');
    const query = JSON.parse(request.body); assert.equal(query.variables.where.integrator, profile.integrator);
    return { data: { pools: { items: changes.empty ? [] : changes.many ? Array.from({ length: 24 }, (_, i) => ({ address: toHex(i + 1, { size: 32 }), chainId: 8453, integrator: profile.integrator, baseToken: { address: asset } })) : [{ address: changes.poolId ?? id, chainId: 8453, integrator: profile.integrator, baseToken: { address: asset } }],
      pageInfo: { hasNextPage: changes.more ?? false, endCursor: changes.more ? 'opaque-index-cursor' : null } } } };
  } };
  return { service: new Fees(config, upstream, Date.now, rpc), config, profile, id, rpc, changes, calls, verified };
}
const input = { address: owner, chainId: 8453, padId: 'stonx' };

test('stonx fees work independently of launch activation and are Base-only', () => {
  const f = fixture(); assert.equal(f.config.stonxLaunch, null); assert(f.config.stonxFees);
  assert.throws(() => readStonxFeeMulticall(JSON.stringify({ ...pin(801), codeHash: 'invalid' })));
  assert.deepEqual(validateInput('fees', input), input);
  assert.throws(() => validateInput('fees', { ...input, chainId: 4663 }));
  assert(FEE_SOURCES.some(s => s.padId === 'stonx' && s.chainId === 8453));
  const status = runtimeStatus({ STONX_BASE_PROFILE_JSON: JSON.stringify(f.profile), BASE_RPC: 'https://base.example.invalid', READ_FEES: 'true', STONX_FEE_MULTICALL_JSON: JSON.stringify(pin(801)) });
  assert.equal(status.features.find(f => f.id === 'stonx_creator_fees').status, 'needs_live_verification');
});

test('both current fee shares are read on-chain even without beneficiary-index records', async () => {
  const f = fixture(), page = parseFees(await f.service.list(input), owner, 8453, 'stonx');
  assert.equal(page.status, 'ready'); assert.equal(page.positions.length, 2);
  assert.deepEqual(page.positions.map(p => p.feeStream), ['lp', 'trading']);
  assert.deepEqual(page.positions.map(p => p.payouts.map(a => a.claimableRaw)), [['500', '1000'], ['700', '1400']]);
  assert.equal(claimQueueItems([page]).length, 2);
  const grouped = groupFeeBalances(page.positions.flatMap(p => p.payouts.map(a => ({ ...a, padId: 'stonx', chainId: 8453 }))));
  assert.equal(grouped.length, 2);
  assert(f.calls.filter(c => c.functionName === 'collectFees').every(c => c.from === owner));
});

test('a transferred trading share remains discoverable after LP shares were transferred away', async () => {
  const f = fixture(); f.changes.lpShares = 0n;
  const page = await f.service.list(input);
  assert.deepEqual(page.positions.map(p => p.feeStream), ['trading']);
  const other = fixture(); other.changes.zeroShares = true;
  assert.deepEqual((await other.service.list(input)).positions, []);
});

test('stonx claim preparation binds stream, wallet, pool, deployment and Base gas fees', async () => {
  const f = fixture(), page = await f.service.list(input);
  for (const position of page.positions) {
    const quote = validateClaim(await f.service.prepare({ address: owner, positionId: position.id }));
    assert.equal(quote.feeStream, position.feeStream); assert.equal(quote.poolId, f.id);
    assert.equal(quote.value, '0'); assert(BigInt(quote.budgetWei) > BigInt(quote.gas) * BigInt(quote.gasPrice));
    for (const changed of [{ chainId: 4663 }, { target: addr(99) }, { poolId: toHex(99, { size: 32 }) }, { feeStream: position.feeStream === 'lp' ? 'trading' : 'lp' }, { data: quote.data + '00' }])
      assert.throws(() => validateClaim({ ...quote, ...changed }));
  }
  await assert.rejects(f.service.prepare({ address: addr(999), positionId: page.positions[0].id }), /quote_expired/);
  assert(f.verified.some(p => p.address === f.config.feeContracts.baseOracle.address));
});

test('pagination remains wallet-bound, deduplicates streams and rejects repeated cursors', async () => {
  const f = fixture(); f.changes.more = true;
  const page = await f.service.list(input); assert.equal(page.status, 'partial'); assert(page.nextCursor);
  await assert.rejects(f.service.list({ ...input, address: addr(999), cursor: page.nextCursor }), /cursor_expired/);
  await assert.rejects(f.service.list({ ...input, cursor: page.nextCursor }), /scan_limit/);
  const merged = mergeFeePages(page, { ...page, status: 'ready', nextCursor: null });
  assert.equal(merged.positions.length, 2);
  assert.throws(() => mergeFeePages(page, { ...page, positions: [{ ...page.positions[0], feeStream: 'trading' }] }));
});

test('changed code, stale shares, wrapper upgrades, bad pool identity and insufficient gas cannot claim', async () => {
  for (const change of [{ code: true }, { zeroShares: true }, { implementation: addr(999) }, { balance: 0n }, { reverted: true }]) {
    const f = fixture(), page = await f.service.list(input); Object.assign(f.changes, change);
    await assert.rejects(f.service.prepare({ address: owner, positionId: page.positions[0].id }));
  }
  const bad = fixture(); bad.changes.poolId = toHex(123, { size: 32 }); await assert.rejects(bad.service.list(input));
  const unrelated = fixture(); unrelated.changes.integrator = addr(999); assert.deepEqual((await unrelated.service.list(input)).positions, []);
  for (const change of [{ stonxFees: null }, { baseRpcUrl: '' }, { feesEnabled: false }]) {
    const f = fixture(); Object.assign(f.config, change); assert.equal((await f.service.list(input)).status, 'unavailable');
  }
});

test('stonx receipts require matching Release and actual transfers to the claiming wallet', async () => {
  const f = fixture(), page = await f.service.list(input), quote = validateClaim(await f.service.prepare({ address: owner, positionId: page.positions[0].id }));
  const release = { address: quote.target, topics: encodeEventTopics({ abi: claimAbi, eventName: 'Release', args: { poolId: quote.poolId, beneficiary: owner } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [500n, 1000n]) };
  const transfer = (asset, value, to = owner) => ({ address: asset, topics: [keccak256(new TextEncoder().encode('Transfer(address,address,uint256)')), toHex(BigInt(quote.target), { size: 32 }), toHex(BigInt(to), { size: 32 })], data: encodeAbiParameters([{ type: 'uint256' }], [value]) });
  const receipt = { status: '0x1', from: owner, to: quote.target, logs: [release, transfer(asset, 500n), transfer(quoteToken, 990n)] };
  assert.deepEqual(receiptPayouts(receipt, quote).map(p => p.claimableRaw), ['500', '990']);
  assert.equal(receiptPayouts({ ...receipt, logs: [release] }, quote), null);
  assert.equal(receiptPayouts({ ...receipt, logs: [release, transfer(asset, 500n, addr(999)), transfer(quoteToken, 1000n)] }, quote), null);
  assert.equal(receiptPayouts({ ...receipt, logs: [release, transfer(asset, 501n), transfer(quoteToken, 1000n)] }, quote), null);
});

test('wallet rechecks pins and simulates the exact stonx claim before one mocked send', async () => {
  const f = fixture(), page = await f.service.list(input), raw = await f.service.prepare({ address: owner, positionId: page.positions[0].id });
  const quote = validateClaim({ ...raw, expiresAt: performance.now() + 20000 });
  let changed = true, simulated = 0, sent = 0;
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [owner]; if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getCode') return changed ? '0x02' : params[0] === quoteToken ? stonxWrapperBytecode(addr(123)) : '0x01';
    if (method === 'eth_call' && params[0].to === addr(123)) return encodeFunctionResult({ abi: STONX_ABI, functionName: 'implementation', result: addr(124) });
    if (method === 'eth_call') { assert.equal(params[0].data, quote.data); simulated++; return encodeFunctionResult({ abi: managerAbi, functionName: 'collectFees', result: [100n, 200n] }); }
    if (method === 'eth_sendTransaction') { assert.equal(simulated, 1); sent++; return toHex(123, { size: 32 }); }
    throw Error(method);
  } };
  await assert.rejects(sendWalletClaim(provider, quote)); assert.equal(sent, 0);
  changed = false; await sendWalletClaim(provider, quote); assert.equal(sent, 1);
});


test('a full scan page uses one verified Multicall for 48 share reads and subcall failures remain unknown', async () => {
  const f = fixture(); f.changes.many = true; f.changes.zeroShares = true;
  assert.deepEqual((await f.service.list(input)).positions, []);
  const calls = f.calls.filter(c => c.functionName === 'aggregate3');
  assert.equal(calls.length, 1); assert.equal(calls[0].args[0].length, 48);
  assert.equal(f.calls.filter(c => c.functionName === 'getShares').length, 0);
  assert(f.verified.some(p => p.address === f.config.stonxFeeMulticall.address));
  const failed = fixture(); failed.changes.multicallFailed = true;
  await assert.rejects(failed.service.list(input), /invalid_response/);
});


test('existing dynamic-fee stonx pools bind their actual PoolKey for claims', async () => {
  const f = fixture({ fee: 8388608 }), page = parseFees(await f.service.list(input), owner, 8453, 'stonx');
  assert.equal(page.positions.length, 2);
  const quote = validateClaim(await f.service.prepare({ address: owner, positionId: page.positions[0].id }));
  assert.equal(quote.poolFee, 8388608); assert.equal(quote.poolId, f.id);
  assert.throws(() => validateClaim({ ...quote, poolFee: 500 }));
  assert.throws(() => validateClaim({ ...quote, tickSpacing: 20 }));
});
