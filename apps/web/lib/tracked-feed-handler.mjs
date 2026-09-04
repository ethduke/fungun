const UPSTREAM = 'https://rh-monitor.fly.dev/api';
const fields = [
  'pool',
  'meme',
  'token',
  'name',
  'sym',
  'version',
  'launchpad',
  'chain_id',
  'quote_kind',
  'quote_symbol',
  'first_in',
  'total_in',
  'swaps',
];
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

export function projectTrackedPayload(payload) {
  if (!payload || !Array.isArray(payload.pools))
    throw new Error('Invalid upstream feed');
  return {
    fetched_at: new Date().toISOString(),
    pools: payload.pools
      .filter(
        (row) =>
          row &&
          Number(row.chain_id ?? 4663) === 4663 &&
          ['eth', 'shares'].includes(row.quote_kind),
      )
      .map((row) => {
        const out = Object.fromEntries(
          fields
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        );
        const trail = row.trail;
        out.trail =
          trail && Array.isArray(trail.ladder)
            ? {
                ladder: trail.ladder.slice(0, 11),
                txs: Array.isArray(trail.txs) ? trail.txs.slice(0, 11) : [],
                bin: trail.bin ?? null,
                base: trail.base ?? 0,
              }
            : null;
        return out;
      }),
  };
}

// Mount this server-side at GET /api/tracked-feed in the destination framework.
export async function handleTrackedFeed(request) {
  if (request.method !== 'GET')
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, Allow: 'GET' },
    });
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const upstream = await fetch(UPSTREAM, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) throw new Error('Feed unavailable');
    return new Response(
      JSON.stringify(projectTrackedPayload(await upstream.json())),
      { headers },
    );
  } catch {
    return new Response(
      JSON.stringify({ error: 'Feed temporarily unavailable' }),
      { status: 502, headers },
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abort);
  }
}
