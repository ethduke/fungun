import { validateLongInput } from "./long-live.mjs";
import { isIP } from "node:net";
import { ServiceError, safeError, serviceErrorBody } from "./errors.mjs";
import { validAddress } from "./fee-contracts.mjs";
import { validatePriceInput } from "./tracked-prices.mjs";
import { validateTokenImageInput } from "./o1-token-image.mjs";

export function validateInput(kind, input) {
  if (kind === "o1-token-image") return validateTokenImageInput(input);
  if (kind === "fomo") {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
      throw new ServiceError("invalid_request", 400);
    return {};
  }
  if (kind.startsWith("launch-")) return validateLongInput(kind, input);
  if (kind === "tracked-prices") return validatePriceInput(input);
  if (kind === "fees" || kind === "claim-prepare") {
    const required = kind === "fees" ? ["address", "chainId", "padId"] : ["address", "positionId"];
    const fields = kind === "fees" ? [...required, "cursor"] : required;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      required.some((key) => !Object.hasOwn(input, key)) ||
      Object.keys(input).some((key) => !fields.includes(key)) ||
      !validAddress(input.address)
    )
      throw new ServiceError("invalid_request", 400);
    if (
      kind === "fees"
        ? ![4663, 8453].includes(input.chainId) ||
          !["long", "o1", "longbow", "stonks"].includes(input.padId) ||
          (input.padId === 'stonks' ? input.chainId !== 8453 : input.padId !== 'o1' && input.chainId !== 4663) ||
          (Object.hasOwn(input, "cursor") &&
            (typeof input.cursor !== "string" || !/^[a-f0-9]{64}$/.test(input.cursor)))
        : typeof input.positionId !== "string" || !/^[a-f0-9]{64}$/.test(input.positionId)
    )
      throw new ServiceError("invalid_request", 400);
    return { ...input, address: input.address.toLowerCase() };
  }
  const keys = kind === "catalog" ? ["chainId"] : ["chainId", "ticker", "pads"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    ![4663, 8453].includes(input.chainId)
  )
    throw new ServiceError("invalid_request", 400);
  if (
    kind === "ticker" &&
    (typeof input.ticker !== "string" ||
      !input.ticker ||
      Array.from(input.ticker).length > 11 ||
      /[\s\p{C}]/u.test(input.ticker) ||
      !Array.isArray(input.pads) ||
      !input.pads.length ||
      input.pads.length > 2 ||
      new Set(input.pads).size !== input.pads.length ||
      input.pads.some(
        (pad) => !['long', 'o1', 'stonks'].includes(pad) || (pad === 'long' && input.chainId !== 4663) || (pad === 'stonks' && input.chainId !== 8453),
      ) ||
      (input.pads.includes("long") && !/^[A-Z]{1,11}$/.test(input.ticker)))
  )
    throw new ServiceError("invalid_request", 400);
  return input;
}

async function readBody(request, limit = 2048) {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new ServiceError("invalid_request", 415);
  if (Number(request.headers["content-length"]) > limit)
    throw new ServiceError("request_too_large", 413);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new ServiceError("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_request", 400);
  }
}

export function createHandler(config, budget, adapters, fees, trackedPrices, launches, fomo, tokenImages) {
  let active = 0;
  return async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    const send = (status, body) => {
      if (!response.destroyed) {
        response.statusCode = status;
        response.end(JSON.stringify(body));
      }
    };
    if (request.method === "GET" && request.url === "/healthz") return send(200, { status: "ok" });
    if (active >= 16) {
      response.setHeader("retry-after", "5");
      return send(429, { error: "busy" });
    }
    active += 1;
    const deadline = setTimeout(() => {
      request.destroy();
      response.destroy();
    }, 25_000);
    try {
      if (
        request.headers.origin !== config.origin ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new ServiceError("origin_denied", 403);
      const kind = ["o1-token-image", "fomo", "catalog", "ticker", "fees", "claim-prepare", "tracked-prices", "launch-prepare", "launch-reserve", "launch-status", "launch-estimate"].find(
        (operation) => request.url === `/v1/${operation}`,
      );
      if (!kind || request.method !== "POST" || request.headers["x-fungun-intent"] !== kind)
        throw new ServiceError("not_found", 404);
      // Forwarded headers are deliberately ignored; the durable global cap is authoritative.
      const ip = request.socket.remoteAddress;
      if (!ip || !isIP(ip)) throw new ServiceError("unavailable");
      budget.request(ip, kind === "ticker");
      const input = validateInput(kind, await readBody(request, kind.startsWith("launch-") ? 4096 : 2048));
      const value =
        kind === "o1-token-image" ? await tokenImages.get(input) :
        kind === "fomo" ? fomo.snapshot() :
        kind.startsWith("launch-")
          ? await launches.run(kind, input)
          : kind === "tracked-prices"
          ? await trackedPrices.list(input, {
              shouldContinue: () => !response.destroyed && !response.writableEnded,
            })
          : kind === "fees"
            ? await fees.list(input)
            : kind === "claim-prepare"
              ? await fees.prepare(input)
              : kind === "catalog"
                ? await adapters.catalog(input.chainId)
                : await adapters.ticker(input.chainId, input.ticker, input.pads);
      send(200, { ...value, serverTime: Date.now() });
    } catch (error) {
      const safe = safeError(error);
      if (safe.retryAfter) response.setHeader("retry-after", String(safe.retryAfter));
      if (safe.status === 429 && safe.retryScope === "operation")
        response.setHeader("x-fungun-retry-scope", "operation");
      send(safe.status, serviceErrorBody(safe));
    } finally {
      clearTimeout(deadline);
      active -= 1;
    }
  };
}
