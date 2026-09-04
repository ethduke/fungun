import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToString } from "viem";
import { initializeIpfsStore, IpfsStore } from "./ipfs-store.mjs";
import { createIpfsWorker } from "./ipfs-worker.mjs";
import { validateAssetInput } from "./asset-service.mjs";
import { createAssetProxy } from "../../web/lib/asset-proxy.ts";
import { prepareAsset, publishAsset, recoveryFor, readAssetRecovery, checkAssetStatus } from "../../web/lib/asset-client.ts";
import { signWalletAsset } from "../../web/lib/asset-wallet.ts";

test("webview verifies IPFS CIDs, signs once, tracks progress and resumes without RPC", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-ipfs-view-")));
  initializeIpfsStore(root);
  const origin = "https://web.example.com", gateway = "launch-assets.mypinata.cloud";
  const store = new IpfsStore({ root, appOrigin: origin, gateway });
  const records = new Map(), calls = [], account = privateKeyToAccount(generatePrivateKey());
  const receipt = (content) => ({ id: crypto.randomUUID(), cid: content.cid, size: content.bytes.length, mime: content.mime });
  const receipts = new Map();
  const publisher = {
    async pinObject(content) { calls.push(["POST", content.cid]); const value = receipt(content); receipts.set(content.cid, value); return value; },
    async inspectPin(id, content) { calls.push(["PIN", content.cid]); assert.equal(receipts.get(content.cid).id, id); },
    async verifyObject(content) { calls.push(["GET", content.cid]); },
    async findPin() { assert.fail("No uncertain upload expected"); },
  };
  const worker = createIpfsWorker(store, publisher, { enabled: true });
  t.after(async () => { await worker.stop(); store.close(); rmSync(root, { recursive: true }); });
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).webp().toBuffer();
  const draft = { name: "Moon", ticker: "MOON", description: "A simple coin." };
  const backend = async (url, options) => {
    const kind = url.pathname.slice("/v1/asset-".length);
    const input = validateAssetInput(kind, JSON.parse(options.body));
    if (kind === "prepare") return Response.json({ ...(await store.challenge(input.wallet, image, input.draft)),
      imageBase64: image.toString("base64"), width: 8, height: 8, serverTime: store.clock() });
    if (kind === "publish") return Response.json(await store.accept(input));
    return Response.json(store.status(input));
  };
  const proxy = createAssetProxy(() => ({ appOrigin: origin, serviceOrigin: "https://backend.example.com",
    publicOrigin: `https://${gateway}`, enabled: true, production: true }), backend);
  const client = (path, options) => proxy(new Request(origin + path, { ...options,
    headers: { ...options.headers, origin } }), path.split("/").at(-1));
  const storage = { getItem: (key) => records.get(key) ?? null, setItem: (key, value) => records.set(key, value),
    removeItem: (key) => records.delete(key) };
  const providerCalls = [];
  const provider = { async request({ method, params }) {
    providerCalls.push(method);
    if (method === "eth_accounts") return [account.address];
    if (method === "eth_chainId") return "0x1237";
    if (method === "personal_sign") return account.signMessage({ message: hexToString(params[0]) });
    assert.fail("Unexpected wallet or RPC operation");
  } };
  const approval = await prepareAsset(image, account.address, draft, origin, client);
  assert.equal(approval.ipfs.profile, "pinata-v1-256k");
  const signature = await signWalletAsset(provider, approval, () => true);
  const recovery = await recoveryFor(approval);
  const accepted = await publishAsset(approval, signature, recovery, storage, () => true, client);
  assert.equal(accepted.status, "processing");
  assert.equal(readAssetRecovery(storage, origin).version, 2);
  worker.kick(); await worker.idle();
  const published = await checkAssetStatus(recovery, account.address, storage, client);
  assert.equal(published.status, "published");
  assert.equal(readAssetRecovery(storage, origin).id, approval.id);
  assert.equal(calls.filter(([method]) => method === "POST").length, 2);
  assert.deepEqual(providerCalls, ["eth_accounts", "eth_chainId", "personal_sign", "eth_accounts", "eth_chainId"]);
});

test("webview rejects server-proposed IPFS CIDs that do not match the bytes", async () => {
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } }).webp().toBuffer();
  const account = privateKeyToAccount(generatePrivateKey());
  const draft = { name: "Moon", ticker: "MOON", description: "" };
  await assert.rejects(prepareAsset(image, account.address, draft, "https://web.example.com", async () =>
    Response.json({ id: "a".repeat(48), message: "invalid", issuedAt: 1, expiresAt: 300001,
      serverTime: 2, totalBytes: image.length, imageHash: "a".repeat(64), metadataHash: "b".repeat(64),
      imageUrl: `https://launch-assets.mypinata.cloud/ipfs/b${"a".repeat(58)}`,
      metadataUrl: `https://launch-assets.mypinata.cloud/ipfs/b${"b".repeat(58)}`,
      draft, imageBase64: image.toString("base64"), width: 4, height: 4,
      assetOrigin: "https://launch-assets.mypinata.cloud",
      ipfs: { profile: "pinata-v1-256k", schema: "long-ipfs-v1", imageCid: `b${"a".repeat(58)}`, metadataCid: `b${"b".repeat(58)}` } })),
    { code: "invalid_asset_response" });
});
