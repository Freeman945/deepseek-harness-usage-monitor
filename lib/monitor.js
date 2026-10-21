/**
 * Usage Monitor Host engine.
 *
 * Responsibilities:
 *  - read every stored Session through the official `sessionPersistence`
 *    service and follow live Sessions through the `session/event` feed;
 *  - poll the signed-in DeepSeek account wallet through the official
 *    `deepseekAccount` service (never more often than the configured interval);
 *  - aggregate everything locally and answer the Client's authenticated HTTP
 *    routes with the snapshot described by docs/API.md.
 *
 * The engine is deliberately dependency-free: Node built-ins plus the Host
 * services it declares in `inject`.
 */

import { buildSnapshot, rangeWindow } from './analytics.js';
import { createSessionRecord, foldSessionEvent } from './ingest.js';
import { DEFAULT_SETTINGS, MonitorStore, emptyState, normalizeSettings } from './store.js';
import { PRICING_SOURCE } from './pricing.js';

const API_PREFIX = '/api/usage-monitor';
const SNAPSHOT_TTL_MS = 1_000;
const SETTINGS_BODY_LIMIT = 64 * 1024;
const VERSION = '0.1.0';

/**
 * Parse a Platform wallet decimal string without manufacturing precision.
 * @param {unknown} value
 * @returns {number | null}
 */
function parseAmount(value) {
  if (typeof value !== 'string') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {string} pathname
 * @param {string} url
 */
function pathnameOf(url) {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return '';
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(text);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<unknown>}
 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { code: 'body-too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { code: 'invalid-json' }));
      }
    });
    req.on('error', reject);
  });
}

export class UsageMonitor {
  /**
   * @param {any} ctx Cordis context of the Host plugin
   * @param {Record<string, unknown>} config plugin row config
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config && typeof config === 'object' ? config : {};
    this.store = new MonitorStore();
    /** @type {any} */
    this.state = emptyState();
    /** @type {typeof DEFAULT_SETTINGS} */
    this.settings = { ...DEFAULT_SETTINGS };
    this.disposed = false;
    this.started = false;
    this.startError = null;
    this.scanInProgress = false;
    this.scanStartedAt = null;
    this.scanFinishedAt = null;
    this.scanErrors = 0;
    this.skippedSessions = 0;
    this.lastScanSessions = 0;
    this.balance = {
      state: 'unavailable',
      wallets: [],
      bonusWallets: [],
      primary: null,
      totalAll: null,
      currency: null,
      fetchedAt: null,
      error: null,
    };
    /** @type {Map<string, import('./ingest.js').RequestRow>} */
    this.entries = new Map();
    this.entryCountAtLoad = 0;
    this.timers = new Set();
    this.dirty = false;
    this.saveTimer = null;
    this.saveInFlight = false;
    this.snapshotCache = null;
    this.snapshotVersion = 0;
    this.lastAccountPollAt = 0;
    this.balancePollBusy = false;
    this.lastStatusWriteAt = 0;
    this.reportedErrors = [];
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Load persisted data, start timers and kick off the first scan. Never
   * throws: a broken data directory is reported in the snapshot instead.
   */
  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const loaded = await this.store.load();
      this.state = loaded.state;
      this.settings = this.mergeConfig(loaded.settings, loaded.hasSettingsFile);
      this.entries = new Map();
      for (const row of this.state.requests) {
        if (row && typeof row === 'object' && typeof row.sid === 'string' && Number.isFinite(row.seq)) {
          this.entries.set(`${row.sid}:${row.seq}`, row);
        }
      }
      this.entryCountAtLoad = this.entries.size;
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
      this.state = emptyState();
      this.entries = new Map();
    }
    this.ctx.on('session/event', (session, event) => this.onSessionEvent(session, event));
    this.armTimers();
    // Initial work runs in the background; the UI shows a loading state.
    void this.scanSessions(true);
    void this.pollBalance(true);
  }

  /**
   * Apply plugin-row config on top of defaults, then saved user settings.
   * Row config only seeds values when the user has not saved settings yet.
   * @param {typeof DEFAULT_SETTINGS} saved
   * @param {boolean} hasSettingsFile
   * @returns {typeof DEFAULT_SETTINGS}
   */
  mergeConfig(saved, hasSettingsFile) {
    const { settings: fromConfig } = normalizeSettings(this.config, DEFAULT_SETTINGS);
    if (!hasSettingsFile) return fromConfig;
    return saved;
  }

  /** Stop timers and flush the last state update. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (this.state) {
      void this.saveNow().catch(() => {});
    }
  }

  /**
   * @param {() => void} fn
   * @param {number} delayMs
   * @param {boolean} [repeat]
   */
  timer(fn, delayMs, repeat = false) {
    const handle = repeat ? setInterval(fn, delayMs) : setTimeout(fn, delayMs);
    this.timers.add(handle);
    return handle;
  }

  armTimers() {
    const scanMs = Math.max(15, this.settings.scanIntervalSeconds) * 1000;
    this.timer(() => void this.scanSessions(false), scanMs, true);
    const balanceMs = Math.max(20, this.settings.balanceRefreshSeconds) * 1000;
    this.timer(() => void this.pollBalance(false), balanceMs, true);
    this.timer(() => {
      if (this.dirty) void this.saveNow().catch(() => {});
      if (this.settings.exposeDiagnosticsFile) void this.writeStatusFile().catch(() => {});
    }, 45_000, true);
    this.timer(() => this.prune(), 10 * 60_000, true);
  }

  // -------------------------------------------------------------------- dirty

  markDirty() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) void this.saveNow().catch(() => {});
    }, 15_000);
  }

  async saveNow() {
    if (!this.state || this.saveInFlight) return;
    this.saveInFlight = true;
    try {
      this.state.requests = [...this.entries.values()];
      this.state.updatedAt = Date.now();
      await this.store.save(this.state);
      this.dirty = false;
    } catch (error) {
      this.reportError('save', error);
    } finally {
      this.saveInFlight = false;
    }
  }

  /**
   * @param {string} scope
   * @param {unknown} error
   */
  reportError(scope, error) {
    const message = `${scope}: ${error instanceof Error ? error.message : String(error)}`;
    this.reportedErrors.push({ t: Date.now(), message });
    if (this.reportedErrors.length > 20) this.reportedErrors.shift();
    try {
      this.ctx.logger?.warn(`usage-monitor: ${message}`);
    } catch {
      // Logging is best-effort; never fail the engine for it.
    }
  }

  // ------------------------------------------------------------------- sessions

  /**
   * @param {any} header
   * @returns {import('./ingest.js').SessionRecord}
   */
  recordFor(header) {
    const id = String(header.id);
    let record = this.state.sessions[id];
    if (!record) {
      record = createSessionRecord(header);
      this.state.sessions[id] = record;
    } else {
      if (typeof header.cwd === 'string') record.cwd = header.cwd;
      if (typeof header.agentPreset === 'string') record.preset = header.agentPreset;
      if (header.origin === 'subagent') record.origin = 'subagent';
      if (typeof header.parentSession === 'string') record.parent = header.parentSession;
      if (Number.isFinite(header.delegationDepth)) record.depth = header.delegationDepth;
    }
    if (!record.signals) record.signals = createSessionRecord(header).signals;
    return record;
  }

  /**
   * Apply one durable event and keep the entry index in sync.
   * @param {import('./ingest.js').SessionRecord} record
   * @param {any} event
   */
  applyEvent(record, event) {
    const { add, removeSeq } = foldSessionEvent(record, event);
    if (removeSeq !== null) this.entries.delete(`${record.id}:${removeSeq}`);
    if (add !== null) this.entries.set(`${record.id}:${add.seq}`, add);
    return add !== null || removeSeq !== null;
  }

  /**
   * @param {import('node:events').EventEmitter | any} session
   * @param {any} event
   */
  onSessionEvent(session, event) {
    if (this.disposed || !this.state) return;
    try {
      const header = session?.header;
      if (!header) return;
      const record = this.recordFor(header);
      const changed = this.applyEvent(record, event);
      if (changed) {
        this.invalidateSnapshot();
        this.markDirty();
      }
    } catch (error) {
      this.reportError('session-event', error);
    }
  }

  /**
   * Walk every stored Session through the official persistence service.
   * @param {boolean} initial
   */
  async scanSessions(initial) {
    if (this.disposed || this.scanInProgress) return;
    const persistence = this.ctx.get('sessionPersistence');
    if (!persistence) {
      this.reportError('scan', new Error('sessionPersistence service is unavailable'));
      return;
    }
    this.scanInProgress = true;
    this.scanStartedAt = Date.now();
    this.scanErrors = 0;
    this.skippedSessions = 0;
    let sessions = 0;
    try {
      const snapshots = await persistence.list();
      sessions = snapshots.length;
      for (const snapshot of snapshots) {
        if (this.disposed) break;
        const header = snapshot.header;
        const id = String(header.id);
        const record = this.recordFor(header);
        const revision = String(snapshot.revision ?? '');
        if (!initial && record.revision === revision) continue;
        try {
          const handle = await persistence.open(id, 'read');
          try {
            let events = [];
            let incremental = !initial && record.lastSeq >= 0;
            if (incremental) {
              const tail = await handle.read(record.lastSeq + 1);
              events = [...tail.events];
              if (events.length > 0 && events[0].seq !== record.lastSeq + 1) {
                // The stored log was replaced or repaired; refold from the start.
                incremental = false;
                events = [];
              }
            }
            if (!incremental) {
              // Full re-read (first sight, replacement, or shrunken log):
              // rebuild this session's rows from scratch before applying.
              for (const key of [...this.entries.keys()]) {
                if (key.startsWith(`${id}:`)) this.entries.delete(key);
              }
              record.fold = null;
              record.signals = createSessionRecord(header).signals;
              record.lastSeq = -1;
              const full = await handle.read(0);
              events = [...full.events];
            }
            for (const event of events) this.applyEvent(record, event);
            record.revision = revision;
            record.lastAt = Date.now();
          } finally {
            await handle.close();
          }
        } catch (error) {
          this.scanErrors += 1;
          this.skippedSessions += 1;
          this.reportError(`scan ${id.slice(0, 24)}`, error);
        }
      }
      this.scanFinishedAt = Date.now();
      this.lastScanSessions = sessions;
      this.state.meta.lastScanAt = this.scanFinishedAt;
      this.state.meta.lastScanErrors = this.scanErrors;
      this.invalidateSnapshot();
      this.markDirty();
      this.prune();
    } catch (error) {
      this.scanErrors += 1;
      this.reportError('scan', error);
    } finally {
      this.scanInProgress = false;
    }
  }

  // -------------------------------------------------------------------- wallet

  /**
   * Poll the signed-in DeepSeek account wallet. Honest about every failure
   * mode: not signed in, account service absent, network/platform error.
   * @param {boolean} [force]
   */
  async pollBalance(force = false) {
    if (this.disposed || this.balancePollBusy) return;
    const now = Date.now();
    if (!force && now - this.lastAccountPollAt < this.settings.balanceRefreshSeconds * 1000) return;
    this.lastAccountPollAt = now;
    this.balancePollBusy = true;
    this.state.balance.lastAttemptAt = now;
    const account = this.ctx.get('deepseekAccount');
    if (!account) {
      this.balance = {
        ...this.balance,
        state: 'unavailable',
        error: 'The DeepSeek account service is not mounted in this profile, so the wallet balance cannot be read.',
      };
      this.balancePollBusy = false;
      this.invalidateSnapshot();
      return;
    }
    try {
      const metadata = {
        version: VERSION,
        locale: this.hostLocale(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
      const result = await account.getBalance(metadata);
      if (result === null) {
        this.balance = {
          state: 'signed-out',
          wallets: this.state.balance.lastWallets,
          bonusWallets: this.state.balance.lastBonusWallets,
          primary: this.primaryWallet(this.state.balance.lastWallets),
          totalAll: this.totalAll(this.state.balance.lastWallets, this.state.balance.lastBonusWallets),
          currency: this.primaryWallet(this.state.balance.lastWallets)?.currency ?? null,
          fetchedAt: this.state.balance.lastFetchedAt,
          error: 'Not signed in to a DeepSeek account in Harness. Sign in under Settings → Account to read the wallet balance.',
        };
        this.state.balance.lastError = this.balance.error;
      } else if (result.status !== 'ready') {
        this.balance = {
          state: 'error',
          wallets: this.state.balance.lastWallets,
          bonusWallets: this.state.balance.lastBonusWallets,
          primary: this.primaryWallet(this.state.balance.lastWallets),
          totalAll: this.totalAll(this.state.balance.lastWallets, this.state.balance.lastBonusWallets),
          currency: this.primaryWallet(this.state.balance.lastWallets)?.currency ?? null,
          fetchedAt: this.state.balance.lastFetchedAt,
          error: 'The DeepSeek Platform balance request failed. Previous samples are kept.',
        };
        this.state.balance.lastError = this.balance.error;
      } else {
        const wallets = Array.isArray(result.value) ? result.value : [];
        const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : [];
        const primary = this.primaryWallet(wallets);
        const currency = primary?.currency ?? (wallets[0]?.currency ?? null);
        this.balance = {
          state: 'ready',
          wallets,
          bonusWallets,
          primary,
          totalAll: this.totalAll(wallets, bonusWallets),
          currency,
          fetchedAt: now,
          error: null,
        };
        this.state.balance.lastWallets = wallets;
        this.state.balance.lastBonusWallets = bonusWallets;
        this.state.balance.lastFetchedAt = now;
        this.state.balance.lastError = null;
        if (currency !== null) {
          const total = this.totalAll(wallets, bonusWallets);
          if (total !== null) this.recordBalanceSample(currency, now, total);
        }
      }
      this.invalidateSnapshot();
      this.markDirty();
    } catch (error) {
      this.balance = {
        ...this.balance,
        state: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
      this.state.balance.lastError = this.balance.error;
      this.state.balance.lastAttemptAt = now;
      this.reportError('balance', error);
      this.invalidateSnapshot();
    } finally {
      this.balancePollBusy = false;
    }
  }

  /** @returns {string} */
  hostLocale() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    } catch {
      return 'en';
    }
  }

  /**
   * @param {Array<{ currency: string, balance: string }>} wallets
   * @returns {{ currency: string, amount: number } | null}
   */
  primaryWallet(wallets) {
    if (!Array.isArray(wallets) || wallets.length === 0) return null;
    const preferred = this.settings.currency === 'auto' ? null : this.settings.currency;
    const parsed = wallets
      .map((wallet) => ({ currency: wallet.currency, amount: parseAmount(wallet.balance) }))
      .filter((wallet) => wallet.amount !== null);
    if (parsed.length === 0) return null;
    const selected =
      (preferred && parsed.find((wallet) => wallet.currency === preferred)) ||
      parsed.find((wallet) => /** @type {number} */ (wallet.amount) > 0) ||
      parsed[0];
    return { currency: selected.currency, amount: /** @type {number} */ (selected.amount) };
  }

  /**
   * @param {Array<{ currency: string, balance: string }>} wallets
   * @param {Array<{ currency: string, balance: string }>} bonusWallets
   * @returns {number | null}
   */
  totalAll(wallets, bonusWallets) {
    const primary = this.primaryWallet(wallets);
    if (!primary) return null;
    let total = 0;
    for (const wallet of [...wallets, ...bonusWallets]) {
      if (wallet.currency !== primary.currency) continue;
      const amount = parseAmount(wallet.balance);
      if (amount !== null) total += amount;
    }
    return Math.round(total * 1e6) / 1e6;
  }

  /**
   * Append one wallet sample used for observed spend and forecast coverage.
   * @param {string} currency
   * @param {number} time
   * @param {number} total
   */
  recordBalanceSample(currency, time, total) {
    const history = this.state.balance.history;
    if (!Array.isArray(history[currency])) history[currency] = [];
    const list = history[currency];
    const last = list[list.length - 1];
    if (last && time - last[0] < Math.max(5_000, this.settings.balanceRefreshSeconds * 500) && Math.abs(last[1] - total) < 1e-9) {
      return;
    }
    list.push([time, total]);
    this.trimBalanceHistory(currency);
  }

  /** @param {string} currency */
  trimBalanceHistory(currency) {
    const list = this.state.balance.history[currency];
    if (!Array.isArray(list)) return;
    const cutoff = Date.now() - this.settings.retentionDays * 86_400_000;
    let index = 0;
    while (index < list.length && list[index][0] < cutoff) index += 1;
    if (index > 0) list.splice(0, index);
    if (list.length <= 720) return;
    // Downsample older than 24h to one sample every 10 minutes; keep the last
    // two hours at full resolution for accurate short-window spend.
    const denseFrom = Date.now() - 2 * 3_600_000;
    const downsampled = [];
    let lastKept = -Infinity;
    for (const sample of list) {
      if (sample[0] >= denseFrom) {
        downsampled.push(sample);
        continue;
      }
      if (sample[0] - lastKept >= 10 * 60_000) {
        downsampled.push(sample);
        lastKept = sample[0];
      }
    }
    this.state.balance.history[currency] = downsampled;
  }

  // -------------------------------------------------------------------- prune

  prune() {
    if (!this.state) return;
    const cutoff = Date.now() - this.settings.retentionDays * 86_400_000;
    for (const [key, row] of this.entries) {
      if (row.t < cutoff) this.entries.delete(key);
    }
    for (const [id, record] of Object.entries(this.state.sessions)) {
      if (!record.lastAt || record.lastAt < cutoff) {
        const hasEntries = [...this.entries.keys()].some((key) => key.startsWith(`${id}:`));
        if (!hasEntries) delete this.state.sessions[id];
      }
    }
    const memory = this.state.anomalyMemory;
    const memoryCutoff = Date.now() - 2 * 86_400_000;
    for (const [key, value] of Object.entries(memory)) {
      if (!value || typeof value !== 'object') delete memory[key];
      else if (Number.isFinite(value.lastSeen) && value.lastSeen < memoryCutoff) delete memory[key];
    }
    this.invalidateSnapshot();
  }

  // ------------------------------------------------------------------ snapshot

  invalidateSnapshot() {
    this.snapshotVersion += 1;
    this.snapshotCache = null;
  }

  /**
   * @param {string} range
   * @returns {any}
   */
  snapshot(range) {
    const now = Date.now();
    const key = `${range}:${this.snapshotVersion}:${Math.floor(now / 1000)}`;
    if (this.snapshotCache && this.snapshotCache.key === key) return this.snapshotCache.value;
    const beforeMemory = JSON.stringify(this.state.anomalyMemory ?? {});
    const value = buildSnapshot({
      state: this.state,
      settings: this.settings,
      locale: this.hostLocale(),
      now,
      balance: { ...this.balance, liveSessions: this.ctx.get('sessions')?.list?.().length ?? 0 },
      scan: {
        startedAt: this.scanStartedAt,
        finishedAt: this.scanFinishedAt,
        inProgress: this.scanInProgress,
        sessions: this.lastScanSessions,
        errors: this.skippedSessions,
      },
      range,
    });
    const afterMemory = JSON.stringify(this.state.anomalyMemory ?? {});
    if (beforeMemory !== afterMemory) {
      this.markDirty();
    }
    if (this.reportedErrors.length > 0) {
      value.diagnostics.warnings.push(...this.reportedErrors.slice(-3).map((row) => row.message));
    }
    this.snapshotCache = { key, value };
    return value;
  }

  // ---------------------------------------------------------------------- http

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async handleHttp(req, res) {
    try {
      const pathname = pathnameOf(String(req.url ?? ''));
      if (pathname === `${API_PREFIX}/health`) {
        sendJson(res, 200, { ok: true, version: VERSION, uptimeMs: Date.now() - (this.state?.meta?.startedAt ?? Date.now()) });
        return;
      }
      const connection = this.ctx.get('connection');
      const rejection = connection?.requestRejection?.(req);
      if (rejection !== undefined) {
        sendJson(res, rejection, { error: { code: 'unauthenticated', message: 'Open the Harness page to use the usage monitor.' } });
        return;
      }
      if (pathname === `${API_PREFIX}/snapshot`) {
        if (req.method !== 'GET') return this.methodNotAllowed(res, 'GET');
        const query = new URL(String(req.url ?? ''), 'http://localhost').searchParams;
        const requested = query.get('range') ?? '24h';
        const range = rangeWindow(Date.now(), requested).range;
        sendJson(res, 200, this.snapshot(range));
        return;
      }
      if (pathname === `${API_PREFIX}/settings`) {
        if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST');
        if (!this.isJson(req)) {
          sendJson(res, 415, { error: { code: 'unsupported-media-type', message: 'content-type must be application/json' } });
          return;
        }
        const body = await readJsonBody(req, SETTINGS_BODY_LIMIT);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          sendJson(res, 400, { error: { code: 'invalid-settings', message: 'settings must be a JSON object' } });
          return;
        }
        const { settings, errors } = normalizeSettings(/** @type {Record<string, unknown>} */ (body), this.settings);
        const changed = JSON.stringify(settings) !== JSON.stringify(this.settings);
        if (changed) {
          this.settings = settings;
          this.resetTimers();
          await this.store.saveSettings(settings);
          this.markDirty();
          this.invalidateSnapshot();
          void this.pollBalance(true);
        }
        const snapshot = this.snapshot('24h');
        if (errors.length > 0) snapshot.diagnostics.warnings.push(...errors);
        sendJson(res, 200, snapshot);
        return;
      }
      if (pathname === `${API_PREFIX}/refresh`) {
        if (req.method !== 'POST') return this.methodNotAllowed(res, 'POST');
        await this.pollBalance(true);
        void this.scanSessions(false);
        sendJson(res, 200, this.snapshot('24h'));
        return;
      }
      sendJson(res, 404, { error: { code: 'not-found', message: `no route for ${pathname}` } });
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      if (code === 'body-too-large' || code === 'invalid-json') {
        sendJson(res, 400, { error: { code: 'invalid-settings', message: error instanceof Error ? error.message : 'invalid body' } });
        return;
      }
      this.reportError('http', error);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal-error', message: 'The usage monitor failed to build a snapshot.' } });
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  isJson(req) {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    return essence === 'application/json';
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} allowed
   */
  methodNotAllowed(res, allowed) {
    res.setHeader('allow', allowed);
    sendJson(res, 405, { error: { code: 'method-not-allowed', message: `use ${allowed}` } });
  }

  // -------------------------------------------------------------------- status

  /** Write the opt-in diagnostics snapshot used by `npm run verify:live`. */
  async writeStatusFile() {
    if (!this.state || this.disposed) return;
    const now = Date.now();
    if (now - this.lastStatusWriteAt < 30_000) return;
    this.lastStatusWriteAt = now;
    try {
      const snapshot = this.snapshot('24h');
      const status = {
        plugin: 'deepseek-harness-usage-monitor',
        version: VERSION,
        generatedAt: now,
        status: snapshot.status,
        pricingSource: PRICING_SOURCE,
        balance: {
          state: snapshot.balance.state,
          primary: snapshot.balance.primary,
          bonusWallets: snapshot.balance.bonusWallets,
          fetchedAt: snapshot.balance.fetchedAt,
          observedSince: snapshot.balance.observedSince,
          error: snapshot.balance.error,
        },
        cost: {
          currency: snapshot.cost.currency,
          windows: snapshot.cost.windows,
        },
        burn: snapshot.burn,
        cache: {
          hitRate: snapshot.cache.last1h.hitRate,
          hitTokens: snapshot.cache.last1h.hitTokens,
          missTokens: snapshot.cache.last1h.missTokens,
          baseline: snapshot.cache.baseline.hitRate,
          diagnosis: snapshot.cache.diagnosis.map((row) => row.code),
        },
        usage: {
          requests: snapshot.diagnostics.data.requestsInRetention,
          sessionsScanned: snapshot.diagnostics.sources.tokens.sessionsScanned,
          lastEventAt: snapshot.diagnostics.data.lastEventAt,
          models: snapshot.models.map((row) => ({ model: row.model, requests: row.requests, cost: row.cost, priced: row.priced })),
        },
        forecast: snapshot.forecast,
        scan: snapshot.diagnostics.scan,
        warnings: snapshot.diagnostics.warnings,
        errors: this.reportedErrors.slice(-5),
      };
      await this.store.writeStatus(status);
    } catch (error) {
      this.reportError('status-file', error);
    }
  }

  resetTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers.clear();
    this.armTimers();
  }
}

export { API_PREFIX };
