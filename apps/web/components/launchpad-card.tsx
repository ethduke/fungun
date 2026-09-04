'use client';

import { ArrowUpRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SAMPLE_PAIRS,
  type Destination,
  type PairId,
} from '@/lib/launch-model';
import type { CatalogPad } from '@/lib/read-service';

export function LaunchpadCard({
  destination: pad,
  onChange,
  catalog,
  loading = false,
}: {
  destination: Destination;
  onChange: (destination: Destination) => void;
  catalog?: CatalogPad;
  loading?: boolean;
}) {
  const long = pad.id === 'long';
  const title = long ? 'Long' : 'O1';
  const live = catalog?.status === 'ready';
  const pairs = live ? catalog.pairs : SAMPLE_PAIRS;
  const selectedPair = pairs.find((pair) => pair.id === pad.pairId);
  return (
    <div className="launchpad-card">
      <label className="launchpad-top">
        <Checkbox
          checked={pad.selected}
          onCheckedChange={(selected) => onChange({ ...pad, selected })}
          aria-label={`Select ${title}`}
        />
        <span className={`pad-logo ${pad.id}`} aria-hidden="true">
          {long ? <ArrowUpRight size={22} /> : 'o1'}
        </span>
        <strong className="pad-title">{title}</strong>
      </label>
      {pad.selected && (
        <Select
          value={pad.pairId}
          onValueChange={(value) => {
            if (
              (!long && value === 'native') ||
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
                ? 'Native / standard'
                : selectedPair
                  ? `${selectedPair.symbol}${live ? '' : ' (sample)'}`
                  : 'Choose pairing'}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!long && <SelectItem value="native">Native / standard</SelectItem>}
            {pairs.map((pair) => (
              <SelectItem key={pair.id} value={pair.id}>
                {pair.symbol}
                {live ? '' : ' (sample)'}
              </SelectItem>
            ))}
            {live && !pairs.length && (
              <SelectItem value="unavailable" disabled>
                No RWA pairs available
              </SelectItem>
            )}
            {!live && (
              <SelectItem value="status" disabled>
                {loading ? 'Loading catalog…' : 'Live catalog unavailable'}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
