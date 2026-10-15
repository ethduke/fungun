import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { smokeProduction, productionOrigins } from './smoke-production.mjs';
import { deploymentCommand, deploymentFailure, safeDeploymentError, githubMetadata } from './deployment-runtime.mjs';

const repository = 'ethduke/fungun';
const stagingWorkflow = 385837647;
const required = ['webview', 'production-build', 'repository-safety'];
export const productionServices = Object.freeze([
  { key: 'api', app: 'farmgun-api', staging: 'farmgun-staging-api', machine: 'e826491a5d7108' },
  { key: 'web', app: 'farmgun-web', staging: 'farmgun-staging-web', machine: '78450d9b656028' },
]);
const shaPattern = /^[a-f0-9]{40}$/;
const idPattern = /^[1-9][0-9]{0,14}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageFor = (app, digest) => `registry.fly.io/${app}@${digest}`;
const fail = code => { throw deploymentFailure(code); };

function imageDigest(image, app) {
  const prefix = `registry.fly.io/${app}@`;
  if (typeof image !== 'string' || !image.startsWith(prefix) || !digestPattern.test(image.slice(prefix.length)))
    fail('INVALID_IMAGE');
  return image.slice(prefix.length);
}

// Every value passed to a command, output, or approval summary is reconstructed
// from validated metadata; arbitrary artifact properties are never forwarded.
function verifyProvenance(run, artifact) {
  if (run.workflow_id !== stagingWorkflow || run.path !== '.github/workflows/deploy-staging.yml'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository
    || run.head_branch !== 'main' || run.status !== 'completed' || run.conclusion !== 'success'
    || !['workflow_run', 'workflow_dispatch'].includes(run.event)
    || !idPattern.test(String(run.id)) || !idPattern.test(String(run.run_attempt)) || !shaPattern.test(run.head_sha))
    fail('UNTRUSTED_STAGING_RUN');
  const name = `staging-release-${run.id}-${run.run_attempt}`;
  if (artifact.name !== name || artifact.expired !== false || !idPattern.test(String(artifact.id))
    || artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha
    || artifact.size_in_bytes > 16_384 || !Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1)
    fail('INVALID_STAGING_ARTIFACT');
  return `sha-${run.head_sha}-${run.id}-${run.run_attempt}`;
}

export function releasePlan(run, artifact, record) {
  const version = verifyProvenance(run, artifact);
  if (record.sha !== run.head_sha || record.version !== version || record.action !== 'deploy' || record.status !== 'healthy')
    fail('UNHEALTHY_STAGING_RELEASE');
  const images = {};
  for (const service of productionServices) {
    const image = record.services?.[service.key]?.target;
    imageDigest(image, service.staging);
    images[service.key] = image;
  }
  return { sha: run.head_sha, stagingRun: String(run.id), stagingAttempt: run.run_attempt, artifact: artifact.id, version, images };
}

export async function verifyRelease({ runId, get, download }) {
  if (!idPattern.test(String(runId))) fail('INVALID_RUN_ID');
  const run = await get(`actions/runs/${runId}`);
  // Validate provenance before downloading any artifact.
  const name = `staging-release-${run.id}-${run.run_attempt}`;
  const { artifacts } = await get(`actions/runs/${runId}/artifacts?per_page=100`);
  const candidates = artifacts.filter(value => value.name === name);
  if (candidates.length !== 1) fail('MISSING_STAGING_ARTIFACT');
  const artifact = candidates[0];
  verifyProvenance(run, artifact);
  const plan = releasePlan(run, artifact, await download(runId, name));
  const comparison = await get(`compare/${plan.sha}...main`);
  if (!['ahead', 'identical'].includes(comparison.status)) fail('COMMIT_NOT_ON_MAIN');
  const checks = [];
  for (let page = 1; page <= 10; page++) {
    const result = await get(`commits/${plan.sha}/check-runs?per_page=100&filter=all&page=${page}`);
    checks.push(...result.check_runs);
    if (checks.length >= result.total_count) break;
    if (page === 10) fail('CHECKS_INCOMPLETE');
  }
  for (const name of required) {
    const check = checks.filter(value => value.name === name && value.app?.id === 15368 && value.head_sha === plan.sha)
      .sort((a, b) => b.id - a.id)[0];
    if (check?.status !== 'completed' || check.conclusion !== 'success') fail('CHECKS_NOT_PASSED');
  }
  return plan;
}

function currentImage(machine, service) {
  const ref = machine.image_ref;
  if (ref?.registry !== 'registry.fly.io' || ref.repository !== service.app || !digestPattern.test(ref.digest ?? ''))
    fail('CURRENT_IMAGE_UNKNOWN');
  return imageFor(service.app, ref.digest);
}

function runtimeConfig(config) {
  const { image: _image, metadata: _metadata, ...runtime } = config;
  // Fly may update release metadata; runtime, mounts, and command must match.
  return runtime;
}

export function verifyProductionMachine(list, service) {
  if (list.length !== 1 || list[0].id !== service.machine || list[0].state !== 'started')
    fail('MACHINE_NOT_READY');
  const machine = list[0]; const config = machine.config; const env = config?.env;
  if (env?.NODE_ENV !== 'production' || env.APP_ORIGIN !== productionOrigins.web || env.FUNGUN_STAGING
    || (config.init?.cmd?.length ?? 0) || (config.init?.entrypoint?.length ?? 0)
    || (config.init?.exec?.length ?? 0)
    || Object.keys(config.processes ?? {}).length || Object.keys(config.containers ?? {}).length)
    fail('RUNTIME_INVALID');
  if (service.key === 'web' && (env.READ_SERVICE_ORIGIN !== productionOrigins.api || config.mounts?.length))
    fail('WEB_CONFIG_INVALID');
  if (service.key === 'api' && (env.READS_MACHINE_ID !== service.machine
    || env.BUDGET_DB_PATH !== '/data/read-budget.sqlite' || config.mounts?.length !== 1
    || config.mounts[0].path !== '/data' || !config.mounts[0].volume))
    fail('STORAGE_INVALID');
  currentImage(machine, service);
  return machine;
}

export async function promoteProduction({ plan, run, verify, smoke = smokeProduction, record = () => {},
  releaseId, sleep = pause, imageAttempts = 30 }) {
  if (!/^production-[1-9][0-9]{0,14}-[1-9][0-9]{0,14}$/.test(releaseId ?? '')) fail('INVALID_RELEASE_ID');
  const state = { releaseId, status: 'validating', phase: 'validate-release', services: {} };
  const snapshots = new Map(); const attempted = [];
  const save = () => { try { record(state); } catch { fail('RECORD_WRITE_FAILED'); } };
  const phase = value => { state.phase = value; save(); };
  const fly = (service, args) => run(service, 'production', 'flyctl', args);
  const list = async service => JSON.parse(await fly(service, ['machine', 'list', '--app', service.app, '--json']));
  const update = (service, image) => fly(service, ['machine', 'update', service.machine, '--app', service.app,
    '--image', image, '--yes', '--wait-timeout', '120']);
  const wait = async (service, expected) => {
    const deadline = Date.now() + 60_000;
    for (let attempt = 0; attempt < imageAttempts; attempt++) {
      const machines = await list(service);
      if (machines.length !== 1 || machines[0].id !== service.machine) fail('MACHINE_CHANGED');
      const machine = machines[0];
      if (machine.state === 'started' && currentImage(machine, service) === expected) {
        verifyProductionMachine(machines, service);
        if (!isDeepStrictEqual(runtimeConfig(machine.config), runtimeConfig(snapshots.get(service.key).config)))
          fail('RUNTIME_CHANGED');
        return;
      }
      if (attempt + 1 === imageAttempts || Date.now() >= deadline) break;
      await sleep(2000);
    }
    fail('IMAGE_NOT_READY');
  };
  try {
    save();
    const verified = await verify();
    if (!isDeepStrictEqual(plan, verified)) fail('APPROVAL_CHANGED');
    Object.assign(state, verified, { status: 'preparing' });
    for (const service of productionServices) {
      phase(`capture-${service.key}`);
      const machine = verifyProductionMachine(await list(service), service);
      snapshots.set(service.key, machine);
      state.services[service.key] = { previous: currentImage(machine, service), target: null };
    }
    phase('baseline-health');
    await smoke();
    // No Machine changes until all source checks and image retention succeed.
    for (const service of productionServices) {
      const source = plan.images[service.key]; const digest = imageDigest(source, service.staging);
      phase(`pull-source-${service.key}`);
      await run(service, 'staging', 'flyctl', ['auth', 'docker']);
      await run(service, 'staging', 'docker', ['pull', source]);
      phase(`inspect-source-${service.key}`);
      const info = JSON.parse(await run(service, 'staging', 'docker', ['image', 'inspect', source]))[0];
      if (info?.Config?.Labels?.['org.opencontainers.image.revision'] !== plan.sha
        || info.Config.Labels['org.opencontainers.image.version'] !== plan.version
        || (service.key === 'api' && !isDeepStrictEqual(info.Config.Cmd, ['node', 'src/server.mjs'])))
        fail('IMAGE_LABELS_INVALID');
      phase(`copy-image-${service.key}`);
      await fly(service, ['auth', 'docker']);
      const tag = `registry.fly.io/${service.app}:${releaseId}`;
      await run(service, 'production', 'docker', ['tag', source, tag]);
      await run(service, 'production', 'docker', ['push', tag]);
      const refs = JSON.parse(await run(service, 'production', 'docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag]));
      const target = imageFor(service.app, digest);
      if (!refs.includes(target)) fail('DIGEST_CHANGED');
      state.services[service.key].target = target;
      phase(`retain-image-${service.key}`);
      const previous = state.services[service.key].previous;
      await run(service, 'production', 'docker', ['pull', previous]);
      const retained = `registry.fly.io/${service.app}:rollback`;
      await run(service, 'production', 'docker', ['tag', previous, retained]);
      await run(service, 'production', 'docker', ['push', retained]);
    }
    state.status = 'prepared';
    phase('revalidate-release');
    if (!isDeepStrictEqual(plan, await verify())) fail('CANDIDATE_CHANGED');
    for (const service of productionServices) {
      phase(`check-current-${service.key}`);
      const current = verifyProductionMachine(await list(service), service);
      if (currentImage(current, service) !== state.services[service.key].previous
        || !isDeepStrictEqual(runtimeConfig(current.config), runtimeConfig(snapshots.get(service.key).config)))
        fail('PRODUCTION_CHANGED');
    }
    for (const service of productionServices) {
      phase(`update-${service.key}`);
      attempted.push(service); // A failed update may already change a Machine.
      await update(service, state.services[service.key].target);
      phase(`verify-${service.key}`);
      await wait(service, state.services[service.key].target);
    }
    phase('probe');
    await smoke();
    state.status = 'healthy'; save();
    return state;
  } catch (error) {
    state.failedPhase = state.phase;
    state.error = safeDeploymentError(error);
    if (!attempted.length) {
      state.status = 'failed_preflight';
      try { record(state); } catch { /* Never disclose the failed write's details. */ }
      throw deploymentFailure(state.error.errorCode, state.error);
    }
    state.rollbackErrors = [];
    const recoveryPhase = value => {
      state.phase = value;
      try { record(state); } catch { /* A full artifact disk must not block recovery. */ }
    };
    let restored = true;
    for (const service of attempted.reverse()) {
      recoveryPhase(`restore-${service.key}`);
      try {
        await update(service, state.services[service.key].previous);
        await wait(service, state.services[service.key].previous);
      } catch (failure) {
        restored = false;
        state.rollbackErrors.push({ phase: state.phase, ...safeDeploymentError(failure) });
      }
    }
    for (const service of productionServices) {
      recoveryPhase(`check-restore-${service.key}`);
      try { await wait(service, state.services[service.key].previous); }
      catch (failure) {
        restored = false;
        state.rollbackErrors.push({ phase: state.phase, ...safeDeploymentError(failure) });
      }
    }
    if (restored) {
      recoveryPhase('check-restore-health');
      try { await smoke(); }
      catch (failure) {
        restored = false;
        state.rollbackErrors.push({ phase: state.phase, ...safeDeploymentError(failure) });
      }
    }
    state.status = restored ? 'rolled_back' : 'rollback_failed';
    try { record(state); } catch { /* The recovery result still fails the job. */ }
    throw deploymentFailure(restored ? 'RELEASE_ROLLED_BACK' : 'ROLLBACK_FAILED', { causeCode: state.error.errorCode });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let directory;
  let activePhase = 'initialize';
  try {
    if (process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main'
      || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') fail('MANUAL_MAIN_REQUIRED');
    directory = mkdtempSync(join(tmpdir(), 'production-release-'));
    const get = path => githubMetadata(path, { token: process.env.GH_TOKEN });
    const verify = () => verifyRelease({ runId: process.env.STAGING_RUN_ID, get, download: async (runId, name) => {
      const target = mkdtempSync(join(directory, 'record-'));
      await deploymentCommand('gh', ['run', 'download', String(runId), '--repo', repository, '--name', name, '--dir', target], { GH_TOKEN: process.env.GH_TOKEN });
      const contents = readFileSync(join(target, 'staging-release.json'), 'utf8');
      if (Buffer.byteLength(contents) > 16_384) fail('RECORD_TOO_LARGE');
      return JSON.parse(contents);
    } });
    if (process.argv[2] === 'plan') {
      activePhase = 'validate-release';
      const plan = await verify();
      activePhase = 'write-plan';
      writeFileSync(process.env.PRODUCTION_PLAN_PATH, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
      activePhase = 'write-summary';
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production approval candidate\n\n` +
        `Staging run: https://github.com/${repository}/actions/runs/${plan.stagingRun}\n\nCommit: \`${plan.sha}\`\n\n` +
        productionServices.map(service => `- ${service.key}: \`${plan.images[service.key]}\``).join('\n') +
        '\n\nApproval deploys these exact images with existing production settings. No production changes have occurred.\n');
      console.log('Tested staging release validated; production approval required.');
    } else if (process.argv[2] === 'release') {
      const plan = JSON.parse(readFileSync(process.env.PRODUCTION_PLAN_PATH, 'utf8'));
      const credentials = {
        api: { staging: process.env.FLY_PROMOTE_STAGING_API_TOKEN, production: process.env.FLY_PRODUCTION_API_TOKEN },
        web: { staging: process.env.FLY_PROMOTE_STAGING_WEB_TOKEN, production: process.env.FLY_PRODUCTION_WEB_TOKEN },
      };
      if (productionServices.some(service => !credentials[service.key].staging || !credentials[service.key].production))
        fail('CREDENTIALS_UNAVAILABLE');
      const state = await promoteProduction({ plan, verify, releaseId: process.env.RELEASE_ID,
        run: (service, scope, binary, args) => deploymentCommand(binary, args, binary === 'flyctl' ? { FLY_API_TOKEN: credentials[service.key][scope] } : {}),
        record: value => {
          activePhase = value.failedPhase || value.phase;
          writeFileSync(process.env.DEPLOY_RECORD_PATH, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
        },
      });
      activePhase = 'write-summary';
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production ${state.status}\n\nCommit: \`${state.sha}\`\n\n` +
        productionServices.map(service => `- ${service.key}: \`${state.services[service.key].target}\`; previous: \`${state.services[service.key].previous}\``).join('\n') + '\n');
      console.log('Production image promotion and read-only health checks passed.');
    } else fail('UNKNOWN_COMMAND');
  } catch (error) {
    const info = safeDeploymentError(error);
    // Only fixed phase labels, allowlisted explanations, and numeric status codes.
    console.error(`::error title=Production deployment failed::Phase ${activePhase}; code ${info.errorCode}. ${info.message}`);
    if (info.exitCode) console.error(`Command exit code: ${info.exitCode}.`);
    if (info.httpStatus) console.error(`GitHub HTTP status: ${info.httpStatus}.`);
    if (info.causeCode) console.error(`Original failure code: ${info.causeCode}.`);
    if (info.command) console.error(`Command type: ${info.command}.`);
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production failed\n\nPhase: \`${activePhase}\`\n\n` +
        `Code: \`${info.errorCode}\`\n\n${info.message}\n` +
        (info.exitCode ? `\nCommand exit code: ${info.exitCode}.\n` : '') +
        (info.httpStatus ? `\nGitHub HTTP status: ${info.httpStatus}.\n` : '') +
        (info.causeCode ? `\nOriginal failure code: \`${info.causeCode}\`.\n` : '') +
        (info.command ? `\nCommand type: \`${info.command}\`.\n` : ''));
    } catch { /* Reporting failures must not expose filesystem or process errors. */ }
    process.exitCode = 1;
  } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
}
