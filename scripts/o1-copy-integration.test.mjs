import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHandler } from '../apps/api/src/service.mjs';
import { Budget } from '../apps/api/src/budget.mjs';
import { O1TokenImages } from '../apps/api/src/o1-token-image.mjs';
import { Upstream } from '../apps/api/src/upstream.mjs';
import { POST } from '../apps/web/app/api/[operation]/route.ts';
import { copiedTokenImage } from '../apps/web/lib/copied-token-image.ts';

test('COPY client crosses the production web proxy and read-service route to fetch artwork', async t => {
  const source = { chainId: 4663, address: `0x${'a'.repeat(40)}` };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=', 'base64');
  const origin = 'https://app.example.invalid';
  const previousOrigin = process.env.APP_ORIGIN, previousBackend = process.env.READ_SERVICE_ORIGIN;
  const realFetch = globalThis.fetch;
  const budget = new Budget(':memory:');
  const config = { origin, readsEnabled: true, o1Key: 'EXAMPLE' };
  let imageReads = 0;
  const providerFetch = async url => {
    if (String(url).startsWith('https://api.launch.o1.exchange/'))
      return Response.json({ data: { chain_id: 4663, token: { address: source.address,
        image_url: `https://sapphire-negative-junglefowl-959.mypinata.cloud/ipfs/b${'a'.repeat(58)}` } } });
    imageReads++;
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  };
  const images = new O1TokenImages(config, new Upstream(budget, providerFetch), providerFetch);
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
    assert.equal(url.href, 'https://backend.example.invalid/v1/o1-token-image');
    assert.equal(options.headers['x-api-key'], undefined);
    return realFetch(`${backend}/v1/o1-token-image`, options);
  };
  const browserFetch = (path, options) => POST(new Request(`${origin}${path}`, {
    ...options, headers: { ...options.headers, origin },
  }), { params: Promise.resolve({ operation: 'o1-token-image' }) });
  const blob = await copiedTokenImage(source, new AbortController().signal, browserFetch);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
  assert.equal(imageReads, 1);
  const invalid = await browserFetch('/api/o1-token-image', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fungun-intent': 'o1-token-image' },
    body: JSON.stringify({ ...source, chainId: 8453 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(imageReads, 1);
});
