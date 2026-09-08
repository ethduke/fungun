import { createHash, createHmac } from 'node:crypto';
import { decodeEventLog, decodeFunctionResult, toHex, zeroAddress } from 'viem';
import { BaseLaunchLive } from './base-launch-live.mjs';
import { STONKS_ABI, STONKS_ROLES, STONKS_SUPPLY, buildUnsignedStonksLaunch, readStonksProfile, stonksSalt } from '../../web/lib/long-encoding/stonks-launch.mjs';
import { ipfsContentId, ipfsUri } from './ipfs-content.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { checkReadDeadline, withinReadDeadline } from './upstream.mjs';
import { ServiceError, InsufficientFundsError, UnsupportedPairError } from './errors.mjs';

export const stonksCall = (address, functionName, args = []) => ({ address, abi: STONKS_ABI, functionName, args });
export const sameStonksAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const same = sameStonksAddress;
const fail = code => { throw new ServiceError(code, 409); };
const gasLimit = 8000000n;
export function readStonksConfig(env) {
  if (!env.STONKS_BASE_PROFILE_JSON) return null;
  try {
    const profile = readStonksProfile(JSON.parse(env.STONKS_BASE_PROFILE_JSON));
    const origin = new URL(env.LAUNCH_ASSET_SERVICE_ORIGIN);
    if (origin.origin !== env.LAUNCH_ASSET_SERVICE_ORIGIN || origin.username || origin.password
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(origin.hostname) && origin.port === '8790'))) throw Error();
    return { profile, assetOrigin: origin.origin, launchesEnabled: env.STONKS_BASE_WALLET_LAUNCH === 'true' };
  } catch { throw new ServiceError('stonks_configuration', 503); }
}

// Verify links as well as runtime bytecode: a frozen implementation still has
// mutable registry/fee settings. These reads precede quotes, launches and claims.
export async function verifyStonks(rpc, profile, block, all = true) {
  await rpc.verify(8453, (all ? STONKS_ROLES : ['launcher', 'locker', 'registry']).map(role => profile[role]), true, block);
  const p = profile;
  const [locker, registry, npm, factory, source, lockerNpm, platform, lp, pending] = await rpc.calls(8453, [
    stonksCall(p.launcher.address, 'feeLocker'), stonksCall(p.launcher.address, 'quoteRegistry'),
    stonksCall(p.launcher.address, 'npm'), stonksCall(p.launcher.address, 'factory'),
    stonksCall(p.locker.address, 'launcher'), stonksCall(p.locker.address, 'npm'),
    stonksCall(p.locker.address, 'platformFeeBps'), stonksCall(p.locker.address, 'lpFeeBps'),
    stonksCall(p.locker.address, 'pendingFeeSplit'),
  ], block);
  if (!same(locker, p.locker.address) || !same(registry, p.registry.address) || !same(npm, p.positionManager.address)
    || !same(factory, p.factory.address) || !same(source, p.launcher.address) || !same(lockerNpm, p.positionManager.address)
    || platform > 3000n || lp > 6000n || platform + lp > 8000n) fail('contract_unverified');
  return { creatorBps: Number(10000n - platform - lp), platformBps: Number(platform), lpBps: Number(lp),
    pendingFeeSplit: pending[2] ? { platformBps: Number(pending[0]), lpBps: Number(pending[1]), executeAfter: Number(pending[2]) } : null };
}

export class StonksLive extends BaseLaunchLive {
  constructor(config, upstream, budget, options) {
    super({ ...config, longLaunch: config.stonksLaunch }, upstream, budget, options);
    this.chainId = 8453;
  }
  run(kind, raw) {
    if (['launch-prepare', 'launch-estimate', 'launch-reserve'].includes(kind) && !this.live?.launchesEnabled)
      fail('stonks_launch_disabled');
    return super.run(kind, raw);
  }
  async quoteState(quote, block) {
    const [state, price] = await this.rpc.calls(8453, [
      stonksCall(this.live.profile.registry.address, 'quotes', [quote.token]),
      stonksCall(this.live.profile.registry.address, 'previewSync', [quote.token]),
    ], block);
    if (!state[0] || !state[3]) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    if (state[1] !== quote.decimals || state[4] !== quote.symbol || state[2] <= 0 || state[2] >= 887200) fail('contract_unverified');
    return { priceFresh: price[0], anchorTick: price[2], openingTickMagnitude: price[3] ? price[1] : price[2] };
  }
  async catalog() {
    if (!this.live || !this.live.launchesEnabled || !this.config.readsEnabled) return { status: 'unavailable', pairs: [] };
    return this.cache.get('catalog', 600000, () => withinReadDeadline(async () => {
      const block = await this.rpc.block(8453);
      const terms = await verifyStonks(this.rpc, this.live.profile, block, false);
      const pairs = [];
      for (const quote of this.live.profile.quotes) {
        try { const state = await this.quoteState(quote, block); pairs.push({ id: quote.id, symbol: quote.symbol.replace(/c$/, ''), priceFresh: state.priceFresh }); }
        catch (error) { if (error.code !== 'unsupported_pair') throw error; }
      }
      return { status: 'ready', pairs, expiresAt: this.now() + 600000, terms: { ...terms, tradingFeeBps: 100, ...await this.launchFee(block) } };
    }));
  }
  async launchFee(block) {
    const [fee, supply, tier] = await this.rpc.calls(8453, [stonksCall(this.live.profile.launcher.address, 'launchFeeWei'),
      stonksCall(this.live.profile.launcher.address, 'enforcedSupply'), stonksCall(this.live.profile.launcher.address, 'LAUNCH_FEE_TIER')], block);
    if (fee > 5n * 10n ** 16n || supply !== STONKS_SUPPLY || tier !== 10000) fail('contract_unverified');
    return { amountWei: fee.toString(), kind: 'verified-contract', contract: this.live.profile.launcher.address, blockNumber: rpcNumber(block).toString() };
  }
  async estimate(input) {
    const quote = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!quote) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    return this.cache.get(`estimate:${quote.id}`, 300000, async () => {
      const block = await this.rpc.block(8453), oracle = this.config.feeContracts?.baseOracle;
      if (!oracle) fail('contract_unverified');
      const terms = await verifyStonks(this.rpc, this.live.profile, block, false);
      const condition = await this.quoteState(quote, block), fee = await this.launchFee(block);
      await this.rpc.verify(8453, [oracle], true, block);
      const [raw] = await this.rpc.batch(8453, [{ method: 'eth_gasPrice', params: [] }]);
      const price = rpcNumber(raw);
      if (!price || price > 10n ** 12n) fail('launch_gas_limit');
      // A disclosed ceiling, including worst-case data length, until the user's
      // exact artwork and calldata are available. Never omit Base's L1 fees.
      const [l1, operator] = await this.rpc.calls(8453, [stonksCall(oracle.address, 'getL1FeeUpperBound', [16384n]),
        stonksCall(oracle.address, 'getOperatorFee', [gasLimit])], block);
      const quotedAt = this.now();
      return { chainId: 8453, pairId: quote.id, basis: 'gas-limit', gasUnits: gasLimit.toString(), gasPriceWei: price.toString(),
        baseFees: { l1DataFeeWei: ((l1 * 120n + 99n) / 100n).toString(), operatorFeeWei: operator.toString() },
        launchpadFeeWei: fee.amountWei, launchFeeSource: fee, terms, condition, quotedAt, expiresAt: quotedAt + 300000 };
    });
  }
  async prepare(input) {
    const quote = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!quote) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const key = createHmac('sha256', this.budget.key).update(`stonks:8453:${input.wallet}:${input.publication.metadataHash}:${input.pairId}`).digest('hex');
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
    this.budget.launch('prepare', 'stonks');
    if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n >= 4096) fail('launch_history_full');
    const publication = await this.metadata(input), imageUri = ipfsUri(publication.ipfs.imageCid), metadataUri = ipfsUri(publication.ipfs.metadataCid);
    const bytes = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker, description: input.draft.description, image: imageUri, image_hash: imageUri }));
    if (createHash('sha256').update(bytes).digest('hex') !== input.publication.metadataHash || await ipfsContentId(bytes) !== publication.ipfs.metadataCid) fail('launch_assets_unverified');
    const p = { ...this.live.profile, quotes: [quote] }, block = await this.rpc.block(8453);
    const terms = await verifyStonks(this.rpc, p, block), condition = await this.quoteState(quote, block), fee = await this.launchFee(block);
    const [predictedAsset] = await this.rpc.calls(8453, [stonksCall(p.launcher.address, 'predictTokenAddress',
      [input.draft.name, input.draft.ticker, STONKS_SUPPLY, input.wallet, stonksSalt(key)])], block);
    const buildInput = { wallet: input.wallet, draft: input.draft, pairId: quote.id, imageUri, metadataUri,
      launchpadFeeWei: fee.amountWei, predictedAsset, intentId: key };
    const plan = buildUnsignedStonksLaunch(buildInput, p);
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
    const [token, tokenId] = decodeFunctionResult({ abi: STONKS_ABI, functionName: 'launchWithMeta', data: simulated });
    if (!same(token, predictedAsset) || !tokenId) fail('launch_simulation_failed');
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
    // NFT IDs can change if another user launches first. Verify the mined event's
    // ID and position state, never assume the simulated global counter is final.
    const prepared = { ...plan, id: key, chainId: 8453, quotedAt, expiresAt: quotedAt + 30000, buildInput,
      transaction: { ...plan.transaction, chainId: '0x2105', nonce: toHex(nonce), gas: toHex(gas), gasPrice: toHex(price) },
      predictedPool: zeroAddress, estimatedGas: estimated.toString(), launchpadFeeWei: fee.amountWei,
      launchFeeSource: fee, maximumGasWei: maximumGas.toString(), baseFees, terms, condition, usd };
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
    const p = plan.profile, quote = p.quotes.find(q => q.id === context.pairId);
    await verifyStonks(this.rpc, p, block);
    const events = receipt.logs.filter(log => same(log.address, p.launcher.address)).flatMap(log => {
      try { return [decodeEventLog({ abi: STONKS_ABI, data: log.data, topics: log.topics, strict: true })]; } catch { return []; }
    });
    const launches = events.filter(e => e.eventName === 'TokenLaunched'), metas = events.filter(e => e.eventName === 'TokenMetaSet');
    const e = launches[0]?.args, m = metas[0]?.args;
    if (launches.length !== 1 || metas.length !== 1 || !same(e.token, plan.predictedAsset) || !same(e.creator, context.wallet)
      || !same(e.quote, quote.token) || !same(e.feeLocker, p.locker.address) || e.fee !== 10000 || e.totalSupply !== STONKS_SUPPLY
      || !same(m.token, e.token) || !same(m.creator, context.wallet) || m.image !== plan.review.imageUri || m.description !== context.draft.description
      || [m.banner, m.website, m.twitter, m.telegram].some(Boolean)) fail('launch_receipt_unverified');
    const [info, name, symbol, supply, owner, position, lockerPosition, splits, pool] = await this.rpc.calls(8453, [
      stonksCall(p.launcher.address, 'tokenInfo', [e.token]), stonksCall(e.token, 'name'), stonksCall(e.token, 'symbol'), stonksCall(e.token, 'totalSupply'),
      stonksCall(p.positionManager.address, 'ownerOf', [e.tokenId]), stonksCall(p.positionManager.address, 'positions', [e.tokenId]),
      stonksCall(p.locker.address, 'positionsInfo', [e.tokenId]), stonksCall(p.locker.address, 'splitsOf', [e.token]),
      stonksCall(p.factory.address, 'getPool', [e.token, quote.token, 10000]),
    ], block);
    if (!same(info[0], e.token) || !same(info[1], context.wallet) || !same(info[2], e.pool) || !same(info[3], quote.token) || info[4] !== e.tokenId || info[5] !== 10000
      || name !== context.draft.name || symbol !== context.draft.ticker || supply !== STONKS_SUPPLY || !same(owner, p.locker.address)
      || ![position[2], position[3]].some(t => same(t, e.token)) || ![position[2], position[3]].some(t => same(t, quote.token)) || position[4] !== 10000 || !position[7]
      || !same(lockerPosition[0], context.wallet) || !lockerPosition[1] || !same(lockerPosition[2], quote.token) || splits.length || !same(pool, e.pool)) fail('launch_receipt_unverified');
  }
}
