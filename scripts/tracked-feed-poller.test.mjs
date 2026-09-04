import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { TrackedFeedPoller } from "../apps/web/lib/tracked-feed-poller.mjs";
import { feedRetryMs, retryAfterMs } from "../apps/web/lib/tracked-feed-policy.mjs";

function harness(t, fetcher) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = 0;
  const calls = [],
    snapshots = [],
    errors = [];
  const poller = new TrackedFeedPoller({
    now: () => time,
    fetcher: (url, options) => {
      calls.push({ url, ...options });
      return fetcher?.(url, options) ?? Promise.resolve(Response.json({ pools: [] }));
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: () => errors.push("unavailable"),
  });
  t.after(() => poller.setActive(false));
  const advance = async (ms) => {
    time += ms;
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  return { poller, calls, snapshots, errors, advance };
}

test("retry policy backs off, caps delays, and parses both Retry-After formats", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 100].map((n) => feedRetryMs(n)),
    [4000, 8000, 16000, 32000, 60000, 60000],
  );
  assert.equal(feedRetryMs(1, 120_000), 120_000);
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("999999"), 300_000);
  const epoch = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:01:00 GMT", epoch), 60_000);
  for (const value of [null, "", "garbage", "-5"]) assert.equal(retryAfterMs(value), 0);
  assert.equal(retryAfterMs("Wed, 31 Dec 2025 23:59:00 GMT", epoch), 0);
});

test("inactive poller makes no requests; redundant activity events cannot accelerate polling", async (t) => {
  const { poller, calls, advance } = harness(t);
  await advance(30_000);
  assert.equal(calls.length, 0);
  poller.setActive(true);
  await advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/tracked-feed");
  assert.equal(calls[0].cache, "no-store");
  for (let i = 0; i < 100; i++) poller.setActive(true);
  await advance(3999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
  poller.setActive(false);
  await advance(60_000);
  assert.equal(calls.length, 2);
});

test("slow requests never overlap and the next interval starts after completion", async (t) => {
  const source = Promise.withResolvers();
  const { poller, calls, snapshots, advance } = harness(t, () => source.promise);
  poller.setActive(true);
  await advance(7000);
  assert.equal(calls.length, 1);
  assert.equal(snapshots.length, 0);
  source.resolve(Response.json({ pools: [] }));
  await advance(0);
  assert.equal(snapshots.length, 1);
  await advance(3999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
});

test("pausing preserves the next deadline and resumes once without a request burst", async (t) => {
  const { poller, calls, advance } = harness(t);
  poller.setActive(true);
  await advance(0);
  for (let i = 0; i < 50; i++) {
    poller.setActive(false);
    poller.setActive(true);
  }
  await advance(3999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
  poller.setActive(false);
  await advance(60_000);
  assert.equal(calls.length, 2);
  poller.setActive(true);
  await advance(0);
  assert.equal(calls.length, 3);
});

test("pause aborts the viewer request and ignores a late response without reporting a failure", async (t) => {
  const source = Promise.withResolvers();
  const { poller, calls, snapshots, errors, advance } = harness(t, () => source.promise);
  poller.setActive(true);
  poller.setActive(false);
  assert.equal(calls[0].signal.aborted, true);
  source.resolve(Response.json({ pools: [] }));
  await advance(30_000);
  assert.equal(snapshots.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(calls.length, 1);
});

test("failures back off while retaining data; visibility changes preserve Retry-After", async (t) => {
  let status = 200,
    retryAfter = "";
  const { poller, calls, snapshots, errors, advance } = harness(t, async () =>
    status === 200
      ? Response.json({ pools: [] })
      : new Response(null, { status, headers: { "Retry-After": retryAfter } }),
  );
  poller.setActive(true);
  await advance(0);
  status = 503;
  await advance(4000);
  assert.equal(snapshots.length, 1);
  assert.equal(errors.length, 1);
  await advance(4000);
  assert.equal(errors.length, 2);
  await advance(7999);
  assert.equal(calls.length, 3);
  retryAfter = "120";
  await advance(1);
  assert.equal(errors.length, 3);
  poller.setActive(false);
  await advance(60_000);
  poller.setActive(true);
  await advance(59_999);
  assert.equal(calls.length, 4);
  status = 200;
  await advance(1);
  assert.equal(snapshots.length, 2);
  await advance(3999);
  assert.equal(calls.length, 5);
  await advance(1);
  assert.equal(calls.length, 6, "success restores normal polling");
});

test("stalled viewer requests time out and wait before retrying", async (t) => {
  const { poller, calls, errors, advance } = harness(
    t,
    (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        }),
      ),
  );
  poller.setActive(true);
  await advance(9999);
  assert.equal(errors.length, 0);
  await advance(1);
  assert.equal(errors.length, 1);
  assert.equal(calls[0].signal.aborted, true);
  await advance(3999);
  assert.equal(calls.length, 1);
  await advance(1);
  assert.equal(calls.length, 2);
});
