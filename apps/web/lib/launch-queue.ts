import { launchpadName, type LaunchpadId } from './launch-model.ts';

export type LaunchQueue = { confirmed: LaunchpadId[]; running: boolean; started: LaunchpadId | null };
export type LaunchQueueAction =
  | { type: 'start' | 'confirmed'; pad: LaunchpadId }
  | { type: 'pause' };

export const emptyLaunchQueue: LaunchQueue = { confirmed: [], running: false, started: null };

export function updateLaunchQueue(queue: LaunchQueue, action: LaunchQueueAction): LaunchQueue {
  if (action.type === 'pause') return queue.running ? { ...queue, running: false } : queue;
  if (action.type === 'confirmed') return queue.confirmed.includes(action.pad) ? queue
    : { ...queue, confirmed: [...queue.confirmed, action.pad] };
  return { ...queue, running: true, started: action.pad };
}

export function launchQueueStep(pads: LaunchpadId[], queue: LaunchQueue) {
  const remaining = pads.filter(pad => !queue.confirmed.includes(pad));
  const current = remaining[0];
  return {
    current,
    autoStart: !!current && queue.running && queue.started !== current,
    label: pads.length > 1
      ? `Launch on ${(queue.running ? remaining.slice(0, 1) : remaining).map(launchpadName).join(' / ')}`
      : 'Launch coin',
  };
}
