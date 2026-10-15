import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseStaging, stagingGate, services } from './fly-staging.mjs';
import { smokeStaging } from './smoke-staging.mjs';

const sha = 'a'.repeat(40);
const version = `sha-${sha}-123-1`;
const digest = n => `sha256:${String(n).repeat(64)}`;
const image = (service, n) => `registry.fly.io/${service.app}@${digest(n)}`;

function fixture({ first = false, failDeploy = false, failSmoke = false, failRestore = false, mismatched = false, secret = false } = {}) {
  const current = new Map(services.map(service => [service.key, first ? null : image(service, 1)]));
  const calls = []; const records = []; let probes = 0;
  return { calls, records, current, options: { sha, version,
    record: state => records.push(structuredClone(state)),
    smoke: async () => { probes++; if (failSmoke && probes === (first ? 1 : 2)) throw new Error('probe failed'); },
    run: async (service, bin, args) => {
      calls.push({ key: service.key, bin, args });
      if (bin === 'docker' && args[0] === 'image') {
        if (args[3].includes('Labels')) return mismatched && service.key === 'web' ? `sha-${sha}-122-1` : version;
        return JSON.stringify([image(service, 2)]);
      }
      if (args[0] === 'secrets') return JSON.stringify(secret ? [{ Name: 'PRIVATE_KEY' }] : []);
      if (args[0] === 'machine') {
        const value = current.get(service.key);
        return JSON.stringify(value ? [{ image_ref: { registry: 'registry.fly.io', repository: service.app, digest: value.split('@')[1] } }] : []);
      }
      if (args[0] === 'deploy') {
        const value = args[args.indexOf('--image') + 1];
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
