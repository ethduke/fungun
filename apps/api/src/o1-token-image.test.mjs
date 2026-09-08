import assert from "node:assert/strict";
import test from "node:test";
import { O1TokenImages, o1ImageUrl, validateTokenImageInput } from "./o1-token-image.mjs";
import { Upstream } from "./upstream.mjs";

const address = `0x${"a".repeat(40)}`;
const input = { chainId: 4663, address };
const url = `https://sapphire-negative-junglefowl-959.mypinata.cloud/ipfs/b${"a".repeat(58)}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1cAAAAASUVORK5CYII=", "base64");

function fixture({ data = { chain_id: 4663, token: { address, image_url: url } }, image,
  config = { readsEnabled: true, o1Key: "EXAMPLE" } } = {}) {
  let now = 1000;
  const calls = [], debits = [];
  const fetcher = async (target, options) => {
    calls.push({ target, options });
    if (String(target).startsWith("https://api.launch.o1.exchange/")) return Response.json({ data });
    return image ? image() : new Response(png, { headers: { "content-type": "image/png" } });
  };
  const upstream = new Upstream({ upstream: provider => debits.push(provider) }, fetcher);
  const images = new O1TokenImages(config, upstream, fetcher, () => now);
  return { images, calls, debits, upstream, advance: ms => { now += ms; } };
}

test("O1 resolves exact identity, fetches bounded image bytes without API credentials, and shares cache", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.images.get(input), f.images.get(input)]);
  assert.deepEqual(first, { ...input, mime: "image/png", size: png.length, base64: png.toString("base64") });
  assert.deepEqual(second, first);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].target, `https://api.launch.o1.exchange/v1/tokens/4663/${address}`);
  assert.equal(f.calls[0].options.headers["x-api-key"], "EXAMPLE");
  assert.deepEqual(f.calls[1].options.headers, { accept: "image/png,image/jpeg,image/webp,image/gif" });
  assert.equal(f.calls[1].options.credentials, "omit");
  assert.equal(f.calls[1].options.redirect, "error");
  assert.deepEqual(f.debits, ["o1", "o1"]);
  await f.images.get(input);
  assert.equal(f.calls.length, 2);
  f.advance(300001);
  await f.images.get(input);
  assert.equal(f.calls.length, 4);
  assert.equal(f.upstream.active, 0);
});

test("only Robinhood token addresses are accepted; no arbitrary URL or calldata inputs", () => {
  for (const value of [null, [], {}, { ...input, chainId: 8453 }, { ...input, url },
    { ...input, address: "bad" }, { ...input, pad: "long" }])
    assert.throws(() => validateTokenImageInput(value), { code: "invalid_request" });
  assert.deepEqual(validateTokenImageInput({ ...input, address: address.toUpperCase().replace("0X", "0x") }), input);
});

test("metadata cannot direct requests to arbitrary hosts, credentials, query strings, or redirect paths", async () => {
  for (const value of [null, "http://127.0.0.1", url.replace("https:", "http:"),
    url.replace(".mypinata.cloud", ".mypinata.cloud.example.invalid"), `${url}?token=EXAMPLE`,
    `${url}#fragment`, url.replace("/ipfs/", "/other/"), url.replace("https://", "https://EXAMPLE@")])
    assert.throws(() => o1ImageUrl(value), { code: "image_unavailable" });
  for (const data of [{ chain_id: 8453, token: { address, image_url: url } },
    { chain_id: 4663, token: { address: `0x${"b".repeat(40)}`, image_url: url } },
    { chain_id: 4663, token: { address, image_url: null } }]) {
    const f = fixture({ data });
    await assert.rejects(f.images.get(input), { code: "image_unavailable" });
    assert.equal(f.calls.length, 1);
  }
});

test("missing, spoofed, redirected and oversized images fail and release admission", async () => {
  for (const image of [
    () => new Response("missing", { status: 404 }),
    () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response("not png", { headers: { "content-type": "image/png" } }),
    () => new Response(png, { headers: { "content-type": "image/png", "content-length": String(2 ** 22) } }),
    () => new Response(new Uint8Array(2 ** 21 + 1), { headers: { "content-type": "image/png" } }),
    () => Object.defineProperty(new Response(png, { headers: { "content-type": "image/png" } }), "redirected", { value: true }),
  ]) {
    const f = fixture({ image });
    await assert.rejects(f.images.get(input));
    assert.equal(f.upstream.active, 0);
    await assert.rejects(f.images.get(input));
    assert.equal(f.calls.length, 2, "failure cache prevents repeated downloads");
  }
});

test("disabled or unconfigured reads never contact O1", async () => {
  for (const config of [{ readsEnabled: false, o1Key: "EXAMPLE" }, { readsEnabled: true }]) {
    const f = fixture({ config });
    await assert.rejects(f.images.get(input), { code: "not_configured" });
    assert.equal(f.calls.length, 0);
  }
});
