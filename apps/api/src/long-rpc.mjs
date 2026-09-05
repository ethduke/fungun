import { FeeRpc, isFeeRpcMethod, rpcError } from "./fee-rpc.mjs";
import { checkReadDeadline } from "./upstream.mjs";
import { ServiceError } from "./errors.mjs";

const extra = new Set(["eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
const hash = (value) => typeof value === "string" && /^0x[a-f0-9]{64}$/i.test(value);
const block = (value) => typeof value === "string" && /^(?:0x[a-f0-9]{1,64}|latest|safe|finalized)$/i.test(value);
const validExtra = (call) => {
  if (call.method === "eth_getBlockByNumber")
    return call.params.length === 2 && block(call.params[0]) && typeof call.params[1] === "boolean";
  return call.params.length === 1 && hash(call.params[0]);
};
const validCall = (call) => call && typeof call === "object" && !Array.isArray(call)
  && Object.keys(call).length === 2 && Object.hasOwn(call, "method") && Object.hasOwn(call, "params")
  && typeof call.method === "string" && Array.isArray(call.params)
  && (extra.has(call.method) ? validExtra(call) : isFeeRpcMethod(call.method));
export class LongRpc extends FeeRpc {
  async batch(chainId, calls) {
    if (!Array.isArray(calls)) throw new ServiceError("invalid_request", 400);
    if (!calls.some((c) => extra.has(c?.method))) return super.batch(chainId, calls);
    if (chainId !== 4663 || calls.length < 1 || calls.length > 12 || !calls.every(validCall))
      throw new ServiceError("invalid_request", 400);
    const output = [];
    for (const c of calls) {
      checkReadDeadline();
      if (!extra.has(c.method)) { output.push((await super.batch(chainId, [c]))[0]); continue; }
      const body = await this.upstream.json("rpc", this.config.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...c }),
      }, 256 * 1024);
      if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== 1)
        throw new ServiceError("invalid_response");
      if (body.error) throw rpcError(body.error);
      if (!Object.hasOwn(body, "result")) throw new ServiceError("invalid_response");
      output.push(body.result);
    }
    return output;
  }
}
