import { checkTicker, type TickerCheck } from './read-service.ts';
import { AppError } from './user-error.ts';
import type { ChainId, PadId } from './launch-model.ts';

export function canCheckTicker(
  chainId: ChainId,
  ticker: string,
  pads: PadId[],
) {
  return (
    [4663, 8453].includes(chainId) &&
    pads.length > 0 &&
    ticker.length > 0 &&
    Array.from(ticker).length <= 11 &&
    !/[\s\p{C}]/u.test(ticker) &&
    (!pads.includes('long') || /^[A-Z]{1,11}$/.test(ticker))
  );
}

export function tickerAvailability(
  check: TickerCheck | null,
  chainId: ChainId,
  ticker: string,
  pads: PadId[],
) {
  if (
    !check ||
    check.chainId !== chainId ||
    check.ticker !== ticker ||
    !pads.length
  )
    return 'unknown';
  if (pads.some((pad) => check.results[pad]?.status === 'reserved'))
    return 'reserved';
  return pads.every((pad) => check.results[pad]?.status === 'unreserved')
    ? 'unreserved'
    : 'unknown';
}

/** Check after a brief typing pause; Enter/focus can flush it. Disposed drafts never receive a result. */
export function watchTicker({
  chainId,
  ticker,
  pads,
  onPending,
  onResult,
  onError,
  request = checkTicker,
  schedule = setTimeout,
  cancel = clearTimeout,
}: {
  chainId: ChainId;
  ticker: string;
  pads: PadId[];
  onPending: () => void;
  onResult: (check: TickerCheck) => void;
  onError: (error: unknown) => void;
  request?: typeof checkTicker;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}) {
  let stopped = false,
    running = false,
    retryAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const valid = canCheckTicker(chainId, ticker, pads);
  async function flush() {
    if (!valid || stopped || running || performance.now() < retryAt) return;
    cancel(timer);
    running = true;
    onPending();
    try {
      const result = await request(chainId, ticker, pads);
      if (!stopped) onResult(result);
    } catch (error) {
      if (!stopped) {
        onError(error);
        const delay = Math.max(
          15000,
          error instanceof AppError ? (error.retrySeconds ?? 0) * 1000 : 0,
        );
        retryAt = performance.now() + delay;
        timer = schedule(() => {
          void flush();
        }, delay + 1);
      }
    } finally {
      running = false;
    }
  }
  if (valid) {
    onPending();
    timer = schedule(() => {
      void flush();
    }, 200);
  }
  return {
    flush,
    stop: () => {
      stopped = true;
      cancel(timer);
    },
  };
}
