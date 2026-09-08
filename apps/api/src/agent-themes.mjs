import { createHash } from 'node:crypto';
import { handleTrackedFeed } from '../../web/lib/tracked-feed-handler.mjs';
import { ServiceError } from './errors.mjs';

const DAY = 86400000;
const addressPattern = /^0x[0-9a-f]{40}$/i;
export function normalizeThemeName(value) {
  if (typeof value !== 'string' || value.length > 128 || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return name && name.length <= 128 ? name : null;
}
async function publicSnapshot() {
  const response = await handleTrackedFeed(new Request('https://local.invalid/api/tracked-feed'));
  if (!response.ok) throw new Error('feed unavailable');
  return response.json();
}
const invalid = () => { throw new ServiceError('invalid_request', 400); };

// Demand-driven observation, never an assertion of deployment/creation time.
// Supply only a trusted, server-owned projected tracked-feed snapshot fetcher.
export class AgentThemes {
  constructor(db, { fetchSnapshot = publicSnapshot, now = Date.now, refreshMs = 30000 } = {}) {
    this.db = db; this.fetchSnapshot = fetchSnapshot; this.now = now;
    this.refreshMs = Math.max(1000, refreshMs); this.pending = null;
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_theme_meta (id INTEGER PRIMARY KEY CHECK(id=1), observed INTEGER, retry INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO agent_theme_meta(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS agent_theme_tokens (address TEXT PRIMARY KEY, name TEXT NOT NULL, display TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_theme_first ON agent_theme_tokens(first_seen);
      CREATE TABLE IF NOT EXISTS agent_theme_configs (key TEXT PRIMARY KEY, minimum INTEGER NOT NULL, window INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_theme_active (config TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(config,name));
      CREATE TABLE IF NOT EXISTS agent_theme_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, config TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL);
    `);
  }
  meta() { return this.db.prepare('SELECT * FROM agent_theme_meta WHERE id=1').get(); }
  groups(config, at) {
    const rows = this.db.prepare('SELECT * FROM agent_theme_tokens WHERE first_seen > ? AND first_seen <= ? ORDER BY name,address').all(at - config.window * 1000, at);
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.name)) groups.set(row.name, { key: row.name, name: row.display, chainId: 4663, tokens: [] });
      groups.get(row.name).tokens.push({ address: row.address, firstObservedAt: row.first_seen, lastObservedAt: row.last_seen });
    }
    return [...groups.values()].filter(group => group.tokens.length >= config.minimum).map(group => ({ ...group, count: group.tokens.length, tokens: group.tokens.slice(0, 100), tokensTruncated: group.tokens.length > 100 }));
  }
  evaluate(at) {
    for (const config of this.db.prepare('SELECT * FROM agent_theme_configs').all()) {
      const themes = this.groups(config, at);
      const active = new Set(this.db.prepare('SELECT name FROM agent_theme_active WHERE config=?').all(config.key).map(row => row.name));
      for (const theme of themes) {
        if (active.has(theme.key)) { active.delete(theme.key); continue; }
        this.db.prepare('INSERT INTO agent_theme_active VALUES (?,?)').run(config.key, theme.key);
        this.db.prepare('INSERT INTO agent_theme_events(config,created,body) VALUES (?,?,?)').run(config.key, at, JSON.stringify({ type: 'theme.threshold_crossed', observedAt: at, minimumTokens: config.minimum, windowSeconds: config.window, theme }));
      }
      for (const name of active) this.db.prepare('DELETE FROM agent_theme_active WHERE config=? AND name=?').run(config.key, name);
    }
    const cutoff = this.db.prepare('SELECT MAX(seq) AS seq FROM agent_theme_events WHERE created < ? OR seq <= (SELECT COALESCE(MAX(seq),0)-10000 FROM agent_theme_events)').get(at - 7 * DAY).seq;
    if (cutoff) {
      this.db.prepare('DELETE FROM agent_theme_events WHERE seq<=?').run(cutoff);
      this.db.prepare('UPDATE agent_theme_meta SET floor=MAX(floor,?) WHERE id=1').run(cutoff);
    }
  }
  async refresh() {
    const at = this.now(), meta = this.meta();
    if (at < meta.retry || (meta.observed !== null && at < meta.observed + this.refreshMs)) return;
    this.pending ??= this.readSource(at).finally(() => { this.pending = null; });
    await this.pending;
  }
  async readSource(at) {
    try {
      const snapshot = await this.fetchSnapshot();
      if (!snapshot || !Array.isArray(snapshot.pools) || snapshot.pools.length > 10000) throw new Error('invalid snapshot');
      const observations = new Map();
      for (const row of snapshot.pools) {
        const name = normalizeThemeName(row?.name);
        const address = row?.meme || row?.token;
        if (!row || Number(row.chain_id) !== 4663 || !['eth', 'shares'].includes(row.quote_kind) || !name || typeof address !== 'string' || !addressPattern.test(address) || /^0x0{40}$/i.test(address)) throw new Error('invalid observation');
        const key = address.toLowerCase();
        if (observations.has(key) && observations.get(key).name !== name) throw new Error('conflicting token names');
        observations.set(key, { name, display: row.name.normalize('NFKC').trim().replace(/\s+/gu, ' ') });
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert = this.db.prepare('INSERT INTO agent_theme_tokens VALUES (?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET last_seen=excluded.last_seen');
        for (const [address, row] of observations) insert.run(address, row.name, row.display, at, at);
        if (this.db.prepare('SELECT COUNT(*) AS count FROM agent_theme_tokens').get().count > 100000) throw new Error('observation capacity');
        // Keep first observation/name immutable, including across disappearing pools.
        this.db.prepare('UPDATE agent_theme_meta SET observed=?,retry=0,failures=0 WHERE id=1').run(at);
        this.evaluate(at);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    } catch {
      const failures = Math.min(this.meta().failures + 1, 5);
      this.db.prepare('UPDATE agent_theme_meta SET failures=?,retry=? WHERE id=1').run(failures, at + Math.min(300000, this.refreshMs * 2 ** failures));
    }
  }
  async poll({ minimumTokens = 3, windowSeconds = 3600, cursor } = {}) {
    minimumTokens = Number(minimumTokens); windowSeconds = Number(windowSeconds);
    if (!Number.isInteger(minimumTokens) || minimumTokens < 2 || minimumTokens > 100 || !Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400) invalid();
    const key = `${minimumTokens}:${windowSeconds}`;
    const scope = createHash('sha256').update(key).digest('hex').slice(0, 16);
    let seq = 0;
    if (cursor !== undefined) {
      if (typeof cursor !== 'string' || !new RegExp(`^${scope}:[0-9]{1,15}$`).test(cursor)) invalid();
      seq = Number(cursor.split(':')[1]);
      const max = this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='agent_theme_events'),0) AS seq").get().seq;
      if (seq < this.meta().floor) throw new ServiceError('theme_cursor_expired', 410);
      if (seq > max) invalid();
    }
    if (!this.db.prepare('SELECT 1 FROM agent_theme_configs WHERE key=?').get(key)) {
      if (this.db.prepare('SELECT COUNT(*) AS n FROM agent_theme_configs').get().n >= 128) throw new ServiceError('theme_subscription_capacity', 503);
      this.db.prepare('INSERT INTO agent_theme_configs VALUES (?,?,?)').run(key, minimumTokens, windowSeconds);
    }
    await this.refresh();
    const at = this.now(), meta = this.meta();
    const fresh = meta.observed !== null && meta.failures === 0 && at < meta.observed + this.refreshMs;
    if (fresh) {
      this.db.exec('BEGIN IMMEDIATE');
      try { this.evaluate(at); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    if (cursor !== undefined && seq < this.meta().floor) throw new ServiceError('theme_cursor_expired', 410);
    const rows = this.db.prepare('SELECT seq,body FROM agent_theme_events WHERE config=? AND seq>? ORDER BY seq LIMIT 100').all(key, seq);
    return {
      minimumTokens, windowSeconds, windowBasis: 'first_observed',
      themes: this.groups({ minimum: minimumTokens, window: windowSeconds }, at).slice(0, 100),
      events: rows.map(row => ({ ...JSON.parse(row.body), id: `${scope}:${row.seq}` })),
      nextCursor: `${scope}:${rows.length === 100 ? rows.at(-1).seq : this.db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='agent_theme_events'),0) AS seq").get().seq}`,
      freshness: { status: fresh ? 'fresh' : meta.observed === null ? 'unavailable' : 'stale', observedAt: meta.observed, retryAt: meta.retry },
    };
  }
}
