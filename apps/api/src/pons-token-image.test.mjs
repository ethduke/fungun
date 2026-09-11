import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { encodeAbiParameters, toFunctionSelector } from 'viem';
import { ipfsContentId } from './ipfs-content.mjs';
import { PonsTokenImages, TokenImages, ponsLogoUrl } from './token-image.mjs';
import { Upstream } from './upstream.mjs';

const address = `0x${'a'.repeat(40)}`;
const source = { chainId: 4663, address, provider: 'pons-v2' };
const png = await sharp({ create: { width: 4, height: 5, channels: 3, background: 'red' } }).png().toBuffer();
const cid = await ipfsContentId(png);
const axiom = `https://axiomtrading-v2.axiom-cdn.io/${'a'.repeat(44)}.webp`;
const credentialUrl = new URL(axiom);
credentialUrl.username = 'EXAMPLE';
credentialUrl.password = 'EXAMPLE';
const catbox = 'https://files.catbox.moe/abc123.png';
const twitter = 'https://pbs.twimg.com/profile_images/123456789/example_400x400.jpg';
const outputs = [{ type: 'address' }, { type: 'string' }, { type: 'string' },
  { type: 'tuple', components: Array.from({ length: 5 }, () => ({ type: 'string' })) }];
function fixture(logo = axiom, extra = {}) {
  let now = 0;
  const state = { logo, bytes: png }, requests = [], charges = [];
  const fetcher = async (url, options) => {
    requests.push({ url: String(url), options });
    if (options.method === 'POST') {
      const request = JSON.parse(options.body);
      let result = '0x1237';
      if (request.method !== 'eth_chainId') {
        assert.equal(request.method, 'eth_call');
        assert.deepEqual(request.params, [{ to: address, data: toFunctionSelector('getTokenInfo()') }, 'latest']);
        result = encodeAbiParameters(outputs, [address, state.logo, 'description is not an image URL', ['', '', '', '', '']]);
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    }
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['x-api-key'], undefined);
    return extra.response ? extra.response(url, options) : new Response(state.bytes);
  };
  const config = { readsEnabled: true, rpcUrl: 'https://rpc.example.invalid', rpcBatchRequests: false, ...extra.config };
  const upstream = new Upstream({ upstream(provider) { charges.push(provider); } }, fetcher);
  const images = new TokenImages(config, upstream, fetcher, () => now);
  return { images, upstream, requests, charges, state, advance(ms) { now += ms; } };
}

for (const logo of [axiom, twitter, catbox, `ipfs://${cid}`]) test(`Pons reads tokenLogo and decodes ${new URL(logo).hostname}`, async () => {
  const f = fixture(logo);
  const result = await f.images.get(source);
  assert.equal(result.chainId, 4663);
  assert.equal(result.address, address);
  assert.equal(result.mime, 'image/webp');
  const decoded = await sharp(Buffer.from(result.base64, 'base64')).metadata();
  assert.deepEqual([decoded.width, decoded.height], [4, 5]);
  assert.deepEqual(f.charges, ['rpc', 'rpc', 'token-image']);
  assert.equal(f.requests[2].url, logo.startsWith('ipfs:') ? `https://ipfs.io/ipfs/${cid}` : logo);
});

test('Pons CDN validation rejects arbitrary URLs, credentials, queries and path escapes', async () => {
  for (const logo of ['http://localhost/image.png', 'https://169.254.169.254/latest/meta-data',
    axiom.replace('axiom-cdn.io', 'axiom-cdn.io.example.invalid'),
    credentialUrl.href, `${axiom}?target=http://localhost`,
    `${axiom}#fragment`, axiom.replace('.io/', '.io:443/'),
    axiom.replace('.io/', '.io/x/../'), 'https://pbs.twimg.com/anything.jpg',
    'https://pbs.twimg.com/profile_images/123456789/%2e%2e/image.jpg',
    'https://axiomtrading-v2.axiom-cdn.io/api/proxy',
    catbox.replace('catbox.moe', 'catbox.moe.example.invalid'),
    catbox.replace('https:', 'http:'), `${catbox}?download=1`, `${catbox}#image`,
    catbox.replace('/abc123', '/nested/abc123'), catbox.replace('.png', '.svg'),
    catbox.replace('/abc123', '/abc12'), catbox.replace('/abc123', '/%61bc123'), 'ipfs://not-a-cid', '']) {
    const f = fixture(logo);
    await assert.rejects(f.images.get(source));
    assert.equal(f.requests.length, 2, 'invalid logo never starts an HTTP fetch');
  }
  assert.equal(ponsLogoUrl(twitter), twitter);
});

test('Pons HTTPS logos never redirect, even to another allowed CDN path', async () => {
  for (const location of ['http://localhost', twitter, axiom, catbox]) {
    const f = fixture(axiom, { response() { return new Response(null, { status: 302, headers: { location } }); } });
    await assert.rejects(f.images.get(source));
    assert.equal(f.requests.length, 3);
    assert.equal(f.upstream.active, 0);
  }
});

test('Pons logo means an image, not a second JSON metadata document', async () => {
  for (const logo of [axiom, catbox, `ipfs://${cid}`]) {
    const f = fixture(logo);
    f.state.bytes = Buffer.from(JSON.stringify({ image: `ipfs://${cid}` }));
    await assert.rejects(f.images.get(source));
    assert.equal(f.requests.length, 3);
  }
});

test('Pons rejects malformed and oversized streamed raster data', async () => {
  for (const bytes of [Buffer.from('not an image'), Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)])]) {
    const f = fixture();
    f.state.bytes = bytes;
    await assert.rejects(f.images.get(source));
    assert.equal(f.upstream.active, 0);
  }
});

test('Pons deduplicates clicks and refreshes mutable HTTPS artwork after one minute', async () => {
  const f = fixture();
  const [first, same] = await Promise.all([f.images.get(source), f.images.get(source)]);
  assert.equal(first, same);
  assert.equal(f.requests.length, 3);
  f.state.bytes = await sharp({ create: { width: 4, height: 5, channels: 3, background: 'blue' } }).png().toBuffer();
  f.advance(60_001);
  const updated = await f.images.get(source);
  assert.notEqual(updated.base64, first.base64);
  assert.equal(f.requests.length, 5);
});

test('Pons refuses Base, unknown providers and disabled reads before RPC', async () => {
  const f = fixture();
  for (const changed of [{ chainId: 8453 }, { provider: 'pons-v3' }, { url: axiom }])
    assert.throws(() => f.images.get({ ...source, ...changed }), { code: 'invalid_request' });
  assert.equal(f.requests.length, 0);
  const disabled = fixture(axiom, { config: { readsEnabled: false } });
  assert.throws(() => disabled.images.get(source), { code: 'not_configured' });
  assert.equal(disabled.requests.length, 0);
});

test('aborted Pons fetch cannot start a CDN request', async () => {
  let reads = 0;
  const images = new PonsTokenImages({}, {}, async () => { reads++; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(images.fetchUrls([axiom], controller.signal));
  assert.equal(reads, 0);
});
