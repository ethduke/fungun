import { fomoHighlightsHTML, fomoStatus } from '../lib/fomo-highlights.mjs';
import { TrackedFeedPoller } from '../lib/tracked-feed-poller.mjs';
import { feedLaunchpad } from '../lib/tracked-feed-labels.mjs';
import {
  TrackedInflowQueue,
} from '../lib/tracked-feed-inflow.mjs';

const finite = (value) =>
  (typeof value === 'number' ||
    (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value));
const amount = (value) =>
  finite(value) && Number(value) >= 0 ? Number(value) : null;
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const number = (value) =>
  amount(value) === null
    ? '—'
    : Number(value).toLocaleString('en-US', { maximumFractionDigits: 3 });
const percent = (value) => {
  const rounded = Number(value.toFixed(1));
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
};
export function priceServiceStatus(state) {
  if (state === 'online') return { text: 'Prices online', error: false };
  if (state === 'no-quotes')
    return { text: 'Price service online · no verified quotes', error: false };
  if (state === 'checking') return { text: 'Checking prices…', error: false };
  if (state === 'unavailable')
    return { text: 'Prices unavailable · retrying', error: true };
  return { text: '', error: false };
}
const pricePool = /^0x[\da-f]{64}$/i;
const priceAddress = /^0x[\da-f]{40}$/i;
export function validatedPriceResponse(body, requests) {
  if (
    !body ||
    !Array.isArray(body.prices) ||
    body.prices.length > requests.length ||
    !Number.isFinite(body.serverTime) ||
    body.serverTime <= 0
  )
    return null;
  const expected = new Set(
    requests.map(
      ({ pool, token }) =>
        `${String(pool).toLowerCase()}:${String(token).toLowerCase()}`,
    ),
  );
  const seen = new Set();
  const prices = [];
  for (const sample of body.prices) {
    const pool =
      typeof sample?.pool === 'string' ? sample.pool.toLowerCase() : '';
    const token =
      typeof sample?.token === 'string' ? sample.token.toLowerCase() : '';
    const quote =
      typeof sample?.quote === 'string' ? sample.quote.toLowerCase() : '';
    const source =
      typeof sample?.source === 'string' ? sample.source.toLowerCase() : '';
    const key = `${pool}:${token}`;
    if (
      !pricePool.test(pool) ||
      !priceAddress.test(token) ||
      !priceAddress.test(quote) ||
      !priceAddress.test(source) ||
      !expected.has(key) ||
      seen.has(key) ||
      !Number.isFinite(sample.value) ||
      sample.value <= 0 ||
      !Number.isFinite(sample.observedAt) ||
      sample.observedAt <= 0 ||
      sample.observedAt > body.serverTime
    )
      return null;
    seen.add(key);
    prices.push({ ...sample, pool, token, quote, source });
  }
  return {
    prices,
    serverTime: body.serverTime,
    state: prices.length ? 'online' : 'no-quotes',
  };
}
const chain = (row) => Number(row.chain_id ?? 4663);
const token = (row) => String(row.meme || row.token || '');
const rowKey = (row) => `${chain(row)}:${row.pool || token(row)}`;

export function trackedTokenDraft(row) {
  const ticker = typeof row.sym === 'string' ? row.sym : '';
  const address = token(row).toLowerCase();
  const chainId = chain(row);
  const pons = /^pons[\s-]+v?2$/i.test(String(row.launchpad ?? '').trim());
  const supportsImage = (!pons || chainId === 4663) && [4663, 8453].includes(chainId) && /^0x[\da-f]{40}$/.test(address);
  const o1 = chainId === 4663 && ['O1', 'O1 RWA', 'O1 Mig.'].includes(feedLaunchpad(row).label);
  return {
    name: typeof row.name === 'string' && row.name.trim() ? row.name : ticker,
    ticker,
    ...(supportsImage ? { imageSource: { chainId, address, ...(o1 ? {} : { provider: pons ? 'pons-v2' : 'doppler' }) } } : {}),
  };
}

const nameKey = (value) =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 64);

function distance(a, b) {
  let prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    const next = [j];
    for (let i = 1; i <= a.length; i++)
      next[i] = Math.min(
        next[i - 1] + 1,
        prev[i] + 1,
        prev[i - 1] + Number(a[i - 1] !== b[j - 1]),
      );
    prev = next;
  }
  return prev[a.length];
}

function similar(a, b) {
  if (a === b) return true;
  const lo = Math.min(a.length, b.length),
    hi = Math.max(a.length, b.length);
  return (
    lo >= 5 &&
    hi / lo <= 1.35 &&
    distance(a, b) <= Math.max(1, Math.floor(hi * 0.2))
  );
}

export function popularTokens(rows, limit = 3) {
  const unique = new Map();
  for (const row of rows) {
    const address = token(row).toLowerCase();
    const name = String(row.name || row.sym || '')
        .trim()
        .slice(0, 80),
      key = nameKey(name);
    if (!address || key.length < 2) continue;
    const id = `${chain(row)}:${address}`,
      flow = amount(row.total_in) ?? 0;
    const item = unique.get(id);
    if (!item || flow > item.flow) unique.set(id, { name, key, flow });
  }
  const items = [...unique.values()],
    parent = items.map((_, i) => i);
  const root = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      if (similar(items[i].key, items[j].key)) parent[root(j)] = root(i);
    }
  const groups = new Map();
  items.forEach((item, i) => {
    const key = root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const variants = new Map();
      for (const item of group) {
        const variant = variants.get(item.key) || {
          name: item.name,
          count: 0,
          flow: 0,
          best: -1,
        };
        variant.count++;
        variant.flow += item.flow;
        if (item.flow > variant.best) {
          variant.name = item.name;
          variant.best = item.flow;
        }
        variants.set(item.key, variant);
      }
      const best = [...variants.values()].sort(
        (a, b) => b.count - a.count || b.flow - a.flow,
      )[0];
      return {
        name: best.name,
        count: group.length,
        flow: group.reduce((sum, item) => sum + item.flow, 0),
      };
    })
    .sort(
      (a, b) =>
        b.count - a.count || b.flow - a.flow || a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

export function binCells(trail) {
  if (
    !trail ||
    !Array.isArray(trail.ladder) ||
    !trail.ladder.length ||
    !Number.isInteger(trail.bin) ||
    trail.bin < 0
  )
    return [];
  const base = Number.isInteger(trail.base) ? trail.base : 0;
  const current = Number.isInteger(trail.bin) ? trail.bin : null;
  return Array.from({ length: 11 }, (_, i) => ({
    index: base + i,
    pending: current !== null && base + i > current,
    current: current !== null && base + i === current,
    value: amount(trail.ladder[i]),
    buys: amount(trail.txs?.[i]),
  }));
}

const styles = `
  :host{display:block;color:var(--feed-text,#223a2c);font:14px/1.4 var(--font-site,'Quicksand',sans-serif)}
  :host([compact]) .heading,:host([compact]) .popular,:host([compact]) .inflow{display:none}:host([compact]) .top{border-bottom:0}:host([compact]) .fomo{margin-top:0}
  *{box-sizing:border-box}section{border:1px solid var(--feed-border);border-radius:16px;background:var(--feed-bg);overflow:hidden}
  .top{padding:14px 16px}.heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .statuses{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.price-status{font-size:13px;color:var(--feed-muted)}.price-status[data-error=true]{color:#92520e}
  h2,h3,p{margin:0}h2{font-size: 16px}.status{font-size: 13px;color:var(--feed-muted)}.status[data-error=true]{color:#92520e}
  .popular{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.popular-label{font-size: 13px;letter-spacing:.08em;font-weight:750;color:var(--feed-muted)}
  .popular a{padding:5px 9px;border-radius:6px;border:1px solid var(--feed-border);background:var(--feed-panel);overflow-wrap:anywhere}.popular small{font-size: 14px;color:var(--feed-muted);margin-left:6px}
  .fomo{margin-top:8px;padding:9px 12px;border:1px solid var(--feed-border);border-radius:6px;background:var(--feed-panel)}
  .fomo-line{display:flex;align-items:baseline;gap:9px;min-width:0}.fomo-label{color:var(--feed-accent);font-size:14px;font-weight:750;letter-spacing:.08em;flex-shrink:0}.fomo-buys{display:flex;align-items:baseline;gap:6px;overflow-x:auto;min-width:0;padding:3px 0;scrollbar-width:thin;font-size:14px}.fomo-buy{white-space:nowrap}.fomo-token{font-weight:750}.fomo-buy time,.fomo-separator,.fomo-empty{color:var(--feed-muted)}.fomo-buy time{font-size:12px}.fomo-health{display:block;color:var(--feed-muted);font-size:12px;margin-top:3px}
  .inflow{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0}.inflow>.popular-label{flex-shrink:0}
  .inflow-tokens{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:3px;white-space:nowrap;scrollbar-width:thin}.inflow-tokens a{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;padding:4px 7px;border:1px solid var(--feed-border);border-radius:5px;background:var(--feed-panel);font-size: 13px;font-weight:600}.inflow-ticker{max-width:110px;overflow:hidden;text-overflow:ellipsis}.price-change{font-variant-numeric:tabular-nums;color:var(--feed-muted)}.price-change[data-direction=up]{color:#268044}.price-change[data-direction=down]{color:#b13b33}.price-change[data-stale=true]{color:var(--feed-muted)}.inflow-tokens .empty{padding:4px 0;font-size: 13px}
  a{color:var(--feed-accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible{outline:2px solid var(--feed-accent);outline-offset:3px}
  .empty{color:var(--feed-muted);padding:12px 4px;font-size: 14px}
  @media(max-width:760px){.top{padding:15px}.heading{align-items:flex-start;flex-direction:column;gap:4px}.inflow{align-items:stretch;flex-direction:column;gap:3px}}
`;

if (
  typeof window !== 'undefined' &&
  !customElements.get('tracked-market-feed')
) {
  class TrackedMarketFeed extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${styles}</style><section aria-label="Tracked market feed"><div class="top"><div class="heading"><h2>Market feed</h2><div class="statuses"><span class="status" role="status" aria-live="polite">Connecting…</span><span class="price-status" role="status" aria-live="polite" hidden></span></div></div><div class="popular"></div><div class="fomo" aria-label="FOMO trader purchases"><div class="fomo-line"><span class="fomo-label">FOMO:</span><div class="fomo-buys" tabindex="0" role="region" aria-label="Recorded trader buys"></div></div><span class="fomo-health" role="status"></span></div><div class="inflow"><span class="popular-label">&gt;10ETH INFL:</span><nav class="inflow-tokens" aria-label="Tokens over 10 ETH total inflow, oldest first"></nav></div></div></section>`;
      this.rows = [];
      this.inflowQueue = new TrackedInflowQueue();
      this.inflows = [];
      this.priceController = null;
      this.priceRetryAt = 0;
      this.priceState = 'waiting';
      this.receivedAt = null;
      this.inView = false;
      this.pageHidden = false;
      this.pauseReason = null;
      this.poller = new TrackedFeedPoller({
        intervalMs: 15_000,
        getUrl: () => {
          const url = new URL(
            this.getAttribute('src') || '/api/tracked-feed',
            location.href,
          );
          if (url.origin !== location.origin)
            throw new Error('Use a same-origin feed endpoint');
          return url;
        },
        onSnapshot: (snapshot) => {
          const seen = new Set();
          this.rows = snapshot.pools.filter((row) => {
            if (
              !row ||
              chain(row) !== 4663 ||
              !['eth', 'shares'].includes(row.quote_kind)
            )
              return false;
            const key = rowKey(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          // Shared responses keep the relay's receipt time, including cache hits.
          const received = Date.parse(snapshot.fetched_at);
          this.receivedAt = Number.isFinite(received) ? received : Date.now();
          this.inflows = this.inflowQueue.update(this.rows);
          this.error = false;
          this.render();
          void this.refreshPrices();
        },
        onError: () => {
          this.error = true;
          this.render();
        },
      });
      this.fomoPayload = null;
      this.fomoUnavailable = false;
      this.fomoPoller = new TrackedFeedPoller({
        getUrl: () => '/api/fomo',
        intervalMs: 15_000,
        validateSnapshot: (body) => Array.isArray(body?.stream_highlights),
        fetcher: (url, options) =>
          fetch(url, {
            ...options,
            method: 'POST',
            credentials: 'omit',
            headers: {
              'content-type': 'application/json',
              'x-fungun-intent': 'fomo',
            },
            body: '{}',
          }),
        onSnapshot: (payload) => {
          this.fomoPayload = payload;
          this.fomoUnavailable = false;
          this.renderFomo();
        },
        onError: () => {
          this.fomoUnavailable = true;
          this.renderFomo();
        },
      });
      this.syncActivity = () => this.updateActivity();
      this.onPageHide = () => {
        this.pageHidden = true;
        this.updateActivity();
      };
      this.onPageShow = () => {
        this.pageHidden = false;
        this.updateActivity();
      };
      this.render();
    }

    static get observedAttributes() {
      return ['compact'];
    }

    attributeChangedCallback() {
      if (this.fomoPoller) this.updateActivity();
    }

    connectedCallback() {
      this.fomoExpiryTimer = setInterval(() => this.renderFomo(), 15_000);
      this.pageHidden = false;
      this.inView = false;
      document.addEventListener('visibilitychange', this.syncActivity);
      window.addEventListener('online', this.syncActivity);
      window.addEventListener('offline', this.syncActivity);
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
      if (typeof IntersectionObserver !== 'undefined') {
        const observer = new IntersectionObserver((entries) => {
          if (this.observer !== observer || !entries.length) return;
          this.inView = entries[entries.length - 1].isIntersecting;
          this.updateActivity();
        });
        this.observer = observer;
        observer.observe(this);
      } else this.inView = true;
      this.updateActivity();
    }

    disconnectedCallback() {
      clearInterval(this.fomoExpiryTimer);
      this.observer?.disconnect();
      this.observer = null;
      document.removeEventListener('visibilitychange', this.syncActivity);
      window.removeEventListener('online', this.syncActivity);
      window.removeEventListener('offline', this.syncActivity);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
      this.poller.setActive(false);
      this.fomoPoller.setActive(false);
      this.priceController?.abort();
      this.priceController = null;
    }

    updateActivity() {
      const reason =
        document.hidden || this.pageHidden
          ? 'hidden'
          : navigator.onLine === false
            ? 'offline'
            : !this.inView
              ? 'offscreen'
              : null;
      const active = this.isConnected && !reason;
      const marketActive = active && !this.hasAttribute('compact');
      if (
        reason === this.pauseReason &&
        marketActive === this.poller.active &&
        active === this.fomoPoller.active
      )
        return;
      this.pauseReason = reason;
      this.poller.setActive(marketActive);
      this.fomoPoller.setActive(active);
      if (!marketActive) {
        this.priceController?.abort();
        this.priceController = null;
      }
      this.render();
    }

    renderFomo() {
      const list = this.shadowRoot.querySelector('.fomo-buys');
      const html = fomoHighlightsHTML(this.fomoPayload);
      if (list._html !== html) {
        const focused = this.shadowRoot.activeElement;
        const href =
          focused && list.contains(focused)
            ? focused.getAttribute('href')
            : null;
        const left = list.scrollLeft;
        list.innerHTML = html;
        list._html = html;
        list.scrollLeft = left;
        if (href)
          [...list.querySelectorAll('a')]
            .find((a) => a.getAttribute('href') === href)
            ?.focus({ preventScroll: true });
      }
      this.shadowRoot.querySelector('.fomo-health').textContent = fomoStatus(
        this.fomoPayload,
        this.fomoUnavailable,
      );
    }

    async refreshPrices() {
      if (
        !this.poller.active ||
        this.priceController ||
        performance.now() < this.priceRetryAt
      )
        return;
      const pools = this.inflowQueue.takePriceRequests();
      if (!pools.length) return;
      const controller = new AbortController();
      this.priceController = controller;
      const timeout = setTimeout(() => controller.abort(), 23_000);
      const previousPriceState = this.priceState;
      this.priceState = 'checking';
      this.render();
      let prices = [];
      let serverTime = null;
      try {
        const response = await fetch('/api/tracked-prices', {
          method: 'POST',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-fungun-intent': 'tracked-prices',
          },
          body: JSON.stringify({ pools }),
        });
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          if (retry && /^\d{1,5}$/.test(retry))
            this.priceRetryAt =
              performance.now() + Math.min(86_400, Number(retry)) * 1000;
          throw new Error('Prices unavailable');
        }
        const result = validatedPriceResponse(await response.json(), pools);
        if (!result) throw new Error('Invalid price response');
        ({ prices, serverTime } = result);
        this.priceState = result.state;
      } catch {
        // No raw backend/provider errors or fabricated zero-price returns.
        this.priceState =
          controller.signal.aborted && !this.poller.active
            ? previousPriceState
            : 'unavailable';
      } finally {
        clearTimeout(timeout);
        if (this.priceController === controller) {
          this.priceController = null;
          if (this.poller.active) {
            this.inflows = this.inflowQueue.applyPrices(
              pools,
              prices,
              serverTime,
            );
            this.render();
          }
        }
      }
    }

    render() {
      this.renderFomo();
      const status = this.shadowRoot.querySelector('.status');
      const priceStatus = this.shadowRoot.querySelector('.price-status');
      const priceView = priceServiceStatus(this.priceState);
      priceStatus.dataset.error = String(priceView.error);
      priceStatus.textContent = priceView.text;
      priceStatus.hidden = !priceView.text;
      status.dataset.error = String(
        Boolean(this.error || this.pauseReason === 'offline'),
      );
      const timestamp = this.receivedAt
        ? new Date(this.receivedAt).toLocaleTimeString()
        : null;
      status.textContent = this.pauseReason
        ? `${this.pauseReason === 'offline' ? 'Offline · waiting for connection' : 'Paused · feed not visible'}${timestamp ? ` · last received ${timestamp}` : ''}`
        : this.error
          ? timestamp
            ? `Reconnecting · last received ${timestamp}`
            : 'Feed unavailable · retrying'
          : timestamp
            ? `Auto-updating · received ${timestamp}`
            : 'Connecting…';
      const hits = popularTokens(this.rows);
      const popular = this.shadowRoot.querySelector('.popular');
      const popularHTML = `<span class="popular-label">${hits.length > 1 ? 'POPULAR TOKENS' : 'POPULAR TOKEN'}</span>${hits.length ? hits.map((hit) => `<a href="https://x.com/search?q=${encodeURIComponent(hit.name)}&src=typed_query" target="_blank" rel="noopener noreferrer">${esc(hit.name)} ↗<small>${hit.count} similar tracked tokens</small></a>`).join('') : '<span class="empty">No repeated token names yet</span>'}`;
      if (popular._html !== popularHTML) {
        const focused = this.shadowRoot.activeElement;
        const focusHref =
          focused && popular.contains(focused)
            ? focused.getAttribute('href')
            : null;
        popular.innerHTML = popularHTML;
        popular._html = popularHTML;
        if (focusHref)
          [...popular.querySelectorAll('a')]
            .find((a) => a.getAttribute('href') === focusHref)
            ?.focus({ preventScroll: true });
      }
      const inflow = this.shadowRoot.querySelector('.inflow-tokens');
      const inflowHTML = this.inflows.length
        ? this.inflows
            .map((item) => {
              const change =
                item.priceChange === null ? '' : percent(item.priceChange);
              const priceHint = item.priceStale
                ? item.entryPrice === null
                  ? 'No verified quote received yet'
                  : 'Price update unavailable; last observation retained'
                : item.entryPrice === null
                  ? 'Price unavailable'
                  : change
                    ? `Change since first quote after entry in ${item.quoteSymbol}; refreshes every 2 min`
                    : 'First percentage update after 2 min';
              const observed = item.priceObservedAt
                ? ` · Price observed ${new Date(item.priceObservedAt).toLocaleTimeString()}`
                : '';
              const baseline = item.entryObservedAt
                ? ` · Baseline ${new Date(item.entryObservedAt).toLocaleTimeString()}`
                : '';
              return `<a href="${esc(item.href)}" target="_blank" rel="noopener noreferrer" title="${esc(item.ticker)} · ${number(item.flow)} ETH total inflow · ${esc(priceHint + baseline + observed)} · Open on GMGN"><span class="inflow-ticker">${esc(item.ticker)}</span>${change ? `<span class="price-change" data-direction="${item.priceChange > 0 ? 'up' : item.priceChange < 0 ? 'down' : 'flat'}" data-stale="${item.priceStale}">${change}${item.priceStale ? ' ·' : ''}</span>` : ''}</a>`;
            })
            .join('')
        : '<span class="empty">Waiting for tokens over 10 ETH</span>';
      if (inflow._html !== inflowHTML) {
        const focused = this.shadowRoot.activeElement;
        const focusHref =
          focused && inflow.contains(focused)
            ? focused.getAttribute('href')
            : null;
        const scrollLeft = inflow.scrollLeft;
        inflow.innerHTML = inflowHTML;
        inflow._html = inflowHTML;
        inflow.scrollLeft = scrollLeft;
        if (focusHref)
          [...inflow.querySelectorAll('a')]
            .find((a) => a.getAttribute('href') === focusHref)
            ?.focus({ preventScroll: true });
      }
    }
  }
  customElements.define('tracked-market-feed', TrackedMarketFeed);
}
