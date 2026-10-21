# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [0.1.1] — 2026-10-21

Anomaly quality and UX refinement. Compatible with DeepSeek Harness **0.2.1-rc.2** (desktop and
web profiles) and Node.js **≥ 20**. The Snapshot schema stays `schemaVersion: 1` (additive fields
only), existing `settings.json` files load unchanged, and no data migration is needed.

### Improved

- **Active-workload baseline for burn rate.** The alert trigger is now the median cost/hour of the
  5-minute buckets in the previous 23 hours that actually had requests (`minimumActiveRequests`,
  default 1), together with median requests/min, median uncached tokens per request and median
  prompt size. The overall 24-hour arithmetic mean is still displayed for context but is no longer
  the primary alert trigger, so a normal concentrated task no longer looks "100× normal" for a
  low-frequency user.
- **Baseline warm-up.** The active baseline is `ready` only with at least `minActiveBuckets` (6)
  active buckets, `baselineMinRequests` (30) requests and `baselineMinCoverageHours` (1 hour) of
  history; otherwise it is `warming`, a confidence value (0..1) is exposed, and burn-rate alerts are
  suppressed. The dashboard shows "Learning baseline / 正在建立基线".
- **Evidence-gated severity.** Normal / Notice / Warning / Critical replace the old binary
  warning/critical ladder. High burn without efficiency evidence is a Notice (Elevated); Critical
  requires high burn **and** at least one strong efficiency signal (cache drop below the absolute
  healthy rate, or an uncached-token burst) unless `criticalRequiresSecondaryEvidence` is disabled.
  Heavy work alone is never called an anomaly, and session dominance is corroborating only.
- **Cache delta deadband and absolute health.** The last-hour hit rate is compared with the
  preceding 24-hour window using a 5-percentage-point deadband (`cacheDeltaDeadband`), a
  15-point warning-class threshold (`cacheDeltaNotice`) and a 90% absolute-health floor
  (`cacheHealthyRate`). A 99.7% → 99.0% move is now neutral and healthy instead of an alert.
- **"Why is usage high?" splits workload from efficiency evidence.** The panel reports request-rate
  and context-size evidence separately from cache-drop, uncached-burst and session-dominance
  evidence, and names a main driver (workload / cache / uncached / mixed / none) instead of blaming
  burn alone.
- **Cleaner historical timeline.** Per-bucket burn-rate reconstruction was removed — it was the main
  source of false-positive timeline entries. The timeline now keeps evidence-backed cache drops and
  informational request spikes only.
- **New optional anomaly-quality settings** (safe defaults, old settings files load unchanged):
  `minimumActiveRequests`, `minActiveBuckets`, `baselineMinRequests`, `baselineMinCoverageHours`,
  `cacheDeltaDeadband`, `cacheDeltaNotice`, `cacheHealthyRate`,
  `criticalRequiresSecondaryEvidence`, `uncachedBurstMultiplier`, `uncachedBurstMinTokens`,
  `sessionDominanceShare`, `contextGrowthMultiplier`. There are still no new Settings-drawer
  controls in v0.1.1; configure them through the bundle row config or
  `POST /api/usage-monitor/settings`.
- **Cache savings wording.** The metric is now documented as **estimated avoided extra input cost**
  (`kind: 'avoided-extra-input-cost'`) — cached tokens priced at the cache-hit rate instead of the
  cache-miss rate — not a refund or a platform credit.

### Fixed

- False-positive burn alerts caused by comparing against an idle-inclusive 24-hour mean.
- False-positive "burn rate" entries painted across the historical anomaly timeline by single heavy
  tasks.
- Cache-hit-rate drops within noise being reported as problems.
- Added `npm run audit` (`"audit": "node scripts/security-audit.mjs"`) so documented and CI commands
  are consistent (`npm test`, `npm run check`, `npm run audit`, `npm run verify:live`); CI now runs
  the audit through `npm run audit`.

## [0.1.0] — 2026-10-21

First public release. Compatible with DeepSeek Harness **0.2.1-rc.2** (desktop and web
profiles), Node.js **≥ 20**.

### Added

- **Sidebar Usage Monitor panel** in the Harness Web UI, with a `main` page entry and a
  `sidebar.panellist` row.
- **Real wallet balance**: reads the signed-in DeepSeek account wallet through Harness's official
  `deepseekAccount.getBalance()` service (`GET /api/v0/users/get_user_summary`, invoked by the
  account service, never by the plugin). Separate recharge and bonus wallets, CNY/USD kept
  unconverted, honest signed-out/unavailable/error states.
- **Token usage** from durable Session logs (`assistant/message` / `assistant/attempt` provider
  usage), with retry de-duplication and live incremental updates from `session/event`.
- **Cache hit rate** using the same formula as Harness's own UI
  (`cacheRead / (cacheRead + input + cacheWrite)`).
- **Estimated cost** from the official DeepSeek price table captured 2026-10-21, peak/off-peak
  aware, per-model and per-tier overrides, clearly labeled `Est.`; **observed spend** from real
  wallet decreases between balance polls.
- **Burn rate** (last 5 min / 30 min / 1 h against the previous 23-hour baseline), cost windows
  (today, last hour, 24 h, 7 days, month), configurable trend ranges (1 h / 6 h / 24 h / 7 d).
- **Anomaly detection and alerts**: burn-rate, cache-low, uncached-input burst, cost spike,
  cache-problem correlation, 24-hour historical anomaly ledger, recovered-condition entries and
  balance-threshold alerts. All rules are deterministic and their thresholds are configurable.
- **Cache diagnostics** that report evidence, not guesses: request-epoch changes, system-prompt
  hash changes, toolset changes, model switches, compaction cache breaks, TTL gaps, timestamp/
  UUID-like text in the system prompt, cache-not-reported sessions and context growth.
- **Top consumers** by session, by task (conversation turn), by agent preset / subagent and by
  uncached token cost, plus a per-model breakdown.
- **Balance forecast** at the recent burn rate, with the basis stated in the UI.
- **Settings drawer** for thresholds, alerts, currency, polling/scan intervals, retention,
  peak/off-peak holidays and pricing overrides; settings are validated, clamped and persisted.
- **Light and dark themes** using Harness theme tokens, and **English / Simplified Chinese**
  dictionaries.
- **Authenticated same-origin HTTP API** (`/api/usage-monitor/snapshot`, `/settings`, `/refresh`,
  `/health`) guarded by `ctx.connection.requestRejection`, with `no-store` responses and no
  secrets in payloads.
- **Zero runtime dependencies**, no build step, no API key and no environment variable required.
- CI for Node 20/22/24: repository checks, Node test runner, security and privacy audit.
- Documentation: README (English and Chinese), `docs/ARCHITECTURE.md`, `docs/DATA-SOURCES.md`,
  `docs/API.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/ROADMAP.md`.

### Security

- The plugin never reads, stores, logs or transmits an API key, cookie or token.
- Session logs are read-only; the plugin never writes Session data.
- System-prompt text is not stored — only a truncated SHA-256 hash and UUID/timestamp counts for
  cache diagnostics.
- Repository and Git history are scanned for secrets, credential files and local runtime data by
  `scripts/security-audit.mjs` in CI.

### Known limitations (v0.1.0)

- Agent identity is derived from Session metadata (agent preset, subagent origin/parent, cwd,
  session title) because Session events do not record a per-request agent name.
- "Tasks" mean conversation **turns**, not Harness jobs.
- Observed spend starts at the first wallet poll after install; there is no historical balance
  backfill. Token history is read from existing Session logs.
- Peak/off-peak pricing ignores Chinese public holidays until they are configured in Settings.
- Search / Fetch per-request billing is not modeled (free until 2026-11-01 Beijing time).
- Balance is unavailable for API-key-only setups that are not signed in to a DeepSeek account.
- The estimated cost is arithmetic on a published price table, not a provider invoice.

[Unreleased]: https://github.com/Freeman945/deepseek-harness-usage-monitor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Freeman945/deepseek-harness-usage-monitor/releases/tag/v0.1.1
[0.1.0]: https://github.com/Freeman945/deepseek-harness-usage-monitor/releases/tag/v0.1.0
