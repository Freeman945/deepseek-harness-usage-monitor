/**
 * Pure Session-event folding for usage monitoring.
 *
 * Sources of truth (verified against DeepSeek Harness 0.2.1-rc.2):
 * - `assistant/message` events carry `data.usage: TokenUsage`.
 * - `assistant/attempt` events carry the same usage inside their stream.
 * - `inputTokens` = prompt tokens billed at the cache-MISS rate;
 *   `cacheReadTokens` = prompt cache hits. Harness renders the cache-hit rate
 *   as cacheRead / (input + cacheRead + cacheWrite), and so does this plugin.
 * - A retried request logs `llm/retry-started`; the replacement usage sample
 *   must replace the previous attempt for the same (turn, step) slot instead of
 *   double counting. This mirrors Harness's own `tokenUsage` projection.
 *
 * No prompt text is ever stored. From `system/message` content this module
 * derives a short hash plus UUID/timestamp hit counts only.
 */

import { createHash } from 'node:crypto';

const MAX_SYSTEM_HASHES = 64;
const MAX_MODELS = 16;
const MAX_TOOL_COUNTS = 16;

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN = /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g;

/**
 * One request sample derived from a durable Session event.
 * @typedef {object} RequestRow
 * @property {number} t settlement time (epoch ms)
 * @property {string} sid session id
 * @property {number} seq Session event sequence
 * @property {number} turn
 * @property {number} step
 * @property {string} model
 * @property {string} provider
 * @property {number} input uncached input tokens
 * @property {number} output output tokens
 * @property {number} cacheRead cached input tokens
 * @property {number} cacheWrite cache-write tokens
 * @property {boolean} attempt true when the event was a failed/interrupted attempt
 */

/**
 * @typedef {object} SessionSignals
 * @property {number} systemMessages
 * @property {string[]} systemHashes
 * @property {{ initial: number, resume: number, change: number, series: number }} requestHeaders
 * @property {number[]} toolCounts distinct tool-list sizes seen in request headers
 * @property {string[]} models distinct model ids seen
 * @property {number} compactions
 * @property {number} turns
 * @property {number} userMessages
 * @property {number} uuidHits
 * @property {number} timestampHits
 * @property {number} cacheReported
 * @property {number} cacheMissing
 * @property {number} gapCount gaps between consecutive usage samples
 * @property {number} gapOver30m
 * @property {number} afterGapSamples
 * @property {number} afterGapHit
 * @property {number} afterGapMiss
 * @property {number | null} lastEntryAt
 */

/**
 * @typedef {object} SessionRecord
 * @property {string} id
 * @property {string | null} title
 * @property {string | null} cwd
 * @property {string | null} preset
 * @property {'subagent' | null} origin
 * @property {string | null} parent
 * @property {number} depth
 * @property {number} createdAt
 * @property {number} lastSeq
 * @property {number} lastAt
 * @property {string | null} revision
 * @property {{ turn: number, step: number, seq: number, buckets: object } | null} fold
 * @property {SessionSignals} signals
 */

/** @returns {SessionSignals} */
export function blankSignals() {
  return {
    systemMessages: 0,
    systemHashes: [],
    requestHeaders: { initial: 0, resume: 0, change: 0, series: 0 },
    toolCounts: [],
    models: [],
    compactions: 0,
    turns: 0,
    userMessages: 0,
    uuidHits: 0,
    timestampHits: 0,
    cacheReported: 0,
    cacheMissing: 0,
    gapCount: 0,
    gapOver30m: 0,
    afterGapSamples: 0,
    afterGapHit: 0,
    afterGapMiss: 0,
    lastEntryAt: null,
  };
}

/**
 * Build a fresh session record from a Harness SessionHeader.
 * @param {object} header
 * @returns {SessionRecord}
 */
export function createSessionRecord(header) {
  return {
    id: String(header.id),
    title: null,
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    origin: header.origin === 'subagent' ? 'subagent' : null,
    parent: typeof header.parentSession === 'string' ? header.parentSession : null,
    depth: Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : Date.now(),
    lastSeq: -1,
    lastAt: 0,
    revision: null,
    fold: null,
    signals: blankSignals(),
  };
}

/**
 * Read the last `usage` chunk embedded in an assistant stream. This is the
 * fallback for events whose top-level `usage` is absent (attempts, interrupted
 * settlements).
 * @param {unknown} stream
 * @returns {object | null}
 */
export function lastUsageFromStream(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
      return record.chunk.usage ?? null;
    }
  }
  return null;
}

/**
 * Normalize a raw TokenUsage into the four counters this plugin aggregates.
 * @param {object | null | undefined} usage
 * @returns {{ input: number, output: number, cacheRead: number, cacheWrite: number } | null}
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const read = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  const normalized = {
    input: read(usage.inputTokens),
    output: read(usage.outputTokens),
    cacheRead: read(usage.cacheReadTokens),
    cacheWrite: read(usage.cacheWriteTokens),
  };
  if (normalized.input + normalized.output + normalized.cacheRead + normalized.cacheWrite === 0) return null;
  return normalized;
}

/**
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number }} a
 * @param {{ input: number, output: number, cacheRead: number, cacheWrite: number } | null} b
 */
function sameBuckets(a, b) {
  return b !== null && a.input === b.input && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/**
 * Extract concatenated text from MessageBase content blocks.
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block && block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * One system prompt hash plus UUID / timestamp occurrence counts.
 * The text itself is discarded immediately.
 * @param {unknown} content
 * @returns {{ hash: string, uuid: number, timestamp: number }}
 */
export function fingerprintSystemContent(content) {
  const text = textOf(content);
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const uuid = (text.match(UUID_PATTERN) ?? []).length;
  const timestamp = (text.match(TIMESTAMP_PATTERN) ?? []).length;
  return { hash, uuid, timestamp };
}

/**
 * Add one distinct value to a bounded array.
 * @template T
 * @param {T[]} list
 * @param {T} value
 * @param {number} limit
 */
function pushDistinct(list, value, limit) {
  if (value === null || value === undefined) return;
  if (list.includes(value)) return;
  if (list.length >= limit) list.shift();
  list.push(value);
}

/**
 * Fold one Session event into a session record.
 *
 * Returns the row to add (if this event settles usage) and the seq of a row the
 * new one replaces (retry dedupe), so the caller can update its entry index.
 * @param {SessionRecord} record
 * @param {any} event
 * @returns {{ add: RequestRow | null, removeSeq: number | null }}
 */
export function foldSessionEvent(record, event) {
  if (!event || typeof event !== 'object') return { add: null, removeSeq: null };
  const seq = Number.isFinite(event.seq) ? event.seq : -1;
  const time = Number.isFinite(event.time) ? event.time : Date.now();
  if (seq > record.lastSeq) record.lastSeq = seq;
  if (time > record.lastAt) record.lastAt = time;
  const signals = record.signals;

  switch (event.type) {
    case 'session/title': {
      if (typeof event.data?.title === 'string') record.title = event.data.title;
      return { add: null, removeSeq: null };
    }
    case 'turn/start': {
      signals.turns += 1;
      return { add: null, removeSeq: null };
    }
    case 'user/message': {
      signals.userMessages += 1;
      return { add: null, removeSeq: null };
    }
    case 'compaction/start': {
      signals.compactions += 1;
      return { add: null, removeSeq: null };
    }
    case 'system/message': {
      signals.systemMessages += 1;
      const fingerprint = fingerprintSystemContent(event.data?.message?.content);
      if (signals.systemHashes.length < MAX_SYSTEM_HASHES && !signals.systemHashes.includes(fingerprint.hash)) {
        signals.systemHashes.push(fingerprint.hash);
      }
      signals.uuidHits += fingerprint.uuid;
      signals.timestampHits += fingerprint.timestamp;
      return { add: null, removeSeq: null };
    }
    case 'request/header': {
      const reason = event.data?.reason;
      if (reason === 'initial' || reason === 'resume' || reason === 'change' || reason === 'series') {
        signals.requestHeaders[reason] += 1;
      }
      const tools = event.data?.header?.tools;
      if (Array.isArray(tools)) pushDistinct(signals.toolCounts, tools.length, MAX_TOOL_COUNTS);
      return { add: null, removeSeq: null };
    }
    case 'llm/retry-started': {
      const fold = record.fold;
      if (fold !== null && fold.turn === event.data?.turn && fold.step === event.data?.step) record.fold = null;
      return { add: null, removeSeq: null };
    }
    case 'assistant/message':
    case 'assistant/attempt': {
      const usage =
        event.type === 'assistant/message'
          ? normalizeUsage(event.data?.usage) ?? normalizeUsage(lastUsageFromStream(event.data?.stream))
          : normalizeUsage(lastUsageFromStream(event.data?.stream));
      if (usage === null) return { add: null, removeSeq: null };
      const turn = Number.isFinite(event.data?.turn) ? event.data.turn : 0;
      const step = Number.isFinite(event.data?.step) ? event.data.step : 0;
      const fold = record.fold;
      const sameSlot = fold !== null && fold.turn === turn && fold.step === step;
      if (sameSlot && sameBuckets(usage, fold.buckets)) return { add: null, removeSeq: null };
      const model = event.data?.message?.source?.model;
      const provider = event.data?.message?.source?.provider;
      if (typeof model === 'string' && model.length > 0) pushDistinct(signals.models, model, MAX_MODELS);
      if (usage.cacheRead > 0 || usage.cacheWrite > 0) signals.cacheReported += 1;
      else signals.cacheMissing += 1;

      // Cache-TTL evidence: a long gap before a request usually means the
      // provider cache expired; record the first sample after each gap.
      const previousAt = signals.lastEntryAt;
      if (previousAt !== null && time > previousAt) {
        const gap = time - previousAt;
        signals.gapCount += 1;
        if (gap > 30 * 60_000) {
          signals.gapOver30m += 1;
          signals.afterGapSamples += 1;
          signals.afterGapHit += usage.cacheRead;
          signals.afterGapMiss += usage.input;
        }
      }
      signals.lastEntryAt = time;

      const row = {
        t: time,
        sid: record.id,
        seq,
        turn,
        step,
        model: typeof model === 'string' ? model : 'unknown',
        provider: typeof provider === 'string' ? provider : '',
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        attempt: event.type === 'assistant/attempt',
      };
      const removeSeq = sameSlot ? fold.seq : null;
      record.fold = { turn, step, seq, buckets: usage };
      return { add: row, removeSeq };
    }
    default:
      return { add: null, removeSeq: null };
  }
}

/**
 * Cache-hit rate from the four counters.
 * @param {{ cacheRead: number, input: number, cacheWrite: number }} counters
 * @returns {number | null}
 */
export function hitRateOf(counters) {
  const denominator = counters.cacheRead + counters.input + counters.cacheWrite;
  if (!(denominator > 0)) return null;
  return counters.cacheRead / denominator;
}
