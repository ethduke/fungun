import assert from 'node:assert/strict';
import test from 'node:test';
import { O1_ROBINHOOD_PAIRS, savedO1Pairs } from '../apps/web/lib/o1-markets.ts';
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

test('a saved RWA selection requires fresh live eligibility, including removal from the live list', () => {
  const pair = O1_ROBINHOOD_PAIRS[0];
  const draft = { name: 'Moon', ticker: 'MOON', description: '', hasImage: true };
  const destinations = [{ ...DEFAULT_DESTINATIONS[1], selected: true, route: 'rwa', pairId: pair.id }];
  const catalog = { chainId: 4663, expiresAt: 200, pads: { o1: { status: 'ready', pairs: [pair] } } };
  assert.ok(validateDraft(draft, destinations, 4663, null, 100).destinations);
  assert.deepEqual(validateDraft(draft, destinations, 4663, catalog, 100), {});
  assert.ok(validateDraft(draft, destinations, 4663, catalog, 200).destinations);
  assert.ok(validateDraft(draft, destinations, 4663, { ...catalog, pads: { o1: { status: 'ready', pairs: [] } } }, 100).destinations);
});
