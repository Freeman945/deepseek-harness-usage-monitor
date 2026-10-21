/**
 * Dashboard aggregation.
 *
 * Everything here is derived locally from two inputs:
 *   1. provider-reported token usage harvested from durable Session events;
 *   2. real wallet snapshots from Harness's `deepseekAccount` service.
 *
 * The only money the plugin ever claims as real is the wallet decrease between
 * two balance samples ("observed"). All per-model / per-agent attribution and
 * every window before monitoring started is an estimate: tokens × official
 * DeepSeek prices, labeled `Est.` in the UI.
 */

import { estimateCacheSavings, estimateUsageCost, pricingInfo } from './pricing.js';
import { hitRateOf } from './ingest.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_SERIES_POINTS = 240;

const RANGES = {
  '1h': { ms: HOUR, bucketMs: MINUTE },
  '6h': { ms: 6 * HOUR, bucketMs: 5 * MINUTE },
  '24h': { ms: DAY, bucketMs: 15 * MINUTE },
  '7d': { ms: 7 * DAY, bucketMs: HOUR },
};

/** @typedef {{ cost: number, pricedCost: number, hitCost: number, missCost: number, tokens: number, input: number, output: number, cacheRead: number, cacheWrite: number, requests: number, pricedRequests: number }} Agg */

/** @returns {Agg} */
function emptyAgg() {
  return {
    cost: 0,
    pricedCost: 0,
    hitCost: 0,
    missCost: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    pricedRequests: 0,
  };
}

/**
 * @param {Agg} target
 * @param {Agg} source
 */
function addAgg(target, source) {
  target.cost += source.cost;
  target.pricedCost += source.pricedCost;
  target.hitCost += source.hitCost;
  target.missCost += source.missCost;
  target.tokens += source.tokens;
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.requests += source.requests;
  target.pricedRequests += source.pricedRequests;
}

/**
 * @param {import('./ingest.js').RequestRow} row
 * @param {string} currency
 * @param {object} settings
 * @returns {{ cost: number, priced: boolean, hit: number, miss: number }}
 */
function costOf(row, currency, settings) {
  const estimate = estimateUsageCost({
    usage: { inputTokens: row.input, outputTokens: row.output, cacheReadTokens: row.cacheRead, cacheWriteTokens: row.cacheWrite },
    model: row.model,
    time: row.t,
    currency,
    overrides: settings.pricingOverrides,
    holidays: settings.holidays,
  });
  return { cost: estimate.total, priced: estimate.priced, hit: estimate.hit, miss: estimate.miss };
}

/**
 * One aggregated index over all retained request samples.
 */
class UsageIndex {
  /**
   * @param {import('./ingest.js').RequestRow[]} rows
   * @param {string} currency
   * @param {object} settings
   * @param {Record<string, import('./ingest.js').SessionRecord>} sessions
   */
  constructor(rows, currency, settings, sessions) {
    /** @type {Map<number, Agg>} minute key → aggregate */
    this.minutes = new Map();
    /** @type {Map<string, Agg>} */
    this.models = new Map();
    /** @type {Map<string, Agg>} */
    this.sessions = new Map();
    /** @type {Map<string, Agg>} */
    this.tasks = new Map();
    /** @type {Map<string, Agg>} */
    this.presets = new Map();
    /** @type {Agg} */
    this.all = emptyAgg();
    /** @type {Map<string, { hit: number, miss: number, requests: number }>} */
    this.sessionsCache = new Map();
    this.rows = rows;
    this.currency = currency;
    this.settings = settings;
    this.sessionsMeta = sessions;
    this.build();
  }

  build() {
    const { rows, currency, settings, sessionsMeta } = this;
    for (const row of rows) {
      const cost = costOf(row, currency, settings);
      const tokens = row.input + row.output;
      const minuteKey = Math.floor(row.t / MINUTE);
      let minute = this.minutes.get(minuteKey);
      if (!minute) {
        minute = emptyAgg();
        this.minutes.set(minuteKey, minute);
      }
      const contribution = {
        cost: cost.cost,
        pricedCost: cost.priced ? cost.cost : 0,
        hitCost: cost.hit,
        missCost: cost.miss,
        tokens,
        input: row.input,
        output: row.output,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        requests: 1,
        pricedRequests: cost.priced ? 1 : 0,
      };
      addAgg(minute, contribution);
      addAgg(this.all, contribution);

      let model = this.models.get(row.model);
      if (!model) {
        model = emptyAgg();
        this.models.set(row.model, model);
      }
      addAgg(model, contribution);

      let session = this.sessions.get(row.sid);
      if (!session) {
        session = emptyAgg();
        this.sessions.set(row.sid, session);
      }
      addAgg(session, contribution);

      const taskKey = `${row.sid}#${row.turn}`;
      let task = this.tasks.get(taskKey);
      if (!task) {
        task = emptyAgg();
        this.tasks.set(taskKey, task);
      }
      addAgg(task, contribution);

      const sessionMeta = sessionsMeta[row.sid];
      const presetKey = presetKeyOf(sessionMeta);
      let preset = this.presets.get(presetKey);
      if (!preset) {
        preset = emptyAgg();
        this.presets.set(presetKey, preset);
      }
      addAgg(preset, contribution);

      let cache = this.sessionsCache.get(row.sid);
      if (!cache) {
        cache = { hit: 0, miss: 0, requests: 0 };
        this.sessionsCache.set(row.sid, cache);
      }
      cache.hit += row.cacheRead;
      cache.miss += row.input + row.cacheWrite;
      cache.requests += 1;
    }
  }

  /**
   * Sum minute buckets intersecting a window.
   * @param {number} from
   * @param {number} to
   * @returns {Agg}
   */
  window(from, to) {
    const result = emptyAgg();
    const first = Math.floor(from / MINUTE);
    const last = Math.floor(to / MINUTE);
    for (let key = first; key <= last; key += 1) {
      const minute = this.minutes.get(key);
      if (minute) addAgg(result, minute);
    }
    return result;
  }

  /**
   * Bucket aggregates for a chart range.
   * @param {number} from
   * @param {number} to
   * @param {number} bucketMs
   * @returns {Array<{ t: number } & Agg>}
   */
  series(from, to, bucketMs) {
    /** @type {Map<number, Agg>} */
    const buckets = new Map();
    const first = Math.floor(from / bucketMs) * bucketMs;
    for (let t = first; t <= to; t += bucketMs) buckets.set(t, emptyAgg());
    const startMinute = Math.floor(from / MINUTE);
    const endMinute = Math.floor(to / MINUTE);
    for (let key = startMinute; key <= endMinute; key += 1) {
      const minute = this.minutes.get(key);
      if (!minute) continue;
      const bucketKey = Math.floor((key * MINUTE) / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketKey);
      if (bucket) addAgg(bucket, minute);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-MAX_SERIES_POINTS)
      .map(([t, agg]) => ({ t, ...agg }));
  }
}

/**
 * Preset bucket key for a session.
 * @param {import('./ingest.js').SessionRecord | undefined} record
 * @returns {string}
 */
function presetKeyOf(record) {
  if (!record) return 'unknown';
  if (record.origin === 'subagent') return `subagent:${record.preset ?? 'unknown'}`;
  return record.preset ?? 'no preset';
}

/**
 * @param {Agg} agg
 * @param {number} totalCost
 * @returns {number}
 */
function shareOf(agg, totalCost) {
  if (!(totalCost > 0)) return 0;
  return agg.pricedCost / totalCost;
}

/**
 * Start of the local day containing `now`.
 * @param {number} now
 * @returns {number}
 */
function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Start of the local month containing `now`.
 * @param {number} now
 * @returns {number}
 */
function startOfMonth(now) {
  const date = new Date(now);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * @param {number} now
 * @param {string} range
 * @returns {{ from: number, to: number, bucketMs: number, range: '1h'|'6h'|'24h'|'7d' }}
 */
export function rangeWindow(now, range) {
  const selected = RANGES[range] ?? RANGES['24h'];
  return { range: /** @type {'1h'|'6h'|'24h'|'7d'} */ (RANGES[range] ? range : '24h'), from: now - selected.ms, to: now, bucketMs: selected.bucketMs };
}

/**
 * @param {number | null} numerator
 * @param {number | null} denominator
 * @returns {number | null}
 */
function safeRatio(numerator, denominator) {
  if (numerator === null || denominator === null) return null;
  if (!(denominator > 0)) return null;
  return numerator / denominator;
}

/**
 * Human-friendly short cwd label; never expose the full private path in the UI.
 * @param {string | null} cwd
 * @returns {string}
 */
function directoryLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cwd;
}

/**
 * @param {string} sid
 * @param {Record<string, import('./ingest.js').SessionRecord>} sessions
 * @returns {string}
 */
function sessionLabel(sid, sessions) {
  const record = sessions[sid];
  if (record && typeof record.title === 'string' && record.title.trim().length > 0) return record.title.trim();
  return `Session ${sid.replace(/^session-/, '').slice(0, 8)}`;
}

/**
 * Observed wallet spend series derived from balance history.
 * @param {Array<[number, number]>} history sorted `[time, total]` pairs
 * @param {number} from
 * @param {number} to
 * @param {number} refreshMs
 * @returns {{ spend: number, complete: boolean, samples: number }}
 */
function observedSpend(history, from, to, refreshMs) {
  if (!Array.isArray(history) || history.length < 2) return { spend: 0, complete: false, samples: 0 };
  let spend = 0;
  let samples = 0;
  let first = null;
  let previousTime = null;
  let continuous = true;
  const maxGap = Math.max(3 * refreshMs, 3 * MINUTE);
  for (let index = 1; index < history.length; index += 1) {
    const [previousTimeValue, previousTotal] = history[index - 1];
    const [time, total] = history[index];
    if (!(time > previousTimeValue)) continue;
    const delta = previousTotal - total;
    if (delta > 0) {
      const midpoint = (time + previousTimeValue) / 2;
      if (midpoint >= from && midpoint <= to) {
        spend += delta;
        samples += 1;
      }
    }
    if (time < from) continue;
    if (first === null) first = previousTimeValue;
    if (previousTime !== null && time - previousTime > maxGap) continuous = false;
    previousTime = time;
  }
  const age = Date.now() - to;
  const complete = first !== null && first <= from && continuous && age <= Math.max(3 * refreshMs, 3 * MINUTE);
  return { spend, complete, samples };
}

/**
 * @typedef {object} SnapshotInput
 * @property {any} state
 * @property {any} settings
 * @property {string} locale
 * @property {number} now
 * @property {any} balance live balance view from the monitor
 * @property {{ startedAt: number|null, finishedAt: number|null, inProgress: boolean, sessions: number, errors: number }} scan
 * @property {string} range
 */

/**
 * Build the complete dashboard payload described by docs/API.md.
 * @param {SnapshotInput} input
 * @returns {any}
 */
export function buildSnapshot(input) {
  const { state, settings, now, balance, scan, range: requestedRange } = input;
  const sessions = state.sessions ?? {};
  const rows = Array.isArray(state.requests) ? state.requests : [];
  const wallet = balance.primary;
  const currency = balance.currency ?? 'USD';
  const refreshMs = settings.balanceRefreshSeconds * 1000;
  const index = new UsageIndex(rows, currency, settings, sessions);

  const range = rangeWindow(now, requestedRange);

  // ------------------------------------------------------------------ windows
  const startHour = now - HOUR;
  const startToday = startOfDay(now);
  const start24h = now - DAY;
  const start7d = now - 7 * DAY;
  const startMonth = startOfMonth(now);
  const history = state.balance?.history?.[currency] ?? [];
  const observedWindow = (from) => observedSpend(history, from, now, refreshMs);

  const windowPayload = (from, agg) => {
    const observed = observedWindow(from);
    return {
      estimated: agg.requests > 0 ? round4(agg.pricedCost) : 0,
      observed: observed.samples > 0 ? round4(observed.spend) : null,
      observedComplete: observed.complete,
      tokens: agg.tokens,
      requests: agg.requests,
    };
  };

  const lastHourAgg = index.window(startHour, now);
  const todayAgg = index.window(startToday, now);
  const last24hAgg = index.window(start24h, now);
  const last7dAgg = index.window(start7d, now);
  const monthAgg = index.window(startMonth, now);
  const last10mAgg = index.window(now - 10 * MINUTE, now);

  // -------------------------------------------------------------------- burn
  const burnAgg = (ms) => index.window(now - ms, now);
  const rateOf = (agg, ms) => {
    const hours = ms / HOUR;
    return {
      cost: round4(agg.pricedCost),
      costPerHour: hours > 0 ? round4(agg.pricedCost / hours) : 0,
      tokensPerMin: ms > 0 ? Math.round(agg.tokens / (ms / MINUTE)) : 0,
      requestsPerMin: Math.round((agg.requests / (ms / MINUTE)) * 10) / 10,
      basis: 'estimated',
    };
  };
  const burn5m = rateOf(burnAgg(5 * MINUTE), 5 * MINUTE);
  const burn30m = rateOf(burnAgg(30 * MINUTE), 30 * MINUTE);
  const burn1h = rateOf(burnAgg(HOUR), HOUR);
  const baselineAgg = index.window(start24h, startHour);
  const baselineHours = 23;
  const baselineRate = {
    cost: round4(baselineAgg.pricedCost),
    costPerHour: round4(baselineAgg.pricedCost / baselineHours),
    tokensPerMin: Math.round(baselineAgg.tokens / (baselineHours * 60)),
    requestsPerMin: Math.round((baselineAgg.requests / (baselineHours * 60)) * 10) / 10,
    basis: 'estimated',
  };
  const burnRatio = safeRatio(burn1h.costPerHour, baselineRate.costPerHour);
  const burnLevel =
    burnRatio === null ? 'normal' : burnRatio >= settings.criticalBurnRatio ? 'critical' : burnRatio >= settings.warningBurnRatio ? 'warning' : 'normal';

  // ------------------------------------------------------------------- cache
  const cacheWindow = (agg) => {
    const hitTokens = agg.cacheRead;
    const missTokens = agg.input;
    const writeTokens = agg.cacheWrite;
    return {
      hitTokens,
      missTokens,
      writeTokens,
      hitRate: round4(hitRateOf({ cacheRead: hitTokens, input: missTokens, cacheWrite: writeTokens })),
      requests: agg.requests,
    };
  };
  const cache1h = cacheWindow(lastHourAgg);
  const cache24h = cacheWindow(last24hAgg);
  const cacheBaseline = cacheWindow(baselineAgg);
  const cacheDelta = cache1h.hitRate === null || cacheBaseline.hitRate === null ? null : round4(cache1h.hitRate - cacheBaseline.hitRate);

  const savings = rows.reduce((total, row) => {
    if (row.t < start24h) return total;
    const saved = estimateCacheSavings({
      usage: { inputTokens: row.input, outputTokens: row.output, cacheReadTokens: row.cacheRead, cacheWriteTokens: row.cacheWrite },
      model: row.model,
      time: row.t,
      currency,
      overrides: settings.pricingOverrides,
      holidays: settings.holidays,
    });
    return total + (saved ?? 0);
  }, 0);

  // ------------------------------------------------------------------ series
  const seriesAggs = index.series(range.from, range.to, range.bucketMs);
  const series = {
    range: range.range,
    bucketMs: range.bucketMs,
    from: range.from,
    to: range.to,
    points: seriesAggs.map((point) => ({
      t: point.t,
      cost: round4(point.pricedCost),
      tokens: point.tokens,
      uncachedInputTokens: point.input,
      cachedInputTokens: point.cacheRead,
      outputTokens: point.output,
      requests: point.requests,
      hitRate: round4(hitRateOf({ cacheRead: point.cacheRead, input: point.input, cacheWrite: point.cacheWrite })),
    })),
  };
  const cacheTrend = seriesAggs.map((point) => ({
    t: point.t,
    hitRate: round4(hitRateOf({ cacheRead: point.cacheRead, input: point.input, cacheWrite: point.cacheWrite })),
    hitTokens: point.cacheRead,
    missTokens: point.input,
    requests: point.requests,
  }));

  // --------------------------------------------------------- dynamic anomalies
  const anomalyMemory = state.anomalyMemory ?? {};
  const activeConditions = [];
  const pushCondition = (key, level, type, title, detail, evidence, extra = {}, sinceOverride = null) => {
    const previous = anomalyMemory[key];
    const since = sinceOverride ?? (previous && Number.isFinite(previous.firstSeen) ? previous.firstSeen : now);
    anomalyMemory[key] = { firstSeen: since, lastSeen: now, level, type, title, detail };
    activeConditions.push({ id: key, t: since, level, type, title, detail, evidence, ...extra });
  };

  if (burnRatio !== null && burnRatio >= settings.warningBurnRatio) {
    const level = burnRatio >= settings.criticalBurnRatio ? 'critical' : 'warning';
    const ratioText = `${round1(burnRatio)}×`;
    pushCondition(
      'burn-rate',
      level,
      'burn-rate',
      `Burn rate is ${ratioText} the 24h average`,
      `Now ${moneyText(burn1h.costPerHour, currency)}/hour vs ${moneyText(baselineRate.costPerHour, currency)}/hour historical average.`,
      { burnPerHour: burn1h.costPerHour, baselinePerHour: baselineRate.costPerHour, ratio: round1(burnRatio) },
    );
  }
  if (cache1h.hitRate !== null && cache1h.hitRate < settings.cacheWarningRate) {
    // Track the first breach even before the sustained-alert threshold is met;
    // otherwise the alert can never become "sustained" during a fresh episode.
    const pendingKey = '__cache-low-since';
    const pending = anomalyMemory[pendingKey];
    const firstSeen = pending && Number.isFinite(pending.firstSeen) ? pending.firstSeen : now;
    anomalyMemory[pendingKey] = { firstSeen, lastSeen: now, internal: true };
    const sustainedMinutes = (now - firstSeen) / MINUTE;
    if (sustainedMinutes >= settings.cacheAlertMinutes) {
      const level = cache1h.hitRate < settings.cacheCriticalRate ? 'critical' : 'warning';
      pushCondition(
        'cache-low',
        level,
        'cache-low',
        'Cache hit rate is low',
        `${percentText(cache1h.hitRate)} over the last hour (baseline ${percentText(cacheBaseline.hitRate)}), below the ${percentText(settings.cacheWarningRate)} threshold for ${Math.round(sustainedMinutes)} minutes.`,
        { hitRate: cache1h.hitRate, baseline: cacheBaseline.hitRate, sustainedMinutes: Math.round(sustainedMinutes) },
        {},
        firstSeen,
      );
    }
  } else {
    delete anomalyMemory['__cache-low-since'];
  }
  if (last10mAgg.pricedCost > settings.costSpike10m) {
    pushCondition(
      'cost-spike',
      'warning',
      'cost-spike',
      `${moneyText(last10mAgg.pricedCost, currency)} spent in the last 10 minutes`,
      `The configured 10-minute cost-spike threshold is ${moneyText(settings.costSpike10m, currency)}.`,
      { last10mCost: round4(last10mAgg.pricedCost), threshold: settings.costSpike10m },
    );
  }
  const uncached30m = index.window(now - 30 * MINUTE, now).input;
  const uncachedBaselinePer30m = baselineAgg.input / (baselineHours * 2);
  if (uncached30m > 0 && uncachedBaselinePer30m > 0 && uncached30m > 3 * uncachedBaselinePer30m && uncached30m > 10_000) {
    pushCondition(
      'uncached-burst',
      'warning',
      'uncached-burst',
      'Uncached input tokens surged',
      `${formatTokens(uncached30m)} uncached input tokens in 30 minutes vs ${formatTokens(Math.round(uncachedBaselinePer30m))} typical.`,
      { uncachedTokens: uncached30m, baseline: Math.round(uncachedBaselinePer30m) },
    );
  }
  if (burnRatio !== null && burnRatio >= 1.5 && cacheDelta !== null && cacheDelta < -0.15) {
    pushCondition(
      'cache-problem-correlated',
      'critical',
      'cache-hit-drop',
      'Possible cache problem detected',
      `Cache hit rate fell ${percentText(Math.abs(cacheDelta))} while burn rate is ${round1(burnRatio)}× normal — cache misses are the most likely cost driver.`,
      { hitRateDelta: cacheDelta, burnRatio: round1(burnRatio) },
    );
  }

  /** @type {any[]} */
  const anomalies = [...activeConditions];
  const anomalies24h = scanHistoricalAnomalies(index, settings, sessions, now, currency);
  anomalies.push(...anomalies24h);
  const recovered = recoveredConditions(anomalyMemory, activeConditions.map((condition) => condition.id), now);
  anomalies.push(...recovered);

  // Balance alerts.
  const alerts = [];
  if (wallet && Number.isFinite(wallet.amount)) {
    const breached = [...settings.balanceAlerts].sort((a, b) => a - b).find((threshold) => wallet.amount < threshold);
    if (breached !== undefined) {
      const key = `balance-low:${breached}`;
      const previous = anomalyMemory[key];
      const since = previous && Number.isFinite(previous.firstSeen) ? previous.firstSeen : now;
      anomalyMemory[key] = { firstSeen: since, lastSeen: now, level: 'warning', type: 'balance-low' };
      alerts.push({
        id: 'balance-low',
        level: breached <= 10 ? 'critical' : 'warning',
        type: 'balance-low',
        title: `Balance below ${moneyText(breached, wallet.currency)}`,
        detail: `Current balance is ${moneyText(wallet.amount, wallet.currency)}.`,
        since,
        evidence: {
          threshold: breached,
          balance: wallet.amount,
          currency: wallet.currency,
          bonus: balance.totalAll !== null ? round4(balance.totalAll) : null,
        },
      });
    }
  }
  for (const condition of activeConditions) {
    if (condition.type === 'burn-rate' || condition.type === 'cache-low' || condition.type === 'cost-spike' || condition.type === 'uncached-burst') {
      alerts.push({
        id: condition.id,
        level: condition.level === 'critical' ? 'critical' : 'warning',
        type: condition.type === 'cache-low' ? 'cache-low' : condition.type === 'cost-spike' ? 'cost-spike' : condition.type,
        title: condition.title,
        detail: condition.detail,
        since: condition.t,
        evidence: condition.evidence ?? {},
      });
    }
  }

  // ------------------------------------------------------------- cache causes
  const diagnosis = diagnoseCache({
    index,
    sessions,
    settings,
    now,
    currency,
    cache1h,
    cache24h,
    cacheBaseline,
    cacheDelta,
    burnRatio,
    rows,
  });

  // ------------------------------------------------------------- consumers
  const consumerTotalCost = index.window(start24h, now).pricedCost;
  const consumerAgg = (map, key, label, sublabel, extra = {}) => {
    const agg = map.get(key);
    if (!agg || agg.requests === 0) return null;
    return {
      key,
      label,
      ...(sublabel ? { sublabel } : {}),
      ...extra,
      requests: agg.requests,
      inputTokens: agg.input,
      outputTokens: agg.output,
      cachedTokens: agg.cacheRead,
      uncachedTokens: agg.input,
      hitRate: round4(hitRateOf({ cacheRead: agg.cacheRead, input: agg.input, cacheWrite: agg.cacheWrite })),
      cost: round4(agg.pricedCost),
      costShare: round4(shareOf(agg, consumerTotalCost)),
    };
  };
  const sortByCost = (list) => list.filter(Boolean).sort((a, b) => b.cost - a.cost).slice(0, 12);
  const sessionRows = sortByCost(
    [...index.sessions.keys()].map((sid) => {
      const record = sessions[sid];
      return consumerAgg(index.sessions, sid, sessionLabel(sid, sessions), [directoryLabel(record?.cwd ?? null), record?.preset ?? ''].filter(Boolean).join(' · '), {
        sessionId: sid,
      });
    }),
  );
  const presetRows = sortByCost(
    [...index.presets.keys()].map((key) => {
      const label = key.startsWith('subagent:') ? `subagent · ${key.slice('subagent:'.length)}` : key;
      return consumerAgg(index.presets, key, label, key.startsWith('subagent:') ? 'delegated child sessions' : 'agent preset');
    }),
  );
  const taskRows = sortByCost(
    [...index.tasks.keys()].map((key) => {
      const [sid, turnText] = key.split('#');
      const turn = Number(turnText);
      const agg = index.tasks.get(key);
      return consumerAgg(index.tasks, key, `${sessionLabel(sid, sessions)} · Turn ${turn}`, sessions[sid]?.preset ?? '', {
        sessionId: sid,
        turn: Number.isFinite(turn) ? turn : 0,
      });
    }),
  );
  const totalUncached = [...index.sessions.values()].reduce((total, agg) => total + agg.input, 0);
  const uncachedRows = [...index.sessions.entries()]
    .map(([sid, agg]) => ({
      key: sid,
      label: sessionLabel(sid, sessions),
      sublabel: `${totalUncached > 0 ? Math.round((agg.input / totalUncached) * 100) : 0}% of recent uncached tokens`,
      sessionId: sid,
      requests: agg.requests,
      inputTokens: agg.input,
      outputTokens: agg.output,
      cachedTokens: agg.cacheRead,
      uncachedTokens: agg.input,
      hitRate: round4(hitRateOf({ cacheRead: agg.cacheRead, input: agg.input, cacheWrite: agg.cacheWrite })),
      // The money actually caused by unmatched input in this window.
      cost: round4(agg.missCost),
      costShare: round4(shareOf(agg, consumerTotalCost)),
    }))
    .filter((row) => row.requests > 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 12);

  // ------------------------------------------------------------------ models
  const totalCost = index.window(start24h, now).pricedCost;
  const models = [...index.models.entries()]
    .map(([model, agg]) => ({
      model,
      provider: providerOf(rows, model),
      priced: agg.pricedRequests > 0,
      requests: agg.requests,
      inputTokens: agg.input,
      outputTokens: agg.output,
      cachedTokens: agg.cacheRead,
      uncachedTokens: agg.input,
      hitRate: round4(hitRateOf({ cacheRead: agg.cacheRead, input: agg.input, cacheWrite: agg.cacheWrite })),
      cost: round4(agg.pricedCost),
      costShare: round4(shareOf(agg, totalCost)),
      avgCostPerRequest: agg.requests > 0 ? round4(agg.pricedCost / agg.requests) : 0,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  // ---------------------------------------------------------------- forecast
  const available = balance.totalAll ?? (wallet ? wallet.amount : null);
  const lastHourCost = burn1h.costPerHour;
  const dailyCost = lastHourCost > 0 ? lastHourCost * 24 : baselineRate.costPerHour * 24;
  const forecast = {
    dailyCost: round4(dailyCost),
    dailyCostBaseline: round4(baselineRate.costPerHour * 24),
    daysRemaining: available !== null && dailyCost > 0 ? round1(available / dailyCost) : null,
    remainingTimeText: null,
    basis: lastHourCost > 0 ? 'last1h' : 'last24h',
    note: 'Estimate based on recent usage.',
  };

  // --------------------------------------------------------------- diagnostics
  const warnings = [];
  if (settings.holidays.length === 0) {
    warnings.push('Peak/off-peak pricing ignores Chinese public holidays unless they are listed in Settings.');
  }
  const unpriced = models.filter((row) => !row.priced).map((row) => row.model);
  if (unpriced.length > 0) warnings.push(`No cached price for model(s): ${unpriced.join(', ')} — token usage is shown, cost is omitted.`);
  if (balance.state !== 'ready') warnings.push(balance.error ?? `Balance unavailable (${balance.state}).`);
  if (scan.errors > 0) {
    warnings.push(`${scan.errors} stored Session(s) could not be read (format migration or corruption); their usage is not included yet.`);
  }
  if (rows.length === 0) warnings.push('No usage samples yet; the first model request will populate the dashboard.');
  const lastEventAt = rows.length > 0 ? rows.reduce((max, row) => (row.t > max ? row.t : max), 0) : null;
  const firstEventAt = rows.length > 0 ? rows.reduce((min, row) => (row.t < min ? row.t : min), Infinity) : null;
  const balanceSamples = Object.values(state.balance?.history ?? {}).reduce((total, list) => total + (Array.isArray(list) ? list.length : 0), 0);

  const overallStatus = alerts.some((alert) => alert.level === 'critical') || activeConditions.some((condition) => condition.level === 'critical')
    ? 'critical'
    : alerts.length > 0 || activeConditions.length > 0
      ? 'warning'
      : 'normal';

  const currencyForCost = wallet?.currency ?? currency;

  return {
    schemaVersion: 1,
    generatedAt: now,
    status: overallStatus,
    locale: input.locale,
    currency: currencyForCost,
    balance: {
      state: balance.state,
      wallets: balance.wallets,
      bonusWallets: balance.bonusWallets,
      primary: balance.primary,
      totalAll: balance.totalAll,
      fetchedAt: balance.fetchedAt,
      error: balance.error,
      observedSince: history.length > 0 ? history[0][0] : null,
    },
    cost: {
      currency: currencyForCost,
      pricing: pricingInfo(currencyForCost),
      coverageStart: history.length > 0 ? history[0][0] : null,
      windows: {
        lastHour: windowPayload(startHour, lastHourAgg),
        today: windowPayload(startToday, todayAgg),
        last24h: windowPayload(start24h, last24hAgg),
        last7d: windowPayload(start7d, last7dAgg),
        month: windowPayload(startMonth, monthAgg),
      },
    },
    burn: {
      last5m: burn5m,
      last30m: burn30m,
      last1h: burn1h,
      baseline24h: baselineRate,
      ratio: burnRatio === null ? null : round1(burnRatio),
      ratioBasis: 'estimated',
      level: burnLevel,
    },
    cache: {
      last1h: cache1h,
      last24h: cache24h,
      baseline: cacheBaseline,
      hitRate: cache1h.hitRate,
      deltaVsBaseline: cacheDelta,
      savings: {
        amount: round4(savings),
        currency: currencyForCost,
        note: 'Estimated: cached input priced at the cache-hit rate instead of the cache-miss rate (last 24h).',
      },
      trend: cacheTrend,
      diagnosis,
    },
    series,
    models,
    consumers: {
      window: '24h',
      sessions: sessionRows,
      presets: presetRows,
      tasks: taskRows,
      uncached: uncachedRows,
    },
    anomalies: anomalies
      .sort((a, b) => b.t - a.t)
      .slice(0, 40)
      .map((anomaly) => ({
        id: anomaly.id,
        t: anomaly.t,
        level: anomaly.level,
        type: anomaly.type,
        title: anomaly.title,
        detail: anomaly.detail,
        ...(anomaly.sessionId ? { sessionId: anomaly.sessionId } : {}),
        ...(Number.isFinite(anomaly.turn) ? { turn: anomaly.turn } : {}),
        evidence: anomaly.evidence ?? {},
      })),
    forecast,
    alerts,
    settings,
    diagnostics: {
      sources: {
        balance: { kind: 'deepseek-account-platform', state: balance.state },
        tokens: { kind: 'session-events', sessionsScanned: scan.sessions, liveSessions: balance.liveSessions ?? 0, requests: rows.length },
        pricing: { kind: 'official-table', currency: currencyForCost, source: pricingInfo(currencyForCost).source, asOf: pricingInfo(currencyForCost).asOf },
        cost: { kind: 'estimated+observed', observedStart: history.length > 0 ? history[0][0] : null },
      },
      scan,
      data: {
        firstEventAt: firstEventAt === null || !Number.isFinite(firstEventAt) ? null : firstEventAt,
        lastEventAt,
        retentionDays: settings.retentionDays,
        requestsInRetention: rows.length,
        balanceSamples,
        gaps: [],
      },
      warnings,
    },
  };
}

/**
 * @param {number | null} value
 * @returns {number | null}
 */
function round4(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10_000) / 10_000;
}

/**
 * @param {number | null} value
 * @returns {number | null}
 */
function round1(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

/**
 * @param {number} value
 * @param {string} currency
 * @returns {string}
 */
function moneyText(value, currency) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function percentText(value) {
  if (value === null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatTokens(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

/**
 * @param {import('./ingest.js').RequestRow[]} rows
 * @param {string} model
 * @returns {string | null}
 */
function providerOf(rows, model) {
  for (const row of rows) if (row.model === model && row.provider) return row.provider;
  return null;
}

/**
 * Historical anomaly ledger reconstructed from 5-minute buckets over the last
 * 24 hours. This is what gives the timeline entries older than the current
 * process start; conditions detected live are tracked separately.
 * @returns {any[]}
 */
function scanHistoricalAnomalies(index, settings, sessions, now, currency) {
  const bucketMs = 5 * MINUTE;
  const from = now - DAY;
  const points = index.series(from, now, bucketMs);
  const baseline = index.window(from, now);
  const baselineCostPerBucket = baseline.pricedCost / (DAY / bucketMs);
  const baselineRequestsPerBucket = baseline.requests / (DAY / bucketMs);
  const globalRate = hitRateOf({ cacheRead: baseline.cacheRead, input: baseline.input, cacheWrite: baseline.cacheWrite });
  const events = [];
  let lastKind = null;
  let lastBucket = null;
  for (const point of points) {
    const hitRate = hitRateOf({ cacheRead: point.cacheRead, input: point.input, cacheWrite: point.cacheWrite });
    const kinds = [];
    if (point.pricedCost > 0 && baselineCostPerBucket > 0) {
      const ratio = point.pricedCost / baselineCostPerBucket;
      if (ratio >= settings.criticalBurnRatio) kinds.push(['critical', 'burn-rate', `Burn rate reached ${round1(ratio)}× the 24h average`, `${moneyText(point.pricedCost * 12, currency)}/hour during this 5-minute bucket.`, { ratio: round1(ratio) }]);
      else if (ratio >= settings.warningBurnRatio) kinds.push(['warning', 'burn-rate', `Burn rate reached ${round1(ratio)}× the 24h average`, `${moneyText(point.pricedCost * 12, currency)}/hour during this 5-minute bucket.`, { ratio: round1(ratio) }]);
    }
    if (hitRate !== null && point.requests >= 5 && globalRate !== null && hitRate < globalRate - 0.2) {
      kinds.push(['warning', 'cache-hit-drop', `Cache hit rate dropped to ${percentText(hitRate)}`, `The 24h baseline is ${percentText(globalRate)}.`, { hitRate: round4(hitRate), baseline: round4(globalRate) }]);
    }
    if (baselineRequestsPerBucket > 0 && point.requests > 4 * baselineRequestsPerBucket && point.requests >= 8) {
      kinds.push(['warning', 'request-spike', 'Request rate spiked', `${point.requests} requests in 5 minutes vs ${round1(baselineRequestsPerBucket)} typical.`, { requests: point.requests, baseline: round1(baselineRequestsPerBucket) }]);
    }
    if (kinds.length === 0) {
      lastKind = null;
      lastBucket = null;
      continue;
    }
    const [level, type, title, detail, evidence] = kinds[0];
    if (lastKind === type && lastBucket !== null && point.t - lastBucket <= bucketMs) {
      lastBucket = point.t;
      continue;
    }
    lastKind = type;
    lastBucket = point.t;
    events.push({ id: `${type}:${point.t}`, t: point.t, level, type, title, detail, evidence });
  }
  return events.slice(-20);
}

/**
 * Close conditions that were active but are no longer; this produces the
 * "Usage returned to normal" timeline entries.
 * @param {Record<string, any>} memory
 * @param {string[]} activeKeys
 * @param {number} now
 * @returns {any[]}
 */
function recoveredConditions(memory, activeKeys, now) {
  const results = [];
  for (const [key, value] of Object.entries(memory)) {
    if (key.startsWith('__')) continue; // internal pending markers are not conditions
    if (activeKeys.includes(key) || !value || typeof value !== 'object') continue;
    if (!Number.isFinite(value.lastSeen)) continue;
    if (now - value.lastSeen < 2 * MINUTE) continue;
    if (value.recoveredAt !== undefined && value.recoveredAt > value.lastSeen) continue;
    if (now - value.lastSeen > DAY) continue;
    value.recoveredAt = now;
    results.push({
      id: `recovered:${key}:${now}`,
      t: now,
      level: 'info',
      type: 'recovered',
      title: 'Usage returned to normal',
      detail: 'The previous condition is no longer active.',
      evidence: { condition: key },
    });
  }
  return results;
}

/**
 * Data-driven cache diagnosis. Every cause below is emitted only when the
 * recorded evidence exists; there is no language-model guesswork.
 * @returns {any[]}
 */
function diagnoseCache(input) {
  const { index, sessions, settings, now, currency, cache1h, cache24h, cacheBaseline, cacheDelta, burnRatio, rows } = input;
  const causes = [];
  const globalRate = cache24h.hitRate;
  const push = (cause) => causes.push({ severity: 'warning', sessionId: null, sessionTitle: null, ...cause });

  if (cacheDelta !== null && cacheDelta < -0.15) {
    push({
      code: 'cache-hit-drop',
      severity: 'warning',
      title: `Cache hit rate dropped ${percentText(Math.abs(cacheDelta))} versus the previous 24h`,
      detail: `Last hour ${percentText(cache1h.hitRate)} vs ${percentText(cacheBaseline.hitRate)} before. Cost grows even when token volume is flat because cache hits are much cheaper.`,
      evidence: { lastHour: cache1h.hitRate, baseline: cacheBaseline.hitRate, delta: cacheDelta },
    });
  }
  if (burnRatio !== null && burnRatio >= 1.5 && cacheDelta !== null && cacheDelta < -0.15) {
    push({
      code: 'cache-problem-correlated',
      severity: 'critical',
      title: 'Possible cache problem detected',
      detail: `Burn rate is ${round1(burnRatio)}× normal while the cache hit rate fell ${percentText(Math.abs(cacheDelta))}. Cache misses are the most likely driver.`,
      evidence: { burnRatio: round1(burnRatio), hitRateDelta: cacheDelta },
    });
  }

  const recentUncachedBySession = new Map();
  const recentCacheBySession = new Map();
  for (const row of rows) {
    if (row.t < now - HOUR) continue;
    recentUncachedBySession.set(row.sid, (recentUncachedBySession.get(row.sid) ?? 0) + row.input);
    const cache = recentCacheBySession.get(row.sid) ?? { hit: 0, miss: 0, requests: 0 };
    cache.hit += row.cacheRead;
    cache.miss += row.input + row.cacheWrite;
    cache.requests += 1;
    recentCacheBySession.set(row.sid, cache);
  }
  const candidates = [...recentUncachedBySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [sid, uncached] of candidates) {
    if (uncached < 5000) continue;
    const record = sessions[sid];
    if (!record) continue;
    const recent = recentCacheBySession.get(sid);
    const hitRate = recent ? hitRateOf({ cacheRead: recent.hit, input: recent.miss, cacheWrite: 0 }) : null;
    if (hitRate !== null && globalRate !== null && hitRate >= globalRate - 0.05) continue;
    const signals = record.signals ?? {};
    const title = record.title ?? `Session ${sid.slice(-6)}`;
    const baseEvidence = { uncachedTokens: uncached, hitRate: hitRate === null ? null : round4(hitRate), sessionRequests: recent?.requests ?? 0 };
    if (signals.requestHeaders?.change > 0) {
      push({
        code: 'request-epoch-change',
        severity: 'warning',
        title: `Cached prefix reset ${signals.requestHeaders.change} time(s) in "${title}"`,
        detail: 'A request-header change starts a new request epoch: tools, system prompt or model changed, so the provider cannot reuse the previous prefix.',
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, headerChanges: signals.requestHeaders.change, initial: signals.requestHeaders.initial, series: signals.requestHeaders.series },
      });
    }
    if ((signals.systemHashes?.length ?? 0) > 1) {
      push({
        code: 'system-prompt-changing',
        severity: 'warning',
        title: `System prompt changed inside "${title}"`,
        detail: `${signals.systemHashes.length} distinct system-prompt hashes were recorded in this session; only a stable prefix can be cached.`,
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, systemPromptHashes: signals.systemHashes.length, systemMessages: signals.systemMessages ?? 0 },
      });
    }
    if ((signals.toolCounts?.length ?? 0) > 1) {
      push({
        code: 'toolset-change',
        severity: 'info',
        title: `Tool list size changed ${signals.toolCounts.length} times in "${title}"`,
        detail: 'Adding or removing tools changes the request prefix; every change invalidates the cacheable prefix after it.',
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, toolListSizes: signals.toolCounts.join(',') },
      });
    }
    if ((signals.models?.length ?? 0) > 1) {
      push({
        code: 'model-switch',
        severity: 'info',
        title: `Model switched inside "${title}"`,
        detail: `Models observed: ${signals.models.join(', ')}. Provider caches are per model, so switching always misses first.`,
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, models: signals.models.join(',') },
      });
    }
    if ((signals.compactions ?? 0) > 0) {
      push({
        code: 'compaction-cache-break',
        severity: 'info',
        title: `Compaction ran ${signals.compactions} time(s) in "${title}"`,
        detail: 'Compaction rewrites history; the first request after it cannot reuse the previous prefix.',
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, compactions: signals.compactions },
      });
    }
    const afterGapTotal = (signals.afterGapHit ?? 0) + (signals.afterGapMiss ?? 0);
    if (afterGapTotal > 0 && globalRate !== null && (signals.afterGapHit ?? 0) / afterGapTotal < globalRate - 0.2) {
      push({
        code: 'ttl-gap',
        severity: 'info',
        title: `First request after a long pause missed the cache in "${title}"`,
        detail: `${signals.afterGapSamples ?? 0} requests followed a >30 minute gap and hit only ${percentText((signals.afterGapHit ?? 0) / afterGapTotal)} of their prompt tokens. Provider caches expire after inactivity.`,
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, afterGapSamples: signals.afterGapSamples ?? 0, afterGapHitRate: round4((signals.afterGapHit ?? 0) / afterGapTotal) },
      });
    }
    if ((signals.uuidHits ?? 0) > 0 || (signals.timestampHits ?? 0) > 0) {
      push({
        code: 'uuid-or-timestamp-in-prefix',
        severity: 'warning',
        title: `Timestamp/UUID-like text found in "${title}" system prompt`,
        detail: 'A timestamp or UUID regenerated on every request makes the prefix different every time and defeats prefix caching.',
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, uuidHits: signals.uuidHits ?? 0, timestampHits: signals.timestampHits ?? 0 },
      });
    }
    if ((signals.cacheMissing ?? 0) > (signals.cacheReported ?? 0) && (signals.cacheMissing ?? 0) > 0) {
      push({
        code: 'cache-not-reported',
        severity: 'info',
        title: `Provider did not report cache counters in "${title}"`,
        detail: 'Every request reported zero cached tokens. The model/provider may not support prefix caching, so the hit rate cannot improve.',
        sessionId: sid,
        sessionTitle: title,
        evidence: { ...baseEvidence, cacheMissing: signals.cacheMissing ?? 0, cacheReported: signals.cacheReported ?? 0 },
      });
    }
  }

  // Average prompt size growth: context growing does not break a stable prefix,
  // but it multiplies the cost of every miss, so it is worth surfacing.
  const recent = index.window(now - HOUR, now);
  const reference = index.window(now - DAY, now - HOUR);
  if (recent.requests >= 5 && reference.requests >= 20) {
    const recentAverage = (recent.input + recent.cacheRead) / recent.requests;
    const referenceAverage = (reference.input + reference.cacheRead) / reference.requests;
    if (referenceAverage > 0 && recentAverage > 1.8 * referenceAverage) {
      push({
        code: 'context-growth',
        severity: 'info',
        title: `Average input context grew to ${formatTokens(Math.round(recentAverage))} tokens`,
        detail: `It was ${formatTokens(Math.round(referenceAverage))} tokens on average over the previous 24 hours. A larger context makes every cache miss more expensive.`,
        evidence: { recentAverage: Math.round(recentAverage), baselineAverage: Math.round(referenceAverage), multiplier: round1(recentAverage / referenceAverage) },
      });
    }
  }

  return causes.slice(0, 10);
}
