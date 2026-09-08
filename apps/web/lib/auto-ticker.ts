import { checkTicker, type TickerCheck } from './read-service.ts';
import { AppError } from './user-error.ts';
import type { ChainId, PadId } from './launch-model.ts';

export function canCheckTicker(
  chainId: ChainId,
  ticker: string,
  pads: PadId[],
) {
  return (
    chainId === 4663 &&
    pads.includes('long') &&
    /^[A-Z]{1,11}$/.test(ticker)
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
    !pads.includes('long')
  )
    return 'unknown';
  if (check.results.long?.status === 'reserved')
    return 'reserved';
  return check.results.long?.status === 'unreserved'
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
      const result = await request(chainId, ticker, ['long']);
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
