import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autofillCoinName,
  autofillGrokPrompt,
  buildGrokPrompt,
  DEFAULT_DESTINATIONS,
  DEFAULT_CHAIN_ID,
  IMAGE_LIMIT,
  draftStatus,
  imageFileError,
  imageKind,
  selectChain,
  selectDestination,
  hasSharedTickerConflict,
  supportsChain,
  isWebviewChain,
  pairingName,
  readablePads,
  validateDraft,
  type Destination,
} from './launch-model.ts';
import { LONGBOW_PAIRS } from './longbow-markets.ts';
import { O1_ROBINHOOD_PAIRS } from './o1-markets.ts';

const draft = {
  name: 'Moon Department',
  ticker: 'MOON',
  description: '',
  hasImage: true,
};
const destinations = () => structuredClone(DEFAULT_DESTINATIONS);

await test('selecting Long or Longbow switches the shared ticker destination and preserves O1 and pairings', () => {
  let selected = destinations().map(pad => pad.id === 'o1' ? { ...pad, selected: true } : pad);
  const original = structuredClone(selected);
  selected = selectDestination(selected, { ...selected[2], selected: true });
  assert.deepEqual(selected.map(pad => pad.selected), [false, true, true, false, false, false]);
  assert.deepEqual(validateDraft(draft, selected, 4663), {});
  selected = selectDestination(selected, { ...selected[0], selected: true });
  assert.deepEqual(selected.map(pad => pad.selected), [true, true, false, false, false, false]);
  assert.deepEqual(selected.map(pad => pad.pairId), original.map(pad => pad.pairId));
  selected = selectDestination(selected, { ...selected[0], selected: false });
  assert.deepEqual(selected.map(pad => pad.selected), [false, true, false, false, false, false]);
  assert.deepEqual(original.map(pad => pad.selected), [true, true, false, false, false, false]);
});

await test('a restored legacy selection with both ticker-sharing pads cannot launch', () => {
  const selected = destinations().map(pad => ({ ...pad, selected: pad.chainId === 4663 }));
  assert.equal(hasSharedTickerConflict(selected), true);
  assert.match(validateDraft(draft, selected, 4663).destinations, /Choose Long or Longbow/);
  assert.equal(draftStatus(validateDraft(draft, selected, 4663), false), 'incomplete');
  assert.equal(hasSharedTickerConflict(selectDestination(selected, { ...selected[0], selected: true })), false);
});

await test('Grok prompt uses the coin name and permits only ticker text', () => {
  assert.equal(
    buildGrokPrompt('Moon Department', 'MOON'),
    'Create a bright, simple logo for a memecoin named "Moon Department" with ticker "MOON". Use bold shapes, no small details, and a square composition. The only text should be the ticker "MOON".',
  );
  assert.match(
    buildGrokPrompt('Sunny', 'SUN'),
    /named "Sunny" with ticker "SUN"\./,
  );
  assert.match(
    buildGrokPrompt('🌙', 'Moon'),
    /named "🌙" with ticker "Moon"\./,
  );
});

await test('Grok prompt handles partial, blank and cleared identity fields', () => {
  assert.match(
    buildGrokPrompt('   ', ' MOON '),
    /named "MOON".*ticker "MOON"/,
  );
  assert.match(
    buildGrokPrompt(' Moon ', ''),
    /named "Moon".*Do not include any text\.$/,
  );
  assert.equal(
    buildGrokPrompt('', ''),
    'Create a bright, simple logo for a memecoin. Use bold shapes, no small details, and a square composition. Do not include any text.',
  );
  assert.equal(buildGrokPrompt(' ', ' '), buildGrokPrompt('', ''));
});

await test('ticker fills real prompt text and follows typing, replacement and clearing', () => {
  let current = { name: '', ticker: '', prompt: '' };
  for (const ticker of ['M', 'MO', 'MOON', 'SUN', 'SU', '', 'STAR']) {
    const named = { ...current, name: autofillCoinName(current.name, current.ticker, ticker) };
    named.prompt = autofillGrokPrompt(current, named);
    const next = { ...named, ticker };
    next.prompt = autofillGrokPrompt(named, next);
    assert.equal(next.prompt, ticker ? buildGrokPrompt(ticker, ticker) : '');
    current = next;
  }
});

await test('generated prompt follows manual names and staged or copied identities', () => {
  const current = { name: 'MOON', ticker: 'MOON', prompt: buildGrokPrompt('MOON', 'MOON') };
  const named = { ...current, name: 'Moon Department' };
  named.prompt = autofillGrokPrompt(current, named);
  assert.equal(named.prompt, buildGrokPrompt('Moon Department', 'MOON'));
  const copied = { ...named, name: 'Sun Club' };
  copied.prompt = autofillGrokPrompt(named, copied);
  assert.equal(autofillGrokPrompt(copied, { name: 'Sun Club', ticker: 'SUN' }), buildGrokPrompt('Sun Club', 'SUN'));
});

await test('custom image prompts are preserved and clearing allows the next ticker to fill them', () => {
  const current = { name: 'MOON', ticker: 'MOON', prompt: 'A bright moon wearing sunglasses.' };
  for (const next of [{ name: 'SUN', ticker: 'SUN' }, { name: '', ticker: '' }, { name: 'Moon Club', ticker: 'MOON' }])
    assert.equal(autofillGrokPrompt(current, next), current.prompt);
  assert.equal(autofillGrokPrompt({ ...current, prompt: '' }, { name: 'SUN', ticker: 'SUN' }), buildGrokPrompt('SUN', 'SUN'));
  assert.equal(autofillGrokPrompt({ name: '', ticker: '', prompt: '' }, { name: 'Moon', ticker: '' }), '');
});

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

await test('inline launch status follows draft edits without a review snapshot', () => {
  const status = (changes = {}) =>
    draftStatus(
      validateDraft({ ...draft, ...changes }, destinations(), 4663),
      false,
    );
  assert.equal(status(), 'complete');
  assert.equal(status({ ticker: 'MOON1' }), 'incomplete');
  assert.equal(status({ name: '' }), 'incomplete');
  assert.equal(status({ hasImage: false }), 'incomplete');
  assert.equal(status({ ticker: 'SUN' }), 'complete');
});

await test('pending image replacement takes precedence over an otherwise complete draft', () => {
  const errors = validateDraft(draft, destinations(), 4663);
  assert.equal(draftStatus(errors, true), 'checking');
  assert.equal(draftStatus({ image: 'Add a coin image.' }, true), 'checking');
  assert.equal(draftStatus(errors, false), 'complete');
  assert.equal(
    draftStatus({ image: 'Add a coin image.' }, false),
    'incomplete',
  );
});

await test('inline launch status revalidates chain and launchpad selections', () => {
  const base: Destination[] = [
    { ...DEFAULT_DESTINATIONS[1], selected: true, chainId: 8453 },
  ];
  assert.equal(
    draftStatus(validateDraft(draft, base, 8453), false),
    'complete',
  );
  assert.equal(
    draftStatus(validateDraft(draft, base, 4663), false),
    'incomplete',
  );
  assert.equal(
    draftStatus(validateDraft(draft, [], 8453), false),
    'incomplete',
  );
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

await test('O1 uses the same ticker restriction and validates its chain', () => {
  const o1: Destination = {
    ...DEFAULT_DESTINATIONS[1],
    selected: true,
    chainId: 4663,
  };
  assert.deepEqual(validateDraft(draft, [o1]), {});
  assert.ok(validateDraft({ ...draft, ticker: 'MOON1' }, [o1]).ticker);
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
  const pads = destinations().map((pad) => ({ ...pad, selected: ['long', 'o1'].includes(pad.id) }));
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

await test('Robinhood is the default chain with all four Robinhood launchpads available', () => {
  assert.equal(DEFAULT_CHAIN_ID, 4663);
  assert.ok(
    destinations().filter(pad => !['stonks', 'stonx'].includes(pad.id)).every((pad) => supportsChain(pad.id, DEFAULT_CHAIN_ID)),
  );
  assert.deepEqual(
    destinations()
      .filter((pad) => pad.selected)
      .map((pad) => pad.id),
    ['long'],
  );
});

await test('Base selects O1 and resets chain-specific quote addresses', () => {
  const before = destinations().map((pad) => ({ ...pad, selected: ['long', 'o1'].includes(pad.id) }));
  before[1].route = 'rwa';
  before[1].pairId = O1_ROBINHOOD_PAIRS.find((pair) => pair.symbol === 'AAPL')!.id;
  const after = selectChain(before, 8453);
  assert.equal(isWebviewChain(8453), true);
  assert.equal(isWebviewChain(4663), true);
  assert.deepEqual(after.filter(pad => pad.selected).map(pad => pad.id), ['o1']);
  assert.equal(after[1].chainId, 8453);
  assert.equal(after[1].pairId, 'native');
  assert.equal(after[1].route, 'standard');
  assert.equal(before[1].route, 'rwa');
  assert.deepEqual(validateDraft(draft, after, 8453), {});
  assert.equal(selectChain(destinations(), 8453)[1].selected, true);
});

await test('Base O1 is valid only with a matching chain selection', () => {
  const base: Destination[] = [
    { ...DEFAULT_DESTINATIONS[1], selected: true, chainId: 8453 },
  ];
  assert.deepEqual(validateDraft(draft, base), {});
  assert.deepEqual(validateDraft(draft, base, 8453), {});
  assert.ok(validateDraft(draft, base, 4663).destinations);
  assert.ok(validateDraft(draft, destinations(), 8453).destinations);
  const recovered = selectChain(base, 4663);
  assert.equal(recovered[0].chainId, 4663);
  assert.equal(recovered[0].pairId, 'native');
  assert.deepEqual(validateDraft(draft, recovered, 4663), {});
});

await test('Longbow accepts only its registry pairs independently of a live O1 catalog', () => {
  const longbow = destinations().find((pad) => pad.id === 'longbow')!;
  const catalog = {
    chainId: 4663 as const,
    expiresAt: 1000,
    pads: { o1: { status: 'ready' as const, pairs: [] } },
  };
  for (const symbol of ['AAOI', 'LULU', 'SKHY', 'WEEK', 'ZS']) {
    const pair = LONGBOW_PAIRS.find((entry) => entry.symbol === symbol)!;
    assert.equal(pairingName(pair.id), symbol);
    assert.deepEqual(
      validateDraft(
        draft,
        [{ ...longbow, selected: true, pairId: pair.id }],
        4663,
        catalog,
        10,
      ),
      {},
    );
  }
  for (const pairId of [
    'long-NVDA',
    'sample-nvda',
    'native',
    'longbow-UNKNOWN',
    'longbow-SKYHY',
  ])
    assert.ok(
      validateDraft(
        draft,
        [{ ...longbow, selected: true, pairId } as Destination],
        4663,
      ).destinations,
    );
  for (const pad of destinations().filter((entry) => entry.id !== 'longbow'))
    assert.ok(
      validateDraft(
        draft,
        [{ ...pad, selected: true, route: 'rwa', pairId: 'longbow-NVDA' }],
        4663,
      ).destinations,
    );
});

await test('Longbow shares Long ticker reads, coalescing the registry for mixed selections', () => {
  assert.deepEqual(readablePads(['longbow']), ['long']);
  assert.deepEqual(readablePads(['long', 'longbow']), ['long']);
  assert.deepEqual(readablePads(['o1', 'longbow']), ['o1', 'long']);
  assert.deepEqual(readablePads(['long', 'o1', 'longbow']), ['long', 'o1']);
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

await test('image sniffing requires supported raster content and enforces size limits', () => {
  const png = new Uint8Array(32);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  png.set(new TextEncoder().encode('IHDR'), 12);
  assert.equal(imageKind(png), 'image/png');
  assert.equal(imageFileError(100, 'image/png', png), null);
  assert.equal(imageFileError(100, '', png), null);
  assert.equal(imageFileError(100, 'image/jpeg', png), null);
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

const webpSamples = [
  new Uint8Array([
    82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 9, 0, 0, 0, 47,
    0, 0, 0, 0, 136, 136, 254, 7, 0,
  ]),
  new Uint8Array([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32, 24, 0, 0, 0,
    48, 1, 0, 157, 1, 42, 1, 0, 1, 0, 1, 64, 38, 37, 164, 0, 3, 112, 0, 254,
    253, 54, 104, 0,
  ]),
];

await test('valid lossy and lossless WebP accepts generic and legacy MIME labels', () => {
  for (const bytes of webpSamples) {
    const header = bytes.slice(0, 32);
    assert.equal(imageKind(header), 'image/webp');
    for (const mime of [
      'image/webp',
      '',
      'application/octet-stream',
      'image/x-webp',
      ' IMAGE/WEBP ',
    ])
      assert.equal(imageFileError(bytes.length, mime, header), null, mime);
  }
});

await test('WebP MIME compatibility does not bypass file validation or size limits', () => {
  const bytes = webpSamples[0];
  const corrupt = bytes.slice();
  corrupt[8] = 0;
  for (const mime of [
    'image/webp',
    'image/x-webp',
    'application/octet-stream',
    '',
  ]) {
    assert.ok(imageFileError(corrupt.length, mime, corrupt));
    assert.ok(imageFileError(bytes.length, mime, bytes.slice(0, 12)));
    assert.ok(imageFileError(0, mime, bytes));
    assert.ok(imageFileError(IMAGE_LIMIT + 1, mime, bytes));
    assert.ok(
      imageFileError(100, mime, new TextEncoder().encode('<svg></svg>')),
    );
  }
  assert.equal(imageFileError(bytes.length, 'image/png', bytes), null);
  assert.ok(imageFileError(bytes.length, 'text/html', bytes));
});

await test('JPEG content named WebP is accepted and retagged as JPEG for decoding', async () => {
  const bytes = new Uint8Array(32);
  bytes.set([255, 216, 255, 219]);
  const file = new File([bytes], 'renamed.webp', { type: 'image/webp' });
  const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  assert.equal(imageKind(header), 'image/jpeg');
  assert.equal(imageFileError(file.size, file.type, header), null);
  const source = file.slice(0, file.size, imageKind(header) ?? '');
  assert.equal(source.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await source.arrayBuffer()), bytes);
});

await test('mislabeled raster files still reject unsupported MIME labels and non-image content', () => {
  const jpeg = new Uint8Array(32);
  jpeg.set([255, 216, 255, 219]);
  for (const mime of [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/webp',
    'image/x-webp',
    'image/gif',
    ' IMAGE/WEBP ',
    '',
    'application/octet-stream',
  ]) {
    assert.equal(imageFileError(jpeg.length, mime, jpeg), null);
    assert.ok(imageFileError(0, mime, jpeg));
    assert.ok(imageFileError(IMAGE_LIMIT + 1, mime, jpeg));
    for (const text of ['<svg></svg>', '<html></html>', 'not an image'])
      assert.ok(imageFileError(32, mime, new TextEncoder().encode(text)));
  }
  for (const mime of [
    'text/html',
    'image/svg+xml',
    'application/pdf',
    'image/unknown',
  ])
    assert.ok(imageFileError(jpeg.length, mime, jpeg));
});

await test('pons uses its own ETH route on Robinhood without a ticker reservation', () => {
  const pons = { ...DEFAULT_DESTINATIONS.find(pad => pad.id === 'pons')!, selected: true };
  assert.deepEqual(validateDraft(draft, [pons], 4663), {});
  assert.equal(pairingName(pons.pairId), 'ETH');
  assert.deepEqual(readablePads(['pons']), []);
  assert.deepEqual(readablePads(['pons', 'longbow']), ['long']);
  assert.equal(supportsChain('pons', 8453), false);
  for (const change of [{ chainId: 8453 }, { pairId: 'native' }, { route: 'rwa' }, { editableMetadata: true }])
    assert.ok(validateDraft(draft, [{ ...pons, ...change } as Destination], 4663).destinations);
  const base = selectChain([pons, DEFAULT_DESTINATIONS[1]], 8453);
  assert.equal(base.find(pad => pad.id === 'pons')?.selected, false);
  assert.equal(base.find(pad => pad.id === 'o1')?.selected, true);
});
