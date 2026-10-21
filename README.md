# DeepSeek Harness Usage Monitor

**Real-time balance, token usage, cache hit rate and abnormal spend detection inside DeepSeek Harness.**

A DeepSeek Harness (DSH) plugin that adds a **Usage Monitor** panel to the Harness sidebar: the
real signed-in wallet balance, provider-reported token usage, cache hit rate, burn rate,
cost attribution, cache diagnostics, anomaly detection and a balance forecast — all computed
locally from official Harness data.

[![CI](https://github.com/Freeman945/deepseek-harness-usage-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Freeman945/deepseek-harness-usage-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

English | [简体中文](README.zh.md)

---

## Screenshots

![Usage Monitor dashboard — dark theme, Simplified Chinese UI](docs/screenshots/dashboard.png)

![Cache and request cards plus the anomaly timeline from the same dashboard](docs/screenshots/cache-anomaly.png)

Both images are real captures from a local DeepSeek Harness run with the plugin installed (dark
theme, Chinese UI; the UI is fully localized in English and Chinese). Wallet amounts are redacted;
no mock or demo data is shown. The second image stacks two regions of the same dashboard:
cache/request cards and the anomaly timeline.

---

## Features

| Feature | What it does |
|---|---|
| **Real balance monitoring** | Reads the signed-in DeepSeek account wallet through Harness's official account service. Recharge and bonus wallets are shown separately. No currency conversion, no invented balance. |
| **Token usage** | Provider-reported input, output, cache-read and cache-write tokens from durable Session logs, refreshed live while a Session runs. |
| **Burn rate** | Estimated spend per hour over the last 5 min / 30 min / 1 hour, compared with a **median active-workload baseline** built from 5-minute buckets that actually had requests; the 23-hour arithmetic mean is kept for context. |
| **Cost windows** | Today, last hour, last 24 hours, last 7 days and this month — each with an `Est.` (tokens × price table) and, where coverage exists, an `Observed` (real wallet decrease) number. |
| **Cache monitoring** | Cache hit rate with the same formula Harness uses, a deadband-aware delta vs the preceding 24-hour window, an absolute-health state, estimated **avoided extra input cost** (not a refund), and a per-bucket trend. |
| **Agent / session / model usage** | Top consumers by session, by task (conversation turn), by agent preset / subagent, by uncached token cost, plus a per-model breakdown. |
| **Evidence-gated anomaly detection** | Normal / Notice / Warning / Critical: high burn on its own is a Notice, Warning needs a real efficiency signal, and Critical requires high burn **and** corroborating evidence. Active-workload baselines, warm-up, a cache deadband, and a 24-hour timeline with "returned to normal" entries. |
| **Alerts** | Only warning/critical conditions become alerts with the time they started; notices stay informational. Balance-threshold alerts are configurable. |
| **Trends** | Usage charts for 1 h, 6 h, 24 h and 7 d with automatic bucket sizes. |
| **Forecast** | Estimated daily cost and estimated remaining balance time at the current burn rate, with the basis stated. |
| **Light / dark, English / Chinese** | Uses Harness theme tokens and the active Harness locale. |
| **Local only** | No telemetry, no upload, no third-party service, no runtime dependencies. |

> Harness already shows the current turn's usage in the chat view and the account balance under
> Settings → Account. This plugin turns that same official data into a persistent dashboard, adds
> historical windows and attribution, and explains *why* spend moved.

## Requirements

| Requirement | Detail |
|---|---|
| DeepSeek Harness | **0.2.1-rc.2** (desktop or web profile) |
| Plugin version | **0.1.1** |
| Node.js | **≥ 20** (DSH bundles its own Node; this matters only for development) |
| DeepSeek account | Signed in under **Settings → Account** for the real balance. Token and estimated-cost panels work without it. |
| API key | **Not needed.** The plugin never asks for, reads or stores one. |
| Environment variables | **None.** There is no `.env` to create. |
| Build step / dependencies | **None.** Plain Node.js ESM; zero runtime dependencies. |

## Installation

### Step by step

1. **Clone the repository** to a permanent location. The bundle is installed by folder path, so do
   not move or delete the folder afterwards.

   ```bash
   git clone https://github.com/Freeman945/deepseek-harness-usage-monitor.git
   ```

2. **Open the Harness Web GUI** and go to **Sidebar → Plugins**.

3. **Add the plugin:** choose **Add plugin**, paste the **absolute path** to the cloned folder,
   and confirm.

   ```text
   Windows:  C:\Users\<you>\deepseek-harness-usage-monitor
   macOS:    /Users/<you>/deepseek-harness-usage-monitor
   Linux:    /home/<you>/deepseek-harness-usage-monitor
   ```

4. Click **Install**, then **Enable now** (or enable *Usage Monitor* from the Plugins list).

5. Open **Usage** (用量) in the sidebar panel list — the **Usage Monitor** (用量监控) page opens in
   the main panel. If the entry is not visible yet, reload the Harness window once.

No API key and no configuration are required. If you are signed in to a DeepSeek account, the
balance appears on the next poll; token history is read from existing Session logs immediately.

### Alternative: let the Harness agent install it

Ask the Harness agent to install the bundle with the `plugin_manager` tool — `action:
install_bundle`, `target: <absolute path to the folder>`. Wait for the *enabled* confirmation, then
reload the window if the panel is not visible.

### Alternative: CLI

```bash
dsh plugin --profile <profile-name> add link:<absolute-path-to-folder>
```

Then enable the bundle in the Plugins page, or add `deepseek-harness-usage-monitor` to
`dsh.profile.bundles` in `$DSH_HOME/profiles/<profile-name>/package.json` and restart Harness.

### Uninstall / reset

Disable or remove the bundle in the Plugins page. Runtime data is stored outside the package in
`$DSH_HOME/usage-monitor/` (default `~/.dsh/usage-monitor/`); delete that folder to reset history,
settings and observed-spend coverage.

## Usage

Open the **Usage** entry in the left sidebar panel rail — the **Usage Monitor** page opens in the
main panel. It refreshes every 5 seconds while the page is visible; the wallet is polled no more
often than `balanceRefreshSeconds` (default 45 seconds, configurable 20–600).

| Number | Meaning | Honest caveat |
|---|---|---|
| **Balance** | The real wallet amount from your DeepSeek account, recharge and bonus wallets shown separately. | Requires being signed in. Never converted between CNY and USD. |
| **Burn rate** | Estimated spend per hour for the last 5 min / 30 min / 1 hour, and its ratio to the **median active-workload baseline** (with the 23-hour average ratio shown as context). | Estimated: tokens × official price table. High burn alone is not called abnormal. |
| **Cache hit rate** | `cacheRead / (cacheRead + input + cacheWrite)` for the last hour, plus a deadband-aware change vs the preceding 24-hour window and an absolute-health state. | Same formula as Harness's own usage display. Changes under 5 percentage points are noise. |
| **Cache avoided cost** | The estimated extra input cost the cache hits avoided (`Est.`): cached tokens priced at the cache-hit rate instead of the cache-miss rate. | Not a refund or a platform credit. It is a counterfactual estimate. |
| **`Est.` amounts** | Tokens × the official DeepSeek price table, peak/off-peak aware. | An estimate, **not** a provider invoice. |
| **`Observed` amounts** | Real money: the decrease of your wallet between balance polls, summed over the window. | Starts when monitoring starts; no historical backfill. Marked incomplete until the window is fully covered. |
| **Top consumers** | Sessions, tasks (turns), agent presets and uncached-token cost rankings. | Attribution comes from Session metadata, not a per-request agent name. |
| **Why is usage high?** | Separates workload evidence (request rate, context size) from efficiency evidence (cache drop, uncached burst, session dominance) and names the main driver. | Evidence, not a proven provider-side root cause. |
| **Forecast** | Estimated daily cost and estimated remaining balance time at the recent burn rate. | A projection from recent usage, not a guarantee. |

Use the **range switch** (1 h / 6 h / 24 h / 7 d) to change the trend chart, and the **gear** to
open Settings. **Refresh** forces one wallet read and one Session rescan without waiting for the
timers. The **timeline** lists anomalies newest-first, including "Usage returned to normal"
entries.

## Configuration

There is **no environment variable, no `.env` file and no API key** to create. The thresholds and
intervals you normally tune live in the dashboard's **Settings** drawer; they are validated,
clamped, persisted in `$DSH_HOME/usage-monitor/settings.json`, and take precedence over bundle
defaults. A few advanced fields — including the v0.1.1 anomaly-quality settings — are accepted by
the Host but have no drawer control yet and are set through the bundle row or the settings API (see
below). An existing `settings.json` from v0.1.0 loads unchanged; the new keys simply inherit their
defaults.

### In the Settings drawer

| Setting | Default | Range / notes |
|---|---|---|
| `currency` | `auto` | `auto` follows the signed-in wallet; `CNY` / `USD` force the price table. No conversion. |
| `balanceRefreshSeconds` | `45` | 20–600. Minimum interval between wallet reads. |
| `warningBurnRatio` | `2` | Burn rate ≥ this multiple of the **active-workload baseline** → Warning (Notice without secondary evidence). |
| `criticalBurnRatio` | `4.5` | Burn rate ≥ this multiple → Critical **only with** corroborating evidence, otherwise Notice. Raised to the warning value if set lower. |
| `cacheWarningRate` | `0.5` | Absolute cache hit rate below this → warning-level cache health (must hold for `cacheAlertMinutes`). |
| `cacheCriticalRate` | `0.3` | Absolute cache hit rate below this → critical-level cache health. Lowered to the warning value if set higher. |
| `cacheAlertMinutes` | `10` | 1–240. Sustained minutes before a low-cache alert fires. |
| `requestRateWarningMultiplier` | `2` | Request rate (last 15 min) ≥ this multiple of the active requests/min baseline → workload Notice. |
| `costSpike10m` | `5` | Display-currency amount spent in 10 minutes that counts as a spike. |
| `balanceAlerts` | `[50, 20, 10]` | Display-currency thresholds; the first breached one fires, the lowest breached one is critical. |
| `retentionDays` | `14` | 1–30. Request rows and wallet samples older than this are pruned. |

### Advanced settings (bundle row or settings API)

These fields are validated by the same allow-list but are not in the drawer yet. Set them in the
bundle row `config` (they seed defaults until a `settings.json` exists — delete that file to re-seed)
or POST them to `/api/usage-monitor/settings` from the signed-in Harness page.

| Setting | Default | Range / notes |
|---|---|---|
| `scanIntervalSeconds` | `60` | 15–600. Full Session rescan interval (live events are still incremental). |
| `holidays` | `[]` | `YYYY-MM-DD` Chinese public holiday dates; they switch estimates to off-peak pricing. |
| `pricingOverrides` | `{}` | Per-model or per-tier `{cacheHit, cacheMiss, output}` prices per 1M tokens, in the display currency. |
| `exposeDiagnosticsFile` | `true` | Writes `$DSH_HOME/usage-monitor/status.json` (no prompts, no credentials) for support. Set `false` to disable. |
| `minimumActiveRequests` | `1` | 1–1000. Requests in a 5-minute bucket for it to count as active workload. |
| `minActiveBuckets` | `6` | 2–288. Active buckets required before the baseline is `ready`. |
| `baselineMinRequests` | `30` | 1–1,000,000. Requests in the 23-hour baseline window required for `ready`. |
| `baselineMinCoverageHours` | `1` | 0.25–24. Observed history needed for `ready`. |
| `cacheDeltaDeadband` | `0.05` | 0–0.5. Cache deltas smaller than this (5 percentage points by default) are neutral. |
| `cacheDeltaNotice` | `0.15` | 0.02–0.95; forced above the deadband. Deltas above this are warning-class. |
| `cacheHealthyRate` | `0.9` | 0–1; raised to `cacheWarningRate` if lower. Absolute hit rate treated as healthy. |
| `criticalRequiresSecondaryEvidence` | `true` | When `false`, high burn alone can be Critical (not recommended). |
| `uncachedBurstMultiplier` | `3` | 1.2–20. Uncached tokens per request vs the active baseline. |
| `uncachedBurstMinTokens` | `10000` | 0–1,000,000,000. Absolute floor before an uncached burst counts. |
| `sessionDominanceShare` | `0.7` | 0.3–1. One-session share of recent uncached tokens treated as dominance (corroborating only). |
| `contextGrowthMultiplier` | `1.8` | 1.1–10. Average prompt size vs the active baseline that counts as context growth. |

### Bundle-row defaults

The bundle inserts one Host row (`cordis.patch.yml`). Its `config` seeds defaults only until you
save settings in the page; after that the saved settings win.

```yaml
- insert:
    - id: usage-monitor
      name: deepseek-harness-usage-monitor
      config:
        balanceRefreshSeconds: 45   # wallet poll floor, seconds
        retentionDays: 14           # request/wallet sample retention
```

> If you need a configured holiday list on a machine that already saved settings, POST it to the
> settings API or delete `$DSH_HOME/usage-monitor/settings.json` and reinstall the row config.

## How anomaly detection works

The plugin does **not** use machine learning, EWMA or an opaque score. Every condition is a
deterministic rule over the retained samples; each has a stable ID so the timeline can remember
when it started and when it recovered. Baselines are transparent arithmetic means and medians over
fixed windows.

### Active-workload baseline

Request samples are bucketed per 5 minutes. The overall 24-hour arithmetic mean is retained for
display and context, but it is **not** the primary alert trigger: for a low-frequency user it is
dominated by idle hours, so a normal concentrated task can look dramatic against it.

The primary ratio compares the last hour with the **median active-workload baseline**:

```text
active bucket             = a 5-minute bucket with requests ≥ minimumActiveRequests (default 1)
activeBaseline.costPerHour = median(active bucket cost × 12)      over [now − 24h, now − 1h]
activeRatio               = burn(last1h).costPerHour / activeBaseline.costPerHour
overallRatio              = burn(last1h).costPerHour / baseline24h.costPerHour   (display context)
```

The same active buckets also supply median requests per minute, median uncached tokens per request
and median prompt tokens; those are the comparison points for workload and efficiency evidence.

**Warm-up.** The baseline is `ready` only when the 23-hour window contains at least
`minActiveBuckets` (6) active buckets, at least `baselineMinRequests` (30) requests and at least
`baselineMinCoverageHours` (1 hour) of observed history. Until then it is `warming`, a confidence
value (0..1) is exposed, burn severity stays Normal and burn-rate alerts are suppressed. The
dashboard shows "Learning baseline".

### Severity levels

| Level | Meaning | What it takes (defaults) |
|---|---|---|
| Normal | Nothing unusual. | Ratio within the baseline and no efficiency evidence. |
| Notice / Elevated | Usage is high for your normal active workload, but there is no evidence that spending is inefficient. | Burn ratio ≥ `warningBurnRatio` (2), or ≥ `criticalBurnRatio` (4.5), **without** secondary evidence. A heavy task alone lands here — it is never an alert. |
| Warning | A concrete condition or a likely efficiency problem. | At least one strong efficiency signal (cache drop below the healthy absolute rate, or an uncached-token burst), an absolute cache problem, or the 10-minute cost spike. |
| Critical | High burn **and** corroborating efficiency evidence. | Burn ratio ≥ `criticalBurnRatio` (4.5) **and** at least one strong efficiency signal. Setting `criticalRequiresSecondaryEvidence: false` lets high burn alone reach Critical (not recommended). |

### Secondary evidence

| Evidence | Kind | Rule (defaults) |
|---|---|---|
| `request-rate` | workload | requests/min over the last 15 minutes ≥ 2× the active requests/min baseline (and ≥ 1/min) |
| `context-growth` | workload | last-hour average prompt size ≥ 1.8× the active prompt baseline |
| `cache-drop` | efficiency | cache delta ≤ −5 percentage points **and** absolute hit rate < 90% |
| `uncached-burst` | efficiency | ≥ 10,000 uncached tokens in the last 30 minutes **and** ≥ 3× the active uncached tokens per request **and** absolute hit rate < 90% |
| `session-dominance` | corroborating only | one session ≥ 70% of recent uncached tokens; recorded only when another efficiency signal already exists, never as a standalone alert |

With `criticalRequiresSecondaryEvidence` enabled, `cache-drop` and `uncached-burst` are the two
signals that can escalate burn severity. `session-dominance` only helps explain an existing problem.

### Conditions in the timeline

| Condition | Exact rule (defaults) | Level |
|---|---|---|
| `burn-anomaly` | combined burn + efficiency condition, emitted only at Warning/Critical; the type is `cache-hit-drop`, `uncached-burst` or `burn-rate` depending on the evidence | warning / critical |
| `cache-low` | last-hour hit rate `< cacheWarningRate` (0.5) continuously for `cacheAlertMinutes` (10) → warning; `< cacheCriticalRate` (0.3) → critical | warning / critical |
| `cost-spike` | estimated cost of the last 10 minutes `> costSpike10m` (5 display-currency units) | warning |
| `balance-low` | wallet below a configured threshold (default 50 / 20 / 10); the lowest breached threshold is critical | warning / critical |
| `recovered` | a previously active condition has been inactive for ≥ 2 minutes | info |

Only **Warning** and **Critical** active conditions become alerts. A Notice changes the dashboard
status pill and the explanation, but it does not create an alert.

**Historical ledger.** The timeline also reconstructs 24 hours of 5-minute buckets from the stored
request rows, but only for evidence-backed events:

- `cache-hit-drop` — a bucket with ≥ 5 requests whose hit rate is below the 50% absolute warning
  rate, or fell ≥ 15 percentage points versus the 24-hour average while still below 90%;
- `request-spike` — a bucket with more than 4× the average request count and at least 8 requests
  (informational).

Per-bucket burn-rate reconstruction was removed in v0.1.1 because it was the main source of
false-positive timeline entries: one heavy task could paint many "anomaly" buckets. The live
assessment above already covers real burn anomalies. Consecutive buckets of the same type are
merged, and the newest 20 historical entries are shown.

**What it is not:** there is no seasonal adjustment, no holiday awareness for usage (only for
pricing), no absolute-token alarm, and every monetary rule is computed on the *estimated* cost,
not on the wallet. The wallet is used only by `balance-low` and by observed spend.

## Understanding burn-rate alerts

**High burn rate does not always mean abnormal usage.** A long tool-using turn, a large context, or
a batch of parallel subagents naturally costs more per hour than an idle session. v0.1.1 is designed
to label that work honestly instead of alarming on it.

*Illustrative:* a low-frequency user can be around 8.5× their overall 24-hour average while sitting
at about 0.6× their active-workload baseline — the first ratio is large because the average includes
idle hours, while the second says the current pace is normal for their actual work. The plugin alerts
on the active-workload comparison, not on the idle-inclusive average.

### How the decision is made

1. **Baseline gate.** If the active baseline is still warming (fresh install, or less than about an
   hour / 6 active 5-minute buckets / 30 requests of history), burn severity is Normal and
   burn-rate alerts are off. The dashboard shows "Learning baseline" with a confidence value.
2. **Compare active work.** The last hour's estimated cost per hour is divided by the median
   active-workload cost per hour. The 24-hour arithmetic mean is shown next to it for context only.
3. **Collect evidence.** Workload signals (request rate, context size) and efficiency signals
   (cache drop, uncached burst, and corroborating session dominance) are gathered from the same data.
4. **Grade.** High burn without evidence is a **Notice** (shown as elevated/high usage). Warning
   needs at least one strong efficiency signal or a concrete condition; **Critical needs high burn
   and strong evidence**.
5. **Alert.** Only Warning and Critical become alerts; a Notice stays informational in the status
   pill, the assessment and the timeline.

### What each level means for you

| Level | What to do |
|---|---|
| Normal | Nothing; usage is within the active-workload baseline. |
| Notice / Elevated | The work is heavy, not necessarily wasteful. Check "Top consumers" to see which session/turn is driving it; no action needed unless the cost itself surprises you. |
| Warning | Open "Why is usage high?" and the cache diagnostics. A cache drop or uncached-token burst explains the extra cost; the evidence is listed with the numbers behind it. |
| Critical | High burn and strong evidence agree. Treat it as a real efficiency problem: inspect the cache evidence, the affected session, and the toolset/system-prompt changes recorded there. |

Nothing here is a budget or a prediction: thresholds compare *estimated* cost, the baseline is your
own recent active history, and the wallet remains the only authoritative money value.

## Cache diagnostics

Cache hit rate is computed as:

```text
hitRate = cacheReadTokens / (cacheReadTokens + inputTokens + cacheWriteTokens)
```

The plugin inspects the Session events that Harness already records and reports only causes it can
back with recorded evidence (in the "Why is usage high?" panel):

| Check | Evidence it records | What it suggests |
|---|---|---|
| **Request-epoch change** | `request/header` events whose reason is `change`; count + timing | Tools, system prompt or model changed, so the cacheable prefix was rebuilt |
| **System-prompt hash change** | Distinct truncated SHA-256 hashes of system-message text in one Session | The prefix could not stay stable |
| **Toolset change** | Distinct tool-list sizes seen in request headers | Adding/removing tools invalidates the prefix after the change |
| **Model switch** | Distinct model ids in one Session | Provider caches are per model; the first request always misses |
| **Compaction break** | Count of `compaction/start` events | Compaction rewrites history; the first request after it cannot reuse the old prefix |
| **TTL gap** | Gaps > 30 min between usage samples, and the hit rate of the first samples after each gap | Provider cache likely expired during inactivity |
| **Timestamp / UUID in prefix** | Regex counts of ISO-like timestamps and UUIDs inside system-message text (counts only, never the text) | A per-request timestamp/UUID makes every prefix different |
| **Cache not reported** | Sessions where more samples report zero cache counters than reported ones | The model/provider may not support prefix caching |
| **Context growth** | Average prompt size in the last hour ≥ 1.8× the active-workload prompt baseline | Context growth does not break the prefix, but it makes every miss more expensive |
| **Hit-rate drop / correlation** | Last-hour hit rate vs the preceding 24-hour window, classified with the 5pp deadband and the 90% absolute-health floor; only a genuine drop becomes a diagnosis, and correlation with the active burn ratio is reported separately | Misses are a likely cost driver |

Causes are only evaluated for sessions with at least 5,000 uncached input tokens in the last hour
and a hit rate below the global 24-hour rate.

**What it cannot prove:** the plugin cannot see the provider's cache keys or hit/miss reasons.
A recorded header change may be caused by a Harness configuration change rather than by a bug;
a timestamp in the system prompt may be intentional; a TTL gap is inferred from request timing,
not reported by the provider. These are labeled as *possible* causes, not findings. The system
prompt itself is never stored — only a truncated hash and counts.

## How to interpret cache savings

The number on the cache card is labeled **Estimated avoided input cost**, not "savings" as money
back. It answers a counterfactual question: *if the cached prompt tokens had been billed at the
cache-miss rate, how much more would the same requests have cost?*

```text
avoided extra input cost = Σ over requests of cacheReadTokens × (cacheMissPrice − cacheHitPrice) / 1,000,000
                           over the last 24 hours
```

- It is computed per request with that request's model, timestamp (peak/off-peak) and configured
  price overrides, then summed.
- It is an estimate of **avoided extra cost** — not a refund, not a platform credit, not money
  added to your wallet, and not a discount you can spend.
- It can be large simply because a workload has large prompts and a good hit rate; by itself it
  does not mean anything is wrong or unusually good.

### The hit-rate delta is deadband-aware

The card also compares the last hour's hit rate with the preceding 24-hour window
(`[now − 24h, now − 1h]`). v0.1.1 classifies the difference instead of treating every move as a
problem:

| Absolute delta | Class (defaults) | Effect |
|---|---|---|
| < 5 percentage points (`cacheDeltaDeadband`) | neutral | Treated as noise. 99.7% → 99.0% is a 0.7pp move and stays healthy. |
| 5–15 percentage points | notice | Worth a look; only becomes a problem if the absolute hit rate is also low. |
| ≥ 15 percentage points (`cacheDeltaNotice`) | warning-class | Warning when the absolute hit rate is also below the healthy floor (`cacheHealthyRate`, 90%); above that floor it remains a notice. |

Absolute health uses fixed floors: below `cacheWarningRate` (50%) is warning-level, below
`cacheCriticalRate` (30%) is critical. The 90% healthy floor is what keeps a high-hit-rate cache
from being flagged by small relative drops. Low-traffic windows can produce
`deltaClass: "unknown"`; nothing is inferred from too few requests.

## Data & privacy

Everything is local. The full inventory is in [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md) and
the policy is in [`SECURITY.md`](SECURITY.md).

| Question | Answer |
|---|---|
| Where is the data? | `$DSH_HOME/usage-monitor/` (default `~/.dsh/usage-monitor/`): `state.json`, `settings.json`, and `status.json` (support snapshot, written by default). It is gitignored and never inside the package or the profile. |
| What is stored? | Aggregated token counters, wallet samples, Session titles/cwd/preset metadata, cache signal counts and anomaly-condition timestamps. **No prompt text, no completion text, no credentials.** |
| What leaves the machine? | Nothing except the official balance read performed by Harness's own `deepseekAccount` service against your signed-in DeepSeek account. The plugin makes no network request of its own, sends no telemetry and uploads nothing. |
| Does it read my API key or cookies? | No. The plugin never reads credentials; Harness's account service owns them and returns only parsed wallet amounts. |
| Are my prompts stored? | No. For cache diagnostics, a system message is reduced to a truncated SHA-256 hash plus UUID/timestamp counts. |
| How long is data kept? | `retentionDays`, default **14 days**, configurable 1–30; pruned every 10 minutes. Wallet history is downsampled after 720 samples. |
| What is `status.json`? | A small support snapshot without prompts or credentials; it is written by default and can be disabled with `exposeDiagnosticsFile: false` (advanced settings). Review it before sharing. |
| How do I delete everything? | Remove the bundle, then delete `$DSH_HOME/usage-monitor/`. |

The plugin is read-only with respect to Harness: it never appends to, rewrites or deletes Session
logs, and it registers only same-origin, authenticated dashboard routes.

## Development

Requirements: Node.js ≥ 20 and a DSH 0.2.1-rc.2 install for live testing. There is nothing to
install — no dependencies, no build step.

```bash
npm test                          # node --test test/*.test.js
npm run check                     # syntax, JSON, manifests, secrets, docs
npm run audit                     # secrets/PII: working tree + Git history
npm run verify:live               # requires a live install: cross-checks the status file,
                                  # state.json and the raw Session logs / Harness projection cache
```

CI runs the first three commands (the audit through `npm run audit`); `verify:live` needs a local
Harness install with the plugin running.

| Path | Responsibility |
|---|---|
| `index.js` | Host entry: `apply`, `inject`, route registration, index injection |
| `lib/monitor.js` | Engine: Session scanning, live events, wallet polling, HTTP, lifecycle |
| `lib/ingest.js` | Session-event folding: usage counters and cache signals |
| `lib/analytics.js` | Snapshot aggregation: windows, burn severity, active baseline, assessment, cache, anomalies, consumers, forecast |
| `lib/pricing.js` | Official price table, peak/off-peak rule, cost estimates |
| `lib/store.js` | Settings validation, atomic local state, retention |
| `client.js` | Browser half: sidebar entry, dashboard, settings drawer, i18n |
| `locale/` | English and Simplified Chinese display strings |
| `test/` | Node test runner tests and synthetic fixtures |
| `docs/` | API contract, architecture, data sources, UI notes, roadmap, screenshots |

**Install a development copy:** follow [Installation](#installation) but point at your working
clone; changes to Host files take effect on plugin reload, and `client.js` changes on window
reload. Delete `$DSH_HOME/usage-monitor/` to reset state while testing.

**Screenshots:** only real captures from a local Harness run are committed — never mockups. Run
the plugin, open the dashboard, capture the window, redact wallet amounts/session titles/paths, and
save as `docs/screenshots/dashboard.png` and `docs/screenshots/cache-anomaly.png`.

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md), [`docs/API.md`](docs/API.md),
[`docs/UI.md`](docs/UI.md), [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Known limitations

1. **Agent identity is derived, not recorded.** Session events do not contain a per-request agent
   name. Agent-preset and subagent attribution comes from Harness Session metadata (preset,
   subagent origin/parent session, cwd, session title).
2. **"Tasks" are conversation turns.** A task row means one turn of one Session, not a Harness
   job or background task.
3. **Observed spend has a start date.** It is measured from the plugin's first wallet poll; there
   is no historical balance backfill. Token history *is* read from existing Session logs.
4. **Peak/off-peak pricing does not know Chinese public holidays** unless you configure them as
   advanced settings (bundle row or settings API). Until then, holiday requests are estimated at the
   peak rate.
5. **Search / Fetch billing is not included.** Those calls are free until 2026-11-01 Beijing time
   and are not modeled by the plugin. Model token costs are the only costs estimated.
6. **API-key-only setups have no balance.** Without a signed-in DeepSeek account the wallet can't
   be read; token and estimated-cost panels still work.
7. **Estimates are not a bill.** There is no Harness-side cost calculator and no provider
   billing-history API; per-session/model amounts are token counts × the published price table.
8. **The active-workload baseline needs warm-up.** Burn-rate alerts stay off until the previous
   23 hours contain about an hour of observed history, at least `minActiveBuckets` (6) active
   5-minute buckets and `baselineMinRequests` (30) requests. A fresh install shows "Learning
   baseline" instead of guessing.
9. **Cache-delta classification needs a ready baseline** (and enough recent cache requests). The
   deadband and absolute-health floor prevent small drops from alerting, but a low-traffic window
   can leave the delta `unknown` rather than inventing a classification.
10. **Session dominance is corroborating only.** A single large task legitimately dominates one
    session, so session share never creates an alert by itself; it is shown only to explain an
    efficiency signal found elsewhere.

## Roadmap

- More provider adapters for the pricing layer.
- Budget policies and notifications through Harness-native surfaces.
- Usage report export (CSV / JSON), local only.
- Deeper cache diagnostics (better root-cause evidence, still without storing prompts).
- Historical balance coverage research.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for detail and non-goals.

## Contributing

Issues and pull requests are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`SECURITY.md`](SECURITY.md) first. In short: no runtime dependencies, no secrets or private data,
every claim must match code and documented Harness behavior, and both English and Chinese UI
strings must be updated together.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Freeman945.

This plugin is built for **DeepSeek Harness**, which is also MIT-licensed
(Copyright (c) 2026 DeepSeek): <https://github.com/deepseek-ai/deepseek-harness>. DeepSeek and
DeepSeek Harness are trademarks of their respective owners; this project is an independent plugin
and is not affiliated with or endorsed by DeepSeek.
