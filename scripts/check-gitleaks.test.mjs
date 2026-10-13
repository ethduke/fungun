import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const available = spawnSync('gitleaks', ['version']).status === 0;
const config = fileURLToPath(new URL('../.gitleaks.toml', import.meta.url));

function fixture(t, path = 'apps/api/src/asset-environment.mjs') {
  const root = mkdtempSync(join(tmpdir(), 'gitleaks-safety-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const target = join(source, path);
  const report = join(root, 'report.json');
  mkdirSync(join(target, '..'), { recursive: true });
  return (content) => {
    writeFileSync(target, content);
    const result = spawnSync('gitleaks', ['dir', '--config', config, '--redact=100',
      '--ignore-gitleaks-allow', '--no-banner', '--report-format=json', '--report-path', report, '.'],
    { cwd: source, encoding: 'utf8' });
    assert.ok([0, 1].includes(result.status), 'Independent scanner must execute successfully');
    return { status: result.status, output: result.stdout + result.stderr,
      findings: JSON.parse(readFileSync(report, 'utf8')) };
  };
}

// The ordinary application suite may run without this optional binary. The
// repository-safety job installs the pinned version before explicitly running us.
test('Gitleaks permits only the reviewed name pair, not credentials in the same file', { skip: !available }, (t) => {
  const scan = fixture(t);
  const keyName = ['OPENROUTER', 'API', 'KEY'].join('_');
  const urlName = ['X402', 'FACILITATOR', 'URL'].join('_');
  const names = `const names = [\n  "${keyName}",\n  "${urlName}",\n];\n`;
  const clean = scan(names);
  assert.equal(clean.status, 0, JSON.stringify(clean.findings));
  const token = createHash('sha256').update('independent scanner synthetic fixture').digest('hex');
  const result = scan(names + `const ${keyName} = "${token}";\n`);
  assert.equal(result.status, 1);
  assert.ok(result.findings.some((finding) => finding.RuleID === 'generic-api-key'));
  assert.ok(!result.output.includes(token));
  assert.ok(!JSON.stringify(result.findings).includes(token));
  assert.ok(result.findings.every((finding) => finding.Secret === 'REDACTED'));
});

test('Gitleaks remains independent of project assignment-name detection', { skip: !available }, (t) => {
  const scan = fixture(t);
  const jwt = [{ alg: 'HS256', typ: 'JWT' }, { sub: 'synthetic-audit', iss: 'example.invalid' }, 'synthetic-signature']
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const result = scan(`const unrelated = "${jwt}";\n`);
  assert.equal(result.status, 1);
  assert.ok(result.findings.some((finding) => finding.RuleID === 'jwt'));
  assert.ok(!result.output.includes(jwt));
  assert.ok(!JSON.stringify(result.findings).includes(jwt));
});

test('the dev exclusion-name exception is exact and cannot hide adjacent credentials', { skip: !available }, (t) => {
  assert.equal(fixture(t, '.gitleaks.toml')(readFileSync(config, 'utf8')).status, 0, 'The rule configuration itself must scan cleanly');
  const scan = fixture(t, 'scripts/dev.test.mjs');
  const tokenName = ['X402', 'FACILITATOR', 'TOKEN'].join('_');
  const keyName = ['X402', 'FACILITATOR', 'PRIVATE', 'KEY'].join('_');
  const names = `const names = ["${tokenName}", "${keyName}"];\n`;
  assert.equal(scan(names).status, 0);
  assert.equal(fixture(t, 'config.mjs')(names).status, 1, 'The same text outside its reviewed path remains scanned');
  const token = createHash('sha256').update('synthetic dev exception regression').digest('hex');
  const assignmentName = ['OPENROUTER', 'API', 'KEY'].join('_');
  const result = scan(names + `const ${assignmentName} = "${token}";\n`);
  assert.equal(result.status, 1);
  assert.ok(result.findings.some(finding => finding.RuleID === 'generic-api-key'));
  assert.ok(!result.output.includes(token));
  assert.ok(!JSON.stringify(result.findings).includes(token));
});

test('the historical Stonx contract-role label exception cannot hide credential assignments', { skip: !available }, (t) => {
  const scan = fixture(t, 'apps/api/src/stonx.test.mjs');
  const role = ['doppler', 'ERC20V1', 'Implementation'].join('');
  const mapping = `const mapping = { tokenImplementation: '${role}' };\n`;
  assert.equal(scan(mapping).status, 0);
  assert.equal(fixture(t, 'config.mjs')(mapping).status, 1, 'The exception is restricted to its reviewed path');
  const token = createHash('sha256').update('synthetic contract-role regression').digest('hex');
  for (const assignment of [
    `const mapping = { tokenImplementation: '${token}' };\n`,
    `const tokenImplementation = '${role}';\n`,
    mapping + `const ${['API', 'KEY'].join('_')} = '${token}';\n`,
  ]) {
    const result = scan(assignment);
    assert.equal(result.status, 1);
    assert.ok(result.findings.some(finding => finding.RuleID === 'generic-api-key'));
    assert.ok(!result.output.includes(token));
    assert.ok(!JSON.stringify(result.findings).includes(token));
  }
});
