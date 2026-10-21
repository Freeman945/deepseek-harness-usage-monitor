/**
 * DeepSeek model pricing and cost estimation.
 *
 * Source: official DeepSeek API pricing page, captured 2026-10-21.
 *   https://api-docs.deepseek.com/quick_start/pricing/
 *   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * The plugin never invents a price. Every number below is copied from that
 * table; users may override it per model in Settings, and every derived amount
 * is labeled "Est." because it is tokens × price, not a provider-returned bill.
 *
 * Peak / off-peak rule (from the same page):
 *   Peak = Beijing time 09:00-12:00 and 14:00-18:00, Monday through Friday,
 *   excluding Chinese public holidays. Off-peak is half of the peak price and
 *   covers every other hour, weekends and (configured) holidays.
 */

export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const PRICING_AS_OF = '2026-10-21';
export const PRICING_TIME_ZONE = 'Asia/Shanghai';

/** Tier names used by every table entry. */
const TIER_FLASH = 'flash';
const TIER_PRO = 'pro';

/**
 * Prices per 1,000,000 tokens for each supported currency.
 * `cacheHit` = cached input, `cacheMiss` = uncached input, `output` = completion.
 * Peak entries are the official list prices; off-peak is exactly half.
 */
export const OFFICIAL_PRICING = {
  CNY: {
    [TIER_FLASH]: {
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    },
    [TIER_PRO]: {
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
  },
  USD: {
    [TIER_FLASH]: {
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    },
    [TIER_PRO]: {
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    },
  },
};

/** Model id → pricing tier. Legacy ids are billed at the Flash price (official note 1). */
export const MODEL_TIERS = {
  'deepseek-flash': TIER_FLASH,
  'deepseek-v4-flash': TIER_FLASH,
  'deepseek-v4-flash-vision-exp': TIER_FLASH,
  'deepseek-chat': TIER_FLASH,
  'deepseek-v4-pro': TIER_PRO,
  'deepseek-reasoner': TIER_PRO,
};

const CHINA_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: PRICING_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY_INDEX = { Sun: 6, Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5 };

/**
 * Resolve one instant to Beijing date/time fields. Results are cached per
 * minute because a snapshot evaluates thousands of requests at once.
 * @param {number} time epoch ms
 * @returns {{ date: string, weekday: number, hour: number, minute: number }}
 */
const localCache = new Map();
function chinaTime(time) {
  const minuteKey = Math.floor(time / 60000);
  const hit = localCache.get(minuteKey);
  if (hit !== undefined) return hit;
  const parts = CHINA_TIME.formatToParts(new Date(time));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const value = {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
  };
  if (localCache.size > 4096) localCache.clear();
  localCache.set(minuteKey, value);
  return value;
}

/**
 * Whether one instant is billed at the peak rate.
 * Public holidays must be supplied by the user (the official holiday calendar
 * is deployment-specific and changes every year).
 * @param {number} time epoch ms
 * @param {readonly string[]} holidays `YYYY-MM-DD` Beijing dates
 * @returns {boolean}
 */
export function isPeak(time, holidays = []) {
  const { date, weekday, hour, minute } = chinaTime(time);
  if (weekday > 4) return false; // Saturday / Sunday
  if (holidays.includes(date)) return false;
  const minuteOfDay = hour * 60 + minute;
  return (
    (minuteOfDay >= 9 * 60 && minuteOfDay < 12 * 60) ||
    (minuteOfDay >= 14 * 60 && minuteOfDay < 18 * 60)
  );
}

/**
 * Return the tier for a model id, or null when this model has no known price.
 * @param {string} model
 * @returns {'flash' | 'pro' | null}
 */
export function tierOf(model) {
  if (typeof model !== 'string') return null;
  if (MODEL_TIERS[model]) return MODEL_TIERS[model];
  // Provider ids sometimes carry a route prefix, e.g. "deepseek/deepseek-flash".
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : null;
  return tail !== null && MODEL_TIERS[tail] ? MODEL_TIERS[tail] : null;
}

/**
 * Resolve the per-1M prices for one request. User overrides win over the
 * official table; an override may be given per model id or per tier name.
 * @param {object} input
 * @param {string} input.model
 * @param {number} input.time epoch ms
 * @param {'CNY' | 'USD' | string} input.currency
 * @param {Record<string, {cacheHit: number, cacheMiss: number, output: number}>} [input.overrides]
 * @param {readonly string[]} [input.holidays]
 * @returns {{ cacheHit: number, cacheMiss: number, output: number, tier: string, peak: boolean, overridden: boolean } | null}
 */
export function priceFor({ model, time, currency, overrides = {}, holidays = [] }) {
  const tier = tierOf(model);
  if (tier === null) return null;
  const peak = isPeak(time, holidays);
  const table = OFFICIAL_PRICING[currency] ?? OFFICIAL_PRICING.CNY;
  const base = table[tier]?.[peak ? 'peak' : 'offPeak'];
  if (!base) return null;
  const override = overrides?.[model] ?? overrides?.[tier];
  if (override && isValidPriceRow(override)) {
    return { cacheHit: override.cacheHit, cacheMiss: override.cacheMiss, output: override.output, tier, peak, overridden: true };
  }
  return { ...base, tier, peak, overridden: false };
}

/**
 * Validate one user pricing override (per 1M tokens, display currency).
 * @param {unknown} row
 * @returns {row is {cacheHit: number, cacheMiss: number, output: number}}
 */
export function isValidPriceRow(row) {
  if (typeof row !== 'object' || row === null) return false;
  return ['cacheHit', 'cacheMiss', 'output'].every((key) => {
    const value = /** @type {Record<string, unknown>} */ (row)[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  });
}

/**
 * Estimated cost of one provider-reported usage sample.
 * `cacheWriteTokens` are billed at the cache-miss input rate because DeepSeek
 * does not currently charge a separate cache-write price.
 * @param {object} input
 * @param {{inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} input.usage
 * @param {string} input.model
 * @param {number} input.time
 * @param {string} input.currency
 * @param {Record<string, object>} [input.overrides]
 * @param {readonly string[]} [input.holidays]
 * @returns {{ total: number, hit: number, miss: number, output: number, priced: boolean, tier: string | null, peak: boolean | null }}
 */
export function estimateUsageCost({ usage, model, time, currency, overrides = {}, holidays = [] }) {
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const price = priceFor({ model, time, currency, overrides, holidays });
  if (price === null) {
    return { total: 0, hit: 0, miss: 0, output: 0, priced: false, tier: null, peak: null };
  }
  const perMillion = 1_000_000;
  const hit = (cacheRead * price.cacheHit) / perMillion;
  const miss = ((inputTokens + cacheWrite) * price.cacheMiss) / perMillion;
  const output = (outputTokens * price.output) / perMillion;
  return {
    total: hit + miss + output,
    hit,
    miss,
    output,
    priced: true,
    tier: price.tier,
    peak: price.peak,
  };
}

/**
 * Estimated money saved by cache hits for one usage sample: cached tokens are
 * priced at the cache-hit rate instead of the cache-miss rate.
 * @param {object} input same shape as {@link estimateUsageCost}
 * @returns {number | null} null when the model has no known price
 */
export function estimateCacheSavings({ usage, model, time, currency, overrides = {}, holidays = [] }) {
  const price = priceFor({ model, time, currency, overrides, holidays });
  if (price === null) return null;
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  return (cacheRead * Math.max(0, price.cacheMiss - price.cacheHit)) / 1_000_000;
}

/**
 * Describe the pricing table for the dashboard footer.
 * @param {string | null} currency
 * @returns {{ source: string, asOf: string, note: string, currency: string | null }}
 */
export function pricingInfo(currency) {
  return {
    source: PRICING_SOURCE,
    asOf: PRICING_AS_OF,
    currency,
    note: 'Official DeepSeek list prices, peak/off-peak applied per request time. Costs are estimates, not a provider bill.',
  };
}
