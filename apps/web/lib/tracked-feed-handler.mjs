import {
  FEED_INTERVAL_MS,
  feedRetryMs,
  retryAfterMs,
} from './tracked-feed-policy.mjs';
import { identifyO1Launchpad } from './tracked-feed-labels.mjs';
import { getO1Hooks, getStableAssets } from './tracked-feed-registry.mjs';
import { isTrackedStablecoin } from './tracked-feed-assets.mjs';

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

export function projectTrackedPayload(
  payload,
  hooks = null,
  stableAssets = null,
) {
  if (!payload || !Array.isArray(payload.pools))
    throw new Error('Invalid upstream feed');
  return {
    fetched_at: new Date().toISOString(),
    pools: payload.pools
      .filter(
        (row) =>
          row &&
          Number(row.chain_id ?? 4663) === 4663 &&
          ['eth', 'shares'].includes(row.quote_kind) &&
          !isTrackedStablecoin(row, stableAssets),
      )
      .map((row) => {
        const out = Object.fromEntries(
          fields
            .filter((key) => row[key] !== undefined)
            .map((key) => [key, row[key]]),
        );
        const launchpad = identifyO1Launchpad(row, hooks);
        if (launchpad !== undefined) out.launchpad = launchpad;
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

export function createTrackedFeedHandler({
  fetcher = (url, options) => fetch(url, options),
  now = () => performance.now(),
  loadHookRegistry = async () => null,
  loadStableRegistry = null,
} = {}) {
  // Shared only within this server process / Worker isolate, never per URL/user.
  let snapshot = null;
  let pending = null;
  let failures = 0;
  let retryAt = 0;

  async function refresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let retryAfter = 0;
    try {
      const stableAssets = loadStableRegistry
        ? await loadStableRegistry()
        : null;
      if (
        loadStableRegistry &&
        !(stableAssets instanceof Set && stableAssets.size)
      ) {
        // Do not show unfiltered rows or repeatedly fetch the feed while the
        // initial address registry is unavailable. Its cache retries in 5 min.
        retryAfter = 300_000;
        throw new Error('Asset classification unavailable');
      }
      // Read the daily registry alongside the feed, with its own two-second
      // timeout. Await both so the Worker lifetime covers all started work.
      const [feed, registry] = await Promise.allSettled([
        fetcher(UPSTREAM, {
          cache: 'no-store',
          // Workers support manual/follow; reject 3xx below without following them.
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        }),
        loadHookRegistry(),
      ]);
      if (feed.status === 'rejected') throw new Error('Feed unavailable');
      const upstream = feed.value;
      retryAfter = retryAfterMs(upstream.headers.get('retry-after'));
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new Error('Feed unavailable');
      }
      const hooks = registry.status === 'fulfilled' ? registry.value : null;
      const body = JSON.stringify(
        projectTrackedPayload(await upstream.json(), hooks, stableAssets),
      );
      snapshot = { body, expiresAt: now() + FEED_INTERVAL_MS };
      failures = 0;
      retryAt = 0;
      return body;
    } catch {
      failures = Math.min(failures + 1, 5);
      retryAt = now() + feedRetryMs(failures, retryAfter);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  function unavailable() {
    return new Response(
      JSON.stringify({ error: 'Feed temporarily unavailable' }),
      {
        status: 502,
        headers: {
          ...headers,
          'Retry-After': String(
            Math.max(1, Math.ceil((retryAt - now()) / 1000)),
          ),
        },
      },
    );
  }

  return async function handle(request) {
    if (request.method !== 'GET')
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...headers, Allow: 'GET' },
      });
    if (request.signal.aborted)
      return new Response(null, { status: 499, headers });
    if (snapshot && now() < snapshot.expiresAt)
      return new Response(snapshot.body, { headers });
    if (now() < retryAt) return unavailable();
    // Finish an already-started, bounded refresh even if one viewer leaves.
    // Its result serves the remaining viewers and prevents cancel/retry churn.
    pending ??= refresh().finally(() => {
      pending = null;
    });
    const body = await pending;
    if (request.signal.aborted)
      return new Response(null, { status: 499, headers });
    return body === null ? unavailable() : new Response(body, { headers });
  };
}

// Demand-driven singleton: no timer or upstream request without a GET.
export const handleTrackedFeed = createTrackedFeedHandler({
  loadHookRegistry: getO1Hooks,
  loadStableRegistry: getStableAssets,
});
