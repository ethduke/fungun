import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyLaunchQueue, launchQueueStep, updateLaunchQueue } from './launch-queue.ts';
import type { LaunchpadId } from './launch-model.ts';

const pads: LaunchpadId[] = ['long', 'o1', 'longbow'];

await test('one action names every selected pad and advances only after confirmation', () => {
  let queue = emptyLaunchQueue;
  assert.deepEqual(launchQueueStep(pads, queue), {
    current: 'long', autoStart: false, label: 'Launch on Long / O1 / Longbow',
  });
  queue = updateLaunchQueue(queue, { type: 'start', pad: 'long' });
  assert.deepEqual(launchQueueStep(pads, queue), {
    current: 'long', autoStart: false, label: 'Launch on Long',
  });
  queue = updateLaunchQueue(queue, { type: 'confirmed', pad: 'long' });
  assert.equal(launchQueueStep(pads, queue).current, 'o1');
  assert.equal(launchQueueStep(pads, queue).autoStart, true);
  queue = updateLaunchQueue(queue, { type: 'start', pad: 'o1' });
  assert.equal(launchQueueStep(pads, queue).autoStart, false);
  queue = updateLaunchQueue(queue, { type: 'confirmed', pad: 'o1' });
  assert.equal(launchQueueStep(pads, queue).current, 'longbow');
  assert.equal(launchQueueStep(pads, queue).autoStart, true);
  queue = updateLaunchQueue(queue, { type: 'confirmed', pad: 'longbow' });
  assert.equal(launchQueueStep(pads, queue).current, undefined);
  assert.equal(launchQueueStep(pads, queue).autoStart, false);
});

await test('failure/cancellation pauses on the same pad and retry does not relaunch confirmed pads', () => {
  let queue = updateLaunchQueue(emptyLaunchQueue, { type: 'start', pad: 'long' });
  queue = updateLaunchQueue(queue, { type: 'confirmed', pad: 'long' });
  queue = updateLaunchQueue(queue, { type: 'start', pad: 'o1' });
  queue = updateLaunchQueue(queue, { type: 'pause' });
  assert.deepEqual(launchQueueStep(pads, queue), {
    current: 'o1', autoStart: false, label: 'Launch on O1 / Longbow',
  });
  queue = updateLaunchQueue(queue, { type: 'start', pad: 'o1' });
  assert.equal(launchQueueStep(pads, queue).current, 'o1');
  assert.equal(launchQueueStep(pads, queue).autoStart, false);
});

await test('restored confirmations never auto-dispatch a wallet request', () => {
  const restored = updateLaunchQueue(emptyLaunchQueue, { type: 'confirmed', pad: 'long' });
  assert.equal(launchQueueStep(pads, restored).current, 'o1');
  assert.equal(launchQueueStep(pads, restored).autoStart, false);
  assert.equal(updateLaunchQueue(restored, { type: 'confirmed', pad: 'long' }), restored);
  assert.equal(launchQueueStep(['long'], emptyLaunchQueue).label, 'Launch coin');
  assert.equal(launchQueueStep([], emptyLaunchQueue).autoStart, false);
});
