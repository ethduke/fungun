import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FungunAgent, defaultLimits } from './index.mjs';
import { stonxFixture, syntheticAddress } from './stonx-fixture.mjs';
async function fixture() {
  const f = stonxFixture(), calls = [], path = join(await mkdtemp(join(tmpdir(), 'stonx-agent-')), 'journal.json');
  const settings = { apiUrl: 'https://example.com', token: 'fixture', profile: f.profile, baseFeeOracle: f.baseFeeOracle,
    journalPath: path, rpc: { request: () => { throw Error('unexpected_rpc'); } },
    signer: { address: f.input.wallet, signTransaction: () => { throw Error('unexpected_signing'); } },
    fetcher: async (url, options) => { calls.push({ path: url.pathname, body: JSON.parse(options.body ?? '{}') });
      return { ok: true, json: () => url.pathname.endsWith('/ticker')
        ? { selectedTicker: 'SAMPLE', checked: [{ ticker: 'SAMPLE', status: 'unreserved' }], tickerPolicy: 'duplicates_allowed' }
        : { status: 'confirmed' } }; } };
  return { ...f, agent: new FungunAgent(settings), settings, calls };
}
test('Stonx ticker candidates use duplicate policy and never Long registry', async () => {
  const f = await fixture();
  assert.equal(await f.agent.selectTicker(['SAMPLE', 'NEXT']), 'SAMPLE');
  assert.equal(f.calls[0].path, '/v1/agent/stonx/ticker');
  assert.equal(f.agent.chainId, 8453);
  assert.equal(f.agent.limits.maxGas, '8000000');
  assert.equal(defaultLimits.maxGas, '3000000');
  f.agent.fetcher = async () => ({ ok: true, json: () => ({ selectedTicker: 'NEXT', checked: [{ ticker: 'SAMPLE', status: 'reserved' }, { ticker: 'NEXT', status: 'unreserved' }], tickerPolicy: 'duplicates_allowed' }) });
  await assert.rejects(f.agent.selectTicker(['SAMPLE', 'NEXT']), /ticker_selection_invalid/);
});
test('Stonx recovery observes only Stonx status and never signs', async () => {
  const f = await fixture();
  await f.agent.journal.lock(async j => { j.data.intents.a = { state: 'signing', plan: { id: 'a', binding: 'b' }, reservedWei: '1' }; await j.save(); });
  assert.deepEqual(await f.agent.resume(), [{ status: 'confirmed' }]);
  assert.equal(f.calls[0].path, '/v1/agent/stonx/status');
});
test('Stonx journal binds trusted Base oracle and cannot become a Long journal', async () => {
  const f = await fixture(); await f.agent.journal.lock(j => j.save());
  const changed = new FungunAgent({ ...f.settings, baseFeeOracle: { ...f.baseFeeOracle, address: syntheticAddress(999) } });
  await assert.rejects(changed.resume(), /journal_identity_changed/);
  const long = new FungunAgent({ ...f.settings, profile: {} });
  await assert.rejects(long.resume(), /journal_identity_changed/);
});
test('Stonx configured profile rejects Long pairs and mixed theme platforms before launching', async () => {
  const f = await fixture();
  await assert.rejects(f.agent.deploy({ ...f.input.draft, pairId: 'long-EXAMPLE' }), /unsupported_launchpad/);
  await assert.rejects(f.agent.tick({ searchLaunchpads: ['stonx'], deployLaunchpads: ['long'] }), /unsupported_launchpad/);
  assert.equal(f.calls.length, 0);
});


test('Stonx requires an explicit fee oracle before any paid artwork or requests', async () => {
  const f = await fixture();
  for (const oracle of [undefined, {}, { ...f.baseFeeOracle, codeHash: 'invalid' }, { ...f.baseFeeOracle, address: syntheticAddress(0) }]) {
    assert.throws(() => new FungunAgent({ ...f.settings, baseFeeOracle: oracle }), /agent_configuration/);
  }
  assert.equal(f.calls.length, 0);
});
