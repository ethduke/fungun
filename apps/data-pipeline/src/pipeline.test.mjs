import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pipeline, normalizeBlock } from './pipeline.mjs';
import { FixtureSource, fixtureHash, loadFixture } from './fixture-source.mjs';
import { reconcile } from './reconcile.mjs';
import { buildDashboard, runDemo } from './demo.mjs';

function setup(t) {
  const fixture = loadFixture(), directory = mkdtempSync(join(tmpdir(), 'quality-test-'));
  let pipeline = new Pipeline(join(directory, 'data.sqlite'), fixture.chain);
  t.after(() => { pipeline.close(); rmSync(directory, { recursive: true, force: true }); });
  return { fixture, directory, get pipeline() { return pipeline; },
    source: options => new FixtureSource(fixture, options),
    reopen() { pipeline.close(); pipeline = new Pipeline(join(directory, 'data.sqlite'), fixture.chain); } };
}

test('incremental backfill resumes from a durable checkpoint and includes empty blocks', async t => {
  const f = setup(t), source = f.source();
  source.getHead = async () => 103;
  assert.equal((await f.pipeline.sync(source)).blocksWritten, 4);
  f.reopen();
  const complete = f.source();
  assert.equal((await f.pipeline.sync(complete)).blocksWritten, 8);
  const quality = await reconcile(f.pipeline, complete);
  assert.equal(quality.healthy, true);
  assert.equal(quality.timeline.find(block => block.height === 105).events, 0);
  assert.equal(quality.canonicalBlocks, 12);
});

test('duplicate delivery is idempotent across process restarts', async t => {
  const f = setup(t);
  const first = await f.pipeline.sync(f.source({ duplicate: true }));
  assert.equal(first.duplicatesIgnored, 23);
  f.reopen();
  assert.equal((await f.pipeline.sync(f.source({ duplicate: true }))).blocksWritten, 0);
  const quality = await reconcile(f.pipeline, f.source());
  assert.equal(quality.canonicalEvents, 23);
  assert.equal(quality.duplicatesIgnored, 23);
  assert.equal(quality.healthy, true);
});

test('conflicting duplicate payloads fail rather than silently replacing facts', async t => {
  const f = setup(t);
  const block = f.fixture.original.find(row => row.height === 100);
  block.events.push({ ...block.events[0], amountRaw: '1' });
  await assert.rejects(f.pipeline.sync(f.source()), { code: 'CONFLICTING_EVENT' });
  assert.equal(f.pipeline.checkpoint().last_height, 99);
  assert.equal(f.pipeline.canonical().length, 0);
});

test('missing block failure preserves committed batches and resumes after reopening', async t => {
  const f = setup(t);
  await assert.rejects(f.pipeline.sync(f.source({ missing: [106] })), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(f.pipeline.checkpoint().last_height, 105);
  const before = await reconcile(f.pipeline, f.source());
  assert.equal(before.missingBlocks, 6);
  assert.equal(before.fingerprintsMatch, false);
  f.reopen();
  assert.equal((await f.pipeline.sync(f.source())).blocksWritten, 6);
  assert.equal((await reconcile(f.pipeline, f.source())).healthy, true);
});

test('a partially fetched batch cannot advance its checkpoint', async t => {
  const f = setup(t);
  await assert.rejects(f.pipeline.sync(f.source({ missing: [101] })), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(f.pipeline.checkpoint().last_height, 99);
  assert.equal(f.pipeline.db.prepare('SELECT count(*) AS n FROM blocks').get().n, 0);
});

test('same-height reorg replaces canonical facts and retains excluded orphan history', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  const fork = f.source({ branch: 'replacement' });
  assert.equal((await reconcile(f.pipeline, fork)).mismatchedBlocks, 3);
  assert.equal((await f.pipeline.sync(fork)).blocksWritten, 3);
  const quality = await reconcile(f.pipeline, fork);
  assert.equal(quality.healthy, true);
  assert.equal(quality.reorgs, 1);
  assert.equal(quality.orphanBlocks, 3);
  assert.equal(quality.canonicalBlocks, 12);
  const expected = f.fixture.replacement.filter(b => b.height >= 100).flatMap(b => b.events)
    .reduce((sum, event) => sum + BigInt(event.amountRaw), 0n);
  assert.equal(quality.tokenTotals[0].amountRaw, String(expected));
  assert.equal(f.pipeline.db.prepare('SELECT count(*) AS n FROM blocks').get().n, 15);
});

test('re-included transaction hashes on another fork do not double count', async t => {
  const f = setup(t);
  const old = f.fixture.original.find(b => b.height === 109);
  const next = f.fixture.replacement.find(b => b.height === 109);
  next.transactions[0].hash = old.transactions[0].hash;
  next.events[0].txHash = old.transactions[0].hash;
  await f.pipeline.sync(f.source());
  await f.pipeline.sync(f.source({ branch: 'replacement' }));
  const result = await reconcile(f.pipeline, f.source({ branch: 'replacement' }));
  assert.equal(result.healthy, true);
  assert.equal(result.canonicalEvents, 23);
});

test('deep reorg limit fails closed without changing the existing canonical chain', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  const before = f.pipeline.canonical();
  await assert.rejects(f.pipeline.sync(f.source({ branch: 'replacement' }), { maxReorgDepth: 2 }), { code: 'REORG_TOO_DEEP' });
  assert.deepEqual(f.pipeline.canonical(), before);
  assert.equal(f.pipeline.checkpoint().last_height, 111);
});

test('a lagging provider cannot erase a newer stored tip', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  const source = f.source(); source.getHead = async () => 108;
  await assert.rejects(f.pipeline.sync(source), { code: 'SOURCE_HEAD_BEHIND' });
  assert.equal(f.pipeline.canonical().length, 12);
});

test('an internal missing canonical block is detected and repaired by replay', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  f.pipeline.db.prepare('DELETE FROM canonical_blocks WHERE height=102').run();
  assert.equal((await reconcile(f.pipeline, f.source())).missingBlocks, 1);
  await f.pipeline.sync(f.source());
  const result = await reconcile(f.pipeline, f.source());
  assert.equal(result.healthy, true);
  assert.equal(result.gapRepairs, 1);
  assert.equal(result.canonicalEvents, 23);
});

test('SQL projection corruption is caught by independent totals and source comparison', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  f.pipeline.db.prepare('UPDATE transfers SET amount_raw=? WHERE rowid=(SELECT min(rowid) FROM transfers)').run('1');
  const result = await reconcile(f.pipeline, f.source());
  assert.equal(result.healthy, false);
  assert.equal(result.tokenTotals[0].reconciled, false);
  assert.equal(result.fingerprintsMatch, false);
});

test('missing normalized transfer rows cannot pass a row-count-only quality check', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  f.pipeline.db.exec('DELETE FROM transfers WHERE rowid=(SELECT min(rowid) FROM transfers)');
  const result = await reconcile(f.pipeline, f.source());
  assert.equal(result.healthy, false);
  assert.ok(result.projectionErrors > 0);
});

test('source fork changes during a fetched batch prevent its commit', async t => {
  const f = setup(t), source = f.source(); const read = source.getBlock.bind(source);
  let tipReads = 0;
  source.getBlock = async height => height === 111 && ++tipReads > 1
    ? structuredClone(f.fixture.replacement.at(-1)) : read(height);
  await assert.rejects(f.pipeline.sync(source), { code: 'SOURCE_CHANGED' });
  assert.equal(f.pipeline.checkpoint().last_height, 99);
  assert.equal(f.pipeline.canonical().length, 0);
});

test('constraint failure rolls back both SQL facts and batch checkpoint', async t => {
  const f = setup(t);
  f.fixture.original.find(b => b.height === 101).events[0].token = fixtureHash('unconfigured-token').slice(0, 42);
  await assert.rejects(f.pipeline.sync(f.source()), { code: 'STORAGE_ERROR' });
  assert.equal(f.pipeline.checkpoint().last_height, 99);
  assert.equal(f.pipeline.db.prepare('SELECT count(*) AS n FROM blocks').get().n, 0);
});

test('changed stream token configuration requires a separate backfill', async t => {
  const f = setup(t);
  await f.pipeline.sync(f.source());
  assert.throws(() => new Pipeline(join(f.directory, 'data.sqlite'), { ...f.fixture.chain,
    tokens: [...f.fixture.chain.tokens, { address: fixtureHash('extra').slice(0,42), symbol: 'OTHER', decimals: 6 }] }), { code: 'CONFIG_MISMATCH' });
});

test('invalid chain IDs, uint256 values and event indices are rejected', t => {
  const f = setup(t), block = f.fixture.original.find(b => b.height === 100);
  for (const mutate of [b => { b.chainId++; }, b => { b.events[0].amountRaw = '-1'; },
    b => { b.events[0].amountRaw = String(2n ** 256n); }, b => { b.events[0].index = 0.5; },
    b => { b.events[0].txHash = fixtureHash('unknown'); }]) {
    const copy = structuredClone(block); mutate(copy);
    assert.throws(() => normalizeBlock(copy, f.fixture.chain.chainId, 100), { code: 'INVALID_BLOCK' });
  }
});

test('source exceptions are recorded as fixed codes without private diagnostics', async t => {
  const f = setup(t), marker = ['DO_NOT', 'EXPORT_PROVIDER_DETAILS'].join('_');
  await assert.rejects(f.pipeline.sync({ getHead: async () => { throw new Error(marker); } }), error => {
    assert.equal(error.code, 'SOURCE_UNAVAILABLE'); assert.ok(!error.message.includes(marker)); return true;
  });
  assert.ok(!JSON.stringify(f.pipeline.db.prepare('SELECT * FROM ingestion_runs').all()).includes(marker));
});

test('demonstrations are real SQL recovery results and all final checks pass', async () => {
  const result = await runDemo();
  assert.equal(result.dataset.kind, 'synthetic');
  assert.equal(result.healthy, true);
  assert.equal(result.scenarios.length, 3);
  for (const scenario of result.scenarios) {
    assert.equal(scenario.before.healthy, false);
    assert.equal(scenario.after.checks.filter(c => c.passed).length, 8);
  }
});

test('public dashboard export contains only static assets and aggregate data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-export-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const report = await buildDashboard(directory);
  assert.deepEqual(readdirSync(directory).sort(), ['.nojekyll', 'dashboard.css', 'dashboard.mjs', 'index.html', 'quality-report.json']);
  const json = readFileSync(join(directory, 'quality-report.json'), 'utf8');
  assert.equal(/0x[0-9a-f]{40,}/i.test(json), false);
  const fixture = loadFixture();
  assert.equal(json.includes(fixture.chain.tokens[0].address), false);
  assert.equal(json.includes(fixture.original.at(-1).hash), false);
  assert.deepEqual(JSON.parse(json), report);
});
