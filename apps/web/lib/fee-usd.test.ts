import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGasUsd, formatGasUsd } from './fee-usd.ts';

const now = 1_800_000_000_000;
const wei = '41630000000000';
const estimate = {
  amount: '0.10194583365',
  ethPrice: '2448.855',
  observedAt: now - 1000,
  source: 'coinbase',
};

await test('gas USD binds the arithmetic and server freshness to the local monotonic clock', () => {
  const parsed = parseGasUsd(estimate, wei, now, 500, 100);
  assert.equal(parsed?.expiresAt, 59_400);
  assert.equal(formatGasUsd(parsed, 1000), '≈ $0.10');
  assert.equal(formatGasUsd(parsed, 59_400), 'USD unavailable');
});

await test('unknown, malformed, stale and mismatched USD prices remain unavailable', () => {
  for (const invalid of [
    null,
    {},
    { ...estimate, source: 'unknown' },
    { ...estimate, ethPrice: '0' },
    { ...estimate, ethPrice: '-1' },
    { ...estimate, ethPrice: 'NaN' },
    { ...estimate, ethPrice: '1000000000' },
    { ...estimate, amount: '1' },
    { ...estimate, amount: '1e6' },
    { ...estimate, amount: '-0.1' },
    { ...estimate, observedAt: now - 60_000 },
    { ...estimate, observedAt: now + 1 },
  ]) {
    assert.equal(parseGasUsd(invalid, wei, now, 500, 100), null);
  }
  assert.equal(formatGasUsd(null, 0), 'USD unavailable');
});

await test('small positive gas does not round down to free and cents round correctly', () => {
  const rate = { ...estimate, ethPrice: '1', observedAt: now };
  const tiny = parseGasUsd(
    { ...rate, amount: '0.0001' },
    '100000000000000',
    now,
    100,
    0,
  );
  assert.equal(formatGasUsd(tiny, 100), '≈ <$0.01');
  const rounded = parseGasUsd(
    { ...rate, amount: '0.125' },
    '125000000000000000',
    now,
    100,
    0,
  );
  assert.equal(formatGasUsd(rounded, 100), '≈ $0.13');
  const zero = parseGasUsd({ ...rate, amount: '0' }, '0', now, 100, 0);
  assert.equal(formatGasUsd(zero, 100), '≈ $0.00');
});
