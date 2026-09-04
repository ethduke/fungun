import { recoverTypedDataAddress } from "viem";
import { ServiceError, safeError } from "./errors.mjs";
import { GROK_IMAGE_PRODUCT } from "./grok-image-provider.mjs";
import { imageJobResult, validateImageOperation } from "./image-generation.mjs";

export const TRANSFER_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};
export function readImageConfig(env = process.env) {
  const enabled = env.IMAGE_GENERATION === "true";
  const maxAmount = env.IMAGE_MAX_PRICE_USDG_BASE_UNITS || "";
  const payTo = (env.IMAGE_PAYMENT_RECIPIENT || "").toLowerCase();
  const asset = (env.IMAGE_USDG_ADDRESS || "").toLowerCase();
  if (
    enabled &&
    (!/^0x[0-9a-f]{40}$/.test(asset) ||
      /^0x0+$/.test(asset) ||
      !/^0x[0-9a-f]{40}$/.test(payTo) ||
      /^0x0+$/.test(payTo) ||
      !/^[1-9][0-9]{0,7}$/.test(maxAmount) ||
      BigInt(maxAmount) > 10000000n ||
      !env.OPENROUTER_KEY ||
      !env.X402_FACILITATOR_URL ||
      typeof env.X402_FACILITATOR_BEARER_TOKEN !== "string" ||
      !/^[\x21-\x7e]{32,256}$/.test(env.X402_FACILITATOR_BEARER_TOKEN) ||
      !env.ROBINHOOD_RPC)
  )
    throw new ServiceError("image_service_not_configured");
  return {
    enabled,
    maxAmount,
    payTo,
    asset,
    domainName: "Global Dollar",
    domainVersion: "1",
    appOrigin: env.APP_ORIGIN,
  };
}

export function imagePaymentRequired(job, origin) {
  return {
    x402Version: 2,
    resource: {
      url: `${origin}/api/images/grok`,
      description: "One Grok memecoin image",
      mimeType: "application/json",
    },
    accepts: [JSON.parse(job.requirements)],
  };
}
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
async function readJson(body, limit = 8192) {
  if (!body) throw new ServiceError("invalid_image_request", 400);
  const chunks = [];
  let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > limit) throw new ServiceError("invalid_image_request", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_image_request", 400);
  }
}
export async function validateImagePayment(header, job, origin) {
  if (typeof header !== "string" || header.length > 12000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header))
    throw new ServiceError("invalid_image_payment", 400);
  let proof;
  try {
    proof = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new ServiceError("invalid_image_payment", 400);
  }
  const terms = JSON.parse(job.requirements);
  const required = imagePaymentRequired(job, origin);
  const auth = proof?.payload?.authorization;
  const fields = ["from", "to", "value", "validAfter", "validBefore", "nonce"];
  if (
    proof?.x402Version !== 2 ||
    JSON.stringify(proof.accepted) !== JSON.stringify(terms) ||
    JSON.stringify(proof.resource) !== JSON.stringify(required.resource) ||
    !auth ||
    Object.keys(auth).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(auth, key)) ||
    auth.from !== job.wallet ||
    auth.to !== terms.payTo ||
    auth.value !== terms.amount ||
    auth.nonce !== terms.extra.nonce ||
    auth.validAfter !== String(Math.floor(job.created_at / 1000) - 60) ||
    auth.validBefore !== String(Math.floor(job.expires_at / 1000)) ||
    !/^0x[a-f0-9]{130}$/i.test(proof.payload.signature)
  )
    throw new ServiceError("invalid_image_payment", 400);
  try {
    const address = await recoverTypedDataAddress({
      domain: {
        name: terms.extra.name,
        version: terms.extra.version,
        chainId: 4663,
        verifyingContract: terms.asset,
      },
      types: TRANSFER_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        ...auth,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
      },
      signature: proof.payload.signature,
    });
    if (address.toLowerCase() !== job.wallet) throw new Error();
  } catch {
    throw new ServiceError("invalid_image_payment", 400);
  }
  return proof;
}

export function createImageHandler(config, store, provider, worker, payments, settlementReader = null) {
  let active = 0;
  const baseHeaders = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  const send = (status, value, headers = {}) =>
    Response.json(value, { status, headers: { ...baseHeaders, ...headers } });
  function result(job) {
    const headers = job.payment_response
      ? { "payment-response": encode(JSON.parse(job.payment_response)) }
      : {};
    return send(job.state === "completed" ? 200 : 202, imageJobResult(job), headers);
  }
  return async (request) => {
    if (active >= 4) return send(429, { error: "image_busy" });
    active++;
    try {
      const path = new URL(request.url);
      const statusMatch = /^\/v1\/images\/grok\/([a-f0-9-]{36})$/.exec(path.pathname);
      if (path.search || (!statusMatch && path.pathname !== "/v1/images/grok"))
        return send(404, { error: "not_found" });
      if (
        request.headers.get("origin") !== config.appOrigin ||
        request.headers.get("sec-fetch-site") === "cross-site" ||
        request.headers.get("x-fungun-intent") !== "image-generation"
      )
        return send(403, { error: "origin_denied" });
      const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") || "")?.[1];
      if (!token) return send(401, { error: "image_auth_required" });
      if (!store) return send(503, { error: "image_service_not_configured" });
      if (statusMatch && request.method === "GET") {
        const job = store.authenticate(statusMatch[1], token);
        if (job.state === "awaiting_payment" && store.now() >= job.expires_at)
          return result({
            ...job,
            state: "failed",
            accounting: "not_charged",
            error: "image_quote_expired",
          });
        if (config.enabled) worker.kick();
        if (job.state === "awaiting_payment")
          return send(200, {
            ...imageJobResult(job),
            quote: imagePaymentRequired(job, config.appOrigin),
          });
        return result(job);
      }
      if (request.method !== "POST" || statusMatch)
        return send(405, { error: "method_not_allowed" });
      if (
        request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" ||
        request.headers.has("content-encoding")
      )
        return send(415, { error: "invalid_image_request" });
      const input = validateImageOperation(await readJson(request.body));
      const header = request.headers.get("payment-signature");
      let job = store.get(input.requestId);
      if (job) {
        store.authenticate(input.requestId, token);
        if (JSON.stringify(input) !== job.input)
          return send(409, { error: "image_request_changed" });
        if (job.state !== "awaiting_payment") {
          if (config.enabled) worker.kick();
          return result(job);
        }
      }
      if (!config.enabled) return send(503, { error: "image_service_not_configured" });
      // A signature cannot be valid before this server has issued and saved the
      // request-specific amount and nonce. Reject it before any pricing/RPC work.
      if (!job && header) throw new ServiceError("invalid_image_payment", 400);
      if (!job) {
        const pricingInput = { name: input.name, ticker: input.ticker, prompt: input.prompt };
        const [price, , fromBlock] = await Promise.all([
          provider.quote(pricingInput),
          payments.ready(),
          settlementReader?.anchor(),
        ]);
        if (!price || typeof price.amount !== "string" || !/^[1-9][0-9]{0,7}$/.test(price.amount))
          throw new ServiceError("image_pricing_unavailable", 503);
        if (BigInt(price.amount) > BigInt(config.maxAmount))
          throw new ServiceError("image_price_above_limit", 503);
        job = store.quote(
          input,
          token,
          { ...config, amount: price.amount, fromBlock },
          GROK_IMAGE_PRODUCT,
        );
      }
      if (store.now() >= job.expires_at) return send(409, { error: "image_quote_expired" });
      if (!header) {
        const quote = imagePaymentRequired(job, config.appOrigin);
        return send(402, quote, { "payment-required": encode(quote) });
      }
      const proof = await validateImagePayment(header, job, config.appOrigin);
      await payments.verify(proof, JSON.parse(job.requirements));
      job = store.authorize(job.id, proof);
      worker.kick();
      return result(job);
    } catch (error) {
      const safe = safeError(error);
      return send(safe.status, { error: safe.code });
    } finally {
      active--;
    }
  };
}
