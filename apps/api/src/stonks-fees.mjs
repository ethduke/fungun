import { stonksCoins } from './stonks-index.mjs';
import { encodeFunctionData, isAddress, zeroAddress } from 'viem';
import { STONKS_ABI } from '../../web/lib/long-encoding/stonks-launch.mjs';
import { stonksCall as call, sameStonksAddress as same, verifyStonks } from './stonks-live.mjs';
import { ServiceError } from './errors.mjs';

const fail = () => { throw new ServiceError('contract_unverified', 409); };
const addr = v => typeof v === 'string' && isAddress(v) && !same(v, zeroAddress);
export function stonksRecipientAmount(total, creator, splits, wallet) {
  if (!splits.length) return same(creator, wallet) ? total : 0n;
  if (splits.length > 20 || splits.some(s => !addr(s.to) || s.bps <= 0n)
    || splits.reduce((sum, s) => sum + s.bps, 0n) !== 10000n) fail();
  let remaining = total, owed = 0n;
  for (let i = 0; i < splits.length; i++) {
    const amount = i === splits.length - 1 ? remaining : total * splits[i].bps / 10000n;
    remaining -= amount;
    if (same(splits[i].to, wallet)) owed += amount;
  }
  return owed;
}

export class StonksFees {
  constructor(config, rpc, upstream, cache) { Object.assign(this, { config, rpc, upstream, cache }); }
  get profile() { return this.config.stonksLaunch?.profile; }
  async verify(block) {
    if (!this.profile) fail();
    const terms = await verifyStonks(this.rpc, this.profile, block);
    // A nonzero compounding share can fall back to the creator depending on
    // pool state. Do not label a guessed compounding result as claimable.
    if (terms.lpBps !== 0) fail();
    return terms;
  }
  position(address, payouts, mode, token) {
    const claimable = payouts.some(p => BigInt(p.claimableRaw) > 0n);
    const reason = !claimable ? 'nothing_to_claim' : !this.config.claimsEnabled ? 'claims_disabled'
      : !this.config.feeContracts?.baseOracle ? 'gas_oracle_not_configured' : null;
    return { address, chainId: 8453, kind: 'stonks', target: this.profile.locker.address, payouts,
      profileKey: JSON.stringify(this.profile), poolId: `${mode}:${token.toLowerCase()}`,
      collectionToken: token.toLowerCase(), claimMode: mode, verification: 'live', claimable: !reason,
      ...(reason ? { claimDisabledReason: reason } : {}) };
  }
  async asset(token, block) {
    const [symbol, decimals] = await this.rpc.calls(8453, [call(token, 'symbol'), call(token, 'decimals')], block);
    if (!/^[A-Za-z0-9._-]{1,24}$/.test(symbol) || decimals > 36) fail();
    return { asset: token.toLowerCase(), symbol, decimals };
  }
  async deferred(address, token, block) {
    const [amount] = await this.rpc.calls(8453, [call(this.profile.locker.address, 'claimable', [address, token])], block);
    if (!amount) return null;
    return this.position(address, [{ ...await this.asset(token, block), claimableRaw: amount.toString() }], 'claim', token);
  }
  async collection(address, token, block, terms) {
    const p = this.profile;
    const [info, ids, creator, quote, splits] = await this.rpc.calls(8453, [call(p.launcher.address, 'tokenInfo', [token]),
      call(p.locker.address, 'positionsOf', [token]), call(p.locker.address, 'tokenCreator', [token]),
      call(p.locker.address, 'tokenQuote', [token]), call(p.locker.address, 'splitsOf', [token])], block);
    if (!same(info[0], token) || !same(info[3], quote) || !addr(info[2]) || info[5] !== 10000 || !ids.length || ids.length > 16) fail();
    // Standard launches and later custom splits use the same recipient math.
    if (!stonksRecipientAmount(10000n, creator, splits, address)) return null;
    const currencies = [token, quote].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const amounts = [0n, 0n];
    for (const tokenId of ids) {
      const [position, record, owner, pool] = await this.rpc.calls(8453, [call(p.positionManager.address, 'positions', [tokenId]),
        call(p.locker.address, 'positionsInfo', [tokenId]), call(p.positionManager.address, 'ownerOf', [tokenId]),
        call(p.factory.address, 'getPool', [token, quote, 10000])], block);
      if (!same(owner, p.locker.address) || !same(record[0], creator) || !record[1] || !same(record[2], quote)
        || !same(position[2], currencies[0]) || !same(position[3], currencies[1]) || position[4] !== 10000 || !same(pool, info[2])) fail();
      // eth_call as the NFT owner computes current fees, including un-poked V3
      // growth. This simulation changes no chain state and transfers no funds.
      const [collected] = await this.rpc.calls(8453, [{ ...call(p.positionManager.address, 'collect', [{ tokenId,
        recipient: p.locker.address, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }]), from: p.locker.address }], block);
      for (let i = 0; i < 2; i++) {
        const creatorAmount = collected[i] - collected[i] * BigInt(terms.platformBps) / 10000n;
        amounts[i] += stonksRecipientAmount(creatorAmount, creator, splits, address);
      }
    }
    const payouts = [];
    for (let i = 0; i < 2; i++) payouts.push({ ...await this.asset(currencies[i], block), claimableRaw: amounts[i].toString() });
    return this.position(address, payouts, 'collect', token);
  }
  async list(address, state) {
    const block = await this.rpc.block(8453), terms = await this.verify(block);
    const coins = await this.cache.get('stonks-coin-index', 60000, async () => stonksCoins(
      await this.upstream.json('stonks', 'https://www.thestonks.exchange/api/coins', {}, 4 * 1024 * 1024)));
    // Public index coverage is explicitly partial: it does not index every
    // custom fee recipient or pending creator reassignment.
    const candidates = state?.candidates ?? coins.filter(c => same(c.creator, address) && same(c.fee_locker, this.profile.locker.address)).map(c => c.token.toLowerCase());
    const offset = state?.offset ?? 0, positions = [], seen = new Set(state?.seen ?? []);
    for (const token of candidates.slice(offset, offset + 3)) {
      const collection = await this.collection(address, token, block, terms);
      if (collection) positions.push(collection);
      const [info] = await this.rpc.calls(8453, [call(this.profile.launcher.address, 'tokenInfo', [token])], block);
      for (const currency of [token, info[3]]) {
        if (seen.has(currency.toLowerCase())) continue;
        seen.add(currency.toLowerCase());
        const deferred = await this.deferred(address, currency, block);
        if (deferred) positions.push(deferred);
      }
    }
    const nextState = offset + 3 < candidates.length ? { candidates, offset: offset + 3, seen: [...seen] } : null;
    return { positions, partial: true, nextState };
  }
  async prepare(position, block) {
    if (position.profileKey !== JSON.stringify(this.profile)) fail();
    const terms = await this.verify(block);
    const updated = position.claimMode === 'collect'
      ? await this.collection(position.address, position.collectionToken, block, terms)
      : await this.deferred(position.address, position.collectionToken, block);
    if (!updated?.claimable) throw new ServiceError('nothing_to_claim', 409);
    const oracle = this.config.feeContracts?.baseOracle;
    if (!oracle) fail();
    await this.rpc.verify(8453, [oracle], true, block);
    return { position: updated, data: encodeFunctionData({ abi: STONKS_ABI,
      functionName: updated.claimMode === 'collect' ? 'collectAll' : 'claim', args: [updated.collectionToken] }) };
  }
}
