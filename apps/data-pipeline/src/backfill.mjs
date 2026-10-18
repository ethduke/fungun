import { Pipeline, safeCode } from './pipeline.mjs';
import { FixtureSource, loadFixture } from './fixture-source.mjs';
import { reconcile } from './reconcile.mjs';

let pipeline;
try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--db' || args[2] !== '--branch' || !['original', 'replacement'].includes(args[3])) throw new Error('Invalid arguments');
  const fixture = loadFixture();
  pipeline = new Pipeline(args[1], fixture.chain);
  const source = new FixtureSource(fixture, { branch: args[3] });
  const result = await pipeline.sync(source);
  const quality = await reconcile(pipeline, source);
  console.log(JSON.stringify({ status: quality.healthy ? 'verified' : 'failed', ...result,
    canonicalBlocks: quality.canonicalBlocks, canonicalEvents: quality.canonicalEvents, reorgs: quality.reorgs }));
  if (!quality.healthy) process.exitCode = 1;
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: safeCode(error) })); process.exitCode = 1; }
finally { pipeline?.close(); }
