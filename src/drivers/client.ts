import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { normalizeCpeUrl } from "../config.ts";
import { CpeApiError, CpeSessionDeadlineError, DEFAULT_SESSION_MAX_HOLD_MS, ReentrantCpeSessionError } from "../cpe-client.ts";
import { ApiErrorTally } from "../device-profile.ts";
import { t } from "../i18n.ts";
import type { DriverFamily } from "../router-family.ts";
import type { CircuitBreakerState, SessionExecutionOutcome, SessionTelemetry } from "../types.ts";
import { LanHttp } from "./transport.ts";
import type { DriverSession, DriverSessionHandle } from "./types.ts";

/**
 * The session client of the driver families, with the HiLink client's guarantees (铁律四 / 铁律五):
 *   1. One short session at a time (non-reentrant mutex), logged out in `finally`, bounded by a
 *      deadline (`sessionMaxHoldMs`) so a hung router never pins the admin slot.
 *   2. Yields to a person: a family that tells before the password that someone is signed in
 *      (layer 1), or answers the password that way (layer 2), gets no session; never retried.
 *   3. One password submission per session, and the breaker latches on a wrong password, a locked
 *      login or an answer FengSui cannot place, persisting across restarts until the password changes.
 *
 * Login outcomes use the HiLink codes the rest of FengSui already understands: `108006` wrong
 * password, `108007` locked, `108003` someone else signed in, `unconfirmed` an answer it cannot place.
 */

/** What a family tells before any password goes out (`null`: it has no such check). */
export interface DriverPrecheck {
  /** Someone is signed in to the router's page. */
  occupied: boolean;
  /** The router has locked its login (`waitSec`: how long, when it says). */
  locked: { waitSec: number | null } | null;
}

export interface DriverCredentials {
  username: string;
  password: string;
}

/** How one family opens a session. */
export interface DriverProtocol {
  readonly family: DriverFamily;
  precheck?(http: LanHttp): Promise<DriverPrecheck | null>;
  /** Submit the password once; throw `CpeApiError` with a login code when the router refuses it. */
  login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle>;
}

export interface DriverCpeClientOptions {
  protocol: DriverProtocol;
  cpeUrl: string;
  cpeUsername?: string;
  cpePassword: string;
  requestTimeoutMs?: number;
  respectBrowserSession?: boolean;
  allowPublicCpeHost?: boolean;
  fetchImpl?: typeof fetch;
  sessionMaxHoldMs?: number;
  apiErrors?: ApiErrorTally;
  /** How long the `finally` logout may take (default 4 s; lower only in tests). */
  logoutTimeoutMs?: number;
}

export interface DriverSessionOptions {
  respectBrowserSession?: boolean;
  /** Accepted for the scheduler's sake; a driver session never retries a login. */
  retriesOnOccupied?: number;
}

/** How long the `finally` logout may take once the session itself is over. */
const LOGOUT_TIMEOUT_MS = 4000;

const activeDriverSession = new AsyncLocalStorage<DriverCpeClient>();

function fingerprint(username: string, password: string): string {
  return crypto.createHash("sha256").update(`fengsui-cpe-cred:${username}:${password}`, "utf8").digest("hex");
}

function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

export function isInsideDriverSession(client: DriverCpeClient): boolean {
  return activeDriverSession.getStore() === client;
}

export class DriverCpeClient {
  readonly protocol: DriverProtocol;
  readonly timeoutMs: number;
  readonly defaultRespectBrowserSession: boolean;
  readonly fetchImpl: typeof fetch;
  readonly sessionMaxHoldMs: number;
  readonly apiErrors: ApiErrorTally;
  readonly #logoutTimeoutMs: number;
  readonly #allowPublicHost: boolean;
  #baseUrl: string;
  #username: string;
  #password: string;
  #mutex: Promise<unknown> = Promise.resolve();
  #activeCancel: AbortController | null = null;
  #tripped: CpeApiError | null = null;
  #trippedAtIso: string | null = null;
  #trippedFingerprint: string | null = null;
  #lastSessionHoldMs: number | null = null;
  #totalSessionsCompleted = 0;
  #browserYieldCount = 0;

  constructor(options: DriverCpeClientOptions) {
    this.protocol = options.protocol;
    this.#allowPublicHost = options.allowPublicCpeHost === true;
    this.#baseUrl = normalizeCpeUrl(options.cpeUrl, { allowPublicHost: this.#allowPublicHost });
    this.#username = options.cpeUsername ?? "";
    this.#password = options.cpePassword;
    this.timeoutMs = options.requestTimeoutMs ?? 15000;
    this.defaultRespectBrowserSession = options.respectBrowserSession ?? true;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sessionMaxHoldMs = Math.max(50, options.sessionMaxHoldMs ?? DEFAULT_SESSION_MAX_HOLD_MS);
    this.apiErrors = options.apiErrors ?? new ApiErrorTally();
    this.#logoutTimeoutMs = options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS;
  }

  get family(): DriverFamily {
    return this.protocol.family;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get username(): string {
    return this.#username;
  }

  get configured(): boolean {
    return this.#password !== "";
  }

  getPasswordFingerprint(): string {
    return fingerprint(this.#username, this.#password);
  }

  getCircuitBreakerState(): CircuitBreakerState {
    if (!this.#tripped) return { tripped: false, code: null, reason: null, trippedAtIso: null, remainCount: null, waitTime: null, passwordFingerprintHex: null };
    return {
      tripped: true,
      code: this.#tripped.code,
      reason: this.#tripped.message,
      trippedAtIso: this.#trippedAtIso,
      remainCount: this.#tripped.remainCount,
      waitTime: this.#tripped.waitTime,
      passwordFingerprintHex: this.#trippedFingerprint,
    };
  }

  /** Restore a persisted latch; it stays only while the password is the one that tripped it. */
  hydrateCircuitBreaker(saved: CircuitBreakerState | null | undefined): boolean {
    if (!saved?.tripped || !saved.code) return false;
    const current = this.getPasswordFingerprint();
    if (saved.passwordFingerprintHex && saved.passwordFingerprintHex !== current) return false;
    this.#tripped = new CpeApiError(saved.code, "persisted latch", { remainCount: saved.remainCount ?? null, waitTime: saved.waitTime ?? null });
    this.#trippedAtIso = saved.trippedAtIso ?? new Date().toISOString();
    this.#trippedFingerprint = saved.passwordFingerprintHex ?? current;
    return true;
  }

  resetCircuitBreaker(): void {
    this.#tripped = null;
    this.#trippedAtIso = null;
    this.#trippedFingerprint = null;
  }

  /** Point the client at a connection the console just proved (between sessions) and clear the breaker. */
  reconfigure(next: { cpeUrl: string; cpeUsername: string; cpePassword: string }): void {
    this.#baseUrl = normalizeCpeUrl(next.cpeUrl, { allowPublicHost: this.#allowPublicHost });
    this.#username = next.cpeUsername;
    this.#password = next.cpePassword;
    this.resetCircuitBreaker();
  }

  /** New credentials clear the breaker; the same ones keep it (`true` when they changed). */
  reloadCredentials(newPassword: string, newUsername?: string): boolean {
    const before = this.getPasswordFingerprint();
    this.#username = newUsername ?? this.#username;
    this.#password = newPassword;
    if (before === this.getPasswordFingerprint()) return false;
    this.resetCircuitBreaker();
    return true;
  }

  getTelemetry(): SessionTelemetry {
    return {
      lastSessionHoldMs: this.#lastSessionHoldMs,
      totalSessionsCompleted: this.#totalSessionsCompleted,
      browserYieldCount: this.#browserYieldCount,
      circuitBreaker: this.getCircuitBreakerState(),
    };
  }

  async waitForIdle(maxWaitMs = 4000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#mutex.then(
          () => true,
          () => true
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), maxWaitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  abortActiveSession(reason: Error): boolean {
    const active = this.#activeCancel;
    if (!active || active.signal.aborted) return false;
    active.abort(reason);
    return true;
  }

  #trip(err: CpeApiError, credentialFp: string): never {
    // Credentials changed while this session ran: the latch would land on the new password
    if (credentialFp !== this.getPasswordFingerprint()) throw err;
    if (!this.#tripped) {
      this.#tripped = err;
      this.#trippedAtIso = new Date().toISOString();
      this.#trippedFingerprint = credentialFp;
    }
    throw this.#tripped;
  }

  #yielded(layer: 1 | 2, stateCode: string): SessionExecutionOutcome<never> {
    this.#browserYieldCount += 1;
    return { status: "yielded", layer, stateCode, messageZh: t("zh-CN", "session.mode_yielding"), messageEn: t("en", "session.mode_yielding") };
  }

  async withSessionDetailed<T>(fn: (session: DriverSession) => Promise<T>, options: DriverSessionOptions = {}): Promise<SessionExecutionOutcome<T>> {
    if (activeDriverSession.getStore() === this) throw new ReentrantCpeSessionError();
    const respectBrowser = options.respectBrowserSession ?? this.defaultRespectBrowserSession;
    const run = async (): Promise<SessionExecutionOutcome<T>> => {
      if (this.#tripped) throw this.#tripped;
      const cancel = new AbortController();
      this.#activeCancel = cancel;
      try {
        return await this.#runSession(fn, cancel.signal, respectBrowser);
      } finally {
        if (this.#activeCancel === cancel) this.#activeCancel = null;
      }
    };
    // The hold time is known once the `finally` logout is done
    const next = this.#mutex.then(run, run).then((outcome) => (outcome.status === "ok" && this.#lastSessionHoldMs !== null ? { ...outcome, holdMs: this.#lastSessionHoldMs } : outcome));
    this.#mutex = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  }

  async withSession<T>(fn: (session: DriverSession) => Promise<T>, options: DriverSessionOptions = {}): Promise<T | null> {
    const outcome = await this.withSessionDetailed(fn, options);
    return outcome.status === "ok" ? outcome.value : null;
  }

  async #runSession<T>(fn: (session: DriverSession) => Promise<T>, cancel: AbortSignal, respectBrowser: boolean): Promise<SessionExecutionOutcome<T>> {
    const credentials: DriverCredentials = { username: this.#username, password: this.#password };
    const credentialFp = fingerprint(credentials.username, credentials.password);
    const deadline = new AbortController();
    // Not unref()'d: a session waiting only on its deadline keeps the process alive until the slot is free
    const timer = setTimeout(() => deadline.abort(new CpeSessionDeadlineError(this.sessionMaxHoldMs)), this.sessionMaxHoldMs);
    const forwardCancel = (): void => deadline.abort(cancel.reason);
    cancel.addEventListener("abort", forwardCancel, { once: true });
    const http = new LanHttp({ baseUrl: this.#baseUrl, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, signal: deadline.signal });
    const startedMs = performance.now();
    let session: DriverSessionHandle | null = null;
    try {
      const pre = this.protocol.precheck ? await raceSignal(this.protocol.precheck(http), deadline.signal) : null;
      if (pre?.locked) {
        this.#trip(new CpeApiError("108007", `the router has locked its login${pre.locked.waitSec !== null ? ` (${pre.locked.waitSec} s)` : ""}`, { waitTime: pre.locked.waitSec }), credentialFp);
      }
      if (respectBrowser && pre?.occupied) return this.#yielded(1, "occupied");
      try {
        session = await raceSignal(this.protocol.login(http, credentials), deadline.signal);
      } catch (err) {
        if (err instanceof CpeApiError && err.isCircuitBreakerFatal) this.#trip(err, credentialFp);
        // Someone signed in elsewhere: never pushed out, never tried again in this session
        if (err instanceof CpeApiError && err.isSessionOccupied) return this.#yielded(2, err.code);
        throw err;
      }
      const opened = session;
      const value = await raceSignal(
        activeDriverSession.run(this, () => fn(opened)),
        deadline.signal
      );
      return { status: "ok", value, holdMs: 0 };
    } finally {
      clearTimeout(timer);
      cancel.removeEventListener("abort", forwardCancel);
      if (session) {
        await this.#logout(http, session);
        this.#lastSessionHoldMs = Math.max(0, Math.round(performance.now() - startedMs));
        this.#totalSessionsCompleted += 1;
      }
    }
  }

  /** Free the admin slot on a fresh bounded signal (the session's own may have fired); never throws. */
  async #logout(http: LanHttp, session: DriverSessionHandle): Promise<void> {
    const bound = AbortSignal.timeout(this.#logoutTimeoutMs);
    http.retarget(bound);
    try {
      // Bounded on its own as well: a logout that never settles must not keep the slot
      await raceSignal(session.logout(), bound);
    } catch {
      // The router ends an idle session on its own; nothing to do here
    }
  }
}
