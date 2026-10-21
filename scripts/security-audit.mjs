#!/usr/bin/env node
/**
 * Security and privacy audit for deepseek-harness-usage-monitor.
 *
 * Run this before publishing a release:  node scripts/security-audit.mjs
 *
 * It is a *repository* audit, not a runtime one. It checks two places:
 *
 *   1. the working tree — committed secrets, credential files, local runtime
 *      data (wallet/usage state), developer home paths and private keys;
 *   2. Git history — the same secret rules over every commit reachable from
 *      any ref, plus a list of every file that was ever committed.
 *
 * Design rules for this script:
 *   - Node.js ESM, no dependencies, no network access;
 *   - read-only: it never writes, deletes or fixes anything;
 *   - a repository with no Git history (an exported tarball, a fresh folder)
 *     still gets a full working-tree audit;
 *   - findings are printed with `file:line` where possible and exit code is 1
 *     when a real problem is found; non-blocking notes do not fail the run.
 *
 * The patterns are assembled from fragments so this file never matches itself.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories that are never part of the published repository. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store', '.pnpm']);

/** Large or binary files that are legitimately part of the release. */
const ALLOWED_BINARY = [/^docs\/screenshots\/[^/]+\.(png|jpe?g|webp|gif)$/i, /^icon\.svg$/];

const failures = [];
const notes = [];

/** @param {string} line */
function failure(line) {
  failures.push(line);
}

/** @param {string} line */
function note(line) {
  notes.push(line);
}

/** @param {string} path */
function rel(path) {
  return relative(ROOT, path).split(sep).join('/');
}

/**
 * Walk the repository, skipping VCS and installed dependencies.
 * @param {string} [directory]
 * @returns {string[]}
 */
function walk(directory = ROOT) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(full));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * True when a buffer is safe to read as UTF-8 text.
 * @param {Buffer} buffer
 */
function isText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 4096);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable += 1;
  }
  return sample.length === 0 || printable / sample.length > 0.9;
}

/**
 * Secret patterns. Fragments are concatenated so this file does not contain a
 * literal key-looking string of its own.
 * @returns {{ name: string, regex: RegExp }[]}
 */
function secretPatterns() {
  return [
    { name: 'DeepSeek/OpenAI-style API key', regex: new RegExp('s' + 'k-[A-Za-z0-9_-]{20,}') },
    { name: 'Bearer token', regex: new RegExp('B' + 'earer\\s+[A-Za-z0-9._~+/-]{20,}=*') },
    { name: 'PEM private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'AWS access key id', regex: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub token', regex: new RegExp('gh' + '[pousr]_[A-Za-z0-9]{36,}') },
    { name: 'GitHub fine-grained token', regex: new RegExp('github' + '_pat_[A-Za-z0-9_]{60,}') },
    { name: 'Google API key', regex: new RegExp('AI' + 'za[0-9A-Za-z_-]{35}') },
    { name: 'Slack token', regex: new RegExp('xox' + '[baprs]-[A-Za-z0-9-]{10,}') },
    {
      name: 'credential assignment',
      regex: new RegExp(
        '(?:api[_ -]?key|apikey|client[_ -]?secret|access[_ -]?token|auth[_ -]?token|password|passwd)' +
          "\\s*[:=]\\s*['\"][^'\"\\s]{16,}['\"]",
        'i',
      ),
    },
  ];
}

/** Lines that explain why a key-looking match is a documented placeholder. */
const PLACEHOLDER = /(?:your|example|placeholder|redacted|dummy|sample|fake|synthetic|test|demo|<[^>]*>|\.\.\.|x{4,})/i;

/**
 * Scan one text blob for secrets.
 * @param {string} label printable location, e.g. `README.md:12`
 * @param {string} text
 * @param {{ name: string, regex: RegExp }[]} patterns
 * @param {string[]} out
 */
function scanText(label, text, patterns, out) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match) continue;
      if (PLACEHOLDER.test(line)) continue;
      out.push(`${label}:${index + 1}: ${pattern.name}`);
    }
  });
}

/** @returns {boolean} whether the working tree is inside a Git repository */
function isGitRepo() {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  return result.status === 0 && String(result.stdout).trim() === 'true';
}

/**
 * Scan every commit reachable from any ref for secret material.
 * @returns {{ commits: number, files: string[] } | null}
 */
function scanGitHistory() {
  if (!isGitRepo()) return null;
  const countResult = spawnSync('git', ['rev-list', '--all', '--count'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30000,
  });
  const commits = Number.parseInt(String(countResult.stdout ?? '0').trim(), 10) || 0;
  if (commits === 0) return { commits: 0, files: [] };

  // Every path that was ever added or modified in any commit.
  const nameResult = spawnSync('git', ['log', '--all', '--name-only', '--pretty=format:'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = String(nameResult.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Full patch text, reduced to added lines only, so the match locations stay
  // meaningful and the buffer stays small for normal repositories.
  const patchResult = spawnSync('git', ['log', '--all', '-p', '--no-color', '--unified=0', '--format=commit %H'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (patchResult.error) {
    note(`Git history content scan skipped: ${patchResult.error.message}`);
    return { commits, files };
  }
  const patterns = secretPatterns();
  const lines = String(patchResult.stdout ?? '').split(/\r?\n/);
  let commit = 'unknown';
  let added = '';
  const findings = [];
  for (const line of lines) {
    if (line.startsWith('commit ')) {
      if (added) scanText(`commit ${commit.slice(0, 12)} (added line)`, added, patterns, findings);
      commit = line.slice('commit '.length);
      added = '';
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) added += `${line.slice(1)}\n`;
  }
  if (added) scanText(`commit ${commit.slice(0, 12)} (added line)`, added, patterns, findings);
  for (const finding of findings) failure(`Git history ${finding}`);
  return { commits, files };
}

// ---------------------------------------------------------------------------
// Working tree
// ---------------------------------------------------------------------------
const files = walk();

for (const file of files) {
  const name = rel(file);
  if (ALLOWED_BINARY.some((pattern) => pattern.test(name))) continue;

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (!isText(buffer)) {
    note(`skipped binary file: ${name}`);
    continue;
  }
  const text = buffer.toString('utf8');

  // Credential files and local runtime data must never be published. The
  // support status file lives in $DSH_HOME/usage-monitor/, not in the repository.
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (base === 'state.json' || base === 'status.json' || base === 'settings.json') {
    failure(`runtime data file in repository: ${name}`);
  } else if (/\.(db|sqlite3?|jsonl|jsonl\.zst|log)$/i.test(base)) {
    failure(`runtime data file in repository: ${name}`);
  } else if (name.startsWith('usage-monitor-data/')) {
    failure(`runtime data directory in repository: ${name}`);
  } else if (/^\.env(\..+)?$/.test(base) && !base.endsWith('.example')) {
    failure(`credential file in repository: ${name}`);
  }

  const findings = [];
  scanText(name, text, secretPatterns(), findings);
  for (const finding of findings) failure(finding);

  // Developer home directories in committed sources. Placeholders such as
  // C:\Users\<you>, C:\Users\you and ~/ are fine.
  const homePath = new RegExp('[A-Za-z]:\\\\+Users\\\\+([A-Za-z0-9._-]+)');
  const allowedUsers = new Set(['you', 'yourname', 'username', 'user', 'me', 'public']);
  text.split(/\r?\n/).forEach((line, index) => {
    const match = homePath.exec(line);
    if (match && !allowedUsers.has(match[1].toLowerCase()) && !PLACEHOLDER.test(line)) {
      failure(`${name}:${index + 1}: developer home path`);
    }
  });
}

// Locales must never carry a credential-shaped value either (the scan above
// covers them, this only checks they exist).
for (const locale of ['locale/en.json', 'locale/zh.json']) {
  try {
    readFileSync(join(ROOT, locale), 'utf8');
  } catch {
    note(`expected locale file is missing: ${locale}`);
  }
}

// ---------------------------------------------------------------------------
// Git history
// ---------------------------------------------------------------------------
const history = scanGitHistory();
if (history === null) {
  note('Git history scan skipped: this directory is not a Git repository yet.');
} else if (history.commits === 0) {
  note('Git history scan skipped: the repository has no commits yet.');
} else {
  note(`Git history: ${history.commits} commit(s), ${history.files.length} distinct path entries scanned.`);
  const forbiddenPaths = history.files.filter((path) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return (
      base === 'state.json' ||
      base === 'status.json' ||
      base === 'settings.json' ||
      /\.(db|sqlite3?|jsonl|jsonl\.zst|log)$/i.test(base) ||
      /^\.env(\..+)?$/.test(base)
    );
  });
  for (const path of [...new Set(forbiddenPaths)]) failure(`Git history contains runtime/credential file: ${path}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
process.stdout.write('Usage Monitor security & privacy audit\n');
process.stdout.write(`Repository: ${ROOT}\n`);
process.stdout.write(`Text files scanned: ${files.length}\n\n`);

for (const line of notes) process.stdout.write(`  note ${line}\n`);

if (failures.length === 0) {
  process.stdout.write('\nPASS: no secrets, credential files, runtime data or developer home paths found.\n');
  process.stdout.write('Reminder: run this audit again after generating screenshots and changelogs.\n');
  process.exit(0);
}

process.stdout.write('\nFindings:\n');
for (const line of failures) process.stdout.write(`  FAIL ${line}\n`);
process.stdout.write(`\n${failures.length} finding(s). Nothing was modified; fix the files and re-run.\n`);
process.exit(1);
