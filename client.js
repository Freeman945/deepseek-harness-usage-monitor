/**
 * DeepSeek Harness Usage Monitor — browser half.
 *
 * This file is the complete DSH client-module artifact: the Harness Web client loads it through
 * `window.__ModuleLoader__.load({ id, factory })`, passes `require` (React is the only dependency),
 * and mounts what `apply()` registers into the slot system.
 *
 * Shape:
 *   constants -> i18n dictionaries -> formatters -> data helpers -> tiny primitives
 *   -> chart components -> page sections -> page container -> sidebar icon -> CSS -> apply()
 *
 * Everything lives in this one factory scope on purpose: a plain-JS plugin has no bundler, no
 * imports, and no access to Harness Client packages. The Host contract (Snapshot v1) is documented
 * in docs/API.md and is the only data source.
 */
window.__ModuleLoader__.load({
  id: 'deepseek-harness-usage-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /* ---------------------------------------------------------------------------------------- *
     * Constants
     * ---------------------------------------------------------------------------------------- */

    /** Locale dictionary namespace owned by this plugin. */
    const NS = 'usage-monitor';
    /** Same-origin JSON endpoints served by the plugin's Host half. */
    const API_BASE = '/api/usage-monitor';
    /** Snapshot poll interval while the page is mounted and visible. */
    const POLL_MS = 5000;
    /** A range switch that comes back with a stale `series.range` retries once quickly. */
    const RANGE_RETRY_MS = 600;
    /** How long the "settings saved" hint stays in the header. */
    const TOAST_MS = 5000;
    /** Client-side request timeout; the Host does not hold a snapshot request for long. */
    const REQUEST_TIMEOUT_MS = 20000;
    /** The four selectable windows, matching `GET /snapshot?range=`. */
    const RANGES = ['1h', '6h', '24h', '7d'];
    /** Currencies the settings form may request; `auto` follows the wallet. */
    const CURRENCIES = ['auto', 'CNY', 'USD'];
    /** How many consumer / diagnosis / anomaly rows render before the "+N more" note. */
    const MAX_CONSUMERS = 5;
    const MAX_CAUSES = 8;
    const MAX_ANOMALIES = 12;
    const EM_DASH = '\u2014';
    const DOT_SEP = ' \u00b7 ';

    /**
     * Settings defaults for the drawer. Mirrors docs/API.md; used only when the snapshot does not
     * carry a value (Host bug or first paint), never to invent values the server did not send.
     */
    const SETTINGS_FALLBACK = {
      currency: 'auto',
      balanceRefreshSeconds: 45,
      warningBurnRatio: 2,
      criticalBurnRatio: 4.5,
      cacheWarningRate: 0.5,
      cacheCriticalRate: 0.3,
      cacheAlertMinutes: 10,
      requestRateWarningMultiplier: 2,
      costSpike10m: 5,
      balanceAlerts: [50, 20, 10],
      retentionDays: 14,
    };

    /**
     * Bounds used by the drawer's local validation. Mirrors the Host's normalizeSettings clamps;
     * the Host validates again, so a mismatch only ever costs one round trip.
     */
    const LIMITS = {
      burnRatio: { min: 1, max: 100 },
      cachePercent: { min: 0, max: 100 },
      cacheMinutes: { min: 1, max: 240 },
      requestMultiplier: { min: 1, max: 100 },
      costSpike: { min: 0.01, max: 1000000 },
      refreshSeconds: { min: 20, max: 600 },
      retentionDays: { min: 1, max: 30 },
      balanceAlerts: { min: 0.01, max: 1000000, maxCount: 8 },
    };

    /* ---------------------------------------------------------------------------------------- *
     * i18n dictionaries — flat keys, English and Simplified Chinese (complete key parity).
     * ---------------------------------------------------------------------------------------- */

    const en = {
      nav: 'Usage',
      'page.title': 'Usage Monitor',
      'page.subtitle': 'Balance, spend, cache hit rate and anomalies for this Harness.',
      'page.loading': 'Loading usage data\u2026',

      'status.normal': 'Normal',
      'status.warning': 'High Usage',
      'status.critical': 'Critical',

      'header.updated': 'Updated {time}',
      'header.never': 'Not loaded yet',
      'header.refresh': 'Refresh now',
      'header.refreshing': 'Refreshing\u2026',
      'header.settings': 'Settings',
      'header.saved': 'Settings saved.',

      'alert.region': 'Active alerts',
      'alert.since': 'since {time}',
      'alert.burn.title': 'Burn rate is {ratio}\u00d7 the 24h average',
      'alert.burn.detail': 'Now {current} vs {baseline} over the previous 24h.',
      'alert.cache.title': 'Cache hit rate is low',
      'alert.cache.detail': '{rate} over the last hour (baseline {baseline}), below the {threshold} warning threshold for {minutes} min.',
      'alert.cache.detailNoBaseline': '{rate} over the last hour, below the {threshold} warning threshold for {minutes} min.',
      'alert.cost.title': '{amount} spent in the last 10 minutes',
      'alert.cost.detail': 'The configured 10-minute cost-spike threshold is {threshold}.',
      'alert.uncached.title': 'Uncached input tokens surged',
      'alert.uncached.detail': '{tokens} uncached input tokens in 30 minutes vs {baseline} typical.',
      'alert.balance.title': 'Balance below {threshold}',
      'alert.balance.detail': 'Current balance is {balance}.',

      'anomaly.burn.title': 'Burn rate reached {ratio}\u00d7 the 24h average',
      'anomaly.burn.detail': 'Now {current} vs {baseline} over the previous 24h.',
      'anomaly.burn.detailBucket': 'This 5-minute bucket cost {ratio}\u00d7 the 24h average per-bucket cost.',
      'anomaly.cache.title': 'Cache hit rate dropped to {rate}',
      'anomaly.cache.detail': 'The 24h baseline is {baseline}.',
      'anomaly.cache.detailNoBaseline': 'Cache hit rate in this bucket was {rate}.',
      'anomaly.cacheProblem.title': 'Possible cache problem detected',
      'anomaly.cacheProblem.detail': 'Cache hit rate fell {delta} while burn rate is {ratio}\u00d7 normal.',
      'anomaly.cacheLow.title': 'Cache hit rate is low',
      'anomaly.cacheLow.detail': '{rate} over the last hour (baseline {baseline}), below the {threshold} warning threshold for {minutes} min.',
      'anomaly.uncached.title': 'Uncached input tokens surged',
      'anomaly.uncached.detail': '{tokens} uncached input tokens in 30 minutes vs {baseline} typical.',
      'anomaly.spike.title': 'Request rate spiked',
      'anomaly.spike.detail': '{requests} requests in 5 minutes vs {baseline} typical.',
      'anomaly.inputGrowth.title': 'Average input context grew',
      'anomaly.inputGrowth.detail': '{recent} tokens now vs {baseline} before ({ratio}\u00d7 larger).',
      'anomaly.modelShare.title': 'One model dominates estimated cost',
      'anomaly.modelShare.detail': '{model} accounts for {rate} of estimated cost.',
      'anomaly.cost.title': '{amount} spent in the last 10 minutes',
      'anomaly.cost.detail': 'The configured 10-minute cost-spike threshold is {threshold}.',
      'anomaly.session.title': 'One session dominates uncached input',
      'anomaly.session.detail': '{session} accounts for {rate} of uncached input in the last 24 hours.',
      'anomaly.balance.title': 'Balance below {threshold}',
      'anomaly.balance.detail': 'Current balance is {balance}.',
      'anomaly.recovered.title': 'Usage returned to normal',
      'anomaly.recovered.detail': 'The previous condition is no longer active.',
      'anomaly.recovered.detailWith': 'The previous condition is no longer active: {condition}.',

      'condition.burn-rate': 'burn rate',
      'condition.cache-low': 'low cache hit rate',
      'condition.cache-hit-drop': 'cache hit-rate drop',
      'condition.cost-spike': 'cost spike',
      'condition.uncached-burst': 'uncached input burst',
      'condition.cache-problem-correlated': 'cache problem',
      'condition.balance-low': 'low balance',

      'diag.cache-hit-drop.title': 'Cache hit rate dropped {delta} vs the previous 24h',
      'diag.cache-hit-drop.detail': 'Last hour {current} vs {baseline} baseline. Cost grows even when token volume is flat because cache hits are much cheaper.',
      'diag.cache-low.title': 'Cache hit rate is low',
      'diag.cache-low.detail': '{rate} over the last hour (baseline {baseline}), below the {threshold} warning threshold for {minutes} min.',
      'diag.uncached-burst.title': 'Uncached input tokens surged',
      'diag.uncached-burst.detail': '{tokens} uncached input tokens in 30 minutes vs {baseline} typical.',
      'diag.cache-problem-correlated.title': 'Possible cache problem detected',
      'diag.cache-problem-correlated.detail': 'Burn rate is {ratio}\u00d7 normal while the cache hit rate fell {delta}. Cache misses are the most likely cost driver.',
      'diag.system-prompt-changing.title': 'System prompt changed inside "{session}"',
      'diag.system-prompt-changing.detail': '{hashes} distinct system-prompt hashes were recorded; only a stable prefix can be cached.',
      'diag.request-epoch-change.title': 'Cached prefix reset {count} time(s) in "{session}"',
      'diag.request-epoch-change.detail': 'A request-header change starts a new request epoch: tools, system prompt or model changed, so the provider cannot reuse the previous prefix.',
      'diag.toolset-change.title': 'Tool list size changed {count} time(s) in "{session}"',
      'diag.toolset-change.detail': 'Adding or removing tools changes the request prefix; every change invalidates the cacheable prefix after it.',
      'diag.model-switch.title': 'Model switched inside "{session}"',
      'diag.model-switch.detail': 'Models observed: {models}. Provider caches are per model, so switching always misses first.',
      'diag.compaction-cache-break.title': 'Compaction ran {count} time(s) in "{session}"',
      'diag.compaction-cache-break.detail': 'Compaction rewrites history; the first request after it cannot reuse the previous prefix.',
      'diag.ttl-gap.title': 'First request after a long pause missed the cache in "{session}"',
      'diag.ttl-gap.detail': '{samples} requests followed a gap of more than 30 minutes and hit only {rate} of their prompt tokens.',
      'diag.uuid-or-timestamp-in-prefix.title': 'Timestamp/UUID-like text found in "{session}" system prompt',
      'diag.uuid-or-timestamp-in-prefix.detail': 'A timestamp or UUID regenerated on every request makes the prefix different every time and defeats prefix caching.',
      'diag.cache-not-reported.title': 'Provider did not report cache counters in "{session}"',
      'diag.cache-not-reported.detail': 'Every request reported zero cached tokens; the model or provider may not support prefix caching.',
      'diag.context-growth.title': 'Average input context grew to {tokens} tokens',
      'diag.context-growth.detail': 'It was {baseline} tokens on average over the previous 24 hours; a larger context makes every cache miss more expensive.',

      'kpi.balance': 'Current balance',
      'kpi.bonus': 'Bonus {amount}',
      'kpi.total': 'Total {amount}',
      'kpi.today': 'Today',
      'kpi.lastHour': 'Last hour',
      'kpi.burn': 'Burn rate',
      'kpi.perHour': '{amount}/h',
      'kpi.est': 'Est.',
      'kpi.estHint': 'Estimated from token counts and the official pricing table. This is not a bill.',
      'kpi.observed': 'Observed spend {amount}',
      'kpi.burnHigher': '{ratio}\u00d7 higher than the 24h average',
      'kpi.burnLower': '{ratio}\u00d7 lower than the 24h average',
      'kpi.burnNormal': 'Around the 24h average',
      'kpi.burnNoBaseline': 'No 24h baseline yet',
      'kpi.usageMeta': '{requests} requests \u00b7 {tokens} tokens',
      'kpi.rateMeta': '{requests} req/min \u00b7 {tokens} tok/min',
      'kpi.burnBaseline': '24h average {amount}/h',

      'balance.signedOut': 'Not signed in',
      'balance.signedOutHint': 'Sign in to the DeepSeek account platform to see the balance. Usage estimates still work.',
      'balance.error': 'Balance unavailable',
      'balance.errorHint': 'The balance API did not respond. Usage estimates still work.',
      'balance.unavailable': 'Balance not available',
      'balance.unavailableHint': 'This account does not expose a wallet balance. Usage estimates still work.',
      'balance.empty': 'No wallet balance',
      'balance.fetched': 'Balance read {time}',

      'range.label': 'Range',
      'range.aria': 'Show usage for the last {range}',
      'range.updating': 'Updating range\u2026',

      'trend.title': 'Usage trend',
      'trend.legendCost': 'Estimated cost',
      'trend.legendTokens': 'Tokens',
      'trend.legendTokensHint': 'The token line is scaled to its own peak so the shape is visible; hover the chart for exact values.',
      'trend.empty': 'No usage recorded in this window.',
      'trend.aria': 'Estimated cost and token usage for the last {range}: {points} buckets, peak {peak}.',

      'chart.cost': 'Cost',
      'chart.tokens': 'Tokens',
      'chart.requests': 'Requests',
      'chart.hitRate': 'Cache hit rate',

      'cache.title': 'Cache hit rate',
      'cache.window': 'Last hour',
      'cache.baseline': '24h baseline {rate}',
      'cache.deltaUp': 'up {delta} vs the 24h baseline',
      'cache.deltaDown': 'down {delta} vs the 24h baseline',
      'cache.deltaFlat': 'in line with the 24h baseline',
      'cache.hits': 'Cache hits',
      'cache.misses': 'Cache misses',
      'cache.writes': 'Cache writes',
      'cache.savings': 'Estimated savings {amount} (24h)',
      'cache.savingsHint': 'Estimated difference compared with billing every input token at the cache-miss price over the last 24 hours.',
      'cache.trendAria': 'Cache hit rate trend over the last hour, with the 24h baseline band.',
      'cache.empty': 'No cache data in this window.',

      'rate.title': 'Request rate',
      'rate.now': '{value} req/min',
      'rate.baseline': '24h average {value} req/min',
      'rate.multiplier': '{ratio}\u00d7 the 24h average',
      'rate.noBaseline': 'No 24h average yet',
      'rate.avgInput': 'Avg input / request',
      'rate.uncachedPerMin': 'Uncached input / min',
      'rate.sparkAria': 'Requests per bucket over the last {range}, {points} buckets.',
      'rate.empty': 'No requests in this window.',

      'consumers.title': 'Top consumers',
      'consumers.groups': 'Group by',
      'consumers.sessions': 'Sessions',
      'consumers.tasks': 'Tasks',
      'consumers.presets': 'Agent presets',
      'consumers.uncached': 'Uncached tokens',
      'consumers.hit': 'cache {rate}',
      'consumers.share': '{rate} of cost',
      'consumers.more': '{count} more not shown',
      'consumers.empty': 'No usage recorded in this window.',

      'models.title': 'Model usage',
      'models.hit': 'cache {rate}',
      'models.breakdown': 'uncached input {input}, cached input {cached}, output {output}',
      'models.noPricing': 'No pricing',
      'models.share': '{rate} of cost',
      'models.empty': 'No model usage recorded in this window.',

      'why.title': 'Why is usage high?',
      'why.empty': 'No abnormal usage detected in this window.',
      'why.emptyHint': 'Burn rate, cache hit rate and request volume are within the thresholds configured in Settings.',
      'why.more': '{count} more findings',
      'why.burn.title': 'Burn rate above normal',
      'why.burn.detail': '{ratio}\u00d7 the 24h average, above the {threshold}\u00d7 warning threshold.',
      'why.cache.title': 'Cache hit rate below its baseline',
      'why.cache.detail': '{recent} now vs {baseline} on the 24h baseline.',
      'why.uncached.title': 'One session dominates uncached input',
      'why.uncached.detail': '{label} accounts for {rate} of uncached input in the last 24 hours.',
      'why.model.title': 'One model dominates estimated cost',
      'why.model.detail': '{model} accounts for {rate} of estimated cost.',

      'severity.info': 'Info',
      'severity.warning': 'Warning',
      'severity.critical': 'Critical',

      'evidence.requests': 'requests',
      'evidence.tokens': 'tokens',
      'evidence.headerChanges': 'header changes',
      'evidence.hitRateAfterChange': 'hit rate after change',
      'evidence.toolCountChanges': 'tool-set changes',
      'evidence.modelChanges': 'model changes',
      'evidence.systemPromptHashes': 'system-prompt hashes',
      'evidence.systemMessages': 'system messages',
      'evidence.burnPerHour': 'burn / hour',
      'evidence.baselinePerHour': 'baseline / hour',
      'evidence.ratio': 'ratio',
      'evidence.recent': 'recent',
      'evidence.baseline': 'baseline',
      'evidence.uncachedTokens': 'uncached tokens',
      'evidence.share': 'share',
      'evidence.hitTokens': 'cached tokens',
      'evidence.missTokens': 'uncached tokens',
      'evidence.minutes': 'minutes',
      'evidence.hitRate': 'hit rate',
      'evidence.sessionRequests': 'session requests',
      'evidence.toolListSizes': 'tool list sizes',
      'evidence.models': 'models',
      'evidence.compactions': 'compactions',
      'evidence.afterGapSamples': 'requests after gap',
      'evidence.afterGapHitRate': 'hit rate after gap',
      'evidence.uuidHits': 'UUID matches',
      'evidence.timestampHits': 'timestamp matches',
      'evidence.cacheMissing': 'missing cache reports',
      'evidence.cacheReported': 'cache reports',
      'evidence.recentAverage': 'recent average',
      'evidence.baselineAverage': 'baseline average',
      'evidence.multiplier': 'multiplier',
      'evidence.lastHour': 'last hour',
      'evidence.delta': 'change',
      'evidence.burnRatio': 'burn ratio',
      'evidence.hitRateDelta': 'hit-rate change',
      'evidence.sustainedMinutes': 'sustained minutes',
      'evidence.last10mCost': 'last-10-minute cost',
      'evidence.threshold': 'threshold',
      'evidence.balance': 'balance',
      'evidence.bonus': 'including bonus',
      'evidence.condition': 'condition',

      'anomalies.title': 'Anomaly timeline',
      'anomalies.aria': 'Anomaly timeline, newest first',
      'anomalies.empty': 'No anomalies recorded.',
      'anomalies.session': 'session',
      'anomalies.more': '{count} more',

      'forecast.title': 'Forecast',
      'forecast.daily': 'Estimated daily cost',
      'forecast.dailyBaseline': 'At the 24h average: {amount}/day',
      'forecast.remaining': 'Estimated remaining time',
      'forecast.basis': 'Estimate based on recent usage.',
      'forecast.unknown': 'Not enough data yet.',

      'footer.sources': 'Data sources',
      'footer.balance': 'Balance \u00b7 {kind} ({state})',
      'footer.tokens': 'Session events \u00b7 {sessions} sessions \u00b7 {requests} requests',
      'footer.pricing': 'Pricing \u00b7 official table as of {asOf}',
      'footer.pricingUnknown': 'Pricing \u00b7 no table loaded',
      'footer.scanning': 'Scan in progress\u2026',
      'footer.scanned': '{sessions} sessions scanned at {time}',
      'footer.scanIdle': 'Not scanned yet',
      'footer.scanErrors': '{count} scan errors',
      'footer.privacy': 'All data stays on this machine; only the authenticated balance call leaves it.',
      'footer.warningsOne': '1 diagnostic warning',
      'footer.warningsMany': '{count} diagnostic warnings',
      'empty.title': 'No usage recorded yet',
      'empty.hint': 'Usage appears here after the first model request. Balance updates keep running in the background.',

      'error.title': 'Could not load usage data',
      'error.http': 'The server returned HTTP {status}.',
      'error.network': 'The Harness host did not answer. Check that it is running, then retry.',
      'error.invalid': 'The server returned an unexpected response.',
      'error.timeout': 'The request timed out. Retry to read a new snapshot.',
      'error.unauthorizedTitle': 'Session expired',
      'error.unauthorizedBody': 'Session expired \u2014 reopen the Harness page to sign in again.',
      'error.retry': 'Retry',
      'error.reconnecting': 'Reconnecting \u00b7 last data {time}',

      'settings.title': 'Settings',
      'settings.close': 'Close settings',
      'settings.hint': 'Stored by the Harness plugin and applied immediately.',
      'settings.sectionBurn': 'Burn rate',
      'settings.sectionCache': 'Cache',
      'settings.sectionRate': 'Requests and spend',
      'settings.sectionBalance': 'Balance and storage',
      'settings.burnWarning': 'Warning ratio',
      'settings.burnCritical': 'Critical ratio',
      'settings.cacheWarning': 'Warning hit rate',
      'settings.cacheCritical': 'Critical hit rate',
      'settings.cacheAlertMinutes': 'Cache alert window',
      'settings.requestMultiplier': 'Request-rate multiplier',
      'settings.costSpike': '10-minute cost spike',
      'settings.balanceAlerts': 'Low-balance alerts',
      'settings.balanceAlertsHint': 'Comma-separated amounts',
      'settings.balanceRefresh': 'Balance refresh interval',
      'settings.retention': 'Retention',
      'settings.currency': 'Display currency',
      'settings.currencyAuto': 'Auto (from wallet)',
      'settings.save': 'Save',
      'settings.saving': 'Saving\u2026',
      'settings.discard': 'Discard',
      'settings.failed': 'Could not save settings.',
      'settings.serverAdjusted': 'The Host adjusted these values:',
      'settings.errNumber': 'Enter a valid number.',
      'settings.errMin': 'Enter a number \u2265 {min}.',
      'settings.errMax': 'Enter a number \u2264 {max}.',
      'settings.errOrderUp': 'Critical must be at or above the warning ratio.',
      'settings.errOrderDown': 'Critical must not be above the warning hit rate.',
      'settings.errList': 'Enter at least one positive amount, separated by commas.',
      'settings.errCurrency': 'Choose a supported currency.',

      'unit.pp': 'pp',
      'unit.req': 'req',
      'unit.reqPerMin': 'req/min',
      'unit.tokens': 'tokens',
    };

    const zh = {
      nav: '用量',
      'page.title': '用量监控',
      'page.subtitle': '查看当前 Harness 的余额、消耗、缓存命中率与异常情况。',
      'page.loading': '正在加载用量数据\u2026',

      'status.normal': '正常',
      'status.warning': '用量偏高',
      'status.critical': '严重',

      'header.updated': '更新于 {time}',
      'header.never': '尚未加载',
      'header.refresh': '立即刷新',
      'header.refreshing': '正在刷新\u2026',
      'header.settings': '设置',
      'header.saved': '设置已保存。',

      'alert.region': '当前告警',
      'alert.since': '自 {time} 起',
      'alert.burn.title': '消耗速率达到 24 小时均值的 {ratio}\u00d7',
      'alert.burn.detail': '当前 {current}，此前 24 小时均值为 {baseline}。',
      'alert.cache.title': '缓存命中率偏低',
      'alert.cache.detail': '{rate}（最近一小时，基线 {baseline}），已持续 {minutes} 分钟低于 {threshold} 的警告阈值。',
      'alert.cache.detailNoBaseline': '{rate}（最近一小时），已持续 {minutes} 分钟低于 {threshold} 的警告阈值。',
      'alert.cost.title': '最近 10 分钟花费 {amount}',
      'alert.cost.detail': '配置的 10 分钟花费突增阈值为 {threshold}。',
      'alert.uncached.title': '未命中缓存的输入 Token 激增',
      'alert.uncached.detail': '最近 30 分钟未命中输入 {tokens} Token，通常约为 {baseline}。',
      'alert.balance.title': '余额低于 {threshold}',
      'alert.balance.detail': '当前余额为 {balance}。',

      'anomaly.burn.title': '消耗速率达到 24 小时均值的 {ratio}\u00d7',
      'anomaly.burn.detail': '当前 {current}，此前 24 小时均值为 {baseline}。',
      'anomaly.burn.detailBucket': '该 5 分钟分桶花费为 24 小时平均分桶的 {ratio}\u00d7。',
      'anomaly.cache.title': '缓存命中率降至 {rate}',
      'anomaly.cache.detail': '24 小时基线为 {baseline}。',
      'anomaly.cache.detailNoBaseline': '该分桶的缓存命中率为 {rate}。',
      'anomaly.cacheProblem.title': '检测到可能的缓存问题',
      'anomaly.cacheProblem.detail': '缓存命中率下降 {delta}，同时消耗速率为正常水平的 {ratio}\u00d7。',
      'anomaly.cacheLow.title': '缓存命中率偏低',
      'anomaly.cacheLow.detail': '{rate}（最近一小时，基线 {baseline}），已持续 {minutes} 分钟低于 {threshold} 的警告阈值。',
      'anomaly.uncached.title': '未命中缓存的输入 Token 激增',
      'anomaly.uncached.detail': '最近 30 分钟未命中输入 {tokens} Token，通常约为 {baseline}。',
      'anomaly.spike.title': '请求速率突增',
      'anomaly.spike.detail': '5 分钟内 {requests} 次请求，通常约为 {baseline}。',
      'anomaly.inputGrowth.title': '平均输入上下文增长',
      'anomaly.inputGrowth.detail': '当前平均 {recent} Token，此前为 {baseline} Token（放大 {ratio}\u00d7）。',
      'anomaly.modelShare.title': '单个模型贡献了大部分估算费用',
      'anomaly.modelShare.detail': '{model} 占估算费用的 {rate}。',
      'anomaly.cost.title': '最近 10 分钟花费 {amount}',
      'anomaly.cost.detail': '配置的 10 分钟花费突增阈值为 {threshold}。',
      'anomaly.session.title': '单个会话贡献了大部分未命中输入',
      'anomaly.session.detail': '{session} 占最近 24 小时未命中输入的 {rate}。',
      'anomaly.balance.title': '余额低于 {threshold}',
      'anomaly.balance.detail': '当前余额为 {balance}。',
      'anomaly.recovered.title': '用量已恢复正常',
      'anomaly.recovered.detail': '此前的异常条件已不再触发。',
      'anomaly.recovered.detailWith': '此前的异常条件已不再触发：{condition}。',

      'condition.burn-rate': '消耗速率',
      'condition.cache-low': '缓存命中率过低',
      'condition.cache-hit-drop': '缓存命中率下降',
      'condition.cost-spike': '花费突增',
      'condition.uncached-burst': '未命中输入突增',
      'condition.cache-problem-correlated': '缓存问题',
      'condition.balance-low': '余额过低',

      'diag.cache-hit-drop.title': '缓存命中率比此前 24 小时下降 {delta}',
      'diag.cache-hit-drop.detail': '最近一小时 {current}，基线 {baseline}。即使 Token 总量不变，费用也会上升，因为缓存命中便宜得多。',
      'diag.cache-low.title': '缓存命中率偏低',
      'diag.cache-low.detail': '{rate}（最近一小时，基线 {baseline}），已持续 {minutes} 分钟低于 {threshold} 的警告阈值。',
      'diag.uncached-burst.title': '未命中缓存的输入 Token 激增',
      'diag.uncached-burst.detail': '最近 30 分钟未命中输入 {tokens} Token，通常约为 {baseline}。',
      'diag.cache-problem-correlated.title': '检测到可能的缓存问题',
      'diag.cache-problem-correlated.detail': '消耗速率为正常水平的 {ratio}\u00d7，同时缓存命中率下降 {delta}；缓存未命中是最可能的费用驱动因素。',
      'diag.system-prompt-changing.title': '“{session}”内的系统提示发生变化',
      'diag.system-prompt-changing.detail': '记录到 {hashes} 个不同的系统提示哈希；只有稳定的前缀才能被缓存。',
      'diag.request-epoch-change.title': '“{session}”内的缓存前缀被重置 {count} 次',
      'diag.request-epoch-change.detail': '请求头变化会开启新的请求纪元：工具、系统提示或模型发生变化，服务商无法复用此前的前缀。',
      'diag.toolset-change.title': '“{session}”内的工具列表大小变化 {count} 次',
      'diag.toolset-change.detail': '增加或移除工具会改变请求前缀；每次变化都会让之后的可缓存前缀失效。',
      'diag.model-switch.title': '“{session}”内发生模型切换',
      'diag.model-switch.detail': '观测到的模型：{models}。服务商缓存按模型隔离，切换后首次请求必然未命中。',
      'diag.compaction-cache-break.title': '“{session}”内执行了 {count} 次压缩',
      'diag.compaction-cache-break.detail': '压缩会重写历史；压缩后的第一次请求无法复用此前的前缀。',
      'diag.ttl-gap.title': '“{session}”长时间停顿后的首次请求未命中缓存',
      'diag.ttl-gap.detail': '{samples} 次请求发生在超过 30 分钟的停顿之后，仅命中 {rate} 的提示 Token。',
      'diag.uuid-or-timestamp-in-prefix.title': '“{session}”系统提示中疑似包含时间戳 / UUID',
      'diag.uuid-or-timestamp-in-prefix.detail': '每次请求都重新生成的时间戳或 UUID 会使前缀每次都不同，从而使前缀缓存失效。',
      'diag.cache-not-reported.title': '服务商未上报“{session}”的缓存计数',
      'diag.cache-not-reported.detail': '每次请求的缓存 Token 都为零；该模型或服务商可能不支持前缀缓存。',
      'diag.context-growth.title': '平均输入上下文增长到 {tokens} Token',
      'diag.context-growth.detail': '此前 24 小时平均为 {baseline} Token；上下文越大，每次缓存未命中的代价越高。',

      'kpi.balance': '当前余额',
      'kpi.bonus': '赠送 {amount}',
      'kpi.total': '合计 {amount}',
      'kpi.today': '今日',
      'kpi.lastHour': '最近一小时',
      'kpi.burn': '消耗速率',
      'kpi.perHour': '{amount}/小时',
      'kpi.est': 'Est.',
      'kpi.estHint': '按 Token 数量与官方价目表估算，并非真实账单。',
      'kpi.observed': '已观测扣费 {amount}',
      'kpi.burnHigher': '比 24 小时均值高 {ratio}\u00d7',
      'kpi.burnLower': '比 24 小时均值低 {ratio}\u00d7',
      'kpi.burnNormal': '与 24 小时均值接近',
      'kpi.burnNoBaseline': '尚无 24 小时基线',
      'kpi.usageMeta': '{requests} 次请求 \u00b7 {tokens} Token',
      'kpi.rateMeta': '{requests} 次/分钟 \u00b7 {tokens} Token/分钟',
      'kpi.burnBaseline': '24 小时平均 {amount}/小时',

      'balance.signedOut': '未登录',
      'balance.signedOutHint': '登录 DeepSeek 开放平台账号后才能读取余额；用量估算仍然可用。',
      'balance.error': '余额不可用',
      'balance.errorHint': '余额接口没有响应；用量估算仍然可用。',
      'balance.unavailable': '无法读取余额',
      'balance.unavailableHint': '当前账号不提供钱包余额；用量估算仍然可用。',
      'balance.empty': '没有钱包余额',
      'balance.fetched': '余额读取于 {time}',

      'range.label': '时间范围',
      'range.aria': '显示最近 {range} 的用量',
      'range.updating': '正在切换范围\u2026',

      'trend.title': '用量趋势',
      'trend.legendCost': '估算费用',
      'trend.legendTokens': 'Token',
      'trend.legendTokensHint': 'Token 折线按自身峰值缩放以便看清走势；悬停图表可查看准确数值。',
      'trend.empty': '该时间范围内没有用量记录。',
      'trend.aria': '最近 {range} 的估算费用与 Token 用量：共 {points} 个分桶，峰值 {peak}。',

      'chart.cost': '费用',
      'chart.tokens': 'Token',
      'chart.requests': '请求',
      'chart.hitRate': '缓存命中率',

      'cache.title': '缓存命中率',
      'cache.window': '最近一小时',
      'cache.baseline': '24 小时基线 {rate}',
      'cache.deltaUp': '比 24 小时基线高 {delta}',
      'cache.deltaDown': '比 24 小时基线低 {delta}',
      'cache.deltaFlat': '与 24 小时基线持平',
      'cache.hits': '缓存命中',
      'cache.misses': '缓存未命中',
      'cache.writes': '缓存写入',
      'cache.savings': '预计节省 {amount}（24h）',
      'cache.savingsHint': '相对全部输入按未命中缓存价格计费的估算差额（最近 24 小时）。',
      'cache.trendAria': '最近一小时的缓存命中率走势，并标出 24 小时基线区间。',
      'cache.empty': '该时间范围内没有缓存数据。',

      'rate.title': '请求速率',
      'rate.now': '{value} 次/分钟',
      'rate.baseline': '24 小时平均 {value} 次/分钟',
      'rate.multiplier': '是 24 小时均值的 {ratio}\u00d7',
      'rate.noBaseline': '尚无 24 小时均值',
      'rate.avgInput': '每次请求平均输入',
      'rate.uncachedPerMin': '未命中缓存输入/分钟',
      'rate.sparkAria': '最近 {range} 每个分桶的请求数，共 {points} 个分桶。',
      'rate.empty': '该时间范围内没有请求。',

      'consumers.title': '消耗排行',
      'consumers.groups': '分组方式',
      'consumers.sessions': '会话',
      'consumers.tasks': '任务',
      'consumers.presets': 'Agent 预设',
      'consumers.uncached': '未命中缓存',
      'consumers.hit': '缓存 {rate}',
      'consumers.share': '占费用 {rate}',
      'consumers.more': '还有 {count} 行未显示',
      'consumers.empty': '该时间范围内没有用量记录。',

      'models.title': '模型用量',
      'models.hit': '缓存 {rate}',
      'models.breakdown': '未命中输入 {input}，命中输入 {cached}，输出 {output}',
      'models.noPricing': '无价目',
      'models.share': '占费用 {rate}',
      'models.empty': '该时间范围内没有模型用量记录。',

      'why.title': '为什么用量偏高？',
      'why.empty': '该时间范围内未发现异常用量。',
      'why.emptyHint': '消耗速率、缓存命中率与请求量均在设置中的阈值范围内。',
      'why.more': '还有 {count} 条发现',
      'why.burn.title': '消耗速率高于正常水平',
      'why.burn.detail': '为 24 小时均值的 {ratio}\u00d7，已超过 {threshold}\u00d7 的告警阈值。',
      'why.cache.title': '缓存命中率低于基线',
      'why.cache.detail': '当前 {recent}，24 小时基线为 {baseline}。',
      'why.uncached.title': '单个会话贡献了大部分未命中输入',
      'why.uncached.detail': '{label} 占最近 24 小时未命中输入的 {rate}。',
      'why.model.title': '单个模型贡献了大部分估算费用',
      'why.model.detail': '{model} 占估算费用的 {rate}。',

      'severity.info': '提示',
      'severity.warning': '警告',
      'severity.critical': '严重',

      'evidence.requests': '请求数',
      'evidence.tokens': 'Token',
      'evidence.headerChanges': '请求头变化',
      'evidence.hitRateAfterChange': '变化后命中率',
      'evidence.toolCountChanges': '工具集变化',
      'evidence.modelChanges': '模型变化',
      'evidence.systemPromptHashes': '系统提示哈希',
      'evidence.systemMessages': '系统消息数',
      'evidence.burnPerHour': '消耗/小时',
      'evidence.baselinePerHour': '基线/小时',
      'evidence.ratio': '倍数',
      'evidence.recent': '当前',
      'evidence.baseline': '基线',
      'evidence.uncachedTokens': '未命中 Token',
      'evidence.share': '占比',
      'evidence.hitTokens': '命中 Token',
      'evidence.missTokens': '未命中 Token',
      'evidence.minutes': '分钟',
      'evidence.hitRate': '命中率',
      'evidence.sessionRequests': '会话请求数',
      'evidence.toolListSizes': '工具列表大小',
      'evidence.models': '模型',
      'evidence.compactions': '压缩次数',
      'evidence.afterGapSamples': '停顿后请求数',
      'evidence.afterGapHitRate': '停顿后命中率',
      'evidence.uuidHits': 'UUID 命中',
      'evidence.timestampHits': '时间戳命中',
      'evidence.cacheMissing': '缺少缓存上报',
      'evidence.cacheReported': '缓存上报数',
      'evidence.recentAverage': '近期平均',
      'evidence.baselineAverage': '基线平均',
      'evidence.multiplier': '倍数',
      'evidence.lastHour': '最近一小时',
      'evidence.delta': '变化',
      'evidence.burnRatio': '消耗倍数',
      'evidence.hitRateDelta': '命中率变化',
      'evidence.sustainedMinutes': '持续分钟',
      'evidence.last10mCost': '最近 10 分钟花费',
      'evidence.threshold': '阈值',
      'evidence.balance': '余额',
      'evidence.bonus': '含赠送',
      'evidence.condition': '条件',

      'anomalies.title': '异常时间线',
      'anomalies.aria': '异常时间线，由新到旧',
      'anomalies.empty': '没有记录到异常。',
      'anomalies.session': '会话',
      'anomalies.more': '还有 {count} 条',

      'forecast.title': '预测',
      'forecast.daily': '预计每日费用',
      'forecast.dailyBaseline': '按 24 小时均值：{amount}/天',
      'forecast.remaining': '预计可用时间',
      'forecast.basis': '基于最近用量的估算。',
      'forecast.unknown': '数据不足。',

      'footer.sources': '数据来源',
      'footer.balance': '余额 \u00b7 {kind}（{state}）',
      'footer.tokens': '会话事件 \u00b7 扫描 {sessions} 个会话 \u00b7 {requests} 次请求',
      'footer.pricing': '价目 \u00b7 官方价目表（{asOf}）',
      'footer.pricingUnknown': '价目 \u00b7 尚未加载价目表',
      'footer.scanning': '正在扫描\u2026',
      'footer.scanned': '已于 {time} 扫描 {sessions} 个会话',
      'footer.scanIdle': '尚未扫描',
      'footer.scanErrors': '{count} 个扫描错误',
      'footer.privacy': '所有数据都保存在本机；只有经过身份验证的余额请求会离开本机。',
      'footer.warningsOne': '诊断警告 1 条',
      'footer.warningsMany': '诊断警告 {count} 条',
      'empty.title': '尚无用量记录',
      'empty.hint': '发出第一次模型请求后，用量会显示在这里。余额轮询会继续在后台运行。',

      'error.title': '无法加载用量数据',
      'error.http': '服务端返回 HTTP {status}。',
      'error.network': 'Harness 宿主没有响应。请确认它正在运行，然后重试。',
      'error.invalid': '服务端返回了无法识别的响应。',
      'error.timeout': '请求超时。请重试以读取新的快照。',
      'error.unauthorizedTitle': '会话已过期',
      'error.unauthorizedBody': '会话已过期 \u2014 请重新打开 Harness 页面以重新登录。',
      'error.retry': '重试',
      'error.reconnecting': '正在重连 \u00b7 上次数据 {time}',

      'settings.title': '设置',
      'settings.close': '关闭设置',
      'settings.hint': '由 Harness 插件保存，保存后立即生效。',
      'settings.sectionBurn': '消耗速率',
      'settings.sectionCache': '缓存',
      'settings.sectionRate': '请求与花费',
      'settings.sectionBalance': '余额与存储',
      'settings.burnWarning': '警告倍数',
      'settings.burnCritical': '严重倍数',
      'settings.cacheWarning': '命中率警告阈值',
      'settings.cacheCritical': '命中率严重阈值',
      'settings.cacheAlertMinutes': '缓存告警时间窗',
      'settings.requestMultiplier': '请求速率告警倍数',
      'settings.costSpike': '10 分钟花费突增阈值',
      'settings.balanceAlerts': '低余额告警',
      'settings.balanceAlertsHint': '以逗号分隔的金额',
      'settings.balanceRefresh': '余额刷新间隔',
      'settings.retention': '数据保留',
      'settings.currency': '显示币种',
      'settings.currencyAuto': '自动（跟随钱包）',
      'settings.save': '保存',
      'settings.saving': '正在保存\u2026',
      'settings.discard': '放弃',
      'settings.failed': '无法保存设置。',
      'settings.serverAdjusted': '宿主调整了以下设置：',
      'settings.errNumber': '请输入有效数字。',
      'settings.errMin': '请输入不小于 {min} 的数字。',
      'settings.errMax': '请输入不大于 {max} 的数字。',
      'settings.errOrderUp': '严重倍数不能低于警告倍数。',
      'settings.errOrderDown': '严重命中率阈值不能高于警告阈值。',
      'settings.errList': '请至少输入一个正数金额，以逗号分隔。',
      'settings.errCurrency': '请选择受支持的币种。',

      'unit.pp': '个百分点',
      'unit.req': '次',
      'unit.reqPerMin': '次/分钟',
      'unit.tokens': 'Token',
    };

    /**
     * Last-resort translator. The slot system injects `t` because the registration passes
     * `locale: NS`; this only keeps a broken/incomplete locale host from blanking the page.
     */
    function fallbackTranslate(key) {
      return en[key] !== undefined ? en[key] : key;
    }

    /* ---------------------------------------------------------------------------------------- *
     * Formatters — all display formatting is Intl-based, never currency conversion.
     * ---------------------------------------------------------------------------------------- */

    /** Resolve the active UI locale: live document language first, then the snapshot, then navigator. */
    function resolveLang(snapshot) {
      try {
        const docLang = document.documentElement.getAttribute('lang');
        if (docLang) return docLang;
      } catch (err) { /* ignore: non-browser verification contexts */ }
      if (snapshot && typeof snapshot.locale === 'string' && snapshot.locale) return snapshot.locale;
      try {
        if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
      } catch (err) { /* ignore */ }
      return 'en';
    }

    /** True when both timestamps fall on the same local calendar day. */
    function sameDay(a, b) {
      const da = new Date(a);
      const db = new Date(b);
      return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    }

    /** `n` is a finite number, otherwise null — keeps chart and formatter guards terse. */
    function num(value) {
      return typeof value === 'number' && isFinite(value) ? value : null;
    }

    /**
     * Build the display formatter bundle for a locale + display currency.
     * Every method accepts null/undefined and returns an em dash, so callers never guard twice.
     */
    function makeFormatters(lang, currency) {
      const safeLang = typeof lang === 'string' && lang ? lang : 'en';
      const code = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : 'CNY';
      const currencyCache = new Map();

      function numberFormat(options) {
        try {
          return new Intl.NumberFormat(safeLang, options);
        } catch (err) {
          try {
            return new Intl.NumberFormat('en', options);
          } catch (err2) {
            return null;
          }
        }
      }

      function dateFormat(options) {
        try {
          return new Intl.DateTimeFormat(safeLang, options);
        } catch (err) {
          try {
            return new Intl.DateTimeFormat('en', options);
          } catch (err2) {
            return null;
          }
        }
      }

      const numberFmt = numberFormat({ maximumFractionDigits: 0 });
      const decimalFmt = numberFormat({ maximumFractionDigits: 1 });
      const compactFmt = numberFormat({ notation: 'compact', maximumFractionDigits: 1 });
      const pctFmt = numberFormat({ style: 'percent', maximumFractionDigits: 1 });
      const timeFmt = dateFormat({ hour: '2-digit', minute: '2-digit' });
      const stampFmt = dateFormat({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const dateFmt = dateFormat({ month: 'short', day: 'numeric' });
      const fullFmt = dateFormat({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const unitDay = numberFormat({ style: 'unit', unit: 'day', unitDisplay: 'long' });
      const unitHour = numberFormat({ style: 'unit', unit: 'hour', unitDisplay: 'long' });
      const unitMinute = numberFormat({ style: 'unit', unit: 'minute', unitDisplay: 'long' });

      function currencyFormatter(target) {
        if (currencyCache.has(target)) return currencyCache.get(target);
        const formatter = numberFormat({ style: 'currency', currency: target, maximumFractionDigits: 2 });
        const compact = numberFormat({ style: 'currency', currency: target, notation: 'compact', maximumFractionDigits: 1 });
        const pair = { formatter, compact };
        currencyCache.set(target, pair);
        return pair;
      }

      function money(value, override) {
        const amount = num(value);
        if (amount == null) return EM_DASH;
        const target = typeof override === 'string' && /^[A-Za-z]{3}$/.test(override) ? override.toUpperCase() : code;
        const pair = currencyFormatter(target);
        if (pair.formatter) return pair.formatter.format(amount);
        return amount.toFixed(2) + ' ' + target;
      }

      function moneyCompact(value) {
        const amount = num(value);
        if (amount == null) return EM_DASH;
        const pair = currencyFormatter(code);
        if (pair.compact) return pair.compact.format(amount);
        return money(amount);
      }

      function duration(hours) {
        const total = num(hours);
        if (total == null || total <= 0) return null;
        const totalMinutes = Math.max(1, Math.round(total * 60));
        const days = Math.floor(totalMinutes / 1440);
        const restHours = Math.floor((totalMinutes % 1440) / 60);
        const restMinutes = totalMinutes % 60;
        const parts = [];
        if (days > 0 && unitDay) parts.push(unitDay.format(days));
        if (restHours > 0 && unitHour) parts.push(unitHour.format(restHours));
        if (days === 0 && restMinutes > 0 && unitMinute) parts.push(unitMinute.format(restMinutes));
        if (!parts.length) return unitMinute ? unitMinute.format(1) : null;
        return parts.join(' ');
      }

      function bucket(ms) {
        const total = num(ms);
        if (total == null || total <= 0) return null;
        const minutes = Math.round(total / 60000);
        if (minutes >= 120 && minutes % 60 === 0) return unitHour ? unitHour.format(minutes / 60) : null;
        return unitMinute ? unitMinute.format(minutes) : null;
      }

      return {
        money,
        moneyCompact,
        number(value) {
          const amount = num(value);
          return amount == null || !numberFmt ? EM_DASH : numberFmt.format(amount);
        },
        decimal(value) {
          const amount = num(value);
          return amount == null || !decimalFmt ? EM_DASH : decimalFmt.format(amount);
        },
        compact(value) {
          const amount = num(value);
          return amount == null || !compactFmt ? EM_DASH : compactFmt.format(amount);
        },
        percent(rate) {
          const value = num(rate);
          return value == null || !pctFmt ? EM_DASH : pctFmt.format(value);
        },
        percentAbs(rate) {
          const value = num(rate);
          return value == null || !pctFmt ? EM_DASH : pctFmt.format(Math.abs(value));
        },
        ratio(value) {
          const amount = num(value);
          return amount == null || !decimalFmt ? EM_DASH : decimalFmt.format(amount);
        },
        time(ms) {
          const stamp = num(ms);
          return stamp == null || !timeFmt ? EM_DASH : timeFmt.format(new Date(stamp));
        },
        stamp(ms) {
          const stamp = num(ms);
          if (stamp == null) return EM_DASH;
          if (sameDay(stamp, Date.now())) return timeFmt ? timeFmt.format(new Date(stamp)) : EM_DASH;
          return stampFmt ? stampFmt.format(new Date(stamp)) : EM_DASH;
        },
        dateTime(ms) {
          const stamp = num(ms);
          return stamp == null || !stampFmt ? EM_DASH : stampFmt.format(new Date(stamp));
        },
        full(ms) {
          const stamp = num(ms);
          return stamp == null || !fullFmt ? EM_DASH : fullFmt.format(new Date(stamp));
        },
        axisTime(ms, range) {
          const stamp = num(ms);
          if (stamp == null) return EM_DASH;
          if (range === '7d' && dateFmt) return dateFmt.format(new Date(stamp));
          if (timeFmt) return timeFmt.format(new Date(stamp));
          return EM_DASH;
        },
        duration,
        bucket,
      };
    }

    /* ---------------------------------------------------------------------------------------- *
     * Data helpers — derive display facts from the snapshot, never invent causes.
     * ---------------------------------------------------------------------------------------- */

    function cx() {
      const parts = [];
      for (let i = 0; i < arguments.length; i += 1) {
        if (arguments[i]) parts.push(arguments[i]);
      }
      return parts.join(' ');
    }

    /** Normalize a server severity; unknown values degrade to `info`. */
    function levelOf(value) {
      return value === 'critical' || value === 'warning' ? value : 'info';
    }

    /** String warnings carried by a snapshot's diagnostics block. */
    function warningList(snapshot) {
      const warnings = snapshot && snapshot.diagnostics && snapshot.diagnostics.warnings;
      if (!Array.isArray(warnings)) return [];
      return warnings.filter((warning) => typeof warning === 'string' && warning);
    }

    /** Requests recorded inside the retention window; 0 means "no usage yet", not an error. */
    function usageCount(snapshot) {
      const info = snapshot && snapshot.diagnostics && snapshot.diagnostics.data;
      if (info && typeof info.requestsInRetention === 'number') return info.requestsInRetention;
      const windowBlock = snapshot && snapshot.cost && snapshot.cost.windows && snapshot.cost.windows.last24h;
      if (windowBlock && typeof windowBlock.requests === 'number') return windowBlock.requests;
      return 0;
    }

    /**
     * Only firing alerts belong in the banner strip. The Host sends firing alerts with a real
     * `since` epoch; a configured-but-not-firing row uses 0 (the demo fixture shows this shape).
     */
    function firingAlerts(alerts) {
      if (!Array.isArray(alerts)) return [];
      return alerts
        .filter((alert) => alert && alert.since > 0 && (alert.level === 'critical' || alert.level === 'warning'))
        .slice()
        .sort((a, b) => {
          if (a.level !== b.level) return a.level === 'critical' ? -1 : 1;
          return a.since - b.since;
        });
    }

    /** Sum the token/cost fields of a `series.points` list. */
    function seriesTotals(points) {
      const totals = {
        requests: 0,
        tokens: 0,
        uncached: 0,
        cached: 0,
        output: 0,
        cost: 0,
        buckets: 0,
      };
      if (!Array.isArray(points)) return totals;
      for (let i = 0; i < points.length; i += 1) {
        const point = points[i];
        if (!point || typeof point.t !== 'number') continue;
        totals.buckets += 1;
        totals.requests += num(point.requests) || 0;
        totals.tokens += num(point.tokens) || 0;
        totals.uncached += num(point.uncachedInputTokens) || 0;
        totals.cached += num(point.cachedInputTokens) || 0;
        totals.output += num(point.outputTokens) || 0;
        totals.cost += num(point.cost) || 0;
      }
      return totals;
    }

    /** Minutes covered by a range id; used for tokens-per-minute derivations. */
    function rangeMinutes(range) {
      if (range === '1h') return 60;
      if (range === '6h') return 360;
      if (range === '7d') return 10080;
      return 1440;
    }

    /** Humanize an unknown evidence key into a readable chip label. */
    function humanizeKey(key) {
      return String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .toLowerCase();
    }

    /** Clamp any 0..1 share/rate the Host sent; shares must never render above 100%. */
    function clamp01(value) {
      const amount = num(value);
      if (amount == null) return null;
      return Math.max(0, Math.min(1, amount));
    }

    /**
     * How each evidence value should render. Keys not listed fall back to a name heuristic
     * (`*Rate` -> percent, `*Tokens` -> compact count, money-looking keys -> currency).
     */
    const EVIDENCE_KINDS = {
      hitRate: 'rate',
      lastHour: 'rate',
      baseline: 'rate',
      delta: 'rate',
      hitRateDelta: 'rate',
      hitRateAfterChange: 'rate',
      afterGapHitRate: 'rate',
      share: 'rate',
      recent: 'rate',
      uncachedTokens: 'tokens',
      hitTokens: 'tokens',
      missTokens: 'tokens',
      tokens: 'tokens',
      recentAverage: 'tokens',
      baselineAverage: 'tokens',
      burnPerHour: 'moneyPerHour',
      baselinePerHour: 'moneyPerHour',
      last10mCost: 'money',
      threshold: 'money',
      balance: 'money',
      bonus: 'money',
      ratio: 'ratio',
      burnRatio: 'ratio',
      multiplier: 'ratio',
      headerChanges: 'count',
      toolCountChanges: 'count',
      modelChanges: 'count',
      systemPromptHashes: 'count',
      systemMessages: 'count',
      requests: 'count',
      minutes: 'count',
      sessionRequests: 'count',
      compactions: 'count',
      afterGapSamples: 'count',
      uuidHits: 'count',
      timestampHits: 'count',
      cacheMissing: 'count',
      cacheReported: 'count',
      sustainedMinutes: 'count',
    };

    /** Evidence keys that have a localized chip label in the dictionaries. */
    const EVIDENCE_LABELS = [
      'requests', 'tokens', 'headerChanges', 'hitRateAfterChange', 'toolCountChanges', 'modelChanges',
      'systemPromptHashes', 'systemMessages', 'burnPerHour', 'baselinePerHour', 'ratio', 'recent',
      'baseline', 'uncachedTokens', 'share', 'hitTokens', 'missTokens', 'minutes',
      'hitRate', 'sessionRequests', 'toolListSizes', 'models', 'compactions', 'afterGapSamples',
      'afterGapHitRate', 'uuidHits', 'timestampHits', 'cacheMissing', 'cacheReported',
      'recentAverage', 'baselineAverage', 'multiplier', 'lastHour', 'delta', 'burnRatio',
      'hitRateDelta', 'sustainedMinutes', 'last10mCost', 'threshold', 'balance', 'bonus', 'condition',
    ];

    /** Opaque diagnostic internals that make noise as chips (the row text already explains them). */
    const EVIDENCE_CHIP_SKIP = ['currency', 'initial', 'series'];

    /** Pick the display kind for an evidence value. */
    function evidenceKind(key) {
      if (Object.prototype.hasOwnProperty.call(EVIDENCE_KINDS, key)) return EVIDENCE_KINDS[key];
      if (/rate/i.test(key)) return 'rate';
      if (/token/i.test(key)) return 'tokens';
      if (/perhour|cost|threshold|balance/i.test(key)) return 'money';
      if (/ratio|multiplier/i.test(key)) return 'ratio';
      return 'count';
    }

    /** Format one evidence value according to its semantic kind. */
    function formatEvidence(key, value, fmt, t, evidence) {
      if (value == null) return EM_DASH;
      if (typeof value === 'boolean') return value ? 'yes' : 'no';
      if (typeof value !== 'number' || !isFinite(value)) return String(value);
      const kind = evidenceKind(key);
      if (kind === 'rate') {
        // Deltas are signed percentage points; absolute rates are 0..1 fractions.
        const signed = /delta|change/i.test(key);
        return fmt.percent(signed ? Math.max(-1, Math.min(1, value)) : clamp01(value));
      }
      if (kind === 'moneyPerHour') return t('kpi.perHour', { amount: fmt.money(value) });
      if (kind === 'money') {
        const currency = evidence && typeof evidence.currency === 'string' && (key === 'balance' || key === 'bonus')
          ? evidence.currency
          : undefined;
        return fmt.money(value, currency);
      }
      if (kind === 'ratio') return fmt.ratio(value) + '\u00d7';
      if (kind === 'tokens') return fmt.compact(value);
      return fmt.number(value);
    }

    function evidenceChips(t, fmt, evidence) {
      if (!evidence || typeof evidence !== 'object') return [];
      const chips = [];
      const keys = Object.keys(evidence);
      for (let i = 0; i < keys.length && chips.length < 4; i += 1) {
        const key = keys[i];
        const value = evidence[key];
        if (value == null || EVIDENCE_CHIP_SKIP.indexOf(key) >= 0) continue;
        const known = EVIDENCE_LABELS.indexOf(key) >= 0;
        chips.push({
          key,
          label: known ? t('evidence.' + key) : humanizeKey(key),
          value: formatEvidence(key, value, fmt, t, evidence),
        });
      }
      return chips;
    }

    /* ---------------------------------------------------------------------------------------- *
     * Localized rendering of Host-authored diagnostics.
     *
     * The Host sends structured `code` / `type` / `evidence` next to English copy. The handlers
     * below rebuild title + detail from those structured fields so the zh UI never shows the
     * English strings; unknown codes/types (or missing evidence) fall back to the Host copy.
     * ---------------------------------------------------------------------------------------- */

    /** Format a money-per-hour rate through the shared "{amount}/h" template. */
    function hourly(t, fmt, value) {
      return num(value) == null ? EM_DASH : t('kpi.perHour', { amount: fmt.money(value) });
    }

    /** The configured cache warning rate as a display percentage (fallback: API default). */
    function cacheWarningText(fmt, settings) {
      const rate = num(settings && settings.cacheWarningRate);
      return fmt.percent(rate != null ? rate : SETTINGS_FALLBACK.cacheWarningRate);
    }

    /** Localize one `cache.diagnosis` entry by `code` + `evidence`. */
    function localizeDiagnosis(t, fmt, item, settings) {
      const code = item && item.code;
      const evidence = item && item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
      const session = typeof item.sessionTitle === 'string' && item.sessionTitle ? item.sessionTitle : null;
      if (!code) return { title: item.title, detail: item.detail || '' };
      switch (code) {
        case 'cache-hit-drop':
          if (num(evidence.lastHour) != null && num(evidence.baseline) != null && num(evidence.delta) != null) {
            return {
              title: t('diag.cache-hit-drop.title', { delta: fmt.percentAbs(evidence.delta) }),
              detail: t('diag.cache-hit-drop.detail', {
                current: fmt.percent(evidence.lastHour),
                baseline: fmt.percent(evidence.baseline),
              }),
            };
          }
          break;
        case 'cache-low':
          if (num(evidence.hitRate) != null) {
            return {
              title: t('diag.cache-low.title'),
              detail: t('diag.cache-low.detail', {
                rate: fmt.percent(evidence.hitRate),
                baseline: fmt.percent(evidence.baseline),
                threshold: cacheWarningText(fmt, settings),
                minutes: fmt.number(evidence.sustainedMinutes),
              }),
            };
          }
          break;
        case 'uncached-burst':
          if (num(evidence.uncachedTokens) != null) {
            return {
              title: t('diag.uncached-burst.title'),
              detail: t('diag.uncached-burst.detail', {
                tokens: fmt.compact(evidence.uncachedTokens),
                baseline: fmt.compact(evidence.baseline),
              }),
            };
          }
          break;
        case 'cache-problem-correlated':
          if (num(evidence.burnRatio) != null && num(evidence.hitRateDelta) != null) {
            return {
              title: t('diag.cache-problem-correlated.title'),
              detail: t('diag.cache-problem-correlated.detail', {
                ratio: fmt.ratio(evidence.burnRatio),
                delta: fmt.percentAbs(evidence.hitRateDelta),
              }),
            };
          }
          break;
        case 'system-prompt-changing':
          if (session && num(evidence.systemPromptHashes) != null) {
            return {
              title: t('diag.system-prompt-changing.title', { session }),
              detail: t('diag.system-prompt-changing.detail', { hashes: fmt.number(evidence.systemPromptHashes) }),
            };
          }
          break;
        case 'request-epoch-change':
          if (session && num(evidence.headerChanges) != null) {
            return {
              title: t('diag.request-epoch-change.title', { count: fmt.number(evidence.headerChanges), session }),
              detail: t('diag.request-epoch-change.detail'),
            };
          }
          break;
        case 'toolset-change':
          if (session && typeof evidence.toolListSizes === 'string' && evidence.toolListSizes) {
            const count = evidence.toolListSizes.split(',').filter(Boolean).length;
            return {
              title: t('diag.toolset-change.title', { count: fmt.number(count), session }),
              detail: t('diag.toolset-change.detail'),
            };
          }
          break;
        case 'model-switch':
          if (session && typeof evidence.models === 'string' && evidence.models) {
            return {
              title: t('diag.model-switch.title', { session }),
              detail: t('diag.model-switch.detail', { models: evidence.models }),
            };
          }
          break;
        case 'compaction-cache-break':
          if (session && num(evidence.compactions) != null) {
            return {
              title: t('diag.compaction-cache-break.title', { count: fmt.number(evidence.compactions), session }),
              detail: t('diag.compaction-cache-break.detail'),
            };
          }
          break;
        case 'ttl-gap':
          if (session && num(evidence.afterGapHitRate) != null) {
            return {
              title: t('diag.ttl-gap.title', { session }),
              detail: t('diag.ttl-gap.detail', {
                samples: fmt.number(evidence.afterGapSamples),
                rate: fmt.percent(evidence.afterGapHitRate),
              }),
            };
          }
          break;
        case 'uuid-or-timestamp-in-prefix':
          if (session) {
            return {
              title: t('diag.uuid-or-timestamp-in-prefix.title', { session }),
              detail: t('diag.uuid-or-timestamp-in-prefix.detail'),
            };
          }
          break;
        case 'cache-not-reported':
          if (session) {
            return {
              title: t('diag.cache-not-reported.title', { session }),
              detail: t('diag.cache-not-reported.detail'),
            };
          }
          break;
        case 'context-growth':
          if (num(evidence.recentAverage) != null) {
            return {
              title: t('diag.context-growth.title', { tokens: fmt.compact(evidence.recentAverage) }),
              detail: t('diag.context-growth.detail', { baseline: fmt.compact(evidence.baselineAverage) }),
            };
          }
          break;
        default:
          break;
      }
      return { title: item.title, detail: item.detail || '' };
    }

    /** Localize one firing alert by `type` + `evidence`, falling back to Host copy. */
    function localizeAlert(t, fmt, alert, settings) {
      if (!alert) return { title: '', detail: '' };
      const type = alert.type;
      const evidence = alert.evidence && typeof alert.evidence === 'object' ? alert.evidence : {};
      if (type === 'burn-rate' && num(evidence.ratio) != null && num(evidence.burnPerHour) != null) {
        return {
          title: t('alert.burn.title', { ratio: fmt.ratio(evidence.ratio) }),
          detail: t('alert.burn.detail', {
            current: hourly(t, fmt, evidence.burnPerHour),
            baseline: hourly(t, fmt, evidence.baselinePerHour),
          }),
        };
      }
      if (type === 'cache-low' && num(evidence.hitRate) != null) {
        const rate = fmt.percent(evidence.hitRate);
        const minutes = fmt.number(evidence.sustainedMinutes);
        const threshold = num(evidence.threshold) != null
          ? fmt.percent(evidence.threshold > 1 ? evidence.threshold / 100 : evidence.threshold)
          : cacheWarningText(fmt, settings);
        if (num(evidence.baseline) != null) {
          return { title: t('alert.cache.title'), detail: t('alert.cache.detail', { rate, baseline: fmt.percent(evidence.baseline), threshold, minutes }) };
        }
        return { title: t('alert.cache.title'), detail: t('alert.cache.detailNoBaseline', { rate, threshold, minutes }) };
      }
      if (type === 'cost-spike' && num(evidence.last10mCost) != null) {
        return {
          title: t('alert.cost.title', { amount: fmt.money(evidence.last10mCost) }),
          detail: num(evidence.threshold) != null ? t('alert.cost.detail', { threshold: fmt.money(evidence.threshold) }) : alert.detail,
        };
      }
      if (type === 'uncached-burst' && num(evidence.uncachedTokens) != null) {
        return {
          title: t('alert.uncached.title'),
          detail: t('alert.uncached.detail', {
            tokens: fmt.compact(evidence.uncachedTokens),
            baseline: fmt.compact(evidence.baseline),
          }),
        };
      }
      if (type === 'balance-low' && num(evidence.threshold) != null) {
        const currency = typeof evidence.currency === 'string' ? evidence.currency : undefined;
        return {
          title: t('alert.balance.title', { threshold: fmt.money(evidence.threshold, currency) }),
          detail: num(evidence.balance) != null ? t('alert.balance.detail', { balance: fmt.money(evidence.balance, currency) }) : alert.detail,
        };
      }
      return { title: alert.title, detail: alert.detail || '' };
    }

    /** Recover a known condition key from a `recovered` anomaly's `evidence.condition`. */
    function conditionKeyOf(value) {
      if (typeof value !== 'string' || !value) return null;
      const base = value.split(':')[0];
      const known = ['burn-rate', 'cache-low', 'cache-hit-drop', 'cost-spike', 'uncached-burst', 'cache-problem-correlated', 'balance-low'];
      return known.indexOf(base) >= 0 ? base : null;
    }

    /** Localize one anomaly timeline entry by `type` + `evidence`, falling back to Host copy. */
    function localizeAnomaly(t, fmt, item, settings) {
      if (!item) return { title: '', detail: '' };
      const type = item.type;
      const evidence = item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
      if (type === 'burn-rate' && num(evidence.ratio) != null) {
        const title = t('anomaly.burn.title', { ratio: fmt.ratio(evidence.ratio) });
        if (num(evidence.burnPerHour) != null && num(evidence.baselinePerHour) != null) {
          return {
            title,
            detail: t('anomaly.burn.detail', {
              current: hourly(t, fmt, evidence.burnPerHour),
              baseline: hourly(t, fmt, evidence.baselinePerHour),
            }),
          };
        }
        return { title, detail: t('anomaly.burn.detailBucket', { ratio: fmt.ratio(evidence.ratio) }) };
      }
      if (type === 'cache-hit-drop') {
        if (num(evidence.hitRateDelta) != null && num(evidence.burnRatio) != null) {
          return {
            title: t('anomaly.cacheProblem.title'),
            detail: t('anomaly.cacheProblem.detail', {
              delta: fmt.percentAbs(evidence.hitRateDelta),
              ratio: fmt.ratio(evidence.burnRatio),
            }),
          };
        }
        // The Host uses `recent` for the current hit rate in the historical ledger and
        // `hitRate` in live conditions; accept both.
        const currentRate = num(evidence.hitRate) != null ? evidence.hitRate : evidence.recent;
        if (num(currentRate) != null) {
          const rate = fmt.percent(currentRate);
          return {
            title: t('anomaly.cache.title', { rate }),
            detail: num(evidence.baseline) != null
              ? t('anomaly.cache.detail', { baseline: fmt.percent(evidence.baseline) })
              : t('anomaly.cache.detailNoBaseline', { rate }),
          };
        }
      }
      if (type === 'cache-low' && (num(evidence.hitRate) != null || num(evidence.recent) != null)) {
        const currentRate = num(evidence.hitRate) != null ? evidence.hitRate : evidence.recent;
        return {
          title: t('anomaly.cacheLow.title'),
          detail: t('anomaly.cacheLow.detail', {
            rate: fmt.percent(currentRate),
            baseline: fmt.percent(evidence.baseline),
            threshold: cacheWarningText(fmt, settings),
            minutes: fmt.number(evidence.sustainedMinutes),
          }),
        };
      }
      if (type === 'uncached-burst' && num(evidence.uncachedTokens) != null) {
        return {
          title: t('anomaly.uncached.title'),
          detail: t('anomaly.uncached.detail', {
            tokens: fmt.compact(evidence.uncachedTokens),
            baseline: fmt.compact(evidence.baseline),
          }),
        };
      }
      if (type === 'request-spike' && num(evidence.requests) != null) {
        return {
          title: t('anomaly.spike.title'),
          detail: t('anomaly.spike.detail', {
            requests: fmt.number(evidence.requests),
            baseline: fmt.ratio(evidence.baseline),
          }),
        };
      }
      if (type === 'input-growth' && num(evidence.recentAverage) != null) {
        return {
          title: t('anomaly.inputGrowth.title'),
          detail: t('anomaly.inputGrowth.detail', {
            recent: fmt.compact(evidence.recentAverage),
            baseline: fmt.compact(evidence.baselineAverage),
            ratio: fmt.ratio(evidence.multiplier),
          }),
        };
      }
      if (type === 'expensive-model-share' && num(evidence.share) != null) {
        return {
          title: t('anomaly.modelShare.title'),
          detail: t('anomaly.modelShare.detail', {
            model: typeof evidence.model === 'string' ? evidence.model : EM_DASH,
            rate: fmt.percent(clamp01(evidence.share)),
          }),
        };
      }
      if (type === 'cost-spike' && num(evidence.last10mCost) != null) {
        return {
          title: t('anomaly.cost.title', { amount: fmt.money(evidence.last10mCost) }),
          detail: num(evidence.threshold) != null ? t('anomaly.cost.detail', { threshold: fmt.money(evidence.threshold) }) : item.detail,
        };
      }
      if (type === 'session-dominance' && num(evidence.share) != null) {
        return {
          title: t('anomaly.session.title'),
          detail: t('anomaly.session.detail', {
            session: typeof evidence.sessionTitle === 'string' && evidence.sessionTitle ? evidence.sessionTitle : (item.sessionId ? String(item.sessionId).slice(-8) : EM_DASH),
            rate: fmt.percent(clamp01(evidence.share)),
          }),
        };
      }
      if (type === 'balance-low' && num(evidence.threshold) != null) {
        const currency = typeof evidence.currency === 'string' ? evidence.currency : undefined;
        return {
          title: t('anomaly.balance.title', { threshold: fmt.money(evidence.threshold, currency) }),
          detail: num(evidence.balance) != null ? t('anomaly.balance.detail', { balance: fmt.money(evidence.balance, currency) }) : item.detail,
        };
      }
      if (type === 'recovered') {
        const condition = conditionKeyOf(evidence.condition);
        return {
          title: t('anomaly.recovered.title'),
          detail: condition
            ? t('anomaly.recovered.detailWith', { condition: t('condition.' + condition) })
            : t('anomaly.recovered.detail'),
        };
      }
      return { title: item.title, detail: item.detail || '' };
    }

    /**
     * Build the "Why is usage high?" rows from the snapshot only:
     * the Host's cache diagnosis plus causes derivable from thresholds and window data.
     */
    function buildCauses(snapshot, t, fmt) {
      const rows = [];
      const cache = (snapshot && snapshot.cache) || {};
      const settings = Object.assign({}, SETTINGS_FALLBACK, (snapshot && snapshot.settings) || {});

      const diagnosis = Array.isArray(cache.diagnosis) ? cache.diagnosis : [];
      for (let i = 0; i < diagnosis.length; i += 1) {
        const item = diagnosis[i];
        if (!item) continue;
        const localized = localizeDiagnosis(t, fmt, item, settings);
        if (!localized.title && !localized.detail) continue;
        rows.push({
          key: 'diagnosis:' + (item.code || i),
          severity: levelOf(item.severity),
          title: localized.title,
          detail: localized.detail || '',
          evidence: item.evidence || null,
          source: 'diagnosis',
        });
      }

      const burn = (snapshot && snapshot.burn) || {};
      const ratio = num(burn.ratio);
      const warnRatio = num(settings.warningBurnRatio);
      const critRatio = num(settings.criticalBurnRatio);
      if (ratio != null && warnRatio != null && ratio >= warnRatio) {
        rows.push({
          key: 'derived:burn',
          severity: ratio >= (critRatio != null ? critRatio : 4.5) ? 'critical' : 'warning',
          title: t('why.burn.title'),
          detail: t('why.burn.detail', { ratio: fmt.ratio(ratio), threshold: fmt.ratio(warnRatio) }),
          evidence: {
            ratio,
            burnPerHour: burn.last1h ? burn.last1h.costPerHour : null,
            baselinePerHour: burn.baseline24h ? burn.baseline24h.costPerHour : null,
          },
          source: 'derived',
        });
      }

      const delta = num(cache.deltaVsBaseline);
      if (delta != null && delta <= -0.02) {
        rows.push({
          key: 'derived:cache',
          severity: delta <= -0.05 ? 'critical' : 'warning',
          title: t('why.cache.title'),
          detail: t('why.cache.detail', {
            recent: fmt.percent(cache.hitRate),
            baseline: fmt.percent(cache.baseline ? cache.baseline.hitRate : null),
          }),
          evidence: { recent: cache.hitRate, baseline: cache.baseline ? cache.baseline.hitRate : null },
          source: 'derived',
        });
      }

      // A share must be a fraction of the session rows' own total — `costShare` is unrelated and
      // `cache.last24h.missTokens` can be smaller than one row when the windows differ.
      const consumerSessions = snapshot && snapshot.consumers && Array.isArray(snapshot.consumers.sessions)
        ? snapshot.consumers.sessions
        : [];
      let sessionUncachedTotal = 0;
      for (let i = 0; i < consumerSessions.length; i += 1) {
        sessionUncachedTotal += num(consumerSessions[i] && consumerSessions[i].uncachedTokens) || 0;
      }
      const uncachedRows = snapshot && snapshot.consumers ? snapshot.consumers.uncached : null;
      const topUncached = Array.isArray(uncachedRows) && uncachedRows.length ? uncachedRows[0] : null;
      if (topUncached && sessionUncachedTotal > 0) {
        const rowTokens = num(topUncached.uncachedTokens);
        if (rowTokens != null) {
          const share = Math.max(0, Math.min(1, rowTokens / sessionUncachedTotal));
          if (share >= 0.5) {
            rows.push({
              key: 'derived:uncached',
              severity: share >= 0.7 ? 'warning' : 'info',
              title: t('why.uncached.title'),
              detail: t('why.uncached.detail', {
                label: topUncached.label || topUncached.key || EM_DASH,
                rate: fmt.percent(share),
              }),
              evidence: { share, uncachedTokens: rowTokens, requests: topUncached.requests },
              source: 'derived',
            });
          }
        }
      }

      const models = Array.isArray(snapshot && snapshot.models) ? snapshot.models : [];
      if (models.length) {
        const priced = models.filter((model) => model && model.priced && num(model.cost) != null);
        if (priced.length) {
          const top = priced.slice().sort((a, b) => (num(b.cost) || 0) - (num(a.cost) || 0))[0];
          const share = num(top.costShare);
          if (share != null && share >= 0.8) {
            rows.push({
              key: 'derived:model',
              severity: 'info',
              title: t('why.model.title'),
              detail: t('why.model.detail', { model: top.model || EM_DASH, rate: fmt.percent(share) }),
              evidence: { share, requests: top.requests },
              source: 'derived',
            });
          }
        }
      }

      const rank = { critical: 0, warning: 1, info: 2 };
      rows.sort((a, b) => rank[a.severity] - rank[b.severity]);
      return rows;
    }

    /* ---------------------------------------------------------------------------------------- *
     * Tiny primitives
     * ---------------------------------------------------------------------------------------- */

    /** Card surface with an optional title / subtitle / action row. */
    function Card(props) {
      const heading = props.title || props.action;
      return h('section', { className: cx('um-card', props.className) },
        heading
          ? h('div', { className: 'um-card-head' },
            h('div', { className: 'um-card-titles' },
              props.title ? h('h2', { className: 'um-card-title' }, props.title) : null,
              props.subtitle ? h('p', { className: 'um-card-sub' }, props.subtitle) : null),
            props.action || null)
          : null,
        props.children);
    }

    /** Tooltip: CSS-only bubble revealed on hover and keyboard focus. */
    function Tooltip(props) {
      return h('span', { className: cx('um-tip', props.className) },
        h('span', { className: 'um-tip-trigger', tabIndex: 0 }, props.children),
        h('span', { className: 'um-tip-bubble', role: 'tooltip' }, props.text));
    }

    /** Small bordered number/icon button used by the header and drawer. */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: cx('um-icon-btn', props.className),
        'aria-label': props.label,
        title: props.label,
        onClick: props.onClick,
        disabled: Boolean(props.disabled),
      }, props.children);
    }

    /** Compact status pill with a colored dot. `level` is critical | warning | normal. */
    function StatusPill(props) {
      const level = props.level === 'critical' || props.level === 'warning' ? props.level : 'normal';
      const label = props.level === 'critical' ? props.t('status.critical')
        : props.level === 'warning' ? props.t('status.warning') : props.t('status.normal');
      return h('span', { className: 'um-pill', 'data-level': level },
        h('span', { className: 'um-dot', 'aria-hidden': true }),
        label);
    }

    /** Share bar (0..1). */
    function Bar(props) {
      const value = num(props.value);
      const pct = value == null ? 0 : Math.max(0, Math.min(1, value));
      return h('div', {
        className: 'um-bar',
        'data-tone': props.tone || 'brand',
        title: props.label || undefined,
      }, h('i', { style: { width: (pct * 100).toFixed(1) + '%' } }));
    }

    /** Large monospace KPI card. */
    function Metric(props) {
      return h('section', { className: 'um-card um-kpi' },
        h('div', { className: 'um-kpi-label' }, props.label),
        h('div', { className: 'um-kpi-value', title: props.valueTitle || undefined },
          props.value,
          props.est
            ? h(Tooltip, { text: props.t('kpi.estHint') }, h('span', { className: 'um-est' }, props.t('kpi.est')))
            : null),
        props.secondary
          ? h('div', { className: 'um-kpi-secondary', 'data-level': props.secondaryLevel || undefined }, props.secondary)
          : null,
        props.meta ? h('div', { className: 'um-kpi-meta' }, props.meta) : null);
    }

    /** Estimated money with the `Est.` marker and an explanatory tooltip. */
    function CostValue(props) {
      const amount = num(props.value);
      if (amount == null) return h('span', { className: 'um-muted' }, EM_DASH);
      return h('span', { className: 'um-cost' },
        h('span', null, props.fmt.money(amount, props.currency)),
        h(Tooltip, { text: props.t('kpi.estHint') }, h('span', { className: 'um-est' }, props.t('kpi.est'))));
    }

    /** Compact token count whose native title carries the exact value. */
    function TokenCount(props) {
      const value = num(props.value);
      if (value == null) return h('span', { className: 'um-muted' }, EM_DASH);
      return h('span', { title: props.fmt.number(value) }, props.fmt.compact(value));
    }

    /** Segmented 1h / 6h / 24h / 7d range switch (native buttons, keyboard reachable). */
    function RangeSwitch(props) {
      return h('div', { className: 'um-seg', role: 'group', 'aria-label': props.t('range.label') },
        RANGES.map((range) => h('button', {
          key: range,
          type: 'button',
          className: 'um-seg-btn',
          'aria-pressed': range === props.range,
          'aria-label': props.t('range.aria', { range }),
          onClick: () => props.onChange(range),
        }, range)));
    }

    /* ---------------------------------------------------------------------------------------- *
     * Chart geometry — hand-written SVG, no chart dependency.
     *
     * The plot SVG uses a fixed 1000-unit-wide viewBox with preserveAspectRatio="none" so it
     * stretches to the card width. Strokes set vector-effect="non-scaling-stroke" so that
     * anisotropic scaling does not skew them; all text labels are HTML outside the SVG, and the
     * hover crosshair / marker are positioned HTML elements, so nothing renders stretched.
     * ---------------------------------------------------------------------------------------- */

    const round1 = (value) => Math.round(value * 10) / 10;

    /** Split a value list into contiguous runs of non-null points. */
    function buildSegments(values, xOf, yOf) {
      const segments = [];
      let current = null;
      for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        if (value == null || !isFinite(value)) {
          current = null;
          continue;
        }
        const point = [xOf(i), yOf(value)];
        if (current) current.points.push(point);
        else {
          current = { points: [point] };
          segments.push(current);
        }
      }
      return segments;
    }

    function segmentsPath(segments) {
      const parts = [];
      for (let s = 0; s < segments.length; s += 1) {
        const points = segments[s].points;
        for (let p = 0; p < points.length; p += 1) {
          parts.push((p === 0 ? 'M' : 'L') + round1(points[p][0]) + ' ' + round1(points[p][1]));
        }
      }
      return parts.join(' ');
    }

    function segmentsArea(segments, baselineY) {
      const parts = [];
      for (let s = 0; s < segments.length; s += 1) {
        const points = segments[s].points;
        if (points.length < 2) continue;
        const first = points[0];
        const last = points[points.length - 1];
        parts.push('M' + round1(first[0]) + ' ' + round1(baselineY));
        for (let p = 0; p < points.length; p += 1) {
          parts.push('L' + round1(points[p][0]) + ' ' + round1(points[p][1]));
        }
        parts.push('L' + round1(last[0]) + ' ' + round1(baselineY) + ' Z');
      }
      return parts.join(' ');
    }

    /** Build the tooltip row list for one series point. */
    function pointRows(t, fmt, point) {
      return [
        { key: 'cost', label: t('chart.cost'), value: fmt.money(point ? point.cost : null) },
        { key: 'tokens', label: t('chart.tokens'), value: fmt.compact(point ? point.tokens : null) },
        { key: 'requests', label: t('chart.requests'), value: fmt.number(point ? point.requests : null) },
        { key: 'hitRate', label: t('chart.hitRate'), value: fmt.percent(point ? point.hitRate : null) },
      ];
    }

    /** Cost + token trend chart with hover crosshair and tooltip. */
    function TrendChart(props) {
      const { t, fmt, points, range } = props;
      const [hoverIndex, setHoverIndex] = useState(-1);
      const W = 1000;
      const H = 220;
      const padTop = 12;
      const padBottom = 10;
      const count = points.length;
      const plotHeight = H - padTop - padBottom;

      const costValues = points.map((point) => num(point.cost));
      const tokenValues = points.map((point) => num(point.tokens) || 0);
      const hasCost = costValues.some((value) => value != null && value > 0);
      const costMax = costValues.reduce((max, value) => (value != null ? Math.max(max, value) : max), 0);
      const tokenMax = tokenValues.reduce((max, value) => Math.max(max, value), 0);
      const primaryIsCost = hasCost;
      const primaryValues = primaryIsCost ? costValues : tokenValues;
      const primaryMax = Math.max(primaryIsCost ? costMax : tokenMax, 0);

      const xOf = (index) => (count <= 1 ? W / 2 : (index / (count - 1)) * W);
      const yOf = (value) => padTop + (1 - (primaryMax > 0 ? value / primaryMax : 0)) * plotHeight;
      const baselineY = H - padBottom;
      const primarySegments = buildSegments(primaryValues, xOf, yOf);
      const linePath = segmentsPath(primarySegments);
      const areaPath = segmentsArea(primarySegments, baselineY);
      const tokenY = (value) => padTop + (1 - (tokenMax > 0 ? value / tokenMax : 0)) * plotHeight;
      const tokenPath = hasCost && tokenMax > 0 ? segmentsPath(buildSegments(tokenValues, xOf, tokenY)) : '';

      const from = num(props.from);
      const to = num(props.to);
      const startTime = from != null ? from : count ? points[0].t : null;
      const endTime = to != null ? to : count ? points[count - 1].t : null;
      const axisStamps = count > 1 && startTime != null && endTime != null
        ? [0, 1, 2, 3].map((step) => startTime + ((endTime - startTime) * step) / 3)
        : (startTime != null ? [startTime] : []);

      const activeIndex = hoverIndex >= 0 && hoverIndex < count ? hoverIndex : -1;
      const active = activeIndex >= 0 ? points[activeIndex] : null;
      const hoverRatio = count <= 1 ? 0.5 : activeIndex / (count - 1);
      const hoverX = hoverRatio * 100;
      const primaryActive = active ? (primaryIsCost ? num(active.cost) : num(active.tokens)) : null;
      const markerY = primaryActive != null ? yOf(primaryActive) : null;

      const peakText = primaryIsCost ? fmt.money(costMax) : fmt.compact(primaryMax);
      const ariaLabel = t('trend.aria', {
        range,
        points: count,
        peak: peakText,
      });

      const gridLines = [0, 0.25, 0.5, 0.75, 1].map((fraction) => h('line', {
        key: 'grid-' + fraction,
        x1: 0,
        y1: round1(padTop + fraction * plotHeight),
        x2: W,
        y2: round1(padTop + fraction * plotHeight),
        stroke: 'var(--dsw-alias-border-l2)',
        strokeOpacity: 0.55,
        strokeWidth: 1,
        vectorEffect: 'non-scaling-stroke',
      }));

      const yLabels = primaryIsCost
        ? [fmt.moneyCompact(primaryMax), fmt.moneyCompact(primaryMax / 2), fmt.moneyCompact(0)]
        : [fmt.compact(primaryMax), fmt.compact(primaryMax / 2), fmt.compact(0)];

      return h('div', { className: 'um-chart' },
        h('div', { className: 'um-chart-y', 'aria-hidden': true },
          yLabels.map((label, index) => h('span', { key: 'y-' + index }, label))),
        h('div', {
          className: 'um-chart-plot',
          onMouseMove: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (!rect.width || !count) return;
            const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            setHoverIndex(Math.round(ratio * (count - 1)));
          },
          onMouseLeave: () => setHoverIndex(-1),
        },
          h('svg', {
            className: 'um-chart-svg',
            viewBox: '0 0 ' + W + ' ' + H,
            preserveAspectRatio: 'none',
            role: 'img',
            'aria-label': ariaLabel,
          },
            gridLines,
            areaPath ? h('path', { d: areaPath, fill: 'var(--dsw-alias-brand-primary)', fillOpacity: 0.12 }) : null,
            tokenPath
              ? h('path', {
                d: tokenPath,
                fill: 'none',
                stroke: 'var(--dsw-alias-label-secondary)',
                strokeOpacity: 0.55,
                strokeWidth: 1.25,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
                vectorEffect: 'non-scaling-stroke',
              })
              : null,
            linePath
              ? h('path', {
                d: linePath,
                fill: 'none',
                stroke: 'var(--dsw-alias-brand-primary)',
                strokeWidth: 1.75,
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
                vectorEffect: 'non-scaling-stroke',
              })
              : null),
          activeIndex >= 0
            ? h('div', { className: 'um-crosshair', style: { left: hoverX + '%' }, 'aria-hidden': true })
            : null,
          activeIndex >= 0 && markerY != null
            ? h('div', {
              className: 'um-marker',
              style: { left: hoverX + '%', top: (markerY / H) * 100 + '%' },
              'aria-hidden': true,
            })
            : null,
          active
            ? h('div', {
              className: 'um-chart-tooltip',
              style: {
                left: hoverX + '%',
                transform: hoverX > 65 ? 'translateX(-102%)' : hoverX < 35 ? 'translateX(2%)' : 'translateX(-50%)',
              },
              'aria-hidden': true,
            },
              h('div', { className: 'um-chart-tooltip-time' }, fmt.dateTime(active.t)),
              h('div', { className: 'um-chart-tooltip-rows' },
                pointRows(t, fmt, active).map((row) => h('div', { key: row.key, className: 'um-chart-tooltip-row' },
                  h('span', { className: 'um-chart-tooltip-label' }, row.label),
                  h('span', { className: 'um-chart-tooltip-value' }, row.value)))))
            : null),
        axisStamps.length
          ? h('div', { className: 'um-chart-x', 'aria-hidden': true },
            axisStamps.map((stamp, index) => h('span', { key: 'x-' + index }, fmt.axisTime(stamp, range))))
          : null);
    }

    /** Cache hit-rate mini trend with the 24h baseline band. */
    function CacheChart(props) {
      const { t, fmt, cache } = props;
      const trend = Array.isArray(cache && cache.trend)
        ? cache.trend.filter((point) => point && typeof point.t === 'number')
        : [];
      const rates = trend.map((point) => num(point.hitRate));
      const valid = rates.filter((rate) => rate != null);
      if (!valid.length) return null;

      const W = 1000;
      const H = 160;
      const padTop = 12;
      const padBottom = 12;
      const plotHeight = H - padTop - padBottom;
      const minRate = valid.reduce((min, rate) => Math.min(min, rate), 1);
      const domainMin = Math.max(0, Math.min(0.5, Math.floor((minRate - 0.08) * 20) / 20));
      const xOf = (index) => (rates.length <= 1 ? W / 2 : (index / (rates.length - 1)) * W);
      const yOf = (rate) => padTop + (1 - (rate - domainMin) / Math.max(0.0001, 1 - domainMin)) * plotHeight;
      const segments = buildSegments(rates, xOf, yOf);
      const baseline = num(cache && cache.baseline && cache.baseline.hitRate);
      const band = 0.02;
      const clampedBaseline = baseline == null ? null : Math.max(domainMin, Math.min(1, baseline));
      const bandTop = clampedBaseline == null ? null : yOf(Math.max(domainMin, Math.min(1, clampedBaseline + band)));
      const bandBottom = clampedBaseline == null ? null : yOf(Math.max(domainMin, Math.min(1, clampedBaseline - band)));
      const baselineY = clampedBaseline == null ? null : yOf(clampedBaseline);

      return h('svg', {
        className: 'um-mini-svg',
        viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': t('cache.trendAria'),
      },
        bandTop != null && bandBottom != null
          ? h('rect', {
            x: 0,
            y: round1(Math.min(bandTop, bandBottom)),
            width: W,
            height: round1(Math.max(1, Math.abs(bandBottom - bandTop))),
            fill: 'var(--dsw-alias-state-success-primary)',
            fillOpacity: 0.1,
          })
          : null,
        baselineY != null
          ? h('line', {
            x1: 0,
            y1: round1(baselineY),
            x2: W,
            y2: round1(baselineY),
            stroke: 'var(--dsw-alias-state-success-primary)',
            strokeOpacity: 0.5,
            strokeWidth: 1,
            strokeDasharray: '4 4',
            vectorEffect: 'non-scaling-stroke',
          })
          : null,
        h('path', { d: segmentsArea(segments, H - padBottom), fill: 'var(--dsw-alias-brand-primary)', fillOpacity: 0.1 }),
        h('path', {
          d: segmentsPath(segments),
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }));
    }

    /** Request-rate sparkline (one value per series bucket). */
    function Sparkline(props) {
      const values = Array.isArray(props.values) ? props.values : [];
      const max = values.reduce((m, value) => Math.max(m, num(value) || 0), 0);
      const W = 1000;
      const H = 120;
      const padTop = 10;
      const padBottom = 6;
      const xOf = (index) => (values.length <= 1 ? W / 2 : (index / (values.length - 1)) * W);
      const yOf = (value) => padTop + (1 - (max > 0 ? value / max : 0)) * (H - padTop - padBottom);
      const segments = buildSegments(values.map((value) => num(value) || 0), xOf, yOf);
      return h('svg', {
        className: 'um-spark-svg',
        viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': props.label,
      },
        h('path', { d: segmentsArea(segments, H - padBottom), fill: 'var(--dsw-alias-brand-primary)', fillOpacity: 0.12 }),
        h('path', {
          d: segmentsPath(segments),
          fill: 'none',
          stroke: 'var(--dsw-alias-brand-primary)',
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
          vectorEffect: 'non-scaling-stroke',
        }));
    }

    /* ---------------------------------------------------------------------------------------- *
     * Page sections
     * ---------------------------------------------------------------------------------------- */

    function RefreshIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M13.4 7.4A5.5 5.5 0 1 1 11.4 3.9' }),
        h('path', { d: 'M13.4 2.2v3.2h-3.2' }));
    }

    function GearIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M2.2 4.6h11.6' }),
        h('path', { d: 'M2.2 11.4h11.6' }),
        h('circle', { cx: 6, cy: 4.6, r: 1.7, fill: 'var(--dsw-alias-bg-layer-1)' }),
        h('circle', { cx: 10.4, cy: 11.4, r: 1.7, fill: 'var(--dsw-alias-bg-layer-1)' }));
    }

    function CloseIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 15, height: 15, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', 'aria-hidden': true, focusable: false,
      },
        h('path', { d: 'M4 4l8 8' }),
        h('path', { d: 'M12 4l-8 8' }));
    }

    function Header(props) {
      const { t, fmt, status, updatedAt, refreshing, savedAt, onRefresh, onSettings, canRefresh, canSettings } = props;
      return h('header', { className: 'um-head' },
        h('div', { className: 'um-head-main' },
          h('h1', { className: 'um-title' }, t('page.title')),
          h('p', { className: 'um-sub' }, t('page.subtitle'))),
        h('div', { className: 'um-head-actions' },
          status ? h(StatusPill, { t, level: status }) : null,
          refreshing
            ? h('span', { className: 'um-updated' }, t('header.refreshing'))
            : h('span', { className: 'um-updated' }, updatedAt ? t('header.updated', { time: fmt.stamp(updatedAt) }) : t('header.never')),
          savedAt ? h('span', { className: 'um-updated um-saved' }, t('header.saved')) : null,
          h(IconButton, { label: t('header.refresh'), onClick: onRefresh, disabled: !canRefresh || refreshing }, h(RefreshIcon)),
          h(IconButton, { label: t('header.settings'), onClick: onSettings, disabled: !canSettings }, h(GearIcon))));
    }

    function AlertStrip(props) {
      const alerts = firingAlerts(props.alerts);
      if (!alerts.length) return null;
      return h('section', { className: 'um-alerts', 'aria-label': props.t('alert.region') },
        alerts.map((alert) => {
          const localized = localizeAlert(props.t, props.fmt, alert, props.settings);
          return h('div', {
            key: alert.id,
            className: 'um-alert',
            'data-level': alert.level,
            role: 'alert',
          },
            h('span', { className: 'um-dot', 'aria-hidden': true }),
            h('div', { className: 'um-alert-body' },
              h('div', { className: 'um-alert-title' }, localized.title || alert.title || alert.type || EM_DASH),
              localized.detail ? h('div', { className: 'um-alert-detail' }, localized.detail) : null),
            h('span', { className: 'um-alert-meta' }, props.t('alert.since', { time: props.fmt.stamp(alert.since) })));
        }));
    }

    function ConnStrip(props) {
      return h('div', { className: 'um-conn', role: 'status' },
        h('span', { className: 'um-dot', 'data-level': 'warning', 'aria-hidden': true }),
        h('span', { className: 'um-conn-text' }, props.t('error.reconnecting', { time: props.fmt.stamp(props.error.at) })),
        h('button', { type: 'button', className: 'um-link-btn', onClick: props.onRetry }, props.t('error.retry')));
    }

    function KpiRow(props) {
      const { t, fmt, data } = props;
      const balance = data.balance || {};
      const windows = (data.cost && data.cost.windows) || {};
      const today = windows.today || {};
      const lastHour = windows.lastHour || {};
      const burn = data.burn || {};
      const last1h = burn.last1h || {};
      const baseline = burn.baseline24h || {};

      let balanceValue = EM_DASH;
      let balanceSecondary = null;
      let balanceMeta = null;
      const primary = balance.primary;
      if (balance.state === 'ready') {
        if (primary && num(primary.amount) != null) {
          balanceValue = fmt.money(primary.amount, primary.currency);
        } else if (num(balance.totalAll) != null) {
          balanceValue = fmt.money(balance.totalAll);
          balanceSecondary = t('kpi.total', { amount: fmt.money(balance.totalAll) });
        } else {
          balanceSecondary = t('balance.empty');
        }
        const bonus = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : [];
        if (bonus.length) {
          const bonusWallet = bonus.filter((wallet) => wallet && num(Number(wallet.balance)) != null && Number(wallet.balance) > 0)[0];
          if (bonusWallet) {
            balanceSecondary = t('kpi.bonus', { amount: fmt.money(Number(bonusWallet.balance), bonusWallet.currency) });
          }
        }
        balanceMeta = balance.fetchedAt ? t('balance.fetched', { time: fmt.stamp(balance.fetchedAt) }) : null;
      } else if (balance.state === 'signed-out') {
        balanceSecondary = t('balance.signedOut');
        balanceMeta = t('balance.signedOutHint');
      } else if (balance.state === 'error') {
        balanceSecondary = t('balance.error');
        balanceMeta = t('balance.errorHint');
      } else {
        balanceSecondary = t('balance.unavailable');
        balanceMeta = t('balance.unavailableHint');
      }

      const todayValue = num(today.estimated) != null ? fmt.money(today.estimated) : EM_DASH;
      const todayObserved = num(today.observed) != null ? t('kpi.observed', { amount: fmt.money(today.observed) }) : null;
      const todayMeta = t('kpi.usageMeta', {
        requests: fmt.number(today.requests),
        tokens: fmt.compact(today.tokens),
      });
      const hourValue = num(lastHour.estimated) != null ? fmt.money(lastHour.estimated) : EM_DASH;
      const hourObserved = num(lastHour.observed) != null ? t('kpi.observed', { amount: fmt.money(lastHour.observed) }) : null;
      const hourMeta = t('kpi.usageMeta', {
        requests: fmt.number(lastHour.requests),
        tokens: fmt.compact(lastHour.tokens),
      });

      const ratio = num(burn.ratio);
      let burnSecondary = t('kpi.burnNoBaseline');
      let burnLevel = null;
      if (ratio != null) {
        if (Math.abs(ratio - 1) < 0.05) burnSecondary = t('kpi.burnNormal');
        else if (ratio > 1) burnSecondary = t('kpi.burnHigher', { ratio: fmt.ratio(ratio) });
        else burnSecondary = t('kpi.burnLower', { ratio: fmt.ratio(ratio <= 0 ? 1 : 1 / ratio) });
        burnLevel = burn.level === 'critical' ? 'critical' : burn.level === 'warning' ? 'warning' : 'normal';
      }
      const burnMeta = t('kpi.rateMeta', {
        requests: fmt.decimal(last1h.requestsPerMin),
        tokens: fmt.compact(last1h.tokensPerMin),
      });
      const burnBaseline = num(baseline.costPerHour) != null
        ? t('kpi.burnBaseline', { amount: fmt.money(baseline.costPerHour) })
        : null;

      return h('div', { className: 'um-grid um-kpis' },
        h(Metric, {
          t,
          label: t('kpi.balance'),
          value: balanceValue,
          secondary: balanceSecondary,
          meta: balanceMeta,
        }),
        h(Metric, {
          t,
          label: t('kpi.today'),
          value: todayValue,
          est: num(today.estimated) != null,
          secondary: todayObserved,
          meta: todayMeta,
        }),
        h(Metric, {
          t,
          label: t('kpi.lastHour'),
          value: hourValue,
          est: num(lastHour.estimated) != null,
          secondary: hourObserved,
          meta: hourMeta,
        }),
        h(Metric, {
          t,
          label: t('kpi.burn'),
          value: num(last1h.costPerHour) != null ? t('kpi.perHour', { amount: fmt.money(last1h.costPerHour) }) : EM_DASH,
          est: num(last1h.costPerHour) != null,
          secondary: burnSecondary,
          secondaryLevel: burnLevel,
          meta: burnBaseline ? burnMeta + DOT_SEP + burnBaseline : burnMeta,
        }));
    }

    function TrendCard(props) {
      const { t, fmt, data, range, onRange, mismatch } = props;
      const series = (data && data.series) || {};
      const points = Array.isArray(series.points) ? series.points.filter((point) => point && typeof point.t === 'number') : [];
      const bucket = fmt.bucket(series.bucketMs);
      const usable = points.some((point) => (num(point.cost) || 0) > 0
        || (num(point.tokens) || 0) > 0
        || (num(point.requests) || 0) > 0);
      const action = h('div', { className: 'um-card-actions' },
        mismatch ? h('span', { className: 'um-hint', role: 'status' }, t('range.updating')) : null,
        h(RangeSwitch, { t, range, onChange: onRange }));
      const legend = h('div', { className: 'um-legend' },
        h('span', { className: 'um-legend-item' },
          h('span', { className: 'um-legend-swatch', 'data-swatch': 'cost', 'aria-hidden': true }),
          t('trend.legendCost')),
        h('span', { className: 'um-legend-item' },
          h(Tooltip, { text: t('trend.legendTokensHint') },
            h('span', { className: 'um-legend-item' },
              h('span', { className: 'um-legend-swatch', 'data-swatch': 'tokens', 'aria-hidden': true }),
              t('trend.legendTokens')))),
        bucket ? h('span', { className: 'um-legend-note' }, bucket) : null);

      return h(Card, { title: t('trend.title'), action, className: 'um-trend-card' },
        usable
          ? h(TrendChart, { t, fmt, points, range, from: series.from, to: series.to })
          : h('div', { className: 'um-empty-inline' }, t('trend.empty')),
        legend);
    }

    function CacheCard(props) {
      const { t, fmt, data } = props;
      const cache = (data && data.cache) || {};
      const last1h = cache.last1h || {};
      const hitRate = num(cache.hitRate) != null ? num(cache.hitRate) : num(last1h.hitRate);
      const delta = num(cache.deltaVsBaseline);
      const baselineRate = num(cache.baseline && cache.baseline.hitRate);
      const savings = cache.savings || {};
      const trend = Array.isArray(cache.trend) ? cache.trend : [];

      let deltaText = null;
      let deltaLevel = null;
      if (delta != null) {
        if (Math.abs(delta) < 0.005) deltaText = t('cache.deltaFlat');
        else if (delta > 0) {
          deltaText = t('cache.deltaUp', { delta: fmt.percentAbs(delta) + ' ' + t('unit.pp') });
          deltaLevel = 'normal';
        } else {
          deltaText = t('cache.deltaDown', { delta: fmt.percentAbs(delta) + ' ' + t('unit.pp') });
          deltaLevel = 'warning';
        }
      }

      const savingsLine = num(savings.amount) != null
        ? h('div', { className: 'um-cache-savings' },
          h('span', null, t('cache.savings', { amount: fmt.money(savings.amount, savings.currency) })),
          h(Tooltip, { text: t('cache.savingsHint') }, h('span', { className: 'um-est' }, t('kpi.est'))))
        : null;

      const rows = [];
      if (num(last1h.hitTokens) != null) {
        rows.push(h('div', { key: 'hit', className: 'um-kv-row' },
          h('dt', null, t('cache.hits')),
          h('dd', null, h(TokenCount, { fmt, value: last1h.hitTokens }))));
      }
      if (num(last1h.missTokens) != null) {
        rows.push(h('div', { key: 'miss', className: 'um-kv-row' },
          h('dt', null, t('cache.misses')),
          h('dd', null, h(TokenCount, { fmt, value: last1h.missTokens }))));
      }
      if (num(last1h.writeTokens) != null) {
        rows.push(h('div', { key: 'write', className: 'um-kv-row' },
          h('dt', null, t('cache.writes')),
          h('dd', null, h(TokenCount, { fmt, value: last1h.writeTokens }))));
      }

      return h(Card, { title: t('cache.title'), subtitle: t('cache.window'), className: 'um-cache-card' },
        h('div', { className: 'um-cache-top' },
          h('div', { className: 'um-big' }, hitRate != null ? fmt.percent(hitRate) : EM_DASH),
          h('div', { className: 'um-cache-deltas' },
            deltaText ? h('div', { className: 'um-delta', 'data-level': deltaLevel || undefined }, deltaText) : null,
            baselineRate != null
              ? h('div', { className: 'um-muted' }, t('cache.baseline', { rate: fmt.percent(baselineRate) }))
              : null)),
        trend.length ? h('div', { className: 'um-cache-chart' }, h(CacheChart, { t, fmt, cache })) : null,
        rows.length ? h('dl', { className: 'um-kv' }, rows) : null,
        savingsLine,
        !trend.length && hitRate == null ? h('div', { className: 'um-empty-inline' }, t('cache.empty')) : null);
    }

    function RequestRateCard(props) {
      const { t, fmt, data, range } = props;
      const burn = (data && data.burn) || {};
      const cache = (data && data.cache) || {};
      const series = (data && data.series) || {};
      const points = Array.isArray(series.points) ? series.points : [];
      const totals = seriesTotals(points);
      const now = num(burn.last5m && burn.last5m.requestsPerMin);
      const baseline = num(burn.baseline24h && burn.baseline24h.requestsPerMin);
      const ratio = now != null && baseline != null && baseline > 0 ? now / baseline : null;
      const minutes = rangeMinutes(range);
      const cachedFallback = cache.last24h || {};
      const inputTokens = totals.requests > 0
        ? totals.uncached + totals.cached
        : (num(cachedFallback.missTokens) || 0) + (num(cachedFallback.hitTokens) || 0);
      const requestCount = totals.requests > 0 ? totals.requests : num(cachedFallback.requests) || 0;
      const avgInput = requestCount > 0 ? inputTokens / requestCount : null;
      const uncachedTotal = totals.requests > 0 ? totals.uncached : num(cachedFallback.missTokens) || 0;
      const uncachedPerMin = requestCount > 0 ? uncachedTotal / minutes : null;

      let rateSecondary = t('rate.noBaseline');
      if (ratio != null) rateSecondary = t('rate.multiplier', { ratio: fmt.ratio(ratio) });

      return h(Card, { title: t('rate.title'), className: 'um-rate-card' },
        h('div', { className: 'um-rate-top' },
          h('div', { className: 'um-big', title: now != null ? t('rate.now', { value: fmt.decimal(now) }) : undefined },
            now != null ? fmt.decimal(now) : EM_DASH,
            now != null ? h('span', { className: 'um-big-unit' }, t('unit.reqPerMin')) : null),
          h('div', { className: 'um-cache-deltas' },
            h('div', { className: 'um-muted' }, rateSecondary),
            baseline != null
              ? h('div', { className: 'um-muted' }, t('rate.baseline', { value: fmt.decimal(baseline) }))
              : null)),
        points.length
          ? h('div', { className: 'um-spark' },
            h(Sparkline, {
              values: points.map((point) => num(point.requests) || 0),
              label: t('rate.sparkAria', { range, points: points.length }),
            }))
          : h('div', { className: 'um-empty-inline' }, t('rate.empty')),
        h('dl', { className: 'um-kv' },
          h('div', { key: 'avg', className: 'um-kv-row' },
            h('dt', null, t('rate.avgInput')),
            h('dd', null, h(TokenCount, { fmt, value: avgInput }))),
          h('div', { key: 'uncached', className: 'um-kv-row' },
            h('dt', null, t('rate.uncachedPerMin')),
            h('dd', null, h(TokenCount, { fmt, value: uncachedPerMin })))));
    }

    function ConsumersCard(props) {
      const { t, fmt, consumers } = props;
      const [tab, setTab] = useState('sessions');
      const groups = [
        { id: 'sessions', label: t('consumers.sessions') },
        { id: 'tasks', label: t('consumers.tasks') },
        { id: 'presets', label: t('consumers.presets') },
        { id: 'uncached', label: t('consumers.uncached') },
      ];
      const rows = consumers && Array.isArray(consumers[tab]) ? consumers[tab] : [];
      const visible = rows.slice(0, MAX_CONSUMERS);
      const action = h('div', { className: 'um-tabs', role: 'group', 'aria-label': t('consumers.groups') },
        groups.map((group) => h('button', {
          key: group.id,
          type: 'button',
          className: 'um-tab',
          'aria-pressed': group.id === tab,
          onClick: () => setTab(group.id),
        }, group.label)));

      return h(Card, { title: t('consumers.title'), action, className: 'um-consumers-card' },
        visible.length
          ? h('ul', { className: 'um-rows' }, visible.map((row, index) => h(ConsumerRow, { key: row.key || row.label || 'consumer-' + index, t, fmt, row })))
          : h('div', { className: 'um-empty-inline' }, t('consumers.empty')),
        rows.length > visible.length
          ? h('div', { className: 'um-more-note' }, t('consumers.more', { count: rows.length - visible.length }))
          : null);
    }

    function ConsumerRow(props) {
      const { t, fmt, row } = props;
      const cost = num(row.cost);
      const totalTokens = (num(row.inputTokens) || 0) + (num(row.cachedTokens) || 0) + (num(row.outputTokens) || 0);
      const share = num(row.costShare) || 0;
      return h('li', { className: 'um-row' },
        h('div', { className: 'um-row-head' },
          h('div', { className: 'um-row-main' },
            h('span', { className: 'um-row-title', title: row.label || row.key || undefined }, row.label || row.key || EM_DASH),
            row.sublabel ? h('span', { className: 'um-row-sub', title: row.sublabel }, row.sublabel) : null),
          h('span', { className: 'um-row-cost' },
            cost != null
              ? h(CostValue, { t, fmt, value: cost })
              : h('span', { className: 'um-muted' }, EM_DASH))),
        h(Bar, { value: share, label: t('consumers.share', { rate: fmt.percent(share) }) }),
        h('div', { className: 'um-row-meta' },
          h('span', null, fmt.number(row.requests), ' ', t('unit.req'), DOT_SEP, h(TokenCount, { fmt, value: totalTokens }), ' ', t('unit.tokens')),
          h('span', null, t('consumers.hit', { rate: num(row.hitRate) != null ? fmt.percent(row.hitRate) : EM_DASH }))));
    }

    function ModelsCard(props) {
      const { t, fmt, models } = props;
      const list = Array.isArray(models) ? models : [];
      return h(Card, { title: t('models.title'), className: 'um-models-card' },
        list.length
          ? h('ul', { className: 'um-rows' }, list.map((row, index) => h(ModelRow, { key: row.model || row.provider || 'model-' + index, t, fmt, row })))
          : h('div', { className: 'um-empty-inline' }, t('models.empty')));
    }

    function ModelRow(props) {
      const { t, fmt, row } = props;
      const cost = num(row.cost);
      const share = num(row.costShare) || 0;
      const totalTokens = (num(row.uncachedTokens) || 0) + (num(row.cachedTokens) || 0) + (num(row.outputTokens) || 0);
      const breakdown = t('models.breakdown', {
        input: fmt.compact(row.uncachedTokens),
        cached: fmt.compact(row.cachedTokens),
        output: fmt.compact(row.outputTokens),
      });
      return h('li', { className: 'um-row' },
        h('div', { className: 'um-row-head' },
          h('div', { className: 'um-row-main' },
            h('span', { className: 'um-row-title', title: row.model || undefined }, row.model || EM_DASH),
            row.provider ? h('span', { className: 'um-row-sub' }, row.provider) : null),
          h('span', { className: 'um-row-cost' },
            row.priced === false
              ? h('span', { className: 'um-muted' }, t('models.noPricing'))
              : cost != null
                ? h(CostValue, { t, fmt, value: cost })
                : h('span', { className: 'um-muted' }, EM_DASH))),
        h(Bar, { value: share, label: t('models.share', { rate: fmt.percent(share) }) }),
        h('div', { className: 'um-row-meta' },
          h('span', null, fmt.number(row.requests), ' ', t('unit.req'), DOT_SEP, h(TokenCount, { fmt, value: totalTokens }), ' ', t('unit.tokens')),
          h('span', { title: breakdown }, t('models.hit', { rate: num(row.hitRate) != null ? fmt.percent(row.hitRate) : EM_DASH }))));
    }

    function CauseRow(props) {
      const { t, fmt, row } = props;
      const chips = evidenceChips(t, fmt, row.evidence);
      const severity = levelOf(row.severity);
      return h('div', { className: 'um-cause' },
        h('span', { className: 'um-dot', 'data-level': severity, 'aria-hidden': true }),
        h('div', { className: 'um-cause-body' },
          h('div', { className: 'um-cause-head' },
            h('span', { className: 'um-cause-title' }, row.title),
            h('span', { className: 'um-chip' }, t('severity.' + severity))),
          row.detail ? h('p', { className: 'um-cause-detail' }, row.detail) : null,
          chips.length
            ? h('div', { className: 'um-chips' }, chips.map((chip) => h('span', { key: chip.key, className: 'um-chip um-chip-mono' },
              chip.label + ': ' + chip.value)))
            : null));
    }

    function DiagnosisCard(props) {
      const { t, fmt, data } = props;
      const rows = buildCauses(data, t, fmt);
      const visible = rows.slice(0, MAX_CAUSES);
      return h(Card, { title: t('why.title'), className: 'um-why-card' },
        visible.length
          ? h('div', { className: 'um-cause-list' },
            visible.map((row) => h(CauseRow, { key: row.key, t, fmt, row })),
            rows.length > visible.length
              ? h('div', { className: 'um-more-note' }, t('why.more', { count: rows.length - visible.length }))
              : null)
          : h('div', { className: 'um-empty' },
            h('div', { className: 'um-empty-title' }, t('why.empty')),
            h('p', { className: 'um-empty-hint' }, t('why.emptyHint'))));
    }

    function AnomalyCard(props) {
      const { t, fmt, anomalies } = props;
      const list = Array.isArray(anomalies)
        ? anomalies.filter((item) => item && typeof item.t === 'number').slice().sort((a, b) => b.t - a.t)
        : [];
      const visible = list.slice(0, MAX_ANOMALIES);
      return h(Card, { title: t('anomalies.title'), className: 'um-anomaly-card' },
        visible.length
          ? h('ol', { className: 'um-timeline', 'aria-label': t('anomalies.aria') },
            visible.map((item, index) => {
              const localized = localizeAnomaly(t, fmt, item, props.settings);
              return h('li', { key: item.id || 'anomaly-' + index, className: 'um-timeline-row' },
                h('span', { className: 'um-timeline-time', title: fmt.full(item.t) }, fmt.stamp(item.t)),
                h('span', { className: 'um-dot', 'data-level': levelOf(item.level), 'aria-hidden': true }),
                h('div', { className: 'um-timeline-body' },
                  h('div', { className: 'um-timeline-title' }, localized.title || item.title || item.type || EM_DASH),
                  localized.detail ? h('div', { className: 'um-timeline-detail' }, localized.detail) : null,
                  item.sessionId
                    ? h('span', { className: 'um-chip um-chip-mono', title: item.sessionId }, t('anomalies.session'))
                    : null));
            }),
            list.length > visible.length
              ? h('div', { className: 'um-more-note' }, t('anomalies.more', { count: list.length - visible.length }))
              : null)
          : h('div', { className: 'um-empty-inline' }, t('anomalies.empty')));
    }

    function ForecastStrip(props) {
      const { t, fmt, data } = props;
      const forecast = (data && data.forecast) || {};
      const daily = num(forecast.dailyCost);
      const baselineDaily = num(forecast.dailyCostBaseline);
      const daysRemaining = num(forecast.daysRemaining);
      const remaining = daysRemaining != null ? fmt.duration(daysRemaining * 24) : forecast.remainingTimeText || null;
      return h('section', { className: 'um-card um-forecast', 'aria-label': t('forecast.title') },
        h('div', { className: 'um-forecast-item' },
          h('div', { className: 'um-forecast-label' }, t('forecast.daily')),
          h('div', { className: 'um-forecast-value' },
            daily != null ? h(CostValue, { t, fmt, value: daily }) : EM_DASH),
          baselineDaily != null
            ? h('div', { className: 'um-forecast-meta' }, t('forecast.dailyBaseline', { amount: fmt.money(baselineDaily) }))
            : null),
        h('div', { className: 'um-forecast-item' },
          h('div', { className: 'um-forecast-label' }, t('forecast.remaining')),
          h('div', { className: 'um-forecast-value' }, remaining || t('forecast.unknown'))),
        h('div', { className: 'um-forecast-note' }, t('forecast.basis')));
    }

    function Footer(props) {
      const { t, fmt, data } = props;
      const diagnostics = (data && data.diagnostics) || {};
      const sources = diagnostics.sources || {};
      const balanceSource = sources.balance || {};
      const tokenSource = sources.tokens || {};
      const pricing = sources.pricing || {};
      const scan = diagnostics.scan || {};
      const warnings = Array.isArray(diagnostics.warnings) ? diagnostics.warnings.filter(Boolean) : [];
      const scanLabel = scan.inProgress
        ? t('footer.scanning')
        : scan.finishedAt
          ? t('footer.scanned', { sessions: fmt.number(scan.sessions), time: fmt.stamp(scan.finishedAt) })
          : t('footer.scanIdle');
      const errors = num(scan.errors) != null && scan.errors > 0 ? t('footer.scanErrors', { count: fmt.number(scan.errors) }) : null;
      return h('footer', { className: 'um-footer' },
        h('div', { className: 'um-footer-line' },
          h('span', { className: 'um-footer-label' }, t('footer.sources')),
          h('span', null, t('footer.balance', {
            kind: balanceSource.kind || EM_DASH,
            state: balanceSource.state || EM_DASH,
          })),
          h('span', { className: 'um-footer-sep', 'aria-hidden': true }, DOT_SEP),
          h('span', null, t('footer.tokens', {
            sessions: fmt.number(tokenSource.sessionsScanned),
            requests: fmt.number(tokenSource.requests),
          })),
          h('span', { className: 'um-footer-sep', 'aria-hidden': true }, DOT_SEP),
          pricing.source
            ? h('a', { className: 'um-link', href: pricing.source, target: '_blank', rel: 'noreferrer noopener', title: pricing.source },
              t('footer.pricing', { asOf: pricing.asOf || EM_DASH }))
            : h('span', null, t('footer.pricingUnknown'))),
        h('div', { className: 'um-footer-line' },
          h('span', { className: 'um-footer-label' }, scanLabel),
          errors ? h('span', { className: 'um-footer-error' }, errors) : null,
          h('span', { className: 'um-footer-sep', 'aria-hidden': true }, DOT_SEP),
          h('span', { className: 'um-footer-privacy' }, t('footer.privacy'))),
        warnings.length
          ? h('div', { className: 'um-footer-line um-footer-warnings', title: warnings.join('\n') },
            h('span', null, warnings.length === 1
              ? t('footer.warningsOne')
              : t('footer.warningsMany', { count: fmt.number(warnings.length) })))
          : null);
    }

    function EmptyUsage(props) {
      return h('section', { className: 'um-card um-empty-state' },
        h('div', { className: 'um-empty-title' }, props.t('empty.title')),
        h('p', { className: 'um-empty-hint' }, props.t('empty.hint')));
    }

    function LoadingSkeleton(props) {
      const kpiCards = [0, 1, 2, 3].map((index) => h('div', { key: 'kpi-' + index, className: 'um-card um-kpi' },
        h('div', { className: 'um-skel um-skel-label' }),
        h('div', { className: 'um-skel um-skel-figure' }),
        h('div', { className: 'um-skel um-skel-meta' })));
      const twoCards = [0, 1].map((index) => h('div', { key: 'two-' + index, className: 'um-card' },
        h('div', { className: 'um-skel um-skel-title' }),
        h('div', { className: 'um-skel um-skel-figure' }),
        h('div', { className: 'um-skel um-skel-meta' })));
      return h('div', { className: 'um-body', 'aria-busy': 'true' },
        h('span', { className: 'um-sr' }, props.t('page.loading')),
        h('div', { className: 'um-grid um-kpis' }, kpiCards),
        h('div', { className: 'um-card' },
          h('div', { className: 'um-skel um-skel-title' }),
          h('div', { className: 'um-skel um-skel-chart' })),
        h('div', { className: 'um-grid um-two' }, twoCards));
    }

    function errorBodyText(t, error) {
      if (!error) return t('error.network');
      if (error.kind === 'http') return t('error.http', { status: error.status || EM_DASH });
      if (error.kind === 'invalid') return t('error.invalid');
      if (error.timedOut) return t('error.timeout');
      return t('error.network');
    }

    function ErrorState(props) {
      const unauthorized = props.mode === 'unauthorized';
      const title = unauthorized ? props.t('error.unauthorizedTitle') : props.t('error.title');
      const body = unauthorized ? props.t('error.unauthorizedBody') : errorBodyText(props.t, props.error);
      return h('div', { className: 'um-center-wrap' },
        h('section', { className: 'um-card um-error-card', role: 'alert' },
          h('div', { className: 'um-error-title' }, title),
          h('p', { className: 'um-error-body' }, body),
          !unauthorized && props.error && props.error.message
            ? h('p', { className: 'um-error-detail' }, props.error.message)
            : null,
          h('button', { type: 'button', className: 'um-btn um-btn-primary', onClick: props.onRetry },
            props.t('error.retry'))));
    }

    /* ---------------------------------------------------------------------------------------- *
     * Settings drawer — thresholds form. Rendered in-flow on the right of the page, not a modal.
     * ---------------------------------------------------------------------------------------- */

    /** Snapshot settings -> editable string draft (percents shown as 0..100). */
    function settingsToDraft(settings) {
      const merged = Object.assign({}, SETTINGS_FALLBACK, settings || {});
      const percent = (value) => {
        const amount = num(Number(value));
        return amount == null ? '' : String(Math.round(amount * 1000) / 10);
      };
      return {
        warningBurnRatio: String(merged.warningBurnRatio),
        criticalBurnRatio: String(merged.criticalBurnRatio),
        cacheWarningRate: percent(merged.cacheWarningRate),
        cacheCriticalRate: percent(merged.cacheCriticalRate),
        cacheAlertMinutes: String(merged.cacheAlertMinutes),
        requestRateWarningMultiplier: String(merged.requestRateWarningMultiplier),
        costSpike10m: String(merged.costSpike10m),
        balanceAlerts: Array.isArray(merged.balanceAlerts) ? merged.balanceAlerts.join(', ') : String(merged.balanceAlerts || ''),
        balanceRefreshSeconds: String(merged.balanceRefreshSeconds),
        retentionDays: String(merged.retentionDays),
        currency: CURRENCIES.indexOf(merged.currency) >= 0 ? merged.currency : 'auto',
      };
    }

    /**
     * Validate the draft and build the POST subset. Returns `{ patch, errors }`; nothing is sent
     * while `errors` is non-empty. The Host validates and clamps again server-side.
     */
    function draftToPatch(draft, t) {
      const errors = {};
      const patch = {};

      function numberField(field, bounds, integer) {
        const raw = String(draft[field] == null ? '' : draft[field]).trim();
        const value = Number(raw);
        if (!raw || !isFinite(value) || (integer && Math.round(value) !== value)) {
          errors[field] = t('settings.errNumber');
          return null;
        }
        if (value < bounds.min) {
          errors[field] = t('settings.errMin', { min: bounds.min });
          return null;
        }
        if (value > bounds.max) {
          errors[field] = t('settings.errMax', { max: bounds.max });
          return null;
        }
        return value;
      }

      const warnBurn = numberField('warningBurnRatio', LIMITS.burnRatio, false);
      const critBurn = numberField('criticalBurnRatio', LIMITS.burnRatio, false);
      if (warnBurn != null) patch.warningBurnRatio = warnBurn;
      if (critBurn != null) patch.criticalBurnRatio = critBurn;
      if (warnBurn != null && critBurn != null && critBurn < warnBurn) errors.criticalBurnRatio = t('settings.errOrderUp');

      const warnCache = numberField('cacheWarningRate', LIMITS.cachePercent, false);
      const critCache = numberField('cacheCriticalRate', LIMITS.cachePercent, false);
      if (warnCache != null) patch.cacheWarningRate = warnCache / 100;
      if (critCache != null) patch.cacheCriticalRate = critCache / 100;
      if (warnCache != null && critCache != null && critCache > warnCache) errors.cacheCriticalRate = t('settings.errOrderDown');

      const cacheMinutes = numberField('cacheAlertMinutes', LIMITS.cacheMinutes, true);
      if (cacheMinutes != null) patch.cacheAlertMinutes = cacheMinutes;

      const multiplier = numberField('requestRateWarningMultiplier', LIMITS.requestMultiplier, false);
      if (multiplier != null) patch.requestRateWarningMultiplier = multiplier;

      const costSpike = numberField('costSpike10m', LIMITS.costSpike, false);
      if (costSpike != null) patch.costSpike10m = costSpike;

      const refresh = numberField('balanceRefreshSeconds', LIMITS.refreshSeconds, true);
      if (refresh != null) patch.balanceRefreshSeconds = refresh;

      const retention = numberField('retentionDays', LIMITS.retentionDays, true);
      if (retention != null) patch.retentionDays = retention;

      const alertBounds = LIMITS.balanceAlerts;
      const alertSource = String(draft.balanceAlerts == null ? '' : draft.balanceAlerts).trim();
      const parts = alertSource ? alertSource.split(/[,，\s]+/).filter(Boolean) : [];
      const amounts = [];
      let listValid = parts.length > 0;
      for (let i = 0; i < parts.length && listValid; i += 1) {
        const amount = Number(parts[i]);
        if (!isFinite(amount) || amount < alertBounds.min || amount > alertBounds.max) listValid = false;
        else amounts.push(amount);
      }
      if (!listValid) errors.balanceAlerts = t('settings.errList');
      else {
        amounts.sort((a, b) => b - a);
        patch.balanceAlerts = amounts.slice(0, alertBounds.maxCount);
      }

      if (CURRENCIES.indexOf(draft.currency) < 0) errors.currency = t('settings.errCurrency');
      else patch.currency = draft.currency;

      return { patch, errors };
    }

    function SettingsField(props) {
      return h('label', { className: 'um-field' },
        h('span', { className: 'um-field-label' },
          h('span', null, props.label),
          h('span', { className: 'um-field-unit' }, props.unit || '')),
        h('input', {
          className: 'um-input',
          type: props.kind === 'text' ? 'text' : 'number',
          inputMode: props.kind === 'text' ? undefined : 'decimal',
          step: props.kind === 'text' ? undefined : 'any',
          min: props.min,
          max: props.max,
          value: props.value,
          onChange: (event) => props.onChange(event.target.value),
          'aria-invalid': props.error ? 'true' : undefined,
        }),
        props.hint ? h('span', { className: 'um-field-hint' }, props.hint) : null,
        props.error ? h('span', { className: 'um-field-error' }, props.error) : null);
    }

    function SettingsDrawer(props) {
      const { t, data, onClose, onSave } = props;
      const [draft, setDraft] = useState(() => settingsToDraft(data && data.settings));
      const [errors, setErrors] = useState({});
      const [saving, setSaving] = useState(false);
      const [saveError, setSaveError] = useState(null);
      const alive = useRef(true);
      const closeRef = useRef(onClose);
      closeRef.current = onClose;

      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
      }, []);

      // Escape closes the drawer; the keydown listener is owned by the mounted drawer.
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closeRef.current();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, []);

      const update = (field) => (value) => {
        setDraft((current) => Object.assign({}, current, { [field]: value }));
        setErrors((current) => {
          if (!current[field]) return current;
          const next = Object.assign({}, current);
          delete next[field];
          return next;
        });
      };

      const submit = (event) => {
        if (event) event.preventDefault();
        if (saving) return;
        const result = draftToPatch(draft, t);
        if (Object.keys(result.errors).length) {
          setErrors(result.errors);
          return;
        }
        setErrors({});
        setSaveError(null);
        setSaving(true);
        Promise.resolve(onSave(result.patch)).then((outcome) => {
          if (!alive.current) return;
          setSaving(false);
          if (outcome && outcome.ok) onClose();
          else setSaveError((outcome && outcome.message) || t('settings.failed'));
        }, () => {
          if (alive.current) setSaving(false);
        });
      };

      return h('aside', { className: 'um-drawer', 'aria-label': t('settings.title') },
        h('div', { className: 'um-drawer-head' },
          h('h2', { className: 'um-drawer-title' }, t('settings.title')),
          h(IconButton, { label: t('settings.close'), onClick: onClose }, h(CloseIcon))),
        h('form', { className: 'um-drawer-form', onSubmit: submit },
          h('p', { className: 'um-drawer-note' }, t('settings.hint')),
          saveError ? h('div', { className: 'um-drawer-error', role: 'alert' }, saveError) : null,

          h('div', { className: 'um-drawer-section' },
            h('div', { className: 'um-drawer-section-title' }, t('settings.sectionBurn')),
            h(SettingsField, {
              label: t('settings.burnWarning'),
              unit: '\u00d7',
              value: draft.warningBurnRatio,
              onChange: update('warningBurnRatio'),
              error: errors.warningBurnRatio,
              min: LIMITS.burnRatio.min,
              max: LIMITS.burnRatio.max,
            }),
            h(SettingsField, {
              label: t('settings.burnCritical'),
              unit: '\u00d7',
              value: draft.criticalBurnRatio,
              onChange: update('criticalBurnRatio'),
              error: errors.criticalBurnRatio,
              min: LIMITS.burnRatio.min,
              max: LIMITS.burnRatio.max,
            })),

          h('div', { className: 'um-drawer-section' },
            h('div', { className: 'um-drawer-section-title' }, t('settings.sectionCache')),
            h(SettingsField, {
              label: t('settings.cacheWarning'),
              unit: '%',
              value: draft.cacheWarningRate,
              onChange: update('cacheWarningRate'),
              error: errors.cacheWarningRate,
              min: LIMITS.cachePercent.min,
              max: LIMITS.cachePercent.max,
            }),
            h(SettingsField, {
              label: t('settings.cacheCritical'),
              unit: '%',
              value: draft.cacheCriticalRate,
              onChange: update('cacheCriticalRate'),
              error: errors.cacheCriticalRate,
              min: LIMITS.cachePercent.min,
              max: LIMITS.cachePercent.max,
            }),
            h(SettingsField, {
              label: t('settings.cacheAlertMinutes'),
              unit: 'min',
              value: draft.cacheAlertMinutes,
              onChange: update('cacheAlertMinutes'),
              error: errors.cacheAlertMinutes,
              min: LIMITS.cacheMinutes.min,
              max: LIMITS.cacheMinutes.max,
            })),

          h('div', { className: 'um-drawer-section' },
            h('div', { className: 'um-drawer-section-title' }, t('settings.sectionRate')),
            h(SettingsField, {
              label: t('settings.requestMultiplier'),
              unit: '\u00d7',
              value: draft.requestRateWarningMultiplier,
              onChange: update('requestRateWarningMultiplier'),
              error: errors.requestRateWarningMultiplier,
              min: LIMITS.requestMultiplier.min,
              max: LIMITS.requestMultiplier.max,
            }),
            h(SettingsField, {
              label: t('settings.costSpike'),
              unit: fmtCurrencyUnit(data),
              value: draft.costSpike10m,
              onChange: update('costSpike10m'),
              error: errors.costSpike10m,
              min: LIMITS.costSpike.min,
              max: LIMITS.costSpike.max,
            })),

          h('div', { className: 'um-drawer-section' },
            h('div', { className: 'um-drawer-section-title' }, t('settings.sectionBalance')),
            h(SettingsField, {
              label: t('settings.balanceAlerts'),
              kind: 'text',
              value: draft.balanceAlerts,
              onChange: update('balanceAlerts'),
              error: errors.balanceAlerts,
              hint: t('settings.balanceAlertsHint'),
            }),
            h(SettingsField, {
              label: t('settings.balanceRefresh'),
              unit: 's',
              value: draft.balanceRefreshSeconds,
              onChange: update('balanceRefreshSeconds'),
              error: errors.balanceRefreshSeconds,
              min: LIMITS.refreshSeconds.min,
              max: LIMITS.refreshSeconds.max,
            }),
            h(SettingsField, {
              label: t('settings.retention'),
              unit: 'd',
              value: draft.retentionDays,
              onChange: update('retentionDays'),
              error: errors.retentionDays,
              min: LIMITS.retentionDays.min,
              max: LIMITS.retentionDays.max,
            }),
            h('label', { className: 'um-field' },
              h('span', { className: 'um-field-label' }, t('settings.currency')),
              h('select', {
                className: 'um-select',
                value: draft.currency,
                onChange: (event) => update('currency')(event.target.value),
              }, CURRENCIES.map((code) => h('option', { key: code, value: code },
                code === 'auto' ? t('settings.currencyAuto') : code))))),

          h('div', { className: 'um-drawer-actions' },
            h('button', { type: 'submit', className: 'um-btn um-btn-primary', disabled: saving },
              saving ? t('settings.saving') : t('settings.save')),
            h('button', { type: 'button', className: 'um-btn', onClick: onClose, disabled: saving },
              t('settings.discard')))));
    }

    /** Unit suffix for the cost-spike field: the display currency, or the wallet currency. */
    function fmtCurrencyUnit(data) {
      if (data && typeof data.currency === 'string' && data.currency) return data.currency;
      return 'CNY';
    }

    /* ---------------------------------------------------------------------------------------- *
     * Page container — owns data fetching, polling lifecycle and all page state.
     * ---------------------------------------------------------------------------------------- */

    function UsageMonitorPage(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const [range, setRange] = useState('24h');
      const [snapshot, setSnapshot] = useState(null);
      const [loadedAt, setLoadedAt] = useState(0);
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState(null);
      const [connError, setConnError] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const [savedAt, setSavedAt] = useState(0);

      const mounted = useRef(true);
      const snapshotRef = useRef(null);
      const rangeRef = useRef(range);
      const inflight = useRef(null);
      const controllers = useRef([]);
      const unauthorized = useRef(false);
      const actionBusy = useRef(false);

      /** Abort every outstanding request (used on unmount and before a user-triggered request). */
      const abortAll = useCallback(() => {
        const list = controllers.current;
        controllers.current = [];
        for (let i = 0; i < list.length; i += 1) {
          try { list[i].abort(); } catch (err) { /* already settled */ }
        }
      }, []);

      /**
       * One JSON request with an AbortController and a timeout. Throws a tagged Error:
       * kind = unauthorized | http | invalid | network, with `aborted`/`timedOut` flags so the
       * callers can distinguish "preempted by a newer request or unmount" from a real failure.
       */
      const request = useCallback(async (path, init) => {
        const controller = new AbortController();
        controllers.current.push(controller);
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
          timedOut = true;
          try { controller.abort(); } catch (err) { /* already settled */ }
        }, REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(API_BASE + path, {
            method: (init && init.method) || 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: Object.assign({ accept: 'application/json' }, (init && init.headers) || {}),
            body: init && init.body,
            signal: controller.signal,
          });
          if (response.status === 401) {
            const authError = new Error('unauthorized');
            authError.kind = 'unauthorized';
            throw authError;
          }
          let payload = null;
          try { payload = await response.json(); } catch (err) { payload = null; }
          if (!response.ok) {
            const serverError = payload && payload.error ? payload.error : null;
            const httpError = new Error(serverError && serverError.message ? serverError.message : ('HTTP ' + response.status));
            httpError.kind = 'http';
            httpError.status = response.status;
            httpError.code = serverError ? serverError.code : null;
            throw httpError;
          }
          if (!payload || typeof payload !== 'object') {
            const invalidError = new Error('invalid snapshot');
            invalidError.kind = 'invalid';
            throw invalidError;
          }
          return payload;
        } catch (caught) {
          if (caught && (caught.kind === 'unauthorized' || caught.kind === 'http' || caught.kind === 'invalid')) throw caught;
          const networkError = new Error(caught && caught.message ? caught.message : 'network error');
          networkError.kind = 'network';
          networkError.aborted = Boolean(caught && caught.name === 'AbortError');
          networkError.timedOut = timedOut;
          throw networkError;
        } finally {
          window.clearTimeout(timeoutId);
          const index = controllers.current.indexOf(controller);
          if (index >= 0) controllers.current.splice(index, 1);
        }
      }, []);

      /**
       * Serialize requests: a poll tick is skipped while another request is in flight; a user
       * action (refresh / save settings) preempts it so the two never overlap.
       */
      const withLock = useCallback((task, preempt) => {
        const current = inflight.current;
        if (current) {
          if (!preempt) return null;
          abortAll();
          inflight.current = null;
          current.catch(() => { /* preempted */ });
        }
        const promise = Promise.resolve().then(task);
        inflight.current = promise;
        const clear = () => { if (inflight.current === promise) inflight.current = null; };
        promise.then(clear, clear);
        return promise;
      }, [abortAll]);

      const applySnapshot = useCallback((data) => {
        if (!data || typeof data !== 'object') return;
        snapshotRef.current = data;
        setSnapshot(data);
        setLoadedAt(Date.now());
        setPhase('ready');
        setError(null);
        setConnError(null);
        unauthorized.current = false;
      }, []);

      const handleFailure = useCallback((err) => {
        if (!mounted.current) return;
        if (err && err.aborted && !err.timedOut) return;
        const info = {
          kind: err && err.kind ? err.kind : 'network',
          status: err && err.status ? err.status : 0,
          message: err && err.message ? err.message : '',
          timedOut: Boolean(err && err.timedOut),
          at: Date.now(),
        };
        if (info.kind === 'unauthorized') {
          unauthorized.current = true;
          setPhase('unauthorized');
          setError(null);
          setConnError(null);
          return;
        }
        if (snapshotRef.current) {
          setConnError(info);
          setPhase('ready');
        } else {
          setError(info);
          setPhase('error');
        }
      }, []);

      const fetchSnapshot = useCallback(async (target) => {
        const requested = target || rangeRef.current;
        const data = await request('/snapshot?range=' + encodeURIComponent(requested));
        if (!mounted.current) return;
        applySnapshot(data);
      }, [request, applySnapshot]);

      const load = useCallback((target) => {
        if (unauthorized.current) return null;
        return withLock(() => fetchSnapshot(target).catch(handleFailure), false);
      }, [withLock, fetchSnapshot, handleFailure]);

      /** Like `load`, but preempts an in-flight request: used by range switches and Retry. */
      const loadNow = useCallback((target) => {
        if (unauthorized.current) return null;
        return withLock(() => fetchSnapshot(target).catch(handleFailure), true);
      }, [withLock, fetchSnapshot, handleFailure]);

      const retry = useCallback(() => {
        unauthorized.current = false;
        setError(null);
        setConnError(null);
        if (!snapshotRef.current) setPhase('loading');
        loadNow(rangeRef.current);
      }, [loadNow]);

      const refresh = useCallback(() => {
        if (actionBusy.current) return;
        actionBusy.current = true;
        unauthorized.current = false;
        setRefreshing(true);
        const locked = withLock(() => request('/refresh', { method: 'POST' }), true);
        if (!locked) {
          actionBusy.current = false;
          setRefreshing(false);
          return;
        }
        locked
          .then((data) => {
            if (!mounted.current) return;
            if (data) applySnapshot(data);
          })
          .catch(handleFailure)
          .then(() => {
            actionBusy.current = false;
            if (mounted.current) setRefreshing(false);
          });
      }, [withLock, request, applySnapshot, handleFailure]);

      /** POST the settings subset; resolves to `{ ok }` or `{ ok: false, message }` for the drawer. */
      const saveSettings = useCallback((patch) => {
        if (actionBusy.current) return Promise.resolve({ ok: false, message: '' });
        actionBusy.current = true;
        const locked = withLock(() => request('/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }), true);
        if (!locked) {
          actionBusy.current = false;
          return Promise.resolve({ ok: false, message: '' });
        }
        return locked
          .then((data) => {
            if (!mounted.current || !data) return { ok: false, message: '' };
            // The Host clamps/normalizes settings and reports what it changed as new
            // diagnostics warnings instead of failing the request; surface those in the drawer.
            const previous = warningList(snapshotRef.current);
            const adjusted = warningList(data).filter((warning) => previous.indexOf(warning) < 0);
            applySnapshot(data);
            if (adjusted.length) return { ok: false, message: t('settings.serverAdjusted') + ' ' + adjusted.join(' ') };
            setSavedAt(Date.now());
            return { ok: true };
          })
          .catch((err) => {
            if (err && err.aborted && !err.timedOut) return { ok: false, message: '' };
            if (err && err.kind === 'unauthorized') {
              handleFailure(err);
              return { ok: false, message: '', unauthorized: true };
            }
            if (err && err.kind === 'http') {
              return { ok: false, message: err.message || '', code: err.code || null };
            }
            handleFailure(err);
            return { ok: false, message: err && err.message ? err.message : '' };
          })
          .then((outcome) => {
            actionBusy.current = false;
            return outcome;
          });
      }, [withLock, request, applySnapshot, handleFailure, t]);

      // Mount lifetime: mark unmounted, then abort every request still outstanding.
      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          abortAll();
        };
      }, [abortAll]);

      // Polling lifecycle: one interval + visibility listener per selected range. Hidden documents
      // skip ticks; becoming visible refreshes immediately. Every timer is cleaned up here.
      useEffect(() => {
        rangeRef.current = range;
        loadNow(range);
        const interval = window.setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          load(rangeRef.current);
        }, POLL_MS);
        const onVisibility = () => {
          if (typeof document === 'undefined' || document.hidden) return;
          load(rangeRef.current);
        };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.clearInterval(interval);
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [range, load, loadNow]);

      // The "settings saved" hint clears itself.
      useEffect(() => {
        if (!savedAt) return undefined;
        const timer = window.setTimeout(() => {
          if (mounted.current) setSavedAt(0);
        }, TOAST_MS);
        return () => window.clearTimeout(timer);
      }, [savedAt]);

      const mismatched = Boolean(snapshot && snapshot.series && snapshot.series.range && snapshot.series.range !== range);

      // A stale series right after a range switch retries once shortly instead of waiting a full tick.
      useEffect(() => {
        if (!mismatched) return undefined;
        const timer = window.setTimeout(() => { loadNow(rangeRef.current); }, RANGE_RETRY_MS);
        return () => window.clearTimeout(timer);
      }, [mismatched, range, loadNow]);

      const openSettings = useCallback(() => {
        if (snapshotRef.current) setSettingsOpen(true);
      }, []);
      const closeSettings = useCallback(() => setSettingsOpen(false), []);
      const changeRange = useCallback((nextRange) => {
        if (RANGES.indexOf(nextRange) < 0) return;
        setRange(nextRange);
      }, []);

      const data = snapshot;
      const lang = resolveLang(data);
      const currency = data && data.currency ? data.currency : 'CNY';
      const fmt = useMemo(() => makeFormatters(lang, currency), [lang, currency]);
      const alerts = data ? firingAlerts(data.alerts) : [];
      const empty = Boolean(data) && usageCount(data) === 0;
      const status = data && data.status ? data.status : null;

      let body = null;
      if (phase === 'unauthorized') {
        body = h(ErrorState, { t, mode: 'unauthorized', onRetry: retry });
      } else if (!data && phase === 'error') {
        body = h(ErrorState, { t, mode: 'error', error, onRetry: retry });
      } else if (!data) {
        body = h(LoadingSkeleton, { t });
      } else {
        body = h('div', { className: 'um-body' },
          h(AlertStrip, { t, fmt, alerts, settings: data.settings }),
          connError ? h(ConnStrip, { t, fmt, error: connError, onRetry: retry }) : null,
          h(KpiRow, { t, fmt, data }),
          empty
            ? h(EmptyUsage, { t })
            : h('div', { className: 'um-sections' },
              h(TrendCard, { t, fmt, data, range, onRange: changeRange, mismatch: mismatched }),
              h('div', { className: 'um-grid um-two' },
                h(CacheCard, { t, fmt, data }),
                h(RequestRateCard, { t, fmt, data, range })),
              h('div', { className: 'um-grid um-two' },
                h(ConsumersCard, { t, fmt, consumers: data.consumers }),
                h(ModelsCard, { t, fmt, models: data.models })),
              h(DiagnosisCard, { t, fmt, data }),
              h(AnomalyCard, { t, fmt, anomalies: data.anomalies, settings: data.settings }),
              h(ForecastStrip, { t, fmt, data })),
          h(Footer, { t, fmt, data }));
      }

      const showDrawer = settingsOpen && Boolean(data) && phase === 'ready';
      return h('div', { className: 'um-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'um-scroll' },
          h('div', { className: 'um-page' },
            h(Header, {
              t,
              fmt,
              status: phase === 'ready' ? status : null,
              updatedAt: loadedAt,
              refreshing,
              savedAt,
              onRefresh: refresh,
              onSettings: openSettings,
              canRefresh: Boolean(data) || phase === 'error',
              canSettings: Boolean(data),
            }),
            body)),
        showDrawer
          ? h(SettingsDrawer, { t, fmt, data, onClose: closeSettings, onSave: saveSettings })
          : null);
    }

    /* ---------------------------------------------------------------------------------------- *
     * Sidebar icon — monochrome glyph rendered at the requested edge, inherits row color.
     * ---------------------------------------------------------------------------------------- */

    function UsageMonitorIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
        h('path', { d: 'M3.5 17.5h17' }),
        h('path', { d: 'M5.5 14.5l3.2-4.2 3.1 2.6 3.3-5.1 3.4 3.1' }),
        h('circle', { cx: 18.6, cy: 6.6, r: 2.1, fill: 'currentColor', stroke: 'none', opacity: 0.9 }));
    }

    /* ---------------------------------------------------------------------------------------- *
     * Styles — one rendered <style> element, removed with the page. Only `--dsw-alias-*` theme
     * tokens, `color-mix` derived variants and opacity; no literal colors, gradients or glow.
     * ---------------------------------------------------------------------------------------- */

    const CSS = `
.um-root {
  position: relative;
  display: flex;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 20px;
}
.um-root *, .um-root *::before, .um-root *::after { box-sizing: border-box; }
.um-scroll { flex: 1; min-width: 0; height: 100%; overflow: auto; scrollbar-width: thin; }
.um-page { max-width: 1220px; margin: 0 auto; padding: 24px 32px 56px; }
@media (max-width: 900px) { .um-page { padding: 20px 16px 40px; } }
[data-platform='darwin'] .um-page { padding-top: calc(24px + var(--dsh-frame-top-clearance, 0px)); }
.um-root button, .um-root input, .um-root select, .um-root a { font: inherit; }
.um-root button:focus-visible, .um-root a:focus-visible, .um-root input:focus-visible,
.um-root select:focus-visible, .um-root [tabindex]:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.um-root h1, .um-root h2, .um-root p { margin: 0; }
.um-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.um-muted { color: var(--dsw-alias-label-secondary); }

/* Header ---------------------------------------------------------------------------------- */
.um-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.um-head-main { min-width: 0; }
.um-title { font-size: 18px; line-height: 26px; font-weight: 600; letter-spacing: -0.01em; }
.um-sub { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-head-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.um-updated { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.um-saved { color: var(--dsw-alias-state-success-primary); }
.um-icon-btn {
  width: 28px; height: 28px; padding: 0; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.um-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.um-icon-btn:disabled { opacity: 0.45; cursor: default; }
.um-btn {
  height: 28px; padding: 0 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 12px; white-space: nowrap;
}
.um-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.um-btn:disabled { opacity: 0.5; cursor: default; }
.um-btn-primary {
  border-color: var(--dsw-alias-border-l1);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, var(--dsw-alias-border-l1));
  color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-bg-layer-1);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1));
}
.um-link-btn { padding: 0; border: 0; background: none; color: var(--dsw-alias-brand-primary); cursor: pointer; font-size: 12px; }
.um-link { color: var(--dsw-alias-brand-primary); text-decoration: none; }
.um-link:hover { text-decoration: underline; }

/* Status ---------------------------------------------------------------------------------- */
.um-pill {
  display: inline-flex; align-items: center; gap: 6px;
  height: 22px; padding: 0 8px; border-radius: 11px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 12px; font-weight: 500; white-space: nowrap;
}
.um-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: currentColor; }
.um-root [data-level='critical'] { color: var(--dsw-alias-state-error-primary); }
.um-root [data-level='warning'] { color: var(--dsw-alias-state-warn-primary); }
.um-root [data-level='normal'], .um-root [data-level='success'] { color: var(--dsw-alias-state-success-primary); }
.um-root [data-level='info'], .um-root [data-level='idle'] { color: var(--dsw-alias-state-idle-primary); }
.um-pill[data-level='normal'] { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.um-pill[data-level='warning'] { border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.um-pill[data-level='critical'] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1)); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1)); }

/* Cards and grids ------------------------------------------------------------------------- */
.um-body { display: block; }
.um-sections > * + * { margin-top: 12px; }
.um-grid { display: grid; gap: 12px; }
.um-kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px; }
@media (max-width: 1100px) { .um-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.um-two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 900px) { .um-two { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 620px) { .um-kpis { grid-template-columns: minmax(0, 1fr); } }
.um-card {
  min-width: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  padding: 14px 16px;
}
.um-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.um-card-titles { min-width: 0; }
.um-card-title { font-size: 13px; line-height: 20px; font-weight: 600; }
.um-card-sub { margin-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-card-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; }

/* KPI -------------------------------------------------------------------------------------- */
.um-kpi-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-kpi-value {
  display: flex; align-items: baseline; gap: 6px; margin-top: 4px;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 22px; line-height: 30px; font-weight: 600;
  letter-spacing: -0.01em; font-variant-numeric: tabular-nums;
}
.um-kpi-secondary { margin-top: 2px; font-size: 12px; line-height: 18px; }
.um-kpi-secondary[data-level='critical'] { color: var(--dsw-alias-state-error-primary); }
.um-kpi-secondary[data-level='warning'] { color: var(--dsw-alias-state-warn-primary); }
.um-kpi-secondary[data-level='normal'] { color: var(--dsw-alias-state-success-primary); }
.um-kpi-meta { margin-top: 4px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.um-cost { display: inline-flex; align-items: baseline; gap: 5px; font-variant-numeric: tabular-nums; }
.um-est {
  display: inline-block; padding: 0 3px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 3px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
  font-family: inherit; font-size: 10px; line-height: 13px; font-weight: 500;
  letter-spacing: 0.02em; cursor: help;
}

/* Alerts, connection strip ----------------------------------------------------------------- */
.um-alerts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.um-alert {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 8px 12px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.um-alert[data-level='warning'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-layer-1));
}
.um-alert[data-level='critical'] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1));
}
.um-alert-body { flex: 1; min-width: 0; }
.um-alert-title { font-size: 12.5px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-primary); }
.um-alert-detail { margin-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.um-alert-meta { flex: none; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.um-conn {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
  padding: 6px 10px; border-radius: 6px; font-size: 12px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-layer-1));
}
.um-conn-text { flex: 1; min-width: 0; }

/* Segmented range switch, tabs ------------------------------------------------------------- */
.um-seg { display: inline-flex; padding: 2px; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.um-seg-btn {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 18px; padding: 2px 8px; border-radius: 4px; cursor: pointer;
  font-variant-numeric: tabular-nums;
}
.um-seg-btn:hover { color: var(--dsw-alias-label-primary); }
.um-seg-btn[aria-pressed='true'] {
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1);
}
.um-tabs { display: inline-flex; flex-wrap: wrap; gap: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); padding: 2px; }
.um-tab {
  appearance: none; border: 0; background: transparent; color: var(--dsw-alias-label-secondary);
  font-size: 12px; line-height: 18px; padding: 2px 8px; border-radius: 4px; cursor: pointer; white-space: nowrap;
}
.um-tab:hover { color: var(--dsw-alias-label-primary); }
.um-tab[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1); }
.um-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }

/* Charts ----------------------------------------------------------------------------------- */
.um-chart { display: grid; grid-template-columns: 52px minmax(0, 1fr); grid-template-rows: auto auto; column-gap: 8px; }
.um-chart-y { grid-column: 1; grid-row: 1; display: flex; flex-direction: column; justify-content: space-between; height: 220px; padding: 8px 0 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; text-align: right; }
.um-chart-plot { grid-column: 2; grid-row: 1; position: relative; height: 220px; min-width: 0; }
.um-chart-svg { display: block; width: 100%; height: 220px; overflow: visible; }
.um-chart-x { grid-column: 2; grid-row: 2; display: flex; justify-content: space-between; margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 14px; font-variant-numeric: tabular-nums; }
.um-crosshair { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dsw-alias-border-l2); pointer-events: none; }
.um-marker {
  position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: var(--dsw-alias-brand-primary); border: 1.5px solid var(--dsw-alias-bg-layer-1);
  pointer-events: none;
}
.um-chart-tooltip {
  position: absolute; top: 4px; z-index: 5; pointer-events: none;
  min-width: 168px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 18px;
}
.um-chart-tooltip-time { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; margin-bottom: 4px; }
.um-chart-tooltip-row { display: flex; justify-content: space-between; gap: 16px; font-variant-numeric: tabular-nums; }
.um-chart-tooltip-label { color: var(--dsw-alias-label-secondary); }
.um-chart-tooltip-value { font-weight: 500; }
.um-legend { display: flex; align-items: center; gap: 14px; margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; flex-wrap: wrap; }
.um-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.um-legend-swatch { display: inline-block; width: 14px; height: 2px; border-radius: 1px; background: var(--dsw-alias-brand-primary); }
.um-legend-swatch[data-swatch='tokens'] { background: var(--dsw-alias-label-secondary); }
.um-legend-note { margin-left: auto; font-variant-numeric: tabular-nums; }

/* Cache / rate cards ----------------------------------------------------------------------- */
.um-cache-top, .um-rate-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.um-big { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 30px; line-height: 38px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.um-big-unit { margin-left: 6px; font-family: inherit; font-size: 13px; line-height: 18px; font-weight: 400; letter-spacing: 0; color: var(--dsw-alias-label-secondary); font-variant-numeric: normal; }
.um-cache-deltas { text-align: right; font-size: 12px; line-height: 18px; min-width: 0; }
.um-delta[data-level='normal'] { color: var(--dsw-alias-state-success-primary); }
.um-delta[data-level='warning'] { color: var(--dsw-alias-state-warn-primary); }
.um-cache-chart { margin-top: 10px; }
.um-mini-svg { display: block; width: 100%; height: 64px; }
.um-spark { margin-top: 10px; }
.um-spark-svg { display: block; width: 100%; height: 44px; }
.um-kv { display: flex; flex-direction: column; gap: 2px; margin: 10px 0 0; }
.um-kv-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; line-height: 18px; }
.um-kv dt { color: var(--dsw-alias-label-secondary); }
.um-kv dd { margin: 0; font-variant-numeric: tabular-nums; }
.um-cache-savings { display: flex; align-items: baseline; gap: 6px; margin-top: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

/* Rows (consumers, models) ----------------------------------------------------------------- */
.um-rows { list-style: none; margin: 0; padding: 0; }
.um-row { padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.um-row:first-child { border-top: 0; padding-top: 0; }
.um-row:last-child { padding-bottom: 0; }
.um-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.um-row-main { min-width: 0; display: flex; flex-direction: column; }
.um-row-title { font-size: 12.5px; line-height: 18px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.um-row-sub { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.um-row-cost { flex: none; font-size: 12.5px; line-height: 18px; font-variant-numeric: tabular-nums; }
.um-row-meta { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.um-bar { height: 4px; margin-top: 6px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.um-bar > i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); opacity: 0.65; }

/* Diagnosis ("why is usage high") ---------------------------------------------------------- */
.um-cause-list { display: flex; flex-direction: column; }
.um-cause { display: flex; gap: 8px; padding: 9px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.um-cause:first-child { border-top: 0; padding-top: 0; }
.um-cause .um-dot { margin-top: 7px; }
.um-cause-body { min-width: 0; flex: 1; }
.um-cause-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.um-cause-title { font-size: 12.5px; line-height: 18px; font-weight: 500; }
.um-cause-detail { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.um-chip {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; white-space: nowrap;
}
.um-chip-mono { font-variant-numeric: tabular-nums; }
.um-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.um-more-note { margin-top: 8px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }

/* Anomaly timeline ------------------------------------------------------------------------- */
.um-timeline { list-style: none; margin: 0; padding: 0; }
.um-timeline-row { display: grid; grid-template-columns: 64px 8px minmax(0, 1fr); align-items: start; gap: 8px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.um-timeline-row:first-child { border-top: 0; padding-top: 0; }
.um-timeline-row .um-dot { margin-top: 7px; }
.um-timeline-time { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 18px; font-variant-numeric: tabular-nums; }
.um-timeline-title { font-size: 12.5px; line-height: 18px; font-weight: 500; }
.um-timeline-detail { margin-top: 1px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.um-timeline-body .um-chip { margin-top: 5px; }

/* Forecast --------------------------------------------------------------------------------- */
.um-forecast { display: flex; align-items: flex-start; gap: 28px; flex-wrap: wrap; }
.um-forecast-item { min-width: 160px; }
.um-forecast-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-forecast-value {
  margin-top: 2px; font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 18px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.um-forecast-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-forecast-note { flex: 1; min-width: 200px; align-self: flex-end; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; text-align: right; }

/* Footer ----------------------------------------------------------------------------------- */
.um-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 18px; display: flex; flex-direction: column; gap: 3px; }
.um-footer-line { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.um-footer-label { color: var(--dsw-alias-label-primary); font-weight: 500; }
.um-footer-sep { opacity: 0.6; }
.um-footer-privacy { color: var(--dsw-alias-label-secondary); }
.um-footer-error { color: var(--dsw-alias-state-warn-primary); }
.um-footer-warnings { opacity: 0.9; }

/* Empty / error / skeleton ----------------------------------------------------------------- */
.um-empty-inline { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; padding: 12px 0; }
.um-empty-state { padding: 28px 20px; text-align: center; }
.um-empty-title { font-size: 14px; line-height: 22px; font-weight: 600; }
.um-empty-hint { margin-top: 4px !important; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 20px; }
.um-empty { padding: 10px 0 4px; }
.um-center-wrap { display: flex; justify-content: center; padding: 48px 0; }
.um-error-card { width: 100%; max-width: 460px; text-align: center; padding: 24px 20px; }
.um-error-title { font-size: 15px; line-height: 22px; font-weight: 600; }
.um-error-body { margin-top: 6px !important; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 20px; }
.um-error-detail { margin-top: 8px !important; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px; overflow-wrap: anywhere; opacity: 0.85; }
.um-error-card .um-btn { margin-top: 16px; }
.um-skel { border-radius: 4px; background: var(--dsw-alias-bg-layer-2); }
.um-skel-label { width: 40%; height: 10px; }
.um-skel-figure { width: 62%; height: 18px; margin-top: 8px; }
.um-skel-meta { width: 78%; height: 10px; margin-top: 8px; }
.um-skel-title { width: 24%; height: 12px; }
.um-skel-chart { width: 100%; height: 200px; margin-top: 12px; }

/* Settings drawer -------------------------------------------------------------------------- */
.um-drawer {
  flex: none; width: 344px; max-width: 44vw; height: 100%; overflow: auto;
  border-left: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  padding: 16px 16px 28px;
  scrollbar-width: thin;
}
@media (max-width: 860px) {
  .um-drawer {
    position: absolute; top: 0; right: 0; bottom: 0; z-index: 10;
    width: min(344px, 100%); max-width: none;
  }
}
.um-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.um-drawer-title { font-size: 14px; line-height: 22px; font-weight: 600; }
.um-drawer-note { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; margin-bottom: 4px !important; }
.um-drawer-form { display: block; }
.um-drawer-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l1); }
.um-drawer-section:first-of-type { border-top: 0; padding-top: 0; }
.um-drawer-section-title { font-size: 12px; line-height: 18px; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.um-field { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
.um-field-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.um-field-unit { color: var(--dsw-alias-label-secondary); opacity: 0.8; font-size: 11px; }
.um-input, .um-select {
  width: 100%; height: 30px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font-size: 12px; font-variant-numeric: tabular-nums;
}
.um-input[aria-invalid='true'] { border-color: var(--dsw-alias-state-error-primary); }
.um-select { appearance: auto; }
.um-field-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.um-field-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; }
.um-drawer-error {
  margin-top: 10px; padding: 8px 10px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere;
}
.um-drawer-actions { display: flex; gap: 8px; margin-top: 20px; }
.um-drawer-actions .um-btn { flex: 1; height: 32px; }

/* Tooltip ---------------------------------------------------------------------------------- */
.um-tip { position: relative; display: inline-flex; align-items: center; }
.um-tip-trigger { display: inline-flex; align-items: center; border-radius: 3px; }
.um-tip-bubble {
  position: absolute; z-index: 20; bottom: calc(100% + 6px); left: 50%;
  transform: translateX(-50%); width: max-content; max-width: 260px;
  padding: 6px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  font-size: 12px; line-height: 17px; font-weight: 400; text-align: left;
  white-space: normal; pointer-events: none;
  opacity: 0; visibility: hidden;
}
.um-tip:hover .um-tip-bubble, .um-tip:focus-within .um-tip-bubble { opacity: 1; visibility: visible; }
.um-tip .um-tip-bubble { transform: translateX(-50%); }
.um-tip:focus-within .um-tip-trigger { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

/* Scrollbars ------------------------------------------------------------------------------- */
.um-scroll::-webkit-scrollbar, .um-drawer::-webkit-scrollbar { width: 10px; height: 10px; }
.um-scroll::-webkit-scrollbar-thumb, .um-drawer::-webkit-scrollbar-thumb {
  border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent);
}
.um-scroll::-webkit-scrollbar-thumb:hover, .um-drawer::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent);
}
.um-scroll::-webkit-scrollbar-track, .um-drawer::-webkit-scrollbar-track { background: transparent; }
`;

    /* ---------------------------------------------------------------------------------------- *
     * Registration
     * ---------------------------------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'usage-monitor: dictionaries');
        const t = ctx.locale.bind(NS);

        // The global panel: sidebar row id `usage-monitor` opens this `main` keyed entry.
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'usage-monitor',
          locale: NS,
        }, UsageMonitorPage));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'usage-monitor',
          order: 20,
          locale: NS,
          label: () => t('nav'),
        }, UsageMonitorIcon));
      },
    };
  },
});
