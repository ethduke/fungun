import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, keccak256, parseTransaction, toHex, zeroAddress } from 'viem';
import { ServiceError } from './errors.mjs';
import { O1Live, readO1BaseLiveConfig } from './o1-live.mjs';
import { LongRecovery } from './long-recovery.mjs';
import { validateLongInput } from './long-live.mjs';
import { ipfsContentId } from './ipfs-content.mjs';
import { Launches } from './launches.mjs';
import { catalogPairId } from './catalog-snapshots.mjs';
import { O1_LAUNCH_ABI, predictO1B20Address, readO1LaunchProfile } from '../../web/lib/long-encoding/o1-launch.mjs';
import { o1Metadata } from '../../web/lib/long-encoding/o1-metadata.mjs';
import { validateLongPlan, sendLongWallet } from '../../web/lib/long-wallet.ts';
import { longWalletCostStep, estimateNetworkFee } from '../../web/lib/launch-cost.ts';
import { confirmedLaunchTokenUrl } from '../../web/lib/long-recovery.ts';
import { launchRecoveryScope } from '../../web/lib/launch-draft-cache.ts';

const addr = n => toHex(n, { size: 20 }), hash = n => toHex(n, { size: 32 });
const b20 = tail => `0xb2${'00'.repeat(10)}${tail}`;
const stockAddress = b20('000000000000000001');
const contract = n => ({ address: addr(n), codeHash: keccak256('0x01') });
async function fixture(t, stock = false) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const now = 1800000000000, pool = hash(50), blockHash = hash(51), txHash = hash(52);
  const quote = stock ? { id: catalogPairId(8453, stockAddress), decimals: 8, token: { address: stockAddress } }
    : { id: 'native', decimals: 18, token: null };
  const profile = { chainId: 8453, launchpad: 'o1', launcher: contract(1), launchTokenValidator: contract(2),
    hook: contract(3), feeEscrow: contract(4), announcementRegistry: contract(5), quotes: [quote] };
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Synthetic Base test' };
  const imageCid = await ipfsContentId(Buffer.from('synthetic')), imageUri = `ipfs://${imageCid}`;
  const bytes = Buffer.from(JSON.stringify({ name: draft.name, symbol: draft.ticker, description: draft.description, image: imageUri, image_hash: imageUri }));
  const publication = { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: createHash('sha256').update(bytes).digest('hex') };
  const published = { ...publication, status: 'published', ipfs: { imageCid, metadataCid: await ipfsContentId(bytes) } };
  const input = { chainId: 8453, wallet: addr(1001), pairId: quote.id, draft, publication, editableMetadata: true };
  const metadataUri = o1Metadata(draft, imageCid).uri;
  const change = {}, seen = [];
  const rpc = {
    block: async chain => { assert.equal(chain, 8453); return '0x64'; },
    verify: async (chain, entries) => { assert.equal(chain, 8453); assert.ok(entries.every(e => e.codeHash)); },
    calls: async (chain, entries) => {
      assert.equal(chain, 8453);
      return entries.map(e => {
        seen.push(e.functionName);
        if (e.functionName === 'getB20Address') return change.badPrediction ? addr(99) : predictO1B20Address(e.args[1], e.args[2]);
        if (e.functionName === 'isB20Initialized') return quote.token?.address === e.args[0] ? !change.quoteMissing : !!change.occupied;
        if (e.functionName === 'getL1Fee') {
          const tx = parseTransaction(e.args[0]);
          assert.equal(tx.chainId, 8453); assert.equal(tx.gas, change.underfundedSimulation ? 8000000n : 600000n); assert.equal(tx.nonce, 1);
          assert.equal(tx.value, 10n ** 15n);
          return change.l1 ?? 1000n;
        }
        if (e.functionName === 'validate') {
          assert.deepEqual(e.args, [change.plan.predictedAsset, input.wallet, profile.launcher.address, profile.hook.address, 10n ** 27n, true]);
          if (change.badRights) throw new Error('invalid B20 roles');
          return undefined;
        }
        const values = { configVersion: 12n, launchSupply: 10n ** 27n, launchCreationEnabled: !change.disabled,
          quoteConfig: [true, quote.decimals, 0], TOKEN_ADDRESS_SUFFIX: 1, launchTokenValidator: profile.launchTokenValidator.address,
          hook: profile.hook.address, announcementRegistry: profile.announcementRegistry.address, feeEscrow: profile.feeEscrow.address,
          tickSpacing: 60, nativeLaunchFee: 10n ** 15n, isActivated: !change.inactive, getOperatorFee: 200n,
          name: draft.name, symbol: draft.ticker, contractURI: metadataUri, totalSupply: 10n ** 27n,
          creatorRights: { originalCreator: input.wallet, creatorFeeRecipient: input.wallet, poolId: pool, metadataEditable: true } };
        assert.ok(Object.hasOwn(values, e.functionName), e.functionName);
        return values[e.functionName];
      });
    },
    batch: async (chain, entries) => {
      assert.equal(chain, 8453);
      return entries.map(e => {
        if (e.method === 'eth_call') {
          if (change.underfundedSimulation) throw new ServiceError('insufficient_funds');
          const params = decodeFunctionData({ abi: O1_LAUNCH_ABI, data: e.params[0].data }).args[0];
          assert.equal(params.quoteToken, quote.token?.address ?? zeroAddress);
          assert.equal(params.tokenContractURI, metadataUri);
          const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [input.wallet, params.creatorSalt]));
          return encodeFunctionResult({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', result: [predictO1B20Address(profile.launcher.address, salt), pool] });
        }
        const values = { eth_getBlockByNumber: { timestamp: toHex(now / 1000), hash: blockHash }, eth_getCode: '0x',
          eth_gasPrice: toHex(1000000), eth_getBalance: toHex(change.balance ?? 10n ** 18n), eth_getTransactionCount: '0x1',
          eth_estimateGas: toHex(500000), eth_chainId: '0x2105', eth_blockNumber: '0x100',
          eth_getTransactionByHash: change.tx, eth_getTransactionReceipt: change.receipt };
        assert.ok(Object.hasOwn(values, e.method), e.method); return values[e.method];
      });
    },
  };
  const config = { readsEnabled: true, o1Launch: { profile }, feeContracts: { baseOracle: { ...contract(6), implementation: addr(7), implementationCodeHash: keccak256('0x01') } } };
  const budget = { db, key: 'a'.repeat(64), launch: () => {}, withLaunch: fn => fn() };
  const live = new O1Live(config, { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500' } }) }, budget, { rpc, now: () => now });
  live.metadata = async () => published;
  live.o1Metadata.prepare = async () => ({ metadataUri });
  const receiptFor = plan => {
    change.plan = plan;
    change.tx = { ...plan.transaction, input: plan.transaction.data, hash: txHash, blockHash, blockNumber: '0x64' };
    change.receipt = { from: input.wallet, to: profile.launcher.address, transactionHash: txHash, blockHash, blockNumber: '0x64',
      gasUsed: toHex(500000), effectiveGasPrice: toHex(1000000), l1Fee: toHex(900), status: '0x1', logs: [{ address: profile.launcher.address,
        topics: encodeEventTopics({ abi: O1_LAUNCH_ABI, eventName: 'Launched', args: { token: plan.predictedAsset, poolId: pool, originalCreator: input.wallet } }),
        data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int24' }], [quote.token?.address ?? zeroAddress, 10n ** 27n, 60]) }] };
  };
  return { db, now, profile, config, budget, live, input, published, change, seen, rpc, txHash, receiptFor };
}

void test('B20 prediction matches an independently checked Base precompile vector', () => {
  assert.equal(predictO1B20Address(addr(1), hash(0)), b20('ada5013122d395ba3c'));
});

for (const stock of [false, true]) void test(`Base ${stock ? 'stock' : 'ETH'} launch rebuilds, budgets all fees, sends once and verifies B20 receipt`, async t => {
  const f = await fixture(t, stock);
  const estimate = await f.live.run('launch-estimate', { chainId: 8453, pairId: f.input.pairId });
  assert.equal(estimate.basis, 'requires-calldata'); assert.equal(estimate.gasPriceWei, undefined);
  const raw = await f.live.run('launch-prepare', f.input);
  assert.match(raw.predictedAsset, /^0xb200000000000000000000[a-f0-9]{16}01$/);
  assert.equal(raw.buildInput.initCodeHash, undefined);
  assert.deepEqual(raw.baseFees, { l1DataFeeWei: '1200', operatorFeeWei: '200' });
  assert.equal(raw.maximumGasWei, '600000001400');
  const response = { ...raw, serverTime: f.now };
  const plan = validateLongPlan(response, f.input, f.published, performance.now());
  assert.equal(estimateNetworkFee(longWalletCostStep(plan).network), 600000001400n);
  for (const update of [{ chainId: 4663 }, { transaction: { ...raw.transaction, chainId: '0x1237' } }, { baseFees: undefined },
    { baseFees: { l1DataFeeWei: '0', operatorFeeWei: '0' } }, { maximumGasWei: '600000000000' }])
    assert.throws(() => validateLongPlan({ ...response, ...update }, f.input, f.published, performance.now()));
  let sends = 0, chain = '0x1237';
  const provider = { request: async ({ method, params }) => {
    const values = { eth_accounts: [f.input.wallet], eth_chainId: chain, eth_getCode: '0x01', eth_getTransactionCount: '0x1', eth_getBalance: toHex(10n ** 18n) };
    if (method === 'eth_sendTransaction') { sends++; assert.equal(params[0].chainId, '0x2105'); return f.txHash; }
    assert.ok(Object.hasOwn(values, method), method); return values[method];
  } };
  const reserve = async () => f.live.run('launch-reserve', { id: raw.id, binding: raw.binding });
  await assert.rejects(sendLongWallet(provider, plan, () => true, reserve)); assert.equal(sends, 0);
  chain = '0x2105';
  assert.equal(await sendLongWallet(provider, plan, () => true, reserve), f.txHash); assert.equal(sends, 1);
  f.receiptFor(plan);
  const result = await f.live.run('launch-status', { id: plan.id, hash: f.txHash });
  assert.equal(result.status, 'confirmed'); assert.equal(result.paidGasWei, '500000001100');
  assert.equal(confirmedLaunchTokenUrl('o1', result, 8453), `https://launch.o1.exchange/token/${plan.predictedAsset}?chain=8453`);
  assert.ok(f.seen.includes('validate')); assert.ok(!f.seen.includes('tokenDeployer'));
});

void test('Base refuses inactive B20, occupied assets, substituted predictions and insufficient total fee balance', async t => {
  for (const [change, code] of [[{ inactive: true }, 'contract_unverified'], [{ occupied: true }, 'launch_already_exists'],
    [{ badPrediction: true }, 'contract_unverified'], [{ quoteMissing: true }, 'contract_unverified'],
    [{ disabled: true }, 'o1_launch_disabled'], [{ balance: 1000600000000000n }, 'insufficient_funds']]) {
    const f = await fixture(t, true); Object.assign(f.change, change);
    await assert.rejects(f.live.run('launch-prepare', f.input), { code });
  }
  const f = await fixture(t); delete f.config.feeContracts.baseOracle;
  await assert.rejects(f.live.prepare(f.input), { code: 'contract_unverified' });
});

void test('Base confirmation checks B20 roles, and recovery and dispatch cannot cross chains', async t => {
  const f = await fixture(t), plan = await f.live.prepare(f.input);
  f.receiptFor(plan); f.change.badRights = true;
  await assert.rejects(f.live.confirm(plan, f.input, f.change.receipt, '0x64'));
  const launches = new Launches({ ...f.config, o1BaseLaunch: f.config.o1Launch, o1Launch: null }, {}, f.budget);
  launches.handlers.o1Base.run = async () => 'base'; launches.handlers.o1.run = async () => 'robinhood';
  assert.equal(await launches.run('launch-prepare', f.input), 'base');
  assert.equal(await launches.run('launch-prepare', { ...f.input, chainId: 4663 }), 'robinhood');
  assert.equal(await launches.run('launch-status', { id: plan.id }), 'base');
  const recovery = new LongRecovery(f.rpc, 8453);
  assert.deepEqual(await recovery.find(plan.id, plan.transaction), { status: 'retryable' });
  await assert.rejects(recovery.find(plan.id, { ...plan.transaction, chainId: '0x1237' }), { code: 'wrong_chain' });
  const args = [f.input.wallet, 'native', f.input.draft, new Blob(['test'])];
  assert.notEqual(await launchRecoveryScope(...args, 4663), await launchRecoveryScope(...args, 8453));
});

void test('Base configuration is independent of Long, and rejects wrong roles, chains and token types', async t => {
  const f = await fixture(t, true), env = { O1_BASE_WALLET_LAUNCH: 'true', O1_BASE_LAUNCH_PROFILE_JSON: JSON.stringify(f.profile), LAUNCH_ASSET_SERVICE_ORIGIN: 'https://assets.example.com' };
  assert.equal(readO1BaseLiveConfig(env).profile.chainId, 8453);
  assert.equal(readO1BaseLiveConfig({ ...env, O1_BASE_WALLET_LAUNCH: 'false' }), null);
  for (const p of [{ ...f.profile, chainId: 4663 }, { ...f.profile, tokenDeployer: contract(7) },
    { ...f.profile, quotes: [{ ...f.profile.quotes[0], id: `rwa-${'a'.repeat(24)}` }] },
    { ...f.profile, quotes: [{ ...f.profile.quotes[0], token: contract(10) }] }]) {
    assert.throws(() => readO1LaunchProfile(p));
    assert.throws(() => readO1BaseLiveConfig({ ...env, O1_BASE_LAUNCH_PROFILE_JSON: JSON.stringify(p) }));
  }
  for (const pairId of ['long-NVDA', 'longbow-NVDA', 'crypto-USDG'])
    assert.throws(() => validateLongInput('launch-prepare', { ...f.input, pairId }));
});


void test('Base funding guidance includes L1 and operator fees when low balance prevents simulation', async t => {
  const f = await fixture(t);
  Object.assign(f.change, { balance: 0n, underfundedSimulation: true });
  await assert.rejects(f.live.prepare(f.input), error => {
    assert.equal(error.code, 'insufficient_funds');
    assert.deepEqual(error.funding, { chainId: 8453, balanceWei: '0', requiredWei: '1008000000001400', shortfallWei: '1008000000001400', basis: 'gas-limit' });
    return true;
  });
});
