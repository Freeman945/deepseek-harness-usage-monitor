import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankSignals,
  createSessionRecord,
  fingerprintSystemContent,
  foldSessionEvent,
  hitRateOf,
  lastUsageFromStream,
  normalizeUsage,
} from '../lib/ingest.js';

function message({ seq, time, turn = 1, step = 1, usage, model = 'deepseek-flash', provider = 'deepseek-official' }) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn, step, usage, message: { source: { model, provider } }, stream: [] },
  };
}

test('normalizeUsage rejects empty or invalid samples', () => {
  assert.equal(normalizeUsage(undefined), null);
  assert.equal(normalizeUsage({ inputTokens: 0, outputTokens: 0 }), null);
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 }), {
    input: 10,
    output: 2,
    cacheRead: 30,
    cacheWrite: 0,
  });
});

test('lastUsageFromStream finds the final usage chunk', () => {
  const stream = [
    { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [] },
    { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } } },
  ];
  assert.deepEqual(lastUsageFromStream(stream), { inputTokens: 5, outputTokens: 6 });
  assert.equal(lastUsageFromStream([]), null);
});

test('cache hit rate uses cached / (cached + uncached + write)', () => {
  assert.equal(hitRateOf({ cacheRead: 82, input: 18, cacheWrite: 0 }), 0.82);
  assert.equal(hitRateOf({ cacheRead: 0, input: 0, cacheWrite: 0 }), null);
});

test('assistant messages become request rows with model identity', () => {
  const record = createSessionRecord({ id: 'session-a', createdAt: 1, cwd: 'D:\\x', agentPreset: 'cordis' });
  const result = foldSessionEvent(record, message({ seq: 3, time: 1000, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } }));
  assert.equal(result.removeSeq, null);
  assert.equal(result.add.sid, 'session-a');
  assert.equal(result.add.input, 100);
  assert.equal(result.add.cacheRead, 900);
  assert.equal(result.add.model, 'deepseek-flash');
  assert.equal(record.lastSeq, 3);
});

test('a retry replacement does not double count the same slot', () => {
  const record = createSessionRecord({ id: 'session-b', createdAt: 1 });
  const first = foldSessionEvent(record, message({ seq: 5, time: 1000, usage: { inputTokens: 100, outputTokens: 10 } }));
  assert.ok(first.add);
  // Same (turn, step) with different counters: replaces the previous sample.
  const second = foldSessionEvent(record, message({ seq: 6, time: 2000, usage: { inputTokens: 120, outputTokens: 12 } }));
  assert.equal(second.removeSeq, 5);
  assert.equal(second.add.seq, 6);
  // Same counters again: no new row.
  const third = foldSessionEvent(record, message({ seq: 7, time: 3000, usage: { inputTokens: 120, outputTokens: 12 } }));
  assert.equal(third.add, null);
});

test('llm/retry-started closes the replacement slot so the retry adds usage', () => {
  const record = createSessionRecord({ id: 'session-c', createdAt: 1 });
  foldSessionEvent(record, message({ seq: 5, time: 1000, usage: { inputTokens: 100, outputTokens: 10 } }));
  foldSessionEvent(record, { type: 'llm/retry-started', seq: 6, time: 1500, data: { turn: 1, step: 1 } });
  const retry = foldSessionEvent(record, message({ seq: 7, time: 2000, usage: { inputTokens: 30, outputTokens: 5 } }));
  assert.ok(retry.add, 'retried attempt is billed separately');
  assert.equal(retry.removeSeq, null);
});

test('assistant attempts read usage from the stream', () => {
  const record = createSessionRecord({ id: 'session-d', createdAt: 1 });
  const event = {
    type: 'assistant/attempt',
    seq: 9,
    time: 5000,
    data: {
      turn: 2,
      step: 3,
      stream: [{ type: 'chunk', time: 4, chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 3 } } }],
    },
  };
  const result = foldSessionEvent(record, event);
  assert.equal(result.add.attempt, true);
  assert.equal(result.add.input, 7);
});

test('system prompts are fingerprinted without storing their text', () => {
  const content = [
    { type: 'text', text: 'Request id 123e4567-e89b-12d3-a456-426614174000 at 2026-10-21T10:00 generated this prompt.' },
  ];
  const fingerprint = fingerprintSystemContent(content);
  assert.equal(fingerprint.uuid, 1);
  assert.equal(fingerprint.timestamp, 1);
  assert.match(fingerprint.hash, /^[0-9a-f]{16}$/);
  const record = createSessionRecord({ id: 'session-e', createdAt: 1 });
  foldSessionEvent(record, { type: 'system/message', seq: 1, time: 1, data: { message: { content } } });
  assert.equal(record.signals.systemMessages, 1);
  assert.equal(record.signals.uuidHits, 1);
  assert.equal(record.signals.systemHashes.length, 1);
  assert.equal(JSON.stringify(record).includes('Request id'), false, 'prompt text must never enter the record');
});

test('long request gaps are recorded as cache-TTL evidence', () => {
  const record = createSessionRecord({ id: 'session-f', createdAt: 1 });
  foldSessionEvent(record, message({ seq: 1, time: 1_000_000, usage: { inputTokens: 10, outputTokens: 1 } }));
  foldSessionEvent(record, message({ seq: 2, time: 1_000_000 + 31 * 60_000, usage: { inputTokens: 50, outputTokens: 2 } }));
  assert.equal(record.signals.gapOver30m, 1);
  assert.equal(record.signals.afterGapSamples, 1);
  assert.equal(record.signals.afterGapHit, 0);
  assert.equal(record.signals.afterGapMiss, 50);
});

test('blankSignals is a fresh object each time', () => {
  const a = blankSignals();
  const b = blankSignals();
  a.gapCount = 5;
  assert.equal(b.gapCount, 0);
});
