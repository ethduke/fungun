import { sha256, toBytes } from 'viem';
import { normalizeLaunchDetails } from './launch-metadata.mjs';

// Keep O1's native ERC-7572 document separate from the shared publication
// schema, preserving existing signed artwork approvals and recovery records.
export function o1Metadata(draft, imageCid) {
  const { name, ticker, description } = normalizeLaunchDetails(draft);
  if (draft.launchpad || !/^b[a-z2-7]{58}$/.test(imageCid)) throw new Error('invalid_o1_metadata');
  const bytes = new TextEncoder().encode(JSON.stringify({ name, symbol: ticker, description,
    standard: 'ERC20', launchpad: 'o1 Launchpad', launchpadUrl: 'https://launch.o1.exchange', image: `ipfs://${imageCid}` }));
  // Bounded JSON fits one raw IPFS leaf: CIDv1/raw/sha2-256.
  if (bytes.length > 262144) throw new Error('invalid_o1_metadata');
  const cidBytes = new Uint8Array([1, 0x55, 0x12, 0x20, ...toBytes(sha256(bytes))]);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let encoded = 'b', bits = 0, value = 0;
  for (const byte of cidBytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; encoded += alphabet[(value >>> bits) & 31]; }
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return { bytes, uri: `ipfs://${encoded}` };
}
