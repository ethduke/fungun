import { createHash } from "node:crypto";
import {
  IMAGE_BYTE_LIMIT,
  IMAGE_SIDE_LIMIT,
  rasterFormat,
  validateImageInput,
} from "./launch-image.mjs";
import { ServiceError } from "./errors.mjs";

export class AssetDecoder {
  constructor(origin, fetcher = fetch) {
    if (
      typeof origin !== "string" ||
      !/^http:\/\/[a-z][a-z0-9-]{0,62}\.internal:8791$/.test(origin)
    )
      throw new ServiceError("invalid_decoder_configuration");
    this.origin = origin;
    this.fetcher = fetcher;
  }
  async process(bytes) {
    const input = validateImageInput(bytes);
    try {
      const response = await this.fetcher(`${this.origin}/decode`, {
        method: "POST",
        body: input,
        headers: { "content-type": "application/octet-stream" },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const reason = response.headers.get("x-image-error");
        await response.body?.cancel();
        if (
          [
            "image_size",
            "image_format",
            "image_dimensions",
            "image_animated",
            "image_decode",
            "image_timeout",
            "image_output_size",
          ].includes(reason)
        )
          throw new ServiceError(reason, 400);
        throw new ServiceError("decoder_unavailable");
      }
      if (
        response.headers.get("content-type") !== "image/webp" ||
        Number(response.headers.get("content-length")) > IMAGE_BYTE_LIMIT
      ) {
        await response.body?.cancel();
        throw new ServiceError("decoder_unavailable");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > IMAGE_BYTE_LIMIT) throw new ServiceError("decoder_unavailable");
        chunks.push(chunk);
      }
      const image = Buffer.concat(chunks);
      const width = Number(response.headers.get("x-image-width"));
      const height = Number(response.headers.get("x-image-height"));
      if (
        !image.length ||
        rasterFormat(image) !== "webp" ||
        [width, height].some(
          (side) => !Number.isInteger(side) || side < 1 || side > IMAGE_SIDE_LIMIT,
        ) ||
        createHash("sha256").update(image).digest("hex") !== response.headers.get("x-image-sha256")
      )
        throw new ServiceError("decoder_unavailable");
      return { bytes: image, width, height };
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("decoder_unavailable");
    }
  }
}
