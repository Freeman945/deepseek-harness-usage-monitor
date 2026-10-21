#!/usr/bin/env node
/**
 * Live verification for a real DeepSeek Harness installation.
 *
 * Usage:
 *   node scripts/verify-live.mjs
 *   DSH_HOME=~/.dsh node scripts/verify-live.mjs
 *
 * It checks three independent layers and exits non-zero on structural failure:
 *
 *   1. status.json produced by the installed plugin (the plugin is running);
 *   2. the plugin's own state.json request samples;
 *   3. an independent raw parse of the Session JSONL logs, cross-checked
 *      against Harness's own `tokenUsage` projection cache.
 *
 * The third layer is what makes this more than a smoke test: the plugin must
 * agree with Harness's durable token accounting, not just with itself.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const DATA_DIR = join(DSH_HOME, 'usage-monitor');
const RETENTION_DAYS = 14;
const ZSTD_MAGIC = 4247762216;

let failures = 0;
const log = (message) => console.log(message);
const check = (ok, message) => {
  if (ok) {
    log(`  ok   ${message}`);
  } else {
    failures += 1;
    log(`  FAIL ${message}`);
  }
};

// ---------------------------------------------------------------- status.json

let status;
try {
  status = JSON.parse(readFileSync(join(DATA_DIR, 'status.json'), 'utf8'));
} catch (error) {
  console.error(`Cannot read ${join(DATA_DIR, 'status.json')}: ${error.message}`);
  console.error('Install the plugin, open the dashboard once, and wait ~60s for the support file.');
  process.exit(1);
}

log('\n[1] plugin status file');
check(status.plugin === 'deepseek-harness-usage-monitor', 'plugin identity');
check(/^\d+\.\d+\.\d+/.test(status.version ?? ''), `plugin version ${status.version}`);
check(Number.isFinite(status.generatedAt), 'generatedAt is a timestamp');
check(['ready', 'signed-out', 'error', 'unavailable'].includes(status.balance?.state), `balance state: ${status.balance?.state}`);
check(status.usage?.requests >= 0, `request samples: ${status.usage?.requests}`);
check(Array.isArray(status.usage?.models), 'model breakdown present');
check(status.cache?.hitRate === null || (status.cache?.hitRate >= 0 && status.cache.hitRate <= 1), `cache hit rate: ${status.cache?.hitRate}`);
check(Array.isArray(status.cache?.diagnosis), 'cache diagnosis present');
check(Number.isFinite(status.cost?.windows?.last24h?.estimated), 'last-24h cost estimate present');
check(Number.isFinite(status.burn?.ratio) || status.burn?.ratio === null, 'burn ratio present');
check(status.scan?.finishedAt !== null && status.scan?.finishedAt >= status.scan?.startedAt, 'session scan completed');
if (status.balance?.state === 'ready') {
  check(status.balance?.primary?.amount >= 0, `wallet balance: ${status.balance.primary?.amount} ${status.balance.primary?.currency}`);
} else {
  log(`  note balance not readable (${status.balance?.state}) — check Settings → Account in Harness`);
}

// ---------------------------------------------------------------- state.json

let state;
try {
  state = JSON.parse(readFileSync(join(DATA_DIR, 'state.json'), 'utf8'));
} catch (error) {
  console.error(`Cannot read state.json: ${error.message}`);
  process.exit(1);
}

log('\n[2] plugin state');
check(state.version === 1, 'state schema version');
check(Array.isArray(state.requests), 'request samples are an array');
const retentionCutoff = Date.now() - RETENTION_DAYS * 86_400_000;
const engineRows = state.requests.filter((row) => row.t >= retentionCutoff);
const engine = new Map();
for (const row of engineRows) {
  const bucket = engine.get(row.sid) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  bucket.input += row.input;
  bucket.output += row.output;
  bucket.cacheRead += row.cacheRead ?? 0;
  bucket.cacheWrite += row.cacheWrite ?? 0;
  bucket.requests += 1;
  engine.set(row.sid, bucket);
}
log(`  samples in ${RETENTION_DAYS}d retention: ${engineRows.length} across ${engine.size} sessions`);
check(engineRows.every((row) => Number.isFinite(row.t) && typeof row.sid === 'string'), 'every sample has a timestamp and session id');

// ------------------------------------------------------- raw log cross-check

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const last = blockHeader & 1;
      const type = (blockHeader >>> 1) & 3;
      const size = blockHeader >>> 3;
      offset += type === 1 ? 1 : size;
      if (last) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return { frames };
}

function readLog(file) {
  const buffer = readFileSync(file);
  const { frames } = scanZstdFrames(buffer);
  const text = Buffer.concat(frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)))).toString('utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Find the newest stored generation for every session directory. */
function listSessionLogs(root) {
  const results = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(projectDir, session.name);
      const candidates = readdirSync(sessionDir)
        .map((name) => {
          const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name);
          return match ? { name, version: match[1] === undefined ? 0 : Number(match[1]) } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.version - a.version);
      if (candidates.length === 0) continue;
      results.push({ id: session.name, file: join(sessionDir, candidates[0].name), version: candidates[0].version });
    }
  }
  return results;
}

/**
 * Fold one log exactly like Harness's tokenUsage projection:
 * assistant/message and assistant/attempt usage, with retry replacement.
 * Returns the billed rows with their settlement timestamps so a caller can
 * compare any time window.
 */
function foldLog(events) {
  const rows = [];
  let last = null;
  for (const event of events) {
    if (event.type === 'llm/retry-started') {
      if (last && last.turn === event.data?.turn && last.step === event.data?.step) last = null;
      continue;
    }
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    let usage = event.type === 'assistant/message' ? event.data?.usage : undefined;
    if (!usage && Array.isArray(event.data?.stream)) {
      for (let index = event.data.stream.length - 1; index >= 0; index -= 1) {
        const record = event.data.stream[index];
        if (record?.type === 'chunk' && record.chunk?.type === 'usage') {
          usage = record.chunk.usage;
          break;
        }
      }
    }
    if (!usage) continue;
    const bucket = {
      t: event.time,
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
    };
    const same = last && last.turn === event.data?.turn && last.step === event.data?.step;
    if (same) {
      const previous = last.row;
      if (
        previous.input === bucket.input &&
        previous.output === bucket.output &&
        previous.cacheRead === bucket.cacheRead &&
        previous.cacheWrite === bucket.cacheWrite
      ) {
        continue;
      }
      rows.pop();
    }
    rows.push(bucket);
    last = { turn: event.data?.turn, step: event.data?.step, row: bucket };
  }
  return rows;
}

/** Sum rows inside one inclusive time window. */
function sumRows(rows, from, to) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  for (const row of rows) {
    if (row.t < from || row.t > to) continue;
    totals.input += row.input;
    totals.output += row.output;
    totals.cacheRead += row.cacheRead;
    totals.cacheWrite += row.cacheWrite;
    totals.requests += 1;
  }
  return totals;
}

/** Harness's own durable projection cache totals, keyed by session id. */
function readProjectionCache() {
  const dir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
  const map = new Map();
  let files = [];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return map;
  }
  for (const name of files) {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const totals = record.record?.rows?.tokenUsage?.val?.totals;
      if (totals) map.set(name.replace(/\.json$/, ''), totals);
    } catch {
      // A corrupt cache checkpoint is Harness's concern; skip it here.
    }
  }
  return map;
}

log('\n[3] independent log + projection-cache cross-check');
let logs = [];
try {
  logs = listSessionLogs(join(DSH_HOME, 'sessions'));
} catch (error) {
  console.error(`Cannot list session logs: ${error.message}`);
  process.exit(1);
}
const projections = readProjectionCache();
const parsed = new Map();
let parseErrors = 0;
for (const entry of logs) {
  try {
    parsed.set(entry.id, {
      rows: foldLog(readLog(entry.file)),
      file: entry.file,
      version: entry.version,
    });
  } catch (error) {
    parseErrors += 1;
    log(`  note unreadable log ${entry.id}: ${error.message}`);
  }
}
log(`  parsed ${parsed.size} of ${logs.length} stored sessions (${parseErrors} unreadable)`);

let projectionCompared = 0;
let projectionMismatch = 0;
for (const [id, value] of parsed) {
  const cache = projections.get(id);
  if (!cache) continue;
  projectionCompared += 1;
  const parseTotals = sumRows(value.rows, 0, Number.MAX_SAFE_INTEGER);
  // The cache checkpoint can trail the log for a live session; the parse may
  // therefore be ahead by the tail. A parse below the cache is always wrong.
  const behind =
    parseTotals.input < cache.uncachedInputTokens ||
    parseTotals.output < cache.outputTokens ||
    parseTotals.cacheRead < cache.cacheReadTokens ||
    parseTotals.cacheWrite < cache.cacheWriteTokens;
  if (behind) {
    projectionMismatch += 1;
    log(`  FAIL ${id}: parsed totals are below Harness's projection cache`);
    log(`       cache=${JSON.stringify(cache)} parsed=${JSON.stringify(parseTotals)}`);
  }
}
check(projectionCompared > 0, `compared ${projectionCompared} sessions against Harness's projection cache`);
check(projectionMismatch === 0, `reconciled with Harness's projection cache (${projectionCompared - projectionMismatch}/${projectionCompared})`);

// Compare a window that is safely inside the plugin's retention period and
// older than the live write/scan tail, so both sides must agree exactly.
const compareFrom = retentionCutoff + 86_400_000;
const compareTo = Date.now() - 120_000;
const engineRowsInWindow = engineRows.filter((row) => row.t >= compareFrom && row.t <= compareTo);
const engineWindow = new Map();
for (const row of engineRowsInWindow) {
  const bucket = engineWindow.get(row.sid) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  bucket.input += row.input;
  bucket.output += row.output;
  bucket.cacheRead += row.cacheRead ?? 0;
  bucket.cacheWrite += row.cacheWrite ?? 0;
  bucket.requests += 1;
  engineWindow.set(row.sid, bucket);
}
let engineMismatch = 0;
let engineCompared = 0;
for (const [id, value] of parsed) {
  const parseTotals = sumRows(value.rows, compareFrom, compareTo);
  const engineTotals = engineWindow.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  if (parseTotals.requests === 0 && engineTotals.requests === 0) continue;
  engineCompared += 1;
  if (
    engineTotals.input !== parseTotals.input ||
    engineTotals.output !== parseTotals.output ||
    engineTotals.cacheRead !== parseTotals.cacheRead ||
    engineTotals.cacheWrite !== parseTotals.cacheWrite ||
    engineTotals.requests !== parseTotals.requests
  ) {
    engineMismatch += 1;
    log(`  FAIL ${id}: plugin samples disagree with the independent parse`);
    log(`       plugin=${JSON.stringify(engineTotals)} parse=${JSON.stringify(parseTotals)}`);
  }
}
check(engineCompared > 0, `compared ${engineCompared} sessions in a settled window against independent parsing`);
check(engineMismatch === 0, `plugin state matches independent parsing (${engineCompared - engineMismatch}/${engineCompared})`);

const fileCount = logs.length;
const newest = logs.reduce((max, entry) => Math.max(max, statSync(entry.file).mtimeMs), 0);
log(`\n  session logs: ${fileCount}; newest log write: ${new Date(newest).toISOString()}`);
if (status.balance?.state === 'ready') {
  log(`  wallet: ${status.balance.primary.amount} ${status.balance.primary.currency} (+ ${status.balance.bonusWallets?.map((wallet) => wallet.balance).join(', ') || '0'} bonus)`);
}
log(`  cache hit rate (1h): ${status.cache.hitRate === null ? 'n/a' : `${(status.cache.hitRate * 100).toFixed(2)}%`}`);
log(`  estimated last 24h: ${status.cost.windows.last24h.estimated} ${status.cost.currency}`);

if (failures > 0) {
  console.error(`\nVERIFY FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
log('\nVERIFY OK: plugin status, plugin state, raw logs and Harness projection cache agree.');
