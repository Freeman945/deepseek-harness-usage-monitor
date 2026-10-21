/**
 * Local persistence for the Usage Monitor.
 *
 * Everything stays inside the DSH home directory (`$DSH_HOME/usage-monitor/`):
 *   state.json    aggregated request samples, session metadata/signals,
 *                 balance history and anomaly-condition memory
 *   settings.json user-tunable thresholds (also accepted from the plugin row)
 *   status.json   opt-in support snapshot (no prompts, no credentials)
 *
 * The plugin never writes into the profile, never modifies the Session logs and
 * never sends this data anywhere.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_VERSION = 1;

/** Default settings, also the allow-list used when validating writes. */
export const DEFAULT_SETTINGS = Object.freeze({
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
  pricingOverrides: {},
  holidays: [],
  retentionDays: 14,
  scanIntervalSeconds: 60,
  exposeDiagnosticsFile: true,
  // v0.1.1 anomaly-quality settings (all have safe defaults; old settings files
  // simply inherit them through normalizeSettings).
  minimumActiveRequests: 1,
  minActiveBuckets: 6,
  baselineMinRequests: 30,
  baselineMinCoverageHours: 1,
  cacheDeltaDeadband: 0.05,
  cacheDeltaNotice: 0.15,
  cacheHealthyRate: 0.9,
  criticalRequiresSecondaryEvidence: true,
  uncachedBurstMultiplier: 3,
  uncachedBurstMinTokens: 10000,
  sessionDominanceShare: 0.7,
  contextGrowthMultiplier: 1.8,
});

const BALANCE_ALERT_MIN = 0.01;

/**
 * Clamp a numeric setting and fall back to its default when unusable.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Validate a rate in [0,1], accepting a percentage input only when it is > 1.
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function rate(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  const normalized = number > 1 && number <= 100 ? number / 100 : number;
  return Math.min(1, Math.max(0, normalized));
}

/**
 * Normalize an arbitrary patch into a complete, valid settings object.
 * Unknown keys are dropped; invalid values fall back to the current value.
 * @param {Record<string, unknown>} patch
 * @param {typeof DEFAULT_SETTINGS} current
 * @returns {{ settings: typeof DEFAULT_SETTINGS, errors: string[] }}
 */
export function normalizeSettings(patch, current = DEFAULT_SETTINGS) {
  const errors = [];
  const next = { ...current };
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key);

  if (has('currency')) {
    const value = patch.currency;
    if (value === 'auto' || value === 'CNY' || value === 'USD') next.currency = value;
    else errors.push('currency must be auto, CNY or USD');
  }
  if (has('balanceRefreshSeconds')) {
    const before = next.balanceRefreshSeconds;
    next.balanceRefreshSeconds = clampNumber(patch.balanceRefreshSeconds, 20, 600, before);
    if (next.balanceRefreshSeconds !== Number(patch.balanceRefreshSeconds)) {
      errors.push('balanceRefreshSeconds must be between 20 and 600 (clamped)');
    }
  }
  if (has('scanIntervalSeconds')) {
    next.scanIntervalSeconds = clampNumber(patch.scanIntervalSeconds, 15, 600, next.scanIntervalSeconds);
  }
  if (has('warningBurnRatio')) next.warningBurnRatio = clampNumber(patch.warningBurnRatio, 1, 100, next.warningBurnRatio);
  if (has('criticalBurnRatio')) next.criticalBurnRatio = clampNumber(patch.criticalBurnRatio, 1, 100, next.criticalBurnRatio);
  if (next.criticalBurnRatio < next.warningBurnRatio) {
    next.criticalBurnRatio = next.warningBurnRatio;
    errors.push('criticalBurnRatio raised to warningBurnRatio');
  }
  if (has('cacheWarningRate')) next.cacheWarningRate = rate(patch.cacheWarningRate, next.cacheWarningRate);
  if (has('cacheCriticalRate')) next.cacheCriticalRate = rate(patch.cacheCriticalRate, next.cacheCriticalRate);
  if (next.cacheCriticalRate > next.cacheWarningRate) {
    next.cacheCriticalRate = next.cacheWarningRate;
    errors.push('cacheCriticalRate lowered to cacheWarningRate');
  }
  if (has('cacheAlertMinutes')) next.cacheAlertMinutes = clampNumber(patch.cacheAlertMinutes, 1, 240, next.cacheAlertMinutes);
  if (has('requestRateWarningMultiplier')) {
    next.requestRateWarningMultiplier = clampNumber(patch.requestRateWarningMultiplier, 1, 100, next.requestRateWarningMultiplier);
  }
  if (has('minimumActiveRequests')) {
    next.minimumActiveRequests = Math.round(clampNumber(patch.minimumActiveRequests, 1, 1000, next.minimumActiveRequests));
  }
  if (has('minActiveBuckets')) {
    next.minActiveBuckets = Math.round(clampNumber(patch.minActiveBuckets, 2, 288, next.minActiveBuckets));
  }
  if (has('baselineMinRequests')) {
    next.baselineMinRequests = Math.round(clampNumber(patch.baselineMinRequests, 1, 1_000_000, next.baselineMinRequests));
  }
  if (has('baselineMinCoverageHours')) {
    next.baselineMinCoverageHours = clampNumber(patch.baselineMinCoverageHours, 0.25, 24, next.baselineMinCoverageHours);
  }
  if (has('cacheDeltaDeadband')) {
    next.cacheDeltaDeadband = clampNumber(patch.cacheDeltaDeadband, 0, 0.5, next.cacheDeltaDeadband);
  }
  if (has('cacheDeltaNotice')) {
    next.cacheDeltaNotice = clampNumber(patch.cacheDeltaNotice, 0.02, 0.95, next.cacheDeltaNotice);
  }
  if (next.cacheDeltaNotice <= next.cacheDeltaDeadband) {
    next.cacheDeltaNotice = Math.min(0.95, next.cacheDeltaDeadband + 0.01);
    errors.push('cacheDeltaNotice raised above cacheDeltaDeadband');
  }
  if (has('cacheHealthyRate')) {
    next.cacheHealthyRate = rate(patch.cacheHealthyRate, next.cacheHealthyRate);
  }
  if (next.cacheHealthyRate < next.cacheWarningRate) {
    next.cacheHealthyRate = next.cacheWarningRate;
    errors.push('cacheHealthyRate raised to cacheWarningRate');
  }
  if (has('criticalRequiresSecondaryEvidence')) {
    next.criticalRequiresSecondaryEvidence = patch.criticalRequiresSecondaryEvidence === true;
  }
  if (has('uncachedBurstMultiplier')) {
    next.uncachedBurstMultiplier = clampNumber(patch.uncachedBurstMultiplier, 1.2, 20, next.uncachedBurstMultiplier);
  }
  if (has('uncachedBurstMinTokens')) {
    next.uncachedBurstMinTokens = Math.round(clampNumber(patch.uncachedBurstMinTokens, 0, 1_000_000_000, next.uncachedBurstMinTokens));
  }
  if (has('sessionDominanceShare')) {
    next.sessionDominanceShare = clampNumber(patch.sessionDominanceShare, 0.3, 1, next.sessionDominanceShare);
  }
  if (has('contextGrowthMultiplier')) {
    next.contextGrowthMultiplier = clampNumber(patch.contextGrowthMultiplier, 1.1, 10, next.contextGrowthMultiplier);
  }
  if (has('costSpike10m')) next.costSpike10m = clampNumber(patch.costSpike10m, 0.01, 1_000_000, next.costSpike10m);
  if (has('balanceAlerts')) {
    const rows = Array.isArray(patch.balanceAlerts) ? patch.balanceAlerts : [];
    const cleaned = rows
      .map((row) => Number(row))
      .filter((row) => Number.isFinite(row) && row >= BALANCE_ALERT_MIN && row <= 1_000_000)
      .slice(0, 8)
      .sort((a, b) => b - a);
    if (cleaned.length === 0) errors.push('balanceAlerts needs at least one positive amount');
    else next.balanceAlerts = [...new Set(cleaned)];
  }
  if (has('pricingOverrides')) {
    const overrides = {};
    if (patch.pricingOverrides && typeof patch.pricingOverrides === 'object') {
      for (const [model, row] of Object.entries(patch.pricingOverrides)) {
        if (typeof model !== 'string' || model.length === 0 || model.length > 120) continue;
        if (!row || typeof row !== 'object') continue;
        const priceRow = {
          cacheHit: clampNumber(row.cacheHit, 0, 1_000_000, Number.NaN),
          cacheMiss: clampNumber(row.cacheMiss, 0, 1_000_000, Number.NaN),
          output: clampNumber(row.output, 0, 1_000_000, Number.NaN),
        };
        if ([priceRow.cacheHit, priceRow.cacheMiss, priceRow.output].some((value) => Number.isNaN(value))) {
          errors.push(`pricingOverrides.${model} needs non-negative numbers`);
          continue;
        }
        overrides[model] = priceRow;
      }
    }
    next.pricingOverrides = overrides;
  }
  if (has('holidays')) {
    const rows = Array.isArray(patch.holidays) ? patch.holidays : [];
    next.holidays = rows
      .filter((row) => typeof row === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row))
      .slice(0, 60);
  }
  if (has('retentionDays')) next.retentionDays = clampNumber(patch.retentionDays, 1, 30, next.retentionDays);
  if (has('exposeDiagnosticsFile')) next.exposeDiagnosticsFile = patch.exposeDiagnosticsFile === true;

  return { settings: next, errors };
}

/**
 * Resolve which currency cost estimates are expressed in.
 * `auto` follows the signed-in wallet; without a wallet the DeepSeek API's
 * official pricing currency (USD) is used. No exchange-rate conversion happens
 * anywhere: estimates are always computed in the chosen currency's own table.
 * @param {typeof DEFAULT_SETTINGS} settings
 * @param {{ currency: string } | null} primaryWallet
 * @returns {'CNY' | 'USD'}
 */
export function resolveCurrency(settings, primaryWallet) {
  if (settings.currency === 'CNY' || settings.currency === 'USD') return settings.currency;
  if (primaryWallet && (primaryWallet.currency === 'CNY' || primaryWallet.currency === 'USD')) {
    return primaryWallet.currency;
  }
  return 'USD';
}

/**
 * Default DSH home directory.
 * @returns {string}
 */
export function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return join(homedir(), '.dsh');
}

/**
 * @typedef {object} MonitorState
 * @property {number} version
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Array<object>} requests
 * @property {Record<string, object>} sessions
 * @property {{ history: Record<string, Array<[number, number]>>, lastWallets: object[], lastBonusWallets: object[], lastFetchedAt: number | null, lastError: string | null, lastAttemptAt: number | null }} balance
 * @property {Record<string, object>} anomalyMemory
 * @property {{ startedAt: number, lastScanAt: number | null, lastScanErrors: number }} meta
 */

/** @returns {MonitorState} */
export function emptyState(now = Date.now()) {
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    requests: [],
    sessions: {},
    balance: {
      history: {},
      lastWallets: [],
      lastBonusWallets: [],
      lastFetchedAt: null,
      lastError: null,
      lastAttemptAt: null,
    },
    anomalyMemory: {},
    meta: { startedAt: now, lastScanAt: null, lastScanErrors: 0 },
  };
}

/**
 * Fill defaults into a state loaded from disk and drop structurally broken rows.
 * @param {unknown} raw
 * @returns {MonitorState}
 */
export function normalizeState(raw) {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const state = /** @type {Record<string, any>} */ (raw);
  if (state.version !== STATE_VERSION) return base;
  base.createdAt = Number.isFinite(state.createdAt) ? state.createdAt : base.createdAt;
  base.updatedAt = Number.isFinite(state.updatedAt) ? state.updatedAt : base.updatedAt;
  if (Array.isArray(state.requests)) {
    base.requests = state.requests.filter(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        Number.isFinite(row.t) &&
        typeof row.sid === 'string' &&
        Number.isFinite(row.seq),
    );
  }
  if (state.sessions && typeof state.sessions === 'object') base.sessions = state.sessions;
  const balance = state.balance && typeof state.balance === 'object' ? state.balance : {};
  base.balance.history = balance.history && typeof balance.history === 'object' ? balance.history : {};
  base.balance.lastWallets = Array.isArray(balance.lastWallets) ? balance.lastWallets : [];
  base.balance.lastBonusWallets = Array.isArray(balance.lastBonusWallets) ? balance.lastBonusWallets : [];
  base.balance.lastFetchedAt = Number.isFinite(balance.lastFetchedAt) ? balance.lastFetchedAt : null;
  base.balance.lastError = typeof balance.lastError === 'string' ? balance.lastError : null;
  base.balance.lastAttemptAt = Number.isFinite(balance.lastAttemptAt) ? balance.lastAttemptAt : null;
  if (state.anomalyMemory && typeof state.anomalyMemory === 'object') base.anomalyMemory = state.anomalyMemory;
  const meta = state.meta && typeof state.meta === 'object' ? state.meta : {};
  base.meta.startedAt = Number.isFinite(meta.startedAt) ? meta.startedAt : base.meta.startedAt;
  base.meta.lastScanAt = Number.isFinite(meta.lastScanAt) ? meta.lastScanAt : null;
  base.meta.lastScanErrors = Number.isFinite(meta.lastScanErrors) ? meta.lastScanErrors : 0;
  return base;
}

/**
 * Durable JSON storage with atomic replace and a debounced writer.
 */
export class MonitorStore {
  /** @param {string} [directory] */
  constructor(directory = join(dshHome(), 'usage-monitor')) {
    this.directory = directory;
    this.statePath = join(directory, 'state.json');
    this.settingsPath = join(directory, 'settings.json');
    this.statusPath = join(directory, 'status.json');
    this.ready = false;
    this.writeTimer = null;
    this.writeInFlight = null;
    this.pending = null;
  }

  /** Create the data directory. */
  async ensure() {
    if (this.ready) return;
    await mkdir(this.directory, { recursive: true });
    this.ready = true;
  }

  /**
   * Read one JSON file, moving a corrupt file aside instead of crashing.
   * @param {string} path
   * @returns {Promise<unknown | undefined>}
   */
  async readJson(path) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error && /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
      try {
        await rename(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        // A rename failure only loses the backup; the plugin still starts clean.
      }
      return undefined;
    }
  }

  /**
   * Load state and settings from disk.
   * @returns {Promise<{ state: MonitorState, settings: typeof DEFAULT_SETTINGS, hasSettingsFile: boolean }>}
   */
  async load() {
    await this.ensure();
    const [rawState, rawSettings] = await Promise.all([this.readJson(this.statePath), this.readJson(this.settingsPath)]);
    const state = normalizeState(rawState);
    const { settings } = normalizeSettings(
      rawSettings && typeof rawSettings === 'object' ? /** @type {Record<string, unknown>} */ (rawSettings) : {},
      DEFAULT_SETTINGS,
    );
    return { state, settings, hasSettingsFile: rawSettings !== undefined };
  }

  /**
   * Persist state atomically. Writes are coalesced: at most one runs at a time
   * and a newer request replaces an older queued one.
   * @param {MonitorState} state
   * @returns {Promise<void>}
   */
  async save(state) {
    await this.ensure();
    this.pending = state;
    if (this.writeInFlight) {
      await this.writeInFlight;
      if (this.pending !== state) return;
    }
    this.writeInFlight = (async () => {
      const snapshot = this.pending;
      this.pending = null;
      if (!snapshot) return;
      const text = JSON.stringify(snapshot);
      const temp = `${this.statePath}.tmp`;
      await writeFile(temp, text, 'utf8');
      await rename(temp, this.statePath);
    })();
    try {
      await this.writeInFlight;
    } finally {
      this.writeInFlight = null;
    }
  }

  /**
   * Persist a settings patch.
   * @param {typeof DEFAULT_SETTINGS} settings
   */
  async saveSettings(settings) {
    await this.ensure();
    const temp = `${this.settingsPath}.tmp`;
    await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8');
    await rename(temp, this.settingsPath);
  }

  /**
   * Write the opt-in support status file.
   * @param {unknown} status
   */
  async writeStatus(status) {
    await this.ensure();
    const temp = `${this.statusPath}.tmp`;
    await writeFile(temp, JSON.stringify(status, null, 2), 'utf8');
    await rename(temp, this.statusPath);
  }

  /** Cancel a pending debounce (dispose path). */
  dispose() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
  }
}
