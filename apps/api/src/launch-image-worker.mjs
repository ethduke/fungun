import sharp from "sharp";
import { pathToFileURL } from "node:url";
import {
  IMAGE_BYTE_LIMIT,
  IMAGE_SIDE_LIMIT,
  rasterFormat,
  validateImageInput,
} from "./launch-image.mjs";
import { ServiceError } from "./errors.mjs";

function rejectAnimatedPng(bytes) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new ServiceError("image_decode", 400);
    const kind = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (kind === "acTL") throw new ServiceError("image_animated", 400);
    offset += length + 12;
    if (kind === "IEND") return;
  }
  throw new ServiceError("image_decode", 400);
}

export async function decodeLaunchImage(input) {
  const bytes = validateImageInput(input);
  const format = rasterFormat(bytes);
  if (format === "png") rejectAnimatedPng(bytes);
  const image = sharp(bytes, {
    failOn: "warning",
    limitInputPixels: IMAGE_SIDE_LIMIT ** 2,
    limitInputChannels: 4,
    pages: 1,
  });
  try {
    const metadata = await image.metadata();
    if (metadata.format !== format) throw new ServiceError("image_format", 400);
    if ((metadata.pages ?? 1) !== 1) throw new ServiceError("image_animated", 400);
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > IMAGE_SIDE_LIMIT ||
      metadata.height > IMAGE_SIDE_LIMIT
    )
      throw new ServiceError("image_dimensions", 400);
    const { data, info } = await image
      .autoOrient()
      .toColourspace("srgb")
      .webp({ quality: 90, alphaQuality: 100, effort: 2 })
      .timeout({ seconds: 3 })
      .toBuffer({ resolveWithObject: true });
    if (!data.length || data.length > IMAGE_BYTE_LIMIT)
      throw new ServiceError("image_output_size", 400);
    return { bytes: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error?.message === "Input image exceeds pixel limit")
      throw new ServiceError("image_dimensions", 400);
    if (typeof error?.message === "string" && /^timeout: \d+% complete/.test(error.message))
      throw new ServiceError("image_timeout", 400);
    throw new ServiceError("image_decode", 400);
  } finally {
    image.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sharp.cache(false);
  sharp.concurrency(1);
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > IMAGE_BYTE_LIMIT) throw new ServiceError("image_size", 400);
      chunks.push(chunk);
    }
    const result = await decodeLaunchImage(Buffer.concat(chunks));
    writeResult({ width: result.width, height: result.height }, result.bytes);
  } catch (error) {
    writeResult({ error: error instanceof ServiceError ? error.code : "image_decode" });
    process.exitCode = 1;
  }
}

function writeResult(header, bytes = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(header));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  process.stdout.write(Buffer.concat([size, json, bytes]));
}
