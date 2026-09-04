import assert from "node:assert/strict";
import test from "node:test";
import { verifyLocalCatalog } from "./verify-local-catalog.mjs";

const snapshot = (chainId = 4663) => ({
  chainId,
  checkedAt: 100,
  serverTime: 100,
  expiresAt: 300100,
  pads: {
    o1: { status: "ready", pairs: [{ id: `rwa-${"a".repeat(24)}`, symbol: "EXAMPLE" }] },
    ...(chainId === 4663 ? { long: { status: "unavailable", pairs: [] } } : {}),
  },
});

test("probe uses one bounded local request without loading credentials or emitting pair data", async () => {
  let calls = 0;
  const report = await verifyLocalCatalog(4663, async (url, options) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:3000/api/catalog");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { chainId: 4663 });
    assert.deepEqual(Object.keys(options.headers).sort(), [
      "content-type",
      "origin",
      "x-fungun-intent",
    ]);
    return Response.json(snapshot());
  });
  assert.equal(calls, 1);
  assert.equal(report.status, "verified");
  assert.deepEqual(report.pads.o1, { status: "ready", pairCount: 1 });
  assert.equal(report.pads.long.status, "unavailable");
  assert.ok(!JSON.stringify(report).includes("EXAMPLE"));
});

test("probe preserves throttling without retrying or forwarding upstream errors", async () => {
  let calls = 0;
  const report = await verifyLocalCatalog(8453, async () => {
    calls++;
    return new Response("EXAMPLE", { status: 429, headers: { "retry-after": "45" } });
  });
  assert.equal(calls, 1);
  assert.equal(report.status, "rate_limited");
  assert.equal(report.retryAfter, 45);
  assert.ok(!JSON.stringify(report).includes("EXAMPLE"));
});

test("probe rejects unexpected fields, expired and wrong-chain responses without echoing values", async () => {
  for (const mutate of [
    (body) => {
      body.PRIVATE_KEY = "EXAMPLE";
    },
    (body) => {
      body.pads.o1.pairs[0].address = "EXAMPLE";
    },
    (body) => {
      body.pads.o1.extra = "EXAMPLE";
    },
    (body) => {
      body.expiresAt = body.serverTime;
    },
    (body) => {
      body.expiresAt++;
    },
    (body) => {
      body.chainId = 8453;
    },
    (body) => {
      body.pads.long.pairs = body.pads.o1.pairs;
    },
  ]) {
    const body = snapshot();
    mutate(body);
    const report = await verifyLocalCatalog(4663, async () => Response.json(body));
    assert.notEqual(report.status, "verified");
    assert.ok(!JSON.stringify(report).includes("EXAMPLE"));
  }
});

test("unavailable, oversized and failed reads cannot pass verification", async () => {
  const body = snapshot();
  body.pads.o1 = { status: "unavailable", pairs: [] };
  for (const fetcher of [
    async () => Response.json(body),
    async () => {
      throw new Error("EXAMPLE");
    },
    async () => new Response("EXAMPLE", { status: 401 }),
    async () => Response.json({ extra: "a".repeat(128 * 1024) }),
  ]) {
    const report = await verifyLocalCatalog(4663, fetcher);
    assert.equal(report.status, "unavailable");
    assert.ok(!JSON.stringify(report).includes("EXAMPLE"));
  }
});

test("unsupported chain is rejected before any request", async () => {
  const report = await verifyLocalCatalog(1, () => assert.fail("unexpected request"));
  assert.equal(report.status, "invalid_chain");
});
