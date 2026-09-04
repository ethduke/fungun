#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MiB = 1024 * 1024;
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const forbiddenDirectories = new Set([
  'secrets', 'credentials', 'keys', 'wallets', 'keystore', 'keystores',
  'uploads', 'captures', 'recordings', 'traces', 'test-results', 'playwright-report',
  'coverage', 'node_modules', 'dist', 'build', 'target', '.cache', '.next',
]);

function forbiddenPath(path) {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1);
  return parts.slice(0, -1).some((part) => forbiddenDirectories.has(part))
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
  return /(?:apikey|privatekey|secret|password|passwd|accesstoken|refreshtoken|authtoken|bearertoken|authorization|mnemonic|seedphrase|signature|rpcurl|rpcendpoint)/i.test(key.replace(/[^a-z0-9]/gi, ''));
}

function hasCredentialAssignment(text) {
  const quoted = /(?:["']([A-Za-z_][\w.-]*)["']|\b([A-Za-z_][\w.-]*))\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`)/g;
  for (const match of text.matchAll(quoted)) {
    if (sensitiveKey(match[1] ?? match[2]) && !placeholder(match[3] ?? match[4] ?? match[5])) return true;
  }
  const environment = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*([^\s#"'`][^\r\n]*)/gm;
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
  if (hasCredentialAssignment(text)) rules.add('non-placeholder-credential-assignment');
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
    if (!contentRules.has(entry.oid)) {
      const blob = git(cwd, ['cat-file', 'blob', entry.oid]);
      contentRules.set(entry.oid, analyzeBlob('package-lock.json', blob, size));
    }
    for (const rule of contentRules.get(entry.oid)) add(rule);
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
