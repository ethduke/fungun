import { isIP } from "node:net";
import { isAddress, zeroAddress } from "viem";
import { IMAGE_BYTE_LIMIT, validateImageInput } from "./launch-image.mjs";
import { normalizeLaunchDetails } from "./launch-metadata.mjs";
import { ServiceError, safeError } from "./errors.mjs";

const bodyLimit = Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 + 16384;
const messages = {
  asset_uploads_disabled:
    "Image publication is not available yet. Your image remains in your browser.",
  asset_approval_changed:
    "The image, coin details or wallet changed. Prepare a new preview before publishing.",
  asset_approval_expired: "This approval expired. Prepare a new preview and approve it again.",
  invalid_asset_approval:
    "The wallet approval could not be verified. Use the wallet shown in the preview.",
  asset_publication_uncertain:
    "Publication could not be confirmed. Do not approve another upload; contact support to check its status.",
  ipfs_approval_pending:
    "Finish or let the current image approval expire before preparing another one.",
  ipfs_publication_disabled:
    "IPFS publication is not available yet. Your image has not been uploaded.",
  ipfs_configuration:
    "IPFS publication is not configured. Your image has not been uploaded.",
  ipfs_verification_unavailable:
    "The IPFS files could not be verified yet. Keep this launch pending and check again later.",
  asset_integrity_failed:
    "The stored files could not be verified. Do not publish again; contact support.",
  invalid_launch_details: "Check the coin name, ticker and description before trying again.",
  request_too_large: "Choose an image no larger than 2 MiB.",
  asset_storage_full: "Image storage is temporarily full. Please try again later.",
  asset_history_full: "Publication is paused while storage history is reviewed. Please try again later.",
  rate_limited: "Too many requests. Please wait before trying again.",
  asset_busy: "Another image is being processed. Please try again shortly.",
  decoder_unavailable:
    "Image validation is temporarily unavailable. Your image has not been published.",
  image_animated: "Animated images are not supported yet. Choose a still image.",
  image_dimensions: "Use an image no larger than 4096 × 4096 pixels.",
  image_size: "Choose an image no larger than 2 MiB.",
  image_format: "Choose a valid PNG, JPEG, WebP or GIF image.",
  image_decode: "This image could not be decoded safely. Choose another file.",
  image_output_size: "The processed image is too large. Choose a smaller or simpler image.",
  image_timeout: "Image processing took too long. Choose a smaller image and try again.",
};
export function assetMessage(code) {
  return (
    messages[code] ??
    "This request could not be completed. Check your image and coin details before trying again."
  );
}

async function body(request) {
  if (
    request.headers["content-type"]?.split(";")[0] !== "application/json" ||
    request.headers["content-encoding"]
  )
    throw new ServiceError("invalid_request", 415);
  if (Number(request.headers["content-length"]) > bodyLimit)
    throw new ServiceError("request_too_large", 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) throw new ServiceError("request_too_large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("invalid_request", 400);
  }
}

export function validateAssetInput(kind, input) {
  if (kind === "status") {
    const fields = ["chainId", "wallet", "id", "imageHash", "metadataHash"];
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(input, key)) ||
      input.chainId !== 4663 ||
      typeof input.wallet !== "string" ||
      !isAddress(input.wallet) ||
      typeof input.id !== "string" ||
      !/^[a-f0-9]{48}$/.test(input.id) ||
      [input.imageHash, input.metadataHash].some(
        (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
      )
    )
      throw new ServiceError("invalid_request", 400);
    return input;
  }
  const fields =
    ["prepare", "launch-prepare"].includes(kind)
      ? ["chainId", "wallet", "draft", "imageBase64"]
      : ["chainId", "wallet", "draft", "imageBase64", "id", kind === "launch-publish" ? "uploadToken" : "signature"];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(input, key)) ||
    input.chainId !== 4663 ||
    typeof input.wallet !== "string" ||
    !isAddress(input.wallet) ||
    input.wallet.toLowerCase() === zeroAddress ||
    typeof input.imageBase64 !== "string" ||
    input.imageBase64.length > Math.ceil(IMAGE_BYTE_LIMIT / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.imageBase64)
  )
    throw new ServiceError("invalid_request", 400);
  const image = Buffer.from(input.imageBase64, "base64");
  if (
    !image.length ||
    image.length > IMAGE_BYTE_LIMIT ||
    image.toString("base64") !== input.imageBase64
  )
    throw new ServiceError("image_size", 400);
  return {
    image,
    draft: normalizeLaunchDetails(input.draft),
    wallet: input.wallet,
    ...(kind === "publish" ? { id: input.id, signature: input.signature } : {}),
    ...(kind === "launch-publish" ? { id: input.id, uploadToken: input.uploadToken } : {}),
  };
}

export function createAssetHandler(config, store, processor) {
  let active = 0;
  let preparing = false;
  return async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; sandbox");
    response.setHeader("referrer-policy", "no-referrer");
    const send = (status, value) => {
      if (response.destroyed) return;
      response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/healthz") return send(200, { status: "ok" });
    if (active >= 8) return send(429, { error: "asset_busy", message: assetMessage("asset_busy") });
    active += 1;
    let acquired = false;
    const deadline = setTimeout(() => {
      request.destroy();
      response.destroy();
    }, 15000);
    const done = () => {
      clearTimeout(deadline);
      active -= 1;
    };
    response.once("close", done);
    try {
      const ip = request.socket.remoteAddress;
      if (!ip || !isIP(ip)) throw new ServiceError("unavailable");
      store.budget.request(ip);
      if (["GET", "HEAD"].includes(request.method)) {
        const match = /^\/launch-assets\/([a-f0-9]{64}\.(?:webp|json))$/.exec(request.url);
        if (!match) throw new ServiceError("not_found", 404);
        const asset = store.read(match[1]);
        const unchanged = request.headers["if-none-match"] === `"${asset.hash}"`;
        if (!unchanged && request.method === "GET")
          store.budget.debit(
            [["asset-egress", 2048, 3600000]],
            Math.ceil(asset.bytes.length / 131072),
          );
        response.writeHead(unchanged ? 304 : 200, {
          "content-type": asset.mime,
          "content-length": asset.bytes.length,
          "cache-control": "public, max-age=31536000, immutable",
          etag: `"${asset.hash}"`,
          "access-control-allow-origin": "*",
        });
        return response.end(unchanged || request.method === "HEAD" ? undefined : asset.bytes);
      }
      if (
        request.method !== "POST" ||
        request.headers.origin !== config.appOrigin ||
        request.headers["sec-fetch-site"] === "cross-site"
      )
        throw new ServiceError("origin_denied", 403);
      const kind = request.url === "/v1/asset-launch-prepare" ? "launch-prepare"
        : request.url === "/v1/asset-launch-publish" ? "launch-publish" :
        request.url === "/v1/asset-prepare"
          ? "prepare"
          : request.url === "/v1/asset-publish"
            ? "publish"
            : request.url === "/v1/asset-status"
              ? "status"
              : null;
      if (!kind || request.headers["x-fungun-intent"] !== `asset-${kind}`)
        throw new ServiceError("not_found", 404);
      if (kind !== "status" && !config.uploadsEnabled)
        throw new ServiceError("asset_uploads_disabled");
      if (["prepare", "launch-prepare"].includes(kind)) {
        if (preparing) throw new ServiceError("asset_busy", 429, 2);
        preparing = acquired = true;
      }
      const input = validateAssetInput(kind, await body(request));
      if (kind === "status") return send(200, await store.status(input));
      if (["publish", "launch-publish"].includes(kind)) {
        const result = await (kind === "launch-publish" ? store.launchPublish(input) : store.publish(input));
        return send(result.status === "processing" ? 202 : 200, result);
      }
      validateImageInput(input.image);
      store.budget.debit([
        ["image-decodes", 60, 86400000],
        ["image-decodes", 6, 60000],
      ]);
      const image = await processor.process(input.image);
      if (response.destroyed) return;
      const challenge = await (kind === "launch-prepare" ? store.launchChallenge(input.wallet, image.bytes, input.draft) : store.challenge(input.wallet, image.bytes, input.draft));
      send(200, {
        ...challenge,
        imageBase64: image.bytes.toString("base64"),
        width: image.width,
        height: image.height,
        serverTime: store.clock(),
      });
    } catch (error) {
      const safe = safeError(error);
      if (safe.retryAfter) response.setHeader("retry-after", String(safe.retryAfter));
      send(safe.status, { error: safe.code, message: assetMessage(safe.code) });
    } finally {
      if (acquired) preparing = false;
    }
  };
}
