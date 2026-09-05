import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex, type EIP1193Provider } from 'viem';
import { buildUnsignedLongLaunch } from './long-encoding/long-launch.mjs';
import { sendLongWallet, validateLongPlan, LaunchPreflightError, type LaunchInput, readLaunchRecovery, saveLaunchRecovery, prepareLongWallet, isLongLaunchPair } from './long-wallet.ts';
import { launchRecoveryScope } from './launch-draft-cache.ts';
import { runLaunchFlow } from './launch-flow.ts';
import type { PublishedAsset } from './asset-protocol.ts';
const addr = (n: number | bigint) => toHex(BigInt(n), { size: 20 });
const hash = (n: number) => toHex(BigInt(n), { size: 32 });
const contract = (n: number) => ({ address: addr(n), codeHash: keccak256('0x01') });
function fixture(pairId = 'long-NVDA') {
  const profile = { chainId: 4663, launcher: contract(1), airlock: contract(2), tokenFactory: { ...contract(3), initCodeHash: hash(103) },
    governanceFactory: contract(4), poolInitializer: contract(5), liquidityMigrator: contract(6), dopplerHook: contract(7),
    integrator: addr(8), protocolBeneficiary: addr(9), quotes: [{ id: pairId, token: { ...contract(10), address: addr(2n ** 160n - 1n) }, oracle: contract(11), decimals: 18, oracleDecimals: 8 }] };
  const input: LaunchInput = { chainId: 4663, wallet: addr(1001), draft: { name: 'Sample', ticker: 'SAMPLE', description: '' }, pairId,
    publication: { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: 'c'.repeat(64) } };
  const cid = 'bafkreia' + 'a'.repeat(51);
  const published: PublishedAsset = { ...input.publication, status: 'published', launchReady: false, imageUrl: '', metadataUrl: '',
    ipfs: { profile: 'pinata-v1-256k', schema: 'long-ipfs-v1', imageCid: cid, metadataCid: cid } };
  const intentId = '00000000-0000-4000-8000-000000000001', startingTick = -160000;
  const plan = buildUnsignedLongLaunch({ chainId: 4663, wallet: input.wallet, draft: input.draft,
    pairId: input.pairId, metadataUri: `ipfs://${cid}`, startingTick, intentId }, profile);
  return { profile, input, published, plan, startingTick, intentId };
}
function response(pairId = 'long-NVDA') {
  const f = fixture(pairId), now = Date.now();
  return { ...f, raw: { id: 'd'.repeat(64), binding: f.plan.binding, chainId: 4663,
    quotedAt: now, expiresAt: now + 30000, serverTime: now, profile: f.profile,
    startingTick: f.startingTick, intentId: f.intentId, predictedAsset: f.plan.predictedAsset, predictedPool: addr(200), review: f.plan.review,
    transaction: { ...f.plan.transaction, chainId: '0x1237', value: '0x0', nonce: '0x1', gas: toHex(1200000), gasPrice: toHex(1000000000) },
    estimatedGas: '1000000', maximumGasWei: String(1200000n * 1000000000n), launchpadFeeWei: '0',
    usd: { sourceLabel: 'Coinbase ETH/USD spot', quotedAt: now, microUsdPerEth: '2500000000' } } };
}

void test('browser reconstructs the exact reviewed calldata and rejects value, target, wallet, cost and hidden field substitution', () => {
  const f = response(), start = performance.now();
  const checked = validateLongPlan(f.raw, f.input, f.published, start);
  assert.equal(checked.transaction.data, f.plan.transaction.data);
  for (const change of [ { to: addr(999) }, { from: addr(999) }, { value: '0x1' }, { chainId: '0x1' }, { data: '0x' }, { gas: '0x1' }, { authorizationList: [] } ]) {
    assert.throws(() => validateLongPlan({ ...f.raw, transaction: { ...f.raw.transaction, ...change } }, f.input, f.published, start));
  }
  assert.throws(() => validateLongPlan({ ...f.raw, launchpadFeeWei: '1' }, f.input, f.published, start));
  assert.throws(() => validateLongPlan(f.raw, { ...f.input, draft: { ...f.input.draft, name: 'Changed' } }, f.published, start));
  assert.throws(() => validateLongPlan(f.raw, f.input, f.published, start, start + 31000));
});

void test('only the wallet sends, once, after current identity checks and durable reservation', async () => {
  const f = response(), plan = validateLongPlan(f.raw, f.input, f.published, performance.now());
  const calls: string[] = []; let reserved = false;
  const provider = { request: async ({ method }: { method: string }) => {
    calls.push(method);
    if (method === 'eth_accounts') return [f.input.wallet];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getCode') return '0x01';
    if (method === 'eth_getTransactionCount') return '0x1';
    if (method === 'eth_sendTransaction') { assert.ok(reserved); return hash(500); }
    throw new Error('unexpected wallet method');
  } } as EIP1193Provider;
  assert.equal(await sendLongWallet(provider, plan, () => true, async () => { reserved = true; }), hash(500));
  assert.equal(calls.filter((m) => m === 'eth_sendTransaction').length, 1);
  reserved = false; calls.length = 0;
  await assert.rejects(sendLongWallet(provider, plan, () => !reserved, async () => { reserved = true; }));
  assert.ok(!calls.includes('eth_sendTransaction'));
  calls.length = 0;
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { throw new Error('reservation lost'); }));
  assert.ok(!calls.includes('eth_sendTransaction'));
});

void test('only errors before eth_sendTransaction are eligible for automatic preflight retry', async () => {
  const f = response(), plan = validateLongPlan(f.raw, f.input, f.published, performance.now());
  let sends = 0;
  const error = new Error('lost wallet response');
  const provider = { request: async ({ method }: { method: string }) => {
    if (method === 'eth_accounts') return [f.input.wallet];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getCode') return '0x01';
    if (method === 'eth_getTransactionCount') return '0x1';
    if (method === 'eth_sendTransaction') { sends++; throw error; }
    throw new Error('unexpected');
  } } as EIP1193Provider;
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => { throw error; }),
    e => e instanceof LaunchPreflightError && e.cause === error);
  assert.equal(sends, 0);
  await assert.rejects(sendLongWallet(provider, plan, () => true, async () => {}), e => e === error && !(e instanceof LaunchPreflightError));
  assert.equal(sends, 1);
});


void test('COPY isolates recovery by content, account and destination while preserving legacy and prior attempts', async t => {
  const storage = new Map<string, string>();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const draft = { name: 'Original', ticker: 'ORIGINAL', description: '' }, image = new Blob(['artwork']);
  const scope = await launchRecoveryScope(addr(1001), 'long-NVDA', draft, image);
  const previous = { id: 'a'.repeat(64), binding: 'b'.repeat(64), hash: hash(600) };
  saveLaunchRecovery(previous); // Existing production browser record.
  saveLaunchRecovery(previous, scope);
  const copied = await launchRecoveryScope(addr(1001), 'long-NVDA', { ...draft, name: 'Copied', ticker: 'COPIED' }, image);
  assert.equal(readLaunchRecovery(copied), null);
  const next = { id: 'c'.repeat(64), binding: 'd'.repeat(64), hash: null };
  saveLaunchRecovery(next, copied);
  assert.deepEqual(readLaunchRecovery(copied), next);
  assert.deepEqual(readLaunchRecovery(scope), previous);
  assert.deepEqual(readLaunchRecovery(), previous);
  assert.equal(await launchRecoveryScope(addr(1001).toUpperCase(), 'long-NVDA', draft, new Blob(['artwork'])), scope);
  for (const other of [await launchRecoveryScope(addr(1002), 'long-NVDA', draft, image),
    await launchRecoveryScope(addr(1001), 'long-TSLA', draft, image),
    await launchRecoveryScope(addr(1001), 'long-NVDA', draft, new Blob(['different image']))]) {
    assert.notEqual(other, scope); assert.equal(readLaunchRecovery(other), null);
  }
});

void test('existing submitted intent resumes without wallet dispatch after a lost or legacy browser record', async t => {
  const f = response(), recovery = { id: f.raw.id, binding: f.raw.binding, hash: hash(600) };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ recovery, serverTime: Date.now() }));
  let sends = 0, resumed = false;
  await runLaunchFlow({ artwork: async () => f.published,
    quote: artwork => prepareLongWallet(f.input, artwork),
    wallet: async prepared => {
      if (prepared.recovery) { assert.deepEqual(prepared.recovery, recovery); resumed = true; }
      else sends++;
    }, isCurrent: () => true, onProgress: () => {} });
  assert.ok(resumed); assert.equal(sends, 0);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ recovery: { ...recovery, hash: 'invalid' } }));
  await assert.rejects(prepareLongWallet(f.input, f.published), /recovery_unavailable/);
});


void test('TSLA wallet launch reconstructs the selected pairing; other unsupported routes remain disabled', () => {
  assert.ok(isLongLaunchPair('long-TSLA')); assert.ok(isLongLaunchPair('long-NVDA'));
  for (const pair of ['long-MU','longbow-TSLA',undefined]) assert.equal(isLongLaunchPair(pair), false);
  const f = response('long-TSLA');
  const checked = validateLongPlan(f.raw, f.input, f.published, performance.now());
  assert.equal(checked.transaction.data, f.plan.transaction.data);
  assert.throws(() => validateLongPlan(f.raw, {...f.input,pairId:'long-NVDA'}, f.published, performance.now()));
});
