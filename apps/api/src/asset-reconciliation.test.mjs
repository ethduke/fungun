import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync, symlinkSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import sharp from "sharp";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { backupAssets, restoreAssetBackup } from "./asset-snapshot.mjs";
import { reconcileRestoredAssets } from "./asset-reconciliation.mjs";
import { snapshotArguments, snapshotMain } from "./asset-snapshot-cli.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "Test coin" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const state = (db) => ["settings", "counters", "asset_challenges", "asset_objects"]
  .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());

async function fixture(t, partial = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "fungun-reconcile-")));
  const root = join(parent, "source");
  mkdirSync(root, { mode: 0o700 });
  const now = () => 1800000000000;
  initializeAssetStore(root, false, now);
  const config = { root, now, publicOrigin: "https://assets.example.com", appOrigin: "https://web.example.com" };
  const store = new AssetStore(config);
  t.after(() => { store.close(); rmSync(parent, { recursive: true }); });
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).webp().toBuffer();
  const approval = store.challenge(account.address, image, draft);
  const signed = await account.signMessage({ message: approval.message });
  await store.publish({ id: approval.id, wallet: account.address, signature: signed, image, draft });
  store.challenge(account.address, image, { ...draft, name: "Pending" });
  if (partial) {
    store.db.prepare("UPDATE asset_challenges SET state = 'reserved' WHERE id = ?").run(approval.id);
    store.db.exec("DELETE FROM asset_objects");
    rmSync(join(store.directory, `${approval.metadataHash}.json`));
  }
  const backupRoot = join(parent, "backup");
  const result = await backupAssets({ root, output: backupRoot, now, execute: true, serviceStopped: true });
  const restoreRoot = join(parent, "restore");
  restoreAssetBackup({ backupRoot, expectedSha256: result.manifestSha256,
    output: restoreRoot, now, execute: true, serviceStopped: true });
  const options = { root, backupRoot, restoreRoot, expectedSha256: result.manifestSha256, now };
  return { parent, store, config, account, approval, options,
    run: (overrides = {}) => reconcileRestoredAssets({ ...options, ...overrides }) };
}

const files = (root) => Object.fromEntries(readdirSync(root).sort().map((name) => [name,
  name === "objects" ? Object.fromEntries(readdirSync(join(root, name)).sort().map((object) =>
    [object, hash(readFileSync(join(root, name, object)))])) : hash(readFileSync(join(root, name)))]));

test("matching original, backup and restore produce evidence without activation or state changes", async (t) => {
  const f = await fixture(t);
  const before = state(f.store.db);
  const backup = files(f.options.backupRoot);
  const restored = files(f.options.restoreRoot);
  const report = f.run();
  assert.equal(report.matched, true);
  assert.equal(report.activationAllowed, false);
  assert.equal(report.requiresVerifiedCutoverIdentity, true);
  assert.equal(report.requiresCutoverRecheck, true);
  assert.equal(report.counts.pending, 1);
  assert.equal(report.counts.published, 1);
  assert.equal(report.files, 2);
  assert.deepEqual(state(f.store.db), before);
  assert.deepEqual(files(f.options.backupRoot), backup);
  assert.deepEqual(files(f.options.restoreRoot), restored);
  assert.throws(() => new AssetStore({ ...f.config, root: f.options.restoreRoot }), { code: "asset_restore_quarantined" });
  const serialized = JSON.stringify(report);
  for (const forbidden of [f.parent, f.account.address, f.approval.id, f.approval.imageHash,
    f.store.db.prepare("SELECT value FROM settings WHERE name = 'ip-hmac'").get().value])
    assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual(f.run(), report);
});

test("partial reservations stay locked even when all three copies agree", async (t) => {
  const f = await fixture(t, true);
  const report = f.run();
  assert.equal(report.matched, true);
  assert.equal(report.counts.reserved, 1);
  assert.equal(report.activationAllowed, false);
  assert.equal(report.files, 1);
  assert.equal(f.store.status({ id: f.approval.id, wallet: f.account.address,
    imageHash: f.approval.imageHash, metadataHash: f.approval.metadataHash }).status, "uncertain");
});

test("post-backup quota changes invalidate previous reconciliation", async (t) => {
  const f = await fixture(t);
  f.run();
  f.store.budget.request("synthetic-client");
  const before = state(f.store.db);
  assert.throws(() => f.run(), { code: "asset_backup_outdated" });
  assert.deepEqual(state(f.store.db), before);
});

test("missing or retired originals cannot be replaced by a backup alone", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.run({ root: join(f.parent, "missing") }));
  f.store.db.prepare("INSERT INTO settings VALUES ('asset-restore-state', ?)").run("retired");
  const before = state(f.store.db);
  assert.throws(() => f.run());
  assert.deepEqual(state(f.store.db), before);
});

test("all aliases are rejected before reconciliation", async (t) => {
  const f = await fixture(t);
  for (const overrides of [
    { restoreRoot: f.options.backupRoot }, { restoreRoot: f.options.root },
    { backupRoot: f.options.root }, { root: f.options.restoreRoot },
  ]) assert.throws(() => f.run(overrides));
  const alias = join(f.parent, "alias");
  symlinkSync(f.options.restoreRoot, alias);
  assert.throws(() => f.run({ restoreRoot: alias }));
});

test("hardlinked restore databases and unexpected files fail closed", async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.options.restoreRoot, "unexpected"), "x", { mode: 0o600 });
  assert.throws(() => f.run());
  rmSync(join(f.options.restoreRoot, "unexpected"));
  rmSync(join(f.options.restoreRoot, "assets.sqlite"));
  linkSync(join(f.options.backupRoot, "assets.sqlite"), join(f.options.restoreRoot, "assets.sqlite"));
  assert.throws(() => f.run());
});

test("wrong digest, tampered restored files and altered quarantine cannot match", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.run({ expectedSha256: randomBytes(32).toString("hex") }));
  const imagePath = join(f.options.restoreRoot, "objects", `${f.approval.imageHash}.webp`);
  const original = readFileSync(imagePath);
  writeFileSync(imagePath, "corrupt");
  assert.throws(() => f.run());
  writeFileSync(imagePath, original);
  const db = new DatabaseSync(join(f.options.restoreRoot, "assets.sqlite"));
  db.prepare("DELETE FROM settings WHERE name = 'asset-restore-state'").run();
  db.close();
  assert.throws(() => f.run());
});

test("reconciliation CLI has no write or activation flags and redacts failures", async () => {
  assert.deepEqual(snapshotArguments(["reconcile-restore"]), { mode: "reconcile-restore", execute: false, serviceStopped: false });
  for (const flags of [["--execute", "--service-stopped"], ["--service-stopped"], ["--activate"], ["--force"]])
    assert.throws(() => snapshotArguments(["reconcile-restore", ...flags]));
  const value = randomBytes(32).toString("hex");
  const original = console.error;
  const errors = [];
  console.error = (text) => errors.push(text);
  try { assert.equal(await snapshotMain(["reconcile-restore"], { ASSET_STORE_ROOT: value }), 1); }
  finally { console.error = original; }
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes(value), false);
});
