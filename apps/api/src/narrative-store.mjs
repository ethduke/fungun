import { groupNarrativeTokens, NARRATIVE_TTL_MS } from "../../web/lib/tracked-feed-narratives.mjs";

// Uses the existing persistent budget database; never initializes or replaces it.
export class NarrativeStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(`
      CREATE TABLE IF NOT EXISTS narrative_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        arrived_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS narrative_tokens (
        token TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        group_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS narrative_token_group ON narrative_tokens(group_id);
    `);
  }

  observe(rows) {
    const now = this.now(),
      cutoff = now - NARRATIVE_TTL_MS;
    const unique = new Map();
    for (const row of rows) {
      const token = String(row?.meme || row?.token || "").toLowerCase();
      const name = String(row?.name || row?.sym || "")
        .trim()
        .slice(0, 80);
      if (
        Number(row?.chain_id ?? 4663) !== 4663 ||
        !["eth", "shares"].includes(row?.quote_kind) ||
        !/^0x[0-9a-f]{40}$/.test(token) ||
        !name
      )
        continue;
      if (!unique.has(token)) unique.set(token, name);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Remove expired episodes, retaining token tombstones while the feed still
      // contains them. Repeated snapshots must not manufacture new arrivals.
      this.db.prepare("DELETE FROM narrative_groups WHERE arrived_at <= ?").run(cutoff);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO narrative_tokens(token,name,first_seen,last_seen) VALUES(?,?,?,?)",
      );
      const touch = this.db.prepare("UPDATE narrative_tokens SET last_seen=? WHERE token=?");
      let added = 0;
      for (const [token, name] of unique) {
        added += insert.run(token, name, now, now).changes;
        touch.run(now, token);
      }
      this.db
        .prepare(`DELETE FROM narrative_tokens WHERE last_seen <= ?
        AND (group_id IS NULL OR group_id NOT IN (SELECT id FROM narrative_groups))`)
        .run(cutoff);
      if (added) {
        const eligible = this.db
          .prepare(`SELECT t.*, g.arrived_at FROM narrative_tokens t
          LEFT JOIN narrative_groups g ON g.id=t.group_id
          WHERE g.id IS NOT NULL OR (t.group_id IS NULL AND t.first_seen > ?)
          ORDER BY t.first_seen, t.token`)
          .all(cutoff);
        const byId = new Map(eligible.map((t) => [`4663:${t.token}`, t]));
        const groups = groupNarrativeTokens(eligible.map((t) => ({ meme: t.token, name: t.name })));
        const assign = this.db.prepare(
          "UPDATE narrative_tokens SET group_id=? WHERE token=? AND group_id IS NULL",
        );
        const create = this.db.prepare("INSERT INTO narrative_groups(name,arrived_at) VALUES(?,?)");
        for (const group of groups) {
          const members = group.members.map((item) => byId.get(item.id));
          const pending = members.filter((t) => t.group_id === null);
          if (!pending.length) continue;
          // Preserve existing arrivals and names even when a spelling variant or
          // a much larger count joins. Existing episodes never move or merge.
          const existing = members
            .filter((t) => t.group_id !== null)
            .sort((a, b) => a.arrived_at - b.arrived_at || a.group_id - b.group_id)[0];
          if (!existing && pending.length < 2) continue;
          const id = existing?.group_id ?? Number(create.run(group.name, now).lastInsertRowid);
          for (const member of pending) assign.run(id, member.token);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot() {
    return this.db
      .prepare(`SELECT g.id, g.name, g.arrived_at AS arrivedAt, COUNT(t.token) AS count
      FROM narrative_groups g JOIN narrative_tokens t ON t.group_id=g.id
      WHERE g.arrived_at > ? GROUP BY g.id HAVING COUNT(t.token) >= 2
      ORDER BY g.arrived_at DESC, g.id DESC`)
      .all(this.now() - NARRATIVE_TTL_MS);
  }
}
