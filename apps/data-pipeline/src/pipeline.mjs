import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codes = new Set(['INVALID_BLOCK', 'CONFLICTING_EVENT', 'SOURCE_UNAVAILABLE', 'SOURCE_CHANGED',
  'SOURCE_HEAD_BEHIND', 'REORG_TOO_DEEP', 'CONFIG_MISMATCH', 'BLOCK_CONFLICT', 'STORAGE_ERROR']);
export const safeCode = error => codes.has(error?.code) ? error.code : 'STORAGE_ERROR';

// Provider contract: getHead() -> height; getBlock(height) -> a complete block
// with all transactions and decoded Transfer events for the configured stream.
// A production adapter must verify chain ID, filter identity and completeness.
export function normalizeBlock(input, chainId, height) {
  if (!input || input.chainId !== chainId || input.height !== height || !HASH.test(input.hash) ||
    !HASH.test(input.parentHash) || !Number.isSafeInteger(input.timestamp) || input.timestamp < 0 ||
    !Array.isArray(input.transactions) || !Array.isArray(input.events)) fail('INVALID_BLOCK');
  const transactions = input.transactions.map(tx => ({ hash: tx.hash, index: tx.index }));
  if (transactions.some(tx => !HASH.test(tx.hash) || !Number.isSafeInteger(tx.index) || tx.index < 0) ||
    new Set(transactions.map(tx => tx.hash)).size !== transactions.length ||
    new Set(transactions.map(tx => tx.index)).size !== transactions.length) fail('INVALID_BLOCK');
  transactions.sort((a, b) => a.index - b.index);
  const events = new Map(); let duplicates = 0;
  for (const row of input.events) {
    const event = { index: row.index, txHash: row.txHash, token: row.token,
      sender: row.sender, recipient: row.recipient, amountRaw: row.amountRaw };
    if (!Number.isSafeInteger(event.index) || event.index < 0 || !transactions.some(tx => tx.hash === event.txHash) ||
      ![event.token, event.sender, event.recipient].every(value => ADDRESS.test(value)) ||
      typeof event.amountRaw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(event.amountRaw) ||
      BigInt(event.amountRaw) >= 2n ** 256n) fail('INVALID_BLOCK');
    const previous = events.get(event.index);
    if (previous && !isDeepStrictEqual(previous, event)) fail('CONFLICTING_EVENT');
    if (previous) duplicates++;
    else events.set(event.index, event);
  }
  return { chainId, height, hash: input.hash, parentHash: input.parentHash, timestamp: input.timestamp,
    transactions, events: [...events.values()].sort((a, b) => a.index - b.index), duplicates };
}

export class Pipeline {
  constructor(path, { chainId, name, startHeight, tokens, now = () => new Date().toISOString() }) {
    if (!Number.isSafeInteger(chainId) || chainId < 1 || !Number.isSafeInteger(startHeight) || startHeight < 1 ||
      !Array.isArray(tokens) || !tokens.length || tokens.some(token => !ADDRESS.test(token.address) ||
      !/^[A-Z0-9]{1,12}$/.test(token.symbol) || !Number.isSafeInteger(token.decimals) || token.decimals < 0 || token.decimals > 36)) fail('CONFIG_MISMATCH');
    this.chainId = chainId; this.startHeight = startHeight; this.now = now;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
      this.db.prepare('INSERT OR IGNORE INTO chains VALUES (?,?)').run(chainId, name);
      const checkpoint = this.checkpoint();
      if (checkpoint && checkpoint.start_height !== startHeight) fail('CONFIG_MISMATCH');
      const existing = this.db.prepare('SELECT address,symbol,decimals FROM tokens WHERE chain_id=? ORDER BY address').all(chainId);
      const requested = tokens.map(token => ({ ...token })).sort((a, b) => a.address.localeCompare(b.address));
      if (existing.length && !isDeepStrictEqual(existing.map(row => ({ ...row })), requested)) fail('CONFIG_MISMATCH');
      for (const token of tokens) {
        const prior = this.db.prepare('SELECT symbol,decimals FROM tokens WHERE chain_id=? AND address=?').get(chainId, token.address);
        if (prior && (prior.symbol !== token.symbol || prior.decimals !== token.decimals)) fail('CONFIG_MISMATCH');
        this.db.prepare('INSERT OR IGNORE INTO tokens VALUES (?,?,?,?)').run(chainId, token.address, token.symbol, token.decimals);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  checkpoint() { return this.db.prepare('SELECT * FROM checkpoints WHERE chain_id=?').get(this.chainId); }
  atomic(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  canonical() {
    return this.db.prepare(`SELECT b.* FROM canonical_blocks c JOIN blocks b
      ON b.chain_id=c.chain_id AND b.hash=c.block_hash WHERE c.chain_id=? ORDER BY c.height`).all(this.chainId);
  }
  async read(source, height) {
    let block;
    try { block = await source.getBlock(height); } catch { fail('SOURCE_UNAVAILABLE'); }
    if (!block) fail('SOURCE_UNAVAILABLE');
    return normalizeBlock(block, this.chainId, height);
  }
  readStored(blockHash) {
    const header = this.db.prepare('SELECT * FROM blocks WHERE chain_id=? AND hash=?').get(this.chainId, blockHash);
    if (!header) return null;
    return { chainId: this.chainId, height: header.height, hash: header.hash, parentHash: header.parent_hash,
      timestamp: header.timestamp, transactions: this.db.prepare(`SELECT tx_hash AS hash,tx_index AS 'index'
      FROM transactions WHERE chain_id=? AND block_hash=? ORDER BY tx_index`).all(this.chainId, blockHash).map(row => ({ ...row })),
      events: this.db.prepare(`SELECT e.log_index AS 'index',e.tx_hash AS txHash,e.token_address AS token,
      t.sender,t.recipient,t.amount_raw AS amountRaw FROM event_logs e JOIN transfers t USING(chain_id,block_hash,log_index)
      WHERE e.chain_id=? AND e.block_hash=? ORDER BY e.log_index`).all(this.chainId, blockHash).map(row => ({ ...row })), duplicates: 0 };
  }
  write(block) {
    const previous = this.readStored(block.hash);
    if (previous) {
      if (!isDeepStrictEqual(previous, { ...block, duplicates: 0 })) fail('BLOCK_CONFLICT');
    } else {
      this.db.prepare('INSERT INTO blocks VALUES (?,?,?,?,?,?)').run(this.chainId, block.hash, block.height,
        block.parentHash, block.timestamp, block.events.length);
      for (const tx of block.transactions) this.db.prepare('INSERT INTO transactions VALUES (?,?,?,?)')
        .run(this.chainId, block.hash, tx.hash, tx.index);
      for (const event of block.events) {
        this.db.prepare('INSERT INTO event_logs VALUES (?,?,?,?,?)').run(this.chainId, block.hash, event.index, event.txHash, event.token);
        this.db.prepare('INSERT INTO transfers VALUES (?,?,?,?,?,?)').run(this.chainId, block.hash, event.index,
          event.sender, event.recipient, event.amountRaw);
      }
    }
    this.db.prepare('INSERT INTO canonical_blocks VALUES (?,?,?)').run(this.chainId, block.height, block.hash);
  }
  rewind(runId, ancestor, reason) {
    const oldTip = this.checkpoint().last_height;
    this.atomic(() => {
      const removed = this.db.prepare('DELETE FROM canonical_blocks WHERE chain_id=? AND height>?').run(this.chainId, ancestor).changes;
      this.db.prepare('UPDATE checkpoints SET last_height=? WHERE chain_id=?').run(ancestor, this.chainId);
      this.db.prepare('INSERT INTO recoveries(run_id,chain_id,reason,ancestor_height,old_tip,reverted_blocks) VALUES (?,?,?,?,?,?)')
        .run(runId, this.chainId, reason, ancestor, oldTip, removed);
    });
  }
  async sync(source, { batchSize = 3, maxReorgDepth = 32 } = {}) {
    if (![batchSize, maxReorgDepth].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000)) fail('CONFIG_MISMATCH');
    const runId = this.db.prepare('INSERT INTO ingestion_runs(chain_id,started_at,status) VALUES (?,?,?)')
      .run(this.chainId, this.now(), 'running').lastInsertRowid;
    let written = 0, duplicates = 0;
    try {
      let head;
      try { head = await source.getHead(); } catch { fail('SOURCE_UNAVAILABLE'); }
      if (!Number.isSafeInteger(head) || head < this.startHeight - 1) fail('INVALID_BLOCK');
      const target = await this.read(source, head);
      this.db.prepare('UPDATE ingestion_runs SET target_height=? WHERE id=?').run(head, runId);
      if (!this.checkpoint()) {
        const anchor = await this.read(source, this.startHeight - 1);
        this.db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?)').run(this.chainId, this.startHeight, this.startHeight - 1, anchor.hash);
      }
      let checkpoint = this.checkpoint();
      if (head < checkpoint.last_height) fail('SOURCE_HEAD_BEHIND');
      const rows = this.canonical();
      let expected = this.startHeight;
      for (const row of rows) {
        if (row.height !== expected) break;
        expected++;
      }
      if (expected <= checkpoint.last_height) this.rewind(runId, expected - 1, 'gap_repair');
      checkpoint = this.checkpoint();
      let ancestor = checkpoint.last_height;
      while (ancestor >= this.startHeight - 1) {
        const localHash = ancestor === this.startHeight - 1 ? checkpoint.anchor_hash
          : this.db.prepare('SELECT block_hash FROM canonical_blocks WHERE chain_id=? AND height=?').get(this.chainId, ancestor)?.block_hash;
        if ((await this.read(source, ancestor)).hash === localHash) break;
        ancestor--;
        if (checkpoint.last_height - ancestor > maxReorgDepth) fail('REORG_TOO_DEEP');
      }
      if (ancestor < this.startHeight - 1) fail('REORG_TOO_DEEP');
      if (ancestor < checkpoint.last_height) this.rewind(runId, ancestor, 'reorg');
      while (this.checkpoint().last_height < head) {
        checkpoint = this.checkpoint();
        const end = Math.min(head, checkpoint.last_height + batchSize);
        const batch = [];
        let parent = checkpoint.last_height === this.startHeight - 1 ? checkpoint.anchor_hash
          : this.db.prepare('SELECT block_hash FROM canonical_blocks WHERE chain_id=? AND height=?').get(this.chainId, checkpoint.last_height).block_hash;
        for (let height = checkpoint.last_height + 1; height <= end; height++) {
          const block = await this.read(source, height);
          if (block.parentHash !== parent) fail('SOURCE_CHANGED');
          parent = block.hash; batch.push(block);
        }
        if ((await this.read(source, head)).hash !== target.hash) fail('SOURCE_CHANGED');
        this.atomic(() => {
          // Detect another writer before committing a batch obtained outside the transaction.
          if (this.checkpoint().last_height !== checkpoint.last_height) fail('SOURCE_CHANGED');
          for (const block of batch) this.write(block);
          this.db.prepare('UPDATE checkpoints SET last_height=? WHERE chain_id=?').run(end, this.chainId);
          this.db.prepare(`UPDATE ingestion_runs SET blocks_written=blocks_written+?,duplicates_ignored=duplicates_ignored+? WHERE id=?`)
            .run(batch.length, batch.reduce((sum, b) => sum + b.duplicates, 0), runId);
        });
        written += batch.length; duplicates += batch.reduce((sum, b) => sum + b.duplicates, 0);
      }
      if ((await this.read(source, head)).hash !== target.hash) fail('SOURCE_CHANGED');
      this.db.prepare('UPDATE ingestion_runs SET status=?,finished_at=? WHERE id=?').run('succeeded', this.now(), runId);
      return { runId: Number(runId), blocksWritten: written, duplicatesIgnored: duplicates, checkpoint: this.checkpoint().last_height };
    } catch (error) {
      const code = safeCode(error);
      this.db.prepare('UPDATE ingestion_runs SET status=?,error_code=?,finished_at=? WHERE id=?').run('failed', code, this.now(), runId);
      fail(code);
    }
  }
}
