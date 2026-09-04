import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localExpiry,
  expiryDelay,
  parseCatalog,
  tickerKey,
  tickerLabel,
  checkTicker,
  loadCatalog,
  tickerNotice,
} from './read-service.ts';
import { AppError, describeError } from './user-error.ts';
import { DEFAULT_DESTINATIONS, validateDraft } from './launch-model.ts';

await test('ticker identity changes on edits and chain changes but not launchpad order', () => {
  assert.equal(
    tickerKey(4663, 'MOON', ['long', 'o1']),
    tickerKey(4663, 'MOON', ['o1', 'long']),
  );
  assert.notEqual(
    tickerKey(4663, 'MOON', ['o1']),
    tickerKey(8453, 'MOON', ['o1']),
  );
  assert.notEqual(
    tickerKey(4663, 'MOON', ['o1']),
    tickerKey(4663, 'SUN', ['o1']),
  );
});

await test('expired reservations and unknown reads never display as available', () => {
  assert.equal(
    tickerLabel({ status: 'unreserved', expiresAt: 100 }, 100),
    'Check again',
  );
  assert.equal(
    tickerLabel({ status: 'unreserved', expiresAt: 101 }, 100),
    'Unreserved',
  );
  assert.equal(tickerLabel({ status: 'unverified' }), 'Unverified');
  assert.equal(tickerLabel(), 'Not checked');
});

await test('freshness is response-relative and monotonic despite browser clock skew', () => {
  assert.equal(localExpiry(1_015_000, 1_000_000, 100, 50, 15_000), 15050);
  assert.equal(localExpiry(1_000_000, 1_000_000, 100, 50, 15_000), 100);
  assert.equal(localExpiry(99_000_000, 1_000_000, 100, 50, 15_000), 15050);
  assert.throws(() => localExpiry(Infinity, 1_000_000, 100, 50, 15_000));
  assert.equal(expiryDelay([1000], 900, 1100), 0);
  assert.equal(expiryDelay([1000], 1001, 1100), null);
  assert.equal(expiryDelay([1200, 1500], 1000, 1100), 100);
});

await test('catalog is validated and live pair IDs belong to the exact chain and pad', () => {
  const id = `rwa-${'a'.repeat(24)}` as const;
  const catalog = parseCatalog(
    {
      chainId: 4663,
      expiresAt: Date.now() + 60_000,
      pads: {
        o1: { status: 'ready', pairs: [{ id, symbol: 'MOON' }] },
        long: { status: 'ready', pairs: [] },
      },
    },
    4663,
  );
  const draft = {
    name: 'MOON',
    ticker: 'MOON',
    description: '',
    hasImage: true,
  };
  const pads = [
    {
      ...DEFAULT_DESTINATIONS[1],
      selected: true,
      route: 'rwa' as const,
      pairId: id,
    },
  ];
  assert.deepEqual(validateDraft(draft, pads, 4663, catalog), {});
  assert.ok(
    validateDraft(draft, pads, 4663, { ...catalog, expiresAt: 0 }).destinations,
  );
  assert.ok(
    validateDraft(draft, pads, 4663, { ...catalog, chainId: 8453 })
      .destinations,
  );
  assert.ok(
    validateDraft(draft, [{ ...pads[0], pairId: 'sample-nvda' }], 4663, catalog)
      .destinations,
  );
  assert.throws(() => parseCatalog({ ...catalog, chainId: 8453 }, 4663));
  assert.throws(() => parseCatalog({ ...catalog, pads: {} }, 4663));
});

await test('unverified ticker reasons become plain text without exposing raw provider data', () => {
  const notice = tickerNotice({
    chainId: 4663,
    ticker: 'MOON',
    results: {
      long: { status: 'unverified', reason: 'not_configured' },
      o1: { status: 'unverified', reason: 'unsupported' },
    },
  });
  assert.match(notice!, /Long: live ticker checks are not connected/);
  assert.match(notice!, /O1: ticker checking is not supported/);
});

await test('read service turns transport and malformed response failures into safe categories', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('synthetic private diagnostic');
  });
  await assert.rejects(
    checkTicker(4663, 'NETWORK', ['long']),
    (error: unknown) => error instanceof AppError && error.code === 'network',
  );
  fetch.mock.mockImplementation(
    async () => new Response('not json', { status: 200 }),
  );
  await assert.rejects(
    checkTicker(4663, 'BADJSON', ['long']),
    (error: unknown) =>
      error instanceof AppError && error.code === 'invalid_response',
  );
  fetch.mock.mockImplementation(
    async () => new Response('private response body', { status: 504 }),
  );
  await assert.rejects(
    checkTicker(4663, 'TIMEOUT', ['long']),
    (error: unknown) => error instanceof AppError && error.code === 'timeout',
  );
});

await test('provider cooldown preserves catalog reads while global cooldown preserves cache', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (url: string | URL | Request, options?: RequestInit) => {
      const href =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (href.endsWith('/api/ticker'))
        return new Response(null, {
          status: 429,
          headers: {
            'retry-after': '21540',
            'x-fungun-retry-scope': 'operation',
          },
        });
      if (typeof options?.body !== 'string') assert.fail('Expected JSON body');
      const { chainId } = JSON.parse(options.body);
      if (chainId === 4663)
        return Response.json({
          serverTime: Date.now(),
          chainId: 4663,
          expiresAt: Date.now() + 6 * 60 * 60 * 1000,
          pads: {
            long: { status: 'ready', pairs: [] },
            o1: { status: 'ready', pairs: [] },
          },
        });
      return new Response(null, {
        status: 429,
        headers: { 'retry-after': '45' },
      });
    },
  );
  await assert.rejects(
    checkTicker(4663, 'PROVIDER', ['long']),
    (error: unknown) =>
      error instanceof AppError && error.code === 'rate_limited',
  );
  const cached = await loadCatalog(4663);
  assert.ok(cached.expiresAt - performance.now() > 5 * 60 * 60 * 1000);
  await assert.rejects(loadCatalog(8453), (error: unknown) => {
    assert.match(describeError(error, 'catalog'), /45 seconds/);
    return error instanceof AppError && error.code === 'rate_limited';
  });
  assert.equal(await loadCatalog(4663), cached);
  await assert.rejects(loadCatalog(8453), {
    code: 'rate_limited',
  });
  assert.equal(fetch.mock.callCount(), 3);
});
