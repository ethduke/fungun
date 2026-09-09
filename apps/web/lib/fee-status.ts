import type { FeePosition, FeeSource } from './fee-service.ts';
import { claimQueueItems } from './claim-queue.ts';

// Loading and failed requests are not fee outcomes. Only verified amounts can
// produce the two completed results shown in the fee list.
export function feeCheckResult(source?: FeeSource, checking = false, failed = false) {
  const claimable = source ? claimQueueItems([source]) : [];
  if (claimable.length) return 'claimable' as const;
  if (checking) return null;
  if (!source || failed || source.status === 'unavailable' || source.nextCursor)
    return null;
  if (source.positions.some((position) => position.verification !== 'live' ||
    position.payouts.some((payout) => BigInt(payout.claimableRaw) > 0n))) return null;
  // `partial` without a cursor describes the supported coverage (for example
  // the current Pons escrow), not an unfinished check of those balances.
  return 'empty' as const;
}

export function unavailableFeeMessage(source?: FeeSource) {
  switch (source?.reason) {
    case 'fees_disabled':
      return 'Fee checks are not enabled yet · balance unknown';
    case 'provider_not_configured':
      return 'Fee lookup is not set up yet · balance unknown';
    case 'contracts_not_configured':
      return 'Fee lookup for this launchpad is not set up yet · balance unknown';
    case 'not_configured':
      return 'Fee lookup setup is incomplete · balance unknown';
    default:
      return 'Fee service unavailable · balance unknown';
  }
}

export function disabledClaimMessage(position: FeePosition) {
  if (position.claimable) return null;
  switch (position.claimDisabledReason) {
    case 'claims_disabled':
      return 'Claims are not enabled yet.';
    case 'contract_unverified':
      return 'These fees are not available to claim here yet.';
    case 'gas_oracle_not_configured':
      return 'Gas costs cannot be estimated yet.';
    case 'nothing_to_claim':
      return 'No fees to claim.';
    default:
      if (position.verification === 'indexed')
        return 'These fees are not available to claim here yet.';
      if (!position.payouts.some((payout) => BigInt(payout.claimableRaw) > 0n))
        return 'No fees to claim.';
      return 'Claims are not available for this position yet.';
  }
}

export function disabledFeeSourceMessage(positions: FeePosition[]) {
  const positive = positions.filter((position) =>
    position.payouts.some((payout) => BigInt(payout.claimableRaw) > 0n),
  );
  // An empty currency must not hide the blocker for a displayed positive balance.
  return (
    (positive.length ? positive : positions)
      .map(disabledClaimMessage)
      .find(Boolean) ?? null
  );
}
