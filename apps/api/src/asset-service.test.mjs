import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { createAssetHandler, validateAssetInput } from "./asset-service.mjs";
import { AssetDecoder } from "./asset-decoder.mjs";
import { assetEnvironment } from "./asset-environment.mjs";

async function setup(t, processor, uploadsEnabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-asset-http-")));
  initializeAssetStore(root);
  const config = {
    root,
    publicOrigin: "https://assets.example.com",
    appOrigin: "http://127.0.0.1:3000",
    uploadsEnabled,
  };
  const store = new AssetStore(config);
  const server = createServer(createAssetHandler(config, store, processor));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(root, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (kind, value, headers = {}) =>
    fetch(`${base}/v1/asset-${kind}`, {
      method: "POST",
      headers: {
        origin: config.appOrigin,
        "content-type": "application/json",
        "x-fungun-intent": `asset-${kind}`,
        ...headers,
      },
      body: JSON.stringify(value),
    });
  return { store, post, base };
}
async function fixture() {
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .webp()
    .toBuffer();
  const input = {
    chainId: 4663,
    wallet: account.address,
    draft: { name: "Moon", ticker: "MOON", description: "" },
    imageBase64: image.toString("base64"),
  };
  return { account, image, input };
}

test("asset HTTP previews before signing, publishes exact bytes and serves only committed hashes", async (t) => {
  const { account, image, input } = await fixture();
  let calls = 0;
  const { store, post, base } = await setup(t, {
    async process(bytes) {
      calls++;
      assert.deepEqual(bytes, image);
      return { bytes: image, width: 8, height: 8 };
    },
  });
  const response = await post("prepare", input);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const preview = await response.json();
  assert.equal(calls, 1);
  const path = `/launch-assets/${preview.imageHash}.webp`;
  assert.equal((await fetch(base + path)).status, 404);
  const request = {
    ...input,
    id: preview.id,
    signature: await account.signMessage({ message: preview.message }),
  };
  assert.equal((await post("publish", request)).status, 200);
  assert.equal((await post("publish", request)).status, 200);
  assert.equal(calls, 1);
  const published = await fetch(base + path);
  assert.deepEqual(Buffer.from(await published.arrayBuffer()), image);
  assert.equal(published.headers.get("x-content-type-options"), "nosniff");
  assert.match(published.headers.get("cache-control"), /immutable/);
  assert.equal(
    (await fetch(base + path, { headers: { "if-none-match": published.headers.get("etag") } }))
      .status,
    304,
  );
  const head = await fetch(base + path, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/assets.sqlite", "/launch-assets/", "/launch-assets/%2e%2e/assets.sqlite"])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM counters WHERE scope LIKE 'upstream:%'").get().n,
    0,
  );
});

test("asset HTTP rejects spoofing, surplus fields, oversized bodies and leaks", async (t) => {
  const { input } = await fixture();
  let calls = 0;
  const { post } = await setup(t, {
    async process() {
      calls++;
      throw new Error("synthetic confidential decoder detail");
    },
  });
  assert.equal((await post("prepare", input, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await post("prepare", input, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post("prepare", input, { "content-type": "text/plain" })).status, 415);
  assert.equal((await post("prepare", { ...input, extra: "no" })).status, 400);
  assert.equal(
    (await post("prepare", { ...input, imageBase64: "a".repeat(3 * 1024 * 1024) })).status,
    413,
  );
  assert.equal(calls, 0);
  const failure = await post("prepare", input);
  assert.equal(failure.status, 503);
  const payload = await failure.json();
  assert.ok(payload.message.length > 10);
  assert.ok(!JSON.stringify(payload).includes("confidential"));
  assert.equal(calls, 1);
});

test("asset preparation rejects concurrent decodes without queuing", async (t) => {
  const { image, input } = await fixture();
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { post } = await setup(t, {
    async process() {
      started();
      await pending;
      return { bytes: image, width: 8, height: 8 };
    },
  });
  const first = post("prepare", input);
  await ready;
  const second = await post("prepare", input);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, "asset_busy");
  release();
  assert.equal((await first).status, 200);
});

test("disabled asset publication cannot call the decoder or accept spoofed request counters", async (t) => {
  const { input } = await fixture();
  const { post } = await setup(
    t,
    {
      process() {
        assert.fail("Disabled decoder called");
      },
    },
    false,
  );
  const disabled = await post("prepare", input);
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error, "asset_uploads_disabled");
  for (let index = 0; index < 29; index++) await post("prepare", input);
  const limited = await post("prepare", input, {
    "fly-client-ip": "192.0.2.1",
    "x-forwarded-for": "192.0.2.2",
  });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
});

test("asset inputs accept canonical bytes only, never URLs or extra operations", async () => {
  const { input, image } = await fixture();
  assert.deepEqual(validateAssetInput("prepare", input).image, image);
  for (const changed of [
    { imageBase64: "https://example.com/image" },
    { imageBase64: input.imageBase64 + "\n" },
    { chainId: 8453 },
    { wallet: null },
    { draft: { ...input.draft, extra: true } },
  ])
    assert.throws(() => validateAssetInput("prepare", { ...input, ...changed }));
});

test("decoder transport pins its origin, strips credentials and checks bounded output", async () => {
  const { image } = await fixture();
  const credentialUrl = new URL("http://decoder.internal:8791");
  credentialUrl.username = "EXAMPLE";
  for (const origin of [
    "https://external.invalid",
    credentialUrl.href,
    "http://decoder.internal:8791/path",
    "http://127.0.0.1:8791",
  ])
    assert.throws(() => new AssetDecoder(origin));
  const response = (changes = {}, bytes = image) =>
    new Response(bytes, {
      headers: {
        "content-type": "image/webp",
        "x-image-width": "8",
        "x-image-height": "8",
        "x-image-sha256": createHash("sha256").update(image).digest("hex"),
        ...changes,
      },
    });
  const decoder = new AssetDecoder("http://decoder.internal:8791", async (url, options) => {
    assert.equal(url, "http://decoder.internal:8791/decode");
    assert.deepEqual(options.headers, { "content-type": "application/octet-stream" });
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.body, image);
    return response();
  });
  assert.deepEqual((await decoder.process(image)).bytes, image);
  for (const changed of [
    { "x-image-sha256": "wrong" },
    { "x-image-width": "4097" },
    { "content-type": "text/html" },
    { "content-length": "3000000" },
  ]) {
    const invalid = new AssetDecoder("http://decoder.internal:8791", async () => response(changed));
    await assert.rejects(invalid.process(image), { code: "decoder_unavailable" });
  }
  const huge = new AssetDecoder("http://decoder.internal:8791", async () =>
    response({}, Buffer.alloc(2097153)),
  );
  await assert.rejects(huge.process(image), { code: "decoder_unavailable" });
  const failed = new AssetDecoder("http://decoder.internal:8791", async () => {
    throw new Error("synthetic secret");
  });
  await assert.rejects(failed.process(image), {
    code: "decoder_unavailable",
    message: "decoder_unavailable",
  });
});

test("asset runtime excludes RPC, wallet, signing and model credentials", () => {
  const inherited = {
    NODE_ENV: "production",
    ASSET_UPLOADS: "false",
    PRIVATE_KEY: "EXAMPLE",
    O1_API_KEY: "EXAMPLE",
    XAI_API_KEY: "EXAMPLE",
    ROBINHOOD_RPC_URL: "EXAMPLE",
    NODE_OPTIONS: "synthetic",
    PATH: "synthetic",
  };
  assert.deepEqual(
    assetEnvironment(inherited, {
      ASSET_UPLOADS: "true",
      ASSET_STORE_ROOT: "/data/launch-assets",
      PRIVATE_KEY: "EXAMPLE",
    }),
    {
      NODE_ENV: "production",
      ASSET_UPLOADS: "false",
      ASSET_STORE_ROOT: "/data/launch-assets",
    },
  );
});
