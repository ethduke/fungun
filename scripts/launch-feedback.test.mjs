import test from 'node:test';
import assert from 'node:assert/strict';
import { launchFeedback, emptyLaunchFeedback } from '../apps/web/lib/launch-feedback.ts';
import { LaunchError, LaunchPreflightError } from '../apps/web/lib/long-wallet.ts';

const funding = { chainId: 4663, balanceWei: '100000000000000', requiredWei: '900000000000000', shortfallWei: '800000000000000', basis: 'simulation' };
test('gas warning and amounts survive retries, successful status reads and unrelated read failures', () => {
  let state = launchFeedback(emptyLaunchFeedback, { type: 'failure', error: new LaunchPreflightError(new LaunchError('insufficient_funds', 0, funding)) });
  const message = state.fundingError;
  assert.match(message, /You have 0.0001 ETH/);
  assert.match(message, /needs 0.0009 ETH/);
  for (const action of [{ type: 'clear-error' }, { type: 'failure', error: new LaunchError('rate_limited') }, { type: 'clear-error' }]) {
    state = launchFeedback(state, action);
    assert.equal(state.fundingError, message);
  }
  state = launchFeedback(state, { type: 'funding-verified' });
  assert.deepEqual(state, emptyLaunchFeedback);
});
test('a newer shortage replaces the old balance; generic insufficient funds also stays visible', () => {
  let state = launchFeedback(emptyLaunchFeedback, { type: 'failure', error: new LaunchError('insufficient_funds', 0, funding) });
  state = launchFeedback(state, { type: 'failure', error: new LaunchError('insufficient_funds', 0, { ...funding, balanceWei: '200000000000000', shortfallWei: '700000000000000' }) });
  assert.match(state.fundingError, /You have 0.0002 ETH/);
  state = launchFeedback(state, { type: 'failure', error: new LaunchError('insufficient_funds') });
  assert.match(state.fundingError, /needs more ETH/);
  assert.equal(launchFeedback(state, { type: 'clear-error' }).fundingError, state.fundingError);
});
