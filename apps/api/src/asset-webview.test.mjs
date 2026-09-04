import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hexToString } from "viem";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { validateAssetInput } from "./asset-service.mjs";
import { createAssetProxy } from "../../web/lib/asset-proxy.ts";
import {
  AssetError,
  imageBase64,
  validateAssetPreview,
  assetMessage,
  assetErrorText,
  readAssetJson,
} from "../../web/lib/asset-protocol.ts";
import {
  prepareAsset,
  publishAsset,
  recoveryFor,
  readAssetRecovery,
  checkAssetStatus,
} from "../../web/lib/asset-client.ts";
import { signWalletAsset } from "../../web/lib/asset-wallet.ts";

const origin = "https://web.example.com";
const assetOrigin = "https://assets.example.com";
const draft = { name: "Moon", ticker: "MOON", description: "A simple coin." };
async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-asset-webview-")));
  initializeAssetStore(root);
  const store = new AssetStore({ root, publicOrigin: assetOrigin, appOrigin: origin });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true });
  });
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .webp()
    .toBuffer();
  const providerCalls = [];
  const provider = {
    async request({ method, params }) {
      providerCalls.push(method);
      if (method === "eth_accounts") return [account.address];
      if (method === "eth_chainId") return "0x1237";
      if (method === "personal_sign") {
        assert.equal(params[1].toLowerCase(), account.address.toLowerCase());
        return account.signMessage({ message: hexToString(params[0]) });
      }
      assert.fail("Unexpected wallet or RPC operation");
    },
  };
  const backend = async (url, options) => {
    const kind = url.pathname.slice("/v1/asset-".length);
    const input = validateAssetInput(kind, JSON.parse(options.body));
    assert.deepEqual(options.headers, {
      origin,
      "content-type": "application/json",
      "x-fungun-intent": `asset-${kind}`,
    });
    assert.equal(options.redirect, "error");
    if (kind === "prepare")
      return Response.json({
        ...store.challenge(input.wallet, image, input.draft),
        imageBase64: imageBase64(image),
        width: 8,
        height: 8,
        serverTime: store.clock(),
      });
    if (kind === "publish") return Response.json(await store.publish(input));
    return Response.json(store.status(input));
  };
  const config = {
    appOrigin: origin,
    publicOrigin: assetOrigin,
    serviceOrigin: "https://backend.example.com",
    enabled: true,
    production: true,
  };
  const proxy = createAssetProxy(() => config, backend);
  const client = (path, options) =>
    proxy(
      new Request(origin + path, { ...options, headers: { ...options.headers, origin } }),
      path.split("/").at(-1),
    );
  const records = new Map();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key),
  };
  return {
    store,
    account,
    image,
    provider,
    providerCalls,
    config,
    backend,
    client,
    storage,
    records,
  };
}

test("asset webview prepares canonical bytes, signs once and publishes through bounded proxy without RPC", async (t) => {
  const { store, account, image, provider, providerCalls, client, storage, records } =
    await setup(t);
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  assert.equal(approval.message, assetMessage(approval));
  assert.equal(approval.totalBytes, image.length + store.bundle(image, draft).metadata.length);
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  const result = await publishAsset(
    approval,
    signature,
    recovery,
    storage,
    () => true,
    async (...args) => {
      assert.equal(readAssetRecovery(storage, origin).id, approval.id);
      const persisted = [...records.values()].join();
      for (const privateValue of [
        signature,
        approval.imageBase64,
        approval.message,
        account.address.toLowerCase(),
      ])
        assert.ok(!persisted.toLowerCase().includes(privateValue.toLowerCase()));
      return client(...args);
    },
  );
  assert.equal(result.id, approval.id);
  assert.equal(result.status, "published");
  assert.equal(result.launchReady, false);
  assert.equal(records.size, 0);
  assert.deepEqual(providerCalls, [
    "eth_accounts",
    "eth_chainId",
    "personal_sign",
    "eth_accounts",
    "eth_chainId",
  ]);
});

test("lost publication response recovers through status without a second signature or publish", async (t) => {
  const { store, account, image, provider, client, storage } = await setup(t);
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  await assert.rejects(
    publishAsset(
      approval,
      signature,
      recovery,
      storage,
      () => true,
      async (...args) => {
        await client(...args);
        throw new Error("lost response");
      },
    ),
    { code: "asset_publication_uncertain" },
  );
  const restored = readAssetRecovery(storage, origin);
  assert.equal(restored.id, approval.id);
  await assert.rejects(
    publishAsset(
      approval,
      signature,
      recovery,
      storage,
      () => true,
      () => assert.fail("Duplicate publish"),
    ),
    { code: "asset_publication_uncertain" },
  );
  const result = await checkAssetStatus(
    restored,
    account.address,
    storage,
    async (path, options) => {
      assert.equal(path, "/api/assets/status");
      return client(path, options);
    },
  );
  assert.equal(result.status, "published");
  assert.equal(readAssetRecovery(storage, origin), null);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM asset_challenges WHERE state = 'published'").get()
      .n,
    1,
  );
});

test("pending, reserved and unknown status never unlock an uncertain publication", async (t) => {
  const { account, image, provider, client, storage } = await setup(t);
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  await assert.rejects(
    publishAsset(
      approval,
      signature,
      recovery,
      storage,
      () => true,
      async () => {
        throw new Error();
      },
    ),
  );
  assert.equal(await checkAssetStatus(recovery, account.address, storage, client), null);
  for (const raw of [{ id: recovery.id, status: "uncertain" }, { error: "not_found" }]) {
    try {
      await checkAssetStatus(recovery, account.address, storage, async () => Response.json(raw));
    } catch {
      /* Unknown stays locked. */
    }
    assert.equal(readAssetRecovery(storage, origin).id, recovery.id);
  }
  await assert.rejects(
    checkAssetStatus(recovery, privateKeyToAccount(generatePrivateKey()).address, storage, () =>
      assert.fail("Wrong-wallet status query"),
    ),
    { code: "asset_recovery_wallet" },
  );
});

test("publication rejection preserves safe explanation and backoff without unlocking recovery", async (t) => {
  const { account, image, provider, client, storage } = await setup(t);
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  await assert.rejects(
    publishAsset(
      approval,
      signature,
      recovery,
      storage,
      () => true,
      async () =>
        Response.json(
          { error: "rate_limited", message: "synthetic private detail" },
          {
            status: 429,
            headers: { "retry-after": "60" },
          },
        ),
    ),
    (error) => {
      assert.equal(error.code, "asset_publication_uncertain");
      assert.equal(error.retryAfter, 60);
      assert.match(assetErrorText(error), /rate-limited/);
      assert.match(assetErrorText(error), /do not publish again/);
      assert.ok(!assetErrorText(error).includes("synthetic private detail"));
      return true;
    },
  );
  assert.equal(readAssetRecovery(storage, origin).id, approval.id);
});

test("changed wallet context, rejection, expiry and double clicks cannot publish or sign twice", async (t) => {
  const { account, image, provider, client, storage } = await setup(t);
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  let release, entered;
  const start = new Promise((resolve) => {
    entered = resolve;
  });
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  let current = true;
  const slow = {
    async request(args) {
      if (args.method === "personal_sign") {
        entered();
        await delayed;
      }
      return provider.request(args);
    },
  };
  const first = signWalletAsset(slow, approval, () => current);
  await start;
  await assert.rejects(
    signWalletAsset(slow, approval, () => true),
    { code: "asset_busy" },
  );
  current = false;
  release();
  await assert.rejects(first, { code: "asset_context_changed" });
  await assert.rejects(
    signWalletAsset(provider, { ...approval, deadline: 0 }, () => true),
    { code: "asset_approval_expired" },
  );
  await assert.rejects(
    signWalletAsset(
      {
        request: async () => {
          throw { code: 4001 };
        },
      },
      approval,
      () => true,
    ),
    { code: "asset_rejected" },
  );
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  await assert.rejects(
    publishAsset(
      approval,
      signature,
      recovery,
      storage,
      () => false,
      () => assert.fail("Changed draft published"),
    ),
    { code: "asset_context_changed" },
  );
  assert.equal(readAssetRecovery(storage, origin), null);
});

test("browser rejects substituted hashes, message, metadata, URLs, fields and expired previews", async (t) => {
  const { store, account, image } = await setup(t);
  const raw = {
    ...store.challenge(account.address, image, draft),
    imageBase64: imageBase64(image),
    width: 8,
    height: 8,
    serverTime: store.clock(),
    assetOrigin,
  };
  const expected = {
    wallet: account.address,
    draft,
    appOrigin: origin,
    startedAt: performance.now(),
  };
  for (const change of [
    { message: "Sign something else" },
    { imageHash: "a".repeat(64) },
    { metadataHash: "b".repeat(64) },
    { metadataUrl: "https://other.example.com/metadata" },
    { imageUrl: "https://other.example.com/image" },
    { draft: { ...draft, name: "Sun" } },
    { extra: true },
    { totalBytes: raw.totalBytes + 1 },
    { serverTime: raw.expiresAt },
    { expiresAt: raw.expiresAt + 1 },
    { width: 4097 },
  ])
    await assert.rejects(validateAssetPreview({ ...raw, ...change }, expected));
});

test("asset proxy rejects unconfigured uploads, unsafe origins, surplus input and leaked upstream errors", async (t) => {
  const { config, account, image } = await setup(t);
  let calls = 0;
  const proxy = createAssetProxy(
    () => config,
    async () => {
      calls++;
      return Response.json(
        { error: "unavailable", signature: "EXAMPLE", detail: "synthetic private response" },
        { status: 500 },
      );
    },
  );
  const input = { chainId: 4663, wallet: account.address, draft, imageBase64: imageBase64(image) };
  const request = (value = input, headers = {}) =>
    new Request(`${origin}/api/assets/prepare`, {
      method: "POST",
      body: JSON.stringify(value),
      headers: {
        origin,
        "content-type": "application/json",
        "x-fungun-intent": "asset-prepare",
        ...headers,
      },
    });
  config.enabled = false;
  assert.equal((await proxy(request(), "prepare")).status, 503);
  assert.equal(calls, 0);
  config.enabled = true;
  assert.equal(
    (await proxy(request(input, { origin: "https://other.example.com" }), "prepare")).status,
    403,
  );
  assert.equal((await proxy(request({ ...input, extra: true }), "prepare")).status, 400);
  config.serviceOrigin = "http://external.example.com";
  assert.equal((await proxy(request(), "prepare")).status, 503);
  assert.equal(calls, 0);
  config.serviceOrigin = "https://backend.example.com";
  const failed = await proxy(request(), "prepare");
  assert.deepEqual(await failed.json(), { error: "unavailable" });
  assert.equal(calls, 1);
  assert.ok(
    !assetErrorText(new AssetError("synthetic private response")).includes("private response"),
  );
});

test("asset response parser cancels oversized and stalled streams", async () => {
  let canceled = false;
  const large = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65));
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(readAssetJson(large, 64), { code: "image_size" });
  assert.equal(canceled, true);
  canceled = false;
  const slow = new ReadableStream({
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(readAssetJson(slow, 64, 5));
  assert.equal(canceled, true);
});
