'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatUnits } from 'viem';
import { Wallet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { useConnectedAccount } from '@/lib/account-context';
import { chainName, launchpadName } from '@/lib/launch-model';
import {
  FEE_LOOKUP_DELAY,
  FEE_SOURCES,
  groupFeeBalances,
  normalizeFeeAddress,
} from '@/lib/fees-model';
import {
  loadFees,
  mergeFeePages,
  prepareClaim,
  type ClaimQuote,
  type FeeSource,
  type FeePosition,
  type FeePayout,
} from '@/lib/fee-service';
import {
  acknowledgeClaim,
  emptyClaims,
  getClaims,
  subscribeClaims,
  type ClaimActivity,
} from '@/lib/claim-wallet';
import {
  claimQueueItems,
  claimQueueActivities,
  queueClaimAttempt,
  reconcileClaimQueue,
  startClaimQueue,
  type ClaimQueue,
} from '@/lib/claim-queue';
import { formatEth, HIGH_NETWORK_FEE_WEI } from '@/lib/launch-cost';
import { describeError } from '@/lib/user-error';
import { disabledClaimMessage, unavailableFeeMessage } from '@/lib/fee-status';
import { formatGasUsd } from '@/lib/fee-usd';

type SourceResult = {
  key: string;
  source?: FeeSource;
  error?: string;
  pageError?: string;
  pages: number;
};
const label = launchpadName;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const payoutText = (payout: FeePayout) =>
  `${formatUnits(BigInt(payout.claimableRaw), payout.decimals)} ${payout.symbol}`;
const ethText = (value: string) => formatEth(BigInt(value));
const highGas = (value: string) => BigInt(value) >= HIGH_NETWORK_FEE_WEI;
const localNow = () => performance.now();

export default function Fees() {
  const account = useConnectedAccount();
  const address = normalizeFeeAddress(account.address ?? '');
  if (!address)
    return (
      <main className="workspace fees-workspace">
        <div className="fees-heading">
          <h1>
            FEES<span>.</span>
          </h1>
        </div>
        <Button
          render={<Empty />}
          nativeButton={false}
          variant="ghost"
          className="fees-panel fee-connect h-auto w-full cursor-pointer whitespace-normal"
          aria-haspopup="dialog"
          onClick={account.openWallet}
        >
          <EmptyHeader>
            <EmptyMedia>
              <Wallet size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Connect your wallet to show fees.</EmptyTitle>
          </EmptyHeader>
        </Button>
      </main>
    );
  return <ConnectedFees key={address} address={address} />;
}

function ConnectedFees({ address }: { address: string }) {
  const account = useConnectedAccount();
  const [results, setResults] = useState<{
    address: string;
    revision: number;
    entries: SourceResult[];
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [quote, setQuote] = useState<ClaimQuote | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [queue, setQueue] = useState<ClaimQueue | null>(null);
  const [loadingMore, setLoadingMore] = useState<string | null>(null);
  const [claimedIds, setClaimedIds] = useState<string[]>([]);
  const reviewSequence = useRef(0);
  const scanSequence = useRef({ value: 0 });
  const activities = useSyncExternalStore(
    subscribeClaims,
    getClaims,
    () => emptyClaims,
  );
  const entries =
    results?.address === address && results.revision === refresh
      ? results.entries
      : [];
  const loading = !!address && entries.length < FEE_SOURCES.length;
  const sources = entries.flatMap((entry) =>
    entry.source ? [entry.source] : [],
  );
  const claimSources = sources.map((source) => ({
    ...source,
    positions: source.positions.filter(
      (position) => !claimedIds.includes(position.id),
    ),
  }));
  const currentQueue = queue ? reconcileClaimQueue(queue, activities) : null;
  const queueItem = currentQueue?.items[currentQueue.index];
  const queueLabel = currentQueue?.items[0]
    ? label(currentQueue.items[0].source.padId)
    : 'Launchpad';
  const ownerConnected =
    !!address && account.address?.toLowerCase() === address;
  const currentActivities = activities.filter(
    (activity) => activity.quote.address.toLowerCase() === address,
  );
  const queueActivities = currentQueue
    ? claimQueueActivities(currentQueue, currentActivities)
    : [];
  const otherActivities = currentActivities.filter(
    (activity) => !queueActivities.includes(activity),
  );
  const locked =
    sending ||
    activities.some((activity) =>
      ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(
        activity.status,
      ),
    );
  const scope = `${address}:${account.address}:${refresh}`;
  const [observedScope, setObservedScope] = useState(scope);
  if (observedScope !== scope) {
    setObservedScope(scope);
    setQueue(null);
    setClaimedIds([]);
    setQuote(null);
    setReviewing(null);
    setClaimError(null);
  }

  useEffect(() => {
    const sequence = reviewSequence;
    sequence.current++;
    return () => {
      sequence.current++;
    };
  }, [address, account.address, refresh]);

  useEffect(() => {
    if (!address) return;
    const scanControl = scanSequence.current;
    scanControl.value++;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoadingMore(null);
      setResults({ address, revision: refresh, entries: [] });
      void (async () => {
        for (const source of FEE_SOURCES) {
          if (cancelled) return;
          const key = `${source.padId}:${source.chainId}`;
          let entry: SourceResult;
          try {
            entry = {
              key,
              source: await loadFees(address, source.chainId, source.padId),
              pages: 1,
            };
          } catch (error) {
            entry = { key, error: describeError(error, 'fees'), pages: 0 };
          }
          if (cancelled) return;
          setResults((previous) => ({
            address,
            revision: refresh,
            entries: [
              ...(previous?.address === address && previous.revision === refresh
                ? previous.entries
                : []),
              entry,
            ],
          }));
        }
      })();
    }, FEE_LOOKUP_DELAY);
    return () => {
      cancelled = true;
      scanControl.value++;
      clearTimeout(timer);
    };
  }, [address, refresh]);

  useEffect(() => {
    if (!quote?.gasUsd) return;
    const timer = setTimeout(
      () => {
        setQuote((current) =>
          current === quote ? { ...current, gasUsd: null } : current,
        );
      },
      Math.max(0, quote.gasUsd.expiresAt - localNow()) + 5,
    );
    return () => clearTimeout(timer);
  }, [quote]);

  async function continueScan(entry: SourceResult) {
    const source = entry.source;
    if (
      !source?.nextCursor ||
      !address ||
      loading ||
      loadingMore ||
      locked ||
      currentQueue
    )
      return;
    const scanControl = scanSequence.current;
    const sequence = ++scanControl.value;
    setLoadingMore(entry.key);
    try {
      const page = await loadFees(
        address,
        source.chainId,
        source.padId,
        source.nextCursor,
      );
      if (sequence !== scanControl.value) return;
      const updated = {
        ...entry,
        source: mergeFeePages(source, page),
        pages: entry.pages + 1,
        pageError: undefined,
      };
      setResults((previous) =>
        previous?.address === address && previous.revision === refresh
          ? {
              ...previous,
              entries: previous.entries.map((result) =>
                result.key === entry.key ? updated : result,
              ),
            }
          : previous,
      );
    } catch (error) {
      if (sequence !== scanControl.value) return;
      setResults((previous) =>
        previous?.address === address && previous.revision === refresh
          ? {
              ...previous,
              entries: previous.entries.map((result) =>
                result.key === entry.key
                  ? { ...result, pageError: describeError(error, 'fees') }
                  : result,
              ),
            }
          : previous,
      );
    } finally {
      if (sequence === scanControl.value) setLoadingMore(null);
    }
  }

  function stopScan() {
    scanSequence.current.value++;
    setLoadingMore(null);
  }

  function cancelQueue() {
    reviewSequence.current++;
    setQueue(null);
    setQuote(null);
    setReviewing(null);
    setClaimError(null);
  }

  async function review(source: FeeSource, position: FeePosition) {
    if (
      !address ||
      !ownerConnected ||
      !account.ensureClaimChain ||
      sending ||
      getClaims().some((activity) =>
        ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(
          activity.status,
        ),
      ) ||
      reviewing ||
      loadingMore
    )
      return;
    const sequence = ++reviewSequence.current;
    setReviewing(position.id);
    setQuote(null);
    setClaimError(null);
    try {
      await account.ensureClaimChain(
        address,
        source.chainId,
        () => sequence === reviewSequence.current,
      );
      if (sequence !== reviewSequence.current) return;
      const prepared = await prepareClaim(address, source, position);
      if (sequence === reviewSequence.current) {
        setQuote(prepared);
      }
    } catch (error) {
      if (sequence === reviewSequence.current)
        setClaimError(describeError(error, 'claim_review'));
    } finally {
      if (sequence === reviewSequence.current) setReviewing(null);
    }
  }

  async function claim() {
    if (
      !currentQueue ||
      !queueItem ||
      currentQueue.status !== 'ready' ||
      !account.sendClaim ||
      !account.ensureClaimChain ||
      !ownerConnected ||
      locked ||
      reviewing
    )
      return;
    setSending(true);
    setClaimError(null);
    const sequence = ++reviewSequence.current;
    let submittedQueue: ClaimQueue | null = null;
    try {
      await account.ensureClaimChain(
        address,
        queueItem.source.chainId,
        () => sequence === reviewSequence.current,
      );
      if (sequence !== reviewSequence.current) return;
      // A wallet network prompt may outlive the estimate. Refresh it within the
      // user's confirmation action, before opening the transaction in the wallet.
      const prepared =
        !quote || localNow() >= quote.expiresAt
          ? await prepareClaim(address, queueItem.source, queueItem.position)
          : quote;
      if (sequence !== reviewSequence.current) return;
      submittedQueue = queueClaimAttempt(currentQueue, prepared);
      setQueue(submittedQueue);
      await account.sendClaim(prepared);
      setQuote(null);
    } catch (error) {
      if (sequence !== reviewSequence.current) return;
      if (submittedQueue)
        setQueue((previous) =>
          previous && previous.attempt === submittedQueue?.attempt
            ? { ...previous, status: 'paused' }
            : previous,
        );
      setQuote(null);
      setClaimError(describeError(error, 'claim'));
    } finally {
      setSending(false);
    }
  }

  function renderActivity(activity: ClaimActivity) {
    return (
      <div
        aria-label="Claim status"
        className="mt-5 border-t border-current/15 pt-4"
      >
        <h3 className="font-semibold">
          {activity.status === 'wallet'
            ? 'Confirm in your wallet'
            : activity.status === 'submitted'
              ? 'Claim submitted'
              : activity.status === 'confirmed'
                ? 'Payout recorded'
                : activity.status === 'failed'
                  ? 'Claim reverted'
                  : activity.status === 'reviewed'
                    ? 'Wallet activity reviewed'
                    : 'Check wallet activity'}
        </h3>
        <p>
          {chainName(activity.quote.chainId)}
          {activity.hash && (
            <>
              {' '}
              · Transaction{' '}
              <a
                href={`${activity.quote.chainId === 4663 ? 'https://robinscan.io' : 'https://basescan.org'}/tx/${activity.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:opacity-70"
                title={activity.hash}
                aria-label={`View transaction ${activity.hash} on ${activity.quote.chainId === 4663 ? 'Robinscan' : 'Basescan'}`}
              >
                {short(activity.hash)}
              </a>
            </>
          )}
        </p>
        {activity.status === 'confirmed' ? (
          <p>
            {activity.payouts?.map(payoutText).join(' + ')}. Included on-chain;
            finality is not guaranteed yet.
          </p>
        ) : activity.status === 'failed' ? (
          <p>No payout was confirmed. Gas may still have been charged.</p>
        ) : activity.status === 'reviewed' ? (
          <p>
            No transaction was resent. Wait 30 seconds, then refresh fees for a
            new review. Never retry while a claim is pending in your wallet.
          </p>
        ) : activity.status === 'uncertain' ||
          activity.status === 'no_payout' ? (
          <p>
            Do not send again until you check your wallet.{' '}
            {activity.status === 'no_payout'
              ? 'The receipt did not prove a payout.'
              : 'The wallet response was inconclusive; the transaction may have been sent.'}{' '}
            A retry may charge gas again.
          </p>
        ) : (
          <p>Do not send again while this request is pending.</p>
        )}
        {['uncertain', 'no_payout'].includes(activity.status) && (
          <Button
            variant="outline"
            disabled={!ownerConnected}
            onClick={() => {
              acknowledgeClaim(activity.quote.positionId);
              setQuote(null);
            }}
          >
            I checked my wallet: no pending claim
          </Button>
        )}
        {activity.hash && activity.status === 'submitted' && (
          <Button
            variant="outline"
            disabled={checking || !account.checkClaim || !ownerConnected}
            onClick={async () => {
              setChecking(true);
              setClaimError(null);
              const sequence = reviewSequence.current;
              try {
                await account.ensureClaimChain?.(
                  address,
                  activity.quote.chainId,
                  () => sequence === reviewSequence.current,
                );
                if (sequence !== reviewSequence.current) return;
                await account.checkClaim?.(activity.quote.positionId);
                if (sequence !== reviewSequence.current) return;
                if (
                  getClaims().some(
                    (entry) =>
                      entry.quote === activity.quote &&
                      entry.status === 'confirmed',
                  )
                ) {
                  setClaimedIds((previous) => [
                    ...new Set([...previous, activity.quote.positionId]),
                  ]);
                  if (currentQueue) {
                    const nextQueue = reconcileClaimQueue(
                      currentQueue,
                      getClaims(),
                    );
                    setQueue(nextQueue);
                    const next = nextQueue.items[nextQueue.index];
                    if (nextQueue.status === 'ready' && next)
                      await review(next.source, next.position);
                  }
                }
              } catch (error) {
                if (sequence === reviewSequence.current)
                  setClaimError(describeError(error, 'claim'));
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? 'Checking…' : 'Check receipt'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <main className="workspace fees-workspace">
      <div className="fee-heading-row">
        <div className="fees-heading">
          <h1>
            FEES<span>.</span>
          </h1>
          <p>Claim your creator fees from each launchpad.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={
            !address ||
            loading ||
            !!reviewing ||
            locked ||
            !!loadingMore ||
            !!currentQueue
          }
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
          Refresh
        </Button>
      </div>
      <section className="fee-sources" aria-label="Launchpad fees">
        {FEE_SOURCES.map((source) => {
          const key = `${source.padId}:${source.chainId}`;
          const entry = entries.find((result) => result.key === key);
          const data = claimSources.find(
            (result) =>
              result.padId === source.padId &&
              result.chainId === source.chainId,
          );
          const unavailable = !!entry?.error || data?.status === 'unavailable';
          const positions = data?.positions ?? [];
          const eligible = data ? claimQueueItems([data]) : [];
          const unverified = positions.some(
            (position) => position.verification === 'indexed',
          );
          const claimUnavailable = positions
            .map(disabledClaimMessage)
            .find(Boolean);
          const balances = groupFeeBalances(
            positions.flatMap((position) =>
              position.payouts.map((payout) => ({
                ...payout,
                padId: source.padId,
                chainId: source.chainId,
              })),
            ),
          );
          const incomplete = data?.status === 'partial' || !!data?.nextCursor;
          const note = !entry
            ? 'Checking your fees…'
            : unavailable
              ? (entry.error ?? unavailableFeeMessage(data))
              : !balances.length
                ? incomplete
                  ? 'No fees found so far.'
                  : 'No fees to claim.'
                : !eligible.length
                  ? (claimUnavailable ??
                    'These fees are not available to claim yet.')
                  : unverified
                    ? 'Some fees still need verification. Claim all includes available fees.'
                    : incomplete
                      ? 'More fees may be available. Claim all includes fees found so far.'
                      : null;
          return (
            <section
              className="fee-source"
              key={key}
              aria-label={`${label(source.padId)} fees`}
              aria-busy={!entry}
            >
              <div className="fee-source-heading">
                <strong>
                  {label(source.padId)}{' '}
                  <span>· {chainName(source.chainId)}</span>
                </strong>
                {unavailable && (
                  <span className="fee-coverage fee-coverage-unknown">
                    Unavailable
                  </span>
                )}
                {!unavailable && incomplete && (
                  <span className="fee-coverage">Partial</span>
                )}
              </div>
              {balances.length > 0 && (
                <div
                  className="my-5"
                  aria-label={unverified ? 'Estimated fees' : 'Fees found'}
                >
                  {unverified && <p>Estimated fees</p>}
                  {balances.map((balance) => (
                    <div className="fee-payout font-mono" key={balance.key}>
                      {balance.claimable} {balance.symbol}
                    </div>
                  ))}
                </div>
              )}
              {note && <p>{note}</p>}
              {entry?.pageError && (
                <p className="field-error" role="alert">
                  {entry.pageError}
                </p>
              )}
              <div className="fee-review-actions">
                <Button
                  disabled={
                    !eligible.length ||
                    !ownerConnected ||
                    locked ||
                    loading ||
                    !!loadingMore ||
                    !!reviewing ||
                    !!currentQueue
                  }
                  onClick={() => {
                    setQuote(null);
                    setClaimError(null);
                    const nextQueue = startClaimQueue(
                      claimSources,
                      source.padId,
                    );
                    setQueue(nextQueue);
                    const first = nextQueue.items[0];
                    if (first) void review(first.source, first.position);
                  }}
                >
                  Claim all
                </Button>
                {data?.nextCursor &&
                  (loadingMore === key ? (
                    <Button variant="outline" onClick={stopScan}>
                      Cancel check
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={
                        loading ||
                        !!loadingMore ||
                        locked ||
                        !!currentQueue ||
                        !!reviewing
                      }
                      onClick={() => entry && void continueScan(entry)}
                    >
                      Check more
                    </Button>
                  ))}
              </div>
            </section>
          );
        })}
      </section>
      {address && !ownerConnected && (
        <p className="notice">Connect this address to claim its fees.</p>
      )}
      {address &&
        locked &&
        !currentActivities.some((activity) =>
          ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(
            activity.status,
          ),
        ) && (
          <p className="notice">
            A claim for another address is unresolved. Return to that address
            and check its claim status before claiming again.
          </p>
        )}
      {currentQueue && (
        <section
          className="fee-review fee-queue font-mono"
          aria-label="Claim fees"
          aria-live="polite"
          aria-busy={!!reviewing || sending}
        >
          <div className="fee-queue-heading">
            <h2>
              {currentQueue.status === 'complete'
                ? `${queueLabel} fees claimed`
                : `Claim ${queueLabel} fees`}
            </h2>
            <span>
              {currentQueue.index} / {currentQueue.items.length} confirmed
            </span>
          </div>
          {queueItem && (
            <p className="fee-payout font-mono">
              {(quote?.payouts ?? queueItem.position.payouts)
                .map(payoutText)
                .join(' + ')}
            </p>
          )}
          {reviewing && <p>Preparing claim…</p>}
          {quote && (
            <p>
              Estimated gas: <strong>{ethText(quote.estimatedWei)}</strong>
              {' · '}
              <span title="ETH/USD spot estimate from Coinbase">
                {formatGasUsd(quote.gasUsd)}
              </span>
            </p>
          )}
          {quote && highGas(quote.estimatedWei) && (
            <p role="alert" className="field-error">
              High gas fee.
            </p>
          )}
          {queueActivities.map((activity) => (
            <div key={activity.quote.positionId}>
              {renderActivity(activity)}
            </div>
          ))}
          <div className="fee-review-actions">
            {queueItem && currentQueue.status === 'ready' && (
              <Button
                disabled={
                  locked ||
                  !ownerConnected ||
                  !!reviewing ||
                  !account.sendClaim ||
                  !account.ensureClaimChain
                }
                onClick={() => {
                  if (quote) void claim();
                  else void review(queueItem.source, queueItem.position);
                }}
              >
                {reviewing
                  ? 'Preparing…'
                  : sending
                    ? 'Confirming…'
                    : quote
                      ? 'Confirm in wallet'
                      : 'Try again'}
              </Button>
            )}
            <Button variant="outline" disabled={sending} onClick={cancelQueue}>
              {currentQueue.status === 'complete' ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </section>
      )}
      {claimError && (
        <p role="alert" className="field-error">
          {claimError}
        </p>
      )}
      {otherActivities.map((activity) => (
        <section
          className="fee-review font-mono"
          key={activity.quote.positionId}
          aria-label="Claim status"
        >
          {renderActivity(activity)}
        </section>
      ))}
    </main>
  );
}
