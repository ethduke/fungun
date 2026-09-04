import { Buffer } from "node:buffer";
import { ServiceError } from "./errors.mjs";
import { hashDomain } from "viem";

export const IMAGE_PAYMENT_CHAIN_ID = 4663;
export const IMAGE_PAYMENT_NETWORK = "eip155:4663";
export const USDG_DECIMALS = 6;
export const USDG_EIP712_NAME = "Global Dollar";
export const USDG_EIP712_VERSION = "1";
export const X402_SCHEME = "exact";
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const INTEGER = /^(0|[1-9][0-9]{0,77})$/;
const RESPONSE_LIMIT = 128 * 1024;

export class PaymentError extends ServiceError {
  constructor(code, status = 400, transactionHash = "") {
    super(code, status);
    this.transactionHash = transactionHash;
  }
}
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const uint = (value) =>
  typeof value === "string" && INTEGER.test(value) && BigInt(value) < 2n ** 256n;
const wallet = (value) =>
  typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(stable(item))));
  if (object(value))
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, JSON.parse(stable(value[key]))]),
      ),
    );
  return JSON.stringify(value);
}

// Compare against the exact durable server quote; never take requirements from
// the browser's accepted echo. Facilitator verification checks the signature.
export function imagePaymentDomainSeparator(asset) {
  if (!wallet(asset)) throw new PaymentError("image_payments_not_configured", 503);
  return hashDomain({
    domain: {
      name: USDG_EIP712_NAME,
      version: USDG_EIP712_VERSION,
      chainId: IMAGE_PAYMENT_CHAIN_ID,
      verifyingContract: asset,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
    },
  });
}

export function validateImagePaymentPayload(paymentPayload, requirements, asset) {
  const extra = requirements?.extra;
  if (
    !object(requirements) ||
    requirements.scheme !== X402_SCHEME ||
    requirements.network !== IMAGE_PAYMENT_NETWORK ||
    !wallet(asset) ||
    !same(requirements.asset, asset) ||
    !wallet(requirements.payTo) ||
    !uint(requirements.amount) ||
    BigInt(requirements.amount) <= 0n ||
    !Number.isSafeInteger(requirements.maxTimeoutSeconds) ||
    requirements.maxTimeoutSeconds < 1 ||
    !object(extra) ||
    extra.assetTransferMethod !== "eip3009" ||
    (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") ||
    extra.name !== USDG_EIP712_NAME ||
    extra.version !== USDG_EIP712_VERSION ||
    !wallet(extra.payer) ||
    !HASH.test(extra.nonce) ||
    !Number.isSafeInteger(extra.issuedAt) ||
    extra.issuedAt < 60_000 ||
    !Number.isSafeInteger(extra.expiresAt) ||
    extra.expiresAt <= extra.issuedAt
  ) {
    throw new PaymentError("invalid_image_payment_quote");
  }
  const authorization = paymentPayload?.payload?.authorization;
  if (
    !object(paymentPayload) ||
    paymentPayload.x402Version !== 2 ||
    !object(paymentPayload.accepted) ||
    stable(paymentPayload.accepted) !== stable(requirements) ||
    !object(paymentPayload.payload) ||
    !SIGNATURE.test(paymentPayload.payload.signature) ||
    !object(authorization) ||
    !same(authorization.from, extra.payer) ||
    !same(authorization.to, requirements.payTo) ||
    authorization.value !== requirements.amount ||
    !same(authorization.nonce, extra.nonce) ||
    !uint(authorization.validAfter) ||
    !uint(authorization.validBefore) ||
    BigInt(authorization.validBefore) <= BigInt(authorization.validAfter) ||
    authorization.validAfter !== String(Math.floor(extra.issuedAt / 1000) - 60) ||
    authorization.validBefore !== String(Math.floor(extra.expiresAt / 1000))
  ) {
    throw new PaymentError("invalid_image_payment");
  }
  return {
    payer: extra.payer.toLowerCase(),
    paymentReference: `${IMAGE_PAYMENT_NETWORK}:${asset.toLowerCase()}:${extra.payer.toLowerCase()}:${authorization.nonce.toLowerCase()}`,
  };
}

async function readJsonLimited(response) {
  if (!response.body) throw new Error("missing_body");
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) {
    await response.body.cancel();
    throw new Error("response_too_large");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("response_too_large");
      chunks.push(Buffer.from(value));
    }
    const result = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!object(result)) throw new Error("invalid_json");
    return result;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Uses only the operator-configured HTTPS facilitator. No default provider,
 * URL from request data, redirects, secret logging, or automatic POST retries.
 * API bearerToken is optional and server-side only. Pass only trusted config.
 */
export function createImagePayments({
  facilitatorUrl,
  asset,
  bearerToken,
  fetcher = fetch,
  timeoutMs = 30_000,
} = {}) {
  let endpoint;
  try {
    endpoint = new URL(facilitatorUrl);
    if (
      !wallet(asset) ||
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000 ||
      (bearerToken !== undefined && (typeof bearerToken !== "string" || /[\r\n]/.test(bearerToken)))
    )
      throw new Error();
  } catch {
    throw new PaymentError("image_payments_not_configured", 503);
  }
  const base = endpoint.href.replace(/\/+$/, "");
  let readinessExpiresAt = 0;

  async function request(path, body, settlement = false) {
    // The timeout also bounds response body streaming because its signal is
    // passed to fetch. A settle failure may follow a successful broadcast.
    try {
      const response = await fetcher(`${base}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(bearerToken ? { ["Authorization"]: `Bearer ${bearerToken}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("facilitator_http_failure");
      }
      return await readJsonLimited(response);
    } catch {
      throw new PaymentError(
        settlement ? "image_settlement_pending" : "image_payment_unavailable",
        settlement ? 202 : 503,
      );
    }
  }
  const bodyFor = (paymentPayload, paymentRequirements) => ({
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });

  return {
    async ready() {
      const readyResult = {
        scheme: X402_SCHEME,
        network: IMAGE_PAYMENT_NETWORK,
        asset: asset.toLowerCase(),
      };
      if (readinessExpiresAt > Date.now()) return readyResult;
      const supported = await request("supported");
      if (
        !Array.isArray(supported.kinds) ||
        !supported.kinds.some(
          (kind) =>
            object(kind) &&
            kind.x402Version === 2 &&
            kind.scheme === X402_SCHEME &&
            kind.network === IMAGE_PAYMENT_NETWORK &&
            (!kind.extra?.assetTransferMethod || kind.extra.assetTransferMethod === "eip3009") &&
            (!kind.extra?.paymentFlow || kind.extra.paymentFlow === "authorization"),
        )
      ) {
        throw new PaymentError("image_payment_network_unsupported", 503);
      }
      readinessExpiresAt = Date.now() + 60_000;
      return readyResult;
    },
    async verify(paymentPayload, requirements) {
      const payment = validateImagePaymentPayload(paymentPayload, requirements, asset);
      const result = await request("verify", bodyFor(paymentPayload, requirements));
      if (result.isValid === false) throw new PaymentError("invalid_image_payment", 402);
      if (result.isValid !== true || !same(result.payer, payment.payer)) {
        throw new PaymentError("image_payment_unavailable", 503);
      }
      return payment;
    },
    async settle(paymentPayload, requirements) {
      const payment = validateImagePaymentPayload(paymentPayload, requirements, asset);
      const result = await request("settle", bodyFor(paymentPayload, requirements), true);
      if (
        result.success === false &&
        result.transaction === "" &&
        result.network === IMAGE_PAYMENT_NETWORK &&
        (result.payer === undefined || same(result.payer, payment.payer)) &&
        typeof result.errorReason === "string" &&
        /^[a-z0-9_]{1,96}$/.test(result.errorReason) &&
        result.errorReason !== "settlement_pending" &&
        (result.amount === undefined || result.amount === requirements.amount)
      ) {
        // In x402 v2 an empty transaction on a well-formed failed response means
        // no transaction was broadcast. This is a terminal, uncharged outcome.
        throw new PaymentError("image_settlement_failed", 402);
      }
      const transaction =
        typeof result.transaction === "string" && HASH.test(result.transaction)
          ? result.transaction.toLowerCase()
          : "";
      if (
        result.success !== true ||
        !transaction ||
        result.network !== IMAGE_PAYMENT_NETWORK ||
        !same(result.payer, payment.payer) ||
        (result.amount !== undefined && result.amount !== requirements.amount)
      ) {
        // Even malformed or failed responses cannot prove no settlement occurred.
        // Persist the known hash and reconcile before any further settle attempt.
        throw new PaymentError("image_settlement_pending", 202, transaction);
      }
      return {
        success: true,
        transaction,
        network: IMAGE_PAYMENT_NETWORK,
        payer: payment.payer,
        ...(result.amount === undefined ? {} : { amount: result.amount }),
      };
    },
  };
}
