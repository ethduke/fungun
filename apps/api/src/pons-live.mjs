import { createHash, createHmac } from 'node:crypto';
import { decodeEventLog, decodeFunctionResult, toHex, zeroAddress } from 'viem';
import { LongLive } from './long-live.mjs';
import { PONS_ABI, PONS_ROLES, buildUnsignedPonsLaunch, readPonsLaunchProfile } from '../../web/lib/long-encoding/pons-launch.mjs';
import { ipfsContentId, ipfsUri } from './ipfs-content.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { checkReadDeadline } from './upstream.mjs';
import { InsufficientFundsError, ServiceError, UnsupportedPairError } from './errors.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = code => { throw new ServiceError(code, 409); };
const call = (address, functionName, args = []) => ({ address, abi: PONS_ABI, functionName, args });
const gasLimit = 8000000n;
export function readPonsLiveConfig(env) {
  if (env.PONS_WALLET_LAUNCH !== 'true') return null;
  try {
    const profile = readPonsLaunchProfile(JSON.parse(env.PONS_LAUNCH_PROFILE_JSON));
    const origin = new URL(env.LAUNCH_ASSET_SERVICE_ORIGIN);
    if (origin.origin !== env.LAUNCH_ASSET_SERVICE_ORIGIN || origin.username || origin.password
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(origin.hostname) && origin.port === '8790'))) throw new Error();
    return { profile, assetOrigin: origin.origin };
  } catch { throw new ServiceError('pons_configuration', 503); }
}

export class PonsLive extends LongLive {
  constructor(config, upstream, budget, options) {
    super({ ...config, longLaunch: config.ponsLaunch }, upstream, budget, options);
  }
  async run(kind, input) {
    if (!this.live || !this.config.readsEnabled) throw new ServiceError('pons_launch_disabled', 503);
    return super.run(kind, input);
  }
  async terms(block, wallet) {
    const p = this.live.profile;
    await this.rpc.verify(4663, PONS_ROLES.map(role => p[role]), true, block);
    const [config, economics, fee, ...dependencies] = await this.rpc.calls(4663, [
      call(p.launcher.address, 'getLaunchConfig', [BigInt(p.launchConfigId)]),
      call(p.launcher.address, 'previewLaunchEconomics', [BigInt(p.launchConfigId), zeroAddress]),
      call(p.launcher.address, 'launchFee'),
      ...PONS_ROLES.slice(1).map(role => call(p.launcher.address, role)),
    ], block);
    if (dependencies.some((value, index) => !same(value, p[PONS_ROLES[index + 1]].address))) fail('contract_unverified');
    if (!config.enabled) fail('pons_launch_disabled');
    if (fee < 0n || fee > 5n * 10n ** 16n || config.supply <= 0n) fail('launch_gas_limit');
    if (wallet) {
      const [allowed] = await this.rpc.calls(4663, [call(p.launcher.address, 'canLaunch', [wallet])], block);
      if (!allowed) fail('pons_launch_restricted');
    }
    return { config, economics, fee: { amountWei: fee.toString(), kind: 'verified-contract',
      contract: p.launcher.address, blockNumber: rpcNumber(block).toString() } };
  }
  async estimate(input) {
    if (input.pairId !== 'pons-native') throw new UnsupportedPairError(['pons-native']);
    const block = await this.rpc.block(4663);
    const { fee } = await this.terms(block, input.wallet);
    const [rawPrice] = await this.rpc.batch(4663, [{ method: 'eth_gasPrice', params: [] }]);
    const price = rpcNumber(rawPrice);
    if (price <= 0n || price > 10n ** 12n) fail('launch_gas_limit');
    const quotedAt = this.now();
    return { chainId: 4663, pairId: input.pairId, gasUnits: gasLimit.toString(), gasPriceWei: price.toString(),
      launchpadFeeWei: fee.amountWei, launchFeeSource: fee, basis: 'gas-limit', quotedAt, expiresAt: quotedAt + 300000 };
  }
  async prepare(input) {
    if (input.pairId !== 'pons-native') throw new UnsupportedPairError(['pons-native']);
    const p = this.live.profile;
    const key = createHmac('sha256', this.budget.key).update(`pons:4663:${input.wallet}:${input.publication.metadataHash}`).digest('hex');
    const context = JSON.stringify(input), prior = this.row(key);
    if (prior && prior.context !== context) {
      const original = JSON.parse(prior.context);
      if (JSON.stringify({ ...input, publication: { ...input.publication, id: original.publication.id } }) !== prior.context) fail('launch_context_locked');
    }
    const retry = prior?.state === 'wallet' && !prior.tx_hash ? JSON.parse(prior.plan) : null;
    const resume = () => ({ recovery: { id: key, binding: JSON.parse(prior.plan).binding, hash: prior.tx_hash ?? null } });
    if (prior && prior.state !== 'prepared' && !retry) return resume();
    if (retry && (await this.recovery.find(key, retry.transaction)).status !== 'retryable') return resume();
    this.budget.launch('prepare', 'pons');
    if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n >= 4096) fail('launch_history_full');
    // Recheck eligibility and economics even when a previous quote is still fresh.
    const block = await this.rpc.block(4663);
    const terms = await this.terms(block, input.wallet);
    const publication = await this.metadata(input), imageUri = ipfsUri(publication.ipfs.imageCid);
    const metadata = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker,
      description: input.draft.description, image: imageUri, image_hash: imageUri }));
    if (createHash('sha256').update(metadata).digest('hex') !== input.publication.metadataHash
      || await ipfsContentId(metadata) !== publication.ipfs.metadataCid) fail('launch_assets_unverified');
    const buildInput = { wallet: input.wallet, draft: input.draft, pairId: input.pairId,
      imageUri, metadataUri: ipfsUri(publication.ipfs.metadataCid), expectedEconomics: terms.economics,
      totalSupply: terms.config.supply.toString(), launchpadFeeWei: terms.fee.amountWei, intentId: key };
    const plan = buildUnsignedPonsLaunch(buildInput, p);
    const [accountCode, rawPrice, rawBalance, rawNonce] = await this.rpc.batch(4663, [
      { method: 'eth_getCode', params: [input.wallet, block] },
      { method: 'eth_gasPrice', params: [] }, { method: 'eth_getBalance', params: [input.wallet, 'pending'] },
      { method: 'eth_getTransactionCount', params: [input.wallet, 'pending'] },
    ]);
    if (accountCode !== '0x') fail('launch_eoa_required');
    const price = rpcNumber(rawPrice), balance = rpcNumber(rawBalance), value = BigInt(terms.fee.amountWei);
    if (price <= 0n || price > 10n ** 12n) fail('launch_gas_limit');
    let result, rawGas;
    try { [result, rawGas] = await this.rpc.batch(4663, [
      { method: 'eth_call', params: [plan.transaction, 'pending'] },
      { method: 'eth_estimateGas', params: [plan.transaction, 'pending'] },
    ]); } catch (error) {
      if (error?.code === 'insufficient_funds' && balance < gasLimit * price + value)
        throw new InsufficientFundsError(balance, gasLimit * price + value, 'gas-limit');
      throw error;
    }
    const [asset, curve] = decodeFunctionResult({ abi: PONS_ABI, functionName: 'launchToken', data: result });
    if (same(asset, zeroAddress) || same(curve, zeroAddress) || same(asset, curve)) fail('launch_simulation_failed');
    const estimated = rpcNumber(rawGas), gas = (estimated * 120n + 99n) / 100n;
    if (estimated < 21000n || gas > gasLimit || gas * price + value > 5n * 10n ** 16n) fail('launch_gas_limit');
    if (retry && rpcNumber(rawNonce) !== rpcNumber(retry.transaction.nonce)) fail('launch_pending');
    if (balance < gas * price + value) throw new InsufficientFundsError(balance, gas * price + value);
    const usd = await this.cache.get('eth-usd', 30000, async () => {
      const data = await this.upstream.json('coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', {}, 8192);
      if (data?.data?.base !== 'ETH' || data?.data?.currency !== 'USD' || typeof data.data.amount !== 'string'
        || !/^\d{1,6}(?:\.\d{1,6})?$/.test(data.data.amount) || Number(data.data.amount) <= 0) fail('usd_unavailable');
      return { microUsdPerEth: String(Math.round(Number(data.data.amount) * 1e6)), sourceLabel: 'Coinbase ETH/USD spot', quotedAt: this.now() };
    });
    const quotedAt = this.now();
    const prepared = { id: key, binding: plan.binding, chainId: 4663, quotedAt, expiresAt: quotedAt + 30000,
      transaction: { ...plan.transaction, chainId: '0x1237', nonce: toHex(rpcNumber(rawNonce)), gas: toHex(gas), gasPrice: toHex(price) },
      profile: plan.profile, ponsBuildInput: buildInput, predictedAsset: asset, saltAttempt: 0, predictedPool: curve,
      graduationThreshold: terms.config.graduationThreshold.toString(), review: plan.review,
      estimatedGas: estimated.toString(), launchpadFeeWei: terms.fee.amountWei, launchFeeSource: terms.fee,
      maximumGasWei: (gas * price).toString(), usd };
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
    const p = plan.profile;
    const events = receipt.logs.filter(log => same(log.address, p.launcher.address)).flatMap(log => {
      try { return [decodeEventLog({ abi: PONS_ABI, eventName: 'TokenLaunched', data: log.data, topics: log.topics, strict: true }).args]; }
      catch { return []; }
    });
    const event = events[0];
    if (events.length !== 1 || !same(event.token, plan.predictedAsset) || !same(event.curve, plan.predictedPool)
      || !same(event.deployer, context.wallet) || !same(event.pairToken, zeroAddress)
      || event.launchConfigId.toString() !== p.launchConfigId || event.graduationThreshold.toString() !== plan.graduationThreshold) fail('launch_receipt_unverified');
    const [name, symbol, supply, info, launch] = await this.rpc.calls(4663, [
      call(plan.predictedAsset, 'name'), call(plan.predictedAsset, 'symbol'), call(plan.predictedAsset, 'totalSupply'),
      call(plan.predictedAsset, 'getTokenInfo'), call(p.launcher.address, 'getLaunchedToken', [plan.predictedAsset]),
    ], block);
    if (name !== context.draft.name || symbol !== context.draft.ticker || supply.toString() !== plan.review.totalSupply
      || !same(info[0], context.wallet) || info[1] !== plan.ponsBuildInput.imageUri || info[2] !== context.draft.description
      || Object.values(info[3]).some(Boolean) || !launch.exists || !same(launch.token, plan.predictedAsset)
      || !same(launch.curve, plan.predictedPool) || !same(launch.deployer, context.wallet)
      || !same(launch.creatorFeeRecipient, context.wallet) || !same(launch.pairToken, zeroAddress)
      || launch.creatorTaxBps !== 0 || launch.buybackEnabled) fail('launch_receipt_unverified');
  }
}
