'use client';

import Image from 'next/image';
import { ImagePlus, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  chainName,
  draftStatus,
  pairingName,
  type Destination,
} from '@/lib/launch-model';
import {
  tickerLabel,
  type Catalog,
  type TickerCheck,
} from '@/lib/read-service';

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
}) {
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
                <strong>{pad.id === 'long' ? 'Long' : 'O1'}</strong>
                <span>{chainName(pad.chainId)}</span>
              </div>
              <dl>
                <div>
                  <dt>Pairing</dt>
                  <dd>
                    {catalog?.pads[pad.id]?.pairs.find(
                      (pair) => pair.id === pad.pairId,
                    )?.symbol ?? pairingName(pad.pairId)}
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
                  <dt>Deployment fee</dt>
                  <dd>Not quoted</dd>
                </div>
                <div>
                  <dt>Network gas</dt>
                  <dd>Not estimated</dd>
                </div>
                <div>
                  <dt>Ticker</dt>
                  <dd>
                    {checking
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
      <footer className="launch-footer">
        <div>
          <span className="eyebrow">ESTIMATED TOTAL</span>
          <div className="total-price">
            — <span>Deployment + network fees</span>
          </div>
          <p id="launch-preview-notice" className="launch-note">
            Live launch and quotes are not connected. Catalog and reservation
            checks do not guarantee a successful launch.
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
