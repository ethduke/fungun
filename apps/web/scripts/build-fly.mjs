import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function webBuildEnvironment(inherited = {}) {
  const env = { NODE_ENV: 'production', FUNGUN_WEB_TARGET: 'fly' };
  for (const name of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TZ',
  ])
    if (Object.hasOwn(inherited, name) && typeof inherited[name] === 'string')
      env[name] = inherited[name];
  return env;
}

export function assertNoBuildEnvFiles(entries) {
  if (
    entries.some(
      (name) => /^\.env(?:\.|$)/.test(name) && name !== '.env.example',
    )
  )
    throw new Error(
      'Local web environment files must not be included in production builds.',
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    assertNoBuildEnvFiles(readdirSync(root));
    const child = spawn(
      process.execPath,
      ['node_modules/vinext/dist/cli.js', 'build'],
      {
        cwd: root,
        env: webBuildEnvironment(process.env),
        stdio: 'inherit',
      },
    );
    child.once('error', () => {
      console.error('Production web build could not start.');
      process.exitCode = 1;
    });
    child.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => child.kill(signal));
  } catch {
    console.error(
      'Production web build refused. Keep local environment files outside apps/web.',
    );
    process.exitCode = 1;
  }
}
