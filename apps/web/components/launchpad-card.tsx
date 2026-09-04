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

export function LaunchpadCard({
  destination: pad,
  onChange,
}: {
  destination: Destination;
  onChange: (destination: Destination) => void;
}) {
  const long = pad.id === 'long';
  const title = long ? 'Long' : 'O1';
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
              SAMPLE_PAIRS.some((pair) => pair.id === value)
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
                : `${SAMPLE_PAIRS.find((pair) => pair.id === pad.pairId)?.symbol} (sample)`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {!long && <SelectItem value="native">Native / standard</SelectItem>}
            {SAMPLE_PAIRS.map((pair) => (
              <SelectItem key={pair.id} value={pair.id}>
                {pair.symbol} · {pair.label} (sample)
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
