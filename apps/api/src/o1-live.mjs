import { createHash, createHmac } from 'node:crypto';
import { decodeEventLog, decodeFunctionResult, toHex, zeroAddress } from 'viem';
import { LongLive, readLongLaunchConfig } from './long-live.mjs';
import { O1MetadataPublisher } from './o1-metadata.mjs';
import { readLaunchTokens, launchPairId } from './launch-catalog.mjs';
import { O1_LAUNCH_ABI, buildUnsignedO1Launch, o1Params, readO1LaunchProfile } from '../../web/lib/long-encoding/o1-launch.mjs';
import { o1Metadata } from '../../web/lib/long-encoding/o1-metadata.mjs';
import { ipfsContentId, ipfsUri } from './ipfs-content.mjs';
import { rpcNumber } from './fee-rpc.mjs';
import { checkReadDeadline } from './upstream.mjs';
import { ServiceError, InsufficientFundsError, UnsupportedPairError } from './errors.mjs';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = code => { throw new ServiceError(code, 409); };
const call = (address, functionName, args = []) => ({ address, abi: O1_LAUNCH_ABI, functionName, args });
const roles = ['launcher', 'tokenDeployer', 'hook', 'feeEscrow', 'announcementRegistry'];
const gasLimit = 8000000n;
export function readO1LiveConfig(env, longLaunch) {
  if (env.O1_WALLET_LAUNCH !== 'true') return null;
  try {
    if (typeof env.O1_API_KEY !== 'string' || !env.O1_API_KEY.trim()) throw new Error();
    // O1 reuses reviewed token and publication pins from the Long configuration,
    // but its switch must not implicitly enable the Long launch handler.
    const dependencies = longLaunch ?? readLongLaunchConfig(env);
    const template = dependencies.profile.quotes[0].token;
    const profile = readO1LaunchProfile({ ...JSON.parse(env.O1_LAUNCH_PROFILE_JSON), quotes: [
      { id: 'native', token: null, decimals: 18 }, ...readLaunchTokens({ ...env, ROBINHOOD_LAUNCH_TOKENS_JSON: env.O1_LAUNCH_TOKENS_JSON }).map(token => ({ id: launchPairId('o1', token),
        decimals: 18, token: { address: token.address, codeHash: template.codeHash } })),
      ...JSON.parse(env.LONG_EXTRA_QUOTES_JSON || '[]').filter(entry => entry.quote.symbol === 'USDG').map(entry => ({
        id: 'crypto-USDG', token: entry.quote.token, decimals: entry.quote.decimals })),
    ] });
    return { profile, assetOrigin: dependencies.assetOrigin };
  } catch { throw new ServiceError('o1_configuration', 503); }
}
export class O1Live extends LongLive {
  constructor(config, upstream, budget, options) {
    super({ ...config, longLaunch: config.o1Launch }, upstream, budget, options);
    this.o1Metadata = new O1MetadataPublisher(this.db, upstream, this.fetcher, config.o1Key);
  }
  journalProfile(value) { return readO1LaunchProfile(value); }
  journalId(context) {
    return createHmac('sha256', this.budget.key).update(`o1:${context.wallet}:${context.publication.metadataHash}:${context.pairId}:${context.editableMetadata ?? false}`).digest('hex');
  }
  usesGuardSnapshot() { return false; }
  currentJournalKeys() {
    return ['id', 'binding', 'chainId', 'quotedAt', 'expiresAt', 'o1MetadataVersion', 'transaction', 'profile', 'buildInput',
      'predictedAsset', 'saltAttempt', 'predictedPool', 'tickSpacing', 'review', 'estimatedGas', 'launchpadFeeWei',
      'launchFeeSource', 'maximumGasWei', 'usd', 'journalVersion', 'publication'];
  }
  journalGasLimit() { return gasLimit; }
  rebuildJournalPlan(plan, context, profile, publication, expectedId) {
    const keys = ['wallet', 'draft', 'pairId', 'metadataUri', 'editableMetadata', 'configVersion', 'chainDeadline',
      'totalSupply', 'launchpadFeeWei', 'intentId', 'initCodeHash'];
    const source = plan.buildInput;
    if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).length !== keys.length
      || keys.some(key => !Object.hasOwn(source, key)) || plan.o1MetadataVersion !== 1
      || !Number.isInteger(plan.tickSpacing) || plan.tickSpacing < -8388608 || plan.tickSpacing > 8388607) fail('launch_journal_unverified');
    const buildInput = { ...source, wallet: context.wallet, draft: context.draft, pairId: context.pairId,
      metadataUri: o1Metadata(context.draft, publication.imageCid).uri,
      editableMetadata: context.editableMetadata ?? false, intentId: expectedId };
    if (keys.some(key => JSON.stringify(buildInput[key]) !== JSON.stringify(source[key]))
      || buildInput.launchpadFeeWei !== plan.launchpadFeeWei
      || buildInput.chainDeadline * 1000 <= plan.expiresAt
      || buildInput.chainDeadline * 1000 > plan.quotedAt + 1830000) fail('launch_journal_unverified');
    return buildUnsignedO1Launch(buildInput, profile, plan.saltAttempt);
  }
  journalContracts(profile, quote) {
    return [...roles.map(role => profile[role]), ...(quote.token ? [quote.token] : [])];
  }
  async launchFee(block) {
    const [fee] = await this.rpc.calls(4663, [call(this.live.profile.launcher.address, 'nativeLaunchFee')], block);
    if (fee < 0n || fee > 5n * 10n ** 16n) fail('launch_gas_limit');
    return { amountWei: fee.toString(), kind: 'verified-contract', contract: this.live.profile.launcher.address,
      blockNumber: rpcNumber(block).toString() };
  }
  async estimate(input) {
    if (!this.live.profile.quotes.some(q => q.id === input.pairId)) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const market = await this.cache.get('approximate-gas-price', 300000, async () => {
      const block = await this.rpc.block(4663);
      await this.rpc.verify(4663, [this.live.profile.launcher], true, block);
      const [raw] = await this.rpc.batch(4663, [{ method: 'eth_gasPrice', params: [] }]);
      const price = rpcNumber(raw);
      if (price <= 0n || price > 10n ** 12n) fail('launch_gas_limit');
      return { price, fee: await this.launchFee(block), quotedAt: this.now() };
    });
    return { chainId: 4663, pairId: input.pairId, gasUnits: gasLimit.toString(), gasPriceWei: market.price.toString(),
      launchpadFeeWei: market.fee.amountWei, launchFeeSource: market.fee, basis: 'gas-limit',
      quotedAt: market.quotedAt, expiresAt: market.quotedAt + 300000 };
  }
  async prepare(input) {
    const quote = this.live.profile.quotes.find(q => q.id === input.pairId);
    if (!quote) throw new UnsupportedPairError(this.live.profile.quotes.map(q => q.id));
    const p = { ...this.live.profile, quotes: [quote] };
    const editableMetadata = input.editableMetadata ?? false;
    const key = this.journalId(input);
    const context = JSON.stringify(input), prior = this.row(key);
    if (prior && prior.context !== context) {
      const original = JSON.parse(prior.context);
      if (JSON.stringify({ ...input, publication: { ...input.publication, id: original.publication.id } }) !== prior.context) fail('launch_context_locked');
    }
    const savedContext = prior ? this.journalContext(prior) : null;
    const savedPlan = prior ? this.journalPlan(prior.plan, savedContext, key, prior.journal_version) : null;
    const retry = prior?.state === 'wallet' && !prior.tx_hash ? savedPlan : null;
    const resume = () => ({ recovery: { id: key, binding: savedPlan.binding, hash: prior.tx_hash ?? null } });
    if (prior && prior.state !== 'prepared' && !retry) return resume();
    if (retry && (await this.recovery.find(key, retry.transaction)).status !== 'retryable') return resume();
    if (!retry && prior && prior.expires > this.now() && this.liveProfileMatches(savedPlan, savedContext)) return savedPlan;
    if (!prior && this.db.prepare('SELECT COUNT(*) AS n FROM long_launches').get().n >= 4096) fail('launch_history_full');
    const publication = await this.metadata(input), imageUri = ipfsUri(publication.ipfs.imageCid);
    const metadata = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker,
      description: input.draft.description, image: imageUri, image_hash: imageUri }));
    if (createHash('sha256').update(metadata).digest('hex') !== input.publication.metadataHash
      || await ipfsContentId(metadata) !== publication.ipfs.metadataCid) fail('launch_assets_unverified');
    const block = await this.rpc.block(4663);
    await this.rpc.verify(4663, [...roles.map(role => p[role]), ...(quote.token ? [quote.token] : [])], true, block);
    const [version, supply, enabled, registered, suffix, deployer, hook, registry, deployerFactory, escrow, spacing] = await this.rpc.calls(4663, [
      call(p.launcher.address, 'configVersion'), call(p.launcher.address, 'launchSupply'), call(p.launcher.address, 'launchCreationEnabled'),
      call(p.launcher.address, 'quoteConfig', [quote.token?.address ?? zeroAddress]), call(p.launcher.address, 'TOKEN_ADDRESS_SUFFIX'),
      call(p.launcher.address, 'tokenDeployer'), call(p.launcher.address, 'hook'), call(p.launcher.address, 'announcementRegistry'),
      call(p.tokenDeployer.address, 'factory'), call(p.hook.address, 'feeEscrow'), call(p.launcher.address, 'tickSpacing'),
    ], block);
    if (!enabled) fail('o1_launch_disabled');
    if (!registered[0] || registered[1] !== quote.decimals) fail('unsupported_pair');
    if (suffix !== 1 || !same(deployer, p.tokenDeployer.address) || !same(hook, p.hook.address)
      || !same(registry, p.announcementRegistry.address) || !same(deployerFactory, p.launcher.address) || !same(escrow, p.feeEscrow.address)) fail('contract_unverified');
    const [header] = await this.rpc.batch(4663, [{ method: 'eth_getBlockByNumber', params: [block, false] }]);
    const timestamp = Number(rpcNumber(header.timestamp));
    if (Math.abs(this.now() / 1000 - timestamp) > 30) fail('contract_unverified');
    const fee = await this.launchFee(block);
    // Admit scarce preparation only after the current contract configuration
    // and fee have been verified, but before the provider write and salt work.
    // This uses the same 3/minute and 30/day pool as Long preparations.
    this.budget.launch('prepare');
    const pinned = await this.o1Metadata.prepare(key, input, publication, quote.token?.address ?? zeroAddress);
    const buildInput = { wallet: input.wallet, draft: input.draft, pairId: input.pairId,
      metadataUri: pinned.metadataUri, editableMetadata, configVersion: version.toString(),
      chainDeadline: timestamp + 1800, totalSupply: supply.toString(), launchpadFeeWei: fee.amountWei, intentId: key };
    const [initCodeHash] = await this.rpc.calls(4663, [call(p.launcher.address, 'launchTokenBytecodeHash', [o1Params(buildInput, quote)])], block);
    buildInput.initCodeHash = initCodeHash;
    const plan = buildUnsignedO1Launch(buildInput, p);
    const [vacancy, accountCode, rawPrice, rawBalance, rawNonce] = await this.rpc.batch(4663, [
      { method: 'eth_getCode', params: [plan.predictedAsset, block] }, { method: 'eth_getCode', params: [input.wallet, block] },
      { method: 'eth_gasPrice', params: [] }, { method: 'eth_getBalance', params: [input.wallet, 'pending'] },
      { method: 'eth_getTransactionCount', params: [input.wallet, 'pending'] },
    ]);
    if (vacancy !== '0x') fail('launch_already_exists');
    if (accountCode !== '0x') fail('launch_eoa_required');
    const price = rpcNumber(rawPrice), balance = rpcNumber(rawBalance), value = BigInt(fee.amountWei);
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
    const [asset, pool] = decodeFunctionResult({ abi: O1_LAUNCH_ABI, functionName: 'createLaunch', data: result });
    if (!same(asset, plan.predictedAsset) || /^0x0+$/.test(pool)) fail('launch_simulation_failed');
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
    const prepared = { id: key, binding: plan.binding, chainId: 4663, quotedAt, expiresAt: quotedAt + 30000, o1MetadataVersion: 1,
      transaction: { ...plan.transaction, chainId: '0x1237', nonce: toHex(rpcNumber(rawNonce)), gas: toHex(gas), gasPrice: toHex(price) },
      profile: plan.profile, buildInput, predictedAsset: plan.predictedAsset, saltAttempt: plan.saltAttempt, predictedPool: pool,
      tickSpacing: spacing, review: plan.review, estimatedGas: estimated.toString(), launchpadFeeWei: fee.amountWei,
      launchFeeSource: fee, maximumGasWei: (gas * price).toString(), usd, journalVersion: 1,
      publication: { imageCid: publication.ipfs.imageCid, metadataCid: publication.ipfs.metadataCid } };
    checkReadDeadline();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (retry) this.remember(key, retry, prior.journal_version);
      this.remember(key, prepared, 1);
      this.db.prepare(`INSERT INTO long_launches(id,context,state,plan,expires,journal_version) VALUES (?,?,'prepared',?,?,1)
        ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,expires=excluded.expires,journal_version=excluded.journal_version
        WHERE state IN ('prepared','wallet') AND tx_hash IS NULL`).run(key, context, JSON.stringify(prepared), prepared.expiresAt);
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
    const [name, symbol, uri, supply, factory, authority, rights] = await this.rpc.calls(4663, [
      call(plan.predictedAsset, 'name'), call(plan.predictedAsset, 'symbol'), call(plan.predictedAsset, 'contractURI'),
      call(plan.predictedAsset, 'totalSupply'), call(plan.predictedAsset, 'factory'), call(plan.predictedAsset, 'metadataAuthority'),
      call(p.launcher.address, 'creatorRights', [plan.predictedAsset]),
    ], block);
    if (name !== context.draft.name || symbol !== context.draft.ticker || uri !== plan.review.metadataUri
      || supply.toString() !== plan.review.totalSupply || !same(factory, p.launcher.address)
      || !same(authority, plan.review.metadataMutable ? p.launcher.address : zeroAddress)
      || !same(rights.originalCreator, context.wallet) || !same(rights.currentCreator, context.wallet)
      || !same(rights.pendingCreator, zeroAddress) || !same(rights.creatorFeeRecipient, context.wallet)
      || !same(rights.poolId, plan.predictedPool) || rights.metadataEditable !== plan.review.metadataMutable) fail('launch_receipt_unverified');
  }
}
