import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { ServiceError } from "./errors.mjs";

const MINUTE = 60_000;
const DAY = 86_400_000;
export const READ_LIMITS = Object.freeze({ perMinute: 180, perDay: 16000, rpcPerDay: 12000, o1PerDay: 600, otherPerDay: 1400 });
export const LAUNCH_LIMITS = Object.freeze({ prepare: 30, assets: 120, upstream: 1200, rpc: 1000, provider: 180 });

export class Budget {
  constructor(path, now = Date.now, initialize = true) {
    this.now = now;
    this.launchScope = new AsyncLocalStorage();
    this.db = new DatabaseSync(path, { timeout: 1000 });
    if (initialize) {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS counters (scope TEXT PRIMARY KEY, expires INTEGER NOT NULL, used INTEGER NOT NULL)",
      );
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_counters_expires ON counters(expires)");
      const insert = this.db.prepare("INSERT OR IGNORE INTO settings VALUES (?, ?)");
      insert.run("ip-hmac", randomBytes(32).toString("hex"));
      insert.run("schema-version", "1");
      insert.run("clock", String(now()));
    } else {
      const version = this.db
        .prepare("SELECT value FROM settings WHERE name = ?")
        .get("schema-version");
      const integrity = this.db.prepare("PRAGMA quick_check").get();
      const columns = this.db.prepare("PRAGMA table_info(counters)").all();
      const secret = this.db.prepare("SELECT value FROM settings WHERE name = ?").get("ip-hmac");
      const clock = this.db.prepare("SELECT value FROM settings WHERE name = ?").get("clock");
      if (
        version?.value !== "1" ||
        integrity?.quick_check !== "ok" ||
        columns.map((column) => column.name).join(",") !== "scope,expires,used" ||
        !/^[a-f0-9]{64}$/.test(secret?.value ?? "") ||
        !/^\d+$/.test(clock?.value ?? "")
      ) {
        this.db.close();
        throw new ServiceError("budget_storage_unavailable");
      }
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.key = this.db.prepare("SELECT value FROM settings WHERE name = ?").get("ip-hmac").value;
    this.lastPrune = 0;
  }

  debit(rules, units = 1, dailyCode = "rate_limited") {
    if (!Number.isInteger(units) || units < 1 || units > 30)
      throw new ServiceError("invalid_budget_units");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = Number(
        this.db.prepare("SELECT value FROM settings WHERE name = ?").get("clock")?.value ?? 0,
      );
      const now = Math.max(this.now(), previous);
      this.db
        .prepare(
          "INSERT INTO settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
        )
        .run("clock", String(now));
      if (now - this.lastPrune >= MINUTE) {
        this.db.prepare("DELETE FROM counters WHERE expires <= ?").run(now);
        this.lastPrune = now;
      }
      const buckets = rules.map(([scope, limit, period]) => ({
        scope: `${scope}:${period}:${Math.floor(now / period)}`,
        expires: (Math.floor(now / period) + 1) * period,
        limit,
        period,
      }));
      for (const bucket of buckets) {
        const row = this.db.prepare("SELECT used FROM counters WHERE scope = ?").get(bucket.scope);
        if ((row?.used ?? 0) + units > bucket.limit)
          throw new ServiceError(
            bucket.period >= DAY ? dailyCode : "rate_limited",
            429,
            Math.max(1, Math.ceil((bucket.expires - now) / 1000)),
          );
      }
      for (const bucket of buckets)
        this.db
          .prepare(
            "INSERT INTO counters VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET used = used + excluded.used",
          )
          .run(bucket.scope, bucket.expires, units);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  request(ip, ticker = false) {
    const fingerprint = createHmac("sha256", this.key)
      .update(`${Math.floor(this.now() / DAY)}:${ip}`)
      .digest("hex");
    this.debit([
      ["requests", 1200, MINUTE],
      [`client:${fingerprint}`, 300, MINUTE],
      ...(ticker ? [[`ticker:${fingerprint}`, 20, MINUTE]] : []),
    ]);
  }

  withLaunch(load) {
    return this.launchScope.run(true, load);
  }

  launch(operation, pad = "shared") {
    this.debit([[`launch-${operation}:${pad}`, LAUNCH_LIMITS[operation], MINUTE]]);
  }

  upstream(provider, units = 1) {
    // Launch preparation/recovery must not inherit a daily browsing quota.
    // Keep durable short burst limits and the provider's own Retry-After.
    if (this.launchScope.getStore()) {
      return this.debit([
        ["launch-upstream", LAUNCH_LIMITS.upstream, MINUTE],
        [`launch-provider:${provider}`, provider === "rpc" ? LAUNCH_LIMITS.rpc : LAUNCH_LIMITS.provider, MINUTE],
      ], units);
    }
    this.debit(
      [
        // Gas estimates alone need 1,728 RPC units per active day. Leave room for
        // ticker, fee, launch and recovery reads while retaining a hard burst cap.
        ["upstream", READ_LIMITS.perMinute, MINUTE],
        ["upstream", READ_LIMITS.perDay, DAY],
        [`provider:${provider}`, provider === "rpc" ? READ_LIMITS.rpcPerDay
          : provider === "o1" ? READ_LIMITS.o1PerDay : READ_LIMITS.otherPerDay, DAY],
      ],
      units,
      "read_daily_limit",
    );
  }

  close() {
    this.db.close();
  }
}
