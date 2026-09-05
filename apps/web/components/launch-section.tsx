'use client';

import Image from 'next/image';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
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
import {
  tickerLabel,
  type Catalog,
  type TickerCheck,
} from '@/lib/read-service';
import {
  calculateLaunchCosts,
  costRefreshDelay,
  costNotice,
  formatEth,
  formatUsd,
  highGasNotice,
  type LaunchCostQuote,
  type UsdRate,
} from '@/lib/launch-cost';
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
  tickerCheck,
  checking = false,
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
  tickerCheck?: TickerCheck | null;
  checking?: boolean;
  now?: number;
  chainId: ChainId;
  costContextKey: string;
  costQuote?: LaunchCostQuote | null;
  usdRate?: UsdRate | null;
  children?: ReactNode;
}) {
  const [costTick, setCostTick] = useState(0);
  const costNow = Math.max(now, costTick);
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
  const costs = calculateLaunchCosts(
    imagePending ? null : costQuote,
    {
      contextKey: costContextKey,
      chainId,
      pads: destinations.map((pad) => pad.id),
    },
    costNow,
  );
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
    : costs.reason === 'not_ready'
      ? 'Fees appear before wallet approval.'
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
            const reservation =
              pad.id === 'longbow'
                ? 'Not supported yet'
                : checking
                  ? 'Checking…'
                  : tickerLabel(tickerCheck?.results[pad.id], now);
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
                  <span>
                    {reservation === 'Unreserved' && (
                      <Check size={14} aria-hidden="true" />
                    )}
                    Ticker: {reservation.toLowerCase()}
                  </span>
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
              {costs.total ? formatEth(costs.total.totalWei) : 'Pending'}
              {hasUsd && <span>≈ {usdTotal}</span>}
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
                              : 'Pending'}
                          </dd>
                        </div>
                        <div>
                          <dt>Estimated gas</dt>
                          <dd>
                            {amount ? formatEth(amount.networkWei) : 'Pending'}
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
