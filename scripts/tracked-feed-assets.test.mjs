import assert from "node:assert/strict";
import test from "node:test";
import { isTrackedStablecoin } from "../apps/web/lib/tracked-feed-assets.mjs";
import {
  createStableAssetRegistry,
  parseStableAssets,
} from "../apps/web/lib/tracked-feed-registry.mjs";
import {
  createTrackedFeedHandler,
  projectTrackedPayload,
} from "../apps/web/lib/tracked-feed-handler.mjs";
import { popularTokens } from "../apps/web/components/tracked-market-feed.mjs";

const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const assetRegistry = () => ({
  schemaVersion: 4,
  project: "o1 Launchpad",
  environment: "production",
  chains: [
    {
      chainId: 4663,
      quotes: [
        { symbol: "USDG", address: address(1) },
        { symbol: "USDC", address: address(2) },
        { symbol: "ETH", address: address(0) },
        { symbol: "AMC", address: address(3) },
      ],
    },
    { chainId: 8453, quotes: [{ symbol: "USDC", address: address(4) }] },
  ],
});
const pool = (n, extra = {}) => ({
  pool: address(n + 100),
  meme: address(n),
  name: "Moon Club",
  sym: "MOON",
  quote_kind: "shares",
  quote_symbol: "AMC",
  ...extra,
});

test("trusted registry selects stablecoins; feed matches exact chain/address, never ticker or name", () => {
  const assets = parseStableAssets(assetRegistry());
  assert.equal(assets.size, 2);
  assert.equal(isTrackedStablecoin(pool(1), assets), true);
  assert.equal(isTrackedStablecoin(pool(1, { meme: address(1).toUpperCase() }), assets), true);
  assert.equal(isTrackedStablecoin(pool(1, { chain_id: 8453 }), assets), false);
  assert.equal(isTrackedStablecoin(pool(9, { sym: "USDG", name: "Global Dollar" }), assets), false);
  assert.equal(isTrackedStablecoin({ token: address(2) }, assets), true);
  assert.equal(isTrackedStablecoin(pool(3), assets), false, "stock is not a stablecoin");
  assert.equal(isTrackedStablecoin(pool(0), assets), false, "ETH is not a stablecoin");
  assert.equal(isTrackedStablecoin({ meme: "invalid" }, assets), false);
});

test("stable tracked assets and stable/stable pools are removed before cards, counts and popularity", () => {
  const assets = parseStableAssets(assetRegistry());
  const pools = [
    pool(1, { quote_asset: address(2), quote_symbol: "USDC", name: "Dollar" }),
    pool(2, { quote_asset: address(1), quote_symbol: "USDG", name: "Dollar" }),
    pool(1, { quote_kind: "eth", quote_symbol: "ETH" }),
    pool(1), // Canonical stablecoin incorrectly occupying the tracked-token side of a stock pair.
    pool(7, { quote_asset: address(1), quote_symbol: "USDG" }),
    pool(8),
    pool(9, { sym: "USDG", name: "A token using the same ticker" }),
  ];
  const result = projectTrackedPayload({ pools }, null, assets);
  assert.deepEqual(
    result.pools.map((row) => row.meme),
    [address(7), address(8), address(9)],
  );
  assert.equal(popularTokens(result.pools).length, 1);
  assert.equal(popularTokens(result.pools)[0].name, "Moon Club");
  assert.equal(popularTokens(result.pools)[0].count, 2);
  assert.equal(pools.length, 7, "does not mutate the source");
  assert.deepEqual(projectTrackedPayload({ pools: pools.slice(0, 4) }, null, assets).pools, []);
});

test("invalid, missing or empty stable registry is rejected instead of disabling exclusions", () => {
  for (const extra of [
    { schemaVersion: 3 },
    { project: "Other" },
    { environment: "test" },
    { chains: [] },
    { chains: [{ chainId: 4663, quotes: [{ symbol: "USDG", address: address(0) }] }] },
    { chains: [{ chainId: 4663, quotes: [{ symbol: "USDG", address: "bad" }] }] },
    { chains: [{ chainId: 4663, quotes: [{ symbol: "ETH", address: address(0) }] }] },
  ])
    assert.throws(() => parseStableAssets({ ...assetRegistry(), ...extra }));
});

test("stable registry shares one daily HTTP request and retains exclusions across outages", async () => {
  let calls = 0,
    time = 0,
    fail = false;
  const load = createStableAssetRegistry({
    now: () => time,
    fetcher: async (url, options) => {
      calls++;
      assert.equal(url, "https://docs.o1.exchange/launchpad/reference/production-deployments.json");
      assert.equal(options.redirect, "manual");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      if (fail) throw new Error("unavailable");
      return Response.json(assetRegistry());
    },
  });
  const results = await Promise.all(Array.from({ length: 100 }, () => load()));
  assert.equal(calls, 1);
  time = 86_399_999;
  assert.equal(await load(), results[0]);
  assert.equal(calls, 1);
  time++;
  fail = true;
  assert.equal(await load(), results[0]);
  assert.equal(calls, 2);
  time += 299_999;
  assert.equal(await load(), results[0]);
  assert.equal(calls, 2);
  time++;
  await load();
  assert.equal(calls, 3);
});

test("missing initial classification backs off five minutes without fetching unfiltered pools", async () => {
  let time = 0,
    available = false,
    reads = 0;
  const handle = createTrackedFeedHandler({
    now: () => time,
    loadStableRegistry: async () => (available ? parseStableAssets(assetRegistry()) : null),
    fetcher: async () => {
      reads++;
      return Response.json({ pools: [pool(1), pool(8)] });
    },
  });
  const request = () => new Request("https://app.example.invalid/api/tracked-feed");
  const response = await handle(request());
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("retry-after"), "300");
  time = 299_999;
  await handle(request());
  assert.equal(reads, 0);
  time++;
  available = true;
  const ready = await handle(request());
  assert.equal(ready.status, 200);
  assert.deepEqual(
    (await ready.json()).pools.map((row) => row.meme),
    [address(8)],
  );
  assert.equal(reads, 1);
});
