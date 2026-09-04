import { decodeEventLog, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from "viem";
import { ServiceError } from "./errors.mjs";
import { FeeRpc, rpcNumber } from "./fee-rpc.mjs";
import { ReadCache } from "./upstream.mjs";

const INTERVAL = 120_000;
const DAY = 86_400_000;
const NEGATIVE_TTL = 1_800_000;
const address = /^0x[\da-f]{40}$/i;
const poolId = /^0x[\da-f]{64}$/i;
const registryUrl = "https://docs.o1.exchange/launchpad/reference/production-deployments.json";
const feedUrl = "https://rh-monitor.fly.dev/api";
const abi = parseAbi([
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
  "function extsload(bytes32[] slots) view returns (bytes32[] values)",
]);
const initializeTopic = encodeEventTopics({ abi, eventName: "Initialize" })[0];
const keyTypes = ["address", "address", "uint24", "int24", "address"].map((type) => ({ type }));
const tupleKey = ({ pool, token, version }) => `${version}:${pool}:${token}`;

export function validatePriceInput(input) {
  if (
    !input ||
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.pools) ||
    !input.pools.length ||
    input.pools.length > 10 ||
    input.pools.some(
      (item) =>
        !item ||
        Object.keys(item).length !== 3 ||
        Object.keys(item).some((key) => !["pool", "token", "version"].includes(key)) ||
        item.version !== "v4" ||
        !poolId.test(item.pool) ||
        !address.test(item.token) ||
        /^0x0{40}$/i.test(item.token),
    )
  )
    throw new ServiceError("invalid_request", 400);
  const pools = input.pools.map((item) => ({
    ...item,
    pool: item.pool.toLowerCase(),
    token: item.token.toLowerCase(),
  }));
  if (new Set(pools.map(tupleKey)).size !== pools.length)
    throw new ServiceError("invalid_request", 400);
  return { pools };
}

export function parsePriceRegistry(body) {
  const chain = body?.chains?.find((item) => item.chainId === 4663);
  const manager = chain?.uniswapV4?.poolManager;
  if (
    body?.schemaVersion !== 4 ||
    body.project !== "o1 Launchpad" ||
    body.environment !== "production" ||
    !address.test(manager) ||
    /^0x0{40}$/i.test(manager) ||
    !Array.isArray(chain.quotes)
  )
    throw new ServiceError("price_registry_unavailable");
  const stables = chain.quotes.filter((quote) =>
    ["USDG", "USDC", "USDT", "DAI", "USDS", "PYUSD"].includes(quote?.symbol),
  );
  if (!stables.length || stables.some((quote) => !address.test(quote.address)))
    throw new ServiceError("price_registry_unavailable");
  return {
    manager: manager.toLowerCase(),
    stables: new Set(stables.map((quote) => quote.address.toLowerCase())),
  };
}

export function verifiedPoolKey(log, manager, id) {
  try {
    if (
      log?.removed !== false ||
      log.address?.toLowerCase() !== manager ||
      log.topics?.[0]?.toLowerCase() !== initializeTopic.toLowerCase()
    )
      return null;
    const { args } = decodeEventLog({
      abi,
      eventName: "Initialize",
      data: log.data,
      topics: log.topics,
      strict: true,
    });
    const { currency0, currency1, fee, tickSpacing, hooks } = args;
    if (
      args.id.toLowerCase() !== id ||
      BigInt(currency0) >= BigInt(currency1) ||
      tickSpacing <= 0 ||
      tickSpacing > 32767 ||
      keccak256(
        encodeAbiParameters(keyTypes, [currency0, currency1, fee, tickSpacing, hooks]),
      ).toLowerCase() !== id
    )
      return null;
    return { currency0: currency0.toLowerCase(), currency1: currency1.toLowerCase() };
  } catch {
    return null;
  }
}

export function poolStateSlot(id) {
  // Uniswap v4 StateLibrary: PoolManager._pools mapping is at storage slot 6.
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n]));
}

export function poolPrice(word, key, token) {
  if (!poolId.test(word) || ![key.currency0, key.currency1].includes(token)) return null;
  const packed = BigInt(word);
  const sqrt = packed & ((1n << 160n) - 1n);
  const tick = Number(BigInt.asIntN(24, packed >> 160n));
  if (
    sqrt < 4295128739n ||
    sqrt >= 1461446703485210103287273052203988822378723970342n ||
    Math.abs(tick) > 887272
  )
    return null;
  const ratio = (Number(sqrt) / 2 ** 96) ** 2;
  const token0 = token === key.currency0;
  const value = token0 ? ratio : 1 / ratio;
  // Atomic-unit scale is constant for the pinned pool and cancels in % changes.
  return Number.isFinite(value) && value > 0
    ? { value, quote: token0 ? key.currency1 : key.currency0 }
    : null;
}

export class TrackedPrices {
  constructor(config, upstream, now = Date.now) {
    Object.assign(this, { config, upstream, now });
    this.rpc = new FeeRpc(config, upstream, now);
    this.sources = new ReadCache(now, 4);
    this.allowed = new Map();
    this.metadata = new Map();
    this.points = new Map();
    this.pending = null;
    this.demands = new Set();
    this.manager = null;
  }

  put(map, key, value) {
    map.delete(key);
    while (map.size >= 256) map.delete(map.keys().next().value);
    map.set(key, value);
  }

  registry(guard) {
    return this.sources.get("registry", DAY, async () => {
      guard();
      return parsePriceRegistry(
        await this.upstream.json(
          "market",
          registryUrl,
          { headers: { Accept: "application/json" } },
          65_536,
        ),
      );
    });
  }

  async admit(requests, registry, guard) {
    const now = this.now();
    for (const [key, until] of this.allowed) if (until <= now) this.allowed.delete(key);
    if (requests.every((item) => this.allowed.has(tupleKey(item)))) return;
    const rows = await this.sources.get("feed", 4000, async () => {
      guard();
      const body = await this.upstream.json(
        "market",
        feedUrl,
        { headers: { Accept: "application/json" } },
        2 * 1024 * 1024,
      );
      if (!Array.isArray(body?.pools)) throw new ServiceError("feed_unavailable");
      return body.pools;
    });
    for (const row of rows) {
      const token = String(row?.meme || row?.token || "").toLowerCase();
      if (
        Number(row?.chain_id ?? 4663) !== 4663 ||
        row?.version !== "v4" ||
        !["eth", "shares"].includes(row.quote_kind) ||
        !poolId.test(row.pool) ||
        !address.test(token) ||
        registry.stables.has(token) ||
        !Number.isFinite(Number(row.total_in)) ||
        Number(row.total_in) <= 10
      )
        continue;
      this.put(
        this.allowed,
        tupleKey({ pool: row.pool.toLowerCase(), token, version: row.version }),
        now + DAY,
      );
    }
  }

  async keys(manager, ids, guard) {
    const now = this.now();
    const missing = [...new Set(ids)].filter(
      (id) => (this.metadata.get(`${manager}:${id}`)?.until ?? 0) <= now,
    );
    if (!missing.length) return;
    guard();
    // Reserve failures too. No pagination, range splitting or immediate retry.
    for (const id of missing)
      this.put(this.metadata, `${manager}:${id}`, { key: null, until: now + NEGATIVE_TTL });
    const [logs] = await this.rpc.batch(4663, [
      {
        method: "eth_getLogs",
        params: [
          {
            address: manager,
            fromBlock: "0x0",
            toBlock: "latest",
            topics: [initializeTopic, missing],
          },
        ],
      },
    ]);
    if (!Array.isArray(logs) || logs.length > missing.length)
      throw new ServiceError("price_metadata_unavailable");
    for (const id of missing) {
      const matching = logs.filter((log) => log?.topics?.[1]?.toLowerCase() === id);
      const key = matching.length === 1 ? verifiedPoolKey(matching[0], manager, id) : null;
      if (key) this.put(this.metadata, `${manager}:${id}`, { key, until: this.now() + DAY });
    }
  }

  async refresh(requests, deadline) {
    const guard = () => {
      // Each started upstream stage has a six-second timeout. Leave room for it
      // to finish within the request deadline; never start work without viewers.
      if (performance.now() > deadline - 6000 || ![...this.demands].some((active) => active()))
        throw new ServiceError("busy", 429, 120);
    };
    const registry = await this.registry(guard);
    for (const item of requests)
      if (registry.stables.has(item.token)) this.allowed.delete(tupleKey(item));
    await this.admit(requests, registry, guard);
    const manager = registry.manager;
    this.manager = manager;
    const due = requests.filter(
      (item) =>
        this.allowed.has(tupleKey(item)) &&
        (this.points.get(`${manager}:${tupleKey(item)}`)?.until ?? 0) <= this.now(),
    );
    if (!due.length) return manager;
    for (const item of due) {
      const key = `${manager}:${tupleKey(item)}`;
      this.put(this.points, key, {
        point: this.points.get(key)?.point ?? null,
        until: this.now() + INTERVAL,
      });
    }
    await this.sources.get(`verified:${manager}`, DAY, async () => {
      guard();
      const [chain, code] = await this.rpc.batch(4663, [
        { method: "eth_chainId", params: [] },
        { method: "eth_getCode", params: [manager, "latest"] },
      ]);
      if (
        rpcNumber(chain) !== 4663n ||
        typeof code !== "string" ||
        !/^0x(?:[\da-f]{2}){100,}$/i.test(code)
      )
        throw new ServiceError("contract_unverified");
      return true;
    });
    await this.keys(
      manager,
      due.map((item) => item.pool),
      guard,
    );
    const priced = due.filter((item) => {
      const key = this.metadata.get(`${manager}:${item.pool}`)?.key;
      return key && [key.currency0, key.currency1].includes(item.token);
    });
    if (!priced.length) return manager;
    const ids = [...new Set(priced.map((item) => item.pool))];
    guard();
    const [words] = await this.rpc.calls(4663, [
      { address: manager, abi, functionName: "extsload", args: [ids.map(poolStateSlot)] },
    ]);
    if (!Array.isArray(words) || words.length !== ids.length)
      throw new ServiceError("invalid_response");
    const observedAt = this.now();
    for (const item of priced) {
      const key = this.metadata.get(`${manager}:${item.pool}`).key;
      const price = poolPrice(words[ids.indexOf(item.pool)], key, item.token);
      if (!price) continue;
      const point = { pool: item.pool, token: item.token, ...price, observedAt, source: manager };
      this.put(this.points, `${manager}:${tupleKey(item)}`, {
        point,
        until: observedAt + INTERVAL,
      });
    }
    return manager;
  }

  cached(pools) {
    if (this.pending) return null;
    const now = this.now();
    const entries = pools.map((item) => this.points.get(`${this.manager}:${tupleKey(item)}`));
    if (
      pools.some(
        (item, index) =>
          (this.allowed.get(tupleKey(item)) ?? 0) <= now ||
          !entries[index] ||
          entries[index].until <= now,
      )
    )
      return null;
    return { prices: entries.map((entry) => entry.point).filter(Boolean) };
  }

  async list(input, { shouldContinue = () => true } = {}) {
    const deadline = performance.now() + 20_000;
    const { pools } = validatePriceInput(input);
    if (!this.config.readsEnabled || !this.config.rpcUrl) return { prices: [] };
    const cached = this.cached(pools);
    if (cached) return cached;
    if (!shouldContinue() || this.demands.size >= 16) throw new ServiceError("busy", 429, 120);
    this.demands.add(shouldContinue);
    try {
      if (this.pending) {
        let timeout;
        try {
          await Promise.race([
            this.pending.catch(() => {}),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new ServiceError("busy", 429, 120)), 20_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        const shared = this.cached(pools);
        if (shared) return shared;
      }
      // Wait for at most one refresh; different batches do not form a work queue.
      if (this.pending || !shouldContinue()) throw new ServiceError("busy", 429, 120);
      this.pending = this.refresh(pools, deadline);
      let manager;
      try {
        manager = await this.pending;
      } finally {
        this.pending = null;
      }
      return {
        prices: pools
          .filter((item) => this.allowed.has(tupleKey(item)))
          .map((item) => this.points.get(`${manager}:${tupleKey(item)}`)?.point)
          .filter(Boolean),
      };
    } finally {
      this.demands.delete(shouldContinue);
    }
  }
}
