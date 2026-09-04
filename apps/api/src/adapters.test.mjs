import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "viem";
import { Adapters, parseQuotes } from "./adapters.mjs";
import { readConfig } from "./config.mjs";
import { ReadCache, Upstream, readJson } from "./upstream.mjs";
import { validateInput } from "./service.mjs";

const address = (digit) => `0x${digit.repeat(40)}`;
const bytecode = "0x60016000";
const config = () => ({
  readsEnabled: true,
  o1Key: "EXAMPLE",
  rpcUrl: "EXAMPLE",
  registry: address("1"),
  codeHash: keccak256(bytecode),
  longQuotes: new Set([address("2")]),
});
const quote = (overrides = {}) => ({
  address: address("2"),
  symbol: "MOON",
  decimals: 18,
  route: "rwa",
  registered: true,
  selectable: true,
  ...overrides,
});
const body = (quotes) => ({ data: { quotes } });

test("backend accepts ROBINHOOD_RPC and retains the legacy variable fallback", () => {
  const endpoint = new URL('/primary', 'https://rpc.example.invalid').href;
  const legacy = new URL('/legacy', 'https://rpc.example.invalid').href;
  assert.equal(readConfig({ ROBINHOOD_RPC: endpoint }).rpcUrl, endpoint);
  assert.equal(readConfig({ ROBINHOOD_RPC_URL: legacy }).rpcUrl, legacy);
  assert.equal(readConfig({ ROBINHOOD_RPC: endpoint, ROBINHOOD_RPC_URL: legacy }).rpcUrl, endpoint);
});

test("malformed entries and ambiguous symbols fail closed before eligibility filtering", () => {
  for (const quotes of [
    [{}],
    [null],
    [quote({ registered: "true" })],
    [quote({ selectable: null })],
    [quote(), quote({ address: address("3"), symbol: "moon" })],
  ])
    assert.throws(() => parseQuotes(body(quotes), 4663));
  assert.deepEqual(parseQuotes(body([quote({ selectable: false })]), 4663), []);
});

test("registry verification is repeated at each newly observed block", async () => {
  let now = 0;
  let changed = false;
  const adapter = new Adapters(
    config(),
    {
      async json(provider, url, options) {
        const call = JSON.parse(options.body);
        const result =
          call.method === "eth_chainId"
            ? `0x${(4663).toString(16)}`
            : call.method === "eth_blockNumber"
              ? changed
                ? "0x124"
                : "0x123"
              : call.method === "eth_getCode"
                ? changed
                  ? "0x6000"
                  : bytecode
                : `0x${"0".repeat(63)}1`;
        return { jsonrpc: "2.0", id: 1, result };
      },
    },
    () => now,
  );
  assert.equal((await adapter.ticker(4663, "MOON", ["long"])).results.long.status, "unreserved");
  now = 6000;
  changed = true;
  assert.equal((await adapter.ticker(4663, "SUN", ["long"])).results.long.status, "unverified");
});

test("catalog validates eligibility, deduplicates addresses and hides runtime addresses", async () => {
  let calls = 0;
  const adapter = new Adapters(config(), {
    async json(provider, url, options) {
      calls++;
      assert.equal(provider, "o1");
      assert.equal(url.origin, "https://api.launch.o1.exchange");
      assert.equal(url.pathname, "/v1/config");
      assert.equal(url.searchParams.get("chain_id"), "4663");
      assert.equal(options.headers["x-api-key"], "EXAMPLE");
      return body([
        quote(),
        quote(),
        quote({ address: address("3"), symbol: "SUN" }),
        quote({ address: address("4"), selectable: false }),
      ]);
    },
  });
  const values = await Promise.all(Array.from({ length: 100 }, () => adapter.catalog(4663)));
  assert.equal(calls, 1);
  assert.equal(values[0].pads.o1.pairs.length, 2);
  assert.equal(values[0].pads.long.pairs.length, 1);
  assert.ok(!JSON.stringify(values).includes(address("2")));
  assert.ok(!JSON.stringify(values).includes("EXAMPLE"));
});

test("malformed catalogs cannot become an empty ready catalog", () => {
  for (const value of [
    {},
    { data: {} },
    body(null),
    body([quote({ decimals: -1 })]),
    body([quote(), quote({ symbol: "OTHER" })]),
  ])
    assert.throws(() => parseQuotes(value, 4663));
  assert.deepEqual(parseQuotes(body([]), 4663), []);
});

test("missing configuration never makes upstream calls or invents O1 availability", async () => {
  const adapter = new Adapters(
    { ...config(), readsEnabled: false },
    {
      json() {
        assert.fail("No upstream calls");
      },
    },
  );
  assert.equal((await adapter.catalog(4663)).pads.o1.status, "unavailable");
  const check = await adapter.ticker(4663, "MOON", ["long", "o1"]);
  assert.equal(check.results.long.status, "unverified");
  assert.equal(check.results.o1.status, "unverified");
});

test("Long checks the chain and pinned bytecode, then coalesces one fixed read call", async () => {
  const methods = [];
  const adapter = new Adapters(config(), {
    async json(provider, url, options) {
      const call = JSON.parse(options.body);
      methods.push(call.method);
      if (call.method === "eth_call") {
        assert.equal(call.params[0].to, config().registry);
        assert.equal(call.params[1], "0x123");
        assert.deepEqual(Object.keys(call.params[0]), ["to", "data", "gas"]);
      }
      if (call.method === "eth_getCode") assert.equal(call.params[1], "0x123");
      const result =
        call.method === "eth_chainId"
          ? `0x${(4663).toString(16)}`
          : call.method === "eth_blockNumber"
            ? "0x123"
            : call.method === "eth_getCode"
              ? bytecode
              : `0x${"0".repeat(63)}1`;
      return { jsonrpc: "2.0", id: 1, result };
    },
  });
  const results = await Promise.all(
    Array.from({ length: 100 }, () => adapter.ticker(4663, "MOON", ["long"])),
  );
  assert.equal(results[0].results.long.status, "unreserved");
  assert.deepEqual(methods.sort(), ["eth_blockNumber", "eth_call", "eth_chainId", "eth_getCode"]);
});

test("wrong chain, code hash, malformed bool and upstream failure never produce available", async () => {
  for (const mode of ["chain", "code", "bool", "error"]) {
    const adapter = new Adapters(config(), {
      async json(provider, url, options) {
        const call = JSON.parse(options.body);
        if (mode === "error") throw new Error("upstream sensitive details");
        const result =
          call.method === "eth_chainId"
            ? `0x${(mode === "chain" ? 1 : 4663).toString(16)}`
            : call.method === "eth_blockNumber"
              ? "0x123"
              : call.method === "eth_getCode"
                ? mode === "code"
                  ? "0x6000"
                  : bytecode
                : `0x${"0".repeat(63)}2`;
        return { jsonrpc: "2.0", id: 1, result };
      },
    });
    const result = await adapter.ticker(4663, "MOON", ["long"]);
    assert.equal(result.results.long.status, "unverified");
    assert.ok(!JSON.stringify(result).includes("sensitive"));
  }
});

test("cache bounds keys, coalesces reads and backs off failures without stale successes", async () => {
  let now = 0;
  const cache = new ReadCache(() => now, 2);
  let calls = 0;
  const load = async () => {
    calls++;
    throw new Error("private upstream details");
  };
  await assert.rejects(cache.get("a", 10, load), { message: "unavailable" });
  await assert.rejects(cache.get("a", 10, load));
  assert.equal(calls, 1);
  now = 15_001;
  assert.equal(await cache.get("a", 10, async () => "ready"), "ready");
  now += 11;
  await assert.rejects(cache.get("a", 10, load));
  await cache.get("b", 10, async () => 2);
  await cache.get("c", 10, async () => 3);
  assert.equal(cache.entries.size, 2);
});

test("upstream reserves budget before fetch, disables redirects/retries and bounds concurrency", async () => {
  let calls = 0;
  let debits = 0;
  const upstream = new Upstream(
    {
      upstream() {
        debits++;
      },
    },
    async (url, options) => {
      calls++;
      assert.equal(debits, calls);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      throw new Error("synthetic timeout");
    },
  );
  await assert.rejects(upstream.json("o1", "https://example.invalid"));
  assert.equal(calls, 1);
  assert.equal(debits, 1);
  const closed = new Upstream(
    {
      upstream() {
        throw new Error("storage unavailable");
      },
    },
    () => assert.fail("budget must precede fetch"),
  );
  await assert.rejects(closed.json("o1", "https://example.invalid"));
  const waiting = new Upstream({ upstream() {} }, () => new Promise(() => {}));
  void waiting.json("o1", "https://example.invalid");
  void waiting.json("o1", "https://example.invalid");
  await assert.rejects(waiting.json("o1", "https://example.invalid"), { status: 429 });
});

test("JSON responses enforce streamed size and fail closed on wrong content type", async () => {
  await assert.rejects(
    readJson(new Response("x".repeat(20), { headers: { "content-type": "application/json" } }), 10),
  );
  await assert.rejects(
    readJson(new Response("{}", { headers: { "content-type": "text/html" } }), 10),
  );
  assert.deepEqual(await readJson(Response.json({ ok: true }), 20), { ok: true });
});

test("request grammar rejects extra fields, arbitrary chains, pad mixing and invalid tickers", () => {
  assert.deepEqual(validateInput("catalog", { chainId: 4663 }), { chainId: 4663 });
  const valid = { chainId: 4663, ticker: "MOON", pads: ["long", "o1"] };
  validateInput("ticker", valid);
  for (const change of [
    { chainId: 1 },
    { chainId: 8453 },
    { ticker: "moon" },
    { ticker: "MO ON" },
    { pads: ["o1", "o1"] },
    { url: "https://example.invalid" },
    { method: "eth_sendTransaction" },
  ])
    assert.throws(() => validateInput("ticker", { ...valid, ...change }));
  validateInput("ticker", { chainId: 8453, ticker: "moon1", pads: ["o1"] });
});

test("production fails closed without pinned machine, persistent path and HTTPS origin", () => {
  const production = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.example.invalid",
    BUDGET_DB_PATH: "/data/read-budget.sqlite",
    READS_MACHINE_ID: "approved",
    FLY_MACHINE_ID: "approved",
  };
  assert.equal(readConfig(production).readsEnabled, false);
  for (const change of [
    { FLY_MACHINE_ID: "replica" },
    { READS_MACHINE_ID: "" },
    { BUDGET_DB_PATH: ":memory:" },
    { APP_ORIGIN: "http://app.example.invalid" },
  ])
    assert.throws(() => readConfig({ ...production, ...change }));
});
