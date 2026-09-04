import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Budget } from "./budget.mjs";
import { CatalogSnapshots, catalogPairId } from "./catalog-snapshots.mjs";

const HOUR = 60 * 60 * 1000;
const address = (digit) => `0x${digit.repeat(40)}`;
const quote = (chainId = 4663, digit = "1", symbol = "MOON") => {
  const value = address(digit);
  return { id: catalogPairId(chainId, value), address: value, symbol, decimals: 18 };
};

test("validated catalog snapshots survive restart without exposing addresses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fungun-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "budget.sqlite");
  let now = 1;
  let budget = new Budget(path, () => now);
  let snapshots = new CatalogSnapshots(budget.db, () => now);
  const firstLease = snapshots.begin(4663);
  assert.equal(firstLease, 1);
  snapshots.succeed(4663, [quote(), quote(4663, "2", "SUN")], firstLease);
  const first = snapshots.catalog(4663, new Set([address("1")]));
  assert.equal(first.pads.o1.status, "ready");
  assert.equal(first.pads.o1.pairs.length, 2);
  assert.equal(first.pads.long.pairs.length, 1);
  assert.equal(JSON.stringify(first).includes(address("1")), false);
  budget.close();

  budget = new Budget(path, () => now, false);
  snapshots = new CatalogSnapshots(budget.db, () => now);
  assert.equal(snapshots.catalog(4663).pads.o1.pairs.length, 2);
  assert.equal(snapshots.begin(4663), false);
  now += 6 * HOUR + 1;
  const stale = snapshots.catalog(4663);
  assert.equal(stale.pads.o1.status, "unavailable");
  assert.deepEqual(stale.pads.o1.pairs, []);
  assert.equal(snapshots.begin(4663), 2);
  budget.close();
});

test("refresh failures retain data and persist their retry deadline", () => {
  let now = 1;
  const budget = new Budget(":memory:", () => now);
  const snapshots = new CatalogSnapshots(budget.db, () => now);
  try {
    const firstLease = snapshots.begin(4663);
    assert.equal(firstLease, 1);
    snapshots.succeed(4663, [quote()], firstLease);
    now += 6 * HOUR + 1;
    const retryLease = snapshots.begin(4663);
    assert.equal(retryLease, 2);
    snapshots.fail(4663, retryLease, 359 * 60);
    assert.equal(snapshots.catalog(4663).pads.o1.status, "unavailable");
    assert.equal(snapshots.read(4663).quotes.length, 1);
    assert.equal(snapshots.begin(4663), false);
    now += 359 * 60 * 1000;
    assert.equal(snapshots.begin(4663), 3);
  } finally {
    budget.close();
  }
});

test("provider retry deadlines cover every chain and survive restart", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fungun-catalog-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "budget.sqlite");
  let now = 1;
  let budget = new Budget(path, () => now);
  let snapshots = new CatalogSnapshots(budget.db, () => now);
  const lease = snapshots.begin(4663);
  snapshots.fail(4663, lease, 359 * 60);
  assert.equal(snapshots.begin(8453), false);
  budget.close();

  budget = new Budget(path, () => now, false);
  snapshots = new CatalogSnapshots(budget.db, () => now);
  assert.equal(snapshots.begin(8453), false);
  now += 359 * 60 * 1000;
  assert.equal(snapshots.begin(8453), 1);
  budget.close();
});

test("clock rollback and expired retention fail closed", () => {
  let now = 8 * 24 * HOUR;
  const budget = new Budget(":memory:", () => now);
  const snapshots = new CatalogSnapshots(budget.db, () => now);
  try {
    const lease = snapshots.begin(4663);
    snapshots.succeed(4663, [quote()], lease);
    now += HOUR;
    assert.equal(snapshots.catalog(4663).pads.o1.status, "ready");
    now -= 30 * 60 * 1000;
    assert.equal(snapshots.catalog(4663).pads.o1.status, "unavailable");
    now += 8 * 24 * HOUR;
    assert.equal(snapshots.catalog(4663).pads.o1.status, "unavailable");
    assert.equal(snapshots.read(4663).quotes, null);
  } finally {
    budget.close();
  }
});

test("a refresh result cannot publish after its lease expires", () => {
  let now = 1;
  const budget = new Budget(":memory:", () => now);
  const snapshots = new CatalogSnapshots(budget.db, () => now);
  try {
    const expiredLease = snapshots.begin(4663);
    now += 10 * 60 * 1000 + 1;
    assert.equal(snapshots.succeed(4663, [quote()], expiredLease), false);
    assert.equal(snapshots.catalog(4663).pads.o1.status, "unavailable");
    const currentLease = snapshots.begin(4663);
    assert.equal(currentLease, 2);
    assert.equal(snapshots.succeed(4663, [quote()], currentLease), true);
  } finally {
    budget.close();
  }
});

test("expired refresh leases cannot overwrite a newer snapshot", () => {
  let now = 1;
  const budget = new Budget(":memory:", () => now);
  const snapshots = new CatalogSnapshots(budget.db, () => now);
  try {
    const oldLease = snapshots.begin(4663);
    now += 10 * 60 * 1000 + 1;
    const currentLease = snapshots.begin(4663);
    assert.equal(currentLease, 2);
    assert.equal(snapshots.succeed(4663, [quote(4663, "2", "NEW")], currentLease), true);
    assert.equal(snapshots.succeed(4663, [quote(4663, "1", "OLD")], oldLease), false);
    assert.equal(snapshots.catalog(4663).pads.o1.pairs[0].symbol, "NEW");
  } finally {
    budget.close();
  }
});

test("corrupt and cross-chain cache records fail closed", () => {
  const budget = new Budget(":memory:", () => 1);
  const snapshots = new CatalogSnapshots(budget.db, () => 1);
  try {
    budget.db
      .prepare("INSERT INTO settings(name,value) VALUES(?,?)")
      .run("catalog-snapshot:4663", JSON.stringify({ version: 1, chainId: 8453 }));
    assert.throws(() => snapshots.catalog(4663), { code: "catalog_cache_unavailable" });
    assert.throws(() => snapshots.catalog(1), { code: "invalid_catalog" });
  } finally {
    budget.close();
  }
});
