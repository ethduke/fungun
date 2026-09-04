import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDecoderHandler, canonicalClient } from "./decoder-service.mjs";
import { verifyDecoderExecutable } from "./decoder-runtime.mjs";
import { LaunchImageProcessor, IMAGE_BYTE_LIMIT } from "./launch-image.mjs";
import sharp from "sharp";

async function serve(t, allowed, processor) {
  const server = createServer(createDecoderHandler(allowed, processor));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/decode`;
  return {
    url,
    send: (body, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body,
      }),
  };
}

test("decoder canonicalizes peers but never trusts mapped IPs or forwarding headers", async (t) => {
  assert.equal(canonicalClient("FDAA:0:0:0:0:0:0:1"), "fdaa::1");
  assert.notEqual(canonicalClient("::ffff:127.0.0.1"), canonicalClient("127.0.0.1"));
  for (const invalid of ["", undefined, "example.com", "fdaa::1%eth0"])
    assert.throws(() => canonicalClient(invalid));
  const { send } = await serve(t, "192.0.2.1", {
    process() {
      assert.fail("Denied peer reached decoder");
    },
  });
  const denied = await send(Buffer.from("not an image"), {
    "fly-client-ip": "192.0.2.1",
    "x-forwarded-for": "192.0.2.1",
  });
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), "");
});

test("decoder serves safe WebP only and rejects malformed, animated and unsupported bodies", async (t) => {
  const { url, send } = await serve(t, "127.0.0.1", new LaunchImageProcessor());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const good = await send(image);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("content-type"), "image/webp");
  assert.equal(good.headers.get("x-image-width"), "8");
  assert.equal((await sharp(Buffer.from(await good.arrayBuffer())).metadata()).format, "webp");
  const malformed = await send(Buffer.from("not an image"));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("x-image-error"), "image_format");
  assert.equal(await malformed.text(), "");
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await send(image, { "content-encoding": "gzip" })).status, 415);
  assert.equal((await send(image, { "content-type": "application/json" })).status, 415);
  assert.equal((await send(Buffer.alloc(IMAGE_BYTE_LIMIT + 1))).status, 413);
  assert.equal((await send(image)).status, 200);
});

test("decoder rejects chunked overflow before native processing", async (t) => {
  const { url } = await serve(t, "127.0.0.1", {
    process() {
      assert.fail("Oversized body reached decoder");
    },
  });
  const outcome = await new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "POST", headers: { "content-type": "application/octet-stream" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", (error) =>
      error.code === "ECONNRESET" ? resolve("closed") : reject(error),
    );
    request.write(Buffer.alloc(IMAGE_BYTE_LIMIT));
    request.end(Buffer.alloc(1));
  });
  assert.ok([413, "closed"].includes(outcome));
});

test("decoder busy state is held through work and releases after a failure", async (t) => {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const { send } = await serve(t, "127.0.0.1", {
    async process() {
      calls++;
      enter();
      await pending;
      throw new Error("synthetic private detail");
    },
  });
  const first = send(Buffer.from("image"));
  await entered;
  const second = await send(Buffer.from("image"));
  assert.equal(second.status, 429);
  assert.equal(calls, 1);
  release();
  const failed = await first;
  assert.equal(failed.headers.get("x-image-error"), "image_decode");
  assert.equal(await failed.text(), "");
  assert.equal((await send(Buffer.from("image"))).status, 400);
  assert.equal(calls, 2);
});

test("decoder executable check refuses non-PIE, executable stack and malformed ELF", (t) => {
  const root = mkdtempSync(join(tmpdir(), "fungun-decoder-elf-"));
  t.after(() => rmSync(root, { recursive: true }));
  const path = join(root, "synthetic-elf");
  const bytes = Buffer.alloc(120);
  Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(0x6474e551, 64);
  bytes.writeUInt32LE(6, 68);
  writeFileSync(path, bytes);
  assert.doesNotThrow(() => verifyDecoderExecutable(path));
  bytes.writeUInt16LE(2, 16);
  writeFileSync(path, bytes);
  assert.throws(() => verifyDecoderExecutable(path));
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt32LE(7, 68);
  writeFileSync(path, bytes);
  assert.throws(() => verifyDecoderExecutable(path));
  writeFileSync(path, bytes.subarray(0, 80));
  assert.throws(() => verifyDecoderExecutable(path));
});
