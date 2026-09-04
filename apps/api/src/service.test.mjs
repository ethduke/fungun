import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Budget } from "./budget.mjs";
import { createHandler } from "./service.mjs";

test("HTTP boundary rejects spoofing, excess input and leaks while keeping reads bounded", async (t) => {
  const budget = new Budget(":memory:");
  let calls = 0;
  const config = { origin: "http://127.0.0.1:3000" };
  const adapters = {
    async catalog(chainId) {
      calls++;
      return { chainId, pads: {} };
    },
    async ticker() {
      calls++;
      throw new Error("synthetic private upstream details");
    },
  };
  const server = createServer(createHandler(config, budget, adapters));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    budget.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value, headers = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        origin: config.origin,
        "content-type": "application/json",
        "x-fungun-intent": path.slice(4),
        ...headers,
      },
      body: JSON.stringify(value),
    });
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal(calls, 0);
  const valid = await post("/v1/catalog", { chainId: 4663 });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get("cache-control"), "no-store");
  assert.ok(Number.isFinite((await valid.json()).serverTime));
  assert.equal(calls, 1);
  assert.equal(
    (await post("/v1/catalog", { chainId: 4663 }, { origin: "https://attacker.invalid" })).status,
    403,
  );
  assert.equal((await post("/v1/catalog", { chainId: 4663 }, { origin: "" })).status, 403);
  assert.equal((await post("/v1/catalog?chainId=8453", { chainId: 4663 })).status, 404);
  assert.equal((await post("/v1/catalog", { chainId: 4663, extra: true })).status, 400);
  assert.equal(
    (await post("/v1/catalog", { chainId: 4663 }, { "content-type": "text/plain" })).status,
    415,
  );
  assert.equal((await post("/v1/catalog", { chainId: 4663, extra: "a".repeat(2100) })).status, 413);
  assert.equal(calls, 1);
  const input = { chainId: 4663, ticker: "MOON", pads: ["long"] };
  const failure = await post("/v1/ticker", input);
  assert.equal(failure.status, 503);
  assert.deepEqual(await failure.json(), { error: "unavailable" });
  for (let i = 0; i < 5; i++) await post("/v1/ticker", input);
  const limited = await post("/v1/ticker", input, {
    "x-forwarded-for": "192.0.2.1",
    "fly-client-ip": "192.0.2.2",
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(calls, 7);
});
