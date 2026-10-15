import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDraft } from '../apps/web/lib/launch-model.ts';

test('Stonks accepts only its own current catalog, independently of O1', () => {
  const draft = { name: 'Moon', ticker: 'MOON', description: '', hasImage: true };
  const pair = { id: 'stonks-603f4784b66148fa71835959', symbol: 'AAPL' };
  const destinations = [{ id: 'stonks', selected: true, chainId: 8453, route: 'rwa', pairId: pair.id, editableMetadata: false }];
  const catalog = { chainId: 8453, expiresAt: 200, pads: { stonks: { status: 'ready', pairs: [pair] }, o1: { status: 'ready', pairs: [] } } };
  assert.deepEqual(validateDraft(draft, destinations, 8453, catalog, 100), {});
  for (const invalid of [null, { ...catalog, chainId: 4663 }, { ...catalog, expiresAt: 100 }, { ...catalog, pads: { stonks: { status: 'unavailable', pairs: [pair] } } },
    { ...catalog, pads: { stonks: { status: 'ready', pairs: [] }, o1: { status: 'ready', pairs: [pair] } } },
    { ...catalog, pads: { stonks: { status: 'ready', pairs: [] }, stonx: { status: 'ready', pairs: [pair] } } }])
    assert.ok(validateDraft(draft, destinations, 8453, invalid, 100).destinations);
});

test('Base O1 accepts its own fresh catalog without borrowing Stonks or stonx pairs', () => {
  const draft = { name: 'Moon', ticker: 'MOON', description: '', hasImage: true };
  const pair = { id: `rwa-${'a'.repeat(24)}`, symbol: 'AAPL' };
  const destinations = [{ id: 'o1', selected: true, chainId: 8453, route: 'rwa', pairId: pair.id, editableMetadata: false }];
  const catalog = { chainId: 8453, expiresAt: 200, pads: { o1: { status: 'ready', pairs: [pair] } } };
  assert.deepEqual(validateDraft(draft, destinations, 8453, catalog, 100), {});
  for (const invalid of [null, { ...catalog, chainId: 4663 }, { ...catalog, expiresAt: 100 },
    { ...catalog, pads: { o1: { status: 'unavailable', pairs: [pair] } } },
    { ...catalog, pads: { o1: { status: 'ready', pairs: [] }, stonks: { status: 'ready', pairs: [pair] } } },
    { ...catalog, pads: { o1: { status: 'ready', pairs: [] }, stonx: { status: 'ready', pairs: [pair] } } }])
    assert.ok(validateDraft(draft, destinations, 8453, invalid, 100).destinations);
});
