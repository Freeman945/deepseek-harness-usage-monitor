# Roadmap

This is a direction, not a promise. Items move when someone has a real use case and can verify
the data source. Anything that would require a private API or an invented number stays out.

## Near term

| Item | Why | Status |
|---|---|---|
| **More provider adapters** | Token usage is already provider-reported in Session events; the pricing layer currently only knows DeepSeek models. Add price tables for other providers Harness supports, and keep unknown models unpriced rather than guessing. | Planned |
| **Historical balance coverage** | Observed spend currently starts when the plugin first polls the wallet. Investigate whether any official, user-visible baseline exists that can extend coverage without guessing. | Research |
| **Usage report export (CSV/JSON)** | Teams want to take the aggregates to a spreadsheet. Export the same snapshot data locally; no upload, no cloud. | Planned |
| **Deeper cache diagnostics** | Improve cause attribution: more precise request-epoch boundaries, prompt-section fingerprints, and per-session cache trend without storing prompt text. | Planned |

## Later

| Item | Why | Status |
|---|---|---|
| **Budget policies and notifications via Harness-native surfaces** | Turn alert thresholds into a notification through a Harness surface (not a separate mailer or webhook), so budgets work the same way as other Harness notifications. | Exploring |
| **Per-model real-vs-estimated reconciliation** | Compare the wallet's observed spend with the estimated total over the same window to show an error band, without claiming per-request billing. | Exploring |
| **Search / Fetch cost accounting** | Per-request billing starts 2026-11-01 Beijing time; add it only when the provider exposes the necessary counters. | Waiting on data |
| **Multi-currency wallets** | Today only the primary wallet currency is summed; show each currency separately rather than converting. | Planned |
| **Agent Team / subagent rollups** | Session metadata already records subagent origin and parent; group delegated work into a single team view. | Planned |

## Explicit non-goals

- Sending usage data to any third-party service or telemetry backend.
- Storing prompts, completions or system-prompt text.
- Reading API keys, cookies or credentials from Harness.
- Claiming exact provider charges when only tokens and a price table exist.
- A second login or a separate account system for the dashboard.

## How to influence this list

Open an issue describing the use case and, if possible, the official data source that makes the
feature observable. A feature that cannot be sourced from documented Harness services or from the
user's own wallet will not be built.
