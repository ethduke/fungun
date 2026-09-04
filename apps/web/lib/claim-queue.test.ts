import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimQueueItems,
  queueClaimAttempt,
  reconcileClaimQueue,
  startClaimQueue,
} from './claim-queue.ts';
import type { ClaimQuote, FeeSource } from './fee-service.ts';
import type { ClaimActivity } from './claim-wallet.ts';

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

await test('only a confirmed current payout unlocks a fresh explicit review for the next item', () => {
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
