import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createFacilitatorServer } from "./server.mjs";
import { PAYMENT_TIMEOUT_SECONDS } from "./policy.mjs";

const asset = `0x${"11".repeat(20)}`;
const payTo = `0x${"22".repeat(20)}`;
const payer = `0x${"33".repeat(20)}`;
const facilitatorCredential = ["private", "test", "credential", "long", "enough"].join("-");

function body() {
  const issuedAt = Date.now() - 1_000;
  const requirements = {
    scheme: "exact",
    network: "eip155:4663",
    asset,
    amount: "25000",
    payTo,
    maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
    extra: {
      assetTransferMethod: "eip3009",
      paymentFlow: "authorization",
      name: "Global Dollar",
      version: "1",
      symbol: "USDG",
      decimals: 6,
      payer,
      requestId: "00000000-0000-4000-8000-000000000001",
      inputHash: "44".repeat(32),
      product: "openrouter-grok-image-2.0-square-1k-low-memecoin-v1",
      nonce: `0x${"55".repeat(32)}`,
      issuedAt,
      expiresAt: issuedAt + PAYMENT_TIMEOUT_SECONDS * 1000,
    },
  };
  return {
    x402Version: 2,
    paymentRequirements: requirements,
    paymentPayload: {
      x402Version: 2,
      resource: {
        url: "https://app.example/api/images/grok",
        description: "One Grok memecoin image",
        mimeType: "application/json",
      },
      accepted: structuredClone(requirements),
      payload: {
        ["signature"]: `0x${"66".repeat(65)}`,
        ["authorization"]: {
          from: payer,
          to: payTo,
          value: "25000",
          validAfter: String(Math.floor(issuedAt / 1000) - 60),
          validBefore: String(Math.floor(requirements.extra.expiresAt / 1000)),
          nonce: requirements.extra.nonce,
        },
      },
    },
  };
}

async function fixture(facilitator = {}, logger = { info() {}, error() {} }) {
  const server = createFacilitatorServer({
    facilitator: {
      verify: async () => ({ isValid: true, payer }),
      settle: async () => ({
        success: true,
        transaction: `0x${"77".repeat(32)}`,
        network: "eip155:4663",
        payer,
      }),
      ...facilitator,
    },
    config: { bearerToken: facilitatorCredential, asset, payTo, maxAmount: 100_000n },
    relayerAddress: `0x${"88".repeat(20)}`,
    logger,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    get: path =>
      fetch(`${origin}${path}`, {
        headers: { ["authorization"]: `Bearer ${facilitatorCredential}` },
      }),
    post: (path, value = body()) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          ["authorization"]: `Bearer ${facilitatorCredential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(value),
      }),
  };
}

function captureLogs() {
  const info = [];
  const error = [];
  return { info, error, logger: {
    info: entry => info.push(entry), error: entry => error.push(entry),
  } };
}

function assertSafeLogs(logs, canaries) {
  const serialized = JSON.stringify([logs.info, logs.error]);
  for (const canary of canaries) assert.ok(!serialized.includes(canary));
  for (const entry of logs.info) {
    assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "event", "route", "status"]);
    assert.equal(entry.event, "facilitator_request");
    assert.ok(["unknown", "/healthz", "/supported", "/verify", "/settle"].includes(entry.route));
    assert.ok(Number.isInteger(entry.durationMs) && entry.durationMs >= 0);
  }
  for (const entry of logs.error) {
    assert.deepEqual(Object.keys(entry).sort(), ["code", "event", "route"]);
    assert.equal(entry.event, "facilitator_request_failed");
    assert.equal(entry.code, "unexpected_error");
  }
}

test("request logs exclude credentials in rejected paths, queries, headers and bodies", async t => {
  const logs = captureLogs();
  const f = await fixture({}, logs.logger);
  t.after(() => f.server.close());
  const markers = ["path", "query", "header", "body"].map(part => ["synthetic", part, "credential"].join("_"));
  const [pathValue, queryValue, headerValue, bodyValue] = markers;
  const authHeaders = { ["authorization"]: `Bearer ${facilitatorCredential}` };
  const jsonHeaders = { ...authHeaders, "content-type": "application/json" };
  const cases = [
    { path: `/${pathValue}`, status: 401, route: "unknown" },
    { path: `/%73${pathValue}`, status: 401, route: "unknown" },
    { path: `/verify?key=${queryValue}`, status: 404, route: "/verify" },
    { path: "/supported", options: { headers: {
      ["authorization"]: `Bearer ${headerValue}`, cookie: headerValue,
      "x-api-key": headerValue, "user-agent": headerValue, referer: headerValue,
    } }, status: 401, route: "/supported" },
    { path: `/unknown/${pathValue}`, options: { headers: authHeaders }, status: 404, route: "unknown" },
    { path: "/verify", options: { method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ note: bodyValue }) }, status: 200, route: "/verify" },
    { path: "/verify", options: { method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ note: bodyValue }).slice(0, -1) }, status: 400, route: "/verify" },
    { path: "/healthz", status: 200, route: "/healthz" },
    { path: "/supported", options: { headers: authHeaders }, status: 200, route: "/supported" },
    ...["/verify", "/settle"].map(path => ({ path,
      options: { method: "POST", headers: jsonHeaders, body: JSON.stringify(body()) },
      status: 200, route: path,
    })),
  ];
  for (const item of cases) {
    const count = logs.info.length;
    const response = await fetch(`${f.origin}${item.path}`, item.options);
    assert.equal(response.status, item.status);
    await response.arrayBuffer();
    assert.equal(logs.info.length, count + 1);
    assert.equal(logs.info.at(-1).route, item.route);
    assert.equal(logs.info.at(-1).status, item.status);
  }
  assert.equal(logs.error.length, 0);
  assertSafeLogs(logs, [...markers, facilitatorCredential]);
});

test("unexpected provider errors use a fixed log code, never a message or stack", async t => {
  const logs = captureLogs();
  // This deliberately satisfies the old error-message character whitelist.
  const marker = ["synthetic", "provider", "credential"].join("_");
  const fail = async () => {
    const error = new Error(marker, { cause: marker });
    error.stack = marker;
    throw error;
  };
  const f = await fixture({ verify: fail, settle: fail }, logs.logger);
  t.after(() => f.server.close());
  for (const route of ["/verify", "/settle"]) {
    const response = await f.post(route);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "unexpected_error" });
    assert.equal(logs.error.at(-1).route, route);
  }
  assert.equal(logs.info.length, 2);
  assert.equal(logs.error.length, 2);
  assertSafeLogs(logs, [marker, facilitatorCredential]);
});

test("keeps health public and every x402 endpoint bearer protected", async t => {
  const f = await fixture();
  t.after(() => f.server.close());
  assert.equal((await fetch(`${(await f.get("/healthz")).url}`)).status, 200);
  const unauthenticated = await fetch((await f.get("/supported")).url);
  assert.equal(unauthenticated.status, 401);
  const supported = await (await f.get("/supported")).json();
  assert.deepEqual(supported.kinds, [
    {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:4663",
      extra: { assetTransferMethod: "eip3009", paymentFlow: "authorization" },
    },
  ]);
});

test("rejects out-of-policy payments before the x402 implementation", async t => {
  let calls = 0;
  const f = await fixture({ verify: async () => (calls++, { isValid: true, payer }) });
  t.after(() => f.server.close());
  const value = body();
  value.paymentRequirements.asset = `0x${"99".repeat(20)}`;
  const response = await f.post("/verify", value);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).isValid, false);
  assert.equal(calls, 0);
});

test("serializes settlement through receipt completion", async t => {
  let running = 0;
  let peak = 0;
  const f = await fixture({
    async settle() {
      running++;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running--;
      return {
        success: true,
        transaction: `0x${"77".repeat(32)}`,
        network: "eip155:4663",
        payer,
      };
    },
  });
  t.after(() => f.server.close());
  const [one, two] = await Promise.all([f.post("/settle"), f.post("/settle")]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(peak, 1);
});

test("keeps an empty-hash transaction submission failure pending for chain reconciliation", async t => {
  const f = await fixture({
    async settle() {
      return {
        success: false,
        transaction: "",
        errorReason: "invalid_exact_evm_transaction_failed",
        network: "eip155:4663",
        payer,
      };
    },
  });
  t.after(() => f.server.close());
  const result = await (await f.post("/settle")).json();
  assert.equal(result.success, false);
  assert.equal(result.errorReason, "settlement_pending");
  assert.equal(result.transaction, "");
});
