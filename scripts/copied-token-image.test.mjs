import assert from 'node:assert/strict';
import test from 'node:test';
import { ImageRequests, copiedTokenImage, tokenImageSource, validateDraftImage } from '../apps/web/lib/copied-token-image.ts';
import { trackedTokenDraft } from '../apps/web/components/tracked-market-feed.mjs';
import { draftImageBlob } from '../apps/web/lib/launch-draft-cache.ts';

const address = `0x${'a'.repeat(40)}`;
const source = { chainId: 4663, address };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=', 'base64');
const payload = { ...source, size: png.length, mime: 'image/png', base64: png.toString('base64') };

test('only recognized Robinhood O1 rows request artwork, preserving other COPY drafts', () => {
  for (const launchpad of ['o1', 'O1 RWA', 'O1 migrated']) {
    const draft = trackedTokenDraft({ meme: address, name: 'Moon', sym: 'MOON', launchpad });
    assert.deepEqual(draft, { name: 'Moon', ticker: 'MOON', imageSource: source });
  }
  for (const row of [{ launchpad: 'long' }, { launchpad: 'longbow' }, {},
    { launchpad: 'o1', chain_id: 8453 }, { launchpad: 'o1', meme: 'bad' }])
    assert.equal(trackedTokenDraft({ meme: address, ...row }).imageSource, undefined);
  assert.equal(tokenImageSource({ ...source, chainId: 8453 }), null);
});

test('COPY downloads only the source identity and produces a persistable Blob', async () => {
  const requests = new ImageRequests(), request = requests.begin();
  const blob = await copiedTokenImage(source, request.signal, async (url, options) => {
    assert.equal(url, '/api/o1-token-image');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers['x-fungun-intent'], 'o1-token-image');
    assert.deepEqual(JSON.parse(options.body), source);
    return Response.json(payload);
  });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png);
  assert.equal(blob.type, 'image/png');
  assert.equal(await draftImageBlob({ blob, size: blob.size, url: 'blob:example' }), blob);
});

test('wrong token, wrong chain, invalid bytes and oversized responses cannot attach', async () => {
  for (const data of [{ ...payload, address: `0x${'b'.repeat(40)}` },
    { ...payload, chainId: 8453 }, { ...payload, size: 2 ** 21 + 1 },
    { ...payload, mime: 'image/svg+xml' }, { ...payload, base64: 'AAAA' }])
    await assert.rejects(copiedTokenImage(source, new AbortController().signal, async () => Response.json(data)));
  await assert.rejects(copiedTokenImage(source, new AbortController().signal,
    async () => new Response(new Uint8Array(3 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })));
});

test('a later COPY/upload or removal/unmount invalidates even a request that ignores abort', async () => {
  const requests = new ImageRequests();
  let resolve;
  const first = requests.begin();
  const pending = copiedTokenImage(source, first.signal, () => new Promise(r => { resolve = r; }));
  const upload = requests.begin();
  assert.equal(first.signal.aborted, true);
  resolve(Response.json(payload));
  await pending;
  assert.equal(first.isCurrent(), false, 'late result cannot attach');
  assert.equal(upload.isCurrent(), true);
  requests.cancel();
  assert.equal(upload.isCurrent(), false);
  assert.equal(upload.signal.aborted, true);
});

test('copied artwork uses image decode and dimension validation before attachment', async () => {
  const previous = globalThis.createImageBitmap;
  let closed = 0;
  try {
    globalThis.createImageBitmap = async () => ({ width: 4097, height: 1, close() { closed++; } });
    await assert.rejects(validateDraftImage(new Blob([png], { type: 'image/png' })), /4096/);
    assert.equal(closed, 1);
    globalThis.createImageBitmap = async () => { throw new Error('decode failed'); };
    await assert.rejects(validateDraftImage(new Blob([png], { type: 'image/png' })), /decode failed/);
  } finally {
    if (previous) globalThis.createImageBitmap = previous;
    else delete globalThis.createImageBitmap;
  }
});
