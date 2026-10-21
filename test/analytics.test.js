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

test('burn rate compares the last hour to a median active baseline', () => {
  const sessions = { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - 30 * HOUR }) };
  const rows = [];
  // Ten active 5-minute buckets 20 hours ago: a real, if light, working history.
  for (let bucket = 0; bucket < 10; bucket += 1) {
    for (let request = 0; request < 4; request += 1) {
      rows.push(row({ t: NOW - 20 * HOUR + bucket * 5 * 60_000 + request * 30_000, step: 1000 + bucket * 10 + request, input: 100, cacheRead: 9000, output: 50 }));
    }
  }
  // A normal but heavy task now: 120 requests in 30 minutes, cache healthy.
  for (let request = 0; request < 120; request += 1) {
    rows.push(row({ t: NOW - 30 * 60_000 + request * 15_000, step: request, input: 100, cacheRead: 9000, output: 50 }));
  }
  const snapshot = build(baseState(rows, sessions));
  assert.equal(snapshot.burn.activeBaseline.status, 'ready');
  assert.ok(snapshot.burn.activeRatio > 2, 'active ratio reflects the hot hour');
  assert.equal(snapshot.burn.level, 'notice', 'high burn alone is a notice, not an anomaly');
  assert.equal(snapshot.status, 'notice');
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

// ---------------------------------------------------------------------------
// v0.1.1 anomaly-quality scenarios
// ---------------------------------------------------------------------------

/**
 * Ten active 5-minute buckets ~20h ago, four requests each. Gives the active
 * baseline enough buckets, requests and coverage to be "ready".
 */
function historyRows({ input = 100, cacheRead = 9000, output = 50 } = {}) {
  const rows = [];
  for (let bucket = 0; bucket < 10; bucket += 1) {
    for (let request = 0; request < 4; request += 1) {
      rows.push(
        row({
          t: NOW - 20 * HOUR + bucket * 5 * 60_000 + request * 30_000,
          step: 1000 + bucket * 10 + request,
          input,
          cacheRead,
          output,
        }),
      );
    }
  }
  return rows;
}

/** Requests spread over the last 30 minutes (default: 60). */
function recentRows({ input = 100, cacheRead = 9000, output = 50, count = 60 } = {}) {
  const rows = [];
  for (let request = 0; request < count; request += 1) {
    const stride = Math.floor((30 * 60_000) / count);
    rows.push(row({ t: NOW - 30 * 60_000 + request * stride, step: request, input, cacheRead, output }));
  }
  return rows;
}

function sessionsFor() {
  return { 'session-a': createSessionRecord({ id: 'session-a', createdAt: NOW - 30 * HOUR, cwd: 'D:\\work\\demo', agentPreset: 'cordis' }) };
}

test('case 1: a normal heavy task is Elevated, not Critical', () => {
  const rows = [...historyRows(), ...recentRows({ count: 120 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.equal(snapshot.burn.activeBaseline.status, 'ready');
  assert.equal(snapshot.cache.health.state, 'healthy');
  assert.equal(snapshot.burn.level, 'notice');
  assert.equal(snapshot.status, 'notice');
  assert.equal(snapshot.assessment.driver, 'workload');
  assert.equal(snapshot.assessment.baselineWarming, false);
  assert.deepEqual(snapshot.assessment.efficiency, []);
  assert.equal(snapshot.alerts.length, 0);
  assert.equal(snapshot.anomalies.filter((anomaly) => anomaly.type === 'burn-rate').length, 0);
});

test('case 2: high burn plus a cache collapse is Critical with evidence', () => {
  const rows = [...historyRows({ input: 1000, cacheRead: 9000 }), ...recentRows({ input: 8000, cacheRead: 2000 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.equal(snapshot.status, 'critical');
  assert.equal(snapshot.burn.level, 'critical');
  assert.equal(snapshot.cache.health.state, 'critical');
  const codes = snapshot.assessment.efficiency.map((entry) => entry.code);
  assert.ok(codes.includes('cache-drop'));
  assert.ok(codes.includes('uncached-burst'));
  assert.ok(snapshot.alerts.some((alert) => ['cache-hit-drop', 'uncached-burst', 'burn-rate'].includes(alert.type)));
  assert.ok(snapshot.cache.diagnosis.some((cause) => cause.code === 'cache-problem-correlated'));
});

test('case 3: a fresh install only warms the baseline up, no false alert', () => {
  const rows = [];
  for (let request = 0; request < 30; request += 1) {
    rows.push(row({ t: NOW - 10 * 60_000 + request * 20_000, step: request }));
  }
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.equal(snapshot.burn.activeBaseline.status, 'warming');
  assert.equal(snapshot.assessment.baselineWarming, true);
  assert.equal(snapshot.burn.level, 'normal');
  assert.equal(snapshot.status, 'normal');
  assert.equal(snapshot.alerts.length, 0);
  assert.ok(snapshot.diagnostics.warnings.some((warning) => warning.includes('warming up')));
  assert.ok(snapshot.burn.activeBaseline.confidence < 1);
});

test('case 4: 99.7% to 99% cache delta stays healthy and neutral', () => {
  const rows = [...historyRows({ input: 30, cacheRead: 9970, output: 20 }), ...recentRows({ input: 100, cacheRead: 9900, output: 20 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.equal(snapshot.cache.deltaClass, 'neutral');
  assert.equal(snapshot.cache.health.state, 'healthy');
  assert.equal(snapshot.cache.deltaVsBaseline < 0, true);
  assert.equal(snapshot.alerts.some((alert) => alert.type === 'cache-hit-drop' || alert.type === 'cache-low'), false);
  assert.notEqual(snapshot.status, 'warning');
  assert.notEqual(snapshot.status, 'critical');
  assert.equal(snapshot.cache.diagnosis.some((cause) => cause.code === 'cache-hit-drop'), false);
});

test('case 5: a request-rate spike with a healthy cache is a workload signal', () => {
  const rows = [...historyRows(), ...recentRows({ count: 120 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.ok(snapshot.assessment.workload.some((entry) => entry.code === 'request-rate'));
  assert.equal(snapshot.assessment.driver, 'workload');
  assert.equal(snapshot.assessment.efficiency.some((entry) => entry.code === 'cache-drop'), false);
  assert.equal(snapshot.cache.health.state, 'healthy');
  assert.ok(['notice', 'normal'].includes(snapshot.status));
  assert.equal(snapshot.alerts.length, 0);
});

test('case 6: a cache drop with an uncached burst is at least Warning', () => {
  const rows = [...historyRows({ input: 1000, cacheRead: 9000 }), ...recentRows({ input: 4000, cacheRead: 8000 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.ok(['warning', 'critical'].includes(snapshot.status));
  assert.ok(['warning', 'critical'].includes(snapshot.burn.level));
  const codes = snapshot.assessment.efficiency.map((entry) => entry.code);
  assert.ok(codes.includes('cache-drop'));
  assert.ok(codes.includes('uncached-burst'));
  assert.ok(snapshot.alerts.length > 0);
});

test('case 7: low-frequency user keeps a huge overall ratio but no false alert', () => {
  // Only ten active buckets in the 23h baseline window: the arithmetic 24h
  // average is tiny, so the old rule would scream. The active baseline sees the
  // real working pace and the moderate hour stays Normal.
  const rows = [...historyRows(), ...recentRows({ count: 60 })];
  const snapshot = build(baseState(rows, sessionsFor()));
  assert.equal(snapshot.burn.activeBaseline.status, 'ready');
  assert.ok(snapshot.burn.overallRatio > 5, 'overall 24h ratio is still dramatic');
  assert.ok(snapshot.burn.activeRatio < 2, 'active ratio shows a normal working pace');
  assert.equal(snapshot.burn.level, 'normal');
  assert.equal(snapshot.status, 'normal');
  assert.equal(snapshot.alerts.length, 0);
  assert.equal(snapshot.anomalies.some((anomaly) => anomaly.type === 'burn-rate'), false);
});
