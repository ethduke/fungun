import { FeeRpc } from "./fee-rpc.mjs";
import { checkReadDeadline } from "./upstream.mjs";
import { ServiceError } from "./errors.mjs";

const extra = new Set(["eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
export class LongRpc extends FeeRpc {
  async batch(chainId, calls) {
    if (!calls.some((c) => extra.has(c.method))) return super.batch(chainId, calls);
    if (chainId !== 4663 || calls.length < 1 || calls.length > 12) throw new ServiceError("invalid_request", 400);
    const output = [];
    for (const c of calls) {
      checkReadDeadline();
      if (!extra.has(c.method)) { output.push((await super.batch(chainId, [c]))[0]); continue; }
      const body = await this.upstream.json("rpc", this.config.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...c }),
      }, 256 * 1024);
      if (body?.jsonrpc !== "2.0" || body.id !== 1 || body.error || !Object.hasOwn(body, "result"))
        throw new ServiceError("upstream_unavailable");
      output.push(body.result);
    }
    return output;
  }
}
