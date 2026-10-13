import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeBlob, scanRepository } from './check-repository.mjs';

const scan = (path, text, size) => analyzeBlob(path, Buffer.from(text), size);
const hex = (length) => ['0', 'x', 'a'.repeat(length)].join('');
const credential = () => JSON.stringify({ [['api', 'key'].join('_')]: 'synthetic-'.repeat(4) });

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'repository-safety-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString('utf8');
  git('init', '--quiet');
  git('config', 'user.name', 'Synthetic Test');
  git('config', 'user.email', 'synthetic@example.invalid');
  const write = (path, content) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  return { cwd, git, write };
}

test('rejects binary sensitive files and generated artifacts', () => {
  for (const path of ['.env', '.env.production', 'secrets/blob.bin', 'wallet.json', 'signature.json', 'private-key.txt', 'credentials.bin', 'uploads/logo.png', 'test-results/result.json', 'archive.zip']) {
    assert.ok(scan(path, '\0\u0001').includes('forbidden-sensitive-or-generated-path'), path);
  }
});

test('rejects snapshot manifests and backup directories even when force-staged', () => {
  for (const path of ['backup.manifest.json', 'nested/backup.manifest.json', 'asset-backups/image.webp', 'asset-restores/data.json']) {
    assert.ok(scan(path, '{}').includes('forbidden-sensitive-or-generated-path'), path);
  }
});

test('enforces limits including binary blobs and the lockfile exception', () => {
  assert.ok(scan('asset.bin', '\0', 1024 * 1024 + 1).includes('file-size-limit'));
  assert.deepEqual(scan('package-lock.json', '{}', 3 * 1024 * 1024), []);
  assert.ok(scan('package-lock.json', '{}', 3 * 1024 * 1024 + 1).includes('file-size-limit'));
  assert.ok(scan('secrets/package-lock.json', '{}').includes('forbidden-sensitive-or-generated-path'));
});

test('rejects addresses, private-key hex and signatures including binary content', () => {
  for (const length of [40, 64, 128, 130]) {
    assert.ok(scan('fixture.json', `\0${hex(length)}`).includes('literal-evm-address-key-or-signature'));
  }
  assert.deepEqual(scan('rule.mjs', String.raw`/\b0x[a-f\d]{40}\b/i`), []);
});

test('rejects JSON, code and environment credential assignments', () => {
  assert.ok(scan('config.json', credential()).includes('non-placeholder-credential-assignment'));
  for (const key of ['XAI_API_KEY', 'privateKey', 'client_secret', 'authorization', 'seed_phrase', 'rpcUrl']) {
    const value = [key, ' = ', 'synthetic-'.repeat(5)].join('');
    assert.ok(scan('.env.example', JSON.stringify({ [key]: 'synthetic-'.repeat(5) })).includes('non-placeholder-credential-assignment'), key);
    if (key === key.toUpperCase()) assert.ok(scan('.env.example', value).includes('non-placeholder-credential-assignment'));
  }
});

test('rejects every supported provider credential name, including public prefixes', () => {
  const names = ['PINATA_JWT', 'FOMO_RELAY_TOKEN', 'TELEGRAM_BOT_TOKEN', 'OPENROUTER_KEY', 'X402_FACILITATOR_TOKEN'];
  for (const name of names) {
    for (const key of [name, `NEXT_PUBLIC_${name}`, `VITE_${name}`, name.toLowerCase().replaceAll('_', '')]) {
      const value = 'synthetic-'.repeat(4);
      for (const content of [JSON.stringify({ [key]: value }), `${key} = '${value}'`])
        assert.ok(scan('config.mjs', content).includes('non-placeholder-credential-assignment'), key);
      if (key === key.toUpperCase()) {
        assert.ok(scan('.env.example', `${key}=${value}`).includes('non-placeholder-credential-assignment'), key);
        for (const replacement of ['', '<set-at-runtime>', 'REDACTED', '${RUNTIME_CREDENTIAL}'])
          assert.deepEqual(scan('.env.example', `${key}=${replacement}\nFEATURE_ENABLED=1`), [], key);
      }
    }
  }
  assert.deepEqual(scan('config.mjs', names.map((name) => `const ${name.toLowerCase()} = process.env.${name};`).join('\n')), []);
  assert.deepEqual(scan('token.json', JSON.stringify({ token: 'public-token-identifier' })), []);
});

test('detects JWT and Telegram credentials even without a recognized assignment', () => {
  const jwt = [{ alg: 'HS256', typ: 'JWT' }, { sub: 'synthetic-audit' }, 'synthetic-signature']
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const bot = ['123456789', 'synthetic'.repeat(5)].join(':');
  for (const [value, rule] of [[jwt, 'jwt-credential-token'], [bot, 'telegram-bot-token']]) {
    for (const content of [value, `\0${value}\0`, JSON.stringify({ unrelated: value })])
      assert.ok(scan('capture.txt', content).includes(rule), rule);
  }
  assert.ok(scan('config.txt', `https://api.telegram.org/bot${bot}/sendMessage`).includes('telegram-bot-token'));
});

test('detects HTTP and WebSocket URL credentials, including encoded query names', () => {
  for (const scheme of ['http', 'https', 'ws', 'wss']) {
    for (const name of ['key', 'api_key', 'api-key', 'token', 'access_token', 'jwt', 'password', '%6bey']) {
      const url = `${scheme}://example.invalid/ws?chain=test&${name}=synthetic-value`;
      assert.ok(scan('request.txt', url).includes('credential-bearing-url'), `${scheme}:${name}`);
    }
    assert.ok(scan('request.txt', `${scheme}://synthetic:credential@example.invalid`).includes('credential-bearing-url'));
    for (const replacement of ['', 'REDACTED', 'YOUR_KEY', '<set-at-runtime>', '${runtime.key}', '%3Cset-at-runtime%3E'])
      assert.deepEqual(scan('request.txt', `${scheme}://example.invalid/?key=${replacement}`), []);
  }
  const htmlUrl = ['https://example.invalid/?chain=test&amp;key=', 'synthetic-value'].join('');
  assert.ok(scan('request.txt', htmlUrl).includes('credential-bearing-url'));
  assert.deepEqual(scan('request.txt', 'wss://example.invalid/ws?chain=test'), []);
  for (const host of ['mainnet.infura.io', 'eth-mainnet.g.alchemy.com'])
    assert.ok(scan('request.txt', `https://${host}/v3/${'synthetic'.repeat(3)}`).includes('credential-bearing-url'));
});

test('historical URL fixture exceptions cannot hide changed or adjacent credentials', () => {
  const fixtures = [
    ['apps/api/src/token-image.test.mjs', ['https://ipfs.io', '@localhost/'].join('')],
    ['apps/api/src/config.test.mjs', ['http://user', '@127.0.0.1:3011'].join('')],
    ['apps/api/src/fomo-collector.test.mjs', ['wss://example.invalid?key=', 'synthetic-private-key'].join('')],
    ['apps/api/src/x402-payments.test.mjs', ['https://secret', '@payments.example'].join('')],
    ['apps/api/src/x402-payments.test.mjs', ['https://payments.example?key=', 'secret'].join('')],
  ];
  for (const [path, url] of fixtures) {
    assert.deepEqual(scan(path, url), []);
    assert.ok(scan('request.txt', url).includes('credential-bearing-url'));
    assert.ok(scan(path, url.replace(/user|synthetic|secret|ipfs\.io/, 'changed')).includes('credential-bearing-url'));
    assert.ok(scan(path, `${url}\n${credential()}`).includes('non-placeholder-credential-assignment'));
  }
  const legacy = JSON.stringify({ FOMO_RELAY_TOKEN: ['synthetic', 'private', 'token'].join('-') });
  assert.deepEqual(scan('apps/api/src/fomo-api.test.mjs', legacy), []);
  assert.ok(scan('config.json', legacy).includes('non-placeholder-credential-assignment'));
});

test('permits empty and unmistakable placeholders, environment lookups and regex source', () => {
  for (const value of ['', '<set-at-runtime>', 'YOUR_KEY', 'REPLACE_ME', '${XAI_API_KEY}', 'REDACTED']) {
    assert.deepEqual(scan('.env.example', JSON.stringify({ [['api', 'key'].join('_')]: value })), []);
  }
  assert.deepEqual(scan('config.mjs', 'const key = process.env.XAI_API_KEY;'), []);
  assert.deepEqual(scan('.env.example', ['XAI_API_KEY', '='].join('')), []);
});

test('permits exact transport placeholders only in tests and matching fields', () => {
  const cases = [
    ['rpcUrl', 'https://rpc.example.invalid'],
    ['baseRpcUrl', 'https://base-rpc.example.invalid'],
    ['authorization', ['Bearer', 'EXAMPLE'].join(' ')],
  ];
  for (const [key, value] of cases) {
    const body = JSON.stringify({ [key]: value });
    for (const path of ['rpc.test.mjs', 'proxy.test.ts']) assert.deepEqual(scan(path, body), []);
    assert.ok(scan('config.json', body).includes('non-placeholder-credential-assignment'));
    assert.ok(scan('rpc.test.mjs', JSON.stringify({ [['api', 'key'].join('_')]: value })).includes('non-placeholder-credential-assignment'));
    for (const suffix of ['/credential', '?value=synthetic', '#synthetic', ':443', '.attacker.invalid']) {
      assert.ok(scan('rpc.test.mjs', JSON.stringify({ [key]: value + suffix })).includes('non-placeholder-credential-assignment'));
    }
  }
  for (const value of ['https://synthetic.example.invalid', 'https://rpc.example.com', ['https://user:', 'synthetic@rpc.example.invalid'].join('')]) {
    assert.ok(scan('rpc.test.mjs', JSON.stringify({ [['rpc', 'Url'].join('')]: value })).includes('non-placeholder-credential-assignment'));
  }
  assert.ok(scan('proxy.test.ts', JSON.stringify({ [['author', 'ization'].join('')]: ['Bearer', 'synthetic-value'].join(' ') })).includes('non-placeholder-credential-assignment'));
});

test('blank environment values never consume the following line', () => {
  const lines = ['XAI_API_KEY', 'O1_API_KEY', 'RPC_HTTP_URL'].map((key) => `${key}=`);
  for (const newline of ['\n', '\r\n']) assert.deepEqual(scan('.env.example', lines.join(newline)), []);
  const populated = [...lines, ['PASSWORD', '123456'].join('=')].join('\n');
  assert.ok(scan('.env.example', populated).includes('non-placeholder-credential-assignment'));
});

test('exempts only semver dependency metadata in package manifests and locks', () => {
  const key = ['cookie', 'signature'].join('-');
  for (const version of ['1.0.7', '^1.0.7', '~1.0.7', '1.0.7-beta.1']) {
    const manifest = JSON.stringify({ dependencies: { [key]: version } });
    assert.deepEqual(scan('apps/web/package.json', manifest), []);
    assert.deepEqual(scan('package-lock.json', JSON.stringify({ packages: { 'node_modules/example': { dependencies: { [key]: version } } } })), []);
    assert.ok(scan('config.json', manifest).includes('non-placeholder-credential-assignment'));
  }
  const unsafe = JSON.stringify({ dependencies: { [key]: 'synthetic-value' } });
  assert.ok(scan('package.json', unsafe).includes('non-placeholder-credential-assignment'));
  const unrelated = JSON.stringify({ [key]: '1.0.7', dependencies: { [key]: '1.0.7' } });
  assert.ok(scan('package-lock.json', unrelated).includes('non-placeholder-credential-assignment'));
  const duplicate = `{"dependencies":{${JSON.stringify(key)}:"synthetic-value",${JSON.stringify(key)}:"1.0.7"}}`;
  assert.ok(scan('package.json', duplicate).includes('non-placeholder-credential-assignment'));
});

test('credentials and numeric passwords remain blocked in lockfiles', () => {
  const key = ['pass', 'word'].join('');
  for (const value of ['123456', 123456, 0]) {
    assert.ok(scan('package-lock.json', JSON.stringify({ [key]: value })).includes('non-placeholder-credential-assignment'));
    assert.ok(scan('package-lock.json', JSON.stringify({ dependencies: { [key]: value } })).includes('non-placeholder-credential-assignment'));
  }
  assert.ok(scan('package-lock.json', credential()).includes('non-placeholder-credential-assignment'));
  assert.ok(scan('package.json', JSON.stringify({ [['RPC', 'HTTP', 'URL'].join('_')]: 'synthetic-value' })).includes('non-placeholder-credential-assignment'));
});

test('rejects provider tokens, key material and authenticated URLs', () => {
  for (const token of [['sk', '-', 'x'.repeat(32)].join(''), ['xai', '-', 'x'.repeat(32)].join(''), ['ghp', '_', 'a'.repeat(36)].join('')]) {
    assert.ok(scan('config.txt', token).includes('provider-credential-token'));
  }
  assert.ok(scan('config.txt', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')).includes('private-key-material'));
  assert.ok(scan('config.txt', ['https://', 'synthetic:synthetic', '@example.invalid'].join('')).includes('credential-bearing-url'));
  assert.ok(scan('config.txt', ['https://example.invalid/?', 'api_key', '=', 'synthetic'.repeat(4)].join('')).includes('credential-bearing-url'));
});

test('default reads staged blobs, never replacement worktree content', (t) => {
  const repo = repository(t);
  repo.write('config.json', credential());
  repo.git('add', 'config.json');
  repo.write('config.json', '{}');
  assert.equal(scanRepository(repo.cwd).findings[0].rule, 'non-placeholder-credential-assignment');
  repo.git('add', 'config.json');
  repo.write('config.json', credential());
  assert.deepEqual(scanRepository(repo.cwd).findings, []);
});

test('tracked scans unchanged index blobs and history finds removed data', (t) => {
  const repo = repository(t);
  repo.write('old.json', credential());
  repo.git('add', 'old.json');
  repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Synthetic unsafe fixture');
  assert.deepEqual(scanRepository(repo.cwd).findings, []);
  assert.equal(scanRepository(repo.cwd, 'tracked').findings.length, 1);
  repo.git('rm', 'old.json');
  repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Remove fixture');
  assert.deepEqual(scanRepository(repo.cwd, 'tracked').findings, []);
  assert.equal(scanRepository(repo.cwd, 'history').findings[0].path, 'old.json');
});

test('CI history scans every tested ancestor without importing unrelated branch findings', (t) => {
  const repo = repository(t);
  repo.write('safe.json', '{}');
  repo.git('add', '.');
  repo.git('commit', '-m', 'Clean fixture');
  const branch = repo.git('branch', '--show-current').trim();
  repo.git('switch', '-c', 'unrelated-fixture');
  repo.write('unrelated.json', credential());
  repo.git('add', '.');
  repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Unrelated synthetic fixture');
  repo.git('switch', branch);
  assert.deepEqual(scanRepository(repo.cwd, 'history-current').findings, []);
  assert.equal(scanRepository(repo.cwd, 'history').findings[0].path, 'unrelated.json');
  repo.write('removed.json', credential());
  repo.git('add', '.');
  repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Tested synthetic fixture');
  repo.git('rm', 'removed.json');
  repo.git('commit', '-m', 'Remove tested fixture');
  assert.deepEqual(scanRepository(repo.cwd, 'tracked').findings, []);
  assert.deepEqual(scanRepository(repo.cwd, 'history-current').findings, [
    { path: 'removed.json', rule: 'non-placeholder-credential-assignment' },
  ]);
});

test('checks binary paths and file sizes from the index', (t) => {
  const repo = repository(t);
  repo.write('wallet.json', Buffer.from([0, 1, 2]));
  repo.write('large.bin', Buffer.alloc(1024 * 1024 + 1));
  repo.git('add', '.');
  assert.deepEqual(new Set(scanRepository(repo.cwd).findings.map((finding) => finding.rule)), new Set(['forbidden-sensitive-or-generated-path', 'file-size-limit']));
});

test('identical staged blobs are analyzed with their actual paths', (t) => {
  const repo = repository(t);
  const content = JSON.stringify({ dependencies: { [['cookie', 'signature'].join('-')]: '^1.0.7' } });
  repo.write('a/package-lock.json', content);
  repo.write('b/config.json', content);
  repo.git('add', '.');
  assert.deepEqual(scanRepository(repo.cwd).findings, [{ path: 'b/config.json', rule: 'non-placeholder-credential-assignment' }]);
});

test('CLI reports filenames and rules without credential contents', (t) => {
  const repo = repository(t);
  repo.write('unsafe.json', credential());
  repo.git('add', '.');
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./check-repository.mjs', import.meta.url))], { cwd: repo.cwd, stdio: 'pipe' });
    assert.fail('Unsafe repository unexpectedly passed');
  } catch (error) {
    assert.equal(error.status, 1);
    const output = `${error.stdout}${error.stderr}`;
    assert.ok(output.includes('unsafe.json'));
    assert.ok(!output.includes('synthetic-'));
    assert.ok(!output.includes(credential()));
  }
});


test('only exact reviewed public deployment files may contain literal contract identities', () => {
  for (const path of ['apps/api/src/o1-fee-profiles.mjs', 'docs/o1-fee-verification.md']) {
    const content = readFileSync(new URL('../' + path, import.meta.url));
    assert.deepEqual(analyzeBlob(path, content), []);
    assert.ok(analyzeBlob('unreviewed.mjs', content).includes('literal-evm-address-key-or-signature'));
    assert.ok(analyzeBlob(path, Buffer.concat([content, Buffer.from('\n' + hex(64))])).includes('literal-evm-address-key-or-signature'));
    assert.ok(analyzeBlob(path, Buffer.from(credential())).includes('non-placeholder-credential-assignment'));
  }
});
