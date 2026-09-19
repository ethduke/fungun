import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createFacilitatorServer } from "./server.mjs";
import { PAYMENT_TIMEOUT_SECONDS } from "./policy.mjs";
import { safeStartupReason } from "./diagnostics.mjs";

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

async function fixture(facilitator = {}) {
  const logs = [];
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
    logger: { info: entry => logs.push(entry), error: entry => logs.push(entry) },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    logs,
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

test("never emits arbitrary SDK reasons or exception text, including code-shaped secrets", async t => {
  const marker = ["synthetic", "credential", "1234567890"].join("_");
  for (const secret of [marker, `https://rpc.example/v2/${marker}`, `Bearer ${marker}`]) {
    const f = await fixture({
      verify: async () => ({ isValid: false, invalidReason: secret }),
      settle: async () => ({ success: false, transaction: "", errorReason: secret }),
    });
    t.after(() => f.server.close());
    assert.equal((await (await f.post("/verify")).json()).invalidReason, "unexpected_error");
    assert.equal((await (await f.post("/settle")).json()).errorReason, "settlement_pending");
    const throwing = await fixture({ verify: async () => { throw new Error(secret); } });
    t.after(() => throwing.server.close());
    const response = await throwing.post("/verify");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "unexpected_error" });
    assert.ok(!JSON.stringify([...f.logs, ...throwing.logs]).includes(marker));
    assert.equal(safeStartupReason(secret), "startup_validation_failed");
  }
  assert.equal(safeStartupReason("missing_robinhood_rpc"), "missing_robinhood_rpc");
});

test("logs only known routes, excluding credentials in paths and queries", async t => {
  const f = await fixture();
  t.after(() => f.server.close());
  const marker = ["synthetic", "path", "credential"].join("_");
  assert.equal((await f.get(`/v2/${marker}`)).status, 404);
  assert.equal((await f.get(`/verify?key=${marker}`)).status, 404);
  assert.deepEqual(f.logs.map(entry => entry.route), ["unknown", "/verify"]);
  assert.ok(!JSON.stringify(f.logs).includes(marker));
});

test("retains known SDK rejection codes", async t => {
  const reason = "invalid_exact_evm_insufficient_balance";
  const f = await fixture({
    verify: async () => ({ isValid: false, invalidReason: reason }),
    settle: async () => ({ success: false, transaction: "", errorReason: reason }),
  });
  t.after(() => f.server.close());
  assert.equal((await (await f.post("/verify")).json()).invalidReason, reason);
  assert.equal((await (await f.post("/settle")).json()).errorReason, reason);
});
