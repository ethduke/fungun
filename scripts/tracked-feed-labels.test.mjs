import assert from "node:assert/strict";
import test from "node:test";
import { feedLaunchpad, identifyO1Launchpad } from "../apps/web/lib/tracked-feed-labels.mjs";
import { createO1HookRegistry, parseO1Hooks } from "../apps/web/lib/tracked-feed-registry.mjs";
import {
  createTrackedFeedHandler,
  projectTrackedPayload,
} from "../apps/web/lib/tracked-feed-handler.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const suite = (n, creationRoutes, status = "historical") => ({
  contracts: { hook: address(n) },
  creationRoutes,
  status,
});
const registry = () => ({
  schemaVersion: 1,
  project: "o1 Launchpad",
  environment: "production",
  chains: [
    { chainId: 8453, suites: [suite(99, ["rwa"])] },
    {
      chainId: 4663,
      suites: [suite(1, ["standard"]), suite(2, ["rwa"]), suite(3, ["standard", "rwa"], "current")],
    },
  ],
});

test("recognition covers current and historical O1 hooks, respecting chain and creation routes", () => {
  const hooks = parseO1Hooks(registry());
  const row = {
    launchpad: `hook:${address(3).toUpperCase()}`,
    quote_kind: "shares",
    version: "v4",
  };
  assert.equal(identifyO1Launchpad(row, hooks), "O1 RWA");
  assert.equal(identifyO1Launchpad({ ...row, quote_kind: "eth" }, hooks), "O1");
  assert.equal(identifyO1Launchpad({ ...row, launchpad: `hook:${address(1)}` }, hooks), "O1");
  assert.equal(
    identifyO1Launchpad({ ...row, launchpad: `hook:${address(2)}`, quote_kind: "eth" }, hooks),
    "O1 RWA",
  );
  assert.equal(identifyO1Launchpad({ ...row, chain_id: 8453 }, hooks), row.launchpad);
  assert.equal(
    identifyO1Launchpad({ ...row, launchpad: `hook:${address(99)}` }, hooks),
    `hook:${address(99)}`,
  );
  assert.equal(
    identifyO1Launchpad({ ...row, launchpad: undefined, meme: address(3) }, hooks),
    undefined,
  );
  assert.equal(identifyO1Launchpad(row, null), row.launchpad);
});

test("pool versions shorten to UniV3/UniV4 without inventing O1 migration or overwriting named venues", () => {
  for (const version of ["v3", "V3", 3]) assert.equal(feedLaunchpad({ version }).label, "UniV3");
  for (const version of ["v4", "V4", 4]) assert.equal(feedLaunchpad({ version }).label, "UniV4");
  assert.equal(feedLaunchpad({ launchpad: "Uniswap", version: "v3" }).label, "UniV3");
  assert.equal(feedLaunchpad({ launchpad: "Uniswap V4" }).label, "UniV4");
  assert.equal(feedLaunchpad({ launchpad: "UniV3" }).label, "UniV3");
  assert.equal(feedLaunchpad({ launchpad: "Uniswap" }).label, "Uniswap");
  assert.equal(feedLaunchpad({ launchpad: "O1 migrated", version: "v3" }).label, "O1 Mig.");
  assert.equal(feedLaunchpad({ launchpad: "O1", version: "v4" }).label, "O1");
  assert.equal(feedLaunchpad({ launchpad: "O1 RWA" }).label, "O1 RWA");
  assert.equal(feedLaunchpad({ launchpad: "Long Launchpad", version: "v4" }).isLong, true);
  assert.equal(feedLaunchpad({ launchpad: "Pons v2", version: "v4" }).label, "Pons v2");
  const unknown = feedLaunchpad({ launchpad: `hook:${address(4)}`, version: "v4" });
  assert.equal(unknown.label, "UniV4");
  assert.match(unknown.title, /Unidentified hook/);
  assert.equal(feedLaunchpad({ name: "O1 migrated", sym: "O1", version: "v4" }).label, "UniV4");
  assert.equal(feedLaunchpad({}).label, "Unknown");
});

test("projection adds O1 attribution without adding historical rows or changing token identity", () => {
  const pool = {
    meme: address(10),
    pool: address(20),
    name: "Test token",
    sym: "TEST",
    quote_kind: "shares",
    version: "v4",
    launchpad: `hook:${address(3)}`,
  };
  const projected = projectTrackedPayload(
    { pools: [pool], stock_shadows: [pool, pool] },
    parseO1Hooks(registry()),
  );
  assert.equal(projected.pools.length, 1);
  assert.equal(projected.pools[0].launchpad, "O1 RWA");
  assert.equal(projected.pools[0].meme, pool.meme);
  assert.equal(projected.pools[0].sym, "TEST");
  assert.equal(pool.launchpad, `hook:${address(3)}`, "does not mutate upstream");
});

test("registry rejects unsupported schema and malformed hooks instead of partially trusting them", () => {
  for (const change of [
    { schemaVersion: 2 },
    { project: "Other" },
    { environment: "test" },
    { chains: [] },
    { chains: [{ chainId: 4663, suites: [suite(0, ["standard"])] }] },
    { chains: [{ chainId: 4663, suites: [suite(1, ["future"])] }] },
  ])
    assert.throws(() => parseO1Hooks({ ...registry(), ...change }));
});

test("100 callers share a daily public registry read; failures preserve historical labels and back off", async () => {
  let time = 0,
    calls = 0,
    fail = false;
  const getHooks = createO1HookRegistry({
    now: () => time,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://docs.o1.exchange/launchpad/reference/launch-contract-suites.json");
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      return fail ? new Response(null, { status: 503 }) : Response.json(registry());
    },
  });
  const results = await Promise.all(Array.from({ length: 100 }, () => getHooks()));
  assert.equal(calls, 1);
  assert.equal(results[0].size, 3);
  time = 86_399_999;
  assert.equal(await getHooks(), results[0]);
  assert.equal(calls, 1);
  time++;
  fail = true;
  assert.equal(await getHooks(), results[0]);
  assert.equal(calls, 2);
  time += 299_999;
  assert.equal(await getHooks(), results[0]);
  assert.equal(calls, 2);
  time++;
  fail = false;
  assert.equal((await getHooks()).size, 3);
  assert.equal(calls, 3);
});

test("oversized, malformed and redirected registry responses never become trusted labels", async () => {
  for (const response of [
    new Response("x".repeat(65_537), { headers: { "Content-Type": "application/json" } }),
    Response.json({ wrong: true }),
    new Response(null, { status: 302 }),
  ]) {
    let calls = 0;
    const getHooks = createO1HookRegistry({
      now: () => 0,
      fetcher: async () => {
        calls++;
        return response;
      },
    });
    assert.equal(await getHooks(), null);
    assert.equal(await getHooks(), null);
    assert.equal(calls, 1);
  }
});

test("stalled registry reads time out within two seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const getHooks = createO1HookRegistry({
    fetcher: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const pending = getHooks();
  t.mock.timers.tick(2000);
  assert.equal(await pending, null);
});

test("registry failure cannot break the feed; known hooks are populated on success", async () => {
  for (const fail of [false, true]) {
    const handle = createTrackedFeedHandler({
      fetcher: async () =>
        Response.json({ pools: [{ quote_kind: "shares", launchpad: `hook:${address(3)}` }] }),
      loadHookRegistry: async () => {
        if (fail) throw new Error("unavailable");
        return parseO1Hooks(registry());
      },
    });
    const response = await handle(new Request("https://app.example.invalid/api/tracked-feed"));
    assert.equal(response.status, 200);
    assert.equal(
      (await response.json()).pools[0].launchpad,
      fail ? `hook:${address(3)}` : "O1 RWA",
    );
  }
});
