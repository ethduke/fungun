import { toHex } from 'viem';
import { rpcNumber } from './fee-rpc.mjs';
import { ServiceError } from './errors.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

// Locate a wallet's original nonce using bounded, read-only RPC calls. No explorer,
// wallet history, signing, or new nonce is needed, including for legacy records.
export class LongRecovery {
  constructor(rpc) { this.rpc = rpc; this.searches = new Map(); }
  async find(id, transaction) {
    const from = transaction.from, nonce = rpcNumber(transaction.nonce);
    const [chain, latest, pending] = await this.rpc.batch(4663, [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getTransactionCount', params: [from, 'latest'] },
      { method: 'eth_getTransactionCount', params: [from, 'pending'] },
    ]);
    if (rpcNumber(chain) !== 4663n) throw new ServiceError('wrong_chain');
    if (rpcNumber(latest) <= nonce) {
      this.searches.delete(id);
      return { status: rpcNumber(latest) === nonce && rpcNumber(pending) === nonce ? 'retryable' : 'submitted' };
    }
    let search = this.searches.get(id);
    if (!search) {
      const [head] = await this.rpc.batch(4663, [{ method: 'eth_getBlockByNumber', params: ['latest', false] }]);
      if (!/^0x[a-f0-9]{64}$/i.test(head?.hash)) throw new ServiceError('invalid_response');
      search = { low: -1n, high: rpcNumber(head.number), anchor: head.number, hash: head.hash };
      if (this.searches.size >= 32) this.searches.delete(this.searches.keys().next().value);
      this.searches.set(id, search);
    }
    // Continue across polls instead of exceeding the request deadline/read budget.
    for (let i = 0; i < 6 && search.high - search.low > 1n; i++) {
      const mid = (search.low + search.high) / 2n;
      const [count] = await this.rpc.batch(4663, [{ method: 'eth_getTransactionCount', params: [from, toHex(mid)] }]);
      if (rpcNumber(count) > nonce) search.high = mid;
      else search.low = mid;
    }
    if (search.high - search.low > 1n) return { status: 'locating' };
    const [anchor, block] = await this.rpc.batch(4663, [
      { method: 'eth_getBlockByNumber', params: [search.anchor, false] },
      { method: 'eth_getBlockByNumber', params: [toHex(search.high), true] },
    ]);
    this.searches.delete(id);
    if (!same(anchor?.hash, search.hash) || rpcNumber(block?.number) !== search.high || !Array.isArray(block.transactions))
      return { status: 'locating' };
    const tx = block.transactions.find((tx) => same(tx.from, from) && rpcNumber(tx.nonce) === nonce);
    if (!tx || !same(tx.blockHash, block.hash) || !/^0x[a-f0-9]{64}$/i.test(tx.hash))
      return { status: 'locating' };
    return { status: 'submitted', hash: tx.hash };
  }
}
