# Usage Monitor — Host ↔ Client API contract (v1)

The Host plugin serves JSON to its own browser half. Every route is same-origin and
requires the authenticated Harness browser session (checked with
`ctx.connection.requestRejection`); no API keys or tokens ever appear in payloads.

Routes:

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/usage-monitor/snapshot?range=1h\|6h\|24h\|7d` | — | `Snapshot` |
| `POST` | `/api/usage-monitor/settings` | `Partial<Settings>` | `Snapshot` |
| `POST` | `/api/usage-monitor/refresh` | — | `Snapshot` (forces a balance read and a session rescan) |
| `GET` | `/api/usage-monitor/health` | — | `{ ok, version, uptimeMs }` (unauthenticated, non-sensitive) |

All responses use `cache-control: no-store`. Error responses are
`{ error: { code, message } }` with a non-200 status.

> Terminology
> - **Cache hit rate** = `cacheReadTokens / (cacheReadTokens + uncachedInputTokens + cacheWriteTokens)`.
>   `cacheReadTokens` is the provider's `cache_read_input_tokens`; `uncachedInputTokens` is the
>   provider's `input_tokens` (prompt tokens billed at the cache-miss rate). This matches how
>   Harness itself renders the cache-hit percentage.
> - **Estimated cost** always means token counts × the pricing table (official DeepSeek prices,
>   configurable). It is never presented as a real bill.
> - **Observed spend** means the decrease of the signed-in account's wallet balance between two
>   balance polls. It is real money movement, but only available since monitoring started.

## Snapshot

```ts
interface Snapshot {
  schemaVersion: 1
  generatedAt: number                 // epoch ms
  status: 'normal' | 'warning' | 'critical'
  locale: string                      // Harness UI locale ('en', 'zh', ...)

  currency: string | null             // display currency for estimates; from the wallet or settings
  balance: BalanceBlock
  cost: CostBlock
  burn: BurnBlock
  cache: CacheBlock
  series: SeriesBlock
  models: ModelRow[]
  consumers: Consumers
  anomalies: Anomaly[]
  forecast: Forecast
  alerts: Alert[]
  settings: Settings
  diagnostics: Diagnostics
}

interface BalanceBlock {
  state: 'ready' | 'signed-out' | 'unavailable' | 'error'
  wallets: Wallet[]                   // recharge wallets, in API order
  bonusWallets: Wallet[]              // granted/bonus wallets, separate
  primary: { currency: string; amount: number } | null  // first non-zero recharge wallet
  totalAll: number | null             // sum of the primary currency's recharge + bonus wallets
  fetchedAt: number | null
  error: string | null
  observedSince: number | null        // first successful balance observation (monitoring start)
}

interface Wallet { currency: string; balance: string }  // API strings preserved, never converted

interface CostBlock {
  currency: string | null
  pricing: {
    source: string                    // official pricing page URL
    asOf: string                      // ISO date the table was captured
    note: string
  }
  coverageStart: number | null        // = balance.observedSince
  windows: {
    lastHour: CostWindow
    today: CostWindow
    last24h: CostWindow
    last7d: CostWindow
    month: CostWindow
  }
}

interface CostWindow {
  estimated: number | null            // full-window token-based estimate
  observed: number | null             // real wallet decrease in the window (null until covered)
  observedComplete: boolean           // true only if monitoring covered the whole window
  tokens: number
  requests: number
}

interface BurnBlock {
  last5m: Rate
  last30m: Rate
  last1h: Rate
  baseline24h: Rate                   // average over the 24h before now
  ratio: number | null                // last1h.costPerHour / baseline24h.costPerHour
  ratioBasis: 'estimated' | 'observed'
  level: 'normal' | 'warning' | 'critical'
}

interface Rate {
  cost: number | null
  costPerHour: number | null
  tokensPerMin: number
  requestsPerMin: number
  basis: 'estimated' | 'observed'
}

interface CacheBlock {
  last1h: CacheWindow
  last24h: CacheWindow
  baseline: CacheWindow               // previous 24h (before the current hour)
  hitRate: number | null              // last1h.hitRate (the headline number)
  deltaVsBaseline: number | null      // hitRate - baseline.hitRate
  savings: { amount: number | null; currency: string | null; note: string }
  trend: CachePoint[]                 // bucket series matching `series.bucketMs`
  diagnosis: CacheDiagnosis[]
}

interface CacheWindow {
  hitTokens: number                   // = cached input tokens
  missTokens: number                  // = uncached input tokens
  writeTokens: number
  hitRate: number | null
  requests: number
}

interface CachePoint {
  t: number
  hitRate: number | null
  hitTokens: number
  missTokens: number
  requests: number
}

interface CacheDiagnosis {
  code:
    | 'cache-hit-drop' | 'cache-low' | 'uncached-burst' | 'cache-problem-correlated'
    | 'system-prompt-changing' | 'request-epoch-change' | 'toolset-change'
    | 'model-switch' | 'compaction-cache-break' | 'ttl-gap'
    | 'uuid-or-timestamp-in-prefix' | 'cache-not-reported' | 'context-growth'
  severity: 'info' | 'warning' | 'critical'
  title: string                       // short, data-specific
  detail: string
  sessionId?: string
  sessionTitle?: string
  evidence: Record<string, string | number | boolean | null>
}

interface SeriesBlock {
  range: '1h' | '6h' | '24h' | '7d'
  bucketMs: number
  from: number
  to: number
  points: SeriesPoint[]
}

interface SeriesPoint {
  t: number
  cost: number | null                 // estimated cost in `currency`
  tokens: number
  uncachedInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  requests: number
  hitRate: number | null
}

interface ModelRow {
  model: string
  provider: string | null
  priced: boolean                     // false => token data only, no cost estimate
  requests: number
  inputTokens: number                 // uncached input
  outputTokens: number
  cachedTokens: number
  uncachedTokens: number              // = inputTokens
  hitRate: number | null
  cost: number | null                 // estimated
  costShare: number                   // 0..1 of total estimated cost in window
  avgCostPerRequest: number | null
}

interface Consumers {
  window: '24h' | '7d'
  sessions: ConsumerRow[]             // sorted by cost desc
  presets: ConsumerRow[]              // agent preset / subagent role
  tasks: ConsumerRow[]                // Session turn, sorted by cost desc
  uncached: ConsumerRow[]             // sorted by uncached token cost desc
}

interface ConsumerRow {
  key: string                         // session id | preset name | task key
  label: string                       // session title / preset / "title · Turn N"
  sublabel?: string                   // cwd, origin, model
  sessionId?: string
  turn?: number
  requests: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  uncachedTokens: number
  hitRate: number | null
  cost: number | null                 // estimated
  costShare: number
}

interface Anomaly {
  id: string
  t: number
  level: 'info' | 'warning' | 'critical'
  type:
    | 'burn-rate' | 'cache-hit-drop' | 'cache-low' | 'uncached-burst' | 'request-spike'
    | 'input-growth' | 'expensive-model-share' | 'cost-spike' | 'session-dominance'
    | 'balance-low' | 'recovered'
  title: string
  detail: string
  sessionId?: string
  turn?: number
  evidence: Record<string, string | number | boolean | null>
}

interface Forecast {
  dailyCost: number | null            // at current burn (last 1h) annualized to a day
  dailyCostBaseline: number | null    // at 24h average
  daysRemaining: number | null
  remainingTimeText: string | null    // "2 days 13 hours" style, localized by the Client
  basis: 'last1h' | 'last24h' | 'none'
  note: string                        // "Estimate based on recent usage"
}

interface Alert {
  id: string
  level: 'warning' | 'critical'
  type: 'balance-low' | 'burn-rate' | 'cache-low' | 'cost-spike' | 'uncached-burst'
  title: string
  detail: string
  Since?: never
  since: number                       // first time the condition held
  evidence: Record<string, string | number | boolean | null>
}

interface Diagnostics {
  sources: {
    balance: { kind: 'deepseek-account-platform'; state: string }
    tokens: { kind: 'session-events'; sessionsScanned: number; liveSessions: number; requests: number }
    pricing: { kind: 'official-table'; currency: string | null; source: string; asOf: string }
    cost: { kind: 'estimated+observed'; observedStart: number | null }
  }
  scan: { startedAt: number | null; finishedAt: number | null; inProgress: boolean; sessions: number; errors: number }
  data: {
    firstEventAt: number | null
    lastEventAt: number | null
    retentionDays: number
    requestsInRetention: number
    balanceSamples: number
    gaps: string[]                    // human-readable data-quality warnings
  }
  warnings: string[]
}

interface Settings {
  currency: 'auto' | 'CNY' | 'USD'
  balanceRefreshSeconds: number       // clamped 20..600
  warningBurnRatio: number            // default 2
  criticalBurnRatio: number           // default 4.5
  cacheWarningRate: number            // 0..1, default 0.5
  cacheCriticalRate: number           // 0..1, default 0.3
  cacheAlertMinutes: number           // default 10
  requestRateWarningMultiplier: number// default 2
  costSpike10m: number                // display currency, default 5
  balanceAlerts: number[]             // default [50, 20, 10]
  pricingOverrides: Record<string, { cacheHit: number; cacheMiss: number; output: number }>
                                      // per 1M tokens, display currency; {} = official defaults
  holidays: string[]                  // 'YYYY-MM-DD' China public holidays for peak pricing
  retentionDays: number               // 1..30
  scanIntervalSeconds: number         // full rescan interval, default 60
  exposeDiagnosticsFile: boolean      // write $DSH_HOME/usage-monitor/status.json for support
}
```

Empty states are data, not errors:

- No session logs yet → `diagnostics.data.requestsInRetention === 0`, all token blocks zero,
  `cache.hitRate === null`, series points all zero.
- Signed out → `balance.state === 'signed-out'`, `balance.primary === null`, observed spend
  `null`, estimates still work when `currency` is configured.
- Balance API failure → `balance.state === 'error'` with `error` string; previous snapshots
  keep `observedSince` and spend history.
- Unknown model → `priced: false`, `cost: null`; it still appears in model rows and token
  totals.

## Settings write

`POST /api/usage-monitor/settings` accepts any subset of `Settings`; the Host validates,
clamps, persists, recomputes, and returns the full new `Snapshot`. Unknown keys are ignored.
Invalid values are clamped and reported under `diagnostics.warnings` in the returned snapshot
(the Client shows them as an inline "Host adjusted…" note); a malformed body returns
`400 { error: { code: 'invalid-settings', message } }`.

## Client registration contract

- Sidebar entry: `sidebar.panellist` with `id: 'usage-monitor'`, order `20`, label from locale.
- Page: `main` with `key: 'usage-monitor'`.
- Settings surface: only the in-page settings drawer in v0.1.0; the plugin does **not** register a
  separate `settings.section` page (advanced options remain available through the plugin row
  config and the settings API).
- UI text comes from the plugin's own locale dictionaries (`ctx.locale.register`), with
  English and Simplified Chinese. Numbers/dates use `Intl` and the active Harness locale.
- Styling uses only Harness theme tokens `--dsw-alias-*`; no gradients, no glow, no emoji
  decoration. Charts are hand-written SVG (no chart dependency).
