import {
  NARRATIVE_TTL_MS,
  NARRATIVE_NEW_MS,
} from '../lib/tracked-feed-narratives.mjs';
import { fomoHighlightsHTML, fomoStatus } from '../lib/fomo-highlights.mjs';
import { TrackedFeedPoller } from '../lib/tracked-feed-poller.mjs';
import { feedLaunchpad } from '../lib/tracked-feed-labels.mjs';

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
export function gmgnTokenUrl(row) {
  const address = String(row.meme || row.token || '');
  return Number(row.chain_id ?? 4663) === 4663 &&
    /^0x[0-9a-f]{40}$/i.test(address)
    ? `https://gmgn.ai/robinhood/token/${address.toLowerCase()}`
    : null;
}
const chain = (row) => Number(row.chain_id ?? 4663);
const token = (row) => String(row.meme || row.token || '');
const rowKey = (row) => `${chain(row)}:${row.pool || token(row)}`;

export function trackedTokenDraft(row) {
  const ticker = typeof row.sym === 'string' ? row.sym : '';
  const address = token(row).toLowerCase();
  const supportsImage = chain(row) === 4663 && /^0x[\da-f]{40}$/.test(address)
    && ['O1', 'O1 RWA', 'O1 Mig.'].includes(feedLaunchpad(row).label);
  return {
    name: typeof row.name === 'string' && row.name.trim() ? row.name : ticker,
    ticker,
    ...(supportsImage ? { imageSource: { chainId: 4663, address } } : {}),
  };
}

export function narrativesHTML(items, now = Date.now()) {
  if (!Array.isArray(items))
    return '<span class="empty">Narratives unavailable</span>';
  const active = items.filter(
    (item) =>
      item &&
      typeof item.name === 'string' &&
      Number.isSafeInteger(item.count) &&
      item.count >= 2 &&
      Number.isFinite(item.arrivedAt) &&
      item.arrivedAt > 0 &&
      item.arrivedAt <= now &&
      now - item.arrivedAt < NARRATIVE_TTL_MS,
  );
  return (
    active
      .sort((a, b) => b.arrivedAt - a.arrivedAt || b.id - a.id)
      .map(({ name, count, arrivedAt }) => {
        const elapsed = now - arrivedAt;
        const age =
          elapsed < 60_000
            ? '<1m'
            : elapsed < 3_600_000
              ? `${Math.floor(elapsed / 60_000)}m`
              : `${Math.floor(elapsed / 3_600_000)}h`;
        return `<span class="narrative">${elapsed < NARRATIVE_NEW_MS ? '<span class="narrative-new" aria-label="New narrative">🆕</span> ' : ''}<a href="https://x.com/search?q=${encodeURIComponent(name.toWellFormed())}&amp;src=typed_query" target="_blank" rel="noopener noreferrer">${esc(name)} (x${count})</a> <time datetime="${new Date(arrivedAt).toISOString()}" title="First reached two mentions: ${esc(new Date(arrivedAt).toLocaleString())}">· ${esc(age)}</time></span>`;
      })
      .join('<span class="narrative-separator">, </span>') ||
    '<span class="empty">No new narratives in the last 24h</span>'
  );
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
  :host{display:block;color:var(--feed-text,#223a2c);font:14px/1.4 var(--font-site,'Quicksand',sans-serif)}
  :host([compact]) .heading,:host([compact]) .narratives,:host([compact]) .columns{display:none}:host([compact]) .top{border-bottom:0}:host([compact]) .fomo{margin-top:0}
  *{box-sizing:border-box}section{border:1px solid var(--feed-border);border-radius:16px;background:var(--feed-bg);overflow:hidden}
  .top{padding:14px 16px;border-bottom:1px solid var(--feed-border)}.heading,.metadata,.identity,.totals{display:flex;align-items:center;justify-content:space-between;gap:10px}
  h2,h3,p{margin:0}h2{font-size: 16px}.status{font-size: 13px;color:var(--feed-muted)}.status[data-error=true]{color:#92520e}
  .fomo{margin-top:8px;padding:9px 12px;border:1px solid var(--feed-border);border-radius:6px;background:var(--feed-panel)}
  .fomo-line{display:flex;align-items:baseline;gap:9px;min-width:0}.fomo-label{color:var(--feed-accent);font-size:14px;font-weight:750;letter-spacing:.08em;flex-shrink:0}.fomo-buys{display:flex;align-items:baseline;gap:6px;overflow-x:auto;min-width:0;padding:3px 0;scrollbar-width:thin;font-size:14px}.fomo-buy{white-space:nowrap}.fomo-token{font-weight:750}.fomo-buy time,.fomo-separator,.fomo-empty{color:var(--feed-muted)}.fomo-buy time{font-size:12px}.fomo-health{display:block;color:var(--feed-muted);font-size:12px;margin-top:3px}
  .narratives{display:flex;align-items:baseline;gap:8px;margin-top:7px;min-width:0}.narratives-label{flex-shrink:0;font-weight:750;color:var(--feed-muted)}
  .narratives-tokens{min-width:0;overflow-x:auto;white-space:nowrap;font-size:14px;padding:3px 0;scrollbar-width:thin}.narrative{display:inline-block}.narrative time,.narrative-separator{color:var(--feed-muted)}.narratives-tokens:focus-visible{outline:2px solid var(--feed-accent)}.narratives-tokens a{font-weight:600}.narratives-tokens .empty{padding:0}
  .columns{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--feed-border)}.lane{min-width:0;background:var(--feed-bg);padding:10px}
  h3{font-size: 14px;letter-spacing:.1em;margin:0 4px 8px}h3 span{font-weight:400;color:var(--feed-muted);letter-spacing:0}
  .list{max-height:320px;overflow:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}
  article{background:var(--feed-panel);padding:10px;border:1px solid var(--feed-border);border-radius:8px;min-width:0}
  .metadata{align-items:center;color:var(--feed-muted);margin-bottom:6px;overflow-wrap:anywhere}.metadata>.launchpad{display:inline-flex;align-items:center;gap:6px;font-size: 14px;font-weight:700;color:var(--feed-text)}
  .launchpad-icon{display:grid;place-items:center;width:22px;height:22px;flex-shrink:0;border-radius:6px;color:#2f5034;background:#e6efcf}.launchpad-icon svg{width:16px;height:16px}
  .copy-button{flex-shrink:0;border:1px solid var(--feed-border);border-radius:4px;background:var(--feed-panel);color:var(--feed-text);font:600 13px/1 var(--font-site,'Quicksand',sans-serif);padding:6px 9px;cursor:pointer}.copy-button:hover{background:var(--feed-bg)}.copy-button:disabled{opacity:.5;cursor:not-allowed}
  .flow{margin-bottom:7px}.identity{justify-content:flex-start;gap:7px}.identity strong{font-size: 15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.quote{flex-shrink:0;font-size: 13px;color:var(--feed-accent)}
  a{color:var(--feed-accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,button:focus-visible,.ladder:focus-visible,.list:focus-visible{outline:2px solid var(--feed-accent);outline-offset:3px}
  .address{font-size: 13px;color:var(--feed-muted);margin:2px 0 0;overflow-wrap:anywhere}.metric-title{font-size: 13px;color:var(--feed-muted);margin-bottom:4px}
  .ladder{display:grid;grid-template-columns:repeat(11,minmax(44px,1fr));gap:3px;overflow-x:auto;padding:2px;scrollbar-width:thin}
  .bin{border:1px solid var(--feed-border);border-radius:4px;text-align:center;padding:4px 2px;font:12px/1.25 var(--font-site,'Quicksand',sans-serif);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pending{border-style:dashed;color:var(--feed-muted)}.current{outline:1px solid var(--feed-accent);outline-offset:0}.totals{font-size: 12px;color:var(--feed-muted);margin-top:6px}.totals b{font-size: 1rem;font-weight:500;color:var(--feed-text);white-space:nowrap}
  .empty{color:var(--feed-muted);padding:12px 4px;font-size: 14px}
  @media(max-width:760px){.columns{grid-template-columns:1fr}.top{padding:15px}.heading{align-items:flex-start;flex-direction:column;gap:4px}.list{max-height:280px}}
`;

if (
  typeof window !== 'undefined' &&
  !customElements.get('tracked-market-feed')
) {
  class TrackedMarketFeed extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${styles}</style><section aria-label="Tracked market feed"><div class="top"><div class="heading"><h2>Market feed</h2><span class="status" role="status" aria-live="polite">Connecting…</span></div><div class="fomo" aria-label="FOMO trader purchases"><div class="fomo-line"><span class="fomo-label">FOMO:</span><div class="fomo-buys" tabindex="0" role="region" aria-label="Recorded trader buys"></div></div><span class="fomo-health" role="status"></span></div><div class="narratives"><span class="narratives-label">Narratives:</span><nav class="narratives-tokens" aria-label="Narratives from the last 24 hours, newest first" tabindex="0"></nav></div></div><div class="columns"><div class="lane"><h3>ETH <span class="count-eth"></span></h3><div class="list" data-kind="eth" tabindex="0" role="region" aria-label="Tracked ETH pairs"></div></div><div class="lane"><h3>SHARES <span class="count-shares"></span></h3><div class="list" data-kind="shares" tabindex="0" role="region" aria-label="Tracked SHARES pairs"></div></div></div></section>`;
      this.rows = [];
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
          this.error = false;
          this.render();
        },
        onError: () => {
          this.error = true;
          this.render();
        },
      });
      this.fomoPayload = null;
      this.narrativeClock = null;
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
          if (Number.isFinite(payload.serverTime))
            this.narrativeClock = {
              serverTime: payload.serverTime,
              received: performance.now(),
            };
          this.fomoUnavailable = false;
          this.renderFomo();
          this.renderNarratives();
        },
        onError: () => {
          this.fomoUnavailable = true;
          this.renderFomo();
          this.renderNarratives();
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

    static get observedAttributes() {
      return ['compact'];
    }

    attributeChangedCallback() {
      if (this.fomoPoller) this.updateActivity();
    }

    connectedCallback() {
      this.fomoExpiryTimer = setInterval(() => {
        this.renderFomo();
        this.renderNarratives();
      }, 15_000);
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

    renderNarratives() {
      const list = this.shadowRoot.querySelector('.narratives-tokens');
      const now = this.narrativeClock
        ? this.narrativeClock.serverTime +
          Math.max(0, performance.now() - this.narrativeClock.received)
        : Date.now();
      const html = narrativesHTML(this.fomoPayload?.narratives, now);
      if (list._html === html) return;
      const focused = this.shadowRoot.activeElement;
      const href =
        focused && list.contains(focused) ? focused.getAttribute('href') : null;
      const left = list.scrollLeft;
      list.innerHTML = html;
      list._html = html;
      list.scrollLeft = left;
      if (href)
        [...list.querySelectorAll('a')]
          .find((a) => a.getAttribute('href') === href)
          ?.focus({ preventScroll: true });
    }

    render() {
      this.renderFomo();
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
      this.renderNarratives();
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
