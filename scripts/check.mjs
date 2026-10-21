#!/usr/bin/env node
/**
 * Repository checks for deepseek-harness-usage-monitor.
 *
 * This script is intentionally dependency-free and network-free: it is meant to
 * run in CI and in a fresh clone with nothing but Node.js installed. It checks
 * the things a release can silently break:
 *
 *   1. required files exist (docs, client bundle, CI, license, locales);
 *   2. every JSON file parses;
 *   3. every JavaScript file passes `node --check`;
 *   4. package.json / cordis.patch.yml declare the plugin correctly;
 *   5. no API keys, bearer tokens or private keys are committed;
 *   6. client.js stays a plain module-loader artifact (no ESM imports, no JSX);
 *   7. public docs contain no developer-machine absolute paths;
 *   8. no local runtime data (state.json, status.json, logs, databases) is committed;
 *   9. the CI workflow exists and never asks for repository secrets;
 *  10. the READMEs keep the sections this project promises to document.
 *
 * Exit code 0 means every check passed. Any failure prints a report and exits 1.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Directories that never contain repository sources. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.pnpm-store', '.pnpm']);

/** Required release files, relative to the repository root. */
const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'docs/API.md',
  'docs/ARCHITECTURE.md',
  'docs/DATA-SOURCES.md',
  'docs/ROADMAP.md',
  'docs/UI.md',
  'locale/en.json',
  'locale/zh.json',
  '.gitignore',
  '.github/workflows/ci.yml',
  'scripts/check.mjs',
  'scripts/security-audit.mjs',
  'scripts/verify-live.mjs',
];

/** README sections this project promises to document (case-insensitive). */
const README_SECTIONS = [
  'screenshot',
  'features',
  'requirements',
  'installation',
  'usage',
  'configuration',
  'how anomaly detection works',
  'cache diagnostics',
  'data & privacy',
  'development',
  'known limitations',
  'roadmap',
  'contributing',
  'license',
];

/** README.zh.md sections (Simplified Chinese). */
const README_ZH_SECTIONS = [
  '截图',
  '功能',
  '环境要求',
  '安装',
  '使用',
  '配置',
  '异常检测',
  '缓存诊断',
  '数据与隐私',
  '开发',
  '已知限制',
  '路线图',
  '贡献',
  '许可证',
];

const failures = [];
const passes = [];
const warnings = [];

/**
 * Record a passing check.
 * @param {string} name
 * @param {string} [detail]
 */
function pass(name, detail = '') {
  passes.push(detail ? `${name} (${detail})` : name);
}

/**
 * Record a failed check.
 * @param {string} name
 * @param {string} detail
 */
function fail(name, detail) {
  failures.push(`${name}: ${detail}`);
}

/**
 * Record a non-blocking warning.
 * @param {string} message
 */
function warn(message) {
  warnings.push(message);
}

/** @param {string} path */
function rel(path) {
  return relative(ROOT, path).split(sep).join('/');
}

/**
 * Walk the repository and return every file path, skipping vendored output.
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

/** @param {string} path */
function read(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Whether a buffer looks like UTF-8 text (no NUL bytes, mostly printable).
 * @param {Buffer} buffer
 */
function looksLikeText(buffer) {
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, 4096);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127)) printable += 1;
  }
  return sample.length === 0 || printable / sample.length > 0.9;
}

const FILES = walk();
const TEXT_FILES = FILES.filter((file) => {
  if (statSync(file).size > 4 * 1024 * 1024) return false;
  try {
    return looksLikeText(readFileSync(file));
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// 1. Required files
// ---------------------------------------------------------------------------
{
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length === 0) pass('required files', `${REQUIRED_FILES.length} present`);
  else fail('required files are missing', missing.join(', '));
}

// ---------------------------------------------------------------------------
// 2. JSON files parse
// ---------------------------------------------------------------------------
{
  const jsonFiles = FILES.filter((file) => file.endsWith('.json'));
  const broken = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(read(file));
    } catch (error) {
      broken.push(`${rel(file)} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (broken.length === 0) pass('JSON parses', `${jsonFiles.length} file(s)`);
  else fail('invalid JSON', broken.join('; '));
}

// ---------------------------------------------------------------------------
// 3. JavaScript syntax (node --check)
// ---------------------------------------------------------------------------
{
  const jsFiles = FILES.filter(
    (file) =>
      (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) &&
      !file.includes(`${sep}docs${sep}`) &&
      !file.includes(`${sep}node_modules${sep}`),
  );
  const broken = [];
  for (const file of jsFiles) {
    let result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      // Older Node releases and unusual launch modes can parse a file as CJS even
      // inside a "type": "module" package. Retry as an explicit ES module before
      // declaring the file broken.
      result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
        input: readFileSync(file),
        encoding: 'utf8',
      });
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 3).join(' ');
      broken.push(`${rel(file)}${detail ? ` (${detail})` : ''}`);
    }
  }
  if (broken.length === 0) pass('JavaScript syntax', `${jsFiles.length} file(s) via node --check`);
  else fail('JavaScript syntax errors', broken.join('; '));
}

// ---------------------------------------------------------------------------
// 4. package.json and cordis.patch.yml declarations
// ---------------------------------------------------------------------------
{
  let manifest = null;
  try {
    manifest = JSON.parse(read(join(ROOT, 'package.json')));
  } catch {
    fail('package.json', 'cannot be parsed');
  }
  if (manifest) {
    const problems = [];
    if (manifest.name !== 'deepseek-harness-usage-monitor') problems.push('name must be deepseek-harness-usage-monitor');
    if (manifest.version !== '0.1.0') problems.push('version must be 0.1.0');
    if (manifest.license !== 'MIT') problems.push('license must be MIT');
    if (manifest.type !== 'module') problems.push('type must be module');
    if (manifest.private !== true) problems.push('private must stay true (install by path, not by npm publish)');
    if (!manifest.engines || manifest.engines.node !== '>=20') problems.push('engines.node must be >=20');
    if (!manifest.exports || manifest.exports['./client'] !== './client.js') problems.push('exports["./client"] must point at client.js');
    if (!manifest.dsh || !manifest.dsh.bundle || manifest.dsh.bundle.patch !== './cordis.patch.yml') {
      problems.push('dsh.bundle.patch must point at cordis.patch.yml');
    }
    if (!manifest.dsh || !manifest.dsh.client || manifest.dsh.client.platform !== 'web') {
      problems.push('dsh.client.platform must be web');
    }
    if (problems.length === 0) pass('package.json manifest');
    else fail('package.json manifest', problems.join('; '));
  }

  if (existsSync(join(ROOT, 'index.js'))) {
    const entry = read(join(ROOT, 'index.js'));
    if (/export\s+(?:async\s+)?function\s+apply\b/.test(entry) && /export\s+const\s+inject\b/.test(entry)) {
      pass('Host entry exports', 'apply() + inject');
    } else {
      fail('Host entry exports', 'index.js must export function apply() and const inject');
    }
  }

  if (existsSync(join(ROOT, 'cordis.patch.yml'))) {
    const patch = read(join(ROOT, 'cordis.patch.yml'));
    const problems = [];
    if (!patch.includes('usage-monitor')) problems.push('missing usage-monitor id');
    if (!patch.includes('deepseek-harness-usage-monitor')) problems.push('missing package name');
    if (!patch.includes('balanceRefreshSeconds')) problems.push('missing balanceRefreshSeconds default');
    if (!patch.includes('retentionDays')) problems.push('missing retentionDays default');
    if (problems.length === 0) pass('cordis.patch.yml bundle row');
    else fail('cordis.patch.yml bundle row', problems.join('; '));
  }
}

// ---------------------------------------------------------------------------
// 5. Secrets
// ---------------------------------------------------------------------------
{
  // Build the patterns from parts so this file does not match its own scan.
  const patterns = [
    { name: 'API key', regex: new RegExp('s' + 'k-[A-Za-z0-9_-]{20,}') },
    { name: 'Bearer token', regex: new RegExp('B' + 'earer\\s+[A-Za-z0-9._~+/-]{20,}=*') },
    { name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'AWS access key', regex: /AKIA[0-9A-Z]{16}/ },
    { name: 'GitHub token', regex: new RegExp('gh' + '[pousr]_[A-Za-z0-9]{36,}') },
    { name: 'Google API key', regex: new RegExp('AI' + 'za[0-9A-Za-z_-]{35}') },
    { name: 'Slack token', regex: new RegExp('xox' + '[baprs]-[A-Za-z0-9-]{10,}') },
  ];
  const allow = /(?:your|example|placeholder|redacted|dummy|sample|fake|test|demo|synthetic|<[^>]*>|\.\.\.)/i;
  const findings = [];
  for (const file of TEXT_FILES) {
    if (rel(file) === 'scripts/security-audit.mjs') continue; // patterns live there, not secrets
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        const match = pattern.regex.exec(line);
        if (!match) continue;
        if (allow.test(line)) continue;
        findings.push(`${rel(file)}:${index + 1} possible ${pattern.name}`);
      }
    });
  }
  if (findings.length === 0) pass('no committed secrets', `${TEXT_FILES.length} text file(s)`);
  else fail('possible secret in repository', findings.join('; '));
}

// ---------------------------------------------------------------------------
// 6. client.js stays a plain module-loader artifact
// ---------------------------------------------------------------------------
{
  const clientPath = join(ROOT, 'client.js');
  if (!existsSync(clientPath)) {
    // Already reported by the required-files check; avoid a duplicate failure.
  } else {
    const source = read(clientPath);
    const problems = [];
    if (/^\s*import\s+[\w{*'"]/m.test(source)) problems.push('contains an ESM import statement');
    if (/\bimport\s*\(/.test(source)) problems.push('contains a dynamic import()');
    if (/<[A-Z][A-Za-z0-9.]*(?:\s[^<>]*)?>/.test(source)) problems.push('contains JSX');
    if (!source.includes('__ModuleLoader__')) problems.push('does not register through window.__ModuleLoader__');
    if (!source.includes('sidebar.panellist')) problems.push('does not register the sidebar.panellist entry');
    if (problems.length === 0) pass('client.js contract', 'plain module-loader bundle, no imports or JSX');
    else fail('client.js contract', problems.join('; '));
  }
}

// ---------------------------------------------------------------------------
// 7. Public docs contain no developer-machine paths
// ---------------------------------------------------------------------------
{
  const docFiles = TEXT_FILES.filter((file) => {
    const name = rel(file);
    return (
      name === 'README.md' ||
      name === 'README.zh.md' ||
      name === 'SECURITY.md' ||
      name === 'CHANGELOG.md' ||
      name === 'CONTRIBUTING.md' ||
      name.startsWith('docs/')
    );
  });
  const homePath = new RegExp('[A-Za-z]:\\\\+Users\\\\+([A-Za-z0-9._-]+)');
  const allowUsers = new Set(['you', 'yourname', 'username', 'user', 'me', 'runner', 'public']);
  const findings = [];
  for (const file of docFiles) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = homePath.exec(line);
      if (match && !allowUsers.has(match[1].toLowerCase())) {
        findings.push(`${rel(file)}:${index + 1} developer home path`);
      }
    });
  }
  if (findings.length === 0) pass('public docs use placeholder paths');
  else fail('developer-machine path in public docs', findings.join('; '));
}

// ---------------------------------------------------------------------------
// 8. No local runtime data committed
// ---------------------------------------------------------------------------
{
  const forbidden = [];
  for (const file of FILES) {
    const name = rel(file);
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (base === 'state.json' || base === 'status.json' || base === 'settings.json') forbidden.push(name);
    else if (/\.(db|sqlite3?|log|jsonl|jsonl\.zst)$/i.test(base)) forbidden.push(name);
    else if (name.startsWith('usage-monitor-data/')) forbidden.push(name);
    else if (/^\.env(\..+)?$/.test(base) && !base.endsWith('.example')) forbidden.push(name);
  }
  if (forbidden.length === 0) pass('no local runtime data or env files');
  else fail('local runtime data must not be committed', forbidden.join(', '));
}

// ---------------------------------------------------------------------------
// 9. CI workflow
// ---------------------------------------------------------------------------
{
  const ciPath = join(ROOT, '.github/workflows/ci.yml');
  if (existsSync(ciPath)) {
    const text = read(ciPath);
    const problems = [];
    if (!text.includes('runs-on: ubuntu-latest')) problems.push('must run on ubuntu-latest');
    if (!text.includes('npm run check')) problems.push('must run npm run check');
    if (!text.includes('node scripts/security-audit.mjs')) problems.push('must run the security audit');
    if (/secrets\./.test(text)) problems.push('must not reference repository secrets');
    if (problems.length === 0) pass('CI workflow', 'ubuntu-latest, no secrets');
    else fail('CI workflow', problems.join('; '));
  }
}

// ---------------------------------------------------------------------------
// 10. README sections
// ---------------------------------------------------------------------------
{
  const readme = join(ROOT, 'README.md');
  if (existsSync(readme)) {
    const text = read(readme);
    const slogan = 'Real-time balance, token usage, cache hit rate and abnormal spend detection inside DeepSeek Harness.';
    if (text.includes(slogan)) pass('README one-line description');
    else fail('README one-line description', 'the required one-line description is missing');
  }
  for (const [file, sections] of [
    ['README.md', README_SECTIONS],
    ['README.zh.md', README_ZH_SECTIONS],
  ]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue;
    const text = read(path).toLowerCase();
    const missing = sections.filter((section) => !text.includes(section.toLowerCase()));
    if (missing.length === 0) pass(`${file} sections`, `${sections.length} headings`);
    else fail(`${file} is missing sections`, missing.join(', '));
  }
}

// ---------------------------------------------------------------------------
// 11. README screenshots resolve
// ---------------------------------------------------------------------------
{
  const screenshotsDir = join(ROOT, 'docs/screenshots');
  const missing = [];
  for (const file of ['README.md', 'README.zh.md']) {
    const text = read(join(ROOT, file));
    const imagePattern = /!\[[^\]]*\]\(([^)\s]+)\)/g;
    let match;
    while ((match = imagePattern.exec(text)) !== null) {
      const target = match[1];
      if (/^https?:/.test(target)) continue;
      if (!existsSync(join(ROOT, target))) missing.push(`${file} → ${target}`);
    }
  }
  if (missing.length === 0) pass('README screenshots resolve');
  else if (!existsSync(screenshotsDir)) warn(`README references screenshots that are not generated yet: ${missing.join(', ')}`);
  else fail('README references missing screenshots', missing.join(', '));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const total = passes.length + failures.length;
process.stdout.write(`Usage Monitor repository checks — ${total} check group(s)\n\n`);
for (const line of passes) process.stdout.write(`  ok   ${line}\n`);
for (const line of warnings) process.stdout.write(`  warn ${line}\n`);
if (failures.length > 0) {
  process.stdout.write('\nFailures:\n');
  for (const line of failures) process.stdout.write(`  FAIL ${line}\n`);
  process.stdout.write(`\n${failures.length} check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nAll checks passed.\n`);
