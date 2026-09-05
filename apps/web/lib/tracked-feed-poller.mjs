import {
  FEED_INTERVAL_MS,
  feedRetryMs,
  retryAfterMs,
} from './tracked-feed-policy.mjs';

// A single viewer's demand-driven polling. Pausing preserves its retry deadline.
export class TrackedFeedPoller {
  constructor({
    getUrl = () => '/api/tracked-feed',
    onSnapshot,
    onError,
    intervalMs = FEED_INTERVAL_MS,
    validateSnapshot = (snapshot) => Array.isArray(snapshot?.pools),
    fetcher = (url, options) => fetch(url, options),
    now = () => performance.now(),
  }) {
    Object.assign(this, {
      getUrl,
      onSnapshot,
      onError,
      fetcher,
      now,
      intervalMs,
      validateSnapshot,
    });
    this.active = false;
    this.generation = 0;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.controller = null;
    this.timer = null;
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    if (active) this.schedule(this.generation);
  }

  schedule(generation) {
    const delay = Math.max(0, this.nextAttemptAt - this.now());
    if (!delay) void this.refresh(generation);
    else
      this.timer = setTimeout(() => {
        void this.refresh(generation);
      }, delay);
  }

  async refresh(generation) {
    if (!this.active || generation !== this.generation || this.controller)
      return;
    const controller = new AbortController();
    this.controller = controller;
    // Even an aborted request cannot be restarted rapidly by visibility changes.
    this.nextAttemptAt = this.now() + this.intervalMs;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let delay = this.intervalMs;
    let retryAfter = 0;
    try {
      const response = await this.fetcher(this.getUrl(), {
        cache: 'no-store',
        signal: controller.signal,
      });
      retryAfter = retryAfterMs(response.headers.get('retry-after'));
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Feed unavailable');
      }
      const snapshot = await response.json();
      if (!this.validateSnapshot(snapshot))
        throw new Error('Invalid feed response');
      if (!this.active || generation !== this.generation) return;
      this.failures = 0;
      this.onSnapshot(snapshot);
    } catch {
      if (!this.active || generation !== this.generation) return;
      this.failures = Math.min(this.failures + 1, 5);
      delay = Math.max(this.intervalMs, feedRetryMs(this.failures, retryAfter));
      this.onError();
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
      if (this.active && generation === this.generation) {
        // Measure from completion so a slow request never causes a tight loop.
        this.nextAttemptAt = this.now() + delay;
        this.schedule(generation);
      }
    }
  }
}
