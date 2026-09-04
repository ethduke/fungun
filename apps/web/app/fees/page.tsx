'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { formatUnits } from 'viem';
import { Wallet, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useConnectedAccount } from '@/lib/account-context';
import { chainName } from '@/lib/launch-model';
import {
  FEE_LOOKUP_DELAY,
  FEE_SOURCES,
  normalizeFeeAddress,
} from '@/lib/fees-model';
import {
  loadFees,
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
} from '@/lib/claim-wallet';
import { formatEth, HIGH_NETWORK_FEE_WEI } from '@/lib/launch-cost';
import { describeError } from '@/lib/user-error';

type SourceResult = { key: string; source?: FeeSource; error?: string };
const label = (pad: string) => (pad === 'long' ? 'Long' : 'O1');
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const payoutText = (payout: FeePayout) =>
  `${formatUnits(BigInt(payout.claimableRaw), payout.decimals)} ${payout.symbol}`;
const ethText = (value: string) => formatEth(BigInt(value));
const highGas = (value: string) => BigInt(value) >= HIGH_NETWORK_FEE_WEI;
const localNow = () => performance.now();

export default function Fees() {
  const account = useConnectedAccount();
  const [manualAddress, setManualAddress] = useState<string | null>(null);
  const [results, setResults] = useState<{
    address: string;
    revision: number;
    entries: SourceResult[];
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [quote, setQuote] = useState<ClaimQuote | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const [sending, setSending] = useState(false);
  const [checking, setChecking] = useState(false);
  const reviewSequence = useRef(0);
  const activities = useSyncExternalStore(
    subscribeClaims,
    getClaims,
    () => emptyClaims,
  );
  const input = manualAddress ?? account.address ?? '';
  const address = normalizeFeeAddress(input);
  const entries =
    results?.address === address && results.revision === refresh
      ? results.entries
      : [];
  const loading = !!address && entries.length < FEE_SOURCES.length;
  const ownerConnected =
    !!address && account.address?.toLowerCase() === address;
  const currentActivities = activities.filter(
    (activity) => activity.quote.address.toLowerCase() === address,
  );
  const locked =
    sending ||
    activities.some((activity) =>
      ['wallet', 'submitted', 'uncertain', 'no_payout'].includes(
        activity.status,
      ),
    );
  const expired = quote ? clock >= quote.expiresAt : false;
  const scope = `${address}:${account.address}:${account.chainId}:${refresh}`;
  const [observedScope, setObservedScope] = useState(scope);
  if (observedScope !== scope) {
    setObservedScope(scope);
    setQuote(null);
    setReviewing(null);
    setClaimError(null);
  }

  useEffect(() => {
    reviewSequence.current++;
  }, [address, account.address, account.chainId, refresh]);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const timer = setTimeout(() => {
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
            };
          } catch (error) {
            entry = { key, error: describeError(error, 'fees') };
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
      clearTimeout(timer);
    };
  }, [address, refresh]);

  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => setClock(performance.now()),
      Math.max(0, quote.expiresAt - performance.now()) + 5,
    );
    return () => clearTimeout(timer);
  }, [quote]);

  async function review(source: FeeSource, position: FeePosition) {
    if (!address || !ownerConnected || locked) return;
    const sequence = ++reviewSequence.current;
    setReviewing(position.id);
    setQuote(null);
    setClaimError(null);
    try {
      const prepared = await prepareClaim(address, source, position);
      if (sequence === reviewSequence.current) {
        setClock(localNow());
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
      !quote ||
      !account.sendClaim ||
      !ownerConnected ||
      account.chainId !== quote.chainId ||
      locked ||
      expired
    )
      return;
    setSending(true);
    setClaimError(null);
    try {
      await account.sendClaim(quote);
      setQuote(null);
    } catch (error) {
      setClaimError(describeError(error, 'claim'));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="workspace fees-workspace">
      <div className="fees-heading">
        <h1>
          FEE<span>.</span>
        </h1>
      </div>
      <div className="fee-address-bar">
        <div className="fee-address-field">
          <label htmlFor="fee-address">Wallet address</label>
          <Input
            id="fee-address"
            value={input}
            placeholder="Connect your wallet or paste an address"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            onChange={(event) => setManualAddress(event.target.value)}
            aria-invalid={!!input.trim() && !address}
            aria-describedby="fee-status"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!account.address || manualAddress === null}
          onClick={() => setManualAddress(null)}
        >
          <Wallet size={16} />
          Use my wallet
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!address || loading || !!reviewing || sending}
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RefreshCw size={16} />
          Refresh
        </Button>
      </div>
      <output
        id="fee-status"
        className={`fee-status ${input.trim() && !address ? 'field-error' : ''}`}
      >
        {!input.trim()
          ? 'Connect your wallet above or enter an address.'
          : !address
            ? 'Enter a complete, valid wallet address.'
            : loading
              ? 'Loading fees…'
              : 'Fees by payout coin. Short-lived snapshots; refresh before claiming.'}
      </output>
      <section
        className="fees-panel"
        aria-label="Fees by payout coin"
        aria-busy={loading}
      >
        <Table className="fees-table">
          <TableHeader>
            <TableRow>
              <TableHead>Coin</TableHead>
              <TableHead>Launchpad</TableHead>
              <TableHead>Network</TableHead>
              <TableHead className="fee-amount">Claimable</TableHead>
              <TableHead>
                <span className="sr-only">Claim fees</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!address && (
              <TableRow>
                <TableCell colSpan={5} className="fee-empty">
                  Long and O1 fees appear here.
                </TableCell>
              </TableRow>
            )}
            {address &&
              FEE_SOURCES.map((source) => {
                const key = `${source.padId}:${source.chainId}`;
                const result = entries.find((entry) => entry.key === key);
                const data = result?.source;
                const note = !result
                  ? 'Loading…'
                  : (result.error ??
                    (data?.status === 'unavailable'
                      ? 'Not connected · balance unknown'
                      : !data?.positions.length
                        ? data?.status === 'partial'
                          ? 'No fees in the checked sources'
                          : 'No indexed fee positions'
                        : null));
                return note ? (
                  <TableRow key={key}>
                    <TableCell className="fee-muted">{note}</TableCell>
                    <TableCell>{label(source.padId)}</TableCell>
                    <TableCell>{chainName(source.chainId)}</TableCell>
                    <TableCell className="fee-amount">—</TableCell>
                    <TableCell>
                      <Button variant="outline" disabled>
                        Claim
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : (
                  data?.positions.flatMap((position) =>
                    position.payouts.map((payout, index) => (
                      <TableRow key={`${key}:${position.id}:${payout.asset}`}>
                        <TableCell>
                          <span title={payout.asset}>{payout.symbol}</span>
                          <small className="fee-row-detail">
                            {short(payout.asset)}
                          </small>
                        </TableCell>
                        <TableCell>
                          {label(source.padId)}
                          <small className="fee-row-detail">
                            {position.verification === 'live'
                              ? 'On-chain snapshot'
                              : 'Indexed · unverified'}
                          </small>
                        </TableCell>
                        <TableCell>{chainName(source.chainId)}</TableCell>
                        <TableCell className="fee-amount">
                          {formatUnits(
                            BigInt(payout.claimableRaw),
                            payout.decimals,
                          )}
                        </TableCell>
                        <TableCell>
                          {index === 0 && (
                            <Button
                              variant="outline"
                              disabled={
                                !ownerConnected ||
                                !position.claimable ||
                                locked ||
                                !!reviewing
                              }
                              onClick={() => void review(data, position)}
                            >
                              {reviewing === position.id
                                ? 'Checking…'
                                : source.padId === 'long'
                                  ? 'Claim pool fees'
                                  : 'Claim'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )),
                  )
                );
              })}
          </TableBody>
        </Table>
      </section>
      {address && !ownerConnected && (
        <p className="notice">Connect this address to claim its fees.</p>
      )}
      {(quote || reviewing) && (
        <section
          className="fee-review"
          aria-label="Review fee claim"
          aria-busy={!!reviewing}
        >
          <h2>{reviewing ? 'Checking claim and gas…' : 'Review claim'}</h2>
          {quote && (
            <>
              <p>
                {label(quote.kind)} · {chainName(quote.chainId)} · to your
                wallet <span title={quote.address}>{short(quote.address)}</span>
              </p>
              <p className="fee-payout">
                {quote.payouts.map(payoutText).join(' + ')}
              </p>
              <p>
                Estimated gas: <strong>{ethText(quote.estimatedWei)}</strong> ·
                USD estimate unavailable
              </p>
              <p>
                ETH balance needed with buffer: {ethText(quote.budgetWei)}. No
                claim payment or token approval.
              </p>
              {quote.chainId === 8453 && (
                <p>Includes Base execution, L1 data and operator fees.</p>
              )}
              <p>
                Estimates can change before mining. Review the wallet’s final
                fee; buffered costs are not a guaranteed cap.
              </p>
              {highGas(quote.estimatedWei) && (
                <p role="alert" className="field-error">
                  Gas is high: at least 0.01 ETH estimated. Consider waiting for
                  lower fees.
                </p>
              )}
              {quote.payouts.some(
                (payout) =>
                  /^0x0{40}$/i.test(payout.asset) &&
                  BigInt(payout.claimableRaw) <= BigInt(quote.estimatedWei),
              ) && (
                <p className="notice">
                  Gas may cost more than the ETH you receive. Other payout coins
                  are not included in this comparison.
                </p>
              )}
              {expired && (
                <p className="notice">
                  Estimate expired. Review the claim again to refresh it.
                </p>
              )}
              {account.chainId !== quote.chainId && (
                <p className="notice">
                  Switch your wallet to {chainName(quote.chainId)} first.
                </p>
              )}
              <div className="fee-review-actions">
                <Button
                  disabled={
                    expired ||
                    locked ||
                    !ownerConnected ||
                    account.chainId !== quote.chainId
                  }
                  onClick={() => void claim()}
                >
                  Confirm in wallet
                </Button>
                <Button
                  variant="outline"
                  disabled={sending}
                  onClick={() => {
                    reviewSequence.current++;
                    setQuote(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
        </section>
      )}
      {claimError && (
        <p role="alert" className="field-error">
          {claimError}
        </p>
      )}
      {currentActivities.map((activity) => (
        <section
          className="fee-review"
          key={activity.quote.positionId}
          aria-label="Claim status"
        >
          <h2>
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
          </h2>
          <p>
            {chainName(activity.quote.chainId)}
            {activity.hash && (
              <>
                {' '}
                · Transaction{' '}
                <span title={activity.hash}>{short(activity.hash)}</span>
              </>
            )}
          </p>
          {activity.status === 'confirmed' ? (
            <p>
              {activity.payouts?.map(payoutText).join(' + ')}. Included
              on-chain; finality is not guaranteed yet.
            </p>
          ) : activity.status === 'failed' ? (
            <p>No payout was confirmed. Gas may still have been charged.</p>
          ) : activity.status === 'reviewed' ? (
            <p>
              No transaction was resent. Wait 30 seconds, then refresh fees for
              a new review. Never retry while a claim is pending in your wallet.
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
              disabled={
                checking ||
                !account.checkClaim ||
                account.chainId !== activity.quote.chainId ||
                !ownerConnected
              }
              onClick={async () => {
                setChecking(true);
                setClaimError(null);
                try {
                  await account.checkClaim?.(activity.quote.positionId);
                } catch (error) {
                  setClaimError(describeError(error, 'claim'));
                } finally {
                  setChecking(false);
                }
              }}
            >
              {checking ? 'Checking…' : 'Check receipt'}
            </Button>
          )}
        </section>
      ))}
    </main>
  );
}
