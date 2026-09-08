import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { toHex as testHex } from 'viem';
import { O1MetadataPublisher } from './o1-metadata.mjs';
import { o1Metadata } from '../../web/lib/long-encoding/o1-metadata.mjs';
import { ipfsContentId, prepareLongIpfsAssets } from './ipfs-content.mjs';

const zero = testHex(0n, { size: 20 });
async function fixture(t, chainId = 4663) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#123456' } }).webp().toBuffer();
  const draft = { name: 'Sample', ticker: 'SAMPLE', description: 'Test artwork' };
  const assets = await prepareLongIpfsAssets(image, draft), expected = o1Metadata(draft, assets.image.cid);
  const input = { chainId, wallet: testHex(1n, { size: 20 }), pairId: 'native', draft, editableMetadata: true,
    publication: { id: 'a'.repeat(48), imageHash: assets.image.sha256, metadataHash: assets.metadata.sha256 } };
  const publication = { imageUrl: `https://source.mypinata.cloud/ipfs/${assets.image.cid}`,
    ipfs: { imageCid: assets.image.cid, metadataCid: assets.metadata.cid } };
  const calls = [], reads = [], change = {};
  const result = { chain_id: chainId, actor: input.wallet, metadata_uri: expected.uri,
    image_url: `https://o1.mypinata.cloud/ipfs/${assets.image.cid}` };
  const upstream = { json: async (provider, url, options) => {
    calls.push({ provider, url, ...options });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM o1_metadata_publications').get().n, 1);
    if (change.timeout) { change.timeout = false; throw new Error('timeout'); }
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
  return { db, assets, expected, input, publication, calls, reads, change, publisher };
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
  const { toHex, keccak256, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, getCreate2Address } = await import('viem');
  const f = await fixture(t), now = 1800000000000;
  const contract = n => ({ address: toHex(n, { size: 20 }), codeHash: keccak256('0x01') });
  const p = { chainId: 4663, launchpad: 'o1', launcher: contract(1), tokenDeployer: contract(2), hook: contract(3),
    feeEscrow: contract(4), announcementRegistry: contract(5), quotes: [{ id: 'native', token: null, decimals: 18 }] };
  const initCodeHash = keccak256('0x01'), pool = keccak256('0x02');
  const rpc = { block: async () => '0x64', verify: async () => {},
    calls: async (_chain, entries) => entries.map(e => {
      const values = { configVersion: 1n, launchSupply: 10n ** 27n, launchCreationEnabled: true, quoteConfig: [true, 18, 0],
        TOKEN_ADDRESS_SUFFIX: 1, tokenDeployer: p.tokenDeployer.address, hook: p.hook.address,
        announcementRegistry: p.announcementRegistry.address, factory: p.launcher.address, feeEscrow: p.feeEscrow.address,
        tickSpacing: 60, nativeLaunchFee: 10n ** 15n, launchTokenBytecodeHash: initCodeHash };
      assert.ok(Object.hasOwn(values, e.functionName));
      if (e.functionName === 'launchTokenBytecodeHash') assert.equal(e.args[0].tokenContractURI, f.expected.uri);
      return values[e.functionName];
    }),
    batch: async (_chain, entries) => entries.map(e => {
      if (e.method === 'eth_getBlockByNumber') return { timestamp: toHex(now / 1000) };
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
    { db: f.db, key: 'a'.repeat(64), launch: () => {} }, { rpc, now: () => now });
  live.metadata = async () => f.publication;
  live.o1Metadata = f.publisher();
  const plan = await live.prepare(f.input);
  assert.equal(plan.review.metadataUri, f.expected.uri);
  assert.equal(plan.o1MetadataVersion, 1);
  const legacy = { ...plan, o1MetadataVersion: undefined, buildInput: { ...plan.buildInput, metadataUri: `ipfs://${f.assets.metadata.cid}` } };
  f.db.prepare('UPDATE long_launches SET plan=? WHERE id=?').run(JSON.stringify(legacy), plan.id);
  const renewed = await live.prepare(f.input);
  assert.equal(renewed.buildInput.metadataUri, f.expected.uri);
  assert.equal(renewed.o1MetadataVersion, 1);
  assert.equal(f.calls.length, 1);
  f.db.prepare("UPDATE long_launches SET state='submitted',tx_hash=? WHERE id=?").run(keccak256('0x03'), plan.id);
  assert.ok((await live.prepare(f.input)).recovery);
  assert.equal(f.calls.length, 1);
});


void test('Base metadata publication uses the selected chain and rejects a Robinhood response', async t => {
  const f = await fixture(t, 8453);
  f.change.result = { chain_id: 4663 };
  await assert.rejects(f.publisher().prepare('base-intent', f.input, f.publication, zero), { code: 'o1_metadata_unverified' });
  assert.equal(JSON.parse(f.calls[0].body).chain_id, 8453);
  delete f.change.result;
  const result = await f.publisher().prepare('base-intent', f.input, f.publication, zero);
  assert.equal(result.metadataUri, f.expected.uri);
  assert.equal(f.calls[0].headers['Idempotency-Key'], f.calls[1].headers['Idempotency-Key']);
  await assert.rejects(f.publisher().prepare('base-intent', { ...f.input, chainId: 4663 }, f.publication, zero));
});
