import { TrackedFeedPoller } from '../lib/tracked-feed-poller.mjs';
import { feedLaunchpad } from '../lib/tracked-feed-labels.mjs';
import {
  gmgnTokenUrl,
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
const chain = (row) => Number(row.chain_id ?? 4663);
const token = (row) => String(row.meme || row.token || '');
const rowKey = (row) => `${chain(row)}:${row.pool || token(row)}`;

export function trackedTokenDraft(row) {
  const ticker = typeof row.sym === 'string' ? row.sym : '';
  return {
    name: typeof row.name === 'string' && row.name.trim() ? row.name : ticker,
    ticker,
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

function ladder(trail) {
  const cells = binCells(trail);
  if (!cells.length) return '<p class="empty">Flow data unavailable</p>';
  return `<div class="ladder" role="list" tabindex="0" aria-label="ETH-equivalent per bin">${cells
    .map((cell) => {
      const label = cell.pending
        ? 'Not reached yet'
        : `${number(cell.value)} ETH-equivalent${cell.buys === null ? '' : ` · ${cell.buys} buys`}${cell.current ? ' · Latest observed' : ''}`;
      const intensity =
        cell.value === null || cell.value <= 0
          ? 0
          : Math.min(1, Math.log10(1 + cell.value) / Math.log10(181));
      const background =
        cell.pending || !intensity
          ? 'transparent'
          : `rgba(61,125,255,${(0.14 + 0.86 * intensity).toFixed(3)})`;
      return `<span role="listitem" class="bin ${cell.pending ? 'pending' : cell.current ? 'current' : ''}" style="background:${background}" title="${esc(label)}" aria-label="${esc(label)}">${cell.pending ? '·' : number(cell.value)}</span>`;
    })
    .join('')}</div>`;
}

function card(row) {
  const address = token(row),
    name = String(row.name || row.sym || 'Unnamed token');
  const draft = trackedTokenDraft(row);
  const {
    label: launchpad,
    title: launchpadTitle,
    isLong,
  } = feedLaunchpad(row);
  const launchpadIcon = isLong
    ? '<span class="launchpad-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg></span>'
    : '';
  const quote =
    row.quote_symbol || (row.quote_kind === 'eth' ? 'ETH' : 'SHARES');
  const chart = gmgnTokenUrl(row);
  const short = address
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : 'Address unavailable';
  return `<div class="metadata"><span class="launchpad" title="${esc(launchpadTitle)}">${launchpadIcon}${esc(launchpad)}</span><button class="copy-button" type="button" aria-label="Copy ${esc(name)} to launch form"${!draft.name && !draft.ticker ? ' disabled' : ''}>COPY</button></div>
    <div class="flow"><div class="metric-title">ETH-equivalent per bin</div>${ladder(row.trail)}</div>
    <div class="identity"><strong title="${esc(name)}">${esc(name)}</strong><span class="quote">/ ${esc(quote)}</span></div>
    <div class="address">${chart ? `<a href="${esc(chart)}" target="_blank" rel="noopener noreferrer" title="${esc(address)}">${esc(short)} ↗</a>` : esc(short)}${row.sym && row.name ? ` <span>${esc(row.sym)}</span>` : ''}</div>
    <div class="totals"><span>Total inflow <b>${number(row.total_in)} ETH</b></span><span>${number(row.swaps)} swaps</span></div>`;
}

const styles = `
  :host{display:block;color:var(--feed-text,#223a2c);font:12px/1.4 Arial,Helvetica,sans-serif}
  *{box-sizing:border-box}section{border:1px solid var(--feed-border);border-radius:16px;background:var(--feed-bg);overflow:hidden}
  .top{padding:14px 16px;border-bottom:1px solid var(--feed-border)}.heading,.metadata,.identity,.totals{display:flex;align-items:center;justify-content:space-between;gap:10px}
  h2,h3,p{margin:0}h2{font-size:14px}.status{font-size:11px;color:var(--feed-muted)}.status[data-error=true]{color:#92520e}
  .popular{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.popular-label{font-size:11px;letter-spacing:.08em;font-weight:750;color:var(--feed-muted)}
  .popular a{padding:5px 9px;border-radius:6px;border:1px solid var(--feed-border);background:var(--feed-panel);overflow-wrap:anywhere}.popular small{font-size:12px;color:var(--feed-muted);margin-left:6px}
  .inflow{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0}.inflow>.popular-label{flex-shrink:0}
  .inflow-tokens{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;padding:3px;white-space:nowrap;scrollbar-width:thin}.inflow-tokens a{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;padding:4px 7px;border:1px solid var(--feed-border);border-radius:5px;background:var(--feed-panel);font-size:11px;font-weight:600}.inflow-ticker{max-width:110px;overflow:hidden;text-overflow:ellipsis}.price-change{font-variant-numeric:tabular-nums;color:var(--feed-muted)}.price-change[data-direction=up]{color:#268044}.price-change[data-direction=down]{color:#b13b33}.price-change[data-stale=true]{color:var(--feed-muted)}.inflow-tokens .empty{padding:4px 0;font-size:11px}
  .columns{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--feed-border)}.lane{min-width:0;background:var(--feed-bg);padding:10px}
  h3{font-size:12px;letter-spacing:.1em;margin:0 4px 8px}h3 span{font-weight:400;color:var(--feed-muted);letter-spacing:0}
  .list{max-height:320px;overflow:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}
  article{background:var(--feed-panel);padding:10px;border:1px solid var(--feed-border);border-radius:8px;min-width:0}
  .metadata{align-items:center;color:var(--feed-muted);margin-bottom:6px;overflow-wrap:anywhere}.metadata>.launchpad{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:var(--feed-text)}
  .launchpad-icon{display:grid;place-items:center;width:22px;height:22px;flex-shrink:0;border-radius:6px;color:#2f5034;background:#e6efcf}.launchpad-icon svg{width:16px;height:16px}
  .copy-button{flex-shrink:0;border:1px solid var(--feed-border);border-radius:4px;background:var(--feed-panel);color:var(--feed-text);font:600 11px/1 Arial,Helvetica,sans-serif;padding:6px 9px;cursor:pointer}.copy-button:hover{background:var(--feed-bg)}.copy-button:disabled{opacity:.5;cursor:not-allowed}
  .flow{margin-bottom:7px}.identity{justify-content:flex-start;gap:7px}.identity strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.quote{flex-shrink:0;font-size:11px;color:var(--feed-accent)}
  a{color:var(--feed-accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible,.ladder:focus-visible,.list:focus-visible{outline:2px solid var(--feed-accent);outline-offset:3px}
  .address{font-size:11px;color:var(--feed-muted);margin:2px 0 0;overflow-wrap:anywhere}.metric-title{font-size:11px;color:var(--feed-muted);margin-bottom:4px}
  .ladder{display:grid;grid-template-columns:repeat(11,minmax(44px,1fr));gap:3px;overflow-x:auto;padding:2px;scrollbar-width:thin}
  .bin{border:1px solid var(--feed-border);border-radius:4px;text-align:center;padding:4px 2px;font:10px/1.25 ui-monospace,monospace;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pending{border-style:dashed;color:var(--feed-muted)}.current{outline:1px solid var(--feed-accent);outline-offset:0}.totals{font-size:10px;color:var(--feed-muted);margin-top:6px}.totals b{font-weight:500;color:var(--feed-text)}
  .empty{color:var(--feed-muted);padding:12px 4px;font-size:12px}
  @media(max-width:760px){.columns{grid-template-columns:1fr}.top{padding:15px}.heading{align-items:flex-start;flex-direction:column;gap:4px}.list{max-height:280px}.inflow{align-items:stretch;flex-direction:column;gap:3px}}
`;

if (
  typeof window !== 'undefined' &&
  !customElements.get('tracked-market-feed')
) {
  class TrackedMarketFeed extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${styles}</style><section aria-label="Tracked market feed"><div class="top"><div class="heading"><h2>Market feed</h2><span class="status" role="status" aria-live="polite">Connecting…</span></div><div class="popular"></div><div class="inflow"><span class="popular-label">&gt;10ETH INFL:</span><nav class="inflow-tokens" aria-label="Tokens over 10 ETH total inflow, oldest first"></nav></div></div><div class="columns"><div class="lane"><h3>ETH <span class="count-eth"></span></h3><div class="list" data-kind="eth" tabindex="0" role="region" aria-label="Tracked ETH pairs"></div></div><div class="lane"><h3>SHARES <span class="count-shares"></span></h3><div class="list" data-kind="shares" tabindex="0" role="region" aria-label="Tracked SHARES pairs"></div></div></div></section>`;
      this.rows = [];
      this.inflowQueue = new TrackedInflowQueue();
      this.inflows = [];
      this.priceController = null;
      this.priceRetryAt = 0;
      this.receivedAt = null;
      this.inView = false;
      this.pageHidden = false;
      this.pauseReason = null;
      this.poller = new TrackedFeedPoller({
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
      this.syncActivity = () => this.updateActivity();
      this.onPageHide = () => {
        this.pageHidden = true;
        this.updateActivity();
      };
      this.onPageShow = () => {
        this.pageHidden = false;
        this.updateActivity();
      };
      this.nodes = new Map();
      this.shadowRoot.addEventListener('click', (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest('.copy-button')
            : null;
        if (!button || button.hasAttribute('disabled')) return;
        const key = button.closest('article')?.dataset.rowKey;
        const row = this.rows.find((item) => rowKey(item) === key);
        if (!row) return;
        this.dispatchEvent(
          new CustomEvent('fungun:copy-tracked-token', {
            bubbles: true,
            composed: true,
            detail: trackedTokenDraft(row),
          }),
        );
      });
      this.render();
    }

    connectedCallback() {
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
      this.observer?.disconnect();
      this.observer = null;
      document.removeEventListener('visibilitychange', this.syncActivity);
      window.removeEventListener('online', this.syncActivity);
      window.removeEventListener('offline', this.syncActivity);
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
      this.poller.setActive(false);
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
      if (reason === this.pauseReason && active === this.poller.active) return;
      this.pauseReason = reason;
      this.poller.setActive(active);
      if (!active) {
        this.priceController?.abort();
        this.priceController = null;
      }
      this.render();
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
        const body = await response.json();
        if (Number.isFinite(body.serverTime)) serverTime = body.serverTime;
        if (Array.isArray(body.prices) && body.prices.length <= 10)
          prices = body.prices;
      } catch {
        // No raw backend/provider errors or fabricated zero-price returns.
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
      const status = this.shadowRoot.querySelector('.status');
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
                ? 'Price update unavailable; last observation retained'
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
      const present = new Set();
      for (const kind of ['eth', 'shares']) {
        const list = this.shadowRoot.querySelector(`[data-kind="${kind}"]`);
        const rows = this.rows.filter((row) => row.quote_kind === kind);
        this.shadowRoot.querySelector(`.count-${kind}`).textContent =
          `(${rows.length})`;
        list.querySelector('.empty-state')?.remove();
        rows.forEach((row, i) => {
          const key = rowKey(row);
          if (present.has(key)) return;
          present.add(key);
          let node = this.nodes.get(key);
          if (!node) {
            node = document.createElement('article');
            node.dataset.rowKey = key;
            this.nodes.set(key, node);
          }
          const html = card(row);
          if (node._html !== html) {
            const focused = this.shadowRoot.activeElement;
            const focusHref =
              focused && node.contains(focused)
                ? focused.getAttribute('href')
                : null;
            const previousLadder = node.querySelector('.ladder');
            const focusCopy =
              focused?.classList.contains('copy-button') &&
              node.contains(focused);
            const scrollLeft = previousLadder?.scrollLeft ?? 0;
            const focusLadder = Boolean(
              previousLadder && focused === previousLadder,
            );
            node.innerHTML = html;
            node._html = html;
            const nextLadder = node.querySelector('.ladder');
            if (nextLadder) nextLadder.scrollLeft = scrollLeft;
            if (focusLadder) nextLadder?.focus({ preventScroll: true });
            if (focusCopy)
              node
                .querySelector('.copy-button')
                ?.focus({ preventScroll: true });
            if (focusHref)
              [...node.querySelectorAll('a')]
                .find((a) => a.getAttribute('href') === focusHref)
                ?.focus({ preventScroll: true });
          }
          if (list.children[i] !== node) {
            const focused = this.shadowRoot.activeElement;
            list.insertBefore(node, list.children[i] || null);
            if (focused && node.contains(focused))
              focused.focus({ preventScroll: true });
          }
        });
        if (!rows.length) {
          const empty = document.createElement('p');
          empty.className = 'empty empty-state';
          empty.textContent = this.receivedAt
            ? `No tracked ${kind === 'eth' ? 'ETH' : 'SHARES'} pairs right now`
            : this.error
              ? 'Waiting for the feed to reconnect…'
              : 'Loading tracked pairs…';
          list.append(empty);
        }
      }
      for (const [key, node] of this.nodes)
        if (!present.has(key)) {
          node.remove();
          this.nodes.delete(key);
        }
    }
  }
  customElements.define('tracked-market-feed', TrackedMarketFeed);
}
