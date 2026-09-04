import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  fstatSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { recoverMessageAddress, isAddress, zeroAddress } from "viem";
import { Budget } from "./budget.mjs";
import { ServiceError } from "./errors.mjs";
import { verifyProductionMount } from "./storage.mjs";
import { buildLongMetadata, normalizeLaunchDetails } from "./launch-metadata.mjs";
import { IMAGE_BYTE_LIMIT, rasterFormat } from "./launch-image.mjs";

const day = 86400000;
const maximumBytes = 256 * 1024 * 1024;
const minimumFree = 256 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const filenamePattern = /^[a-f0-9]{64}\.(?:webp|json)$/;

export function checkAssetRoot(root, production = false) {
  if (
    !root ||
    resolve(root) !== root ||
    realpathSync(root) !== root ||
    !lstatSync(root).isDirectory()
  )
    throw new ServiceError("asset_storage_unavailable");
  if ((lstatSync(root).mode & 0o077) !== 0) throw new ServiceError("asset_storage_permissions");
  for (let path = root; ; path = dirname(path)) {
    if (existsSync(join(path, ".git"))) throw new ServiceError("asset_storage_in_repository");
    if (path === dirname(path)) break;
  }
  if (production) {
    verifyProductionMount();
    if (root !== "/data/launch-assets") throw new ServiceError("asset_storage_unavailable");
  }
}

export function checkAssetStorage(root, production = false) {
  checkAssetRoot(root, production);
  for (const [name, directory] of [["assets.sqlite", false], ["objects", true]]) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o077) !== 0
    ) throw new ServiceError("asset_storage_unavailable");
  }
}

export function initializeAssetStore(root, production = false, now = Date.now) {
  checkAssetRoot(root, production);
  if (existsSync(join(root, "objects")))
    throw new ServiceError("asset_storage_already_initialized");
  const file = openSync(join(root, "assets.sqlite"), "wx", 0o600);
  closeSync(file);
  const budget = new Budget(join(root, "assets.sqlite"), now, true);
  try {
    budget.db.exec(readFileSync(new URL("../migrations/001-assets.sql", import.meta.url), "utf8"));
    budget.db.prepare("INSERT INTO settings VALUES (?, ?)").run("asset-schema", "1");
    budget.db.exec(readFileSync(new URL("../migrations/002-assets-expiry.sql", import.meta.url), "utf8"));
    budget.db.prepare("INSERT INTO settings VALUES (?, ?)").run("asset-bytes", "0");
    budget.db.prepare("INSERT INTO settings VALUES (?, ?)").run("asset-origin", "");
    budget.db.prepare("INSERT INTO settings VALUES (?, ?)").run("asset-app-origin", "");
    mkdirSync(join(root, "objects"), { mode: 0o700 });
    syncDirectory(root);
  } finally {
    budget.close();
  }
}

export function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readExact(path, limit, sync = false) {
  if (!lstatSync(path).isFile()) throw new ServiceError("asset_integrity_failed");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit)
      throw new ServiceError("asset_integrity_failed");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count !== stat.size) throw new ServiceError("asset_integrity_failed");
    if (sync) fsyncSync(fd);
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}

export function writeOnce(directory, name, bytes) {
  const target = join(directory, name);
  if (existsSync(target)) {
    if (!readExact(target, bytes.length, true).equals(bytes))
      throw new ServiceError("asset_integrity_failed");
    syncDirectory(directory);
    return;
  }
  const temporary = join(directory, `.${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Never overwrite an existing content address, even after an uncertain write.
  linkSync(temporary, target);
  unlinkSync(temporary);
  syncDirectory(directory);
}

export function validAssetOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validAssetAppOrigin(value, production = false) {
  return validAssetOrigin(value) || (!production && ["http://127.0.0.1:3000", "http://localhost:3000"].includes(value));
}

export class AssetStore {
  constructor({ root, publicOrigin, appOrigin, production = false, now = Date.now }) {
    checkAssetStorage(root, production);
    const inspection = new DatabaseSync(join(root, "assets.sqlite"), { readOnly: true });
    try {
      if (inspection.prepare("SELECT 1 FROM settings WHERE name = 'asset-restore-state'").get())
        throw new ServiceError("asset_restore_quarantined");
    } finally { inspection.close(); }
    if (
      !validAssetOrigin(publicOrigin) || !validAssetAppOrigin(appOrigin, production)
    )
      throw new ServiceError("invalid_asset_origin");
    this.root = root;
    this.directory = join(root, "objects");
    this.publicOrigin = publicOrigin;
    this.appOrigin = appOrigin;
    this.now = now;
    this.budget = new Budget(join(root, "assets.sqlite"), now, false);
    this.db = this.budget.db;
    try {
      const setting = (name) =>
        this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name)?.value;
      if (setting("asset-restore-state") !== undefined)
        throw new ServiceError("asset_restore_quarantined");
      const used = Number(setting("asset-bytes"));
      if (setting("asset-schema") === "1") throw new ServiceError("asset_migration_required");
      const reserved = this.db
        .prepare(
          "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM asset_challenges WHERE state IN ('reserved', 'published')",
        )
        .get().bytes;
      if (
        setting("asset-schema") !== "2" ||
        !/^\d+$/.test(setting("asset-bytes") ?? "") ||
        !Number.isSafeInteger(used) ||
        used > maximumBytes ||
        used !== reserved
      )
        throw new ServiceError("asset_storage_unavailable");
      for (const [name, value] of [
        ["asset-origin", publicOrigin],
        ["asset-app-origin", appOrigin],
      ]) {
        this.db
          .prepare("UPDATE settings SET value = ? WHERE name = ? AND value = ''")
          .run(value, name);
        if (setting(name) !== value) throw new ServiceError("asset_origin_changed");
      }
    } catch (error) {
      this.budget.close();
      throw error;
    }
    this.busy = false;
  }

  clock() {
    const previous = Number(
      this.db.prepare("SELECT value FROM settings WHERE name = 'clock'").get().value,
    );
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < previous - 1000)
      throw new ServiceError("asset_clock_unavailable");
    return Math.max(previous, now);
  }

  owner(wallet) {
    return createHmac("sha256", this.budget.key).update(wallet.toLowerCase()).digest("hex");
  }

  bundle(image, draft) {
    if (
      !Buffer.isBuffer(image) ||
      !image.length ||
      image.length > IMAGE_BYTE_LIMIT ||
      rasterFormat(image) !== "webp"
    )
      throw new ServiceError("invalid_asset_image", 400);
    const imageHash = digest(image);
    const imageUrl = `${this.publicOrigin}/launch-assets/${imageHash}.webp`;
    const metadata = buildLongMetadata(draft, imageUrl, this.publicOrigin);
    return {
      image,
      imageHash,
      imageUrl,
      metadata: metadata.bytes,
      metadataHash: metadata.sha256,
      metadataUrl: `${this.publicOrigin}/launch-assets/${metadata.sha256}.json`,
    };
  }

  message(row, wallet) {
    return [
      "Publish memecoin assets — no transaction or token approval.",
      "Intent version: 1",
      `Website: ${this.appOrigin}`,
      `Public asset origin: ${this.publicOrigin}`,
      `Wallet: ${wallet.toLowerCase()}`,
      "Chain ID: 4663",
      "Launchpad: Long",
      `Image SHA-256: ${row.image_hash}`,
      `Metadata SHA-256: ${row.metadata_hash}`,
      `Total published bytes: ${row.bytes}`,
      "I approve publishing these exact images and metadata publicly. Copies may remain permanently.",
      `Nonce: ${row.id}`,
      `Issued at: ${row.created}`,
      `Expires at: ${row.expires}`,
    ].join("\n");
  }

  challenge(wallet, image, draft) {
    if (typeof wallet !== "string" || !isAddress(wallet) || wallet.toLowerCase() === zeroAddress)
      throw new ServiceError("invalid_wallet", 400);
    const bundle = this.bundle(image, draft);
    const now = this.clock();
    if (this.db.prepare("SELECT COUNT(*) AS count FROM asset_challenges").get().count >= 4096)
      throw new ServiceError("asset_history_full", 507);
    if (
      this.db
        .prepare("SELECT COUNT(*) AS count FROM asset_challenges WHERE state = 'pending' AND expires >= ?")
        .get(now).count >= 64
    )
      throw new ServiceError("asset_busy", 429, 60);
    this.budget.debit([
      ["asset-challenges", 60, day],
      ["asset-challenges", 6, 60000],
    ]);
    const row = {
      id: randomBytes(24).toString("hex"),
      owner: this.owner(wallet),
      image_hash: bundle.imageHash,
      metadata_hash: bundle.metadataHash,
      bytes: bundle.image.length + bundle.metadata.length,
      created: now,
      expires: now + 300000,
    };
    this.db
      .prepare(
        "INSERT INTO asset_challenges (id, owner, image_hash, metadata_hash, bytes, created, expires, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(
        row.id,
        row.owner,
        row.image_hash,
        row.metadata_hash,
        row.bytes,
        row.created,
        row.expires,
      );
    return {
      id: row.id,
      message: this.message(row, wallet),
      issuedAt: row.created,
      totalBytes: row.bytes,
      expiresAt: row.expires,
      imageHash: row.image_hash,
      metadataHash: row.metadata_hash,
      imageUrl: bundle.imageUrl,
      metadataUrl: bundle.metadataUrl,
      draft: normalizeLaunchDetails(draft),
    };
  }

  async publish({ id, wallet, signature, image, draft }) {
    if (this.busy) throw new ServiceError("asset_busy", 429, 2);
    this.busy = true;
    try {
      if (
        typeof id !== "string" ||
        !/^[a-f0-9]{48}$/.test(id) ||
        typeof wallet !== "string" ||
        !isAddress(wallet) ||
        typeof signature !== "string" ||
        !/^0x[a-f0-9]{130}$/i.test(signature)
      )
        throw new ServiceError("invalid_asset_approval", 400);
      const bundle = this.bundle(image, draft);
      let row = this.db.prepare("SELECT * FROM asset_challenges WHERE id = ?").get(id);
      if (
        !row ||
        row.owner !== this.owner(wallet) ||
        row.image_hash !== bundle.imageHash ||
        row.metadata_hash !== bundle.metadataHash ||
        row.bytes !== image.length + bundle.metadata.length
      )
        throw new ServiceError("asset_approval_changed", 400);
      let signer;
      try {
        signer = await recoverMessageAddress({ message: this.message(row, wallet), signature });
      } catch {
        throw new ServiceError("invalid_asset_approval", 400);
      }
      if (signer.toLowerCase() !== wallet.toLowerCase())
        throw new ServiceError("invalid_asset_approval", 400);
      row = this.db.prepare("SELECT * FROM asset_challenges WHERE id = ?").get(id);
      if (!row) throw new ServiceError("asset_publication_uncertain", 409);
      if (row.state === "expired") throw new ServiceError("asset_approval_expired", 409);
      if (row.state === "published") {
        this.read(`${bundle.imageHash}.webp`);
        this.read(`${bundle.metadataHash}.json`);
        return this.result(bundle, id);
      }
      if (row.state !== "pending") throw new ServiceError("asset_publication_uncertain", 409);
      if (row.expires < this.clock()) throw new ServiceError("asset_approval_expired", 409);
      const disk = statfsSync(this.root);
      if (disk.bavail * disk.bsize < minimumFree + row.bytes * 2)
        throw new ServiceError("asset_storage_full", 507);
      this.budget.debit([
        ["asset-publications", 30, day],
        [`asset-owner:${row.owner}`, 3, day],
      ]);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (row.expires < this.clock()) throw new ServiceError("asset_approval_expired", 409);
        const used = Number(
          this.db.prepare("SELECT value FROM settings WHERE name = 'asset-bytes'").get().value,
        );
        if (used + row.bytes > maximumBytes) throw new ServiceError("asset_storage_full", 507);
        const changed = this.db
          .prepare(
            "UPDATE asset_challenges SET state = 'reserved' WHERE id = ? AND state = 'pending'",
          )
          .run(id);
        if (changed.changes !== 1) throw new ServiceError("asset_publication_uncertain", 409);
        this.db
          .prepare("UPDATE settings SET value = ? WHERE name = 'asset-bytes'")
          .run(String(used + row.bytes));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      writeOnce(this.directory, `${bundle.imageHash}.webp`, bundle.image);
      writeOnce(this.directory, `${bundle.metadataHash}.json`, bundle.metadata);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const [name, size] of [
          [`${bundle.imageHash}.webp`, image.length],
          [`${bundle.metadataHash}.json`, bundle.metadata.length],
        ])
          this.db.prepare("INSERT OR IGNORE INTO asset_objects VALUES (?, ?)").run(name, size);
        this.db
          .prepare(
            "UPDATE asset_challenges SET state = 'published' WHERE id = ? AND state = 'reserved'",
          )
          .run(id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return this.result(bundle, id);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("asset_publication_uncertain", 409);
    } finally {
      this.busy = false;
    }
  }

  status({ id, wallet, imageHash, metadataHash }) {
    if (
      typeof id !== "string" ||
      !/^[a-f0-9]{48}$/.test(id) ||
      typeof wallet !== "string" ||
      !isAddress(wallet)
    )
      throw new ServiceError("invalid_asset_approval", 400);
    const row = this.db.prepare("SELECT * FROM asset_challenges WHERE id = ?").get(id);
    if (
      !row ||
      row.owner !== this.owner(wallet) ||
      row.image_hash !== imageHash ||
      row.metadata_hash !== metadataHash
    )
      throw new ServiceError("asset_approval_changed", 404);
    if (row.state === "expired")
      return { id, status: "expired", imageHash, metadataHash };
    if (row.state !== "published")
      return { id, status: row.state === "reserved" ? "uncertain" : "pending" };
    this.read(`${imageHash}.webp`);
    this.read(`${metadataHash}.json`);
    return this.result(
      {
        imageHash,
        metadataHash,
        imageUrl: `${this.publicOrigin}/launch-assets/${imageHash}.webp`,
        metadataUrl: `${this.publicOrigin}/launch-assets/${metadataHash}.json`,
      },
      id,
    );
  }

  result(bundle, id) {
    return {
      id,
      status: "published",
      imageUrl: bundle.imageUrl,
      metadataUrl: bundle.metadataUrl,
      imageHash: bundle.imageHash,
      metadataHash: bundle.metadataHash,
      launchReady: false,
    };
  }

  read(name) {
    if (typeof name !== "string" || !filenamePattern.test(name))
      throw new ServiceError("not_found", 404);
    const row = this.db.prepare("SELECT bytes FROM asset_objects WHERE name = ?").get(name);
    if (!row) throw new ServiceError("not_found", 404);
    try {
      const bytes = readExact(
        join(this.directory, name),
        name.endsWith(".json") ? 16384 : IMAGE_BYTE_LIMIT,
      );
      if (bytes.length !== row.bytes || digest(bytes) !== name.split(".")[0]) throw new Error();
      return {
        bytes,
        mime: name.endsWith(".json") ? "application/json; charset=utf-8" : "image/webp",
        hash: name.split(".")[0],
      };
    } catch {
      throw new ServiceError("asset_integrity_failed");
    }
  }

  close() {
    this.budget.close();
  }
}
