import { LongRecovery } from "./long-recovery.mjs";
import { LongRpc } from "./long-rpc.mjs";
import { createHash, createHmac } from "node:crypto";
import { decodeEventLog, decodeFunctionResult, isAddress, keccak256, parseAbi, toBytes, toHex, zeroAddress } from "viem";
import { buildUnsignedLongLaunch, buildUnsignedLongLaunchAsync, LONG_CREATE_ABI, readLongLaunchProfile } from "./long-launch.mjs";
import { isCanonicalLongAsset } from '../../web/lib/long-encoding/long-salt.mjs';
import { normalizeLaunchDetails } from "./launch-metadata.mjs";
import { ipfsContentId, ipfsUri, IPFS_IMPORT_PROFILE, LONG_IPFS_SCHEMA } from "./ipfs-content.mjs";
import { rpcNumber } from "./fee-rpc.mjs";
import { ReadCache, readJson, withinReadDeadline, checkReadDeadline } from "./upstream.mjs";
import { ServiceError, InsufficientFundsError } from "./errors.mjs";

export const LONG_STATE_ABI = parseAbi([
  "function AIRLOCK() view returns (address)",
  "function TRUSTED_TOKEN_FACTORY() view returns (address)",
  "function RESERVATION_DURATION() view returns (uint48)",
  "function paused() view returns (bool)",
  "function isTickerAvailable(string) view returns (bool)",
  "function getTickerRecord(string) view returns (address,uint48,uint48)",
  "function getModuleState(address) view returns (uint8)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function aggregator() view returns (address)",
  "function implementation() view returns (address)",
  "function oraclePaused() view returns (bool)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function tokenURI() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function getAssetData(address) view returns (address,address,address,address,address,address,address,uint256,uint256,address)",
  "event LaunchCreated(address indexed poolOrHook,address indexed asset,address indexed numeraire,address poolInitializer,address launcher,bytes32 tickerKey,uint48 deployedAt,uint48 reservedUntil,string normalizedTicker)",
]);
const roles = ["launcher", "airlock", "tokenFactory", "governanceFactory", "poolInitializer", "liquidityMigrator", "dopplerHook"];
const digest = (v) => createHash("sha256").update(v).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const id = (v, size = 64) => typeof v === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(v);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const fail = (code, status = 409) => { throw new ServiceError(code, status); };
const beaconSlot = toHex(BigInt(keccak256(toBytes("eip1967.proxy.beacon"))) - 1n, { size: 32 });
const call = (address, functionName, args = []) => ({ address, abi: LONG_STATE_ABI, functionName, args });
const journalVersion = 1;
const base32 = "abcdefghijklmnopqrstuvwxyz234567";

function readLongLaunchGuard(value) {
  if (!exact(value, ["tokenBeacon", "tokenImplementation", "oracleAggregator", "heartbeatSeconds"])
    || !Number.isInteger(value.heartbeatSeconds) || value.heartbeatSeconds < 1 || value.heartbeatSeconds > 86400) fail("launch_journal_unverified", 503);
  const contracts = {};
  for (const role of ["tokenBeacon", "tokenImplementation", "oracleAggregator"]) {
    const contract = value[role];
    if (!exact(contract, ["address", "codeHash"]) || !isAddress(contract.address) || same(contract.address, zeroAddress)
      || !/^0x[a-f0-9]{64}$/i.test(contract.codeHash)) fail("launch_journal_unverified", 503);
    contracts[role] = { address: contract.address.toLowerCase(), codeHash: contract.codeHash.toLowerCase() };
  }
  return Object.freeze({ ...contracts, heartbeatSeconds: value.heartbeatSeconds });
}

function rawCidDigest(value) {
  if (typeof value !== "string" || !/^b[a-z2-7]{58}$/.test(value)) return null;
  const bytes = []; let pending = 0, bits = 0;
  for (const character of value.slice(1)) {
    pending = (pending << 5) | base32.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push(pending >> bits); pending &= (1 << bits) - 1; }
  }
  return pending === 0 && bytes.length === 36 && bytes[0] === 1 && bytes[1] === 0x55
    && bytes[2] === 0x12 && bytes[3] === 0x20 ? Buffer.from(bytes.slice(4)).toString("hex") : null;
}

export function validateLongInput(kind, value) {
  if (kind === "launch-estimate") {
    if (!exact(value, ["chainId", "pairId"]) || value.chainId !== 4663
      || typeof value.pairId !== "string" || !/^(?:long-(?:NVDA|TSLA)|longbow-[A-Z0-9._-]{1,24}|rwa-[a-f0-9]{24}|native|crypto-USDG)$/.test(value.pairId)) fail("invalid_request", 400);
    return value;
  }
  if (kind === "launch-prepare") {
    if (!exact(value, ["chainId", "wallet", "draft", "pairId", "publication", ...(Object.hasOwn(value ?? {}, "editableMetadata") ? ["editableMetadata"] : [])]) || value.chainId !== 4663
      || typeof value.wallet !== "string" || !isAddress(value.wallet) || same(value.wallet, zeroAddress)
      || typeof value.pairId !== "string" || !/^(?:(?:long|longbow)-[A-Z0-9._-]{1,24}|rwa-[a-f0-9]{24}|native|crypto-USDG)$/.test(value.pairId)
      || (value.editableMetadata !== undefined && (typeof value.editableMetadata !== "boolean" || value.pairId.startsWith("long")))
      || !exact(value.publication, ["id", "imageHash", "metadataHash"])
      || !id(value.publication.id, 48) || !id(value.publication.imageHash) || !id(value.publication.metadataHash)) fail("invalid_request", 400);
    const draft = normalizeLaunchDetails(value.draft);
    if ((draft.launchpad === "longbow") !== value.pairId.startsWith("longbow-")) fail("invalid_request", 400);
    return { ...value, wallet: value.wallet.toLowerCase(), draft };
  }
  if (kind === "launch-reserve") {
    if (!exact(value, ["id", "binding"]) || !id(value.id) || !id(value.binding)) fail("invalid_request", 400);
  } else if (kind === "launch-status") {
    if (!exact(value, ["id", "hash"]) || !id(value.id)
      || (value.hash !== null && (typeof value.hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(value.hash)))) fail("invalid_request", 400);
  } else fail("invalid_request", 400);
  return value;
}

export function readLongLaunchConfig(env) {
  try {
    const profile = readLongLaunchProfile(JSON.parse(env.LONG_LAUNCH_PROFILE_JSON));
    const configured = JSON.parse(env.LONG_LAUNCH_GUARDS_JSON), guards = {};
    for (const q of profile.quotes) {
      try { guards[q.id] = readLongLaunchGuard(configured[q.id]); }
      catch { fail("long_configuration"); }
    }
    const assetOrigin = env.LAUNCH_ASSET_SERVICE_ORIGIN;
    const url = new URL(assetOrigin);
    if (url.origin !== assetOrigin || url.username || url.password || !(url.protocol === "https:"
      || (url.protocol === "http:" && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(url.hostname) && url.port === "8790"))) fail("long_configuration");
    return { profile, guards: Object.freeze(guards), assetOrigin };
  } catch { fail("long_configuration", 503); }
}

export function readLongLiveConfig(env) {
  return env.LONG_WALLET_LAUNCH === "true" ? readLongLaunchConfig(env) : null;
}

export class LongLive {
  constructor(config, upstream, budget, { now = Date.now, fetcher = fetch, rpc } = {}) {
    this.config = config; this.live = config.longLaunch; this.upstream = upstream; this.budget = budget;
    this.db = budget.db; this.now = now; this.fetcher = fetcher;
    this.rpc = rpc ?? new LongRpc(config, upstream, now, { queue: true, parallel: true });
    this.recovery = new LongRecovery(this.rpc);
    this.cache = new ReadCache(now, 32); this.active = false;
    // Additive table on the existing durable volume; never prune an attempted launch.
    this.db.exec(`CREATE TABLE IF NOT EXISTS long_launches (
      id TEXT PRIMARY KEY, context TEXT NOT NULL, state TEXT NOT NULL,
      plan TEXT NOT NULL, expires INTEGER NOT NULL, tx_hash TEXT, result TEXT,
      journal_version INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS long_launch_attempts (
      id TEXT NOT NULL, envelope TEXT NOT NULL, plan TEXT NOT NULL,
      journal_version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(id,envelope)
    )`);
    // Existing durable rows predate reconstructable journal plans. Preserve them
    // as version zero while making the trust boundary explicit for every new row.
    for (const table of ["long_launches", "long_launch_attempts"]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === "journal_version"))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN journal_version INTEGER NOT NULL DEFAULT 0`);
    }
  }
  async run(kind, raw) {
    const input = validateLongInput(kind, raw);
    // Status is a read-only recovery path over the durable journal. Keep it
    // available when launch creation is switched off; every operation that can
    // offer or reserve a transaction still requires the current live profile.
    if (!this.config.readsEnabled || (kind !== "launch-status" && !this.live)) fail("long_launch_disabled", 503);
    if (kind === "launch-reserve") return this.reserve(input);
    if (kind === "launch-estimate") return withinReadDeadline(() => this.estimate(input));
    if (this.active) throw new ServiceError("busy", 429, 5);
    this.active = true;
    try { return await withinReadDeadline(() => kind === "launch-prepare" ? this.prepare(input) : this.status(input)); }
    finally { this.active = false; }
  }
  async estimate(input) {
    if (!this.live.profile.quotes.some(q => q.id === input.pairId)) fail("unsupported_pair", 400);
    // Shared across visitors, independent of artwork, wallet, reservations and quote budgets.
    const samples = this.db.prepare("SELECT plan,context FROM long_launches WHERE expires>? ORDER BY expires DESC LIMIT 20")
      .all(this.now() - 7 * 86400000).flatMap(row => {
        const plan = JSON.parse(row.plan), context = JSON.parse(row.context);
        if (context.pairId !== input.pairId || JSON.stringify({ ...plan.profile, quotes: plan.profile.quotes.filter(q => q.id === input.pairId) }) !== JSON.stringify({ ...this.live.profile, quotes: this.live.profile.quotes.filter(q => q.id === input.pairId) })
          || !/^\d+$/.test(plan.estimatedGas)) return [];
        const gas = Number(plan.estimatedGas);
        return gas >= 21000 && gas <= 2500000 ? [gas] : [];
      }).sort((a, b) => a - b);
    const market = await this.cache.get('approximate-gas-price', 300000, async () => {
      const [chain, rawPrice] = await this.rpc.batch(4663, [
        { method: "eth_chainId", params: [] }, { method: "eth_gasPrice", params: [] },
      ]);
      if (rpcNumber(chain) !== 4663n) fail("wrong_chain");
      const price = rpcNumber(rawPrice);
      if (price <= 0n || price > 10n ** 12n) fail("launch_gas_limit");
      const block = await this.rpc.block(4663);
      await this.rpc.verify(4663, [this.live.profile.launcher], true, block);
      return { price, fee: this.launchFee(block), quotedAt: this.now() };
    });
    const { price, quotedAt } = market;
    // With no comparable simulation, disclose the configured gas-unit ceiling.
    const gasUnits = samples.length ? samples[Math.floor(samples.length / 2)] : 3000000;
    return { chainId: 4663, pairId: input.pairId, gasUnits: String(gasUnits), gasPriceWei: String(price),
      launchpadFeeWei: market.fee.amountWei, launchFeeSource: market.fee, basis: samples.length ? "recent-simulations" : "gas-limit",
      quotedAt, expiresAt: quotedAt + 300000 };
  }
  launchFee(block) {
    // The reviewed create ABI is nonpayable and forwards no native value.
    // Only call after verifying the deployed launcher against that reviewed code.
    if (LONG_CREATE_ABI.find(entry => entry.name === "create")?.stateMutability !== "nonpayable") fail("contract_unverified");
    return { amountWei: "0", kind: "verified-contract", contract: this.live.profile.launcher.address,
      blockNumber: rpcNumber(block).toString() };
  }
  row(key) { return this.db.prepare("SELECT * FROM long_launches WHERE id=?").get(key); }
  journalProfile(value) { return readLongLaunchProfile(value); }
  journalId(context) {
    return createHmac("sha256", this.budget.key).update(`${context.wallet}:${context.publication.metadataHash}${context.pairId === "long-NVDA" ? "" : `:${context.pairId}`}`).digest("hex");
  }
  usesGuardSnapshot() { return true; }
  currentJournalKeys() {
    return ["id", "binding", "chainId", "quotedAt", "expiresAt", "transaction", "profile", "startingTick", "intentId",
      "predictedAsset", "saltAttempt", "predictedPool", "review", "estimatedGas", "launchpadFeeWei", "launchFeeSource",
      "maximumGasWei", "usd", "journalVersion", "publication", "guard"];
  }
  journalGasLimit() { return 3000000n; }
  journalContracts(profile, quote) {
    return [...roles.map((role) => profile[role]), quote.token, quote.oracle].filter(Boolean);
  }
  journalContext(row) {
    try { return validateLongInput("launch-prepare", JSON.parse(row.context)); }
    catch { fail("launch_journal_unverified", 503); }
  }
  journalPublication(value, context) {
    if (!exact(value, ["imageCid", "metadataCid"])) fail("launch_journal_unverified", 503);
    const imageUri = ipfsUri(value.imageCid), bytes = Buffer.from(JSON.stringify({
      name: context.draft.name, symbol: context.draft.ticker, description: context.draft.description,
      image: imageUri, image_hash: imageUri,
    }));
    if (digest(bytes) !== context.publication.metadataHash
      || rawCidDigest(value.metadataCid) !== context.publication.metadataHash) fail("launch_journal_unverified", 503);
    return Object.freeze({ imageCid: value.imageCid, metadataCid: value.metadataCid });
  }
  journalGuard(plan) {
    if (!this.usesGuardSnapshot()) {
      if (plan.guard !== undefined) fail("launch_journal_unverified", 503);
      return undefined;
    }
    const guard = readLongLaunchGuard(plan.guard);
    if (JSON.stringify(guard) !== JSON.stringify(plan.guard)) fail("launch_journal_unverified", 503);
    return guard;
  }
  liveGuard(context) {
    if (!this.usesGuardSnapshot()) return undefined;
    return readLongLaunchGuard(this.live?.guards?.[context.pairId]);
  }
  rebuildJournalPlan(plan, context, profile, publication, expectedId) {
    const intentId = `${expectedId.slice(0,8)}-${expectedId.slice(8,12)}-${expectedId.slice(12,16)}-${expectedId.slice(16,20)}-${expectedId.slice(20,32)}`;
    if (plan.intentId !== intentId) fail("launch_journal_unverified", 503);
    const rebuilt = buildUnsignedLongLaunch({ chainId: 4663, wallet: context.wallet, draft: context.draft,
      pairId: context.pairId, metadataUri: ipfsUri(publication.metadataCid), startingTick: plan.startingTick, intentId },
    profile, undefined, plan.saltAttempt);
    return rebuilt;
  }
  validateCurrentJournalPlan(plan, context, profile, expectedId) {
    if (!exact(plan, this.currentJournalKeys()) || plan.journalVersion !== journalVersion || plan.id !== expectedId
      || this.journalId(context) !== expectedId
      || plan.chainId !== 4663 || !Number.isSafeInteger(plan.quotedAt) || plan.quotedAt < 1
      || !Number.isSafeInteger(plan.expiresAt) || plan.expiresAt - plan.quotedAt !== 30000) fail("launch_journal_unverified", 503);
    const publication = this.journalPublication(plan.publication, context), guard = this.journalGuard(plan);
    const rebuilt = this.rebuildJournalPlan(plan, context, profile, publication, expectedId), transaction = plan.transaction;
    if (plan.binding !== rebuilt.binding || !same(plan.predictedAsset, rebuilt.predictedAsset)
      || JSON.stringify(plan.review) !== JSON.stringify(rebuilt.review)
      || !exact(transaction, ["from", "to", "data", "value", "chainId", "nonce", "gas", "gasPrice"])
      || !same(transaction.from, rebuilt.transaction.from) || !same(transaction.to, rebuilt.transaction.to)
      || transaction.data !== rebuilt.transaction.data || rpcNumber(transaction.value) !== BigInt(rebuilt.transaction.value)
      || transaction.chainId !== "0x1237" || !/^\d{1,8}$/.test(plan.estimatedGas)
      || !/^\d{1,17}$/.test(plan.launchpadFeeWei) || !/^\d{1,20}$/.test(plan.maximumGasWei)
      || !exact(plan.launchFeeSource, ["amountWei", "kind", "contract", "blockNumber"])
      || plan.launchFeeSource.kind !== "verified-contract" || plan.launchFeeSource.amountWei !== plan.launchpadFeeWei
      || !same(plan.launchFeeSource.contract, profile.launcher.address) || !/^\d{1,20}$/.test(plan.launchFeeSource.blockNumber)
      || !exact(plan.usd, ["microUsdPerEth", "sourceLabel", "quotedAt"])
      || plan.usd.sourceLabel !== "Coinbase ETH/USD spot" || !/^\d{1,12}$/.test(plan.usd.microUsdPerEth)
      || BigInt(plan.usd.microUsdPerEth) === 0n || !Number.isSafeInteger(plan.usd.quotedAt)
      || plan.usd.quotedAt > plan.quotedAt || plan.quotedAt - plan.usd.quotedAt >= 60000) fail("launch_journal_unverified", 503);
    const estimate = BigInt(plan.estimatedGas), gas = rpcNumber(transaction.gas), price = rpcNumber(transaction.gasPrice);
    const nonce = rpcNumber(transaction.nonce), value = rpcNumber(transaction.value), maximum = BigInt(plan.maximumGasWei);
    if (estimate < 21000n || gas !== (estimate * 120n + 99n) / 100n || gas > this.journalGasLimit()
      || price === 0n || price > 10n ** 12n || nonce > 2n ** 64n - 1n || value !== BigInt(plan.launchpadFeeWei)
      || maximum !== gas * price || maximum + value > 5n * 10n ** 16n
      || !isAddress(plan.predictedAsset) || same(plan.predictedAsset, zeroAddress)
      || typeof plan.predictedPool !== "string" || !/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(plan.predictedPool)) fail("launch_journal_unverified", 503);
    return { ...plan, profile, publication, ...(guard ? { guard } : {}) };
  }
  journalPlan(value, context, expectedId, version = 0) {
    try {
      const plan = typeof value === "string" ? JSON.parse(value) : value;
      const profile = this.journalProfile(plan?.profile);
      const quote = profile.quotes.find((entry) => entry.id === context.pairId);
      const transaction = plan?.transaction;
      if (JSON.stringify(profile) !== JSON.stringify(plan.profile) || !quote
        || !exact(transaction, ["from", "to", "data", "value", "chainId", "nonce", "gas", "gasPrice"])
        || !same(transaction.from, context.wallet) || !same(transaction.to, profile.launcher.address)
        || typeof transaction.data !== "string" || !/^0x(?:[a-f0-9]{2})+$/i.test(transaction.data) || transaction.data.length > 131074
        || rpcNumber(transaction.chainId) !== 4663n || rpcNumber(transaction.value) > 5n * 10n ** 16n
        || rpcNumber(transaction.nonce) > 2n ** 64n - 1n || rpcNumber(transaction.gas) < 21000n
        || rpcNumber(transaction.gas) > 8000000n || rpcNumber(transaction.gasPrice) > 10n ** 12n
        || !id(plan.binding) || !isAddress(plan.predictedAsset) || same(plan.predictedAsset, zeroAddress)
        || (typeof plan.predictedPool !== "string" || !/^0x(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(plan.predictedPool))
        || plan.review?.pairId !== context.pairId || typeof plan.review?.metadataUri !== "string") fail("launch_journal_unverified", 503);
      if (![0, journalVersion].includes(version)) fail("launch_journal_unverified", 503);
      if (version === journalVersion) return this.validateCurrentJournalPlan(plan, context, profile, expectedId);
      if (plan.journalVersion !== undefined || plan.publication !== undefined || plan.guard !== undefined) fail("launch_journal_unverified", 503);
      return { ...plan, profile };
    } catch { fail("launch_journal_unverified", 503); }
  }
  scopedProfile(profile, pairId) {
    const quote = profile.quotes.find((entry) => entry.id === pairId);
    return quote ? { ...profile, quotes: [quote] } : null;
  }
  liveProfileMatches(plan, context) {
    if (!this.live || plan.journalVersion !== journalVersion) return false;
    try {
      const current = this.journalProfile(this.live.profile);
      return JSON.stringify({ profile: this.scopedProfile(plan.profile, context.pairId), guard: this.journalGuard(plan) })
        === JSON.stringify({ profile: this.scopedProfile(current, context.pairId), guard: this.liveGuard(context) });
    } catch { return false; }
  }
  assertActionableProfile(row) {
    const context = this.journalContext(row), plan = this.journalPlan(row.plan, context, row.id, row.journal_version);
    if (!this.liveProfileMatches(plan, context)) fail("launch_configuration_changed", 503);
    return { context, plan };
  }
  async verifyJournalProfile(plan, context, block) {
    const profile = this.journalProfile(plan.profile), quote = profile.quotes.find((entry) => entry.id === context.pairId);
    if (!quote) fail("launch_journal_unverified", 503);
    // Verify the exact deployment profile stored with the plan at the receipt's
    // canonical block. The current environment may now describe another release.
    const guard = plan.journalVersion === journalVersion ? this.journalGuard(plan) : undefined;
    await this.rpc.verify(4663, this.journalContracts(profile, quote), true, block);
    if (guard) {
      await this.rpc.verify(4663, [guard.tokenBeacon, guard.tokenImplementation, guard.oracleAggregator], true, block);
      const [[implementation, aggregator], [beacon]] = await Promise.all([
        this.rpc.calls(4663, [call(guard.tokenBeacon.address, "implementation"), call(quote.oracle.address, "aggregator")], block),
        this.rpc.batch(4663, [{ method: "eth_getStorageAt", params: [quote.token.address, beaconSlot, block] }]),
      ]);
      if (!/^0x0{24}[a-f0-9]{40}$/i.test(beacon) || !same(`0x${beacon.slice(-40)}`, guard.tokenBeacon.address)
        || !same(implementation, guard.tokenImplementation.address) || !same(aggregator, guard.oracleAggregator.address)) fail("launch_receipt_unverified");
    }
  }
  async metadata(input) {
    return this.cache.get(`publication:${input.wallet}:${JSON.stringify(input.publication)}`, 30000, async () => {
      this.budget.debit([["launch-assets", 6, 60000], ["launch-assets", 60, 86400000]]);
      const response = await this.fetcher(`${this.live.assetOrigin}/v1/asset-status`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { origin: this.config.origin, "content-type": "application/json", "x-fungun-intent": "asset-status" },
        body: JSON.stringify({ chainId: 4663, wallet: input.wallet, ...input.publication }),
      });
      const value = await readJson(response, 8192);
      if (value.status !== "published" || value.id !== input.publication.id
        || value.imageHash !== input.publication.imageHash || value.metadataHash !== input.publication.metadataHash
        || value.ipfs?.profile !== IPFS_IMPORT_PROFILE || value.ipfs?.schema !== LONG_IPFS_SCHEMA) fail("launch_assets_unverified");
      return value;
    });
  }
  async prepare(input) {
    // Keep legacy NVDA IDs recoverable; other pairings have distinct transaction intents.
    const key = this.journalId(input);
    const context = JSON.stringify(input), prior = this.row(key);
    let savedContext, savedPlan;
    if (prior && prior.context !== context) {
      // Re-publication can issue a new upload ID for identical immutable content.
      // Keep the original transaction identity; only the upload ticket may differ.
      const original = JSON.parse(prior.context);
      const equivalent = { ...input, publication: { ...input.publication, id: original.publication.id } };
      if (JSON.stringify(equivalent) !== prior.context) fail("launch_context_locked");
    }
    if (prior) {
      savedContext = this.journalContext(prior);
      savedPlan = this.journalPlan(prior.plan, savedContext, key, prior.journal_version);
      if (prior.context !== context) {
        const publication = await this.metadata(input);
        if (ipfsUri(publication.ipfs.metadataCid) !== savedPlan.review.metadataUri) fail("launch_assets_unverified");
      }
    }
    const retry = prior?.state === "wallet" && !prior.tx_hash ? savedPlan : null;
    // A browser that copied another draft (or lost its local record) can recover
    // this exact intent without resubmitting it or asking for wallet history.
    const resume = () => ({ recovery: { id: key, binding: savedPlan.binding, hash: prior.tx_hash ?? null } });
    if (prior?.state !== undefined && prior.state !== "prepared" && !retry) return resume();
    if (retry && (await this.recovery.find(key, retry.transaction)).status !== "retryable") return resume();
    if (!retry && prior && prior.expires > this.now() && this.liveProfileMatches(savedPlan, savedContext)
      && isCanonicalLongAsset(savedPlan.predictedAsset) && Number.isInteger(savedPlan.saltAttempt)) return savedPlan;
    if (!prior && this.db.prepare("SELECT COUNT(*) AS n FROM long_launches").get().n >= 4096) fail("launch_history_full");
    const p = this.live.profile, q = p.quotes.find((q) => q.id === input.pairId);
    if (!q) fail("unsupported_pair", 400);
    const publication = await this.metadata(input);
    const imageUri = ipfsUri(publication.ipfs.imageCid);
    const bytes = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker,
      description: input.draft.description, image: imageUri, image_hash: imageUri }));
    if (digest(bytes) !== input.publication.metadataHash || await ipfsContentId(bytes) !== publication.ipfs.metadataCid) fail("launch_assets_unverified");
    const block = await this.rpc.block(4663);
    const g = readLongLaunchGuard(this.live.guards[q.id]);
    await this.rpc.verify(4663, [...roles.map((r) => p[r]), q.token, q.oracle], true, block);
    await this.rpc.verify(4663, [g.tokenBeacon, g.tokenImplementation, g.oracleAggregator], true, block);
    const [airlock, factory, duration, paused, ...moduleStates] = await this.rpc.calls(4663, [
      call(p.launcher.address, "AIRLOCK"), call(p.launcher.address, "TRUSTED_TOKEN_FACTORY"),
      call(p.launcher.address, "RESERVATION_DURATION"), call(p.launcher.address, "paused"),
      ...["tokenFactory", "governanceFactory", "poolInitializer", "liquidityMigrator"].map((r) => call(p.airlock.address, "getModuleState", [p[r].address])),
    ], block);
    if (!same(airlock, p.airlock.address) || !same(factory, p.tokenFactory.address) || Number(duration) !== 86400
      || paused || moduleStates.some((v, i) => v !== i + 1)) fail("contract_unverified");
    const [tokenDecimals, feedDecimals, round, available, implementation, aggregator, oraclePaused] = await this.rpc.calls(4663, [
      call(q.token.address, "decimals"), call(q.oracle.address, "decimals"), call(q.oracle.address, "latestRoundData"),
      call(p.launcher.address, "isTickerAvailable", [input.draft.ticker]), call(g.tokenBeacon.address, "implementation"),
      call(q.oracle.address, "aggregator"), call(q.token.address, "oraclePaused"),
    ], block);
    const [beacon, header] = await this.rpc.batch(4663, [
      { method: "eth_getStorageAt", params: [q.token.address, beaconSlot, block] },
      { method: "eth_getBlockByNumber", params: [block, false] },
    ]);
    const timestamp = Number(rpcNumber(header?.timestamp));
    if (Math.abs(this.now() / 1000 - timestamp) > 30 || tokenDecimals !== 18 || feedDecimals !== 8
      || !/^0x0{24}[a-f0-9]{40}$/i.test(beacon) || !same(`0x${beacon.slice(-40)}`, g.tokenBeacon.address)
      || !same(implementation, g.tokenImplementation.address) || !same(aggregator, g.oracleAggregator.address)) fail("contract_unverified");
    if (!available) fail("ticker_reserved");
    // Fail closed outside a fresh trading observation, including corporate-action pauses.
    const [roundId, answer, started, updated, answered] = round;
    if (oraclePaused || answer <= 0n || answer > 10n ** 20n || started === 0n || started > updated
      || answered < roundId || updated > BigInt(timestamp) || BigInt(timestamp) - updated > BigInt(g.heartbeatSeconds)) fail("oracle_stale");
    const tick = 8 * Math.round((-108202 - Math.log(Number(answer) / 1e8) / Math.log(1.0001)) / 8);
    // Requotes retain the original nonce. Journal every offered envelope so a
    // delayed original submission can still be verified after fees/prices change.
    const intentId = `${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`;
    // The scarce shared allowance gates CPU mining only after the server-issued
    // publication ticket, immutable content, configured quote and live launch
    // dependencies have all been verified. Earlier work retains its own request,
    // asset-status and upstream bounds.
    this.budget.launch("prepare");
    const plan = await buildUnsignedLongLaunchAsync({ chainId: 4663, wallet: input.wallet, draft: input.draft, pairId: q.id,
      metadataUri: ipfsUri(publication.ipfs.metadataCid), startingTick: tick, intentId }, p, undefined, checkReadDeadline);
    const [vacancy, accountCode] = await this.rpc.batch(4663, [
      { method: "eth_getCode", params: [plan.predictedAsset, block] },
      { method: "eth_getCode", params: [input.wallet, block] },
    ]);
    if (vacancy !== "0x") fail("launch_already_exists");
    if (accountCode !== "0x") fail("launch_eoa_required");
    const tx = { from: input.wallet, to: plan.transaction.to, data: plan.transaction.data, value: "0x0" };
    const [priceRaw, balanceRaw, nonceRaw] = await this.rpc.batch(4663, [
      { method: "eth_gasPrice", params: [] }, { method: "eth_getBalance", params: [input.wallet, "pending"] },
      { method: "eth_getTransactionCount", params: [input.wallet, "pending"] },
    ]);
    const price = rpcNumber(priceRaw), balance = rpcNumber(balanceRaw);
    if (price <= 0n || price > 10n ** 12n) fail("launch_gas_limit");
    let simulation, gasRaw;
    try {
      [simulation, gasRaw] = await this.rpc.batch(4663, [
        { method: "eth_call", params: [tx, "pending"] }, { method: "eth_estimateGas", params: [tx, "pending"] },
      ]);
    } catch (error) {
      // Some nodes refuse gas estimation before returning units when the sender
      // is underfunded. Report the disclosed gas ceiling, never an invented exact estimate.
      if (error?.code === "insufficient_funds" && balance < 3000000n * price) {
        if (3000000n * price > 5n * 10n ** 16n) fail("launch_gas_limit");
        throw new InsufficientFundsError(balance, 3000000n * price, "gas-limit");
      }
      throw error;
    }
    const simulated = decodeFunctionResult({ abi: LONG_CREATE_ABI, functionName: "create", data: simulation });
    if (!same(simulated[0], plan.predictedAsset) || same(simulated[1], zeroAddress)) fail("launch_simulation_failed");
    const estimate = rpcNumber(gasRaw), gas = (estimate * 120n + 99n) / 100n;
    if (retry && rpcNumber(nonceRaw) !== rpcNumber(retry.transaction.nonce)) fail("launch_pending");
    if (estimate < 21000n || gas > 3000000n || price <= 0n || price > 10n ** 12n || gas * price > 5n * 10n ** 16n) fail("launch_gas_limit");
    if (balance < gas * price) throw new InsufficientFundsError(balance, gas * price);
    const usd = await this.cache.get("eth-usd", 30000, async () => {
      const body = await this.upstream.json("coinbase", "https://api.coinbase.com/v2/prices/ETH-USD/spot", {}, 8192);
      const amount = body?.data?.amount;
      if (body?.data?.base !== "ETH" || body?.data?.currency !== "USD" || typeof amount !== "string"
        || !/^\d{1,6}(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) fail("usd_unavailable");
      return { microUsdPerEth: String(Math.round(Number(amount) * 1e6)), sourceLabel: "Coinbase ETH/USD spot", quotedAt: this.now() };
    });
    const quotedAt = this.now();
    const result = { id: key, binding: plan.binding, chainId: 4663, quotedAt, expiresAt: quotedAt + 30000,
      transaction: { ...tx, chainId: "0x1237", nonce: toHex(rpcNumber(nonceRaw)), gas: toHex(gas), gasPrice: toHex(price) },
      profile: p, startingTick: tick, intentId, predictedAsset: plan.predictedAsset, saltAttempt: plan.saltAttempt, predictedPool: simulated[1], review: plan.review,
      estimatedGas: estimate.toString(), launchpadFeeWei: this.launchFee(block).amountWei,
      launchFeeSource: this.launchFee(block), maximumGasWei: (gas * price).toString(), usd,
      journalVersion, publication: { imageCid: publication.ipfs.imageCid, metadataCid: publication.ipfs.metadataCid }, guard: g };
    checkReadDeadline();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (retry) this.remember(key, retry, prior.journal_version);
      this.remember(key, result, journalVersion);
      this.db.prepare(`INSERT INTO long_launches(id,context,state,plan,expires,journal_version) VALUES (?,?,'prepared',?,?,?)
        ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,expires=excluded.expires,journal_version=excluded.journal_version
        WHERE state IN ('prepared','wallet') AND tx_hash IS NULL`).run(key, context, JSON.stringify(result), result.expiresAt, journalVersion);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return result;
  }
  remember(key, plan, version = 0) {
    const envelope = digest(JSON.stringify(plan.transaction));
    if (this.db.prepare("SELECT 1 FROM long_launch_attempts WHERE id=? AND envelope=?").get(key, envelope)) return;
    if (this.db.prepare("SELECT COUNT(*) AS n FROM long_launch_attempts WHERE id=?").get(key).n >= 16) fail("launch_attempt_limit");
    this.db.prepare("INSERT INTO long_launch_attempts(id,envelope,plan,journal_version) VALUES (?,?,?,?)").run(key, envelope, JSON.stringify(plan), version);
  }
  reserve(input) {
    const row = this.row(input.id);
    if (!row) fail("invalid_request", 400);
    const { plan } = this.assertActionableProfile(row);
    if (plan.binding !== input.binding) fail("invalid_request", 400);
    if (row.expires <= this.now()) fail("quote_expired");
    const changed = this.db.prepare("UPDATE long_launches SET state='wallet' WHERE id=? AND state IN ('prepared','wallet') AND tx_hash IS NULL AND expires>?").run(input.id, this.now());
    if (changed.changes !== 1) fail("launch_pending");
    return { id: input.id, status: "wallet" };
  }
  terminalResult(row, plan) {
    let result;
    try { result = JSON.parse(row.result); } catch { fail("launch_journal_unverified", 503); }
    const confirmed = result?.status === "confirmed";
    const keys = confirmed ? ["id", "status", "hash", "paidGasWei", "asset"] : ["id", "status", "hash", "paidGasWei"];
    if (!exact(result, keys) || !["confirmed", "failed"].includes(result.status) || row.state !== result.status
      || result.id !== row.id || typeof row.tx_hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(row.tx_hash)
      || typeof result.hash !== "string" || !same(result.hash, row.tx_hash)
      || typeof result.paidGasWei !== "string" || !/^\d{1,78}$/.test(result.paidGasWei)
      || BigInt(result.paidGasWei) > 2n ** 256n - 1n
      || (confirmed && (!isAddress(result.asset) || same(result.asset, zeroAddress)
        || (plan && !same(result.asset, plan.predictedAsset))))) fail("launch_journal_unverified", 503);
    return result;
  }
  async status(input) {
    const row = this.row(input.id);
    if (!row) fail("launch_unknown");
    if (row.tx_hash && input.hash && !same(row.tx_hash, input.hash)) fail("launch_transaction_changed");
    if (row.result) {
      if (![0, journalVersion].includes(row.journal_version)) fail("launch_journal_unverified", 503);
      let plan;
      if (row.journal_version === journalVersion) {
        const context = this.journalContext(row);
        plan = this.journalPlan(row.plan, context, row.id, row.journal_version);
      }
      return this.terminalResult(row, plan);
    }
    if (!["prepared", "wallet", "submitted"].includes(row.state)
      || (row.tx_hash && !/^0x[a-f0-9]{64}$/i.test(row.tx_hash))) fail("launch_journal_unverified", 503);
    const context = this.journalContext(row), savedPlan = this.journalPlan(row.plan, context, row.id, row.journal_version);
    let hash = row.tx_hash ?? input.hash;
    if (!hash) {
      if (row.state === "prepared") return { id: input.id, status: "retryable" };
      const found = await this.cache.get(`recover:${input.id}`, 5000,
        () => this.recovery.find(input.id, savedPlan.transaction));
      if (!found.hash) return { id: input.id, status: found.status };
      hash = found.hash;
    }
    if (row.state === "prepared") fail("launch_unknown");
    return this.cache.get(`receipt:${input.id}:${hash}`, 10000, async () => {
      const [chain, tx, receipt] = await this.rpc.batch(4663, [
        { method: "eth_chainId", params: [] }, { method: "eth_getTransactionByHash", params: [hash] },
        { method: "eth_getTransactionReceipt", params: [hash] },
      ]);
      if (rpcNumber(chain) !== 4663n) fail("wrong_chain");
      if (!tx) return { id: input.id, status: "uncertain" };
      const plans = [savedPlan, ...this.db.prepare("SELECT plan,journal_version FROM long_launch_attempts WHERE id=?").all(input.id)
        .map((entry) => this.journalPlan(entry.plan, context, row.id, entry.journal_version))];
      // Match the launch intent, not wallet-controlled fee settings. Extensions
      // may buffer gas again or convert a legacy quote to EIP-1559. The receipt,
      // event and deployed state below determine whether the launch succeeded;
      // preparation and wallet dispatch still enforce our quoted gas budget.
      const plan = plans.find((candidate) => {
        const expected = candidate.transaction;
        return same(tx.from, expected.from) && same(tx.to, expected.to) && same(tx.input, expected.data)
          && rpcNumber(tx.value) === rpcNumber(expected.value) && rpcNumber(tx.nonce) === rpcNumber(expected.nonce);
      });
      if (!plan) fail("launch_transaction_changed");
      const expected = plan.transaction;
      if (!same(tx.hash, hash) || !same(tx.from, expected.from) || !same(tx.to, expected.to)
        || !same(tx.input, expected.data) || rpcNumber(tx.value) !== rpcNumber(expected.value) || rpcNumber(tx.nonce) !== rpcNumber(expected.nonce)
        || rpcNumber(tx.chainId) !== 4663n) fail("launch_transaction_changed");
      // Make the matched envelope the canonical row before waiting for its
      // receipt. Terminal reads can then validate the saved asset against the
      // exact reconstructed plan, including when a delayed earlier quote won.
      this.db.prepare("UPDATE long_launches SET tx_hash=?,state='submitted',plan=?,journal_version=? WHERE id=?")
        .run(hash, JSON.stringify(plan), plan.journalVersion === journalVersion ? journalVersion : 0, input.id);
      if (!receipt) return { id: input.id, status: "submitted", hash };
      if (!same(receipt.transactionHash, hash) || !same(receipt.from, expected.from) || !same(receipt.to, expected.to)
        || !same(receipt.blockHash, tx.blockHash) || receipt.blockNumber !== tx.blockNumber) fail("launch_receipt_unverified");
      const block = receipt.blockNumber;
      const [header, head] = await this.rpc.batch(4663, [
        { method: "eth_getBlockByNumber", params: [block, false] }, { method: "eth_blockNumber", params: [] },
      ]);
      if (!same(header?.hash, receipt.blockHash) || rpcNumber(head) < rpcNumber(block) + 12n)
        return { id: input.id, status: "confirming", hash };
      const paid = rpcNumber(receipt.gasUsed) * rpcNumber(receipt.effectiveGasPrice);
      if (rpcNumber(receipt.status) === 0n) return this.finish(input.id, { status: "failed", hash, paidGasWei: paid.toString() });
      if (rpcNumber(receipt.status) !== 1n || !Array.isArray(receipt.logs)) fail("launch_receipt_unverified");
      await this.verifyJournalProfile(plan, context, block);
      await this.confirm(plan, context, receipt, block);
      return this.finish(input.id, { status: "confirmed", hash, paidGasWei: paid.toString(), asset: plan.predictedAsset });
    });
  }
  async confirm(plan, context, receipt, block) {
    const expected = plan.transaction;
      const p = plan.profile, q = p.quotes.find((q) => q.id === context.pairId);
      const events = receipt.logs.filter((l) => same(l.address, p.launcher.address)).flatMap((l) => {
        try { return [decodeEventLog({ abi: LONG_STATE_ABI, eventName: "LaunchCreated", data: l.data, topics: l.topics, strict: true }).args]; }
        catch { return []; }
      });
      const event = events[0];
      if (events.length !== 1 || !same(event.asset, plan.predictedAsset) || !same(event.poolOrHook, plan.predictedPool)
        || !same(event.numeraire, q.token.address) || !same(event.poolInitializer, p.poolInitializer.address)
        || !same(event.launcher, expected.from) || event.normalizedTicker !== context.draft.ticker
        || !same(event.tickerKey, keccak256(toBytes(context.draft.ticker))) || Number(event.reservedUntil) - Number(event.deployedAt) !== 86400) fail("launch_receipt_unverified");
      const [name, symbol, uri, supply, record, asset] = await this.rpc.calls(4663, [
        call(plan.predictedAsset, "name"), call(plan.predictedAsset, "symbol"), call(plan.predictedAsset, "tokenURI"), call(plan.predictedAsset, "totalSupply"),
        call(p.launcher.address, "getTickerRecord", [context.draft.ticker]), call(p.airlock.address, "getAssetData", [plan.predictedAsset]),
      ], block);
      // Airlock stores sale supply before total supply. They differ on Longbow
      // because 1% vests to the platform instead of going on the curve.
      const [numeraire, , , migrator, initializer, pool, , tokensForSale, initialSupply, integrator] = asset;
      if (name !== context.draft.name || symbol !== context.draft.ticker || uri !== plan.review.metadataUri || supply !== 10n ** 27n
        || !same(record[0], plan.predictedAsset) || Number(record[2]) - Number(record[1]) !== 86400
        || !same(numeraire, q.token.address) || !same(migrator, p.liquidityMigrator.address) || !same(initializer, p.poolInitializer.address)
        || !same(pool, plan.predictedPool) || initialSupply !== supply || tokensForSale !== BigInt(plan.review.tokensForSale) || !same(integrator, p.integrator)) fail("launch_receipt_unverified");
  }
  finish(key, result) {
    const value = { id: key, ...result };
    this.db.prepare("UPDATE long_launches SET state=?,result=? WHERE id=?").run(result.status, JSON.stringify(value), key);
    return value;
  }
}
