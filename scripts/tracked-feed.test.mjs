import assert from "node:assert/strict";
import test from "node:test";
import { binCells, popularTokens } from "../apps/web/components/tracked-market-feed.mjs";
import { handleTrackedFeed, projectTrackedPayload } from "../apps/web/lib/tracked-feed-handler.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const row = (n, overrides = {}) => ({
  pool: address(n + 100),
  meme: address(n),
  name: "Moon Club",
  quote_kind: "eth",
  total_in: 1,
  ...overrides,
});

test("projection preserves cohort ordering and preconverted share values, dropping extra fields", () => {
  const pools = [
    row(1, {
      quote_kind: "shares",
      quote_symbol: "AMC",
      safety: { private: true },
      trail: {
        base: 8,
        bin: 10,
        ladder: [0, 1.5, null, ...Array(12).fill(2)],
        txs: [0, 3],
        extra: "omit",
      },
    }),
    null,
    row(2, { quote_kind: "other" }),
    row(3),
    row(4, { quote_kind: "shares" }),
  ];
  const result = projectTrackedPayload({ pools, extra: "omit" });
  assert.deepEqual(
    result.pools.map((item) => item.pool),
    [address(101), address(103), address(104)],
  );
  assert.equal(result.pools[0].quote_symbol, "AMC");
  assert.equal(result.pools[0].trail.ladder[1], 1.5);
  assert.equal(result.pools[0].trail.ladder.length, 11);
  assert.equal(result.pools[0].trail.base, 8);
  assert.equal(result.pools[1].trail, null);
  assert.equal("chain_id" in result.pools[0], false);
  assert.equal(JSON.stringify(result).includes("omit"), false);
  assert.equal("safety" in result.pools[0], false);
  assert.equal(Number.isFinite(Date.parse(result.fetched_at)), true);
  for (const payload of [null, {}, { pools: null }])
    assert.throws(() => projectTrackedPayload(payload));
});

test("popularity counts distinct contracts per chain, not pools or high-volume singletons", () => {
  const rows = [
    row(10, { name: "Móon-Club", total_in: 3 }),
    row(10, { meme: address(10).toUpperCase(), pool: address(900), total_in: 5 }),
    row(10, { chain_id: 4663, pool: address(901), total_in: 4 }),
    row(10, { chain_id: 8453, total_in: 2 }),
    row(11, { name: "Moon Clubs", total_in: 1 }),
    row(12, { name: "Sunshine", total_in: 100 }),
    row(13, { name: "Sunshine", total_in: 100 }),
    row(14, { name: "Whale", total_in: 10000 }),
  ];
  const groups = popularTokens(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map(({ count, flow }) => ({ count, flow })),
    [
      { count: 3, flow: 8 },
      { count: 2, flow: 200 },
    ],
  );
  assert.equal(groups[0].name, "Moon Club");
  assert.equal(popularTokens(rows, 1).length, 1);
  assert.deepEqual(popularTokens([row(1)]), []);
  assert.deepEqual(popularTokens([]), []);
});

test("popularity ranks equal-count groups by inflow and limits the list to three", () => {
  const groups = ["Alpha", "Bravo", "Charlie", "Delta"].flatMap((name, i) => [
    row(i * 2 + 1, { name, total_in: i }),
    row(i * 2 + 2, { name, total_in: i }),
  ]);
  assert.deepEqual(
    popularTokens(groups).map((item) => item.name),
    ["Delta", "Charlie", "Bravo"],
  );
});

test("eleven chronological cells distinguish observed zero, missing and future values", () => {
  const cells = binCells({
    base: 20,
    bin: 23,
    ladder: [0, null, "2.5", undefined, 99],
    txs: [0, 1],
  });
  assert.equal(cells.length, 11);
  assert.deepEqual(cells[0], { index: 20, pending: false, current: false, value: 0, buys: 0 });
  assert.equal(cells[1].value, null);
  assert.equal(cells[2].value, 2.5);
  assert.equal(cells[3].value, null);
  assert.equal(cells[3].current, true);
  assert.equal(cells[4].pending, true);
  assert.equal(cells[4].value, 99);
  assert.equal(cells[10].index, 30);
  assert.equal(binCells({ bin: 0, ladder: [0] })[0].current, true);
  for (const trail of [
    null,
    {},
    { bin: 0, ladder: [] },
    { bin: -1, ladder: [0] },
    { ladder: [0] },
  ]) {
    assert.deepEqual(binCells(trail), []);
  }
  for (const value of ["", " ", false, {}, -1, Infinity]) {
    assert.equal(binCells({ bin: 0, ladder: [value] })[0].value, null);
  }
});

test("handler uses only the fixed public source and never forwards browser credentials", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://rh-monitor.fly.dev/api");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    assert.equal(options.signal instanceof AbortSignal, true);
    return Response.json({ pools: [row(1)] });
  });
  const response = await handleTrackedFeed(
    new Request("https://app.example.invalid/api/tracked-feed", {
      headers: { cookie: "session=EXAMPLE", authorization: "EXAMPLE" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).pools.length, 1);
  const rejected = await handleTrackedFeed(
    new Request("https://app.example.invalid/api/tracked-feed", { method: "POST" }),
  );
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET");
  assert.equal(fetch.mock.callCount(), 1);
});

test("handler returns a generic retryable failure, then recovers on a valid response", async (t) => {
  let next;
  t.mock.method(globalThis, "fetch", async () => {
    if (next instanceof Error) throw next;
    return next;
  });
  for (next of [
    new Error("private upstream detail"),
    new Response("bad", { status: 503 }),
    Response.json({ wrong: [] }),
  ]) {
    const response = await handleTrackedFeed(
      new Request("https://app.example.invalid/api/tracked-feed"),
    );
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Feed temporarily unavailable" });
  }
  next = Response.json({ pools: [] });
  const response = await handleTrackedFeed(
    new Request("https://app.example.invalid/api/tracked-feed"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).pools, []);
});

test("handler bounds stalled requests and propagates cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(
    globalThis,
    "fetch",
    (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  const pending = handleTrackedFeed(new Request("https://app.example.invalid/api/tracked-feed"));
  t.mock.timers.tick(8000);
  assert.equal((await pending).status, 502);
  const controller = new AbortController();
  const cancelled = handleTrackedFeed(
    new Request("https://app.example.invalid/api/tracked-feed", { signal: controller.signal }),
  );
  controller.abort();
  assert.equal((await cancelled).status, 502);
});
