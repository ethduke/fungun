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
  claimAbi,
  legacyClaimAbi,
  validateClaim,
  type ClaimQuote,
  type FeePayout,
} from './fee-service.ts';
import { AppError } from './user-error.ts';

function wasRejected(error: unknown) {
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
    if (entry.code === 4001 || entry.name === 'UserRejectedRequestError')
      return true;
    current = entry.cause;
  }
  return false;
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
  for (const log of receipt.logs) {
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
          event.args.destination.toLowerCase() === quote.address.toLowerCase())) &&
      event.args.currency.toLowerCase() === quote.payouts[0].asset.toLowerCase()
    )
      amounts[0] += event.args.amount;
    if (
      quote.kind === 'long' &&
      event.eventName === 'Release' &&
      event.args.poolId === quote.poolId &&
      event.args.beneficiary.toLowerCase() === quote.address.toLowerCase()
    ) {
      amounts[0] += event.args.fees0;
      amounts[1] += event.args.fees1;
    }
  }
  return amounts.some((value) => value > 0n)
    ? quote.payouts.map((payout, index) => ({
        ...payout,
        claimableRaw: amounts[index].toString(),
      }))
    : null;
}

let checking = false;
let nextCheck = 0;
export async function checkWalletClaim(
  provider: EIP1193Provider,
  positionId: string,
) {
  const activity = activities.get(positionId);
  if (!activity?.hash || checking || performance.now() < nextCheck)
    throw new AppError('pending');
  checking = true;
  nextCheck = performance.now() + 10_000;
  try {
    await identity(provider, activity.quote);
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [activity.hash],
    });
    if (!receipt) return;
    if (receipt.transactionHash.toLowerCase() !== activity.hash.toLowerCase())
      throw new AppError('invalid_response');
    if (
      !['0x0', '0x1'].includes(receipt.status) ||
      receipt.from?.toLowerCase() !== activity.quote.address.toLowerCase() ||
      receipt.to?.toLowerCase() !== activity.quote.target.toLowerCase()
    )
      throw new AppError('invalid_response');
    activity.payouts = receiptPayouts(receipt, activity.quote) ?? undefined;
    activity.status =
      receipt.status === '0x0'
        ? 'failed'
        : activity.payouts
          ? 'confirmed'
          : 'no_payout';
    publish();
  } finally {
    checking = false;
  }
}
