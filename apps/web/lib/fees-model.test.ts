import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFeePreview,
  feeQueryState,
  groupFeeBalances,
  normalizeFeeAddress,
  type FeeBalance,
} from './fees-model.ts';

const address = (digit: string) => `0x${digit.repeat(40)}`;

await test('fee lookups require a complete valid nonzero wallet address', () => {
  for (const input of [
    '',
    'person.eth',
    'not an address',
    '0x123',
    address('0'),
    `0x${'a'.repeat(64)}`,
  ]) {
    assert.equal(normalizeFeeAddress(input), null);
    assert.throws(() => createFeePreview(input));
  }
  assert.equal(normalizeFeeAddress(` ${address('a')} `), address('a'));
});

await test('fee address changes never reuse another address result', () => {
  const result = createFeePreview(address('a'));
  assert.equal(feeQueryState('', result), 'idle');
  assert.equal(feeQueryState('0x12', result), 'invalid');
  assert.equal(feeQueryState(address('b'), result), 'loading');
  assert.equal(feeQueryState(address('a'), result), 'unavailable');
});

await test('preview fee lookups never request RPC, invent zero balances or enable claims', () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('No network allowed.');
  };
  try {
    const result = createFeePreview(address('a'));
    assert.equal(result.mode, 'preview');
    assert.equal(result.claimsEnabled, false);
    assert.deepEqual(result.balances, []);
    assert.deepEqual(result.unavailableSources, [
      { padId: 'long', chainId: 4663 },
      { padId: 'o1', chainId: 4663 },
      { padId: 'longbow', chainId: 4663 },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

const balance: FeeBalance = {
  padId: 'long',
  chainId: 4663,
  asset: address('b'),
  symbol: 'COIN',
  decimals: 18,
  claimableRaw: '1000000000000000001',
};

await test('fees group across launchpads by network and asset, with exact amounts', () => {
  const rows = groupFeeBalances([balance, { ...balance, padId: 'o1' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claimable, '2.000000000000000002');
  assert.deepEqual(rows[0].launchpads, ['long', 'o1']);
});

await test('matching tickers never merge different assets, chains or native and wrapped coins', () => {
  const rows = groupFeeBalances([
    balance,
    { ...balance, asset: address('c') },
    { ...balance, padId: 'o1', chainId: 8453 },
    { ...balance, asset: 'native' },
  ]);
  assert.equal(rows.length, 4);
});

await test('Longbow fees preserve launchpad identity and only support Robinhood', () => {
  const rows = groupFeeBalances([{ ...balance, padId: 'longbow' }]);
  assert.deepEqual(rows[0].launchpads, ['longbow']);
  assert.equal(rows[0].claimable, '1.000000000000000001');
  assert.throws(() =>
    groupFeeBalances([{ ...balance, padId: 'longbow', chainId: 8453 }]),
  );
});

await test('malformed amounts and conflicting asset metadata are rejected', () => {
  for (const claimableRaw of ['-1', '1.5', 'Infinity', '1e18'])
    assert.throws(() => groupFeeBalances([{ ...balance, claimableRaw }]));
  assert.throws(() => groupFeeBalances([balance, { ...balance, decimals: 6 }]));
  assert.throws(() => groupFeeBalances([{ ...balance, chainId: 8453 }]));
  const overflow = BigInt(1) << BigInt(256);
  assert.throws(() =>
    groupFeeBalances([{ ...balance, claimableRaw: overflow.toString() }]),
  );
  assert.throws(() =>
    groupFeeBalances([
      { ...balance, claimableRaw: (overflow - BigInt(1)).toString() },
      balance,
    ]),
  );
});

await test('native currency aliases merge without merging the wrapped asset', () => {
  const rows = groupFeeBalances([
    { ...balance, asset: 'native' },
    { ...balance, asset: address('0') },
    balance,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].claimable, '2.000000000000000002');
  assert.equal(rows[1].claimable, '1.000000000000000001');
});
