import { LongRpc } from "./long-rpc.mjs";
import { createHash, createHmac } from "node:crypto";
import { decodeEventLog, decodeFunctionResult, isAddress, keccak256, parseAbi, toBytes, toHex, zeroAddress } from "viem";
import { buildUnsignedLongLaunch, LONG_CREATE_ABI, readLongLaunchProfile } from "./long-launch.mjs";
import { normalizeLaunchDetails } from "./launch-metadata.mjs";
import { ipfsContentId, ipfsUri, IPFS_IMPORT_PROFILE, LONG_IPFS_SCHEMA } from "./ipfs-content.mjs";
import { rpcNumber } from "./fee-rpc.mjs";
import { ReadCache, readJson, withinReadDeadline, checkReadDeadline } from "./upstream.mjs";
import { ServiceError } from "./errors.mjs";

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

export function validateLongInput(kind, value) {
  if (kind === "launch-prepare") {
    if (!exact(value, ["chainId", "wallet", "draft", "pairId", "publication"]) || value.chainId !== 4663
      || typeof value.wallet !== "string" || !isAddress(value.wallet) || same(value.wallet, zeroAddress)
      || typeof value.pairId !== "string" || !/^(?:long-[A-Z0-9._-]{1,24}|rwa-[a-f0-9]{24})$/.test(value.pairId)
      || !exact(value.publication, ["id", "imageHash", "metadataHash"])
      || !id(value.publication.id, 48) || !id(value.publication.imageHash) || !id(value.publication.metadataHash)) fail("invalid_request", 400);
    return { ...value, wallet: value.wallet.toLowerCase(), draft: normalizeLaunchDetails(value.draft) };
  }
  if (kind === "launch-reserve") {
    if (!exact(value, ["id", "binding"]) || !id(value.id) || !id(value.binding)) fail("invalid_request", 400);
  } else if (kind === "launch-status") {
    if (!exact(value, ["id", "hash"]) || !id(value.id)
      || (value.hash !== null && (typeof value.hash !== "string" || !/^0x[a-f0-9]{64}$/i.test(value.hash)))) fail("invalid_request", 400);
  } else fail("invalid_request", 400);
  return value;
}

export function readLongLiveConfig(env) {
  if (env.LONG_WALLET_LAUNCH !== "true") return null;
  try {
    const profile = readLongLaunchProfile(JSON.parse(env.LONG_LAUNCH_PROFILE_JSON));
    const guards = JSON.parse(env.LONG_LAUNCH_GUARDS_JSON);
    for (const q of profile.quotes) {
      const g = guards[q.id];
      if (!exact(g, ["tokenBeacon", "tokenImplementation", "oracleAggregator", "heartbeatSeconds"]) || !Number.isInteger(g.heartbeatSeconds) || g.heartbeatSeconds < 1 || g.heartbeatSeconds > 86400) fail("long_configuration");
      for (const c of [g.tokenBeacon, g.tokenImplementation, g.oracleAggregator]) if (!exact(c, ["address", "codeHash"]) || !isAddress(c.address)
        || same(c.address, zeroAddress) || !/^0x[a-f0-9]{64}$/i.test(c.codeHash)) fail("long_configuration");
    }
    const assetOrigin = env.LAUNCH_ASSET_SERVICE_ORIGIN;
    const url = new URL(assetOrigin);
    if (url.origin !== assetOrigin || url.username || url.password || !(url.protocol === "https:"
      || (url.protocol === "http:" && /^[a-z][a-z0-9-]{0,62}\.internal$/.test(url.hostname) && url.port === "8790"))) fail("long_configuration");
    return { profile, guards, assetOrigin };
  } catch { fail("long_configuration", 503); }
}

export class LongLive {
  constructor(config, upstream, budget, { now = Date.now, fetcher = fetch, rpc } = {}) {
    this.config = config; this.live = config.longLaunch; this.upstream = upstream; this.budget = budget;
    this.db = budget.db; this.now = now; this.fetcher = fetcher;
    this.rpc = rpc ?? new LongRpc(config, upstream, now);
    this.cache = new ReadCache(now, 32); this.active = false;
    // Additive table on the existing durable volume; never prune an attempted launch.
    this.db.exec(`CREATE TABLE IF NOT EXISTS long_launches (
      id TEXT PRIMARY KEY, context TEXT NOT NULL, state TEXT NOT NULL,
      plan TEXT NOT NULL, expires INTEGER NOT NULL, tx_hash TEXT, result TEXT
    )`);
  }
  async run(kind, raw) {
    const input = validateLongInput(kind, raw);
    if (!this.live || !this.config.readsEnabled) fail("long_launch_disabled", 503);
    if (kind === "launch-reserve") return this.reserve(input);
    if (this.active) throw new ServiceError("busy", 429, 5);
    this.active = true;
    try { return await withinReadDeadline(() => kind === "launch-prepare" ? this.prepare(input) : this.status(input)); }
    finally { this.active = false; }
  }
  row(key) { return this.db.prepare("SELECT * FROM long_launches WHERE id=?").get(key); }
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
    const key = createHmac("sha256", this.budget.key).update(`${input.wallet}:${input.publication.metadataHash}`).digest("hex");
    const context = JSON.stringify(input), prior = this.row(key);
    if (prior && prior.context !== context) fail("launch_context_locked");
    if (prior?.state !== undefined && prior.state !== "prepared") fail("launch_pending");
    if (prior && prior.expires > this.now()) return JSON.parse(prior.plan);
    this.budget.debit([["launch-prepare", 3, 60000], ["launch-prepare", 30, 86400000]]);
    if (!prior && this.db.prepare("SELECT COUNT(*) AS n FROM long_launches").get().n >= 4096) fail("launch_history_full");
    const publication = await this.metadata(input);
    const imageUri = ipfsUri(publication.ipfs.imageCid);
    const bytes = Buffer.from(JSON.stringify({ name: input.draft.name, symbol: input.draft.ticker,
      description: input.draft.description, image: imageUri, image_hash: imageUri }));
    if (digest(bytes) !== input.publication.metadataHash || await ipfsContentId(bytes) !== publication.ipfs.metadataCid) fail("launch_assets_unverified");
    const p = this.live.profile, q = p.quotes.find((q) => q.id === input.pairId);
    if (!q) fail("unsupported_pair", 400);
    const block = await this.rpc.block(4663);
    const g = this.live.guards[q.id];
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
    const intentId = `${key.slice(0,8)}-${key.slice(8,12)}-${key.slice(12,16)}-${key.slice(16,20)}-${key.slice(20,32)}`;
    const plan = buildUnsignedLongLaunch({ chainId: 4663, wallet: input.wallet, draft: input.draft, pairId: q.id,
      metadataUri: ipfsUri(publication.ipfs.metadataCid), startingTick: tick, intentId }, p);
    const [vacancy, accountCode] = await this.rpc.batch(4663, [
      { method: "eth_getCode", params: [plan.predictedAsset, block] },
      { method: "eth_getCode", params: [input.wallet, block] },
    ]);
    if (vacancy !== "0x") fail("launch_already_exists");
    if (accountCode !== "0x") fail("launch_eoa_required");
    const tx = { from: input.wallet, to: plan.transaction.to, data: plan.transaction.data, value: "0x0" };
    const [simulation, gasRaw, priceRaw, balanceRaw, nonceRaw] = await this.rpc.batch(4663, [
      { method: "eth_call", params: [tx, "pending"] }, { method: "eth_estimateGas", params: [tx, "pending"] },
      { method: "eth_gasPrice", params: [] }, { method: "eth_getBalance", params: [input.wallet, "pending"] },
      { method: "eth_getTransactionCount", params: [input.wallet, "pending"] },
    ]);
    const simulated = decodeFunctionResult({ abi: LONG_CREATE_ABI, functionName: "create", data: simulation });
    if (!same(simulated[0], plan.predictedAsset) || same(simulated[1], zeroAddress)) fail("launch_simulation_failed");
    const estimate = rpcNumber(gasRaw), gas = (estimate * 120n + 99n) / 100n, price = rpcNumber(priceRaw);
    if (estimate < 21000n || gas > 3000000n || price <= 0n || price > 10n ** 12n || gas * price > 5n * 10n ** 16n) fail("launch_gas_limit");
    if (rpcNumber(balanceRaw) < gas * price) fail("insufficient_funds");
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
      profile: p, startingTick: tick, intentId, predictedAsset: plan.predictedAsset, predictedPool: simulated[1], review: plan.review,
      estimatedGas: estimate.toString(), launchpadFeeWei: "0", maximumGasWei: (gas * price).toString(), usd };
    checkReadDeadline();
    this.db.prepare(`INSERT INTO long_launches(id,context,state,plan,expires) VALUES (?,?,'prepared',?,?)
      ON CONFLICT(id) DO UPDATE SET plan=excluded.plan,expires=excluded.expires WHERE state='prepared'`).run(key, context, JSON.stringify(result), result.expiresAt);
    return result;
  }
  reserve(input) {
    const row = this.row(input.id);
    if (!row || JSON.parse(row.plan).binding !== input.binding) fail("invalid_request", 400);
    if (row.expires <= this.now()) fail("quote_expired");
    const changed = this.db.prepare("UPDATE long_launches SET state='wallet' WHERE id=? AND state='prepared' AND expires>?").run(input.id, this.now());
    if (changed.changes !== 1) fail("launch_pending");
    return { id: input.id, status: "wallet" };
  }
  async status(input) {
    const row = this.row(input.id);
    if (!row) fail("launch_unknown");
    if (row.tx_hash && input.hash && !same(row.tx_hash, input.hash)) fail("launch_transaction_changed");
    if (row.result) return JSON.parse(row.result);
    const hash = row.tx_hash ?? input.hash;
    if (!hash) return { id: input.id, status: row.state === "prepared" ? "prepared" : "uncertain" };
    if (row.state === "prepared") fail("launch_unknown");
    return this.cache.get(`receipt:${input.id}:${hash}`, 10000, async () => {
      const [chain, tx, receipt] = await this.rpc.batch(4663, [
        { method: "eth_chainId", params: [] }, { method: "eth_getTransactionByHash", params: [hash] },
        { method: "eth_getTransactionReceipt", params: [hash] },
      ]);
      if (rpcNumber(chain) !== 4663n) fail("wrong_chain");
      if (!tx) return { id: input.id, status: "uncertain" };
      const plan = JSON.parse(row.plan), expected = plan.transaction;
      if (!same(tx.hash, hash) || !same(tx.from, expected.from) || !same(tx.to, expected.to)
        || !same(tx.input, expected.data) || rpcNumber(tx.value) !== 0n || rpcNumber(tx.nonce) !== rpcNumber(expected.nonce)
        || rpcNumber(tx.gas) !== rpcNumber(expected.gas) || rpcNumber(tx.gasPrice) > rpcNumber(expected.gasPrice)
        || rpcNumber(tx.chainId) !== 4663n) fail("launch_transaction_changed");
      this.db.prepare("UPDATE long_launches SET tx_hash=?,state='submitted' WHERE id=? AND tx_hash IS NULL").run(hash, input.id);
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
      const p = this.live.profile, context = JSON.parse(row.context), q = p.quotes.find((q) => q.id === context.pairId);
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
      if (name !== context.draft.name || symbol !== context.draft.ticker || uri !== plan.review.metadataUri || supply !== 10n ** 27n
        || !same(record[0], plan.predictedAsset) || Number(record[2]) - Number(record[1]) !== 86400
        || !same(asset[0], q.token.address) || !same(asset[3], p.liquidityMigrator.address) || !same(asset[4], p.poolInitializer.address)
        || !same(asset[5], plan.predictedPool) || asset[7] !== supply || asset[8] !== supply || !same(asset[9], p.integrator)) fail("launch_receipt_unverified");
      return this.finish(input.id, { status: "confirmed", hash, paidGasWei: paid.toString(), asset: plan.predictedAsset });
    });
  }
  finish(key, result) {
    const value = { id: key, ...result };
    this.db.prepare("UPDATE long_launches SET state=?,result=? WHERE id=?").run(result.status, JSON.stringify(value), key);
    return value;
  }
}
