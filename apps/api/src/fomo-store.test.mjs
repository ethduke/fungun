import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FomoStore, fomoUsers, normalizeFomoEvent, eventTime } from "./fomo-store.mjs";

const now = 1_788_600_000_000;
const token = `0x${"ab".repeat(20)}`;
const users = fomoUsers({ unipcs: "theunipcs", runn3rrr: "runn3rrr" });
const buy = (extra = {}) => ({
  type: "alert",
  id: "fixture-1",
  alertType: "buy",
  trader: "unipcs",
  token: "EXAMPLE",
  tokenAddress: token,
  chainId: 4663,
  ts: now - 1000,
  ...extra,
});
const rows = [{ token, sym: "EXAMPLE", chain_id: 4663, quote_kind: "eth" }];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "fungun-fomo-"));
  const path = join(dir, "cache.sqlite");
  let db = new DatabaseSync(path);
  let time = now;
  const build = () => new FomoStore(db, users, () => time);
  let store = build();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    advance(ms) {
      time += ms;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      store = build();
    },
  };
}

test("strict buy evidence excludes positions, thesis, unknown/wrong chains, invalid time and users", () => {
  for (const extra of [
    { alertType: "position_open" },
    { alertType: "thesis" },
    { alertType: undefined, side: "buy" },
    { type: "position" },
    { chainId: undefined },
    { chainId: 1 },
    { chain: "base" },
    { trader: "someoneelse" },
    { tokenAddress: "EXAMPLE" },
    { tokenAddress: `0x${"0".repeat(40)}` },
    { ts: NaN },
    { ts: Infinity },
    { ts: null },
    { ts: "" },
    { ts: true },
    { ts: now + 300_001 },
    { ts: "2026-09-05T12:00:00" },
    { ts: undefined, createdAt: now },
  ])
    assert.equal(normalizeFomoEvent(buy(extra), users, now), null, JSON.stringify(extra));
  assert.equal(eventTime((now - 1000) / 1000, now), now - 1000);
  assert.equal(eventTime(new Date(now - 1000).toISOString(), now), now - 1000);
  const nested = normalizeFomoEvent(
    buy({
      trader: { handle: "@UNIPCS" },
      tokenAddress: undefined,
      token: { address: token.toUpperCase().replace("0X", "0x"), symbol: "EXAMPLE" },
    }),
    users,
    now,
  );
  assert.equal(nested.handle, "unipcs");
  assert.equal(nested.token, token);
});

test("buys in both arrival orders survive replays, sells, removal, ten days and restart", (t) => {
  const f = fixture(t);
  assert.equal(f.store.ingest(buy()), true);
  assert.deepEqual(f.store.highlights(), []);
  f.store.register(rows);
  f.store.register(rows);
  f.store.ingest(buy());
  f.store.ingest(buy({ id: "fixture-2", trader: "runn3rrr" }));
  f.store.ingest(buy({ id: "fixture-3", alertType: "sell" }));
  f.store.register([]);
  assert.equal(f.store.highlights().length, 2);
  assert.equal(f.store.highlights()[1].buy_alerts, 1);
  f.advance(11 * 86_400_000);
  f.reopen();
  assert.equal(f.store.highlights().length, 2);
  assert.equal(f.store.tokenCount(), 1);
  const unipcs = f.store.highlights().find((row) => row.handle === "unipcs");
  assert.equal(unipcs.label, "theunipcs");
  assert.equal(unipcs.last_bought_at, (now - 1000) / 1000);
});

test("sell-only and unrelated contracts never highlight; token identity includes chain", (t) => {
  const f = fixture(t);
  f.store.register([
    { ...rows[0], chain_id: 1 },
    { ...rows[0], chain_id: undefined },
  ]);
  f.store.ingest(buy());
  assert.equal(f.store.tokenCount(), 0);
  assert.deepEqual(f.store.highlights(), []);
  const other = `0x${"cd".repeat(20)}`;
  f.store.register([{ ...rows[0], token: other }]);
  f.store.ingest(buy({ id: "sell-only", tokenAddress: other, alertType: "sell" }));
  assert.deepEqual(f.store.highlights(), []);
});

test("daily attempt reservations and retry deadlines survive restarts", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 12; i++) {
    assert.equal(f.store.reserveConnection().allowed, true);
    assert.equal(f.store.reserveConnection().allowed, false);
    f.advance(60_000);
    f.reopen();
  }
  assert.equal(f.store.attempts(), 12);
  assert.equal(f.store.reserveConnection().allowed, false);
  f.advance(86_400_000);
  assert.equal(f.store.reserveConnection().allowed, true);
  f.store.defer(now + 3 * 86_400_000);
  f.reopen();
  assert.equal(f.store.reserveConnection().allowed, false);
});

test("default mapping contains all nine canonical profiles and normalizes handles", () => {
  const mapping = fomoUsers(
    JSON.parse(readFileSync(new URL("./fomo-users.json", import.meta.url), "utf8")),
  );
  assert.equal(mapping.size, 9);
  assert.equal(mapping.get("runn3rrr"), "runn3rrr");
  assert.equal(mapping.get("change"), "changefomo");
  assert.equal(fomoUsers({ "@Unipcs": "theunipcs" }).get("unipcs"), "theunipcs");
  assert.throws(() => fomoUsers({}));
  assert.throws(() => fomoUsers({ "../bad": "bad" }));
});
