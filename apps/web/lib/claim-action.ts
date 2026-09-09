import type { ClaimQuote, FeePosition, FeeSource } from './fee-service.ts';
import { queueClaimAttempt, type ClaimQueue } from './claim-queue.ts';
import { HIGH_NETWORK_FEE_WEI } from './launch-cost.ts';

// One user action prepares and opens exactly one wallet transaction. Queue
// advancement and receipt monitoring never call this function automatically.
export async function runClaimAction({
  queue, quote, address, isCurrent, ensureChain, prepare, onPrepared,
  onAttempt, send,
}: {
  queue: ClaimQueue;
  quote: ClaimQuote | null;
  address: string;
  isCurrent: () => boolean;
  ensureChain: (address: string, chainId: number, isCurrent: () => boolean) => Promise<void>;
  prepare: (address: string, source: FeeSource, position: FeePosition) => Promise<ClaimQuote>;
  onPrepared: (quote: ClaimQuote) => void;
  onAttempt: (queue: ClaimQueue) => void;
  send: (quote: ClaimQuote) => Promise<string>;
}) {
  const item = queue.items[queue.index];
  if (!item || queue.status !== 'ready' || !isCurrent()) return;
  await ensureChain(address, item.source.chainId, isCurrent);
  if (!isCurrent()) return;
  // Network approval can outlive the estimate; refresh within this same click.
  const prepared = !quote || performance.now() >= quote.expiresAt
    ? await prepare(address, item.source, item.position) : quote;
  if (!isCurrent()) return;
  const attempt = queueClaimAttempt(queue, prepared);
  onPrepared(prepared);
  if (BigInt(prepared.estimatedWei) >= HIGH_NETWORK_FEE_WEI && prepared !== quote)
    return;
  if (!isCurrent()) return;
  onAttempt(attempt);
  await send(prepared);
}
