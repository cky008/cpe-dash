import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { type AuditActor, type AuditOutcome, currentActor } from "./audit-log.ts";
import {
  CpeAnswerFormatError,
  CpeApiError,
  CpeEncryptionUnavailableError,
  type EphemeralCpeSession,
  HuaweiCpeClient,
  ReentrantCpeSessionError,
  isInsideCpeSession,
} from "./cpe-client.ts";
import { CpeLoginMethodError, LOGIN_UNCONFIRMED_CODE } from "./cpe-auth.ts";
import { CpeControlValidationError, type GlobalTelemetrySnapshot, type PersistedLockState, readRouterModel, sectionUnavailableCode } from "./cpe-domain.ts";
import {
  CONTROL_FEATURES,
  type ControlAction,
  DeviceAccess,
  type DeviceAccessSnapshot,
  type ReadSection,
  type WriteCheck,
  type WriteFeature,
  type WriteResultRecord,
  modelLabel,
} from "./device-access.ts";
import { newWriteCheck } from "./generic-writes.ts";
import {
  type ApiErrorSnapshot,
  type DeviceFeature,
  type DeviceProbeResult,
  type LoginScheme,
  type TokenFlow,
  isDeviceProbeResult,
  probeDevice,
} from "./device-profile.ts";
import { verifiedModelsLabel } from "./firmware.ts";
import { type I18nKey, t } from "./i18n.ts";
import { getXmlTag } from "./xml.ts";
import { type AlertEventRecord, type EncryptedStateStore, MAX_GENERIC_WRITES } from "./state-store.ts";
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
  /** Only a generic write on a model nobody verified (phase 3): the endpoints it wrote and its read-back. */
  check?: WriteCheck;
}

/**
 * What a write learns in its own session, once the gate looked at the model right before it: whether
 * the router is a model nobody verified (then only the generic implementation may write, `generic`),
 * the LTE bands such a band lock may use, and the check the generic write fills in as it goes.
 */
export interface WriteContext {
  readonly generic: boolean;
  readonly lteBands: ReadonlyArray<number> | null;
  readonly check: WriteCheck;
}

/** A redial or reboot counts as done once a poll shows the connection or uptime started after it (seconds of clock slack). */
const RESTART_SLACK_SEC = 30;
/** Before this long a poll that shows no restart proves nothing yet (the router may not have gone down). */
const RESTART_GRACE_MS = 120_000;
/** No poll could tell by then: the check ends `unknown`. */
const RESTART_DEADLINE_MS = 15 * 60_000;

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
  /** The router's model as the write gate sees it, and whether FengSui may write to it. */
  device: DeviceAccessSnapshot;
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
 * A write refused because the router is a model FengSui was not verified on: unverified models are
 * read-only (`409 DEVICE_UNVERIFIED_READ_ONLY`). Nothing reached the router.
 */
export class DeviceReadOnlyError extends Error {
  readonly statusCode = 409;
  /** The router's model as it may be shown (`?` when it is not plain text). */
  readonly model: string;
  /** The feature the refused write belongs to (`null`: refused before it was known, e.g. an MCP tool). */
  readonly feature: DeviceFeature | null;
  readonly messageZh: string;
  readonly messageEn: string;

  constructor(model: string, feature: DeviceFeature | null) {
    const params = { model, verified: verifiedModelsLabel() };
    const en = t("en", "controls.device_read_only", params);
    super(en);
    this.name = "DeviceReadOnlyError";
    this.model = model;
    this.feature = feature;
    this.messageZh = t("zh-CN", "controls.device_read_only", params);
    this.messageEn = en;
  }
}

/**
 * A write whose own session could not read the router's model (it had not been seen in this run):
 * nothing was written (`409 DEVICE_NOT_IDENTIFIED`).
 */
export class DeviceNotIdentifiedError extends Error {
  readonly statusCode = 409;
  readonly messageZh: string;
  readonly messageEn: string;

  constructor() {
    const en = t("en", "controls.device_not_identified");
    super(en);
    this.name = "DeviceNotIdentifiedError";
    this.messageZh = t("zh-CN", "controls.device_not_identified");
    this.messageEn = en;
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
          : "circuit breaker open: no further login attempts until the router password is corrected in the console (Settings → Router tests it once and, if it logs in, saves it and clears the breaker)",
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
  /** The router's model and what FengSui may do with it (the write gate, `src/device-access.ts`). */
  readonly device = new DeviceAccess();
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
  /** Generic redials and reboots waiting for the polls to show them (record id → what to look for). */
  #pendingRestarts = new Map<string, { kind: "reboot" | "reconnect"; requestedAtMs: number }>();

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
    // Its own field since phase 2; state written before that keeps the stored identification's
    this.#client.rememberLoginScheme(loaded.knownLoginScheme ?? storedLoginScheme(loaded.deviceProbe));
    // Only a likely model until this run sees the router report it (see `DeviceAccess`)
    this.device.remember(loaded.deviceProbe?.identity.model, loaded.deviceProbe?.identity.softwareVersion);
    this.device.noteProbe(loaded.deviceProbe);
    this.device.restoreReads(loaded.deviceReads);
    // A redial or reboot an earlier run left pending: its polls are gone, so nothing can decide it now
    if (loaded.genericWrites.some((r) => r.readback === "pending")) {
      this.stateStore.update({
        genericWrites: loaded.genericWrites.map((r) => (r.readback === "pending" ? { ...r, readback: "unknown" as const, reason: "no_evidence" as const } : r)),
      });
    }
    this.#syncLoginPolicy();
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
    // Back from standby: the router may have been replaced while this daemon stayed off it
    if (peerAddress === null && this.#peerStandby.active) this.device.forget();
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
      device: this.device.snapshot(),
    };
  }

  /**
   * An identification of the router in use (start, catch-up, or a console test of it): the stored
   * model from now on, and seen in this run.
   */
  noteIdentification(probe: DeviceProbeResult): void {
    const before = this.device.current?.model ?? null;
    this.device.remember(probe.identity.model, probe.identity.softwareVersion);
    this.device.noteProbe(probe);
    this.#seeModel(probe.identity.model, probe.identity.softwareVersion, before);
    this.#syncLoginPolicy();
    // What the start-up reads found counts for the model just identified (stored with it by the caller's flush)
    const reads = this.device.readRecord;
    if (reads) this.stateStore.update({ deviceReads: reads });
  }

  /** A read of this run saw the router report its model (the 5 s poll reads `device/information`). */
  noteRouterModel(model: string | null, softwareVersion: string | null): void {
    this.#seeModel(model, softwareVersion);
  }

  /**
   * `device:changed` when the model contradicts the stored identification: the router was replaced.
   * `device:model` whenever the model the gate goes by becomes another one (its consents end).
   */
  #seeModel(model: string | null, softwareVersion: string | null, before: string | null = this.device.current?.model ?? null): void {
    const changed = this.device.see(model, softwareVersion);
    this.#syncLoginPolicy();
    if (changed) this.#safeEmit("device:changed", this.device.snapshot());
    const now = this.device.current?.model ?? null;
    if (now !== null && now !== before) this.#safeEmit("device:model", now);
  }

  /**
   * Read one section inside a session. On a router identified as a model nobody verified, a section
   * it answers without (`100002` / `100003`, or an answer FengSui's parser refuses) resolves to `null`
   * and is recorded as not on this model, instead of failing the session; transport failures still
   * fail it. A verified or not yet identified router reads exactly as before.
   */
  async readSection<T>(section: ReadSection, read: () => Promise<T>): Promise<T | null> {
    const tolerant = this.device.unverifiedModel;
    let value: T;
    try {
      value = await read();
    } catch (err) {
      const code = tolerant ? sectionUnavailableCode(err) : undefined;
      if (code === undefined) throw err;
      this.noteRead(section, { available: false, code });
      return null;
    }
    // Kept only for a model nobody verified (or, before any identification, for the one identified next)
    this.noteRead(section, { available: true });
    return value;
  }

  /** Record what the router answered for a section, kept with the identification. */
  noteRead(section: ReadSection, outcome: { available: true } | { available: false; code: string | null }): void {
    if (!this.device.noteRead(section, outcome)) return;
    this.stateStore.update({ deviceReads: this.device.readRecord });
    void this.stateStore.flushAsync().catch(() => undefined);
  }

  /** On a router identified as another model, SCRAM answers FengSui cannot place latch the breaker (R1-04). */
  #syncLoginPolicy(): void {
    this.#client.rememberUnverifiedModel(this.device.unverifiedModel);
  }

  /**
   * Refuse a write the router's model does not allow (before any session, in the queue, and in the
   * write's session): another model writes only what users verified on it or its owner consented to.
   */
  #assertWritable(feature: WriteFeature): void {
    const current = this.device.current;
    if (current && this.device.writeAccess(feature) === "read_only") throw new DeviceReadOnlyError(modelLabel(current.model), feature);
  }

  /** A write while this run has not seen the router's model: read it in the write's own session first. */
  async #confirmModel(session: EphemeralCpeSession, feature: WriteFeature): Promise<void> {
    const reported = await readRouterModel(session);
    if (!reported) throw new DeviceNotIdentifiedError();
    this.#seeModel(reported.model, reported.softwareVersion);
    this.#assertWritable(feature);
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
        "Circuit breaker latched on a wrong password: save the correct router password in the console (Settings → Router) instead, which clears it"
      );
    }
    if (!changed) {
      this.#client.resetCircuitBreaker();
    }
    // Nothing went to the router while the breaker was open: it may have been replaced meanwhile
    if (latched.tripped) this.device.forget();
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
      // And a router identified as another model latches an answer to the password it cannot place
      client.rememberUnverifiedModel(this.#client.unverifiedModel);
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
      // Possibly another router: its model is confirmed again before the next write
      this.device.forget();
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
    actionName: ControlAction,
    fn: (session: EphemeralCpeSession, write: WriteContext) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary | null)
  ): Promise<T> {
    const actor = currentActor();
    try {
      return await this.#runControl(actor, actionName, fn, summary);
    } catch (err) {
      const refused =
        err instanceof BrowserSessionYieldedError ||
        err instanceof DeviceReadOnlyError ||
        err instanceof DeviceNotIdentifiedError ||
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
    actionName: ControlAction,
    fn: (session: EphemeralCpeSession, write: WriteContext) => Promise<T>,
    summary?: ControlSummary | ((value: T) => ControlSummary | null)
  ): Promise<T> {
    if (!this.#client.configured) throw new CpeNotConfiguredError();
    const feature = CONTROL_FEATURES[actionName];
    // The write gate: a router whose model does not allow this write gets no session at all
    this.#assertWritable(feature);
    return await this.#enqueue("high", async () => {
      if (this.#peerStandby.active) throw new PeerDaemonStandbyError(this.#peerStandby.peerAddress);
      // The model may have changed while this write waited
      this.#assertWritable(feature);
      const wasTripped = this.#client.getCircuitBreakerState().tripped;
      /** Set once the gate let this write through in its session: which implementation applies. */
      const gate: { write: WriteContext | null } = { write: null };
      try {
        const outcome = await this.#client.withSessionDetailed(
          async (session) => {
            // A read that ended just before this session notes the model it saw only after the
            // queue's look, so look again here, right before the write
            if (this.device.confirmed) this.#assertWritable(feature);
            else await this.#confirmModel(session, feature);
            const write: WriteContext = { generic: this.device.generic, lteBands: this.device.experimentalLteBands, check: newWriteCheck() };
            gate.write = write;
            return await fn(session, write);
          },
          { retriesOnOccupied: 0 }
        );
        if (outcome.status === "yielded") {
          this.#enterAvoidance(outcome.layer, outcome.stateCode);
          throw new BrowserSessionYieldedError();
        }
        this.#clearAvoidanceIfActive();
        this.#mode = "idle";
        this.#lastError = null;

        // A generic write that wrote something: recorded, its read-back said, a mismatch alerted
        const generic = gate.write?.generic === true && gate.write.check.endpoints.length > 0 ? gate.write : null;
        const record = generic ? this.#recordGenericWrite(actionName, feature, generic.check, "applied", null) : null;

        const resolvedSummary = typeof summary === "function" ? summary(outcome.value) : summary;
        if (resolvedSummary === null) return outcome.value;
        const suffix = record ? readbackSuffix(record) : { zh: "", en: "" };
        const appliedEvent: ControlAppliedEvent = {
          action: actionName,
          tsIso: resolvedSummary?.lockState?.updatedAtIso ?? new Date().toISOString(),
          summaryZh: `${resolvedSummary?.zh ?? actionName}${suffix.zh}`,
          summaryEn: `${resolvedSummary?.en ?? actionName}${suffix.en}`,
          lockState: resolvedSummary?.lockState,
          ...(generic ? { check: { ...generic.check, endpoints: [...generic.check.endpoints] } } : {}),
        };
        this.#safeEmit("control:applied", appliedEvent);
        this.#audit(actor, actionName, "applied", appliedEvent.summaryEn);
        return outcome.value;
      } catch (err) {
        // A generic write that failed in its session: what it tried and the router's code are recorded
        const tried = gate.write;
        if (tried?.generic && (tried.check.endpoints.length > 0 || err instanceof CpeApiError)) {
          this.#recordGenericWrite(actionName, feature, { ...tried.check, readback: "none", reason: null }, "failed", err instanceof CpeApiError ? err.code : null);
        }
        if (err instanceof BrowserSessionYieldedError) {
          throw err;
        }
        // Refused by the write gate in a session that logged in and read fine
        if (err instanceof DeviceReadOnlyError || err instanceof DeviceNotIdentifiedError) {
          this.#clearAvoidanceIfActive();
          this.#mode = "idle";
          throw err;
        }
        return await this.#handleExecutionError(err, wasTripped);
      }
    });
  }

  /** The last generic writes on a model nobody verified, oldest first (the device report's "recent write results"). */
  get genericWrites(): WriteResultRecord[] {
    return this.stateStore.getState().genericWrites.map((r) => ({ ...r, endpoints: [...r.endpoints] }));
  }

  /**
   * Keep a generic write's result (endpoints, code, read-back; never a value), alert on a mismatch,
   * watch a redial or reboot. Only a code that is a router code is kept: the router's text in its
   * place would reach the device report.
   */
  #recordGenericWrite(action: ControlAction, feature: WriteFeature, check: WriteCheck, outcome: WriteResultRecord["outcome"], code: string | null): WriteResultRecord {
    const nowMs = Date.now();
    const record: WriteResultRecord = {
      id: crypto.randomUUID(),
      atIso: new Date(nowMs).toISOString(),
      action,
      feature,
      model: modelLabel(this.device.current?.model ?? "?"),
      endpoints: [...check.endpoints],
      outcome,
      code: code !== null && /^\d{4,8}$/.test(code) ? code : null,
      readback: check.readback,
      reason: check.reason,
    };
    this.#storeWrites([...this.stateStore.getState().genericWrites, record]);
    if (record.readback === "pending") this.#pendingRestarts.set(record.id, { kind: feature === "reboot" ? "reboot" : "reconnect", requestedAtMs: nowMs });
    if (record.readback === "mismatch") this.#raiseMismatch(record);
    return record;
  }

  #storeWrites(records: ReadonlyArray<WriteResultRecord>): void {
    const kept = records.slice(-MAX_GENERIC_WRITES);
    for (const id of this.#pendingRestarts.keys()) if (!kept.some((r) => r.id === id)) this.#pendingRestarts.delete(id);
    this.stateStore.update({ genericWrites: kept });
    void this.stateStore.flushAsync().catch(() => undefined);
  }

  #raiseMismatch(record: WriteResultRecord): void {
    const params = (locale: "zh-CN" | "en") => ({ action: record.action, model: record.model, reason: t(locale, readbackReasonKey(record.reason ?? "differs")) });
    this.raiseAlert({
      severity: "warning",
      code: "WRITE_READBACK_MISMATCH",
      messageZh: t("zh-CN", "alerts.write_readback_mismatch", params("zh-CN")),
      messageEn: t("en", "alerts.write_readback_mismatch", params("en")),
    });
  }

  /**
   * A poll that follows a generic redial or reboot: done once the connection (redial) or the uptime
   * (reboot; the connection when the router names no uptime) started after it; a router still running
   * past the grace period did not do it (an alert); with no poll able to tell by the deadline, unknown.
   * A counter at 0 tells nothing: it is also how traffic statistics without `CurrentConnectTime` read.
   */
  notePollForWrites(snapshot: GlobalTelemetrySnapshot): void {
    if (this.#pendingRestarts.size === 0) return;
    const decided = new Map<string, Pick<WriteResultRecord, "readback" | "reason">>();
    for (const [id, pending] of this.#pendingRestarts) {
      const elapsedMs = snapshot.capturedAtMs - pending.requestedAtMs;
      if (elapsedMs <= 0) continue;
      const connected = snapshot.device.connectionStatus === "901";
      const connectTime = snapshot.traffic.sessionConnectTimeSec;
      const connectAge = snapshot.unavailable?.includes("traffic") || !connected || connectTime <= 0 ? null : connectTime;
      const age = pending.kind === "reboot" && snapshot.device.uptimeSec > 0 ? snapshot.device.uptimeSec : connectAge;
      if (age !== null && age <= elapsedMs / 1000 + RESTART_SLACK_SEC) decided.set(id, { readback: "match", reason: null });
      else if (age !== null && elapsedMs >= RESTART_GRACE_MS) decided.set(id, { readback: "mismatch", reason: "no_restart" });
      else if (elapsedMs >= RESTART_DEADLINE_MS) decided.set(id, { readback: "unknown", reason: "no_evidence" });
    }
    if (decided.size === 0) return;
    for (const id of decided.keys()) this.#pendingRestarts.delete(id);
    const records = this.stateStore.getState().genericWrites.map((r) => {
      const result = decided.get(r.id);
      return result ? { ...r, ...result } : r;
    });
    this.#storeWrites(records);
    for (const r of records) if (decided.get(r.id)?.readback === "mismatch") this.#raiseMismatch(r);
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
        this.#recordLoginScheme();
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * Persist how the live client logs in once a session or a saved connection changed it. Connection
   * tests use a throwaway client, so one that is not saved never moves it (R1-13).
   */
  #recordLoginScheme(): void {
    if (!this.#initialized) return;
    const scheme = this.#client.knownLoginScheme;
    if (scheme === this.stateStore.getState().knownLoginScheme) return;
    this.stateStore.update({ knownLoginScheme: scheme });
    void this.stateStore.flushAsync().catch(() => undefined);
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
      // The reads leave the router alone for that long: it may be replaced meanwhile
      this.device.forget();
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
    const answered =
      err instanceof CpeApiError || err instanceof CpeControlValidationError || (err instanceof CpeLoginMethodError && !err.scramKnown);
    this.#mode = answered ? "idle" : "cpe_unreachable";
    // Out of sight, the router may be replaced: its model is confirmed again before the next write
    // (an answer FengSui could not read still came from the router that is there)
    const sawRouter = err instanceof CpeAnswerFormatError || err instanceof CpeEncryptionUnavailableError;
    if (!answered && !sawRouter) this.device.forget();
    throw err;
  }
}

function readbackReasonKey(reason: NonNullable<WriteResultRecord["reason"]>): I18nKey {
  return `readback.${reason}`;
}

/** What a generic write's summary adds: experimental, and how its read-back went. */
function readbackSuffix(record: WriteResultRecord): { zh: string; en: string } {
  const say = (locale: "zh-CN" | "en"): string => {
    const reason = record.reason ? t(locale, readbackReasonKey(record.reason)) : "";
    if (record.readback === "match") return t(locale, "controls.experimental_match");
    if (record.readback === "mismatch") return t(locale, "controls.experimental_mismatch", { reason });
    if (record.readback === "pending") return t(locale, "controls.experimental_pending");
    return t(locale, "controls.experimental_unknown", { reason });
  };
  return { zh: say("zh-CN"), en: say("en") };
}
