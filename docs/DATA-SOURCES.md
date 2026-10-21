# Data sources and metric definitions

Every number the Usage Monitor shows has exactly one source. This document lists that source,
the formula used to derive the number, and whether the number is **observed**, **estimated**,
or **derived**. Nothing here is guessed by a model; the plugin contains no heuristics that
invent data.

Verified against **DeepSeek Harness 0.2.1-rc.2** and **plugin 0.1.0**.
See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how these sources are wired into the Host plugin.

## Three kinds of numbers

| Label | Meaning | Where it comes from |
|---|---|---|
| **Observed** | Real money or real provider counters. | Provider-reported `TokenUsage` in Session events; the signed-in DeepSeek account wallet. |
| **Estimated** (`Est.`) | Tokens × the official DeepSeek price table. | `lib/pricing.js`, shown with the `Est.` prefix in the UI. Never presented as a bill. |
| **Derived** | Arithmetic over observed/estimated values (rates, ratios, shares, forecasts). | `lib/analytics.js`; the formula is stated below. |

> There is **no Harness-side cost calculator and no billing-history API**. The plugin cannot
> query "what did DeepSeek charge me last month". Estimated spend is the only way to attribute
> cost to a session, model, agent preset or turn, and it is labeled as such everywhere.

## 1. Token usage — observed

**Source:** durable Session events read through `ctx.sessionPersistence`
(`list()` → `open(id, 'read')` → `read()`), plus the live `session/event` feed for sessions that
are currently running.

| Field | Source event | Notes |
|---|---|---|
| `inputTokens` | `assistant/message` / `assistant/attempt` → `TokenUsage.inputTokens` | Prompt tokens billed at the **cache-miss** rate. This is the plugin's `uncachedInputTokens`. |
| `outputTokens` | same → `TokenUsage.outputTokens` | Completion tokens. |
| `cacheReadTokens` | same → `TokenUsage.cacheReadTokens` | Prompt tokens served from the provider's prefix cache. |
| `cacheWriteTokens` | same → `TokenUsage.cacheWriteTokens` | Cache-write tokens; DeepSeek has no separate cache-write price, so they are billed at the miss rate (see §3). |
| Settlement time | `event.time` | Used as the request timestamp for every window and trend bucket. |
| Model | `event.data.message.source.model` | Used for pricing and the model breakdown. |
| Provider | `event.data.message.source.provider` | Shown in the model table only. |
| Turn | `event.data.turn` | Defines a "task" (see §8). |
| Session id | `SessionHeader.id` | Primary attribution key. |
| Session title | `session/title` event | Display label; never the prompt text. |
| Agent preset | `SessionHeader.agentPreset` | Display label; see §8 for why this is not a per-request agent name. |

Where the usage lives exactly:

- `assistant/message` — the committed assistant settlement. Usage is in `data.usage`; when the
  event is an interrupted settlement it may only appear as a `usage` chunk inside `data.stream`.
- `assistant/attempt` — a failed or retried attempt that never committed a message. Usage is
  inside the last `usage` chunk of `data.stream`.

**Retry de-duplication.** A retried request first logs `llm/retry-started`, then the replacement
attempt settles for the same `(turn, step)` slot. The plugin mirrors Harness's own `tokenUsage`
projection: the replacement sample replaces the previous one for that slot instead of being
counted twice, and an identical duplicate sample is ignored.

## 2. Cache hit rate — derived

**Source:** the four counters above.

```text
cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens + cacheWriteTokens)
```

- `inputTokens` is the uncached prompt (cache-miss) volume, `cacheWriteTokens` is included in the
  denominator exactly as Harness's own UI does.
- Harness renders the same number as `cacheReadTokens / (totalTokens − outputTokens)`, which is
  algebraically identical because `totalTokens = input + output + cacheRead + cacheWrite`.
- Windows used by the dashboard: `last1h` (headline number), `last24h`, and `baseline` — the
  preceding 24-hour window **excluding the current hour** (`[now − 24h, now − 1h]`), so the
  comparison is not diluted by the hour being judged.
- `null` (shown as `—`) when the denominator is zero, e.g. a model that does not report caching.

## 3. Estimated cost — estimated

**Source:** the official DeepSeek API price page, captured **2026-10-21**:
<https://api-docs.deepseek.com/quick_start/pricing/> (English, USD) and
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/> (Chinese, CNY).
The frozen table lives in [`lib/pricing.js`](../lib/pricing.js); it is never fetched at runtime.

Prices below are **per 1,000,000 tokens**. Peak is the official list price; off-peak is exactly
half of it.

### CNY

| Model | Input (cache hit) off-peak / peak | Input (cache miss) off-peak / peak | Output off-peak / peak |
|---|---|---|---|
| `deepseek-flash` (and legacy `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-chat`) | ¥0.02 / ¥0.04 | ¥1 / ¥2 | ¥4 / ¥8 |
| `deepseek-v4-pro` (and `deepseek-reasoner`) | ¥0.15 / ¥0.30 | ¥4.5 / ¥9.0 | ¥13.5 / ¥27.0 |

### USD

| Model | Input (cache hit) off-peak / peak | Input (cache miss) off-peak / peak | Output off-peak / peak |
|---|---|---|---|
| `deepseek-flash` (and legacy ids) | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` (and `deepseek-reasoner`) | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

**Estimated cost of one request:**

```text
cost = (cacheReadTokens × cacheHitPrice
      + (inputTokens + cacheWriteTokens) × cacheMissPrice
      + outputTokens × outputPrice) / 1,000,000
```

- `cacheWriteTokens` are billed at the **cache-miss** rate because the official table has no
  separate cache-write price.
- Unknown model ids are not priced. They still appear in token totals and model rows with
  `priced: false`, `cost: null`, and a warning in Diagnostics. No price is invented.
- Per-model or per-tier price overrides can be set as an advanced setting (`pricingOverrides`); overrides
  win over the table and are still labeled `Est.`.

**Peak / off-peak rule** (from the same page):

```text
peak = Monday–Friday, Beijing time 09:00–12:00 or 14:00–18:00,
       excluding Chinese public holidays
off-peak = every other hour, all weekend, and configured holidays
```

- Times are evaluated in `Asia/Shanghai` for each request's settlement time.
- Chinese public holidays change every year, so the plugin cannot know them. Set the `holidays`
  advanced setting (bundle row `config` or the settings API, `YYYY-MM-DD` dates). Until then,
  holiday requests are estimated at the peak rate, and Diagnostics says so.

**Cache savings (last 24 h):**

```text
savings = Σ over requests of cacheReadTokens × (cacheMissPrice − cacheHitPrice) / 1,000,000
```

This is the money the cache hits avoided relative to paying the miss price for the same tokens.

## 4. Wallet balance — observed

**Source:** `ctx.deepseekAccount.getBalance(clientMetadata)` — the official Harness account
service. The backing HTTP request is `GET /api/v0/users/get_user_summary` on the DeepSeek
Platform origin of the signed-in account, issued by
`@deepseek-ai/dsh-deepseek-account-platform`. The plugin never calls that endpoint itself and
never sees the credential.

| Field | Meaning |
|---|---|
| `wallets` | Recharge wallets, in API order. Decimal strings preserved exactly (`"82.41"`). |
| `bonusWallets` | Granted/bonus wallets, kept separate. |
| `primary` | First non-zero recharge wallet, or the wallet matching the configured currency. |
| `totalAll` | Sum of recharge + bonus wallets **in the primary wallet's currency only**. |
| `state` | `ready`, `signed-out`, `unavailable` (account service not mounted), `error`. |

- **No currency conversion ever happens.** CNY and USD are separate wallet currencies with
  separate price tables. When the wallet currency is unknown, estimates use USD, the official
  API pricing currency.
- Balance is polled at most once per `balanceRefreshSeconds` (default 45 s, clamped 20–600 s).
  A dashboard refresh never triggers a per-refresh balance call; only the explicit Refresh
  button forces one.
- Signed out, or an API-key-only Harness setup without a Platform account: `state` is
  `signed-out`/`unavailable`, balance is `null`, and observed spend is unavailable. Estimated
  costs still work.

## 5. Observed spend — observed

**Source:** the balance samples recorded above (in `$DSH_HOME/usage-monitor/state.json`).

```text
observedSpend(window) = Σ max(0, previousSampleTotal − nextSampleTotal)
                        for consecutive samples whose midpoint falls inside the window
```

- Only **decreases** count. A top-up (increase) is ignored, not treated as negative spend.
- Coverage starts when the plugin first polls the wallet after install. There is no historical
  balance backfill: `observedComplete` is `true` only when the window start was covered by
  samples with no gap longer than `max(3 × balanceRefreshSeconds, 3 min)` and the newest sample
  is fresh. Otherwise `observed` may be `null` or a partial number and the UI marks it as
  incomplete.
- Because `totalAll` includes granted (bonus) wallets, spend paid from bonus balance is still
  observed. Wallets in a non-primary currency are not counted.
- Balance history is trimmed to `retentionDays` and downsampled after 720 samples (full
  resolution for the last 2 hours, 10-minute resolution before that).

## 6. Burn rate — derived

**Source:** estimated cost bucketed per minute over the retained request rows.

```text
burn(window).costPerHour = estimated cost in window / window hours
windows: last5m, last30m, last1h
baseline24h.costPerHour = estimated cost in [now − 24h, now − 1h] / 23
burnRatio = burn(last1h).costPerHour / baseline24h.costPerHour
```

- The baseline deliberately excludes the current hour, so the ratio answers "how much hotter is
  the current hour than the previous 23 hours?".
- `ratioBasis` is `estimated`: burn rate is never derived from wallet samples.
- Level: `warning` when `ratio ≥ warningBurnRatio` (default 2), `critical` when
  `ratio ≥ criticalBurnRatio` (default 4.5).

## 7. Forecast — derived

```text
dailyCost = burn(last1h).costPerHour × 24          (falls back to baseline24h when the last hour is empty)
daysRemaining = walletAmount / dailyCost           (null when no wallet or zero cost)
```

The UI labels this "Estimate based on recent usage". It is not a promise: a single expensive
turn changes it immediately.

## 8. Attribution — derived from Session metadata

Session events **do not record a per-request agent name**, so the plugin cannot attribute a
request to an "agent" the way a billing system would. It attributes by the metadata Harness does
record:

| Breakdown | Key | Source | Limitation |
|---|---|---|---|
| Session | `SessionHeader.id` | persistence | Exact. |
| Task (turn) | `sessionId#turn` | `event.data.turn` | A "task" is a conversation **turn**, not a Harness task/job. |
| Agent preset | `SessionHeader.agentPreset` | persistence | The preset the session runs; subagent sessions are prefixed `subagent:`. It is not a per-request identity. |
| Uncached tokens | `SessionHeader.id` | `inputTokens` | Sorted by the money caused by cache-miss input (`missCost`), not by total cost. |
| Model | `event.data.message.source.model` | assistant settlement | Unknown models are shown, unpriced. |

## 9. Trend series — derived

| Range | Window | Bucket size | Max points returned |
|---|---|---|---|
| `1h` | rolling 60 min | 1 min | 240 |
| `6h` | rolling 6 h | 5 min | 240 |
| `24h` | rolling 24 h | 15 min | 240 |
| `7d` | rolling 7 days | 1 h | 240 |

Each point carries estimated cost, token counters, request count and hit rate for that bucket.
Points outside the retained request rows are zero-filled, not interpolated.

## 10. Anomalies, alerts and cache diagnostics

These are all **derived** from the sources above; the exact rules and thresholds are documented
in the main README ([How anomaly detection works](../README.md#how-anomaly-detection-works) and
[Cache diagnostics](../README.md#cache-diagnostics)) and in
[`lib/analytics.js`](../lib/analytics.js). The only additional persistent state is
`anomalyMemory`: the first time a condition was seen, so the timeline can show "since" and
"recovered" entries. It contains condition keys and timestamps, never prompt text.

## 11. What does not exist (and is therefore not shown)

| Missing capability | Consequence in v0.1.0 |
|---|---|
| Harness-side cost calculator | Cost is always `tokens × table`, labeled `Est.`. |
| Provider billing-history API | No historical invoice view and no exact per-request charge. |
| Per-request agent name in Session events | Agent attribution is derived from preset/subagent metadata (see §8). |
| Balance history before install | Observed spend starts at the first wallet poll; no backfill. |
| Chinese public holiday calendar | Peak pricing ignores holidays until they are configured as an advanced setting. |
| Search/Fetch per-request billing | Not included. They are free until 2026-11-01 Beijing time; the plugin does not model them. |
| Reliable cache internals from the provider | Cache diagnostics report correlated evidence, never a proven root cause (see README). |

## 12. Storage and retention

| Data | Location | Retention |
|---|---|---|
| Aggregated request rows (token counters, timestamps, model, turn, no prompts) | `$DSH_HOME/usage-monitor/state.json` | `retentionDays`, default 14, clamp 1–30; pruned every 10 min |
| Session metadata (id, title, cwd, agent preset, subagent origin/parent, cache signal counts) | same file, `sessions` | same retention |
| Wallet samples | same file, `balance.history` | same retention; downsampled after 720 samples |
| Settings | `$DSH_HOME/usage-monitor/settings.json` | until changed or manually deleted |
| Support status snapshot | `$DSH_HOME/usage-monitor/status.json` | overwritten every 30 s while `exposeDiagnosticsFile` is enabled |
| System prompt | never stored | a truncated SHA-256 hash and UUID/timestamp counts only |
| Prompt/completion text | never stored or read into state | — |

`$DSH_HOME` defaults to `~/.dsh`. The plugin never writes into Session logs, the profile, or the
plugin package directory.
