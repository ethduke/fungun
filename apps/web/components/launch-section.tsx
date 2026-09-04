'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { ImagePlus, LockKeyhole, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
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
            width={52}
            height={52}
            src={image.url}
            alt="Coin preview"
          />
        ) : (
          <span className="launch-image" aria-hidden="true">
            <ImagePlus size={22} />
          </span>
        )}
        <div>
          <strong>{name.trim() || 'Coin name'}</strong>
          <span>{ticker ? `$${ticker}` : 'Ticker'}</span>
        </div>
      </div>
      {destinations.length ? (
        <div className="launch-destinations">
          {destinations.map((pad) => (
            <div key={pad.id} className="launch-destination">
              <div>
                <strong>{launchpadName(pad.id)}</strong>
                <span>{chainName(pad.chainId)}</span>
              </div>
              <dl>
                <div>
                  <dt>Pairing</dt>
                  <dd>
                    {(pad.id === 'longbow'
                      ? undefined
                      : catalog?.pads[pad.id]?.pairs.find(
                          (pair) => pair.id === pad.pairId,
                        )?.symbol) ?? pairingName(pad.pairId)}
                    {pad.pairId.startsWith('sample-') ? ' · sample' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Metadata</dt>
                  <dd>
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
                        Allow updates
                      </label>
                    ) : (
                      'Immutable'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Launchpad fee</dt>
                  <dd className="cost-amount">
                    {formatEth(costs.pads[pad.id]?.launchpadWei)}
                    <span>
                      {formatUsd(
                        costs.pads[pad.id]?.launchpadWei,
                        usdRate,
                        costNow,
                      )}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>Network fees · estimated</dt>
                  <dd className="cost-amount">
                    {formatEth(costs.pads[pad.id]?.networkWei)}
                    <span>
                      {formatUsd(
                        costs.pads[pad.id]?.networkWei,
                        usdRate,
                        costNow,
                      )}
                    </span>
                  </dd>
                </div>
                {!!costs.pads[pad.id]?.otherValueWei && (
                  <div>
                    <dt>Other transaction value</dt>
                    <dd className="cost-amount">
                      {formatEth(costs.pads[pad.id]?.otherValueWei)}
                      <span>
                        {formatUsd(
                          costs.pads[pad.id]?.otherValueWei,
                          usdRate,
                          costNow,
                        )}
                      </span>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Ticker</dt>
                  <dd>
                    {pad.id === 'longbow'
                      ? 'Not supported yet'
                      : checking
                        ? 'Checking…'
                        : tickerLabel(tickerCheck?.results[pad.id], now)}
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      ) : (
        <p className="launch-empty">Select a launchpad above.</p>
      )}
      {status === 'incomplete' && (
        <output className="launch-validation">
          {Object.values(errors)[0]}
        </output>
      )}
      {destinations.length > 1 && (
        <p className="launch-note">
          Separate token deployments; one can succeed while another fails.
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
          <span className="eyebrow">ESTIMATED TOTAL</span>
          <output className="total-price" aria-live="polite">
            {formatEth(costs.total?.totalWei)} <span>{usdTotal}</span>
          </output>
          <p className="cost-caption">
            Launchpad + network fees
            {costs.total?.otherValueWei ? ' + other transaction value' : ''}
            {costs.total
              ? ` · ${costs.total.transactions} transaction${costs.total.transactions === 1 ? '' : 's'}`
              : ''}
          </p>
          {usdTotal !== 'USD unavailable' && usdRate && (
            <p className="cost-caption">
              ETH/USD: {usdRate.sourceLabel} ·{' '}
              {Math.max(0, Math.floor((costNow - usdRate.quotedAt) / 1000))}s
              ago
            </p>
          )}
          <p id="launch-preview-notice" className="launch-note">
            {destinations.length
              ? costNotice(costs.reason)
              : 'Select a launchpad to see its launch costs.'}
          </p>
        </div>
        <Button
          type="button"
          className="launch-button"
          disabled
          aria-describedby="launch-preview-notice"
        >
          <LockKeyhole size={16} />
          Launch coin
        </Button>
      </footer>
    </section>
  );
}
