import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ServiceError } from "./errors.mjs";

export const IMAGE_BYTE_LIMIT = 2 * 1024 * 1024;
export const IMAGE_SIDE_LIMIT = 4096;
const worker = fileURLToPath(new URL("./launch-image-worker.mjs", import.meta.url));
const messages = Object.freeze({
  image_size: "Choose an image no larger than 2 MiB.",
  image_format: "Choose a valid PNG, JPEG, WebP or GIF image.",
  image_dimensions: "Use an image no larger than 4096 × 4096 pixels.",
  image_animated: "Animated images are not supported yet. Choose a still image.",
  image_decode: "This image could not be decoded safely. Choose another file.",
  image_output_size: "This image is too large after processing. Choose a simpler or smaller image.",
  image_timeout: "Image processing took too long. Choose a smaller image and try again.",
  image_busy: "Another image is being checked. Please try again shortly.",
});

export function imageErrorMessage(error) {
  return messages[error?.code] ?? messages.image_decode;
}

export function rasterFormat(bytes) {
  const start = (signature) => bytes.subarray(0, signature.length).equals(signature);
  if (start(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (start(Buffer.from([255, 216, 255]))) return "jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "webp";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "gif";
  return null;
}

export function validateImageInput(input) {
  if (!(input instanceof Uint8Array)) throw new ServiceError("image_format", 400);
  if (!input.byteLength || input.byteLength > IMAGE_BYTE_LIMIT)
    throw new ServiceError("image_size", 400);
  const bytes = Buffer.from(input);
  if (!rasterFormat(bytes)) throw new ServiceError("image_format", 400);
  return bytes;
}

function parseWorkerResult(chunks, code) {
  const output = Buffer.concat(chunks);
  if (output.length < 4) throw new ServiceError("image_decode", 400);
  const length = output.readUInt32BE(0);
  if (length > 256 || length + 4 > output.length) throw new ServiceError("image_decode", 400);
  let header;
  try {
    header = JSON.parse(output.subarray(4, 4 + length).toString("utf8"));
  } catch {
    throw new ServiceError("image_decode", 400);
  }
  if (code !== 0) {
    const reason = Object.hasOwn(messages, header?.error) ? header.error : "image_decode";
    throw new ServiceError(reason, 400);
  }
  const bytes = output.subarray(4 + length);
  if (
    !bytes.length ||
    bytes.length > IMAGE_BYTE_LIMIT ||
    rasterFormat(bytes) !== "webp" ||
    !Number.isInteger(header.width) ||
    !Number.isInteger(header.height) ||
    header.width < 1 ||
    header.height < 1 ||
    header.width > IMAGE_SIDE_LIMIT ||
    header.height > IMAGE_SIDE_LIMIT
  )
    throw new ServiceError("image_decode", 400);
  return Object.freeze({
    bytes,
    mime: "image/webp",
    width: header.width,
    height: header.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export class LaunchImageProcessor {
  #busy = false;

  async process(input) {
    if (this.#busy) throw new ServiceError("image_busy", 429, 2);
    const bytes = validateImageInput(input);
    this.#busy = true;
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--max-old-space-size=96", worker], {
          env: {},
          stdio: ["pipe", "pipe", "ignore"],
          cwd: fileURLToPath(new URL("../", import.meta.url)),
        });
        const chunks = [];
        let length = 0;
        let failure;
        const stop = (reason) => {
          failure ??= new ServiceError(reason, 400);
          child.kill("SIGKILL");
        };
        const timer = setTimeout(() => stop("image_timeout"), 6000);
        child.stdout.on("data", (chunk) => {
          length += chunk.length;
          if (length > IMAGE_BYTE_LIMIT + 260) stop("image_output_size");
          else chunks.push(chunk);
        });
        child.stdin.on("error", () => stop("image_decode"));
        child.once("error", () => {
          failure ??= new ServiceError("image_decode", 400);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (failure) return reject(failure);
          try {
            resolve(parseWorkerResult(chunks, code));
          } catch (error) {
            reject(error);
          }
        });
        child.stdin.end(bytes);
      });
    } finally {
      this.#busy = false;
    }
  }
}
