# Usage Monitor — Client UI notes

Maintainer notes for `client.js`, the browser half of the plugin. The data contract lives in
[API.md](API.md); installation and user-facing behaviour live in the README.

## Artifact shape

`client.js` is the deployed browser artifact, not a build input. It registers through the
Harness module loader and exports `apply()`:

```js
window.__ModuleLoader__.load({
  id: 'deepseek-harness-usage-monitor',
  factory(require) {
    const React = require('react'); // the only import; no JSX, no bundler, no Client packages
    ...
    return { inject: ['slots', 'locale'], apply(ctx) { ... } };
  },
});
```

`npm run check` enforces the constraints that silently break this half: no ESM `import`, no JSX,
`__ModuleLoader__` present, and a `sidebar.panellist` registration. The file is plain CommonJS in a
`"type": "module"` package — that is intentional and understood by the loader.

## Registrations

| Slot | Options | Component |
|---|---|---|
| `main` | `key: 'usage-monitor'`, `locale: NS` | `UsageMonitorPage` |
| `sidebar.panellist` | `id: 'usage-monitor'`, `order: 20`, `locale: NS`, `label: () => t('nav')` | `UsageMonitorIcon` |

`NS = 'usage-monitor'`. The `locale` option makes the slot system inject a `t` prop; the sidebar
`id` is what selects the `main` key. The icon receives `{ size, active }` and renders a monochrome
`currentColor` SVG at `size` (16 px expanded, 18 px on the collapsed rail).

The page registers no `settings.section`: v0.1.0 keeps every editable threshold in the in-page
Settings drawer, so there is exactly one settings surface. If a second surface is added later,
reuse `settingsToDraft` / `draftToPatch` / `SettingsField` instead of duplicating the form.

## Data lifecycle

All requests go to the same-origin Host API (`/api/usage-monitor/*`) with
`credentials: 'same-origin'`; the Host rejects unauthenticated callers with `401`.

- **Poll** — `GET /snapshot?range=<range>` on mount and every 5 s (`POLL_MS`). Hidden documents
  skip ticks; `visibilitychange` back to visible refreshes immediately. `setInterval` and the
  listener are both removed in the effect cleanup.
- **Serialization** — `withLock(task, preempt)` keeps at most one request in flight. Poll ticks are
  skipped while a request is running (`preempt: false`); user actions (range switch, Retry,
  Refresh, Save settings) preempt the in-flight request and abort it (`preempt: true`). The aborted
  call resolves silently — an `AbortError` without `timedOut` is not a user-visible failure.
- **Abort** — every request owns an `AbortController`; unmount marks the component dead and aborts
  all outstanding controllers. A 20 s client timeout aborts a hung request and reports a timeout.
- **Range switch** — the new range is fetched immediately via `loadNow`; if the response's
  `series.range` does not match the requested range (the Host returns a 24 h snapshot from
  `/refresh` and `/settings`), the last series stays on screen with an "Updating range…" hint and
  one quick retry (`RANGE_RETRY_MS`) before the normal poll catches up.
- **Refresh** — `POST /refresh` forces a wallet read + Session rescan and returns a snapshot.
- **Settings** — `POST /settings` with the validated JSON subset returns a snapshot that replaces
  state. The Host normalizes/clamps values and reports what it changed as **new
  `diagnostics.warnings`** (it answers `200` rather than `400`); `saveSettings` diffs warnings
  before/after, applies the snapshot, and returns the adjusted values to the drawer so they show
  up as an inline message instead of being swallowed.
- **Errors** — with a previous snapshot on screen, a failure shows a compact "Reconnecting" strip
  and keeps stale data; with no data it shows a retry card. `401` stops polling and shows
  "Session expired — reopen the Harness page." `400`/`invalid-settings` messages from the Host are
  rendered verbatim in the drawer.
- **Empty data** — `diagnostics.data.requestsInRetention === 0` (or all-zero windows) is a state,
  not an error: the balance/KPI strip stays, the usage sections are replaced by the "No usage
  recorded yet" card.

`document.hidden`, `AbortController`, timers and `fetch` are the only browser APIs used. There is
no portal, no `document.body` write, no iframe, and no DOM outside React.

## Layout and sections

The `main` slot owns the whole central panel: `.um-root` is a full-height flex row; `.um-scroll`
is the self-scrolling page; `.um-page` caps at 1220 px and pads `24px 32px 56px` (plus the macOS
frame top clearance token when present). Rendering order, top to bottom:

1. compact header — title, status pill (`normal` / `warning` / `critical`), last-updated time,
   Refresh and Settings icon buttons;
2. firing alerts only (`since > 0`, critical first);
3. KPI row — balance (primary wallet + bonus), today, last hour, burn rate with ratio line;
4. usage trend card with the 1 h / 6 h / 24 h / 7 d switch and hover tooltip;
5. two-up: cache hit rate (big %, baseline delta, mini trend with baseline band, hit/miss/write
   tokens, estimated savings) and request rate (req/min vs baseline, sparkline, avg input per
   request, uncached input per minute);
6. two-up: top consumers (tabs: sessions / tasks / agent presets / uncached tokens) and model
   usage (requests, tokens, hit rate, cost, share bar);
7. "Why is usage high?" — `cache.diagnosis` plus causes derived only from snapshot values: burn
   ratio vs configured threshold, cache hit-rate delta, top uncached session share, model cost
   share. Severity-sorted; calm empty state when nothing fires;
8. anomaly timeline, newest first (the session chip is informational — Harness has no public
   client API to open a session from a plugin, so it is deliberately not a link);
9. forecast strip (daily cost, remaining time, basis note);
10. footer (data sources, scan status, localized diagnostics-warning count with the raw Host
    strings in the `title`, privacy line).

The Settings drawer is an in-flow right-hand panel (`.um-drawer`, 344 px) inside the page, not a
modal/portal. Below 860 px it overlays the page's right edge; Escape closes it. Inputs are
uncontrolled-string drafts converted to numbers on save.

## Formatting and i18n

- `resolveLang` prefers the live `<html lang>` (Harness locale service), then `snapshot.locale`,
  then `navigator.language`.
- `makeFormatters(lang, currency)` builds every number/date formatter once per render via
  `Intl`. Money uses `style: 'currency'` with `snapshot.currency || 'CNY'` and
  `maximumFractionDigits: 2`; nothing is ever converted (wallet strings keep their own currency).
  Large token counts use `notation: 'compact'`; the exact value rides in the element `title`.
  Durations/buckets use `Intl.NumberFormat` unit formatting, so they localize without dictionary
  entries.
- Dictionaries are flat key maps (`en`, `zh`) with identical key sets (289 keys); `t('kpi.rateMeta')`
  style keys include a namespace prefix. Dynamic families (`severity.*`, `evidence.*`,
  `status.*`, `condition.*`, `diag.*`) are resolved by prefix.
- **Host-authored copy is localized client-side from structured fields, never by translating the
  English strings.** The Host sends `code` / `type` / `evidence` (and `sessionTitle`) next to its
  English title/detail; `localizeDiagnosis`, `localizeAlert` and `localizeAnomaly` switch on those
  identifiers and rebuild the copy from `diag.<code>.*`, `alert.<type>.*` and `anomaly.<type>.*`
  templates. Covers all 13 `cache.diagnosis` codes, every alert type (`burn-rate`, `cache-low`,
  `cost-spike`, `uncached-burst`, `balance-low`) and every anomaly type (`burn-rate`,
  `cache-hit-drop` including the cache-problem variant, `cache-low`, `uncached-burst`,
  `request-spike`, `input-growth`, `expensive-model-share`, `cost-spike`, `session-dominance`,
  `balance-low`, `recovered`). When an unknown code/type arrives or its required evidence is
  missing, the Host title/detail is shown unchanged — that English fallback is intentional and is
  the only place Host copy reaches the screen.
- `evidenceChips` formats each evidence value by semantic kind: `*rate` keys as percentages
  (signed for `*delta`/`*change`, clamped 0–100% otherwise), `*Tokens`/averages as compact counts,
  money keys (`last10mCost`, `threshold`, `balance`, `bonus`) as currency (wallet currency when the
  evidence carries one), ratios with `×`. Opaque internals (`currency`, `initial`, `series`) are
  skipped; at most four chips render.
- The `Est.` badge stays "Est." in both locales because the README and API use that exact badge
  name; its tooltip is localized. Every estimated cost — KPI cards, consumer rows, model rows,
  forecast, cache savings — goes through `CostValue`/`Metric`, so the badge is never omitted.
- Consumer "share of uncached input" causes divide the row by the summed `uncachedTokens` of the
  `consumers.sessions` rows (not `costShare`, not the cache window) and clamp the result to 100%
  before formatting.

## Charts

Hand-written SVG; no chart dependency.

- The plot uses a fixed `viewBox` (`0 0 1000 220` for the trend, smaller for the mini charts) with
  `preserveAspectRatio="none"` so it fills the card width. Every stroked element sets
  `vector-effect="non-scaling-stroke"`, so anisotropic scaling keeps a constant stroke width and
  dash pattern.
- All text is HTML outside the SVG: cost labels in `.um-chart-y` (right-aligned, 52 px column),
  time labels in `.um-chart-x`. The SVG element itself carries `role="img"` + an `aria-label`
  summary.
- Hover: `onMouseMove` maps `clientX` to the nearest bucket index by the plot's own
  `getBoundingClientRect().width`; the crosshair, marker dot and tooltip are absolutely positioned
  HTML elements (never skewed), clamped left/right at the edges. Tooltip rows: time, cost, tokens,
  requests, cache hit rate.
- Costs may be `null` per point (unpriced model) — `buildSegments` starts a new path segment, so
  the line breaks instead of dropping to zero. When every cost is zero/null the chart falls back
  to plotting tokens as the primary series.
- The token line is normalized to its own peak (documented in the legend tooltip); the cost axis
  labels remain the only numeric axis.
- The cache chart draws a ±2 pp band and a dashed line at the 24 h baseline, with a dynamic
  lower bound so small variations stay visible.
- Empty series render the "No usage recorded in this window." line instead of an empty plot.

## Styling

One `<style>` element is rendered by the page (removed with it) using `dangerouslySetInnerHTML`;
all class names are prefixed `um-`. Only these tokens are used: `--dsw-alias-bg-base`,
`bg-layer-1`, `bg-layer-2`, `bg-overlay`, `border-l1`, `border-l2`, `brand-primary`,
`label-primary`, `label-secondary`, `state-error-primary`, `state-idle-primary`,
`state-success-primary`, `state-warn-primary`, plus `--dsw-font-mono` and
`--dsh-frame-top-clearance`. Derived tints/borders are `color-mix()` over those tokens (with a
plain token declaration first as a fallback); no literal colors, gradients or glow. React
`style` props are only used for geometry (bar width, crosshair position). Indicators use the
status tokens: success = normal, warn = warning, error = critical, idle = informational.

## Manual verification checklist (browser required)

1. Install the bundle in a profile and open the **Usage** sidebar entry; the page must fill the
   main panel, scroll on its own, and keep the sidebar selection state.
2. Light and dark themes: check both beside a host page (Plugin Manager is the reference density).
3. Switch Harness language (General settings) while the page is open: header, KPIs, charts labels,
   tabs and drawer must re-render in the other language without a reload.
4. Resize from desktop width down to ~600 px: KPI grid collapses 4 → 2 → 1, two-up rows stack,
   the drawer overlays the page and Escape closes it.
5. Range switch: hover the trend chart (crosshair, tooltip, no stretched strokes); verify the
   bucket size note changes. On 1 h/6 h/7 d, press Refresh — the "Updating range…" hint may blink
   briefly while the 24 h snapshot is replaced by the selected range.
6. Signed-out state (Settings → Account): balance card shows "Not signed in" copy, estimates stay.
7. Settings drawer: save a valid change (state replaced, "Settings saved."), then a clamp case
   (e.g. critical burn ratio below warning) to see the Host-adjusted message, then network-off to
   see the inline failure. Invalid local input shows field errors without a request.
8. No usage yet (fresh home): empty-state card, no chart axes, footer diagnostics count present.

## Known limitations

- Session chips in the anomaly timeline and consumer rows are not navigable (no public API).
- Trend hover is pointer-driven; keyboard users get the chart `aria-label` summary and the range
  buttons, but not per-bucket values.
- Chart hover values are not announced through a live region.
- Localized Host copy depends on the structured `code`/`type`/`evidence` fields. An unknown
  identifier or an entry without its required evidence renders the Host's English title/detail
  unchanged (the intended fallback); the footer likewise shows only a localized count of
  `diagnostics.warnings`, with the raw Host strings in the `title`.
- The drawer does not expose the advanced settings (`scanIntervalSeconds`, `holidays`,
  `pricingOverrides`, `exposeDiagnosticsFile`) added after this UI was scoped; the API and bundle
  row accept them.
- `_demo: true` fixtures must never be rendered or embedded; the UI has no demo mode and reads only
  the authenticated snapshot endpoint.
- Visual verification requires the running Harness page; `node --check`, the repository checks and
  the component smoke test do not prove rendering.
