import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { encodeAbiParameters } from 'viem';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { DopplerTokenImages, TokenImages, gmgnImageUrl, imageCid, validateCopiedTokenImageInput } from './token-image.mjs';
import { Upstream } from './upstream.mjs';
import { ServiceError } from './errors.mjs';

const address = `0x${'a'.repeat(40)}`;
const source = { chainId: 4663, address };
const png = await sharp({ create: { width: 2, height: 3, channels: 4, background: 'red' } }).png().toBuffer();
const cidFor = async bytes => CID.createV1(0x55, await sha256.digest(bytes)).toString();
const image = await cidFor(png);
const metadata = Buffer.from(JSON.stringify({ image_hash: `ipfs://${image}` }));
const document = await cidFor(metadata);

function fixture(options = {}) {
  let now = 0;
  const requests = [], charges = [];
  const state = { uri: `ipfs://${document}`, chain: 4663 };
  const bodies = new Map([[document, metadata], [image, png]]);
  const config = { readsEnabled: true, rpcUrl: 'https://rpc.example.invalid',
    baseRpcUrl: 'https://base-rpc.example.invalid', rpcBatchRequests: false, ...options.config };
  const fetcher = async (url, init) => {
    requests.push({ url: String(url), init });
    if (init.method === 'POST') {
      const request = JSON.parse(init.body);
      assert.ok(['eth_chainId', 'eth_call'].includes(request.method));
      if (request.method === 'eth_call') {
        assert.equal(request.params[0].to, address);
        assert.equal(request.params[0].data, '0x3c130d90');
        assert.equal(request.params[1], 'latest');
      }
      return Response.json({ jsonrpc: '2.0', id: request.id,
        result: request.method === 'eth_chainId' ? `0x${state.chain.toString(16)}`
          : encodeAbiParameters([{ type: 'string' }], [state.uri]) });
    }
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers['x-api-key'], undefined);
    if (options.gateway) return options.gateway(String(url), init, bodies);
    const key = new URL(url).pathname.split('/').at(-1);
    const body = bodies.get(key);
    return new Response(body ?? 'missing', { status: body ? 200 : 404 });
  };
  const budget = { upstream(provider) { charges.push(provider); options.charge?.(provider); } };
  const upstream = new Upstream(budget, fetcher);
  const service = new DopplerTokenImages(config, upstream, fetcher, () => now);
  return { service, upstream, config, fetcher, requests, charges, state, bodies, advance(ms) { now += ms; } };
}

for (const field of ['image', 'image_hash']) test(`resolves ${field} metadata and fully decodes artwork`, async () => {
  const f = fixture();
  f.bodies.set(document, Buffer.from(JSON.stringify({ [field]: `ipfs://${image}` })));
  const result = await f.service.get(source);
  assert.equal(result.address, address);
  assert.equal(result.chainId, 4663);
  assert.equal(result.mime, 'image/webp');
  const bytes = Buffer.from(result.base64, 'base64');
  assert.equal(bytes.length, result.size);
  const decoded = await sharp(bytes).metadata();
  assert.deepEqual([decoded.width, decoded.height], [2, 3]);
  assert.deepEqual(f.charges, ['rpc', 'rpc', 'token-image', 'token-image']);
});

test('direct image tokenURI works, including CIDv0 normalization', async () => {
  const f = fixture();
  const legacy = CID.createV0(await sha256.digest(png));
  f.state.uri = `ipfs://${legacy}`;
  f.bodies.set(legacy.toV1().toString(), png);
  assert.equal((await f.service.get(source)).mime, 'image/webp');
  assert.equal(f.charges.filter(p => p === 'token-image').length, 1);
});

test('invalid or unavailable image falls back to image_hash', async () => {
  for (const first of ['http://127.0.0.1/private', `ipfs://${await cidFor(Buffer.from('missing'))}`]) {
    const f = fixture();
    f.bodies.set(document, Buffer.from(JSON.stringify({ image: first, image_hash: `ipfs://${image}` })));
    assert.equal((await f.service.get(source)).mime, 'image/webp');
    assert.ok(f.requests.every(r => !r.url.includes('127.0.0.1')));
  }
});

test('gateway failures fall back; only exact same-CID canonical redirects are followed', async () => {
  const f = fixture({ gateway(url) {
    const cid = url.includes(image) ? image : document;
    if (url.startsWith('https://ipfs.io/')) return new Response(null, { status: 302,
      headers: { location: `https://${cid}.ipfs.dweb.link/` } });
    assert.equal(url, `https://${cid}.ipfs.dweb.link/`);
    return new Response(cid === image ? png : metadata);
  } });
  assert.equal((await f.service.get(source)).mime, 'image/webp');
  const unavailable = fixture({ gateway(url) {
    if (url.startsWith('https://ipfs.io/')) throw new TypeError('network unavailable');
    return new Response(url.includes(image) ? png : metadata);
  } });
  assert.equal((await unavailable.service.get(source)).mime, 'image/webp');
});

test('redirects cannot escape gateways or change content identity', async () => {
  for (const location of ['http://127.0.0.1/private', 'https://ipfs.io@localhost/',
    `https://${image}.ipfs.dweb.link/`, `https://ipfs.io/ipfs/${document}?download=1`]) {
    const f = fixture({ gateway() { return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(f.service.get(source));
    assert.equal(f.requests.filter(r => !r.init.method).length, 3);
    assert.ok(f.requests.every(r => !r.url.includes('localhost') && !r.url.includes('127.0.0.1')));
  }
});

test('URI validation rejects hosts, traversal, IPNS, malformed CIDs and extra input fields', () => {
  for (const uri of ['https://example.com/image', 'ipns://example', `ipfs://${image}/../x`,
    `ipfs://${image}?x=1`, `ipfs://${image}#x`, `ipfs://b${'a'.repeat(58)}`, `ipfs://${image}/x.png`])
    assert.throws(() => imageCid(uri));
  for (const input of [null, [], { ...source }, { ...source, provider: 'doppler', url: 'x' },
    { ...source, provider: 'doppler', chainId: 1 }, { ...source, provider: 'unknown' },
    { ...source, provider: 'o1', chainId: 8453 }, { ...source, provider: 'doppler', address: 'bad' }])
    assert.throws(() => validateCopiedTokenImageInput(input));
});

test('rejects oversized streams, malformed JSON, nested metadata and invalid raster bytes', async () => {
  for (const bytes of [Buffer.alloc(128 * 1024 + 1, 32), Buffer.from('{'),
    Buffer.from(JSON.stringify({ image: `ipfs://${document}` })),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]),
    Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])]) {
    const f = fixture();
    f.bodies.set(document, bytes);
    await assert.rejects(f.service.get(source));
  }
});

test('launch decoder rejects oversized dimensions and animated images', async () => {
  const oversized = await sharp({ create: { width: 4097, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  for (const bytes of [oversized, animated]) {
    const f = fixture();
    f.state.uri = `ipfs://${image}`;
    f.bodies.set(image, bytes);
    await assert.rejects(f.service.get(source), error => ['image_dimensions', 'image_animated'].includes(error.code));
  }
});

test('deduplicates clicks, refreshes mutable tokenURI, retains immutable CID artwork', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.get(source), f.service.get(source)]);
  assert.equal(a, b);
  await f.service.get(source);
  assert.equal(f.requests.length, 4);
  f.advance(60_001);
  f.state.uri = `ipfs://${image}`;
  await f.service.get(source);
  // The image is already cached under image:CID but a new direct URI gets its own document entry.
  assert.equal(f.requests.filter(r => r.init.method).length, 3);
  f.advance(60_001);
  await f.service.get(source);
  assert.equal(f.requests.filter(r => r.init.method).length, 4);
  assert.equal(f.requests.filter(r => !r.init.method).length, 3);
});

test('Base uses its configured RPC; wrong chain and disabled reads never fetch artwork', async () => {
  const f = fixture();
  f.state.chain = 8453;
  assert.equal((await f.service.get({ ...source, chainId: 8453 })).chainId, 8453);
  assert.equal(f.requests[0].url, f.config.baseRpcUrl);
  const wrong = fixture();
  wrong.state.chain = 1;
  await assert.rejects(wrong.service.get(source), { code: 'wrong_chain' });
  assert.equal(wrong.requests.length, 1);
  const disabled = fixture({ config: { readsEnabled: false } });
  assert.throws(() => disabled.service.get(source), { code: 'not_configured' });
  assert.equal(disabled.requests.length, 0);
});

test('gateway reads obey admission and budgets without leaking slots', async () => {
  const f = fixture({ charge(provider) { if (provider === 'token-image') throw new ServiceError('rate_limited', 429, 5); } });
  await assert.rejects(f.service.get(source), { code: 'rate_limited' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.upstream.active, 0);
});

test('provider dispatch preserves legacy O1 and isolates Doppler', async () => {
  const service = new TokenImages({}, {});
  service.o1.get = input => ({ provider: 'o1', ...input });
  service.doppler.get = input => ({ provider: 'doppler', ...input });
  assert.deepEqual(service.get(source), { provider: 'o1', ...source });
  assert.deepEqual(service.get({ ...source, provider: 'doppler' }), { provider: 'doppler', ...source });
  assert.deepEqual(service.get({ ...source, provider: 'o1' }), { provider: 'o1', ...source });
});

const gmgnUrl = `https://gmgn.ai/external-res/${'a'.repeat(32)}_v2.webp`;

test('GMGN image paths reject arbitrary hosts, URLs, credentials and traversal', () => {
  assert.equal(gmgnImageUrl(gmgnUrl), gmgnUrl);
  for (const url of [null, gmgnUrl.replace('https:', 'http:'),
    gmgnUrl.replace('gmgn.ai', 'gmgn.ai.example.invalid'),
    gmgnUrl.replace('gmgn.ai', 'user:secret@gmgn.ai'),
    gmgnUrl.replace('gmgn.ai', 'gmgn.ai:443'),
    gmgnUrl.replace('/external-res/', '/external-res/../external-res/'),
    gmgnUrl.replace('/external-res/', '/api/'), `${gmgnUrl}?x=1`, `${gmgnUrl}#x`,
    gmgnUrl.replace('.webp', '.svg'), 'http://127.0.0.1/private'])
    assert.throws(() => gmgnImageUrl(url));
});

for (const field of ['image', 'image_hash']) test(`GMGN HTTPS ${field} downloads and decodes through the bounded resolver`, async () => {
  let reads = 0;
  const f = fixture({ gateway(url) {
    if (url === gmgnUrl) { reads++; return new Response(png); }
    assert.ok(url.includes(document));
    return Response.json({ [field]: gmgnUrl });
  } });
  const result = await f.service.get(source);
  assert.equal(result.mime, 'image/webp');
  assert.equal((await sharp(Buffer.from(result.base64, 'base64')).metadata()).width, 2);
  await f.service.get(source);
  assert.equal(reads, 1);
  f.advance(60_001);
  await f.service.get(source);
  assert.equal(reads, 2, 'immutable metadata cannot keep a mutable HTTPS image cached for an hour');
});

test('blocked or redirected GMGN images fail closed and can fall back to an IPFS image_hash', async () => {
  for (const response of [() => new Response('<html>challenge</html>', { status: 403 }),
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    () => new Response('not an image'),
    () => new Response(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]))]) {
    const f = fixture({ gateway(url) {
      if (url === gmgnUrl) return response();
      if (url.includes(image)) return new Response(png);
      return Response.json({ image: gmgnUrl, image_hash: `ipfs://${image}` });
    } });
    assert.equal((await f.service.get(source)).mime, 'image/webp');
    assert.ok(f.requests.every(r => !r.url.includes('127.0.0.1')));
    assert.equal(f.upstream.active, 0);
  }
  const blocked = fixture({ gateway(url) {
    return url === gmgnUrl ? new Response('challenge', { status: 403 })
      : Response.json({ image_hash: gmgnUrl });
  } });
  await assert.rejects(blocked.service.get(source), { code: 'gmgn_image_blocked' });
  assert.equal(blocked.upstream.active, 0);
});
