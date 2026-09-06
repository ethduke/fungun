import assert from 'node:assert/strict';
import test from 'node:test';
import { claimLaunchSuccessNotice } from './launch-success.ts';

const transaction = (value: string) => `https://robinhoodchain.blockscout.com/tx/0x${value.repeat(64)}`;
function storage(values = new Map<string, string>()) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

void test('a confirmed launch auto-opens once across Fees navigation and hard refresh', () => {
  const persisted = new Map<string, string>();
  assert.equal(claimLaunchSuccessNotice(transaction('a'), storage(persisted)), true);
  // Each new reader represents a remounted form or a freshly loaded page.
  assert.equal(claimLaunchSuccessNotice(transaction('a'), storage(persisted)), false);
  assert.equal(claimLaunchSuccessNotice(transaction('a'), storage(persisted)), false);
});

void test('each newly confirmed transaction gets its own notice', () => {
  const saved = storage();
  assert.equal(claimLaunchSuccessNotice(transaction('a'), saved), true);
  assert.equal(claimLaunchSuccessNotice(transaction('b'), saved), true);
  assert.equal(claimLaunchSuccessNotice(transaction('a'), saved), false);
});

void test('transaction casing and repeated confirmation callbacks do not replay a notice', () => {
  const saved = storage();
  assert.equal(claimLaunchSuccessNotice(transaction('a'), saved), true);
  assert.equal(claimLaunchSuccessNotice(transaction('A'), saved), false);
});

void test('unavailable storage leaves success details manual instead of replaying popups', () => {
  const unavailable = () => { throw new Error('Storage unavailable'); };
  assert.equal(claimLaunchSuccessNotice(transaction('a'), { getItem: unavailable, setItem: unavailable }), false);
  assert.equal(claimLaunchSuccessNotice(transaction('a'), { getItem: () => null, setItem: unavailable }), false);
});
