#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const forbiddenDirectories = new Set([
  'secrets', 'credentials', 'keys', 'wallets', 'keystore', 'keystores',
  'uploads', 'captures', 'recordings', 'traces', 'test-results', 'playwright-report',
  'coverage', 'node_modules', 'dist', 'build', 'target', '.cache', '.next',
  'asset-backups', 'asset-restores',
]);

function forbiddenPath(path) {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.slice(0, -1).some((part) => forbiddenDirectories.has(part))
    || name === 'backup.manifest.json'
    || (/^\.env(?:\.|$)/.test(name) && name !== '.env.example')
    || /^(?:\.envrc|\.npmrc|\.netrc|\.pypirc)$/.test(name)
    || /\.(?:pem|key|p12|pfx|jks|keystore|secret|seed|log|sqlite3?|db|dump|zip|7z|tar|gz|dmg)$/i.test(name)
    || /^(?:wallets?|credentials?|secrets?|signatures?|signed[-_]?transactions?)(?:[._-]|$)/.test(name)
    || /(?:^|[-_.])(?:private[-_]?key|keypair|seed[-_]?phrase)(?:[-_.]|$)/.test(name);
}

function placeholder(value) {
  return value === ''
    || /^(?:<[^>]+>|\$\{[A-Z_][A-Z0-9_]*\}|(?:YOUR|REPLACE|INSERT)_[A-Z0-9_]+|CHANGE_?ME|EXAMPLE|PLACEHOLDER|REDACTED)$/i.test(value);
}

function sensitiveKey(key) {
  return /(?:apikey|privatekey|secret|password|passwd|accesstoken|refreshtoken|authtoken|bearertoken|authorization|mnemonic|seedphrase|signature|rpc(?:https?|wss?)?(?:url|endpoint))/i.test(key.replace(/[^a-z0-9]/gi, ''));
}

function assignmentPlaceholder(path, key, value) {
  if (placeholder(value)) return true;
  if (!/\.test\.(?:mjs|ts)$/.test(path)) return false;
  const name = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (name === 'authorization') return /^Bearer (?:EXAMPLE|PLACEHOLDER|REDACTED)$/.test(value);
  // Exact reserved fixture hosts only, without user info, ports or URL suffixes.
  return /^(?:base)?rpc(?:https?|wss?)?(?:url|endpoint)$/.test(name)
    && /^https:\/\/(?:rpc\.|base-rpc\.)?example\.invalid\/?$/.test(value);
}

function withoutDependencyVersions(path, text) {
  const name = path.split('/').at(-1);
  if (!['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(name)) return text;
  try { JSON.parse(text); } catch { return text; }
  const groups = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']);
  const dependencyMap = (route) => (route.length === 1 && groups.has(route[0]))
    || (name !== 'package.json' && route.length === 3 && route[0] === 'packages' && groups.has(route[2]));
  const semver = /^[~^]?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  const spans = [];
  let index = 0;
  function walk(route, keyStart) {
    const token = tokens[index++];
    if (token[0] === '{') {
      while (tokens[index][0] !== '}') {
        const key = tokens[index++];
        index += 1;
        walk([...route, JSON.parse(key[0])], key.index);
        if (tokens[index][0] === ',') index += 1;
      }
      index += 1;
    } else if (token[0] === '[') {
      let item = 0;
      while (tokens[index][0] !== ']') {
        walk([...route, item++]);
        if (tokens[index][0] === ',') index += 1;
      }
      index += 1;
    } else if (token[0].startsWith('"') && dependencyMap(route.slice(0, -1))
      && sensitiveKey(String(route.at(-1))) && semver.test(JSON.parse(token[0]))) {
      spans.push([keyStart, token.index + token[0].length]);
    }
  }
  walk([]);
  // Mask only parsed dependency entries, preserving duplicate and unrelated keys.
  for (const [start, end] of spans.reverse()) text = text.slice(0, start) + text.slice(start, end).replace(/[^\r\n]/g, ' ') + text.slice(end);
  return text;
}

function hasCredentialAssignment(path, source) {
  const text = withoutDependencyVersions(path, source);
  const quoted = /(?:["']([A-Za-z_][\w.-]*)["']|\b([A-Za-z_][\w.-]*))\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`)/g;
  for (const match of text.matchAll(quoted)) {
    const key = match[1] ?? match[2];
    if (sensitiveKey(key) && !assignmentPlaceholder(path, key, match[3] ?? match[4] ?? match[5])) return true;
  }
  const numeric = /(?:["']([A-Za-z_][\w.-]*)["']|\b([A-Za-z_][\w.-]*))\s*[:=]\s*(-?\d+(?:\.\d+)?)(?=[,\s;}])/g;
  for (const match of text.matchAll(numeric)) {
    if (sensitiveKey(match[1] ?? match[2])) return true;
  }
  const environment = /^[\t ]*(?:export[\t ]+)?([A-Z_][A-Z0-9_]*)[\t ]*=[\t ]*([^\s#"'`][^\r\n]*)/gm;
  for (const match of text.matchAll(environment)) {
    const value = match[2].replace(/\s+#.*$/, '').trim();
    if (sensitiveKey(match[1]) && !placeholder(value)) return true;
  }
  return false;
}

export function analyzeBlob(path, content, size = content.length) {
  const rules = new Set();
  const name = path.split('/').at(-1);
  if (forbiddenPath(path)) rules.add('forbidden-sensitive-or-generated-path');
  if (size > (lockfiles.has(name) ? 3 * MiB : MiB)) rules.add('file-size-limit');
  if (rules.has('file-size-limit')) return [...rules];
  // Decode binary blobs too: embedded credentials must not bypass the checks.
  const text = content.toString('utf8');
  if (/\b0x(?:[a-f\d]{40}|[a-f\d]{64}|[a-f\d]{128}|[a-f\d]{130})\b/i.test(text)) rules.add('literal-evm-address-key-or-signature');
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text)) rules.add('private-key-material');
  if (/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/.test(text)) rules.add('provider-credential-token');
  if (hasCredentialAssignment(path, text)) rules.add('non-placeholder-credential-assignment');
  if (/https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/i.test(text)
    || /https?:\/\/[^\s"'<>]+[?&](?:api[_-]?key|token|secret|password)=(?!<|\$\{)[A-Za-z0-9_%.-]{8,}/i.test(text)
    || /https?:\/\/[^\s/"'<>]*(?:infura\.io|alchemy\.com)\/v[23]\/[A-Za-z0-9_-]{12,}/i.test(text)) rules.add('credential-bearing-url');
  return [...rules];
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, maxBuffer: 128 * MiB, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

function indexEntries(cwd, stagedOnly) {
  const changed = stagedOnly
    ? new Set(git(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']).toString('utf8').split('\0').filter(Boolean))
    : null;
  return git(cwd, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).flatMap((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    if (changed && !changed.has(path)) return [];
    if (stage !== '0') throw new Error('Unmerged index');
    return [{ path, oid, mode }];
  });
}

function historyEntries(cwd) {
  const commits = git(cwd, ['rev-list', '--all']).toString('utf8').trim().split('\n').filter(Boolean);
  const entries = new Map();
  for (const commit of commits) {
    for (const entry of git(cwd, ['ls-tree', '-rz', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const [mode, type, oid] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      entries.set(`${oid}\0${path}`, { path, oid, mode, type });
    }
  }
  return [...entries.values()];
}

export function scanRepository(cwd, mode = 'staged') {
  if (!['staged', 'tracked', 'history'].includes(mode)) throw new Error('Invalid scan mode');
  const entries = mode === 'history' ? historyEntries(cwd) : indexEntries(cwd, mode === 'staged');
  const findings = new Map();
  const contentRules = new Map();
  for (const entry of entries) {
    const add = (rule) => findings.set(`${entry.path}\0${rule}`, { path: entry.path, rule });
    if (entry.mode === '160000') {
      add('unscanned-submodule');
      continue;
    }
    if (entry.mode === '120000') add('unscanned-symlink');
    const size = Number(git(cwd, ['cat-file', '-s', entry.oid]).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid blob size');
    const max = lockfiles.has(entry.path.split('/').at(-1)) ? 3 * MiB : MiB;
    if (forbiddenPath(entry.path)) add('forbidden-sensitive-or-generated-path');
    if (size > max) {
      add('file-size-limit');
      continue;
    }
    const cacheKey = `${entry.oid}\0${entry.path}`;
    if (!contentRules.has(cacheKey)) {
      const blob = git(cwd, ['cat-file', 'blob', entry.oid]);
      contentRules.set(cacheKey, analyzeBlob(entry.path, blob, size));
    }
    for (const rule of contentRules.get(cacheKey)) add(rule);
  }
  return { files: entries.length, findings: [...findings.values()] };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--tracked', '--history'].includes(args[0]))) {
    process.stderr.write('Usage: node scripts/check-repository.mjs [--tracked|--history]\n');
    return 2;
  }
  const mode = args[0]?.slice(2) ?? 'staged';
  try {
    const result = scanRepository(process.cwd(), mode);
    if (result.findings.length) {
      process.stderr.write('Repository safety check failed; file contents are never printed.\n');
      for (const finding of result.findings) process.stderr.write(`${JSON.stringify(finding.path)}: ${finding.rule}\n`);
      return 1;
    }
    process.stdout.write(`Repository safety check passed (${mode}; ${result.files} file versions).\n`);
    return 0;
  } catch {
    // Git errors may contain paths or content; never forward the original error.
    process.stderr.write('Repository safety check could not complete. Resolve Git/index errors and retry.\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
