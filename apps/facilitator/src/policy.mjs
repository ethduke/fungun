export const X402_VERSION = 2;
export const X402_SCHEME = "exact";
export const X402_NETWORK = "eip155:4663";
export const USDG_NAME = "Global Dollar";
export const USDG_VERSION = "1";
export const USDG_DECIMALS = 6;
export const PAYMENT_TIMEOUT_SECONDS = 300;
export const GROK_IMAGE_PRODUCT = "openrouter-grok-image-2.0-square-1k-low-memecoin-v1";

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const INPUT_HASH = /^[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const INTEGER = /^(0|[1-9][0-9]{0,77})$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const same = (left, right) =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.toLowerCase() === right.toLowerCase();
const uint = value =>
  typeof value === "string" && INTEGER.test(value) && BigInt(value) < 2n ** 256n;
const wallet = value =>
  typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
const exactKeys = (value, keys) =>
  object(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export class PaymentPolicyError extends Error {
  constructor(code, payer = "") {
    super(code);
    this.name = "PaymentPolicyError";
    this.code = code;
    this.payer = payer;
  }
}

const reject = (code, payer) => {
  throw new PaymentPolicyError(code, payer);
};

function validateResource(resource, payer) {
  if (!exactKeys(resource, ["url", "description", "mimeType"]))
    reject("resource_not_allowed", payer);
  let url;
  try {
    url = new URL(resource.url);
  } catch {
    reject("resource_not_allowed", payer);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/images/grok" ||
    resource.description !== "One Grok memecoin image" ||
    resource.mimeType !== "application/json"
  )
    reject("resource_not_allowed", payer);
}

/**
 * Accepts only the exact request shape emitted by the Fungun Grok image backend.
 * This is intentionally narrower than the generic x402 exact EVM mechanism.
 */
export function validateFacilitatorRequest(body, config, now = Date.now()) {
  if (
    !exactKeys(body, ["x402Version", "paymentPayload", "paymentRequirements"]) ||
    body.x402Version !== X402_VERSION
  )
    reject("x402_version_not_allowed");

  const requirements = body.paymentRequirements;
  const paymentPayload = body.paymentPayload;
  const extra = requirements?.extra;
  const payer = wallet(extra?.payer) ? extra.payer.toLowerCase() : "";
  const extraKeys = [
    "assetTransferMethod",
    "decimals",
    "expiresAt",
    "inputHash",
    "issuedAt",
    "name",
    "nonce",
    "payer",
    "paymentFlow",
    "product",
    "requestId",
    "symbol",
    "version",
    ...(Object.hasOwn(extra || {}, "fromBlock") ? ["fromBlock"] : []),
  ];

  if (
    !exactKeys(requirements, [
      "scheme",
      "network",
      "asset",
      "amount",
      "payTo",
      "maxTimeoutSeconds",
      "extra",
    ]) ||
    requirements.scheme !== X402_SCHEME ||
    requirements.network !== X402_NETWORK ||
    !same(requirements.asset, config.asset) ||
    !same(requirements.payTo, config.payTo) ||
    !uint(requirements.amount) ||
    BigInt(requirements.amount) < 1n ||
    BigInt(requirements.amount) > config.maxAmount ||
    requirements.maxTimeoutSeconds !== PAYMENT_TIMEOUT_SECONDS ||
    !exactKeys(extra, extraKeys) ||
    extra.assetTransferMethod !== "eip3009" ||
    extra.paymentFlow !== "authorization" ||
    extra.name !== USDG_NAME ||
    extra.version !== USDG_VERSION ||
    extra.symbol !== "USDG" ||
    extra.decimals !== USDG_DECIMALS ||
    !wallet(extra.payer) ||
    !HASH.test(extra.nonce) ||
    !UUID_V4.test(extra.requestId) ||
    !INPUT_HASH.test(extra.inputHash) ||
    !PRODUCT.test(extra.product) ||
    extra.product !== GROK_IMAGE_PRODUCT ||
    !Number.isSafeInteger(extra.issuedAt) ||
    !Number.isSafeInteger(extra.expiresAt) ||
    extra.expiresAt - extra.issuedAt !== PAYMENT_TIMEOUT_SECONDS * 1000 ||
    extra.issuedAt > now + 10_000 ||
    extra.expiresAt < now + 6_000 ||
    (Object.hasOwn(extra, "fromBlock") &&
      (typeof extra.fromBlock !== "string" || !QUANTITY.test(extra.fromBlock)))
  )
    reject("payment_requirements_not_allowed", payer);

  if (
    !exactKeys(paymentPayload, ["x402Version", "resource", "accepted", "payload"]) ||
    paymentPayload.x402Version !== X402_VERSION ||
    stable(paymentPayload.accepted) !== stable(requirements)
  )
    reject("payment_payload_not_allowed", payer);

  validateResource(paymentPayload.resource, payer);
  const payload = paymentPayload.payload;
  const authorization = payload?.authorization;
  if (
    !exactKeys(payload, ["signature", "authorization"]) ||
    !SIGNATURE.test(payload.signature) ||
    !exactKeys(authorization, [
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]) ||
    !same(authorization.from, extra.payer) ||
    !same(authorization.to, config.payTo) ||
    authorization.value !== requirements.amount ||
    !same(authorization.nonce, extra.nonce) ||
    authorization.validAfter !== String(Math.floor(extra.issuedAt / 1000) - 60) ||
    authorization.validBefore !== String(Math.floor(extra.expiresAt / 1000))
  )
    reject("payment_authorization_not_allowed", payer);

  return Object.freeze({ paymentPayload, requirements, payer });
}
