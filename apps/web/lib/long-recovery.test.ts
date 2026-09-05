import test from 'node:test';
import assert from 'node:assert/strict';
import { watchLaunch, validateLaunchStatus } from './long-recovery.ts';
import { LaunchError } from './long-wallet.ts';
const recovery = { id: 'a'.repeat(64), binding: 'b'.repeat(64), hash: null };
const hash = `0x${'c'.repeat(64)}`;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
void test('refresh recovery only reads, discovers hashes automatically, and stops on confirmation', async () => {
  const callbacks: Array<() => void> = [], results: string[] = [], operations: string[] = [];
  let step = 0;
  const stop = watchLaunch(recovery, (r) => results.push(r.status), (e) => { throw e; }, async (operation) => {
    operations.push(operation);
    return { id: recovery.id, status: step++ ? 'confirmed' : 'submitted', hash, asset: `0x${'d'.repeat(40)}`, paidGasWei: '1' };
  }, (fn) => { callbacks.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; });
  await flush(); callbacks.shift()!(); await flush();
  assert.deepEqual(results, ['submitted', 'confirmed']);
  assert.deepEqual(operations, ['launch-status', 'launch-status']);
  assert.equal(callbacks.length, 0); stop();
});
void test('unused nonce enables a user retry without automatically opening the wallet', async () => {
  let status = '', scheduled = false;
  watchLaunch(recovery, (r) => { status = r.status; }, (e) => { throw e; }, async () => ({ id: recovery.id, status: 'retryable' }),
    () => { scheduled = true; return 0 as unknown as ReturnType<typeof setTimeout>; });
  await flush(); assert.equal(status, 'retryable'); assert.equal(scheduled, false);
});
void test('polling respects actual service cooldown and ignores results after unmount', async () => {
  let delay = 0;
  const stop = watchLaunch(recovery, () => {}, () => {}, async () => { throw new LaunchError('rate_limited', 90); },
    (_fn, ms) => { delay = ms; return 0 as unknown as ReturnType<typeof setTimeout>; });
  await flush(); assert.equal(delay, 90000); stop();
  let delivered = false;
  const cancel = watchLaunch(recovery, () => { delivered = true; }, () => {}, async () => ({ id: recovery.id, status: 'retryable' }));
  cancel(); await flush(); assert.equal(delivered, false);
});
void test('a hash alone, mismatched recovery and incomplete receipt cannot declare success', () => {
  for (const value of [{ id: recovery.id, status: 'confirmed', hash }, { id: 'wrong', status: 'retryable' },
    { id: recovery.id, status: 'confirmed', hash, paidGasWei: '1', asset: 'bad' }])
    assert.throws(() => validateLaunchStatus(value, recovery));
  assert.throws(() => validateLaunchStatus({ id: recovery.id, status: 'submitted', hash }, { ...recovery, hash: `0x${'e'.repeat(64)}` }));
});
