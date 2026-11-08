import type { CpeControlService, WanRepairOutcome } from "./cpe-controls.ts";
import type { GlobalTelemetrySnapshot, PersistedLockState } from "./cpe-domain.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { runAsActor } from "./audit-log.ts";
import { type I18nKey, t } from "./i18n.ts";
import { sanitizeFreeText } from "./sanitize.ts";
import {
  BrowserSessionYieldedError,
  CircuitBreakerOpenError,
  type ControlAppliedEvent,
  DeviceNotIdentifiedError,
  DeviceReadOnlyError,
  type MutexSessionScheduler,
  PeerDaemonStandbyError,
  SchedulerQueueFullError,
  SchedulerStoppedError,
} from "./scheduler.ts";
import { LOCK_CONFIRM_MS, RECONNECT_MAX_PER_DAY, type SelfHealStatus } from "./self-heal-status.ts";
import type { AlertEventRecord, SelfHealLockWatchState, SelfHealReconnectState } from "./state-store.ts";

export { LOCK_CONFIRM_MS, RECONNECT_MAX_PER_DAY, SELF_HEAL_OFF, type SelfHealStatus } from "./self-heal-status.ts";

export interface WanSelfHealOptions {
  scheduler: MutexSessionScheduler;
  /** Source of `telemetry` events. */
  monitor: CpeMonitor;
  controls: Pick<CpeControlService, "getPersistedLockState" | "rollBackLocks" | "reconnectWan">;
  /** `LOCK_ROLLBACK_AFTER_MIN` in ms; `0` keeps every lock (off). */
  lockRollbackAfterMs: number;
  /** `WAN_AUTO_RECONNECT_AFTER_MIN` in ms; `0` never redials (off). */
  reconnectAfterMs: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** After the deadline a rollback that keeps being refused (human on the WebUI, router errors) gives up. */
export const ROLLBACK_GIVE_UP_MS = 60 * 60_000;
/** Wait before trying again after a refusal or failure. */
export const SELF_HEAL_RETRY_MS = 60_000;
/** Gaps between redials of one outage: 10, 30, then 60 min. */
export const RECONNECT_BACKOFF_MS: ReadonlyArray<number> = [10 * 60_000, 30 * 60_000, 60 * 60_000];
const DAY_MS = 24 * 60 * 60_000;
/** Snapshots older than this (restored from disk at startup) never drive a write. */
const STALE_SNAPSHOT_MS = 2 * 60_000;
const MAX_ROLLBACK_FAILURES = 3;

interface LockWatch {
  lockUpdatedAtIso: string;
  armedAtMs: number;
  deadlineMs: number;
  upSinceMs: number | null;
  retryAtMs: number;
  failures: number;
}

/**
 * Opt-in WAN self-healing (both parts default off, because they write to the router without a
 * human request):
 *
 * - **Lock rollback** (`LOCK_ROLLBACK_AFTER_MIN`): after a band or cell lock, the WAN must come back
 *   and stay up for 2 min; if it is still down when the window ends, every lock is cleared once.
 * - **Reconnect** (`WAN_AUTO_RECONNECT_AFTER_MIN`): a WAN down that long is redialled, then again
 *   after 10, 30 and 60 min, at most 4 times in 24 h (kept in state.json, so a restart neither
 *   refills the budget nor shortens the wait). Never a reboot.
 *
 * The lock watch is kept in state.json too: a restart picks up a watch still open (until the
 * rollback, or giving up an hour after the deadline) and never re-arms a lock the WAN proved.
 *
 * Both act only on fresh telemetry, go through the control queue (so a human logged into the WebUI
 * is never overridden and the breaker is respected), re-read the WAN and the mobile-data switch
 * inside the session, and raise an alert for every write. On a router of an unverified model the
 * write gate refuses both: nothing is written, and one `SELF_HEAL_READ_ONLY` alert per outage or
 * lock says what would have been done.
 */
export class WanSelfHeal {
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly controls: WanSelfHealOptions["controls"];
  readonly lockRollbackAfterMs: number;
  readonly reconnectAfterMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  #started = false;
  #busy: Promise<void> | null = null;
  #lockWatch: LockWatch | null = null;
  #downSinceMs: number | null = null;
  #reconnects: number[] = [];
  #backoffIndex = 0;
  #nextReconnectAtMs = 0;
  /** The redials and backoff step last saved, to write state.json only when they change. */
  #savedReconnects = budgetKey([], 0);
  #exhaustedAlerted = false;
  /** The read-only alert of this outage was raised (a router of an unverified model writes nothing). */
  #readOnlyAlerted = false;
  #lastFailure: string | null = null;

  readonly #onTelemetry = (snap: GlobalTelemetrySnapshot): void => {
    void this.ingestTelemetry(snap);
  };

  readonly #onControl = (event: ControlAppliedEvent): void => {
    this.noteControl(event);
  };

  constructor(opts: WanSelfHealOptions) {
    this.scheduler = opts.scheduler;
    this.monitor = opts.monitor;
    this.controls = opts.controls;
    this.lockRollbackAfterMs = Math.max(0, opts.lockRollbackAfterMs);
    this.reconnectAfterMs = Math.max(0, opts.reconnectAfterMs);
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => undefined);
  }

  get enabled(): boolean {
    return this.lockRollbackAfterMs > 0 || this.reconnectAfterMs > 0;
  }

  /** When the watched lock is rolled back if the WAN is still down (`null`: no lock is watched). */
  get lockDeadlineMs(): number | null {
    return this.#lockWatch?.deadlineMs ?? null;
  }

  /** What it will do next: the open lock window and the redial budget (read-only, from memory). */
  status(): SelfHealStatus {
    const now = this.#now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const watch = this.#lockWatch;
    const redialing = this.reconnectAfterMs > 0;
    const next = this.#nextReconnectAtMs;
    return {
      lockRollback: {
        afterMin: this.lockRollbackAfterMs > 0 ? Math.round(this.lockRollbackAfterMs / 60_000) : null,
        watch: watch ? { lockUpdatedAtIso: watch.lockUpdatedAtIso, deadlineIso: iso(watch.deadlineMs), wanUpSinceIso: watch.upSinceMs === null ? null : iso(watch.upSinceMs) } : null,
      },
      reconnect: {
        afterMin: redialing ? Math.round(this.reconnectAfterMs / 60_000) : null,
        redialsLast24h: this.#reconnects.filter((ts) => now - ts < DAY_MS).length,
        maxPer24h: RECONNECT_MAX_PER_DAY,
        nextAllowedAtIso: redialing && Number.isFinite(next) && next > now ? iso(next) : null,
        wanDownSinceIso: redialing && this.#downSinceMs !== null ? iso(this.#downSinceMs) : null,
      },
    };
  }

  start(): void {
    if (this.#started || !this.enabled) return;
    this.#started = true;
    this.scheduler.on("control:applied", this.#onControl);
    this.monitor.on("telemetry", this.#onTelemetry);
    if (this.reconnectAfterMs > 0) this.#restoreReconnects(this.scheduler.stateStore.getState().selfHealReconnect);
    // A restart (deploy, crash) picks up the watch of the lock in place: one still open runs to its
    // end, one that ended stays ended; a lock with no record (from before it was kept) only inside the window
    const lock = this.controls.getPersistedLockState();
    if (this.lockRollbackAfterMs > 0 && lock.mode !== "unlocked") {
      const appliedMs = Date.parse(lock.updatedAtIso);
      const record = watchRecordFor(this.scheduler.stateStore.getState().selfHealLockWatch, lock.updatedAtIso);
      const openForMs = record ? this.lockRollbackAfterMs + ROLLBACK_GIVE_UP_MS : this.lockRollbackAfterMs;
      if (!record?.settled && Number.isFinite(appliedMs) && this.#now() - appliedMs < openForMs) this.#arm(lock, appliedMs);
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.scheduler.off("control:applied", this.#onControl);
    this.monitor.off("telemetry", this.#onTelemetry);
    await this.#busy;
  }

  /** Arm the rollback for a new lock; any unlock (by anyone, through FengSui) disarms it. */
  noteControl(event: ControlAppliedEvent): void {
    const lock = event.lockState;
    if (!lock) return;
    if (lock.mode === "unlocked") {
      this.#setWatch(null);
    } else if (this.lockRollbackAfterMs > 0 && (event.action === "lock_band" || event.action === "lock_cell")) {
      const appliedMs = Date.parse(lock.updatedAtIso);
      this.#arm(lock, Number.isFinite(appliedMs) ? appliedMs : this.#now());
    }
  }

  /** Evaluate one telemetry snapshot; resolves once any write it started has finished. */
  async ingestTelemetry(snap: GlobalTelemetrySnapshot): Promise<void> {
    const status = snap.device.connectionStatus;
    if (!status || this.#now() - snap.capturedAtMs > STALE_SNAPSHOT_MS) return;
    const up = status === "901";
    const at = snap.capturedAtMs;
    if (up) {
      this.#downSinceMs = null;
      this.#backoffIndex = 0;
      this.#nextReconnectAtMs = 0;
      this.#exhaustedAlerted = false;
      this.#readOnlyAlerted = false;
      this.#saveReconnects();
    } else {
      this.#downSinceMs ??= at;
    }
    // One write at a time; snapshots that arrive meanwhile only update the bookkeeping above
    if (this.#busy) return;
    const work = this.#lockWatch ? this.#watchLock(this.#lockWatch, up, at) : this.#watchOutage(up, at);
    if (!work) return;
    const running = work.finally(() => {
      this.#busy = null;
    });
    this.#busy = running;
    await running;
  }

  #arm(lock: PersistedLockState, appliedMs: number): void {
    this.#setWatch({
      lockUpdatedAtIso: lock.updatedAtIso,
      armedAtMs: appliedMs,
      deadlineMs: appliedMs + this.lockRollbackAfterMs,
      upSinceMs: null,
      retryAtMs: 0,
      failures: 0,
    });
  }

  /** End `watch` if it is still the open one: a newer lock may have replaced it while a rollback waited. */
  #endWatch(watch: LockWatch): void {
    if (this.#lockWatch === watch) this.#setWatch(null);
  }

  /**
   * Open, replace or end the lock watch, and record it in state.json at once (it changes once or
   * twice per lock), so a restart picks it up where it was.
   */
  #setWatch(next: LockWatch | null): void {
    const ended = this.#lockWatch;
    this.#lockWatch = next;
    const record: SelfHealLockWatchState | null = next
      ? { lockUpdatedAtIso: next.lockUpdatedAtIso, settled: false }
      : ended
        ? { lockUpdatedAtIso: ended.lockUpdatedAtIso, settled: true }
        : null;
    const stored = this.scheduler.stateStore.getState().selfHealLockWatch;
    if (record === null || (stored?.lockUpdatedAtIso === record.lockUpdatedAtIso && stored.settled === record.settled)) return;
    this.scheduler.stateStore.update({ selfHealLockWatch: record });
    void this.scheduler.stateStore.flushAsync().catch(() => undefined);
  }

  #watchLock(watch: LockWatch, up: boolean, at: number): Promise<void> | null {
    if (at < watch.armedAtMs) return null;
    if (up) {
      watch.upSinceMs ??= at;
      if (at - watch.upSinceMs >= LOCK_CONFIRM_MS) {
        this.#setWatch(null);
        this.#log("[self-heal] WAN stayed up after the lock; keeping it");
      }
      return null;
    }
    watch.upSinceMs = null;
    if (at < watch.deadlineMs || at < watch.retryAtMs) return null;
    if (this.controls.getPersistedLockState().updatedAtIso !== watch.lockUpdatedAtIso) {
      this.#setWatch(null);
      return null;
    }
    if (at - watch.deadlineMs > ROLLBACK_GIVE_UP_MS) {
      this.#setWatch(null);
      this.#raise("critical", "LOCK_ROLLBACK_FAILED", "alerts.lock_rollback_failed", { reason: this.#lastFailure ?? "timeout" });
      return null;
    }
    return this.#rollBack(watch, at);
  }

  async #rollBack(watch: LockWatch, at: number): Promise<void> {
    let outcome: WanRepairOutcome;
    try {
      outcome = await runAsActor({ channel: "self-heal" }, () => this.controls.rollBackLocks(watch.lockUpdatedAtIso));
    } catch (err) {
      const reason = describe(err);
      this.#noteFailure("lock rollback", reason);
      // A router of an unverified model is read-only: say so once instead of retrying a write that never comes
      if (err instanceof DeviceReadOnlyError) {
        this.#endWatch(watch);
        this.#raise("warning", "SELF_HEAL_READ_ONLY", "alerts.self_heal_read_only_rollback", { model: err.model });
        return;
      }
      if (err instanceof CircuitBreakerOpenError || err instanceof PeerDaemonStandbyError) {
        this.#endWatch(watch);
        this.#raise("critical", "LOCK_ROLLBACK_FAILED", "alerts.lock_rollback_failed", { reason });
        return;
      }
      watch.retryAtMs = at + SELF_HEAL_RETRY_MS;
      // A human on the WebUI is not a failure of the rollback: wait for them, never fight them
      if (!(err instanceof BrowserSessionYieldedError) && !isQueueRefusal(err)) watch.failures += 1;
      if (watch.failures >= MAX_ROLLBACK_FAILURES) {
        this.#endWatch(watch);
        this.#raise("critical", "LOCK_ROLLBACK_FAILED", "alerts.lock_rollback_failed", { reason });
      }
      return;
    }
    this.#lastFailure = null;
    if (!outcome.applied) {
      if (outcome.skipped === "wan_up") {
        // Seen up inside the session: look again in a minute, not at every poll while the WAN flaps
        watch.upSinceMs = at;
        watch.retryAtMs = at + SELF_HEAL_RETRY_MS;
      } else if (outcome.skipped === "lock_changed") {
        // Replaced while the rollback waited in the queue: the newer lock has its own watch
        this.#endWatch(watch);
      } else {
        this.#endWatch(watch);
        this.#log("[self-heal] mobile data is switched off; not rolling the lock back");
      }
      return;
    }
    this.#endWatch(watch);
    // The unlocked modem needs time to attach before a redial could help
    this.#downSinceMs = at;
    this.#raise("warning", "LOCK_ROLLED_BACK", "alerts.lock_rolled_back", {
      minutes: Math.round((at - watch.armedAtMs) / 60_000),
    });
  }

  #watchOutage(up: boolean, at: number): Promise<void> | null {
    const downSince = this.#downSinceMs;
    if (this.reconnectAfterMs <= 0 || up || downSince === null) return null;
    if (at - downSince < this.reconnectAfterMs || at < this.#nextReconnectAtMs) return null;
    this.#reconnects = this.#reconnects.filter((ts) => at - ts < DAY_MS);
    if (this.#reconnects.length >= RECONNECT_MAX_PER_DAY) {
      if (!this.#exhaustedAlerted) {
        this.#exhaustedAlerted = true;
        this.#raise("critical", "WAN_RECONNECT_EXHAUSTED", "alerts.wan_reconnect_exhausted", { max: RECONNECT_MAX_PER_DAY });
      }
      return null;
    }
    return this.#reconnect(downSince, at);
  }

  async #reconnect(downSince: number, at: number): Promise<void> {
    let outcome: WanRepairOutcome;
    try {
      outcome = await runAsActor({ channel: "self-heal" }, () => this.controls.reconnectWan());
    } catch (err) {
      this.#noteFailure("reconnect", describe(err));
      // A router of an unverified model is read-only: no redial in this outage, one alert saying so
      if (err instanceof DeviceReadOnlyError) {
        this.#nextReconnectAtMs = Number.POSITIVE_INFINITY;
        if (!this.#readOnlyAlerted) {
          this.#readOnlyAlerted = true;
          this.#raise("warning", "SELF_HEAL_READ_ONLY", "alerts.self_heal_read_only_reconnect", {
            minutes: Math.max(1, Math.round((at - downSince) / 60_000)),
            model: err.model,
          });
        }
        return;
      }
      // Refusals never reached the router; anything else spends one of the day's attempts
      const reachedRouter = !(
        err instanceof BrowserSessionYieldedError ||
        err instanceof CircuitBreakerOpenError ||
        err instanceof PeerDaemonStandbyError ||
        err instanceof DeviceNotIdentifiedError ||
        isQueueRefusal(err)
      );
      if (reachedRouter) {
        // It may have redialled: it spends one of the day's attempts and waits its step like a redial
        this.#reconnects.push(at);
        this.#nextReconnectAtMs = at + this.#takeBackoffStep();
        this.#saveReconnects();
      } else {
        this.#nextReconnectAtMs = at + SELF_HEAL_RETRY_MS;
      }
      return;
    }
    this.#lastFailure = null;
    if (!outcome.applied) {
      // Back already, or mobile data is off on purpose: look again after the first backoff step
      this.#nextReconnectAtMs = at + (RECONNECT_BACKOFF_MS[0] ?? SELF_HEAL_RETRY_MS);
      if (outcome.skipped === "mobile_data_off") this.#log("[self-heal] mobile data is switched off; not redialling");
      return;
    }
    this.#reconnects.push(at);
    this.#nextReconnectAtMs = at + this.#takeBackoffStep();
    this.#saveReconnects();
    this.#raise("warning", "WAN_AUTO_RECONNECT", "alerts.wan_auto_reconnect", {
      minutes: Math.max(1, Math.round((at - downSince) / 60_000)),
      count: this.#reconnects.length,
      max: RECONNECT_MAX_PER_DAY,
    });
  }

  /** The wait before the next redial of this outage (10, 30, then 60 min); each redial moves one step on. */
  #takeBackoffStep(): number {
    const gap = RECONNECT_BACKOFF_MS[Math.min(this.#backoffIndex, RECONNECT_BACKOFF_MS.length - 1)] ?? SELF_HEAL_RETRY_MS;
    this.#backoffIndex += 1;
    return gap;
  }

  /**
   * Take back what an earlier run saved, as far as it is plausible now: redials within 24 h of this
   * clock, and a wait no longer than the longest backoff step (a clock that has moved since says nothing).
   */
  #restoreReconnects(saved: SelfHealReconnectState | null): void {
    if (!saved) return;
    const now = this.#now();
    const reconnects = Array.isArray(saved.reconnectsMs) ? saved.reconnectsMs : [];
    this.#reconnects = reconnects.filter((ts) => typeof ts === "number" && Math.abs(now - ts) < DAY_MS);
    const next = saved.nextReconnectAtMs;
    this.#nextReconnectAtMs = typeof next === "number" && next - now <= Math.max(...RECONNECT_BACKOFF_MS) ? next : 0;
    const step = saved.backoffIndex;
    this.#backoffIndex = Number.isSafeInteger(step) && step > 0 ? Math.min(step, RECONNECT_BACKOFF_MS.length) : 0;
    this.#savedReconnects = budgetKey(this.#reconnects, this.#backoffIndex);
  }

  /**
   * Save the day's redials and the backoff step when either changed (a redial, or the WAN back up),
   * at once: a daemon crashing in a loop would otherwise start each run with a full budget. The
   * one-minute retries after a refusal are not worth a write.
   */
  #saveReconnects(): void {
    const key = budgetKey(this.#reconnects, this.#backoffIndex);
    if (key === this.#savedReconnects) return;
    this.#savedReconnects = key;
    const next = Number.isFinite(this.#nextReconnectAtMs) ? this.#nextReconnectAtMs : 0;
    this.scheduler.stateStore.update({ selfHealReconnect: { reconnectsMs: [...this.#reconnects], nextReconnectAtMs: next, backoffIndex: this.#backoffIndex } });
    void this.scheduler.stateStore.flushAsync().catch(() => undefined);
  }

  /** Log a failure once per distinct reason (a tripped breaker would otherwise log every minute). */
  #noteFailure(what: string, reason: string): void {
    if (reason === this.#lastFailure) return;
    this.#lastFailure = reason;
    this.#log(`[self-heal] ${what} not done: ${reason}`);
  }

  #raise(severity: AlertEventRecord["severity"], code: string, key: I18nKey, params?: Readonly<Record<string, string | number>>): void {
    this.scheduler.raiseAlert({ severity, code, messageZh: t("zh-CN", key, params), messageEn: t("en", key, params) });
  }
}

/** The saved watch record when it is about the lock `lockUpdatedAtIso` and reads as one (state.json is input). */
function watchRecordFor(saved: SelfHealLockWatchState | null, lockUpdatedAtIso: string): SelfHealLockWatchState | null {
  return saved !== null && typeof saved === "object" && saved.lockUpdatedAtIso === lockUpdatedAtIso && typeof saved.settled === "boolean" ? saved : null;
}

function budgetKey(reconnects: ReadonlyArray<number>, backoffIndex: number): string {
  return `${reconnects.join(",")}/${backoffIndex}`;
}

function isQueueRefusal(err: unknown): boolean {
  return err instanceof SchedulerQueueFullError || err instanceof SchedulerStoppedError;
}

function describe(err: unknown): string {
  return sanitizeFreeText(err instanceof Error ? err.message : String(err)).slice(0, 160);
}
