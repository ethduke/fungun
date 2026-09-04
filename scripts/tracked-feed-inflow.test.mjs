import assert from "node:assert/strict";
import test from "node:test";
import {
  gmgnTokenUrl,
  inflowPriceChange,
  TrackedInflowQueue,
} from "../apps/web/lib/tracked-feed-inflow.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const row = (n, overrides = {}) => ({
  meme: address(n),
  pool: address(n + 100),
  sym: `T${n}`,
  quote_kind: "eth",
  total_in: 11,
  ...overrides,
});
const tickers = (items) => items.map(({ ticker }) => ticker);
const priceRow = (n, overrides = {}) =>
  row(n, { pool: `0x${n.toString(16).padStart(64, "0")}`, version: "v4", ...overrides });

test("inflow admission requires strictly over 10 ETH, a ticker and a Robinhood chart", () => {
  const queue = new TrackedInflowQueue();
  const invalid = [10, 0, -1, "", " ", null, true, {}, NaN, Infinity, "Infinity"];
  const items = queue.update([
    ...invalid.map((total_in, i) => row(i + 100, { total_in })),
    row(1, { total_in: "10.001" }),
    row(2, { quote_kind: "shares", quote_symbol: "STOCK" }),
    row(3, { sym: " " }),
    row(4, { sym: undefined, quote_symbol: "NOT_THE_TICKER" }),
    row(5, { chain_id: 1 }),
    row(6, { meme: "invalid-address" }),
    row(7, { quote_kind: "other" }),
    null,
  ]);
  assert.deepEqual(tickers(items), ["T1", "T2"]);
  assert.equal(items[0].flow, 10.001);
  assert.equal(items[0].href, `https://gmgn.ai/robinhood/token/${address(1)}`);
  assert.equal(
    gmgnTokenUrl(row(10, { meme: address(10).toUpperCase() })),
    `https://gmgn.ai/robinhood/token/${address(10)}`,
  );
  assert.equal(gmgnTokenUrl(row(1, { meme: address(1) + "?redirect=other" })), null);
  assert.equal(gmgnTokenUrl(row(1, { chain_id: 8453 })), null);
});

test("distinct contracts share tickers; multiple pools never multiply inflow or admission", () => {
  const queue = new TrackedInflowQueue();
  const items = queue.update([
    row(10, { sym: "SAME", total_in: 12 }),
    row(10, { meme: address(10).toUpperCase(), pool: address(300), sym: "SAME", total_in: 20 }),
    row(11, { sym: "SAME", total_in: 15 }),
    row(12, { total_in: 6 }),
    row(12, { pool: address(301), total_in: 6 }),
    row(13, { meme: undefined, token: address(13) }),
  ]);
  assert.deepEqual(tickers(items), ["SAME", "SAME", "T13"]);
  assert.equal(items[0].flow, 20);
  assert.notEqual(items[0].href, items[1].href);
});

test("FIFO caps at ten and does not churn after repeated or reordered snapshots", () => {
  const queue = new TrackedInflowQueue();
  const rows = Array.from({ length: 12 }, (_, i) => row(i + 1));
  const expected = Array.from({ length: 10 }, (_, i) => `T${i + 3}`);
  assert.deepEqual(tickers(queue.update(rows)), expected);
  assert.deepEqual(tickers(queue.update(rows)), expected);
  assert.deepEqual(tickers(queue.update([...rows].reverse())), expected);
  assert.deepEqual(tickers(queue.update([...rows, row(13)])), [...expected.slice(1), "T13"]);
  assert.deepEqual(tickers(queue.update(rows)), [...expected.slice(1), "T13"]);
});

test("qualifiers join when observed; missing snapshots and metadata updates preserve FIFO", () => {
  const queue = new TrackedInflowQueue();
  assert.deepEqual(tickers(queue.update([row(1, { total_in: 10 }), row(2)])), ["T2"]);
  assert.deepEqual(tickers(queue.update([row(1), row(2)])), ["T2", "T1"]);
  assert.deepEqual(tickers(queue.update([])), ["T2", "T1"]);
  assert.deepEqual(tickers(queue.update([row(2, { sym: "RENAMED", total_in: 25 })])), [
    "RENAMED",
    "T1",
  ]);
  assert.equal(queue.items[0].flow, 25);
  assert.deepEqual(tickers(queue.update([row(2, { total_in: 9 })])), ["RENAMED", "T1"]);
  assert.deepEqual(new TrackedInflowQueue().update([]), []);
});

test("price returns use a fixed entry baseline and wait two minutes between observations", () => {
  let now = 0;
  const queue = new TrackedInflowQueue({ now: () => now, wallNow: () => 1000 });
  queue.update([priceRow(1)]);
  const first = queue.takePriceRequests();
  const price = (value, observedAt) => ({
    ...first[0],
    value,
    observedAt,
    quote: address(500),
    source: address(600),
  });
  assert.equal(first.length, 1);
  assert.deepEqual(queue.takePriceRequests(), []);
  queue.applyPrices(first, [price(200, 1000)]);
  assert.equal(queue.items[0].entryPrice, 200);
  assert.equal(queue.items[0].priceChange, null, "entry shows ticker only");
  now = 119999;
  assert.deepEqual(queue.takePriceRequests(), []);
  now = 120000;
  queue.applyPrices(queue.takePriceRequests(), [price(220, 121000)]);
  assert.equal(queue.items[0].priceChange, 10);
  now = 240000;
  queue.applyPrices(queue.takePriceRequests(), [price(180, 241000)]);
  assert.equal(queue.items[0].priceChange, -10, "still compares with 200, not 220");
  assert.equal(queue.items[0].entryPrice, 200);
});

test("price gaps, cached observations and quote changes cannot reset the entry baseline", () => {
  let now = 0;
  const queue = new TrackedInflowQueue({ now: () => now, wallNow: () => 1000 });
  queue.update([priceRow(1)]);
  const first = queue.takePriceRequests();
  const sample = {
    ...first[0],
    value: 100,
    observedAt: 1000,
    quote: address(500),
    source: address(600),
  };
  queue.applyPrices(first, [sample]);
  for (const prices of [
    [],
    [sample],
    [{ ...sample, observedAt: 500 }],
    [{ ...sample, value: 0, observedAt: 999999 }],
    [{ ...sample, quote: address(501), observedAt: 999999 }],
  ]) {
    now += 120000;
    queue.applyPrices(queue.takePriceRequests(), prices);
    assert.equal(queue.items[0].priceStale, true);
    assert.equal(queue.items[0].entryPrice, 100);
    assert.equal(queue.items[0].priceChange, null);
    assert.deepEqual(queue.takePriceRequests(), [], "failures retain the two-minute deadline");
  }
  queue.update([row(1, { pool: address(999), total_in: 30 })]);
  assert.equal(queue.items[0].pool, first[0].pool, "price source stays pinned to entry pool");
  now += 120000;
  queue.applyPrices(queue.takePriceRequests(), [{ ...sample, value: 125, observedAt: 999999 }]);
  assert.equal(queue.items[0].priceChange, 25);
  assert.equal(queue.items[0].priceStale, false);
});

test("invalid prices cannot create misleading zero or infinite returns", () => {
  for (const value of [undefined, null, 0, -1, NaN, Infinity, "10"])
    assert.equal(inflowPriceChange(value, 10), null);
  for (const value of [undefined, null, 0, -1, NaN, Infinity, "10"])
    assert.equal(inflowPriceChange(10, value), null);
  assert.equal(inflowPriceChange(10, 10), 0);
  assert.equal(inflowPriceChange(100, 50), -50);
  assert.equal(inflowPriceChange(Number.MIN_VALUE, Number.MAX_VALUE), null);
});

test("a quote cached before admission cannot become the entry baseline", () => {
  let now = 0;
  const queue = new TrackedInflowQueue({ now: () => now, wallNow: () => 5000 });
  queue.update([priceRow(1)]);
  const first = queue.takePriceRequests();
  const sample = {
    ...first[0],
    value: 100,
    observedAt: 4000,
    quote: address(500),
    source: address(600),
  };
  queue.applyPrices(first, [sample]);
  assert.equal(queue.items[0].entryPrice, null);
  now = 120000;
  queue.applyPrices(queue.takePriceRequests(), [{ ...sample, observedAt: 125000 }]);
  assert.equal(queue.items[0].entryPrice, 100);
  assert.equal(queue.items[0].priceChange, null);
  now += 120000;
  queue.applyPrices(queue.takePriceRequests(), [
    { ...sample, value: 200, observedAt: 245000, source: address(601) },
  ]);
  assert.equal(queue.items[0].priceChange, null, "manager changes cannot mix baselines");
});

test("server-relative admission freshness tolerates a skewed browser clock", () => {
  let now = 0;
  const queue = new TrackedInflowQueue({ now: () => now, wallNow: () => 1000000000 });
  queue.update([priceRow(1)]);
  const requests = queue.takePriceRequests();
  now = 100;
  queue.applyPrices(
    requests,
    [{ ...requests[0], value: 10, observedAt: 1000, quote: address(500), source: address(600) }],
    1100,
  );
  assert.equal(queue.items[0].entryPrice, 10);
});
