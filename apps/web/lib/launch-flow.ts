import { AssetError } from './asset-protocol.ts';
import { LaunchError, LaunchPreflightError } from './long-wallet.ts';
import { isOutdatedPage } from './page-version.ts';

const transientRead = (e: unknown) => {
  if (isOutdatedPage(e)) return false;
  if (e instanceof Error && ['TypeError', 'TimeoutError', 'AbortError'].includes(e.name)) return true;
  return e instanceof LaunchError
    ? [
        'rate_limited',
        'busy',
        'timeout',
        'read_service_unavailable',
        'upstream_unavailable',
      ].includes(e.message)
    : e instanceof AssetError &&
      ['rate_limited', 'asset_busy', 'asset_publication_uncertain'].includes(
        e.code,
      );
};

/** One user action through publication, fresh quote and wallet dispatch.
 * Retry only preparation or errors proven to precede eth_sendTransaction. */
export async function runLaunchFlow<A, Q>({
  availability,
  artwork,
  quote,
  wallet,
  isCurrent,
  onProgress,
  pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = () => performance.now(),
}: {
  availability?: () => Promise<unknown>;
  artwork: () => Promise<A>;
  quote: (artwork: A) => Promise<Q>;
  wallet: (quote: Q) => Promise<void>;
  isCurrent: () => boolean;
  onProgress: (message: string) => void;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}) {
  const deadline = now() + 180000;
  const guard = () => {
    if (!isCurrent()) throw new LaunchError('launch_context_locked');
  };
  async function wait(error: unknown) {
    const original =
      error instanceof LaunchPreflightError ? error.cause : error;
    const seconds =
      original instanceof LaunchError || original instanceof AssetError
        ? original.retryAfter
        : 0;
    const delay = Math.max(1000, seconds * 1000 || 3000);
    if (now() + delay > deadline) throw original;
    let lastSecond = -1;
    for (let remaining = delay; remaining > 0; remaining -= 250) {
      guard();
      const second = Math.ceil(remaining / 1000);
      if (second !== lastSecond) {
        onProgress(original instanceof LaunchError && original.message === 'long_address_pending'
          ? `Preparing token address… Continuing in ${second}s…`
          : `Retrying launch preparation in ${second}s…`);
        lastSecond = second;
      }
      await pause(Math.min(remaining, 250));
    }
    guard();
  }
  async function read<T>(operation: () => Promise<T>): Promise<T> {
    for (let failures = 0; ;) {
      guard();
      if (now() >= deadline) throw new LaunchError('timeout');
      try {
        const result = await operation();
        guard();
        return result;
      } catch (e) {
        // Address checkpoints are progress, not failed network attempts. They
        // still share the overall deadline and can never retry wallet dispatch.
        if (!(e instanceof LaunchError && e.message === 'long_address_pending')) {
          if (!transientRead(e) || failures++ >= 5) throw e;
        }
        await wait(e);
        if (e instanceof LaunchError && e.message === 'long_address_pending')
          onProgress('Preparing token address…');
      }
    }
  }
  if (availability) {
    onProgress('Checking launch availability…');
    await read(availability);
  }
  const published = await read(artwork);
  for (let attempt = 0; ; attempt++) {
    onProgress('Preparing launch and estimating fees…');
    const prepared = await read(() => quote(published));
    guard();
    try {
      await wallet(prepared);
      return;
    } catch (e) {
      if (
        !(e instanceof LaunchPreflightError) ||
        attempt >= 2 ||
        !(
          transientRead(e.cause) ||
          (e.cause instanceof LaunchError &&
            e.cause.message === 'quote_expired')
        )
      )
        throw e;
      await wait(e);
    }
  }
}
