import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';

const execute = promisify(execFile);
const commands = new Set(['fly-auth-docker', 'fly-machine-list', 'fly-machine-update',
  'docker-pull', 'docker-tag', 'docker-push', 'docker-inspect', 'github-download', 'command']);
const messages = Object.freeze({
  INVALID_IMAGE: 'Invalid immutable release image.',
  UNTRUSTED_STAGING_RUN: 'Select a successful staging deployment from protected main.',
  INVALID_STAGING_ARTIFACT: 'Staging release record is missing, expired, or untrusted.',
  UNHEALTHY_STAGING_RELEASE: 'Staging record does not describe a healthy deployment.',
  INVALID_RUN_ID: 'Invalid staging run ID.',
  MISSING_STAGING_ARTIFACT: 'Expected one retained staging release record.',
  COMMIT_NOT_ON_MAIN: 'Staging commit is not on main.',
  CHECKS_INCOMPLETE: 'Cannot completely verify required checks.',
  CHECKS_NOT_PASSED: 'Required checks for the staging commit must pass.',
  CURRENT_IMAGE_UNKNOWN: 'Cannot identify the current production image.',
  MACHINE_NOT_READY: 'Production must have its one approved, running Machine.',
  RUNTIME_INVALID: 'Unexpected production runtime or process override.',
  WEB_CONFIG_INVALID: 'Unexpected production web configuration.',
  STORAGE_INVALID: 'Production API storage or Machine identity changed.',
  INVALID_RELEASE_ID: 'Invalid production release ID.',
  APPROVAL_CHANGED: 'Staging release changed after approval; start a new run.',
  MACHINE_CHANGED: 'Production Machine identity changed.',
  RUNTIME_CHANGED: 'Production runtime settings changed during image promotion.',
  IMAGE_NOT_READY: 'Production Machine did not start with the expected image.',
  IMAGE_LABELS_INVALID: 'Staging image labels or production entry point do not match.',
  DIGEST_CHANGED: 'Image digest changed during promotion.',
  CANDIDATE_CHANGED: 'Staging release changed before promotion.',
  PRODUCTION_CHANGED: 'Production changed while this release was being prepared.',
  RELEASE_ROLLED_BACK: 'Production release failed; previous images restored.',
  ROLLBACK_FAILED: 'Production release and rollback verification failed.',
  RECORD_WRITE_FAILED: 'Cannot save the release record.',
  MANUAL_MAIN_REQUIRED: 'Manual protected-main workflow required.',
  RECORD_TOO_LARGE: 'Staging release record is oversized.',
  CREDENTIALS_UNAVAILABLE: 'Production promotion credentials unavailable.',
  UNKNOWN_COMMAND: 'Unknown production command.',
  COMMAND_FAILED: 'Deployment command failed.',
  COMMAND_TIMEOUT: 'Deployment command exceeded its deadline.',
  FLY_IMAGE_REFERENCE_INVALID: 'Fly rejected the image reference; verify the CLI version and digest formatting.',
  GITHUB_NETWORK_ERROR: 'GitHub read request failed after bounded retries.',
  GITHUB_TIMEOUT: 'GitHub read request exceeded its deadline.',
  GITHUB_HTTP_ERROR: 'GitHub rejected the read request.',
  GITHUB_RESPONSE_INVALID: 'GitHub returned an invalid metadata response.',
  UNEXPECTED_FAILURE: 'Unexpected deployment failure; raw details withheld.',
});

class DeploymentError extends Error {
  constructor(code, details = {}) {
    super(messages[code]);
    this.code = code;
    this.details = {};
    if (Number.isInteger(details.exitCode) && details.exitCode > 0 && details.exitCode <= 255)
      this.details.exitCode = details.exitCode;
    if (Number.isInteger(details.httpStatus) && details.httpStatus >= 400 && details.httpStatus <= 599)
      this.details.httpStatus = details.httpStatus;
    if (Object.hasOwn(messages, details.causeCode)) this.details.causeCode = details.causeCode;
    if (commands.has(details.command)) this.details.command = details.command;
  }
}

export function deploymentFailure(code, details) {
  if (!Object.hasOwn(messages, code)) return new DeploymentError('UNEXPECTED_FAILURE');
  return new DeploymentError(code, details);
}

// Never serialize a provider/CLI Error, message, cause, stack, stderr, headers,
// URLs, arguments or environment. Even an Error with a forged code is untrusted.
export function safeDeploymentError(error) {
  if (!(error instanceof DeploymentError) || !Object.hasOwn(messages, error.code))
    return { errorCode: 'UNEXPECTED_FAILURE', message: messages.UNEXPECTED_FAILURE };
  const result = { errorCode: error.code, message: messages[error.code] };
  if (Number.isInteger(error.details.exitCode) && error.details.exitCode > 0 && error.details.exitCode <= 255)
    result.exitCode = error.details.exitCode;
  if (Number.isInteger(error.details.httpStatus) && error.details.httpStatus >= 400 && error.details.httpStatus <= 599)
    result.httpStatus = error.details.httpStatus;
  if (Object.hasOwn(messages, error.details.causeCode)) result.causeCode = error.details.causeCode;
  if (commands.has(error.details.command)) result.command = error.details.command;
  return result;
}

export async function deploymentCommand(binary, args, extra = {}, { executor = execute, timeoutMs } = {}) {
  const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_CONFIG', 'XDG_CONFIG_HOME']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  try {
    // Asynchronous execution lets fetch process idle socket closures while
    // Docker/Fly run. Blocking this event loop can break the next GitHub read.
    const { stdout } = await executor(binary, args, { env: { ...env, ...extra }, encoding: 'utf8',
      timeout: timeoutMs ?? (binary === 'docker' || args.includes('update') ? 180_000 : 30_000),
      maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    let command = 'command';
    if (binary === 'flyctl' && args[0] === 'auth' && args[1] === 'docker') command = 'fly-auth-docker';
    if (binary === 'flyctl' && args[0] === 'machine' && args[1] === 'list') command = 'fly-machine-list';
    if (binary === 'flyctl' && args[0] === 'machine' && args[1] === 'update') command = 'fly-machine-update';
    if (binary === 'docker' && ['pull', 'tag', 'push'].includes(args[0])) command = `docker-${args[0]}`;
    if (binary === 'docker' && args[0] === 'image' && args[1] === 'inspect') command = 'docker-inspect';
    if (binary === 'gh' && args[0] === 'run' && args[1] === 'download') command = 'github-download';
    const invalidImage = command === 'fly-machine-update' && typeof error?.stderr === 'string'
      && error.stderr.includes('config.image: invalid image identifier');
    throw deploymentFailure(error?.killed || error?.code === 'ETIMEDOUT' ? 'COMMAND_TIMEOUT'
      : invalidImage ? 'FLY_IMAGE_REFERENCE_INVALID' : 'COMMAND_FAILED',
      { exitCode: error?.code, command });
  }
}

export async function githubMetadata(path, { token, request = fetch, sleep = pause, attempts = 3 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      const headers = new Headers({ accept: 'application/vnd.github+json' });
      headers.set('authorization', `Bearer ${token}`);
      response = await request(`https://api.github.com/repos/ethduke/fungun/${path}`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt + 1 === attempts) throw deploymentFailure(
        ['TimeoutError', 'AbortError'].includes(error?.name) ? 'GITHUB_TIMEOUT' : 'GITHUB_NETWORK_ERROR');
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw deploymentFailure('GITHUB_HTTP_ERROR', { httpStatus: response.status });
    }
    try { return await response.json(); }
    catch { throw deploymentFailure('GITHUB_RESPONSE_INVALID'); }
  }
  throw deploymentFailure('GITHUB_NETWORK_ERROR');
}
