import assert from "node:assert/strict";
import test from "node:test";
import {
  binCells,
  priceServiceStatus,
  popularTokens,
  trackedTokenDraft,
  validatedPriceResponse,
} from "../apps/web/components/tracked-market-feed.mjs";
import {
  createTrackedFeedHandler,
  projectTrackedPayload,
} from "../apps/web/lib/tracked-feed-handler.mjs";

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
    row(5, { chain_id: 8453 }),
    row(6, { chain_id: 1, quote_kind: "shares" }),
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

test("COPY uses the token ticker, never its quote symbol or contract address", () => {
  assert.deepEqual(
    trackedTokenDraft(
      row(1, {
        name: "Moon Club",
        sym: "MOON",
        quote_symbol: "NVDA",
        quote_kind: "shares",
      }),
    ),
    { name: "Moon Club", ticker: "MOON" },
  );
  assert.deepEqual(trackedTokenDraft({ sym: "TOKEN" }), { name: "TOKEN", ticker: "TOKEN" });
  assert.deepEqual(trackedTokenDraft({ name: "Only a name" }), { name: "Only a name", ticker: "" });
  assert.deepEqual(trackedTokenDraft({}), { name: "", ticker: "" });
});

test("price service status distinguishes waiting, active and unavailable reads", () => {
  assert.deepEqual(priceServiceStatus("waiting"), {
    text: "",
    error: false,
  });
  assert.deepEqual(priceServiceStatus("checking"), {
    text: "Checking prices…",
    error: false,
  });
  assert.deepEqual(priceServiceStatus("online"), {
    text: "Prices online",
    error: false,
  });
  assert.deepEqual(priceServiceStatus("no-quotes"), {
    text: "Price service online · no verified quotes",
    error: false,
  });
  assert.deepEqual(priceServiceStatus("unavailable"), {
    text: "Prices unavailable · retrying",
    error: true,
  });
});

test("price responses distinguish verified samples, valid empties and malformed success", () => {
  const request = {
    pool: `0x${"a".repeat(64)}`,
    token: address(1),
    version: "v4",
  };
  assert.deepEqual(validatedPriceResponse({ prices: [], serverTime: 200 }, [request]), {
    prices: [],
    serverTime: 200,
    state: "no-quotes",
  });
  const sample = {
    pool: request.pool,
    token: request.token,
    value: 1.25,
    quote: address(2),
    observedAt: 100,
    source: address(3),
  };
  assert.deepEqual(validatedPriceResponse({ prices: [sample], serverTime: 200 }, [request]), {
    prices: [sample],
    serverTime: 200,
    state: "online",
  });
  for (const body of [
    { prices: [], serverTime: null },
    { prices: [{ ...sample, pool: `0x${"b".repeat(64)}` }], serverTime: 200 },
    { prices: [{ ...sample, value: 0 }], serverTime: 200 },
    { prices: [{ ...sample, observedAt: 201 }], serverTime: 200 },
    { prices: [sample, sample], serverTime: 200 },
  ])
    assert.equal(validatedPriceResponse(body, [request]), null);
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

const request = (options) => new Request("https://app.example.invalid/api/tracked-feed", options);
const deferred = () => Promise.withResolvers();

test("handler uses only the fixed public source and never forwards browser credentials", async () => {
  let calls = 0;
  const handle = createTrackedFeedHandler({
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://rh-monitor.fly.dev/api");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      assert.equal(options.signal instanceof AbortSignal, true);
      return Response.json({ pools: [row(1)] });
    },
  });
  const response = await handle(
    request({ headers: { cookie: "session=EXAMPLE", authorization: "EXAMPLE" } }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).pools.length, 1);
  const rejected = await handle(request({ method: "POST" }));
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET");
  assert.equal(calls, 1);
});

test("100 viewers share one upstream refresh and cache, including at expiry", async () => {
  let time = 0,
    calls = 0,
    source = deferred();
  const handle = createTrackedFeedHandler({
    now: () => time,
    fetcher: () => {
      calls++;
      return source.promise;
    },
  });
  assert.equal(calls, 0, "no background refresh");
  const pending = Array.from({ length: 100 }, () => handle(request()));
  assert.equal(calls, 1);
  time = 2000; // Cache lifetime starts after a slow source finishes.
  source.resolve(Response.json({ pools: [row(1)] }));
  const bodies = await Promise.all((await Promise.all(pending)).map((response) => response.text()));
  assert.equal(new Set(bodies).size, 1, "each caller can consume its own body");
  time = 5999;
  const cached = await handle(request());
  assert.equal(await cached.text(), bodies[0], "cache retains the original receipt timestamp");
  assert.equal(calls, 1);
  time = 6000;
  source = deferred();
  const refreshes = Array.from({ length: 100 }, () => handle(request()));
  assert.equal(calls, 2);
  source.resolve(Response.json({ pools: [] }));
  for (const response of await Promise.all(refreshes))
    assert.deepEqual((await response.json()).pools, []);
  time = 1_000_000;
  assert.equal(calls, 2, "expiry alone does not fetch");
});

test("failure cooldown prevents request storms, uses generic errors, and resets on recovery", async () => {
  let time = 0,
    calls = 0,
    next = new Error("private upstream detail");
  const handle = createTrackedFeedHandler({
    now: () => time,
    fetcher: async () => {
      calls++;
      if (next instanceof Error) throw next;
      return next;
    },
  });
  for (const [index, delay] of [4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    if (index === 1) next = new Response("bad", { status: 503 });
    if (index === 2)
      next = new Response(null, {
        status: 302,
        headers: { location: "https://other.example.invalid" },
      });
    if (index > 2) next = Response.json({ wrong: [] });
    const response = await handle(request());
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Feed temporarily unavailable" });
    assert.equal(response.headers.get("retry-after"), String(delay / 1000));
    const callsBefore = calls;
    time += delay - 1;
    await Promise.all(Array.from({ length: 100 }, () => handle(request())));
    assert.equal(calls, callsBefore, "cooldown blocks all viewers");
    time++;
  }
  next = Response.json({ pools: [] });
  assert.equal((await handle(request())).status, 200);
  time += 4000;
  next = new Error("failure after recovery");
  assert.equal((await handle(request())).headers.get("retry-after"), "4");
});

test("upstream Retry-After is shared across viewers", async () => {
  let time = 0,
    calls = 0;
  const handle = createTrackedFeedHandler({
    now: () => time,
    fetcher: async () => {
      calls++;
      return new Response(null, { status: 429, headers: { "Retry-After": "120" } });
    },
  });
  assert.equal((await handle(request())).headers.get("retry-after"), "120");
  time = 119_000;
  assert.equal((await handle(request())).headers.get("retry-after"), "1");
  assert.equal(calls, 1);
  time = 120_000;
  await handle(request());
  assert.equal(calls, 2);
});

test("one viewer leaving cannot abort a shared refresh or cause cancel/retry churn", async () => {
  const source = deferred();
  let calls = 0,
    upstreamSignal;
  const handle = createTrackedFeedHandler({
    fetcher: (_url, { signal }) => {
      calls++;
      upstreamSignal = signal;
      return source.promise;
    },
  });
  const controller = new AbortController();
  const first = handle(request({ signal: controller.signal }));
  const second = handle(request());
  controller.abort();
  assert.equal(upstreamSignal.aborted, false);
  source.resolve(Response.json({ pools: [row(1)] }));
  assert.equal((await first).status, 499);
  assert.equal((await second).status, 200);
  assert.equal((await handle(request())).status, 200);
  assert.equal(calls, 1);
  assert.equal((await handle(request({ signal: controller.signal }))).status, 499);
  assert.equal(calls, 1);
});

test("already aborted viewers cannot start an upstream request", async () => {
  const handle = createTrackedFeedHandler({ fetcher: () => assert.fail("unexpected fetch") });
  assert.equal((await handle(request({ signal: AbortSignal.abort() }))).status, 499);
  assert.equal((await handle(request({ method: "POST" }))).status, 405);
});

test("handler bounds stalled upstream requests and enters cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const handle = createTrackedFeedHandler({
    now: () => 0,
    fetcher: (_url, { signal }) => {
      calls++;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    },
  });
  const pending = handle(request());
  t.mock.timers.tick(8000);
  assert.equal((await pending).status, 502);
  assert.equal((await handle(request())).status, 502);
  assert.equal(calls, 1);
});
