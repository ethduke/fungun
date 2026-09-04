import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ipfsContentId, ipfsUri, prepareLongIpfsAssets } from "./ipfs-content.mjs";
import { IMAGE_BYTE_LIMIT } from "./launch-image.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "A simple coin." };
const image = () => {
  const bytes = Buffer.alloc(32);
  bytes.write("RIFF"); bytes.writeUInt32LE(24, 4); bytes.write("WEBPVP8 ", 8);
  return bytes;
};
const rawCid = (bytes) => {
  const digest = createHash("sha256").update(bytes).digest();
  const bits = Array.from(Buffer.concat([Buffer.from([1, 85, 18, 32]), digest]),
    (byte) => byte.toString(2).padStart(8, "0")).join("").padEnd(290, "0");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return `b${bits.match(/.{5}/g).map((group) => alphabet[Number.parseInt(group, 2)]).join("")}`;
};

test("IPFS v1 raw CID matches independent SHA-256 encoding at the chunk boundary", async () => {
  for (const size of [1, 32, 262143, 262144]) {
    const bytes = Buffer.alloc(size, 7);
    assert.equal(await ipfsContentId(bytes), rawCid(bytes));
  }
});

test("multi-chunk files use reproducible UnixFS CIDs, not a raw whole-file hash", async () => {
  for (const size of [262145, IMAGE_BYTE_LIMIT - 1, IMAGE_BYTE_LIMIT]) {
    const bytes = Buffer.alloc(size, 7);
    const cid = await ipfsContentId(bytes);
    assert.match(cid, /^bafy[a-z2-7]+$/);
    assert.notEqual(cid, rawCid(bytes));
    assert.equal(cid, await ipfsContentId(Buffer.from(bytes)));
    bytes[size - 1] = 8;
    assert.notEqual(cid, await ipfsContentId(bytes));
  }
});

test("content calculation snapshots bytes before asynchronous hashing", async () => {
  const bytes = Buffer.alloc(262145, 7);
  const expected = await ipfsContentId(bytes);
  const pending = ipfsContentId(bytes);
  bytes.fill(8);
  assert.equal(await pending, expected);
});

test("Long's IPFS bundle binds both image fields without copying private fields", async () => {
  const result = await prepareLongIpfsAssets(image(), draft);
  const metadata = JSON.parse(result.metadata.bytes);
  assert.deepEqual(metadata, { name: "Moon", symbol: "MOON", description: draft.description,
    image: result.image.uri, image_hash: result.image.uri });
  assert.equal(result.metadata.uri, `ipfs://${await ipfsContentId(result.metadata.bytes)}`);
  assert.equal(result.image.sha256, createHash("sha256").update(result.image.bytes).digest("hex"));
  assert.equal(result.totalBytes, result.image.bytes.length + result.metadata.bytes.length);
  assert.equal(result.launchReady, false);
  assert.equal(result.schema, "long-ipfs-v1");
  assert.equal(result.profile, "pinata-v1-256k");
  assert.deepEqual(await prepareLongIpfsAssets(image(), { description: draft.description,
    ticker: draft.ticker, name: " Moon " }), result);
  for (const key of ["signature", "privateKey", "account", "filename", "image_hash", "fee_receiver", "categories"])
    await assert.rejects(prepareLongIpfsAssets(image(), { ...draft, [key]: "EXAMPLE" }));
});

test("changed details change metadata only; source buffers are never retained", async () => {
  const bytes = image();
  const pending = prepareLongIpfsAssets(bytes, draft);
  bytes.fill(0);
  const result = await pending;
  assert.deepEqual(result.image.bytes, image());
  const changed = await prepareLongIpfsAssets(image(), { ...draft, name: "Sun" });
  assert.equal(result.image.cid, changed.image.cid);
  assert.notEqual(result.metadata.cid, changed.metadata.cid);
});

test("invalid content and URI forms cannot become upload destinations", async () => {
  for (const bytes of [null, "data", new Uint8Array(8), Buffer.alloc(0), Buffer.alloc(IMAGE_BYTE_LIMIT + 1)])
    await assert.rejects(ipfsContentId(bytes));
  for (const bytes of [null, "data", Buffer.from("bad"), Buffer.alloc(IMAGE_BYTE_LIMIT + 1)])
    await assert.rejects(prepareLongIpfsAssets(bytes, draft));
  const cid = await ipfsContentId(image());
  assert.equal(ipfsUri(cid), `ipfs://${cid}`);
  for (const bad of [null, "", `${cid}/file`, `${cid}?key=EXAMPLE`, `${cid}#fragment`,
    `https://example.com/${cid}`, `ipfs://${cid}`, cid.toUpperCase()]) assert.throws(() => ipfsUri(bad));
});
