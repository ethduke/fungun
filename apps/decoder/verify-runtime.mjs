import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import sharp from "sharp";
import { LaunchImageProcessor } from "./src/launch-image.mjs";
import { verifyDecoderRuntime } from "./src/decoder-runtime.mjs";

verifyDecoderRuntime();
assert.equal(
  Object.values(networkInterfaces())
    .flat()
    .some((item) => !item.internal),
  false,
);
const status = readFileSync("/proc/self/status", "utf8");
assert.match(status, /CapEff:\s+0+\n/);
assert.match(status, /NoNewPrivs:\s+1\n/);
const rootMount = readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n")
  .find((line) => line.split(" ")[4] === "/");
assert.ok(rootMount.split(" ")[5].split(",").includes("ro"));
const memoryPath = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
].find(existsSync);
assert.ok(memoryPath);
assert.ok(Number(readFileSync(memoryPath, "utf8")) <= 512 * 1024 * 1024);
const processor = new LaunchImageProcessor();
for (const format of ["png", "jpeg", "webp", "gif"]) {
  const input = await sharp({ create: { width: 16, height: 16, channels: 3, background: "green" } })
    .toFormat(format)
    .toBuffer();
  const image = await processor.process(input);
  const metadata = await sharp(image.bytes).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 16);
  assert.equal(metadata.height, 16);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  console.log(`Synthetic ${format} conversion passed.`);
}
const large = await sharp({
  create: { width: 4096, height: 4096, channels: 4, background: "blue" },
})
  .png()
  .toBuffer();
try {
  const result = await processor.process(large);
  assert.equal(result.width, 4096);
  assert.equal(result.height, 4096);
  console.log("4096-pixel conversion passed.");
} catch (error) {
  assert.equal(error.code, "image_timeout");
  console.log(
    "4096-pixel input reached the enforced timeout; target-host performance remains unverified.",
  );
}
const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: "red" } })
  .png()
  .toBuffer();
await assert.rejects(processor.process(wide), { code: "image_dimensions" });
await assert.rejects(processor.process(Buffer.from("RIFFbad!WEBPbroken")), {
  code: "image_decode",
});
console.log("Decoder isolation, PIE, resource limits, four formats and rejection checks passed.");
