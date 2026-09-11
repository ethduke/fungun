import { createHash, createHmac } from 'node:crypto';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeAbiParameters, keccak256, toBytes, toHex, zeroAddress } from 'viem';
import { BaseLaunchLive } from './base-launch-live.mjs';
import { O1MetadataPublisher } from './o1-metadata.mjs';
import { readLaunchTokens, launchPairId } from './launch-catalog.mjs';
import { O1_LAUNCH_ABI, O1_BASE_ABI, B20_FACTORY, B20_ACTIVATION, o1LaunchRoles, buildUnsignedO1Launch, o1Params, readO1LaunchProfile } from '../../web/lib/long-encoding/o1-launch.mjs';
import { ipfsContentId, ipfsUri } from './ipfs-content.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { checkReadDeadline } from './upstream.mjs';
import { ServiceError, InsufficientFundsError, UnsupportedPairError } from './errors.mjs';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = code => { throw new ServiceError(code, 409); };
const call = (address, functionName, args = []) => ({ address, abi: O1_LAUNCH_ABI, functionName, args });
const gasLimit = 8000000n;
export function readO1BaseLiveConfig(env) {
  if (env.O1_BASE_WALLET_LAUNCH !== 'true') return null;
  try {
    const profile = readO1LaunchProfile(JSON.parse(env.O1_BASE_LAUNCH_PROFILE_JSON));
    const origin = new URL(env.LAUNCH_ASSET_SERVICE_ORIGIN);
    if (profile.chainId !== 8453 || origin.origin !== env.LAUNCH_ASSET_SERVICE_ORIGIN || origin.username || origin.password
      || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(origin.hostname) && origin.port === '8790')))
      throw new Error();
    return { profile, assetOrigin: origin.origin };
  } catch { throw new ServiceError('o1_configuration', 503); }
}
export function readO1LiveConfig(env, longLaunch) {
  if (env.O1_WALLET_LAUNCH !== 'true') return null;
  try {
    const template = longLaunch.profile.quotes[0].token;
    const profile = readO1LaunchProfile({ ...JSON.parse(env.O1_LAUNCH_PROFILE_JSON), quotes: [
      { id: 'native', token: null, decimals: 18 }, ...readLaunchTokens({ ...env, ROBINHOOD_LAUNCH_TOKENS_JSON: env.O1_LAUNCH_TOKENS_JSON }).map(token => ({ id: launchPairId('o1', token),
        decimals: 18, token: { address: token.address, codeHash: template.codeHash } })),
      ...JSON.parse(env.LONG_EXTRA_QUOTES_JSON || '[]').filter(entry => entry.quote.symbol === 'USDG').map(entry => ({
        id: 'crypto-USDG', token: entry.quote.token, decimals: entry.quote.decimals })),
    ] });
    return { profile, assetOrigin: longLaunch.assetOrigin };
  } catch { throw new ServiceError('o1_configuration', 503); }
}
export class O1Live extends BaseLaunchLive {
  constructor(config, upstream, budget, options) {
    super({ ...config, longLaunch: config.o1Launch }, upstream, budget, options);
    this.o1Metadata = new O1MetadataPublisher(this.db, upstream, this.fetcher, config.o1Key);
  }
  async verifyTokenFactory(p, quote, block) {
    if (this.chainId === 8453) {
      const [validator, active, initialized] = await this.rpc.calls(8453, [
        { address: p.launcher.address, abi: O1_BASE_ABI, functionName: 'launchTokenValidator' },
        { address: B20_ACTIVATION, abi: O1_BASE_ABI, functionName: 'isActivated', args: [keccak256(toBytes('base.b20_asset'))] },
        ...(quote.token ? [{ address: B20_FACTORY, abi: O1_BASE_ABI, functionName: 'isB20Initialized', args: [quote.token.address] }] : []),
      ], block);
      if (!same(validator, p.launchTokenValidator.address) || !active || (quote.token && !initialized)) fail('contract_unverified');
    } else {
      const [deployer, factory] = await this.rpc.calls(this.chainId, [
        call(p.launcher.address, 'tokenDeployer'), call(p.tokenDeployer.address, 'factory'),
      ], block);
      if (!same(deployer, p.tokenDeployer.address) || !same(factory, p.launcher.address)) fail('contract_unverified');
    }
  }
  async launchFee(block) {
    const [fee] = await this.rpc.calls(this.chainId, [call(this.live.profile.launcher.address, 'nativeLaunchFee')], block);
    if (fee < 0n || fee > 5n * 10n ** 16n) fail('launch_gas_limit');
    return { amountWei: fee.toString(), kind: 'verified-contract', contract: this.live.profile.launcher.address,
      blockNumber: rpcNumber(block).toString() };
  }
  async estimate(input) {
    if (!this.live.profile.quotes.some(q => q.id === input.pairId)) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const market = await this.cache.get('approximate-gas-price', 300000, async () => {
      const block = await this.rpc.block(this.chainId);
      await this.rpc.verify(this.chainId, [this.live.profile.launcher], true, block);
      const [raw] = await this.rpc.batch(this.chainId, [{ method: 'eth_gasPrice', params: [] }]);
      const price = rpcNumber(raw);
      if (price <= 0n || price > 10n ** 12n) fail('launch_gas_limit');
      return { price, fee: await this.launchFee(block), quotedAt: this.now() };
    });
    if (this.chainId === 8453) {
      if (!this.config.feeContracts?.baseOracle) fail('contract_unverified');
      // Base data fees require the actual transaction bytes. Never display an
      // incomplete execution-only estimate as the complete network budget.
      return { chainId: 8453, pairId: input.pairId, basis: 'requires-calldata',
        launchpadFeeWei: market.fee.amountWei, launchFeeSource: market.fee,
        quotedAt: market.quotedAt, expiresAt: market.quotedAt + 300000 };
    }
    return { chainId: this.chainId, pairId: input.pairId, gasUnits: gasLimit.toString(), gasPriceWei: market.price.toString(),
      launchpadFeeWei: market.fee.amountWei, launchFeeSource: market.fee, basis: 'gas-limit',
      quotedAt: market.quotedAt, expiresAt: market.quotedAt + 300000 };
  }
  async prepare(input) {
    const quote = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!quote) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const p = { ...this.live.profile, quotes: [quote] };
    const base = this.chainId === 8453;
    const editableMetadata = input.editableMetadata ?? false;
    const key = createHmac('sha256', this.budget.key).update(`o1:${this.chainId === 8453 ? '8453:' : ''}${input.wallet}:${input.publication.metadataHash}:${input.pairId}:${editableMetadata}`).digest('hex');
    const context = JSON.stringify(input), prior = this.row(key);
    if (prior && prior.context !== context) {
      const original = JSON.parse(prior.context);
      if (JSON.stringify({ ...input, publication: { ...input.publication, id: original.publication.id } }) !== prior.context) fail('launch_context_locked');
    }
    const retry = prior?.state === 'wallet' && !prior.tx_hash ? JSON.parse(prior.plan) : null;
    const resume = () => ({ recovery: { id: key, binding: JSON.parse(prior.plan).binding, hash: prior.tx_hash ?? null } });
    if (prior && prior.state !== 'prepared' && !retry) return resume();
    if (retry && (await this.recovery.find(key, retry.transaction)).status !== 'retryable') return resume();
    if (!retry && prior && prior.expires > this.now() && JSON.parse(prior.plan).o1MetadataVersion === 1) return JSON.parse(prior.plan);
    this.budget.launch('prepare', 'o1');
    if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n >= 4096) fail('launch_history_full');
    const publication = await this.metadata(input), imageUri = ipfsUri(publication.ipfs.imageCid);
    const metadata = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker,
      description: input.draft.description, image: imageUri, image_hash: imageUri,
      ...(input.draft.website !== undefined ? { website: input.draft.website } : {}),
      ...(input.draft.twitter !== undefined ? { twitter: input.draft.twitter } : {}) }));
    if (createHash('sha256').update(metadata).digest('hex') !== input.publication.metadataHash
      || await ipfsContentId(metadata) !== publication.ipfs.metadataCid) fail('launch_assets_unverified');
    const pinned = await this.o1Metadata.prepare(key, input, publication, quote.token?.address ?? zeroAddress);
    const block = await this.rpc.block(this.chainId);
    await this.rpc.verify(this.chainId, [...o1LaunchRoles(this.chainId).map(role => p[role]), ...(!base && quote.token ? [quote.token] : [])], true, block);
    const [version, supply, enabled, registered, suffix, hook, registry, escrow, spacing] = await this.rpc.calls(this.chainId, [
      call(p.launcher.address, 'configVersion'), call(p.launcher.address, 'launchSupply'), call(p.launcher.address, 'launchCreationEnabled'),
      call(p.launcher.address, 'quoteConfig', [quote.token?.address ?? zeroAddress]), call(p.launcher.address, 'TOKEN_ADDRESS_SUFFIX'),
      call(p.launcher.address, 'hook'), call(p.launcher.address, 'announcementRegistry'),
      call(p.hook.address, 'feeEscrow'), call(p.launcher.address, 'tickSpacing'),
    ], block);
    if (!enabled) fail('o1_launch_disabled');
    if (!registered[0] || registered[1] !== quote.decimals) fail('unsupported_pair');
    if (suffix !== 1 || !same(hook, p.hook.address) || !same(registry, p.announcementRegistry.address) || !same(escrow, p.feeEscrow.address)) fail('contract_unverified');
    await this.verifyTokenFactory(p, quote, block);
    const [header] = await this.rpc.batch(this.chainId, [{ method: 'eth_getBlockByNumber', params: [block, false] }]);
    const timestamp = Number(rpcNumber(header.timestamp));
    if (Math.abs(this.now() / 1000 - timestamp) > 30) fail('contract_unverified');
    const fee = await this.launchFee(block);
    const buildInput = { wallet: input.wallet, draft: input.draft, pairId: input.pairId,
      metadataUri: pinned.metadataUri, editableMetadata, configVersion: version.toString(),
      chainDeadline: timestamp + 1800, totalSupply: supply.toString(), launchpadFeeWei: fee.amountWei, intentId: key };
    if (!base) {
      const [initCodeHash] = await this.rpc.calls(this.chainId, [call(p.launcher.address, 'launchTokenBytecodeHash', [o1Params(buildInput, quote)])], block);
      buildInput.initCodeHash = initCodeHash;
    }
    const plan = buildUnsignedO1Launch(buildInput, p);
    const [accountCode, rawPrice, rawBalance, rawNonce, vacancy] = await this.rpc.batch(this.chainId, [
      { method: 'eth_getCode', params: [input.wallet, block] },
      { method: 'eth_gasPrice', params: [] }, { method: 'eth_getBalance', params: [input.wallet, 'pending'] },
      { method: 'eth_getTransactionCount', params: [input.wallet, 'pending'] },
      ...(!base ? [{ method: 'eth_getCode', params: [plan.predictedAsset, block] }] : []),
    ]);
    if (base) {
      const params = decodeFunctionData({ abi: O1_LAUNCH_ABI, data: plan.transaction.data }).args[0];
      const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [input.wallet, params.creatorSalt]));
      const [predicted, initialized] = await this.rpc.calls(this.chainId, [
        { address: B20_FACTORY, abi: O1_BASE_ABI, functionName: 'getB20Address', args: [0, p.launcher.address, salt] },
        { address: B20_FACTORY, abi: O1_BASE_ABI, functionName: 'isB20Initialized', args: [plan.predictedAsset] },
      ], block);
      if (!same(predicted, plan.predictedAsset)) fail('contract_unverified');
      if (initialized) fail('launch_already_exists');
    } else if (vacancy !== '0x') fail('launch_already_exists');
    if (accountCode !== '0x') fail('launch_eoa_required');
    const price = rpcNumber(rawPrice), balance = rpcNumber(rawBalance), value = BigInt(fee.amountWei);
    if (price <= 0n || price > 10n ** 12n) fail('launch_gas_limit');
    let result, rawGas;
    try { [result, rawGas] = await this.rpc.batch(this.chainId, [
      { method: 'eth_call', params: [plan.transaction, 'pending'] },
      { method: 'eth_estimateGas', params: [plan.transaction, 'pending'] },
    ]); } catch (error) {
      if (error?.code === 'insufficient_funds' && balance < gasLimit * price + value) {
        const fallbackFees = base ? await this.baseFees(plan.transaction, gasLimit, price, rpcNumber(rawNonce), block) : null;
        const required = gasLimit * price + value + (fallbackFees ? BigInt(fallbackFees.l1DataFeeWei) + BigInt(fallbackFees.operatorFeeWei) : 0n);
        throw new InsufficientFundsError(balance, required, 'gas-limit', this.chainId);
      }
      throw error;
    }
    const [asset, pool] = decodeFunctionResult({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', data: result });
    if (!same(asset, plan.predictedAsset) || /^0x0+$/.test(pool)) fail('launch_simulation_failed');
    const estimated = rpcNumber(rawGas), gas = (estimated * 120n + 99n) / 100n;
    if (estimated < 21000n || gas > gasLimit || gas * price + value > 5n * 10n ** 16n) fail('launch_gas_limit');
    if (retry && rpcNumber(rawNonce) !== rpcNumber(retry.transaction.nonce)) fail('launch_pending');
    const baseFees = base ? await this.baseFees(plan.transaction, gas, price, rpcNumber(rawNonce), block) : undefined;
    const maximumGas = gas * price + (baseFees ? BigInt(baseFees.l1DataFeeWei) + BigInt(baseFees.operatorFeeWei) : 0n);
    if (maximumGas + value > 5n * 10n ** 16n) fail('launch_gas_limit');
    if (balance < maximumGas + value) throw new InsufficientFundsError(balance, maximumGas + value, 'simulation', this.chainId);
    const usd = await this.cache.get('eth-usd', 30000, async () => {
      const data = await this.upstream.json('coinbase', 'https://api.coinbase.com/v2/prices/ETH-USD/spot', {}, 8192);
      if (data?.data?.base !== 'ETH' || data?.data?.currency !== 'USD' || typeof data.data.amount !== 'string'
        || !/^\d{1,6}(?:\.\d{1,6})?$/.test(data.data.amount) || Number(data.data.amount) <= 0) fail('usd_unavailable');
      return { microUsdPerEth: String(Math.round(Number(data.data.amount) * 1e6)), sourceLabel: 'Coinbase ETH/USD spot', quotedAt: this.now() };
    });
    const quotedAt = this.now();
    const prepared = { id: key, binding: plan.binding, chainId: this.chainId, quotedAt, expiresAt: quotedAt + 30000, o1MetadataVersion: 1,
      transaction: { ...plan.transaction, chainId: toHex(this.chainId), nonce: toHex(rpcNumber(rawNonce)), gas: toHex(gas), gasPrice: toHex(price) },
      profile: plan.profile, buildInput, predictedAsset: plan.predictedAsset, saltAttempt: plan.saltAttempt, predictedPool: pool,
      tickSpacing: spacing, review: plan.review, estimatedGas: estimated.toString(), launchpadFeeWei: fee.amountWei,
      launchFeeSource: fee, maximumGasWei: maximumGas.toString(), ...(baseFees ? { baseFees } : {}), usd };
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
    const events = receipt.logs.filter(log => same(log.address, p.launcher.address)).flatMap(log => {
      try { return [decodeEventLog({ abi: O1_LAUNCH_ABI, eventName: 'Launched', data: log.data, topics: log.topics, strict: true }).args]; }
      catch { return []; }
    });
    const event = events[0];
    if (events.length !== 1 || !same(event.token, plan.predictedAsset) || !same(event.poolId, plan.predictedPool)
      || !same(event.originalCreator, context.wallet) || !same(event.quoteToken, quote.token?.address ?? zeroAddress)
      || event.launchSupply.toString() !== plan.review.totalSupply || event.tickSpacing !== plan.tickSpacing) fail('launch_receipt_unverified');
    const [name, symbol, uri, supply, rights] = await this.rpc.calls(this.chainId, [
      call(plan.predictedAsset, 'name'), call(plan.predictedAsset, 'symbol'), call(plan.predictedAsset, 'contractURI'),
      call(plan.predictedAsset, 'totalSupply'),
      call(p.launcher.address, 'creatorRights', [plan.predictedAsset]),
    ], block);
    if (name !== context.draft.name || symbol !== context.draft.ticker || uri !== plan.review.metadataUri
      || supply.toString() !== plan.review.totalSupply
      || !same(rights.originalCreator, context.wallet) || !same(rights.creatorFeeRecipient, context.wallet)
      || !same(rights.poolId, plan.predictedPool) || rights.metadataEditable !== plan.review.metadataMutable) fail('launch_receipt_unverified');
    if (this.chainId === 8453) {
      await this.rpc.calls(8453, [{ address: p.launchTokenValidator.address, abi: O1_BASE_ABI, functionName: 'validate',
        args: [plan.predictedAsset, context.wallet, p.launcher.address, p.hook.address, supply, plan.review.metadataMutable] }], block);
    } else {
      const [factory, authority] = await this.rpc.calls(this.chainId, [call(plan.predictedAsset, 'factory'), call(plan.predictedAsset, 'metadataAuthority')], block);
      if (!same(factory, p.launcher.address) || !same(authority, plan.review.metadataMutable ? p.launcher.address : zeroAddress)) fail('launch_receipt_unverified');
    }
  }
}
