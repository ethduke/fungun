import { backup, DatabaseSync } from "node:sqlite";
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  opendirSync, statfsSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { checkAssetRoot, checkAssetStorage, readExact, syncDirectory,
  validAssetOrigin, validAssetAppOrigin } from "./asset-store.mjs";
import { inspectAssetDatabase } from "./asset-maintenance.mjs";
import { buildLongMetadata } from "./launch-metadata.mjs";
import { ServiceError } from "./errors.mjs";

const MiB = 1024 * 1024;
const databaseLimit = 16 * MiB;
const byteLimit = 256 * MiB;
const fileLimit = 12288;
const manifestLimit = 3 * MiB;
const manifestName = "backup.manifest.json";
const hashPattern = /^[a-f0-9]{64}$/;
const objectPattern = /^(?:[a-f0-9]{64}\.(?:webp|json)|\.[a-f0-9]{32}\.tmp)$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new ServiceError("asset_snapshot_invalid"); };

function database(path, readOnly = true) {
  const db = new DatabaseSync(path, { readOnly, timeout: 1000 });
  db.exec("PRAGMA trusted_schema = OFF");
  return db;
}

function destination(path, source) {
  if (!path || resolve(path) !== path || existsSync(path)) fail();
  checkAssetRoot(dirname(path));
  if (path.startsWith(source + sep) || source.startsWith(path + sep)) fail();
}

function writeNew(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function privateFile(path, limit) {
  if ((lstatSync(path).mode & 0o077) !== 0) fail();
  return readExact(path, limit);
}

function directoryNames(path, limit) {
  const names = [];
  const directory = opendirSync(path);
  try {
    for (let entry; (entry = directory.readSync());) {
      if (names.length === limit) fail();
      names.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return names.sort();
}

function databaseFiles(root) {
  const allowed = new Set(["assets.sqlite", "assets.sqlite-wal", "assets.sqlite-shm", "objects"]);
  const names = directoryNames(root, 4);
  for (const name of names) if (!allowed.has(name)) fail();
  for (const [name, limit] of [["assets.sqlite", databaseLimit], ["assets.sqlite-wal", 32 * MiB],
    ["assets.sqlite-shm", MiB]]) {
    const path = join(root, name);
    if (!names.includes(name)) continue;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || (stat.mode & 0o077) !== 0) fail();
  }
}

export function checkAssetSnapshotSource(root, production = false) {
  checkAssetStorage(root, production);
  databaseFiles(root);
}

function inventory(db, root, now, quarantined) {
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const pages = db.prepare("PRAGMA page_count").get().page_count;
  if (pages * pageSize > databaseLimit) fail();
  const stats = inspectAssetDatabase(db, now);
  const setting = (name) => db.prepare("SELECT value FROM settings WHERE name = ?").get(name)?.value;
  if (stats.schema !== 2 ||
      setting("asset-restore-state") !== (quarantined ? "quarantined" : undefined) ||
      Object.values(stats.counts).reduce((a, b) => a + b, 0) > 4096) fail();
  const rows = db.prepare("SELECT * FROM asset_challenges").all();
  const origin = setting("asset-origin");
  const appOrigin = setting("asset-app-origin");
  const unpinned = !rows.length && origin === "" && appOrigin === "";
  if (!unpinned && (!validAssetOrigin(origin) || !validAssetAppOrigin(appOrigin))) fail();
  const names = directoryNames(join(root, "objects"), fileLimit);
  const files = new Map();
  let total = 0;
  for (const name of names) {
    if (!objectPattern.test(name)) fail();
    const bytes = privateFile(join(root, "objects", name), 2 * MiB);
    total += bytes.length;
    if (total > byteLimit) fail();
    files.set(name, { name, bytes: bytes.length, sha256: hash(bytes) });
  }
  const objects = db.prepare("SELECT * FROM asset_objects LIMIT 8193").all();
  if (objects.length > 8192) fail();
  const registered = new Map();
  for (const row of objects) {
    if (!/^[a-f0-9]{64}\.(?:webp|json)$/.test(row.name)) fail();
    const file = files.get(row.name);
    if (!file || file.bytes !== row.bytes || file.sha256 !== row.name.split(".")[0]) fail();
    registered.set(row.name, row.bytes);
  }
  for (const row of rows) {
    if (!/^[a-f0-9]{48}$/.test(row.id) || !hashPattern.test(row.owner) ||
        !hashPattern.test(row.image_hash) || !hashPattern.test(row.metadata_hash) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 2 * MiB + 16384 ||
        !Number.isSafeInteger(row.created) || !Number.isSafeInteger(row.expires) ||
        row.expires <= row.created) fail();
    if (row.state !== "published") continue;
    const imageName = `${row.image_hash}.webp`;
    const metadataName = `${row.metadata_hash}.json`;
    if (!registered.has(imageName) || !registered.has(metadataName) ||
        registered.get(imageName) + registered.get(metadataName) !== row.bytes) fail();
    const bytes = privateFile(join(root, "objects", metadataName), 16384);
    const metadata = JSON.parse(bytes.toString("utf8"));
    const canonical = buildLongMetadata({ name: metadata.name, ticker: metadata.symbol,
      description: metadata.description }, `${origin}/launch-assets/${imageName}`, origin);
    if (!canonical.bytes.equals(bytes)) fail();
  }
  return { files: [...files.values()], total, stats };
}

function copyFiles(source, target, files) {
  for (const file of files) {
    const bytes = privateFile(join(source, "objects", file.name), 2 * MiB);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail();
    writeNew(join(target, "objects", file.name), bytes);
  }
  syncDirectory(join(target, "objects"));
}

export async function backupAssets({ root, output, execute = false, serviceStopped = false,
  production = false, now = Date.now }) {
  checkAssetSnapshotSource(root, production);
  destination(output, root);
  const sameFilesystem = lstatSync(root).dev === lstatSync(dirname(output)).dev;
  if (execute && (!serviceStopped || (production && sameFilesystem))) fail();
  const fence = database(join(root, "assets.sqlite"), !execute);
  let locked = false;
  try {
    if (execute) { fence.exec("BEGIN IMMEDIATE"); locked = true; }
    const current = inventory(fence, root, now, false);
    if (!execute) return { mode: "backup", execute, files: current.files.length,
      bytes: current.total, sameFilesystem };
    const space = statfsSync(dirname(output));
    if (space.bavail * space.bsize < current.total + databaseLimit + manifestLimit + 256 * MiB) fail();
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(join(output, "objects"), { mode: 0o700 });
    const dbPath = join(output, "snapshot.pending.sqlite");
    writeNew(dbPath, Buffer.alloc(0));
    const source = database(join(root, "assets.sqlite"));
    try { await backup(source, dbPath); } finally { source.close(); }
    const copied = database(dbPath, false);
    let snapshot;
    try {
      copied.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL");
      snapshot = inventory(copied, root, now, false);
      copied.prepare("INSERT INTO settings VALUES ('asset-restore-state', 'quarantined')").run();
    } finally { copied.close(); }
    const dbBytes = readExact(dbPath, databaseLimit, true);
    linkSync(dbPath, join(output, "assets.sqlite"));
    unlinkSync(dbPath);
    syncDirectory(output);
    copyFiles(root, output, snapshot.files);
    const manifest = Buffer.from(JSON.stringify({ version: 1, created: snapshot.stats.cutoff,
      database: { bytes: dbBytes.length, sha256: hash(dbBytes) }, files: snapshot.files }));
    if (manifest.length > manifestLimit) fail();
    writeNew(join(output, manifestName), manifest);
    syncDirectory(output);
    syncDirectory(dirname(output));
    return { mode: "backup", execute, files: snapshot.files.length, bytes: snapshot.total,
      sameFilesystem, manifestSha256: hash(manifest), quarantined: true };
  } finally {
    if (locked) fence.exec("ROLLBACK");
    fence.close();
  }
}

function fields(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === expected.split(",").sort().join(",");
}

export function verifyAssetBackup({ backupRoot, expectedSha256, now = Date.now }) {
  if (!hashPattern.test(expectedSha256 ?? "")) fail();
  checkAssetStorage(backupRoot);
  if (directoryNames(backupRoot, 3).join(",") !== "assets.sqlite,backup.manifest.json,objects") fail();
  const bytes = privateFile(join(backupRoot, manifestName), manifestLimit);
  if (hash(bytes) !== expectedSha256) fail();
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!fields(manifest, "version,created,database,files") || manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.created) || manifest.created < 0 ||
      !fields(manifest.database, "bytes,sha256") || !Array.isArray(manifest.files) ||
      manifest.files.length > fileLimit) fail();
  const dbBytes = privateFile(join(backupRoot, "assets.sqlite"), databaseLimit);
  if (dbBytes.length !== manifest.database.bytes || hash(dbBytes) !== manifest.database.sha256) fail();
  const db = database(join(backupRoot, "assets.sqlite"));
  try {
    const actual = inventory(db, backupRoot, now, true);
    if (manifest.files.length !== actual.files.length) fail();
    for (let i = 0; i < actual.files.length; i++) {
      const expected = manifest.files[i];
      const file = actual.files[i];
      if (!fields(expected, "name,bytes,sha256") || expected.name !== file.name ||
          expected.bytes !== file.bytes || expected.sha256 !== file.sha256) fail();
    }
    return { mode: "verify", files: actual.files.length, bytes: actual.total,
      manifestSha256: expectedSha256, quarantined: true };
  } finally { db.close(); }
}

export function restoreAssetBackup({ backupRoot, expectedSha256, output, execute = false,
  serviceStopped = false, now = Date.now }) {
  const verified = verifyAssetBackup({ backupRoot, expectedSha256, now });
  destination(output, backupRoot);
  if (execute && !serviceStopped) fail();
  if (!execute) return { ...verified, mode: "restore", execute };
  const space = statfsSync(dirname(output));
  if (space.bavail * space.bsize < verified.bytes + databaseLimit + manifestLimit + 256 * MiB) fail();
  mkdirSync(output, { mode: 0o700 });
  mkdirSync(join(output, "objects"), { mode: 0o700 });
  const manifestBytes = privateFile(join(backupRoot, manifestName), manifestLimit);
  if (hash(manifestBytes) !== expectedSha256) fail();
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const dbBytes = privateFile(join(backupRoot, "assets.sqlite"), databaseLimit);
  if (hash(dbBytes) !== manifest.database.sha256) fail();
  writeNew(join(output, "assets.sqlite"), dbBytes);
  copyFiles(backupRoot, output, manifest.files);
  writeNew(join(output, manifestName), manifestBytes);
  syncDirectory(output);
  syncDirectory(dirname(output));
  verifyAssetBackup({ backupRoot: output, expectedSha256, now });
  return { ...verified, mode: "restore", execute };
}

function stateFingerprint(db) {
  const state = ["settings", "counters", "asset_challenges", "asset_objects"].map((table) =>
    db.prepare(`SELECT * FROM ${table}${table === "settings" ? " WHERE name != 'asset-restore-state'" : ""} ORDER BY 1`).all());
  return hash(JSON.stringify(state));
}

export function verifyRecoverySource({ db, root, backupRoot, expectedSha256, now = Date.now }) {
  verifyAssetBackup({ backupRoot, expectedSha256, now });
  const manifestBytes = privateFile(join(backupRoot, manifestName), manifestLimit);
  if (hash(manifestBytes) !== expectedSha256) fail();
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const dbBytes = privateFile(join(backupRoot, "assets.sqlite"), databaseLimit);
  if (hash(dbBytes) !== manifest.database.sha256) fail();
  const saved = database(join(backupRoot, "assets.sqlite"));
  try {
    const source = inventory(db, root, now, false);
    if (stateFingerprint(db) !== stateFingerprint(saved) ||
        JSON.stringify(source.files) !== JSON.stringify(manifest.files))
      throw new ServiceError("asset_backup_outdated");
    return source.stats;
  } finally { saved.close(); }
}
