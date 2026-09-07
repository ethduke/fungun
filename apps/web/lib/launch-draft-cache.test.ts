import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDraftWriteQueue,
  decodeLaunchDraft,
  draftArtworkKey,
  draftImageBlob,
  emptyLaunchDraft,
  encodeLaunchDraft,
  sameDraftArtwork,
  updateDraftField,
  validateDraftPublication,
  type CachedLaunchDraft,
  type LaunchDraft,
} from './launch-draft-cache.ts';

function image(last = 0) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  bytes[23] = last;
  return new Blob([bytes], { type: 'image/png' });
}
function draft(): LaunchDraft {
  const blob = image();
  return {
    ...emptyLaunchDraft(),
    name: 'Moon Club',
    ticker: 'MOON',
    description: 'To the moon.',
    prompt: 'A happy moon.',
    image: {
      url: 'blob:https://example.test/expired-on-reload',
      size: blob.size,
      blob,
    },
  };
}
function published() {
  return {
    id: 'a'.repeat(48),
    imageHash: 'b'.repeat(64),
    metadataHash: 'c'.repeat(64),
    imageUrl: `https://assets.example.test/launch-assets/${'b'.repeat(64)}.webp`,
    metadataUrl: `https://assets.example.test/launch-assets/${'c'.repeat(64)}.json`,
    status: 'published' as const,
    launchReady: false as const,
  };
}

await test('IPFS cache upgrades exact legacy gateway paths without losing publication identity', () => {
  const ipfs = { profile: 'pinata-v1-256k', schema: 'long-ipfs-v1', imageCid: `b${'a'.repeat(58)}`, metadataCid: `b${'b'.repeat(58)}` };
  const saved = { sourceKey: 'd'.repeat(64), result: { ...published(), ipfs,
    imageUrl: `https://assets.example.test/files/${ipfs.imageCid}`,
    metadataUrl: `https://assets.example.test/files/${ipfs.metadataCid}` } };
  const restored = validateDraftPublication(saved);
  assert.deepEqual(restored, { ...saved, result: { ...saved.result,
    imageUrl: saved.result.imageUrl.replace('/files/', '/ipfs/'),
    metadataUrl: saved.result.metadataUrl.replace('/files/', '/ipfs/') } });
  for (const field of ['imageUrl', 'metadataUrl'] as const) {
    assert.equal(validateDraftPublication({ ...saved, result: { ...saved.result, [field]: saved.result[field] + '?changed=1' } }), null);
    assert.equal(validateDraftPublication({ ...saved, result: { ...saved.result, [field]: saved.result[field].replace('assets.example.test', 'other.example.test') } }), null);
  }
});

await test('round trip stores the Blob bytes and draft fields, never its object URL', async () => {
  const original = draft();
  const encoded = await encodeLaunchDraft(original);
  const restored = await decodeLaunchDraft(structuredClone(encoded));
  assert.ok(restored?.image instanceof Blob);
  assert.deepEqual(
    new Uint8Array(await restored.image.arrayBuffer()),
    new Uint8Array(await original.image!.blob!.arrayBuffer()),
  );
  assert.equal(restored.prompt, original.prompt);
  assert.deepEqual(restored.selection, original.selection);
  assert.equal(JSON.stringify(encoded).includes('blob:'), false);
  assert.equal('url' in restored.image, false);
});

await test('draft cache copies only draft fields and excludes wallet or authorization data', async () => {
  const saved = await encodeLaunchDraft(draft());
  const restored = await decodeLaunchDraft({
    ...saved,
    wallet: 'EXAMPLE',
    paymentSignature: 'EXAMPLE',
    privateKey: 'EXAMPLE',
    selection: {
      ...saved.selection,
      destinations: saved.selection.destinations.map((item) => ({
        ...item,
        signature: 'EXAMPLE',
      })),
    },
  });
  assert.equal(JSON.stringify(restored).includes('EXAMPLE'), false);
});

await test('expired object URLs, malformed image bytes and unsupported cache versions are rejected', async () => {
  const saved = await encodeLaunchDraft(draft());
  for (const invalid of [
    { ...saved, image: { url: 'blob:https://example.test/expired', size: 24 } },
    { ...saved, image: new Blob(['not an image'], { type: 'image/png' }) },
    { ...saved, version: 2 },
    { ...saved, selection: { ...saved.selection, destinations: [] } },
    { ...saved, prompt: 'x'.repeat(12001) },
  ])
    await assert.rejects(decodeLaunchDraft(invalid));
  assert.equal(await decodeLaunchDraft(undefined), null);
});

await test('publication survives reload only for the same coin fields and image bytes', async () => {
  const source = draft();
  source.published = {
    sourceKey: await draftArtworkKey(source, source.image!.blob!),
    result: published(),
  };
  const encoded = await encodeLaunchDraft(source);
  assert.deepEqual(
    (await decodeLaunchDraft(encoded))?.published?.result,
    published(),
  );
  for (const edited of [
    { ...encoded, name: 'Different' },
    { ...encoded, ticker: 'SUN' },
    { ...encoded, description: 'Different' },
    { ...encoded, image: image(1) },
    { ...encoded, image: null },
  ])
    assert.equal((await decodeLaunchDraft(edited))?.published, null);
  assert.ok(
    (await decodeLaunchDraft({ ...encoded, prompt: 'A new prompt.' }))
      ?.published,
  );
});

await test('cached publication rejects unsafe or unrelated URLs and strips extra response fields', () => {
  const valid = { sourceKey: 'f'.repeat(64), result: published() };
  for (const result of [
    { ...valid.result, metadataUrl: 'javascript:alert(1)' },
    { ...valid.result, metadataUrl: 'https://evil.test/file.json' },
    {
      ...valid.result,
      imageUrl: `${new URL('https://assets.example.test').protocol}//${['EXAMPLE', 'EXAMPLE'].join(':')}@assets.example.test/launch-assets/${'b'.repeat(64)}.webp`,
    },
    {
      ...valid.result,
      metadataUrl: `${valid.result.metadataUrl}?signature=EXAMPLE`,
    },
  ])
    assert.equal(validateDraftPublication({ ...valid, result }), null);
  assert.deepEqual(
    validateDraftPublication({
      ...valid,
      result: { ...valid.result, signature: 'EXAMPLE' },
    }),
    valid,
  );
});

await test('editing clears stale metadata, keeps custom prompt and preserves ticker autofill', () => {
  const original = emptyLaunchDraft();
  const typed = updateDraftField(original, 'ticker', 'mo_on1');
  assert.equal(typed.ticker, 'MOON');
  assert.equal(typed.name, 'MOON');
  assert.match(typed.prompt, /MOON/);
  const current = draft();
  current.published = { sourceKey: 'f'.repeat(64), result: published() };
  assert.equal(
    updateDraftField(current, 'ticker', 'SUN').prompt,
    current.prompt,
  );
  assert.equal(
    updateDraftField(current, 'description', 'Changed').published,
    null,
  );
  assert.equal(
    updateDraftField(current, 'image', { ...current.image! }).published,
    null,
  );
  assert.equal(
    updateDraftField(current, 'prompt', 'New prompt').published,
    current.published,
  );
  assert.equal(
    sameDraftArtwork(current, { ...current, prompt: 'Other' }),
    true,
  );
});

await test('legacy in-session image URLs are fetched only from this origin and verified', async () => {
  let requested = '';
  const fetcher = (async (url: string | URL | Request) => {
    requested =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    return new Response(image());
  }) as typeof fetch;
  const local = { url: 'blob:https://example.test/current', size: 24 };
  assert.equal(
    (await draftImageBlob(local, fetcher, 'https://example.test')).size,
    24,
  );
  assert.equal(requested, local.url);
  requested = '';
  await assert.rejects(
    draftImageBlob(
      { ...local, url: 'https://external.test/pic.png' },
      fetcher,
      'https://example.test',
    ),
  );
  await assert.rejects(
    draftImageBlob(
      { ...local, url: 'blob:https://other.test/current' },
      fetcher,
      'https://example.test',
    ),
  );
  assert.equal(requested, '');
  await assert.rejects(
    draftImageBlob({ ...local, size: 23 }, fetcher, 'https://example.test'),
  );
});

await test('serialized writes preserve newest edits even when its image finishes encoding first', async () => {
  const completions = new Map<string, (value: CachedLaunchDraft) => void>();
  const committed: string[] = [];
  const queue = createDraftWriteQueue(
    async (value) => {
      committed.push(value.name);
    },
    (value) =>
      new Promise((resolve) => {
        completions.set(value.name, resolve);
      }),
  );
  const older = queue({ ...draft(), name: 'Older' });
  const newer = queue({ ...draft(), name: 'Newer' });
  const encoded = await encodeLaunchDraft(draft());
  completions.get('Newer')!({ ...encoded, name: 'Newer' });
  await Promise.resolve();
  assert.deepEqual(committed, []);
  completions.get('Older')!({ ...encoded, name: 'Older' });
  await Promise.all([older, newer]);
  assert.deepEqual(committed, ['Older', 'Newer']);
});

await test('a failed write does not prevent the next edit from being saved', async () => {
  let saved = '';
  const queue = createDraftWriteQueue(async (value) => {
    if (value.name === 'Failure') throw new Error('Quota exceeded');
    saved = value.name;
  });
  const failed = queue({ ...draft(), name: 'Failure' });
  const succeeded = queue({ ...draft(), name: 'Latest' });
  await assert.rejects(failed, /Quota exceeded/);
  await succeeded;
  assert.equal(saved, 'Latest');
});

await test('legacy three-pad drafts retain artwork and selections when Stonks is added', async () => {
  const encoded = await encodeLaunchDraft(draft());
  const legacy = { ...encoded, selection: { ...encoded.selection,
    destinations: encoded.selection.destinations.filter(pad => pad.id !== 'stonks') } };
  const restored = await decodeLaunchDraft(legacy);
  assert.ok(restored?.image instanceof Blob);
  assert.deepEqual(restored.selection.destinations.filter(pad => pad.id !== 'stonks'), legacy.selection.destinations);
  assert.equal(restored.selection.destinations.find(pad => pad.id === 'stonks')?.selected, false);
});

await test('production four-pad drafts gain pons without losing existing choices', async () => {
  const saved = await encodeLaunchDraft(draft());
  saved.selection.destinations = saved.selection.destinations.filter(pad => pad.id !== 'pons');
  const original = structuredClone(saved.selection.destinations);
  const restored = await decodeLaunchDraft(saved);
  assert.ok(restored);
  assert.deepEqual(restored.selection.destinations.filter(pad => pad.id !== 'pons'), original);
  assert.equal(restored.selection.destinations.find(pad => pad.id === 'pons')?.selected, false);
  const legacy = { ...saved, selection: { ...saved.selection, destinations: saved.selection.destinations.filter(pad => pad.id !== 'stonks') } };
  const oldest = await decodeLaunchDraft(legacy);
  assert.equal(oldest?.selection.destinations.length, 5);
});
