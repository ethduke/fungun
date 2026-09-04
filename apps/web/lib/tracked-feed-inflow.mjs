const addressPattern = /^0x[0-9a-f]{40}$/i;

export function gmgnTokenUrl(row) {
  const address = String(row.meme || row.token || '');
  return Number(row.chain_id ?? 4663) === 4663 && addressPattern.test(address)
    ? `https://gmgn.ai/robinhood/token/${address.toLowerCase()}`
    : null;
}

export class TrackedInflowQueue {
  constructor() {
    this.items = [];
    this.seen = new Set();
  }

  update(rows) {
    const candidates = new Map();
    for (const row of rows) {
      if (!row || !['eth', 'shares'].includes(row.quote_kind)) continue;
      const href = gmgnTokenUrl(row);
      const ticker = typeof row.sym === 'string' ? row.sym.trim() : '';
      const flow =
        typeof row.total_in === 'number' || typeof row.total_in === 'string'
          ? Number(row.total_in)
          : NaN;
      if (!href || !ticker || !Number.isFinite(flow) || flow <= 10) continue;
      const previous = candidates.get(href);
      // A token may have several pools; do not add their cumulative totals.
      if (!previous || flow > previous.flow)
        candidates.set(href, { href, ticker, flow });
    }
    for (const item of candidates.values()) {
      const index = this.items.findIndex(({ href }) => href === item.href);
      if (index !== -1) this.items[index] = item;
      if (this.seen.has(item.href)) continue;
      // Remember evictions too, so repeated snapshots cannot re-admit them.
      // Arrival order is first observation in this view, not a chain timestamp.
      this.seen.add(item.href);
      this.items.push(item);
      if (this.items.length > 10) this.items.shift();
    }
    return [...this.items];
  }
}
