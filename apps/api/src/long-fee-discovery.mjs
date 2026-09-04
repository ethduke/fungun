import { decodeEventLog, parseAbi, toEventSelector, toHex, zeroAddress } from "viem";
import { ServiceError } from "./errors.mjs";
import { managerAbi, poolId, sameAddress, validAddress } from "./fee-contracts.mjs";
import { rpcNumber } from "./fee-rpc.mjs";
import { ReadCache } from "./upstream.mjs";

// Reviewed source: whetstoneresearch/doppler@bda077cf, DopplerHookInitializer.sol
// and base/FeesManager.sol. Lock's indexed `pool` is the launched asset address.
// UpdateBeneficiary is deliberately scanned too: holding a token, or creating it,
// does not establish current ownership of its fee shares.
export const longDiscoveryAbi = parseAbi([
  "struct BeneficiaryData { address beneficiary; uint96 shares; }",
  "event Lock(address indexed pool, BeneficiaryData[] beneficiaries)",
  "event UpdateBeneficiary(bytes32 poolId, address oldBeneficiary, address newBeneficiary)",
  "function getPoolKey(bytes32 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);
const currencyAbi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const topics = longDiscoveryAbi.filter((item) => item.type === "event").map(toEventSelector);
const MAX_LOGS = 256;
const PAGE_SIZE = 2;
const logCaches = new WeakMap();
const hash = (value) => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const view = (address, abi, functionName, args = []) => ({ address, abi, functionName, args });
const invalid = () => new ServiceError("invalid_response");

function validKey(key, manager) {
  return (
    key && validAddress(key.currency0, true) && validAddress(key.currency1) &&
    BigInt(key.currency0) < BigInt(key.currency1) && sameAddress(key.hooks, manager) &&
    Number.isInteger(key.fee) && key.fee >= 0 && key.fee < 2 ** 24 &&
    Number.isInteger(key.tickSpacing) && key.tickSpacing > 0 && key.tickSpacing < 2 ** 23
  );
}

function candidatesFromLogs(logs, profile, address, fromBlock, toBlock) {
  if (!Array.isArray(logs) || logs.length > MAX_LOGS) throw invalid();
  const candidates = new Map();
  const seen = new Map();
  for (const log of logs) {
    if (
      !log || !sameAddress(log.address, profile.manager) || log.removed !== false ||
      !hash(log.blockHash) || !hash(log.transactionHash) ||
      !Array.isArray(log.topics) || log.topics.some((topic) => !hash(topic)) ||
      typeof log.data !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(log.data) ||
      log.data.length > 64 * 1024
    ) throw invalid();
    const height = rpcNumber(log.blockNumber);
    if (height < fromBlock || height > toBlock) throw invalid();
    const key = `${log.blockHash}:${rpcNumber(log.logIndex)}`;
    const fingerprint = JSON.stringify([log.transactionHash, log.topics, log.data]);
    if (seen.has(key) && seen.get(key) !== fingerprint) throw invalid();
    seen.set(key, fingerprint);
    let event;
    try {
      event = decodeEventLog({ abi: longDiscoveryAbi, data: log.data, topics: log.topics, strict: true });
    } catch {
      throw invalid();
    }
    if (event.eventName === "Lock") {
      if (log.topics.length !== 2 || !validAddress(event.args.pool)) throw invalid();
      const beneficiaries = event.args.beneficiaries;
      if (
        !beneficiaries.length || beneficiaries.length > MAX_LOGS ||
        beneficiaries.some((entry) => !validAddress(entry.beneficiary) || entry.shares <= 0n || entry.shares > 10n ** 18n) ||
        new Set(beneficiaries.map((entry) => entry.beneficiary.toLowerCase())).size !== beneficiaries.length ||
        beneficiaries.reduce((total, entry) => total + entry.shares, 0n) !== 10n ** 18n
      ) throw invalid();
      if (beneficiaries.some((entry) => sameAddress(entry.beneficiary, address))) {
        const asset = event.args.pool.toLowerCase();
        candidates.set(`asset:${asset}`, { asset });
      }
    } else if (event.eventName === "UpdateBeneficiary") {
      if (
        log.topics.length !== 1 || !hash(event.args.poolId) ||
        !validAddress(event.args.oldBeneficiary) || !validAddress(event.args.newBeneficiary, true)
      ) throw invalid();
      if (sameAddress(event.args.newBeneficiary, address)) {
        const id = event.args.poolId.toLowerCase();
        candidates.set(`pool:${id}`, { poolId: id });
      }
    } else throw invalid();
  }
  return [...candidates.values()];
}

async function currencies(rpc, addresses, block) {
  const calls = addresses.filter((address) => !sameAddress(address, zeroAddress)).flatMap((address) => [
    view(address, currencyAbi, "symbol"), view(address, currencyAbi, "decimals"),
  ]);
  const results = calls.length ? await rpc.calls(4663, calls, block) : [];
  let index = 0;
  return addresses.map((address) => {
    if (sameAddress(address, zeroAddress)) return { address: zeroAddress, symbol: "ETH", decimals: 18 };
    const symbol = results[index++];
    const decimals = results[index++];
    if (
      typeof symbol !== "string" || !/^[A-Za-z0-9._-]{1,24}$/.test(symbol) ||
      !Number.isInteger(decimals) || decimals < 0 || decimals > 36
    ) throw invalid();
    return { address: address.toLowerCase(), symbol, decimals };
  });
}

async function resolvePool(rpc, profile, address, block, candidate) {
  let assets = candidate.asset ? [candidate.asset] : [];
  if (candidate.poolId) {
    const [tuple] = await rpc.calls(4663, [view(profile.manager, longDiscoveryAbi, "getPoolKey", [candidate.poolId])], block);
    const [currency0, currency1, fee, tickSpacing, hooks] = tuple;
    const key = { currency0, currency1, fee, tickSpacing, hooks };
    if (!validKey(key, profile.manager) || poolId({ currency0: { address: currency0 }, currency1: { address: currency1 }, fee, tickSpacing }, profile.manager) !== candidate.poolId) throw invalid();
    assets = [currency0, currency1].filter((asset) => !sameAddress(asset, zeroAddress));
  }
  const states = await rpc.calls(4663, assets.map((asset) => view(profile.manager, managerAbi, "getState", [asset])), block);
  const matches = states.flatMap((state, index) => {
    const [numeraire, , hook, , status, key] = state;
    if (status === 0) return [];
    if (!validKey(key, profile.manager)) throw invalid();
    const asset = assets[index];
    if (
      ![key.currency0, key.currency1].some((value) => sameAddress(value, asset)) ||
      !sameAddress(numeraire, sameAddress(asset, key.currency0) ? key.currency1 : key.currency0)
    ) throw invalid();
    const pool = { asset: asset.toLowerCase(), currency0: { address: key.currency0 }, currency1: { address: key.currency1 }, fee: key.fee, tickSpacing: key.tickSpacing };
    if (candidate.poolId && poolId(pool, profile.manager) !== candidate.poolId) return [];
    return [{ pool, hook, status }];
  });
  if (matches.length !== 1) throw invalid();
  const { pool, hook, status } = matches[0];
  // The initializer also hosts other integrations. Only the reviewed Long hook
  // belongs to this adapter; graduated/migrated pools cannot be claimed here.
  const [shares] = await rpc.calls(4663, [view(profile.manager, managerAbi, "getShares", [poolId(pool, profile.manager), address])], block);
  if (typeof shares !== "bigint" || shares < 0n || shares > 10n ** 18n) throw invalid();
  if (shares === 0n) return {};
  if (!sameAddress(hook, profile.hook) || status !== 2) return { partial: true };
  [pool.currency0, pool.currency1] = await currencies(rpc, [pool.currency0.address, pool.currency1.address], block);
  return { pool };
}

/**
 * Read one bounded page. The caller verifies profile manager/hook bytecode at
 * `block`, retains that block for the whole scan, and keeps nextState server-side
 * behind an opaque wallet-bound cursor. No caller-provided RPC targets are used.
 */
export async function discoverLongFeePools(rpc, profile, address, block, state) {
  const config = profile.discovery;
  if (
    !config || !Number.isSafeInteger(config.fromBlock) || config.fromBlock < 0 ||
    !Number.isInteger(config.blockRange) || config.blockRange < 1 || config.blockRange > 10000 ||
    !validAddress(address) || !validAddress(profile.manager) || !validAddress(profile.hook)
  ) throw new ServiceError("invalid_fee_configuration");
  const snapshot = rpcNumber(block);
  const fromBlock = BigInt(config.fromBlock);
  if (state && (
    typeof state.nextBlock !== "string" || !/^(0|[1-9]\d{0,77})$/.test(state.nextBlock) ||
    !Array.isArray(state.pending) || typeof state.partial !== "boolean" ||
    !Number.isInteger(state.blockRange) || state.blockRange < 1 || state.blockRange > config.blockRange
  )) throw invalid();
  let nextBlock = state ? BigInt(state.nextBlock) : fromBlock;
  let pending = state ? [...state.pending] : [];
  let partial = state?.partial === true;
  let blockRange = state?.blockRange ?? config.blockRange;
  if (
    nextBlock < fromBlock || nextBlock > snapshot + 1n || pending.length > MAX_LOGS ||
    pending.some((candidate) => !candidate || !(
      Object.keys(candidate).length === 1 &&
      (validAddress(candidate.asset) || hash(candidate.poolId))
    ))
  ) throw invalid();
  if (!pending.length && nextBlock <= snapshot) {
    const end = nextBlock + BigInt(blockRange) - 1n;
    const toBlock = end > snapshot ? snapshot : end;
    if (!logCaches.has(rpc)) logCaches.set(rpc, new ReadCache(Date.now, 64));
    let logs;
    try {
      [logs] = await logCaches.get(rpc).get(JSON.stringify([profile.manager, nextBlock.toString(), toBlock.toString()]), 45_000, () => rpc.batch(4663, [{ method: "eth_getLogs", params: [{
        address: profile.manager, fromBlock: toHex(nextBlock), toBlock: toHex(toBlock), topics: [topics],
      }] }]));
    } catch (error) {
      // RPC range/response-size limits are provider specific. A continuation
      // retries a smaller range, never skips the failed blocks or converts them
      // to zero. Rate limits and other errors remain visible to the caller.
      if (error.code !== "upstream_unavailable" || blockRange === 1) throw error;
      return {
        pools: [], partial,
        nextState: { nextBlock: nextBlock.toString(), pending: [], partial, blockRange: Math.max(1, Math.floor(blockRange / 2)) },
        progress: { scannedThroughBlock: nextBlock > fromBlock ? (nextBlock - 1n).toString() : null, toBlock: snapshot.toString() },
      };
    }
    if (Array.isArray(logs) && logs.length > MAX_LOGS && blockRange > 1) {
      return {
        pools: [], partial,
        nextState: { nextBlock: nextBlock.toString(), pending: [], partial, blockRange: Math.max(1, Math.floor(blockRange / 2)) },
        progress: { scannedThroughBlock: nextBlock > fromBlock ? (nextBlock - 1n).toString() : null, toBlock: snapshot.toString() },
      };
    }
    pending = candidatesFromLogs(logs, profile, address, nextBlock, toBlock);
    nextBlock = toBlock + 1n;
  }
  const pools = new Map();
  // Limit candidates as well as matches, so transferred-away or unsupported
  // pools cannot turn an otherwise small page into unbounded RPC work.
  for (const candidate of pending.splice(0, PAGE_SIZE)) {
    const result = await resolvePool(rpc, profile, address, block, candidate);
    if (result.pool) pools.set(poolId(result.pool, profile.manager), result.pool);
    partial ||= result.partial === true;
  }
  const nextState = pending.length || nextBlock <= snapshot
    ? { nextBlock: nextBlock.toString(), pending, partial, blockRange }
    : null;
  return {
    pools: [...pools.values()], nextState, partial,
    progress: { scannedThroughBlock: nextBlock > fromBlock ? (nextBlock - 1n).toString() : null, toBlock: snapshot.toString() },
  };
}
