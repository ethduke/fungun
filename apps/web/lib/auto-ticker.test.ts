import test from 'node:test';
import assert from 'node:assert/strict';
import {
  watchTicker,
  tickerAvailability,
  canCheckTicker,
} from './auto-ticker.ts';
import { AppError } from './user-error.ts';
import type { TickerCheck } from './read-service.ts';

const answer = (
  ticker: string,
  status: 'reserved' | 'unreserved',
): TickerCheck => ({
  chainId: 4663,
  ticker,
  results: { long: { status, checkedAt: 0, expiresAt: 15000 } },
});
function timers() {
  let counter = 0;
  const jobs = new Map<number, { run: () => void; delay: number }>();
  return {
    jobs,
    schedule: ((run: () => void, delay: number) => {
      const id = ++counter;
      jobs.set(id, { run, delay });
      return id;
    }) as unknown as typeof setTimeout,
    cancel: ((id: number) => {
      jobs.delete(id);
    }) as unknown as typeof clearTimeout,
  };
}
void test('typing is coalesced; Enter flushes one request and a stopped draft ignores its response', async () => {
  const clock = timers();
  const seen: string[] = [];
  const results: string[] = [];
  let finish!: (value: TickerCheck) => void;
  const request = async (_chain: number, ticker: string) => {
    seen.push(ticker);
    return new Promise<TickerCheck>((r) => {
      finish = r;
    });
  };
  const create = (ticker: string) =>
    watchTicker({
      chainId: 4663,
      ticker,
      pads: ['long'],
      onPending: () => {},
      onResult: (value) => results.push(value.ticker),
      onError: () => {},
      request,
      ...clock,
    });
  const a = create('A');
  assert.equal([...clock.jobs.values()][0].delay, 200);
  a.stop();
  const ab = create('AB');
  assert.equal(clock.jobs.size, 1);
  const job = ab.flush();
  void ab.flush();
  assert.deepEqual(seen, ['AB']);
  ab.stop();
  const abc = create('ABC');
  finish(answer('AB', 'reserved'));
  await job;
  assert.deepEqual(results, []);
  const current = abc.flush();
  finish(answer('ABC', 'unreserved'));
  await current;
  assert.deepEqual(results, ['ABC']);
  assert.equal(clock.jobs.size, 0);
  abc.stop();
});
void test('only the selected ticker and launchpad results control red/green status and reserved blocking', () => {
  assert.equal(
    tickerAvailability(answer('TAKEN', 'reserved'), 4663, 'TAKEN', ['long']),
    'reserved',
  );
  assert.equal(
    tickerAvailability(answer('FREE', 'unreserved'), 4663, 'FREE', ['long']),
    'unreserved',
  );
  assert.equal(
    tickerAvailability(answer('TAKEN', 'reserved'), 4663, 'NEW', ['long']),
    'unknown',
  );
  assert.equal(
    tickerAvailability(answer('FREE', 'unreserved'), 8453, 'FREE', ['o1']),
    'unknown',
  );
  assert.equal(
    tickerAvailability(answer('FREE', 'unreserved'), 4663, 'FREE', [
      'long',
      'o1',
    ]),
    'unreserved',
  );
  assert.equal(tickerAvailability(null, 4663, 'FREE', ['long']), 'unknown');
  for (const ticker of ['', 'LONGERTICKER', 'BAD TICKER'])
    assert.equal(canCheckTicker(4663, ticker, ['long']), false);
});
void test('O1 needs no reservation request; mixed selections only check the shared Long registry', async () => {
  const clock = timers();
  const requestedPads: string[][] = [];
  let pending = 0;
  const create = (pads: ('long' | 'o1')[]) => watchTicker({
    chainId: 4663,
    ticker: 'MOON',
    pads,
    onPending: () => { pending++; },
    onResult: () => {},
    onError: () => assert.fail('Unexpected error'),
    request: async (_chain, ticker, selected) => {
      requestedPads.push(selected);
      return answer(ticker, 'unreserved');
    },
    ...clock,
  });
  const o1 = create(['o1']);
  await o1.flush();
  assert.equal(clock.jobs.size, 0);
  assert.equal(pending, 0);
  assert.deepEqual(requestedPads, []);
  o1.stop();
  const mixed = create(['long', 'o1']);
  await mixed.flush();
  assert.deepEqual(requestedPads, [['long']]);
  mixed.stop();
  assert.equal(canCheckTicker(8453, 'MOON', ['long']), false);
  assert.equal(canCheckTicker(4663, 'MOON', []), false);
});
void test('unavailable and throttled checks never become green; retries honor the server delay', async () => {
  const clock = timers();
  let results = 0,
    errors = 0;
  const watcher = watchTicker({
    chainId: 4663,
    ticker: 'TEST',
    pads: ['long'],
    onPending: () => {},
    onResult: () => {
      results++;
    },
    onError: () => {
      errors++;
    },
    request: async () => {
      throw new AppError('rate_limited', 45);
    },
    ...clock,
  });
  await watcher.flush();
  assert.equal(results, 0);
  assert.equal(errors, 1);
  assert.equal([...clock.jobs.values()][0].delay, 45001);
  await watcher.flush();
  assert.equal(errors, 1);
  watcher.stop();
  assert.equal(clock.jobs.size, 0);
});
