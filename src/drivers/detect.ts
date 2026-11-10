import { normalizeCpeUrl } from "../config.ts";
import type { RouterFamily } from "../router-family.ts";
import { getXmlTag } from "../xml.ts";
import { DRIVER_PROTOCOLS } from "./brands.ts";
import { LanHttp } from "./transport.ts";

/**
 * Which family the router at an address is, told from what it answers without a login: each family
 * has a request of its own that no other router answers the same way (its login page's first read).
 * No password, no session and no write is involved, so telling the brand costs no login attempt and
 * disturbs nobody signed in to the router's page. The console runs it when its owner leaves the
 * brand on "detect"; the daemon never runs it on its own.
 */

/**
 * The order a router with more than one matching signature is named in. NROS and ZTE's zWRT are
 * OpenWrt underneath (they answer `/ubus` as well), and NROS' module bridge answers HiLink-style
 * paths: the family with pages or objects of its own goes first, plain OpenWrt and HiLink last.
 */
export const DETECTION_ORDER: ReadonlyArray<RouterFamily> = ["nradio", "zte-zwrt", "fiberhome", "tozed", "pinsu", "zte-goform", "openwrt", "huawei"];

/** How long a router gets to answer the signature requests (they run side by side). */
export const DETECTION_TIMEOUT_MS = 5000;

/** HiLink: the login-free state read every HiLink page starts with (`<State>` and the login type). */
async function detectHuawei(http: LanHttp): Promise<boolean> {
  const res = await http.request({ method: "GET", path: "/api/user/state-login" });
  return res.status === 200 && getXmlTag(res.text, "State") !== null;
}

export interface DetectOptions {
  cpeUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default and upper bound: `DETECTION_TIMEOUT_MS`). */
  requestTimeoutMs?: number;
  allowPublicCpeHost?: boolean;
  /** Cancels the detection (the daemon stopping). */
  signal?: AbortSignal;
}

/**
 * The family of the router at `cpeUrl`, or `null` when it answers none of the signatures (another
 * brand, or nothing there). Throws only for an address FengSui would not talk to.
 */
export async function detectRouterFamily(options: DetectOptions): Promise<RouterFamily | null> {
  const baseUrl = normalizeCpeUrl(options.cpeUrl, { allowPublicHost: options.allowPublicCpeHost === true });
  const timeoutMs = Math.min(options.requestTimeoutMs ?? DETECTION_TIMEOUT_MS, DETECTION_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(DETECTION_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const fetchImpl = options.fetchImpl ?? fetch;
  const matched = await Promise.all(
    DETECTION_ORDER.map(async (family): Promise<boolean> => {
      // Its own cookie jar: one family's answer never rides on another's request
      const http = new LanHttp({ baseUrl, fetchImpl, timeoutMs, signal });
      try {
        return family === "huawei" ? await detectHuawei(http) : await DRIVER_PROTOCOLS[family].detect(http);
      } catch {
        return false;
      }
    })
  );
  const index = matched.indexOf(true);
  return index < 0 ? null : (DETECTION_ORDER[index] ?? null);
}
