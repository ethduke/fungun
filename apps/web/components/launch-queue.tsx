'use client';

import { useReducer } from 'react';
import { LongLaunch, type LongCosts } from '@/components/long-launch';
import { emptyLaunchQueue, launchQueueStep, updateLaunchQueue } from '@/lib/launch-queue';
import { hasSharedTickerConflict, launchpadName, type Destination, type LaunchpadId } from '@/lib/launch-model';
import type { DraftImage } from '@/lib/launch-draft-cache';

// Key this component by the draft/account/selection, excluding wallet network:
// the intended network switch must not restart the queue.
export function LaunchQueue({ destinations, enabled, ready, tickerReserved, name, ticker, description, image, contextKey, onCosts }: {
  destinations: Destination[];
  enabled: boolean;
  ready: boolean;
  tickerReserved: boolean;
  name: string;
  ticker: string;
  description: string;
  image: DraftImage | null;
  contextKey: string;
  onCosts: (pad: LaunchpadId, costs: LongCosts) => void;
}) {
  const [queue, dispatch] = useReducer(updateLaunchQueue, emptyLaunchQueue);
  const step = launchQueueStep(destinations.map(pad => pad.id), queue);
  const conflicting = hasSharedTickerConflict(destinations);
  return <>
    {destinations.length > 1 && queue.started && step.current && (
      <p className="launch-disclosure" aria-live="polite">
        {queue.confirmed.length + 1} of {destinations.length} · {launchpadName(step.current)}
      </p>
    )}
    {destinations.map(pad => (
      <div key={pad.id} hidden={pad.id !== step.current && !queue.confirmed.includes(pad.id)}>
        <LongLaunch
          enabled={enabled}
          chainId={pad.chainId}
          ready={ready && !conflicting && (!['long', 'longbow'].includes(pad.id) || !tickerReserved)}
          pairId={pad.pairId}
          editableMetadata={pad.editableMetadata}
          showPadName={destinations.length > 1}
          buttonLabel={step.label}
          autoStart={pad.id === step.current && step.autoStart}
          locked={pad.id !== step.current}
          onStart={() => dispatch({ type: 'start', pad: pad.id })}
          onPause={() => dispatch({ type: 'pause' })}
          onConfirmed={() => dispatch({ type: 'confirmed', pad: pad.id })}
          autoShowSuccess={pad.id === destinations.at(-1)?.id}
          name={name} ticker={ticker} description={description} image={image}
          contextKey={contextKey}
          onCosts={costs => onCosts(pad.id, costs)}
        />
      </div>
    ))}
  </>;
}
