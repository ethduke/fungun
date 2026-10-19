import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pipeline } from './pipeline.mjs';
import { FixtureSource, loadFixture } from './fixture-source.mjs';
import { reconcile } from './reconcile.mjs';

export async function runDemo() {
  const fixture = loadFixture(), directory = mkdtempSync(join(tmpdir(), 'farmgun-quality-'));
  const scenarios = [];
  let pipeline;
  const open = label => new Pipeline(join(directory, `${label}.sqlite`), fixture.chain);
  try {
    // Every snapshot comes from the actual SQL/reconciliation functions.
    pipeline = open('duplicates');
    const clean = new FixtureSource(fixture);
    const duplicate = new FixtureSource(fixture, { duplicate: true });
    const beforeDuplicate = await reconcile(pipeline, clean);
    const duplicateRun = await pipeline.sync(duplicate);
    const afterDuplicate = await reconcile(pipeline, clean);
    pipeline.close(); pipeline = open('duplicates');
    const replay = await pipeline.sync(duplicate);
    assert.equal(replay.blocksWritten, 0);
    assert.equal(afterDuplicate.duplicatesIgnored, afterDuplicate.canonicalEvents);
    scenarios.push({ id: 'duplicates', title: 'Duplicate delivery',
      description: 'Every Transfer arrives twice. Primary keys and payload comparison accept one copy; a restart and identical rerun write zero blocks.',
      before: beforeDuplicate, after: afterDuplicate,
      evidence: { duplicatesIgnored: duplicateRun.duplicatesIgnored, blocksWrittenOnRerun: replay.blocksWritten },
      steps: ['Replay duplicated events', 'Compare identical event payloads', 'Commit one normalized copy', 'Restart and rerun: zero writes'] });
    pipeline.close(); pipeline = open('gap');
    await assert.rejects(pipeline.sync(new FixtureSource(fixture, { missing: [106] })), { code: 'SOURCE_UNAVAILABLE' });
    const beforeGap = await reconcile(pipeline, clean);
    assert.equal(beforeGap.checkpoint, 105);
    assert.equal(beforeGap.missingBlocks, 6);
    pipeline.close(); pipeline = open('gap');
    const resume = await pipeline.sync(clean);
    const afterGap = await reconcile(pipeline, clean);
    scenarios.push({ id: 'gap', title: 'Missing blocks',
      description: 'The source cannot serve block 106. The batch stops at durable checkpoint 105. A restarted worker resumes at 106 and fills the six-block backlog.',
      before: beforeGap, after: afterGap,
      evidence: { checkpointBeforeRestart: beforeGap.checkpoint, resumedFrom: beforeGap.checkpoint + 1, blocksRecovered: resume.blocksWritten },
      steps: ['Source block 106 unavailable', 'Fail batch; preserve checkpoint 105', 'Restart from persisted SQL', 'Backfill blocks 106–111'] });
    pipeline.close(); pipeline = open('reorg');
    await pipeline.sync(clean);
    const replacement = new FixtureSource(fixture, { branch: 'replacement' });
    const beforeReorg = await reconcile(pipeline, replacement);
    assert.equal(beforeReorg.mismatchedBlocks, 3);
    const reorgRun = await pipeline.sync(replacement);
    const afterReorg = await reconcile(pipeline, replacement);
    assert.equal(afterReorg.orphanBlocks, 3);
    scenarios.push({ id: 'reorg', title: 'Recorded fork replay',
      description: 'A recorded synthetic branch replaces blocks 109–111 at the same head height. The worker finds ancestor 108, replays the replacement, and excludes orphaned transfers from totals.',
      before: beforeReorg, after: afterReorg,
      evidence: { commonAncestor: 108, orphanBlocksRetained: afterReorg.orphanBlocks, replacementBlocks: reorgRun.blocksWritten },
      steps: ['Detect changed head hash', 'Find common ancestor 108', 'Rewind and replay replacement', 'Retain orphans; exclude their totals'] });
    for (const scenario of scenarios) {
      assert.equal(scenario.before.healthy, false);
      assert.equal(scenario.after.healthy, true);
      assert.equal(scenario.after.canonicalBlocks, 12);
    }
    return { schemaVersion: 1, generatedAt: new Date().toISOString(),
      dataset: { kind: 'synthetic', title: 'Recorded EVM-shaped recovery fixtures',
        notice: 'Replay demonstration, not live chain data or evidence of a historical mainnet reorg.',
        startHeight: 100, endHeight: 111, chainId: fixture.chain.chainId },
      healthy: scenarios.every(scenario => scenario.after.healthy), scenarios,
      tables: ['chains', 'blocks', 'canonical_blocks', 'tokens', 'transactions', 'event_logs', 'transfers', 'checkpoints', 'ingestion_runs', 'recoveries'] };
  } finally { pipeline?.close(); rmSync(directory, { recursive: true, force: true }); }
}

export async function buildDashboard(output) {
  const report = await runDemo();
  mkdirSync(output, { recursive: true });
  for (const name of ['index.html','dashboard.css','dashboard.mjs']) cpSync(new URL(`../dashboard/${name}`, import.meta.url), join(output,name));
  // No raw fixture records, SQL files, databases, addresses, or credentials.
  writeFileSync(join(output, 'quality-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(output, '.nojekyll'), '');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--out') throw new Error('Invalid arguments');
    const report = await buildDashboard(resolve(args[1]));
    console.log(JSON.stringify({ status: 'verified', scenarios: report.scenarios.length, checks: report.scenarios.reduce((n, s) => n + s.after.checks.length, 0) }));
  } catch { console.error('Data-quality replay or export failed. No raw data exported.'); process.exitCode = 1; }
}
