import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { quantity, hex, hash, stop } from './public-rpc.mjs';

export const STREAM = JSON.parse(readFileSync(new URL('../public-stream.json', import.meta.url), 'utf8'));
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const time = seconds => new Date(seconds * 1000).toISOString();
export function decodeLog(row, stream = STREAM) {
  if (!row || row.removed !== false || row.address?.toLowerCase() !== stream.token.address ||
    row.topics?.length !== 3 || row.topics[0]?.toLowerCase() !== stream.transferTopic ||
    !/^0x[0-9a-f]{64}$/i.test(row.data) || row.topics.slice(1).some(t => !/^0x0{24}[0-9a-f]{40}$/i.test(t))) stop('INVALID_TRANSFER_LOG');
  return { height: quantity(row.blockNumber), blockHash: hash(row.blockHash), index: quantity(row.logIndex),
    txHash: hash(row.transactionHash), txIndex: quantity(row.transactionIndex), token: stream.token.address,
    sender: '0x' + row.topics[1].slice(-40).toLowerCase(), recipient: '0x' + row.topics[2].slice(-40).toLowerCase(),
    amountRaw: BigInt(row.data).toString() };
}
export function uniqueLogs(rows, stream = STREAM) {
  const logs = new Map(); let duplicates = 0;
  for (const row of rows) {
    const item = decodeLog(row, stream), key = `${item.height}:${item.index}`;
    if (logs.has(key)) { if (!isDeepStrictEqual(logs.get(key), item)) stop('CONFLICTING_RPC_LOG'); duplicates++; }
    else logs.set(key, item);
  }
  return { rows: [...logs.values()].sort((a,b) => a.height - b.height || a.index - b.index), duplicates };
}
export async function logsInRange(rpc, first, last, stream = STREAM) {
  const rows = [];
  for (let from = first; from <= last; from += 1000) {
    const result = await rpc.call('eth_getLogs', [{ address: stream.token.address, topics: [stream.transferTopic],
      fromBlock: hex(from), toBlock: hex(Math.min(from + 999, last)) }]);
    if (!Array.isArray(result)) stop('INVALID_LOG_RANGE');
    for (const row of result) { const height = quantity(row.blockNumber); if (height < from || height > Math.min(from + 999,last)) stop('LOG_OUTSIDE_RANGE'); }
    rows.push(...result);
    if (rows.length > 100000) stop('SNAPSHOT_TOO_LARGE');
  }
  return uniqueLogs(rows, stream);
}
export async function findFirstBlock(rpc, endHeight, startExclusive) {
  let low = 1, high = endHeight;
  while (low < high) {
    const mid = Math.floor((low + high) / 2), block = await rpc.call('eth_getBlockByNumber', [hex(mid), false]);
    if (!block || quantity(block.number) !== mid) stop('INVALID_BLOCK_HEADER');
    if (quantity(block.timestamp) > startExclusive) high = mid; else low = mid + 1;
  }
  return low;
}
