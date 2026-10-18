import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHandler } from '../apps/api/src/service.mjs';
import { Budget } from '../apps/api/src/budget.mjs';
import { TokenImages } from '../apps/api/src/token-image.mjs';
import { Upstream } from '../apps/api/src/upstream.mjs';
import { ipfsContentId } from '../apps/api/src/ipfs-content.mjs';
import { POST } from '../apps/web/app/api/[operation]/route.ts';
import { copiedTokenImage, copiedImageError, GMGN_IMAGE_BLOCKED_ERROR } from '../apps/web/lib/copied-token-image.ts';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { encodeAbiParameters } = require('viem');
const sharp = require('sharp');

for (const scenario of ['doppler', 'pons-v2', 'gmgn-blocked']) test(`${scenario} COPY crosses the production proxy, route and RPC resolver`, async t => {
  const provider = scenario === 'gmgn-blocked' ? 'doppler' : scenario;
  const gmgnUrl = `https://gmgn.ai/external-res/${'a'.repeat(32)}_v2.webp`;
  const source = { chainId: 4663, address: `0x${'a'.repeat(40)}`, provider };
  const png = await sharp({ create: { width: 3, height: 4, channels: 3, background: 'blue' } }).png().toBuffer();
  const imageCid = await ipfsContentId(png);
  const metadata = Buffer.from(JSON.stringify({ image_hash: scenario === 'gmgn-blocked' ? gmgnUrl : `ipfs://${imageCid}` }));
  const metadataCid = await ipfsContentId(metadata);
  const origin = 'https://app.example.invalid';
  const previousOrigin = process.env.APP_ORIGIN, previousBackend = process.env.READ_SERVICE_ORIGIN;
  const realFetch = globalThis.fetch;
  const budget = new Budget(':memory:');
  const config = { origin, readsEnabled: true, rpcUrl: 'https://rpc.example.invalid', rpcBatchRequests: false };
  let imageReads = 0;
  const providerFetch = async (url, options) => {
    if (options.method === 'POST') {
      const request = JSON.parse(options.body);
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'eth_chainId'
        ? '0x1237' : provider === 'doppler' ? encodeAbiParameters([{ type: 'string' }], [`ipfs://${metadataCid}`])
          : encodeAbiParameters([{ type: 'address' }, { type: 'string' }, { type: 'string' },
            { type: 'tuple', components: Array.from({ length: 5 }, () => ({ type: 'string' })) }],
            [source.address, `ipfs://${imageCid}`, '', ['', '', '', '', '']]) });
    }
    imageReads++;
    if (url === gmgnUrl) return new Response('challenge', { status: 403 });
    return new Response(String(url).endsWith(imageCid) ? png : metadata);
  };
  const images = new TokenImages(config, new Upstream(budget, providerFetch), providerFetch);
  const server = createServer(createHandler(config, budget, {}, null, null, null, images));
  t.after(async () => {
    globalThis.fetch = realFetch;
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
    if (previousBackend === undefined) delete process.env.READ_SERVICE_ORIGIN; else process.env.READ_SERVICE_ORIGIN = previousBackend;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    budget.close();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const backend = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_ORIGIN = origin;
  process.env.READ_SERVICE_ORIGIN = 'https://backend.example.invalid';
  globalThis.fetch = (url, options) => {
    assert.equal(url.href, 'https://backend.example.invalid/v1/token-image');
    assert.equal(options.headers['x-api-key'], undefined);
    return realFetch(`${backend}/v1/token-image`, options);
  };
  const browserFetch = (path, options) => POST(new Request(`${origin}${path}`, {
    ...options, headers: { ...options.headers, origin },
  }), { params: Promise.resolve({ operation: 'token-image' }) });
  if (scenario === 'gmgn-blocked') {
    await assert.rejects(copiedTokenImage(source, new AbortController().signal, browserFetch), error => {
      assert.equal(copiedImageError(error), GMGN_IMAGE_BLOCKED_ERROR);
      return true;
    });
    assert.equal(imageReads, 2);
    return;
  }
  const blob = await copiedTokenImage(source, new AbortController().signal, browserFetch);
  const decoded = await sharp(Buffer.from(await blob.arrayBuffer())).metadata();
  assert.deepEqual([decoded.width, decoded.height], [3, 4]);
  assert.equal(blob.type, 'image/webp');
  assert.equal(imageReads, provider === 'doppler' ? 2 : 1);
  for (const body of [{ ...source, chainId: 1 }, { ...source, url: 'http://localhost/' }, { ...source, provider: 'anything' }]) {
    const invalid = await browserFetch('/api/token-image', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fungun-intent': 'token-image' }, body: JSON.stringify(body) });
    assert.equal(invalid.status, 400);
  }
  const denied = await browserFetch('/api/token-image', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fungun-intent': 'o1-token-image' }, body: JSON.stringify(source) });
  assert.equal(denied.status, 403);
  assert.equal(imageReads, provider === 'doppler' ? 2 : 1);
});
