import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, keccak256, toHex, zeroAddress } from 'viem';
import { DopplerSDK, getAddresses } from '@whetstone-research/doppler-sdk/evm';
import { STONX_ABI, STONX_ROLES, STONX_BANDS, STONX_SUPPLY, buildUnsignedStonxLaunch, readStonxProfile, stonxPairId, stonxBeneficiaries, stonxTick, stonxWrapperCodeHash, stonxWrapperBytecode } from '../../web/lib/long-encoding/stonx-launch.mjs';
import { StonxLive, readStonxConfig, parseStonxPrice } from './stonx-live.mjs';
import { validateLongInput } from './long-live.mjs';
import { validateLongPlan, sendLongWallet } from '../../web/lib/long-wallet.ts';
import { DEFAULT_DESTINATIONS, selectChain, supportsChain, validateDraft, readablePads } from '../../web/lib/launch-model.ts';
import { STONX_PAIRS } from '../../web/lib/stonx-markets.ts';
import { parseCatalog } from '../../web/lib/read-service.ts';
import { confirmedLaunchTokenUrl } from '../../web/lib/long-recovery.ts';
import { ipfsContentId } from './ipfs-content.mjs';
import { Adapters } from './adapters.mjs';
import { Launches } from './launches.mjs';
const address = n => toHex(BigInt(n), { size: 20 });
const pin = a => ({ address: a.toLowerCase(), codeHash: keccak256('0x01') });
const now = 1800000000000;
function profileFixture(symbol = 'wtNVDA', token = address(2n ** 159n)) {
  const a = getAddresses(8453);
  const mapping = { launcher: 'airlock', tokenFactory: 'dopplerERC20V1Factory', tokenImplementation: 'dopplerERC20V1Implementation', governanceFactory: 'noOpGovernanceFactory',
    poolInitializer: 'dopplerHookInitializer', liquidityMigrator: 'noOpMigrator', dopplerHook: 'rehypeDopplerHookInitializer', poolManager: 'poolManager' };
  return { chainId: 8453, launchpad: 'stonx', ...Object.fromEntries(STONX_ROLES.map(r => [r, pin(a[mapping[r]])])),
    integrator: address(500), protocolBeneficiary: address(600), quotes: [{ id: stonxPairId(token), token: { ...pin(token), codeHash: stonxWrapperCodeHash(address(123)) }, beacon: pin(address(123)), implementation: pin(address(124)), symbol, decimals: 18 }] };
}
async function fixture(t, symbol, token) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const profile = profileFixture(symbol, token), q = profile.quotes[0], wallet = address(700);
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Shared artwork' };
  const imageCid = await ipfsContentId(Buffer.from('fixture'));
  const bytes = Buffer.from(JSON.stringify({ name: draft.name, symbol: draft.ticker, description: draft.description, image: `ipfs://${imageCid}`, image_hash: `ipfs://${imageCid}` }));
  const publication = { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: createHash('sha256').update(bytes).digest('hex') };
  const published = { ...publication, status: 'published', ipfs: { imageCid, metadataCid: await ipfsContentId(bytes) } };
  const input = { chainId: 8453, wallet, draft, pairId: q.id, publication };
  const changes = {}, calls = [];
  let built;
  const rpc = {
    block: async () => '0x64',
    verify: async chain => { assert.equal(chain, 8453); if (changes.code) throw Error('contract_unverified'); },
    calls: async (chain, entries) => entries.map(e => {
      calls.push(e.functionName);
      const values = { owner: changes.owner ?? profile.protocolBeneficiary, airlock: profile.launcher.address, poolManager: profile.poolManager.address, implementation: changes.implementation ?? q.implementation.address,
        getModuleState: ['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].findIndex(r => profile[r].address === e.args?.[0]) + 1,
        symbol: e.address === q.token.address ? (changes.symbol ?? q.symbol) : draft.ticker, decimals: 18,
        getL1Fee: 1000n, getOperatorFee: 200n, name: draft.name, totalSupply: STONX_SUPPLY, tokenURI: built?.review.metadataUri,
        getAssetData: [q.token.address, zeroAddress, zeroAddress, profile.liquidityMigrator.address, profile.poolInitializer.address, built?.predictedAsset, zeroAddress, STONX_SUPPLY, STONX_SUPPLY, profile.integrator],
        getState: [q.token.address, STONX_SUPPLY, profile.dopplerHook.address, '0x', 2, { currency0: built?.predictedAsset, currency1: q.token.address, fee: 500, tickSpacing: 10, hooks: profile.poolInitializer.address }, stonxTick(100000, 226.65)],
      };
      if (e.functionName === 'getShares') {
        const W = 10n ** 18n;
        return changes.shares ?? (e.address === profile.poolInitializer.address
          ? stonxBeneficiaries([[profile.protocolBeneficiary, W * 5n / 100n], [profile.integrator, W * 285n / 1000n], [wallet, W * 665n / 1000n]])
          : stonxBeneficiaries([[profile.integrator, W * 3n / 10n], [wallet, W * 7n / 10n]])).find(s => s.beneficiary === e.args[1]).shares;
      }
      assert.ok(Object.hasOwn(values, e.functionName), e.functionName); return values[e.functionName];
    }),
    batch: async (chain, entries) => entries.map(e => {
      if (e.method === 'eth_call') {
        const row = db.prepare('SELECT plan FROM long_launches LIMIT 1').get();
        if (row) built = JSON.parse(row.plan);
        if (!built) {
          // Match the deterministic intent chosen by preparation.
          const decoded = decodeFunctionData({ abi: STONX_ABI, data: e.params[0].data });
          const { getCreate2Address } = sdkViem;
          const bytecodeHash = keccak256('0x' + `602c3d8160093d39f33d3d3d3d363d3d37363d73${profile.tokenImplementation.address.slice(2)}5af43d3d93803e602a57fd5bf3`);
          const token = getCreate2Address({ from: profile.tokenFactory.address, salt: decoded.args[0].salt, bytecodeHash });
          return encodeFunctionResult({ abi: STONX_ABI, functionName: 'create', result: [changes.prediction ?? token, token, zeroAddress, zeroAddress, zeroAddress] });
        }
        return encodeFunctionResult({ abi: STONX_ABI, functionName: 'create', result: [changes.prediction ?? built.predictedAsset, built.predictedAsset, zeroAddress, zeroAddress, zeroAddress] });
      }
      return { eth_getCode: changes.occupied ? '0x01' : '0x', eth_gasPrice: toHex(1000000), eth_getBalance: toHex(changes.balance ?? 10n ** 18n), eth_getTransactionCount: '0x1', eth_estimateGas: toHex(6300000) }[e.method];
    }),
  };
  const config = { readsEnabled: true, stonxLaunch: { profile, assetOrigin: 'https://assets.example.invalid' }, feeContracts: { baseOracle: pin(address(800)) } };
  const budget = { db, key: 'c'.repeat(64), launch: () => {}, withLaunch: fn => fn() };
  const upstream = { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500' } }) };
  const live = new StonxLive(config, upstream, budget, { rpc, now: () => now });
  live.metadata = async () => published;
  live.price = async () => ({ priceUsd: '226.65000000', quotedAt: now });
  const prepare = async () => { built = await live.prepare(input); return built; };
  const receipt = plan => ({ logs: [{ address: profile.launcher.address,
    topics: encodeEventTopics({ abi: STONX_ABI, eventName: 'Create', args: { numeraire: q.token.address } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [plan.predictedAsset, profile.poolInitializer.address, plan.predictedAsset]) }] });
  return { db, profile, input, published, live, rpc, budget, config, upstream, changes, calls, prepare, receipt };
}
import * as sdkViem from 'viem';

test('stonx calldata matches official Doppler SDK 1.0.40 including tail liquidity and beneficiaries', async t => {
  const f = await fixture(t), p = f.profile, W = 10n ** 18n;
  for (const price of ['1.19000000', '226.65000000', '1770.00000000']) {
    const input = { wallet: f.input.wallet, draft: f.input.draft, pairId: f.input.pairId, metadataUri: `ipfs://${f.published.ipfs.metadataCid}`, quotePriceUsd: price, intentId: 'd'.repeat(64) };
    const built = buildUnsignedStonxLaunch(input, p);
    const sdk = new DopplerSDK({ publicClient: {}, chainId: 8453 });
    const params = sdk.buildMulticurveAuction().tokenConfig({ type: 'dopplerERC20V1', name: input.draft.name, symbol: input.draft.ticker, tokenURI: input.metadataUri })
      .saleConfig({ initialSupply: STONX_SUPPLY, numTokensToSell: STONX_SUPPLY, numeraire: p.quotes[0].token.address })
      .withCurves({ numerairePrice: Number(price), numeraireDecimals: 18, fee: 500,
        curves: STONX_BANDS.map(([a,b,numPositions,bps]) => ({ marketCap: { start: a * 5000, end: b === 'max' ? b : b * 5000 }, numPositions, shares: BigInt(bps) * 10n ** 14n })),
        beneficiaries: stonxBeneficiaries([[p.protocolBeneficiary,W * 5n / 100n],[p.integrator,W * 285n / 1000n],[input.wallet,W * 665n / 1000n]]) })
      .withRehypeDopplerHookInitializer({ hookAddress: p.dopplerHook.address,
        feeBeneficiaries: stonxBeneficiaries([[p.integrator,W * 3n / 10n],[input.wallet,W * 7n / 10n]]), feeRoutingMode: 'routeToBeneficiaryFees',
        startFee: 800000, endFee: 10000, durationSeconds: 10,
        feeDistributionInfo: { assetFeesToAssetBuybackWad: 0n, assetFeesToNumeraireBuybackWad: W, assetFeesToBeneficiaryWad: 0n, assetFeesToLpWad: 0n, numeraireFeesToAssetBuybackWad: 0n, numeraireFeesToNumeraireBuybackWad: 0n, numeraireFeesToBeneficiaryWad: W, numeraireFeesToLpWad: 0n }, graduationMarketCap: 100000 })
      .withFeeDistributionController(p.integrator).withGovernance({ type: 'noOp' }).withMigration({ type: 'noOp' })
      .withUserAddress(input.wallet).withIntegrator(p.integrator).withDopplerHookInitializer(p.poolInitializer.address).withNoOpMigrator(p.liquidityMigrator.address).build();
    const expected = sdk.factory.encodeCreateMulticurveParams({ ...params, salt: built.salt });
    const actual = decodeFunctionData({ abi: STONX_ABI, data: built.transaction.data }).args[0];
    assert.deepEqual(JSON.parse(JSON.stringify(actual, (_,v) => typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v)),
      JSON.parse(JSON.stringify(expected, (_,v) => typeof v === 'bigint' ? v.toString() : typeof v === 'string' ? v.toLowerCase() : v)));
  }
});

test('stonx prepares, reconstructs, confirms and recovers using its own handler', async t => {
  const f = await fixture(t), plan = await f.prepare();
  const verified = validateLongPlan({ ...plan, serverTime: now }, f.input, f.published, 10, 10);
  assert.equal(verified.launchpadFeeWei, '0');
  assert.ok(BigInt(plan.maximumGasWei) > BigInt(plan.transaction.gas) * BigInt(plan.transaction.gasPrice));
  await f.live.confirm(plan, f.input, f.receipt(plan), '0x64');
  assert.deepEqual(await f.prepare(), plan);
  const launches = new Launches(f.config, f.upstream, f.budget);
  launches.handlers.stonx.run = () => 'stonx';
  assert.equal(await launches.run('launch-status', { id: plan.id }), 'stonx');
  const changed = structuredClone(plan); changed.transaction.data = '0x1234';
  assert.throws(() => validateLongPlan({ ...changed, serverTime: now }, f.input, f.published, 10, 10));
  f.changes.shares = 1n;
  await assert.rejects(f.live.confirm(plan, f.input, f.receipt(plan), '0x64'), /launch_receipt_unverified/);
});

test('stonx rejects wrong chain, changed deployment, unknown pairing and insufficient balance', async t => {
  const f = await fixture(t);
  assert.equal(readStonxConfig({}), null);
  assert.throws(() => readStonxConfig({ STONX_BASE_WALLET_LAUNCH: 'true' }));
  assert.throws(() => readStonxProfile({ ...f.profile, chainId: 4663 }));
  assert.deepEqual(validateLongInput('launch-prepare', f.input), f.input);
  assert.throws(() => validateLongInput('launch-prepare', { ...f.input, chainId: 4663 }));
  assert.throws(() => validateLongInput('launch-prepare', { ...f.input, editableMetadata: true }));
  f.changes.balance = 0n;
  await assert.rejects(f.prepare(), e => e.code === 'insufficient_funds');
  f.changes.code = true;
  await assert.rejects(f.prepare(), /contract_unverified/);
});

test('stonx stock prices must be timestamped and fresh', () => {
  const token = address(1), body = { data: { stockUsdPrices: { items: [{ address: token, price: '22665000000', timestamp: String(now / 1000) }] } } };
  assert.equal(parseStonxPrice(body, token, now).priceUsd, '226.65000000');
  assert.throws(() => parseStonxPrice(body, token, now + 600001), /oracle_stale/);
  assert.throws(() => parseStonxPrice(body, address(2), now), /oracle_stale/);
});

test('stonx ignores an early future bucket when a fresh current stock price exists', () => {
  const token = address(1), row = (seconds, price) => ({ address: token, price, timestamp: String(now / 1000 + seconds) });
  const body = items => ({ data: { stockUsdPrices: { items } } });
  const future = row(240, '99900000000'), fresh = row(-60, '22665000000'), older = row(-360, '20000000000');
  const selected = parseStonxPrice(body([future, older, fresh]), token, now);
  assert.equal(selected.priceUsd, '226.65000000');
  assert.equal(selected.timestamp, now - 60000);
  assert.throws(() => parseStonxPrice(body([future]), token, now), /oracle_stale/);
  assert.throws(() => parseStonxPrice(body([future, row(-601, '20000000000')]), token, now), /oracle_stale/);
  assert.throws(() => parseStonxPrice(body([future, { ...fresh, address: address(2) }]), token, now), /oracle_stale/);
});

test('stonx wallet verifies the simulated token before reserving or dispatching', async t => {
  const f = await fixture(t), raw = await f.prepare();
  const plan = validateLongPlan({ ...raw, serverTime: now }, f.input, f.published, performance.now());
  let reserved = 0, sent = 0, wrongToken = true;
  const provider = { request: async ({ method, params }) => {
    if (method === 'eth_accounts') return [f.input.wallet];
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_getCode') {
      if (params[0] === f.profile.quotes[0].token.address) return stonxWrapperBytecode(f.profile.quotes[0].beacon.address);
      return '0x01';
    }
    if (method === 'eth_getTransactionCount') return plan.transaction.nonce;
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_call' && params[0].to === f.profile.quotes[0].beacon.address) return encodeFunctionResult({ abi: STONX_ABI, functionName: 'implementation', result: f.profile.quotes[0].implementation.address });
    if (method === 'eth_call') return encodeFunctionResult({ abi: STONX_ABI, functionName: 'create', result: [wrongToken ? address(99) : plan.predictedAsset, plan.predictedAsset, zeroAddress, zeroAddress, zeroAddress] });
    if (method === 'eth_sendTransaction') { sent++; return toHex(123, { size: 32 }); }
    throw Error(method);
  } };
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { reserved++; }));
  assert.equal(reserved,0); assert.equal(sent,0);
  wrongToken = false;
  await sendLongWallet(provider, plan, () => true, async () => { reserved++; });
  assert.equal(reserved,1); assert.equal(sent,1);
});

test('all 45 wrapped stocks appear only on Base; server catalog and success link retain stonx identity', async t => {
  const f = await fixture(t), pads = selectChain(DEFAULT_DESTINATIONS, 8453);
  assert.deepEqual(pads.filter(p => supportsChain(p.id,8453)).map(p => p.id), ['o1','stonx','stonks']);
  assert.equal(STONX_PAIRS.length,45);
  assert.deepEqual(readablePads(['stonx']), []);
  const stonx = { ...pads.find(p => p.id === 'stonx'), selected: true };
  for (const pair of STONX_PAIRS)
    assert.deepEqual(validateDraft({ name: 'Sample', ticker: 'SAMPLE', description: '', hasImage: true }, [{ ...stonx, pairId: pair.id }],8453), {}, pair.symbol);
  assert.ok(validateDraft({ name: 'Sample', ticker: 'SAMPLE', description: '', hasImage: true }, [{ ...stonx, chainId: 4663 }],4663).destinations);
  const adapters = new Adapters(f.config, f.upstream);
  assert.equal(parseCatalog(await adapters.catalog(8453),8453).pads.stonx.pairs.length,1);
  assert.equal(confirmedLaunchTokenUrl('stonx',{status:'confirmed',asset:address(9)},8453),`https://stonx.ai/t/${address(9)}`);
});

test('stonx runtime requires the complete 45-stock catalog and publishes every pairing', async () => {
  const profile = profileFixture();
  profile.quotes = STONX_PAIRS.map((pair, i) => profileFixture(pair.symbol, address(2n ** 159n + BigInt(i))).quotes[0]);
  const env = { STONX_BASE_WALLET_LAUNCH: 'true', STONX_BASE_PROFILE_JSON: JSON.stringify(profile), LAUNCH_ASSET_SERVICE_ORIGIN: 'https://assets.example.invalid' };
  const stonxLaunch = readStonxConfig(env);
  const catalog = parseCatalog(await new Adapters({ readsEnabled: true, stonxLaunch }, {}).catalog(8453), 8453);
  assert.deepEqual(catalog.pads.stonx.pairs, profile.quotes.map(({ id, symbol }) => ({ id, symbol })));
  assert.throws(() => readStonxConfig({ ...env, STONX_BASE_PROFILE_JSON: JSON.stringify({ ...profile, quotes: profile.quotes.slice(1) }) }), { code: 'stonx_configuration' });
});

test('every wrapped-stock pairing can prepare, reconstruct and confirm a launch', async t => {
  for (const [i, pair] of STONX_PAIRS.entries()) await t.test(pair.symbol, async t => {
    const f = await fixture(t, pair.symbol, address(2n ** 159n + BigInt(i)));
    assert.deepEqual(validateLongInput('launch-prepare', f.input), f.input);
    const raw = await f.prepare();
    const plan = validateLongPlan({ ...raw, serverTime: now }, f.input, f.published, 10, 10);
    assert.equal(plan.review.pairId, f.input.pairId);
    assert.equal(decodeFunctionData({ abi: STONX_ABI, data: plan.transaction.data }).args[0].numeraire.toLowerCase(), f.profile.quotes[0].token.address);
    await f.live.confirm(plan, f.input, f.receipt(plan), '0x64');
  });
});
