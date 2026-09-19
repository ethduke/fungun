import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  openSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { ServiceError } from "./errors.mjs";
import { safeImageErrorCode } from "./image-errors.mjs";

export const IMAGE_PAYMENT_TIMEOUT_SECONDS = 300;

const hash = (value) => createHash("sha256").update(value).digest("hex");
const schema = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  CREATE TABLE image_jobs (
    id TEXT PRIMARY KEY, wallet TEXT NOT NULL, auth_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL, input TEXT NOT NULL, product TEXT NOT NULL,
    requirements TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'awaiting_payment', transaction_hash TEXT UNIQUE,
    payment_proof TEXT, payment_response TEXT, authorization_ref TEXT UNIQUE, settlement_transaction TEXT,
    settlement_attempts INTEGER NOT NULL DEFAULT 0, settlement_attempted_at INTEGER, settlement_checked_at INTEGER,
    started_at INTEGER, raw_image BLOB, image BLOB, image_hash TEXT,
    width INTEGER, height INTEGER, error TEXT, accounting TEXT NOT NULL DEFAULT 'unpaid'
  );
  PRAGMA user_version=1;
`;

export function initializeImageJobs(path) {
  closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(schema);
  } finally {
    db.close();
  }
}

export function imageJobsPath(assetRoot, production = false) {
  return production
    ? "/data/image-jobs.sqlite"
    : join(dirname(assetRoot), `${basename(assetRoot)}-image-jobs.sqlite`);
}

export class ImageJobStore {
  constructor(path, { now = Date.now, maxJobs = 2000, dailyLimit = 100 } = {}) {
    if (path !== ":memory:") {
      const stat = lstatSync(path);
      if (realpathSync(path) !== path || !stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077)
        throw new ServiceError("image_storage_unavailable");
    }
    if (path !== ":memory:") {
      this.lockPath = `${path}.owner`;
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
          throw new ServiceError("image_store_locked");
        try {
          process.kill(owner.pid, 0);
          throw new ServiceError("image_store_locked");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        unlinkSync(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const fd = openSync(this.lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        closeSync(fd);
      }
    }
    this.db = new DatabaseSync(path);
    if (path === ":memory:") this.db.exec(schema);
    if (this.db.prepare("PRAGMA user_version").get().user_version !== 1) {
      this.db.close();
      throw new ServiceError("image_storage_unavailable");
    }
    this.db.exec("PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.now = now;
    this.maxJobs = maxJobs;
    this.dailyLimit = dailyLimit;
    // A crash during an upstream POST is never permission to issue it again.
    this.db
      .prepare(
        "UPDATE image_jobs SET state='unknown', error='image_outcome_unknown', accounting='not_charged' WHERE state='generating'",
      )
      .run();
  }
  get(id) {
    return this.db.prepare("SELECT * FROM image_jobs WHERE id=?").get(id);
  }
  authenticate(id, token) {
    const job = this.get(id);
    if (
      !job ||
      typeof token !== "string" ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(job.auth_hash, "hex"), Buffer.from(hash(token), "hex"))
    )
      throw new ServiceError("image_not_found", 404);
    return job;
  }
  quote(input, token, config, product) {
    const serialized = JSON.stringify(input);
    const inputHash = hash(JSON.stringify({ input, product, origin: config.appOrigin }));
    const existing = this.get(input.requestId);
    if (existing) {
      this.authenticate(input.requestId, token);
      if (existing.input_hash !== inputHash) throw new ServiceError("image_request_changed", 409);
      return existing;
    }
    this.db
      .prepare("DELETE FROM image_jobs WHERE state='awaiting_payment' AND expires_at<?")
      .run(this.now());
    if (this.db.prepare("SELECT COUNT(*) AS n FROM image_jobs").get().n >= this.maxJobs)
      throw new ServiceError("image_storage_full", 507);
    const reserved = this.db
      .prepare(
        "SELECT COALESCE(SUM(COALESCE(length(raw_image),0)+COALESCE(length(image),0)+CASE WHEN state IN ('awaiting_payment','authorized','generating') THEN 2097152 ELSE 0 END),0) AS n FROM image_jobs",
      )
      .get().n;
    if (reserved + 2097152 > 256 * 1024 * 1024) throw new ServiceError("image_storage_full", 507);
    const createdAt = this.now();
    const expiresAt = createdAt + IMAGE_PAYMENT_TIMEOUT_SECONDS * 1000;
    const requirements = {
      scheme: "exact",
      network: "eip155:4663",
      asset: config.asset,
      amount: config.amount,
      payTo: config.payTo,
      maxTimeoutSeconds: IMAGE_PAYMENT_TIMEOUT_SECONDS,
      extra: {
        assetTransferMethod: "eip3009",
        paymentFlow: "authorization",
        name: config.domainName,
        version: config.domainVersion,
        symbol: "USDG",
        decimals: 6,
        payer: input.wallet,
        requestId: input.requestId,
        inputHash,
        product,
        nonce: `0x${randomBytes(32).toString("hex")}`,
        ...(config.fromBlock ? { fromBlock: config.fromBlock } : {}),
        issuedAt: createdAt,
        expiresAt,
      },
    };
    this.db
      .prepare(
        "INSERT INTO image_jobs(id,wallet,auth_hash,input_hash,input,product,requirements,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.requestId,
        input.wallet,
        hash(token),
        inputHash,
        serialized,
        product,
        JSON.stringify(requirements),
        createdAt,
        expiresAt,
      );
    return this.get(input.requestId);
  }
  authorize(id, proof) {
    const job = this.get(id);
    if (!job || job.requirements !== JSON.stringify(proof.accepted))
      throw new ServiceError("image_quote_expired", 409);
    const nonce = JSON.parse(job.requirements).extra.nonce;
    try {
      this.db
        .prepare(
          "UPDATE image_jobs SET state='authorized', payment_proof=?, authorization_ref=?, accounting='authorized' WHERE id=? AND state='awaiting_payment'",
        )
        .run(JSON.stringify(proof), `${job.wallet}:${nonce}`, id);
    } catch (error) {
      if (String(error.message).includes("UNIQUE"))
        throw new ServiceError("image_payment_reused", 409);
      throw error;
    }
    return this.get(id);
  }
  claim(id) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const job = this.get(id);
      const since = this.now() - 86400000;
      if (job.expires_at - this.now() < 210000) {
        this.db
          .prepare(
            "UPDATE image_jobs SET state='failed',error='image_quote_expired',accounting='not_charged' WHERE id=? AND state='authorized'",
          )
          .run(id);
        this.db.exec("COMMIT");
        return false;
      }
      const total = this.db
        .prepare("SELECT COUNT(*) AS n FROM image_jobs WHERE started_at>?")
        .get(since).n;
      const payer = this.db
        .prepare("SELECT COUNT(*) AS n FROM image_jobs WHERE started_at>? AND wallet=?")
        .get(since, job.wallet).n;
      if (total >= this.dailyLimit || payer >= 10) {
        this.db
          .prepare(
            "UPDATE image_jobs SET state='failed',error='image_daily_limit',accounting='not_charged' WHERE id=? AND state='authorized'",
          )
          .run(id);
        this.db.exec("COMMIT");
        return false;
      }
      const result = this.db
        .prepare(
          "UPDATE image_jobs SET state='generating',started_at=? WHERE id=? AND state='authorized'",
        )
        .run(this.now(), id);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  generated(id, bytes) {
    this.db
      .prepare(
        "UPDATE image_jobs SET state='generated',raw_image=? WHERE id=? AND state='generating'",
      )
      .run(bytes, id);
  }
  stageImage(id, result) {
    this.db
      .prepare(
        "UPDATE image_jobs SET state='settlement_pending',accounting='settlement_pending',image=?,image_hash=?,width=?,height=?,raw_image=NULL WHERE id=? AND state='generated'",
      )
      .run(result.bytes, hash(result.bytes), result.width, result.height, id);
  }
  complete(id, payment) {
    this.db
      .prepare(
        "UPDATE image_jobs SET state='completed',accounting='paid',transaction_hash=?,payment_response=?,error=NULL WHERE id=? AND state='settlement_pending'",
      )
      .run(payment.transaction.toLowerCase(), JSON.stringify(payment), id);
  }
  beginSettlement(id) {
    const result = this.db
      .prepare(
        "UPDATE image_jobs SET settlement_attempts=settlement_attempts+1,settlement_attempted_at=? WHERE id=? AND state='settlement_pending' AND settlement_attempts<3 AND (settlement_attempted_at IS NULL OR settlement_attempted_at<=?)",
      )
      .run(this.now(), id, this.now() - 30000);
    return result.changes === 1;
  }
  beginReconciliation(id) {
    const result = this.db
      .prepare(
        "UPDATE image_jobs SET settlement_checked_at=? WHERE id=? AND state='settlement_pending' AND (settlement_checked_at IS NULL OR settlement_checked_at<=?)",
      )
      .run(this.now(), id, this.now() - 30000);
    return result.changes === 1;
  }
  fail(id, code, unknown = false) {
    this.db
      .prepare(
        "UPDATE image_jobs SET state=?,error=?,accounting='not_charged',raw_image=NULL WHERE id=? AND state IN ('authorized','generating','generated')",
      )
      .run(unknown ? "unknown" : "failed", safeImageErrorCode(code), id);
  }
  failSettlement(id, code = "image_settlement_failed") {
    this.db
      .prepare(
        "UPDATE image_jobs SET state='failed',error=?,accounting='not_charged' WHERE id=? AND state='settlement_pending'",
      )
      .run(safeImageErrorCode(code), id);
  }
  settlementPending(id, transaction, code = "image_settlement_pending") {
    const error = code === "image_settlement_review_required" ? code : "image_settlement_pending";
    this.db
      .prepare(
        "UPDATE image_jobs SET error=CASE WHEN error='image_settlement_review_required' THEN error ELSE ? END,settlement_transaction=COALESCE(?,settlement_transaction) WHERE id=? AND state='settlement_pending'",
      )
      .run(
        error,
        /^0x[a-f0-9]{64}$/i.test(transaction || "") ? transaction.toLowerCase() : null,
        id,
      );
  }
  pending() {
    return this.db
      .prepare(
        "SELECT id FROM image_jobs WHERE state IN ('authorized','generated','settlement_pending') ORDER BY created_at",
      )
      .all();
  }
  close() {
    this.db.close();
    if (this.lockPath) unlinkSync(this.lockPath);
  }
}
