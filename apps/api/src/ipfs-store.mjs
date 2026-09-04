import { createHmac, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statfsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isAddress, recoverMessageAddress, zeroAddress } from "viem";
import { Budget } from "./budget.mjs";
import { ServiceError } from "./errors.mjs";
import { checkAssetRoot, readExact, syncDirectory, validAssetAppOrigin, writeOnce } from "./asset-store.mjs";
import { IPFS_IMPORT_PROFILE, LONG_IPFS_SCHEMA, prepareLongIpfsAssets } from "./ipfs-content.mjs";
import { pinataGatewayOrigin, pinataGatewayUrl } from "./pinata-publisher.mjs";

const day = 86400000;
const maximumBytes = 256 * 1024 * 1024;
const validId = (id) => typeof id === "string" && /^[a-f0-9]{48}$/.test(id);
const validWallet = (wallet) => typeof wallet === "string" && isAddress(wallet) && wallet.toLowerCase() !== zeroAddress;

export function initializeIpfsStore(root, production = false, now = Date.now) {
  checkAssetRoot(root, production);
  const path = join(root, "ipfs.sqlite");
  if (existsSync(join(root, "ipfs-staging"))) throw new ServiceError("asset_storage_already_initialized");
  closeSync(openSync(path, "wx", 0o600));
  const budget = new Budget(path, now);
  try {
    budget.db.exec(readFileSync(new URL("../migrations/003-ipfs-publications.sql", import.meta.url), "utf8"));
    mkdirSync(join(root, "ipfs-staging"), { mode: 0o700 });
    syncDirectory(root);
  } finally { budget.close(); }
}

export class IpfsStore {
  constructor({ root, appOrigin, gateway, production = false, now = Date.now }) {
    checkAssetRoot(root, production);
    if (!validAssetAppOrigin(appOrigin, production)) throw new ServiceError("invalid_asset_origin");
    for (const [name, directory] of [["ipfs.sqlite", false], ["ipfs-staging", true]]) {
      const path = join(root, name), stat = lstatSync(path);
      if (realpathSync(path) !== path || stat.mode & 0o077
        || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1))
        throw new ServiceError("asset_storage_unavailable");
    }
    pinataGatewayOrigin(gateway);
    this.root = root;
    this.directory = join(root, "ipfs-staging");
    this.appOrigin = appOrigin;
    this.gateway = gateway;
    this.now = now;
    this.busy = false;
    this.budget = new Budget(join(root, "ipfs.sqlite"), now, false);
    this.db = this.budget.db;
    this.db.exec("PRAGMA foreign_keys=ON");
    try {
      if (this.setting("ipfs-schema") !== "1") throw new ServiceError("asset_migration_required");
      for (const [name, value] of [["ipfs-app-origin", appOrigin], ["ipfs-gateway", gateway]]) {
        this.db.prepare("UPDATE settings SET value=? WHERE name=? AND value=''").run(value, name);
        if (this.setting(name) !== value) throw new ServiceError("asset_origin_changed");
      }
      if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new ServiceError("asset_storage_unavailable");
    } catch (error) { this.budget.close(); throw error; }
  }
  setting(name) { return this.db.prepare("SELECT value FROM settings WHERE name=?").get(name)?.value; }
  clock() {
    const previous = Number(this.setting("clock")), now = this.now();
    if (!Number.isSafeInteger(now) || now < previous - 1000) throw new ServiceError("asset_clock_unavailable");
    return Math.max(previous, now);
  }
  owner(wallet) { return createHmac("sha256", this.budget.key).update(wallet.toLowerCase()).digest("hex"); }
  get(id) { return validId(id) ? this.db.prepare("SELECT * FROM ipfs_publications WHERE id=?").get(id) : undefined; }
  objects(id) { return this.db.prepare("SELECT * FROM ipfs_objects WHERE publication_id=? ORDER BY kind").all(id); }
  ipfs(row) { return { profile: row.profile, schema: row.schema_name, imageCid: row.image_cid, metadataCid: row.metadata_cid }; }
  links(row) {
    return { imageUrl: pinataGatewayUrl(this.gateway, row.image_cid), metadataUrl: pinataGatewayUrl(this.gateway, row.metadata_cid) };
  }
  message(row, wallet) {
    return [
      "Publish memecoin assets — no transaction or token approval.", "Intent version: 2",
      `Website: ${this.appOrigin}`, `Public asset origin: https://${this.gateway}`,
      `Wallet: ${wallet.toLowerCase()}`, "Chain ID: 4663", "Launchpad: Long", "Storage: public IPFS",
      `Importer: ${row.profile}`, `Metadata schema: ${row.schema_name}`,
      `Image URI: ipfs://${row.image_cid}`, `Metadata URI: ipfs://${row.metadata_cid}`,
      `Image SHA-256: ${row.image_hash}`, `Metadata SHA-256: ${row.metadata_hash}`,
      `Total published bytes: ${row.image_size + row.metadata_size}`,
      "I approve publishing these exact images and metadata publicly. Copies may remain permanently.",
      `Nonce: ${row.id}`, `Issued at: ${row.created}`, `Expires at: ${row.expires}`,
    ].join("\n");
  }
  async challenge(wallet, image, draft) {
    if (!validWallet(wallet)) throw new ServiceError("invalid_wallet", 400);
    const bundle = await prepareLongIpfsAssets(image, draft), now = this.clock(), owner = this.owner(wallet);
    this.db.prepare("UPDATE ipfs_publications SET state='expired' WHERE state='pending' AND expires<?").run(now);
    const existing = this.db.prepare("SELECT * FROM ipfs_publications WHERE owner=? AND state IN ('pending','reserved')").get(owner);
    if (existing) {
      if (existing.state === "pending" && this.matches(existing, bundle)) return this.preview(existing, wallet, bundle);
      throw new ServiceError(existing.state === "reserved" ? "asset_publication_uncertain" : "ipfs_approval_pending", 409);
    }
    if (this.db.prepare("SELECT COUNT(*) AS n FROM ipfs_publications").get().n >= 4096)
      throw new ServiceError("asset_history_full", 507);
    this.budget.debit([["ipfs-challenges", 60, day], ["ipfs-challenges", 6, 60000]]);
    const row = { id: randomBytes(24).toString("hex"), owner, draft: JSON.stringify(bundle.draft),
      profile: bundle.profile, schema_name: bundle.schema, image_cid: bundle.image.cid, metadata_cid: bundle.metadata.cid,
      image_hash: bundle.image.sha256, metadata_hash: bundle.metadata.sha256,
      image_size: bundle.image.bytes.length, metadata_size: bundle.metadata.bytes.length, created: now, expires: now + 300000 };
    this.db.prepare(`INSERT INTO ipfs_publications
      (id,owner,draft,profile,schema_name,image_cid,metadata_cid,image_hash,metadata_hash,image_size,metadata_size,created,expires,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`).run(...Object.values(row));
    return this.preview(row, wallet, bundle);
  }
  matches(row, bundle) {
    return row.profile === IPFS_IMPORT_PROFILE && row.schema_name === LONG_IPFS_SCHEMA
      && row.draft === JSON.stringify(bundle.draft)
      && row.image_hash === bundle.image.sha256 && row.metadata_hash === bundle.metadata.sha256
      && row.image_cid === bundle.image.cid && row.metadata_cid === bundle.metadata.cid
      && row.image_size === bundle.image.bytes.length && row.metadata_size === bundle.metadata.bytes.length;
  }
  preview(row, wallet, bundle) {
    return { id: row.id, message: this.message(row, wallet), issuedAt: row.created, expiresAt: row.expires,
      totalBytes: row.image_size + row.metadata_size, imageHash: row.image_hash, metadataHash: row.metadata_hash,
      ...this.links(row), ipfs: this.ipfs(row), draft: bundle.draft };
  }
  async accept({ id, wallet, signature, image, draft }) {
    if (this.busy) throw new ServiceError("asset_busy", 429, 2);
    this.busy = true;
    try {
      if (!validId(id) || !validWallet(wallet) || typeof signature !== "string" || !/^0x[a-f0-9]{130}$/i.test(signature))
        throw new ServiceError("invalid_asset_approval", 400);
      const bundle = await prepareLongIpfsAssets(image, draft);
      let row = this.get(id);
      if (!row || row.owner !== this.owner(wallet) || !this.matches(row, bundle))
        throw new ServiceError("asset_approval_changed", 400);
      let signer;
      try { signer = await recoverMessageAddress({ message: this.message(row, wallet), signature }); }
      catch { throw new ServiceError("invalid_asset_approval", 400); }
      if (signer.toLowerCase() !== wallet.toLowerCase()) throw new ServiceError("invalid_asset_approval", 400);
      row = this.get(id);
      if (row.state === "published") return this.result(row);
      if (row.state === "reserved") {
        for (const [kind, object] of [["image", bundle.image], ["metadata", bundle.metadata]])
          writeOnce(this.directory, `${id}.${kind}`, object.bytes);
        this.staged(id);
        return this.result(this.get(id));
      }
      if (row.state !== "pending" || row.expires < this.clock()) throw new ServiceError("asset_approval_expired", 409);
      const disk = statfsSync(this.root);
      if (disk.bavail * disk.bsize < maximumBytes + bundle.totalBytes * 2) throw new ServiceError("asset_storage_full", 507);
      this.budget.debit([["ipfs-publications", 30, day], [`ipfs-owner:${row.owner}`, 3, day]]);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const reserved = this.db.prepare("SELECT COALESCE(SUM(image_size+metadata_size),0) AS n FROM ipfs_publications WHERE approved IS NOT NULL").get().n;
        if (reserved + bundle.totalBytes > maximumBytes) throw new ServiceError("asset_storage_full", 507);
        if (row.expires < this.clock()) throw new ServiceError("asset_approval_expired", 409);
        const changed = this.db.prepare("UPDATE ipfs_publications SET state='reserved',approved=? WHERE id=? AND state='pending'").run(this.clock(), id);
        if (changed.changes !== 1) throw new ServiceError("asset_publication_uncertain", 409);
        for (const kind of ["image", "metadata"])
          this.db.prepare("INSERT INTO ipfs_objects(publication_id,kind,state) VALUES (?,?,'staging')").run(id, kind);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      for (const [kind, object] of [["image", bundle.image], ["metadata", bundle.metadata]])
        writeOnce(this.directory, `${id}.${kind}`, object.bytes);
      this.staged(id);
      return this.result(this.get(id));
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("asset_publication_uncertain", 409);
    } finally { this.busy = false; }
  }
  status({ id, wallet, imageHash, metadataHash }) {
    const row = this.get(id);
    if (!validWallet(wallet) || !row || row.owner !== this.owner(wallet)
      || row.image_hash !== imageHash || row.metadata_hash !== metadataHash)
      throw new ServiceError("asset_approval_changed", 404);
    if (row.state === "pending" && row.expires < this.clock())
      this.db.prepare("UPDATE ipfs_publications SET state='expired' WHERE id=? AND state='pending'").run(id);
    return this.result(this.get(id));
  }
  result(row) {
    if (row.state === "expired") return { id: row.id, status: "expired", imageHash: row.image_hash, metadataHash: row.metadata_hash };
    if (row.state === "pending") return { id: row.id, status: "pending" };
    const base = { id: row.id, imageHash: row.image_hash, metadataHash: row.metadata_hash,
      ...this.links(row), ipfs: this.ipfs(row), launchReady: false };
    if (row.state === "published") return { ...base, status: "published" };
    const states = Object.fromEntries(this.objects(row.id).map((object) => [object.kind, object.state]));
    return { ...base, status: "processing", progress: { image: states.image, metadata: states.metadata },
      ...(row.error ? { issue: "verification_delayed", retryAt: row.next_check } : {}) };
  }
  pending() { return this.db.prepare("SELECT * FROM ipfs_publications WHERE state IN ('reserved','published') AND next_check<=? ORDER BY next_check,created LIMIT 30").all(this.clock()); }
  async bundle(row) {
    const image = readExact(join(this.directory, `${row.id}.image`), row.image_size);
    const bundle = await prepareLongIpfsAssets(image, JSON.parse(row.draft));
    if (!this.matches(row, bundle)
      || !readExact(join(this.directory, `${row.id}.metadata`), row.metadata_size).equals(bundle.metadata.bytes))
      throw new ServiceError("asset_integrity_failed");
    return bundle;
  }
  defer(id) { this.db.prepare("UPDATE ipfs_publications SET next_check=? WHERE id=? AND state IN ('reserved','published')").run(this.clock() + 60000, id); }
  failed(id) {
    this.db.prepare(`UPDATE ipfs_publications SET error='verification_delayed',attempts=attempts+1,
      next_check=? WHERE id=? AND state='reserved'`).run(this.clock() + 60000, id);
  }
  staged(id) { this.db.prepare("UPDATE ipfs_objects SET state='ready' WHERE publication_id=? AND state='staging'").run(id); }
  begin(id, kind) {
    return this.db.prepare("UPDATE ipfs_objects SET state='sending' WHERE publication_id=? AND kind=? AND state='ready'").run(id, kind).changes === 1;
  }
  pinned(id, kind, receipt) {
    this.db.prepare("UPDATE ipfs_objects SET state='pinned',provider_id=? WHERE publication_id=? AND kind=? AND state='sending'").run(receipt.id, id, kind);
  }
  verified(id, kind) {
    this.db.prepare("UPDATE ipfs_objects SET state='verified',verified_at=? WHERE publication_id=? AND kind=? AND state IN ('pinned','verified')").run(this.clock(), id, kind);
  }
  complete(id) {
    this.db.prepare(`UPDATE ipfs_publications SET state='published' WHERE id=? AND state='reserved'
      AND (SELECT COUNT(*) FROM ipfs_objects WHERE publication_id=? AND state='verified')=2`).run(id, id);
    this.cleanup(id);
  }
  cleanup(id) {
    if (this.get(id)?.state !== "published") return;
    for (const kind of ["image", "metadata"])
      try { unlinkSync(join(this.directory, `${id}.${kind}`)); }
      catch (error) { if (error.code !== "ENOENT") { this.defer(id); return; } }
    syncDirectory(this.directory);
    this.db.prepare("UPDATE ipfs_publications SET approved=NULL,next_check=? WHERE id=? AND state='published'").run(Number.MAX_SAFE_INTEGER, id);
  }
  close() { this.budget.close(); }
}
