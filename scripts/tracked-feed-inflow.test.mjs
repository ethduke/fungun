import assert from "node:assert/strict";
import test from "node:test";
import { gmgnTokenUrl, TrackedInflowQueue } from "../apps/web/lib/tracked-feed-inflow.mjs";

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
