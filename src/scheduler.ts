import { EventEmitter } from "node:events";
import {
  CpeApiError,
  type EphemeralCpeSession,
  type HuaweiCpeClient,
  ReentrantCpeSessionError,
  isInsideCpeSession,
} from "./cpe-client.ts";
import {
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type GlobalTelemetrySnapshot,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type SecurityUpdateCommand,
  type TerminalTopologySnapshot,
  type AntennaModeName,
  applyBandLock,
  applyCellLock,
  fetchGlobalTelemetry,
  fetchRouterSettings,
  fetchTerminalTopology,
  prepareBandLockPayloads,
  prepareCellLockPayload,
  rebootCpe,
  scanNeighborCells,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
  validateSecurityUpdateCommand,
} from "./cpe-domain.ts";
import { t } from "./i18n.ts";
import type { AlertEventRecord, EncryptedStateStore } from "./state-store.ts";
import type {
  TimeSeriesQueryParams,
  TimeSeriesQueryResult,
  TimeSeriesRingBuffer,
} from "./timeseries.ts";
import type { CircuitBreakerState } from "./types.ts";

export type SchedulerMode =
  | "idle"
  | "polling"
  | "yielding_browser"
  | "circuit_tripped"
  | "cpe_unreachable";

export type SchedulerPriority = "high" | "normal" | "low";

export interface AvoidanceBroadcastPayload {
  active: boolean;
  layer: 1 | 2 | null;
  stateCode: string | null;
  sinceIso: string | null;
  cooldownUntilMs: number | null;
  messageZh: string;
  messageEn: string;
}

export interface SpeedTickPayload {
  tsMs: number;
  tsIso: string;
  downloadBps: number;
  uploadBps: number;
  downloadRateFormatted: string;
  uploadRateFormatted: string;
}

export interface ControlAppliedEvent {
  action: string;
  tsIso: string;
  summaryZh: string;
  summaryEn: string;
  lockState?: PersistedLockState;
}

export interface SchedulerStatusSnapshot {
  mode: SchedulerMode;
  running: boolean;
  avoidance: AvoidanceBroadcastPayload;
  circuitBreaker: CircuitBreakerState;
  lastSessionHoldMs: number | null;
  totalSessionsCompleted: number;
  browserYieldCount: number;
  queueDepth: number;
  lastError: string | null;
}

export class BrowserSessionYieldedError extends Error {
  readonly statusCode = 409;
  readonly messageZh: string;
  readonly messageEn: string;

  constructor() {
    const zh = t("zh-CN", "controls.yielded_cannot_mutate");
    const en = t("en", "controls.yielded_cannot_mutate");
    super(zh);
    this.name = "BrowserSessionYieldedError";
    this.messageZh = zh;
    this.messageEn = en;
  }
}

export class SchedulerQueueFullError extends Error {
  readonly statusCode = 503;

  constructor(maxDepth: number) {
    super(`CPE session scheduler queue is full (maxDepth=${maxDepth}); retry shortly`);
    this.name = "SchedulerQueueFullError";
  }
}

export class SchedulerStoppedError extends Error {
  readonly statusCode = 503;

  constructor() {
    super("CPE session scheduler is stopping");
    this.name = "SchedulerStoppedError";
  }
}

export interface ControlSummary {
  zh: string;
  en: string;
  nextLockState?: PersistedLockState;
}

interface QueuedTask<T> {
  priority: SchedulerPriority;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const PRIORITY_WEIGHT: Readonly<Record<SchedulerPriority, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

export interface MutexSessionSchedulerOptions {
  client: HuaweiCpeClient;
  stateStore: EncryptedStateStore;
  timeseries: TimeSeriesRingBuffer;
  pollIntervalMs?: number;
  neighborScanIntervalMs?: number;
  stateFlushIntervalMs?: number;
  redactSensitive?: boolean;
  maxQueueDepth?: number;
  layer2InitialBackoffMs?: number;
  layer2MaxBackoffMs?: number;
  /** Piggyback `GET /api/sms/sms-count` on every telemetry session (SMS change detection). */
  smsCountersEnabled?: boolean;
}

/**
 * Single-instance Mutex Ephemeral Session Scheduler & Polite Browser Avoidance Engine.
 *
 * - Serializes all CPE access across background polling, Web REST triggers, and MCP Agent calls.
 * - Coalesces concurrent read-only telemetry/neighbor/topology/settings requests onto single-flight promises.
 * - Enforces dual-layer human browser avoidance (`state-login != -1` + cross-IP `108003` with exponential
 *   anti-flapping cooldown) and broadcasts transitions only when state changes. Avoidance follows the
 *   client's `respectBrowserSession` setting (`RESPECT_BROWSER_SESSION`, default `true`).
 * - Persists `108006`/`108007` circuit-breaker latches across restarts via `EncryptedStateStore`.
 */
export class MutexSessionScheduler extends EventEmitter {
  readonly client: HuaweiCpeClient;
  readonly stateStore: EncryptedStateStore;
  readonly timeseries: TimeSeriesRingBuffer;
  readonly pollIntervalMs: number;
  readonly neighborScanIntervalMs: number;
  readonly stateFlushIntervalMs: number;
  readonly redactSensitive: boolean;
  readonly maxQueueDepth: number;
  readonly layer2InitialBackoffMs: number;
  readonly layer2MaxBackoffMs: number;
  readonly smsCountersEnabled: boolean;

  #initialized = false;
  #running = false;
  #stopping = false;
  #mode: SchedulerMode = "idle";
  #lastError: string | null = null;

  #avoidanceActive = false;
  #avoidanceLayer: 1 | 2 | null = null;
  #avoidanceStateCode: string | null = null;
  #avoidanceSinceIso: string | null = null;
  #layer2CooldownUntilMs: number | null = null;
  #layer2CooldownUntilMono: number | null = null;
  #consecutiveLayer2Yields = 0;

  #queue: Array<QueuedTask<unknown>> = [];
  #draining = false;

  #inflightTelemetry: Promise<GlobalTelemetrySnapshot | null> | null = null;
  #inflightNeighbors: Promise<NeighborScanSnapshot | null> | null = null;
  #inflightTopology: Promise<TerminalTopologySnapshot | null> | null = null;
  #inflightSettings: Promise<RouterSettingsSnapshot | null> | null = null;

  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #slowScanTimer: ReturnType<typeof setInterval> | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MutexSessionSchedulerOptions) {
    super();
    this.client = options.client;
    this.stateStore = options.stateStore;
    this.timeseries = options.timeseries;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.neighborScanIntervalMs = options.neighborScanIntervalMs ?? 60000;
    this.stateFlushIntervalMs = options.stateFlushIntervalMs ?? 30 * 60 * 1000;
    this.redactSensitive = options.redactSensitive !== false;
    this.maxQueueDepth = options.maxQueueDepth ?? 32;
    this.layer2InitialBackoffMs = options.layer2InitialBackoffMs ?? 45_000;
    this.layer2MaxBackoffMs = options.layer2MaxBackoffMs ?? 300_000;
    this.smsCountersEnabled = options.smsCountersEnabled === true;
  }

  /**
   * Hydrate encrypted runtime state, time-series ring buffers, and circuit-breaker latches.
   */
  init(): void {
    if (this.#initialized) return;
    const loaded = this.stateStore.load();
    this.timeseries.restoreSnapshot(loaded.timeseries);
    const latched = this.client.hydrateCircuitBreaker(loaded.circuitBreaker);
    if (latched) {
      this.#mode = "circuit_tripped";
    }
    this.#initialized = true;
  }

  /**
   * Start background polling, low-frequency neighbor/topology sweeps, and periodic encrypted flushes.
   */
  start(): void {
    this.init();
    this.#stopping = false;
    if (this.#running) return;
    this.#running = true;

    // Immediate non-blocking seed sweep
    void this.refreshTelemetry().catch(() => undefined);
    void this.refreshTopology().catch(() => undefined);

    this.#pollTimer = setInterval(() => {
      void this.refreshTelemetry().catch(() => undefined);
    }, this.pollIntervalMs);
    this.#pollTimer.unref?.();

    this.#slowScanTimer = setInterval(() => {
      void this.refreshNeighbors().catch(() => undefined);
      void this.refreshTopology().catch(() => undefined);
    }, this.neighborScanIntervalMs);
    this.#slowScanTimer.unref?.();

    this.#flushTimer = setInterval(() => {
      this.stateStore.update({ timeseries: this.timeseries.toSnapshot() });
      void this.stateStore.flushAsync().catch(() => undefined);
    }, this.stateFlushIntervalMs);
    this.#flushTimer.unref?.();
  }

  /**
   * Gracefully stop timers, reject unstarted queued tasks, drain any in-flight CPE `logout()`, and flush encrypted state.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#stopping = true;
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#slowScanTimer) {
      clearInterval(this.#slowScanTimer);
      this.#slowScanTimer = null;
    }
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }

    for (const queued of this.#queue.splice(0)) {
      queued.reject(new SchedulerStoppedError());
    }

    await this.client.waitForIdle(4000);
    if (!this.#initialized) {
      return;
    }
    this.stateStore.update({
      circuitBreaker: this.client.getCircuitBreakerState(),
      timeseries: this.timeseries.toSnapshot(),
    });
    await this.stateStore.flushAsync();
  }

  getAvoidanceState(): AvoidanceBroadcastPayload {
    return {
      active: this.#avoidanceActive,
      layer: this.#avoidanceLayer,
      stateCode: this.#avoidanceStateCode,
      sinceIso: this.#avoidanceSinceIso,
      cooldownUntilMs: this.#layer2CooldownUntilMs,
      messageZh: this.#avoidanceActive
        ? t("zh-CN", "session.mode_yielding")
        : t("zh-CN", "session.mode_idle"),
      messageEn: this.#avoidanceActive
        ? t("en", "session.mode_yielding")
        : t("en", "session.mode_idle"),
    };
  }

  getStatus(): SchedulerStatusSnapshot {
    const telemetry = this.client.getTelemetry();
    const cb = telemetry.circuitBreaker;
    const effectiveMode: SchedulerMode = cb.tripped ? "circuit_tripped" : this.#mode;
    return {
      mode: effectiveMode,
      running: this.#running,
      avoidance: this.getAvoidanceState(),
      circuitBreaker: {
        tripped: cb.tripped,
        code: cb.code,
        reason: cb.reason,
        trippedAtIso: cb.trippedAtIso,
        remainCount: cb.remainCount ?? null,
        waitTime: cb.waitTime ?? null,
      },
      lastSessionHoldMs: telemetry.lastSessionHoldMs,
      totalSessionsCompleted: telemetry.totalSessionsCompleted,
      browserYieldCount: telemetry.browserYieldCount,
      queueDepth: this.#queue.length,
      lastError: this.#lastError,
    };
  }

  getCachedTelemetry(): GlobalTelemetrySnapshot | null {
    return this.stateStore.getState().latestTelemetry;
  }

  getCachedNeighbors(): NeighborScanSnapshot | null {
    return this.stateStore.getState().latestNeighbors;
  }

  getCachedTopology(): TerminalTopologySnapshot | null {
    return this.stateStore.getState().latestTopology;
  }

  getCachedSettings(): RouterSettingsSnapshot | null {
    return this.stateStore.getState().latestSettings;
  }

  getPersistedLockState(): PersistedLockState {
    return this.stateStore.getState().lockState;
  }

  getRecentAlerts(): ReadonlyArray<AlertEventRecord> {
    return this.stateStore.getState().recentAlerts;
  }

  queryTimeSeries(params: TimeSeriesQueryParams): TimeSeriesQueryResult {
    return this.timeseries.query(params);
  }

  /**
   * Reload credentials & reset the anti-brute-force circuit breaker after human updates `.env`.
   * Enforces 铁律五: refuses to clear a wrong-password latch (`108006`/`108002`/`108001`) if the
   * configured password has not changed, preventing accidental exhaustion of remaining strikes to `108007`.
   */
  async reloadCredentialsAndResetBreaker(
    newPassword: string,
    newUsername?: string
  ): Promise<CircuitBreakerState> {
    const latched = this.client.getCircuitBreakerState();
    const changed = this.client.reloadCredentials(newPassword, newUsername);
    if (!changed && latched.tripped && latched.code !== "108007") {
      throw new CpeControlValidationError(
        "Circuit breaker latched on wrong password; update CPE_PASSWORD in .env before resetting"
      );
    }
    if (!changed) {
      this.client.resetCircuitBreaker();
    }
    const cb = this.client.getCircuitBreakerState();
    this.#mode = "idle";
    this.#lastError = null;
    this.stateStore.update({ circuitBreaker: cb });
    await this.stateStore.flushAsync();
    return {
      tripped: cb.tripped,
      code: cb.code,
      reason: cb.reason,
      trippedAtIso: cb.trippedAtIso,
      remainCount: cb.remainCount ?? null,
      waitTime: cb.waitTime ?? null,
    };
  }

  /**
   * Run an arbitrary read-only CPE session through the shared queue with the same breaker,
   * browser-avoidance and Layer-2 cooldown semantics as the built-in refreshes.
   * Resolves `null` when the session was skipped or yielded to a human administrator.
   */
  executeRead<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    opts: { priority?: SchedulerPriority; ignoreCooldown?: boolean } = {}
  ): Promise<T | null> {
    return this.#runReadSession(opts.priority ?? "normal", fn, { ignoreCooldown: opts.ignoreCooldown });
  }

  /**
   * Record an alert in the encrypted state (bounded history), persist it, and push it to
   * `alert` listeners (SSE, Telegram, webhooks).
   */
  raiseAlert(alert: Omit<AlertEventRecord, "id" | "tsIso">): AlertEventRecord {
    const record = this.stateStore.appendAlert(alert);
    void this.stateStore.flushAsync().catch(() => undefined);
    this.#safeEmit("alert", record);
    return record;
  }

  #safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (listenerErr) {
      this.#lastError = `"${event}" listener failed: ${
        listenerErr instanceof Error ? listenerErr.message : String(listenerErr)
      }`;
    }
  }

  #enqueue<T>(priority: SchedulerPriority, execute: () => Promise<T>): Promise<T> {
    if (isInsideCpeSession(this.client)) {
      return Promise.reject(new ReentrantCpeSessionError());
    }
    if (this.#stopping) {
      return Promise.reject(new SchedulerStoppedError());
    }
    if (this.#queue.length >= this.maxQueueDepth) {
      return Promise.reject(new SchedulerQueueFullError(this.maxQueueDepth));
    }
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<unknown> = {
        priority,
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      };
      this.#queue.push(task);
      // Array.prototype.sort is guaranteed stable in ES2019+, preserving exact FIFO order per priority
      this.#queue.sort((a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]);
      void this.#drainQueue();
    });
  }

  async #drainQueue(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift()!;
        try {
          const val = await next.execute();
          next.resolve(val);
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  #enterAvoidance(layer: 1 | 2, stateCode: string): void {
    const nowMs = Date.now();
    if (layer === 2) {
      this.#consecutiveLayer2Yields += 1;
      const expDelay = Math.min(
        this.layer2MaxBackoffMs,
        this.layer2InitialBackoffMs * 2 ** (this.#consecutiveLayer2Yields - 1)
      );
      const jitter = Math.round(expDelay * 0.05);
      const cooldownSpan = expDelay + jitter;
      this.#layer2CooldownUntilMs = nowMs + cooldownSpan;
      this.#layer2CooldownUntilMono = performance.now() + cooldownSpan;
    }

    const wasActive = this.#avoidanceActive;
    this.#avoidanceActive = true;
    this.#avoidanceLayer = layer;
    this.#avoidanceStateCode = stateCode;
    this.#mode = "yielding_browser";

    if (!wasActive) {
      this.#avoidanceSinceIso = new Date(nowMs).toISOString();
      const payload = this.getAvoidanceState();
      this.#safeEmit("session:avoidance", payload);
    }
  }

  #clearAvoidanceIfActive(): void {
    const wasActive = this.#avoidanceActive;
    this.#avoidanceActive = false;
    this.#avoidanceLayer = null;
    this.#avoidanceStateCode = null;
    this.#avoidanceSinceIso = null;
    this.#layer2CooldownUntilMs = null;
    this.#layer2CooldownUntilMono = null;
    this.#consecutiveLayer2Yields = 0;

    if (wasActive) {
      const resumedPayload: AvoidanceBroadcastPayload = {
        active: false,
        layer: null,
        stateCode: "-1",
        sinceIso: null,
        cooldownUntilMs: null,
        messageZh: t("zh-CN", "session.mode_resumed"),
        messageEn: t("en", "session.mode_resumed"),
      };
      this.#safeEmit("session:avoidance", resumedPayload);
    }
  }

  async #handleExecutionError(err: unknown, wasTripped: boolean): Promise<never> {
    this.#lastError = err instanceof Error ? err.message : String(err);
    const cb = this.client.getCircuitBreakerState();
    if (cb.tripped) {
      this.#mode = "circuit_tripped";
      if (!wasTripped) {
        const code = cb.code ?? "unknown";
        this.stateStore.update({ circuitBreaker: cb });
        const alert = this.stateStore.appendAlert({
          severity: "critical",
          code: `CIRCUIT_${code}`,
          messageZh: t("zh-CN", "session.mode_circuit_tripped", { code }),
          messageEn: t("en", "session.mode_circuit_tripped", { code }),
        });
        await this.stateStore.flushAsync().catch(() => undefined);
        this.#safeEmit("alert", alert);
      }
      throw err;
    }

    // A CPE error code or rejected input means the router answered; only transport failures mean unreachable
    this.#mode =
      err instanceof CpeApiError || err instanceof CpeControlValidationError
        ? "idle"
        : "cpe_unreachable";
    throw err;
  }

  async #runReadSession<T>(
    priority: SchedulerPriority,
    fn: (session: EphemeralCpeSession) => Promise<T>,
    opts: { ignoreCooldown?: boolean } = {}
  ): Promise<T | null> {
    return await this.#enqueue(priority, async () => {
      if (this.client.getCircuitBreakerState().tripped) {
        this.#mode = "circuit_tripped";
        return null;
      }

      // Layer-2 anti-flapping quiet window (monotonic clock immune to NTP steps)
      if (
        !opts.ignoreCooldown &&
        this.#avoidanceActive &&
        this.#avoidanceLayer === 2 &&
        this.#layer2CooldownUntilMono !== null &&
        performance.now() < this.#layer2CooldownUntilMono
      ) {
        return null;
      }

      const wasTripped = this.client.getCircuitBreakerState().tripped;
      this.#mode = "polling";
      try {
        const outcome = await this.client.withSessionDetailed(fn);
        if (outcome.status === "yielded") {
          this.#enterAvoidance(outcome.layer, outcome.stateCode);
          return null;
        }
        this.#clearAvoidanceIfActive();
        this.#mode = "idle";
        this.#lastError = null;
        return outcome.value;
      } catch (err) {
        return await this.#handleExecutionError(err, wasTripped);
      }
    });
  }

  /**
   * Coalesced high-frequency telemetry refresh (`5s` default poll + manual/MCP triggers).
   */
  refreshTelemetry(opts: { ignoreCooldown?: boolean } = {}): Promise<GlobalTelemetrySnapshot | null> {
    if (this.#inflightTelemetry && !opts.ignoreCooldown) {
      return this.#inflightTelemetry;
    }

    const promise = this.#runReadSession(
      "normal",
      (session) =>
        fetchGlobalTelemetry(session, {
          redactSensitive: this.redactSensitive,
          includeSmsCounters: this.smsCountersEnabled,
        }),
      opts
    )
      .then((snap) => {
        if (!snap) return null;
        this.timeseries.push({
          tsMs: snap.capturedAtMs,
          downloadBps: snap.traffic.downloadBps,
          uploadBps: snap.traffic.uploadBps,
          lteRsrpDbm: snap.rf.lteRsrpDbm,
          lteSinrDb: snap.rf.lteSinrDb,
          nrRsrpDbm: snap.rf.nrRsrpDbm,
          nrSinrDb: snap.rf.nrSinrDb,
          temperatureCelsius: snap.thermal.temperatureCelsius,
        });
        this.stateStore.update({ latestTelemetry: snap });

        const speedTick: SpeedTickPayload = {
          tsMs: snap.capturedAtMs,
          tsIso: snap.capturedAtIso,
          downloadBps: snap.traffic.downloadBps,
          uploadBps: snap.traffic.uploadBps,
          downloadRateFormatted: snap.traffic.downloadRateFormatted,
          uploadRateFormatted: snap.traffic.uploadRateFormatted,
        };
        this.#safeEmit("speed", speedTick);
        this.#safeEmit("telemetry", snap);
        return snap;
      })
      .finally(() => {
        if (this.#inflightTelemetry === promise) {
          this.#inflightTelemetry = null;
        }
      });

    if (!opts.ignoreCooldown) {
      this.#inflightTelemetry = promise;
    }
    return promise;
  }

  /**
   * Coalesced 4G/5G neighbor cell scan (`GET /api/device/nbrcellinfo`).
   */
  refreshNeighbors(opts: { ignoreCooldown?: boolean } = {}): Promise<NeighborScanSnapshot | null> {
    if (this.#inflightNeighbors && !opts.ignoreCooldown) {
      return this.#inflightNeighbors;
    }
    const promise = this.#runReadSession("low", (session) => scanNeighborCells(session), opts)
      .then((snap) => {
        if (!snap) return null;
        this.stateStore.update({ latestNeighbors: snap });
        this.#safeEmit("neighbors", snap);
        return snap;
      })
      .finally(() => {
        if (this.#inflightNeighbors === promise) {
          this.#inflightNeighbors = null;
        }
      });

    if (!opts.ignoreCooldown) {
      this.#inflightNeighbors = promise;
    }
    return promise;
  }

  /**
   * Coalesced LAN & Wi-Fi 7 terminal topology sweep (`HostInfo` + `topology`).
   */
  refreshTopology(opts: { ignoreCooldown?: boolean } = {}): Promise<TerminalTopologySnapshot | null> {
    if (this.#inflightTopology && !opts.ignoreCooldown) {
      return this.#inflightTopology;
    }
    const promise = this.#runReadSession(
      "low",
      (session) => fetchTerminalTopology(session, { sanitize: this.redactSensitive }),
      opts
    )
      .then((snap) => {
        if (!snap) return null;
        this.stateStore.update({ latestTopology: snap });
        this.#safeEmit("topology", snap);
        return snap;
      })
      .finally(() => {
        if (this.#inflightTopology === promise) {
          this.#inflightTopology = null;
        }
      });

    if (!opts.ignoreCooldown) {
      this.#inflightTopology = promise;
    }
    return promise;
  }

  /**
   * Coalesced router security, Wi-Fi 7 MLO, antenna, and mobile-data settings read.
   */
  refreshSettings(opts: { ignoreCooldown?: boolean } = {}): Promise<RouterSettingsSnapshot | null> {
    if (this.#inflightSettings && !opts.ignoreCooldown) {
      return this.#inflightSettings;
    }
    const promise = this.#runReadSession(
      "normal",
      (session) => fetchRouterSettings(session, { sanitize: this.redactSensitive }),
      opts
    )
      .then((snap) => {
        if (!snap) return null;
        this.stateStore.update({ latestSettings: snap });
        this.#safeEmit("settings", snap);
        return snap;
      })
      .finally(() => {
        if (this.#inflightSettings === promise) {
          this.#inflightSettings = null;
        }
      });

    if (!opts.ignoreCooldown) {
      this.#inflightSettings = promise;
    }
    return promise;
  }

  /**
   * Execute a high-priority control mutation.
   * Never hijacks an active human browser session: if a human is logged into `192.168.8.1`, throws
   * `BrowserSessionYieldedError` (`409 Conflict`) immediately instead of queuing a delayed surprise mutation.
   */
  async executeControl<T>(
    actionName: string,
    fn: (session: EphemeralCpeSession) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary)
  ): Promise<T> {
    return await this.#enqueue("high", async () => {
      const wasTripped = this.client.getCircuitBreakerState().tripped;
      try {
        const outcome = await this.client.withSessionDetailed(fn, {
          retriesOnOccupied: 0, // Zero auto-replay on writes
        });
        if (outcome.status === "yielded") {
          this.#enterAvoidance(outcome.layer, outcome.stateCode);
          throw new BrowserSessionYieldedError();
        }
        this.#clearAvoidanceIfActive();
        this.#mode = "idle";
        this.#lastError = null;

        const resolvedSummary =
          typeof summary === "function" ? summary(outcome.value) : summary;
        if (resolvedSummary?.nextLockState) {
          this.stateStore.update({ lockState: resolvedSummary.nextLockState });
          void this.stateStore.flushAsync().catch(() => undefined);
        }

        const appliedEvent: ControlAppliedEvent = {
          action: actionName,
          tsIso: resolvedSummary?.nextLockState?.updatedAtIso ?? new Date().toISOString(),
          summaryZh: resolvedSummary?.zh ?? actionName,
          summaryEn: resolvedSummary?.en ?? actionName,
          lockState: resolvedSummary?.nextLockState,
        };
        this.#safeEmit("control:applied", appliedEvent);
        return outcome.value;
      } catch (err) {
        if (err instanceof BrowserSessionYieldedError) {
          throw err;
        }
        return await this.#handleExecutionError(err, wasTripped);
      }
    });
  }

  // High-level domain control wrappers for REST & MCP consumers (pre-validate before enqueuing)
  async lockBands(command: BandLockCommand): Promise<PersistedLockState> {
    prepareBandLockPayloads(command);
    return await this.executeControl(
      "lock_band",
      (session) => applyBandLock(session, command),
      (state) => {
        const summaryText = `LTE=${JSON.stringify(state.lteBands)}, NR=${JSON.stringify(state.nrBands)}`;
        return {
          zh: t("zh-CN", "controls.band_lock_applied", { summary: summaryText }),
          en: t("en", "controls.band_lock_applied", { summary: summaryText }),
          nextLockState: state,
        };
      }
    );
  }

  async lockCell(command: CellLockCommand): Promise<PersistedLockState> {
    prepareCellLockPayload(command);
    return await this.executeControl(
      "lock_cell",
      (session) => applyCellLock(session, command),
      (state) => ({
        zh: t("zh-CN", "controls.cell_lock_applied", {
          rat: command.rat,
          band: String(command.band),
          arfcn: command.arfcn,
        }),
        en: t("en", "controls.cell_lock_applied", {
          rat: command.rat,
          band: String(command.band),
          arfcn: command.arfcn,
        }),
        nextLockState: state,
      })
    );
  }

  async unlockAllLocks(): Promise<PersistedLockState> {
    return await this.executeControl(
      "unlock_rf_locks",
      (session) => unlockAllRfLocks(session),
      (state) => ({
        zh: t("zh-CN", "controls.unlock_all_applied"),
        en: t("en", "controls.unlock_all_applied"),
        nextLockState: state,
      })
    );
  }

  async rebootRouter(params: { confirm: boolean }): Promise<{ rebooting: true; requestedAtIso: string }> {
    if (params.confirm !== true) {
      throw new CpeControlValidationError(
        "Remote reboot rejected: explicit { confirm: true } is mandatory"
      );
    }
    return await this.executeControl(
      "reboot_cpe",
      (session) => rebootCpe(session, params),
      {
        zh: t("zh-CN", "controls.reboot_triggered"),
        en: t("en", "controls.reboot_triggered"),
      }
    );
  }

  async reconnectCellular(): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return await this.executeControl(
      "reconnect_cellular",
      (session) => triggerCellularReconnect(session),
      {
        zh: t("zh-CN", "controls.reconnect_triggered"),
        en: t("en", "controls.reconnect_triggered"),
      }
    );
  }

  /**
   * Fold a confirmed settings write into the cached snapshot and push it over SSE without a second
   * CPE session. Capture timestamps keep marking the last full read; nothing is emitted when no
   * snapshot has been read yet.
   */
  #patchCachedSettings(
    patch: (current: RouterSettingsSnapshot) => Partial<RouterSettingsSnapshot>
  ): void {
    const current = this.stateStore.getState().latestSettings;
    if (!current) return;
    const next: RouterSettingsSnapshot = { ...current, ...patch(current) };
    this.stateStore.update({ latestSettings: next });
    this.#safeEmit("settings", next);
  }

  async setSecuritySwitches(command: SecurityUpdateCommand): Promise<RouterSettingsSnapshot | null> {
    validateSecurityUpdateCommand(command);
    await this.executeControl(
      "set_security_switches",
      (session) => updateSecuritySettings(session, command),
      {
        zh: t("zh-CN", "controls.security_updated"),
        en: t("en", "controls.security_updated"),
      }
    );
    return await this.refreshSettings({ ignoreCooldown: true });
  }

  async setWifi7Settings(input: {
    mloEnable?: boolean;
    dbhoEnable?: boolean;
  }): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    if (input.mloEnable === undefined && input.dbhoEnable === undefined) {
      throw new CpeControlValidationError("Specify mloEnable and/or dbhoEnable");
    }
    const wifi7 = await this.executeControl(
      "set_wifi7_mlo",
      (session) => updateWifi7Mlo(session, input),
      {
        zh: t("zh-CN", "controls.wifi7_updated"),
        en: t("en", "controls.wifi7_updated"),
      }
    );
    this.#patchCachedSettings(() => ({ wifi7: { ...wifi7 } }));
    return wifi7;
  }

  async setAntennaMode(mode: AntennaModeName): Promise<{ mode: AntennaModeName; rawCode: number }> {
    if (mode !== "auto" && mode !== "internal" && mode !== "external") {
      throw new CpeControlValidationError(`Invalid antenna mode "${String(mode)}"`);
    }
    const antenna = await this.executeControl(
      "set_antenna_mode",
      (session) => updateAntennaMode(session, mode),
      {
        zh: t("zh-CN", "controls.antenna_updated", { mode }),
        en: t("en", "controls.antenna_updated", { mode }),
      }
    );
    this.#patchCachedSettings((current) => ({
      antenna: { ...current.antenna, mode: antenna.mode, rawCode: String(antenna.rawCode) },
    }));
    return antenna;
  }

  async setMobileData(enabled: boolean): Promise<{ mobileDataEnabled: boolean }> {
    const result = await this.executeControl(
      "set_mobile_data",
      (session) => updateMobileDataSwitch(session, enabled),
      {
        zh: t("zh-CN", "controls.mobile_data_updated"),
        en: t("en", "controls.mobile_data_updated"),
      }
    );
    this.#patchCachedSettings(() => ({ mobileDataEnabled: result.mobileDataEnabled }));
    return result;
  }
}
