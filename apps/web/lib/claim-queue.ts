import type { ClaimActivity } from './claim-wallet.ts';
import type { ClaimQuote, FeePosition, FeeSource } from './fee-service.ts';

export type ClaimQueueItem = { source: FeeSource; position: FeePosition };
export type ClaimQueue = {
  items: ClaimQueueItem[];
  index: number;
  status: 'ready' | 'awaiting' | 'paused' | 'complete';
  attempt?: ClaimQuote;
  attempts?: ClaimQuote[];
};

export function claimQueueActivities(
  queue: ClaimQueue,
  activities: ClaimActivity[],
) {
  const attempts = [
    ...(queue.attempts ?? []),
    ...(queue.attempt ? [queue.attempt] : []),
  ];
  return activities.filter((activity) => attempts.includes(activity.quote));
}

// One Long position can pay two currencies. It still needs only one transaction.
export function claimQueueItems(sources: FeeSource[]): ClaimQueueItem[] {
  const seen = new Set<string>();
  return sources.flatMap((source) =>
    source.status === 'unavailable'
      ? []
      : source.positions.flatMap((position) => {
          const key = `${source.chainId}:${source.padId}:${position.id}`;
          if (
            seen.has(key) ||
            !position.claimable ||
            position.verification !== 'live' ||
            !position.payouts.some((payout) => BigInt(payout.claimableRaw) > 0n)
          )
            return [];
          seen.add(key);
          return [{ source, position }];
        }),
  );
}

export function startClaimQueue(
  sources: FeeSource[],
  padId?: FeeSource['padId'],
): ClaimQueue {
  const items = claimQueueItems(
    padId ? sources.filter((source) => source.padId === padId) : sources,
  );
  return { items, index: 0, status: items.length ? 'ready' : 'complete' };
}

export function queueClaimAttempt(
  queue: ClaimQueue,
  quote: ClaimQuote,
): ClaimQueue {
  const item = queue.items[queue.index];
  if (
    queue.status !== 'ready' ||
    !item ||
    quote.positionId !== item.position.id ||
    quote.chainId !== item.source.chainId ||
    quote.kind !== item.source.padId ||
    quote.address.toLowerCase() !== item.source.address.toLowerCase()
  )
    throw new Error('The claim does not match the current queue item.');
  return {
    ...queue,
    status: 'awaiting',
    attempt: quote,
    attempts: [...(queue.attempts ?? []), quote],
  };
}

// Reconciliation never sends a transaction. The next item can be prepared by
// the page after receipt verification and still needs its own wallet confirmation.
export function reconcileClaimQueue(
  queue: ClaimQueue,
  activities: ClaimActivity[],
): ClaimQueue {
  if (queue.status !== 'awaiting' || !queue.attempt) return queue;
  const attempt = queue.attempt;
  const activity = activities.find(
    (entry) =>
      entry.quote.positionId === attempt.positionId &&
      entry.quote.chainId === attempt.chainId &&
      entry.quote.address.toLowerCase() === attempt.address.toLowerCase() &&
      entry.quote.expiresAt === attempt.expiresAt,
  );
  if (!activity || ['wallet', 'submitted'].includes(activity.status))
    return queue;
  if (activity.status !== 'confirmed') return { ...queue, status: 'paused' };
  const index = queue.index + 1;
  return {
    ...queue,
    index,
    attempt: undefined,
    attempts: queue.attempts ?? [attempt],
    status: index === queue.items.length ? 'complete' : 'ready',
  };
}
