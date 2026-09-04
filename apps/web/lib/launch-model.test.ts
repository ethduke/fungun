import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_DESTINATIONS,
  IMAGE_LIMIT,
  imageFileError,
  imageKind,
  validateDraft,
  type Destination,
} from './launch-model.ts';

const draft = {
  name: 'Moon Department',
  ticker: 'MOON',
  description: '',
  hasImage: true,
};
const destinations = () => structuredClone(DEFAULT_DESTINATIONS);

await test('valid Long draft and empty draft requirements', () => {
  assert.deepEqual(validateDraft(draft, destinations()), {});
  const errors = validateDraft(
    { name: '', ticker: '', description: '', hasImage: false },
    [],
  );
  assert.deepEqual(Object.keys(errors).sort(), [
    'destinations',
    'image',
    'name',
    'ticker',
  ]);
});

await test('name and ticker limits use characters, not bytes', () => {
  assert.equal(
    validateDraft({ ...draft, name: '🌙'.repeat(50) }, destinations()).name,
    undefined,
  );
  assert.ok(
    validateDraft({ ...draft, name: '🌙'.repeat(51) }, destinations()).name,
  );
  assert.ok(
    validateDraft({ ...draft, ticker: 'ABCDEFGHIJKL' }, destinations()).ticker,
  );
  for (const ticker of ['MO ON', 'MOON1', 'moon', 'MOON!', 'MOON\n'])
    assert.ok(validateDraft({ ...draft, ticker }, destinations()).ticker);
});

await test('O1 has independent ticker and chain rules', () => {
  const o1: Destination = {
    ...DEFAULT_DESTINATIONS[1],
    selected: true,
    chainId: 8453,
  };
  assert.deepEqual(validateDraft({ ...draft, ticker: 'MOON1' }, [o1]), {});
  assert.ok(validateDraft({ ...draft, ticker: 'MO ON' }, [o1]).ticker);
  assert.ok(validateDraft(draft, [{ ...o1, chainId: 1 as 8453 }]).destinations);
});

await test('Long rejects unsupported chain, route and editable metadata', () => {
  for (const change of [
    { chainId: 8453 },
    { route: 'standard', pairId: 'native' },
    { editableMetadata: true },
  ]) {
    assert.ok(
      validateDraft(draft, [
        { ...DEFAULT_DESTINATIONS[0], ...change } as Destination,
      ]).destinations,
    );
  }
});

await test('multi-launch validates every selected destination', () => {
  const pads = destinations().map((pad) => ({ ...pad, selected: true }));
  assert.deepEqual(validateDraft(draft, pads), {});
  assert.ok(
    validateDraft(
      draft,
      pads.map((pad) => ({ ...pad, selected: false })),
    ).destinations,
  );
  pads[1].pairId = 'sample-nvda';
  assert.ok(validateDraft(draft, pads).destinations);
});

await test('description has a UTF-8 byte limit', () => {
  assert.equal(
    validateDraft({ ...draft, description: '🌙'.repeat(500) }, destinations())
      .description,
    undefined,
  );
  assert.ok(
    validateDraft({ ...draft, description: '🌙'.repeat(501) }, destinations())
      .description,
  );
});

await test('image sniffing rejects unsupported or spoofed formats', () => {
  const png = new Uint8Array(32);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set(new TextEncoder().encode('IHDR'), 12);
  assert.equal(imageKind(png), 'image/png');
  assert.equal(imageFileError(100, 'image/png', png), null);
  assert.equal(imageFileError(100, '', png), null);
  assert.ok(imageFileError(100, 'image/jpeg', png));
  assert.ok(imageFileError(IMAGE_LIMIT + 1, 'image/png', png));
  assert.ok(imageFileError(0, 'image/png', png));
  assert.ok(
    imageFileError(
      100,
      'image/svg+xml',
      new TextEncoder().encode('<svg></svg>'),
    ),
  );
  assert.equal(imageKind(new Uint8Array([137, 80])), null);
});
