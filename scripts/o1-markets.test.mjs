import assert from 'node:assert/strict';
import test from 'node:test';
import { O1_ROBINHOOD_PAIRS, savedO1Pairs, selectableO1Pairs } from '../apps/web/lib/o1-markets.ts';
import { DEFAULT_DESTINATIONS, pairingName, validateDraft } from '../apps/web/lib/launch-model.ts';

test('the complete saved Robinhood catalog is chain-bound and resolves every pairing label', () => {
  assert.equal(O1_ROBINHOOD_PAIRS.length, 194);
  assert.equal(new Set(O1_ROBINHOOD_PAIRS.map((p) => p.id)).size, 194);
  assert.equal(new Set(O1_ROBINHOOD_PAIRS.map((p) => p.symbol)).size, 194);
  assert.deepEqual(savedO1Pairs(8453), []);
  for (const pair of savedO1Pairs(4663)) {
    assert.match(pair.id, /^rwa-[a-f0-9]{24}$/);
    assert.equal(pairingName(pair.id), pair.symbol);
  }
  assert.equal(pairingName('native'), 'ETH');
});

test('saved pairings remain eligible without a fresh live catalog', () => {
  const pair = O1_ROBINHOOD_PAIRS[0];
  const draft = { name: 'Moon', ticker: 'MOON', description: '', hasImage: true };
  const destinations = [{ ...DEFAULT_DESTINATIONS[1], selected: true, route: 'rwa', pairId: pair.id }];
  const catalog = { chainId: 4663, expiresAt: 200, pads: { o1: { status: 'ready', pairs: [pair] } } };
  assert.deepEqual(validateDraft(draft, destinations, 4663, null, 100), {});
  assert.deepEqual(validateDraft(draft, destinations, 4663, catalog, 100), {});
  assert.deepEqual(validateDraft(draft, destinations, 4663, catalog, 200), {});
  assert.deepEqual(validateDraft(draft, destinations, 4663, { ...catalog, pads: { o1: { status: 'ready', pairs: [] } } }, 100), {});
  assert.ok(validateDraft(draft, [{ ...destinations[0], pairId: 'rwa-unknown' }], 4663).destinations);
});

test('live catalogs extend and deduplicate the saved pairing choices', () => {
  const saved = O1_ROBINHOOD_PAIRS[0];
  const added = { id: 'rwa-111111111111111111111111', symbol: 'EXAMPLE' };
  const pairs = selectableO1Pairs(4663, { status: 'ready', pairs: [saved, added] });
  assert.equal(pairs.length, O1_ROBINHOOD_PAIRS.length + 1);
  assert.deepEqual(pairs.at(-1), added);
  assert.deepEqual(selectableO1Pairs(4663, { status: 'ready', pairs: [] }), O1_ROBINHOOD_PAIRS);
});
