import type { ReadCapability, ReadSection, WriteAccess } from "./device-access.ts";
import { type DeviceVerification, deviceVerification, isVerifiedModel } from "./firmware.ts";

/**
 * Who the router is and what it says it can do. One read session (at daemon start and in the
 * console's connection test) sends the fixed list of GETs below and nothing else; the answers become
 * four endpoint states, the identity, the LTE bands and a structure-only record (tag paths and value
 * shapes) for the device report. Values are kept only for an allowlist: model, firmware and WebUI
 * version, `password_type` and small feature-switch numbers.
 *
 * Zero dependencies: the daemon, the web console and the static demo share this module.
 */

/** Every GET the identification and capability probe may send, in the order it sends them. */
export const DEVICE_PROBE_PATHS = [
  "/api/user/state-login",
  "/api/device/information",
  "/api/device/basic_information",
  "/api/device/basicinformation",
  "/api/device/device-feature-switch",
  "/api/net/net-feature-switch",
  "/api/wlan/wifi-feature-switch",
  "/api/system/devcapacity",
  "/api/net/net-mode-list",
  "/api/global/module-switch",
] as const;

/**
 * GETs the probe adds, after the list above, only for a model nobody verified (multi-model phase 3):
 * the read side of the writes FengSui may do there once its owner consents, i.e. the endpoint such a
 * write reads back. A verified model, and a router that names no model, never get them.
 */
export const EXPERIMENTAL_PROBE_PATHS = ["/api/net/net-mode", "/api/dialup/mobile-dataswitch", "/api/sms/sms-count"] as const;

export type DeviceProbePath = (typeof DEVICE_PROBE_PATHS)[number] | (typeof EXPERIMENTAL_PROBE_PATHS)[number];

/**
 * Each probe GET gives up after this long: a router that leaves an unknown endpoint hanging instead
 * of answering `100002` holds the admin slot for at most 10 × 5 s (13 × 5 s for a model nobody
 * verified), inside the 90 s session budget.
 */
export const PROBE_REQUEST_TIMEOUT_MS = 5000;

const IDENTITY_PATHS: ReadonlySet<string> = new Set(["/api/device/information", "/api/device/basic_information", "/api/device/basicinformation"]);
const SWITCH_PATHS: ReadonlySet<string> = new Set([
  "/api/device/device-feature-switch",
  "/api/net/net-feature-switch",
  "/api/wlan/wifi-feature-switch",
  "/api/system/devcapacity",
  "/api/global/module-switch",
]);
/** Identity leaves whose values the report may carry (top level of an identity endpoint). */
const IDENTITY_VALUE_TAGS: ReadonlySet<string> = new Set(["devicename", "softwareversion", "webuiversion", "spreadname_en"]);

/**
 * `supported`: it answered; `unsupported`: `100002`; `restricted`: `100003`, which is NOT
 * unsupported (the H168-383 answers `GET /api/net/lock-freq` with it); `unknown`: another error
 * code, a transport failure, a timeout or an answer that could not be read (too big, cut off).
 */
export type EndpointState = "supported" | "unsupported" | "restricted" | "unknown";

export function endpointState(code: string): EndpointState {
  if (code === "100002") return "unsupported";
  if (code === "100003") return "restricted";
  return "unknown";
}

export interface EndpointProbe {
  path: DeviceProbePath;
  state: EndpointState;
  /** The router's error code (`100002`, `100003`, …); `null` when it answered, or never did. */
  code: string | null;
}

export type LoginScheme = "scram" | "sha256" | "base64" | "unknown";
export type TokenFlow = "webserver-token" | "sestokinfo" | "unknown";

export interface DeviceIdentity {
  model: string | null;
  /** `spreadname_en` of `basic_information`, e.g. "HUAWEI 5G CPE Ultra 6". */
  marketingName: string | null;
  softwareVersion: string | null;
  webUiVersion: string | null;
  /** `password_type` of `user/state-login`, as the router reports it. */
  passwordType: string | null;
  /** How FengSui logged in. */
  loginScheme: LoginScheme;
  /** The login answer carried a signed ECC key that verified (the encrypted channel is available). */
  ecc: boolean;
  /** Where the session's first CSRF token came from. */
  tokenFlow: TokenFlow;
  detectedAtIso: string;
}

/** The features of CONTEXT §7.1; each gets a capability state. */
export const DEVICE_FEATURES = [
  "telemetry",
  "neighbors",
  "topology",
  "smsRead",
  "smsWrite",
  "bandLock",
  "cellLock",
  "reboot",
  "reconnect",
  "mobileData",
  "securitySwitches",
  "wifi",
  "antenna",
  "accessControl",
] as const;

export type DeviceFeature = (typeof DEVICE_FEATURES)[number];

/**
 * The writes FengSui has a generic implementation for (HiLink request formats from the reference
 * project's facts, docs/PHASE1_PROTOCOL_SPEC.md A.11): what a model nobody verified may be offered as
 * an experimental write once its owner consents. Every other write stays the verified model's alone.
 */
export const EXPERIMENTAL_FEATURES = ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"] as const;

export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];

/**
 * `verified`: the model is on the verified list; `probe`: on another model, the probe found what the
 * feature's generic write reads back (or the module of a write-only endpoint); `none`: neither.
 */
export interface FeatureCapability {
  state: EndpointState;
  source: "verified" | "probe" | "none";
}

export interface DeviceCapabilities {
  probedAtIso: string;
  endpoints: EndpointProbe[];
  /** LTE bands `net/net-mode-list` advertises; `null` when it gave none. */
  lteBands: number[] | null;
  features: Record<DeviceFeature, FeatureCapability>;
}

export type ProbeOrigin = "startup" | "connection-test";

export type StructureKind = "xml" | "json" | "text";

/** One leaf of a response: its tag path below the root and the shapes of its values, never the values. */
export interface FieldShape {
  tag: string;
  /** e.g. `int`, `hex(18)`, `text(12)`, `empty`; up to three shapes joined with `|`. */
  shape: string;
  count: number;
  /** Only for allowlisted leaves. */
  value?: string;
}

export interface EndpointObservation {
  path: DeviceProbePath;
  /** `null` when the endpoint answered with an error (or not at all). */
  format: StructureKind | null;
  fields: FieldShape[];
  /** More leaves than the observation keeps. */
  truncated: boolean;
}

/** What one probe found; stored encrypted. Verification and features are derived when read. */
export interface DeviceProbeResult {
  identity: DeviceIdentity;
  endpoints: EndpointProbe[];
  lteBands: number[] | null;
  probedAtIso: string;
  origin: ProbeOrigin;
  observations: EndpointObservation[];
}

/** `GET /api/device/profile`: the probe as the console and adapters read it. */
export interface DeviceProfile {
  identity: DeviceIdentity;
  verification: DeviceVerification;
  capabilities: DeviceCapabilities;
  origin: ProbeOrigin;
}

/** The logged-in session the probe reads through (`EphemeralCpeSession` fits it). */
export interface ProbeSession {
  get(apiPath: string, extraHeaders?: Record<string, string>, overrideTimeoutMs?: number): Promise<string>;
  /** `false` once the session is over (deadline, logout, stop): no request can go out any more. */
  readonly open: boolean;
  readonly loginScheme: LoginScheme | null;
  readonly eccVerified: boolean;
  readonly tokenFlow: TokenFlow | null;
}

// ── Structure ────────────────────────────────────────────────────────────────

export interface StructureLeaf {
  path: string;
  raw: string;
}

export interface Structure {
  kind: StructureKind;
  leaves: StructureLeaf[];
  truncated: boolean;
}

const MAX_LEAVES = 400;
const MAX_DEPTH = 8;
const MAX_PATH_LENGTH = 96;
const ELEMENT_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const UNSAFE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Where the tag opened before `from` ends: the first `>` outside a quoted attribute value, or -1. */
function tagEnd(text: string, from: number): number {
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/** A leaf's raw text with each CDATA section replaced by its literal text, escaped like element text. */
function unwrapCdata(raw: string): string {
  let out = "";
  let cursor = 0;
  for (let at = raw.indexOf("<![CDATA[", cursor); at >= 0; at = raw.indexOf("<![CDATA[", cursor)) {
    const end = raw.indexOf("]]>", at + 9);
    if (end < 0) break;
    out += raw.slice(cursor, at) + raw.slice(at + 9, end).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    cursor = end + 3;
  }
  return out + raw.slice(cursor);
}

/**
 * The leaf elements of an XML answer (path below the root element, raw inner text), in one linear
 * pass without backtracking regexes. Declarations and comments are skipped, CDATA counts as the
 * literal text it holds, a `>` inside a quoted attribute does not end its tag, odd names and markup
 * are ignored, depth and leaf count are bounded. JSON and plain text are only classified.
 */
export function readStructure(body: string): Structure {
  const text = body.trimStart();
  if (text.startsWith("{") || text.startsWith("[")) return { kind: "json", leaves: [], truncated: false };
  if (!text.startsWith("<")) return { kind: "text", leaves: [], truncated: false };

  const leaves: StructureLeaf[] = [];
  const stack: Array<{ name: string; start: number; hasChild: boolean }> = [];
  let truncated = false;
  const pathOf = (extra: string | null): string => [...stack.slice(1).map((e) => e.name), ...(extra === null ? [] : [extra])].join(".");
  const record = (path: string, raw: string): void => {
    if (path === "" || path.length > MAX_PATH_LENGTH) return;
    if (leaves.length >= MAX_LEAVES) {
      truncated = true;
      return;
    }
    leaves.push({ path, raw });
  };

  let cursor = 0;
  while (cursor < text.length) {
    const lt = text.indexOf("<", cursor);
    if (lt < 0) break;
    if (text.startsWith("<!--", lt) || text.startsWith("<![CDATA[", lt)) {
      const terminator = text.startsWith("<!--", lt) ? "-->" : "]]>";
      const end = text.indexOf(terminator, lt + 4);
      cursor = end < 0 ? text.length : end + terminator.length;
      continue;
    }
    const gt = tagEnd(text, lt + 1);
    if (gt < 0) break;
    const inner = text.slice(lt + 1, gt).trim();
    cursor = gt + 1;
    if (inner.startsWith("?") || inner.startsWith("!")) continue;

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      let at = stack.length - 1;
      while (at >= 0 && stack[at]?.name !== name) at -= 1;
      if (at < 0) continue;
      const closing = stack[at];
      if (closing && at === stack.length - 1 && at > 0 && !closing.hasChild) record(pathOf(null), unwrapCdata(text.slice(closing.start, lt)));
      stack.length = at;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const name = (selfClosing ? inner.slice(0, -1) : inner).trim().split(/\s/)[0] ?? "";
    const parent = stack[stack.length - 1];
    if (parent) parent.hasChild = true;
    if (!ELEMENT_NAME.test(name) || UNSAFE_NAMES.has(name)) continue;
    if (selfClosing) {
      if (stack.length >= 1 && stack.length <= MAX_DEPTH) record(pathOf(name), "");
      continue;
    }
    if (stack.length > MAX_DEPTH) continue;
    stack.push({ name, start: gt + 1, hasChild: false });
  }
  return { kind: "xml", leaves, truncated };
}

/**
 * The body is a Huawei API answer: its root element is `<response>` (after an optional XML
 * declaration). An HTML page, an `<error>`, JSON or plain text is not.
 */
export function isResponseDocument(body: string): boolean {
  let text = body.trimStart();
  if (text.startsWith("<?xml")) {
    const end = text.indexOf("?>");
    if (end < 0) return false;
    text = text.slice(end + 2).trimStart();
  }
  return /^<response[\s/>]/.test(text);
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML entities and Huawei's `xss()` escapes (`&#40;` …) back to characters; anything odd stays as written. */
function decodeEntities(raw: string): string {
  return raw.replace(/&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|[a-z]{2,4});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return code >= 0x20 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? (NAMED_ENTITIES[body] ?? whole) : whole;
  });
}

const MAX_TEXT_LENGTH = 64;
const VERSION_ALPHABET = /^[A-Za-z0-9 ._()+-]+$/;

/**
 * Router text kept as an allowlisted value (whitespace collapsed) only when all of it is in a
 * version's alphabet and fits in 64 characters. Anything else is dropped whole, never patched with
 * `?` or cut, so no fragment of an identifier hidden in it can reach the report (R0-04).
 */
function inertText(raw: string): string | null {
  const text = raw.replace(/\s+/g, " ").trim();
  return text.length <= MAX_TEXT_LENGTH && VERSION_ALPHABET.test(text) ? text : null;
}

const MAC_ADDRESS = /^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/;

/** A value's shape without its characters: `empty`, `int`, `decimal`, `mac`, `ipv4`, `ipv6`, `hex(n)` or `text(n)`. */
export function valueShape(raw: string): string {
  const value = raw.trim();
  if (value === "") return "empty";
  if (/^-?\d{1,20}$/.test(value)) return "int";
  if (/^-?\d{1,12}\.\d{1,12}$/.test(value)) return "decimal";
  if (MAC_ADDRESS.test(value)) return "mac";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return "ipv4";
  if (/^[0-9A-Fa-f:.]{2,45}$/.test(value) && (value.includes("::") || value.split(":").length >= 8)) return "ipv6";
  if (/^[0-9A-Fa-f]+$/.test(value)) return `hex(${value.length})`;
  return `text(${[...value].length})`;
}

/** The value the report may carry for a leaf, or `null`. */
function allowedValue(endpoint: DeviceProbePath, tag: string, text: string): string | null {
  const leaf = tag.toLowerCase();
  if (IDENTITY_PATHS.has(endpoint) && IDENTITY_VALUE_TAGS.has(leaf)) return inertText(text);
  const number = text.trim();
  if (endpoint === "/api/user/state-login") return leaf === "password_type" && /^\d{1,2}$/.test(number) ? number : null;
  return SWITCH_PATHS.has(endpoint) && /^\d{1,2}$/.test(number) ? number : null;
}

const MAX_SHAPES = 3;

function observeFields(endpoint: DeviceProbePath, leaves: ReadonlyArray<StructureLeaf>): FieldShape[] {
  const byTag = new Map<string, { shapes: string[]; count: number; value: string | null }>();
  for (const leaf of leaves) {
    const text = decodeEntities(leaf.raw);
    const shape = valueShape(text);
    const seen = byTag.get(leaf.path);
    if (seen) {
      seen.count += 1;
      if (!seen.shapes.includes(shape) && seen.shapes.length < MAX_SHAPES) seen.shapes.push(shape);
      continue;
    }
    byTag.set(leaf.path, { shapes: [shape], count: 1, value: allowedValue(endpoint, leaf.path, text) });
  }
  return [...byTag].map(([tag, seen]) => ({ tag, shape: seen.shapes.join("|"), count: seen.count, ...(seen.value === null ? {} : { value: seen.value }) }));
}

/** LTE band numbers of a `net-mode-list` mask (bit `n - 1` is band `n`); `null` for anything but hex. */
export function maskToBands(hex: string): number[] | null {
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) return null;
  const bands: number[] = [];
  let mask = BigInt(`0x${clean}`);
  for (let band = 1; mask > 0n; band += 1, mask >>= 1n) {
    if ((mask & 1n) === 1n) bands.push(band);
  }
  return bands;
}

/** The LTE mask that means "every band" (`7fffffffffffffff`; case and leading zeros aside). */
export const LTE_ALL_BANDS_MASK = "7fffffffffffffff";

export function isAllBandsMask(hex: string): boolean {
  const clean = hex.trim().toLowerCase().replace(/^0+/, "");
  return clean === LTE_ALL_BANDS_MASK;
}

// ── Probe ────────────────────────────────────────────────────────────────────

/** The router's error code on an error thrown for its answer (`CpeApiError`), else `null`. */
function cpeErrorCode(err: unknown): string | null {
  if (!(err instanceof Error) || !("code" in err)) return null;
  return typeof err.code === "string" && /^\d{4,8}$/.test(err.code) ? err.code : null;
}

/**
 * Read the probe list inside a logged-in session, one GET after another. While the session is open,
 * whatever goes wrong with one endpoint (an error code, no answer, a timeout, an answer too big or
 * cut off) is that endpoint's state, so an odd endpoint never fails a connection test that logged
 * in. Once the session is over (deadline, logout, stop) the probe ends: nothing guessed is stored.
 */
export async function probeDevice(session: ProbeSession, opts: { nowIso: string; origin: ProbeOrigin }): Promise<DeviceProbeResult> {
  const endpoints: EndpointProbe[] = [];
  const observations: EndpointObservation[] = [];
  const leavesOf = new Map<DeviceProbePath, StructureLeaf[]>();
  const probe = async (path: DeviceProbePath): Promise<void> => {
    let body: string;
    try {
      body = await session.get(path, {}, PROBE_REQUEST_TIMEOUT_MS);
    } catch (err) {
      if (!session.open) throw err;
      const code = cpeErrorCode(err);
      endpoints.push({ path, state: code === null ? "unknown" : endpointState(code), code });
      observations.push({ path, format: null, fields: [], truncated: false });
      return;
    }
    const structure = readStructure(body);
    // Only an API answer counts: an HTML page (e.g. the WebUI served for an unknown path) or plain text is unknown
    const answered = structure.kind === "json" || isResponseDocument(body);
    if (answered) leavesOf.set(path, structure.leaves);
    endpoints.push({ path, state: answered ? "supported" : "unknown", code: null });
    observations.push({ path, format: structure.kind, fields: answered ? observeFields(path, structure.leaves) : [], truncated: answered && structure.truncated });
  };
  for (const path of DEVICE_PROBE_PATHS) await probe(path);

  const top = (path: DeviceProbePath, tag: string): string | null => {
    const want = tag.toLowerCase();
    const leaf = leavesOf.get(path)?.find((l) => l.path.toLowerCase() === want);
    return leaf ? inertText(decodeEntities(leaf.raw)) : null;
  };
  const identityTag = (tag: string): string | null =>
    top("/api/device/information", tag) ?? top("/api/device/basic_information", tag) ?? top("/api/device/basicinformation", tag);
  const passwordType = top("/api/user/state-login", "password_type");
  const model = identityTag("DeviceName");
  // A model nobody verified: the read side of the writes its owner may consent to (never the H168-383's)
  if (model !== null && !isVerifiedModel(model)) for (const path of EXPERIMENTAL_PROBE_PATHS) await probe(path);

  let lteBands: number[] | null = null;
  for (const leaf of leavesOf.get("/api/net/net-mode-list") ?? []) {
    if (leaf.path.toLowerCase() !== "ltebandlist.lteband.value") continue;
    const mask = decodeEntities(leaf.raw);
    // An entry that stands for every band (the reference project's LTE "ALL") names no band
    if (isAllBandsMask(mask)) continue;
    const bands = maskToBands(mask);
    if (bands) lteBands = [...new Set([...(lteBands ?? []), ...bands])].sort((a, b) => a - b);
  }

  return {
    identity: {
      model,
      marketingName: top("/api/device/basic_information", "spreadname_en") ?? top("/api/device/basicinformation", "spreadname_en"),
      softwareVersion: identityTag("SoftwareVersion"),
      webUiVersion: identityTag("WebUIVersion"),
      passwordType: passwordType !== null && /^\d{1,2}$/.test(passwordType) ? passwordType : null,
      loginScheme: session.loginScheme ?? "unknown",
      ecc: session.eccVerified,
      tokenFlow: session.tokenFlow ?? "unknown",
      detectedAtIso: opts.nowIso,
    },
    endpoints,
    lteBands,
    probedAtIso: opts.nowIso,
    origin: opts.origin,
    observations,
  };
}

const ENDPOINT_STATES: ReadonlySet<string> = new Set<EndpointState>(["supported", "unsupported", "restricted", "unknown"]);
const LOGIN_SCHEMES: ReadonlySet<string> = new Set<LoginScheme>(["scram", "sha256", "base64", "unknown"]);
const TOKEN_FLOWS: ReadonlySet<string> = new Set<TokenFlow>(["webserver-token", "sestokinfo", "unknown"]);
const PROBE_PATHS: ReadonlySet<string> = new Set<string>([...DEVICE_PROBE_PATHS, ...EXPERIMENTAL_PROBE_PATHS]);
const FORMATS: ReadonlySet<string> = new Set<StructureKind>(["xml", "json", "text"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): boolean => typeof value === "string";
const isTextOrNull = (value: unknown): boolean => value === null || typeof value === "string";

/**
 * A stored probe (from `state.json`, written by this or another version) has the shape this version
 * reads; anything else is treated as "not identified yet" rather than served half-broken.
 */
export function isDeviceProbeResult(value: unknown): value is DeviceProbeResult {
  if (!isRecord(value) || !isRecord(value["identity"])) return false;
  const id = value["identity"];
  const identityOk =
    isTextOrNull(id["model"]) &&
    isTextOrNull(id["marketingName"]) &&
    isTextOrNull(id["softwareVersion"]) &&
    isTextOrNull(id["webUiVersion"]) &&
    isTextOrNull(id["passwordType"]) &&
    LOGIN_SCHEMES.has(String(id["loginScheme"])) &&
    typeof id["ecc"] === "boolean" &&
    TOKEN_FLOWS.has(String(id["tokenFlow"])) &&
    isText(id["detectedAtIso"]);
  const endpoints = value["endpoints"];
  const endpointsOk =
    Array.isArray(endpoints) &&
    endpoints.every((e: unknown) => isRecord(e) && PROBE_PATHS.has(String(e["path"])) && ENDPOINT_STATES.has(String(e["state"])) && isTextOrNull(e["code"]));
  const bands = value["lteBands"];
  const bandsOk = bands === null || (Array.isArray(bands) && bands.every((b: unknown) => Number.isInteger(b)));
  const observations = value["observations"];
  const observationsOk =
    Array.isArray(observations) &&
    observations.every(
      (o: unknown) =>
        isRecord(o) &&
        PROBE_PATHS.has(String(o["path"])) &&
        (o["format"] === null || FORMATS.has(String(o["format"]))) &&
        typeof o["truncated"] === "boolean" &&
        Array.isArray(o["fields"]) &&
        o["fields"].every((f: unknown) => isRecord(f) && isText(f["tag"]) && isText(f["shape"]) && Number.isInteger(f["count"]) && (f["value"] === undefined || isText(f["value"])))
    );
  return identityOk && endpointsOk && bandsOk && observationsOk && isText(value["probedAtIso"]) && (value["origin"] === "startup" || value["origin"] === "connection-test");
}

/**
 * Whether the probe found what each generic write needs on this router (a model nobody verified):
 * the endpoint the write reads back, with the tags it reads, or for a write-only endpoint
 * (`device/control`, `net/reconnect`) the module it belongs to. Tag names only, never values.
 *
 * - `bandLock`: `net/net-mode-list` advertises LTE bands, and `net/net-mode` answers with the
 *   `NetworkMode`, `NetworkBand` and `LTEBand` the write sends back and checks;
 * - `reboot`: `device/information` answers (`device/control` is in that module);
 * - `reconnect`: `net/net-mode` or `net/net-mode-list` answers (`net/reconnect` is in that module);
 * - `mobileData`: `dialup/mobile-dataswitch` answers with `dataswitch`;
 * - `smsWrite`: `sms/sms-count` answers with `LocalUnread` and `LocalInbox`.
 */
export function experimentalEvidence(probe: DeviceProbeResult): Record<ExperimentalFeature, boolean> {
  const answered = (path: DeviceProbePath): boolean => probe.endpoints.some((e) => e.path === path && e.state === "supported");
  const tags = (path: DeviceProbePath): Set<string> =>
    new Set((probe.observations.find((o) => o.path === path)?.fields ?? []).map((f) => f.tag.toLowerCase()));
  const has = (path: DeviceProbePath, ...wanted: string[]): boolean => {
    const seen = tags(path);
    return answered(path) && wanted.every((tag) => seen.has(tag.toLowerCase()));
  };
  return {
    bandLock: (probe.lteBands?.length ?? 0) > 0 && has("/api/net/net-mode", "NetworkMode", "NetworkBand", "LTEBand"),
    reboot: answered("/api/device/information"),
    reconnect: answered("/api/net/net-mode") || answered("/api/net/net-mode-list"),
    mobileData: has("/api/dialup/mobile-dataswitch", "dataswitch"),
    smsWrite: has("/api/sms/sms-count", "LocalUnread", "LocalInbox"),
  };
}

/**
 * The profile as served: verification and features come from the verified list at read time, so an
 * upgrade that verifies a new build applies to a profile stored before it.
 */
export function deviceProfileOf(probe: DeviceProbeResult): DeviceProfile {
  const { identity } = probe;
  const verifiedModel = identity.model !== null && isVerifiedModel(identity.model);
  const evidence: Partial<Record<DeviceFeature, boolean>> = verifiedModel ? {} : experimentalEvidence(probe);
  const features = {} as Record<DeviceFeature, FeatureCapability>;
  for (const feature of DEVICE_FEATURES) {
    features[feature] = verifiedModel
      ? { state: "supported", source: "verified" }
      : evidence[feature] === true
        ? { state: "supported", source: "probe" }
        : { state: "unknown", source: "none" };
  }
  return {
    identity: { ...identity },
    verification: deviceVerification(identity.model, identity.softwareVersion),
    capabilities: {
      probedAtIso: probe.probedAtIso,
      endpoints: probe.endpoints.map((e) => ({ ...e })),
      lteBands: probe.lteBands ? [...probe.lteBands] : null,
      features,
    },
    origin: probe.origin,
  };
}

// ── Router error counts ──────────────────────────────────────────────────────

export interface ApiErrorStat {
  method: "GET" | "POST";
  /** Without the query string. */
  path: string;
  code: string;
  count: number;
  lastAtIso: string;
}

export interface ApiErrorSnapshot {
  sinceIso: string;
  entries: ApiErrorStat[];
}

const MAX_ERROR_KEYS = 100;

/** Router error codes per method, endpoint and code since the daemon started (bounded, in memory). */
export class ApiErrorTally {
  readonly #now: () => number;
  readonly #sinceIso: string;
  readonly #stats = new Map<string, ApiErrorStat>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
    this.#sinceIso = new Date(now()).toISOString();
  }

  record(method: string, apiPath: string, code: string): void {
    if (method !== "GET" && method !== "POST") return;
    const path = apiPath.split("?")[0] ?? "";
    if (!/^\/api\/[A-Za-z0-9_/-]{1,96}$/.test(path) || !/^\d{4,8}$/.test(code)) return;
    const key = `${method} ${path} ${code}`;
    const lastAtIso = new Date(this.#now()).toISOString();
    const known = this.#stats.get(key);
    if (known) {
      known.count += 1;
      known.lastAtIso = lastAtIso;
      return;
    }
    if (this.#stats.size >= MAX_ERROR_KEYS) return;
    this.#stats.set(key, { method, path, code, count: 1, lastAtIso });
  }

  snapshot(): ApiErrorSnapshot {
    const entries = [...this.#stats.values()]
      .map((stat) => ({ ...stat }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
    return { sinceIso: this.#sinceIso, entries };
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

export const DEVICE_REPORT_VERSION = 1;

export interface DeviceReportEndpoint extends EndpointProbe {
  format: StructureKind | null;
  fields: FieldShape[];
  truncated: boolean;
}

/** `GET /api/console/device-report`: structure, never values (allowlist aside). The user decides whether to share it. */
export interface DeviceReport {
  reportVersion: typeof DEVICE_REPORT_VERSION;
  fengsuiVersion: string;
  generatedAtIso: string;
  verification: DeviceVerification;
  identity: DeviceIdentity | null;
  capabilities: { probedAtIso: string; lteBands: number[] | null; features: Record<DeviceFeature, FeatureCapability> } | null;
  endpoints: DeviceReportEndpoint[];
  apiErrors: ApiErrorSnapshot;
  /** What FengSui does with this router: writes allowed or locked, and per read section what it answered (states and router codes only). */
  access: DeviceReportAccess | null;
}

export interface DeviceReportAccess {
  writes: WriteAccess;
  reads: Record<ReadSection, ReadCapability>;
}

export function buildDeviceReport(input: {
  probe: DeviceProbeResult | null;
  apiErrors: ApiErrorSnapshot;
  fengsuiVersion: string;
  generatedAtIso: string;
  access?: DeviceReportAccess | null;
}): DeviceReport {
  const apiErrors = { sinceIso: input.apiErrors.sinceIso, entries: input.apiErrors.entries.map((e) => ({ ...e })) };
  const base = { reportVersion: DEVICE_REPORT_VERSION, fengsuiVersion: input.fengsuiVersion, generatedAtIso: input.generatedAtIso } as const;
  const access: DeviceReportAccess | null = input.access
    ? { writes: input.access.writes, reads: Object.fromEntries(Object.entries(input.access.reads).map(([section, read]) => [section, { state: read.state, code: read.code }])) as Record<ReadSection, ReadCapability> }
    : null;
  if (!input.probe) return { ...base, verification: "unknown", identity: null, capabilities: null, endpoints: [], apiErrors, access };
  const profile = deviceProfileOf(input.probe);
  const observed = new Map(input.probe.observations.map((o) => [o.path, o]));
  return {
    ...base,
    verification: profile.verification,
    identity: profile.identity,
    capabilities: { probedAtIso: profile.capabilities.probedAtIso, lteBands: profile.capabilities.lteBands, features: profile.capabilities.features },
    endpoints: profile.capabilities.endpoints.map((endpoint) => {
      const observation = observed.get(endpoint.path);
      return {
        ...endpoint,
        format: observation?.format ?? null,
        fields: observation ? observation.fields.map((f) => ({ ...f })) : [],
        truncated: observation?.truncated ?? false,
      };
    }),
    apiErrors,
    access,
  };
}
