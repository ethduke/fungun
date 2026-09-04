import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { IMAGE_BYTE_LIMIT, LaunchImageProcessor, imageErrorMessage } from "./launch-image.mjs";
import { decodeLaunchImage } from "./launch-image-worker.mjs";

const raster = () =>
  sharp({
    create: {
      width: 24,
      height: 16,
      channels: 4,
      background: { r: 100, g: 180, b: 20, alpha: 1 },
    },
  });

test("launch images fully decode PNG, JPEG, WebP and still GIF into stripped WebP", async () => {
  const processor = new LaunchImageProcessor();
  for (const format of ["png", "jpeg", "webp", "gif"]) {
    const input = await raster()[format]().toBuffer();
    const result = await processor.process(input);
    const decoded = await sharp(result.bytes).metadata();
    assert.equal(decoded.format, "webp");
    assert.equal(result.width, 24);
    assert.equal(result.height, 16);
    assert.equal(result.mime, "image/webp");
    assert.match(result.sha256, /^[a-f\d]{64}$/);
    assert.equal(decoded.exif, undefined);
    assert.equal(decoded.xmp, undefined);
    assert.equal(decoded.icc, undefined);
  }
});

test("orientation is applied before camera metadata is removed", async () => {
  const input = await raster().withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await new LaunchImageProcessor().process(input);
  assert.equal(result.width, 16);
  assert.equal(result.height, 24);
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.orientation, undefined);
  assert.equal(metadata.exif, undefined);
});

test("launch image processing refuses paths, URLs, unsupported files and size overflow", async () => {
  const processor = new LaunchImageProcessor();
  for (const input of [
    "/private/local.webp",
    "https://example.com/image.png",
    {},
    Buffer.from("<svg/>"),
  ])
    await assert.rejects(processor.process(input), { code: "image_format" });
  for (const input of [Buffer.alloc(0), Buffer.alloc(IMAGE_BYTE_LIMIT + 1)])
    await assert.rejects(processor.process(input), { code: "image_size" });
});

test("valid headers do not bypass full image decoding", async () => {
  const input = await raster().jpeg().toBuffer();
  await assert.rejects(new LaunchImageProcessor().process(input.subarray(0, 40)), {
    code: "image_decode",
  });
  const corrupt = await raster().png().toBuffer();
  await assert.rejects(decodeLaunchImage(corrupt.subarray(0, corrupt.length - 15)), {
    code: "image_decode",
  });
});

test("oversized dimensions and animated GIF, WebP and PNG are rejected explicitly", async () => {
  const wide = await sharp({
    create: {
      width: 4097,
      height: 1,
      channels: 3,
      background: "red",
    },
  })
    .png()
    .toBuffer();
  await assert.rejects(new LaunchImageProcessor().process(wide), { code: "image_dimensions" });
  const largeArea = await sharp({
    create: {
      width: 4097,
      height: 4097,
      channels: 3,
      background: "red",
    },
  })
    .png()
    .toBuffer();
  await assert.rejects(new LaunchImageProcessor().process(largeArea), { code: "image_dimensions" });
  const pixels = Buffer.alloc(8 * 4 * 3, 90);
  pixels.fill(190, 8 * 2 * 3);
  for (const format of ["gif", "webp"]) {
    const animated = await sharp(pixels, {
      raw: { width: 8, height: 4, channels: 3, pageHeight: 2 },
    })
      [format]({ loop: 0, delay: [100, 100] })
      .toBuffer();
    assert.equal((await sharp(animated).metadata()).pages, 2);
    await assert.rejects(new LaunchImageProcessor().process(animated), { code: "image_animated" });
  }
  const png = await raster().png().toBuffer();
  const animation = Buffer.alloc(20);
  animation.writeUInt32BE(8);
  animation.write("acTL", 4);
  await assert.rejects(
    decodeLaunchImage(Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)])),
    {
      code: "image_animated",
    },
  );
});

test("image conversions have no work queue and release admission after failure", async () => {
  const processor = new LaunchImageProcessor();
  const input = await raster().png().toBuffer();
  const first = processor.process(input);
  await assert.rejects(processor.process(input), { code: "image_busy", retryAfter: 2 });
  await first;
  await assert.rejects(processor.process(Buffer.from([255, 216, 255])), { code: "image_decode" });
  assert.ok((await processor.process(input)).bytes.length);
});

test("decoder workers inherit no credentials, discard raw diagnostics and have bounded lifetimes", () => {
  const source = readFileSync(new URL("./launch-image.mjs", import.meta.url), "utf8");
  assert.match(source, /env: \{\}/);
  assert.match(source, /stdio: \["pipe", "pipe", "ignore"\]/);
  assert.match(source, /6000/);
  assert.match(source, /SIGKILL/);
  assert.equal(
    imageErrorMessage({ message: "EXAMPLE", code: "unknown" }),
    "This image could not be decoded safely. Choose another file.",
  );
  assert.match(imageErrorMessage({ code: "image_animated" }), /still image/);
});
