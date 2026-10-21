import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCacheSavings, estimateUsageCost, isPeak, priceFor, tierOf } from '../lib/pricing.js';

// 2026-10-21 is a Wednesday. Beijing time = UTC+8.
const PEAK_INSTANT = Date.UTC(2026, 9, 21, 2, 30); // 10:30 Beijing -> peak
const OFF_PEAK_INSTANT = Date.UTC(2026, 9, 21, 12, 30); // 20:30 Beijing -> off-peak
const WEEKEND_INSTANT = Date.UTC(2026, 9, 24, 2, 30); // Saturday 10:30 Beijing -> off-peak

test('peak windows follow the official Beijing-time rule', () => {
  assert.equal(isPeak(PEAK_INSTANT), true);
  assert.equal(isPeak(OFF_PEAK_INSTANT), false);
  assert.equal(isPeak(WEEKEND_INSTANT), false);
  assert.equal(isPeak(PEAK_INSTANT, ['2026-10-21']), false, 'configured holiday disables peak');
});

test('model mapping includes legacy ids billed at Flash price', () => {
  assert.equal(tierOf('deepseek-flash'), 'flash');
  assert.equal(tierOf('deepseek-v4-flash'), 'flash');
  assert.equal(tierOf('deepseek-v4-flash-vision-exp'), 'flash');
  assert.equal(tierOf('deepseek-v4-pro'), 'pro');
  assert.equal(tierOf('deepseek-official/deepseek-flash'), 'flash');
  assert.equal(tierOf('some-other-model'), null);
});

test('official CNY prices are applied per direction and peak state', () => {
  const peak = priceFor({ model: 'deepseek-flash', time: PEAK_INSTANT, currency: 'CNY' });
  assert.deepEqual(peak, { cacheHit: 0.04, cacheMiss: 2, output: 8, tier: 'flash', peak: true, overridden: false });
  const offPeak = priceFor({ model: 'deepseek-flash', time: OFF_PEAK_INSTANT, currency: 'CNY' });
  assert.deepEqual(offPeak, { cacheHit: 0.02, cacheMiss: 1, output: 4, tier: 'flash', peak: false, overridden: false });
  const pro = priceFor({ model: 'deepseek-v4-pro', time: PEAK_INSTANT, currency: 'CNY' });
  assert.equal(pro.cacheMiss, 9);
  assert.equal(pro.output, 27);
});

test('official USD prices are applied', () => {
  const usd = priceFor({ model: 'deepseek-flash', time: PEAK_INSTANT, currency: 'USD' });
  assert.equal(usd.cacheHit, 0.006);
  assert.equal(usd.cacheMiss, 0.3);
  assert.equal(usd.output, 1.2);
});

test('user overrides win over the official table', () => {
  const price = priceFor({
    model: 'deepseek-flash',
    time: PEAK_INSTANT,
    currency: 'CNY',
    overrides: { 'deepseek-flash': { cacheHit: 1, cacheMiss: 2, output: 3 } },
  });
  assert.equal(price.overridden, true);
  assert.equal(price.cacheHit, 1);
});

test('usage cost is sum of hit, miss and output components', () => {
  const result = estimateUsageCost({
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
    model: 'deepseek-flash',
    time: PEAK_INSTANT,
    currency: 'CNY',
  });
  assert.equal(result.priced, true);
  assert.equal(result.hit, 0.04);
  assert.equal(result.miss, 2);
  assert.equal(result.output, 8);
  assert.equal(result.total, 10.04);
});

test('unknown models produce no cost and no fabricated price', () => {
  const result = estimateUsageCost({
    usage: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, cacheWriteTokens: 0 },
    model: 'mystery-model',
    time: PEAK_INSTANT,
    currency: 'CNY',
  });
  assert.equal(result.priced, false);
  assert.equal(result.total, 0);
  assert.equal(estimateCacheSavings({ usage: { cacheReadTokens: 1000 }, model: 'mystery-model', time: PEAK_INSTANT, currency: 'CNY' }), null);
});

test('cache savings price hits at the cheaper rate', () => {
  const saved = estimateCacheSavings({
    usage: { cacheReadTokens: 1_000_000 },
    model: 'deepseek-flash',
    time: PEAK_INSTANT,
    currency: 'CNY',
  });
  assert.equal(saved, 1.96); // 1M * (2 - 0.04) / 1M
});
