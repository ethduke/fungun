import assert from "node:assert/strict";
import test from "node:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import sharp from "sharp";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "A simple coin." };
const origin = "https://assets.example.com";
async function setup(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungun-assets-test-")));
  let now = 1800000000000;
  initializeAssetStore(root, false, () => now);
  const config = { root, publicOrigin: origin, appOrigin: "http://127.0.0.1:3000", now: () => now };
  const store = new AssetStore(config);
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .webp()
    .toBuffer();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true });
  });
  return {
    root,
    config,
    store,
    account,
    image,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("Fly assets publish only after exact wallet approval and stay readable after restart", async (t) => {
  const { root, config, store, account, image } = await setup(t);
  const challenge = store.challenge(account.address, image, draft);
  assert.deepEqual(readdirSync(join(root, "objects")), []);
  assert.throws(() => store.read(`${challenge.imageHash}.webp`), { code: "not_found" });
  const signature = await account.signMessage({ message: challenge.message });
  const request = { id: challenge.id, wallet: account.address, image, draft, signature };
  const published = await store.publish(request);
  assert.equal(published.status, "published");
  assert.equal(published.launchReady, false);
  assert.deepEqual(store.read(`${published.imageHash}.webp`).bytes, image);
  assert.equal(
    JSON.parse(store.read(`${published.metadataHash}.json`).bytes).image,
    published.imageUrl,
  );
  const used = store.db
    .prepare("SELECT value FROM settings WHERE name = 'asset-bytes'")
    .get().value;
  assert.deepEqual(await store.publish(request), published);
  assert.equal(
    store.db.prepare("SELECT value FROM settings WHERE name = 'asset-bytes'").get().value,
    used,
  );
  const another = new AssetStore(config);
  try {
    assert.deepEqual(another.read(`${published.imageHash}.webp`).bytes, image);
  } finally {
    another.close();
  }
  const rows = store.db.prepare("SELECT * FROM asset_challenges").all();
  assert.ok(!JSON.stringify(rows).includes(signature));
  assert.ok(!JSON.stringify(rows).toLowerCase().includes(account.address.toLowerCase()));
});

test("asset signatures bind wallet, content, origin, expiry and chain without provider reads", async (t) => {
  const { store, account, image, advance } = await setup(t);
  const challenge = store.challenge(account.address, image, draft);
  const signature = await account.signMessage({ message: challenge.message });
  const request = { id: challenge.id, wallet: account.address, image, draft, signature };
  await assert.rejects(store.publish({ ...request, draft: { ...draft, name: "Sun" } }), {
    code: "asset_approval_changed",
  });
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(
    store.publish({
      ...request,
      signature: await other.signMessage({ message: challenge.message }),
    }),
    { code: "invalid_asset_approval" },
  );
  for (const message of [
    challenge.message.replace("4663", "8453"),
    challenge.message.replace(origin, "https://other.example.com"),
  ])
    await assert.rejects(
      store.publish({ ...request, signature: await account.signMessage({ message }) }),
      { code: "invalid_asset_approval" },
    );
  advance(300001);
  await assert.rejects(store.publish(request), { code: "asset_approval_expired" });
});

test("partial writes remain charged and unavailable; uncertain publication is never repeated", async (t) => {
  const { root, store, account, image } = await setup(t);
  const challenge = store.challenge(account.address, image, draft);
  const request = {
    id: challenge.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: challenge.message }),
  };
  writeFileSync(join(root, "objects", `${challenge.metadataHash}.json`), "wrong");
  await assert.rejects(store.publish(request), { code: "asset_integrity_failed" });
  assert.equal(
    store.db.prepare("SELECT state FROM asset_challenges WHERE id = ?").get(challenge.id).state,
    "reserved",
  );
  assert.ok(
    Number(store.db.prepare("SELECT value FROM settings WHERE name = 'asset-bytes'").get().value) >
      image.length,
  );
  assert.throws(() => store.read(`${challenge.imageHash}.webp`), { code: "not_found" });
  await assert.rejects(store.publish(request), { code: "asset_publication_uncertain" });
});

test("asset quota, clock rollback and immutable origin checks fail closed", async (t) => {
  const { config, store, account, image, advance } = await setup(t);
  assert.throws(() => new AssetStore({ ...config, publicOrigin: "https://changed.example.com" }), {
    code: "asset_origin_changed",
  });
  for (let index = 0; index < 3; index += 1) {
    const challenge = store.challenge(account.address, image, draft);
    await store.publish({
      id: challenge.id,
      wallet: account.address,
      image,
      draft,
      signature: await account.signMessage({ message: challenge.message }),
    });
  }
  const challenge = store.challenge(account.address, image, draft);
  await assert.rejects(
    store.publish({
      id: challenge.id,
      wallet: account.address,
      image,
      draft,
      signature: await account.signMessage({ message: challenge.message }),
    }),
    { code: "rate_limited" },
  );
  advance(-5000);
  assert.throws(() => store.challenge(account.address, image, draft), {
    code: "asset_clock_unavailable",
  });
});

test("asset filesystem rejects repository roots, symlinks, reinitialization and tampering", async (t) => {
  const { root, store, account, image } = await setup(t);
  assert.throws(() => initializeAssetStore(root));
  const privateFolder = join(root, "private");
  mkdirSync(privateFolder, { mode: 0o700 });
  mkdirSync(join(privateFolder, ".git"));
  assert.throws(() => initializeAssetStore(privateFolder), { code: "asset_storage_in_repository" });
  const alias = join(root, "alias");
  symlinkSync(privateFolder, alias);
  assert.throws(() => initializeAssetStore(alias), { code: "asset_storage_unavailable" });
  chmodSync(privateFolder, 0o755);
  assert.throws(() => initializeAssetStore(privateFolder), { code: "asset_storage_permissions" });
  const challenge = store.challenge(account.address, image, draft);
  await store.publish({
    id: challenge.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: challenge.message }),
  });
  for (const name of ["../assets.sqlite", "assets.sqlite", `${challenge.imageHash}.webp?x=1`])
    assert.throws(() => store.read(name), { code: "not_found" });
  const target = join(root, "objects", `${challenge.imageHash}.webp`);
  writeFileSync(target, Buffer.alloc(image.length));
  assert.throws(() => store.read(`${challenge.imageHash}.webp`), {
    code: "asset_integrity_failed",
  });
  assert.ok(!readFileSync(join(root, "assets.sqlite")).includes(Buffer.from(account.address)));
});

test("simultaneous publications cannot double-spend a nonce and quotas survive restart", async (t) => {
  const { config, store, account, image } = await setup(t);
  const challenge = store.challenge(account.address, image, draft);
  const input = {
    id: challenge.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: challenge.message }),
  };
  const results = await Promise.allSettled([store.publish(input), store.publish(input)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "asset_busy");
  const another = new AssetStore(config);
  try {
    assert.equal((await another.publish(input)).status, "published");
    const rows = another.db
      .prepare("SELECT used FROM counters WHERE scope LIKE 'asset-publications:%'")
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used, 1);
    assert.equal(another.db.prepare("SELECT COUNT(*) AS n FROM asset_objects").get().n, 2);
  } finally {
    another.close();
  }
});

test("valid files left by interrupted publication are verified and reused without overwrite", async (t) => {
  const { root, store, account, image } = await setup(t);
  const bundle = store.bundle(image, draft);
  writeFileSync(join(root, "objects", `${bundle.imageHash}.webp`), image, { mode: 0o600 });
  writeFileSync(join(root, "objects", `${bundle.metadataHash}.json`), bundle.metadata, {
    mode: 0o600,
  });
  const challenge = store.challenge(account.address, image, draft);
  const published = await store.publish({
    id: challenge.id,
    wallet: account.address,
    image,
    draft,
    signature: await account.signMessage({ message: challenge.message }),
  });
  assert.deepEqual(store.read(`${published.imageHash}.webp`).bytes, image);
  assert.equal(readdirSync(join(root, "objects")).length, 2);
});

test("missing or inconsistent asset databases fail closed without resetting quotas", async (t) => {
  const { root, config, store } = await setup(t);
  store.db.prepare("UPDATE settings SET value = '1' WHERE name = 'asset-bytes'").run();
  assert.throws(() => new AssetStore(config), { code: "asset_storage_unavailable" });
  assert.throws(() => new AssetStore({ ...config, root: join(root, "absent") }));
  store.db.prepare("UPDATE settings SET value = '0' WHERE name = 'asset-bytes'").run();
  assert.throws(() => new AssetStore({ ...config, appOrigin: "https://changed.example.com" }), {
    code: "asset_origin_changed",
  });
});
