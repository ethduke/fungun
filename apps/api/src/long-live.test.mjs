import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters, getCreate2Address, toHex } from "viem";
import { Budget } from "./budget.mjs";
import { LongLive, LONG_STATE_ABI, readLongLiveConfig, validateLongInput } from "./long-live.mjs";
import { LONG_CREATE_ABI } from "./long-launch.mjs";
import { ipfsContentId } from "./ipfs-content.mjs";
const addr = (n) => toHex(BigInt(n), { size: 20 });
const hash = (n) => toHex(BigInt(n), { size: 32 });
const contract = (n) => ({ address: addr(n), codeHash: hash(n) });
async function fixture(t) {
  let now = 1800000000000;
  const root = mkdtempSync(join(tmpdir(), 'long-live-'));
  const path = join(root, 'budget.sqlite');
  const budget = new Budget(path, () => now);
  t.after(() => { try { budget.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  const p = { chainId: 4663, launcher: contract(1), airlock: contract(2), tokenFactory: { ...contract(3), initCodeHash: hash(103) },
    governanceFactory: contract(4), poolInitializer: contract(5), liquidityMigrator: contract(6), dopplerHook: contract(7),
    integrator: addr(8), protocolBeneficiary: addr(9), quotes: [{ id: 'long-NVDA', token: { ...contract(10), address: addr(2n ** 160n - 1n) }, oracle: contract(11), decimals: 18, oracleDecimals: 8 }] };
  const g = { tokenBeacon: contract(12), tokenImplementation: contract(13), oracleAggregator: contract(14), heartbeatSeconds: 86400 };
  const config = { readsEnabled: true, origin: 'https://example.com', longLaunch: { profile: p, guards: { 'long-NVDA': g }, assetOrigin: 'https://assets.example.com' } };
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Test metadata' };
  const imageCid = await ipfsContentId(Buffer.from('synthetic'));
  const imageUri = `ipfs://${imageCid}`;
  const metadata = Buffer.from(JSON.stringify({ name: draft.name, symbol: draft.ticker, description: draft.description, image: imageUri, image_hash: imageUri }));
  const publication = { id: 'a'.repeat(48), imageHash: 'b'.repeat(64), metadataHash: createHash('sha256').update(metadata).digest('hex') };
  const published = { ...publication, status: 'published', ipfs: { profile: 'pinata-v1-256k', schema: 'long-ipfs-v1', imageCid, metadataCid: await ipfsContentId(metadata) } };
  const input = { chainId: 4663, wallet: addr(1001), pairId: 'long-NVDA', draft, publication };
  const changes = {}, seen = [], requests = [];
  const rpc = {
    block: async () => '0x64',
    verify: async (...args) => { seen.push(args); if (changes.code) throw new Error('unverified'); },
    calls: async (_chain, entries) => entries.map((e) => {
      switch(e.functionName) {
        case 'AIRLOCK': return p.airlock.address;
        case 'TRUSTED_TOKEN_FACTORY': return p.tokenFactory.address;
        case 'RESERVATION_DURATION': return 86400;
        case 'paused': return changes.paused ?? false;
        case 'getModuleState': return ['tokenFactory','governanceFactory','poolInitializer','liquidityMigrator'].findIndex((r) => p[r].address === e.args[0]) + 1;
        case 'decimals': return e.address === p.quotes[0].token.address ? 18 : 8;
        case 'latestRoundData': return [1n, 23000000000n, BigInt(now / 1000 - 20), BigInt(now / 1000 - (changes.age ?? 10)), 1n];
        case 'isTickerAvailable': return !changes.reserved;
        case 'implementation': return changes.implementation ?? g.tokenImplementation.address;
        case 'aggregator': return g.oracleAggregator.address;
        case 'oraclePaused': return changes.oraclePaused ?? false;
        case 'name': return draft.name;
        case 'symbol': return draft.ticker;
        case 'tokenURI': return imageUri.replace(imageCid, published.ipfs.metadataCid);
        case 'totalSupply': return 10n ** 27n;
        case 'getTickerRecord': return [changes.plan.predictedAsset, 100, 86500];
        case 'getAssetData': return [p.quotes[0].token.address, addr(20), addr(21), p.liquidityMigrator.address, p.poolInitializer.address, addr(200), addr(22), 10n ** 27n, 10n ** 27n, p.integrator];
        default: throw new Error('unexpected call');
      }
    }),
    batch: async (_chain, entries) => entries.map((e) => {
      requests.push(e.method);
      switch(e.method) {
        case 'eth_chainId': return '0x1237';
        case 'eth_blockNumber': return '0x100';
        case 'eth_getStorageAt': return toHex(BigInt(g.tokenBeacon.address), { size: 32 });
        case 'eth_getBlockByNumber': return { timestamp: toHex(now / 1000), hash: changes.reorg ? hash(900) : hash(500) };
        case 'eth_getCode': return changes.occupied ? '0x01' : '0x';
        case 'eth_call': {
          const params = decodeFunctionData({ abi: LONG_CREATE_ABI, data: e.params[0].data }).args[0];
          const asset = getCreate2Address({ from: p.tokenFactory.address, salt: params.salt, bytecodeHash: p.tokenFactory.initCodeHash });
          return encodeFunctionResult({ abi: LONG_CREATE_ABI, functionName: 'create', result: [changes.badSimulation ? addr(55) : asset, addr(200), addr(201), addr(202), addr(203)] });
        }
        case 'eth_estimateGas': return toHex(changes.gas ?? 1000000);
        case 'eth_gasPrice': return toHex(1000000000);
        case 'eth_getBalance': return toHex(changes.balance ?? 10n ** 18n);
        case 'eth_getTransactionCount': return '0x1';
        case 'eth_getTransactionByHash': return changes.tx ?? null;
        case 'eth_getTransactionReceipt': return changes.receipt ?? null;
        default: throw new Error('unexpected RPC');
      }
    }),
  };
  const upstream = { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500.12' } }) };
  const options = { now: () => now, rpc, fetcher: async (_url, request) => {
    assert.equal(request.headers['x-fungun-intent'], 'asset-status');
    assert.equal(JSON.parse(request.body).wallet, input.wallet);
    return Response.json(published);
  } };
  const service = new LongLive(config, upstream, budget, options);
  return { service, input, p, g, changes, seen, requests, budget, path, config, upstream, options, advance: (n) => now += n };
}

test('preparation binds metadata, verifies dependencies at one block and returns a bounded unsigned transaction', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  assert.equal(plan.launchpadFeeWei, '0'); assert.equal(plan.transaction.value, '0x0');
  assert.equal(plan.maximumGasWei, String(1200000n * 1000000000n));
  assert.ok(f.requests.includes('eth_estimateGas'));
  assert.equal(f.seen.length, 2); assert.ok(f.seen.every((v) => v[3] === '0x64'));
  assert.equal(f.seen[1][1].length, 3);
  const reads = f.requests.length;
  assert.deepEqual(await f.service.run('launch-prepare', f.input), plan);
  assert.equal(f.requests.length, reads);
  assert.ok(!f.requests.some((m) => /send|sign/i.test(m)));
});

test('one durable reservation survives restart, repeat clicks, edited context and expired estimates', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  assert.throws(() => f.service.reserve({ id: plan.id, binding: 'f'.repeat(64) }));
  assert.equal(f.service.reserve(plan).status, 'wallet');
  assert.throws(() => f.service.reserve(plan), /launch_pending/);
  f.budget.close();
  const reopened = new Budget(f.path, f.options.now, false); t.after(() => reopened.close());
  const service = new LongLive(f.config, f.upstream, reopened, f.options);
  await assert.rejects(service.run('launch-prepare', f.input), /launch_pending/);
  assert.equal((await service.run('launch-status', { id: plan.id, hash: null })).status, 'uncertain');
});

test('changed metadata, stale or paused prices, changed implementations, occupied addresses and unsafe gas fail closed', async (t) => {
  for (const change of [{ age: 86401 }, { oraclePaused: true }, { paused: true }, { implementation: addr(999) }, { occupied: true }, { gas: 3000000 }, { balance: 0n }, { reserved: true }, { badSimulation: true }]) {
    const f = await fixture(t); Object.assign(f.changes, change);
    await assert.rejects(f.service.run('launch-prepare', f.input));
    assert.equal(f.budget.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n, 0);
  }
  const f = await fixture(t);
  await assert.rejects(f.service.run('launch-prepare', { ...f.input, draft: { ...f.input.draft, name: 'Changed' } }), /launch_assets_unverified/);
});

test('receipt verification rejects substituted transactions and requires canonical confirmations plus matching event and state', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input); f.changes.plan = plan;
  f.service.reserve(plan);
  const txHash = hash(600), blockHash = hash(500);
  f.changes.tx = { ...plan.transaction, input: plan.transaction.data, hash: txHash, blockHash, blockNumber: '0x64', value: '0x1' };
  await assert.rejects(f.service.run('launch-status', { id: plan.id, hash: txHash }), /launch_transaction_changed/);
  f.changes.tx.value = '0x0'; f.advance(31000);
  const event = LONG_STATE_ABI.find((e) => e.type === 'event');
  const topics = encodeEventTopics({ abi: LONG_STATE_ABI, eventName: 'LaunchCreated', args: { poolOrHook: addr(200), asset: plan.predictedAsset, numeraire: f.p.quotes[0].token.address } });
  const data = encodeAbiParameters(event.inputs.filter((i) => !i.indexed), [f.p.poolInitializer.address, f.input.wallet,
    (await import('viem')).keccak256((await import('viem')).toBytes(f.input.draft.ticker)), 100, 86500, f.input.draft.ticker]);
  f.changes.receipt = { transactionHash: txHash, from: plan.transaction.from, to: plan.transaction.to, blockHash, blockNumber: '0x64',
    gasUsed: '0x100', effectiveGasPrice: plan.transaction.gasPrice, status: '0x1', logs: [{ address: f.p.launcher.address, topics, data }] };
  f.changes.reorg = true;
  assert.equal((await f.service.run('launch-status', { id: plan.id, hash: txHash })).status, 'confirming');
  f.changes.reorg = false; f.advance(11000);
  const result = await f.service.run('launch-status', { id: plan.id, hash: txHash });
  assert.equal(result.status, 'confirmed'); assert.equal(result.asset, plan.predictedAsset);
  assert.equal((await f.service.run('launch-status', { id: plan.id, hash: null })).status, 'confirmed');
});

test('terminal launch results remain bound to the journaled transaction hash', async (t) => {
  for (const status of ['confirmed', 'failed']) {
    const f = await fixture(t);
    const plan = await f.service.run('launch-prepare', f.input);
    const txHash = hash(status === 'confirmed' ? 700 : 701);
    const terminal = { id: plan.id, status, hash: txHash, paidGasWei: '1' };
    f.budget.db.prepare(
      "UPDATE long_launches SET state=?,tx_hash=?,result=? WHERE id=?",
    ).run(status, txHash, JSON.stringify(terminal), plan.id);
    assert.deepEqual(
      await f.service.run('launch-status', { id: plan.id, hash: null }),
      terminal,
    );
    assert.deepEqual(
      await f.service.run('launch-status', { id: plan.id, hash: txHash.toUpperCase() }),
      terminal,
    );
    await assert.rejects(
      f.service.run('launch-status', { id: plan.id, hash: hash(702) }),
      /launch_transaction_changed/,
    );
  }
});

test('configuration and inputs reject arbitrary targets, signatures and unsupported chains', () => {
  assert.equal(readLongLiveConfig({}), null);
  assert.throws(() => readLongLiveConfig({ LONG_WALLET_LAUNCH: 'true' }));
  assert.throws(() => validateLongInput('launch-reserve', { id: 'a'.repeat(64), binding: 'b'.repeat(64), data: '0x' }));
  assert.throws(() => validateLongInput('launch-status', { id: 'a'.repeat(64), hash: 'bad' }));
});
