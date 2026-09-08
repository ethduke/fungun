import { createHash } from 'node:crypto';
import { isAddress, zeroAddress } from 'viem';
import { ServiceError } from './errors.mjs';

export const launchpadForPair = pair => typeof pair === 'string' && pair.startsWith('stonx-') ? 'stonx' : pair === 'pons-native' ? 'pons' : typeof pair === 'string' && pair.startsWith('stonks-') ? 'stonks'
  : typeof pair === 'string' && pair.startsWith('longbow-') ? 'longbow'
  : typeof pair === 'string' && pair.startsWith('long-') ? 'long' : 'o1';
export const launchPairId = (pad, token) => pad === 'o1'
  ? `rwa-${createHash('sha256').update(`4663:${token.address.toLowerCase()}`).digest('hex').slice(0, 24)}`
  : `${pad}-${token.symbol}`;
export function readLaunchTokens(env) {
  if (!env.ROBINHOOD_LAUNCH_TOKENS_JSON) return [];
  try {
    const tokens = JSON.parse(env.ROBINHOOD_LAUNCH_TOKENS_JSON);
    if (!Array.isArray(tokens) || !tokens.length || tokens.length > 512
      || tokens.some(t => !t || Object.keys(t).sort().join(',') !== 'address,symbol'
        || typeof t.symbol !== 'string' || !/^[A-Z0-9._-]{1,24}$/.test(t.symbol)
        || !isAddress(t.address) || t.address.toLowerCase() === zeroAddress)
      || new Set(tokens.map(t => t.symbol)).size !== tokens.length
      || new Set(tokens.map(t => t.address.toLowerCase())).size !== tokens.length) throw Error();
    return tokens.map(t => ({ symbol: t.symbol, address: t.address.toLowerCase() }));
  } catch { throw new ServiceError('long_configuration', 503); }
}
