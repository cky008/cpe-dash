import { HuaweiCpeClient } from "../protocols/hilink/client.ts";
import { ApiErrorTally, type LoginScheme } from "../device-profile.ts";
import { type RouterFamily, isDriverFamily } from "../router-family.ts";
import type { RouterDriver, RouterSession, RouterSessionContext } from "../router-session.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, type SessionClient, type WithSessionOptions } from "../session-client.ts";
import type { CpeLoginState, SessionExecutionOutcome } from "../types.ts";
import { DriverRouterSession, driverFamilyDriver } from "./adapter.ts";
import { createDriverClient } from "./brands.ts";
import { HilinkRouterSession, huaweiDriver } from "./huawei/driver.ts";
import { CounterRates } from "./snapshot.ts";

/**
 * What a connection learns about how its router logs in, kept in state.json so that a restart starts
 * from it. HiLink learns both; a brand whose login learns nothing has `NO_KNOWN_LOGIN`.
 */
export interface KnownLogin {
  /** How the router last logged in (`null`: not known yet). */
  loginScheme: LoginScheme | null;
  /** The router has signed its encryption key at a login. */
  eccSigned: boolean;
}

const NO_KNOWN_LOGIN: KnownLogin = Object.freeze({ loginScheme: null, eccSigned: false });

/** The router a connection points at. */
export interface ConnectionTarget {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
}

/** The reads a brand's interface answers without a login: never queued, they take no admin slot. */
export interface LoginFreeReads {
  /** One GET of a path the brand answers without a login. */
  get(apiPath: string): Promise<string>;
  /** Who the login page says is signed in, and whether the login is locked. */
  loginState(): Promise<CpeLoginState>;
}

/**
 * A connection to one router: its brand's driver, the session client that holds its sessions (and
 * its breaker), and how one session of it opens as the brand's `RouterSession`. The only place that
 * picks a brand's session client and session object: the scheduler holds the live one, and a
 * connection test builds a throwaway one the same way.
 */
export interface RouterConnection {
  readonly driver: RouterDriver;
  readonly client: SessionClient<unknown>;
  open<T>(fn: (session: RouterSession) => Promise<T>, opts?: WithSessionOptions): Promise<SessionExecutionOutcome<T>>;
  /** What the connection knows of how its router logs in. */
  readonly knownLogin: KnownLogin;
  /** Take over what is known already: state.json at start, the live connection's in a test of its router. */
  rememberLogin(known: KnownLogin): void;
  /**
   * Point the connection at a router the console just proved (only between sessions): the breaker is
   * cleared, and what it learnt of the router before starts over (it may be another one) from how
   * that test logged in.
   */
  reconfigure(next: ConnectionTarget, loginScheme: LoginScheme | null): void;
  /** `null`: FengSui asks this brand nothing without a login. */
  readonly loginFree: LoginFreeReads | null;
}

/** Where and how to reach the router, as the daemon (or a test) says it; what is left out takes the usual value. */
export interface ConnectionOptions {
  cpeUrl: string;
  /** Default `admin`. */
  cpeUsername?: string;
  /** Empty: the console's setup has not given one yet, and nothing logs in. */
  cpePassword: string;
  /** How requests go out (tests put a mock router here); default the global `fetch`. */
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** `RESPECT_BROWSER_SESSION` (default `true`): yield to a person signed in to the router's page. */
  respectBrowserSession?: boolean;
  /** Hard upper bound for one session, login to logout. */
  sessionMaxHoldMs?: number;
  /** Where router error codes are counted; default a tally of the connection's own. */
  apiErrors?: ApiErrorTally;
  /** `CPE_REQUIRE_ECC_SIGNATURE` (HiLink; default `true`): end a session whose router, known to sign its encryption key, sends it unsigned. */
  requireEccSignature?: boolean;
}

/** `ConnectionOptions` with the usual values filled in. */
export interface ConnectionSettings extends ConnectionTarget {
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  respectBrowserSession: boolean;
  sessionMaxHoldMs?: number;
  apiErrors: ApiErrorTally;
  requireEccSignature?: boolean;
}

export function connectionSettings(options: ConnectionOptions): ConnectionSettings {
  return {
    cpeUrl: options.cpeUrl,
    cpeUsername: options.cpeUsername ?? "admin",
    cpePassword: options.cpePassword,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    respectBrowserSession: options.respectBrowserSession ?? true,
    ...(options.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: options.sessionMaxHoldMs } : {}),
    apiErrors: options.apiErrors ?? new ApiErrorTally(),
    ...(options.requireEccSignature !== undefined ? { requireEccSignature: options.requireEccSignature } : {}),
  };
}

/**
 * The connection of `family` to the router `settings` names, with a breaker of its own. On Huawei,
 * a HiLink client and what it learns of the router's login, which plans each login with what the
 * daemon knows of the model (`ctx.device`); on any other brand, a client of its driver, and the
 * rates derived from its byte counters.
 */
export function routerConnection(family: RouterFamily, settings: ConnectionSettings, ctx: RouterSessionContext): RouterConnection {
  const shared = {
    cpeUrl: settings.cpeUrl,
    cpeUsername: settings.cpeUsername,
    cpePassword: settings.cpePassword,
    fetchImpl: settings.fetchImpl,
    requestTimeoutMs: settings.requestTimeoutMs,
    respectBrowserSession: settings.respectBrowserSession,
    ...(settings.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: settings.sessionMaxHoldMs } : {}),
    apiErrors: settings.apiErrors,
  };
  if (!isDriverFamily(family)) {
    const client = new HuaweiCpeClient({
      ...shared,
      ...(settings.requireEccSignature !== undefined ? { requireEccSignature: settings.requireEccSignature } : {}),
      unverifiedModel: () => ctx.device.unverifiedModel,
    });
    return {
      driver: huaweiDriver,
      client,
      open: (fn, opts) => client.withSessionDetailed((session) => fn(new HilinkRouterSession(session, ctx)), opts),
      get knownLogin(): KnownLogin {
        return { loginScheme: client.knownLoginScheme, eccSigned: client.eccSignedKnown };
      },
      rememberLogin(known) {
        client.rememberLoginScheme(known.loginScheme);
        client.rememberEccSigned(known.eccSigned);
      },
      // Whether the router signs its key is learnt again as well (the client forgets it)
      reconfigure: (next, loginScheme) => client.reconfigure({ ...next, loginScheme }),
      loginFree: { get: (apiPath) => client.getPublic(apiPath), loginState: () => client.getLoginState() },
    };
  }
  const client = createDriverClient(family, shared);
  const rates = new CounterRates();
  return {
    driver: driverFamilyDriver(family),
    client,
    open: (fn, opts) => client.withSessionDetailed((session) => fn(new DriverRouterSession(session, ctx, rates)), opts),
    knownLogin: NO_KNOWN_LOGIN,
    rememberLogin: () => undefined,
    reconfigure(next) {
      client.reconfigure(next);
      // Another router's counters are not comparable with the last ones seen
      rates.reset();
    },
    loginFree: null,
  };
}
