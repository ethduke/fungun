'use client';

import { ArrowUpRight, Crosshair, Info } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  LONG_PAIRS,
  launchpadName,
  type Destination,
  type PairId,
} from '@/lib/launch-model';
import type { CatalogPad } from '@/lib/read-service';
import { FEE_INFO_REVIEWED, launchpadFeeInfo } from '@/lib/launchpad-fees';
import { LONGBOW_PAIRS } from '@/lib/longbow-markets';
import { savedO1Pairs } from '@/lib/o1-markets';
import './launchpad-card.css';

export function LaunchpadCard({
  destination: pad,
  onChange,
  catalog,
  loading = false,
  onPairingOpen,
}: {
  destination: Destination;
  onChange: (destination: Destination) => void;
  catalog?: CatalogPad;
  loading?: boolean;
  onPairingOpen?: () => void;
}) {
  const long = pad.id === 'long';
  const o1 = pad.id === 'o1';
  const title = launchpadName(pad.id);
  const live = o1 && catalog?.status === 'ready';
  const saved = o1 && !live;
  const pairs = long
    ? LONG_PAIRS
    : pad.id === 'longbow'
      ? LONGBOW_PAIRS
      : live
        ? catalog.pairs
        : savedO1Pairs(pad.chainId);
  const selectedPair = pairs.find((pair) => pair.id === pad.pairId);
  const feeInfo = launchpadFeeInfo(pad);
  return (
    <div className="launchpad-card" data-selected={pad.selected}>
      <label className="launchpad-top">
        <Checkbox
          checked={pad.selected}
          onCheckedChange={(selected) => onChange({ ...pad, selected })}
          aria-label={`Select ${title}`}
        />
        <span className={`pad-logo ${pad.id}`} aria-hidden="true">
          {long ? (
            <ArrowUpRight size={22} />
          ) : o1 ? (
            'o1'
          ) : (
            <Crosshair size={22} />
          )}
        </span>
        <strong className="pad-title">{title}</strong>
      </label>
      {pad.selected && (
        <Select
          value={pad.pairId}
          onOpenChange={(open) => {
            if (open && o1) onPairingOpen?.();
          }}
          onValueChange={(value) => {
            if (
              (o1 && value === 'native') ||
              pairs.some((pair) => pair.id === value)
            )
              onChange({
                ...pad,
                route: value === 'native' ? 'standard' : 'rwa',
                pairId: value as PairId,
              });
          }}
        >
          <SelectTrigger
            aria-label={`${title} pairing`}
            className="pair-select"
          >
            <SelectValue>
              {pad.pairId === 'native'
                ? 'ETH'
                : selectedPair
                  ? selectedPair.symbol
                  : 'Choose pairing'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {o1 && <SelectItem value="native">ETH</SelectItem>}
            {pairs.map((pair) => (
              <SelectItem key={pair.id} value={pair.id}>
                {pair.symbol}
              </SelectItem>
            ))}
            {live && !pairs.length && (
              <SelectItem value="unavailable" disabled>
                No RWA pairs available
              </SelectItem>
            )}
            {saved && (
              <SelectItem value="status" disabled>
                {loading
                  ? 'Checking availability…'
                  : pairs.length
                    ? 'Saved catalog · Sep 4, 2026'
                    : 'Catalog unavailable'}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
      {feeInfo && (
        <div className="pad-fee-share">
          <span>
            {feeInfo.label} <strong>{feeInfo.creatorPercent}%</strong>
          </span>
          <Popover>
            <PopoverTrigger
              type="button"
              className="pad-fee-info"
              aria-label={`${title} fee share details`}
            >
              <Info size={15} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="end" className="pad-fee-details">
              <PopoverTitle>{title} fee share</PopoverTitle>
              <PopoverDescription>{feeInfo.details}</PopoverDescription>
              <p>
                Shares of fee revenue, not trading volume. Launch costs and
                network gas are separate.
              </p>
              <a
                href={feeInfo.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {feeInfo.sourceLabel}{' '}
                <ArrowUpRight size={13} aria-hidden="true" />
              </a>
              <p className="pad-fee-reviewed">
                Reviewed <time dateTime={FEE_INFO_REVIEWED}>4 Sep 2026</time>.
                Not a live quote; terms may change for future launches.
              </p>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  );
}
