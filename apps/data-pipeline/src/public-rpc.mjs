import { setTimeout as pause } from 'node:timers/promises';

const METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getTransactionReceipt', 'eth_getBlockReceipts', 'eth_call']);
export const stop = code => { throw new Error(code); };
export const quantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) stop('INVALID_QUANTITY');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) stop('INVALID_QUANTITY');
  return number;
};
export const hex = number => '0x' + number.toString(16);
export function hash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) stop('INVALID_HASH');
  return value.toLowerCase();
}
export class PublicRpc {
  constructor(endpoint, { fetcher = fetch, wait = pause } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.href !== 'https://rpc.mainnet.chain.robinhood.com/') stop('INVALID_PUBLIC_ENDPOINT');
    this.endpoint = url.href; this.fetcher = fetcher; this.wait = wait; this.calls = 0;
  }
  async batch(requests) {
    if (!requests.length || requests.length > 25 || requests.some(r => !METHODS.has(r.method))) stop('INVALID_READ_REQUEST');
    const body = requests.map((r, id) => ({ jsonrpc: '2.0', id, method: r.method, params: r.params }));
    let retryDelay=0;
    for (let attempt = 0; attempt < 6; attempt++) {
      await this.wait(attempt ? retryDelay : 500);
      try {
        this.calls += requests.length;
        const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body.length===1 ? body[0] : body), redirect: 'error', signal: AbortSignal.timeout(25000) });
        if (!response.ok) {
          const status=response.status,after=response.headers.get('retry-after');await response.body?.cancel();
          if(status===429||status>=500){
            const seconds=after&&/^\d+$/.test(after)?Number(after):after?Math.max(0,(Date.parse(after)-Date.now())/1000):NaN;
            retryDelay=Math.min(120000,Math.max(status===429?30000:1000,Number.isFinite(seconds)?seconds*1000:1000*2**attempt));continue;
          }
          stop('RPC_HTTP_REJECTED');
        }
        // Bound response size before parsing or retaining provider diagnostics.
        const reader = response.body.getReader(); let size = 0; const parts = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
          if (size > 16 * 1024 * 1024) { await reader.cancel(); stop('RPC_RESPONSE_TOO_LARGE'); } parts.push(value); }
        const bytes = Buffer.concat(parts), parsed = JSON.parse(bytes.toString('utf8'));
        const rows = requests.length===1 && !Array.isArray(parsed) ? [parsed] : parsed;
        if (!Array.isArray(rows) || rows.length !== requests.length) stop('RPC_INVALID_RESPONSE');
        const byId = new Map();
        for (const row of rows) {
          if (row.error) { const error=new Error('RPC_QUERY_REJECTED'); error.rpcCode=Number.isInteger(row.error.code)?row.error.code:null; throw error; }
          if (row.jsonrpc !== '2.0' || !Number.isInteger(row.id) || row.id < 0 || row.id >= requests.length ||
            byId.has(row.id) || !Object.hasOwn(row, 'result') || row.error) stop('RPC_INVALID_RESPONSE');
          byId.set(row.id, row.result);
        }
        return requests.map((_, i) => byId.get(i));
      } catch (error) {
        retryDelay=Math.min(30000,1000*2**attempt);
        if (['INVALID_READ_REQUEST','RPC_HTTP_REJECTED','RPC_RESPONSE_TOO_LARGE','RPC_INVALID_RESPONSE','RPC_QUERY_REJECTED'].includes(error.message)) throw error;
      }
    }
    stop('PUBLIC_RPC_UNAVAILABLE');
  }
  async call(method, params = []) { return (await this.batch([{ method, params }]))[0]; }
}
