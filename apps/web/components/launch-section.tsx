'use client';

import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ImagePlus,
  LockKeyhole,
  TriangleAlert,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { BulletProgress } from '@/components/launch-motion';
import {
  chainName,
  draftStatus,
  launchpadName,
  pairingName,
  type Destination,
  type ChainId,
} from '@/lib/launch-model';
import { type Catalog } from '@/lib/read-service';
import {
  calculateLaunchCosts,
  approximateLaunchQuote,
  parseApproximateLaunchCost,
  type ApproximateLaunchCost,
  costRefreshDelay,
  costNotice,
  formatEth,
  formatUsd,
  highGasNotice,
  type LaunchCostQuote,
  type UsdRate,
} from '@/lib/launch-cost';
import {
  launchRequest,
  LaunchError,
  isLongLaunchPair,
} from '@/lib/long-wallet';
import './launch-cost.css';
import './launch-section.css';

export function LaunchSection({
  name,
  ticker,
  image,
  imagePending,
  errors,
  destinations,
  onChange,
  catalog,
  now = 0,
  chainId,
  costContextKey,
  costQuote,
  usdRate,
  children,
}: {
  name: string;
  ticker: string;
  image: { url: string } | null;
  imagePending: boolean;
  errors: Record<string, string>;
  destinations: Destination[];
  onChange: (destination: Destination) => void;
  catalog?: Catalog | null;
  now?: number;
  chainId: ChainId;
  costContextKey: string;
  costQuote?: LaunchCostQuote | null;
  usdRate?: UsdRate | null;
  children?: ReactNode;
}) {
  const selectedPair = destinations.find((pad) => pad.id === 'long')?.pairId;
  const estimatePair =
    chainId === 4663 && isLongLaunchPair(selectedPair) ? selectedPair : null;
  const supportsEstimate = !!estimatePair;
  const [approximate, setApproximate] = useState<ApproximateLaunchCost | null>(
    null,
  );
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [costTick, setCostTick] = useState(0);
  useEffect(() => {
    if (!estimatePair) return;
    const pairId = estimatePair;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(refresh, 30000);
        return;
      }
      let delay = 30000;
      try {
        const started = performance.now();
        const raw = await launchRequest('launch-estimate', {
          chainId: 4663,
          pairId,
        });
        const estimate = parseApproximateLaunchCost(raw, started, pairId);
        if (estimate.expiresAt <= performance.now())
          throw new Error('Estimate expired');
        if (stopped) return;
        setApproximate(estimate);
        setEstimateFailed(false);
        setCostTick(performance.now());
        delay = Math.max(1000, estimate.expiresAt - performance.now() + 50);
      } catch (error) {
        if (stopped) return;
        setEstimateFailed(true);
        setCostTick(performance.now());
        if (error instanceof LaunchError)
          delay = Math.max(delay, error.retryAfter * 1000);
      }
      if (!stopped) timer = setTimeout(refresh, delay);
    }
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [estimatePair]);
  const costNow = Math.max(now, costTick);
  useEffect(() => {
    if (!approximate) return;
    const timer = setTimeout(
      () => setCostTick(performance.now()),
      Math.max(0, approximate.expiresAt - performance.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [approximate]);
  useEffect(() => {
    const delay = costRefreshDelay(
      costQuote,
      usdRate,
      costNow,
      performance.now(),
    );
    if (delay === null) return;
    const timer = setTimeout(
      () => setCostTick(performance.now()),
      Math.min(delay + 1, 1000),
    );
    return () => clearTimeout(timer);
  }, [costQuote, usdRate, costNow]);
  const exactCosts = calculateLaunchCosts(
    imagePending ? null : costQuote,
    {
      contextKey: costContextKey,
      chainId,
      pads: destinations.map((pad) => pad.id),
    },
    costNow,
  );
  const fallbackCosts = calculateLaunchCosts(
    supportsEstimate && approximate?.pairId === estimatePair
      ? approximateLaunchQuote(approximate, costContextKey, costNow)
      : null,
    {
      contextKey: costContextKey,
      chainId,
      pads: destinations.map((pad) => pad.id),
    },
    costNow,
  );
  const useApproximate = !exactCosts.total && !!fallbackCosts.pads.long;
  const costs = useApproximate ? fallbackCosts : exactCosts;
  const prefix = useApproximate
    ? approximate?.basis === 'gas-limit'
      ? 'Up to '
      : '≈ '
    : '';
  const gasWarning = highGasNotice(
    Object.values(costs.pads).reduce(
      (sum, pad) => sum + (pad?.networkWei ?? 0n),
      0n,
    ),
  );
  const usdTotal = formatUsd(costs.total?.totalWei, usdRate, costNow);
  const status = draftStatus(errors, imagePending);
  const statusText = {
    checking: 'Checking image…',
    incomplete: 'Draft incomplete',
    complete: 'Draft complete',
  }[status];

  const hasUsd = usdTotal !== 'USD unavailable';
  const costMessage = !destinations.length
    ? 'Select a launchpad to see its fees.'
    : useApproximate && !costs.total
      ? 'Long gas is shown below. Estimates for other launchpads are unavailable.'
      : useApproximate
        ? approximate?.basis === 'gas-limit'
          ? 'Gas limit at the current gas price. Checked again before wallet approval.'
          : 'Approximate gas. Checked again before wallet approval.'
        : !costs.total && supportsEstimate
          ? estimateFailed
            ? 'Gas estimate temporarily unavailable. Launch will check again.'
            : 'Calculating approximate gas…'
          : costs.reason
            ? costNotice(costs.reason)
            : '';

  return (
    <section className="launch-section" aria-labelledby="launch-heading">
      <header className="launch-heading">
        <div className="section-heading">
          <span className="step-number">03</span>
          <h2 id="launch-heading">Launch</h2>
        </div>
        <output
          className="launch-status"
          data-state={status}
          aria-live="polite"
        >
          {statusText}
        </output>
      </header>
      <div className="launch-identity" aria-busy={imagePending}>
        {imagePending ? (
          <Skeleton className="launch-image" aria-hidden="true" />
        ) : image ? (
          <Image
            unoptimized
            width={48}
            height={48}
            src={image.url}
            alt="Coin preview"
          />
        ) : (
          <span className="launch-image" aria-hidden="true">
            <ImagePlus size={22} />
          </span>
        )}
        <div className="launch-identity-copy">
          <div className="launch-name-row">
            <strong>{name.trim() || 'Coin name'}</strong>
            <span>{ticker ? `$${ticker}` : 'Ticker'}</span>
          </div>
          <div className="launch-chain">{chainName(chainId)}</div>
        </div>
      </div>
      {destinations.length ? (
        <div className="launch-destinations">
          {destinations.map((pad) => {
            const pairing =
              (pad.id === 'longbow'
                ? undefined
                : catalog?.pads[pad.id]?.pairs.find(
                    (pair) => pair.id === pad.pairId,
                  )?.symbol) ?? pairingName(pad.pairId);
            return (
              <div key={pad.id} className="launch-destination">
                <div className="launch-route">
                  <strong>
                    {launchpadName(pad.id)} / {pairing}
                  </strong>
                  {pad.pairId.startsWith('sample-') && (
                    <span>Sample pairing</span>
                  )}
                  {pad.chainId !== chainId && (
                    <span>{chainName(pad.chainId)}</span>
                  )}
                </div>
                <div className="launch-facts">
                  {pad.id === 'o1' ? (
                    <label
                      className="metadata-option"
                      htmlFor="o1-editable-metadata"
                    >
                      <Checkbox
                        id="o1-editable-metadata"
                        checked={pad.editableMetadata}
                        onCheckedChange={(editableMetadata) =>
                          onChange({ ...pad, editableMetadata })
                        }
                      />
                      Allow metadata updates
                    </label>
                  ) : (
                    <span>
                      <LockKeyhole size={14} aria-hidden="true" />
                      Immutable metadata
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="launch-empty">Select a launchpad above.</p>
      )}
      {imagePending && <BulletProgress label="Checking image…" />}
      {status === 'incomplete' && (
        <output className="launch-validation">
          {Object.values(errors)[0]}
        </output>
      )}
      {destinations.length > 1 && (
        <p className="launch-note">
          Separate deployments; each launch can succeed or fail independently.
        </p>
      )}
      {gasWarning && (
        <p role="alert" className="cost-warning">
          <TriangleAlert size={18} aria-hidden="true" />
          {gasWarning}
        </p>
      )}
      <footer className="launch-footer">
        <div>
          <div className="launch-cost-summary">
            <div>
              <span className="launch-total-label">Estimated total</span>
              <p className="launch-total-note">
                Launch fee + network gas
                {costs.total?.otherValueWei ? ' + transaction value' : ''}
              </p>
            </div>
            <output
              className="total-price"
              data-pending={!costs.total}
              aria-live="polite"
            >
              {costs.total
                ? `${prefix}${formatEth(costs.total.totalWei)}`
                : supportsEstimate &&
                    !estimateFailed &&
                    !fallbackCosts.pads.long
                  ? 'Estimating…'
                  : 'Unavailable'}
              {hasUsd && <span>{usdTotal}</span>}
            </output>
          </div>
          {costMessage && (
            <p id="launch-preview-notice" className="launch-note">
              {costMessage}
            </p>
          )}
          {!!destinations.length && (
            <Collapsible className="launch-fees">
              <CollapsibleTrigger className="launch-fee-toggle">
                Fee breakdown <ChevronDown size={14} aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent className="launch-fee-panel">
                {destinations.map((pad) => {
                  const amount = costs.pads[pad.id];
                  return (
                    <div key={pad.id} className="launch-fee-pad">
                      <strong>{launchpadName(pad.id)}</strong>
                      <dl>
                        <div>
                          <dt>Launch fee</dt>
                          <dd>
                            {amount
                              ? formatEth(amount.launchpadWei)
                              : pad.id === 'long' && supportsEstimate
                                ? '0 ETH'
                                : 'Unavailable'}
                          </dd>
                        </div>
                        <div>
                          <dt>Estimated gas</dt>
                          <dd>
                            {amount
                              ? `${prefix}${formatEth(amount.networkWei)}`
                              : supportsEstimate &&
                                  pad.id === 'long' &&
                                  !estimateFailed
                                ? 'Estimating…'
                                : 'Unavailable'}
                          </dd>
                        </div>
                        {!!amount?.otherValueWei && (
                          <div>
                            <dt>Transaction value</dt>
                            <dd>{formatEth(amount.otherValueWei)}</dd>
                          </div>
                        )}
                        {amount && (
                          <div>
                            <dt>Transactions</dt>
                            <dd>{amount.transactions}</dd>
                          </div>
                        )}
                      </dl>
                    </div>
                  );
                })}
                {hasUsd && usdRate && (
                  <p className="launch-rate-source">
                    ETH/USD: {usdRate.sourceLabel} ·{' '}
                    {Math.max(
                      0,
                      Math.floor((costNow - usdRate.quotedAt) / 1000),
                    )}
                    s ago
                  </p>
                )}
                {costs.total && (
                  <p className="launch-rate-source">
                    Fees may change. Your wallet shows the final request.
                  </p>
                )}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
        {children}
      </footer>
    </section>
  );
}
