'use client';

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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
  compactFeeAmount,
  normalizeFeeAddress,
} from '@/lib/fees-model';
import {
  loadFeeSources,
  prepareClaim,
  type ClaimQuote,
  type FeeSource,
  type FeePosition,
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
  reconcileClaimQueue,
  startClaimQueue,
  type ClaimQueue,
} from '@/lib/claim-queue';
import { formatEth, HIGH_NETWORK_FEE_WEI } from '@/lib/launch-cost';
import { describeError } from '@/lib/user-error';
import {
  feeCheckResult,
} from '@/lib/fee-status';
import { formatGasUsd } from '@/lib/fee-usd';
import { runClaimAction } from '@/lib/claim-action';

type SourceResult = {
  key: string;
  source?: FeeSource;
  error?: string;
  pageError?: string;
  pages: number;
  scanning?: boolean;
};
const label = launchpadName;
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const ethText = (value: string) => formatEth(BigInt(value));
const highGas = (value: string) => BigInt(value) >= HIGH_NETWORK_FEE_WEI;
const localNow = () => performance.now();
const subscribeVisibility = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const pageVisible = () => document.visibilityState !== 'hidden';
const hiddenOnServer = () => false;

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
  const { watchClaim, chainId: walletChainId } = account;
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
  const [queue, setQueue] = useState<ClaimQueue | null>(null);
  const [claimedIds, setClaimedIds] = useState<string[]>([]);
  const reviewSequence = useRef(0);
  const claimInFlight = useRef(false);
  const seenConfirmations = useRef(
    new Set(
      getClaims()
        .filter((entry) => entry.status === 'confirmed')
        .map((entry) => entry.quote),
    ),
  );
  const visible = useSyncExternalStore(
    subscribeVisibility,
    pageVisible,
    hiddenOnServer,
  );
  const activities = useSyncExternalStore(
    subscribeClaims,
    getClaims,
    () => emptyClaims,
  );
  const entries =
    results?.address === address && results.revision === refresh
      ? results.entries
      : [];
  const loading =
    !!address &&
    (entries.length < FEE_SOURCES.length ||
      entries.some((entry) => entry.scanning));
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
  const ownerConnected =
    !!address && account.address?.toLowerCase() === address;
  const currentActivities = activities.filter(
    (activity) => activity.quote.address.toLowerCase() === address,
  );
  const pendingActivity = currentActivities.find(
    (activity) => activity.status === 'submitted' && activity.hash,
  );
  const queueActivities = currentQueue
    ? claimQueueActivities(currentQueue, currentActivities)
    : [];
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
    let cancelled = false;
    const timer = setTimeout(() => {
      setResults({ address, revision: refresh, entries: [] });
      void loadFeeSources(
        address,
        FEE_SOURCES,
        (result) => {
          const key = `${result.padId}:${result.chainId}`;
          const entry: SourceResult = result.source
            ? {
                key,
                source: result.source,
                pages: result.pages ?? 1,
                scanning: result.scanning,
                pageError: result.pageError
                  ? describeError(result.pageError, 'fees')
                  : undefined,
              }
            : { key, error: describeError(result.error, 'fees'), pages: 0 };
          setResults((previous) => ({
            address,
            revision: refresh,
            entries: [
              ...(previous?.address === address && previous.revision === refresh
                ? previous.entries.filter((entry) => entry.key !== key)
                : []),
              entry,
            ],
          }));
        },
        () => !cancelled,
      );
    }, FEE_LOOKUP_DELAY);
    return () => {
      cancelled = true;
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
      reviewing
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

  const advanceQueue = useEffectEvent(() => {
    const confirmed = currentActivities.filter(
      (activity) =>
        activity.status === 'confirmed' &&
        !seenConfirmations.current.has(activity.quote),
    );
    for (const activity of confirmed)
      seenConfirmations.current.add(activity.quote);
    if (confirmed.length)
      setClaimedIds((previous) => [
        ...new Set([
          ...previous,
          ...confirmed.map((activity) => activity.quote.positionId),
        ]),
      ]);
    if (confirmed.length) setClaimError(null);
    if (!queue) return;
    const nextQueue = reconcileClaimQueue(queue, activities);
    if (nextQueue === queue) return;
    setQueue(nextQueue);
    const next = nextQueue.items[nextQueue.index];
    if (nextQueue.status === 'ready' && next)
      void review(next.source, next.position);
  });
  useEffect(() => {
    advanceQueue();
  }, [activities]);

  useEffect(() => {
    if (
      !visible ||
      !pendingActivity ||
      !watchClaim ||
      !ownerConnected ||
      walletChainId !== pendingActivity.quote.chainId
    )
      return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void watchClaim(
      pendingActivity.quote.positionId,
      () => !cancelled && pageVisible(),
      (error) => {
        if (!cancelled) setClaimError(describeError(error, 'claim'));
      },
    )
      .then((cleanup) => {
        if (cancelled) cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        if (!cancelled) setClaimError(describeError(error, 'claim'));
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [visible, pendingActivity, watchClaim, walletChainId, ownerConnected]);

  async function claim(selectedQueue = currentQueue, selectedQuote = quote) {
    const item = selectedQueue?.items[selectedQueue.index];
    if (
      !selectedQueue ||
      !item ||
      selectedQueue.status !== 'ready' ||
      !account.sendClaim ||
      !account.ensureClaimChain ||
      !ownerConnected ||
      locked ||
      reviewing ||
      claimInFlight.current
    )
      return;
    claimInFlight.current = true;
    setReviewing(item.position.id);
    setClaimError(null);
    const sequence = ++reviewSequence.current;
    let submittedQueue: ClaimQueue | null = null;
    try {
      await runClaimAction({
        queue: selectedQueue,
        quote: selectedQuote,
        address,
        isCurrent: () => sequence === reviewSequence.current,
        ensureChain: account.ensureClaimChain,
        prepare: prepareClaim,
        onPrepared: setQuote,
        onAttempt: (attempt) => {
          submittedQueue = attempt;
          setQueue(attempt);
          setReviewing(null);
          setSending(true);
        },
        send: account.sendClaim,
      });
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
      claimInFlight.current = false;
      setReviewing(null);
      setSending(false);
    }
  }

  function renderActivity(activity: ClaimActivity) {
    return (
      <div aria-label="Claim status" className="mt-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span>
            {activity.status === 'wallet'
              ? 'Confirm in wallet'
              : activity.status === 'submitted'
                ? 'Confirming…'
                : activity.status === 'confirmed'
                  ? 'Claimed'
                  : activity.status === 'failed'
                    ? 'Failed'
                    : activity.status === 'reviewed'
                      ? 'Reviewed'
                      : 'Check wallet'}
          </span>
          {activity.hash && (
            <a
              href={`${activity.quote.chainId === 4663 ? 'https://robinscan.io' : 'https://basescan.org'}/tx/${activity.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 hover:opacity-70"
              title={activity.hash}
              aria-label={`View transaction ${activity.hash}`}
            >
              {short(activity.hash)}
            </a>
          )}
        </div>
        {['uncertain', 'no_payout'].includes(activity.status) && (
          <>
            <p>Check your wallet before trying again.</p>
            <Button
              variant="outline"
              disabled={!ownerConnected}
              onClick={() => {
                acknowledgeClaim(activity.quote.positionId);
                setQuote(null);
              }}
            >
              I checked my wallet
            </Button>
          </>
        )}
      </div>
    );
  }

  const rows = FEE_SOURCES.map((source) => {
    const key = `${source.padId}:${source.chainId}`;
    const entry = entries.find((result) => result.key === key);
    const data = claimSources.find((result) =>
      result.padId === source.padId && result.chainId === source.chainId);
    const eligible = data ? claimQueueItems([data]) : [];
    const balances = groupFeeBalances(eligible.flatMap(({ position }) =>
      position.payouts.filter((payout) => BigInt(payout.claimableRaw) > 0n)
        .map((payout) => ({ ...payout, ...source }))));
    const unavailable = !!entry?.error || data?.status === 'unavailable';
    const checking = !entry || !!entry.scanning;
    const active = currentQueue?.items[0]?.source.padId === source.padId &&
      currentQueue?.items[0]?.source.chainId === source.chainId;
    const history = currentActivities.filter((activity) =>
      activity.quote.kind === source.padId && activity.quote.chainId === source.chainId);
    const result = feeCheckResult(data, checking, unavailable || !!entry?.pageError);
    const issue = !checking && (unavailable || !!entry?.pageError ||
      !!data?.nextCursor || (!result && !active));
    return { source, key, entry, data, eligible, balances,
      checking, active, history, result, issue };
  });
  const pendingRows = rows.filter((row) => row.checking);
  const failedRows = rows.filter((row) => row.issue);

  function renderSource(row: (typeof rows)[number]) {
    const { source, key, data, eligible, balances,
      checking, active, history, result } = row;
    const activeQuote = active ? quote : null;
    const statusQuote = activeQuote ?? history.find((activity) =>
      ['wallet', 'submitted'].includes(activity.status))?.quote;
    const complete = active && currentQueue?.status === 'complete';
    const canResume = active && currentQueue && !complete;
    const hasAction = eligible.length > 0 || canResume;
    const rowBusy = active && (!!reviewing || sending);
    const message = result === 'empty' && !complete ? 'No fees to claim' : null;
    const displayedActivities = active ? queueActivities : history;
    const latestActivity = displayedActivities.at(-1);
    const confirming = latestActivity?.status === 'submitted';
    return (
      <section className="fee-source fee-source-row" key={key}
        aria-label={`${label(source.padId)} fees`} aria-busy={checking || rowBusy}>
        <div className="fee-source-main">
          <div className="fee-source-content">
            <div className="fee-source-heading">
              <strong>{label(source.padId)} <span>· {chainName(source.chainId)}</span></strong>
            </div>
            {balances.length > 0 && (
              <div className="fee-balances" aria-label="Creator fees">
                {balances.map((balance) => (
                  <span className="fee-payout font-mono" key={balance.key}>
                    {compactFeeAmount(balance.claimable)} {balance.symbol}
                  </span>
                ))}
              </div>
            )}
            {complete && <p className="fee-complete">Fees claimed</p>}
            {message && <p>{message}</p>}
            {statusQuote && <p className="fee-gas">
              Est. gas <strong>{ethText(statusQuote.estimatedWei)}</strong>
              {statusQuote.gasUsd && localNow() < statusQuote.gasUsd.expiresAt &&
                <> · {formatGasUsd(statusQuote.gasUsd)}</>}
            </p>}
            {activeQuote && highGas(activeQuote.estimatedWei) &&
              <p role="alert" className="field-error">High gas fee. Review the estimate before continuing.</p>}
          </div>
          <div className="fee-source-action">
            {hasAction && <Button
              disabled={!ownerConnected || locked || !!reviewing ||
                !account.sendClaim || !account.ensureClaimChain}
              onClick={() => {
                if (canResume) {
                  const resumed: ClaimQueue = currentQueue.status === 'paused'
                    ? { ...currentQueue, status: 'ready', attempt: undefined } : currentQueue;
                  setQueue(resumed);
                  void claim(resumed, quote);
                } else if (data) {
                  const nextQueue = startClaimQueue([data]);
                  setQueue(nextQueue);
                  setQuote(null);
                  setClaimError(null);
                  void claim(nextQueue, null);
                }
              }}>
              {rowBusy ? reviewing ? 'Preparing…' : 'Check wallet'
                : active && confirming ? 'Confirming…'
                : active && currentQueue?.status === 'paused' ? 'Try again'
                : activeQuote && highGas(activeQuote.estimatedWei) ? 'Continue in wallet'
                : active && currentQueue && currentQueue.index > 0 ? 'Claim next'
                : 'Claim fees'}
            </Button>}
            {hasAction && <span className="fee-transaction-count">
              {active && currentQueue ? `${currentQueue.index} / ${currentQueue.items.length} confirmed`
                : `${eligible.length} ${eligible.length === 1 ? 'transaction' : 'transactions'}`}
            </span>}
          </div>
        </div>
        {active && (rowBusy || latestActivity || claimError || complete) && (
          <div className="fee-inline-progress" aria-live="polite">
            {reviewing && <p>Preparing claim…</p>}
            {latestActivity && renderActivity(latestActivity)}
            {complete && <span>{currentQueue.index} / {currentQueue.items.length} confirmed</span>}
            {claimError && <p className="field-error" role="alert">{claimError}</p>}
          </div>
        )}
        {!active && latestActivity && renderActivity(latestActivity)}
        {balances.length > 0 && (
          <details className="fee-amount-details">
            <summary>Exact amounts</summary>
            {balances.map((balance) => <p className="font-mono" key={balance.key}>
              {balance.claimable} {balance.symbol}
            </p>)}
            {data?.positions.some((position) => position.verification === 'indexed') &&
              <p>Some reported fees are not available to claim here yet.</p>}
            {active && queueItem?.source.padId === 'stonx' &&
              <p>{queueItem.position.feeStream === 'trading' ? 'Trading fee share' : 'LP fee share'}</p>}
            {activeQuote && activeQuote.payouts.map((payout) => <p key={payout.asset}>
              Current transaction: {formatUnits(BigInt(payout.claimableRaw), payout.decimals)} {payout.symbol}
            </p>)}
          </details>
        )}

      </section>
    );
  }

  return (
    <main className="workspace fees-workspace">
      <div className="fee-heading-row">
        <div className="fees-heading"><h1>FEES<span>.</span></h1></div>
        <Button type="button" variant="outline"
          disabled={!address || loading || !!reviewing || locked}
          onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={16} />Refresh
        </Button>
      </div>
      {pendingRows.length > 0 && <output className="block" aria-live="polite">
        Checking {pendingRows.map((row) => label(row.source.padId)).join(', ')} fees…
      </output>}
      {failedRows.length > 0 && <div className="notice" role="alert">
        <p>Couldn’t finish checking {failedRows.map((row) => label(row.source.padId)).join(', ')} fees.</p>
        <Button variant="outline" disabled={loading || locked || !!reviewing}
          onClick={() => setRefresh((value) => value + 1)}>Retry fee checks</Button>
      </div>}
      <section className="fee-sources fee-compact-sources" aria-label="Launchpad fees">
        {rows.filter((row) => row.result || row.active || row.history.length).map(renderSource)}
      </section>
      <details className="fee-disclosure fee-coverage-details">
        <summary>Coverage details</summary>
        <p>Balances include fees found so far. Newly launched pools and older launches may not appear yet.</p>
        <p>pons includes ETH and configured payout tokens in the current v2 escrow. Pending sweeps, locked buybacks and older escrows are excluded.{' '}
          <a href="https://www.ponsfamily.com/launchpad" target="_blank" rel="noopener noreferrer">Manage sweeps and vesting on pons ↗</a>
        </p>
        <p>stonx trading fees and LP fees are claimed separately. Each transaction requires wallet confirmation.</p>
      </details>
      {address && !ownerConnected && <p className="notice">Connect this address to claim its fees.</p>}
      {address && locked && !currentActivities.some((activity) =>
        ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(activity.status)) &&
        <p className="notice">A claim for another address is unresolved. Return to that address and check its claim status before claiming again.</p>}
    </main>
  );
}
