import { bytesToHex, getAddress, hexToBytes, keccak256, toBytes } from 'viem';
import { ServiceError } from './errors.mjs';

export const LONG_SALT_ATTEMPTS = 3_000_000;
export function isCanonicalLongAsset(address) {
  return typeof address === 'string' && /^0x[a-f0-9]{36}1e18$/i.test(address);
}
const cache = new Map();

// Bind the first 28 salt bytes to the launch context; enumerate with the last
// four. Hash bytes directly, avoiding per-candidate hex/checksum allocations.
function search(factory, numeraire, binding, suppliedAttempt) {
  if (BigInt(numeraire) <= 0x1e18n) throw new ServiceError('long_salt_unavailable');
  if (suppliedAttempt !== undefined && (!Number.isInteger(suppliedAttempt)
    || suppliedAttempt < 0 || suppliedAttempt >= LONG_SALT_ATTEMPTS))
    throw new ServiceError('invalid_long_salt');
  const bytes = new Uint8Array(85);
  bytes[0] = 255;
  bytes.set(hexToBytes(factory.address), 1);
  bytes.set(keccak256(toBytes(`fungun:long:canonical:2:${binding}`), 'bytes'), 21);
  bytes.set(hexToBytes(factory.initCodeHash), 53);
  const view = new DataView(bytes.buffer);
  const quote = hexToBytes(numeraire);
  const key = `${factory.address}:${factory.initCodeHash}:${numeraire}:${binding}`;
  const known = suppliedAttempt ?? cache.get(key)?.saltAttempt;
  const start = known ?? 0, end = known === undefined ? LONG_SALT_ATTEMPTS : known + 1;
  function* candidates() {
    for (let attempt = start; attempt < end; attempt++) {
      view.setUint32(49, attempt);
      const digest = keccak256(bytes, 'bytes');
      if (digest[30] === 0x1e && digest[31] === 0x18) {
        let lower = false;
        for (let i = 0; i < 20; i++) {
          if (digest[i + 12] !== quote[i]) { lower = digest[i + 12] < quote[i]; break; }
        }
        if (lower) {
          const result = { salt: bytesToHex(bytes.slice(21, 53)), predictedAsset: getAddress(bytesToHex(digest.slice(12))), saltAttempt: attempt };
          if (cache.size >= 64) cache.delete(cache.keys().next().value);
          cache.set(key, result);
          return result;
        }
      }
      if ((attempt - start + 1) % 4096 === 0) yield;
    }
    throw new ServiceError(known === undefined ? 'long_salt_unavailable' : 'invalid_long_salt');
  }
  return candidates();
}

export function mineLongSalt(factory, numeraire, binding, suppliedAttempt) {
  const iterator = search(factory, numeraire, binding, suppliedAttempt);
  for (;;) { const next = iterator.next(); if (next.done) return next.value; }
}

export async function mineLongSaltAsync(factory, numeraire, binding, check = () => {}) {
  const iterator = search(factory, numeraire, binding);
  for (;;) {
    check();
    const next = iterator.next();
    if (next.done) return next.value;
    // Keep health checks and other API requests responsive while mining.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
