import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NarrativeStore } from "./narrative-store.mjs";

const DAY = 86_400_000;
const row = (id, name = "The dogs", extra = {}) => ({
  meme: `0x${id.toString(16).padStart(40, "0")}`,
  name,
  quote_kind: "eth",
  ...extra,
});
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let now = 1_000_000;
  return { store: new NarrativeStore(db, () => now), advance: (ms) => (now += ms) };
}

test("arrival starts at second distinct token; later mentions never reorder or reset it", (t) => {
  const { store, advance } = fixture(t);
  store.observe([row(1), row(1, "The dogs", { pool: "another" })]);
  assert.deepEqual(store.snapshot(), []);
  advance(60_000);
  store.observe([row(1), row(2)]);
  const dogs = store.snapshot()[0];
  assert.equal(dogs.arrivedAt, 1_060_000);
  assert.equal(dogs.count, 2);
  advance(60_000);
  store.observe([row(3, "Marians"), row(4, "Marians")]);
  assert.deepEqual(
    store.snapshot().map((g) => g.name),
    ["Marians", "The dogs"],
  );
  store.observe([row(5, "The dog"), row(5, "The dog", { quote_kind: "shares" })]);
  assert.deepEqual(
    store.snapshot().map((g) => g.count),
    [2, 3],
  );
  assert.equal(store.snapshot()[1].arrivedAt, dogs.arrivedAt);
  assert.equal(store.snapshot()[1].name, dogs.name);
});

test("retain arrivals for exactly one day, even after rows disappear, without readmission", (t) => {
  const { store, advance } = fixture(t);
  store.observe([row(1), row(2)]);
  const arrived = store.snapshot()[0];
  advance(DAY - 1);
  store.observe([]);
  assert.equal(store.snapshot()[0].id, arrived.id);
  advance(1);
  assert.deepEqual(store.snapshot(), []);
  store.observe([row(1), row(2)]);
  assert.deepEqual(store.snapshot(), [], "cached/repeated contracts cannot restart a day");
  store.observe([row(1), row(2), row(3)]);
  assert.deepEqual(store.snapshot(), [], "a new episode needs two new contracts");
  store.observe([row(1), row(2), row(3), row(4)]);
  assert.equal(store.snapshot()[0].count, 2);
  assert.notEqual(store.snapshot()[0].id, arrived.id);
});

test("new narrative times and counts survive database close/reopen", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fungun-narratives-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, "journal.sqlite");
  let db = new DatabaseSync(path);
  const first = new NarrativeStore(db, () => 1_000_000);
  first.observe([row(1), row(2)]);
  const before = first.snapshot().map((item) => ({ ...item }));
  db.close();
  db = new DatabaseSync(path);
  t.after(() => db.close());
  const restored = new NarrativeStore(db, () => 2_000_000);
  restored.observe([row(1), row(2)]);
  assert.deepEqual(
    restored.snapshot().map((item) => ({ ...item })),
    before,
  );
});

test("all 2+ groups are retained, invalid rows and pools cannot inflate counts", (t) => {
  const { store } = fixture(t);
  const rows = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].flatMap((name, i) => [
    row(i * 2 + 1, name),
    row(i * 2 + 2, name),
  ]);
  store.observe([
    ...rows,
    row(1, "Alpha"),
    row(99, "Alpha", { chain_id: 8453 }),
    row(100, "Alpha", { quote_kind: "other" }),
    { name: "Alpha" },
    null,
  ]);
  assert.equal(store.snapshot().length, 5);
  assert.ok(store.snapshot().every((g) => g.count === 2));
});
