import assert from 'node:assert/strict';
import test from 'node:test';
import {
  localExpiry,
  expiryDelay,
  parseCatalog,
  tickerKey,
  tickerLabel,
  checkTicker,
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

await test('concurrent 429 responses never shorten cooldown or let subsequent clicks fetch', async (t) => {
  const resolve: ((response: Response) => void)[] = [];
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    () => new Promise<Response>((done) => resolve.push(done)),
  );
  const first = assert.rejects(
    checkTicker(4663, 'LIMITED', ['long']),
    (error: unknown) => {
      assert.match(describeError(error, 'ticker'), /45 seconds/);
      return error instanceof AppError && error.code === 'rate_limited';
    },
  );
  const second = assert.rejects(
    checkTicker(4663, 'SHORTLIMIT', ['long']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'rate_limited' &&
      (error.retrySeconds ?? 0) >= 40,
  );
  resolve[0](
    new Response('private response body', {
      status: 429,
      headers: { 'retry-after': '45' },
    }),
  );
  await first;
  resolve[1](
    new Response('private response body', {
      status: 429,
      headers: { 'retry-after': '5' },
    }),
  );
  await second;
  await assert.rejects(
    checkTicker(4663, 'BACKOFF', ['long']),
    (error: unknown) =>
      error instanceof AppError && error.code === 'rate_limited',
  );
  assert.equal(fetch.mock.callCount(), 2);
});
