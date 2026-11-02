import type {
  AccessControlEndpointResponse,
  AlertsResponse,
  ContactRecord,
  DeviceProfileResponse,
  DeviceReportResponse,
  HealthResponse,
  NeighborsEndpointResponse,
  SettingsEndpointResponse,
  SmsCountriesResponse,
  SmsStatusSnapshot,
  TelemetryEndpointResponse,
  TopologyEndpointResponse,
} from "../../../src/api-contract.ts";
import type { SmsMessageRecord } from "../../../src/sms/types.ts";

/**
 * What the static demo starts from: every snapshot the real daemon served while it ran against the
 * demo router (scripts/capture-demo-seed.ts records it at build time), so the shapes are the
 * daemon's own. All identifiers in it are RFC / reserved placeholders.
 */
export interface DemoSeed {
  version: 1;
  /** When the capture ran; `rebaseSeed` moves every timestamp onto the visitor's clock. */
  capturedAtMs: number;
  /** UTC offset of the machine that captured it: router-local SMS dates carry no zone. */
  capturedUtcOffsetMin: number;
  health: HealthResponse;
  telemetry: TelemetryEndpointResponse;
  neighbors: NeighborsEndpointResponse;
  topology: TopologyEndpointResponse;
  settings: SettingsEndpointResponse;
  alerts: AlertsResponse;
  accessControl: AccessControlEndpointResponse;
  sms: {
    status: SmsStatusSnapshot;
    countries: SmsCountriesResponse;
    messages: SmsMessageRecord[];
    contacts: ContactRecord[];
  };
  /** The daemon's own `controls.*`, `sms.*` and `alerts.*` messages, for toasts and alerts. */
  catalog: Record<"zh-CN" | "en", Record<string, string>>;
  /** The demo router as the daemon identified it, and its device report (seeds from before v1.6 lack it). */
  device?: { profile: DeviceProfileResponse; report: DeviceReportResponse };
}

const SNAPSHOT_KEYS = ["health", "telemetry", "neighbors", "topology", "settings", "alerts", "accessControl"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Check the seed file's outline before trusting it. The file is a build artifact published next to
 * the page, so this guards against a stale or truncated upload rather than hostile input.
 */
export function readDemoSeed(raw: unknown): DemoSeed {
  if (!isRecord(raw) || raw["version"] !== 1) throw new Error("demo seed: unsupported version");
  if (typeof raw["capturedAtMs"] !== "number" || typeof raw["capturedUtcOffsetMin"] !== "number") {
    throw new Error("demo seed: missing capture time");
  }
  for (const key of SNAPSHOT_KEYS) {
    const snapshot = raw[key];
    if (!isRecord(snapshot) || snapshot["ok"] !== true) throw new Error(`demo seed: missing ${key}`);
  }
  const sms = raw["sms"];
  if (!isRecord(sms) || !isRecord(sms["status"]) || !isRecord(sms["countries"]) || !Array.isArray(sms["messages"]) || !Array.isArray(sms["contacts"])) {
    throw new Error("demo seed: missing sms");
  }
  const catalog = raw["catalog"];
  if (!isRecord(catalog) || !isRecord(catalog["zh-CN"]) || !isRecord(catalog["en"])) throw new Error("demo seed: missing catalog");
  const device = raw["device"];
  if (device !== undefined && (!isRecord(device) || !isRecord(device["profile"]) || device["profile"]["ok"] !== true || !isRecord(device["report"]) || device["report"]["ok"] !== true)) {
    throw new Error("demo seed: malformed device");
  }
  return raw as unknown as DemoSeed;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ROUTER_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** Epoch milliseconds after 2001; smaller `…Ms` numbers are durations. */
const EPOCH_FLOOR_MS = 1e12;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `yyyy-MM-dd HH:mm:ss` in this browser's zone, as the router writes SMS dates. */
export function formatRouterDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Shift every instant in the seed by `deltaMs`: ISO strings, `…Ms` epoch numbers, and router-local
 * SMS dates (read in the capture machine's zone, written back in the visitor's). Date-only values
 * such as the billing month's start stay as they are.
 */
export function rebaseTimestamps<T>(value: T, deltaMs: number, capturedUtcOffsetMin: number): T {
  const visit = (node: unknown, key: string): unknown => {
    if (typeof node === "string") {
      if (ISO_INSTANT.test(node)) return new Date(Date.parse(node) + deltaMs).toISOString();
      const m = ROUTER_DATE.exec(node);
      if (m) {
        const [, y, mo, d, h, mi, s] = m.map(Number);
        const utc = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0) - capturedUtcOffsetMin * 60_000;
        return formatRouterDate(utc + deltaMs);
      }
      return node;
    }
    if (typeof node === "number") return key.endsWith("Ms") && node > EPOCH_FLOOR_MS ? node + deltaMs : node;
    if (Array.isArray(node)) return node.map((item) => visit(item, ""));
    if (isRecord(node)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        // A JSON "__proto__" key would otherwise rewire the copy's prototype (AGENTS.md 铁律六)
        if (!UNSAFE_KEYS.has(k)) out[k] = visit(v, k);
      }
      return out;
    }
    return node;
  };
  return visit(value, "") as T;
}

/** The seed as if it had been captured at `nowMs`. */
export function rebaseSeed(seed: DemoSeed, nowMs: number): DemoSeed {
  const rebased = rebaseTimestamps(seed, nowMs - seed.capturedAtMs, seed.capturedUtcOffsetMin);
  return { ...rebased, capturedAtMs: nowMs, capturedUtcOffsetMin: -new Date(nowMs).getTimezoneOffset() };
}
