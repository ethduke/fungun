import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { PaymentPolicyError, validateFacilitatorRequest, X402_NETWORK } from "./policy.mjs";

const BODY_LIMIT = 32 * 1024;
const activeLimit = 8;
const knownRoutes = new Set(["/healthz", "/supported", "/verify", "/settle"]);
const baseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const safeReason = value =>
  typeof value === "string" && /^[a-z0-9_]{1,96}$/.test(value) ? value : "unexpected_error";
const safeHash = value =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : "";

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function send(response, status, value, extraHeaders = {}) {
  response.writeHead(status, { ...baseHeaders, ...extraHeaders });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new Error("invalid_content_type");
  const declared = request.headers["content-length"];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT))
    throw new Error("request_too_large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("invalid_json");
  }
}

export function createFacilitatorServer({ facilitator, config, relayerAddress, logger = console }) {
  let active = 0;
  let settleTail = Promise.resolve();
  const settleSerially = operation => {
    const result = settleTail.then(operation, operation);
    settleTail = result.catch(() => {});
    return result;
  };
  const server = http.createServer(async (request, response) => {
    const startedAt = performance.now();
    let status = 500;
    let route = "unknown";
    let counted = false;
    try {
      const url = new URL(request.url || "/", "http://facilitator.invalid");
      // Authentication failures are logged too: never retain a caller's path.
      route = knownRoutes.has(url.pathname) ? url.pathname : "unknown";
      if (url.search) {
        status = 404;
        return send(response, status, { error: "not_found" });
      }
      if (request.method === "GET" && route === "/healthz") {
        status = 200;
        return send(response, status, { ok: true });
      }
      if (!authorized(request.headers.authorization, config.bearerToken)) {
        status = 401;
        return send(response, status, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      }
      if (active >= activeLimit) {
        status = 429;
        return send(response, status, { error: "busy" }, { "retry-after": "1" });
      }
      active++;
      counted = true;
      if (request.method === "GET" && route === "/supported") {
        status = 200;
        return send(response, status, {
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network: X402_NETWORK,
              extra: { assetTransferMethod: "eip3009", paymentFlow: "authorization" },
            },
          ],
          extensions: [],
          signers: { "eip155:*": [relayerAddress] },
        });
      }
      if (request.method !== "POST" || (route !== "/verify" && route !== "/settle")) {
        status = 404;
        return send(response, status, { error: "not_found" });
      }
      const body = await readBody(request);
      let checked;
      try {
        checked = validateFacilitatorRequest(body, config);
      } catch (error) {
        if (!(error instanceof PaymentPolicyError)) throw error;
        status = 200;
        if (route === "/verify")
          return send(response, status, {
            isValid: false,
            invalidReason: error.code,
            ...(error.payer ? { payer: error.payer } : {}),
          });
        return send(response, status, {
          success: false,
          errorReason: error.code,
          transaction: "",
          network: X402_NETWORK,
          ...(error.payer ? { payer: error.payer } : {}),
        });
      }
      if (route === "/verify") {
        const result = await facilitator.verify(checked.paymentPayload, checked.requirements);
        status = 200;
        return send(response, status, {
          isValid: result.isValid === true,
          ...(result.isValid === true ? {} : { invalidReason: safeReason(result.invalidReason) }),
          payer: checked.payer,
        });
      }
      const result = await settleSerially(() =>
        facilitator.settle(checked.paymentPayload, checked.requirements),
      );
      status = 200;
      if (result.success === true && safeHash(result.transaction))
        return send(response, status, {
          success: true,
          transaction: safeHash(result.transaction),
          network: X402_NETWORK,
          payer: checked.payer,
        });
      const transaction = safeHash(result.transaction);
      const ambiguousBroadcast =
        !transaction &&
        typeof result.errorReason === "string" &&
        result.errorReason.startsWith("invalid_exact_evm_transaction_failed");
      return send(response, status, {
        success: false,
        errorReason: ambiguousBroadcast ? "settlement_pending" : safeReason(result.errorReason),
        transaction,
        network: X402_NETWORK,
        payer: checked.payer,
      });
    } catch (error) {
      status = error?.message === "request_too_large" ? 413 : 400;
      if (!["request_too_large", "invalid_content_type", "invalid_json"].includes(error?.message)) {
        status = 500;
        // Character filtering is not redaction; a secret can look like a code.
        logger.error?.({ event: "facilitator_request_failed", route, code: "unexpected_error" });
      }
      if (!response.headersSent) send(response, status, { error: status === 500 ? "unexpected_error" : error.message });
      else response.destroy();
    } finally {
      if (counted) active--;
      logger.info?.({
        event: "facilitator_request",
        route,
        status,
        durationMs: Math.ceil(performance.now() - startedAt),
      });
    }
  });
  server.requestTimeout = 35_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}
