import { HuaweiCpeClient } from "../cpe-client.ts";
import type { ApiErrorTally } from "../device-profile.ts";
import { type RouterFamily, isDriverFamily } from "../router-family.ts";
import type { RouterDriver, RouterSession, RouterSessionContext } from "../router-session.ts";
import type { SessionClient, WithSessionOptions } from "../session-client.ts";
import type { SessionExecutionOutcome } from "../types.ts";
import { DriverRouterSession, driverFamilyDriver } from "./adapter.ts";
import { createDriverClient } from "./brands.ts";
import { HilinkRouterSession, huaweiDriver } from "./huawei.ts";
import { CounterRates } from "./snapshot.ts";

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
}

/** Where and how to reach the router. */
export interface ConnectionSettings {
  cpeUrl: string;
  cpeUsername: string;
  cpePassword: string;
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
  respectBrowserSession: boolean;
  sessionMaxHoldMs?: number;
  apiErrors: ApiErrorTally;
}

/**
 * The connection of `family`: on Huawei, `hilink` itself when given (the live client, which keeps
 * what it learnt about how its router logs in) or a new HiLink client; on any other brand, a new
 * client of its driver, with a fresh breaker and counter rates that start over.
 */
export function routerConnection(family: RouterFamily, settings: ConnectionSettings, ctx: RouterSessionContext, hilink?: HuaweiCpeClient): RouterConnection & { readonly hilink: HuaweiCpeClient | null } {
  if (!isDriverFamily(family)) {
    const client =
      hilink ??
      new HuaweiCpeClient({
        cpeUrl: settings.cpeUrl,
        cpeUsername: settings.cpeUsername,
        cpePassword: settings.cpePassword,
        fetchImpl: settings.fetchImpl,
        requestTimeoutMs: settings.requestTimeoutMs,
        respectBrowserSession: settings.respectBrowserSession,
        ...(settings.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: settings.sessionMaxHoldMs } : {}),
        apiErrors: settings.apiErrors,
      });
    return { driver: huaweiDriver, client, hilink: client, open: (fn, opts) => client.withSessionDetailed((session) => fn(new HilinkRouterSession(session, ctx)), opts) };
  }
  const client = createDriverClient(family, {
    cpeUrl: settings.cpeUrl,
    cpeUsername: settings.cpeUsername,
    cpePassword: settings.cpePassword,
    fetchImpl: settings.fetchImpl,
    requestTimeoutMs: settings.requestTimeoutMs,
    respectBrowserSession: settings.respectBrowserSession,
    ...(settings.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: settings.sessionMaxHoldMs } : {}),
    apiErrors: settings.apiErrors,
  });
  const rates = new CounterRates();
  return { driver: driverFamilyDriver(family), client, hilink: null, open: (fn, opts) => client.withSessionDetailed((session) => fn(new DriverRouterSession(session, ctx, rates)), opts) };
}
