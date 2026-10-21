# Contributing

Thanks for helping improve the Usage Monitor. This is a small, deliberately plain project: a Host
plugin in dependency-free Node.js ESM and a browser half that must load without a build step.

## Ground rules

1. **No runtime dependencies.** Node built-ins and Harness Host services only. If a feature seems
   to need a package, describe the tradeoff in an issue first.
2. **No secrets, ever.** No API keys, cookies, tokens, `.env` files, real wallet amounts, real
   Session IDs or private prompts in commits, tests, fixtures, screenshots or issues. The
   security audit and CI enforce this; do not work around it.
3. **No invented claims.** If you add or change a metric, update
   [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md) with its source and formula, and mark it
   `Est.` when it is an estimate. The README may only state what the code and the Harness source
   actually do.
4. **Read-only on Harness data.** The plugin must never append to, rewrite or delete Session
   logs, and must never call a private endpoint.
5. **Both surfaces stay in sync.** Host behavior changes usually need a matching
   `docs/API.md` change and a Client update. English and Chinese locale strings should be added
   together.

## Development setup

Requirements:

- Node.js ≥ 20 (DSH bundles its own Node; a normal Node install is fine for development);
- DeepSeek Harness 0.2.1-rc.2 installed and running;
- no package manager step — there is nothing to install in this repository.

```bash
git clone https://github.com/Freeman945/deepseek-harness-usage-monitor.git
cd deepseek-harness-usage-monitor

node --version          # must be >= 20
npm test                # Node's built-in test runner
npm run check           # syntax, JSON, manifests, secrets, docs
node scripts/security-audit.mjs
```

`npm test` runs `node --test test/*.test.js`. Tests are plain ESM using `node:test` and
`node:assert/strict`; no test framework is installed.

## Installing a development copy

Install the checkout into a Harness profile exactly like a release, pointing at your working
directory instead of a clone:

1. Harness → **Sidebar → Plugins → Add plugin** → paste the absolute path of this checkout →
   **Install** → **Enable now**.
2. Or, with an agent: `plugin_manager` tool, `action: install_bundle`,
   `target: <absolute path to this checkout>`.
3. Or CLI: `dsh plugin --profile <profile> add link:<absolute path>`, then enable the bundle
   (Plugins page, or add `deepseek-harness-usage-monitor` to `dsh.profile.bundles` in
   `$DSH_HOME/profiles/<profile>/package.json`).

Restart the Harness window if the panel does not appear after installation. Local data lives in
`$DSH_HOME/usage-monitor/`; delete that directory to reset the plugin's state and settings.

## Project layout

| Path | Owner | Purpose |
|---|---|---|
| `index.js` | Host | Cordis entry: `apply`, `inject`, route registration, index injection |
| `lib/monitor.js` | Host | Engine: scanning, live events, wallet polling, HTTP, lifecycle |
| `lib/ingest.js` | Host | Session-event folding: usage counters and cache signals |
| `lib/analytics.js` | Host | Snapshot aggregation: windows, burn, cache, anomalies, consumers |
| `lib/pricing.js` | Host | Official price table, peak rule, estimates |
| `lib/store.js` | Host | Settings, atomic state file, retention |
| `client.js` | Client | Browser bundle: sidebar entry, dashboard, settings drawer, i18n |
| `locale/` | Client | Display dictionaries (English, Simplified Chinese) |
| `test/` | Both | Node test runner tests and **synthetic** fixtures |
| `docs/` | Both | API contract, architecture, data sources, UI notes, roadmap, screenshots |

## Changing a metric or diagnostic

1. Add the source/formula to `docs/DATA-SOURCES.md`.
2. Add or update the corresponding field in `docs/API.md` (schema v1 is additive-only within
   0.1.x; an incompatible payload change bumps `schemaVersion`).
3. Add a unit test with a deterministic timestamp (tests must not depend on the wall clock).
4. If the UI displays it, use a locale key in both `locale/en.json` and `locale/zh.json`.

## Screenshots

- Only real captures of a local Harness run are accepted. No mockups, no fabricated data.
- Redact wallet amounts, Session titles, file paths, model/provider keys if private, and any
  personal information before committing.
- Screenshots live in `docs/screenshots/` and are referenced from `README.md` with a caption
  stating they are from a real local run.

## Pull request checklist

- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] `node scripts/security-audit.mjs` passes (including Git history).
- [ ] No new runtime dependency; no new network call.
- [ ] Docs updated (`README`, `docs/API.md`, `docs/DATA-SOURCES.md` as applicable).
- [ ] English and Chinese UI strings both present.
- [ ] Fixtures and screenshots are synthetic or redacted.
- [ ] Commit messages describe the user-visible behavior change.

## Reporting bugs

Use GitHub Issues for normal bugs. For security or privacy problems follow
[`SECURITY.md`](SECURITY.md) and report privately instead of opening a public issue.
