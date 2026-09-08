import {
  createWalletClient,
  custom,
  decodeEventLog,
  toHex,
  type EIP1193Provider,
  type Hash,
} from 'viem';
import { base, robinhood } from 'viem/chains';
import {
  stonksClaimAbi,
  claimAbi,
  ponsClaimAbi,
  legacyClaimAbi,
  isLockedPoolClaim,
  validateClaim,
  type ClaimQuote,
  type FeePayout,
} from './fee-service.ts';
import { AppError } from './user-error.ts';

function hasWalletError(error: unknown, code: number, name?: string) {
  const seen = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth < 8 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const entry = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (entry.code === code || (name && entry.name === name)) return true;
    current = entry.cause;
  }
  return false;
}

function wasRejected(error: unknown) {
  return hasWalletError(error, 4001, 'UserRejectedRequestError');
}

export async function ensureClaimChain(
  provider: EIP1193Provider,
  address: string,
  chainId: number,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const chain =
    chainId === robinhood.id ? robinhood : chainId === base.id ? base : null;
  if (!chain) throw new AppError('invalid_request');
  const assertCurrent = () => {
    if (!isCurrent()) throw new AppError('cancelled');
  };
  const request = async <T>(send: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await send();
    assertCurrent();
    return value;
  };
  const checkAccount = async () => {
    const accounts = await request(() =>
      provider.request({ method: 'eth_accounts' }),
    );
    if (accounts[0]?.toLowerCase() !== address.toLowerCase())
      throw new AppError('wrong_account');
  };
  const readChain = async () =>
    BigInt(await request(() => provider.request({ method: 'eth_chainId' })));
  const switchChain = () =>
    request(() =>
      provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: toHex(chain.id) }],
      }),
    );
  await checkAccount();
  if ((await readChain()) === BigInt(chain.id)) return;
  try {
    await switchChain();
  } catch (error) {
    assertCurrent();
    if (wasRejected(error) || !hasWalletError(error, 4902)) throw error;
    await checkAccount();
    await request(() =>
      provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: toHex(chain.id),
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: [...chain.rpcUrls.default.http],
            blockExplorerUrls: [chain.blockExplorers.default.url],
          },
        ],
      }),
    );
    await checkAccount();
    if ((await readChain()) !== BigInt(chain.id)) await switchChain();
  }
  await checkAccount();
  if ((await readChain()) !== BigInt(chain.id))
    throw new AppError('wrong_chain');
}

export type ClaimActivity = {
  quote: ClaimQuote;
  status:
    | 'wallet'
    | 'submitted'
    | 'uncertain'
    | 'confirmed'
    | 'failed'
    | 'no_payout'
    | 'reviewed';
  hash?: Hash;
  payouts?: FeePayout[];
  retryAfter?: number;
};
const activities = new Map<string, ClaimActivity>();
const listeners = new Set<() => void>();
let snapshot: ClaimActivity[] = [];
function publish() {
  snapshot = [...activities.values()];
  for (const listener of listeners) listener();
}
export const subscribeClaims = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getClaims = () => snapshot;
export const emptyClaims: ClaimActivity[] = [];
export function acknowledgeClaim(positionId: string) {
  const activity = activities.get(positionId);
  if (!activity || !['uncertain', 'no_payout'].includes(activity.status))
    return;
  activity.status = 'reviewed';
  activity.retryAfter = performance.now() + 30_000;
  publish();
}

async function identity(provider: EIP1193Provider, quote: ClaimQuote) {
  const accounts = await provider.request({ method: 'eth_accounts' });
  const chain = await provider.request({ method: 'eth_chainId' });
  if (accounts[0]?.toLowerCase() !== quote.address.toLowerCase())
    throw new AppError('wrong_account');
  if (BigInt(chain) !== BigInt(quote.chainId))
    throw new AppError('wrong_chain');
}

export async function sendWalletClaim(
  provider: EIP1193Provider,
  input: ClaimQuote,
) {
  const quote = validateClaim(input);
  if (
    [...activities.values()].some((entry) =>
      ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(entry.status),
    )
  )
    throw new AppError('pending');
  if (!activities.has(quote.positionId) && activities.size >= 32) {
    const settled = [...activities.entries()].find(
      ([, entry]) =>
        ['confirmed', 'failed', 'reviewed'].includes(entry.status) &&
        performance.now() >= (entry.retryAfter ?? 0),
    );
    if (!settled) throw new AppError('pending');
    activities.delete(settled[0]);
  }
  const previous = activities.get(quote.positionId);
  if (
    previous &&
    (!['failed', 'confirmed', 'reviewed'].includes(previous.status) ||
      performance.now() < (previous.retryAfter ?? 0))
  )
    throw new AppError('pending');
  const activity: ClaimActivity = { quote, status: 'wallet' };
  activities.set(quote.positionId, activity);
  publish();
  let dispatched = false;
  try {
    await identity(provider, quote);
    if (performance.now() >= quote.expiresAt)
      throw new AppError('quote_expired');
    const client = createWalletClient({
      chain: quote.chainId === 4663 ? robinhood : base,
      transport: custom(provider, { retryCount: 0 }),
    });
    dispatched = true;
    const hash = await client.request(
      {
        method: 'eth_sendTransaction',
        params: [
          {
            from: quote.address as `0x${string}`,
            to: quote.target as `0x${string}`,
            chainId: toHex(quote.chainId),
            data: quote.data,
            value: '0x0',
            gas: toHex(BigInt(quote.gas)),
            gasPrice: toHex(BigInt(quote.gasPrice)),
            type: '0x0',
          },
        ],
      },
      { retryCount: 0 },
    );
    if (!/^0x[\da-f]{64}$/i.test(hash)) throw new AppError('invalid_response');
    activity.hash = hash;
    activity.status = 'submitted';
    publish();
    return activity.hash;
  } catch (error) {
    const rejected = wasRejected(error);
    if (!dispatched || rejected) {
      if (previous) activities.set(quote.positionId, previous);
      else activities.delete(quote.positionId);
    } else activity.status = 'uncertain';
    publish();
    throw error;
  }
}

export function receiptPayouts(
  receipt: {
    status: string;
    from: string;
    to: string | null;
    logs: readonly {
      address: string;
      data: `0x${string}`;
      topics: readonly `0x${string}`[];
    }[];
  },
  quote: ClaimQuote,
) {
  if (
    receipt.status !== '0x1' ||
    receipt.from.toLowerCase() !== quote.address.toLowerCase() ||
    receipt.to?.toLowerCase() !== quote.target.toLowerCase()
  )
    return null;
  const amounts = quote.payouts.map(() => 0n);
  let ponsTransferred = 0n;
  for (const log of receipt.logs) {
    if (quote.kind === 'pons') {
      try {
        const event = decodeEventLog({ abi: ponsClaimAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
        if (event.eventName === 'Transfer') {
          if (log.address.toLowerCase() === quote.payouts[0].asset.toLowerCase() &&
            event.args.from.toLowerCase() === quote.target.toLowerCase() && event.args.to.toLowerCase() === quote.address.toLowerCase())
            ponsTransferred += event.args.value;
          continue;
        }
        if (log.address.toLowerCase() !== quote.target.toLowerCase() || event.args.recipient.toLowerCase() !== quote.address.toLowerCase()) continue;
        const native = /^0x0{40}$/i.test(quote.payouts[0].asset);
        if ((native && event.eventName === 'Claimed') ||
          (!native && event.eventName === 'ClaimedToken' && event.args.token.toLowerCase() === quote.payouts[0].asset.toLowerCase()))
          amounts[0] += event.args.amount;
      } catch { /* Unrelated or malformed events are not payout evidence. */ }
      continue;
    }
    if (quote.kind === 'stonks') {
      try {
        const event = decodeEventLog({ abi: stonksClaimAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
        const index = quote.payouts.findIndex(p => p.asset.toLowerCase() === log.address.toLowerCase());
        if (event.eventName === 'Transfer' && index >= 0 && event.args.from.toLowerCase() === quote.target.toLowerCase() && event.args.to.toLowerCase() === quote.address.toLowerCase())
          amounts[index] += event.args.value;
      } catch { /* Only actual matching ERC-20 payouts count as received. */ }
      continue;
    }
    if (log.address.toLowerCase() !== quote.target.toLowerCase()) continue;
    let event;
    try {
      event = decodeEventLog({
        abi: quote.escrowVersion === 'legacy' ? legacyClaimAbi : claimAbi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
    } catch {
      continue;
    }
    if (
      quote.kind === 'o1' &&
      event.eventName === 'Claimed' &&
      event.args.recipient.toLowerCase() === quote.address.toLowerCase() &&
      (quote.escrowVersion === 'legacy' ||
        ('destination' in event.args &&
          event.args.destination.toLowerCase() ===
            quote.address.toLowerCase())) &&
      event.args.currency.toLowerCase() === quote.payouts[0].asset.toLowerCase()
    )
      amounts[0] += event.args.amount;
    if (
      isLockedPoolClaim(quote.kind) &&
      event.eventName === 'Release' &&
      event.args.poolId === quote.poolId &&
      event.args.beneficiary.toLowerCase() === quote.address.toLowerCase()
    ) {
      amounts[0] += event.args.fees0;
      amounts[1] += event.args.fees1;
    }
  }
  if (quote.kind === 'pons') {
    if (amounts[0] !== BigInt(quote.payouts[0].claimableRaw)) return null;
    if (!/^0x0{40}$/i.test(quote.payouts[0].asset)) {
      if (ponsTransferred <= 0n || ponsTransferred > amounts[0]) return null;
      amounts[0] = ponsTransferred;
    }
  }
  return amounts.some((value) => value > 0n)
    ? quote.payouts.map((payout, index) => ({
        ...payout,
        claimableRaw: amounts[index].toString(),
      }))
    : null;
}

let checking: symbol | undefined;
let nextCheck = 0;
const receiptReadTimeout = 15_000;
export type CheckWalletClaimOptions = { signal?: AbortSignal };
export async function checkWalletClaim(
  provider: EIP1193Provider,
  positionId: string,
  options: CheckWalletClaimOptions = {},
) {
  const activity = activities.get(positionId);
  if (!activity?.hash || checking || performance.now() < nextCheck)
    throw new AppError('pending');
  if (options.signal?.aborted) throw new AppError('cancelled');
  const token = Symbol('claim-receipt-check');
  checking = token;
  nextCheck = performance.now() + 10_000;
  let current = true;
  let rejectCancellation!: (error: AppError) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (code: 'cancelled' | 'timeout') => {
    if (!current) return;
    current = false;
    if (checking === token) checking = undefined;
    rejectCancellation(new AppError(code));
  };
  const onAbort = () => cancel('cancelled');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => cancel('timeout'), receiptReadTimeout);
  const assertCurrent = () => {
    if (!current || options.signal?.aborted) throw new AppError('cancelled');
  };
  const request = async <T>(read: () => Promise<T>): Promise<T> => {
    assertCurrent();
    const value = await Promise.race([read(), cancellation]);
    assertCurrent();
    return value;
  };
  try {
    const accounts = await request(() =>
      provider.request({ method: 'eth_accounts' }),
    );
    if (accounts[0]?.toLowerCase() !== activity.quote.address.toLowerCase())
      throw new AppError('wrong_account');
    const chain = await request(() =>
      provider.request({ method: 'eth_chainId' }),
    );
    if (BigInt(chain) !== BigInt(activity.quote.chainId))
      throw new AppError('wrong_chain');
    const receipt = await request(() =>
      provider.request({
        method: 'eth_getTransactionReceipt',
        params: [activity.hash!],
      }),
    );
    if (!receipt) return;
    if (receipt.transactionHash.toLowerCase() !== activity.hash.toLowerCase())
      throw new AppError('invalid_response');
    if (
      !['0x0', '0x1'].includes(receipt.status) ||
      receipt.from?.toLowerCase() !== activity.quote.address.toLowerCase() ||
      receipt.to?.toLowerCase() !== activity.quote.target.toLowerCase()
    )
      throw new AppError('invalid_response');
    assertCurrent();
    activity.payouts = receiptPayouts(receipt, activity.quote) ?? undefined;
    activity.status =
      receipt.status === '0x0'
        ? 'failed'
        : activity.payouts
          ? 'confirmed'
          : 'no_payout';
    publish();
  } finally {
    current = false;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    if (checking === token) checking = undefined;
  }
}

export type ClaimReceiptWatchOptions = {
  isCurrent?: () => boolean;
  onError?: (error: unknown) => void;
};
type ReceiptSubscriber = ClaimReceiptWatchOptions & {
  provider: EIP1193Provider;
  reportedError: boolean;
};
type ReceiptWatch = {
  activity: ClaimActivity;
  subscribers: Set<ReceiptSubscriber>;
  stop: () => void;
};
const receiptWatches = new Map<string, ReceiptWatch>();
const receiptDelays = [10_000, 20_000, 30_000, 60_000];
const subscriberIsCurrent = (subscriber: ReceiptSubscriber) => {
  try {
    return subscriber.isCurrent?.() !== false;
  } catch {
    return false;
  }
};
const stopsReceiptWatch = (error: unknown) =>
  wasRejected(error) ||
  [4100, 4200, 4900, 4901, 4902].some((code) => hasWalletError(error, code)) ||
  (error instanceof AppError &&
    ['wrong_account', 'wrong_chain', 'disconnected', 'unsupported'].includes(
      error.code,
    ));

export function watchWalletClaim(
  provider: EIP1193Provider,
  positionId: string,
  options: ClaimReceiptWatchOptions = {},
): () => void {
  const activity = activities.get(positionId);
  const subscriber: ReceiptSubscriber = {
    ...options,
    provider,
    reportedError: false,
  };
  if (
    activity?.status !== 'submitted' ||
    !activity.hash ||
    !subscriberIsCurrent(subscriber)
  )
    return () => {};
  const key = `${activity.quote.chainId}:${activity.quote.address.toLowerCase()}:${positionId}:${activity.hash.toLowerCase()}`;
  let watch = receiptWatches.get(key);
  if (watch && watch.activity !== activity) {
    watch.stop();
    watch = undefined;
  }
  if (!watch) {
    const subscribers = new Set<ReceiptSubscriber>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delayIndex = 0;
    const abort = new AbortController();
    let unsubscribe = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      abort.abort();
      unsubscribe();
      subscribers.clear();
      receiptWatches.delete(key);
    };
    const active = () => {
      if (stopped) return false;
      if (
        activities.get(positionId) !== activity ||
        activity.status !== 'submitted'
      ) {
        stop();
        return false;
      }
      for (const entry of subscribers)
        if (!subscriberIsCurrent(entry)) subscribers.delete(entry);
      if (!subscribers.size) stop();
      return !stopped;
    };
    const guardedProvider = {
      request: async (args: Parameters<EIP1193Provider['request']>[0]) => {
        if (!active()) throw new AppError('cancelled');
        const entry = subscribers.values().next().value!;
        const result = await entry.provider.request(args);
        if (!active() || !subscribers.has(entry))
          throw new AppError('cancelled');
        return result;
      },
    } as unknown as EIP1193Provider;
    const schedule = () => {
      if (!active()) return;
      timer = setTimeout(() => void poll(), receiptDelays[delayIndex]);
    };
    const poll = async () => {
      if (!active()) return;
      try {
        await checkWalletClaim(guardedProvider, positionId, {
          signal: abort.signal,
        });
        for (const entry of subscribers) entry.reportedError = false;
      } catch (error) {
        if (!active()) return;
        if (
          !(
            error instanceof AppError &&
            ['pending', 'cancelled'].includes(error.code)
          )
        ) {
          for (const entry of subscribers) {
            if (entry.reportedError) continue;
            entry.reportedError = true;
            try {
              entry.onError?.(error);
            } catch {
              /* Keep the receipt watcher independent of UI callbacks. */
            }
          }
          if (stopsReceiptWatch(error)) {
            stop();
            return;
          }
        }
      }
      delayIndex = Math.min(delayIndex + 1, receiptDelays.length - 1);
      schedule();
    };
    watch = { activity, subscribers, stop };
    receiptWatches.set(key, watch);
    subscribers.add(subscriber);
    unsubscribe = subscribeClaims(() => {
      active();
    });
    schedule();
  } else {
    watch.subscribers.add(subscriber);
  }
  const currentWatch = watch;
  return () => {
    currentWatch.subscribers.delete(subscriber);
    if (!currentWatch.subscribers.size) currentWatch.stop();
  };
}
