import fs from "node:fs";
import path from "node:path";
import type {
  AccessControlEndpointResponse,
  AlertsResponse,
  HealthResponse,
  NeighborsEndpointResponse,
  SettingsEndpointResponse,
  SmsContactsResponse,
  SmsCountriesResponse,
  SmsStatusResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  TelemetryEndpointResponse,
  TopologyEndpointResponse,
} from "../src/api-contract.ts";
import { getFlatCatalog } from "../src/i18n.ts";
import type { SmsMessageRecord } from "../src/sms/types.ts";
import type { DemoSeed } from "../web/src/demo/seed.ts";
import { startDemoDaemon } from "./demo-router.ts";

/**
 * Record the static demo's starting point: run the real daemon against the demo router, sign in as
 * the web console does, wait until every poll has landed, and save each snapshot the console reads
 * at start-up. `npm run build:demo` writes it to dist/demo/demo-seed.json; the contract test uses
 * `captureDemoSeed` to compare the browser backend with the daemon it imitates.
 */

/** Fictional contacts on reserved numbers, so the SMS centre shows names and a new conversation. */
const DEMO_CONTACTS = [
  { phone: "+353830000001", name: "Sam Demo", note: "Dinner club" },
  { phone: "+447700900123", name: "Parcel Depot", note: "Demo courier" },
  { phone: "+353830000002", name: "Robin Demo" },
] as const;

const SETTLE_TIMEOUT_MS = 60_000;
/** Message families the demo backend needs for control toasts, SMS summaries and alerts. */
const CATALOG_PREFIXES = ["controls.", "sms.", "alerts."] as const;

function catalogSubset(locale: "zh-CN" | "en"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(getFlatCatalog(locale))) {
    if (CATALOG_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = text;
  }
  return out;
}

export interface DemoSession {
  get<T>(route: string): Promise<T>;
  post<T>(route: string, body: unknown): Promise<T>;
}

/** Sign in with the API token and return a cookie-session client, as the web console holds one. */
export async function openDemoSession(baseUrl: string, token: string): Promise<DemoSession> {
  // The daemon's CSRF guard wants the custom header and an Origin matching Host, as a browser sends
  const headers = { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: baseUrl };
  const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers, body: JSON.stringify({ token }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!login.ok || !cookie) throw new Error(`demo login failed: HTTP ${login.status}`);
  const call = async <T>(route: string, init: RequestInit): Promise<T> => {
    const res = await fetch(`${baseUrl}${route}`, { ...init, headers: { ...headers, Cookie: cookie } });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${route}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    get: (route) => call(route, { method: "GET" }),
    post: (route, body) => call(route, { method: "POST", body: JSON.stringify(body) }),
  };
}

async function settle<T>(what: string, read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`demo capture: ${what} never arrived`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function plainRecord(m: SmsMessageRecord): SmsMessageRecord {
  const record: SmsMessageRecord = {
    index: m.index,
    phone: m.phone,
    content: m.content,
    date: m.date,
    smstat: m.smstat,
    isUnread: m.isUnread,
    direction: m.direction,
    uid: m.uid,
    verificationCode: m.verificationCode,
  };
  return m.pending ? { ...record, pending: true } : record;
}

/** Capture a seed from a running daemon (contacts are added through the API first). */
export async function captureDemoSeed(session: DemoSession): Promise<DemoSeed> {
  for (const contact of DEMO_CONTACTS) await session.post("/api/sms/contacts/upsert", contact);
  await settle(
    "telemetry",
    () => session.get<TelemetryEndpointResponse>("/api/telemetry"),
    (r) => r.telemetry !== null && r.telemetry.sms !== null
  );
  // The slow sweeps (topology, settings, access control) run minutes apart: ask for them now
  await session.post("/api/topology/refresh", {});
  await session.post("/api/settings/refresh", {});
  await session.post("/api/access-control/refresh", {});
  const topology = await settle("topology", () => session.get<TopologyEndpointResponse>("/api/topology"), (r) => r.topology !== null);
  const settings = await settle("settings", () => session.get<SettingsEndpointResponse>("/api/settings"), (r) => r.settings !== null);
  const accessControl = await settle(
    "access control",
    () => session.get<AccessControlEndpointResponse>("/api/access-control"),
    (r) => r.accessControl !== null && r.guard.daemonHostMac !== null
  );
  const smsStatus = await settle("SMS sync", () => session.get<SmsStatusResponse>("/api/sms/status"), (r) => r.status.seeded && !r.status.syncInProgress);
  const neighbors = await session.post<NeighborsEndpointResponse>("/api/neighbors/scan", {});
  if (!neighbors.neighbors) throw new Error("demo capture: the neighbor scan returned nothing");

  const threads = await session.get<SmsThreadsResponse>("/api/sms/threads?filter=all&search=&limit=500");
  const messages: SmsMessageRecord[] = [];
  for (const thread of threads.threads) {
    const detail = await session.get<SmsThreadResponse>(`/api/sms/thread?${new URLSearchParams({ key: thread.threadKey }).toString()}`);
    messages.push(...detail.thread.messages.map(plainRecord));
  }
  const contacts = await session.get<SmsContactsResponse>("/api/sms/contacts?search=&limit=5000");
  const [health, alerts, countries] = await Promise.all([
    session.get<HealthResponse>("/api/health"),
    session.get<AlertsResponse>("/api/alerts"),
    session.get<SmsCountriesResponse>("/api/sms/countries"),
  ]);
  // Re-read the snapshots last, so they carry the scheduler's latest counters
  const nowMs = Date.now();
  return {
    version: 1,
    capturedAtMs: nowMs,
    capturedUtcOffsetMin: -new Date(nowMs).getTimezoneOffset(),
    health,
    telemetry: await session.get<TelemetryEndpointResponse>("/api/telemetry"),
    neighbors: await session.get<NeighborsEndpointResponse>("/api/neighbors"),
    topology,
    settings,
    alerts,
    accessControl,
    sms: { status: smsStatus.status, countries, messages, contacts: contacts.contacts },
    catalog: { "zh-CN": catalogSubset("zh-CN"), en: catalogSubset("en") },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const out = path.resolve(process.argv[2] ?? path.join("dist", "demo", "demo-seed.json"));
  const token = "fengsui-demo-capture";
  const demo = await startDemoDaemon({ port: 0, token });
  try {
    const seed = await captureDemoSeed(await openDemoSession(demo.baseUrl, token));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(seed)}\n`);
    const kib = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`  demo seed ${kib} KiB (${seed.sms.messages.length} SMS, ${seed.topology.topology?.hosts.length ?? 0} hosts) -> ${path.relative(process.cwd(), out)}`);
  } finally {
    await demo.close();
  }
}
