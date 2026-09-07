import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from './config.mjs';
import { readRuntimeFeeContracts, reviewedO1FeeProfiles } from './o1-fee-profiles.mjs';

test('runtime covers every published Robinhood suite without enabling reads or claims', () => {
  const config = readConfig({});
  assert.equal(config.feesEnabled, false);
  assert.equal(config.claimsEnabled, false);
  assert.equal(config.feeContracts.o1.length, 5);
  assert.equal(config.feeContracts.o1.filter(p => p.version === 'legacy').length, 4);
  assert.ok(config.feeContracts.o1.every(p => p.chainId === 4663));
});

test('existing partial runtime lists gain missing suites without replacing operator pins', () => {
  const changed = { ...reviewedO1FeeProfiles[4], codeHash: `0x${'f'.repeat(64)}` };
  const base = { ...reviewedO1FeeProfiles[0], chainId: 8453 };
  const config = readRuntimeFeeContracts(JSON.stringify({ o1: [reviewedO1FeeProfiles[3], changed, base] }));
  assert.equal(config.o1.length, 6);
  assert.deepEqual(config.o1.find(p => p.escrow === changed.escrow), changed);
  assert.deepEqual(config.o1.find(p => p.chainId === 8453), base);
  assert.equal(config.o1.filter(p => p.escrow === changed.escrow).length, 1);
});

test('runtime defaults do not hide invalid operator configuration', () => {
  for (const raw of ['invalid', JSON.stringify({ o1: [{ ...reviewedO1FeeProfiles[0], version: 'auto' }] }),
    JSON.stringify({ o1: [reviewedO1FeeProfiles[0], reviewedO1FeeProfiles[0]] })])
    assert.throws(() => readRuntimeFeeContracts(raw), { code: 'invalid_fee_configuration' });
});
