const fakeSignedHex = `0x${"ab".repeat(65)}`;
import test from "node:test";
import assert from "node:assert/strict";
import { createImagePayments, validateImagePaymentPayload } from "./x402-payments.mjs";
const USDG_ADDRESS = `0x${"ef".repeat(20)}`;

const payer = `0x${"12".repeat(20)}`;
const recipient = `0x${"34".repeat(20)}`;
const nonce = `0x${"56".repeat(32)}`;
const transaction = `0x${"78".repeat(32)}`;
const facilitatorCredential = Buffer.alloc(64, 0x74).toString();
const requirements = {
  scheme: "exact",
  network: "eip155:4663",
  asset: USDG_ADDRESS,
  amount: "250000",
  payTo: recipient,
  maxTimeoutSeconds: 300,
  extra: {
    name: "Global Dollar",
    version: "1",
    assetTransferMethod: "eip3009",
    paymentFlow: "authorization",
    payer,
    nonce,
    issuedAt: 1700000060000,
    expiresAt: 1700000360000,
  },
};
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {
    signature: fakeSignedHex,
    authorization: {
      from: payer,
      to: recipient,
      value: "250000",
      validAfter: "1700000000",
      validBefore: "1700000360",
      nonce,
    },
  },
};
function fixture(results) {
  const calls = [];
  const payments = createImagePayments({
    asset: USDG_ADDRESS,
    facilitatorUrl: "https://payments.example/x402/",
    bearerToken: facilitatorCredential,
    fetcher: async (url, options) => {
      calls.push({ url, ...options });
      const value = results.shift();
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      return Response.json(value);
    },
  });
  return { payments, calls };
}
test("requires a configured HTTPS facilitator and prevents URL credentials or queries", () => {
  for (const facilitatorUrl of [
    undefined,
    "",
    "http://payments.example",
    "https://secret@payments.example",
    "https://payments.example?key=secret",
  ]) {
    assert.throws(
      () =>
        createImagePayments({
          facilitatorUrl,
          asset: USDG_ADDRESS,
          bearerToken: facilitatorCredential,
        }),
      (error) => error.code === "image_payments_not_configured",
    );
  }
});
test("requires a strong server-side facilitator bearer token", () => {
  for (const token of [undefined, "", "too-short", `valid-length${"x".repeat(24)}\n`]) {
    assert.throws(
      () =>
        createImagePayments({
          facilitatorUrl: "https://payments.example",
          asset: USDG_ADDRESS,
          bearerToken: token,
        }),
      (error) => error.code === "image_payments_not_configured",
    );
  }
});
test("capability gate requires v2 exact on Robinhood and eip3009 if declared", async () => {
  for (const kind of [
    { x402Version: 2, scheme: "exact", network: "eip155:1" },
    { x402Version: 1, scheme: "exact", network: "eip155:4663" },
    {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:4663",
      extra: { assetTransferMethod: "permit2" },
    },
  ]) {
    const { payments } = fixture([{ kinds: [kind] }]);
    await assert.rejects(
      payments.ready(),
      (error) => error.code === "image_payment_network_unsupported",
    );
  }
  const { payments, calls } = fixture([
    { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }] },
  ]);
  assert.equal((await payments.ready()).network, "eip155:4663");
  assert.equal(calls[0].url, "https://payments.example/x402/supported");
  assert.equal(calls[0].headers.Authorization, `Bearer ${facilitatorCredential}`);
});
test("verify sends standard facilitator payload only to configured URL and checks payer", async () => {
  const { payments, calls } = fixture([{ isValid: true, payer }]);
  assert.equal(
    (await payments.verify(payload, requirements)).paymentReference,
    `eip155:4663:${USDG_ADDRESS}:${payer}:${nonce}`,
  );
  assert.deepEqual(JSON.parse(calls[0].body), {
    x402Version: 2,
    paymentPayload: payload,
    paymentRequirements: requirements,
  });
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers.Authorization, `Bearer ${facilitatorCredential}`);
  const wrong = fixture([{ isValid: true, payer: recipient }]);
  await assert.rejects(
    wrong.payments.verify(payload, requirements),
    (error) => error.code === "image_payment_unavailable",
  );
});
test("authorization payer, amount, destination, nonce, validity and quote tampering fail before network", async () => {
  for (const [field, value] of [
    ["from", recipient],
    ["to", payer],
    ["value", "1"],
    ["nonce", transaction],
    ["validBefore", "1700000361"],
    ["validAfter", "0"],
  ]) {
    const p = structuredClone(payload);
    p.payload.authorization[field] = value;
    const { payments, calls } = fixture([]);
    await assert.rejects(
      payments.verify(p, requirements),
      (error) => error.code === "invalid_image_payment",
    );
    assert.equal(calls.length, 0);
  }
  const p = structuredClone(payload);
  p.accepted.payTo = payer;
  assert.throws(
    () => validateImagePaymentPayload(p, requirements, USDG_ADDRESS),
    (error) => error.code === "invalid_image_payment",
  );
});
test("failed verification cannot be reported as paid", async () => {
  const { payments } = fixture([{ isValid: false, invalidReason: "insufficient_funds" }]);
  await assert.rejects(
    payments.verify(payload, requirements),
    (error) => error.code === "invalid_image_payment" && error.status === 402,
  );
});
test("successful settlement validates payer, network, hash and optional amount", async () => {
  const { payments, calls } = fixture([
    { success: true, transaction, payer, network: "eip155:4663", amount: "250000" },
  ]);
  assert.deepEqual(await payments.settle(payload, requirements), {
    success: true,
    transaction,
    payer,
    network: "eip155:4663",
    amount: "250000",
  });
  assert.equal(calls.length, 1);
  for (const changed of [
    { payer: recipient },
    { network: "eip155:1" },
    { transaction: "" },
    { amount: "1" },
  ]) {
    const f = fixture([{ success: true, transaction, payer, network: "eip155:4663", ...changed }]);
    await assert.rejects(
      f.payments.settle(payload, requirements),
      (error) => error.code === "image_settlement_pending",
    );
  }
});
test("a well-formed failed settlement with no broadcast is terminal and uncharged", async () => {
  const { payments, calls } = fixture([
    {
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "eip155:4663",
      payer,
    },
  ]);
  await assert.rejects(
    payments.settle(payload, requirements),
    (error) =>
      error.code === "image_settlement_failed" &&
      error.status === 402 &&
      error.transactionHash === "",
  );
  assert.equal(calls.length, 1);
});
test("ambiguous settlement preserves hash and never retries or issues new authorization", async () => {
  for (const value of [
    new Error("secret RPC or key"),
    new Response("unavailable", { status: 503 }),
    {
      success: false,
      errorReason: "settlement_pending",
      transaction: "",
      network: "eip155:4663",
      payer,
    },
    {
      success: false,
      errorReason: "settlement_pending",
      transaction,
      network: "eip155:4663",
      payer,
    },
  ]) {
    const { payments, calls } = fixture([value]);
    await assert.rejects(
      payments.settle(payload, requirements),
      (error) =>
        error.code === "image_settlement_pending" &&
        error.status === 202 &&
        !error.message.includes("secret") &&
        (value instanceof Error ||
          value instanceof Response ||
          error.transactionHash === value.transaction),
    );
    assert.equal(calls.length, 1);
  }
});
test("oversized and malformed facilitator replies fail closed", async () => {
  for (const response of [
    new Response("x".repeat(128 * 1024 + 1)),
    new Response("{not json"),
    Response.json([]),
  ]) {
    const { payments } = fixture([response]);
    await assert.rejects(
      payments.verify(payload, requirements),
      (error) => error.code === "image_payment_unavailable",
    );
  }
});
