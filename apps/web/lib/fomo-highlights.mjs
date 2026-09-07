const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

export function fomoHighlightsHTML(payload, now = Date.now()) {
  const rows = Array.isArray(payload?.stream_highlights)
    ? payload.stream_highlights
    : [];
  const seen = new Set();
  const valid = rows.filter((row) => {
    if (
      !row ||
      !/^[a-z0-9_.-]{1,64}$/.test(row.handle) ||
      !/^0x[0-9a-f]{40}$/i.test(row.token) ||
      !Number.isInteger(row.buy_alerts) ||
      row.buy_alerts <= 0 ||
      !Number.isFinite(row.last_bought_at) ||
      row.last_bought_at <= 0 ||
      row.last_bought_at * 1000 <= now - 86_400_000 ||
      !Number.isFinite(new Date(row.last_bought_at * 1000).getTime())
    )
      return false;
    const key = `${row.handle}:${row.token.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!valid.length)
    return '<span class="fomo-empty">No confirmed buys in the last 24 hours</span>';
  return valid
    .map((row) => {
      const date = new Date(row.last_bought_at * 1000);
      const when = date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `<span class="fomo-buy"><a href="https://fomo.family/profile/${encodeURIComponent(row.handle)}" target="_blank" rel="noopener noreferrer">@${esc(row.label || row.handle)}</a> bought <a class="fomo-token" href="https://gmgn.ai/robinhood/token/${row.token.toLowerCase()}" target="_blank" rel="noopener noreferrer">${esc(row.symbol || row.token)}</a> <time datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">(${esc(when)})</time></span>`;
    })
    .join('<span class="fomo-separator" aria-hidden="true">,</span>');
}

export function fomoStatus(payload, unavailable = false, now = Date.now()) {
  if (unavailable) return 'Feed unavailable · showing buys from the last 24 hours';
  if (!payload) return 'Checking FOMO…';
  const states = {
    disabled: 'Tracking disabled',
    not_configured: 'Tracking not configured',
    access_denied: 'Feed access denied',
    budget_exhausted: 'Reconnect limit reached',
    storage_error: 'Cache unavailable',
    connecting: 'Connecting to FOMO…',
    reconnecting: 'Feed reconnecting',
  };
  const connection =
    states[payload.state] ||
    (payload.connected
      ? 'Live feed connected'
      : 'Feed disconnected · buys retained for 24 hours');
  const retry = !payload.connected && Number.isFinite(payload.retry_at)
    ? ` · retry in ${Math.max(0, Math.ceil((payload.retry_at * 1000 - now) / 60_000))}m`
    : '';
  const delay = payload.connected && Number.isFinite(payload.delay_seconds)
    ? ` · ${payload.delay_seconds}s delay`
    : '';
  const stream =
    payload.stream_status === 'unavailable'
      ? ' · Stream observer unavailable'
      : '';
  return `${connection}${retry}${delay}${stream}`;
}
