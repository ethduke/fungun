import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autofillCoinName,
  DEFAULT_DESTINATIONS,
  DEFAULT_CHAIN_ID,
  IMAGE_LIMIT,
  imageFileError,
  imageKind,
  selectChain,
  supportsChain,
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

await test('coin name follows ticker typing, replacement and clearing', () => {
  let name = '';
  let ticker = '';
  for (const nextTicker of ['M', 'MO', 'MOON', 'SUN', 'SU', '']) {
    name = autofillCoinName(name, ticker, nextTicker);
    ticker = nextTicker;
    assert.equal(name, ticker);
  }
});

await test('ticker autofill preserves custom names until the name is cleared', () => {
  assert.equal(
    autofillCoinName('Moon Department', 'MOON', 'SUN'),
    'Moon Department',
  );
  assert.equal(
    autofillCoinName('Moon Department', 'MOON', ''),
    'Moon Department',
  );
  assert.equal(autofillCoinName('', 'MOON', 'SUN'), 'SUN');
  assert.equal(autofillCoinName('   ', 'MOON', 'SUN'), 'SUN');
});

await test('ticker autofill copies the exact text without changing case or characters', () => {
  assert.equal(autofillCoinName('', '', 'Moon1'), 'Moon1');
  assert.equal(autofillCoinName('', '', '🌙'), '🌙');
});

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

await test('Robinhood is the default chain with both launchpads available', () => {
  assert.equal(DEFAULT_CHAIN_ID, 4663);
  assert.ok(
    destinations().every((pad) => supportsChain(pad.id, DEFAULT_CHAIN_ID)),
  );
  assert.deepEqual(
    destinations()
      .filter((pad) => pad.selected)
      .map((pad) => pad.id),
    ['long'],
  );
});

await test('switching to Base removes Long and resets O1 pairing without mutating the draft', () => {
  const before = destinations().map((pad) => ({ ...pad, selected: true }));
  before[1].route = 'rwa';
  before[1].pairId = 'sample-aapl';
  const after = selectChain(before, 8453);
  assert.deepEqual(
    after.filter((pad) => supportsChain(pad.id, 8453)).map((pad) => pad.id),
    ['o1'],
  );
  assert.deepEqual(after[0], { ...before[0], selected: false });
  assert.deepEqual(after[1], {
    ...before[1],
    chainId: 8453,
    route: 'standard',
    pairId: 'native',
  });
  assert.equal(before[0].selected, true);
  assert.equal(before[1].chainId, 4663);
  assert.equal(before[1].pairId, 'sample-aapl');
  assert.deepEqual(validateDraft(draft, after), {});
});

await test('chain switch selects O1 if needed and never restores hidden Long selection', () => {
  const base = selectChain(destinations(), 8453);
  assert.equal(base[0].selected, false);
  assert.equal(base[1].selected, true);
  const robinhood = selectChain(base, 4663);
  assert.equal(robinhood[0].selected, false);
  assert.equal(robinhood[1].selected, true);
  assert.equal(robinhood[1].chainId, 4663);
  assert.deepEqual(validateDraft(draft, robinhood), {});
});

await test('review rejects selected launchpads across different chains', () => {
  const mixed = destinations().map((pad) => ({ ...pad, selected: true }));
  mixed[1].chainId = 8453;
  assert.equal(
    validateDraft(draft, mixed).destinations,
    'Select launchpads on one chain at a time.',
  );
});

await test('review rejects a single stale selection that disagrees with the chain filter', () => {
  assert.ok(validateDraft(draft, destinations(), 8453).destinations);
  const base = selectChain(destinations(), 8453);
  assert.ok(validateDraft(draft, base, 4663).destinations);
  assert.deepEqual(validateDraft(draft, base, 8453), {});
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
