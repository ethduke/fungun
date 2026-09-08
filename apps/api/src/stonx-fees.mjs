import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData, multicall3Abi } from 'viem';
import { STONX_ABI, readStonxProfile } from '../../web/lib/long-encoding/stonx-launch.mjs';
import { verifyStonx } from './stonx-live.mjs';
import { beneficiaryFees, managerAbi, poolId, sameAddress, validAddress } from './fee-contracts.mjs';
import { ServiceError } from './errors.mjs';

const PAGE_SIZE = 2;
const fail = (code = 'invalid_response') => { throw new ServiceError(code, 409); };
const hash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value);
const view = (address, abi, functionName, args, from) => ({ address, abi, functionName, args, from });

export function readStonxFeeProfile(raw) {
  if (!raw) return null;
  try { return readStonxProfile(JSON.parse(raw)); }
  catch { throw new ServiceError('invalid_fee_configuration'); }
}

export function readStonxFeeMulticall(raw) {
  if (!raw) return null;
  try {
    const pin = JSON.parse(raw);
    if (Object.keys(pin).sort().join(',') !== 'address,codeHash' || !validAddress(pin.address) || !hash(pin.codeHash)) throw Error();
    return { address: pin.address.toLowerCase(), codeHash: pin.codeHash.toLowerCase() };
  } catch { throw new ServiceError('invalid_fee_configuration'); }
}

// Ponder supplies pool identities only. Scan every pool for the configured
// integrator because its current trading-beneficiary table is incomplete.
// Both streams' current on-chain shares establish entitlement, including transfers.
export class StonxFees {
  constructor(config, rpc, upstream) { this.config = config; this.rpc = rpc; this.upstream = upstream; }
  async list(address, cursor) {
    const p = this.config.stonxFees, block = cursor?.block ?? await this.rpc.block(8453);
    const multicall = this.config.stonxFeeMulticall;
    if (!multicall) fail('contract_unverified');
    if (!cursor) {
      await verifyStonx(this.rpc, p, block);
      await this.rpc.verify(8453, [multicall], false, block);
    }
    let pending = cursor?.pending ?? [], after = cursor?.after ?? null, more = cursor?.more ?? true, seen = cursor?.seen ?? [];
    if (!pending.length && more) {
      const body = await this.upstream.json('stonx', 'https://stonx.ai/indexer', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query($where:poolFilter,$after:String,$limit:Int){ pools(where:$where,orderBy:"address",orderDirection:"asc",after:$after,limit:$limit){items{address chainId integrator baseToken{address}} pageInfo{hasNextPage endCursor}} }',
          variables: { where: { chainId: 8453, integrator: p.integrator }, after, limit: 24 } }),
      }, 32768, 1, { queue: true, retry: true });
      const rows = body?.data?.pools, info = rows?.pageInfo;
      if (body?.errors || !Array.isArray(rows?.items) || rows.items.length > 24 || typeof info?.hasNextPage !== 'boolean'
        || (info.hasNextPage && (typeof info.endCursor !== 'string' || !info.endCursor.length || info.endCursor.length > 4096))
        || new Set(rows.items.map(row => row.address)).size !== rows.items.length) fail();
      for (const row of rows.items)
        if (row.chainId !== 8453 || !hash(row.address) || !validAddress(row.baseToken?.address) || !sameAddress(row.integrator, p.integrator)) fail();
      pending = [];
      if (rows.items.length) {
        const [results] = await this.rpc.calls(8453, [view(multicall.address, multicall3Abi, 'aggregate3', [rows.items.flatMap(row => [p.poolInitializer.address, p.dopplerHook.address]
          .map(target => ({ target, allowFailure: false, callData: encodeFunctionData({ abi: managerAbi, functionName: 'getShares', args: [row.address, address] }) })) )])], block);
        if (results.length !== rows.items.length * 2) fail();
        const shares = results.map(result => {
          if (!result.success) fail();
          const n = decodeFunctionResult({ abi: managerAbi, functionName: 'getShares', data: result.returnData });
          if (n < 0n || n > 10n ** 18n) fail();
          return n;
        });
        rows.items.forEach((row, index) => {
          if (shares[index * 2] > 0n || shares[index * 2 + 1] > 0n)
            pending.push({ asset: row.baseToken.address, poolId: row.address });
        });
      }
      more = info.hasNextPage;
      after = more ? info.endCursor : null;
      if (more) {
        const fingerprint = createHash('sha256').update(after).digest('hex');
        if (seen.includes(fingerprint) || seen.length >= 511) fail('scan_limit');
        seen = [...seen, fingerprint];
      }
    }
    const positions = [];
    for (const row of pending.slice(0, PAGE_SIZE)) {
      for (const stream of ['lp', 'trading']) {
        const position = await this.position(address, row.asset, row.poolId, stream, block);
        if (position) positions.push(position);
      }
    }
    pending = pending.slice(PAGE_SIZE);
    const nextState = more || pending.length ? { block, after, more, seen, pending } : null;
    return { positions, partial: !!nextState, nextState };
  }

  async position(address, asset, id, stream, block) {
    const p = this.config.stonxFees;
    const [data, state] = await this.rpc.calls(8453, [view(p.launcher.address, STONX_ABI, 'getAssetData', [asset]),
      view(p.poolInitializer.address, STONX_ABI, 'getState', [asset])], block);
    // The Doppler initializer also serves unrelated launchpads. Never brand
    // their balances as stonx or infer entitlement from token ownership.
    if (!sameAddress(data[9], p.integrator)) return null;
    const key = state[5], quote = p.quotes.find(q => sameAddress(q.token.address, state[0]));
    if (!quote || state[4] !== 2 || !sameAddress(state[2], p.dopplerHook.address)
      || !sameAddress(data[0], quote.token.address) || !sameAddress(data[4], p.poolInitializer.address)
      || !sameAddress(data[5], asset) || !sameAddress(key.hooks, p.poolInitializer.address)
      || !sameAddress(key.currency0, asset) || !sameAddress(key.currency1, quote.token.address)
      || !Number.isInteger(key.fee) || !((key.fee >= 0 && key.fee <= 1000000) || key.fee === 8388608)
      || !Number.isInteger(key.tickSpacing) || key.tickSpacing < 1 || key.tickSpacing > 32767) fail('contract_unverified');
    const pool = { currency0: { address: key.currency0 }, currency1: { address: key.currency1 }, fee: key.fee, tickSpacing: key.tickSpacing };
    if (!sameAddress(poolId(pool, p.poolInitializer.address), id)) fail('contract_unverified');
    const target = stream === 'lp' ? p.poolInitializer.address : p.dopplerHook.address;
    const [shares, c0, c1, l0, l1] = await this.rpc.calls(8453, [view(target, managerAbi, 'getShares', [id, address]),
      ...['getCumulatedFees0', 'getCumulatedFees1'].map(fn => view(target, managerAbi, fn, [id])),
      ...['getLastCumulatedFees0', 'getLastCumulatedFees1'].map(fn => view(target, managerAbi, fn, [id, address]))], block);
    if (shares === 0n) return null;
    const [collected, symbol, decimals] = await this.rpc.calls(8453, [view(target, managerAbi, 'collectFees', [id], address),
      view(asset, STONX_ABI, 'symbol', []), view(asset, STONX_ABI, 'decimals', [])], block);
    if (typeof symbol !== 'string' || !/^[A-Za-z0-9._-]{1,24}$/.test(symbol) || decimals !== 18) fail();
    const amounts = [beneficiaryFees(c0, collected[0], l0, shares), beneficiaryFees(c1, collected[1], l1, shares)];
    const nonzero = amounts.some(n => n > 0n), oracle = !!this.config.feeContracts?.baseOracle;
    return { kind: 'stonx', chainId: 8453, address, target, poolId: id.toLowerCase(), launchAsset: asset.toLowerCase(), feeStream: stream,
      poolFee: key.fee, tickSpacing: key.tickSpacing, profileKey: JSON.stringify(p), verification: 'live', claimable: this.config.claimsEnabled && oracle && nonzero,
      claimDisabledReason: !nonzero ? 'nothing_to_claim' : !this.config.claimsEnabled ? 'claims_disabled' : !oracle ? 'gas_oracle_not_configured' : undefined,
      payouts: [{ asset: asset.toLowerCase(), symbol, decimals: 18, claimableRaw: amounts[0].toString() },
        { asset: quote.token.address, symbol: quote.symbol, decimals: quote.decimals, claimableRaw: amounts[1].toString() }] };
  }

  validatePosition(position) {
    const p = this.config.stonxFees;
    if (!p || position.chainId !== 8453 || position.profileKey !== JSON.stringify(p) || !['lp', 'trading'].includes(position.feeStream)
      || !sameAddress(position.target, position.feeStream === 'lp' ? p.poolInitializer.address : p.dopplerHook.address)
      || !validAddress(position.launchAsset) || !hash(position.poolId)) fail('contract_unverified');
  }

  async prepare(position, block) {
    this.validatePosition(position);
    const p = this.config.stonxFees, q = p.quotes.find(q => sameAddress(q.token.address, position.payouts[1].asset));
    if (!q || !this.config.feeContracts?.baseOracle) fail('contract_unverified');
    await verifyStonx(this.rpc, p, block);
    await this.rpc.verify(8453, [q.token, q.beacon, q.implementation, this.config.feeContracts.baseOracle], true, block);
    const [implementation] = await this.rpc.calls(8453, [view(q.beacon.address, STONX_ABI, 'implementation', [])], block);
    if (!sameAddress(implementation, q.implementation.address)) fail('contract_unverified');
    const fresh = await this.position(position.address, position.launchAsset, position.poolId, position.feeStream, block);
    if (!fresh) fail('nothing_to_claim');
    return { position: { ...fresh, stonxProfile: { ...p, quotes: [q] } }, data: encodeFunctionData({ abi: managerAbi, functionName: 'collectFees', args: [position.poolId] }) };
  }
}
