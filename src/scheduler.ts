import { EventEmitter } from "node:events";
import { type AuditActor, type AuditOutcome, currentActor } from "./audit-log.ts";
import {
  CpeApiError,
  type EphemeralCpeSession,
  HuaweiCpeClient,
  ReentrantCpeSessionError,
  isInsideCpeSession,
} from "./cpe-client.ts";
import { CpeLoginMethodError, LOGIN_UNCONFIRMED_CODE } from "./cpe-auth.ts";
import { CpeControlValidationError, type PersistedLockState } from "./cpe-domain.ts";
import { type ApiErrorSnapshot, type DeviceProbeResult, type LoginScheme, type TokenFlow, isDeviceProbeResult, probeDevice } from "./device-profile.ts";
import { t } from "./i18n.ts";
import { getXmlTag } from "./xml.ts";
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

/**
 * The anti-brute-force breaker is open (`108006`/`108002`/`108001` wrong credentials, `108007`
 * router lockout): thrown for the call that tripped it and for every control while it stays
 * latched, which then makes no login attempt at all (`423 CIRCUIT_BREAKER_OPEN`).
 */
export class CircuitBreakerOpenError extends CpeApiError {
  readonly statusCode = 423;
  readonly circuitBreaker: CircuitBreakerState;

  constructor(circuitBreaker: CircuitBreakerState) {
    const code = circuitBreaker.code ?? "unknown";
    super(
      code,
      code === "108007"
        ? "circuit breaker open: the router has locked logins; once the lock has expired, POST /api/session/reset-breaker"
        : code === "115002"
          ? "circuit breaker open: the router wants its admin password changed on its own web page first; then save the new password in the console"
          : "circuit breaker open: no further login attempts until CPE_PASSWORD in .env is fixed and POST /api/session/reset-breaker is called",
      { remainCount: circuitBreaker.remainCount ?? null, waitTime: circuitBreaker.waitTime ?? null }
    );
    this.name = "CircuitBreakerOpenError";
    this.circuitBreaker = circuitBreaker;
  }
}

/** The login scheme of a stored identification, when it reads as one (state written by any version). */
function storedLoginScheme(probe: unknown): LoginScheme | null {
  return isDeviceProbeResult(probe) ? probe.identity.loginScheme : null;
}

/** The breaker state reported to adapters (the password fingerprint never leaves the client). */
function publicBreakerState(cb: CircuitBreakerState): CircuitBreakerState {
  return {
    tripped: cb.tripped,
    code: cb.code,
    reason: cb.reason,
    trippedAtIso: cb.trippedAtIso,
    remainCount: cb.remainCount ?? null,
    waitTime: cb.waitTime ?? null,
  };
}

/** No router password yet (first start before the console's setup): nothing may log in. */
export class CpeNotConfiguredError extends Error {
  readonly statusCode = 409;

  constructor() {
    super("The router connection is not set up yet: finish the setup in the web console");
    this.name = "CpeNotConfiguredError";
  }
}

/** One audit record of a write that reached the queue (`control:audit`). */
export interface ControlAuditEvent {
  /** The caller, captured where the write was requested (the queue runs tasks in its own context). */
  actor: AuditActor;
  action: string;
  outcome: AuditOutcome;
  detail: string | null;
}

/** A router connection the console wants to switch to. */
export interface ConnectionCandidate {
  url: string;
  username: string;
  password: string;
}

export type ConnectionTestResult =
  | {
      ok: true;
      holdMs: number;
      model: string | null;
      firmware: string | null;
      /** How the test logged in, settled before the password went out. */
      loginScheme: LoginScheme;
      tokenFlow: TokenFlow;
      /** The login offered an ECC key whose signature verified (the encrypted channel). */
      ecc: boolean;
    }
  | {
      ok: false;
      reason:
        | "invalid_url"
        | "wrong_password"
        | "last_attempt"
        | "locked"
        | "password_change_required"
        | "unsupported_login"
        | "scram_refused"
        | "unconfirmed_login"
        | "human_logged_in"
        | "unreachable"
        | "standby"
        | "router_error";
      code: string | null;
      /** Login attempts the router says are left (after a wrong password). */
      remainCount: number | null;
      /** Seconds until the router lifts its login lock. */
      waitTimeSec: number | null;
      message: string;
    };

/** A connection test and, when its session logged in, the device probe that session ran. */
export interface ConnectionTestOutcome {
  result: ConnectionTestResult;
  probe: DeviceProbeResult | null;
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
  /**
   * `CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM` (default `false`): let the console's connection test look
   * for a legacy login method although this router has logged in with SCRAM before (it was replaced
   * by an older model at the same address). Background sessions keep to SCRAM either way.
   */
  allowLegacyLoginAfterScram?: boolean;
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
  readonly #allowLegacyLoginAfterScram: boolean;

  readonly #client: HuaweiCpeClient;
  #initialized = false;
  #stopping = false;
  #mode: SchedulerMode = "idle";
  /** Login attempts the router said were left after the console's last failed connection test. */
  #remainingLogins: number | null = null;
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
    this.#allowLegacyLoginAfterScram = options.allowLegacyLoginAfterScram === true;
  }

  /**
   * Hydrate encrypted runtime state and the persisted circuit-breaker latch (idempotent).
   */
  init(): void {
    if (this.#initialized) return;
    const loaded = this.stateStore.load();
    this.#client.rememberLoginScheme(storedLoginScheme(loaded.deviceProbe));
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
      circuitBreaker: publicBreakerState(cb),
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
    return publicBreakerState(cb);
  }

  /**
   * Try a router connection the console was given, as one queued session of its own (so it never
   * overlaps ours) with a throwaway client: the live client, its breaker and its credentials stay
   * untouched whatever happens. One login attempt, never retried; a human on the WebUI is not kicked.
   */
  async testConnection(candidate: ConnectionCandidate, opts: { lastAttempt?: boolean } = {}): Promise<ConnectionTestResult> {
    return (await this.testConnectionDetailed(candidate, opts)).result;
  }

  /**
   * `testConnection`, plus what its session found once logged in: the same identification and
   * capability probe the daemon runs at start (`DEVICE_PROBE_PATHS`). Router error codes count in the
   * live client's tally.
   */
  async testConnectionDetailed(candidate: ConnectionCandidate, opts: { lastAttempt?: boolean } = {}): Promise<ConnectionTestOutcome> {
    const failure = (reason: Extract<ConnectionTestResult, { ok: false }>["reason"], message: string, extra: { code?: string | null; remainCount?: number | null; waitTimeSec?: number | null } = {}): ConnectionTestOutcome => ({
      result: {
        ok: false,
        reason,
        code: extra.code ?? null,
        remainCount: extra.remainCount ?? null,
        waitTimeSec: extra.waitTimeSec ?? null,
        message,
      },
      probe: null,
    });
    if (this.#peerStandby.active) return failure("standby", `another FengSui daemon (${this.#peerStandby.peerAddress ?? "?"}) manages this router`);
    let client: HuaweiCpeClient;
    try {
      client = new HuaweiCpeClient({
        cpeUrl: candidate.url,
        cpeUsername: candidate.username,
        cpePassword: candidate.password,
        fetchImpl: this.#client.fetchImpl,
        requestTimeoutMs: this.#client.timeoutMs,
        respectBrowserSession: true,
        apiErrors: this.#client.apiErrors,
      });
    } catch (err) {
      return failure("invalid_url", err instanceof Error ? err.message : String(err));
    }
    // One wrong password more would lock the router's logins: only a deliberate, confirmed attempt
    const remain = this.#remainingLogins ?? this.#client.getCircuitBreakerState().remainCount ?? null;
    if (remain !== null && remain <= 1 && opts.lastAttempt !== true) {
      return failure("last_attempt", "the router allows one more login attempt before it locks; confirm the password and try again deliberately", { remainCount: remain });
    }
    return await this.#enqueue("high", async (): Promise<ConnectionTestOutcome> => {
      // A router this daemon has seen log in with SCRAM keeps to SCRAM in a test as well (the owner's
      // decision): a refused challenge then sends no legacy password, unless re-detection is allowed
      if (!this.#allowLegacyLoginAfterScram) client.rememberLoginScheme(this.#client.knownLoginScheme);
      try {
        const outcome = await client.withSessionDetailed(
          async (session) => {
            const xml = await session.get("/api/device/information");
            const identified = {
              model: getXmlTag(xml, "DeviceName") ?? null,
              firmware: getXmlTag(xml, "SoftwareVersion") ?? null,
              loginScheme: session.loginScheme ?? "unknown",
              tokenFlow: session.tokenFlow ?? "unknown",
              ecc: session.eccVerified,
            };
            return { identified, probe: await probeDevice(session, { nowIso: new Date().toISOString(), origin: "connection-test" }) };
          },
          { retriesOnOccupied: 0 }
        );
        if (outcome.status === "yielded") return failure("human_logged_in", "someone is logged into the router's web page", { code: outcome.stateCode });
        this.#remainingLogins = null;
        return { result: { ok: true, holdMs: outcome.holdMs, ...outcome.value.identified }, probe: outcome.value.probe };
      } catch (err) {
        const breaker = client.getCircuitBreakerState();
        const message = err instanceof Error ? err.message : String(err);
        if (breaker.tripped && breaker.code === "108007") return failure("locked", message, { code: "108007", waitTimeSec: breaker.waitTime ?? null });
        if (breaker.tripped && breaker.code === "115002") return failure("password_change_required", message, { code: "115002" });
        // An answer to the password it could not place: it may have counted as a wrong attempt (code: the router's, if any)
        if (err instanceof CpeApiError && err.latchesBreaker) return failure("unconfirmed_login", message, { code: err.code === LOGIN_UNCONFIRMED_CODE ? null : err.code });
        if (breaker.tripped) {
          this.#remainingLogins = breaker.remainCount ?? this.#remainingLogins;
          return failure("wrong_password", message, { code: breaker.code, remainCount: breaker.remainCount ?? null });
        }
        if (err instanceof CpeLoginMethodError) return failure(err.scramKnown ? "scram_refused" : "unsupported_login", message, { code: err.probeCode });
        if (err instanceof CpeApiError) return failure("router_error", message, { code: err.code });
        return failure("unreachable", message);
      }
    });
  }

  /** Router error codes per endpoint since start, connection tests included (the device report). */
  apiErrorSnapshot(): ApiErrorSnapshot {
    return this.#client.apiErrors.snapshot();
  }

  /**
   * Switch the live client to a connection `testConnection` just proved, and clear its breaker.
   * `loginScheme` is how that test logged in: a SCRAM router then never gets a legacy password.
   */
  async applyConnection(candidate: ConnectionCandidate, opts: { loginScheme?: LoginScheme | null } = {}): Promise<CircuitBreakerState> {
    return await this.#enqueue("high", async () => {
      this.#client.reconfigure({ cpeUrl: candidate.url, cpeUsername: candidate.username, cpePassword: candidate.password, loginScheme: opts.loginScheme ?? null });
      this.#remainingLogins = null;
      const cb = this.#client.getCircuitBreakerState();
      this.#mode = "idle";
      this.#lastError = null;
      this.stateStore.update({ circuitBreaker: cb });
      await this.stateStore.flushAsync().catch(() => undefined);
      return publicBreakerState(cb);
    });
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
    if (!this.#client.configured) return Promise.resolve(null);
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
   * mutation. Writes are never replayed (`retriesOnOccupied: 0`). A summary function that returns
   * `null` (the session decided not to write) suppresses the broadcast.
   */
  async executeControl<T>(
    actionName: string,
    fn: (session: EphemeralCpeSession) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary | null)
  ): Promise<T> {
    const actor = currentActor();
    try {
      return await this.#runControl(actor, actionName, fn, summary);
    } catch (err) {
      const refused =
        err instanceof BrowserSessionYieldedError ||
        err instanceof PeerDaemonStandbyError ||
        err instanceof CircuitBreakerOpenError ||
        err instanceof CpeNotConfiguredError ||
        err instanceof SchedulerQueueFullError ||
        err instanceof SchedulerStoppedError;
      this.#audit(actor, actionName, refused ? "refused" : "failed", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  #audit(actor: AuditActor, action: string, outcome: AuditOutcome, detail: string | null): void {
    this.#safeEmit("control:audit", { actor, action, outcome, detail } satisfies ControlAuditEvent);
  }

  async #runControl<T>(
    actor: AuditActor,
    actionName: string,
    fn: (session: EphemeralCpeSession) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary | null)
  ): Promise<T> {
    if (!this.#client.configured) throw new CpeNotConfiguredError();
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
        if (resolvedSummary === null) return outcome.value;
        const appliedEvent: ControlAppliedEvent = {
          action: actionName,
          tsIso: resolvedSummary?.lockState?.updatedAtIso ?? new Date().toISOString(),
          summaryZh: resolvedSummary?.zh ?? actionName,
          summaryEn: resolvedSummary?.en ?? actionName,
          lockState: resolvedSummary?.lockState,
        };
        this.#safeEmit("control:applied", appliedEvent);
        this.#audit(actor, actionName, "applied", appliedEvent.summaryEn);
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
      throw new CircuitBreakerOpenError(publicBreakerState(cb));
    }

    // A CPE error code or rejected input means the router answered; only transport failures mean unreachable,
    // and a router that logged in with SCRAM before but now refuses it: nothing gets in until the owner acts, so it alerts
    this.#mode =
      err instanceof CpeApiError || err instanceof CpeControlValidationError || (err instanceof CpeLoginMethodError && !err.scramKnown)
        ? "idle"
        : "cpe_unreachable";
    throw err;
  }
}
