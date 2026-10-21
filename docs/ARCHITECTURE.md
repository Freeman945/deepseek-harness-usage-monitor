# Architecture

This document explains how the Usage Monitor plugin fits into DeepSeek Harness (DSH), which
official Host services it uses, and how a dashboard number travels from a Session log to the
browser. It is written against **DeepSeek Harness 0.2.1-rc.2** and **plugin 0.1.1**.

For the exact metric sources and formulas see [`DATA-SOURCES.md`](DATA-SOURCES.md). For the
Host ↔ Client JSON contract see [`API.md`](API.md).

## 1. Where a DSH plugin lives

DSH is a Cordis application. A profile is an ordered stack of patch layers:

1. the profile's `dsh.profile.bundles` in `$DSH_HOME/profiles/<profile>/package.json`;
2. the user's `cordis.patch.yml` in the same directory;
3. optional `--patch` overlays.

Each bundle contributes a loader patch. This plugin ships exactly one bundle with two halves:

```text
deepseek-harness-usage-monitor/
├── package.json          declares dsh.bundle.patch + dsh.client
├── cordis.patch.yml      inserts the Host row (id: usage-monitor)
├── index.js              Host half entry: export function apply(ctx, config)
├── lib/                  Host half: ingest, analytics, pricing, store, engine
├── client.js             Client half: browser bundle (no build step)
├── locale/               en.json / zh.json display dictionaries
└── icon.svg              sidebar icon
```

The Host half is a normal Cordis plugin: it exports `apply(ctx, config)` and
`export const inject = [...]` to declare the services it needs. The Client half is declared with
`dsh.client` in `package.json`:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true }
}
```

DSH's `@deepseek-ai/dsh-client-modules` scans enabled Loader entries, turns each `dsh.client`
declaration into a lazy browser bundle, serves it from the web carrier under `/plugins`, and
injects the boot graph into `index.html`. There is no build step in this repository: `client.js`
is written as the plain-JavaScript bundle the loader expects.

## 2. Host half

### 2.1 Entry point

```js
export const inject = ['webServer', 'connection', 'sessionPersistence'];

export function apply(ctx, config = {}) { … }
```

`index.js` does four things:

| Work | Harness API | Why |
|---|---|---|
| Start the engine | `ctx.effect(() => { void monitor.start(); return () => monitor.dispose(); })` | Owns timers, scanning, saving; disposed cleanly on unload/reload. |
| Register the dashboard API | `ctx.webServer.register({ kind: 'prefix', path: '/api/usage-monitor', handler })` | One authenticated, same-origin JSON endpoint group. |
| Bootstrap the Client | `ctx.on('webserver/index-inject', table => table.push({ kind: 'global', name: '__DSH_USAGE_MONITOR__', value: { api, schemaVersion, version } }))` | Injects one `global` row into the shell's `index.html`; the Client reads the API prefix and version from it. |
| Poll wallet / read sessions | `ctx.deepseekAccount`, `ctx.sessionPersistence`, `session/event` | See below. |

`deepseekAccount` is optional: the plugin does not put it in `inject`, so an API-key-only
profile still mounts the plugin and shows token/cost data with an honest "balance unavailable"
state instead of failing to load.

### 2.2 Reading token usage

Two input paths, both official:

1. **History** — `ctx.sessionPersistence.list()` returns one snapshot per stored Session
   (header, revision, event count). For each snapshot the engine calls
   `open(id, 'read')` → `handle.read(offset)` → `handle.close()` and folds every
   `assistant/message` / `assistant/attempt` settlement through `lib/ingest.js`.
   A full rescan is skipped when the stored revision is unchanged; a session whose
   `formatStatus` is not `current` (a format migration is required) is skipped with a warning
   instead of being misread.
2. **Live** — `ctx.on('session/event', (session, event) => …)` folds the same events for running
   Sessions as they are appended, so the dashboard updates before the next full scan.

`lib/ingest.js` keeps one record per Session: header metadata (cwd, agent preset, subagent
origin/parent, delegation depth), provider-reported token counters, and the **signal counters**
used by cache diagnostics (system-prompt hashes, request-header changes, tool-list sizes, models,
compactions, gaps, UUID/timestamp occurrences). It never keeps prompt text: system message
content is reduced to a truncated SHA-256 hash plus counts.

The retry rule mirrors Harness's own `tokenUsage` projection: a `llm/retry-started` closes the
current `(turn, step)` slot, and the replacement settlement replaces the previous sample rather
than being added to it.

### 2.3 Reading the wallet

`ctx.deepseekAccount.getBalance(metadata)` is the same account service that powers
Settings → Account. The plugin passes only client metadata (version, locale, timezone offset);
the credential stays inside the account service. The request is polled no more often than
`balanceRefreshSeconds` (default 45 s). Wallets are kept as Decimal strings and summed per
currency; **no conversion is performed**. See [`DATA-SOURCES.md`](DATA-SOURCES.md#4-wallet-balance--observed).

### 2.4 Serving the dashboard

The engine answers a small same-origin JSON API:

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/usage-monitor/snapshot?range=1h\|6h\|24h\|7d` | Harness browser session | Full dashboard payload (`snapshot`, schema v1). |
| `POST /api/usage-monitor/settings` | Harness browser session | Validate/clamp/persist settings, return a fresh snapshot. |
| `POST /api/usage-monitor/refresh` | Harness browser session | Force a wallet poll + Session rescan, return a fresh snapshot. |
| `GET /api/usage-monitor/health` | none | `{ ok, version, uptimeMs }`, deliberately non-sensitive. |

Every authenticated route first calls `ctx.connection.requestRejection(req)`, the Host's
Origin/Host fence plus browser-session check. A rejection becomes `401`/`403`; nothing is served
before that check. Responses use `cache-control: no-store` and `x-content-type-options: nosniff`;
settings bodies are limited to 64 KiB and validated by an allow-list (`normalizeSettings`);
unknown keys are dropped. The API returns aggregates only — never prompts, credentials or raw
Session logs.

Snapshots are cached for at most one second and invalidated by new events, scan completion or
settings changes, so five browser tabs polling at 5 s do not multiply the CPU cost.

### 2.5 Local persistence

`lib/store.js` owns `$DSH_HOME/usage-monitor/`:

| File | Content | Notes |
|---|---|---|
| `state.json` | aggregated request rows (tokens only), Session headers/signals, wallet samples, anomaly condition memory | written atomically (temp file + rename), debounced ~8 s; a corrupt file is moved aside, not fatal |
| `settings.json` | user settings from the Settings drawer | written atomically |
| `status.json` | support snapshot (written by default) | no prompts, no credentials; disable with `exposeDiagnosticsFile: false` |

Nothing is written into the profile, the plugin package or the Session logs. Pruning runs every
10 minutes against `retentionDays` (default 14).

### 2.6 Anomaly assessment pipeline (v0.1.1)

Snapshot construction is still one pure function (`buildSnapshot`), but the anomaly path was
rewritten in v0.1.1 so a heavy workload is no longer automatically treated as abnormal:

```text
retained request rows
        │
        ▼
UsageIndex  ── per-minute aggregates, per-model/session/preset/turn, cache counters
        │
        ▼
activeBaselineStats ── 5-min buckets with requests ≥ minimumActiveRequests in [now−24h, now−1h]
        │               median cost/hour + median requests/min + uncached/request + prompt size
        │               status = ready | warming (6 buckets / 30 requests / 1 h coverage)
        ▼
buildSecondaryEvidence ── workload: request-rate, context-growth
        │                  efficiency: cache-drop, uncached-burst, session-dominance (corroborating)
        ▼
burnSeverityOf ── activeRatio vs warning/criticalBurnRatio, gated by strong evidence and by
        │         criticalRequiresSecondaryEvidence; warming → normal + baseline-warming
        ▼
conditions / assessment ── one combined burn-anomaly condition; cache-low, cost-spike,
        │                    balance-low, recovered; workload-vs-efficiency explanation
        ▼
alerts (warning/critical only) + anomaly timeline (live conditions + evidence-backed history)
```

Key properties of the pipeline:

- **The baseline never guesses.** While `activeBaseline.status === 'warming'`, burn severity is
  forced to `normal` and no burn-rate alert can fire; the warning carries the bucket, request and
  coverage counts, and confidence is exposed to the Client.
- **Severity is evidence-gated.** High burn alone is a `notice`; `warning` and `critical` need at
  least one strong efficiency signal, and `critical` additionally needs high burn (unless the user
  disables `criticalRequiresSecondaryEvidence`). Session dominance is never a standalone signal.
- **Workload and efficiency are separate.** The snapshot's `assessment` block exposes both lists
  plus a `driver` (`workload` / `cache` / `uncached` / `mixed` / `none`) so the Client can explain
  *why* rather than just reporting a ratio.
- **History is evidence-only.** Per-bucket burn-rate reconstruction was removed as the main false
  positive source; the timeline keeps evidence-backed cache drops and informational request spikes.
- **Wire compatibility.** `schemaVersion` remains `1`; the v0.1.1 fields (`assessment`,
  `burn.activeBaseline`, `burn.activeRatio`, `burn.overallRatio`, `burn.reason`,
  `cache.deltaClass`, `cache.health`, `cache.deltaDeadband`, `cache.deltaNoticeThreshold`,
  `cache.savings.kind`) are additive. An existing `state.json` / `settings.json` needs no migration.

## 3. Client half

`client.js` is a single plain-JavaScript bundle. In DSH's module format it registers with the
shell's module loader (`window.__ModuleLoader__.load({ id, factory })`) instead of using ES
imports or JSX, so DSH can serve it directly without a bundler.

It contributes:

- a `main` panel entry (`key: "usage-monitor"`) — the dashboard page;
- a `sidebar.panellist` entry — the clickable Usage Monitor row in the left sidebar rail;
- locale dictionaries through `ctx.locale.register`, with English and Simplified Chinese
  fallbacks driven by the active Harness locale;
- light/dark styling that uses only Harness theme tokens (`--dsw-alias-*`), never fixed colors.

Maintainer notes for the browser half (registrations, data lifecycle, charts, styling, manual
verification checklist) live in [`UI.md`](UI.md).

It fetches `GET /api/usage-monitor/snapshot?range=…` every 5 seconds while the page is visible
(hidden tabs skip ticks and refresh on return; same origin, browser session cookie), renders SVG
charts itself (no chart dependency), and POSTs settings changes to `/settings`. A "Refresh" action
calls `/refresh`. If a fetch fails after a snapshot was loaded, the page keeps the last snapshot and
shows a connection error instead of clearing the dashboard.

## 4. End-to-end data flow

```text
Session logs (durable, owned by Harness)
        │  sessionPersistence.list/open/read
        ▼
lib/ingest.js  ── folds provider TokenUsage + cache signals ──►  in-memory entries
        ▲                                                              │
        │  session/event (live incremental updates)                    │
        │                                                              ▼
deepseekAccount.getBalance ───────────────────────────────►  lib/analytics.js
        │  (wallet samples, ≤ every 45 s)                            │
        │                                    active baseline ─► evidence ─► severity
        │                                                              │  + assessment
        ▼                                                              ▼
$DSH_HOME/usage-monitor/state.json                       authenticated JSON routes
                                                                     │
                                  browser: client.js polls every 5 s │
                                                                     ▼
                                                     Usage Monitor panel (DOM + SVG)
```

## 5. Failure behavior

The plugin prefers an honest empty state over a fabricated one.

| Failure | Behavior |
|---|---|
| `sessionPersistence` unavailable | Plugin keeps running; API returns empty token data; Diagnostics lists the scan error. |
| A Session needs a format migration | That Session is skipped (`formatStatus !== "current"`), counted as a scan error, and named in Diagnostics. |
| `deepseekAccount` not mounted (API-key-only profile) | `balance.state = "unavailable"`; token/cost panels still work. |
| Signed out | `balance.state = "signed-out"`; previous wallet samples stay for observed-spend history. |
| Platform balance request fails | `balance.state = "error"`, previous samples retained; no fake zero balance. |
| Corrupt `state.json` | Renamed to `state.json.corrupt-<timestamp>`; the plugin starts from a clean state. |
| Unknown model id | Tokens are counted; cost is `null` and a Diagnostics warning names the model. |
| Active baseline still warming | `burn.activeBaseline.status = "warming"`, severity is forced to Normal, burn-rate alerts are suppressed, Diagnostics reports the bucket/request/coverage counts; the Client shows "Learning baseline". |
| HTTP handler throws | Logged; `500` JSON error; the process is not affected. |

## 6. Harness architecture audit

Before writing a line of Host code, each seam this plugin depends on was checked in the installed
DeepSeek Harness 0.2.1-rc.2 build. No private or undocumented entry point is used.

| Dependency | Verified in DSH 0.2.1-rc.2 | Used for |
|---|---|---|
| `ctx.sessionPersistence` service with `list()` / `stat()` / `open(id, 'read')` / `handle.read()` / `handle.close()` | `@deepseek-ai/dsh-session-persistence` service definition and contract; `@deepseek-ai/dsh-session-persistence-jsonl` backend | Enumerating and reading stored Sessions |
| `session/event` / `session/flush` / `session/disposed` events | Persistence write path and `@deepseek-ai/dsh-session-persistence-jsonl` listener wiring | Live incremental usage updates |
| `SessionEventMap` shapes: `assistant/message` (`data.usage`), `assistant/attempt` (usage in the final `usage` stream chunk), `llm/retry-started`, `request/header`, `system/message`, `compaction/start`, `session/title` | `@deepseek-ai/dsh-agent-loop`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-token-meter` (`tokenUsage` projection) | Usage folding, cache signals, retry de-duplication |
| `ctx.deepseekAccount.getBalance(AccountClientMetadata)` | `@deepseek-ai/dsh-deepseek-account` service contract; `@deepseek-ai/dsh-deepseek-account-platform` provider (`GET /api/v0/users/get_user_summary`) | Real wallet balance |
| `ctx.webServer.register({ kind: 'exact' \| 'prefix', path, handler })` | `@deepseek-ai/dsh-host-webserver` route registry | Dashboard JSON API |
| `ctx.connection.requestRejection(req)` | `@deepseek-ai/dsh-client-connection` Host/Origin fence + browser-session admission | Authentication of every dashboard route |
| `webserver/index-inject` rows, including `kind: 'global'` | `@deepseek-ai/dsh-host-webserver` `collectIndexInjections` / `renderIndexInjections` | `window.__DSH_USAGE_MONITOR__` bootstrap row |
| `dsh.client` manifest (`platform`, `immediately`), `/plugins` bundle serving, `window.__ModuleLoader__.load({ id, factory })` | `@deepseek-ai/dsh-client-modules` and first-party client bundles | Loading the browser half without a build step |
| Slot registry names `main` and `sidebar.panellist`; `ctx.locale.register(namespace, { en, zh })` | `@deepseek-ai/dsh-client-ui-sidebar`, `@deepseek-ai/dsh-client-ui-schedule`, `@deepseek-ai/dsh-client-locale` | Main panel, sidebar entry, i18n |

The audit also covered the seams the plugin deliberately avoids: no direct reads of Session JSONL
files, no `resolveToken`/credential access, no model calls, no separate billing API. The Host
service contract is enough, and using it is what keeps the plugin compatible across Session-format
migrations.

## 7. Compatibility and upgrade notes

- Built and tested against **DeepSeek Harness 0.2.1-rc.2**, desktop and web profiles.
- Node.js **≥ 20** for the runtime (DSH bundles its own Node; this matters for development).
- v0.1.1 keeps `schemaVersion: 1` and adds fields only; existing `settings.json` files load
  unchanged (new anomaly-quality settings inherit defaults) and there is no data migration.
- The plugin has **zero runtime dependencies**: only Node built-ins and the Host services above.
- Session formats are owned by Harness; the plugin reads the current format through the
  official service and never parses the raw log files, so a Harness upgrade that ships a format
  migration is handled by the persistence backend, not by this plugin (sessions awaiting
  migration are skipped and reported).
- Uninstalling the bundle removes the Host row; `$DSH_HOME/usage-monitor/` is left in place so a
  reinstall keeps history. Delete that directory to reset the plugin.

## 8. Why this shape

- **No per-page Host work.** The Client only renders; all scanning and aggregation happen once in
  the Host, so ten open tabs cost no extra scans.
- **Fewer false positives by construction.** The primary burn comparison is against active
  workloads (median of busy 5-minute buckets), the baseline refuses to judge while warming, and
  aggressive severity is gated on corroborating efficiency evidence. A heavy task is labeled heavy,
  not broken.
- **No new network surface.** The only outbound request is the account balance read performed by
  Harness's own account service; the plugin registers no third-party endpoint and sends no
  telemetry.
- **No private APIs.** Everything comes from services DSH documents for plugins:
  `sessionPersistence`, the `session/event` feed, `deepseekAccount`, `webServer`,
  `connection` and `webserver/index-inject`.
- **No secrets.** The plugin never reads, stores, logs or transmits an API key, cookie or token.
