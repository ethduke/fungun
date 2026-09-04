export const FEED_INTERVAL_MS = 4000;
const MAX_RETRY_AFTER_MS = 300_000;

export function retryAfterMs(value, epoch = Date.now()) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - epoch;
  return Number.isFinite(delay)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, delay))
    : 0;
}

export function feedRetryMs(failures, retryAfter = 0) {
  return Math.max(
    Math.min(
      60_000,
      FEED_INTERVAL_MS * 2 ** Math.min(4, Math.max(0, failures - 1)),
    ),
    retryAfter,
  );
}
