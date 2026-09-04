import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { maintainAssets } from "./asset-maintenance.mjs";
import { backupAssets, restoreAssetBackup, verifyAssetBackup } from "./asset-snapshot.mjs";
import { snapshotArguments, snapshotEnvironment, snapshotMain } from "./asset-snapshot-cli.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const draft = { name: "Moon", ticker: "MOON", description: "A test coin" };

async function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "fungun-snapshot-")));
  const root = join(parent, "source");
  mkdirSync(root, { mode: 0o700 });
  const now = () => 1800000000000;
  initializeAssetStore(root, false, now);
  const config = { root, now, publicOrigin: "https://assets.example.com", appOrigin: "https://web.example.com" };
  const store = new AssetStore(config);
  t.after(() => { store.close(); rmSync(parent, { recursive: true }); });
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).webp().toBuffer();
  const account = privateKeyToAccount(generatePrivateKey());
  const publish = async () => {
    const approval = store.challenge(account.address, image, draft);
    const signed = await account.signMessage({ message: approval.message });
    await store.publish({ id: approval.id, wallet: account.address, signature: signed, image, draft });
    return approval;
  };
  const output = join(parent, "snapshot");
  const run = (options = {}) => backupAssets({ root, output, now, execute: true, serviceStopped: true, ...options });
  const verify = (digest, options = {}) => verifyAssetBackup({ backupRoot: output, expectedSha256: digest, now, ...options });
  return { parent, root, store, now, output, account, image, config, publish, run, verify };
}

const state = (db) => Object.fromEntries(["settings", "counters", "asset_challenges", "asset_objects"]
  .map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]));

test("snapshots include committed WAL state, preserve source and restore only a quarantined copy", async (t) => {
  const f = await fixture(t);
  await f.publish();
  f.store.challenge(f.account.address, f.image, { ...draft, name: "Next" });
  const before = state(f.store.db);
  assert.ok(existsSync(join(f.root, "assets.sqlite-wal")));
  const planned = await f.run({ execute: false });
  assert.equal(planned.files, 2);
  assert.equal(planned.sameFilesystem, true);
  assert.equal(existsSync(f.output), false);
  const result = await f.run();
  assert.deepEqual(state(f.store.db), before);
  assert.equal(f.verify(result.manifestSha256).files, 2);
  assert.deepEqual(readdirSync(f.output).sort(), ["assets.sqlite", "backup.manifest.json", "objects"]);
  const db = new DatabaseSync(join(f.output, "assets.sqlite"), { readOnly: true });
  const copied = state(db);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
  db.close();
  assert.equal(copied.settings.find((row) => row.name === "asset-restore-state").value, "quarantined");
  copied.settings = copied.settings.filter((row) => row.name !== "asset-restore-state");
  assert.deepEqual(copied, before);
  const output = join(f.parent, "restored");
  const options = { backupRoot: f.output, expectedSha256: result.manifestSha256, output, now: f.now };
  assert.equal(restoreAssetBackup(options).execute, false);
  assert.equal(existsSync(output), false);
  assert.throws(() => restoreAssetBackup({ ...options, execute: true }));
  restoreAssetBackup({ ...options, execute: true, serviceStopped: true });
  assert.throws(() => new AssetStore({ ...f.config, root: output }), { code: "asset_restore_quarantined" });
  for (const mode of ["expire-pending", "migrate-schema"]) {
    assert.throws(() => maintainAssets({ root: output, mode, now: () => f.now() + 999999,
      execute: true, serviceStopped: true }), { code: "asset_restore_quarantined" });
  }
  assert.equal(maintainAssets({ root: output, now: f.now }).counts.pending, 1);
  verifyAssetBackup({ backupRoot: output, expectedSha256: result.manifestSha256, now: f.now });
  assert.throws(() => initializeAssetStore(output, false, f.now));
  await assert.rejects(f.run({ root: output, output: join(f.parent, "rebackup") }));
  assert.throws(() => restoreAssetBackup({ ...options, execute: true, serviceStopped: true }));
});

test("reserved and temporary bytes survive backup without publication or quota refunds", async (t) => {
  const f = await fixture(t);
  const approval = await f.publish();
  f.store.db.prepare("UPDATE asset_challenges SET state = 'reserved' WHERE id = ?").run(approval.id);
  f.store.db.exec("DELETE FROM asset_objects");
  const name = `.${randomBytes(16).toString("hex")}.tmp`;
  writeFileSync(join(f.store.directory, name), randomBytes(32), { mode: 0o600 });
  const before = state(f.store.db);
  const result = await f.run();
  assert.equal(result.files, 3);
  f.verify(result.manifestSha256);
  assert.deepEqual(state(f.store.db), before);
  assert.equal(f.store.status({ id: approval.id, wallet: f.account.address,
    imageHash: approval.imageHash, metadataHash: approval.metadataHash }).status, "uncertain");
});

test("write acknowledgement, existing destinations, repository paths and nested targets fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ serviceStopped: false }));
  await assert.rejects(f.run({ output: f.root }));
  await assert.rejects(f.run({ output: join(f.root, "nested") }));
  const repo = join(f.parent, "repo");
  mkdirSync(repo, { mode: 0o700 });
  mkdirSync(join(repo, ".git"));
  await assert.rejects(f.run({ output: join(repo, "backup") }));
  assert.equal(existsSync(f.output), false);
});

test("source writer lock prevents snapshot creation", async (t) => {
  const f = await fixture(t);
  f.store.db.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(f.run()); }
  finally { f.store.db.exec("ROLLBACK"); }
  assert.equal(existsSync(f.output), false);
});

test("interrupted pre-quarantine snapshots never expose a runtime database", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(f.run({ now: () => ++calls === 1 ? f.now() : 0 }));
  assert.ok(existsSync(join(f.output, "snapshot.pending.sqlite")));
  assert.equal(existsSync(join(f.output, "assets.sqlite")), false);
  assert.equal(existsSync(join(f.output, "backup.manifest.json")), false);
  assert.throws(() => new AssetStore({ ...f.config, root: f.output }));
});

for (const kind of ["symlink", "hardlink", "fifo", "oversize", "public", "unknown", "corrupt-published", "missing-published"]) {
  test(`snapshot refuses ${kind} evidence without a completion manifest`, async (t) => {
    const f = await fixture(t);
    const approval = await f.publish();
    const path = join(f.store.directory, `${randomBytes(32).toString("hex")}.webp`);
    const imagePath = join(f.store.directory, `${approval.imageHash}.webp`);
    if (kind === "symlink") symlinkSync(imagePath, path);
    if (kind === "hardlink") linkSync(imagePath, path);
    if (kind === "fifo") execFileSync("mkfifo", [path]);
    if (kind === "oversize") writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
    if (kind === "public") chmodSync(imagePath, 0o644);
    if (kind === "unknown") writeFileSync(join(f.store.directory, "unknown"), "x", { mode: 0o600 });
    if (kind === "corrupt-published") writeFileSync(imagePath, "broken");
    if (kind === "missing-published") rmSync(imagePath);
    await assert.rejects(f.run());
    assert.equal(existsSync(join(f.output, "backup.manifest.json")), false);
  });
}

test("manifest and object tampering cannot pass verification or create a restore", async (t) => {
  const f = await fixture(t);
  const approval = await f.publish();
  const result = await f.run();
  assert.throws(() => f.verify(undefined));
  assert.throws(() => f.verify(randomBytes(32).toString("hex")));
  const manifestPath = join(f.output, "backup.manifest.json");
  const original = readFileSync(manifestPath);
  const manifest = JSON.parse(original);
  manifest.files[0].name = "../outside";
  const corrupt = Buffer.from(JSON.stringify(manifest));
  writeFileSync(manifestPath, corrupt);
  assert.throws(() => f.verify(result.manifestSha256));
  assert.throws(() => f.verify(hash(corrupt)));
  writeFileSync(manifestPath, original);
  writeFileSync(join(f.output, "objects", `${approval.imageHash}.webp`), "changed");
  assert.throws(() => f.verify(result.manifestSha256));
  const output = join(f.parent, "bad-restore");
  assert.throws(() => restoreAssetBackup({ backupRoot: f.output, expectedSha256: result.manifestSha256,
    output, now: f.now, execute: true, serviceStopped: true }));
  assert.equal(existsSync(output), false);
});

test("CLI is explicit, redacts errors and excludes unrelated credentials", async () => {
  for (const args of [[], ["backup", "--execute"], ["verify", "--execute"], ["activate"],
    ["backup", "--service-stopped", "--service-stopped"], ["restore", "--force"]])
    assert.throws(() => snapshotArguments(args));
  assert.deepEqual(snapshotArguments(["backup"]), { mode: "backup", execute: false, serviceStopped: false });
  const secret = randomBytes(32).toString("hex");
  assert.deepEqual(snapshotEnvironment({ ASSET_STORE_ROOT: "selected", PRIVATE_KEY: secret,
    RPC_HTTP_URL: secret, ASSET_UPLOADS: "true" }, { ASSET_STORE_ROOT: "ignored", XAI_API_KEY: secret }),
  { ASSET_STORE_ROOT: "selected" });
  const original = console.error;
  const messages = [];
  console.error = (message) => messages.push(message);
  try { assert.equal(await snapshotMain(["verify"], { ASSET_BACKUP_ROOT: secret }), 1); }
  finally { console.error = original; }
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes(secret), false);
});
