import { createHash, createHmac } from 'node:crypto';
import { decodeEventLog, decodeFunctionResult, toHex } from 'viem';
import { BaseLaunchLive } from './base-launch-live.mjs';
import { STONX_ABI, STONX_ROLES, STONX_SUPPLY, STONX_TICKERS, buildUnsignedStonxLaunch, readStonxProfile, stonxBeneficiaries, stonxTick } from '../../web/lib/long-encoding/stonx-launch.mjs';
import { ipfsContentId, ipfsUri } from './ipfs-content.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { checkReadDeadline } from './upstream.mjs';
import { ServiceError, InsufficientFundsError, UnsupportedPairError } from './errors.mjs';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = code => { throw new ServiceError(code, 409); };
const call = (address, functionName, args = []) => ({ address, abi: STONX_ABI, functionName, args });
const gasLimit = 8000000n;
export function readStonxConfig(env) {
  if (env.STONX_BASE_WALLET_LAUNCH !== 'true') return null;
  try {
    const profile = readStonxProfile(JSON.parse(env.STONX_BASE_PROFILE_JSON));
    if (profile.quotes.length !== STONX_TICKERS.length) throw Error('incomplete_stonx_catalog');
    const origin = new URL(env.LAUNCH_ASSET_SERVICE_ORIGIN);
    if (origin.origin !== env.LAUNCH_ASSET_SERVICE_ORIGIN || origin.username || origin.password
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(origin.hostname) && origin.port === '8790'))) throw Error();
    return { profile, assetOrigin: origin.origin };
  } catch { throw new ServiceError('stonx_configuration', 503); }
}
export async function verifyStonx(rpc, p, block) {
  await rpc.verify(8453, STONX_ROLES.map(r => p[r]), true, block);
  const [owner, airlock, manager, ...states] = await rpc.calls(8453, [call(p.launcher.address, 'owner'),
    call(p.poolInitializer.address, 'airlock'), call(p.dopplerHook.address, 'poolManager'),
    ...['tokenFactory', 'governanceFactory', 'poolInitializer', 'liquidityMigrator'].map(r => call(p.launcher.address, 'getModuleState', [p[r].address]))], block);
  if (!same(owner, p.protocolBeneficiary) || !same(airlock, p.launcher.address) || !same(manager, p.poolManager.address)
    || states.some((s, i) => s !== [1, 2, 3, 4][i])) fail('contract_unverified');
}
export function parseStonxPrice(body, token, now) {
  const items = body?.data?.stockUsdPrices?.items;
  if (body?.errors || !Array.isArray(items) || !items.length || items.length > 3) fail('oracle_stale');
  const observations = items.map(row => {
    if (!row || !same(row.address, token) || typeof row.price !== 'string' || !/^[1-9]\d{0,15}$/.test(row.price)
      || !/^\d{1,12}$/.test(String(row.timestamp))) fail('oracle_stale');
    const timestamp = Number(row.timestamp) * 1000, price = Number(row.price) / 1e8;
    if (price < 0.000001 || price > 10000000) fail('oracle_stale');
    return { priceUsd: price.toFixed(8), timestamp, source: 'stonx wrapped-stock index' };
  });
  // The index may publish the next five-minute bucket early. Use the newest
  // currently valid observation, never that future price or a stale fallback.
  const current = observations.filter(row => row.timestamp <= now + 30000 && now - row.timestamp <= 600000)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!current) fail('oracle_stale');
  return current;
}
export class StonxLive extends BaseLaunchLive {
  constructor(config, upstream, budget, options) {
    super({ ...config, longLaunch: config.stonxLaunch }, upstream, budget, options);
  }
  run(kind, input) {
    if (!this.live || !this.config.readsEnabled) throw new ServiceError('stonx_launch_disabled', 503);
    return super.run(kind, input);
  }
  async quoteState(q, block) {
    await this.rpc.verify(8453, [q.token, q.beacon, q.implementation], true, block);
    const [symbol, decimals, implementation] = await this.rpc.calls(8453, [call(q.token.address, 'symbol'), call(q.token.address, 'decimals'), call(q.beacon.address, 'implementation')], block);
    if (symbol !== q.symbol || decimals !== q.decimals || !same(implementation, q.implementation.address)) fail('contract_unverified');
  }
  async price(q) {
    // Cache only fresh, timestamped index observations. Never use a pasted USD price.
    return this.cache.get(`price:${q.id}`, 30000, async () => {
      const body = await this.upstream.json('stonx', 'https://stonx.ai/indexer', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query($where: stockUsdPriceFilter, $limit: Int) { stockUsdPrices(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit) { items { address price timestamp } } }',
          variables: { where: { chainId: 8453, address_in: [q.token.address] }, limit: 3 } }) }, 8192);
      const observed = parseStonxPrice(body, q.token.address, this.now());
      // stonx calibrates the NAV price to the wrapped token's DEX quote when
      // the ratio is within 0.1–10; use the same bounded calibration.
      const market = await this.upstream.json('stonx', `https://stonx.ai/api/quote-prices?tokens=${q.token.address}`, {}, 4096);
      const usd = market?.[q.token.address]?.usd, ratio = usd / Number(observed.priceUsd);
      if (typeof usd === 'number' && Number.isFinite(usd) && ratio >= 0.1 && ratio <= 10)
        return { ...observed, priceUsd: usd.toFixed(8), source: 'stonx wrapped-stock DEX quote', quotedAt: this.now() };
      return { ...observed, quotedAt: this.now() };
    });
  }
  async estimate(input) {
    const q = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!q) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const block = await this.rpc.block(8453);
    await verifyStonx(this.rpc, this.live.profile, block);
    await this.quoteState(q, block);
    await this.price(q);
    const quotedAt = this.now();
    return { chainId: 8453, pairId: q.id, basis: 'requires-calldata', launchpadFeeWei: '0',
      launchFeeSource: { amountWei: '0', kind: 'verified-contract', contract: this.live.profile.launcher.address, blockNumber: rpcNumber(block).toString() },
      quotedAt, expiresAt: quotedAt + 300000 };
  }
  async prepare(input) {
    const quote = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!quote) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const key = createHmac('sha256', this.budget.key).update(`stonx:8453:${input.wallet}:${input.publication.metadataHash}:${input.pairId}`).digest('hex');
    const context = JSON.stringify(input), prior = this.row(key);
    if (prior && prior.context !== context) {
      const original = JSON.parse(prior.context);
      if (JSON.stringify({ ...input, publication: { ...input.publication, id: original.publication.id } }) !== prior.context) fail('launch_context_locked');
    }
    const retry = prior?.state === 'wallet' && !prior.tx_hash ? JSON.parse(prior.plan) : null;
    const resume = () => ({ recovery: { id: key, binding: JSON.parse(prior.plan).binding, hash: prior.tx_hash ?? null } });
    if (prior && prior.state !== 'prepared' && !retry) return resume();
    if (retry && (await this.recovery.find(key, retry.transaction)).status !== 'retryable') return resume();
    if (!retry && prior && prior.expires > this.now()) return JSON.parse(prior.plan);
    this.budget.launch('prepare', 'stonx');
    if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n >= 4096) fail('launch_history_full');
    const publication = await this.metadata(input), imageUri = ipfsUri(publication.ipfs.imageCid), metadataUri = ipfsUri(publication.ipfs.metadataCid);
    const bytes = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker, description: input.draft.description, image: imageUri, image_hash: imageUri,
      ...(input.draft.website !== undefined ? { website: input.draft.website } : {}),
      ...(input.draft.twitter !== undefined ? { twitter: input.draft.twitter } : {}),
    }));
    if (createHash('sha256').update(bytes).digest('hex') !== input.publication.metadataHash || await ipfsContentId(bytes) !== publication.ipfs.metadataCid) fail('launch_assets_unverified');
    const p = { ...this.live.profile, quotes: [quote] }, block = await this.rpc.block(8453);
    await verifyStonx(this.rpc, p, block);
    await this.quoteState(quote, block);
    const priceQuote = await this.price(quote);
    const fee = { amountWei: '0', kind: 'verified-contract', contract: p.launcher.address, blockNumber: rpcNumber(block).toString() };
    const buildInput = { wallet: input.wallet, draft: input.draft, pairId: quote.id, metadataUri,
      quotePriceUsd: priceQuote.priceUsd, intentId: key };
    const plan = buildUnsignedStonxLaunch(buildInput, p), predictedAsset = plan.predictedAsset;
    const [vacancy, accountCode, rawPrice, rawBalance, rawNonce] = await this.rpc.batch(8453, [
      { method: 'eth_getCode', params: [predictedAsset, block] }, { method: 'eth_getCode', params: [input.wallet, block] },
      { method: 'eth_gasPrice', params: [] }, { method: 'eth_getBalance', params: [input.wallet, 'pending'] },
      { method: 'eth_getTransactionCount', params: [input.wallet, 'pending'] },
    ]);
    if (vacancy !== '0x') fail('launch_already_exists');
    if (accountCode !== '0x') fail('launch_eoa_required');
    const price = rpcNumber(rawPrice), balance = rpcNumber(rawBalance), nonce = rpcNumber(rawNonce), value = BigInt(fee.amountWei);
    if (!price || price > 10n ** 12n) fail('launch_gas_limit');
    if (retry && nonce !== rpcNumber(retry.transaction.nonce)) fail('launch_pending');
    let simulated, rawGas;
    try { [simulated, rawGas] = await this.rpc.batch(8453, [{ method: 'eth_call', params: [plan.transaction, 'pending'] },
      { method: 'eth_estimateGas', params: [plan.transaction, 'pending'] }]); }
    catch (error) {
      if (error.code === 'insufficient_funds') {
        const fees = await this.baseFees(plan.transaction, gasLimit, price, nonce, block);
        throw new InsufficientFundsError(balance, gasLimit * price + value + BigInt(fees.l1DataFeeWei) + BigInt(fees.operatorFeeWei), 'gas-limit', 8453);
      }
      throw error;
    }
    const [token, pool] = decodeFunctionResult({ abi: STONX_ABI, functionName: 'create', data: simulated });
    if (!same(token, predictedAsset) || !same(pool, predictedAsset)) fail('launch_simulation_failed');
    const estimated = rpcNumber(rawGas), gas = (estimated * 120n + 99n) / 100n;
    if (estimated < 21000n || gas > gasLimit) fail('launch_gas_limit');
    const baseFees = await this.baseFees(plan.transaction, gas, price, nonce, block);
    const maximumGas = gas * price + BigInt(baseFees.l1DataFeeWei) + BigInt(baseFees.operatorFeeWei);
    if (maximumGas + value > 5n * 10n ** 16n) fail('launch_gas_limit');
    if (balance < maximumGas + value) throw new InsufficientFundsError(balance, maximumGas + value, 'simulation', 8453);
    const usd = await this.cache.get('eth-usd', 30000, async () => {
      const body = await this.upstream.json('coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', {}, 8192);
      if (body?.data?.base !== 'ETH' || body.data.currency !== 'USD' || !/^\d{1,6}(?:\.\d{1,6})?$/.test(body.data.amount) || Number(body.data.amount) <= 0) fail('usd_unavailable');
      return { microUsdPerEth: String(Math.round(Number(body.data.amount) * 1e6)), sourceLabel: 'Coinbase ETH/USD spot', quotedAt: this.now() };
    });
    const quotedAt = this.now();
    const prepared = { ...plan, id: key, chainId: 8453, quotedAt, expiresAt: quotedAt + 30000, stonxBuildInput: buildInput,
      transaction: { ...plan.transaction, chainId: '0x2105', nonce: toHex(nonce), gas: toHex(gas), gasPrice: toHex(price) },
      estimatedGas: estimated.toString(), launchpadFeeWei: fee.amountWei,
      launchFeeSource: fee, maximumGasWei: maximumGas.toString(), baseFees, priceQuote, usd };
    checkReadDeadline();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (retry) this.remember(key, retry);
      this.remember(key, prepared);
      this.db.prepare(`INSERT INTO long_launches(id,context,state,plan,expires) VALUES (?,?,'prepared',?,?)
        ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,expires=excluded.expires WHERE state IN ('prepared','wallet') AND tx_hash IS NULL`).run(key, context, JSON.stringify(prepared), prepared.expiresAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return prepared;
  }
  async confirm(plan, context, receipt, block) {
    const p = plan.profile, q = p.quotes.find(q => q.id === context.pairId);
    await verifyStonx(this.rpc, p, block);
    const events = receipt.logs.filter(l => same(l.address, p.launcher.address)).flatMap(l => {
      try { return [decodeEventLog({ abi: STONX_ABI, eventName: 'Create', data: l.data, topics: l.topics, strict: true }).args]; } catch { return []; }
    });
    const e = events[0];
    if (events.length !== 1 || !same(e.asset, plan.predictedAsset) || !same(e.numeraire, q.token.address)
      || !same(e.initializer, p.poolInitializer.address) || !same(e.poolOrHook, e.asset)) fail('launch_receipt_unverified');
    const [asset, state, name, symbol, supply, uri] = await this.rpc.calls(8453, [call(p.launcher.address, 'getAssetData', [e.asset]),
      call(p.poolInitializer.address, 'getState', [e.asset]), call(e.asset, 'name'), call(e.asset, 'symbol'), call(e.asset, 'totalSupply'), call(e.asset, 'tokenURI')], block);
    const pool = state[5];
    if (!same(asset[0], q.token.address) || !same(asset[3], p.liquidityMigrator.address) || !same(asset[4], p.poolInitializer.address)
      || !same(asset[5], e.asset) || asset[7] !== STONX_SUPPLY || asset[8] !== STONX_SUPPLY || !same(asset[9], p.integrator)
      || !same(state[0], q.token.address) || !same(state[2], p.dopplerHook.address) || state[4] !== 2
      || !same(pool.currency0, e.asset) || !same(pool.currency1, q.token.address) || pool.fee !== 500 || pool.tickSpacing !== 10 || !same(pool.hooks, p.poolInitializer.address)
      || state[6] !== stonxTick(100000, Number(plan.review.quotePriceUsd))
      || name !== context.draft.name || symbol !== context.draft.ticker || supply !== STONX_SUPPLY || uri !== plan.review.metadataUri) fail('launch_receipt_unverified');
    const WAD = 10n ** 18n;
    for (const [role, entries] of [['poolInitializer', [[p.protocolBeneficiary, WAD * 5n / 100n], [p.integrator, WAD * 285n / 1000n], [context.wallet, WAD * 665n / 1000n]]],
      ['dopplerHook', [[p.integrator, WAD * 3n / 10n], [context.wallet, WAD * 7n / 10n]]]]) {
      const shares = stonxBeneficiaries(entries);
      const actual = await this.rpc.calls(8453, shares.map(s => call(p[role].address, 'getShares', [plan.predictedPool, s.beneficiary])), block);
      if (actual.some((s, i) => s !== shares[i].shares)) fail('launch_receipt_unverified');
    }
  }
}
