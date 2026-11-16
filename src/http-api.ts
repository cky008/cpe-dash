import { type AccessControlSnapshot, accessGuardFromHosts } from "./access-control.ts";
import type { AgentTestService } from "./agent-test-service.ts";
import type {
  AccessControlChangeResponse,
  AccessControlEndpointResponse,
  AlertsResponse,
  AntennaControlResponse,
  ApiErrorEnvelope,
  AuditResponse,
  CellularEndpointResponse,
  DeviceProfileResponse,
  HealthResponse,
  LockStateResponse,
  MobileDataControlResponse,
  NeighborsEndpointResponse,
  RebootResponse,
  ReconnectResponse,
  ResetBreakerResponse,
  SecurityControlResponse,
  SessionStatusResponse,
  SettingsEndpointResponse,
  SettingsRefreshResponse,
  SseInitialSnapshot,
  TelegramChatRecord,
  TelemetryEndpointResponse,
  TelemetryRefreshResponse,
  TimeSeriesEndpointResponse,
  TopologyEndpointResponse,
  Wifi7ControlResponse,
} from "./api-contract.ts";
import { type AuditActor, type AuditLog, runAsActor } from "./audit-log.ts";
import type { BehaviourValues } from "./behaviour-settings.ts";
import type { ConsoleSettings } from "./console-settings.ts";
import { CpeControlValidationError, HttpPayloadError } from "./control-error.ts";
import type { FengSuiCore } from "./core.ts";
import { deviceReportOf } from "./core.ts";
import type { AccessControlResult } from "./cpe-controls.ts";
import { deviceSupportRow } from "./device-catalog.ts";
import { deviceProfileOf } from "./device-profile.ts";
import { VERIFIED_FIRMWARE } from "./firmware.ts";
import { cellularRestHandlers } from "./http-cellular.ts";
import type { CredentialVerdict } from "./http-auth.ts";
import { SettingsHttpRoutes } from "./http-settings.ts";
import type { NotificationHub } from "./notify/hub.ts";
import { type ApiOperation, type OperationHandlers, apiOperation, runOperation } from "./operations/registry.ts";
import { maskMacTail } from "./privacy-mask.ts";
import { accessControlForOutput, auditForOutput, telemetryForOutput, topologyForOutput } from "./redact.ts";
import { sanitizeDeviceProfile } from "./sanitize.ts";
import {
  BrowserSessionYieldedError,
  CircuitBreakerOpenError,
  ConnectionChangedError,
  CpeNotConfiguredError,
  DeviceNotIdentifiedError,
  DeviceReadOnlyError,
  PeerDaemonStandbyError,
  SchedulerQueueFullError,
  SchedulerStoppedError,
} from "./scheduler.ts";
import { SELF_HEAL_OFF, type SelfHealStatus } from "./self-heal-status.ts";
import { SmsHttpRoutes } from "./sms/http-routes.ts";
import type { SmsService } from "./sms/service.ts";
import type { SseEventBus } from "./sse-bus.ts";
import { TimeSeriesValidationError } from "./timeseries.ts";
import { FENGSUI_VERSION } from "./version.ts";

/**
 * The REST API behind the sign-in: every registered operation's handler (the routes and their input
 * checks are the operation registry's), the SMS and console routes, how a refusal becomes a status
 * and an envelope, the event stream's first snapshot and the liveness answer. No `node:http`: the
 * daemon's HTTP server calls it once it has authenticated a request (src/http-server.ts), and the live
 * demo calls it from the page (web/src/demo/transport.ts), so both answer with the same code.
 */

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function parseQueryNullProto(searchParams: URLSearchParams): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of searchParams.entries()) {
    if (!k || FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** One request as the transport hands it over: what was asked, how to read its body, how to answer. */
export interface ApiExchange {
  /** Upper case. */
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  /** The JSON body as an object (a `HttpPayloadError` when it is too large, not JSON or not an object). */
  readJsonBody(maxBytes?: number): Promise<Record<string, unknown>>;
  sendJson(statusCode: number, body: unknown, headers?: Record<string, string>): void;
}

/** Who asks, as the transport authenticated them. */
export interface ApiCaller {
  /** Bearer callers get the REDACT_SENSITIVE_IN_API copies (the console reveals on screen instead). */
  redact: boolean;
  clientIp: string;
  /** The sign-in limiter's bucket of the caller's address. */
  bucketKey: string;
  /** The console session asking (`null`: a Bearer token); the console's own routes answer only a session. */
  sessionId: string | null;
  /** Check a console password through the caller's sign-in limiter (a password change asks for the current one). */
  checkPassword(candidate: string): Promise<CredentialVerdict>;
  /**
   * Who the audit log names: set as each handler starts, once the body is read (a page's stand-in for
   * `AsyncLocalStorage` keeps a caller only until the first `await`; the daemon's keeps it throughout).
   */
  actor: AuditActor;
}

/** What a protected route's handler gets besides its checked input. */
interface ApiCall {
  redact: boolean;
  clientIp: string;
  searchParams: URLSearchParams;
  /** The body said `confirm: true`. */
  confirm: boolean;
}

export interface FengSuiApiOptions {
  core: FengSuiCore;
  /** The console login, Bearer tokens and router connection (`/api/console/*`). */
  settings: ConsoleSettings;
  /** Closes the event streams of a revoked token or ended session. */
  sseBus: SseEventBus;
  /** Enables `/api/sms/*`; when absent those routes answer `404 SMS_DISABLED`. */
  sms?: SmsService | null;
  audit?: AuditLog | null;
  notificationHub?: NotificationHub | null;
  /** What WAN self-healing will do next, for `GET /api/session/status` (default: off). */
  selfHealStatus?: (() => SelfHealStatus) | null;
  /** The AI agent test at one click (Settings → Device). */
  agentTest?: AgentTestService | null;
  /** METRICS_ENABLED from `.env`, used while the console has not set its own choice. */
  metricsFromEnv?: boolean;
  /** What `.env` says for the behaviour settings (it can be reloaded, hence a function). */
  behaviourFromEnv?: () => BehaviourValues;
  /** The behaviour settings in force changed in the console (AI switches, self-heal, alerts, SMS behaviour). */
  onBehaviourChanged?: ((values: BehaviourValues) => void) | null;
  /** The first router connection was saved during setup: start the background work. */
  onConnectionReady?: () => void;
  /** Unlink every Telegram chat linked with /auth (`null` without a bot). */
  unlinkTelegram?: (() => number) | null;
  /** Unlink the Telegram chats a revoked token linked with /auth (`null` without a bot). */
  unlinkTelegramToken?: ((tokenId: string) => number) | null;
  /** Every Telegram chat the bot reaches, for Settings → Telegram (`null` without a bot). */
  telegramChats?: (() => TelegramChatRecord[]) | null;
  /** Unlink one Telegram chat linked with /auth (`null` without a bot). */
  unlinkTelegramChat?: ((chatId: string) => boolean) | null;
  /** The bot's @username once known, for the `/auth@bot CODE` a group needs. */
  telegramUsername?: () => string | null;
  /**
   * `/api/session/reset-breaker` first re-reads the process's configuration: the daemon reloads `.env`
   * and re-encrypts its stores under the key it names (src/cli.ts). Absent: there is nothing to re-read.
   */
  reloadConfig?: (() => Promise<void>) | null;
}

/** The console sessions the transport keeps (the daemon's sign-in guard); none until one is attached. */
export interface ApiSessions {
  /** End every console session but `keepSessionId`; the ended sessions' ids. */
  revokeAllSessionsExcept(keepSessionId: string | null): string[];
}

export class FengSuiApi {
  readonly core: FengSuiCore;
  readonly sms: SmsService | null;
  readonly notificationHub: NotificationHub | null;
  readonly startedAtMs: number;
  readonly #opts: FengSuiApiOptions;
  readonly #smsRoutes: SmsHttpRoutes | null;
  readonly #consoleRoutes: SettingsHttpRoutes;
  readonly #handlers: OperationHandlers<ApiOperation, ApiCall>;
  #sessions: ApiSessions | null = null;

  constructor(options: FengSuiApiOptions) {
    this.#opts = options;
    this.core = options.core;
    this.sms = options.sms ?? null;
    this.notificationHub = options.notificationHub ?? null;
    this.startedAtMs = Date.now();
    this.#smsRoutes = this.sms ? new SmsHttpRoutes(this.sms) : null;
    const { core, sseBus } = options;
    const unlinkTelegram = options.unlinkTelegram ?? null;
    this.#consoleRoutes = new SettingsHttpRoutes({
      settings: options.settings,
      scheduler: core.scheduler,
      audit: options.audit ?? null,
      metricsFromEnv: options.metricsFromEnv ?? false,
      ...(options.behaviourFromEnv ? { behaviourFromEnv: options.behaviourFromEnv } : {}),
      onBehaviourChanged: (values) => options.onBehaviourChanged?.(values),
      telegramConfigured: unlinkTelegram !== null,
      onConnectionReady: options.onConnectionReady ?? (() => undefined),
      revokeSessions: (keep: string | null) => this.revokeSessionsExcept(keep),
      disconnectToken: (tokenId: string) => sseBus.disconnectByTokenId(tokenId),
      unlinkTelegram: () => unlinkTelegram?.() ?? 0,
      unlinkTelegramToken: (tokenId: string) => options.unlinkTelegramToken?.(tokenId) ?? 0,
      telegramChats: () => options.telegramChats?.() ?? [],
      unlinkTelegramChat: (chatId: string) => options.unlinkTelegramChat?.(chatId) ?? false,
      telegramUsername: options.telegramUsername ?? (() => null),
      onDeviceProbe: (probe) => void core.monitor.recordDeviceProbe(probe),
      deviceReport: () => deviceReportOf(core),
      agentTest: options.agentTest ?? null,
    });
    this.#handlers = this.#buildHandlers();
  }

  /** The transport's console sessions, which a password change ends (all but the one that asked). */
  attachSessions(sessions: ApiSessions): void {
    this.#sessions = sessions;
  }

  /** End every console session but `keep` and close their event streams. */
  revokeSessionsExcept(keep: string | null): void {
    for (const id of this.#sessions?.revokeAllSessionsExcept(keep) ?? []) this.#opts.sseBus.disconnectBySessionId(id);
  }

  /** `GET /api/health`: answered before any sign-in. */
  health(): HealthResponse {
    return {
      ok: true,
      service: "cpe-dash",
      codename: "FengSui",
      version: FENGSUI_VERSION,
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
    };
  }

  /** The event stream's `hello`: what the console draws before the first event. */
  hello(redact: boolean, smsAllowed: boolean): SseInitialSnapshot {
    const { core } = this;
    return {
      schedulerStatus: core.scheduler.getStatus(),
      avoidance: core.scheduler.getAvoidanceState(),
      telemetry: telemetryForOutput(core.monitor.getCachedTelemetry(), redact),
      lockState: core.controls.getPersistedLockState(),
      lockVerification: core.controls.getLockVerification(),
      sms: smsAllowed ? (this.sms?.getStatus() ?? null) : null,
    };
  }

  /** Answer one authenticated request: a registered route, the SMS routes or (for a console session) the console's own. */
  async dispatch(exchange: ApiExchange, caller: ApiCaller): Promise<void> {
    const { method, pathname, searchParams } = exchange;
    try {
      if (pathname === "/api/sms" || pathname.startsWith("/api/sms/")) {
        await this.#dispatchSms(exchange, caller.actor);
        return;
      }
      if ((pathname === "/api/console" || pathname.startsWith("/api/console/")) && caller.sessionId !== null) {
        const handled = await this.#consoleRoutes.handle(
          { method, pathname, query: parseQueryNullProto(searchParams), readJsonBody: exchange.readJsonBody, sendJson: exchange.sendJson },
          caller.sessionId,
          (candidate) => caller.checkPassword(candidate)
        );
        if (!handled) exchange.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: `Unknown ${method} endpoint ${pathname}` });
        return;
      }
      const call: ApiCall = { redact: caller.redact, clientIp: caller.clientIp, searchParams, confirm: false };
      // The daemon's data (no router session): a GET's input is its query string
      if (method === "GET") {
        const op = apiOperation("GET", pathname);
        if (op === null) {
          exchange.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: `Unknown GET endpoint ${pathname}` });
          return;
        }
        exchange.sendJson(200, await runAsActor(caller.actor, () => runOperation(this.#handlers, op, parseQueryNullProto(searchParams), call)));
        return;
      }
      if (method !== "POST") {
        exchange.sendJson(405, { ok: false, errorCode: "METHOD_NOT_ALLOWED", message: `Method ${method} not allowed on ${pathname}` });
        return;
      }
      // A POST's body is read before its route is looked up: an unknown route still refuses a malformed body
      const body = await exchange.readJsonBody();
      const op = apiOperation("POST", pathname);
      if (op === null) {
        exchange.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: `Unknown POST endpoint ${pathname}` });
        return;
      }
      exchange.sendJson(200, await runAsActor(caller.actor, () => runOperation(this.#handlers, op, body, { ...call, confirm: body["confirm"] === true })));
    } catch (err) {
      const [status, envelope] = this.#refusal(err);
      exchange.sendJson(status, envelope);
    }
  }

  /** Delegate `/api/sms/*` to the SMS route module (errors bubble to the shared mapping). */
  async #dispatchSms(exchange: ApiExchange, actor: AuditActor): Promise<void> {
    const { method, pathname } = exchange;
    if (!this.#smsRoutes) {
      exchange.sendJson(404, { ok: false, errorCode: "SMS_DISABLED", message: "SMS features are disabled (SMS_ENABLED=false)" });
      return;
    }
    if (method !== "GET" && method !== "POST") {
      exchange.sendJson(405, { ok: false, errorCode: "METHOD_NOT_ALLOWED", message: `Method ${method} not allowed on ${pathname}` });
      return;
    }
    const handled = await this.#smsRoutes.handle({
      method,
      pathname,
      query: parseQueryNullProto(exchange.searchParams),
      readJsonBody: exchange.readJsonBody,
      sendJson: (statusCode, body) => exchange.sendJson(statusCode, body),
    }, actor);
    if (!handled) exchange.sendJson(404, { ok: false, errorCode: "NOT_FOUND", message: `Unknown ${method} endpoint ${pathname}` });
  }

  /** The status and envelope a request that threw answers with. */
  #refusal(err: unknown): [number, ApiErrorEnvelope] {
    if (err instanceof HttpPayloadError) return [err.statusCode, { ok: false, errorCode: "BAD_PAYLOAD", message: err.message }];
    if (err instanceof CpeControlValidationError || err instanceof TimeSeriesValidationError) return [400, { ok: false, errorCode: "VALIDATION_ERROR", message: err.message }];
    if (err instanceof BrowserSessionYieldedError) {
      return [409, { ok: false, errorCode: "BROWSER_SESSION_YIELDED", message: err.messageZh, messageEn: err.messageEn, avoidance: this.core.scheduler.getAvoidanceState() }];
    }
    if (err instanceof CpeNotConfiguredError) return [409, { ok: false, errorCode: "CPE_NOT_CONFIGURED", message: err.message }];
    // The write gate: no implementation for this unverified model, or turned off by its owner; and a write never goes to a router whose model is unknown
    if (err instanceof DeviceReadOnlyError) {
      return [409, { ok: false, errorCode: err.errorCode, message: err.messageEn, messageZh: err.messageZh, model: err.model, ...(err.feature ? { feature: err.feature } : {}) }];
    }
    if (err instanceof DeviceNotIdentifiedError) return [409, { ok: false, errorCode: "DEVICE_NOT_IDENTIFIED", message: err.messageEn, messageZh: err.messageZh }];
    if (err instanceof PeerDaemonStandbyError) return [409, { ok: false, errorCode: "PEER_DAEMON_ACTIVE", message: err.message, peerAddress: err.peerAddress }];
    // Another brand's connection took over while the write waited: it went to neither router
    if (err instanceof ConnectionChangedError) return [409, { ok: false, errorCode: "CONNECTION_CHANGED", message: err.messageEn, messageZh: err.messageZh }];
    if (err instanceof CircuitBreakerOpenError) return [423, { ok: false, errorCode: "CIRCUIT_BREAKER_OPEN", message: err.message, circuitBreaker: err.circuitBreaker }];
    if (err instanceof SchedulerQueueFullError || err instanceof SchedulerStoppedError) return [503, { ok: false, errorCode: "QUEUE_FULL", message: err.message }];
    return [502, { ok: false, errorCode: "CPE_UPSTREAM_ERROR", message: err instanceof Error ? err.message : String(err) }];
  }

  /** What each route of the protected API answers (200); a refusal is thrown and mapped in `#refusal`. */
  #buildHandlers(): OperationHandlers<ApiOperation, ApiCall> {
    const { core } = this;
    const selfHealStatus = (): SelfHealStatus => this.#opts.selfHealStatus?.() ?? SELF_HEAL_OFF;
    return {
      // Strictly side-effect-free reads (from the cache / the ring buffer)
      telemetry: (_input, call) =>
        ({
          ok: true,
          schedulerStatus: core.scheduler.getStatus(),
          lockState: core.controls.getPersistedLockState(),
          lockVerification: core.controls.getLockVerification(),
          telemetry: telemetryForOutput(core.monitor.getCachedTelemetry(), call.redact),
          recentAlerts: core.scheduler.getRecentAlerts(),
        }) satisfies TelemetryEndpointResponse,
      timeseries: (window) => ({ ok: true, ...core.monitor.queryTimeSeries(window) }) satisfies TimeSeriesEndpointResponse,
      neighbors: () => ({ ok: true, schedulerStatus: core.scheduler.getStatus(), neighbors: core.monitor.getCachedNeighbors() }) satisfies NeighborsEndpointResponse,
      topology: (_input, call) => ({ ok: true, schedulerStatus: core.scheduler.getStatus(), topology: topologyForOutput(core.monitor.getCachedTopology(), call.redact) }) satisfies TopologyEndpointResponse,
      settings: () =>
        ({
          ok: true,
          schedulerStatus: core.scheduler.getStatus(),
          lockState: core.controls.getPersistedLockState(),
          lockVerification: core.controls.getLockVerification(),
          settings: core.monitor.getCachedSettings(),
        }) satisfies SettingsEndpointResponse,
      accessControlView: (_input, call) => this.#accessControlView(core.monitor.getCachedAccessControl(), call) satisfies AccessControlEndpointResponse,
      cellular: () => ({ ok: true, schedulerStatus: core.scheduler.getStatus(), cellular: core.monitor.getCachedCellular() }) satisfies CellularEndpointResponse,
      sessionStatus: () => ({ ok: true, status: core.scheduler.getStatus(), selfHeal: selfHealStatus() }) satisfies SessionStatusResponse,
      deviceProfile: () => {
        // Identity and capabilities carry no identifier, so every caller gets the same answer; tokens and
        // agents read it too, so it takes the device report's second pass as well
        const probe = core.monitor.getDeviceProbe();
        // The row goes by the brand and model the gate goes by (a probe that named no model: the brand's defaults)
        const device = core.scheduler.device.snapshot();
        return {
          ok: true,
          profile: probe ? sanitizeDeviceProfile(deviceProfileOf(probe, device.family)) : null,
          verifiedFirmware: VERIFIED_FIRMWARE.map((entry) => ({ ...entry })),
          // In the form of the brand's interface the gate goes by (the driver's report, else as the model is on record)
          support: probe || device.model ? deviceSupportRow(device.family, device.model ?? probe?.identity.model ?? null, device.model ? { variant: core.scheduler.device.variant } : {}) : null,
        } satisfies DeviceProfileResponse;
      },
      alerts: () => ({ ok: true, alerts: core.scheduler.getRecentAlerts(), notifications: this.notificationHub?.getStats() ?? null }) satisfies AlertsResponse,
      audit: (_input, call) => {
        const limit = Number.parseInt(call.searchParams.get("limit") ?? "200", 10);
        const entries = this.#opts.audit?.list(Number.isFinite(limit) ? limit : 200) ?? [];
        return { ok: true, entries: auditForOutput(entries, call.redact) } satisfies AuditResponse;
      },

      // Read sessions now
      telemetryRefresh: async (_input, call) => {
        const telemetry = await core.monitor.refreshTelemetry();
        return { ok: true, schedulerStatus: core.scheduler.getStatus(), telemetry: telemetryForOutput(telemetry ?? core.monitor.getCachedTelemetry(), call.redact) } satisfies TelemetryRefreshResponse;
      },
      neighborsScan: async () => {
        const neighbors = await core.monitor.refreshNeighbors();
        return { ok: true, schedulerStatus: core.scheduler.getStatus(), neighbors: neighbors ?? core.monitor.getCachedNeighbors() } satisfies NeighborsEndpointResponse;
      },
      topologyRefresh: async (_input, call) => {
        const topology = await core.monitor.refreshTopology();
        return { ok: true, schedulerStatus: core.scheduler.getStatus(), topology: topologyForOutput(topology ?? core.monitor.getCachedTopology(), call.redact) } satisfies TopologyEndpointResponse;
      },
      settingsRefresh: async () => {
        const settings = await core.monitor.refreshSettings();
        return { ok: true, schedulerStatus: core.scheduler.getStatus(), settings: settings ?? core.monitor.getCachedSettings() } satisfies SettingsRefreshResponse;
      },
      accessControlRefresh: async (_input, call) => {
        const fresh = await core.monitor.refreshAccessControl();
        return this.#accessControlView(fresh ?? core.monitor.getCachedAccessControl(), call) satisfies AccessControlEndpointResponse;
      },
      cellularRefresh: async () => {
        const cellular = await core.monitor.refreshCellular();
        return { ok: true, schedulerStatus: core.scheduler.getStatus(), cellular: cellular ?? core.monitor.getCachedCellular() } satisfies CellularEndpointResponse;
      },

      // The router's controls
      bandLock: async (bands) => ({ ok: true, lockState: await core.controls.lockBands(bands) }) satisfies LockStateResponse,
      cellLock: async (command) => ({ ok: true, lockState: await core.controls.lockCell(command) }) satisfies LockStateResponse,
      unlock: async () => ({ ok: true, lockState: await core.controls.unlockAllLocks() }) satisfies LockStateResponse,
      reboot: async (_input, call) => ({ ok: true, ...(await core.controls.rebootRouter({ confirm: call.confirm })) }) satisfies RebootResponse,
      reconnect: async () => ({ ok: true, ...(await core.controls.reconnectCellular()) }) satisfies ReconnectResponse,
      securitySwitches: async (change) => ({ ok: true, settings: await core.controls.setSecuritySwitches(change) }) satisfies SecurityControlResponse,
      wifi7: async (switches) => ({ ok: true, wifi7: await core.controls.setWifi7Settings(switches) }) satisfies Wifi7ControlResponse,
      antenna: async (mode) => ({ ok: true, antenna: await core.controls.setAntennaMode(mode) }) satisfies AntennaControlResponse,
      mobileData: async (enabled) => ({ ok: true, ...(await core.controls.setMobileData(enabled)) }) satisfies MobileDataControlResponse,
      // The cellular settings (network mode, operator, SIM slot and PIN, airplane mode, roaming, APN, data limit, USSD)
      ...cellularRestHandlers(core.controls),
      resetBreaker: async () => {
        await this.#opts.reloadConfig?.();
        // The router connection and the tokens live in the console store now, not in .env
        const cpe = this.#opts.settings.cpe;
        if (!cpe) throw new CpeNotConfiguredError();
        const breaker = await core.scheduler.reloadCredentialsAndResetBreaker(cpe.password, cpe.username, cpe.family);
        return { ok: true, circuitBreaker: breaker, status: core.scheduler.getStatus() } satisfies ResetBreakerResponse;
      },

      // Devices' internet access
      wifiAccess: async (change, call) => this.#accessChange(await core.controls.setWifiAccess(change, { requesterIp: call.clientIp, confirm: call.confirm }), call.redact),
      wifiMacFilter: async (change, call) => this.#accessChange(await core.controls.setWifiAccess(change, { requesterIp: call.clientIp, confirm: call.confirm }), call.redact),
      timeRule: async (change, call) => this.#accessChange(await core.controls.manageTimeRule(change, { requesterIp: call.clientIp, confirm: call.confirm }), call.redact),
    };
  }

  #accessChange(result: AccessControlResult, redact: boolean): AccessControlChangeResponse {
    return {
      ok: true,
      accessControl: accessControlForOutput(result.accessControl, redact),
      changed: result.changed,
      alsoBlocked: redact ? result.alsoBlocked.map(maskMacTail) : result.alsoBlocked,
    };
  }

  /** Access-control snapshot plus the devices this caller's writes may not cut off. */
  #accessControlView(snapshot: AccessControlSnapshot | null, caller: { redact: boolean; clientIp: string }): AccessControlEndpointResponse {
    const hosts = this.core.monitor.getCachedTopology()?.hosts ?? [];
    const guard = accessGuardFromHosts(hosts, caller.clientIp);
    const macOf = (reason: "daemon-host" | "requester"): string | null => {
      const mac = guard.protectedDevices.find((d) => d.reason === reason)?.macAddress ?? null;
      return mac && caller.redact ? maskMacTail(mac) : mac;
    };
    return {
      ok: true,
      schedulerStatus: this.core.scheduler.getStatus(),
      accessControl: accessControlForOutput(snapshot, caller.redact),
      guard: { daemonHostMac: macOf("daemon-host"), requesterMac: macOf("requester") },
    };
  }
}
