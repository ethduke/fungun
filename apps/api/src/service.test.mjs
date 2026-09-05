import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Budget } from "./budget.mjs";
import { createHandler } from "./service.mjs";
import { Fees } from "./fees.mjs";
import { readConfig } from "./config.mjs";
import { ServiceError, InsufficientFundsError } from "./errors.mjs";

test("HTTP boundary rejects spoofing, excess input and leaks while keeping reads bounded", async (t) => {
  const budget = new Budget(":memory:");
  let calls = 0;
  const config = { origin: "http://127.0.0.1:3000" };
  const adapters = {
    async catalog(chainId) {
      calls++;
      return { chainId, pads: {} };
    },
    async ticker(chainId, ticker) {
      calls++;
      if (ticker === "LIMIT") throw new ServiceError("rate_limited", 429, 120, "operation");
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
  const providerLimited = await post("/v1/ticker", {
    ...input,
    ticker: "LIMIT",
  });
  assert.equal(providerLimited.status, 429);
  assert.equal(providerLimited.headers.get("retry-after"), "120");
  assert.equal(providerLimited.headers.get("x-fungun-retry-scope"), "operation");
  for (let i = 0; i < 18; i++) await post("/v1/ticker", input);
  const limited = await post("/v1/ticker", input, {
    "x-forwarded-for": "192.0.2.1",
    "fly-client-ip": "192.0.2.2",
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(calls, 21);
});

test("fee HTTP endpoints remain non-signing and reject arbitrary calldata", async (t) => {
  const budget = new Budget(":memory:");
  const config = readConfig({});
  const fees = new Fees(config, {
    json() {
      assert.fail("Disabled fees cannot contact providers");
    },
  });
  const server = createServer(createHandler(config, budget, {}, fees));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    budget.close();
  });
  const post = (kind, input) =>
    fetch(`http://127.0.0.1:${server.address().port}/v1/${kind}`, {
      method: "POST",
      headers: {
        origin: config.origin,
        "content-type": "application/json",
        "x-fungun-intent": kind,
      },
      body: JSON.stringify(input),
    });
  const address = `0x${"a".repeat(40)}`;
  const listed = await post("fees", { address, chainId: 4663, padId: "long" });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).status, "unavailable");
  assert.equal(
    (await post("claim-prepare", { address, positionId: "a".repeat(64), data: "0x1234" })).status,
    400,
  );
  const prepared = await post("claim-prepare", { address, positionId: "a".repeat(64) });
  assert.equal(prepared.status, 503);
  assert.deepEqual(await prepared.json(), { error: "not_configured" });
  assert.equal((await post("claim-send", { address })).status, 404);
});

test("launch HTTP endpoints enforce exact inputs and their bounded larger body", async (t) => {
  const budget = new Budget(":memory:");
  const config = { origin: "http://127.0.0.1:3000" };
  const calls = [];
  const launches = {
    async run(kind, input) {
      calls.push([kind, input]);
      return { id: input.id ?? "a".repeat(64), status: kind.slice(7) };
    },
  };
  const server = createServer(createHandler(config, budget, {}, undefined, undefined, launches));
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
  const post = (kind, body, headers = {}) => fetch(`${base}/v1/${kind}`, {
    method: "POST",
    headers: {
      origin: config.origin,
      "content-type": "application/json",
      "x-fungun-intent": kind,
      cookie: "private=EXAMPLE",
      "x-forwarded-for": "192.0.2.1",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const prepare = {
    chainId: 4663,
    wallet: `0x${"1".repeat(40)}`,
    draft: { name: "Sample", ticker: "SAMPLE", description: "a".repeat(2000) },
    pairId: "long-NVDA",
    publication: {
      id: "a".repeat(48),
      imageHash: "b".repeat(64),
      metadataHash: "c".repeat(64),
    },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(prepare)) > 2048);
  assert.equal((await post("launch-prepare", prepare)).status, 200);
  const id = "d".repeat(64);
  assert.equal((await post("launch-reserve", { id, binding: "e".repeat(64) })).status, 200);
  assert.equal((await post("launch-status", { id, hash: null })).status, 200);
  assert.equal((await post("launch-estimate", { chainId: 4663, pairId: "long-NVDA" })).status, 200);
  assert.equal(
    (await post("launch-status", { id, hash: null, transaction: "0x" })).status,
    400,
  );
  assert.equal((await post("launch-status", { id, hash: "0x1234" })).status, 400);
  assert.equal((await post("launch-prepare", `{"padding":"${"a".repeat(4096)}"}`)).status, 413);
  assert.equal(
    (await post("launch-status", { id, hash: null }, { "x-fungun-intent": "catalog" })).status,
    404,
  );
  assert.deepEqual(calls.map(([kind]) => kind), ["launch-prepare", "launch-reserve", "launch-status", "launch-estimate"]);
  assert.equal(calls[0][1].draft.description.length, 2000);
  launches.run = async () => { throw new InsufficientFundsError(200n, 1000n); };
  const low = await post("launch-prepare", prepare);
  assert.equal(low.status, 409);
  assert.deepEqual(await low.json(), { error: "insufficient_funds", funding: {
    chainId:4663, balanceWei:"200", requiredWei:"1000", shortfallWei:"800", basis:"simulation",
  } });
});
