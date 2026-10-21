import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot } from '../lib/analytics.js';
import { createSessionRecord } from '../lib/ingest.js';
import { DEFAULT_SETTINGS, emptyState } from '../lib/store.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 21, 6, 0); // 14:00 Beijing (peak)

function row({ t, sid = 'session-a', turn = 1, step, input = 100, output = 20, cacheRead = 900, model = 'deepseek-flash' }) {
  return {
    t,
    sid,
    seq: step,
    turn,
    step,
    model,
    provider: 'deepseek-official',
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    attempt: false,
  };
}

function baseState(rows, sessions, history) {
  const state = emptyState(NOW - 48 * HOUR);
  state.requests = rows;
  state.sessions = sessions;
  state.balance.history = history ?? { CNY: [[NOW - 3 * HOUR, 100], [NOW - 2 * HOUR, 99.8], [NOW - HOUR, 99.7], [NOW, 99.4]] };
  state.balance.lastWallets = [{ currency: 'CNY', balance: '99.40' }];
  state.balance.lastFetchedAt = NOW;
  return state;
}

function balanceView() {
  return {
    state: 'ready',
    wallets: [{ currency: 'CNY', balance: '99.40' }],
    bonusWallets: [],
    primary: { currency: 'CNY', amount: 99.4 },
    totalAll: 99.4,
    currency: 'CNY',
    fetchedAt: NOW,
    error: null,
  };
}

function build(state, extra = {}) {
  return buildSnapshot({
    state,
    settings: { ...DEFAULT_SETTINGS },
    locale: 'en',
    now: NOW,
    balance: balanceView(),
    scan: { startedAt: NOW - 10_000, finishedAt: NOW - 1000, inProgress: false, sessions: 2, errors: 0 },
    range: '24h',
    ...extra,
  });
}

test('empty state still produces a complete, honest snapshot', () => {
  const snapshot = build(baseState([], {}, { CNY: [] }));
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.diagnostics.data.requestsInRetention, 0);
  assert.equal(snapshot.cache.hitRate, null);
  assert.equal(snapshot.balance.state, 'ready');
  assert.equal(snapshot.models.length, 0);
  assert.ok(snapshot.diagnostics.warnings.some((warning) => warning.includes('No usage samples')));
});

test('cache hit rate and window tokens are derived from provider counters', () => {
  const sessions = {
    'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR, cwd: 'D:\\work', agentPreset: 'cordis' }),
  };
  const rows = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push(row({ t: NOW - 50 * 60_000 + index * 60_000, step: index }));
  }
  const snapshot = build(baseState(rows, sessions));
  assert.equal(snapshot.cache.last1h.hitTokens, 9000);
  assert.equal(snapshot.cache.last1h.missTokens, 1000);
  assert.equal(snapshot.cache.last1h.hitRate, 0.9);
  assert.equal(snapshot.cache.last1h.requests, 10);
  assert.equal(snapshot.series.points.length > 0, true);
  assert.equal(snapshot.models[0].model, 'deepseek-flash');
  assert.equal(snapshot.consumers.sessions[0].key, 'session-a');
  assert.equal(snapshot.consumers.sessions[0].hitRate, 0.9);
});

test('cost windows are estimated and observed independently', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR }) };
  const rows = [row({ t: NOW - 10 * 60_000, step: 1 })];
  const snapshot = build(baseState(rows, sessions));
  const lastHour = snapshot.cost.windows.lastHour;
  assert.ok(lastHour.estimated > 0, 'estimated cost uses the official price table');
  assert.equal(lastHour.tokens, 120);
  // History has samples within the hour; observed spend is real wallet decrease.
  assert.ok(lastHour.observed > 0);
  assert.equal(typeof lastHour.observedComplete, 'boolean');
});

test('burn ratio compares the last hour to the previous 23h baseline', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - 30 * HOUR }) };
  const rows = [];
  // Quiet day: one small request every hour for 20 hours.
  for (let index = 0; index < 20; index += 1) rows.push(row({ t: NOW - (index + 2) * HOUR, step: index, input: 100, cacheRead: 900 }));
  // Hot last hour.
  for (let index = 0; index < 20; index += 1) rows.push(row({ t: NOW - 55 * 60_000 + index * 60_000, step: 100 + index, input: 5000, cacheRead: 100_000 }));
  const snapshot = build(baseState(rows, sessions));
  assert.ok(snapshot.burn.ratio > 2, 'burn ratio reflects the hot hour');
  assert.ok(['warning', 'critical'].includes(snapshot.burn.level));
});

test('cache diagnosis only reports causes with recorded evidence', () => {
  const record = createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR, agentPreset: 'cordis' });
  record.signals.systemHashes = ['aaa', 'bbb', 'ccc'];
  record.signals.requestHeaders.change = 3;
  record.signals.models = ['deepseek-flash', 'deepseek-v4-pro'];
  record.signals.uuidHits = 2;
  const sessions = { 'session-a': record };
  const rows = [];
  // Quiet baseline earlier in the day with a high cache hit rate.
  for (let index = 0; index < 60; index += 1) {
    rows.push(row({ t: NOW - 20 * HOUR + index * 60_000, step: 1000 + index, input: 100, cacheRead: 9900 }));
  }
  // Recent hour with a much worse hit rate and uncached tokens.
  for (let index = 0; index < 20; index += 1) {
    rows.push(row({ t: NOW - 50 * 60_000 + index * 60_000, step: index, input: 2000, cacheRead: 1000 }));
  }
  const snapshot = build(baseState(rows, sessions));
  const codes = snapshot.cache.diagnosis.map((cause) => cause.code);
  assert.ok(codes.includes('request-epoch-change'));
  assert.ok(codes.includes('system-prompt-changing'));
  assert.ok(codes.includes('model-switch'));
  assert.ok(codes.includes('uuid-or-timestamp-in-prefix'));
  const evidence = snapshot.cache.diagnosis.find((cause) => cause.code === 'request-epoch-change');
  assert.equal(evidence.evidence.headerChanges, 3);
  assert.equal(JSON.stringify(snapshot).includes('sk-'), false);
});

test('a low cache rate becomes an alert only after the sustained window', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR, agentPreset: 'cordis' }) };
  const rows = [];
  for (let index = 0; index < 20; index += 1) {
    rows.push(row({ t: NOW - 50 * 60_000 + index * 60_000, step: index, input: 2000, cacheRead: 1000 }));
  }
  const state = baseState(rows, sessions);
  const first = build(state);
  assert.equal(first.cache.hitRate < 0.5, true, 'fixture is below the default warning rate');
  assert.equal(first.alerts.some((alert) => alert.type === 'cache-low'), false, 'not sustained yet');
  // Advance 11 minutes with continued low cache traffic in the fresh hour.
  for (let index = 0; index < 11; index += 1) {
    rows.push(row({ t: NOW + index * 60_000, step: 200 + index, input: 2000, cacheRead: 1000 }));
  }
  const later = NOW + 11 * 60_000;
  const second = build(state, { now: later });
  const alert = second.alerts.find((entry) => entry.type === 'cache-low');
  assert.ok(alert, 'sustained cache-low alert fires after cacheAlertMinutes');
  assert.ok(second.anomalies.some((entry) => entry.type === 'cache-low'));
  assert.ok(alert.since <= NOW + 60_000, 'the alert start is the first breach, not the first sustained check');
});

test('forecast uses the recent burn and reports an estimate basis', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR }) };
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push(row({ t: NOW - 30 * 60_000 + index * 20_000, step: index, input: 1000, cacheRead: 10_000 }));
  }
  const snapshot = build(baseState(rows, sessions));
  assert.ok(snapshot.forecast.dailyCost > 0);
  assert.equal(snapshot.forecast.note, 'Estimate based on recent usage.');
  assert.ok(snapshot.forecast.daysRemaining > 0);
});

test('unknown models are reported as unpriced without invented cost', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR }) };
  const rows = [row({ t: NOW - 5 * 60_000, step: 1, model: 'private-model' })];
  const snapshot = build(baseState(rows, sessions));
  assert.equal(snapshot.models[0].priced, false);
  assert.equal(snapshot.models[0].cost, 0);
  assert.ok(snapshot.diagnostics.warnings.some((warning) => warning.includes('private-model')));
});

test('range selection changes the series resolution', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - HOUR }) };
  const rows = [row({ t: NOW - 5 * 60_000, step: 1 })];
  const day = build(baseState(rows, sessions), { range: '24h' });
  const week = build(baseState(rows, sessions), { range: '7d' });
  assert.equal(day.series.range, '24h');
  assert.equal(day.series.bucketMs, 15 * 60_000);
  assert.equal(week.series.range, '7d');
  assert.equal(week.series.bucketMs, HOUR);
});
