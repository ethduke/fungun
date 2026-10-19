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
export function analyze(pipeline, start, end, capturedAt) {
  const db = pipeline.db, first = pipeline.startHeight, last = pipeline.checkpoint().last_height;
  const rows = db.prepare(`SELECT b.timestamp,t.amount_raw,t.sender,t.recipient,e.tx_hash FROM canonical_transfers t
    JOIN event_logs e USING(chain_id,block_hash,log_index) JOIN blocks b ON b.chain_id=e.chain_id AND b.hash=e.block_hash
    WHERE t.chain_id=? ORDER BY b.timestamp,e.log_index`).all(pipeline.chainId);
  const buckets = Array.from({length:24}, (_,i) => ({ start: time(start+i*3600), end: time(start+(i+1)*3600), observed:start+i*3600<end, transfers:0, amountRaw:'0' }));
  const amounts = [], wallets = new Set(), txs = new Set(); let total = 0n;
  for (const row of rows) {
    const index = Math.min(23, Math.floor((row.timestamp - start - 1) / 3600));
    if (row.timestamp <= start || row.timestamp > end || index < 0) stop('EVENT_OUTSIDE_WINDOW');
    const bucket = buckets[index], amount = BigInt(row.amount_raw); bucket.transfers++; bucket.amountRaw = String(BigInt(bucket.amountRaw)+amount);
    total += amount; amounts.push(amount); txs.add(row.tx_hash);
    for (const address of [row.sender,row.recipient]) if (BigInt(address) !== 0n) wallets.add(address);
  }
  amounts.sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  const middle = Math.floor(amounts.length/2), median = !amounts.length ? 0n : amounts.length%2 ? amounts[middle] : (amounts[middle-1]+amounts[middle])/2n;
  return { capturedAt, start:time(start), end:time(end), startHeight:first, endHeight:last,
    blocks:last-first+1, transfers:rows.length, transactions:txs.size, activeAddresses:wallets.size,
    amountRaw:String(total), medianRaw:String(median), largestRaw:String(amounts.at(-1) ?? 0n),
    peakHour:buckets.reduce((a,b) => b.transfers > a.transfers ? b : a).start, hours:buckets };
}
