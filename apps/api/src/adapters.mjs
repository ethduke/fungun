import { decodeFunctionResult, encodeFunctionData, isAddress, isHex, keccak256 } from "viem";
import { CatalogSnapshots, catalogPairId } from "./catalog-snapshots.mjs";
import { ServiceError, safeError } from "./errors.mjs";
import { ReadCache } from "./upstream.mjs";

const O1_ORIGIN = "https://api.launch.o1.exchange";
const TICKER_ABI = [
  {
    type: "function",
    name: "isTickerAvailable",
    stateMutability: "view",
    inputs: [{ name: "ticker", type: "string" }],
    outputs: [{ type: "bool" }],
  },
];

export function parseQuotes(body, chainId) {
  const data = body?.data;
  const quotes = data?.quotes;
  if (
    ![4663, 8453].includes(chainId) ||
    data?.chain?.chain_id !== chainId ||
    typeof data.as_of_block !== "string" ||
    !/^[1-9]\d{0,19}$/.test(data.as_of_block) ||
    !Array.isArray(data.suites) ||
    data.suites.length > 32 ||
    !Array.isArray(quotes) ||
    quotes.length > 1000
  )
    throw new ServiceError("invalid_catalog");
  if (chainId === 8453 && data.chain.capabilities?.b20_asset_status !== "active")
    throw new ServiceError("catalog_unavailable");
  const suites = new Map();
  for (const suite of data.suites) {
    if (
      !suite ||
      typeof suite.id !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(suite.id) ||
      suites.has(suite.id) ||
      suite.chain_id !== chainId ||
      typeof suite.active_for_creation !== "boolean" ||
      typeof suite.creation_available !== "boolean" ||
      !Array.isArray(suite.supported_routes) ||
      !suite.supported_routes.length ||
      suite.supported_routes.length > 2 ||
      suite.supported_routes.some((route) => !["standard", "rwa"].includes(route))
    )
      throw new ServiceError("invalid_catalog");
    suites.set(suite.id, {
      routes: suite.supported_routes,
      ready:
        suite.active_for_creation &&
        suite.creation_available &&
        suite.launch_creation_enabled === true,
    });
  }
  if (![...suites.values()].some((suite) => suite.ready && suite.routes.includes("rwa")))
    throw new ServiceError("catalog_unavailable");
  const unique = new Map();
  for (const quote of quotes) {
    if (
      !quote ||
      typeof quote !== "object" ||
      Array.isArray(quote) ||
      typeof quote.address !== "string" ||
      typeof quote.symbol !== "string" ||
      !Number.isInteger(quote.decimals) ||
      typeof quote.route !== "string" ||
      !["standard", "rwa"].includes(quote.route) ||
      typeof quote.suite_id !== "string" ||
      !suites.has(quote.suite_id) ||
      typeof quote.registered !== "boolean" ||
      typeof quote.selectable !== "boolean"
    )
      throw new ServiceError("invalid_catalog");
    if (quote.route !== "rwa" || !quote.registered || !quote.selectable) continue;
    const suite = suites.get(quote.suite_id);
    if (!suite.ready || !suite.routes.includes(quote.route))
      throw new ServiceError("invalid_catalog");
    if (
      !isAddress(quote.address) ||
      /^0x0+$/i.test(quote.address) ||
      typeof quote.symbol !== "string" ||
      !/^[A-Za-z0-9._-]{1,24}$/.test(quote.symbol) ||
      !Number.isInteger(quote.decimals) ||
      quote.decimals < 0 ||
      quote.decimals > 36
    )
      throw new ServiceError("invalid_catalog");
    const address = quote.address.toLowerCase();
    const previous = unique.get(address);
    if (previous && (previous.symbol !== quote.symbol || previous.decimals !== quote.decimals))
      throw new ServiceError("invalid_catalog");
    const id = catalogPairId(chainId, address);
    unique.set(address, { id, address, symbol: quote.symbol, decimals: quote.decimals });
  }
  const values = Array.from(unique.values());
  if (new Set(values.map((quote) => quote.symbol.toUpperCase())).size !== values.length)
    throw new ServiceError("ambiguous_catalog");
  return values;
}

export class Adapters {
  constructor(config, upstream, now = Date.now, budget = null) {
    this.config = config;
    this.upstream = upstream;
    this.now = now;
    this.cache = new ReadCache(now);
    this.catalogs = budget ? new CatalogSnapshots(budget.db, now) : null;
  }

  async catalog(chainId) {
    const unavailable = { status: "unavailable", pairs: [] };
    if (!this.config.readsEnabled || !this.config.o1Key || !this.catalogs) {
      this.catalogs?.prune(chainId);
      return {
        chainId,
        expiresAt: this.now() + 300_000,
        pads: chainId === 4663 ? { long: unavailable, o1: unavailable } : { o1: unavailable },
      };
    }
    return this.catalogs.catalog(chainId, this.config.longQuotes);
  }

  async refreshCatalog(chainId) {
    if (!this.catalogs) return false;
    if (!this.config.readsEnabled || !this.config.o1Key) {
      this.catalogs.prune(chainId);
      return false;
    }
    const lease = this.catalogs.begin(chainId);
    if (!lease) return false;
    try {
      const url = new URL("/v1/config", O1_ORIGIN);
      url.search = new URLSearchParams({
        chain_id: String(chainId),
        market: "rwa",
        include: "chains,suites,quotes",
        active_only: "true",
      }).toString();
      const body = await this.upstream.json(
        "o1",
        url,
        { headers: { "x-api-key": this.config.o1Key } },
        512 * 1024,
        20,
      );
      return this.catalogs.succeed(chainId, parseQuotes(body, chainId), lease);
    } catch (error) {
      const safe = safeError(error);
      this.catalogs.fail(chainId, lease, safe.retryAfter);
      throw safe;
    }
  }

  async rpc(method, params) {
    const result = await this.upstream.json(
      "rpc",
      this.config.rpcUrl,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      },
      128 * 1024,
    );
    if (result?.jsonrpc !== "2.0" || result.id !== 1 || result.error || !isHex(result.result))
      throw new ServiceError("upstream_unavailable");
    return result.result;
  }

  async verifyRegistry() {
    await this.cache.get("chain", 300_000, async () => {
      if (BigInt(await this.rpc("eth_chainId", [])) !== BigInt(4663))
        throw new ServiceError("registry_unverified");
      return true;
    });
    const block = await this.cache.get("block", 5000, () => this.rpc("eth_blockNumber", []));
    await this.cache.get(`registry:${block}`, 30_000, async () => {
      const code = await this.rpc("eth_getCode", [this.config.registry, block]);
      if (code === "0x" || keccak256(code).toLowerCase() !== this.config.codeHash.toLowerCase())
        throw new ServiceError("registry_unverified");
      return true;
    });
    return block;
  }

  async ticker(chainId, ticker, pads) {
    const results = {};
    if (pads.includes("o1")) results.o1 = { status: "unverified", reason: "unsupported" };
    if (pads.includes("long")) {
      const { readsEnabled, rpcUrl, registry, codeHash } = this.config;
      if (!readsEnabled || !rpcUrl || !registry || !codeHash)
        results.long = { status: "unverified", reason: "not_configured" };
      else {
        try {
          results.long = await this.cache.get(`ticker:${chainId}:${ticker}`, 15_000, async () => {
            const block = await this.verifyRegistry();
            const data = encodeFunctionData({
              abi: TICKER_ABI,
              functionName: "isTickerAvailable",
              args: [ticker],
            });
            const encoded = await this.rpc("eth_call", [
              { to: registry, data, gas: `0x${(200000).toString(16)}` },
              block,
            ]);
            if (
              !/^0x[0-9a-fA-F]{64}$/.test(encoded) ||
              ![BigInt(0), BigInt(1)].includes(BigInt(encoded))
            )
              throw new ServiceError("upstream_unavailable");
            const available = decodeFunctionResult({
              abi: TICKER_ABI,
              functionName: "isTickerAvailable",
              data: encoded,
            });
            return {
              status: available ? "unreserved" : "reserved",
              checkedAt: this.now(),
              expiresAt: this.now() + 15_000,
            };
          });
        } catch (error) {
          const safe = safeError(error);
          if (safe.status === 429) throw safe;
          results.long = { status: "unverified", reason: "unavailable" };
        }
      }
    }
    return { chainId, ticker, results };
  }
}
