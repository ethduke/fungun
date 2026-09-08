import assert from 'node:assert/strict';
import test from 'node:test';
import { mineLongSalt, mineLongSaltAsync } from '../../web/lib/long-encoding/long-salt.mjs';
import { getCreate2Address } from 'viem';

const factory = { address: `0x${'12'.repeat(20)}`, initCodeHash: `0x${'34'.repeat(32)}` };
const numeraire = `0x${'ff'.repeat(20)}`;

test('native ETH mines a suffix-bearing asset above currency0 and verifies the supplied attempt', async () => {
  const native = `0x${'00'.repeat(20)}`, binding = 'native-eth';
  const result = await mineLongSaltAsync(factory, native, binding);
  assert.match(result.predictedAsset, /1e18$/i);
  assert.ok(BigInt(result.predictedAsset) > 0n);
  assert.equal(getCreate2Address({ from: factory.address, salt: result.salt, bytecodeHash: factory.initCodeHash }), result.predictedAsset);
  assert.deepEqual(mineLongSalt(factory, native, binding, result.saltAttempt), result);
  assert.throws(() => mineLongSalt(factory, `0x${'00'.repeat(19)}01`, binding), /long_salt_unavailable/);
});

test('interrupted searches resume until they match an uninterrupted independently verified search', async () => {
  const reference = await import('../../web/lib/long-encoding/long-salt.mjs?reference');
  for (const binding of ['a'.repeat(64), 'b'.repeat(64)]) {
    const expected = reference.mineLongSalt(factory, numeraire, binding);
    assert.ok(expected.saltAttempt > 4096, 'fixture must require multiple search slices');
    let slices = 0;
    let result;
    const interrupted = new Error('request slice ended');
    while (!result && slices < 740) {
      let checks = 0;
      try {
        result = await mineLongSaltAsync(factory, numeraire, binding, () => {
          if (++checks > 1) throw interrupted;
        });
      } catch (error) { assert.equal(error, interrupted); }
      slices++;
    }
    assert.deepEqual(result, expected);
    assert.equal(slices, Math.floor(expected.saltAttempt / 4096) + 1);
    assert.equal(getCreate2Address({ from: factory.address, salt: result.salt,
      bytecodeHash: factory.initCodeHash }), result.predictedAsset);
    assert.match(result.predictedAsset, /1e18$/i);
    assert.ok(BigInt(result.predictedAsset) < BigInt(numeraire));
    assert.deepEqual(mineLongSalt(factory, numeraire, binding, result.saltAttempt), result);
    assert.throws(() => mineLongSalt(factory, numeraire, binding, -1), /invalid_long_salt/);
  }
});

test('a cancelled overlapping search cannot erase a completed search', async () => {
  const binding = 'c'.repeat(64);
  let complete;
  const interrupted = new Error('cancelled');
  let checks = 0;
  await assert.rejects(mineLongSaltAsync(factory, numeraire, binding, () => {
    if (++checks === 2) {
      complete = mineLongSalt(factory, numeraire, binding);
      throw interrupted;
    }
  }), error => error === interrupted);
  assert.ok(complete);
  let resumedChecks = 0;
  assert.deepEqual(await mineLongSaltAsync(factory, numeraire, binding, () => { resumedChecks++; }), complete);
  assert.equal(resumedChecks, 1);
});
