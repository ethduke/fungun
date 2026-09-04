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
const chain = (row) => Number(row.chain_id ?? 4663);
const token = (row) => String(row.meme || row.token || '');
const rowKey = (row) => `${chain(row)}:${row.pool || token(row)}`;
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
    id = chain(row),
    name = String(row.name || row.sym || 'Unnamed token');
  const rawLaunchpad = String(row.launchpad || 'Unknown launchpad');
  const launchpad = rawLaunchpad.startsWith('hook:')
    ? 'Unknown hook'
    : rawLaunchpad;
  const quote =
    row.quote_symbol || (row.quote_kind === 'eth' ? 'ETH' : 'SHARES');
  const network =
    id === 4663 ? 'Robinhood' : id === 8453 ? 'Base' : `Chain ${id}`;
  const chart =
    /^0x[0-9a-f]{40}$/i.test(address) && [4663, 8453].includes(id)
      ? `https://gmgn.ai/${id === 8453 ? 'base' : 'robinhood'}/token/${address}`
      : null;
  const short = address
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : 'Address unavailable';
  return `<div class="metadata"><span title="${esc(rawLaunchpad)}">${esc(launchpad)}</span><span>${esc(network)}${id === 8453 ? ' · Observed snapshot' : ''}</span></div>
    <div class="identity"><strong title="${esc(name)}">${esc(name)}</strong><span class="quote">/ ${esc(quote)}</span></div>
    <div class="address">${chart ? `<a href="${esc(chart)}" target="_blank" rel="noopener noreferrer" title="${esc(address)}">${esc(short)} ↗</a>` : esc(short)}${row.sym && row.name ? ` <span>${esc(row.sym)}</span>` : ''}</div>
    <div class="metric-title">ETH-equivalent per bin</div>${ladder(row.trail)}
    <div class="totals"><span>Total inflow <b>${number(row.total_in)} ETH</b></span><span>${number(row.swaps)} swaps</span></div>`;
}

const styles = `
  :host{display:block;color:var(--feed-text,#223a2c);font:14px/1.45 Arial,Helvetica,sans-serif}
  *{box-sizing:border-box}section{border:1px solid var(--feed-border);border-radius:16px;background:var(--feed-bg);overflow:hidden}
  .top{padding:18px 20px;border-bottom:1px solid var(--feed-border)}.heading,.metadata,.identity,.totals{display:flex;align-items:center;justify-content:space-between;gap:12px}
  h2,h3,p{margin:0}h2{font-size:16px}.status{font-size:12px;color:var(--feed-muted)}.status[data-error=true]{color:#92520e}
  .popular{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}.popular-label{font-size:12px;letter-spacing:.08em;font-weight:750;color:var(--feed-muted)}
  .popular a{padding:5px 9px;border-radius:6px;border:1px solid var(--feed-border);background:var(--feed-panel);overflow-wrap:anywhere}.popular small{font-size:12px;color:var(--feed-muted);margin-left:6px}
  .columns{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--feed-border)}.lane{min-width:0;background:var(--feed-bg);padding:14px}
  h3{font-size:14px;letter-spacing:.1em;margin:0 4px 10px}h3 span{font-weight:400;color:var(--feed-muted);letter-spacing:0}
  .list{max-height:320px;overflow:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
  article{background:var(--feed-panel);padding:13px;border:1px solid var(--feed-border);border-radius:10px;min-width:0}
  .metadata{align-items:flex-start;font-size:12px;color:var(--feed-muted);margin-bottom:7px;overflow-wrap:anywhere}.metadata span:first-child{font-size:14px;font-weight:700;color:var(--feed-text)}.metadata span:last-child{text-align:right}
  .identity{justify-content:flex-start;gap:8px}.identity strong{font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.quote{flex-shrink:0;font-size:12px;color:var(--feed-accent)}
  a{color:var(--feed-accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,.ladder:focus-visible,.list:focus-visible{outline:2px solid var(--feed-accent);outline-offset:3px}
  .address{font-size:12px;color:var(--feed-muted);margin:3px 0 12px;overflow-wrap:anywhere}.metric-title{font-size:12px;color:var(--feed-muted);margin-bottom:6px}
  .ladder{display:grid;grid-template-columns:repeat(11,minmax(44px,1fr));gap:3px;overflow-x:auto;padding:2px;scrollbar-width:thin}
  .bin{border:1px solid var(--feed-border);border-radius:4px;text-align:center;padding:5px 2px;font:12px/1.25 ui-monospace,monospace;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pending{border-style:dashed;color:var(--feed-muted)}.current{outline:1px solid var(--feed-accent);outline-offset:0}.totals{font-size:12px;color:var(--feed-muted);margin-top:10px}.totals b{font-weight:500;color:var(--feed-text)}
  .empty{color:var(--feed-muted);padding:12px 4px;font-size:12px}
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
      this.shadowRoot.innerHTML = `<style>${styles}</style><section aria-label="Tracked market feed"><div class="top"><div class="heading"><h2>Market feed</h2><span class="status" role="status" aria-live="polite">Connecting…</span></div><div class="popular"></div></div><div class="columns"><div class="lane"><h3>ETH <span class="count-eth"></span></h3><div class="list" data-kind="eth" tabindex="0" role="region" aria-label="Tracked ETH pairs"></div></div><div class="lane"><h3>SHARES <span class="count-shares"></span></h3><div class="list" data-kind="shares" tabindex="0" role="region" aria-label="Tracked SHARES pairs"></div></div></div></section>`;
      this.rows = [];
      this.receivedAt = null;
      this.generation = 0;
      this.nodes = new Map();
      this.render();
    }

    connectedCallback() {
      this.running = true;
      this.generation++;
      void this.refresh(this.generation);
    }

    disconnectedCallback() {
      this.running = false;
      this.generation++;
      clearTimeout(this.timer);
      this.controller?.abort();
    }

    async refresh(generation) {
      if (!this.running || generation !== this.generation) return;
      const controller = new AbortController();
      this.controller = controller;
      const deadline = setTimeout(() => controller.abort(), 10000);
      const started = Date.now();
      try {
        const url = new URL(
          this.getAttribute('src') || '/api/tracked-feed',
          location.href,
        );
        if (url.origin !== location.origin)
          throw new Error('Use a same-origin feed endpoint');
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Feed unavailable');
        const snapshot = await response.json();
        if (!Array.isArray(snapshot.pools))
          throw new Error('Invalid feed response');
        if (!this.running || generation !== this.generation) return;
        const seen = new Set();
        this.rows = snapshot.pools.filter((row) => {
          if (!row || !['eth', 'shares'].includes(row.quote_kind)) return false;
          const key = rowKey(row);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        this.receivedAt = Date.now();
        this.error = false;
        this.render();
      } catch {
        if (!this.running || generation !== this.generation) return;
        this.error = true;
        this.render();
      } finally {
        clearTimeout(deadline);
        if (this.running && generation === this.generation) {
          this.timer = setTimeout(
            () => this.refresh(generation),
            Math.max(0, 4000 - (Date.now() - started)),
          );
        }
      }
    }

    render() {
      const status = this.shadowRoot.querySelector('.status');
      status.dataset.error = String(Boolean(this.error));
      const timestamp = this.receivedAt
        ? new Date(this.receivedAt).toLocaleTimeString()
        : null;
      status.textContent = this.error
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
            const scrollLeft = previousLadder?.scrollLeft ?? 0;
            const focusLadder = Boolean(previousLadder && focused === previousLadder);
            node.innerHTML = html;
            node._html = html;
            const nextLadder = node.querySelector('.ladder');
            if (nextLadder) nextLadder.scrollLeft = scrollLeft;
            if (focusLadder) nextLadder?.focus({ preventScroll: true });
            if (focusHref)
              [...node.querySelectorAll('a')]
                .find((a) => a.getAttribute('href') === focusHref)
                ?.focus({ preventScroll: true });
          }
          if (list.children[i] !== node)
            list.insertBefore(node, list.children[i] || null);
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
