import { AccessPlanError, planTimeRuleChange, planWifiAccessChange } from "../../../src/access-plan.ts";
import type { TimeRuleChange, TimeRuleWrite, WifiAccessChange, WifiFilterWrite } from "../../../src/access-plan.ts";
import { isDeviceBlocked, normalizeMac } from "../../../src/access-state.ts";
import type {
  AccessControlChangeResponse,
  AccessControlEndpointResponse,
  AccessControlSnapshot,
  CellularEndpointResponse,
  AccessGuardInfo,
  AlertEventRecord,
  AlertsResponse,
  AntennaControlResponse,
  ApiErrorCode,
  ApiErrorEnvelope,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuthStatusResponse,
  ConnectionTestResponse,
  ContactDeleteResponse,
  ContactUpsertResponse,
  ControlAppliedEvent,
  DeviceProfileResponse,
  GlobalTelemetrySnapshot,
  HealthResponse,
  LockStateResponse,
  LockVerification,
  MobileDataControlResponse,
  NeighborScanSnapshot,
  NeighborsEndpointResponse,
  PersistedLockState,
  RebootResponse,
  ReconnectResponse,
  ResetBreakerResponse,
  RouterSettingsSnapshot,
  SchedulerStatusSnapshot,
  SecurityControlResponse,
  SessionStatusResponse,
  SettingsEndpointResponse,
  SettingsRefreshResponse,
  SmsContactsResponse,
  SmsCountriesResponse,
  SmsDeleteResponse,
  SmsPurgeResponse,
  SmsRestoreResponse,
  SmsTrashResponse,
  SmsPreviewResponse,
  SmsReadResponse,
  SmsSendResponse,
  SmsStatusResponse,
  SmsSyncResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  SseEventPayloads,
  SseHelloPayload,
  TelemetryEndpointResponse,
  TelemetryRefreshResponse,
  TerminalTopologySnapshot,
  TimeRule,
  TimeSeriesEndpointResponse,
  TopologyEndpointResponse,
  VcardImportResponse,
  Wifi7ControlResponse,
  WifiMacFilterState,
} from "../../../src/api-contract.ts";
import { DEFAULT_BEHAVIOUR } from "../../../src/behaviour-settings.ts";
import { CpeControlValidationError } from "../../../src/control-error.ts";
import { gateRefuses } from "../../../src/device-access.ts";
import { type ControlAction } from "../../../src/features.ts";
import { LTE_ALL_BANDS_MASK, maskToBands, statusReadsOf } from "../../../src/device-profile.ts";
import { CELLULAR_CONTROL_PATHS, DemoCellular } from "./cellular.ts";
import { VERIFIED_FIRMWARE } from "../../../src/firmware.ts";
import {
  readAntennaMode,
  readBandSelection,
  assertOneCell,
  readCellLockCommand,
  readDriverBandLockTarget,
  readDriverCellLockTarget,
  readOptionalBoolean,
  readSecurityControl,
  readTimeRuleChange,
  readTimeSeriesPreset,
  readWifiDeviceAccess,
  readWifiMacFilterChange,
  validateGenericBandLock,
} from "../../../src/control-input.ts";
import { maskMacTail, maskPhoneNumber } from "../../../src/privacy-mask.ts";
import { bandsToHexMask, checkCellLockInput, parseSupportedLteBand, parseSupportedNrBand } from "../../../src/rf-bounds.ts";
import { LOCK_CONFIRM_MS, RECONNECT_MAX_PER_DAY, type SelfHealStatus } from "../../../src/self-heal-status.ts";
import { validateGenericSmsContent } from "../../../src/sms/text-mode.ts";
import { TimeSeriesRingBuffer, TimeSeriesValidationError } from "../../../src/timeseries.ts";
import { previewGuard } from "../core/access-view.ts";
import type { EventSourceLike } from "../core/sse.ts";
import { DemoConsole, DemoRefusal } from "./console.ts";
import { DemoDevice, type WriteHint } from "./device.ts";
import { ROUTER_FAMILY_FACTS } from "../../../src/router-family.ts";
import type { DemoSeed } from "./seed.ts";
import { DemoSmsBox, DemoValidationError } from "./sms-box.ts";
import { type SignalBase, TICK_MS, advanceTelemetry, backfillHistory, seriesInput, signalBase, speedTick, worldSample } from "./world.ts";

/**
 * The static demo's stand-in for the FengSui daemon, entirely inside the page: it answers the web
 * console's REST calls (`fetch`) and feeds its `/api/events` stream, starting from a seed the real
 * daemon produced. Inputs go through the daemon's own guards (control-input, access-plan,
 * rf-bounds, the SMS helpers), so the console sees the same validation errors, state changes and
 * toasts it would on a real router. The seed decides which router it is: the verified H168-383, or
 * an LTE-only model FengSui was not verified on (`?router=other`), which provides no neighbour cells,
 * router settings or access control and takes only the writes the visitor turns on (DemoDevice).
 * Nothing is persisted and no request leaves the page.
 */

export interface DemoBackendOptions {
  /** Already rebased onto the visitor's clock (`rebaseSeed`). */
  seed: DemoSeed;
  now?: () => number;
  random?: () => number;
  /** Multiplier for the simulated router latency; tests pass 0. */
  latencyScale?: number;
}

type Body = Readonly<Record<string, unknown>>;
type Locale = "zh-CN" | "en";
type Handler = (body: Body, query: URLSearchParams) => unknown;

class DemoHttpError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Router round trips the console would wait for (ms, before `latencyScale`). */
const LATENCY = { read: 40, session: 650, control: 1200, scan: 2200 } as const;
const REBOOT_OFFLINE_MS = 45_000;
const RECONNECT_OFFLINE_MS = 8_000;
const LOCK_SETTLE_MS = 30_000;
/** How long the daemon lets a lock settle before a router that still disagrees reads as drift (its LOCK_SETTLE_MS). */
const MASK_SETTLE_MS = 90_000;
const TOPOLOGY_EVERY_TICKS = 12;
const FIRST_SMS_MS = 40_000;
const SMS_EVERY_MS = 150_000;
const AUTO_REPLY_MS = 6_000;
const CJK = /[㐀-鿿]/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function interpolate(template: string, params: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]{1,40})\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

function applyFilterWrite(state: WifiMacFilterState, write: WifiFilterWrite): WifiMacFilterState {
  const entries = write.entries.map((e) => ({ ...e }));
  if (write.status === "0") return { ...state, enabled: false };
  if (write.status === "1") return { ...state, enabled: true, policy: "allow", allowList: entries };
  return { ...state, enabled: true, policy: "deny", denyList: entries };
}

export class DemoEventSource implements EventSourceLike {
  readonly #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly #onClose: (source: DemoEventSource) => void;
  closed = false;

  constructor(onClose: (source: DemoEventSource) => void) {
    this.#onClose = onClose;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#onClose(this);
  }

  dispatch(type: string, data: string): void {
    if (this.closed) return;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

/** The demo household's self-healing (`LOCK_ROLLBACK_AFTER_MIN` / `WAN_AUTO_RECONNECT_AFTER_MIN`, as in `npm run demo`). */
const DEMO_LOCK_ROLLBACK_MIN = 10;
const DEMO_RECONNECT_MIN = 3;

export class DemoBackend {
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #latencyScale: number;
  readonly #catalog: DemoSeed["catalog"];
  readonly #health: HealthResponse;
  readonly #startedAtMs: number;
  readonly #base: SignalBase;
  readonly #series = new TimeSeriesRingBuffer();
  readonly #sms: DemoSmsBox;
  readonly #countries: SmsCountriesResponse;
  readonly #sources = new Set<DemoEventSource>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #cellular: DemoCellular;
  readonly #routes: ReadonlyMap<string, Handler>;
  readonly #console: DemoConsole;
  /** The demo router as the daemon identified it when the seed was taken, and its write gate. */
  readonly #profile: DemoSeed["device"] | null;
  readonly #device: DemoDevice;
  /** Wi-Fi devices seen online when the seed was taken, before any filter cut them off. */
  readonly #presentWifi: ReadonlySet<string>;

  #scheduler: SchedulerStatusSnapshot;
  #telemetry: GlobalTelemetrySnapshot;
  /** On a router of another brand: what its own lock settings hold (an unlock takes off what is there). */
  #driverLocks = { nr: false, lteCell: false, nrCell: false };
  #lockState: PersistedLockState;
  #lockVerification: LockVerification;
  readonly #unlockedVerification: LockVerification;
  /** `null` on a model that does not provide them (neighbour cells, router settings, access control). */
  #neighbors: NeighborScanSnapshot | null;
  #topology: TerminalTopologySnapshot;
  #settings: RouterSettingsSnapshot | null;
  #alerts: AlertEventRecord[];
  readonly #notifications: AlertsResponse["notifications"];
  #access: AccessControlSnapshot | null;
  readonly #guard: AccessGuardInfo;
  /** The mobile data switch, which a model without router settings still has. */
  #mobileData: boolean;
  /** The LTE mask an experimental band lock wrote, which the next poll reads (net-mode). */
  #routerMask: string | null = null;
  #authenticated = true;
  #offlineUntilMs = 0;
  #offlineReason: "reboot" | "reconnect" | null = null;
  #ticks = 0;
  #nextRuleId: number;
  #ticker: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DemoBackendOptions) {
    const seed = clone(opts.seed);
    this.#now = opts.now ?? (() => Date.now());
    this.#random = opts.random ?? Math.random;
    this.#latencyScale = opts.latencyScale ?? 1;
    this.#catalog = seed.catalog;
    this.#health = seed.health;
    this.#startedAtMs = this.#now();
    if (!seed.telemetry.telemetry || !seed.topology.topology) {
      throw new Error("demo seed: a snapshot is missing");
    }
    this.#telemetry = seed.telemetry.telemetry;
    this.#scheduler = seed.telemetry.schedulerStatus;
    this.#lockState = seed.telemetry.lockState;
    this.#lockVerification = seed.telemetry.lockVerification;
    this.#unlockedVerification = clone(seed.telemetry.lockVerification);
    this.#neighbors = seed.neighbors.neighbors;
    this.#topology = seed.topology.topology;
    this.#settings = seed.settings.settings;
    this.#alerts = [...seed.alerts.alerts];
    this.#notifications = seed.alerts.notifications;
    this.#access = seed.accessControl.accessControl;
    this.#guard = seed.accessControl.guard;
    this.#countries = seed.sms.countries;
    this.#profile = seed.device ?? null;
    this.#mobileData = this.#settings?.mobileDataEnabled ?? this.#telemetry.device.connectionStatus === "901";
    this.#sms = new DemoSmsBox(seed.sms, this.#now, () => this.#console.behaviourValues.smsTrashDays);
    this.#base = signalBase(this.#telemetry);
    this.#nextRuleId = Math.max(0, ...(this.#access?.timeRules.rules ?? []).map((r) => Number(/(\d+)\.?$/.exec(r.id)?.[1] ?? 0))) + 1;
    const filter = this.#access?.wifiMacFilter ?? null;
    this.#presentWifi = new Set(
      this.#topology.hosts
        .filter((h) => h.medium.startsWith("WIFI") && (h.active || (filter !== null && isDeviceBlocked(filter, h.macAddress))))
        .map((h) => normalizeMac(h.macAddress) ?? h.macAddress)
    );
    backfillHistory(this.#series, this.#base, this.#now(), this.#random);
    // The login the daemon identified when the seed was taken (an older seed: the demo router's SCRAM with ECC)
    const identity = this.#profile?.profile.profile?.identity;
    this.#console = new DemoConsole({
      now: this.#now,
      random: this.#random,
      device: {
        model: this.#telemetry.device.deviceName,
        firmware: this.#telemetry.device.softwareVersion,
        loginScheme: identity?.loginScheme ?? "scram",
        tokenFlow: identity?.tokenFlow ?? "webserver-token",
        ecc: identity?.ecc ?? true,
      },
      behaviourEnv: { ...DEFAULT_BEHAVIOUR, lockRollbackAfterMin: DEMO_LOCK_ROLLBACK_MIN, wanReconnectAfterMin: DEMO_RECONNECT_MIN },
    });
    this.#device = new DemoDevice({ seed, now: this.#now, console: this.#console, text: (key, params) => this.#text(key, params) });
    this.#cellular = new DemoCellular(
      {
        now: this.#now,
        text: (key, params) => this.#text(key, params),
        gate: (action) => this.#device.gate(action),
        control: (action, summary, hint) => this.#controlWith(action, summary, undefined, hint),
        session: () => this.#session(LATENCY.session),
        status: () => this.#telemetry.status,
        patchStatus: (patch) => {
          const status = this.#telemetry.status;
          if (status) this.#telemetry = { ...this.#telemetry, status: patch(status) };
        },
        driver: this.#device.driver,
      },
      seed.cellular?.cellular ?? null
    );
    this.#routes = this.#buildRoutes();
  }

  /** `fetch` for the console's ApiClient. */
  readonly fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://demo.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = this.#routes.get(`${method} ${url.pathname}`);
    try {
      if (!handler) {
        const known = [...this.#routes.keys()].some((key) => key.endsWith(` ${url.pathname}`));
        throw known
          ? new DemoHttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed on ${url.pathname}`)
          : new DemoHttpError(404, "NOT_FOUND", `No route for ${url.pathname}`);
      }
      if (!this.#authenticated && !url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/health") {
        throw new DemoHttpError(401, "UNAUTHORIZED", "Sign in first");
      }
      const body = this.#readBody(init?.body);
      const payload = await handler(body, url.searchParams);
      return this.#json(200, payload);
    } catch (err: unknown) {
      return this.#json(...this.#errorResponse(err));
    }
  };

  /** EventSource factory for the console's SseClient. */
  readonly createEventSource = (_url: string): EventSourceLike => {
    const source = new DemoEventSource((s) => this.#sources.delete(s));
    this.#sources.add(source);
    this.#later(20, () => {
      if (!this.#authenticated) {
        source.dispatch("error", "");
        return;
      }
      const hello: SseHelloPayload = {
        clientId: globalThis.crypto.randomUUID(),
        connectedAtIso: new Date(this.#now()).toISOString(),
        heartbeatMs: 15_000,
        schedulerStatus: this.#status(),
        avoidance: this.#scheduler.avoidance,
        telemetry: this.#telemetry,
        lockState: this.#lockState,
        lockVerification: this.#lockVerification,
        sms: this.#sms.status(),
      };
      source.dispatch("hello", JSON.stringify(hello));
    });
    return source;
  };

  /** Start the 5 s poll and the occasional incoming SMS. */
  start(): void {
    if (this.#ticker) return;
    this.#ticker = setInterval(() => this.tick(), TICK_MS);
    const deliver = (): void => {
      const code = String(100_000 + Math.floor(this.#random() * 899_999));
      this.receiveSms("DemoBank", `Your DemoBank verification code is ${code}. It expires in 10 minutes.`);
      this.#later(SMS_EVERY_MS, deliver);
    };
    this.#later(FIRST_SMS_MS, deliver);
  }

  stop(): void {
    if (this.#ticker) clearInterval(this.#ticker);
    this.#ticker = null;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const source of [...this.#sources]) source.close();
  }

  /** One telemetry poll: the walk moves on and `speed` + `telemetry` go out. */
  tick(): void {
    const now = this.#now();
    if (now < this.#offlineUntilMs) return;
    if (this.#offlineReason !== null) this.#comeBack(now);
    this.#ticks += 1;
    const sample = worldSample(now, this.#base, this.#random);
    if (!this.#mobileData) {
      sample.downloadBytesPerSec = 0;
      sample.uploadBytesPerSec = 0;
    }
    const elapsedSec = Math.max(1, Math.round((now - this.#telemetry.capturedAtMs) / 1000));
    const next = advanceTelemetry(this.#telemetry, sample, this.#base, elapsedSec);
    // Without mobile data the router drops its connection (monitoring/status: 902), and connects again when it is back
    const device = { ...next.device, connectionStatus: this.#mobileData ? "901" : "902" };
    this.#telemetry = { ...next, device, bandConfig: this.#readMask(next.bandConfig), sms: this.#sms.counters() };
    this.#series.push(seriesInput(sample), now);
    this.#scheduler = {
      ...this.#scheduler,
      mode: "idle",
      totalSessionsCompleted: this.#scheduler.totalSessionsCompleted + 1,
      lastSessionHoldMs: Math.round(30 + this.#random() * 190),
    };
    if (this.#device.driver) {
      // Another brand's driver reads no band mask to check a lock against: it stays undetermined, as on the daemon
      this.#lockVerification = { ...this.#lockVerification, checkedAtIso: this.#telemetry.capturedAtIso };
    } else if (this.#device.hilinkGeneric) {
      this.#lockVerification = this.#maskVerification();
    } else if (this.#lockVerification.status === "settling" && now - Date.parse(this.#lockState.updatedAtIso) >= LOCK_SETTLE_MS) {
      this.#lockVerification = { ...this.#lockVerification, status: "consistent", checkedAtIso: this.#telemetry.capturedAtIso, issues: [] };
    } else {
      this.#lockVerification = { ...this.#lockVerification, checkedAtIso: this.#telemetry.capturedAtIso };
    }
    this.#emit("speed", speedTick(this.#telemetry));
    this.#emit("telemetry", this.#telemetry);
    if (this.#ticks % TOPOLOGY_EVERY_TICKS === 0) {
      this.#topology = this.#nextTopology();
      this.#emit("topology", this.#topology);
    }
  }

  /** An SMS arriving on the router (`sms:new`, as the daemon announces it after its sync). */
  receiveSms(phone: string, content: string): void {
    const message = this.#sms.receive(phone, content);
    this.#emit("sms:new", message);
    this.#emit("sms:status", this.#sms.status());
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  #buildRoutes(): Map<string, Handler> {
    const routes = new Map<string, Handler>();
    const get = (path: string, h: Handler): void => void routes.set(`GET ${path}`, h);
    const post = (path: string, h: Handler): void => void routes.set(`POST ${path}`, h);

    get("/api/health", () => ({ ...this.#health, uptimeSec: this.#health.uptimeSec + Math.round((this.#now() - this.#startedAtMs) / 1000) }) satisfies HealthResponse);
    get("/api/auth/status", () => ({ ok: true, authenticated: this.#authenticated, locale: "zh-CN", setupRequired: false }) satisfies AuthStatusResponse);
    post("/api/auth/login", async (body) => {
      await this.#wait(LATENCY.read);
      // Any password opens the demo; the daemon also takes it as `token` (older consoles)
      const password = typeof body["password"] === "string" ? body["password"] : body["token"];
      if (typeof password !== "string" || !password) throw new DemoHttpError(401, "UNAUTHORIZED", "Invalid console password");
      this.#authenticated = true;
      this.#console.record("login", "applied", "from 192.168.8.20");
      return { ok: true, authenticated: true, expiresAtIso: new Date(this.#now() + 12 * 3_600_000).toISOString() } satisfies AuthLoginResponse;
    });
    post("/api/auth/logout", () => {
      this.#authenticated = false;
      return { ok: true, authenticated: false } satisfies AuthLogoutResponse;
    });

    get("/api/telemetry", () => ({ ok: true, ...this.#lockView(), schedulerStatus: this.#status(), telemetry: this.#telemetry, recentAlerts: this.#alerts.slice(-20) }) satisfies TelemetryEndpointResponse);
    post("/api/telemetry/refresh", async () => {
      await this.#session(LATENCY.session);
      this.tick();
      return { ok: true, schedulerStatus: this.#status(), telemetry: this.#telemetry } satisfies TelemetryRefreshResponse;
    });
    get("/api/session/status", () => ({ ok: true, status: this.#status(), selfHeal: this.#selfHeal() }) satisfies SessionStatusResponse);
    get("/api/timeseries", (_body, query) => {
      const result = this.#series.query({
        preset: readTimeSeriesPreset(query.get("preset") ?? undefined),
        fromMs: strictInt(query.get("fromMs")),
        toMs: strictInt(query.get("toMs")),
        bucketMs: strictInt(query.get("bucketMs")),
        maxPoints: strictInt(query.get("maxPoints")),
        nowMs: this.#now(),
      });
      return { ok: true, ...result } satisfies TimeSeriesEndpointResponse;
    });
    get("/api/neighbors", () => ({ ok: true, schedulerStatus: this.#status(), neighbors: this.#neighbors }) satisfies NeighborsEndpointResponse);
    post("/api/neighbors/scan", async () => {
      await this.#session(LATENCY.scan);
      this.#neighbors = this.#nextNeighbors();
      if (this.#neighbors) this.#emit("neighbors", this.#neighbors);
      return { ok: true, schedulerStatus: this.#status(), neighbors: this.#neighbors } satisfies NeighborsEndpointResponse;
    });
    get("/api/topology", () => ({ ok: true, schedulerStatus: this.#status(), topology: this.#topology }) satisfies TopologyEndpointResponse);
    post("/api/topology/refresh", async () => {
      await this.#session(LATENCY.session);
      this.#topology = this.#nextTopology();
      this.#emit("topology", this.#topology);
      return { ok: true, schedulerStatus: this.#status(), topology: this.#topology } satisfies TopologyEndpointResponse;
    });
    get("/api/settings", () => ({ ok: true, ...this.#lockView(), schedulerStatus: this.#status(), settings: this.#settings }) satisfies SettingsEndpointResponse);
    post("/api/settings/refresh", async () => {
      await this.#session(LATENCY.session);
      // A model without router settings answers the sweep with nothing to show
      if (this.#settings) {
        this.#settings = { ...this.#settings, ...this.#stamp() };
        this.#emit("settings", this.#settings);
      }
      return { ok: true, schedulerStatus: this.#status(), settings: this.#settings } satisfies SettingsRefreshResponse;
    });
    get("/api/alerts", () => ({ ok: true, alerts: this.#alerts, notifications: this.#notifications }) satisfies AlertsResponse);

    get("/api/console", () => this.#console.summary());
    post("/api/console/cpe/test", async (body) => {
      await this.#session(LATENCY.session);
      return { ok: true, ...this.#console.test(body) } satisfies ConnectionTestResponse;
    });
    post("/api/console/cpe", async (body) => {
      await this.#session(LATENCY.session);
      return this.#console.save(body);
    });
    post("/api/console/review", () => this.#console.review());
    post("/api/console/password", (body) => this.#console.changePassword(body));
    get("/api/console/tokens", () => this.#console.tokens());
    post("/api/console/tokens", (body) => this.#console.createToken(body));
    post("/api/console/tokens/revoke", (body) => this.#console.revokeToken(body));
    post("/api/console/tokens/permissions", (body) => this.#console.tokenPermissions(body));
    post("/api/console/telegram/pairing-code", (body) => this.#console.pairingCode(body));
    post("/api/console/telegram/unlink-all", () => this.#console.unlinkTelegram());
    get("/api/console/telegram/chats", () => this.#console.telegramChats());
    post("/api/console/telegram/unlink", (body) => this.#console.unlinkTelegramChat(body));
    post("/api/console/switches", (body) => this.#console.switches(body));
    post("/api/console/behaviour", (body) => this.#console.behaviour(body));
    get("/api/audit", (_body, query) => this.#console.audit(query));
    get("/api/device/profile", () => this.#profile?.profile ?? ({ ok: true, profile: null, verifiedFirmware: VERIFIED_FIRMWARE.map((entry) => ({ ...entry })), support: null } satisfies DeviceProfileResponse));
    get("/api/console/experimental", () => this.#device.view());
    post("/api/console/experimental", (body) => this.#device.setExperimental(body));
    post("/api/console/agent-test", (body) => this.#device.agentTest(body));
    get("/api/console/device-report", () => this.#device.report(this.#health.version, statusReadsOf(this.#telemetry.status)));

    post("/api/control/band-lock", async (body) => {
      const lteBands = readBandSelection(body, "lteBands");
      const nrBands = readBandSelection(body, "nrBands");
      if (this.#device.driver) {
        // The driver's rules: NR where the brand locks NR, a mode it offers, checked before the gate like the daemon
        const networkMode = optionalString(body, "networkMode");
        const target = readDriverBandLockTarget({ ...(lteBands !== undefined ? { lteBands } : {}), ...(nrBands !== undefined ? { nrBands } : {}), ...(networkMode !== undefined ? { networkMode } : {}) }, ROUTER_FAMILY_FACTS[this.#device.family]);
        const lte = target.lte ?? this.#lockState.lteBands;
        const nr = target.nr === null ? this.#lockState.nrBands : target.nr === "all" ? [] : target.nr;
        const state: PersistedLockState = { mode: lte === "all" && nr.length === 0 ? "unlocked" : "band_lock", ...this.#stampIso(), lteBands: lte, nrBands: nr, cellLock: null };
        const summary = `LTE=${JSON.stringify(lte)}, NR=${JSON.stringify(nr)}`;
        const lockState = await this.#lock("lock_band", state, "controls.band_lock_applied", { summary }, { nr: target.nr !== null, mode: target.networkMode !== null });
        if (target.nr !== null) this.#driverLocks = { ...this.#driverLocks, nr: nr.length > 0 };
        return { ok: true, lockState } satisfies LockStateResponse;
      }
      if (this.#device.hilinkGeneric) {
        // LTE only, among the bands the router advertises; checked once the gate lets it through, like the daemon
        this.#device.gate("lock_band");
        const locked = validateGenericBandLock({ lteBands, nrBands }, this.#device.lteBands);
        const state: PersistedLockState = { mode: locked === "all" ? "unlocked" : "band_lock", ...this.#stampIso(), lteBands: locked, nrBands: [], cellLock: null };
        const summary = `LTE=${JSON.stringify(locked)}, NR=[]`;
        return { ok: true, lockState: await this.#lock("lock_band", state, "controls.band_lock_applied", { summary }) } satisfies LockStateResponse;
      }
      if (lteBands === undefined && nrBands === undefined) throw new CpeControlValidationError("At least one of lteBands or nrBands must be provided");
      const lte = lteBands === undefined || lteBands === "all" ? "all" : sortedUnique(lteBands.map(guard(parseSupportedLteBand)));
      const nr = nrBands === undefined || nrBands === "all" ? [] : sortedUnique(nrBands.map(guard(parseSupportedNrBand)));
      const state: PersistedLockState = { mode: lte === "all" && nr.length === 0 ? "unlocked" : "band_lock", ...this.#stampIso(), lteBands: lte, nrBands: nr, cellLock: null };
      const summary = `LTE=${JSON.stringify(lte)}, NR=${JSON.stringify(nr)}`;
      return { ok: true, lockState: await this.#lock("lock_band", state, "controls.band_lock_applied", { summary }) } satisfies LockStateResponse;
    });
    post("/api/control/cell-lock", async (body) => {
      const command = readCellLockCommand(body, { allowNullPci: true });
      // No router of the demo locks several cells at once: refused before anything, as on the daemon
      assertOneCell(command);
      const check = checkCellLockInput({ rat: command.rat, band: command.band, arfcn: command.arfcn, pci: command.pci ?? null });
      if (!check.ok) throw new CpeControlValidationError(check.message);
      // A driver locks one cell: a frequency alone is refused, as on the daemon
      if (this.#device.driver) readDriverCellLockTarget(command);
      const state: PersistedLockState = {
        mode: "cell_lock",
        ...this.#stampIso(),
        lteBands: command.rat === "LTE" ? [check.value.band] : "all",
        nrBands: command.rat === "NR" ? [check.value.band] : [],
        cellLock: { rat: command.rat, band: check.value.band, arfcn: command.arfcn, pci: command.pci ?? null },
      };
      const params = { rat: command.rat, band: String(command.band), arfcn: command.arfcn };
      const lockState = await this.#lock("lock_cell", state, "controls.cell_lock_applied", params, { rat: command.rat });
      this.#driverLocks = { ...this.#driverLocks, ...(command.rat === "LTE" ? { lteCell: true } : { nrCell: true }) };
      return { ok: true, lockState } satisfies LockStateResponse;
    });
    post("/api/control/unlock", async () => {
      const state: PersistedLockState = { mode: "unlocked", ...this.#stampIso(), lteBands: "all", nrBands: [], cellLock: null };
      // What the router itself still has locked (a cell lock leaves its NR bands as they were)
      const lockState = await this.#lock("unlock_rf_locks", state, "controls.unlock_all_applied", undefined, { locked: this.#driverLocks });
      this.#driverLocks = { nr: false, lteCell: false, nrCell: false };
      return { ok: true, lockState } satisfies LockStateResponse;
    });
    post("/api/control/reboot", async (body) => {
      if (body["confirm"] !== true) throw new CpeControlValidationError("Remote reboot rejected: explicit { confirm: true } is mandatory");
      await this.#control("reboot_cpe", "controls.reboot_triggered");
      this.#goOffline("reboot", REBOOT_OFFLINE_MS);
      return { ok: true, rebooting: true, requestedAtIso: new Date(this.#now()).toISOString() } satisfies RebootResponse;
    });
    post("/api/control/reconnect", async (body) => {
      if (body["confirm"] !== true) throw new CpeControlValidationError("Cellular reconnect requires explicit { confirm: true }");
      await this.#control("reconnect_cellular", "controls.reconnect_triggered");
      this.#goOffline("reconnect", RECONNECT_OFFLINE_MS);
      return { ok: true, reconnecting: true, requestedAtIso: new Date(this.#now()).toISOString() } satisfies ReconnectResponse;
    });
    post("/api/control/security", async (body) => {
      const input = readSecurityControl(body);
      await this.#control("set_security_switches", "controls.security_updated");
      const settings = this.#routerSettings();
      this.#settings = {
        ...settings,
        ...this.#stamp(),
        upnpEnabled: input.upnpEnabled ?? settings.upnpEnabled,
        dmzEnabled: input.dmz?.enabled ?? settings.dmzEnabled,
        dmzIpAddress: input.dmz?.ipAddress ?? settings.dmzIpAddress,
        firewall: { ...settings.firewall, ...input.firewall },
      };
      this.#emit("settings", this.#settings);
      return { ok: true, settings: this.#settings } satisfies SecurityControlResponse;
    });
    post("/api/control/wifi7", async (body) => {
      const mloEnable = readOptionalBoolean(body, "mloEnable");
      const dbhoEnable = readOptionalBoolean(body, "dbhoEnable");
      if (mloEnable === undefined && dbhoEnable === undefined) throw new CpeControlValidationError("Specify mloEnable and/or dbhoEnable");
      await this.#control("set_wifi7_mlo", "controls.wifi7_updated");
      const settings = this.#routerSettings();
      const wifi7 = { mloEnable: mloEnable ?? settings.wifi7.mloEnable, dbhoEnable: dbhoEnable ?? settings.wifi7.dbhoEnable };
      this.#settings = { ...settings, ...this.#stamp(), wifi7 };
      this.#emit("settings", this.#settings);
      return { ok: true, wifi7 } satisfies Wifi7ControlResponse;
    });
    post("/api/control/antenna", async (body) => {
      const mode = readAntennaMode(body["mode"]);
      await this.#control("set_antenna_mode", "controls.antenna_updated", { mode });
      const rawCode = mode === "internal" ? 1 : mode === "external" ? 2 : 0;
      const settings = this.#routerSettings();
      this.#settings = { ...settings, ...this.#stamp(), antenna: { ...settings.antenna, mode, rawCode: String(rawCode) } };
      this.#emit("settings", this.#settings);
      return { ok: true, antenna: { mode, rawCode } } satisfies AntennaControlResponse;
    });
    post("/api/control/mobile-data", async (body) => {
      const enabled = readOptionalBoolean(body, "enabled");
      if (enabled === undefined) throw new CpeControlValidationError('"enabled" must be a boolean');
      await this.#control("set_mobile_data", "controls.mobile_data_updated", undefined, undefined, { enabled });
      this.#mobileData = enabled;
      if (this.#settings) {
        this.#settings = { ...this.#settings, ...this.#stamp(), mobileDataEnabled: enabled };
        this.#emit("settings", this.#settings);
      }
      return { ok: true, mobileDataEnabled: enabled } satisfies MobileDataControlResponse;
    });
    // The cellular settings: the same paths, checks and answers as `src/http-cellular.ts`
    get("/api/cellular", () => ({ ok: true, schedulerStatus: this.#status(), cellular: this.#cellular.view() }) satisfies CellularEndpointResponse);
    post("/api/cellular/refresh", async () => {
      const cellular = await this.#cellular.refresh();
      return { ok: true, schedulerStatus: this.#status(), cellular } satisfies CellularEndpointResponse;
    });
    for (const path of CELLULAR_CONTROL_PATHS) post(path, (body) => this.#cellular.write(path, body));
    post("/api/session/reset-breaker", async () => {
      await this.#wait(LATENCY.read);
      return { ok: true, circuitBreaker: this.#scheduler.circuitBreaker, status: this.#status() } satisfies ResetBreakerResponse;
    });

    get("/api/access-control", () => this.#accessView());
    post("/api/access-control/refresh", async () => {
      await this.#session(LATENCY.session);
      // A model without access control answers the sweep with nothing to show
      if (this.#access) {
        this.#access = { ...this.#access, ...this.#stamp() };
        this.#emit("access-control", this.#access);
      }
      return this.#accessView();
    });
    post("/api/control/wifi-access", (body) => this.#wifiAccess(readWifiDeviceAccess(body), body));
    post("/api/control/wifi-mac-filter", (body) => this.#wifiAccess(readWifiMacFilterChange(body), body));
    post("/api/control/time-rule", (body) => this.#timeRule(readTimeRuleChange(body), body));

    get("/api/sms/status", () => ({ ok: true, status: this.#sms.status() }) satisfies SmsStatusResponse);
    get("/api/sms/countries", () => this.#countries);
    get("/api/sms/threads", (_body, query) => {
      const filter = query.get("filter") ?? "all";
      if (filter !== "all" && filter !== "unread" && filter !== "otp") throw new CpeControlValidationError(`Unsupported filter "${filter}" (all | unread | otp)`);
      const threads = this.#sms.threads(filter, (query.get("search") ?? "").slice(0, 100), limit(query.get("limit"), 500, 500));
      return { ok: true, threads, status: this.#sms.status() } satisfies SmsThreadsResponse;
    });
    get("/api/sms/thread", (_body, query) => {
      const key = (query.get("key") ?? query.get("phone") ?? "").trim();
      if (!key || key.length > 64) throw new CpeControlValidationError('Query "key" (thread key or phone number) is required');
      return { ok: true, thread: this.#sms.thread(key) } satisfies SmsThreadResponse;
    });
    get("/api/sms/contacts", (_body, query) => ({ ok: true, ...this.#sms.contacts((query.get("search") ?? "").slice(0, 100), limit(query.get("limit"), 500, 5000)) }) satisfies SmsContactsResponse);
    post("/api/sms/preview", (body) => {
      const preview = this.#sms.preview({ phone: optionalString(body, "phone"), content: optionalString(body, "content") ?? "", countryCode: optionalString(body, "countryCode") });
      return { ok: true, preview } satisfies SmsPreviewResponse;
    });
    post("/api/sms/send", async (body) => this.#sendSms(body));
    post("/api/sms/read", async (body) => {
      let onRouter = 0;
      const uids = this.#sms.markRead({ uids: stringList(body, "uids"), threadKey: optionalString(body, "threadKey") }, (count) => {
        this.#device.gate("sms_mark_read");
        onRouter = count;
      });
      if (uids.length > 0) {
        if (onRouter > 0) await this.#control("sms_mark_read", "sms.marked_read_summary", { count: onRouter });
        this.#emit("sms:updated", { action: "read", uids });
        this.#emit("sms:status", this.#sms.status());
      }
      return { ok: true, count: uids.length, uids } satisfies SmsReadResponse;
    });
    post("/api/sms/delete", async (body) => {
      let onRouter = 0;
      const uids = this.#sms.delete(stringList(body, "uids") ?? [], (count) => {
        this.#device.gate("sms_delete");
        onRouter = count;
      });
      if (onRouter > 0) await this.#control("sms_delete", "sms.deleted_summary", { count: onRouter });
      this.#emit("sms:updated", { action: "deleted", uids });
      this.#emit("sms:status", this.#sms.status());
      return { ok: true, deleted: uids.length, uids, trashDays: this.#sms.trashDays } satisfies SmsDeleteResponse;
    });
    get("/api/sms/trash", () => ({ ok: true, messages: this.#sms.trash(), trashDays: this.#sms.trashDays }) satisfies SmsTrashResponse);
    post("/api/sms/trash/restore", async (body) => {
      const uids = this.#sms.restore(stringList(body, "uids") ?? []);
      this.#emit("sms:updated", { action: "restored", uids });
      this.#emit("sms:status", this.#sms.status());
      return { ok: true, restored: uids.length, uids } satisfies SmsRestoreResponse;
    });
    post("/api/sms/trash/purge", async (body) => {
      if (body["all"] !== undefined && body["all"] !== true) throw new CpeControlValidationError('Field "all" must be true when given');
      const uids = this.#sms.purge(body["all"] === true ? { all: true } : { uids: stringList(body, "uids") ?? [] });
      if (uids.length > 0) {
        this.#emit("sms:updated", { action: "purged", uids });
        this.#emit("sms:status", this.#sms.status());
      }
      return { ok: true, purged: uids.length, uids } satisfies SmsPurgeResponse;
    });
    post("/api/sms/sync", async (body) => {
      const mode = optionalString(body, "mode") ?? "full";
      if (mode !== "full" && mode !== "incremental") throw new CpeControlValidationError('Field "mode" must be "full" or "incremental"');
      await this.#session(LATENCY.session);
      const summary = this.#sms.sync(mode);
      this.#emit("sms:sync", summary);
      return { ok: true, summary, status: this.#sms.status() } satisfies SmsSyncResponse;
    });
    post("/api/sms/contacts/upsert", (body) => {
      const contact = this.#sms.upsertContact({ phone: requiredString(body, "phone"), name: requiredString(body, "name"), note: optionalString(body, "note") });
      this.#emit("contacts:updated", { total: this.#sms.contacts("", 1).total });
      return { ok: true, contact } satisfies ContactUpsertResponse;
    });
    post("/api/sms/contacts/delete", (body) => {
      const deleted = this.#sms.removeContact(requiredString(body, "id"));
      this.#emit("contacts:updated", { total: this.#sms.contacts("", 1).total });
      return { ok: true, deleted } satisfies ContactDeleteResponse;
    });
    post("/api/sms/contacts/import-vcf", (body) => {
      const summary = this.#sms.importVcard(requiredString(body, "vcf"));
      this.#emit("contacts:updated", { total: summary.total });
      return { ok: true, summary } satisfies VcardImportResponse;
    });
    return routes;
  }

  // ── Controls ───────────────────────────────────────────────────────────────

  /**
   * Self-healing as `npm run demo` runs it (lock rollback after 10 min, redial after 3) unless the visitor changes it in Settings. This WAN never
   * drops: a fresh lock is watched until it has stayed up two minutes, and nothing is redialled.
   */
  #selfHeal(): SelfHealStatus {
    const { lockRollbackAfterMin, wanReconnectAfterMin } = this.#console.behaviourValues;
    const lock = this.#lockState;
    const appliedMs = Date.parse(lock.updatedAtIso);
    const watching = lockRollbackAfterMin > 0 && lock.mode !== "unlocked" && this.#now() - appliedMs < LOCK_CONFIRM_MS;
    return {
      lockRollback: {
        afterMin: lockRollbackAfterMin > 0 ? lockRollbackAfterMin : null,
        watch: watching ? { lockUpdatedAtIso: lock.updatedAtIso, deadlineIso: new Date(appliedMs + lockRollbackAfterMin * 60_000).toISOString(), wanUpSinceIso: lock.updatedAtIso } : null,
      },
      reconnect: { afterMin: wanReconnectAfterMin > 0 ? wanReconnectAfterMin : null, redialsLast24h: 0, maxPer24h: RECONNECT_MAX_PER_DAY, nextAllowedAtIso: null, wanDownSinceIso: null },
    };
  }

  async #lock(action: ControlAction, state: PersistedLockState, key: string, params?: Readonly<Record<string, string | number>>, hint: WriteHint = {}): Promise<PersistedLockState> {
    await this.#control(action, key, params, state, hint);
    this.#lockState = state;
    if (this.#device.driver) return state;
    if (this.#device.hilinkGeneric) {
      // net-mode takes the new LTE mask; the next poll reads it, and until then the router still shows the old one
      this.#routerMask = state.lteBands === "all" ? LTE_ALL_BANDS_MASK : bandsToHexMask(state.lteBands);
      this.#lockVerification = this.#maskVerification();
      return state;
    }
    this.#lockVerification =
      state.mode === "unlocked"
        ? { ...this.#unlockedVerification, checkedAtIso: this.#telemetry.capturedAtIso }
        : {
            status: "settling",
            checkedAtIso: this.#telemetry.capturedAtIso,
            routerLteBands: state.lteBands === "all" ? this.#unlockedVerification.routerLteBands : state.lteBands,
            issues: [],
          };
    return state;
  }

  async #wifiAccess(change: WifiAccessChange, body: Body): Promise<AccessControlChangeResponse> {
    requireConfirm(body);
    this.#device.gate("set_wifi_access");
    const access = this.#accessControl();
    const plan = planWifiAccessChange(access.wifiMacFilter, change, previewGuard(this.#guard, this.#topology.hosts));
    const summary =
      change.kind === "block"
        ? this.#text("controls.wifi_access_blocked", { mac: maskMacTail(change.macAddress) })
        : change.kind === "unblock"
          ? this.#text("controls.wifi_access_unblocked", { mac: maskMacTail(change.macAddress) })
          : change.kind === "mode"
            ? this.#text("controls.wifi_filter_mode", { mode: change.mode })
            : this.#text("controls.wifi_filter_entries", { count: (change.add?.length ?? 0) + (change.remove?.length ?? 0) });
    await this.#controlWith("set_wifi_access", summary);
    if (plan.write) {
      this.#access = { ...access, ...this.#stamp(), wifiMacFilter: applyFilterWrite(access.wifiMacFilter, plan.write) };
      this.#emit("access-control", this.#access);
      // The router drops (or lets back) a filtered device a few seconds after the write
      this.#later(3_000 * this.#latencyScale, () => {
        this.#topology = this.#nextTopology();
        this.#emit("topology", this.#topology);
      });
    }
    return { ok: true, accessControl: this.#access, changed: plan.write !== null, alsoBlocked: plan.alsoBlocked };
  }

  async #timeRule(change: TimeRuleChange, body: Body): Promise<AccessControlChangeResponse> {
    requireConfirm(body);
    this.#device.gate("manage_time_rule");
    const access = this.#accessControl();
    const rules = access.timeRules;
    const write = planTimeRuleChange(rules.rules, rules.maxRules, change, previewGuard(this.#guard, this.#topology.hosts));
    const detail =
      change.kind === "delete"
        ? `#${/(\d+)\.?$/.exec(change.id)?.[1] ?? change.id}`
        : `${maskMacTail(change.rule.macAddress)} ${change.rule.weekMask} ${change.rule.startTime}-${change.rule.endTime}`;
    const key = change.kind === "create" ? "controls.time_rule_created" : change.kind === "update" ? "controls.time_rule_updated" : "controls.time_rule_deleted";
    await this.#controlWith("manage_time_rule", this.#text(key, { detail }));
    this.#access = { ...access, ...this.#stamp(), timeRules: { ...rules, rules: this.#applyRuleWrite(rules.rules, write) } };
    this.#emit("access-control", this.#access);
    return { ok: true, accessControl: this.#access, changed: true, alsoBlocked: [] };
  }

  #applyRuleWrite(rules: ReadonlyArray<TimeRule>, write: TimeRuleWrite): TimeRule[] {
    if (write.action === "delete") return rules.filter((r) => r.id !== write.id);
    const rule: TimeRule = {
      id: write.id || `InternetGatewayDevice.X_FireWall.TimeRule.${this.#nextRuleId++}.`,
      enabled: write.enabled,
      devices: write.devices.map((d) => ({ ...d })),
      weekMask: write.weekMask,
      startTime: write.startTime,
      endTime: write.endTime,
    };
    return write.action === "update" ? rules.map((r) => (r.id === write.id ? rule : r)) : [...rules, rule];
  }

  async #sendSms(body: Body): Promise<SmsSendResponse> {
    const phones = stringList(body, "phones") ?? [requiredString(body, "phone")];
    const outcome = this.#sms.send({ phones, content: requiredString(body, "content"), countryCode: optionalString(body, "countryCode") }, (content) => {
      // A model nobody verified sends the plaintext way: refused before queueing (a send the gate refuses says so first)
      if (this.#device.hilinkGeneric && !gateRefuses(this.#device.writeAccess("smsWrite"))) validateGenericSmsContent(content);
      this.#device.gate("sms_send");
    });
    const to = outcome.resolvedPhones.map(maskPhoneNumber).join(", ");
    await this.#control("sms_send", "sms.sent_summary", { to, segments: outcome.result.segments });
    this.#emit("sms:sent", { source: "web", result: outcome.result, messages: outcome.messages });
    this.#emit("sms:status", this.#sms.status());
    // The demo's recipients answer, so the console's incoming-message flow can be seen too
    const [first] = outcome.resolvedPhones;
    const content = requiredString(body, "content");
    if (first) {
      this.#later(AUTO_REPLY_MS * Math.max(this.#latencyScale, 0.001), () =>
        this.receiveSms(first, CJK.test(content) ? "收到 👍（演示页自动回复，号码与内容均为虚构）" : "Got it 👍 (automatic demo reply; every number here is fictional)")
      );
    }
    return { ok: true, ...outcome };
  }

  /** A queued control session: busy for a moment, then `control:applied` with the daemon's wording. */
  async #control(action: ControlAction, key: string, params?: Readonly<Record<string, string | number>>, lockState?: PersistedLockState, hint: WriteHint = {}): Promise<void> {
    await this.#controlWith(action, this.#text(key, params), lockState, hint);
  }

  /**
   * The daemon's write path: the gate (a write this router may not take gets no session), the session,
   * then on a model nobody verified the experimental write's read-back, kept for the device report and
   * added to the summary.
   */
  async #controlWith(action: ControlAction, summary: { zh: string; en: string }, lockState?: PersistedLockState, hint: WriteHint = {}): Promise<void> {
    this.#device.gate(action);
    if (this.#now() < this.#offlineUntilMs) {
      const message = "The router is restarting; try again in a minute";
      this.#console.record(action, "failed", message);
      throw new DemoHttpError(502, "CPE_UPSTREAM_ERROR", message);
    }
    await this.#session(LATENCY.control);
    const record = this.#device.generic ? this.#device.noteWrite(action, hint) : null;
    const suffix = record ? this.#device.readbackSuffix(record) : { zh: "", en: "" };
    const event: ControlAppliedEvent = {
      action,
      tsIso: lockState?.updatedAtIso ?? new Date(this.#now()).toISOString(),
      summaryZh: `${summary.zh}${suffix.zh}`,
      summaryEn: `${summary.en}${suffix.en}`,
      ...(lockState ? { lockState } : {}),
      ...(record ? { check: { endpoints: [...record.endpoints], readback: record.readback, reason: record.reason } } : {}),
    };
    this.#emit("control:applied", event);
    this.#console.record(action, "applied", event.summaryEn);
  }

  async #session(ms: number): Promise<void> {
    this.#scheduler = { ...this.#scheduler, mode: "polling", queueDepth: this.#scheduler.queueDepth + 1 };
    try {
      await this.#wait(ms * (0.75 + this.#random() * 0.5));
    } finally {
      this.#scheduler = {
        ...this.#scheduler,
        mode: "idle",
        queueDepth: Math.max(0, this.#scheduler.queueDepth - 1),
        totalSessionsCompleted: this.#scheduler.totalSessionsCompleted + 1,
        lastSessionHoldMs: Math.round(ms * 0.2),
      };
    }
  }

  #goOffline(reason: "reboot" | "reconnect", ms: number): void {
    this.#offlineUntilMs = this.#now() + ms * Math.max(this.#latencyScale, 0.001);
    this.#offlineReason = reason;
    if (reason === "reboot") {
      this.#later(Math.min(ms, 30_000) * this.#latencyScale, () => {
        if (this.#offlineReason !== "reboot") return;
        this.#scheduler = { ...this.#scheduler, mode: "cpe_unreachable", lastError: "fetch failed (ECONNREFUSED 192.168.8.1:80)" };
        this.#raise("critical", "CPE_UNREACHABLE", "alerts.cpe_unreachable", { seconds: 30, reason: "fetch failed (ECONNREFUSED 192.168.8.1:80)" });
      });
    }
  }

  #comeBack(now: number): void {
    const reason = this.#offlineReason;
    this.#offlineReason = null;
    const t = this.#telemetry;
    const traffic = { ...t.traffic, sessionConnectTimeSec: 0, sessionDownloadBytesStr: "0", sessionUploadBytesStr: "0" };
    // The first poll after the outage counts one interval, not the whole offline gap
    const restarted = { ...t, capturedAtMs: now - TICK_MS, traffic };
    this.#telemetry = reason === "reboot" ? { ...restarted, device: { ...t.device, uptimeSec: 0 } } : restarted;
    this.#scheduler = { ...this.#scheduler, mode: "idle", lastError: null };
    this.#device.settleRestarts();
    if (reason === "reboot") {
      this.#raise("info", "CPE_RECOVERED", "alerts.cpe_recovered", { seconds: Math.round(REBOOT_OFFLINE_MS / 1000) });
      // The daemon sees a reboot in the uptime, which a router that reports none cannot show
      if (this.#base.uptime) this.#raise("warning", "REBOOT_DETECTED", "alerts.reboot_detected", { uptime: Math.round(TICK_MS / 1000) });
    }
  }

  #raise(severity: AlertEventRecord["severity"], code: string, key: string, params: Readonly<Record<string, string | number>>): void {
    const text = this.#text(key, params);
    const alert: AlertEventRecord = { id: globalThis.crypto.randomUUID(), tsIso: new Date(this.#now()).toISOString(), severity, code, messageZh: text.zh, messageEn: text.en };
    this.#alerts = [...this.#alerts, alert].slice(-200);
    this.#emit("alert", alert);
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  #lockView(): { lockState: PersistedLockState; lockVerification: LockVerification } {
    return { lockState: this.#lockState, lockVerification: this.#lockVerification };
  }

  /** The scheduler as the daemon reports it, with the write gate as it is now (what the visitor turned off). */
  #status(): SchedulerStatusSnapshot {
    return { ...this.#scheduler, device: this.#device.snapshot() };
  }

  #accessView(): AccessControlEndpointResponse {
    return { ok: true, schedulerStatus: this.#status(), accessControl: this.#access, guard: this.#guard };
  }

  /** Router settings, which only a verified model's writes change (the gate refuses them on any other). */
  #routerSettings(): RouterSettingsSnapshot {
    if (!this.#settings) throw new Error("this demo router has no router settings to change");
    return this.#settings;
  }

  /** Access control, which only a verified model's writes change (the gate refuses them on any other). */
  #accessControl(): AccessControlSnapshot {
    if (!this.#access) throw new Error("this demo router has no access control to change");
    return this.#access;
  }

  /** The LTE mask net-mode reports at this poll: the one an experimental band lock wrote, once. */
  #readMask(bandConfig: GlobalTelemetrySnapshot["bandConfig"]): GlobalTelemetrySnapshot["bandConfig"] {
    const mask = this.#routerMask;
    if (mask === null) return bandConfig;
    this.#routerMask = null;
    return { ...bandConfig, lteBandHex: mask, activeLteBands: maskToBands(mask) ?? [] };
  }

  /**
   * The daemon's lock check (verifyLockState) on a model nobody verified: its LTE mask against the
   * lock, with no carrier or cell detail to compare; a snapshot from before the lock cannot contradict it yet.
   */
  #maskVerification(): LockVerification {
    const lock = this.#lockState;
    const telemetry = this.#telemetry;
    const router = telemetry.bandConfig.lteBandHex ? [...telemetry.bandConfig.activeLteBands] : null;
    const list = (bands: ReadonlyArray<number>): string => bands.map((band) => `B${band}`).join(", ");
    const issues: string[] = [];
    if (router && lock.lteBands === "all") {
      const every = (bands: ReadonlyArray<number>): boolean => bands.every((band) => router.includes(band));
      const unlocked = every(this.#device.lteBands ?? []) || every(Array.from({ length: 63 }, (_, i) => i + 1));
      if (!unlocked) issues.push(`LTE is not unlocked: the router enables only ${list(router)}`);
    } else if (router && lock.lteBands !== "all") {
      const expected = [...lock.lteBands].sort((a, b) => a - b);
      if (expected.join() !== router.join()) issues.push(`LTE bands on the router (${list(router)}) differ from the applied lock (${list(expected)})`);
    }
    const settling = telemetry.capturedAtMs - Date.parse(lock.updatedAtIso) < MASK_SETTLE_MS;
    const status: LockVerification["status"] = issues.length > 0 ? (settling ? "settling" : "drift") : router ? "consistent" : "unknown";
    return { status, checkedAtIso: telemetry.capturedAtIso, routerLteBands: router, issues };
  }

  /** Hosts as the router would list them now: filtered Wi-Fi devices offline, leases counting down. */
  #nextTopology(): TerminalTopologySnapshot {
    const filter = this.#access?.wifiMacFilter ?? null;
    const elapsedSec = Math.max(0, Math.round((this.#now() - this.#topology.capturedAtMs) / 1000));
    const hosts = this.#topology.hosts.map((h) => {
      const mac = normalizeMac(h.macAddress) ?? h.macAddress;
      const wifi = h.medium.startsWith("WIFI");
      const active = wifi ? this.#presentWifi.has(mac) && !(filter !== null && isDeviceBlocked(filter, mac)) : h.active;
      const lease = h.leaseTimeRemainingSec === null || h.leaseTimeRemainingSec === 0 ? h.leaseTimeRemainingSec : Math.max(60, h.leaseTimeRemainingSec - elapsedSec);
      const rssi = h.rssi !== null && h.rssi > 0 && active ? Math.max(5, Math.round(h.rssi + (this.#random() - 0.5) * 4)) : h.rssi;
      return { ...h, active, leaseTimeRemainingSec: lease, rssi };
    });
    const countsByMedium = { LAN_1000M: 0, LAN_100M: 0, LAN_OTHER: 0, WIFI_2_4G: 0, WIFI_5G: 0, WIFI_OTHER: 0, UNKNOWN: 0 };
    for (const h of hosts) if (h.active) countsByMedium[h.medium] += 1;
    return { ...this.#topology, ...this.#stamp(), hosts, countsByMedium };
  }

  #nextNeighbors(): NeighborScanSnapshot | null {
    const prev = this.#neighbors;
    if (!prev) return null;
    const jitter = (v: number | null, spread: number): number | null => (v === null ? null : Math.round(v + (this.#random() - 0.5) * spread));
    const move = (c: NeighborScanSnapshot["lteNeighbors"][number]): NeighborScanSnapshot["lteNeighbors"][number] => ({
      ...c,
      rsrpDbm: jitter(c.rsrpDbm, 4),
      rsrqDb: jitter(c.rsrqDb, 2),
      sinrDb: jitter(c.sinrDb, 3),
    });
    return { ...prev, ...this.#stamp(), lteNeighbors: prev.lteNeighbors.map(move), nrNeighbors: prev.nrNeighbors.map(move) };
  }

  #stamp(): { capturedAtIso: string; capturedAtMs: number } {
    const nowMs = this.#now();
    return { capturedAtIso: new Date(nowMs).toISOString(), capturedAtMs: nowMs };
  }

  #stampIso(): { updatedAtIso: string } {
    return { updatedAtIso: new Date(this.#now()).toISOString() };
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  #text(key: string, params?: Readonly<Record<string, string | number>>): { zh: string; en: string } {
    const pick = (locale: Locale): string => interpolate(this.#catalog[locale][key] ?? key, params);
    return { zh: pick("zh-CN"), en: pick("en") };
  }

  #emit<K extends keyof SseEventPayloads>(name: K, payload: SseEventPayloads[K]): void {
    const data = JSON.stringify(payload);
    for (const source of this.#sources) source.dispatch(name, data);
  }

  #later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      fn();
    }, ms);
    this.#timers.add(timer);
  }

  async #wait(ms: number): Promise<void> {
    const scaled = ms * this.#latencyScale;
    if (scaled <= 0) return;
    await new Promise<void>((resolve) => this.#later(scaled, resolve));
  }

  #readBody(raw: RequestInit["body"]): Body {
    if (raw === undefined || raw === null || raw === "") return {};
    if (typeof raw !== "string") throw new DemoHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Expected a JSON body");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DemoHttpError(400, "BAD_PAYLOAD", "Malformed JSON body");
    }
    if (!isRecord(parsed)) throw new DemoHttpError(400, "BAD_PAYLOAD", "JSON body must be an object");
    const clean: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) if (k !== "__proto__" && k !== "constructor" && k !== "prototype") clean[k] = v;
    return clean;
  }

  #errorResponse(err: unknown): [number, ApiErrorEnvelope] {
    if (err instanceof DemoHttpError) return [err.status, { ok: false, errorCode: err.code, message: err.message }];
    if (err instanceof DemoRefusal) return [err.status, err.envelope];
    if (err instanceof CpeControlValidationError || err instanceof TimeSeriesValidationError || err instanceof DemoValidationError || err instanceof AccessPlanError) {
      return [400, { ok: false, errorCode: "VALIDATION_ERROR", message: err.message }];
    }
    return [500, { ok: false, errorCode: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unexpected demo error" }];
  }

  #json(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
}

function requireConfirm(body: Body): void {
  if (body["confirm"] !== true) throw new CpeControlValidationError("Access control changes require explicit { confirm: true }");
}

function guard<T>(parse: (input: string | number) => T): (input: string | number) => T {
  return (input) => {
    try {
      return parse(input);
    } catch (err: unknown) {
      throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
    }
  };
}

function sortedUnique(values: ReadonlyArray<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function strictInt(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw.trim())) throw new DemoHttpError(400, "BAD_PAYLOAD", `Invalid integer query parameter "${raw}"`);
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n)) throw new DemoHttpError(400, "BAD_PAYLOAD", `Out-of-range integer query parameter "${raw}"`);
  return n;
}

function limit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,4}$/.test(raw)) throw new CpeControlValidationError(`Invalid limit "${raw}"`);
  return Math.max(1, Math.min(max, Number(raw)));
}

/** Request field limits of src/sms/http-routes.ts. */
const MAX_LENGTH: Readonly<Record<string, number>> = { phone: 64, content: 2000, countryCode: 5, threadKey: 64, mode: 16, name: 256, note: 1024, id: 64, vcf: 4 * 1024 * 1024 };
const MAX_ITEMS: Readonly<Record<string, number>> = { phones: 5, uids: 200 };

function optionalString(body: Body, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CpeControlValidationError(`Field "${key}" must be a string`);
  const max = MAX_LENGTH[key] ?? 1024;
  if (value.length > max) throw new CpeControlValidationError(`Field "${key}" exceeds ${max} characters`);
  return value;
}

function requiredString(body: Body, key: string): string {
  const value = optionalString(body, key);
  if (value === undefined || !value.trim()) throw new CpeControlValidationError(`Field "${key}" is required`);
  return value;
}

function stringList(body: Body, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new CpeControlValidationError(`Field "${key}" must be an array of strings`);
  const max = MAX_ITEMS[key] ?? 200;
  if (value.length > max) throw new CpeControlValidationError(`Field "${key}" accepts at most ${max} items`);
  return value.filter((v): v is string => typeof v === "string");
}
