import assert from 'node:assert/strict';
import test from 'node:test';
import { releasePlan, verifyRelease, promoteProduction, productionServices } from './fly-production.mjs';
import { smokeProduction, productionOrigins } from './smoke-production.mjs';

const sha = 'a'.repeat(40);
const digest = n => `sha256:${String(n).repeat(64)}`;
const image = (service, n, staging = false) => `registry.fly.io/${staging ? service.staging : service.app}@${digest(n)}`;
const sourceRun = { id: 123, run_attempt: 1, workflow_id: 385837647, path: '.github/workflows/deploy-staging.yml',
  repository: { full_name: 'ethduke/fungun' }, head_repository: { full_name: 'ethduke/fungun' },
  head_branch: 'main', head_sha: sha, event: 'workflow_run', status: 'completed', conclusion: 'success' };
const artifact = { id: 456, name: 'staging-release-123-1', expired: false, size_in_bytes: 527,
  workflow_run: { id: 123, head_sha: sha } };
const staging = { sha, version: `sha-${sha}-123-1`, action: 'deploy', status: 'healthy',
  services: Object.fromEntries(productionServices.map(service => [service.key, { target: image(service, 2, true) }])) };
const plan = releasePlan(sourceRun, artifact, staging);
const checks = ['webview', 'production-build', 'repository-safety'].map((name, id) => ({
  id, name, app: { id: 15368 }, head_sha: sha, status: 'completed', conclusion: 'success',
}));

function gateFixture({ run = sourceRun, record = staging, artifacts = [artifact], status = 'ahead', checkRuns = checks } = {}) {
  const downloads = []; const paths = [];
  return { downloads, paths, options: { runId: '123', download: async (...args) => { downloads.push(args); return record; },
    get: async path => {
      paths.push(path);
      if (path.includes('/artifacts?')) return { artifacts };
      if (path === 'actions/runs/123') return run;
      if (path.startsWith('compare/')) return { status };
      if (path.includes('/check-runs?')) return { total_count: checkRuns.length, check_runs: checkRuns };
      assert.fail(`Unexpected GitHub request: ${path}`);
    },
  } };
}

test('promotion selects a retained healthy staging deployment on main with all trusted checks', async () => {
  const f = gateFixture();
  assert.deepEqual(await verifyRelease(f.options), plan);
  assert.deepEqual(f.downloads, [['123', 'staging-release-123-1']]);
  assert.ok(f.paths.includes(`compare/${sha}...main`));
});

for (const change of [
  { workflow_id: 99 }, { path: '.github/workflows/untrusted.yml' }, { head_branch: 'feature' },
  { head_repository: { full_name: 'attacker/fungun' } }, { repository: { full_name: 'attacker/fungun' } },
  { conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_sha: 'bad' },
]) test(`untrusted staging provenance is rejected before artifact download: ${JSON.stringify(change)}`, async () => {
  const f = gateFixture({ run: { ...sourceRun, ...change } });
  await assert.rejects(verifyRelease(f.options));
  assert.equal(f.downloads.length, 0);
});

test('expired, ambiguous, rerun, oversized and wrong-run artifacts cannot be promoted', async () => {
  for (const artifacts of [[], [artifact, artifact], [{ ...artifact, expired: true }],
    [{ ...artifact, size_in_bytes: 20_000 }], [{ ...artifact, workflow_run: { id: 1, head_sha: sha } }],
    [{ ...artifact, name: 'staging-release-123-2' }]]) {
    const f = gateFixture({ artifacts });
    await assert.rejects(verifyRelease(f.options));
    assert.equal(f.downloads.length, 0);
  }
});

test('rollback artifacts, wrong digests and stale source commits are rejected', async () => {
  for (const record of [{ ...staging, action: 'rollback' }, { ...staging, status: 'rolled_back' },
    { ...staging, sha: 'b'.repeat(40) }, { ...staging, version: `sha-${sha}-123-2` },
    { ...staging, services: { ...staging.services, web: { target: image(productionServices[1], 2) } } }])
    await assert.rejects(verifyRelease(gateFixture({ record }).options));
  await assert.rejects(verifyRelease(gateFixture({ status: 'diverged' }).options));
  await assert.rejects(verifyRelease({ ...gateFixture().options, runId: '123;echo unsafe' }));
});

test('latest failed, missing, unfinished or impersonated required checks block production', async () => {
  for (const checkRuns of [checks.slice(1), checks.map(check => ({ ...check, app: { id: 1 } })),
    [...checks, { ...checks[0], id: 100, conclusion: 'failure' }],
    [...checks, { ...checks[0], id: 100, status: 'in_progress', conclusion: null }]])
    await assert.rejects(verifyRelease(gateFixture({ checkRuns }).options));
});

test('required check pagination cannot hide a newer failure', async () => {
  const f = gateFixture();
  const get = async path => path.includes('/check-runs?')
    ? { total_count: 101, check_runs: path.endsWith('page=1')
      ? [...checks, ...Array.from({ length: 97 }, (_, id) => ({ name: 'other', id }))]
      : [{ ...checks[0], id: 200, conclusion: 'failure' }] }
    : f.options.get(path);
  await assert.rejects(verifyRelease({ ...f.options, get }));
});

function machine(service, value = image(service, 1)) {
  return { id: service.machine, state: 'started', image_ref: { registry: 'registry.fly.io', repository: service.app, digest: value.split('@')[1] },
    config: { image: value, init: {}, env: { NODE_ENV: 'production', APP_ORIGIN: productionOrigins.web,
      ...(service.key === 'api' ? { READS_MACHINE_ID: service.machine, BUDGET_DB_PATH: '/data/read-budget.sqlite' }
        : { READ_SERVICE_ORIGIN: productionOrigins.api }),
    }, mounts: service.key === 'api' ? [{ volume: 'vol_fixture', path: '/data', name: 'read_budget' }] : [],
    guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 }, services: [{ internal_port: service.key === 'api' ? 8787 : 3000 }],
    },
  };
}

function fixture({ failUpdate = false, failSmoke = false, failRestore = false, wrongLabels = false, wrongDigest = false,
  staleReads = 0, wrongRuntime = false, changedApproval = false } = {}) {
  const current = new Map(productionServices.map(service => [service.key, machine(service)]));
  const pending = new Map(); const calls = []; const records = []; let probes = 0;
  return { current, calls, records, options: { plan, releaseId: 'production-999-1', sleep: async () => {},
    verify: async () => changedApproval ? { ...plan, stagingAttempt: 2 } : plan,
    record: value => records.push(structuredClone(value)),
    smoke: async () => { probes++; if (failSmoke && probes === 2) throw new Error('probe'); },
    run: async (service, scope, bin, args) => {
      calls.push({ key: service.key, scope, bin, args });
      if (bin === 'flyctl' && args[0] === 'machine' && args[1] === 'list') {
        const delay = pending.get(service.key);
        if (delay?.remaining > 0) { delay.remaining--; return JSON.stringify([{ ...delay.previous, state: 'replacing' }]); }
        return JSON.stringify([current.get(service.key)]);
      }
      if (bin === 'docker' && args[0] === 'image') {
        if (args.includes('--format')) return JSON.stringify([image(service, wrongDigest ? 3 : 2)]);
        return JSON.stringify([{ Config: { Cmd: ['node', 'src/server.mjs'], Labels: {
          'org.opencontainers.image.revision': wrongLabels ? 'b'.repeat(40) : sha,
          'org.opencontainers.image.version': plan.version,
        } } }]);
      }
      if (bin === 'flyctl' && args[0] === 'machine' && args[1] === 'update') {
        const value = args[args.indexOf('--image') + 1];
        pending.set(service.key, { previous: current.get(service.key), remaining: staleReads });
        const updated = machine(service, value);
        if (wrongRuntime && value === image(service, 2)) updated.config.mounts = [];
        current.set(service.key, updated);
        if (failUpdate && service.key === 'web' && value === image(service, 2)) throw new Error('partial failure');
        if (failRestore && value === image(service, 1)) throw new Error('restore failed');
      }
      return '';
    },
  } };
}

const updates = f => f.calls.filter(call => call.bin === 'flyctl' && call.args[0] === 'machine' && call.args[1] === 'update');

test('promotes the exact tested digests, retaining both previous images before any image-only update', async () => {
  const f = fixture({ staleReads: 2 }); const result = await promoteProduction(f.options);
  assert.equal(result.status, 'healthy');
  const firstUpdate = f.calls.indexOf(updates(f)[0]);
  for (const service of productionServices) {
    assert.equal(f.current.get(service.key).config.image, image(service, 2));
    assert.ok(f.calls.slice(0, firstUpdate).some(call => call.key === service.key && call.args[0] === 'push' && call.args[1].endsWith(':rollback')));
    assert.deepEqual(updates(f).find(call => call.key === service.key).args,
      ['machine', 'update', service.machine, '--app', service.app, '--image', image(service, 2), '--yes', '--wait-timeout', '120']);
  }
  assert.equal(f.calls.filter(call => call.scope === 'staging').some(call => call.bin === 'flyctl' && call.args[0] !== 'auth'), false);
});

for (const scenario of [{ failUpdate: true }, { failSmoke: true }, { wrongRuntime: true }])
  test(`production failure restores and verifies the original image pair: ${JSON.stringify(scenario)}`, async () => {
    const f = fixture({ ...scenario, staleReads: 2 });
    await assert.rejects(promoteProduction(f.options), /previous images restored/);
    assert.equal(f.records.at(-1).status, 'rolled_back');
    for (const service of productionServices) assert.equal(f.current.get(service.key).config.image, image(service, 1));
  });

test('rollback failure is recorded as failed, never successful', async () => {
  const f = fixture({ failSmoke: true, failRestore: true });
  await assert.rejects(promoteProduction(f.options), /rollback verification failed/);
  assert.equal(f.records.at(-1).status, 'rollback_failed');
});

test('wrong deployed digest triggers recovery even when the update command succeeded', async () => {
  const f = fixture(); const original = f.options.run;
  await assert.rejects(promoteProduction({ ...f.options, imageAttempts: 2, run: async (...args) => {
    const result = await original(...args);
    if (args[2] === 'flyctl' && args[3][1] === 'list' && f.current.get(args[0].key).config.image === image(args[0], 2))
      return JSON.stringify([{ ...machine(args[0]), state: 'replacing' }]);
    return result;
  } }), /previous images restored/);
  assert.equal(f.records.at(-1).failedPhase, 'verify-api');
  assert.equal(f.records.at(-1).status, 'rolled_back');
});

test('release-record write failure after an update cannot prevent image recovery', async () => {
  const f = fixture();
  await assert.rejects(promoteProduction({ ...f.options, record: () => {
    if (updates(f).length) throw new Error('disk unavailable');
  } }), /previous images restored/);
  for (const service of productionServices) assert.equal(f.current.get(service.key).config.image, image(service, 1));
});

test('labels, digest identity and approval candidate must match before any production update', async () => {
  for (const scenario of [{ wrongLabels: true }, { wrongDigest: true }, { changedApproval: true }]) {
    const f = fixture(scenario);
    await assert.rejects(promoteProduction(f.options));
    assert.equal(updates(f).length, 0);
  }
});

test('unhealthy baseline, storage, topology and mock process configuration fail without deploying', async () => {
  const changes = [
    m => { m.id = 'other'; }, m => { m.state = 'stopped'; }, m => { m.config.mounts = []; },
    m => { m.config.env.READS_MACHINE_ID = 'other'; }, m => { m.config.env.FUNGUN_STAGING = 'mock'; },
    m => { m.config.init.cmd = ['node', 'src/staging-server.mjs']; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.current.get('api'));
    await assert.rejects(promoteProduction(f.options));
    assert.equal(updates(f).length, 0);
  }
  const f = fixture();
  await assert.rejects(promoteProduction({ ...f.options, smoke: async () => { throw new Error('baseline unhealthy'); } }));
  assert.equal(updates(f).length, 0);
});

test('a superseded approval or out-of-band production change during preparation cannot deploy', async () => {
  const f = fixture(); let verifications = 0;
  await assert.rejects(promoteProduction({ ...f.options, verify: async () => ++verifications === 1 ? plan : { ...plan, artifact: 457 } }));
  assert.equal(updates(f).length, 0);
  const changed = fixture(); const original = changed.options.run;
  await assert.rejects(promoteProduction({ ...changed.options, run: async (...args) => {
    if (args[3][0] === 'push' && args[3][1].endsWith(':rollback')) changed.current.get('api').config.env.APP_ORIGIN = 'https://changed.invalid';
    return original(...args);
  } }));
  assert.equal(updates(changed).length, 0);
});

test('production health checks only GET public routes and reject staging responses', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/healthz')) return Response.json({ status: 'ok' });
    const text = url.endsWith('/llms.txt');
    return new Response(text ? 'Fungun agent discovery' : '<html></html>', { headers: { 'content-type': text ? 'text/plain' : 'text/html' } });
  };
  await smokeProduction({ request });
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ options }) => options.method === 'GET' && options.redirect === 'error' && !options.body));
  await assert.rejects(smokeProduction({ request: async () => Response.json({ status: 'ok' }, { headers: { 'x-fungun-staging': 'mock' } }), attempts: 1 }));
});

test('production probes stop at the deadline to leave time for recovery', async () => {
  let elapsed = 0;
  await assert.rejects(smokeProduction({ now: () => elapsed, timeoutMs: 5,
    request: async () => { elapsed += 10; throw new Error('private provider detail'); },
    sleep: async () => assert.fail('No sleep after deadline') }), /^Error: Production health or page check failed\.$/);
});
