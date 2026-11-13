import type { ApiErrorTally } from "../device-profile.ts";
import type { DriverFamily } from "../router-family.ts";
import { type SessionAttempt, type SessionAttemptContext, SessionClient, type SessionPrecheck, type SessionProtocol, raceSignal } from "../session-client.ts";
import { CpeApiError } from "../session-errors.ts";
import { LanHttp, deadlineSignal } from "./transport.ts";
import type { DriverSession, DriverSessionHandle } from "./types.ts";

/**
 * How a driver family logs in and out. The guarantees around it (one session at a time, `finally`
 * logout, the deadline, yielding to a person, the breaker) are the shared `SessionClient`'s
 * (`src/session-client.ts`), the same code the HiLink client runs on.
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
  /**
   * The router answers this family's own login-free request the way only this family does (the
   * brand is told before any password goes out; `src/drivers/detect.ts`). Throws or resolves `false`
   * for any other router.
   */
  detect(http: LanHttp): Promise<boolean>;
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

export function isInsideDriverSession(client: DriverCpeClient): boolean {
  return client.insideSession;
}

/**
 * A driver family's way into a session, for the shared client: the family's own login-free check
 * (someone signed in, a locked login), one password submission, the family's logout on a fresh
 * bounded signal in `finally`. A login answered "someone else is signed in" yields: a driver's
 * password never goes out twice in a row.
 */
function driverSessionProtocol(protocol: DriverProtocol, logoutTimeoutMs: number): SessionProtocol<DriverSession> {
  return {
    retryOccupiedLogin: false,
    attempt(ctx: SessionAttemptContext): SessionAttempt<DriverSession> {
      const http = new LanHttp({ baseUrl: ctx.baseUrl, fetchImpl: ctx.fetchImpl, timeoutMs: ctx.timeoutMs, signal: ctx.deadline });
      const startedMs = performance.now();
      let handle: DriverSessionHandle | null = null;
      /** The login, while it runs: a family's login may do more after the router handed it a session. */
      let loggingIn: Promise<DriverSessionHandle> | null = null;
      return {
        get session(): DriverSession {
          if (!handle) throw new TypeError("the driver session was used before its login");
          return handle;
        },
        async precheck(): Promise<SessionPrecheck | null> {
          const pre = protocol.precheck ? await protocol.precheck(http) : null;
          if (!pre) return null;
          const locked = pre.locked
            ? new CpeApiError("108007", `the router has locked its login${pre.locked.waitSec !== null ? ` (${pre.locked.waitSec} s)` : ""}`, { waitTime: pre.locked.waitSec })
            : null;
          return { occupied: pre.occupied, stateCode: "occupied", locked };
        },
        async login(): Promise<void> {
          loggingIn = protocol.login(http, { username: ctx.username, password: ctx.password });
          handle = await loggingIn;
        },
        async logout(): Promise<number | null> {
          // The deadline or a stop cut the login short: wait (bounded) for it to end on the session's own
          // signal, which fails its last requests at once; a session the router handed out is still logged out
          if (!handle && loggingIn) {
            const settle = deadlineSignal(logoutTimeoutMs);
            try {
              handle = await raceSignal(
                loggingIn.catch((): null => null),
                settle.signal
              );
            } catch {
              // The login never ended: nothing to log out of that FengSui knows
            } finally {
              settle.clear();
            }
          }
          const opened = handle;
          if (!opened) return null;
          // Free the admin slot on a fresh bounded signal (the session's own may have fired); never throws
          const bound = deadlineSignal(logoutTimeoutMs);
          http.retarget(bound.signal);
          try {
            // Bounded on its own as well: a logout that never settles must not keep the slot
            await raceSignal(opened.logout(), bound.signal);
          } catch {
            // The router ends an idle session on its own; nothing to do here
          } finally {
            bound.clear();
          }
          return Math.max(0, Math.round(performance.now() - startedMs));
        },
      };
    },
  };
}

/** The session client of a driver family: the shared `SessionClient` with the family's protocol. */
export class DriverCpeClient extends SessionClient<DriverSession> {
  readonly driver: DriverProtocol;

  constructor(options: DriverCpeClientOptions) {
    super(driverSessionProtocol(options.protocol, options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS), {
      cpeUrl: options.cpeUrl,
      cpeUsername: options.cpeUsername ?? "",
      cpePassword: options.cpePassword,
      ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
      ...(options.respectBrowserSession !== undefined ? { respectBrowserSession: options.respectBrowserSession } : {}),
      allowPublicCpeHost: options.allowPublicCpeHost === true,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: options.sessionMaxHoldMs } : {}),
      ...(options.apiErrors !== undefined ? { apiErrors: options.apiErrors } : {}),
    });
    this.driver = options.protocol;
  }

  get family(): DriverFamily {
    return this.driver.family;
  }
}
