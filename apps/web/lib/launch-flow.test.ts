import test from 'node:test';
import assert from 'node:assert/strict';
import { runLaunchFlow } from './launch-flow.ts';
import { LaunchError, LaunchPreflightError } from './long-wallet.ts';
import { AssetError } from './asset-protocol.ts';

function fixture() {
  let clock = 0,
    current = true;
  const events: string[] = [];
  return {
    events,
    get clock() {
      return clock;
    },
    change: () => {
      current = false;
    },
    options: {
      isCurrent: () => current,
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms;
      },
      onProgress: (text: string) => {
        events.push(text);
      },
    },
  };
}
void test('one action resumes throttled preparation and opens the wallet after artwork completes', async () => {
  const f = fixture();
  let checks = 0,
    quotes = 0,
    sends = 0;
  await runLaunchFlow({
    ...f.options,
    artwork: async () => {
      if (checks++ === 0)
        throw new AssetError('asset_publication_uncertain', 2);
      return 'published';
    },
    quote: async (art) => {
      assert.equal(art, 'published');
      if (quotes++ === 0) throw new LaunchError('rate_limited', 21);
      return 'fresh quote';
    },
    wallet: async (q) => {
      assert.equal(q, 'fresh quote');
      sends++;
    },
  });
  assert.equal(checks, 2);
  assert.equal(quotes, 2);
  assert.equal(sends, 1);
  assert.equal(f.clock, 23000);
});
void test('a failure before wallet dispatch refreshes the quote without repeating artwork', async () => {
  for (const error of [
    new LaunchError('quote_expired'),
    new LaunchError('rate_limited', 7),
  ]) {
    const f = fixture();
    let artwork = 0,
      quotes = 0,
      preflight = 0,
      sent = 0;
    await runLaunchFlow({
      ...f.options,
      artwork: async () => ++artwork,
      quote: async () => ++quotes,
      wallet: async () => {
        if (preflight++ === 0) throw new LaunchPreflightError(error);
        sent++;
      },
    });
    assert.equal(artwork, 1);
    assert.equal(quotes, 2);
    assert.equal(sent, 1);
  }
});
void test('rejection, lost send response, and even a rate-limit response after send never retry the wallet', async () => {
  for (const error of [
    Object.assign(new Error('rejected'), { code: 4001 }),
    new TypeError('lost response'),
    new LaunchError('rate_limited', 1),
  ]) {
    const f = fixture();
    let sends = 0;
    await assert.rejects(
      runLaunchFlow({
        ...f.options,
        artwork: async () => 1,
        quote: async () => 1,
        wallet: async () => {
          sends++;
          throw error;
        },
      }),
      (e) => e === error,
    );
    assert.equal(sends, 1);
    assert.equal(f.clock, 0);
  }
});
void test('changing the draft/account while waiting prevents all further preparation and payment', async () => {
  const f = fixture();
  let quotes = 0,
    sent = 0;
  await assert.rejects(
    runLaunchFlow({
      ...f.options,
      pause: async () => {
        f.change();
      },
      artwork: async () => 1,
      quote: async () => {
        quotes++;
        throw new LaunchError('rate_limited', 10);
      },
      wallet: async () => {
        sent++;
      },
    }),
  );
  assert.equal(quotes, 1);
  assert.equal(sent, 0);
});
void test('daily exhaustion and repeated preflight failures have bounded retries', async () => {
  const f = fixture();
  let quotes = 0;
  await assert.rejects(
    runLaunchFlow({
      ...f.options,
      artwork: async () => 1,
      quote: async () => {
        quotes++;
        throw new LaunchError('rate_limited', 3600);
      },
      wallet: async () => {},
    }),
    /rate_limited/,
  );
  assert.equal(quotes, 1);
  assert.equal(f.clock, 0);
  let opens = 0;
  await assert.rejects(
    runLaunchFlow({
      ...f.options,
      artwork: async () => 1,
      quote: async () => 1,
      wallet: async () => {
        opens++;
        throw new LaunchPreflightError(new LaunchError('quote_expired'));
      },
    }),
  );
  assert.equal(opens, 3);
});

void test('daily read exhaustion does not retry or open the wallet', async () => {
  const f = fixture(); let reads = 0, sends = 0;
  await assert.rejects(runLaunchFlow({ ...f.options, artwork: async () => 1,
    quote: async () => { reads++; throw new LaunchError('read_daily_limit', 26000); },
    wallet: async () => { sends++; } }), /read_daily_limit/);
  assert.equal(reads, 1); assert.equal(sends, 0); assert.equal(f.clock, 0);
});
void test('temporary read throttling counts down and continues without a second launch click', async () => {
  const f = fixture(); let reads = 0, sends = 0; const progress: string[] = [];
  await runLaunchFlow({ ...f.options, onProgress: message => { progress.push(message); }, artwork: async () => 1,
    quote: async () => { if (++reads === 1) throw new LaunchError('rate_limited', 2); return 1; },
    wallet: async () => { sends++; } });
  assert.ok(progress.includes('Retrying launch preparation in 2s…'));
  assert.ok(progress.includes('Retrying launch preparation in 1s…'));
  assert.equal(sends, 1); assert.equal(f.clock, 2000);
});
