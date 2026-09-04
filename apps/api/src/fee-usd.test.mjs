import assert from "node:assert/strict";
import test from "node:test";
import { Budget } from "./budget.mjs";
import { ServiceError } from "./errors.mjs";
import { FeeUsd, parseEthUsd } from "./fee-usd.mjs";
import { Upstream } from "./upstream.mjs";

const response = (amount = "2448.855") => ({
  data: { base: "ETH", currency: "USD", amount },
});

test("ETH/USD rejects wrong pairs and malformed or nonpositive prices", () => {
  for (const amount of [
    "",
    "0",
    "-1",
    "NaN",
    "Infinity",
    "1e3",
    "01",
    "1000000000",
    "1.1234567890123456789",
    2500,
  ])
    assert.throws(() => parseEthUsd(response(amount)), { code: "price_unavailable" });
  for (const body of [
    null,
    {},
    { data: { ...response().data, base: "BTC" } },
    { data: { ...response().data, currency: "EUR" } },
  ])
    assert.throws(() => parseEthUsd(body), { code: "price_unavailable" });
  assert.equal(parseEthUsd(response()).scaled, 2448855n * 10n ** 15n);
});

test("gas USD uses integer decimals, shares a bounded public price request and refreshes after one minute", async (t) => {
  let now = 1000;
  let requests = 0;
  const budget = new Budget(":memory:", () => now);
  t.after(() => budget.close());
  const upstream = new Upstream(
    budget,
    async (url, options) => {
      requests++;
      assert.equal(url, "https://api.coinbase.com/v2/prices/ETH-USD/spot");
      assert.deepEqual(options.headers, { Accept: "application/json" });
      assert.equal(options.body, undefined);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(response());
    },
    () => now,
  );
  const prices = new FeeUsd(upstream, () => now);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => prices.estimate(41_630_000_000_000n)),
  );
  assert.equal(requests, 1);
  assert.deepEqual(results[0], {
    amount: "0.10194583365",
    ethPrice: "2448.855",
    observedAt: 1000,
    source: "coinbase",
  });
  assert.equal((await prices.estimate(1n)).amount, "0.000000000000002448");
  now += 59_999;
  assert.equal((await prices.estimate(0n)).amount, "0");
  assert.equal(requests, 1);
  now++;
  assert.equal((await prices.estimate(1n)).observedAt, now);
  assert.equal(requests, 2);
  assert.equal(
    budget.db.prepare("SELECT used FROM counters WHERE scope = ?").get("provider:market:86400000:0")
      .used,
    2,
  );
});

test("invalid prices, transport failures and quota failures return no estimate without stale fallback or immediate retry", async () => {
  for (const failure of [
    new Error("network"),
    new ServiceError("rate_limited", 429, 30),
    response("0"),
  ]) {
    let now = 1000;
    let requests = 0;
    let fail = false;
    const prices = new FeeUsd(
      {
        async json() {
          requests++;
          if (fail) {
            if (failure instanceof Error) throw failure;
            return failure;
          }
          return response();
        },
      },
      () => now,
    );
    assert.ok(await prices.estimate(10n ** 18n));
    now += 60_000;
    fail = true;
    assert.equal(await prices.estimate(10n ** 18n), null);
    assert.equal(await prices.estimate(10n ** 18n), null);
    assert.equal(requests, 2);
    now += 30_001;
    fail = false;
    assert.ok(await prices.estimate(10n ** 18n));
    assert.equal(requests, 3);
  }
});
