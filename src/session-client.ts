import { AsyncLocalStorage } from "node:async_hooks";
import { normalizeCpeUrl } from "./config.ts";
import { ApiErrorTally } from "./device-profile.ts";
import { t } from "./i18n.ts";
import { CpeApiError, CpeSessionDeadlineError, DEFAULT_SESSION_MAX_HOLD_MS, ReentrantCpeSessionError, hashCredentialsFingerprint } from "./session-errors.ts";
import type { CircuitBreakerState, SessionExecutionOutcome, SessionTelemetry } from "./types.ts";

/**
 * The one session client every router brand goes through (铁律四 / 铁律五). A brand brings only how
 * it checks the login page, logs in and logs out (`SessionProtocol`); everything that keeps the
 * router's single admin slot safe is here, once:
 *   1. One short session at a time (a non-reentrant mutex), logged out in `finally`, bounded by a
 *      deadline (`sessionMaxHoldMs`) so a hung router or a hung piece of work never pins the slot.
 *   2. Yields to a person: someone signed in, seen before the password (layer 1) or in the answer to
 *      it (layer 2), gets the slot; respecting the browser, a login is never tried again.
 *   3. The password goes out once per attempt; a wrong password, a locked login or an answer
 *      FengSui cannot place latch the breaker, which survives a restart (`hydrateCircuitBreaker`)
 *      until the password changes.
 */

/** What the router says before any password goes out. */
export interface SessionPrecheck {
  /** Someone is signed in to the router's page right now. */
  occupied: boolean;
  /** How the router said so (reported with a layer-1 yield). */
  stateCode: string;
  /** The router has locked its login: the error the breaker latches on. */
  locked: CpeApiError | null;
}

/** One login attempt of a protocol: built before the precheck, logged out in `finally` whatever happened. */
export interface SessionAttempt<S> {
  /** The login page's own check (`null`: the brand has none). */
  precheck(): Promise<SessionPrecheck | null>;
  /** Submit the password once; a refusal throws `CpeApiError` with the login code. */
  login(precheck: SessionPrecheck | null): Promise<void>;
  /** The logged-in session the work gets. */
  readonly session: S;
  /**
   * Free the admin slot (never throws). Resolves how long the session held it in ms, or `null` when
   * it never logged in (nothing was held, nothing was sent).
   */
  logout(): Promise<number | null>;
}

export interface SessionAttemptContext {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /** Aborts at the session's deadline or when the run is cancelled. */
  deadline: AbortSignal;
  apiErrors: ApiErrorTally;
}

/** How one brand opens a session. */
export interface SessionProtocol<S> {
  attempt(ctx: SessionAttemptContext): SessionAttempt<S>;
  /**
   * The login is tried again (after a pause) when the answer to the password says someone else holds
   * the slot and the caller does not respect the browser (`retriesOnOccupied`); a brand whose password
   * must never go out twice in a row says `false`, and then yields.
   */
  readonly retryOccupiedLogin: boolean;
}

export interface SessionClientOptions {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
  requestTimeoutMs?: number;
  respectBrowserSession?: boolean;
  allowPublicCpeHost?: boolean;
  fetchImpl?: typeof fetch;
  /** Hard upper bound for one session, login to logout (default `DEFAULT_SESSION_MAX_HOLD_MS`). */
  sessionMaxHoldMs?: number;
  /** Where router error codes are counted (a connection test's throwaway client shares the live one's). */
  apiErrors?: ApiErrorTally;
}

export interface WithSessionOptions {
  respectBrowserSession?: boolean;
  /** Logins tried again when the admin slot is occupied (default 2); always 0 while respecting the browser. */
  retriesOnOccupied?: number;
  occupiedRetryDelayMs?: number;
}

const activeSession = new AsyncLocalStorage<SessionClient<unknown>>();

/** Resolve after `ms`, or reject with `signal.reason` as soon as it aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reject when `signal` aborts, even if `work` never settles (non-I/O hangs cannot pin the mutex). */
export function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
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

export class SessionClient<S> {
  readonly protocol: SessionProtocol<S>;
  readonly timeoutMs: number;
  readonly defaultRespectBrowserSession: boolean;
  readonly fetchImpl: typeof fetch;
  readonly sessionMaxHoldMs: number;
  /** Router error codes per endpoint since start (the device report); counting changes no request. */
  readonly apiErrors: ApiErrorTally;
  readonly #allowPublicHost: boolean;
  #baseUrl: string;
  #username: string;
  #password: string;
  #mutex: Promise<unknown> = Promise.resolve();
  /** Cancels the session run that holds the mutex right now (`abortActiveSession`). */
  #activeCancel: AbortController | null = null;
  #tripped: CpeApiError | null = null;
  #trippedAtIso: string | null = null;
  #trippedFingerprint: string | null = null;
  #lastSessionHoldMs: number | null = null;
  #totalSessionsCompleted = 0;
  #browserYieldCount = 0;

  constructor(protocol: SessionProtocol<S>, options: SessionClientOptions) {
    this.protocol = protocol;
    this.#allowPublicHost = options.allowPublicCpeHost === true;
    this.#baseUrl = normalizeCpeUrl(options.cpeUrl, { allowPublicHost: this.#allowPublicHost });
    this.#username = options.cpeUsername;
    this.#password = options.cpePassword;
    this.timeoutMs = options.requestTimeoutMs ?? 15000;
    this.defaultRespectBrowserSession = options.respectBrowserSession ?? true;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sessionMaxHoldMs = Math.max(50, options.sessionMaxHoldMs ?? DEFAULT_SESSION_MAX_HOLD_MS);
    this.apiErrors = options.apiErrors ?? new ApiErrorTally();
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get username(): string {
    return this.#username;
  }

  get password(): string {
    return this.#password;
  }

  /** The router has credentials to log in with (setup not finished otherwise). */
  get configured(): boolean {
    return this.#password !== "";
  }

  /** The caller runs inside one of this client's sessions right now. */
  get insideSession(): boolean {
    return activeSession.getStore() === this;
  }

  getPasswordFingerprint(): string {
    return hashCredentialsFingerprint(this.#username, this.#password);
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

  /**
   * Restore a persisted latch at startup: it stays only while the configured password is the one
   * that tripped it.
   */
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

  /** Point the client at a connection the console just proved (only between sessions) and clear the breaker. */
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

  /**
   * Wait for the running session and its `finally` logout (e.g. on SIGTERM): `true` once idle,
   * `false` when it still ran after `maxWaitMs`.
   */
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

  /**
   * Cancel the session running now (e.g. on shutdown) with `reason`: its pending requests abort, a
   * login or retry still to come never starts, and its `finally` logout still runs. `false`: none ran.
   */
  abortActiveSession(reason: Error): boolean {
    const active = this.#activeCancel;
    if (!active || active.signal.aborted) return false;
    active.abort(reason);
    return true;
  }

  /** Latch the breaker on `err` (once) and throw what it latched; credentials changed meanwhile: just throw. */
  #trip(err: CpeApiError, credentialFp: string): never {
    // Credentials hot-reloaded while this session ran: the latch would land on the new password
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

  async withSessionDetailed<T>(fn: (session: S) => Promise<T>, options: WithSessionOptions = {}): Promise<SessionExecutionOutcome<T>> {
    if (this.insideSession) throw new ReentrantCpeSessionError();
    const respectBrowser = options.respectBrowserSession ?? this.defaultRespectBrowserSession;
    const retryBaseDelayMs = options.occupiedRetryDelayMs ?? 1500;
    // Respecting the browser means never trying again against an occupied slot, whatever the caller asked
    const retriesOnOccupied = respectBrowser || !this.protocol.retryOccupiedLogin ? 0 : (options.retriesOnOccupied ?? 2);
    const run = async (): Promise<SessionExecutionOutcome<T>> => {
      if (this.#tripped) throw this.#tripped;
      // Run-scoped cancellation (`abortActiveSession`): pre-check, login, `fn` and retry waits
      const cancel = new AbortController();
      this.#activeCancel = cancel;
      try {
        return await this.#runSession(fn, cancel.signal, { respectBrowser, retriesOnOccupied, retryBaseDelayMs });
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

  async withSession<T>(fn: (session: S) => Promise<T>, options: WithSessionOptions = {}): Promise<T | null> {
    const outcome = await this.withSessionDetailed(fn, options);
    return outcome.status === "ok" ? outcome.value : null;
  }

  async #runSession<T>(
    fn: (session: S) => Promise<T>,
    cancel: AbortSignal,
    opts: { respectBrowser: boolean; retriesOnOccupied: number; retryBaseDelayMs: number }
  ): Promise<SessionExecutionOutcome<T>> {
    const username = this.#username;
    const password = this.#password;
    const credentialFp = hashCredentialsFingerprint(username, password);
    const maxAttempts = opts.retriesOnOccupied + 1;
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      cancel.throwIfAborted();
      const deadline = new AbortController();
      // Deliberately not unref()'d: a session waiting only on its deadline (a hung request or piece of
      // work) must keep the event loop alive until the deadline frees the slot; `finally` clears it
      const timer = setTimeout(() => deadline.abort(new CpeSessionDeadlineError(this.sessionMaxHoldMs)), this.sessionMaxHoldMs);
      const forwardCancel = (): void => deadline.abort(cancel.reason);
      cancel.addEventListener("abort", forwardCancel, { once: true });
      const attempt = this.protocol.attempt({
        baseUrl: this.#baseUrl,
        username,
        password,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        deadline: deadline.signal,
        apiErrors: this.apiErrors,
      });
      try {
        const pre = await raceSignal(attempt.precheck(), deadline.signal);
        if (pre?.locked) this.#trip(pre.locked, credentialFp);
        if (opts.respectBrowser && pre?.occupied) return this.#yielded(1, pre.stateCode);
        cancel.throwIfAborted();
        try {
          await raceSignal(attempt.login(pre), deadline.signal);
        } catch (err) {
          if (err instanceof CpeApiError && err.isCircuitBreakerFatal) this.#trip(err, credentialFp);
          // Only before the work starts: a write is never replayed
          if (err instanceof CpeApiError && err.isSessionOccupied) {
            if (attemptNo < maxAttempts) {
              await abortableDelay(opts.retryBaseDelayMs * attemptNo, cancel);
              continue;
            }
            // Someone signed in elsewhere: never pushed out
            if (opts.respectBrowser || !this.protocol.retryOccupiedLogin) return this.#yielded(2, err.code);
          }
          throw err;
        }
        const value = await raceSignal(
          activeSession.run(this, () => fn(attempt.session)),
          deadline.signal
        );
        return { status: "ok", value, holdMs: 0 };
      } finally {
        clearTimeout(timer);
        cancel.removeEventListener("abort", forwardCancel);
        const holdMs = await attempt.logout();
        if (holdMs !== null) {
          this.#lastSessionHoldMs = holdMs;
          this.#totalSessionsCompleted += 1;
        }
      }
    }
    return this.#yielded(2, "108003");
  }
}
