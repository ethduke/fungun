import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { toHex as testHex } from 'viem';
import { O1MetadataPublisher } from './o1-metadata.mjs';
import { o1Metadata } from '../../web/lib/long-encoding/o1-metadata.mjs';
import { ipfsContentId, prepareLongIpfsAssets } from './ipfs-content.mjs';
import { Budget } from './budget.mjs';
import { ServiceError } from './errors.mjs';

const zero = testHex(0n, { size: 20 });
async function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).webp().toBuffer();
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Test artwork' };
  const assets = await prepareLongIpfsAssets(image, draft), expected = o1Metadata(draft, assets.image.cid);
  const input = { wallet: testHex(1n, { size: 20 }), pairId: 'native', draft, editableMetadata: true,
    publication: { id: 'a'.repeat(48), imageHash: assets.image.sha256, metadataHash: assets.metadata.sha256 } };
  const publication = { imageUrl: `https://source.mypinata.cloud/ipfs/${assets.image.cid}`,
    ipfs: { imageCid: assets.image.cid, metadataCid: assets.metadata.cid } };
  const calls = [], reads = [], change = {};
  const result = { chain_id: 4663, actor: input.wallet, metadata_uri: expected.uri,
    image_url: `https://o1.mypinata.cloud/ipfs/${assets.image.cid}` };
  const upstream = { json: async (provider, url, options, maxBytes, units, policy) => {
    calls.push({ provider, url, maxBytes, units, policy, ...options });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM o1_metadata_publications').get().n, 1);
    if (change.timeout) { change.timeout = false; throw new Error('timeout'); }
    if (change.staleBarrier && options.headers['Idempotency-Key'] === change.staleBarrier.key) {
      await new Promise(resolve => {
        change.staleBarrier.waiting.push(resolve);
        if (change.staleBarrier.waiting.length === 2)
          for (const ready of change.staleBarrier.waiting.splice(0)) ready();
      });
      throw new ServiceError('stale_plan', 409);
    }
    if (change.stale) { change.stale--; throw new ServiceError('stale_plan', 409); }
    return { data: { ...result, ...change.result } };
  } };
  const fetcher = async (url, options) => {
    reads.push({ url, options });
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(Object.keys(options.headers), ['accept']);
    const metadata = url.endsWith(expected.uri.slice(7));
    if (change.forbidden && url.includes('o1.mypinata')) return new Response('Forbidden', { status: 403 });
    const bytes = metadata ? Buffer.from(expected.bytes) : change.image ?? image;
    return new Response(bytes, { headers: { 'content-type': metadata ? 'application/json' : 'image/webp' } });
  };
  const publisher = () => new O1MetadataPublisher(db, upstream, fetcher, 'test-api-key');
  return { db, assets, expected, input, publication, calls, reads, change, publisher, upstream };
}

void test('canonical O1 metadata matches native public document and UnixFS CID', async () => {
  const document = o1Metadata({ name: 'Johnny Sins', ticker: 'SIMSQ', description: '' },
    'bafkreierecltpddskr3iszd23i47lb5rp36sxtporgatj3mmayqcyfynb4');
  assert.equal(document.uri, 'ipfs://bafkreibses2w6x5kvqs3bylrb57etptanzlcdnooduyznkgkea776pabsa');
  for (const description of ['', 'a'.repeat(1000), 'A cat: 🐱']) {
    const next = o1Metadata({ name: 'Sample', ticker: 'SAMPLE', description }, document.uri.slice(7));
    assert.equal(next.uri, `ipfs://${await ipfsContentId(Buffer.from(next.bytes))}`);
  }
});

void test('pins approved bytes through O1, verifies both files, and never repins on refreshed plans or restart', async t => {
  const f = await fixture(t);
  const pinned = await f.publisher().prepare('intent', f.input, f.publication, zero);
  assert.equal(pinned.metadataUri, f.expected.uri);
  assert.notEqual(pinned.metadataUri, `ipfs://${f.publication.ipfs.metadataCid}`);
  assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.equal(request.url, 'https://api.launch.o1.exchange/v1/launches/prepare');
  assert.equal(request.provider, 'o1'); assert.equal(request.method, 'POST');
  assert.equal(request.maxBytes, 32768); assert.equal(request.units, 20);
  assert.deepEqual(request.policy, { problemCodes: ['stale_plan'] });
  assert.equal(request.headers['x-api-key'], 'test-api-key');
  const body = JSON.parse(request.body);
  assert.equal(body.market, 'standard'); assert.equal(body.token.editable_metadata, true);
  assert.equal(createHash('sha256').update(Buffer.from(body.token.image_base64, 'base64')).digest('hex'), f.input.publication.imageHash);
  await f.publisher().prepare('intent', f.input, f.publication, zero);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reads.filter(r => r.url.startsWith('https://o1.')).length, 4);
});

void test('uncertain upload retries the same durable key and exact body after restart', async t => {
  const f = await fixture(t); f.change.timeout = true;
  await assert.rejects(f.publisher().prepare('intent', f.input, f.publication, zero));
  await f.publisher().prepare('intent', f.input, f.publication, zero);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
  assert.equal(f.calls[0].body, f.calls[1].body);
  await assert.rejects(f.publisher().prepare('intent', { ...f.input, draft: { ...f.input.draft, name: 'Changed' } }, f.publication, zero));
  assert.equal(f.calls.length, 2);
});

void test('expired O1 plans rotate one durable key once while network uncertainty never rotates it', async t => {
  const f = await fixture(t); f.change.stale = 1;
  await f.publisher().prepare('intent', f.input, f.publication, zero);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
  assert.equal(f.calls[0].body, f.calls[1].body);
  assert.ok(f.calls.every(call => call.units === 20));

  const twice = await fixture(t); twice.change.stale = 2;
  await assert.rejects(twice.publisher().prepare('intent', twice.input, twice.publication, zero), {
    code: 'o1_metadata_unverified',
  });
  assert.equal(twice.calls.length, 2);
  const saved = twice.db.prepare('SELECT idempotency_key FROM o1_metadata_publications WHERE id=?').get('intent');
  assert.equal(saved.idempotency_key, twice.calls[1].headers['Idempotency-Key']);
});

void test('concurrent stale-plan recovery converges on one replacement key and one saved result', async t => {
  const f = await fixture(t); f.change.timeout = true;
  await assert.rejects(f.publisher().prepare('intent', f.input, f.publication, zero));
  const original = f.db.prepare('SELECT idempotency_key FROM o1_metadata_publications WHERE id=?').get('intent').idempotency_key;
  f.change.staleBarrier = { key: original, waiting: [] };
  const [left, right] = await Promise.all([
    f.publisher().prepare('intent', f.input, f.publication, zero),
    f.publisher().prepare('intent', f.input, f.publication, zero),
  ]);
  assert.deepEqual(left, right);
  const staleCalls = f.calls.filter(call => call.headers['Idempotency-Key'] === original);
  const retryCalls = f.calls.filter(call => call.headers['Idempotency-Key'] !== original);
  assert.equal(staleCalls.length, 3); // Initial uncertainty plus both stale responses.
  assert.ok(retryCalls.length >= 1 && retryCalls.length <= 2);
  assert.equal(new Set(retryCalls.map(call => call.headers['Idempotency-Key'])).size, 1);
  const row = f.db.prepare('SELECT * FROM o1_metadata_publications WHERE id=?').get('intent');
  assert.equal(row.idempotency_key, retryCalls[0].headers['Idempotency-Key']);
  assert.ok(row.result);
});

void test('O1 gateway 403 blocks launch, then verifies saved pin without another upload', async t => {
  const f = await fixture(t); f.change.forbidden = true;
  await assert.rejects(f.publisher().prepare('intent', f.input, f.publication, zero), { code: 'o1_metadata_unverified' });
  assert.equal(f.calls.length, 1);
  f.change.forbidden = false;
  await f.publisher().prepare('intent', f.input, f.publication, zero);
  assert.equal(f.calls.length, 1);
});

void test('changed artwork never reaches O1, and substituted metadata or image URLs are rejected', async t => {
  const f = await fixture(t); f.change.image = Buffer.from('changed');
  await assert.rejects(f.publisher().prepare('intent', f.input, f.publication, zero));
  assert.equal(f.calls.length, 0); delete f.change.image;
  for (const result of [{ metadata_uri: `ipfs://${f.publication.ipfs.metadataCid}` },
    { image_url: 'https://untrusted.example/image' }, { actor: zero }, { chain_id: 8453 }]) {
    f.change.result = result;
    await assert.rejects(f.publisher().prepare('intent', f.input, f.publication, zero));
  }
  assert.equal(new Set(f.calls.map(r => r.headers['Idempotency-Key'])).size, 1);
});

void test('O1 launch preparation puts the verified native URI in calldata and refreshes legacy unsent plans', async t => {
  const { O1Live } = await import('./o1-live.mjs');
  const { O1_LAUNCH_ABI } = await import('../../web/lib/long-encoding/o1-launch.mjs');
  const { toHex, keccak256, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, encodeEventTopics, getCreate2Address } = await import('viem');
  const f = await fixture(t), now = 1800000000000;
  const budget = new Budget(':memory:', () => now); t.after(() => budget.close());
  const contract = n => ({ address: toHex(n, { size: 20 }), codeHash: keccak256('0x01') });
  const p = { chainId: 4663, launchpad: 'o1', launcher: contract(1), tokenDeployer: contract(2), hook: contract(3),
    feeEscrow: contract(4), announcementRegistry: contract(5), quotes: [{ id: 'native', token: null, decimals: 18 }] };
  const initCodeHash = keccak256('0x01'), pool = keccak256('0x02');
  const liveState = { enabled: true, currentCreator: f.input.wallet, pendingCreator: zero };
  const pins = [];
  const rpc = { block: async () => '0x64', verify: async (...args) => { pins.push(args); },
    calls: async (_chain, entries) => entries.map(e => {
      const values = { configVersion: 1n, launchSupply: 10n ** 27n, launchCreationEnabled: liveState.enabled, quoteConfig: [true, 18, 0],
        TOKEN_ADDRESS_SUFFIX: 1, tokenDeployer: p.tokenDeployer.address, hook: p.hook.address,
        announcementRegistry: p.announcementRegistry.address, factory: p.launcher.address, feeEscrow: p.feeEscrow.address,
        tickSpacing: 60, nativeLaunchFee: 10n ** 15n, launchTokenBytecodeHash: initCodeHash,
        name: f.input.draft.name, symbol: f.input.draft.ticker, contractURI: f.expected.uri,
        totalSupply: 10n ** 27n, metadataAuthority: p.launcher.address,
        creatorRights: { originalCreator: f.input.wallet, currentCreator: liveState.currentCreator,
          pendingCreator: liveState.pendingCreator, creatorFeeRecipient: f.input.wallet, poolId: pool,
          metadataEditable: true } };
      assert.ok(Object.hasOwn(values, e.functionName));
      if (e.functionName === 'launchTokenBytecodeHash') assert.equal(e.args[0].tokenContractURI, f.expected.uri);
      return values[e.functionName];
    }),
    batch: async (_chain, entries) => entries.map(e => {
      if (e.method === 'eth_getBlockByNumber') return { timestamp: toHex(now / 1000 + 30) };
      if (e.method === 'eth_getCode') return '0x';
      if (e.method === 'eth_gasPrice') return toHex(1000000);
      if (e.method === 'eth_getBalance') return toHex(10n ** 18n);
      if (e.method === 'eth_getTransactionCount') return '0x1';
      if (e.method === 'eth_estimateGas') return toHex(5000000);
      assert.equal(e.method, 'eth_call');
      const params = decodeFunctionData({ abi: O1_LAUNCH_ABI, data: e.params[0].data }).args[0];
      assert.equal(params.tokenContractURI, f.expected.uri);
      const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [f.input.wallet, params.creatorSalt]));
      const asset = getCreate2Address({ from: p.tokenDeployer.address, salt, bytecodeHash: initCodeHash });
      return encodeFunctionResult({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', result: [asset, pool] });
    }) };
  const live = new O1Live({ o1Launch: { profile: p }, o1Key: 'test-api-key' },
    { json: async () => ({ data: { base: 'ETH', currency: 'USD', amount: '2500' } }) },
    budget, { rpc, now: () => now });
  live.metadata = async () => f.publication;
  live.o1Metadata = f.publisher();
  const launchInput = { ...f.input, chainId: 4663 };
  const plan = await live.prepare(launchInput);
  assert.equal(budget.db.prepare("SELECT used FROM counters WHERE scope LIKE 'launch-prepare:86400000:%'").get().used, 1);
  assert.equal(plan.review.metadataUri, f.expected.uri);
  assert.equal(plan.o1MetadataVersion, 1);
  assert.equal(plan.buildInput.chainDeadline * 1000 - plan.quotedAt, 1830000);
  const receipt = { logs: [{ address: p.launcher.address,
    topics: encodeEventTopics({ abi: O1_LAUNCH_ABI, eventName: 'Launched', args: {
      token: plan.predictedAsset, poolId: pool, originalCreator: f.input.wallet,
    } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'int24' }],
      [zero, 10n ** 27n, 60]) }] };
  await live.confirm(plan, launchInput, receipt, '0x64');
  liveState.currentCreator = toHex(999n, { size: 20 });
  await assert.rejects(live.confirm(plan, launchInput, receipt, '0x64'), { code: 'launch_receipt_unverified' });
  liveState.currentCreator = f.input.wallet;
  liveState.pendingCreator = toHex(998n, { size: 20 });
  await assert.rejects(live.confirm(plan, launchInput, receipt, '0x64'), { code: 'launch_receipt_unverified' });
  liveState.pendingCreator = zero;
  await live.verifyJournalProfile(plan, launchInput, '0x64');
  assert.equal(pins.at(-1)[3], '0x64');
  assert.ok(pins.at(-1)[1].some(entry => entry.address === p.launcher.address));
  budget.db.prepare('UPDATE long_launches SET plan=? WHERE id=?')
    .run(JSON.stringify({ ...plan, buildInput: { ...plan.buildInput, totalSupply: String(2n * 10n ** 27n) } }), plan.id);
  assert.throws(() => live.reserve(plan), { code: 'launch_journal_unverified' });
  budget.db.prepare('UPDATE long_launches SET plan=? WHERE id=?').run(JSON.stringify(plan), plan.id);
  const rotated = new O1Live({ o1Launch: { profile: { ...p, launcher: contract(9) } }, o1Key: 'test-api-key' },
    {}, budget, { rpc, now: () => now });
  assert.throws(() => rotated.reserve(plan), { code: 'launch_configuration_changed' });
  const legacy = { ...plan, o1MetadataVersion: undefined, buildInput: { ...plan.buildInput, metadataUri: `ipfs://${f.assets.metadata.cid}` } };
  delete legacy.journalVersion; delete legacy.publication;
  budget.db.prepare('UPDATE long_launches SET plan=?,journal_version=0 WHERE id=?').run(JSON.stringify(legacy), plan.id);
  const renewed = await live.prepare(launchInput);
  assert.equal(renewed.buildInput.metadataUri, f.expected.uri);
  assert.equal(renewed.o1MetadataVersion, 1);
  assert.equal(f.calls.length, 1);
  budget.db.prepare("UPDATE long_launches SET state='submitted',tx_hash=? WHERE id=?").run(keccak256('0x03'), plan.id);
  assert.ok((await live.prepare(launchInput)).recovery);
  assert.equal(f.calls.length, 1);
  const quota = () => budget.db.prepare("SELECT used FROM counters WHERE scope LIKE 'launch-prepare:86400000:%'").get()?.used ?? 0;
  const admitted = quota(), providerCalls = f.calls.length;
  liveState.enabled = false;
  await assert.rejects(live.prepare({ ...launchInput, wallet: toHex(777n, { size: 20 }) }), {
    code: 'o1_launch_disabled',
  });
  assert.equal(quota(), admitted);
  assert.equal(f.calls.length, providerCalls);
});
