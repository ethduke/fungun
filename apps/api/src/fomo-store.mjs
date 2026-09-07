import { createHash, randomUUID } from "node:crypto";

const DAY = 86_400_000;

export function fomoConnectionLimit(value = 10) {
  const limit = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("FOMO_MAX_CONNECTIONS_5M must be an integer from 1 to 100");
  return limit;
}
const addressPattern = /^0x[0-9a-f]{40}$/i;
export const normalizeHandle = (value) =>
  typeof value === "string" ? value.trim().replace(/^@/, "").toLowerCase() : "";
const address = (value) =>
  typeof value === "string" && addressPattern.test(value) && !/^0x0{40}$/i.test(value)
    ? value.toLowerCase()
    : null;
const text = (value) => (typeof value === "string" ? value.slice(0, 100) : "");

export function fomoUsers(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
    throw new Error("Invalid FOMO watchlist");
  const users = new Map();
  for (const [key, label] of Object.entries(mapping)) {
    const handle = normalizeHandle(key);
    if (
      !/^[a-z0-9_.-]{1,64}$/.test(handle) ||
      typeof label !== "string" ||
      !label.trim() ||
      label.length > 100 ||
      users.has(handle)
    )
      throw new Error("Invalid FOMO watchlist");
    users.set(handle, label.trim().replace(/^@/, ""));
  }
  if (!users.size) throw new Error("Empty FOMO watchlist");
  return users;
}

export function eventTime(value, now = Date.now()) {
  let ts = NaN;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    ts = Number(value);
    if (ts < 1e11) ts *= 1000;
  } else if (typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    ts = Date.parse(value);
  return Number.isFinite(ts) && ts > 0 && ts <= now + 300_000 ? Math.floor(ts) : null;
}

export function normalizeFomoEvent(row, users, now = Date.now()) {
  if (!row || row.type !== "alert" || !["buy", "sell"].includes(row.alertType)) return null;
  const handle = normalizeHandle(typeof row.trader === "object" ? row.trader?.handle : row.trader);
  const token = address(row.tokenAddress ?? row.token?.address);
  const ts = eventTime(row.ts, now);
  // An unknown chain is not evidence, even on a chain-filtered socket.
  if (
    !users.has(handle) ||
    !token ||
    !ts ||
    Number(row.chainId) !== 4663 ||
    (row.chain && row.chain !== "robinhood")
  )
    return null;
  const symbol = text(typeof row.token === "string" ? row.token : row.token?.symbol);
  const source = `ws_alert:${text(row.source) || "feed"}`;
  const providerId =
    typeof row.id === "string" || typeof row.id === "number" ? String(row.id).slice(0, 256) : "";
  const identity =
    providerId ||
    JSON.stringify([token, row.alertType, ts, row.usdValue ?? null, row.txHash ?? null]);
  const id = createHash("sha256")
    .update(JSON.stringify([source, handle, identity]))
    .digest("hex");
  return { id, handle, token, symbol, side: row.alertType, ts, source, providerId };
}

export class FomoStore {
  constructor(db, users, now = Date.now, maxConnections5m = 10) {
    this.maxConnections5m = fomoConnectionLimit(maxConnections5m);
    Object.assign(this, { db, users, now });
    db.exec(`
      CREATE TABLE IF NOT EXISTS fomo_events (
        id TEXT PRIMARY KEY, handle TEXT NOT NULL, chain_id INTEGER NOT NULL,
        token TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL,
        ts INTEGER NOT NULL, observed_at INTEGER NOT NULL, source TEXT NOT NULL, provider_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fomo_events_match ON fomo_events(chain_id,token,handle,side,ts);
      CREATE INDEX IF NOT EXISTS fomo_events_expiry ON fomo_events(ts);
      CREATE TABLE IF NOT EXISTS fomo_stream_tokens (
        chain_id INTEGER NOT NULL, token TEXT NOT NULL, symbol TEXT NOT NULL,
        first_seen INTEGER NOT NULL, PRIMARY KEY(chain_id,token)
      );
      CREATE TABLE IF NOT EXISTS fomo_connections (ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fomo_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fomo_journal (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL
      );
    `);
    this.prune();
    this.db.prepare("INSERT OR IGNORE INTO fomo_metadata VALUES ('journal_id',?)").run(randomUUID());
    this.transaction(() => {
      const missing = this.db.prepare(`SELECT e.* FROM fomo_events e
        LEFT JOIN fomo_journal j ON j.event_id=e.id WHERE j.event_id IS NULL
        ORDER BY e.observed_at,e.id`).all();
      for (const row of missing) this.appendJournal(row.id, {
        type: "alert", id: row.provider_id || undefined, trader: row.handle,
        tokenAddress: row.token, token: row.symbol, chainId: 4663,
        alertType: row.side, ts: row.ts, source: row.source.slice("ws_alert:".length),
      }, true);
    });
  }

  prune() {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM fomo_journal WHERE event_id IN
        (SELECT id FROM fomo_events WHERE ts<=?)`).run(this.now() - DAY);
      this.db.prepare("DELETE FROM fomo_events WHERE ts<=?").run(this.now() - DAY);
    });
  }

  appendJournal(id, payload, migrated = false) {
    this.db.prepare("INSERT INTO fomo_journal(event_id,payload) VALUES (?,?)")
      .run(id, JSON.stringify({ ...payload, migrated }));
  }

  journal(after = 0) {
    this.prune();
    const head = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='fomo_journal'").get()?.seq ?? 0;
    const rows = this.db.prepare(`SELECT sequence,event_id,payload FROM fomo_journal
      WHERE sequence>? ORDER BY sequence LIMIT 200`).all(after);
    return {
      journal_id: this.db.prepare("SELECT value FROM fomo_metadata WHERE name='journal_id'").get().value,
      events: rows.map(({ sequence, event_id, payload }) => ({ sequence, event_id, payload: JSON.parse(payload) })),
      next_cursor: rows.at(-1)?.sequence ?? head,
      head, has_more: (rows.at(-1)?.sequence ?? head) < head,
      retention_seconds: DAY / 1000,
    };
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  register(rows) {
    return this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO fomo_stream_tokens VALUES (4663,?,?,?)
        ON CONFLICT(chain_id,token) DO UPDATE SET symbol=CASE WHEN excluded.symbol<>'' THEN excluded.symbol ELSE symbol END`);
      for (const row of rows) {
        const token = address(row.meme || row.token);
        if (Number(row.chain_id) !== 4663 || !token || !["eth", "shares"].includes(row.quote_kind))
          continue;
        insert.run(token, text(row.sym), this.now());
      }
    });
  }

  ingest(row) {
    const event = normalizeFomoEvent(row, this.users, this.now());
    if (!event || event.ts <= this.now() - DAY) return false;
    return this.transaction(() => {
      const inserted = Boolean(this.db
        .prepare("INSERT OR IGNORE INTO fomo_events VALUES (?,?,4663,?,?,?,?,?,?,?)")
        .run(
          event.id,
          event.handle,
          event.token,
          event.symbol,
          event.side,
          event.ts,
          this.now(),
          event.source,
          event.providerId,
        ).changes);
      const usd = row.usdValue ?? row.sizeUsd;
      if (inserted) this.appendJournal(event.id, {
        type: "alert", id: typeof row.id === "number" ? row.id : event.providerId || undefined,
        trader: event.handle, tokenAddress: event.token, token: event.symbol,
        chainId: 4663, alertType: event.side, ts: typeof row.ts === "string" ? row.ts.slice(0, 100) : row.ts,
        source: text(row.source) || "feed",
        usdValue: Number.isFinite(Number(usd)) && usd != null && Number(usd) >= 0
          ? Number(usd) : null,
        tradeId: typeof row.tradeId === "number" ? row.tradeId : text(row.tradeId) || undefined, txHash: text(row.txHash) || undefined,
      });
      return inserted;
    });
  }

  highlights() {
    this.prune();
    return this.db
      .prepare(`SELECT e.handle,e.token,
      COALESCE(NULLIF(s.symbol,''),NULLIF(MAX(e.symbol),''),e.token) AS symbol,
      MIN(e.ts)/1000.0 AS first_bought_at, MAX(e.ts)/1000.0 AS last_bought_at,
      COUNT(*) AS buy_alerts, s.first_seen/1000.0 AS first_stream_seen_at
      FROM fomo_events e JOIN fomo_stream_tokens s ON s.chain_id=e.chain_id AND s.token=e.token
      WHERE e.chain_id=4663 AND e.side='buy'
      GROUP BY e.handle,e.token ORDER BY last_bought_at DESC,e.handle,e.token`)
      .all()
      .filter((row) => this.users.has(row.handle))
      .map((row) => ({ ...row, label: this.users.get(row.handle) }));
  }

  attempts(window = DAY) {
    return this.db
      .prepare("SELECT COUNT(*) AS n FROM fomo_connections WHERE ts>?")
      .get(this.now() - window).n;
  }

  reserveConnection() {
    return this.transaction(() => {
      const now = this.now();
      const latest = this.db.prepare("SELECT MAX(ts) AS ts FROM fomo_connections").get().ts ?? 0;
      const retry = Number(
        this.db.prepare("SELECT value FROM fomo_metadata WHERE name='retry_at'").get()?.value ?? 0,
      );
      this.db.prepare("DELETE FROM fomo_connections WHERE ts<=?").run(now - DAY);
      if (this.attempts(300_000) >= this.maxConnections5m)
        return {
          allowed: false,
          reason: "cooldown",
          // If the configured limit was lowered, enough attempts must expire first.
          retryAt: Math.max(
            retry,
            this.db
              .prepare("SELECT ts FROM fomo_connections ORDER BY ts DESC LIMIT 1 OFFSET ?")
              .get(this.maxConnections5m - 1).ts + 300_000,
          ),
        };
      if (latest > now || retry > now)
        return { allowed: false, reason: this.metadata("retry_state") || "reconnecting", retryAt: Math.max(latest, retry) };
      this.db.prepare("INSERT INTO fomo_connections VALUES (?)").run(now);
      this.defer(now + 3000);
      return { allowed: true };
    });
  }

  metadata(name) {
    return this.db.prepare("SELECT value FROM fomo_metadata WHERE name=?").get(name)?.value;
  }

  setMetadata(name, value) {
    this.db
      .prepare(
        "INSERT INTO fomo_metadata VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
      )
      .run(name, String(value));
  }

  defer(ts, state = "reconnecting") {
    this.setMetadata("retry_at", ts);
    this.setMetadata("retry_state", state);
  }

  blocked(keyFingerprint) {
    const reason = this.metadata("blocked_reason");
    if (!reason) return null;
    if (this.metadata("blocked_key") === keyFingerprint) return reason;
    this.db.prepare("DELETE FROM fomo_metadata WHERE name IN ('blocked_reason','blocked_key')").run();
    this.defer(0);
    return null;
  }

  block(reason, keyFingerprint) {
    this.transaction(() => {
      this.setMetadata("blocked_reason", reason);
      this.setMetadata("blocked_key", keyFingerprint);
    });
  }

  tokenCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM fomo_stream_tokens").get().n;
  }
}
