import { EventEmitter } from "node:events";
import type { AccessControlSnapshot } from "./access-control.ts";
import { routerBackendOf } from "./backends/index.ts";
import type { CellularSettingsSnapshot } from "./cellular.ts";
import type { GlobalTelemetrySnapshot, NeighborScanSnapshot, RouterSettingsSnapshot, TerminalTopologySnapshot } from "./cpe-domain.ts";
import type { DeviceProbeResult } from "./device-profile.ts";
import type { ReadSection } from "./device-access.ts";
import type { RouterBackend } from "./router-backend.ts";
import type { RouterFamily } from "./router-family.ts";
import type { MutexSessionScheduler, SchedulerPriority } from "./scheduler.ts";
import type { EncryptedStateStore } from "./state-store.ts";
import type {
  TimeSeriesQueryParams,
  TimeSeriesQueryResult,
  TimeSeriesRingBuffer,
} from "./timeseries.ts";

export interface SpeedTickPayload {
  tsMs: number;
  tsIso: string;
  downloadBps: number;
  uploadBps: number;
  downloadRateFormatted: string;
  uploadRateFormatted: string;
}

export interface CpeMonitorOptions {
  scheduler: MutexSessionScheduler;
  stateStore: EncryptedStateStore;
  timeseries: TimeSeriesRingBuffer;
  pollIntervalMs?: number;
  neighborScanIntervalMs?: number;
  stateFlushIntervalMs?: number;
  /** Piggyback `GET /api/sms/sms-count` on every telemetry session (SMS change detection). */
  smsCountersEnabled?: boolean;
}

export interface RefreshOptions {
  /** Skip the Layer-2 quiet window and the single-flight join (explicit read-after-write). */
  ignoreCooldown?: boolean;
}

/** Failed identifications in a row after which catching up waits for the next start or connection test. */
const MAX_IDENTIFY_FAILURES = 3;

/**
 * Read side of FengSui: background polling, single-flight refreshes and cached snapshots.
 *
 * - Every refresh is one `MutexSessionScheduler.executeRead` session (on a router of a driver family,
 *   the driver's telemetry / neighbour read, in the same snapshot shapes; the sections such a family
 *   does not document are skipped); concurrent callers of the same refresh join the in-flight
 *   promise (Single-Flight Request Coalescing).
 * - Telemetry feeds the time-series ring buffer and emits `speed` + `telemetry`; sweeps emit
 *   `neighbors` / `topology` / `access-control`; settings reads emit `settings`.
 * - Snapshots live in the encrypted state store so a restart can serve the last known values. They
 *   always hold the plain values: REDACT_SENSITIVE_IN_API applies per response (src/redact.ts).
 */
export class CpeMonitor extends EventEmitter {
  readonly scheduler: MutexSessionScheduler;
  readonly stateStore: EncryptedStateStore;
  readonly timeseries: TimeSeriesRingBuffer;
  readonly pollIntervalMs: number;
  readonly neighborScanIntervalMs: number;
  readonly stateFlushIntervalMs: number;
  readonly smsCountersEnabled: boolean;

  #initialized = false;
  #running = false;
  #inflightTelemetry: Promise<GlobalTelemetrySnapshot | null> | null = null;
  #inflightNeighbors: Promise<NeighborScanSnapshot | null> | null = null;
  #inflightTopology: Promise<TerminalTopologySnapshot | null> | null = null;
  #inflightSettings: Promise<RouterSettingsSnapshot | null> | null = null;
  #inflightAccessControl: Promise<AccessControlSnapshot | null> | null = null;
  #inflightCellular: Promise<CellularSettingsSnapshot | null> | null = null;
  /** The cellular settings last read, for the brand they were read on (kept in memory: read when the console asks). */
  #cellular: { family: RouterFamily; snapshot: CellularSettingsSnapshot } | null = null;
  #inflightIdentify: Promise<DeviceProbeResult | null> | null = null;
  /** The identification asked for at start has not got in yet: it runs right after the next read that does. */
  #identifyPending = false;
  #identifyFailures = 0;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #slowScanTimer: ReturnType<typeof setInterval> | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;

  /** The backend of the router's family: every read goes through it, whatever the brand. */
  readonly #backend: () => RouterBackend;

  constructor(options: CpeMonitorOptions) {
    super();
    this.scheduler = options.scheduler;
    this.stateStore = options.stateStore;
    this.timeseries = options.timeseries;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.neighborScanIntervalMs = options.neighborScanIntervalMs ?? 60000;
    this.stateFlushIntervalMs = options.stateFlushIntervalMs ?? 30 * 60 * 1000;
    this.smsCountersEnabled = options.smsCountersEnabled === true;
    this.#backend = routerBackendOf(options.scheduler);
    // A poll or a write saw another model than the stored identification: the router was replaced
    this.scheduler.on("device:changed", () => {
      this.#identifyPending = true;
      this.#identifyFailures = 0;
    });
  }

  /** Load encrypted state (via the scheduler) and restore the time-series rings (idempotent). */
  init(): void {
    if (this.#initialized) return;
    this.scheduler.init();
    const state = this.stateStore.getState();
    this.timeseries.restoreSnapshot(state.timeseries);
    // Before v1.0.1, REDACT_SENSITIVE_IN_API masked snapshots at capture time, topology included
    // (with look-alike names and MACs). Serve nothing until the next sweep rather than serve those.
    if (state.latestTelemetry?.device.sensitiveRedacted) {
      this.stateStore.update({ latestTelemetry: null, latestTopology: null });
    }
    this.#initialized = true;
  }

  /** Start the 5 s telemetry poll, the slow neighbor/topology sweep and periodic encrypted flushes. */
  start(): void {
    this.init();
    this.scheduler.markRunning(true);
    if (this.#running) return;
    this.#running = true;

    // Immediate non-blocking seed sweep
    void this.refreshTelemetry().catch(() => undefined);
    this.#sweep("topology", () => this.refreshTopology());
    this.#sweep("accessControl", () => this.refreshAccessControl());

    this.#pollTimer = setInterval(() => {
      void this.refreshTelemetry().catch(() => undefined);
    }, this.pollIntervalMs);
    this.#pollTimer.unref?.();

    this.#slowScanTimer = setInterval(() => {
      this.#sweep("neighbors", () => this.refreshNeighbors());
      this.#sweep("topology", () => this.refreshTopology());
      this.#sweep("accessControl", () => this.refreshAccessControl());
    }, this.neighborScanIntervalMs);
    this.#slowScanTimer.unref?.();

    this.#flushTimer = setInterval(() => {
      this.stateStore.update({ timeseries: this.timeseries.toSnapshot() });
      void this.stateStore.flushAsync().catch(() => undefined);
    }, this.stateFlushIntervalMs);
    this.#flushTimer.unref?.();
  }

  /** A background read, left out for a section this model does not provide (a refresh someone asks for still tries). */
  #sweep(section: ReadSection, refresh: () => Promise<unknown>): void {
    if (this.scheduler.device.skips(section)) return;
    void refresh().catch(() => undefined);
  }

  /** Stop the timers and stage the time-series snapshot; `MutexSessionScheduler.stop()` flushes it. */
  stop(): void {
    this.#running = false;
    this.scheduler.markRunning(false);
    for (const timer of [this.#pollTimer, this.#slowScanTimer, this.#flushTimer]) {
      if (timer) clearInterval(timer);
    }
    this.#pollTimer = null;
    this.#slowScanTimer = null;
    this.#flushTimer = null;
    if (this.#initialized) {
      this.stateStore.update({ timeseries: this.timeseries.toSnapshot() });
    }
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

  getCachedAccessControl(): AccessControlSnapshot | null {
    return this.stateStore.getState().latestAccessControl;
  }

  /** The cellular settings last read from the router in use (`null`: none read, or read on another brand's router). */
  getCachedCellular(): CellularSettingsSnapshot | null {
    return this.#cellular !== null && this.#cellular.family === this.scheduler.getFamily() ? this.#cellular.snapshot : null;
  }

  /** The last identification and capability probe, `null` before the first one. */
  getDeviceProbe(): DeviceProbeResult | null {
    return this.stateStore.getState().deviceProbe;
  }

  /**
   * Identify the router and probe its capabilities in one low-priority read session (the listed GETs
   * of `DEVICE_PROBE_PATHS`). Run once when the daemon starts, never from the polls. Like every read
   * it is skipped (`null`) while a person uses the router's page or the breaker is latched; then, or
   * when it fails, it stays owed and runs right after the next read that gets in, ahead of the reads
   * still queued, until it succeeds or fails three times in a row. Waiting for that read sends nothing.
   */
  identifyDevice(): Promise<DeviceProbeResult | null> {
    this.#identifyPending = true;
    this.#identifyFailures = 0;
    return this.#identify("low");
  }

  #identify(priority: SchedulerPriority): Promise<DeviceProbeResult | null> {
    // Each family's backend knows how its routers say who they are
    this.#inflightIdentify ??= this.#backend()
      .identify(priority)
      .then(
        async (probe) => {
          if (probe) await this.recordDeviceProbe(probe);
          return probe;
        },
        (err: unknown) => {
          this.#identifyFailures += 1;
          if (this.#identifyFailures >= MAX_IDENTIFY_FAILURES) this.#identifyPending = false;
          throw err;
        }
      )
      .finally(() => {
        this.#inflightIdentify = null;
      });
    return this.#inflightIdentify;
  }

  /** A read got in: an identification still owed since the start goes next. */
  #catchUpIdentification(): void {
    if (this.#identifyPending && this.#inflightIdentify === null) void this.#identify("high").catch(() => undefined);
  }

  /** Keep a probe (also the one a console connection test of this router made) and persist it at once. */
  async recordDeviceProbe(probe: DeviceProbeResult): Promise<void> {
    this.#identifyPending = false;
    this.#identifyFailures = 0;
    this.scheduler.noteIdentification(probe);
    this.stateStore.update({ deviceProbe: probe });
    await this.stateStore.flushAsync().catch(() => undefined);
  }

  queryTimeSeries(params: TimeSeriesQueryParams): TimeSeriesQueryResult {
    return this.timeseries.query(params);
  }

  /** Coalesced high-frequency telemetry refresh (`5s` default poll + manual/MCP triggers). */
  refreshTelemetry(opts: RefreshOptions = {}): Promise<GlobalTelemetrySnapshot | null> {
    return this.#coalesce(
      opts,
      () => this.#inflightTelemetry,
      (p) => {
        this.#inflightTelemetry = p;
      },
      () => this.#backend().readTelemetry({ ignoreCooldown: opts.ignoreCooldown, smsCounters: this.smsCountersEnabled }),
      (snap) => {
        // Before anyone hears of the snapshot: a write it prompts (self-heal) goes by this model
        this.scheduler.noteRouterModel(snap.device.deviceName, snap.device.softwareVersion);
        this.stateStore.update({ latestTelemetry: snap });
        // A model without traffic counters has no throughput to chart: no sample rather than a made-up zero
        if (snap.unavailable?.includes("traffic")) {
          this.#safeEmit("telemetry", snap);
          return;
        }
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
      }
    );
  }

  /** Coalesced 4G/5G neighbor cell scan (each family's own list). */
  refreshNeighbors(opts: RefreshOptions = {}): Promise<NeighborScanSnapshot | null> {
    return this.#coalesce(
      opts,
      () => this.#inflightNeighbors,
      (p) => {
        this.#inflightNeighbors = p;
      },
      () => this.#backend().readNeighbors({ ignoreCooldown: opts.ignoreCooldown }),
      (snap) => {
        this.stateStore.update({ latestNeighbors: snap });
        this.#safeEmit("neighbors", snap);
      }
    );
  }

  /** Coalesced sweep of the devices connected to the router (LAN and Wi-Fi). */
  refreshTopology(opts: RefreshOptions = {}): Promise<TerminalTopologySnapshot | null> {
    return this.#coalesce(
      opts,
      () => this.#inflightTopology,
      (p) => {
        this.#inflightTopology = p;
      },
      () => this.#backend().readTopology({ ignoreCooldown: opts.ignoreCooldown }),
      (snap) => {
        this.stateStore.update({ latestTopology: snap });
        this.#safeEmit("topology", snap);
      }
    );
  }

  /** Coalesced router security, Wi-Fi 7 MLO, antenna, and mobile-data settings read. */
  refreshSettings(opts: RefreshOptions = {}): Promise<RouterSettingsSnapshot | null> {
    return this.#coalesce(
      opts,
      () => this.#inflightSettings,
      (p) => {
        this.#inflightSettings = p;
      },
      () => this.#backend().readSettings({ ignoreCooldown: opts.ignoreCooldown }),
      (snap) => {
        this.stateStore.update({ latestSettings: snap });
        this.#safeEmit("settings", snap);
      }
    );
  }

  /** Coalesced read of the Wi-Fi MAC filter and the internet time rules (low priority). */
  refreshAccessControl(opts: RefreshOptions = {}): Promise<AccessControlSnapshot | null> {
    return this.#coalesce(
      opts,
      () => this.#inflightAccessControl,
      (p) => {
        this.#inflightAccessControl = p;
      },
      () => this.#backend().readAccessControl({ ignoreCooldown: opts.ignoreCooldown }),
      (snap) => {
        this.stateStore.update({ latestAccessControl: snap });
        this.#safeEmit("access-control", snap);
      }
    );
  }

  /**
   * Coalesced read of the cellular settings (network mode, SIM slots, operator selection, access
   * point, data limit): one session when the console or a tool asks, never from the polls.
   */
  refreshCellular(opts: RefreshOptions = {}): Promise<CellularSettingsSnapshot | null> {
    const family = this.scheduler.getFamily();
    return this.#coalesce(
      opts,
      () => this.#inflightCellular,
      (p) => {
        this.#inflightCellular = p;
      },
      () => this.#backend().readCellular({ ignoreCooldown: opts.ignoreCooldown }),
      (snap) => {
        this.#cellular = { family, snapshot: snap };
      }
    );
  }

  /**
   * Fold a verified access-control write (its read-back) into the cached snapshot and push it over
   * SSE. Returns `false` when nothing is cached yet, so the caller can run a full read instead.
   */
  patchCachedAccessControl(patch: Partial<Pick<AccessControlSnapshot, "wifiMacFilter" | "timeRules">>): boolean {
    const current = this.stateStore.getState().latestAccessControl;
    if (!current) return false;
    const nowMs = Date.now();
    const next: AccessControlSnapshot = { ...current, ...patch, capturedAtMs: nowMs, capturedAtIso: new Date(nowMs).toISOString() };
    this.stateStore.update({ latestAccessControl: next });
    this.#safeEmit("access-control", next);
    return true;
  }

  /**
   * Fold a confirmed settings write into the cached snapshot and push it over SSE without a second
   * CPE session. Capture timestamps keep marking the last full read; nothing is emitted when no
   * snapshot has been read yet.
   */
  patchCachedSettings(patch: (current: RouterSettingsSnapshot) => Partial<RouterSettingsSnapshot>): void {
    const current = this.stateStore.getState().latestSettings;
    if (!current) return;
    const next: RouterSettingsSnapshot = { ...current, ...patch(current) };
    this.stateStore.update({ latestSettings: next });
    this.#safeEmit("settings", next);
  }

  #coalesce<T>(
    opts: RefreshOptions,
    getInflight: () => Promise<T | null> | null,
    setInflight: (promise: Promise<T | null> | null) => void,
    /** One read session through the scheduler; `null`: nothing to keep (skipped, or a section this model does not provide). */
    read: () => Promise<T | null>,
    onFresh: (value: T) => void
  ): Promise<T | null> {
    const inflight = getInflight();
    if (inflight && !opts.ignoreCooldown) return inflight;

    const promise: Promise<T | null> = read()
      .then((value) => {
        if (value === null) return null;
        onFresh(value);
        this.#catchUpIdentification();
        return value;
      })
      .finally(() => {
        if (getInflight() === promise) setInflight(null);
      });

    if (!opts.ignoreCooldown) setInflight(promise);
    return promise;
  }

  #safeEmit(event: string, payload: unknown): void {
    // Each listener on its own: a failing one (e.g. a disconnected SSE client) must never break polling, nor keep
    // the snapshot from the listeners after it (self-healing, the SMS counters). Raw listeners keep `once` working.
    for (const listener of this.rawListeners(event)) {
      try {
        Reflect.apply(listener, this, [payload]);
      } catch {
        // Already isolated: the other listeners still get the snapshot
      }
    }
  }
}
