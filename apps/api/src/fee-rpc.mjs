import { decodeFunctionResult, encodeFunctionData, keccak256, toHex, toBytes } from "viem";
import { ServiceError } from "./errors.mjs";
import { ReadCache } from "./upstream.mjs";

const methods = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getTransactionCount",
]);
const implementationSlot = toHex(BigInt(keccak256(toBytes("eip1967.proxy.implementation"))) - 1n, {
  size: 32,
});
function rpcError(error) {
  const message =
    typeof error.message === "string" ? error.message.slice(0, 512).toLowerCase() : "";
  const code = /insufficient funds/.test(message)
    ? "insufficient_funds"
    : /intrinsic gas too low/.test(message)
      ? "gas_limit_low"
      : /exceeds.*gas limit|gas required exceeds allowance/.test(message)
        ? "gas_limit"
        : /max fee per gas less than|fee cap less than/.test(message)
          ? "fee_changed"
          : error.code === 3 || /execution reverted/.test(message)
            ? "reverted"
            : "upstream_unavailable";
  return new ServiceError(code);
}
export function rpcNumber(value) {
  if (typeof value !== "string" || !/^0x[\da-f]{1,64}$/i.test(value))
    throw new ServiceError("invalid_response");
  return BigInt(value);
}

export class FeeRpc {
  constructor(config, upstream, now = Date.now) {
    this.config = config;
    this.upstream = upstream;
    this.pins = new ReadCache(now, 16);
  }
  async batch(chainId, calls) {
    if (![4663, 8453].includes(chainId)) throw new ServiceError("invalid_request", 400);
    const url = chainId === 4663 ? this.config.rpcUrl : this.config.baseRpcUrl;
    if (!url) throw new ServiceError("not_configured");
    if (!calls.length || calls.length > 12 || calls.some((call) => !methods.has(call.method)))
      throw new ServiceError("invalid_request", 400);
    if (this.config.rpcBatchRequests === false) {
      const values = [];
      // Some RPC providers accept only individual request objects. This mode is
      // explicit: charge each read, send in order, and stop without a retry.
      for (const [id, call] of calls.entries()) {
        const result = await this.upstream.json(
          "rpc",
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, ...call }),
          },
          256 * 1024,
          1,
        );
        if (!result || Array.isArray(result) || result.id !== id || result.jsonrpc !== "2.0")
          throw new ServiceError("invalid_response");
        if (result.error) throw rpcError(result.error);
        if (!Object.hasOwn(result, "result")) throw new ServiceError("invalid_response");
        values.push(result.result);
      }
      return values;
    }
    const results = await this.upstream.json(
      "rpc",
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call }))),
      },
      256 * 1024,
      calls.length,
    );
    if (
      !Array.isArray(results) ||
      results.length !== calls.length ||
      new Set(results.map((item) => item?.id)).size !== calls.length
    )
      throw new ServiceError("invalid_response");
    return calls.map((_, id) => {
      const result = results.find((item) => item?.id === id);
      if (!result || result.jsonrpc !== "2.0") throw new ServiceError("invalid_response");
      if (result.error) throw rpcError(result.error);
      if (!Object.hasOwn(result, "result")) throw new ServiceError("invalid_response");
      return result.result;
    });
  }
  async verify(chainId, contracts, fresh = false, block = "latest") {
    const load = async () => {
      const [chain, ...codes] = await this.batch(chainId, [
        { method: "eth_chainId", params: [] },
        ...contracts.map(({ address }) => ({ method: "eth_getCode", params: [address, block] })),
      ]);
      if (rpcNumber(chain) !== BigInt(chainId)) throw new ServiceError("wrong_chain");
      if (
        contracts.some(
          (contract, index) =>
            !/^0x(?:[\da-f]{2})+$/i.test(codes[index] ?? "") ||
            keccak256(codes[index]).toLowerCase() !== contract.codeHash.toLowerCase(),
        )
      )
        throw new ServiceError("contract_unverified");
      for (const contract of contracts.filter((entry) => entry.implementation)) {
        const [slot, code] = await this.batch(chainId, [
          { method: "eth_getStorageAt", params: [contract.address, implementationSlot, block] },
          { method: "eth_getCode", params: [contract.implementation, block] },
        ]);
        if (
          typeof slot !== "string" ||
          !/^0x0{24}[\da-f]{40}$/i.test(slot) ||
          slot.slice(-40).toLowerCase() !== contract.implementation.slice(2).toLowerCase() ||
          !/^0x(?:[\da-f]{2})+$/i.test(code ?? "") ||
          keccak256(code).toLowerCase() !== contract.implementationCodeHash.toLowerCase()
        )
          throw new ServiceError("contract_unverified");
      }
      return true;
    };
    return fresh
      ? load()
      : this.pins.get(JSON.stringify([chainId, contracts, block]), 300_000, load);
  }
  async verifiedContracts(chainId, contracts, block) {
    if (contracts.some((contract) => contract.implementation))
      throw new ServiceError("invalid_request", 400);
    // Discovery can retain one changed immutable escrow as indexed-only while
    // verifying the other configured escrows in a single bounded RPC batch.
    return this.pins.get(
      JSON.stringify(["available", chainId, contracts, block]),
      300_000,
      async () => {
        const [chain, ...codes] = await this.batch(chainId, [
          { method: "eth_chainId", params: [] },
          ...contracts.map(({ address }) => ({ method: "eth_getCode", params: [address, block] })),
        ]);
        if (rpcNumber(chain) !== BigInt(chainId)) throw new ServiceError("wrong_chain");
        return contracts.filter(
          (contract, index) =>
            /^0x(?:[\da-f]{2})+$/i.test(codes[index] ?? "") &&
            keccak256(codes[index]).toLowerCase() === contract.codeHash.toLowerCase(),
        );
      },
    );
  }
  async block(chainId) {
    const [block] = await this.batch(chainId, [{ method: "eth_blockNumber", params: [] }]);
    return toHex(rpcNumber(block));
  }
  async calls(chainId, entries, block = "latest") {
    const results = await this.batch(
      chainId,
      entries.map((entry) => ({
        method: "eth_call",
        params: [
          {
            to: entry.address,
            data: encodeFunctionData(entry),
            ...(entry.from ? { from: entry.from } : {}),
          },
          block,
        ],
      })),
    );
    return entries.map((entry, index) => {
      try {
        return decodeFunctionResult({ ...entry, data: results[index] });
      } catch {
        throw new ServiceError("invalid_response");
      }
    });
  }
}
