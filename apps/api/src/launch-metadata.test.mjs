import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLongMetadata,
  normalizeLaunchDetails,
  validatePublishedUri,
} from "./launch-metadata.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "A simple coin." };
const origin = "https://assets.example.com";
const image = `${origin}/launch-assets/${"a".repeat(64)}.webp`;

test("Long metadata has canonical public fields and binds the published image", () => {
  const result = buildLongMetadata(draft, image, origin);
  assert.deepEqual(JSON.parse(result.bytes), {
    name: "Moon",
    symbol: "MOON",
    description: "A simple coin.",
    image,
  });
  assert.deepEqual(
    buildLongMetadata(
      { description: draft.description, ticker: "MOON", name: "Moon" },
      image,
      origin,
    ),
    result,
  );
  assert.notEqual(
    buildLongMetadata({ ...draft, name: "Sun" }, image, origin).sha256,
    result.sha256,
  );
  assert.notEqual(
    buildLongMetadata(draft, image.replace("a".repeat(64), "b".repeat(64)), origin).sha256,
    result.sha256,
  );
});

test("metadata does not copy unrelated request fields or hidden control characters", () => {
  for (const extra of [
    "account",
    "signature",
    "privateKey",
    "image",
    "tokenURI",
    "filename",
    "creator",
  ])
    assert.throws(() => buildLongMetadata({ ...draft, [extra]: "EXAMPLE" }, image, origin));
  for (const changed of [
    { ticker: "MO0N" },
    { ticker: "moon" },
    { ticker: "A".repeat(12) },
    { name: "" },
    { name: "A".repeat(51) },
    { name: "Moon\u202e" },
    { description: "x".repeat(2001) },
    { description: "x\u0000" },
  ])
    assert.throws(() => normalizeLaunchDetails({ ...draft, ...changed }));
  assert.equal(
    normalizeLaunchDetails({ ...draft, description: "Hello\nworld" }).description,
    "Hello\nworld",
  );
  assert.equal(
    normalizeLaunchDetails({ ...draft, description: "🌙".repeat(500) }).description.length,
    1000,
  );
  assert.throws(() => normalizeLaunchDetails({ ...draft, description: "🌙".repeat(501) }));
});

test("metadata references accept only content-addressed IPFS or exact configured asset paths", () => {
  const bytes = Buffer.concat([Buffer.from([1, 85, 18, 32]), Buffer.alloc(32)]);
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0"))
    .join("")
    .padEnd(290, "0");
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const cid = `b${bits
    .match(/.{5}/g)
    .map((group) => alphabet[Number.parseInt(group, 2)])
    .join("")}`;
  assert.equal(validatePublishedUri(`ipfs://${cid}`, "image"), `ipfs://${cid}`);
  assert.equal(validatePublishedUri(image, "image", origin), image);
  for (const uri of [
    "file:///private/image.webp",
    "data:image/png;base64,EXAMPLE",
    "https://other.example.com/image.webp",
    `${image}?key=EXAMPLE`,
    `${image}#x`,
    image.replace(".webp", ".svg"),
    image.replace("/launch-assets/", "/launch-assets/../launch-assets/"),
    `ipfs://${cid}/other`,
    `ipfs://${cid}?x=1`,
    `ipfs://b${"a".repeat(58)}`,
    `ipfs://${cid.slice(0, -1)}b`,
    image.toUpperCase(),
  ])
    assert.throws(() => validatePublishedUri(uri, "image", origin));
  assert.throws(() => validatePublishedUri(image, "metadata", origin));
});

test('optional HTTPS links preserve canonical metadata bytes across server and portable encoder', async () => {
  const { buildLongMetadata: portable } = await import('../../web/lib/long-encoding/launch-metadata.mjs');
  const origin='https://assets.example';
  const uri=origin+'/launch-assets/'+'a'.repeat(64)+'.webp';
  const details={name:'Coin',ticker:'COIN',website:'https://example.com/',twitter:'https://x.com/example'};
  const server=buildLongMetadata(details,uri,origin);
  assert.deepEqual(server.bytes,portable(details,uri,origin).bytes);
  assert.equal(server.sha256,portable(details,uri,origin).sha256);
  assert.equal(JSON.parse(server.bytes).website,details.website);
  for (const website of ['http://example.com',new URL('https://example.com').href.replace('://', '://' + ['user', 'pass'].join(':') + '@'),'https://example.com/\n']) assert.throws(()=>buildLongMetadata({...details,website},uri,origin));
});
