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
export function stonksFeedRows(coins, profile) {
  const quotes = new Map(profile.quotes.map(q => [q.token.toLowerCase(), q]));
  return coins.filter(c => c.fee_locker.toLowerCase() === profile.locker.address.toLowerCase() && quotes.has(c.quote.toLowerCase()))
    .filter(c => typeof c.name === 'string' && c.name.length <= 200 && typeof c.symbol === 'string' && c.symbol.length <= 24
      && /^\d{1,12}$/.test(c.created_at))
    .sort((a, b) => Number(b.created_at) - Number(a.created_at)).slice(0, 30).map(c => ({
      chain_id: 8453, launchpad: 'Stonks', version: 'v3', quote_kind: 'shares',
      pool: c.pool.toLowerCase(), meme: c.token.toLowerCase(), name: c.name, sym: c.symbol,
      quote_symbol: quotes.get(c.quote.toLowerCase()).symbol.replace(/c$/, ''), created_at: Number(c.created_at),
      total_in: null, swaps: null, trail: null,
    }));
}
