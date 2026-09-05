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
import { InsufficientFundsError, ServiceError, serviceErrorBody } from "./errors.mjs";
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
    verify: async (...args) => { seen.push(args); if (changes.code) throw new ServiceError('contract_unverified'); },
    calls: async (_chain, entries) => entries.map((e) => {
      switch(e.functionName) {
        case 'AIRLOCK': return p.airlock.address;
        case 'TRUSTED_TOKEN_FACTORY': return p.tokenFactory.address;
        case 'RESERVATION_DURATION': return 86400;
        case 'paused': return changes.paused ?? false;
        case 'getModuleState': return ['tokenFactory','governanceFactory','poolInitializer','liquidityMigrator'].findIndex((r) => p[r].address === e.args[0]) + 1;
        case 'decimals': return p.quotes.some(q => q.token.address === e.address) ? 18 : 8;
        case 'latestRoundData': return [1n, changes.answer ?? 23000000000n, BigInt(now / 1000 - 20), BigInt(now / 1000 - (changes.age ?? 10)), 1n];
        case 'isTickerAvailable': return !changes.reserved;
        case 'implementation': return changes.implementation ?? g.tokenImplementation.address;
        case 'aggregator': return g.oracleAggregator.address;
        case 'oraclePaused': return changes.oraclePaused ?? false;
        case 'name': return draft.name;
        case 'symbol': return draft.ticker;
        case 'tokenURI': return imageUri.replace(imageCid, published.ipfs.metadataCid);
        case 'totalSupply': return changes.supply ?? 10n ** 27n;
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
        case 'eth_estimateGas':
          if (changes.estimateUnderfunded) throw new ServiceError('insufficient_funds');
          return toHex(changes.gas ?? 1000000);
        case 'eth_gasPrice': return toHex(changes.price ?? 1000000000);
        case 'eth_getBalance': return toHex(changes.balance ?? 10n ** 18n);
        case 'eth_getTransactionCount': return e.params[1] === 'pending' ? (changes.pendingNonce ?? '0x1') : (changes.latestNonce ?? '0x1');
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

test('unsent legacy plans are refreshed with a canonical address rather than offered to the wallet', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  assert.ok(plan.predictedAsset.toLowerCase().endsWith('1e18'));
  assert.ok(Number.isInteger(plan.saltAttempt));
  const legacy = { ...plan, predictedAsset: addr(333) };
  delete legacy.saltAttempt;
  f.budget.db.prepare('UPDATE long_launches SET plan=? WHERE id=?').run(JSON.stringify(legacy), plan.id);
  const refreshed = await f.service.run('launch-prepare', f.input);
  assert.ok(refreshed.predictedAsset.toLowerCase().endsWith('1e18'));
  assert.ok(Number.isInteger(refreshed.saltAttempt));
  assert.notEqual(refreshed.predictedAsset, legacy.predictedAsset);
});

test('durable recovery survives restart and requotes only the original unused nonce', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  assert.throws(() => f.service.reserve({ id: plan.id, binding: 'f'.repeat(64) }));
  assert.equal(f.service.reserve(plan).status, 'wallet');
  assert.equal(f.service.reserve(plan).status, 'wallet');
  f.budget.close();
  const reopened = new Budget(f.path, f.options.now, false); t.after(() => reopened.close());
  const service = new LongLive(f.config, f.upstream, reopened, f.options);
  f.advance(31000);
  assert.equal((await service.run('launch-status', { id: plan.id, hash: null })).status, 'retryable');
  f.changes.price = 2000000000;
  const retry = await service.run('launch-prepare', f.input);
  assert.equal(retry.transaction.nonce, plan.transaction.nonce);
  assert.equal(retry.transaction.data, plan.transaction.data);
  assert.notEqual(retry.transaction.gasPrice, plan.transaction.gasPrice);
  assert.equal(service.reserve(retry).status, 'wallet');
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS n FROM long_launch_attempts').get().n, 2);
  assert.equal(service.row(plan.id).state, 'wallet');
  f.changes.pendingNonce = '0x2';
  assert.deepEqual(await service.run('launch-prepare', f.input), { recovery: { id: retry.id, binding: retry.binding, hash: null } });
  await assert.rejects(service.run('launch-prepare', { ...f.input, draft: {...f.input.draft, name:'Changed'} }), /launch_context_locked/);
  assert.equal(service.row(plan.id).plan, JSON.stringify(retry));
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
  f.advance(31000); f.changes.price = 2000000000; f.changes.answer = 24000000000n;
  const retry = await f.service.run('launch-prepare', f.input);
  f.service.reserve(retry);
  assert.notEqual(retry.transaction.data, plan.transaction.data);
  assert.equal(retry.transaction.nonce, plan.transaction.nonce);
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

test('wallet gas changes and EIP-1559 conversion preserve a verified launch, including old journal entries', async (t) => {
  for (const fees of [
    { gas: toHex(2995286), gasPrice: toHex(439374000), type: '0x2', maxFeePerGas: toHex(536800000), maxPriorityFeePerGas: '0x0' },
    { gas: toHex(3100000), gasPrice: toHex(600000000) },
    { gas: toHex(2995286), gasPrice: undefined, type: '0x2', maxFeePerGas: toHex(536800000), maxPriorityFeePerGas: '0x0' },
  ]) {
    const f = await fixture(t);
    f.changes.gas = 1996857; f.changes.price = 427804000;
    const plan = await f.service.run('launch-prepare', f.input);
    assert.equal(plan.transaction.gas, toHex(2396229));
    f.changes.plan = plan; f.service.reserve(plan);
    // Simulate a launch reserved before the attempts journal was introduced.
    f.budget.db.prepare('DELETE FROM long_launch_attempts WHERE id=?').run(plan.id);
    const txHash = hash(610), blockHash = hash(500);
    f.changes.tx = { ...plan.transaction, input: plan.transaction.data, hash: txHash, blockHash, blockNumber: '0x64', ...fees };
    const topics = encodeEventTopics({ abi: LONG_STATE_ABI, eventName: 'LaunchCreated', args: {
      poolOrHook: addr(200), asset: plan.predictedAsset, numeraire: f.p.quotes[0].token.address,
    } });
    const event = LONG_STATE_ABI.find((e) => e.type === 'event');
    const { keccak256, toBytes } = await import('viem');
    const data = encodeAbiParameters(event.inputs.filter((i) => !i.indexed), [f.p.poolInitializer.address, f.input.wallet,
      keccak256(toBytes(f.input.draft.ticker)), 100, 86500, f.input.draft.ticker]);
    f.changes.receipt = { transactionHash: txHash, from: plan.transaction.from, to: plan.transaction.to,
      blockHash, blockNumber: '0x64', gasUsed: toHex(1880957), effectiveGasPrice: toHex(439374000), status: '0x1',
      logs: [{ address: f.p.launcher.address, topics, data }] };
    for (const change of [{ from: addr(999) }, { to: addr(999) }, { input: '0x' }, { value: '0x1' }, { nonce: '0x2' }, { chainId: '0x1' }, { hash: hash(999) }]) {
      const original = f.changes.tx;
      f.changes.tx = { ...original, ...change };
      await assert.rejects(f.service.run('launch-status', { id: plan.id, hash: txHash }), /launch_transaction_changed/);
      f.changes.tx = original;
      f.advance(31000);
    }
    const logs = f.changes.receipt.logs;
    for (const invalid of [[], [{ ...logs[0], address: addr(999) }], [logs[0], logs[0]]]) {
      f.changes.receipt.logs = invalid;
      await assert.rejects(f.service.run('launch-status', { id: plan.id, hash: txHash }), /launch_receipt_unverified/);
      f.advance(31000);
    }
    f.changes.receipt.logs = logs;
    f.changes.supply = 1n;
    await assert.rejects(f.service.run('launch-status', { id: plan.id, hash: txHash }), /launch_receipt_unverified/);
    delete f.changes.supply; f.advance(31000);
    const result = await f.service.run('launch-status', { id: plan.id, hash: txHash });
    assert.equal(result.status, 'confirmed');
    assert.equal(result.asset, plan.predictedAsset);
    assert.equal(result.paidGasWei, '826443600918000');
    assert.ok(!f.requests.some((method) => /send|sign/i.test(method)));
  }
});

test('configuration and inputs reject arbitrary targets, signatures and unsupported chains', () => {
  assert.equal(readLongLiveConfig({}), null);
  assert.throws(() => readLongLiveConfig({ LONG_WALLET_LAUNCH: 'true' }));
  assert.throws(() => validateLongInput('launch-reserve', { id: 'a'.repeat(64), binding: 'b'.repeat(64), data: '0x' }));
  assert.throws(() => validateLongInput('launch-status', { id: 'a'.repeat(64), hash: 'bad' }));
});


test('another coin gets its own plan while an older wallet attempt stays recoverable', async (t) => {
  const f = await fixture(t), original = await f.service.run('launch-prepare', f.input);
  f.service.reserve(original);
  const copied = { ...f.input, draft: { name: 'Copied coin', ticker: 'COPIED', description: '' },
    publication: { ...f.input.publication, id: 'd'.repeat(48) } };
  const imageCid = await ipfsContentId(Buffer.from('copied artwork'));
  const uri = `ipfs://${imageCid}`;
  const metadata = Buffer.from(JSON.stringify({ name: copied.draft.name, symbol: copied.draft.ticker,
    description: '', image: uri, image_hash: uri }));
  copied.publication.metadataHash = createHash('sha256').update(metadata).digest('hex');
  f.service.metadata = async () => ({ ...copied.publication, ipfs: { imageCid, metadataCid: await ipfsContentId(metadata) } });
  const next = await f.service.run('launch-prepare', copied);
  assert.notEqual(next.id, original.id);
  assert.equal(next.transaction.nonce, original.transaction.nonce);
  assert.equal(f.service.row(original.id).state, 'wallet');
  assert.equal(JSON.parse(f.service.row(original.id).plan).transaction.data, original.transaction.data);
  assert.equal(f.service.reserve(next).status, 'wallet');
  assert.equal(f.budget.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n, 2);
  assert.ok(!f.requests.some(m => /send|sign/i.test(m)));
});

test('submitted and completed launches resume by exact draft even when browser recovery is missing', async (t) => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  const txHash = hash(600);
  for (const state of ['submitted', 'confirmed', 'failed']) {
    f.budget.db.prepare('UPDATE long_launches SET state=?,tx_hash=? WHERE id=?').run(state, txHash, plan.id);
    const reads = f.requests.length;
    assert.deepEqual(await f.service.run('launch-prepare', f.input), { recovery: { id: plan.id, binding: plan.binding, hash: txHash } });
    assert.equal(f.requests.length, reads);
  }
});


test('a verified new upload ticket for the same immutable artwork resumes the original intent', async t => {
  const f = await fixture(t), plan = await f.service.run('launch-prepare', f.input);
  const published = await f.service.metadata(f.input);
  const input = { ...f.input, publication: { ...f.input.publication, id: 'e'.repeat(48) } };
  let verified = false;
  f.service.metadata = async request => { assert.equal(request.publication.id, input.publication.id); verified = true; return published; };
  assert.deepEqual(await f.service.run('launch-prepare', input), plan);
  assert.ok(verified);
  assert.equal(f.budget.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n, 1);
  f.service.metadata = async () => ({ ...published, ipfs: { ...published.ipfs, metadataCid: published.ipfs.imageCid } });
  await assert.rejects(f.service.run('launch-prepare', input), /launch_assets_unverified/);
});


test('background estimate uses recent comparable simulations and cached live gas without reserving or uploading', async t => {
  const f = await fixture(t);
  const plan = await f.service.run('launch-prepare', f.input);
  const before = f.service.row(plan.id), reads = f.requests.length;
  f.changes.price = 2000000000;
  const input = { chainId: 4663, pairId: 'long-NVDA' };
  const [estimate, shared] = await Promise.all([f.service.run('launch-estimate', input), f.service.run('launch-estimate', input)]);
  assert.deepEqual(estimate, shared);
  assert.equal(estimate.gasUnits, plan.estimatedGas);
  assert.equal(estimate.gasPriceWei, '2000000000');
  assert.equal(estimate.launchpadFeeWei, '0');
  assert.equal(estimate.basis, 'recent-simulations');
  assert.equal(estimate.expiresAt - estimate.quotedAt, 300000);
  assert.deepEqual(f.requests.slice(reads), ['eth_chainId', 'eth_gasPrice']);
  assert.deepEqual(f.service.row(plan.id), before);
  assert.deepEqual(await f.service.run('launch-estimate', input), estimate);
  assert.equal(f.requests.length, reads + 2);
  f.advance(301000); f.changes.price = 1000000000;
  assert.equal((await f.service.run('launch-estimate', input)).gasPriceWei, '1000000000');
  assert.equal(f.requests.length, reads + 4);
  for (const change of [{wallet:f.input.wallet}, {pairId:'long-MU'}, {chainId:8453}, {transaction:{}}])
    await assert.rejects(f.service.run('launch-estimate', {...input,...change}), /invalid_request/);
});

test('no simulation history uses a disclosed gas limit, and invalid gas prices never become estimates', async t => {
  const f = await fixture(t), input = { chainId:4663, pairId:'long-NVDA' };
  const estimate = await f.service.run('launch-estimate', input);
  assert.equal(estimate.basis, 'gas-limit'); assert.equal(estimate.gasUnits, '3000000');
  assert.equal(f.budget.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n, 0);
  f.advance(301000); f.changes.price = 0;
  await assert.rejects(f.service.run('launch-estimate', input), /launch_gas_limit/);
});


test('TSLA has an independent launch intent, gas sample and verified numeraire while NVDA recovery is preserved', async t => {
  const f = await fixture(t);
  const nvda = await f.service.run('launch-prepare', f.input);
  f.service.reserve(nvda);
  const q = { ...f.p.quotes[0], id:'long-TSLA', token:{...contract(16),address:addr(2n**160n-2n)}, oracle:contract(17) };
  f.p.quotes.push(q); f.config.longLaunch.guards['long-TSLA'] = f.g;
  const nvdaEstimate = await f.service.run('launch-estimate', {chainId:4663,pairId:'long-NVDA'});
  assert.equal(nvdaEstimate.basis, 'recent-simulations');
  const reads = f.requests.length;
  const tslaEstimate = await f.service.run('launch-estimate', {chainId:4663,pairId:'long-TSLA'});
  assert.equal(tslaEstimate.basis, 'gas-limit');
  assert.equal(f.requests.length, reads); // Same network gas-price cache, separate gas-unit history.
  const tsla = await f.service.run('launch-prepare', {...f.input,pairId:'long-TSLA'});
  assert.notEqual(tsla.id, nvda.id);
  assert.notEqual(tsla.transaction.data, nvda.transaction.data);
  assert.equal(f.service.row(nvda.id).state, 'wallet');
  assert.equal(tsla.transaction.nonce, nvda.transaction.nonce);
  const decoded = decodeFunctionData({abi:LONG_CREATE_ABI,data:tsla.transaction.data});
  assert.equal(decoded.args[0].numeraire.toLowerCase(),q.token.address.toLowerCase());
  assert.equal((await f.service.run('launch-estimate',{chainId:4663,pairId:'long-TSLA'})).basis,'recent-simulations');
  assert.equal((await f.service.run('launch-prepare',f.input)).id,nvda.id);
});

test('underfunded launch reports exact balance and required buffered gas without journaling a transaction', async t => {
  const f=await fixture(t);f.changes.balance=200000000000000n;
  await assert.rejects(f.service.run('launch-prepare',f.input), error=>{
    assert.ok(error instanceof InsufficientFundsError);
    assert.deepEqual(serviceErrorBody(error),{error:'insufficient_funds',funding:{chainId:4663,balanceWei:'200000000000000',requiredWei:'1200000000000000',shortfallWei:'1000000000000000',basis:'simulation'}});
    return true;
  });
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n,0);
  const arbitrary=new ServiceError('insufficient_funds');arbitrary.funding={private:'not public'};
  assert.deepEqual(serviceErrorBody(arbitrary),{error:'insufficient_funds'});
});

test('node rejection before gas estimation reports the configured ceiling with a clear basis',async t=>{
  const f=await fixture(t);f.changes.balance=0n;f.changes.estimateUnderfunded=true;
  await assert.rejects(f.service.run('launch-prepare',f.input),error=>{
    assert.equal(error.funding.balanceWei,'0');assert.equal(error.funding.requiredWei,'3000000000000000');
    assert.equal(error.funding.shortfallWei,'3000000000000000');assert.equal(error.funding.basis,'gas-limit');return true;
  });
});

test('background launch fee requires current verified contract code and includes its source block',async t=>{
  const f=await fixture(t), input={chainId:4663,pairId:'long-NVDA'};
  const estimate=await f.service.run('launch-estimate',input);
  assert.deepEqual(estimate.launchFeeSource,{amountWei:'0',kind:'verified-contract',contract:f.p.launcher.address,blockNumber:'100'});
  assert.ok(f.seen.some(([,contracts,,block])=>contracts.length===1&&contracts[0].address===f.p.launcher.address&&block==='0x64'));
  f.advance(301000);f.changes.code=true;
  await assert.rejects(f.service.run('launch-estimate',input),/unverified/);
});
