import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { smokeStaging } from './smoke-staging.mjs';

const repository = 'ethduke/fungun';
export const services = Object.freeze([
  { key: 'api', app: 'farmgun-staging-api', config: 'fly.staging.api.toml' },
  { key: 'web', app: 'farmgun-staging-web', config: 'fly.staging.web.toml' },
]);
const required = ['webview', 'production-build', 'repository-safety'];

export async function stagingGate({ sha, action = 'deploy', token, request = fetch, sleep = pause, attempts = 15 }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !['deploy', 'rollback'].includes(action))
    throw new Error('Invalid staging release request.');
  const get = async path => {
    const headers = new Headers({ accept: 'application/vnd.github+json' });
    headers.set('authorization', `Bearer ${token}`);
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      headers,
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Cannot verify the main deployment gate.');
    return response.json();
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await get('git/ref/heads/main')).object.sha !== sha) return false;
    if (action === 'rollback') return true;
    const { check_runs: checks } = await get(`commits/${sha}/check-runs?per_page=100`);
    const latest = required.map(name => checks.filter(check =>
      check.name === name && check.app?.id === 15368 && check.head_sha === sha,
    ).sort((a, b) => b.id - a.id)[0]);
    if (latest.every(check => check?.status === 'completed' && check.conclusion === 'success')) return true;
    if (latest.some(check => check?.status === 'completed' && check.conclusion !== 'success'))
      throw new Error('Required main checks did not pass.');
    if (attempt < attempts - 1) await sleep(4000);
  }
  throw new Error('Required main checks did not finish.');
}

function deployedImage(machines, service) {
  if (machines.length > 1) throw new Error('Staging must have at most one Machine per app.');
  if (!machines.length) return null;
  const ref = machines[0].image_ref;
  if (ref?.registry !== 'registry.fly.io' || ref.repository !== service.app
    || !/^sha256:[a-f0-9]{64}$/.test(ref.digest ?? ''))
    throw new Error('Cannot identify the previous staging image.');
  return `registry.fly.io/${service.app}@${ref.digest}`;
}

function pushedImage(output, service) {
  const prefix = `registry.fly.io/${service.app}@sha256:`;
  const image = JSON.parse(output).find(value => value.startsWith(prefix) && /^[a-f0-9]{64}$/.test(value.slice(prefix.length)));
  if (!image) throw new Error('Cannot identify a pushed staging image digest.');
  return image;
}

// All side effects are injected so rollback, partial failures and registry
// retention can be tested without a Fly account, network, or blockchain wallet.
export async function releaseStaging({ sha, version, action = 'deploy', run, smoke = smokeStaging, record = () => {}, gate = async () => true }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !/^sha-[a-f0-9]{40}-[0-9]+-[0-9]+$/.test(version ?? '')
    || !['deploy', 'rollback'].includes(action)) throw new Error('Invalid staging release request.');
  const state = { sha, version, action, status: 'prepared', services: {} };
  const attempted = [];
  const fly = (service, args) => run(service, 'flyctl', args);
  const machines = async service => JSON.parse(await fly(service, ['machine', 'list', '--app', service.app, '--json']));
  const inspect = async (service, image) => pushedImage(await run(service, 'docker', [
    'image', 'inspect', '--format', '{{json .RepoDigests}}', image,
  ]), service);
  const deploy = (service, image) => fly(service, ['deploy', '--app', service.app, '--config', service.config,
    '--image', image, '--strategy', 'immediate', '--ha=false', '--yes', '--wait-timeout', '120s']);

  // Capture both services before changing either one. No provider or signing
  // secrets are permitted even if someone manually changed a staging app.
  for (const service of services) {
    if (JSON.parse(await fly(service, ['secrets', 'list', '--app', service.app, '--json'])).length)
      throw new Error('Staging apps must not contain secrets.');
    const previous = deployedImage(await machines(service), service);
    state.services[service.key] = { previous, target: null };
  }
  if (action === 'deploy' && services.every(service => state.services[service.key].previous)) await smoke();

  for (const service of services) {
    await fly(service, ['auth', 'docker']);
    const entry = state.services[service.key];
    const targetTag = `registry.fly.io/${service.app}:${action === 'rollback' ? 'rollback' : version}`;
    if (action === 'rollback') {
      await run(service, 'docker', ['pull', targetTag]);
      entry.targetVersion = (await run(service, 'docker', ['image', 'inspect', '--format',
        '{{index .Config.Labels "org.opencontainers.image.version"}}', targetTag])).trim();
    } else {
      await run(service, 'docker', ['tag', `fungun-staging-${service.key}:${sha}`, targetTag]);
      await run(service, 'docker', ['push', targetTag]);
    }
    entry.target = await inspect(service, targetTag);
  }
  if (action === 'rollback' && (!/^sha-[a-f0-9]{40}-[0-9]+-[0-9]+$/.test(state.services.api.targetVersion)
    || state.services.api.targetVersion !== state.services.web.targetVersion))
    throw new Error('Retained staging images are not from the same release.');
  record(state);
  // Recheck after image preparation so a queued, superseded commit cannot ship.
  if (!await gate()) { state.status = 'superseded'; record(state); return state; }
  if (action === 'deploy') for (const service of services) {
    const previous = state.services[service.key].previous;
    if (previous) {
      await fly(service, ['auth', 'docker']);
      await run(service, 'docker', ['pull', previous]);
      const retained = `registry.fly.io/${service.app}:rollback`;
      await run(service, 'docker', ['tag', previous, retained]);
      await run(service, 'docker', ['push', retained]);
    }
  }
  try {
    for (const service of services) {
      attempted.push(service);
      await deploy(service, state.services[service.key].target);
      if (deployedImage(await machines(service), service) !== state.services[service.key].target)
        throw new Error('Deployed staging image does not match the release.');
    }
    await smoke();
    state.status = 'healthy';
    record(state);
    return state;
  } catch {
    let restored = true;
    for (const service of attempted.reverse()) {
      try {
        const previous = state.services[service.key].previous;
        if (previous) {
          await deploy(service, previous);
          if (deployedImage(await machines(service), service) !== previous) throw new Error();
        } else {
          // A first release has no rollback image. Remove only its new staging
          // Machine so autostart cannot keep serving an unhealthy first image.
          await fly(service, ['scale', 'count', '0', '--app', service.app, '--yes']);
        }
      } catch { restored = false; }
    }
    if (restored && services.every(service => state.services[service.key].previous)) {
      try { await smoke(); } catch { restored = false; }
    }
    state.status = restored ? 'rolled_back' : 'rollback_failed';
    record(state);
    throw new Error(restored ? 'Staging release failed; previous images restored (new first-release Machines removed).' :
      'Staging release and rollback verification failed; inspect staging Machines.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = process.env.DEPLOY_SHA;
    const action = process.env.STAGING_ACTION || 'deploy';
    const gate = () => stagingGate({ sha, action, token: process.env.GH_TOKEN });
    if (process.argv[2] === 'gate') {
      const ready = await gate();
      appendFileSync(process.env.GITHUB_OUTPUT, `ready=${ready}\n`);
      console.log(ready ? 'Main deployment gate passed.' : 'Superseded main commit; staging skipped.');
    } else if (process.argv[2] === 'release') {
      const tokens = { api: process.env.FLY_STAGING_API_TOKEN, web: process.env.FLY_STAGING_WEB_TOKEN };
      if (services.some(service => !tokens[service.key])) throw new Error('Staging deploy credentials unavailable.');
      const run = (service, binary, args) => {
        const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
        if (binary === 'flyctl') env.FLY_API_TOKEN = tokens[service.key];
        try { return execFileSync(binary, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024, timeout: 300_000 }); }
        catch { throw new Error(`Staging ${service.key} command failed.`); }
      };
      const state = await releaseStaging({ sha, action, version: process.env.RELEASE_VERSION, run, gate,
        record: value => writeFileSync(process.env.DEPLOY_RECORD_PATH, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }),
      });
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Staging ${state.status}\n\nCommit: \`${sha}\`\n\n` +
        services.map(service => `- ${service.key}: \`${state.services[service.key].target}\`; previous: \`${state.services[service.key].previous || 'first release'}\``).join('\n') + '\n');
      console.log(`Staging ${state.status}.`);
    } else throw new Error('Unknown staging command.');
  } catch {
    // CLI/provider output, environment values and request bodies are never logged.
    console.error('Staging operation failed; inspect the release record and Fly dashboard.');
    process.exitCode = 1;
  }
}
