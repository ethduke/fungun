import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AgentThemes, normalizeThemeName } from './agent-themes.mjs';
const row = (n, name = 'Moon Club', extra = {}) => ({ chain_id: 4663, quote_kind: 'eth', token: `0x${n.toString(16).padStart(40, '0')}`, name, ...extra });
function setup() {
  const db = new DatabaseSync(':memory:');
  let at = 1000000, pools = [], failure = false, calls = 0;
  const options = { now: () => at, refreshMs: 1000, fetchSnapshot: async () => { calls++; if (failure) throw Error('unavailable'); return { pools }; } };
  return { db, options, service: new AgentThemes(db, options), set: value => pools = value, advance: (ms = 1000) => at += ms, fail: () => failure = true, calls: () => calls };
}
test('exact normalized names count distinct addresses, never pools or fuzzy names', async () => {
  const s = setup();
  s.set([row(1), row(1, '  MOON   CLUB  '), row(2, 'ｍｏｏｎ club'), row(3, 'MoonClub')]);
  const result = await s.service.poll({ minimumTokens: 2 });
  assert.equal(result.themes.length, 1);
  assert.equal(result.themes[0].count, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.freshness.status, 'fresh');
  assert.equal(normalizeThemeName('a\u0000b'), null);
  s.db.close();
});
test('threshold event is immutable and durable; repeats do not cause storms', async () => {
  const s = setup(); s.set([row(1), row(2)]);
  const initial = await s.service.poll(); assert.equal(initial.events.length, 0);
  s.advance(); s.set([row(1), row(2), row(3)]);
  const crossing = await s.service.poll({ cursor: initial.nextCursor });
  assert.equal(crossing.events.length, 1);
  s.advance(); s.set([row(1), row(2), row(3), row(4)]);
  assert.equal((await s.service.poll({ cursor: crossing.nextCursor })).events.length, 0);
  s.service = new AgentThemes(s.db, s.options);
  const replay = await s.service.poll({ cursor: initial.nextCursor });
  assert.deepEqual(replay.events, crossing.events);
  assert.equal(replay.themes[0].count, 4);
  s.db.close();
});
test('first observation expires despite continual presence and reappearance', async () => {
  const s = setup(); s.set([row(1), row(2)]);
  await s.service.poll({ minimumTokens: 2, windowSeconds: 60 });
  s.advance(61000);
  const expired = await s.service.poll({ minimumTokens: 2, windowSeconds: 60 });
  assert.equal(expired.themes.length, 0);
  s.advance(); s.set([row(3), row(4)]);
  const next = await s.service.poll({ minimumTokens: 2, windowSeconds: 60, cursor: expired.nextCursor });
  assert.equal(next.events.length, 1);
  s.advance(); s.set([row(1), row(2)]);
  assert.equal((await s.service.poll({ minimumTokens: 2, windowSeconds: 60, cursor: next.nextCursor })).events.length, 0);
  s.db.close();
});
test('coalesced refresh and upstream failure preserve stale status with backoff', async () => {
  const s = setup(); s.set([row(1), row(2)]);
  await Promise.all(Array.from({ length: 10 }, () => s.service.poll()));
  assert.equal(s.calls(), 1);
  s.advance(); s.fail();
  assert.equal((await s.service.poll()).freshness.status, 'stale');
  await s.service.poll(); assert.equal(s.calls(), 2);
  s.db.close();
});
test('malformed source cannot produce fresh data, and invalid cursors/configurations fail', async () => {
  for (const bad of [row(1, 'x', { chain_id: 1 }), row(1, 'x', { chain_id: undefined }), row(1, 'x', { token: 'bad' }), row(1, 'x'.repeat(129))]) {
    const s = setup(); s.set([bad]);
    assert.equal((await s.service.poll()).freshness.status, 'unavailable'); s.db.close();
  }
  const s = setup();
  await assert.rejects(s.service.poll({ minimumTokens: 1 }), /invalid_request/);
  await assert.rejects(s.service.poll({ windowSeconds: 86401 }), /invalid_request/);
  const result = await s.service.poll();
  await assert.rejects(s.service.poll({ minimumTokens: 2, cursor: result.nextCursor }), /invalid_request/);
  await assert.rejects(s.service.poll({ cursor: 'x'.repeat(10000) }), /invalid_request/);
  s.db.close();
});

test('persisted cursor survives database reopen and retention gaps are explicit', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'themes-test-'));
  const path = join(dir, 'themes.sqlite');
  let at = 1000000;
  const options = { now: () => at, refreshMs: 1000, fetchSnapshot: async () => ({ pools: [row(1), row(2)] }) };
  let db = new DatabaseSync(path);
  try {
    const first = await new AgentThemes(db, options).poll({ minimumTokens: 2 });
    db.close(); db = new DatabaseSync(path);
    const service = new AgentThemes(db, options);
    assert.equal((await service.poll({ minimumTokens: 2, cursor: first.nextCursor })).events.length, 0);
    const zero = first.nextCursor.replace(/:[0-9]+$/, ':0');
    assert.deepEqual((await service.poll({ minimumTokens: 2, cursor: zero })).events, first.events);
    at += 8 * 86400000;
    await service.poll({ minimumTokens: 2 });
    await assert.rejects(service.poll({ minimumTokens: 2, cursor: zero }), /theme_cursor_expired/);
    assert.equal((await service.poll({ minimumTokens: 2, cursor: first.nextCursor })).events.length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
