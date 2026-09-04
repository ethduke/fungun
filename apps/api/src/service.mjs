import { isIP } from "node:net";
import { ServiceError, safeError } from "./errors.mjs";

export function validateInput(kind, input) {
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
        (pad) => !["long", "o1"].includes(pad) || (pad === "long" && input.chainId !== 4663),
      ) ||
      (input.pads.includes("long") && !/^[A-Z]{1,11}$/.test(input.ticker)))
  )
    throw new ServiceError("invalid_request", 400);
  return input;
}

async function readBody(request) {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new ServiceError("invalid_request", 415);
  if (Number(request.headers["content-length"]) > 2048)
    throw new ServiceError("request_too_large", 413);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2048) throw new ServiceError("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_request", 400);
  }
}

export function createHandler(config, budget, adapters) {
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
      const kind =
        request.url === "/v1/catalog" ? "catalog" : request.url === "/v1/ticker" ? "ticker" : null;
      if (!kind || request.method !== "POST" || request.headers["x-fungun-intent"] !== kind)
        throw new ServiceError("not_found", 404);
      // Forwarded headers are deliberately ignored; the durable global cap is authoritative.
      const ip = request.socket.remoteAddress;
      if (!ip || !isIP(ip)) throw new ServiceError("unavailable");
      budget.request(ip, kind === "ticker");
      const input = validateInput(kind, await readBody(request));
      const value =
        kind === "catalog"
          ? await adapters.catalog(input.chainId)
          : await adapters.ticker(input.chainId, input.ticker, input.pads);
      send(200, { ...value, serverTime: Date.now() });
    } catch (error) {
      const safe = safeError(error);
      if (safe.retryAfter) response.setHeader("retry-after", String(safe.retryAfter));
      send(safe.status, { error: safe.code });
    } finally {
      clearTimeout(deadline);
      active -= 1;
    }
  };
}
