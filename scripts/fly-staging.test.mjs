import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseStaging, stagingGate, services } from './fly-staging.mjs';
import { smokeStaging } from './smoke-staging.mjs';

const sha = 'a'.repeat(40);
const version = `sha-${sha}-123-1`;
const digest = n => `sha256:${String(n).repeat(64)}`;
const image = (service, n) => `registry.fly.io/${service.app}@${digest(n)}`;

function fixture({ first = false, failDeploy = false, failSmoke = false, failRestore = false, mismatched = false, secret = false, staleReads = 0 } = {}) {
  const current = new Map(services.map(service => [service.key, first ? null : image(service, 1)]));
  const pending = new Map();
  const calls = []; const records = []; let probes = 0;
  return { calls, records, current, options: { sha, version, sleep: async () => {},
    record: state => records.push(structuredClone(state)),
    smoke: async () => { probes++; if (failSmoke && probes === (first ? 1 : 2)) throw new Error('probe failed'); },
    run: async (service, bin, args) => {
      calls.push({ key: service.key, bin, args });
      if (bin === 'docker' && args[0] === 'image') {
        if (args[3].includes('Labels')) return mismatched && service.key === 'web' ? `sha-${sha}-122-1` : version;
        return JSON.stringify([image(service, 2)]);
      }
      if (args[0] === 'secrets') return JSON.stringify(secret ? [{ Name: 'PRIVATE_KEY' }] : []);
      if (args[0] === 'machine' && args[1] === 'list') {
        const replacement = pending.get(service.key);
        const replacing = replacement?.remaining > 0;
        if (replacing) replacement.remaining--;
        const value = replacing ? replacement.previous : current.get(service.key);
        return JSON.stringify(value ? [{ state: replacing ? 'replacing' : 'started', image_ref: { registry: 'registry.fly.io', repository: service.app, digest: value.split('@')[1] } }] : []);
      }
      if (args[0] === 'deploy') {
        const value = args[args.indexOf('--image') + 1];
        pending.set(service.key, { previous: current.get(service.key), remaining: staleReads });
        current.set(service.key, value); // A failed Fly command may already change a Machine.
        if (failDeploy && service.key === 'web' && value.endsWith(digest(2))) throw new Error('partial deployment');
        if (failRestore && value.endsWith(digest(1))) throw new Error('restore failed');
      }
      if (args[0] === 'scale') current.set(service.key, null);
      return '';
    },
  } };
}

test('staging retains both previous images before deploying and verifies health', async () => {
  const f = fixture(); const result = await releaseStaging(f.options);
  assert.equal(result.status, 'healthy');
  const firstDeploy = f.calls.findIndex(call => call.args[0] === 'deploy');
  for (const service of services) {
    assert.equal(f.current.get(service.key), image(service, 2));
    assert.ok(f.calls.slice(0, firstDeploy).some(call => call.key === service.key && call.args[0] === 'push' && call.args[1].endsWith(':rollback')));
    assert.equal(result.services[service.key].previous, image(service, 1));
  }
});

test('successful Fly deploy can report the previous image while a Machine is replacing', async () => {
  const f = fixture({ staleReads: 2 });
  const state = await releaseStaging(f.options);
  assert.equal(state.status, 'healthy');
  for (const service of services) {
    assert.equal(f.current.get(service.key), image(service, 2));
    assert.equal(f.calls.filter(call => call.key === service.key && call.args[0] === 'deploy').length, 1);
  }
});

test('rollback also waits for replacement metadata to converge', async () => {
  const f = fixture({ staleReads: 2, failSmoke: true });
  await assert.rejects(releaseStaging(f.options), /previous images restored/);
  assert.equal(f.records.at(-1).failedPhase, 'probe');
  for (const service of services) assert.equal(f.current.get(service.key), image(service, 1));
});

test('a Machine that never reports the target image still triggers verified rollback', async () => {
  const f = fixture();
  const run = async (service, bin, args) => {
    const output = await f.options.run(service, bin, args);
    if (args[0] === 'machine' && f.current.get(service.key) === image(service, 2))
      return JSON.stringify([{ state: 'replacing', image_ref: {
        registry: 'registry.fly.io', repository: service.app, digest: digest(1),
      } }]);
    return output;
  };
  await assert.rejects(releaseStaging({ ...f.options, run, imageAttempts: 2 }), /previous images restored/);
  assert.equal(f.records.at(-1).status, 'rolled_back');
  assert.equal(f.records.at(-1).failedPhase, 'verify-api');
  for (const service of services) assert.equal(f.current.get(service.key), image(service, 1));
});

for (const action of ['deploy', 'rollback']) test(`${action} starts idle Machines only after their desired image is applied`, async () => {
  const f = fixture();
  const started = new Set();
  const run = async (service, bin, args) => {
    const output = await f.options.run(service, bin, args);
    if (args[0] === 'machine' && args[1] === 'start') { started.add(service.key); return ''; }
    if (args[0] === 'machine' && args[1] === 'list' && f.current.get(service.key) === image(service, 2) && !started.has(service.key))
      return JSON.stringify([{ id: `test-${service.key}`, state: 'stopped',
        config: { image: image(service, 2) }, image_ref: {
          registry: 'registry.fly.io', repository: service.app, digest: digest(1),
        } }]);
    return output;
  };
  assert.equal((await releaseStaging({ ...f.options, action, run })).status, 'healthy');
  assert.deepEqual([...started], ['api', 'web']);
});

for (const scenario of [{ failDeploy: true }, { failSmoke: true }]) test(`partial staging failure restores both previous digests: ${JSON.stringify(scenario)}`, async () => {
  const f = fixture(scenario);
  await assert.rejects(releaseStaging(f.options), /previous images restored/);
  for (const service of services) assert.equal(f.current.get(service.key), image(service, 1));
  assert.equal(f.records.at(-1).status, 'rolled_back');
});

test('rollback verification failure remains a failed deployment', async () => {
  const f = fixture({ failSmoke: true, failRestore: true });
  await assert.rejects(releaseStaging(f.options), /rollback verification failed/);
  assert.equal(f.records.at(-1).status, 'rollback_failed');
});

test('unhealthy first release is removed instead of inventing a rollback image', async () => {
  const f = fixture({ first: true, failSmoke: true });
  await assert.rejects(releaseStaging(f.options));
  assert.deepEqual([...f.current.values()], [null, null]);
});

test('superseded releases and unexpected secrets cannot mutate staging Machines', async () => {
  const f = fixture();
  assert.equal((await releaseStaging({ ...f.options, gate: async () => false })).status, 'superseded');
  assert.ok(!f.calls.some(call => ['deploy', 'scale'].includes(call.args[0]) || (call.args[0] === 'push' && call.args[1].endsWith(':rollback'))));
  const unsafe = fixture({ secret: true });
  await assert.rejects(releaseStaging(unsafe.options), /must not contain secrets/);
  assert.ok(!unsafe.calls.some(call => call.args[0] === 'deploy'));
});

test('manual rollback requires a matching retained API/web release', async () => {
  const f = fixture();
  assert.equal((await releaseStaging({ ...f.options, action: 'rollback' })).status, 'healthy');
  const bad = fixture({ mismatched: true });
  await assert.rejects(releaseStaging({ ...bad.options, action: 'rollback' }), /not from the same release/);
  assert.ok(!bad.calls.some(call => call.args[0] === 'deploy'));
});

test('deployment gate checks exact main SHA, trusted check app, latest results, and failed checks', async () => {
  let checks = ['webview', 'production-build', 'repository-safety'].map((name, id) => ({ name, id, app: { id: 15368 }, head_sha: sha, status: 'completed', conclusion: 'success' }));
  const request = async url => Response.json(url.includes('/git/ref/') ? { object: { sha } } : { check_runs: checks });
  assert.equal(await stagingGate({ sha, request }), true);
  assert.equal(await stagingGate({ sha: 'b'.repeat(40), request }), false);
  checks = [...checks, { ...checks[0], id: 100, conclusion: 'failure' }];
  await assert.rejects(stagingGate({ sha, request }), /did not pass/);
  checks = checks.slice(0, 3).map(check => ({ ...check, app: { id: 1 } }));
  await assert.rejects(stagingGate({ sha, request, attempts: 1 }), /did not finish/);
});

test('smoke probe rejects a real transaction or non-mock response without logging its body', async () => {
  const request = async url => {
    if (url.endsWith('/healthz')) return Response.json({ status: 'ok' }, { headers: { 'x-fungun-staging': 'mock' } });
    if (url.endsWith('/api/launch-prepare')) return Response.json({ mode: 'live', status: 'ready', transactions: [{ data: '0x1234' }] });
    return new Response('<html></html>');
  };
  await assert.rejects(smokeStaging({ request, attempts: 1 }), /^Error: Staging health or mocked preparation check failed\.$/);
});

test('stalled health retries respect the overall deadline and leave time for rollback', async () => {
  let elapsed = 0;
  let calls = 0;
  const request = async () => { calls++; elapsed += 10; throw new Error('unavailable'); };
  await assert.rejects(smokeStaging({ request, now: () => elapsed, timeoutMs: 5,
    sleep: async () => assert.fail('No retry after the deadline') }));
  assert.equal(calls, 1);
});
