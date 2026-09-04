import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { ServiceError } from "./errors.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FRESH_FOR = 6 * HOUR;
const RETAIN_FOR = 7 * DAY;
const ATTEMPT_LEASE = 10 * 60 * 1000;
const MAX_RECORD_BYTES = 256 * 1024;
const PROVIDER_RETRY_KEY = "catalog-provider-retry:o1";
const chains = new Set([4663, 8453]);

export function catalogPairId(chainId, address) {
  return `rwa-${createHash("sha256").update(`${chainId}:${address}`).digest("hex").slice(0, 24)}`;
}

function validQuote(quote, chainId) {
  if (
    !quote ||
    typeof quote !== "object" ||
    Array.isArray(quote) ||
    Object.keys(quote).sort().join(",") !== "address,decimals,id,symbol" ||
    typeof quote.address !== "string" ||
    quote.address !== quote.address.toLowerCase() ||
    !isAddress(quote.address) ||
    /^0x0+$/i.test(quote.address) ||
    quote.id !== catalogPairId(chainId, quote.address) ||
    typeof quote.symbol !== "string" ||
    !/^[A-Za-z0-9._-]{1,24}$/.test(quote.symbol) ||
    !Number.isInteger(quote.decimals) ||
    quote.decimals < 0 ||
    quote.decimals > 36
  )
    return false;
  return true;
}

function validateQuotes(quotes, chainId) {
  if (!Array.isArray(quotes) || quotes.length > 1000) return false;
  const addresses = new Set();
  const symbols = new Set();
  for (const quote of quotes) {
    if (!validQuote(quote, chainId)) return false;
    const symbol = quote.symbol.toUpperCase();
    if (addresses.has(quote.address) || symbols.has(symbol)) return false;
    addresses.add(quote.address);
    symbols.add(symbol);
  }
  return true;
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRecord(record, chainId) {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).sort().join(",") !==
      "attempts,chainId,checkedAt,freshUntil,lease,leaseUntil,nextAttemptAt,quotes,staleUntil,version" ||
    record.version !== 1 ||
    record.chainId !== chainId ||
    !validTime(record.checkedAt) ||
    !validTime(record.freshUntil) ||
    !validTime(record.staleUntil) ||
    !validTime(record.nextAttemptAt) ||
    !Number.isInteger(record.attempts) ||
    record.attempts < 0 ||
    record.attempts > 1000 ||
    !validTime(record.lease) ||
    !validTime(record.leaseUntil) ||
    (record.leaseUntil > 0 &&
      (record.attempts === 0 || record.nextAttemptAt !== record.leaseUntil)) ||
    !(
      (record.quotes === null &&
        record.checkedAt === 0 &&
        record.freshUntil === 0 &&
        record.staleUntil === 0) ||
      (validateQuotes(record.quotes, chainId) &&
        record.checkedAt > 0 &&
        record.checkedAt <= record.freshUntil &&
        record.freshUntil <= record.staleUntil)
    )
  )
    throw new ServiceError("catalog_cache_unavailable");
  return record;
}

export class CatalogSnapshots {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
  }

  key(chainId) {
    if (!chains.has(chainId)) throw new ServiceError("invalid_catalog");
    return `catalog-snapshot:${chainId}`;
  }

  current() {
    const current = this.now();
    if (!validTime(current)) throw new ServiceError("catalog_cache_unavailable");
    return current;
  }

  timeline() {
    const current = this.current();
    const persisted = Number(
      this.db.prepare("SELECT value FROM settings WHERE name='clock'").get()?.value,
    );
    if (!validTime(persisted)) throw new ServiceError("catalog_cache_unavailable");
    if (current > persisted)
      this.db.prepare("UPDATE settings SET value=? WHERE name='clock'").run(String(current));
    return { current, highWater: Math.max(current, persisted) };
  }

  clock() {
    return this.timeline().highWater;
  }

  read(chainId) {
    const value = this.db
      .prepare("SELECT value FROM settings WHERE name=?")
      .get(this.key(chainId))?.value;
    if (value === undefined) return null;
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_RECORD_BYTES)
      throw new ServiceError("catalog_cache_unavailable");
    try {
      return validateRecord(JSON.parse(value), chainId);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("catalog_cache_unavailable");
    }
  }

  write(record) {
    validateRecord(record, record.chainId);
    const value = JSON.stringify(record);
    if (Buffer.byteLength(value) > MAX_RECORD_BYTES)
      throw new ServiceError("catalog_cache_unavailable");
    this.db
      .prepare(
        "INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      )
      .run(this.key(record.chainId), value);
  }

  transaction(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  retained(record, now) {
    if (!record?.quotes || record.staleUntil > now) return record;
    return {
      ...record,
      checkedAt: 0,
      freshUntil: 0,
      staleUntil: 0,
      quotes: null,
    };
  }

  providerRetryAt() {
    const value = this.db
      .prepare("SELECT value FROM settings WHERE name=?")
      .get(PROVIDER_RETRY_KEY)?.value;
    if (value === undefined) return 0;
    const retryAt = Number(value);
    if (!validTime(retryAt)) throw new ServiceError("catalog_cache_unavailable");
    return retryAt;
  }

  deferProvider(retryAt) {
    if (!validTime(retryAt)) throw new ServiceError("catalog_cache_unavailable");
    const deadline = Math.max(this.providerRetryAt(), retryAt);
    this.db
      .prepare(
        "INSERT INTO settings(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      )
      .run(PROVIDER_RETRY_KEY, String(deadline));
  }

  prune(chainId) {
    return this.transaction(() => {
      const { current } = this.timeline();
      const stored = this.read(chainId);
      const record = this.retained(stored, current);
      if (record !== stored && record) this.write(record);
      return record !== stored;
    });
  }

  due(chainId) {
    const record = this.read(chainId);
    const { current, highWater } = this.timeline();
    return current >= highWater && (!record || record.nextAttemptAt <= highWater);
  }

  begin(chainId) {
    return this.transaction(() => {
      const { current, highWater } = this.timeline();
      const stored = this.read(chainId);
      const record = this.retained(stored, current) ?? {
        version: 1,
        chainId,
        checkedAt: 0,
        freshUntil: 0,
        staleUntil: 0,
        nextAttemptAt: 0,
        attempts: 0,
        lease: 0,
        leaseUntil: 0,
        quotes: null,
      };
      if (record !== stored) this.write(record);
      if (current < highWater || this.providerRetryAt() > highWater) return false;
      if (record.nextAttemptAt > highWater) return false;
      record.attempts = Math.min(1000, record.attempts + 1);
      record.lease += 1;
      record.leaseUntil = highWater + ATTEMPT_LEASE;
      record.nextAttemptAt = record.leaseUntil;
      this.write(record);
      return record.lease;
    });
  }

  succeed(chainId, quotes, lease) {
    if (!validateQuotes(quotes, chainId)) throw new ServiceError("invalid_catalog");
    return this.transaction(() => {
      const { current, highWater } = this.timeline();
      const record = this.read(chainId);
      if (
        current < highWater ||
        !record ||
        record.lease !== lease ||
        record.leaseUntil <= highWater
      )
        return false;
      this.write({
        version: 1,
        chainId,
        checkedAt: highWater,
        freshUntil: highWater + FRESH_FOR,
        staleUntil: highWater + RETAIN_FOR,
        nextAttemptAt: highWater + FRESH_FOR,
        attempts: 0,
        lease,
        leaseUntil: 0,
        quotes,
      });
      return true;
    });
  }

  fail(chainId, lease, retryAfter = 0) {
    return this.transaction(() => {
      const { current, highWater } = this.timeline();
      const record = this.retained(this.read(chainId), current);
      if (
        current < highWater ||
        !record ||
        record.lease !== lease ||
        record.leaseUntil <= highWater
      )
        return false;
      const exponential = Math.min(
        FRESH_FOR,
        15 * 60 * 1000 * 2 ** Math.min(5, record.attempts - 1),
      );
      const provider = Number.isFinite(retryAfter)
        ? Math.min(DAY, Math.max(0, Math.ceil(retryAfter)) * 1000)
        : 0;
      if (provider > 0) this.deferProvider(highWater + provider);
      record.leaseUntil = 0;
      record.nextAttemptAt = highWater + Math.max(exponential, provider);
      this.write(record);
      return true;
    });
  }

  catalog(chainId, longQuotes = new Set()) {
    return this.transaction(() => {
      const { current, highWater } = this.timeline();
      const stored = this.read(chainId);
      const record = this.retained(stored, current);
      if (record !== stored && record) this.write(record);
      const fresh = Boolean(
        current >= highWater &&
        record?.quotes &&
        record.checkedAt <= current &&
        record.freshUntil > current,
      );
      const quotes = fresh ? record.quotes : [];
      const unavailable = { status: "unavailable", pairs: [] };
      const project = ({ id, symbol }) => ({ id, symbol });
      const pads = {
        o1: fresh ? { status: "ready", pairs: quotes.map(project) } : unavailable,
      };
      if (chainId === 4663)
        pads.long =
          fresh && longQuotes.size
            ? {
                status: "ready",
                pairs: quotes.filter((quote) => longQuotes.has(quote.address)).map(project),
              }
            : unavailable;
      return {
        chainId,
        ...(record?.checkedAt ? { checkedAt: record.checkedAt } : {}),
        expiresAt: fresh ? record.freshUntil : current + 300_000,
        pads,
      };
    });
  }
}

export const CATALOG_REFRESH_CHECK_MS = 5 * 60 * 1000;
