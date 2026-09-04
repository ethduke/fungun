import assert from "node:assert/strict";
import test from "node:test";
import {
  PAYMENT_TIMEOUT_SECONDS,
  PaymentPolicyError,
  validateFacilitatorRequest,
} from "./policy.mjs";

const now = 1_800_000_000_000;
const asset = `0x${"11".repeat(20)}`;
const payTo = `0x${"22".repeat(20)}`;
const payer = `0x${"33".repeat(20)}`;
const nonce = `0x${"44".repeat(32)}`;

function fixture() {
  const issuedAt = now - 1_000;
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
      inputHash: "55".repeat(32),
      product: "openrouter-grok-image-2.0-square-1k-low-memecoin-v1",
      nonce,
      fromBlock: "0x1234",
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
        authorization: {
          from: payer,
          to: payTo,
          value: requirements.amount,
          validAfter: String(Math.floor(issuedAt / 1000) - 60),
          validBefore: String(Math.floor(requirements.extra.expiresAt / 1000)),
          nonce,
        },
      },
    },
  };
}

const config = { asset, payTo, maxAmount: 100_000n };

test("accepts only the prompt-bound v2 exact USDG authorization", () => {
  const body = fixture();
  const checked = validateFacilitatorRequest(body, config, now);
  assert.equal(checked.payer, payer);
  assert.equal(checked.requirements.amount, "25000");
});

test("rejects alternate protocol, route, token, recipient, price, or lifetime", () => {
  const mutations = [
    body => (body.x402Version = 1),
    body => (body.paymentRequirements.scheme = "upto"),
    body => (body.paymentRequirements.network = "eip155:1"),
    body => (body.paymentRequirements.asset = `0x${"77".repeat(20)}`),
    body => (body.paymentRequirements.payTo = payer),
    body => (body.paymentRequirements.amount = "100001"),
    body => (body.paymentRequirements.maxTimeoutSeconds = 301),
    body => (body.paymentRequirements.extra.expiresAt += 1_000),
    body => (body.paymentRequirements.extra.assetTransferMethod = "permit2"),
    body => (body.paymentRequirements.extra.paymentFlow = "capture"),
    body => (body.paymentPayload.payload.permit2Authorization = {}),
    body => (body.paymentPayload.resource.url = "https://app.example/api/other"),
  ];
  for (const mutate of mutations) {
    const body = fixture();
    mutate(body);
    assert.throws(
      () => validateFacilitatorRequest(body, config, now),
      error => error instanceof PaymentPolicyError,
    );
  }
});

test("rejects an expired authorization and any accepted echo mismatch", () => {
  const expired = fixture();
  assert.throws(
    () => validateFacilitatorRequest(expired, config, expired.paymentRequirements.extra.expiresAt),
    error => error.code === "payment_requirements_not_allowed",
  );
  const changed = fixture();
  changed.paymentPayload.accepted.amount = "1";
  assert.throws(
    () => validateFacilitatorRequest(changed, config, now),
    error => error.code === "payment_payload_not_allowed",
  );
});
