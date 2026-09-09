import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimQueueItems,
  claimQueueActivities,
  queueClaimAttempt,
  reconcileClaimQueue,
  startClaimQueue,
} from './claim-queue.ts';
import type { ClaimQuote, FeeSource } from './fee-service.ts';
import type { ClaimActivity } from './claim-wallet.ts';
import { runClaimAction } from './claim-action.ts';
import { HIGH_NETWORK_FEE_WEI } from './launch-cost.ts';

const address = (value: string) => `0x${value.repeat(40)}`;
const source = (id = 'a'.repeat(64)): FeeSource => ({
  address: address('1'),
  chainId: 8453,
  padId: 'o1',
  status: 'ready',
  positions: [
    {
      id,
      target: address('2'),
      payouts: [
        {
          asset: address('3'),
          symbol: 'TEST',
          decimals: 18,
          claimableRaw: '100',
        },
      ],
      verification: 'live',
      claimable: true,
    },
  ],
  expiresAt: 10_000,
});
const quote = (value = source()): ClaimQuote => ({
  positionId: value.positions[0].id,
  address: value.address,
  chainId: value.chainId,
  kind: value.padId,
  target: value.positions[0].target,
  payouts: value.positions[0].payouts,
  data: '0x',
  value: '0',
  gas: '21000',
  gasPrice: '1',
  estimatedWei: '21000',
  budgetWei: '25200',
  l1FeeWei: '0',
  operatorFeeWei: '0',
  expiresAt: 20_000,
});

function clickFixture() {
  const queue = startClaimQueue([source()]);
  const prepared = { ...quote(), expiresAt: performance.now() + 20_000 };
  const calls: string[] = [];
  let current = true;
  const options = {
    queue, quote: null as ClaimQuote | null, address: queue.items[0].source.address,
    isCurrent: () => current,
    ensureChain: async () => { calls.push('network'); },
    prepare: async () => { calls.push('prepare'); return prepared; },
    onPrepared: () => { calls.push('estimate'); },
    onAttempt: () => { calls.push('attempt'); },
    send: async () => { calls.push('wallet'); return '0x123'; },
  };
  return { options, prepared, calls, cancel: () => { current = false; } };
}

await test('one claim action prepares and opens the wallet exactly once', async () => {
  const f = clickFixture();
  await runClaimAction(f.options);
  assert.deepEqual(f.calls, ['network', 'prepare', 'estimate', 'attempt', 'wallet']);
});

await test('account changes during network selection or preparation never open the wallet', async () => {
  for (const stage of ['network', 'prepare']) {
    const f = clickFixture();
    if (stage === 'network') f.options.ensureChain = async () => { f.cancel(); };
    else f.options.prepare = async () => { f.cancel(); return f.prepared; };
    await runClaimAction(f.options);
    assert.ok(!f.calls.includes('wallet'));
    assert.ok(!f.calls.includes('attempt'));
  }
});

await test('expired estimates refresh in the same claim action and mismatched quotes never send', async () => {
  const f = clickFixture();
  f.options.quote = { ...f.prepared, expiresAt: 0 };
  await runClaimAction(f.options);
  assert.equal(f.calls.filter((call) => call === 'wallet').length, 1);
  assert.ok(f.calls.includes('prepare'));
  const mismatch = clickFixture();
  mismatch.options.quote = { ...mismatch.prepared, positionId: 'f'.repeat(64) };
  await assert.rejects(runClaimAction(mismatch.options), /does not match/);
  assert.ok(!mismatch.calls.includes('wallet'));
});

await test('high gas pauses inline and only a second explicit action sends the reviewed quote', async () => {
  const f = clickFixture();
  f.prepared.estimatedWei = HIGH_NETWORK_FEE_WEI.toString();
  await runClaimAction(f.options);
  assert.deepEqual(f.calls, ['network', 'prepare', 'estimate']);
  f.options.quote = f.prepared;
  await runClaimAction(f.options);
  assert.equal(f.calls.filter((call) => call === 'wallet').length, 1);
});

await test('wallet rejection is surfaced without retrying or sending the next queue item', async () => {
  const f = clickFixture();
  f.options.queue = startClaimQueue([source(), source('b'.repeat(64))]);
  let writes = 0;
  f.options.send = async () => { writes++; throw new Error('Rejected'); };
  await assert.rejects(runClaimAction(f.options), /Rejected/);
  assert.equal(writes, 1);
});

await test('queues unique verified positive positions and counts a two-coin pool once', () => {
  const good = source();
  good.positions[0].payouts.push({
    asset: address('4'),
    symbol: 'PAIR',
    decimals: 18,
    claimableRaw: '200',
  });
  const indexed = source('b'.repeat(64));
  indexed.positions[0].verification = 'indexed';
  const zero = source('c'.repeat(64));
  zero.positions[0].payouts[0].claimableRaw = '0';
  const disabled = source('d'.repeat(64));
  disabled.positions[0].claimable = false;
  const unavailable = source('e'.repeat(64));
  unavailable.status = 'unavailable';
  assert.equal(
    claimQueueItems([good, good, indexed, zero, disabled, unavailable]).length,
    1,
  );
  assert.equal(startClaimQueue([indexed, zero]).status, 'complete');
});

await test('launchpad claim all includes only the selected launchpad across its fee sources', () => {
  const o1Base = source();
  const o1Robinhood = { ...source('b'.repeat(64)), chainId: 4663 as const };
  const long = {
    ...source('c'.repeat(64)),
    chainId: 4663 as const,
    padId: 'long' as const,
  };
  const longbow = {
    ...source('d'.repeat(64)),
    chainId: 4663 as const,
    padId: 'longbow' as const,
  };
  const all = [o1Base, long, o1Robinhood, longbow];
  const o1Queue = startClaimQueue(all, 'o1');
  assert.deepEqual(
    o1Queue.items.map((item) => item.source),
    [o1Base, o1Robinhood],
  );
  assert.deepEqual(
    startClaimQueue(all, 'long').items.map((item) => item.source),
    [long],
  );
  assert.equal(startClaimQueue([long], 'o1').status, 'complete');
  assert.deepEqual(
    startClaimQueue(all, 'longbow').items.map((item) => item.source),
    [longbow],
  );
  assert.throws(() =>
    queueClaimAttempt(startClaimQueue(all, 'longbow'), quote(long)),
  );
  assert.throws(() => queueClaimAttempt(o1Queue, quote(long)));
});

await test('does not advance on submitted transactions, unrelated receipts, or old attempts', () => {
  const queue = queueClaimAttempt(startClaimQueue([source()]), quote());
  assert.equal(reconcileClaimQueue(queue, []), queue);
  assert.equal(
    reconcileClaimQueue(queue, [{ quote: quote(), status: 'submitted' }]),
    queue,
  );
  assert.equal(
    reconcileClaimQueue(queue, [
      { quote: { ...quote(), expiresAt: 10 }, status: 'confirmed' },
    ]),
    queue,
  );
  assert.equal(
    reconcileClaimQueue(queue, [
      { quote: { ...quote(), address: address('9') }, status: 'confirmed' },
    ]),
    queue,
  );
  assert.equal(
    reconcileClaimQueue(queue, [
      { quote: { ...quote(), chainId: 4663 }, status: 'confirmed' },
    ]),
    queue,
  );
});

await test('only a confirmed current payout unlocks preparation of the next item', () => {
  const second = source('b'.repeat(64));
  const queue = queueClaimAttempt(startClaimQueue([source(), second]), quote());
  const afterFirst = reconcileClaimQueue(queue, [
    { quote: quote(), status: 'confirmed' },
  ]);
  assert.equal(afterFirst.status, 'ready');
  assert.equal(afterFirst.index, 1);
  assert.equal(afterFirst.attempt, undefined);
  assert.throws(() => queueClaimAttempt(afterFirst, quote()));
  const last = queueClaimAttempt(afterFirst, quote(second));
  const done = reconcileClaimQueue(last, [
    { quote: quote(second), status: 'confirmed' },
  ]);
  assert.equal(done.status, 'complete');
  assert.equal(done.index, 2);
  assert.throws(() => queueClaimAttempt(done, quote(second)));
});

await test('failed and uncertain outcomes stop the queue without skipping or retrying', () => {
  for (const status of [
    'failed',
    'uncertain',
    'no_payout',
    'reviewed',
  ] as ClaimActivity['status'][]) {
    const queue = queueClaimAttempt(
      startClaimQueue([source(), source('b'.repeat(64))]),
      quote(),
    );
    const stopped = reconcileClaimQueue(queue, [{ quote: quote(), status }]);
    assert.equal(stopped.status, 'paused');
    assert.equal(stopped.index, 0);
    assert.throws(() => queueClaimAttempt(stopped, quote()));
  }
});

await test('queue attempts stay bound to the expected wallet, chain, source and position', () => {
  const queue = startClaimQueue([source()]);
  for (const altered of [
    { address: address('9') },
    { chainId: 4663 as const },
    { kind: 'long' as const },
    { positionId: 'f'.repeat(64) },
  ])
    assert.throws(() => queueClaimAttempt(queue, { ...quote(), ...altered }));
});

await test('queue status keeps its own receipts and never takes an older same-position activity', () => {
  const first = quote();
  const old: ClaimActivity = { quote: { ...first }, status: 'confirmed' };
  const pending: ClaimActivity = { quote: first, status: 'submitted' };
  const started = startClaimQueue([source(), source('b'.repeat(64))]);
  assert.deepEqual(claimQueueActivities(started, [old]), []);
  const waiting = queueClaimAttempt(started, first);
  assert.deepEqual(claimQueueActivities(waiting, [old, pending]), [pending]);
  const paid: ClaimActivity = { ...pending, status: 'confirmed' };
  const advanced = reconcileClaimQueue(waiting, [paid]);
  assert.deepEqual(claimQueueActivities(advanced, [old, paid]), [paid]);
  const second = quote(source('b'.repeat(64)));
  const next: ClaimActivity = { quote: second, status: 'submitted' };
  const continuing = queueClaimAttempt(advanced, second);
  assert.deepEqual(claimQueueActivities(continuing, [old, paid, next]), [
    paid,
    next,
  ]);
  assert.deepEqual(
    claimQueueActivities(startClaimQueue([source()]), [paid, next]),
    [],
  );
});
