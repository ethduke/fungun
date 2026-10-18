import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const fingerprint = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const totals = events => {
  const result = {};
  for (const e of events) result[e.token] = ((BigInt(result[e.token] || '0')) + BigInt(e.amountRaw)).toString();
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
};
const payload = block => ({ height: block.height, hash: block.hash, parentHash: block.parentHash,
  timestamp: block.timestamp, transactions: block.transactions, events: block.events });

// Independent source-vs-SQL comparison, not a check of the checkpoint alone.
// A successful fetch is not proof the provider returned every chain log; the
// production source adapter must establish that independently (see README).
export async function reconcile(pipeline, source) {
  const rows = pipeline.canonical(); const checkpoint = pipeline.checkpoint();
  let sourceHead = null, sourceReadable = true;
  try { sourceHead = await source.getHead(); } catch { sourceReadable = false; }
  if (!Number.isSafeInteger(sourceHead) || sourceHead < pipeline.startHeight - 1) sourceReadable = false;
  const last = checkpoint?.last_height ?? pipeline.startHeight - 1;
  const local = [], upstream = [], sqlEvents = [], sourceEvents = [];
  let missingBlocks = 0, brokenParents = 0, mismatchedBlocks = 0, projectionErrors = 0;
  const byHeight = new Map(rows.map(row => [row.height, row]));
  let previous = checkpoint?.anchor_hash;
  const reportHead = sourceReadable ? sourceHead : last;
  // Bounded showcase datasets; a live adapter should reconcile bounded partitions.
  if (reportHead - pipeline.startHeight > 10000) throw new Error('RECONCILIATION_RANGE_TOO_LARGE');
  for (let height = pipeline.startHeight; height <= reportHead; height++) {
    const row = byHeight.get(height);
    let expected;
    try { expected = await pipeline.read(source, height); } catch { sourceReadable = false; }
    if (expected) { upstream.push(payload(expected)); sourceEvents.push(...expected.events); }
    if (!row) { missingBlocks++; continue; }
    const stored = pipeline.readStored(row.hash);
    if (previous && stored.parentHash !== previous) brokenParents++;
    previous = row.hash;
    if (stored.events.length !== row.expected_events) projectionErrors++;
    local.push(payload(stored)); sqlEvents.push(...stored.events);
    if (expected) {
      if (!isDeepStrictEqual(payload(stored), payload(expected))) mismatchedBlocks++;
    }
  }
  let finalHead;
  try {
    finalHead = await source.getHead();
    // Reject a moving fork even when its height is unchanged.
    for (const block of upstream) if ((await pipeline.read(source, block.height)).hash !== block.hash) sourceReadable = false;
  } catch { sourceReadable = false; }
  if (finalHead !== sourceHead) sourceReadable = false;
  const fkErrors = pipeline.db.prepare('PRAGMA foreign_key_check').all().length;
  const integrityOk = pipeline.db.prepare('PRAGMA integrity_check').all().every(row => row.integrity_check === 'ok');
  const eventCount = pipeline.db.prepare(`SELECT count(*) AS n FROM event_logs e JOIN canonical_blocks c
    ON c.chain_id=e.chain_id AND c.block_hash=e.block_hash WHERE e.chain_id=?`).get(pipeline.chainId).n;
  if (eventCount !== sqlEvents.length) projectionErrors++;
  const sqlTotals = totals(sqlEvents), sourceTotals = totals(sourceEvents);
  const localDigest = fingerprint(local), sourceDigest = fingerprint(upstream);
  const checks = [
    ['Source available and stable', sourceReadable],
    ['Complete block coverage', missingBlocks === 0 && rows.length === Math.max(0, reportHead - pipeline.startHeight + 1)],
    ['Continuous parent links', brokenParents === 0],
    ['Canonical hashes and events match source', mismatchedBlocks === 0 && localDigest === sourceDigest && sourceReadable],
    ['Normalized projection completeness', projectionErrors === 0],
    ['Exact integer transfer totals', isDeepStrictEqual(sqlTotals, sourceTotals) && sourceReadable],
    ['Foreign keys and SQL integrity', fkErrors === 0 && integrityOk],
    ['Checkpoint equals verified tip', last === reportHead && (rows.at(-1)?.height ?? pipeline.startHeight - 1) === last],
  ].map(([name, passed]) => ({ name, passed }));
  return { healthy: checks.every(check => check.passed), checks, sourceHead: sourceReadable ? sourceHead : null,
    checkpoint: last, canonicalBlocks: rows.length, canonicalEvents: eventCount, missingBlocks, brokenParents,
    mismatchedBlocks, projectionErrors, foreignKeyErrors: fkErrors,
    orphanBlocks: pipeline.db.prepare(`SELECT count(*) AS n FROM blocks b LEFT JOIN canonical_blocks c
      ON c.chain_id=b.chain_id AND c.block_hash=b.hash WHERE b.chain_id=? AND c.block_hash IS NULL`).get(pipeline.chainId).n,
    duplicatesIgnored: pipeline.db.prepare('SELECT coalesce(sum(duplicates_ignored),0) AS n FROM ingestion_runs WHERE chain_id=?').get(pipeline.chainId).n,
    reorgs: pipeline.db.prepare("SELECT count(*) AS n FROM recoveries WHERE chain_id=? AND reason='reorg'").get(pipeline.chainId).n,
    gapRepairs: pipeline.db.prepare("SELECT count(*) AS n FROM recoveries WHERE chain_id=? AND reason='gap_repair'").get(pipeline.chainId).n,
    tokenTotals: pipeline.db.prepare('SELECT address,symbol,decimals FROM tokens WHERE chain_id=? ORDER BY address').all(pipeline.chainId)
      .map(token => ({ symbol: token.symbol, decimals: token.decimals, amountRaw: sqlTotals[token.address] ?? '0',
        sourceAmountRaw: sourceTotals[token.address] ?? '0', reconciled: (sqlTotals[token.address] ?? '0') === (sourceTotals[token.address] ?? '0') })),
    // Fingerprints, not raw block/transaction hashes or wallet identities.
    fingerprintsMatch: sourceReadable && localDigest === sourceDigest,
    timeline: Array.from({ length: Math.max(0, reportHead - pipeline.startHeight + 1) }, (_, i) => {
      const height = pipeline.startHeight + i, row = byHeight.get(height);
      return { height, present: Boolean(row), events: row?.expected_events ?? 0 };
    }) };
}
