'use client';

import { ArrowUpRight, LockKeyhole } from 'lucide-react';
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
  chainName,
  type Destination,
  type PairId,
} from '@/lib/launch-model';

export function LaunchpadCard({
  destination,
  onChange,
}: {
  destination: Destination;
  onChange: (destination: Destination) => void;
}) {
  const pad = destination;
  const long = pad.id === 'long';
  const title = long ? 'Long' : 'O1';
  return (
    <div className={`launchpad-card ${pad.selected ? 'is-selected' : ''}`}>
      <label className="launchpad-top">
        <span className={`pad-logo ${pad.id}`}>
          {long ? <ArrowUpRight size={25} /> : 'o1'}
        </span>
        <span className="pad-title">
          <strong>{title}</strong>
          <span>
            {long ? 'RWA-paired launches' : 'Standard & RWA launches'}
          </span>
        </span>
        <Checkbox
          checked={pad.selected}
          onCheckedChange={(selected) => onChange({ ...pad, selected })}
          aria-label={`Select ${title}`}
        />
      </label>
      {pad.selected ? (
        <div className="pad-options">
          <div className="option-row">
            <span id={`${pad.id}-chain-label`}>Network</span>
            <Select
              value={String(pad.chainId)}
              onValueChange={(value) => {
                if (value === '4663' || (!long && value === '8453'))
                  onChange({ ...pad, chainId: Number(value) as 4663 | 8453 });
              }}
            >
              <SelectTrigger
                aria-labelledby={`${pad.id}-chain-label`}
                className="option-select"
              >
                <SelectValue>{chainName(pad.chainId)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="4663">Robinhood Chain</SelectItem>
                {!long && <SelectItem value="8453">Base</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {!long && (
            <div className="option-row">
              <span id="o1-route-label">Launch route</span>
              <Select
                value={pad.route}
                onValueChange={(route) => {
                  if (route === 'standard' || route === 'rwa')
                    onChange({
                      ...pad,
                      route,
                      pairId: route === 'standard' ? 'native' : 'sample-nvda',
                    });
                }}
              >
                <SelectTrigger
                  aria-labelledby="o1-route-label"
                  className="option-select"
                >
                  <SelectValue>
                    {pad.route === 'rwa' ? 'RWA-paired' : 'Native / standard'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Native / standard</SelectItem>
                  <SelectItem value="rwa">RWA-paired</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {pad.route === 'rwa' && (
            <div className="option-row">
              <span id={`${pad.id}-pair-label`}>Paired with</span>
              <Select
                value={pad.pairId}
                onValueChange={(value) => {
                  if (SAMPLE_PAIRS.some((pair) => pair.id === value))
                    onChange({ ...pad, pairId: value as PairId });
                }}
              >
                <SelectTrigger
                  aria-labelledby={`${pad.id}-pair-label`}
                  className="option-select"
                >
                  <SelectValue>
                    <span className="stock-dot" />
                    {
                      SAMPLE_PAIRS.find((pair) => pair.id === pad.pairId)
                        ?.symbol
                    }
                    <span className="sample-tag">sample</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SAMPLE_PAIRS.map((pair) => (
                    <SelectItem key={pair.id} value={pair.id}>
                      {pair.symbol} · {pair.label} (sample)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {pad.route === 'rwa' && (
            <p className="sample-note">
              Illustrative catalog. Live eligibility is not connected.
            </p>
          )}
          {!long && (
            <label className="metadata-option" htmlFor="o1-editable-metadata">
              <Checkbox
                id="o1-editable-metadata"
                checked={pad.editableMetadata}
                onCheckedChange={(editableMetadata) =>
                  onChange({ ...pad, editableMetadata })
                }
              />
              Allow metadata updates
            </label>
          )}
          {long && (
            <div className="immutable-note">
              <LockKeyhole size={12} />
              Metadata is permanent after launch.
            </div>
          )}
        </div>
      ) : (
        <div className="pad-meta">
          <span className="network-dot" />
          {long ? 'Robinhood Chain' : 'Robinhood Chain / Base'}
          <span className="meta-divider" />
          {long ? 'Immutable metadata' : 'Flexible pairing'}
        </div>
      )}
    </div>
  );
}
