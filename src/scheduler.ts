import { EventEmitter } from "node:events";
import {
  CpeApiError,
  type EphemeralCpeSession,
  type HuaweiCpeClient,
  ReentrantCpeSessionError,
  isInsideCpeSession,
} from "./cpe-client.ts";
import { CpeControlValidationError, type PersistedLockState } from "./cpe-domain.ts";
import { t } from "./i18n.ts";
import type { AlertEventRecord, EncryptedStateStore } from "./state-store.ts";
import type { CircuitBreakerState, CpeLoginState } from "./types.ts";

export type SchedulerMode =
  | "idle"
  | "polling"
  | "yielding_browser"
  | "circuit_tripped"
  | "cpe_unreachable"
  | "standby_peer";

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

export interface ControlAppliedEvent {
  action: string;
  tsIso: string;
  summaryZh: string;
  summaryEn: string;
  lockState?: PersistedLockState;
}

/** Another FengSui daemon (another host) leads for this CPE; this one stays off the router. */
export interface PeerStandbyState {
  active: boolean;
  peerAddress: string | null;
  sinceIso: string | null;
}

export interface SchedulerStatusSnapshot {
  mode: SchedulerMode;
  running: boolean;
  avoidance: AvoidanceBroadcastPayload;
  peerStandby: PeerStandbyState;
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

/** A control was refused because another FengSui daemon drives this CPE (`409 PEER_DAEMON_ACTIVE`). */
export class PeerDaemonStandbyError extends Error {
  readonly statusCode = 409;
  readonly peerAddress: string | null;

  constructor(peerAddress: string | null) {
    super(t("en", "controls.peer_daemon_active", { address: peerAddress ?? "?" }));
    this.name = "PeerDaemonStandbyError";
    this.peerAddress = peerAddress;
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
  /** Attached to the `control:applied` event (RF lock controls). */
  lockState?: PersistedLockState;
}

/** Login-free CPE endpoints that may be probed outside the admin session (no queue, no slot). */
export type PublicProbePath = "/api/monitoring/check-notifications";

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
  maxQueueDepth?: number;
  layer2InitialBackoffMs?: number;
  layer2MaxBackoffMs?: number;
  /** How long `stop()` lets an in-flight session finish before cancelling it (default 2 s). */
  stopGraceMs?: number;
}

/**
 * Single-instance Mutex Ephemeral Session Scheduler & Polite Browser Avoidance Engine: the only
 * path from FengSui to an authenticated CPE session.
 *
 * - Serializes all CPE sessions (background polling, SMS, Web REST, MCP, Telegram) through one
 *   priority queue (`high` controls > `normal` reads > `low` sweeps); domain services build on
 *   `executeRead` / `executeControl` and never touch the client directly.
 * - Enforces dual-layer human browser avoidance (`state-login != -1` + cross-IP `108003` with an
 *   exponential anti-flapping cooldown) and broadcasts `session:avoidance` only on transitions.
 *   Avoidance follows the client's `respectBrowserSession` setting (`RESPECT_BROWSER_SESSION`).
 * - Persists `108006`/`108007` circuit-breaker latches across restarts via `EncryptedStateStore`
 *   and raises a `CIRCUIT_<code>` alert the first time the breaker trips.
 */
export class MutexSessionScheduler extends EventEmitter {
  readonly stateStore: EncryptedStateStore;
  readonly maxQueueDepth: number;
  readonly layer2InitialBackoffMs: number;
  readonly layer2MaxBackoffMs: number;
  readonly stopGraceMs: number;

  readonly #client: HuaweiCpeClient;
  #initialized = false;
  #stopping = false;
  #mode: SchedulerMode = "idle";
  #lastError: string | null = null;
  #running = false;

  #avoidanceActive = false;
  #avoidanceLayer: 1 | 2 | null = null;
  #avoidanceStateCode: string | null = null;
  #avoidanceSinceIso: string | null = null;
  #layer2CooldownUntilMs: number | null = null;
  #layer2CooldownUntilMono: number | null = null;
  #consecutiveLayer2Yields = 0;

  #queue: Array<QueuedTask<unknown>> = [];
  #draining = false;
  #peerStandby: PeerStandbyState = { active: false, peerAddress: null, sinceIso: null };

  constructor(options: MutexSessionSchedulerOptions) {
    super();
    this.#client = options.client;
    this.stateStore = options.stateStore;
    this.maxQueueDepth = options.maxQueueDepth ?? 32;
    this.layer2InitialBackoffMs = options.layer2InitialBackoffMs ?? 45_000;
    this.layer2MaxBackoffMs = options.layer2MaxBackoffMs ?? 300_000;
    this.stopGraceMs = Math.max(0, options.stopGraceMs ?? 2000);
  }

  /**
   * Hydrate encrypted runtime state and the persisted circuit-breaker latch (idempotent).
   */
  init(): void {
    if (this.#initialized) return;
    const loaded = this.stateStore.load();
    const latched = this.#client.hydrateCircuitBreaker(loaded.circuitBreaker);
    if (latched) {
      this.#mode = "circuit_tripped";
    }
    this.#initialized = true;
  }

  /** Accept sessions again after `stop()` and mark the background workload as running. */
  markRunning(running: boolean): void {
    this.#running = running;
    if (running) this.#stopping = false;
  }

  /**
   * Reject unstarted queued tasks, give an in-flight session `stopGraceMs` to finish (a control
   * write is never cut short without need), then cancel it: its `finally` logout still runs on a
   * fresh bounded signal, so the router's admin slot is free before the process exits. Finally
   * persist the breaker latch and flush encrypted state.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#stopping = true;
    const stopped = new SchedulerStoppedError();
    for (const queued of this.#queue.splice(0)) {
      queued.reject(stopped);
    }
    if (!(await this.#client.waitForIdle(this.stopGraceMs))) {
      this.#client.abortActiveSession(stopped);
      await this.#client.waitForIdle(4000);
    }
    if (!this.#initialized) {
      return;
    }
    this.stateStore.update({ circuitBreaker: this.#client.getCircuitBreakerState() });
    await this.stateStore.flushAsync();
  }

  /**
   * Enter or leave peer standby (`PeerDaemonGuard`): while active, reads are skipped (`null`, like a
   * latched breaker) and controls throw `PeerDaemonStandbyError` without touching the router.
   */
  setPeerStandby(peerAddress: string | null): void {
    this.#peerStandby =
      peerAddress === null
        ? { active: false, peerAddress: null, sinceIso: null }
        : { active: true, peerAddress, sinceIso: this.#peerStandby.sinceIso ?? new Date().toISOString() };
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
    const telemetry = this.#client.getTelemetry();
    const cb = telemetry.circuitBreaker;
    const effectiveMode: SchedulerMode = cb.tripped
      ? "circuit_tripped"
      : this.#peerStandby.active
        ? "standby_peer"
        : this.#mode;
    return {
      mode: effectiveMode,
      running: this.#running,
      avoidance: this.getAvoidanceState(),
      peerStandby: { ...this.#peerStandby },
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

  isCircuitTripped(): boolean {
    return this.#client.getCircuitBreakerState().tripped;
  }

  getRecentAlerts(): ReadonlyArray<AlertEventRecord> {
    return this.stateStore.getState().recentAlerts;
  }

  /**
   * Unauthenticated `GET /api/user/state-login` (no queue, no admin slot). May run concurrently with
   * an ephemeral session; it never logs in, so it cannot disturb a human or our own session.
   */
  async probeLoginState(): Promise<CpeLoginState> {
    return await this.#client.getLoginState();
  }

  /** Unauthenticated GET of an allowlisted login-free endpoint (see `PublicProbePath`). */
  async probePublic(apiPath: PublicProbePath): Promise<string> {
    return await this.#client.getPublic(apiPath);
  }

  /**
   * Reload credentials & reset the anti-brute-force circuit breaker after a human updates `.env`.
   * Enforces 铁律五: refuses to clear a wrong-password latch (`108006`/`108002`/`108001`) if the
   * configured password has not changed, preventing accidental exhaustion of remaining strikes to `108007`.
   */
  async reloadCredentialsAndResetBreaker(
    newPassword: string,
    newUsername?: string
  ): Promise<CircuitBreakerState> {
    const latched = this.#client.getCircuitBreakerState();
    const changed = this.#client.reloadCredentials(newPassword, newUsername);
    if (!changed && latched.tripped && latched.code !== "108007") {
      throw new CpeControlValidationError(
        "Circuit breaker latched on wrong password; update CPE_PASSWORD in .env before resetting"
      );
    }
    if (!changed) {
      this.#client.resetCircuitBreaker();
    }
    const cb = this.#client.getCircuitBreakerState();
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
   * Run a read-only CPE session through the shared queue with breaker, browser-avoidance and
   * Layer-2 cooldown semantics. Resolves `null` when the session was skipped (breaker latched,
   * Layer-2 quiet window) or yielded to a human administrator.
   */
  executeRead<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    opts: { priority?: SchedulerPriority; ignoreCooldown?: boolean } = {}
  ): Promise<T | null> {
    const ignoreCooldown = opts.ignoreCooldown === true;
    return this.#enqueue(opts.priority ?? "normal", async () => {
      if (this.#client.getCircuitBreakerState().tripped) {
        this.#mode = "circuit_tripped";
        return null;
      }
      if (this.#peerStandby.active) return null;

      // Layer-2 anti-flapping quiet window (monotonic clock immune to NTP steps)
      if (
        !ignoreCooldown &&
        this.#avoidanceActive &&
        this.#avoidanceLayer === 2 &&
        this.#layer2CooldownUntilMono !== null &&
        performance.now() < this.#layer2CooldownUntilMono
      ) {
        return null;
      }

      const wasTripped = this.#client.getCircuitBreakerState().tripped;
      this.#mode = "polling";
      try {
        const outcome = await this.#client.withSessionDetailed(fn);
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
   * Execute a high-priority control mutation and broadcast `control:applied`.
   * Never hijacks an active human browser session: if a human is logged into `192.168.8.1`, throws
   * `BrowserSessionYieldedError` (`409 Conflict`) immediately instead of queuing a delayed surprise
   * mutation. Writes are never replayed (`retriesOnOccupied: 0`).
   */
  async executeControl<T>(
    actionName: string,
    fn: (session: EphemeralCpeSession) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary)
  ): Promise<T> {
    return await this.#enqueue("high", async () => {
      if (this.#peerStandby.active) throw new PeerDaemonStandbyError(this.#peerStandby.peerAddress);
      const wasTripped = this.#client.getCircuitBreakerState().tripped;
      try {
        const outcome = await this.#client.withSessionDetailed(fn, {
          retriesOnOccupied: 0,
        });
        if (outcome.status === "yielded") {
          this.#enterAvoidance(outcome.layer, outcome.stateCode);
          throw new BrowserSessionYieldedError();
        }
        this.#clearAvoidanceIfActive();
        this.#mode = "idle";
        this.#lastError = null;

        const resolvedSummary = typeof summary === "function" ? summary(outcome.value) : summary;
        const appliedEvent: ControlAppliedEvent = {
          action: actionName,
          tsIso: resolvedSummary?.lockState?.updatedAtIso ?? new Date().toISOString(),
          summaryZh: resolvedSummary?.zh ?? actionName,
          summaryEn: resolvedSummary?.en ?? actionName,
          lockState: resolvedSummary?.lockState,
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
    if (isInsideCpeSession(this.#client)) {
      return Promise.reject(new ReentrantCpeSessionError());
    }
    if (this.#stopping) {
      return Promise.reject(new SchedulerStoppedError());
    }
    if (this.#queue.length >= this.maxQueueDepth) {
      return Promise.reject(new SchedulerQueueFullError(this.maxQueueDepth));
    }
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = { priority, execute, resolve, reject };
      this.#queue.push(task as QueuedTask<unknown>);
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
    // Cancelled by stop(): says nothing about the router's health
    if (err instanceof SchedulerStoppedError) {
      if (this.#mode === "polling") this.#mode = "idle";
      throw err;
    }
    this.#lastError = err instanceof Error ? err.message : String(err);
    const cb = this.#client.getCircuitBreakerState();
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
}
