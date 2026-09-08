import { isAddress, zeroAddress } from 'viem';
import { ServiceError } from './errors.mjs';
const validAddress = v => typeof v === 'string' && isAddress(v) && v.toLowerCase() !== zeroAddress;
export function stonksCoins(body) {
  const fail = () => { throw new ServiceError('invalid_response'); };
  if (!body || !Array.isArray(body.coins) || body.coins.length > 5000) fail();
  const seen = new Set();
  return body.coins.map(c => {
    if (!c || ![c.token, c.creator, c.quote, c.pool, c.fee_locker].every(validAddress) || !/^\d{1,30}$/.test(c.token_id)
      || seen.has(c.token.toLowerCase())) fail();
    seen.add(c.token.toLowerCase());
    return c;
  });
}
