import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { deploymentCommand, deploymentFailure, safeDeploymentError, githubMetadata } from './deployment-runtime.mjs';

test('CLI work does not block socket cleanup before the next GitHub metadata read', async () => {
  // Separate process closes a reusable connection while the command runs. With
  // the former execFileSync implementation, the next fetch fails UND_ERR_SOCKET.
  const server = spawn(process.execPath, ['-e', `
    const server = require('node:http').createServer((request, response) => {
      response.setHeader('Keep-Alive', 'timeout=60');
      response.end('{"ok":true}');
      setTimeout(() => request.socket.destroy(), 200);
    });
    server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const [port] = await once(server.stdout, 'data', { signal: AbortSignal.timeout(5000) });
    const url = `http://127.0.0.1:${Number(port)}`;
    assert.deepEqual(await (await fetch(url)).json(), { ok: true });
    await pause(30); // Let fetch return this connection to its idle pool.
    await deploymentCommand(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500)']);
    assert.deepEqual(await (await fetch(url)).json(), { ok: true });
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
  }
});

test('command failures retain numeric exit status but never stdout, stderr, arguments or environment', async () => {
  const details = 'private provider diagnostic';
  const executor = async (_binary, _args, options) => {
    assert.equal(options.env.GH_TOKEN, undefined);
    assert.equal(options.env.FLY_API_TOKEN, 'EXAMPLE');
    throw Object.assign(new Error(details), { code: 7, stdout: details, stderr: details });
  };
  await assert.rejects(deploymentCommand('flyctl', ['machine', 'list'], { FLY_API_TOKEN: 'EXAMPLE' }, { executor }), error => {
    const safe = safeDeploymentError(error);
    assert.deepEqual(safe, { errorCode: 'COMMAND_FAILED', message: 'Deployment command failed.', exitCode: 7, command: 'fly-machine-list' });
    assert.ok(!JSON.stringify(error).includes(details));
    return true;
  });
});

test('timed-out commands produce a fixed timeout code without child process output', async () => {
  await assert.rejects(deploymentCommand(process.execPath,
    ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000)'], {}, { timeoutMs: 50 }), error => {
    assert.equal(safeDeploymentError(error).errorCode, 'COMMAND_TIMEOUT');
    return true;
  });
});

test('Fly image-reference rejection is recognized without logging raw API error output', async () => {
  const privateText = 'private diagnostic must stay hidden';
  await assert.rejects(deploymentCommand('flyctl', ['machine', 'update'], {}, {
    executor: async () => { throw Object.assign(new Error(privateText), { code: 1,
      stderr: `config.image: invalid image identifier ${privateText}` }); },
  }), error => {
    const safe = safeDeploymentError(error);
    assert.equal(safe.errorCode, 'FLY_IMAGE_REFERENCE_INVALID');
    assert.equal(safe.command, 'fly-machine-update');
    assert.equal(safe.exitCode, 1);
    assert.equal(JSON.stringify(error).includes(privateText), false);
    return true;
  });
});

test('forged errors and arbitrary diagnostic properties cannot bypass redaction', () => {
  const raw = Object.assign(new Error('private diagnostic'), { code: 'COMMAND_FAILED', details: { exitCode: 2 } });
  assert.deepEqual(safeDeploymentError(raw), { errorCode: 'UNEXPECTED_FAILURE', message: 'Unexpected deployment failure; raw details withheld.' });
  const safe = safeDeploymentError(deploymentFailure('GITHUB_HTTP_ERROR', { httpStatus: 403, exitCode: 'private', arbitrary: 'private' }));
  assert.deepEqual(safe, { errorCode: 'GITHUB_HTTP_ERROR', message: 'GitHub rejected the read request.', httpStatus: 403 });
});

test('the CLI emits an actionable annotation and summary without printing credential values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'production-report-test-'));
  const summary = join(directory, 'summary.md');
  const privateText = 'private fixture credential value';
  try {
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./fly-production.mjs', import.meta.url)), 'plan'], {
      env: { GITHUB_REPOSITORY: 'ethduke/fungun', GITHUB_REF: 'refs/heads/untrusted',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: summary, GH_TOKEN: privateText },
      encoding: 'utf8',
    }), error => {
      assert.match(error.stderr, /::error title=Production deployment failed::Phase initialize; code MANUAL_MAIN_REQUIRED/);
      assert.equal(error.stderr.includes(privateText), false);
      assert.match(readFileSync(summary, 'utf8'), /MANUAL_MAIN_REQUIRED/);
      assert.equal(readFileSync(summary, 'utf8').includes(privateText), false);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('read-only metadata retries a closed socket and transient HTTP errors with bounded backoff', async () => {
  let calls = 0; const delays = [];
  const result = await githubMetadata('actions/runs/123', { sleep: async ms => delays.push(ms), request: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    calls++;
    if (calls === 1) throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } });
    if (calls === 2) return new Response('private diagnostic', { status: 503 });
    return Response.json({ ok: true });
  } });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
});

test('metadata failures stop after three attempts and never expose server/transport details', async () => {
  let calls = 0;
  await assert.rejects(githubMetadata('actions/runs/123', { sleep: async () => {}, request: async () => {
    calls++; throw new Error('private endpoint and credentials');
  } }), error => {
    assert.equal(safeDeploymentError(error).errorCode, 'GITHUB_NETWORK_ERROR');
    assert.ok(!JSON.stringify(safeDeploymentError(error)).includes('credentials'));
    return true;
  });
  assert.equal(calls, 3);
});

test('GitHub request deadlines have a fixed diagnostic code', async () => {
  await assert.rejects(githubMetadata('actions/runs/123', { attempts: 1, request: async () => {
    throw Object.assign(new Error('private timeout details'), { name: 'TimeoutError' });
  } }), error => {
    assert.equal(safeDeploymentError(error).errorCode, 'GITHUB_TIMEOUT');
    return true;
  });
});

test('authorization failures, invalid JSON and semantic check failures are never retried into success', async () => {
  for (const response of [() => new Response('private diagnostic', { status: 403 }), () => new Response('invalid metadata')]) {
    let calls = 0;
    await assert.rejects(githubMetadata('actions/runs/123', { request: async () => { calls++; return response(); } }));
    assert.equal(calls, 1);
  }
  assert.deepEqual(await githubMetadata('actions/runs/123', {
    request: async () => Response.json({ conclusion: 'failure' }),
  }), { conclusion: 'failure' });
});
