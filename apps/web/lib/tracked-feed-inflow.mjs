const addressPattern = /^0x[0-9a-f]{40}$/i;
export const INFLOW_PRICE_INTERVAL_MS = 120_000;

export function inflowPriceChange(entryPrice, currentPrice) {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  )
    return null;
  const change = ((currentPrice - entryPrice) / entryPrice) * 100;
  return Number.isFinite(change) ? change : null;
}

export function gmgnTokenUrl(row) {
  const address = String(row.meme || row.token || '');
  return Number(row.chain_id ?? 4663) === 4663 && addressPattern.test(address)
    ? `https://gmgn.ai/robinhood/token/${address.toLowerCase()}`
    : null;
}

export class TrackedInflowQueue {
  constructor({ now = () => performance.now(), wallNow = Date.now } = {}) {
    this.now = now;
    this.wallNow = wallNow;
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
        candidates.set(href, {
          href,
          ticker,
          flow,
          pool: typeof row.pool === 'string' ? row.pool.toLowerCase() : '',
          token: String(row.meme || row.token).toLowerCase(),
          version: row.version,
          quoteSymbol:
            row.quote_symbol ||
            (row.quote_kind === 'eth' ? 'ETH' : 'quote asset'),
        });
    }
    for (const item of candidates.values()) {
      const index = this.items.findIndex(({ href }) => href === item.href);
      if (index !== -1) {
        // Keep the entry pool and price baseline when another pool overtakes it.
        this.items[index] = {
          ...this.items[index],
          ticker: item.ticker,
          flow: item.flow,
        };
      }
      if (this.seen.has(item.href)) continue;
      // Remember evictions too, so repeated snapshots cannot re-admit them.
      // Arrival order is first observation in this view, not a chain timestamp.
      this.seen.add(item.href);
      this.items.push({
        ...item,
        entryPrice: null,
        admittedAt: this.wallNow(),
        admittedMonotonicAt: this.now(),
        entryObservedAt: null,
        priceChange: null,
        priceObservedAt: null,
        priceQuote: null,
        priceSource: null,
        priceStale: false,
        nextPriceAt: 0,
      });
      if (this.items.length > 10) this.items.shift();
    }
    return [...this.items];
  }

  takePriceRequests() {
    const now = this.now();
    return this.items
      .filter(
        (item) =>
          item.version === 'v4' &&
          /^0x[\da-f]{64}$/i.test(item.pool) &&
          now >= item.nextPriceAt,
      )
      .map((item) => {
        // Reserve the deadline before any request, including failed/aborted ones.
        item.nextPriceAt = now + INFLOW_PRICE_INTERVAL_MS;
        return { pool: item.pool, token: item.token, version: item.version };
      });
  }

  applyPrices(requests, prices, serverTime = null) {
    const now = this.now();
    for (const request of requests) {
      const item = this.items.find(
        (entry) => entry.pool === request.pool && entry.token === request.token,
      );
      if (!item) continue;
      item.nextPriceAt = now + INFLOW_PRICE_INTERVAL_MS;
      const admissionCutoff =
        Number.isFinite(serverTime) && serverTime > 0
          ? serverTime - Math.max(0, now - item.admittedMonotonicAt)
          : item.admittedAt;
      const sample = prices.find(
        (price) => price?.pool === item.pool && price.token === item.token,
      );
      if (
        !sample ||
        !Number.isFinite(sample.value) ||
        sample.value <= 0 ||
        !Number.isFinite(sample.observedAt) ||
        sample.observedAt <= 0 ||
        (item.entryPrice === null && sample.observedAt < admissionCutoff) ||
        typeof sample.quote !== 'string' ||
        !addressPattern.test(sample.quote) ||
        typeof sample.source !== 'string' ||
        !addressPattern.test(sample.source) ||
        (item.priceQuote !== null && item.priceQuote !== sample.quote) ||
        (item.priceSource !== null && item.priceSource !== sample.source) ||
        (item.priceObservedAt !== null &&
          sample.observedAt <= item.priceObservedAt)
      ) {
        item.priceStale = true;
        continue;
      }
      if (item.entryPrice === null) {
        item.entryPrice = sample.value;
        item.entryObservedAt = sample.observedAt;
        item.priceQuote = sample.quote;
        item.priceSource = sample.source;
      } else
        item.priceChange = inflowPriceChange(item.entryPrice, sample.value);
      item.priceObservedAt = sample.observedAt;
      item.priceStale = false;
    }
    return [...this.items];
  }
}
