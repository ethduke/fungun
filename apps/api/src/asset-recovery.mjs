import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readExact, syncDirectory } from "./asset-store.mjs";
import { checkAssetSnapshotSource, verifyRecoverySource } from "./asset-snapshot.mjs";
import { inspectAssetDatabase } from "./asset-maintenance.mjs";
import { buildLongMetadata } from "./launch-metadata.mjs";
import { rasterFormat } from "./launch-image.mjs";
import { ServiceError } from "./errors.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const state = (db) => Object.fromEntries(["settings", "counters", "asset_challenges", "asset_objects"]
  .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));

function completeBundle(directory, row, origin, sync) {
  const imageName = `${row.image_hash}.webp`;
  const metadataName = `${row.metadata_hash}.json`;
  const image = readExact(join(directory, imageName), 2 * 1024 * 1024, sync);
  const bytes = readExact(join(directory, metadataName), 16384, sync);
  if (hash(image) !== row.image_hash || hash(bytes) !== row.metadata_hash ||
      image.length + bytes.length !== row.bytes || rasterFormat(image) !== "webp")
    throw new ServiceError("asset_integrity_failed");
  const metadata = JSON.parse(bytes.toString("utf8"));
  const canonical = buildLongMetadata({ name: metadata.name, ticker: metadata.symbol,
    description: metadata.description }, `${origin}/launch-assets/${imageName}`, origin);
  if (!canonical.bytes.equals(bytes)) throw new ServiceError("asset_integrity_failed");
  return [[imageName, image.length], [metadataName, bytes.length]];
}

export function recoverCompleteAssets({ root, backupRoot, expectedSha256, execute = false,
  serviceStopped = false, production = false, now = Date.now }) {
  if (execute && !serviceStopped) throw new ServiceError("invalid_recovery_arguments");
  checkAssetSnapshotSource(root, production);
  const db = new DatabaseSync(join(root, "assets.sqlite"), { readOnly: !execute, timeout: 1000 });
  let transaction = false;
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    if (execute) db.exec("PRAGMA synchronous = FULL");
    db.exec(execute ? "BEGIN IMMEDIATE" : "BEGIN");
    transaction = true;
    const before = verifyRecoverySource({ db, root, backupRoot, expectedSha256, now });
    const origin = db.prepare("SELECT value FROM settings WHERE name = 'asset-origin'").get().value;
    const directory = join(root, "objects");
    const expected = state(db);
    const rows = expected.asset_challenges.filter((row) => row.state === "reserved");
    let eligible = 0;
    let blocked = 0;
    let changed = 0;
    for (const row of rows) {
      let files;
      try { files = completeBundle(directory, row, origin, execute); }
      catch { blocked += 1; continue; }
      eligible += 1;
      if (!execute) continue;
      for (const [name, bytes] of files) {
        const existing = db.prepare("SELECT bytes FROM asset_objects WHERE name = ?").get(name);
        if (existing && existing.bytes !== bytes) throw new ServiceError("asset_integrity_failed");
        if (!existing) {
          db.prepare("INSERT INTO asset_objects VALUES (?, ?)").run(name, bytes);
          expected.asset_objects.push({ name, bytes });
        }
      }
      const result = db.prepare("UPDATE asset_challenges SET state = 'published' WHERE id = ? AND state = 'reserved'").run(row.id);
      if (result.changes !== 1) throw new ServiceError("asset_recovery_conflict");
      row.state = "published";
      changed += 1;
    }
    if (changed) syncDirectory(directory);
    const after = inspectAssetDatabase(db, () => before.cutoff);
    expected.asset_objects.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (after.reservedBytes !== before.reservedBytes || JSON.stringify(expected) !== JSON.stringify(state(db)))
      throw new ServiceError("asset_integrity_failed");
    db.exec("COMMIT");
    transaction = false;
    return { mode: "recover-complete", execute, eligible, blocked, changed,
      counts: after.counts, reservedBytes: after.reservedBytes, launchReady: false };
  } catch (error) {
    if (transaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}
