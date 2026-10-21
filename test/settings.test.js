import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, emptyState, normalizeSettings, normalizeState, resolveCurrency } from '../lib/store.js';

test('settings clamp unsafe values and keep defaults', () => {
  const { settings, errors } = normalizeSettings({
    balanceRefreshSeconds: 5,
    warningBurnRatio: 3,
    criticalBurnRatio: 2,
    cacheWarningRate: 20, // percent input -> 0.2
    retentionDays: 99,
    balanceAlerts: [50, -20, 10, 'x'],
    holidays: ['2026-10-01', 'nope'],
  });
  assert.equal(settings.balanceRefreshSeconds, 20);
  assert.equal(settings.warningBurnRatio, 3);
  assert.equal(settings.criticalBurnRatio, 3, 'critical is raised to warning');
  assert.equal(settings.cacheWarningRate, 0.2);
  assert.equal(settings.retentionDays, 30);
  assert.deepEqual(settings.balanceAlerts, [50, 10]);
  assert.deepEqual(settings.holidays, ['2026-10-01']);
  assert.ok(errors.length >= 2);
});

test('unknown settings keys are dropped', () => {
  const { settings } = normalizeSettings({ attacker: '<script>' });
  assert.equal('attacker' in settings, false);
  assert.equal(JSON.stringify(settings).includes('<script>'), false);
});

test('pricing overrides are validated per model', () => {
  const { settings, errors } = normalizeSettings({
    pricingOverrides: {
      'deepseek-flash': { cacheHit: 1, cacheMiss: 2, output: 3 },
      bad: { cacheHit: -1 },
    },
  });
  assert.deepEqual(settings.pricingOverrides['deepseek-flash'], { cacheHit: 1, cacheMiss: 2, output: 3 });
  assert.equal('bad' in settings.pricingOverrides, false);
  assert.equal(errors.length, 1);
});

test('currency resolution never converts between currencies', () => {
  assert.equal(resolveCurrency({ ...DEFAULT_SETTINGS, currency: 'auto' }, { currency: 'CNY' }), 'CNY');
  assert.equal(resolveCurrency({ ...DEFAULT_SETTINGS, currency: 'auto' }, { currency: 'USD' }), 'USD');
  assert.equal(resolveCurrency({ ...DEFAULT_SETTINGS, currency: 'auto' }, null), 'USD');
  assert.equal(resolveCurrency({ ...DEFAULT_SETTINGS, currency: 'CNY' }, { currency: 'USD' }), 'CNY');
});

test('state normalization drops a foreign version instead of guessing', () => {
  const current = emptyState();
  assert.equal(normalizeState({ ...current, version: 99 }).version, 1);
  assert.equal(normalizeState(null).requests.length, 0);
  const validRow = { t: 1, sid: 'session-a', seq: 2, turn: 1, step: 1, model: 'deepseek-flash', provider: '', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, attempt: false };
  const restored = normalizeState({ ...current, requests: [validRow, { junk: true }], sessions: { a: {} } });
  assert.equal(restored.requests.length, 1);
  assert.deepEqual(restored.sessions, { a: {} });
});

test('v0.1.1 anomaly settings load with safe defaults from an old settings file', () => {
  // An old settings.json has none of the new keys; normalizeSettings must fill
  // them, not fail, and must keep the v0.1.0 values.
  const oldFile = {
    currency: 'CNY',
    warningBurnRatio: 2,
    criticalBurnRatio: 4.5,
    cacheWarningRate: 0.5,
    cacheCriticalRate: 0.3,
  };
  const { settings, errors } = normalizeSettings(oldFile, DEFAULT_SETTINGS);
  assert.equal(settings.currency, 'CNY');
  assert.equal(settings.minimumActiveRequests, 1);
  assert.equal(settings.minActiveBuckets, 6);
  assert.equal(settings.cacheDeltaDeadband, 0.05);
  assert.equal(settings.cacheDeltaNotice, 0.15);
  assert.equal(settings.cacheHealthyRate, 0.9);
  assert.equal(settings.criticalRequiresSecondaryEvidence, true);
  assert.equal(errors.length, 0);
});

test('v0.1.1 settings are clamped and cross-field rules hold', () => {
  const { settings, errors } = normalizeSettings({
    minimumActiveRequests: 9999,
    minActiveBuckets: 1,
    cacheDeltaDeadband: 0.4,
    cacheDeltaNotice: 0.1,
    cacheHealthyRate: 100,
    criticalRequiresSecondaryEvidence: false,
    uncachedBurstMultiplier: 0.1,
    sessionDominanceShare: 2,
  });
  assert.equal(settings.minimumActiveRequests, 1000);
  assert.equal(settings.minActiveBuckets, 2);
  assert.equal(settings.cacheDeltaNotice > settings.cacheDeltaDeadband, true);
  assert.equal(settings.cacheHealthyRate, 1);
  assert.equal(settings.criticalRequiresSecondaryEvidence, false);
  assert.equal(settings.uncachedBurstMultiplier, 1.2);
  assert.equal(settings.sessionDominanceShare, 1);
  assert.ok(errors.length >= 1);
});
