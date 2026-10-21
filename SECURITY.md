# Security policy

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` | Yes — current public release |

## Reporting a vulnerability

Please **do not open a public issue** for a security or privacy problem. Report it privately
through GitHub's **Security → Advisories → Report a vulnerability** flow on
`https://github.com/Freeman945/deepseek-harness-usage-monitor`, or contact the maintainer
`@Freeman945` on GitHub.

Include:

- affected version and Harness version;
- a minimal reproduction (no real wallet, account or Session data);
- the impact you believe it has;
- any suggested fix, if you have one.

Please do **not** include real prompts, Session IDs, wallet amounts, cookies, API keys or
screenshots containing them. We will acknowledge the report and coordinate a fix and disclosure
date. This project is maintained by volunteers; no bounty is offered.

## What this plugin is allowed to do

The Usage Monitor is read-mostly by design. The complete list of external interactions:

| Interaction | Direction | Detail |
|---|---|---|
| Session persistence | read-only | `ctx.sessionPersistence.list/open/read` on Session logs owned by Harness. The plugin never appends, rewrites or deletes Session data. |
| Live session events | read-only | Subscribes to `session/event`; no event is emitted by the plugin. |
| Wallet balance | read | Calls `ctx.deepseekAccount.getBalance(metadata)` — Harness's own official account service. The plugin never talks to the Platform HTTP endpoint itself and never sees the credential. |
| Dashboard HTTP API | in | Same-origin routes on `ctx.webServer`, gated by `ctx.connection.requestRejection`. |
| Boot injection | out (DOM only) | One `global` index row `__DSH_USAGE_MONITOR__` with the API prefix, schema version and plugin version. |

There is **no telemetry, no analytics and no upload**. The plugin makes no network request of
its own and ships zero runtime dependencies.

## Secret handling

- The plugin requires **no API key, cookie, token or environment variable**. There is no key,
  token or `.env` value to fill in anywhere in the documentation.
- Harness account credentials are owned by Harness's credentials service. The plugin only
  receives the parsed wallet result (`currency` + decimal `balance` strings) from
  `deepseekAccount`; it cannot read the underlying grant.
- API payloads, `state.json`, `status.json` and logs contain no credential, cookie, Authorization
  header, prompt text or completion text.
- `state.json` contains aggregated token counters, Session labels and cwd metadata, never prompt
  text. Treat `$DSH_HOME/usage-monitor/` as private local data: it is deliberately gitignored, and
  you should not attach it to public issues. `status.json` exists for support but should also be
  reviewed before sharing.
- The repository scan in [`scripts/security-audit.mjs`](scripts/security-audit.mjs) refuses
  API-key-looking strings, bearer tokens, private keys, `.env` files, wallet/usage databases and
  local runtime data in the working tree **and** in Git history. It runs in CI on every push.

## Data at rest

| Data | Location | Sensitivity |
|---|---|---|
| Aggregated usage rows, wallet samples, Session labels | `$DSH_HOME/usage-monitor/state.json` | Local; no prompts; gitignored |
| Settings thresholds | `$DSH_HOME/usage-monitor/settings.json` | Local; gitignored |
| Support status snapshot (on by default; disable with `exposeDiagnosticsFile: false`) | `$DSH_HOME/usage-monitor/status.json` | Local; no prompts or credentials |
| System prompt evidence | only a truncated SHA-256 hash and UUID/timestamp **counts** are kept | Not reversible |

Retention defaults to 14 days and is configurable (1–30 days). There is no cloud backup, sync or
export endpoint in v0.1.1. The v0.1.1 anomaly-quality changes only added derived fields and
settings; they collect no new data, store no prompt text and add no network request.

## Threat model and known boundaries

- **Dashboard authentication is Harness's browser session.** The routes are protected by the same
  Origin/Host fence and session check as the rest of the Harness UI. Someone who can already use
  the signed-in Harness page can read the dashboard; there is no second password.
- **`/health` is intentionally unauthenticated.** It exposes only `{ ok, version, uptimeMs }`.
- **Local OS users.** Anyone who can read `$DSH_HOME/usage-monitor/state.json` can see aggregated
  usage and wallet history. Protect your home directory; the plugin cannot defend against a
  local attacker with your OS account.
- **Text rendering.** All session titles, model names and diagnostics are rendered as text in
  React; the plugin does not inject HTML from Session data. Session titles are user-controlled
  strings and are treated as untrusted input.
- **XSS on the Harness origin** would affect every plugin on that origin. Keep Harness updated.
- **Estimation is not a bill.** Estimated cost is arithmetic on the official price table and is
  labeled `Est.`. Do not use it for accounting, tax or dispute purposes; the wallet is the only
  authoritative money value.
- **No historical balance.** Observed spend cannot be reconstructed for time before the plugin
  first ran; there is no backfill and no billing-history API to backfill from.

## Dependency and supply-chain policy

- Zero npm runtime dependencies; only Node.js built-ins (`node:fs`, `node:path`, `node:crypto`,
  `node:http`, etc.).
- CI installs nothing, uses no repository secrets and calls no paid API. Actions are pinned to
  major versions (`actions/checkout@v4`, `actions/setup-node@v4`).
- The plugin is installed from source as a DSH bundle by absolute path; there is no published npm
  package and `"private": true` prevents accidental publishing.
- Release checklist: `npm test`, `npm run check`, `npm run audit`,
  `npm run verify:live` against a real local install, then confirm that `docs/screenshots/`
  contains only real local-run captures with private data redacted.

## License

MIT. The plugin includes no third-party code. DeepSeek Harness itself is MIT-licensed by
DeepSeek; see [LICENSE](LICENSE) and the upstream repository
<https://github.com/deepseek-ai/deepseek-harness>.
