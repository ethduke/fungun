import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { STONKS_ABI, STONKS_ROLES, STONKS_SUPPLY, buildUnsignedStonksLaunch, readStonksProfile, stonksPairId } from '../../web/lib/long-encoding/stonks-launch.mjs';
import { StonksLive, readStonksConfig } from './stonks-live.mjs';
import { StonksFees, stonksRecipientAmount } from './stonks-fees.mjs';
import { stonksCoins } from './stonks-index.mjs';
import { ipfsContentId } from './ipfs-content.mjs';
import { ServiceError } from './errors.mjs';
import { ReadCache } from './upstream.mjs';
import { parseCatalog } from '../../web/lib/read-service.ts';
import { validateLongInput } from './long-live.mjs';
import { Launches } from './launches.mjs';
import { validateInput } from './service.mjs';
import { validateLongPlan, sendLongWallet } from '../../web/lib/long-wallet.ts';
import { parseApproximateLaunchCost, approximateLaunchQuote, calculateLaunchCosts } from '../../web/lib/launch-cost.ts';
import { validateClaim, parseFees } from '../../web/lib/fee-service.ts';
import { receiptPayouts } from '../../web/lib/claim-wallet.ts';
import { DEFAULT_DESTINATIONS, selectChain, supportsChain, validateDraft } from '../../web/lib/launch-model.ts';
import { apiEnvironment } from './runtime-env.mjs';

const addr = n => toHex(BigInt(n), { size: 20 });
const hash = n => toHex(BigInt(n), { size: 32 });
const contract = n => ({ address: addr(n), codeHash: keccak256('0x01') });
function profileFixture() {
  const roles = Object.fromEntries(STONKS_ROLES.map((role, i) => [role, { ...contract(i + 1),
    ...(['launcher', 'locker'].includes(role) ? { implementation: addr(i + 100), implementationCodeHash: keccak256('0x01') } : {}) }]));
  return { chainId: 8453, launchpad: 'stonks', ...roles,
    quotes: [{ id: stonksPairId(addr(900)), token: addr(900), symbol: 'NVDAc', decimals: 8 }] };
}
async function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const now = 1800000000000, profile = profileFixture(), q = profile.quotes[0], wallet = addr(400), token = addr(500), pool = addr(600);
  const draft = { name: 'Sample launch', ticker: 'SAMPLE', description: 'Same composer metadata' };
  const imageCid = await ipfsContentId(Buffer.from('synthetic image')), imageUri = `ipfs://${imageCid}`;
  const metadata = Buffer.from(JSON.stringify({ name: draft.name, symbol: draft.ticker, description: draft.description, image: imageUri, image_hash: imageUri }));
  const publication = { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: createHash('sha256').update(metadata).digest('hex') };
  const published = { ...publication, status: 'published', ipfs: { imageCid, metadataCid: await ipfsContentId(metadata) } };
  const input = { chainId: 8453, wallet, draft, pairId: q.id, publication };
  const change = {}, seen = [];
  const rpc = {
    block: async () => '0x64',
    verify: async (chain, roles) => { assert.equal(chain, 8453); assert.ok(roles.every(c => c.codeHash)); if (change.code) throw new ServiceError('contract_unverified'); },
    calls: async (chain, entries) => { assert.equal(chain, 8453); return entries.map(e => {
      seen.push(e.functionName);
      const values = {
        feeLocker: change.locker ?? profile.locker.address, quoteRegistry: profile.registry.address, npm: profile.positionManager.address,
        factory: profile.factory.address, launcher: profile.launcher.address, platformFeeBps: change.platform ?? 3000n, lpFeeBps: 0n,
        pendingFeeSplit: [0, 0, 0n], enforcedSupply: STONKS_SUPPLY, LAUNCH_FEE_TIER: 10000, launchFeeWei: 1000000n,
        quotes: [!change.disabled, 8, 400000, true, 'NVDAc'], previewSync: [!change.stale, 400000, 399800, !change.stale, 150n * 10n ** 18n],
        predictTokenAddress: token, getL1Fee: 1000n, getL1FeeUpperBound: 2000n, getOperatorFee: 200n,
        name: draft.name, symbol: same(e.address, q.token) ? q.symbol : draft.ticker, decimals: same(e.address, q.token) ? 8 : 18,
        totalSupply: STONKS_SUPPLY, tokenInfo: [token, wallet, pool, q.token, 77n, 10000, 100n],
        ownerOf: change.owner ?? profile.locker.address,
        positions: [0n, addr(0), token, q.token, 10000, -400000, 887200, 10n, 0n, 0n, 0n, 0n],
        positionsInfo: [wallet, true, q.token], splitsOf: change.splits ?? [], getPool: change.pool ?? pool,
        positionsOf: [77n], tokenCreator: wallet, tokenQuote: q.token,
        collect: [101n, 203n], claimable: change.deferred ?? 0n,
      };
      assert.ok(Object.hasOwn(values, e.functionName), e.functionName); return values[e.functionName];
    }); },
    batch: async (chain, entries) => { assert.equal(chain, 8453); return entries.map(e => {
      if (e.method === 'eth_call') {
        if (change.noFundsSimulation) throw new ServiceError('insufficient_funds');
        const decoded = decodeFunctionData({ abi: STONKS_ABI, data: e.params[0].data });
        assert.equal(decoded.functionName, 'launchWithMeta');
        assert.equal(decoded.args[0].devBuyQuote, 0n); assert.equal(decoded.args[0].feeRecipient, wallet);
        return encodeFunctionResult({ abi: STONKS_ABI, functionName: 'launchWithMeta', result: [change.prediction ?? token, 50n] });
      }
      const values = { eth_getCode: change.occupied && same(e.params[0], token) ? '0x01' : '0x',
        eth_gasPrice: toHex(1000000n), eth_getBalance: toHex(change.balance ?? 10n ** 18n), eth_getTransactionCount: '0x1', eth_estimateGas: toHex(6300000n) };
      assert.ok(Object.hasOwn(values, e.method), e.method); return values[e.method];
    }); },
  };
  const config = { readsEnabled: true, claimsEnabled: true, stonksLaunch: { profile, launchesEnabled: true }, feeContracts: { baseOracle: { ...contract(700), implementation: addr(701), implementationCodeHash: keccak256('0x01') } } };
  const budget = { db, key: 'c'.repeat(64), launch: () => {}, withLaunch: fn => fn() };
  const upstream = { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500' } }) };
  const live = new StonksLive(config, upstream, budget, { rpc, now: () => now }); live.metadata = async () => published;
  const receipt = { logs: [
    { address: profile.launcher.address,
      topics: encodeEventTopics({ abi: STONKS_ABI, eventName: 'TokenLaunched', args: { token, tokenId: 77n, creator: wallet } }),
      data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'address' }], [q.token, pool, 10000, -400000, STONKS_SUPPLY, profile.locker.address]) },
    { address: profile.launcher.address,
      topics: encodeEventTopics({ abi: STONKS_ABI, eventName: 'TokenMetaSet', args: { token, creator: wallet } }),
      data: encodeAbiParameters(Array.from({ length: 6 }, () => ({ type: 'string' })), [imageUri, '', draft.description, '', '', '']) },
  ] };
  return { db, config, budget, upstream, now, live, rpc, input, published, profile, change, receipt, token, pool, wallet };
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

test('Stonks runtime settings remain API-only and require a reviewed Base profile', () => {
  const env = { STONKS_BASE_WALLET_LAUNCH: 'true', STONKS_BASE_PROFILE_JSON: JSON.stringify(profileFixture()), LAUNCH_ASSET_SERVICE_ORIGIN: 'https://assets.example.invalid' };
  assert.equal(readStonksConfig(env).launchesEnabled, true);
  assert.equal(readStonksConfig({ ...env, STONKS_BASE_WALLET_LAUNCH: 'false' }).launchesEnabled, false);
  assert.equal(readStonksConfig({}), null);
  assert.deepEqual(apiEnvironment({}, { ...env, NEXT_PUBLIC_STONKS_BASE_PROFILE_JSON: 'LEAK' }), env);
  assert.throws(() => readStonksProfile({ ...profileFixture(), chainId: 4663 }));
  const p = profileFixture(); delete p.launcher.implementation;
  assert.throws(() => readStonksProfile(p));
});

test('Base offers O1 and Stonks while Robinhood keeps its existing destinations', () => {
  const pads = selectChain(DEFAULT_DESTINATIONS, 8453);
  assert.deepEqual(pads.filter(p => supportsChain(p.id, 8453)).map(p => p.id), ['o1', 'stonks']);
  assert.deepEqual(pads.filter(p => p.selected).map(p => p.id), ['o1']);
  const q = profileFixture().quotes[0], destination = { ...pads.find(p => p.id === 'stonks'), selected: true, pairId: q.id };
  const draft = { name: 'Test', ticker: 'TEST', description: '', hasImage: true };
  const catalog = { chainId: 8453, expiresAt: performance.now() + 60000, pads: { stonks: { status: 'ready', pairs: [{ id: q.id, symbol: 'NVDA' }] } } };
  assert.deepEqual(validateDraft(draft, [destination], 8453, catalog), {});
  for (const changed of [{ chainId: 4663 }, { route: 'standard', pairId: 'native' }, { editableMetadata: true }])
    assert.ok(validateDraft(draft, [{ ...destination, ...changed }], 8453, catalog).destinations);
  assert.ok(validateDraft(draft, [destination], 8453, null).destinations);
});

test('Stonks request routing is isolated by chain and pair, including persisted recovery', async t => {
  const f = await fixture(t), plan = await f.live.prepare(f.input);
  assert.deepEqual(validateLongInput('launch-prepare', f.input), f.input);
  for (const changed of [{ chainId: 4663 }, { editableMetadata: true }, { editableMetadata: false }])
    assert.throws(() => validateLongInput('launch-prepare', { ...f.input, ...changed }));
  assert.deepEqual(validateInput('fees', { address: f.wallet, chainId: 8453, padId: 'stonks' }).padId, 'stonks');
  assert.throws(() => validateInput('fees', { address: f.wallet, chainId: 4663, padId: 'stonks' }));
  const launches = new Launches(f.config, f.upstream, f.budget);
  launches.handlers.stonks.run = () => 'stonks'; launches.handlers.o1Base.run = () => 'o1';
  assert.equal(await launches.run('launch-status', { id: plan.id }), 'stonks');
  assert.equal(await launches.run('launch-prepare', { chainId: 8453, pairId: 'native' }), 'o1');
});

test('Stonks composes exact metadata, bounds fees, and rejects transaction substitution', async t => {
  const f = await fixture(t), raw = { ...await f.live.prepare(f.input), serverTime: f.now };
  const plan = validateLongPlan(raw, f.input, f.published, performance.now());
  const decoded = decodeFunctionData({ abi: STONKS_ABI, data: plan.transaction.data });
  assert.equal(decoded.args[0].totalSupply, STONKS_SUPPLY); assert.equal(decoded.args[0].devBuyQuote, 0n);
  assert.equal(decoded.args[0].feeRecipient, f.wallet); assert.equal(decoded.args[1].description, f.input.draft.description);
  assert.equal(decoded.args[1].image, `ipfs://${f.published.ipfs.imageCid}`);
  assert.equal(plan.maximumGasWei, '7560000001400');
  assert.deepEqual(plan.baseFees, { l1DataFeeWei: '1200', operatorFeeWei: '200' });
  for (const change of [{ transaction: { ...raw.transaction, to: addr(88) } }, { chainId: 4663 }, { baseFees: undefined },
    { terms: { ...raw.terms, creatorBps: 10000 } }, { condition: { ...raw.condition, priceFresh: 'yes' } },
    { maximumGasWei: '7560000000000' }, { buildInput: { ...raw.buildInput, launchpadFeeWei: '0' } }])
    assert.throws(() => validateLongPlan({ ...raw, ...change }, f.input, f.published, performance.now()));
  assert.throws(() => buildUnsignedStonksLaunch({ ...raw.buildInput, pairId: stonksPairId(addr(99)) }, raw.profile));
});

test('Stonks wallet rechecks proxy implementations and predicted address before one mocked submission', async t => {
  const f = await fixture(t), raw = { ...await f.live.prepare(f.input), serverTime: f.now };
  const plan = validateLongPlan(raw, f.input, f.published, performance.now());
  let bad = false, sends = 0, reserved = false;
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_getStorageAt') {
      const role = same(params[0], f.profile.launcher.address) ? f.profile.launcher : f.profile.locker;
      return toHex(BigInt(bad ? addr(99) : role.implementation), { size: 32 });
    }
    if (method === 'eth_call') return encodeFunctionResult({ abi: STONKS_ABI, functionName: 'predictTokenAddress', result: f.token });
    if (method === 'eth_sendTransaction') { assert.ok(reserved); sends++; return hash(777); }
    const values = { eth_accounts: [f.wallet], eth_chainId: '0x2105', eth_getCode: '0x01', eth_getTransactionCount: '0x1', eth_getBalance: toHex(10n ** 18n) };
    assert.ok(Object.hasOwn(values, method)); return values[method];
  } };
  bad = true;
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { reserved = true; }));
  assert.equal(sends, 0); assert.equal(reserved, false);
  bad = false;
  await sendLongWallet(provider, plan, () => true, async () => { reserved = true; });
  assert.equal(sends, 1);
});

test('Stonks confirms the mined NFT even when another launch changed the simulated NFT counter', async t => {
  const f = await fixture(t), plan = await f.live.prepare(f.input);
  await f.live.confirm(plan, f.input, f.receipt, '0x64');
  for (const change of [{ owner: addr(99) }, { pool: addr(99) }, { splits: [{ to: addr(99), bps: 10000n }] }]) {
    Object.assign(f.change, change);
    await assert.rejects(f.live.confirm(plan, f.input, f.receipt, '0x64'), { code: 'launch_receipt_unverified' });
    for (const key of Object.keys(change)) delete f.change[key];
  }
  await assert.rejects(f.live.confirm(plan, f.input, { logs: f.receipt.logs.slice(0, 1) }, '0x64'), { code: 'launch_receipt_unverified' });
});

test('Stonks rejects changed contracts, missing pairs, occupied tokens, and insufficient complete Base budget', async t => {
  for (const [change, code] of [[{ code: true }, 'contract_unverified'], [{ locker: addr(99) }, 'contract_unverified'],
    [{ disabled: true }, 'unsupported_pair'], [{ occupied: true }, 'launch_already_exists'], [{ prediction: addr(99) }, 'launch_simulation_failed'],
    [{ balance: 7560001000000n }, 'insufficient_funds'], [{ noFundsSimulation: true, balance: 0n }, 'insufficient_funds']]) {
    const f = await fixture(t); Object.assign(f.change, change);
    await assert.rejects(f.live.prepare(f.input), e => {
      assert.equal(e.code, code);
      if (e.funding) { assert.equal(e.funding.chainId, 8453); assert.ok(BigInt(e.funding.shortfallWei) > 0n); }
      return true;
    });
  }
});

test('Stonks comparison discloses a Base gas ceiling, full data fees, and stale-price fallback', async t => {
  const f = await fixture(t); f.change.stale = true;
  const raw = await f.live.estimate(f.input);
  assert.equal(raw.terms.creatorBps, 7000); assert.equal(raw.condition.priceFresh, false);
  assert.throws(() => parseApproximateLaunchCost({ ...raw, chainId: '8453', serverTime: f.now }, performance.now(), f.input.pairId));
  const estimate = parseApproximateLaunchCost({ ...raw, serverTime: f.now }, performance.now(), f.input.pairId);
  const quote = approximateLaunchQuote(estimate, 'test', performance.now());
  const cost = calculateLaunchCosts(quote, { chainId: 8453, pads: ['stonks'], contextKey: 'test' }, performance.now());
  assert.equal(cost.total.totalWei, 8000001002600n);
  const plan = await f.live.prepare(f.input); assert.equal(plan.condition.priceFresh, false);
});

test('Stonks creator splits preserve rounding dust, and redirected fees never become the creator wallet balance', () => {
  const splits = [{ to: addr(1), bps: 3333n }, { to: addr(2), bps: 6667n }];
  assert.equal(stonksRecipientAmount(10n, addr(3), splits, addr(1)), 3n);
  assert.equal(stonksRecipientAmount(10n, addr(3), splits, addr(2)), 7n);
  assert.equal(stonksRecipientAmount(10n, addr(3), splits, addr(3)), 0n);
  assert.throws(() => stonksRecipientAmount(10n, addr(3), [{ to: addr(1), bps: 1n }], addr(1)));
});

test('Stonks collection reads uncollected V3 growth and distinguishes deferred payouts', async t => {
  const f = await fixture(t), fees = new StonksFees(f.config, f.rpc, f.upstream, f.live.cache);
  const position = await fees.collection(f.wallet, f.token, '0x64', { platformBps: 3000, lpBps: 0 });
  assert.deepEqual(position.payouts.map(p => p.claimableRaw), ['71', '143']);
  assert.equal(position.claimMode, 'collect'); assert.equal(position.claimable, true);
  f.change.splits = [{ to: addr(99), bps: 10000n }];
  assert.equal(await fees.collection(f.wallet, f.token, '0x64', { platformBps: 3000, lpBps: 0 }), null);
  await assert.rejects(fees.prepare(position, '0x64'), { code: 'nothing_to_claim' });
  f.change.deferred = 123n;
  const deferred = await fees.deferred(f.wallet, f.token, '0x64');
  assert.equal(deferred.claimMode, 'claim'); assert.equal(deferred.payouts[0].claimableRaw, '123');
});

test('Stonks claim calldata and receipts bind the collection token and only count received transfers', async t => {
  const f = await fixture(t), fees = new StonksFees(f.config, f.rpc, f.upstream, f.live.cache);
  const position = await fees.collection(f.wallet, f.token, '0x64', { platformBps: 3000, lpBps: 0 });
  const quote = { positionId: 'a'.repeat(64), kind: 'stonks', chainId: 8453, address: f.wallet, target: f.profile.locker.address,
    collectionToken: f.token, claimMode: 'collect', payouts: position.payouts, value: '0', gas: '100000', gasPrice: '1000000',
    estimatedWei: '100000000000', budgetWei: '120000000000', l1FeeWei: '1000', operatorFeeWei: '200', expiresAt: 99999,
    data: encodeFunctionData({ abi: STONKS_ABI, functionName: 'collectAll', args: [f.token] }) };
  assert.equal(validateClaim(quote), quote);
  assert.throws(() => validateClaim({ ...quote, collectionToken: addr(99) }));
  assert.throws(() => validateClaim({ ...quote, chainId: 4663 }));
  const transfer = { address: f.token, topics: encodeEventTopics({ abi: STONKS_ABI, eventName: 'Transfer', args: { from: quote.target, to: f.wallet } }), data: encodeAbiParameters([{ type: 'uint256' }], [71n]) };
  const receipt = { status: '0x1', from: f.wallet, to: quote.target, logs: [transfer] };
  assert.equal(receiptPayouts(receipt, quote)[0].claimableRaw, '71');
  assert.equal(receiptPayouts({ ...receipt, logs: [{ ...transfer, address: addr(99) }] }, quote), null);
  assert.equal(receiptPayouts({ ...receipt, status: '0x0' }, quote), null);
  assert.equal(parseFees({ address: f.wallet, chainId: 8453, padId: 'stonks', status: 'partial', coverage: 'wallet_index', expiresAt: 99,
    positions: [{ ...position, id: 'a'.repeat(64) }] }, f.wallet, 8453, 'stonks').positions.length, 1);
});

test('Stonks creator-fee index rejects malformed and duplicate token records', () => {
  const profile = profileFixture(), coin = { token: addr(500), creator: addr(400), quote: profile.quotes[0].token,
    pool: addr(600), token_id: '77', fee_locker: profile.locker.address, name: 'Sample', symbol: 'SAMPLE', created_at: '1800000000' };
  assert.deepEqual(stonksCoins({ coins: [coin] }), [coin]);
  assert.throws(() => stonksCoins({ coins: [coin, coin] }));
  assert.throws(() => stonksCoins({ coins: [{ ...coin, pool: 'https://evil.invalid' }] }));
});

test('Stonks catalog polling fits the daily read allowance across a full active day', async t => {
  const f = await fixture(t); let now = f.now, rpcUnits = 0;
  f.live.now = () => now; f.live.cache = new ReadCache(() => now);
  f.rpc.block = async () => { rpcUnits++; return '0x64'; };
  const calls = f.rpc.calls; f.rpc.calls = (...args) => { rpcUnits += args[1].length; return calls(...args); };
  const verify = f.rpc.verify; f.rpc.verify = (...args) => {
    rpcUnits += 1 + args[1].length + args[1].filter(c => c.implementation).length * 2;
    return verify(...args);
  };
  const q = f.profile.quotes[0];
  f.live.live = { ...f.live.live, profile: { ...f.profile, quotes: Array.from({ length: 13 }, (_, i) => ({ ...q, id: stonksPairId(addr(900+i)), token: addr(900+i) })) } };
  for (let minute = 0; minute < 1440; minute++) {
    now = f.now + minute * 60000;
    const catalog = await f.live.catalog();
    assert.equal(parseCatalog({ chainId: 8453, expiresAt: catalog.expiresAt, pads: { o1: { status: 'unavailable', pairs: [] }, stonks: catalog } }, 8453).pads.stonks.pairs.length, 13);
  }
  assert.ok(rpcUnits < 9000, `Browsing used ${rpcUnits} RPC units`);
  f.change.code = true;
  await assert.rejects(f.live.prepare(f.input), { code: 'contract_unverified' });
});
