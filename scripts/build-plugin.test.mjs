import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));

test('Vinext CommonJS tooling discovers dynamic requires with the patched glob API', async () => {
  const commonjsPath = webRequire.resolve('vite-plugin-commonjs');
  const pluginRequire = createRequire(commonjsPath);
  const entry = pluginRequire.resolve('vite-plugin-dynamic-import');
  assert.match(entry, /vendor\/vite-plugin-dynamic-import\/lib\/index.js$/);
  assert.equal(typeof pluginRequire('vite-plugin-dynamic-import').globFiles, 'function');
  const esm = await import(pathToFileURL(join(dirname(entry), 'index.mjs')));
  assert.equal(typeof esm.globFiles, 'function');

  const { resolveConfig } = await import(pathToFileURL(webRequire.resolve('vite')));
  const commonjs = webRequire('vite-plugin-commonjs').default;
  const root = await mkdtemp(join(tmpdir(), 'fungun-commonjs-'));
  try {
    for (const [file, value] of [
      ['views/alpha.js', 'alpha'], ['views/page.js', 'file'],
      ['views/page/index.js', 'index'], ['views/nested/deep.js', 'deep'],
      ['views/.hidden.js', 'hidden'],
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), `export const value = ${JSON.stringify(value)};`);
    }
    const plugin = commonjs();
    const config = await resolveConfig({ configFile: false, root }, 'build');
    plugin.configResolved(config);
    const transformed = await plugin.transform(
      'export function load(name) { return require(`./views/${name}`).value; }',
      join(root, 'main.js'),
    );
    assert.ok(transformed?.code);
    assert.ok(!transformed.code.includes('./views/.hidden.js'));
    const output = join(root, 'transformed.mjs');
    await writeFile(output, transformed.code);
    const { load } = await import(pathToFileURL(output));
    assert.equal(load('alpha'), 'alpha');
    assert.equal(load('page'), 'file');
    assert.equal(load('page/index'), 'index');
    assert.equal(load('nested/deep'), 'deep');
    assert.throws(() => load('missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
