import { createHash } from "node:crypto";
import { ServiceError } from "./errors.mjs";
import { buildGrokImageRequest, GROK_IMAGE_PROMPT_VERSION } from "./image-prompt.mjs";
import { IMAGE_BYTE_LIMIT, rasterFormat } from "./launch-image.mjs";

// Verified against OpenRouter's image models and endpoint metadata on 2026-09-04.
// https://openrouter.ai/docs/guides/overview/multimodal/image-generation
// https://openrouter.ai/api/v1/images/models/x-ai/grok-imagine-image-2.0/endpoints
export const GROK_IMAGE_MODEL = "x-ai/grok-imagine-image-2.0";
export const GROK_IMAGE_PRODUCT = `openrouter-grok-image-2.0-square-1k-low-${GROK_IMAGE_PROMPT_VERSION}`;
export const GROK_IMAGE_ENDPOINT = "https://openrouter.ai/api/v1/images";
export const GROK_IMAGE_TIMEOUT_MS = 180_000;
export const GROK_IMAGE_RESPONSE_LIMIT = Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 + 64 * 1024;

const invalidResponse = () => new ServiceError("image_provider_response_invalid", 502);
const unknownOutcome = () => new ServiceError("image_outcome_unknown", 502);
const mimeTypes = Object.freeze({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp" });

function cancel(body) {
  // Cancellation must not extend the request deadline or expose provider details.
  try {
    void Promise.resolve(body?.cancel()).catch(() => {});
  } catch {}
}

async function readResult(response, deadline) {
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const declaredLength = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > GROK_IMAGE_RESPONSE_LIMIT))
  ) {
    cancel(response.body);
    throw invalidResponse();
  }
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > GROK_IMAGE_RESPONSE_LIMIT) throw invalidResponse();
      chunks.push(Buffer.from(value));
    }
    try {
      return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch {
      throw invalidResponse();
    }
  } finally {
    cancel(reader);
    reader.releaseLock();
  }
}

function decodeResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    result.error ||
    !Array.isArray(result.data) ||
    result.data.length !== 1
  )
    throw invalidResponse();
  const item = result.data[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidResponse();
  if (item.respect_moderation === false) throw new ServiceError("image_filtered", 422);

  // OpenRouter's Image API returns b64_json. Also accept an inline data URI,
  // without ever fetching a provider-controlled URL or following redirects.
  let base64 = item.b64_json;
  let declaredMime = item.media_type;
  if (typeof base64 !== "string" && typeof item.url === "string") base64 = item.url;
  if (typeof base64 !== "string" || base64.length > GROK_IMAGE_RESPONSE_LIMIT)
    throw invalidResponse();
  if (base64.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(base64);
    if (!match || (declaredMime !== undefined && declaredMime !== match[1]))
      throw invalidResponse();
    declaredMime = match[1];
    base64 = base64.slice(match[0].length);
  }
  if (!base64.length || base64.length > Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4)
    throw invalidResponse();
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > IMAGE_BYTE_LIMIT || bytes.toString("base64") !== base64)
    throw invalidResponse();
  const mime = mimeTypes[rasterFormat(bytes)];
  if (!mime || (declaredMime !== undefined && declaredMime !== mime)) throw invalidResponse();
  // Signature checks only. The asset service must decode and sanitize these
  // bytes before storing/publishing them; no original provider URL is retained.
  return Object.freeze({
    bytes,
    mime,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    model: GROK_IMAGE_MODEL,
  });
}

export function createGrokImageProvider({
  apiKey = "",
  fetcher = fetch,
  timeoutMs = GROK_IMAGE_TIMEOUT_MS,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > GROK_IMAGE_TIMEOUT_MS)
    throw new TypeError("Invalid image provider deadline");
  const configured =
    typeof apiKey === "string" &&
    apiKey.trim().length > 0 &&
    apiKey.length <= 4096 &&
    !/\p{Cc}/u.test(apiKey) &&
    typeof fetcher === "function";
  return Object.freeze({
    configured,
    model: GROK_IMAGE_MODEL,
    product: GROK_IMAGE_PRODUCT,
    async generate(input) {
      const { prompt } = buildGrokImageRequest(input);
      if (!configured) throw new ServiceError("image_service_not_configured", 503);
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(unknownOutcome());
          controller.abort();
        }, timeoutMs);
      });
      try {
        // There is deliberately one POST and no retry: only the paid job ledger
        // may decide how to resolve an interrupted or ambiguous generation.
        const pending = Promise.resolve()
          .then(() =>
            fetcher(GROK_IMAGE_ENDPOINT, {
              method: "POST",
              redirect: "error",
              signal: controller.signal,
              headers: {
                ["Authorization"]: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              body: JSON.stringify({
                model: GROK_IMAGE_MODEL,
                prompt,
                n: 1,
                aspect_ratio: "1:1",
                resolution: "1K",
                quality: "low",
                stream: false,
                provider: { only: ["xai"], allow_fallbacks: false },
              }),
            }),
          )
          .then((response) => {
            if (controller.signal.aborted) {
              cancel(response.body);
              throw unknownOutcome();
            }
            return response;
          });
        const response = await Promise.race([pending, deadline]);
        if (!response.ok) {
          cancel(response.body);
          throw new ServiceError("image_provider_unavailable", response.status === 429 ? 503 : 502);
        }
        return decodeResult(await readResult(response, deadline));
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw unknownOutcome();
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
