import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
  linkSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AssetStore, initializeAssetStore } from "./asset-store.mjs";
import { backupAssets, restoreAssetBackup } from "./asset-snapshot.mjs";
import { recoverCompleteAssets } from "./asset-recovery.mjs";

const draft = { name: "Moon", ticker: "MOON", description: "A test coin" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const state = (db) => ["settings", "counters", "asset_challenges", "asset_objects"]
  .map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());

async function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "fungun-recovery-")));
  const root = join(parent, "source");
  mkdirSync(root, { mode: 0o700 });
  let current = 1800000000000;
  const now = () => current;
  initializeAssetStore(root, false, now);
  const config = { root, now, publicOrigin: "https://assets.example.com", appOrigin: "https://web.example.com" };
  let store = new AssetStore(config);
  t.after(() => { store.close(); rmSync(parent, { recursive: true }); });
  const account = privateKeyToAccount(generatePrivateKey());
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).webp().toBuffer();
  const approval = store.challenge(account.address, image, draft);
  const signed = await account.signMessage({ message: approval.message });
  store.db.exec("CREATE TRIGGER interrupted BEFORE UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  await assert.rejects(store.publish({ id: approval.id, wallet: account.address, signature: signed, image, draft }));
  store.db.exec("DROP TRIGGER interrupted");
  let sequence = 0;
  const snapshot = async () => {
    const backupRoot = join(parent, `backup-${++sequence}`);
    const result = await backupAssets({ root, output: backupRoot, now, execute: true, serviceStopped: true });
    return { backupRoot, expectedSha256: result.manifestSha256 };
  };
  const run = (backup, options = {}) => recoverCompleteAssets({ root, now, ...backup, ...options });
  const query = { id: approval.id, wallet: account.address, imageHash: approval.imageHash, metadataHash: approval.metadataHash };
  return { parent, root, config, get store() { return store; }, account, image, approval, query, now, snapshot, run,
    advance: () => { current += 600000; },
    restart: () => { store.close(); store = new AssetStore(config); },
  };
}

test("complete interrupted writes recover once without signatures, quota refunds or file changes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.status(f.query).status, "uncertain");
  f.advance();
  const backup = await f.snapshot();
  const before = state(f.store.db);
  const objects = readdirSync(f.store.directory).map((name) => [name, readFileSync(join(f.store.directory, name))]);
  const preview = f.run(backup);
  assert.equal(preview.eligible, 1);
  assert.equal(preview.changed, 0);
  assert.deepEqual(state(f.store.db), before);
  assert.throws(() => f.run(backup, { execute: true }));
  const result = f.run(backup, { execute: true, serviceStopped: true });
  assert.equal(result.changed, 1);
  assert.equal(result.launchReady, false);
  const after = state(f.store.db);
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(after[1], before[1]);
  assert.deepEqual(after[2], before[2].map((row) => ({ ...row, state: "published" }))
    .map((row) => Object.assign(Object.create(null), row)));
  assert.equal(after[3].length, 2);
  for (const [name, bytes] of objects) assert.deepEqual(readFileSync(join(f.store.directory, name)), bytes);
  f.restart();
  assert.equal(f.store.status(f.query).status, "published");
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }), { code: "asset_backup_outdated" });
  assert.equal(f.run(await f.snapshot(), { execute: true, serviceStopped: true }).changed, 0);
});

for (const kind of ["missing-image", "missing-metadata", "missing-both", "corrupt-image", "corrupt-metadata", "wrong-size", "wrong-metadata-uri", "temporary-only"]) {
  test(`${kind} stays reserved and charged`, async (t) => {
    const f = await fixture(t);
    const imagePath = join(f.store.directory, `${f.approval.imageHash}.webp`);
    const metadataPath = join(f.store.directory, `${f.approval.metadataHash}.json`);
    if (["missing-image", "missing-both", "temporary-only"].includes(kind)) rmSync(imagePath);
    if (["missing-metadata", "missing-both", "temporary-only"].includes(kind)) rmSync(metadataPath);
    if (kind === "corrupt-image") writeFileSync(imagePath, "bad");
    if (kind === "corrupt-metadata") writeFileSync(metadataPath, "bad");
    if (kind === "temporary-only") writeFileSync(join(f.store.directory, `.${randomBytes(16).toString("hex")}.tmp`), f.image, { mode: 0o600 });
    if (kind === "wrong-size") {
      f.store.db.prepare("UPDATE asset_challenges SET bytes = bytes + 1 WHERE id = ?").run(f.approval.id);
      f.store.db.exec("UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE name = 'asset-bytes'");
    }
    if (kind === "wrong-metadata-uri") {
      const value = JSON.parse(readFileSync(metadataPath));
      value.image = "https://unrelated.example.com/image.webp";
      const bytes = Buffer.from(JSON.stringify(value));
      const nextHash = hash(bytes);
      rmSync(metadataPath);
      writeFileSync(join(f.store.directory, `${nextHash}.json`), bytes, { mode: 0o600 });
      f.store.db.prepare("UPDATE asset_challenges SET metadata_hash = ?, bytes = ? WHERE id = ?")
        .run(nextHash, bytes.length + f.image.length, f.approval.id);
      f.store.db.prepare("UPDATE settings SET value = ? WHERE name = 'asset-bytes'").run(String(bytes.length + f.image.length));
    }
    const backup = await f.snapshot();
    const before = state(f.store.db);
    const result = f.run(backup, { execute: true, serviceStopped: true });
    assert.equal(result.changed, 0);
    assert.equal(result.blocked, 1);
    assert.deepEqual(state(f.store.db), before);
  });
}

test("pending and expired approvals are never promoted even with complete files", async (t) => {
  const f = await fixture(t);
  const other = f.store.challenge(f.account.address, f.image, draft);
  const expired = f.store.challenge(f.account.address, f.image, draft);
  f.store.db.prepare("UPDATE asset_challenges SET state = 'expired' WHERE id = ?").run(expired.id);
  const result = f.run(await f.snapshot(), { execute: true, serviceStopped: true });
  assert.equal(result.changed, 1);
  assert.equal(result.counts.pending, 1);
  assert.equal(result.counts.expired, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM asset_challenges WHERE id = ?").get(other.id).state, "pending");
});

test("post-backup quota, challenge and object changes prevent recovery", async (t) => {
  const f = await fixture(t);
  const backup = await f.snapshot();
  f.store.budget.request("synthetic-client");
  const before = state(f.store.db);
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }), { code: "asset_backup_outdated" });
  assert.deepEqual(state(f.store.db), before);
  const latest = await f.snapshot();
  writeFileSync(join(f.store.directory, `.${randomBytes(16).toString("hex")}.tmp`), "evidence", { mode: 0o600 });
  assert.throws(() => f.run(latest, { execute: true, serviceStopped: true }), { code: "asset_backup_outdated" });
});

for (const kind of ["symlink", "hardlink", "fifo"]) {
  test(`${kind} substitution after backup cannot be recovered`, async (t) => {
    const f = await fixture(t);
    const backup = await f.snapshot();
    const path = join(f.store.directory, `${f.approval.imageHash}.webp`);
    rmSync(path);
    const other = join(f.parent, "image");
    writeFileSync(other, f.image, { mode: 0o600 });
    if (kind === "symlink") symlinkSync(other, path);
    if (kind === "hardlink") linkSync(other, path);
    if (kind === "fifo") execFileSync("mkfifo", [path]);
    const before = state(f.store.db);
    assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }));
    assert.deepEqual(state(f.store.db), before);
  });
}

test("database errors roll back registrations, publication and unexpected quota writes", async (t) => {
  const f = await fixture(t);
  const backup = await f.snapshot();
  const before = state(f.store.db);
  f.store.db.exec("CREATE TRIGGER fail_recovery BEFORE UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }));
  assert.deepEqual(state(f.store.db), before);
  f.store.db.exec("DROP TRIGGER fail_recovery");
  f.store.db.exec("CREATE TRIGGER modify_quota AFTER UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' BEGIN UPDATE counters SET used = 0; END");
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }), { code: "asset_integrity_failed" });
  assert.deepEqual(state(f.store.db), before);
  f.store.db.exec("DROP TRIGGER modify_quota");
});

test("shared registered content is reused without replacing files", async (t) => {
  const f = await fixture(t);
  f.store.db.prepare("INSERT INTO asset_objects VALUES (?, ?)").run(`${f.approval.imageHash}.webp`, f.image.length);
  const result = f.run(await f.snapshot(), { execute: true, serviceStopped: true });
  assert.equal(result.changed, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM asset_objects").get().count, 2);
  assert.equal(f.store.status(f.query).status, "published");
});

test("failure on a later reservation rolls back the whole recovery batch", async (t) => {
  const f = await fixture(t);
  const nextDraft = { ...draft, name: "Next" };
  const approval = f.store.challenge(f.account.address, f.image, nextDraft);
  const signed = await f.account.signMessage({ message: approval.message });
  f.store.db.exec("CREATE TRIGGER interrupted BEFORE UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  await assert.rejects(f.store.publish({ id: approval.id, wallet: f.account.address, signature: signed, image: f.image, draft: nextDraft }));
  f.store.db.exec("DROP TRIGGER interrupted");
  const backup = await f.snapshot();
  const before = state(f.store.db);
  const last = f.store.db.prepare("SELECT id FROM asset_challenges ORDER BY id DESC LIMIT 1").get().id;
  f.store.db.exec(`CREATE TRIGGER fail_last BEFORE UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' AND NEW.id = '${last}' BEGIN SELECT RAISE(ABORT, 'test failure'); END`);
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }));
  assert.deepEqual(state(f.store.db), before);
  f.store.db.exec("DROP TRIGGER fail_last");
  assert.equal(f.run(backup, { execute: true, serviceStopped: true }).changed, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM asset_objects").get().count, 3);
});

test("quarantined restores cannot be activated through recovery", async (t) => {
  const f = await fixture(t);
  const backup = await f.snapshot();
  const root = join(f.parent, "restored");
  restoreAssetBackup({ ...backup, output: root, now: f.now, execute: true, serviceStopped: true });
  assert.throws(() => f.run(backup, { root, execute: true, serviceStopped: true }));
  assert.throws(() => new AssetStore({ ...f.config, root }), { code: "asset_restore_quarantined" });
});

test("malformed pinned application origins refuse backup and recovery without mutation", async (t) => {
  const f = await fixture(t);
  const backup = await f.snapshot();
  f.store.db.prepare("UPDATE settings SET value = ? WHERE name = 'asset-app-origin'").run("not-an-origin");
  const before = state(f.store.db);
  await assert.rejects(f.snapshot());
  assert.throws(() => f.run(backup, { execute: true, serviceStopped: true }));
  assert.deepEqual(state(f.store.db), before);
});

test("mixed complete and incomplete reservations finalize only the complete bundle", async (t) => {
  const f = await fixture(t);
  const nextDraft = { ...draft, name: "Incomplete" };
  const approval = f.store.challenge(f.account.address, f.image, nextDraft);
  const signed = await f.account.signMessage({ message: approval.message });
  f.store.db.exec("CREATE TRIGGER interrupted BEFORE UPDATE OF state ON asset_challenges WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  await assert.rejects(f.store.publish({ id: approval.id, wallet: f.account.address, signature: signed, image: f.image, draft: nextDraft }));
  f.store.db.exec("DROP TRIGGER interrupted");
  rmSync(join(f.store.directory, `${approval.metadataHash}.json`));
  const counters = state(f.store.db)[1];
  const result = f.run(await f.snapshot(), { execute: true, serviceStopped: true });
  assert.equal(result.changed, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.counts.published, 1);
  assert.equal(result.counts.reserved, 1);
  assert.deepEqual(state(f.store.db)[1], counters);
  assert.equal(f.store.status(f.query).status, "published");
  assert.equal(f.store.db.prepare("SELECT state FROM asset_challenges WHERE id = ?").get(approval.id).state, "reserved");
});
