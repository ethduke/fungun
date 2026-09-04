import { isIP } from "node:net";
import { IMAGE_BYTE_LIMIT } from "./launch-image.mjs";
import { ServiceError } from "./errors.mjs";

const knownErrors = new Set([
  "image_size",
  "image_format",
  "image_dimensions",
  "image_animated",
  "image_decode",
  "image_timeout",
  "image_output_size",
]);

export function canonicalClient(value) {
  if (typeof value !== "string" || !isIP(value) || value.includes("%"))
    throw new ServiceError("invalid_decoder_configuration");
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
}

export function createDecoderHandler(allowedClient, processor) {
  const peer = canonicalClient(allowedClient);
  let active = false;
  return async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const fail = (status, code) => {
      if (response.destroyed) return;
      response.writeHead(status, { "x-image-error": code, connection: "close" });
      response.end();
    };
    if (!request.socket.remoteAddress || canonicalClient(request.socket.remoteAddress) !== peer)
      return fail(403, "image_decode");
    if (request.method !== "POST" || request.url !== "/decode") return fail(404, "image_decode");
    if (active) return fail(429, "image_busy");
    if (
      request.headers["content-type"] !== "application/octet-stream" ||
      request.headers["content-encoding"]
    )
      return fail(415, "image_format");
    if (Number(request.headers["content-length"]) > IMAGE_BYTE_LIMIT)
      return fail(413, "image_size");
    active = true;
    const deadline = setTimeout(() => {
      request.destroy();
      response.destroy();
    }, 8000);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > IMAGE_BYTE_LIMIT) throw new ServiceError("image_size", 413);
        chunks.push(chunk);
      }
      const image = await processor.process(Buffer.concat(chunks));
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "image/webp",
        "content-length": image.bytes.length,
        "x-image-width": image.width,
        "x-image-height": image.height,
        "x-image-sha256": image.sha256,
      });
      response.end(image.bytes);
    } catch (error) {
      fail(
        error instanceof ServiceError ? error.status : 400,
        knownErrors.has(error?.code) ? error.code : "image_decode",
      );
    } finally {
      clearTimeout(deadline);
      active = false;
    }
  };
}
