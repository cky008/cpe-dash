import { CpeControlValidationError } from "./control-error.ts";
import {
  type EndpointState,
  type FieldShape,
  PROBE_REQUEST_TIMEOUT_MS,
  type StructureKind,
  cpeErrorCode,
  endpointState,
  isResponseDocument,
  observeFields,
  readStructure,
} from "./device-profile.ts";

/**
 * Read-only discovery for AI agents testing a router (`probe_router_endpoints`): GETs of endpoints
 * an agent names, to find what FengSui does not use yet. They go through FengSui's own session (the
 * agent never logs in itself: the router allows one admin session, and wrong passwords lock it), one
 * session per call, and only GETs. Paths that belong to the session itself or act on some firmware
 * are refused before anything is sent. What comes back is the structure of each answer, as in the
 * device report: tag paths and value shapes, never a value.
 */

export const DISCOVERY_MAX_PATHS = 12;
/** Between two calls, so a sweep leaves the router's one admin session free for the polls and for people. */
export const DISCOVERY_PAUSE_MS = 10_000;

const PATH = /^\/api(?:\/[A-Za-z0-9_-]{1,64}){2,4}$/;
const MAX_PATH_LENGTH = 96;

/**
 * Families no discovery touches: the session's own login, logout, token and cookie endpoints (a GET
 * there can hand out a new session cookie or end the session), the SIM toolkit and USSD (their menus
 * act on the SIM and can send messages) and file uploads.
 */
const SESSION_FAMILIES: ReadonlySet<string> = new Set(["user", "webserver", "stk", "ussd", "filemanager"]);

/** GETs known to act: the operator scan drops the connection for minutes, the rest act on some firmware. */
const ACTING_PATHS: ReadonlySet<string> = new Set([
  "/api/net/plmn-list",
  "/api/online-update/check-new-version",
  "/api/device/compressed-logs",
]);

/** Words of a path segment (split at `-`, `_` and camelCase) that name an action. */
const ACTION_WORDS: ReadonlySet<string> = new Set([
  "ack",
  "answer",
  "apply",
  "backup",
  "call",
  "cancel",
  "clear",
  "commit",
  "connect",
  "control",
  "del",
  "delete",
  "dial",
  "disable",
  "disconnect",
  "enable",
  "erase",
  "factory",
  "format",
  "hangup",
  "install",
  "login",
  "logout",
  "operate",
  "pbc",
  "poweroff",
  "reboot",
  "reconnect",
  "release",
  "reload",
  "remove",
  "reset",
  "restart",
  "restore",
  "save",
  "scan",
  "send",
  "set",
  "shutdown",
  "unlock",
  "upgrade",
  "upload",
  "wps",
]);

/**
 * The router endpoints FengSui itself reads or writes (the protocol modules; a test keeps the two
 * in step), so a discovery result can say what is new.
 */
export const FENGSUI_ROUTER_ENDPOINTS: ReadonlySet<string> = new Set([
  "/api/device/antenna_set_type",
  "/api/device/antenna_type",
  "/api/device/basic_information",
  "/api/device/basicinformation",
  "/api/device/control",
  "/api/device/device-feature-switch",
  "/api/device/information",
  "/api/device/nbrcellinfo",
  "/api/device/ri",
  "/api/device/seccellinfo",
  "/api/device/signal",
  "/api/dialup/mobile-dataswitch",
  "/api/global/module-switch",
  "/api/lan/HostInfo",
  "/api/monitoring/check-notifications",
  "/api/monitoring/month_statistics",
  "/api/monitoring/start_date",
  "/api/monitoring/status",
  "/api/monitoring/traffic-statistics",
  "/api/net/cell-info",
  "/api/net/current-plmn",
  "/api/net/lock-freq",
  "/api/net/net-feature-switch",
  "/api/net/net-mode",
  "/api/net/net-mode-list",
  "/api/net/reconnect",
  "/api/security/bridgemode",
  "/api/security/dmz",
  "/api/security/firewall-switch",
  "/api/security/nat",
  "/api/security/upnp",
  "/api/sms/delete-sms",
  "/api/sms/send-sms",
  "/api/sms/send-status",
  "/api/sms/set-read",
  "/api/sms/sms-count",
  "/api/sms/sms-count-contact",
  "/api/sms/sms-list",
  "/api/sms/sms-list-contact",
  "/api/sms/sms-list-phone",
  "/api/system/devcapacity",
  "/api/system/HostInfo",
  "/api/system/topology",
  "/api/timerule/timerule",
  "/api/user/authentication_login",
  "/api/user/challenge_login",
  "/api/user/login",
  "/api/user/logout",
  "/api/user/state-login",
  "/api/webserver/publickey",
  "/api/webserver/SesTokInfo",
  "/api/webserver/token",
  "/api/wlan/host-list",
  "/api/wlan/multi-macfilter-settings",
  "/api/wlan/multi-macfilter-settings-ex",
  "/api/wlan/wifi-feature-switch",
  "/api/wlan/wlandbho",
]);

/** `session`: the session's own machinery (or the SIM toolkit, USSD, uploads); `acts`: a GET that acts on some firmware. */
export type DiscoveryRefusal = "session" | "acts";

export interface DiscoveredEndpoint {
  path: string;
  /** FengSui already reads or writes it. */
  known: boolean;
  /** As in the device report; `refused`: never sent. */
  state: EndpointState | "refused";
  /** The router's error code (`100002`, `100003`, …). */
  code: string | null;
  format: StructureKind | null;
  /** Tag paths and value shapes, never a value. */
  fields: FieldShape[];
  truncated: boolean;
  refused?: DiscoveryRefusal;
}

/** The session a discovery reads through (`EphemeralCpeSession` fits it). */
export interface DiscoverySession {
  peek(apiPath: string, timeoutMs: number): Promise<string>;
  /** `false` once the session is over (deadline, logout, stop). */
  readonly open: boolean;
}

/** Why `path` is never sent, or `null` when it may be read. */
export function discoveryRefusal(path: string): DiscoveryRefusal | null {
  const segments = path.split("/").slice(2);
  if (SESSION_FAMILIES.has((segments[0] ?? "").toLowerCase())) return "session";
  if (ACTING_PATHS.has(path)) return "acts";
  const words = segments.flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().split(/[-_]/));
  return words.some((word) => ACTION_WORDS.has(word)) ? "acts" : null;
}

/** The paths of a call: 1–12 API paths (`/api/` and two to four segments), each once. */
export function readDiscoveryPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new CpeControlValidationError('"paths" must list at least one API path');
  const paths = [...new Set(value)];
  if (paths.length > DISCOVERY_MAX_PATHS) throw new CpeControlValidationError(`At most ${DISCOVERY_MAX_PATHS} paths per call`);
  for (const path of paths) {
    if (typeof path !== "string" || path.length > MAX_PATH_LENGTH || !PATH.test(path)) {
      throw new CpeControlValidationError(`${JSON.stringify(path)} is not an API path such as /api/device/autorun-version`);
    }
  }
  return paths as string[];
}

/**
 * Discover `paths` in order: the refused ones without a request, the rest with one GET each inside
 * one session that `openSession` runs (none when every path is refused). `null` when the session
 * was skipped (someone on the router's web page, the breaker): nothing was read. While the session
 * is open, whatever goes wrong with one endpoint is that endpoint's state; once it is over, the call
 * fails rather than report guesses.
 */
export async function discoverEndpoints(
  paths: ReadonlyArray<string>,
  openSession: (probe: (session: DiscoverySession) => Promise<DiscoveredEndpoint[]>) => Promise<DiscoveredEndpoint[] | null>
): Promise<DiscoveredEndpoint[] | null> {
  const sendable = paths.filter((path) => discoveryRefusal(path) === null);
  const read = sendable.length === 0 ? [] : await openSession((session) => readEndpoints(session, sendable));
  if (read === null) return null;
  return paths.map((path): DiscoveredEndpoint => {
    const known = FENGSUI_ROUTER_ENDPOINTS.has(path);
    const refused = discoveryRefusal(path);
    if (refused !== null) return { path, known, state: "refused", code: null, format: null, fields: [], truncated: false, refused };
    return read.find((entry) => entry.path === path) ?? { path, known, state: "unknown", code: null, format: null, fields: [], truncated: false };
  });
}

async function readEndpoints(session: DiscoverySession, paths: ReadonlyArray<string>): Promise<DiscoveredEndpoint[]> {
  const results: DiscoveredEndpoint[] = [];
  for (const path of paths) {
    const known = FENGSUI_ROUTER_ENDPOINTS.has(path);
    let body: string;
    try {
      body = await session.peek(path, PROBE_REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (!session.open) throw err;
      const code = cpeErrorCode(err);
      results.push({ path, known, state: code === null ? "unknown" : endpointState(code), code, format: null, fields: [], truncated: false });
      continue;
    }
    const structure = readStructure(body);
    // Only an API answer counts: an HTML page (the WebUI served for an unknown path) or plain text is unknown
    const answered = structure.kind === "json" || isResponseDocument(body);
    results.push({
      path,
      known,
      state: answered ? "supported" : "unknown",
      code: null,
      format: structure.kind,
      fields: answered ? observeFields(structure.leaves) : [],
      truncated: answered && structure.truncated,
    });
  }
  return results;
}
