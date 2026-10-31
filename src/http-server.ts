import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import {
  canonicalizeRateLimitBucketKey,
  isAllowedHttpHostHeader,
  loadConfig,
  resolveClientIp,
  resolveRequestSecureScheme,
} from "./config.ts";
import {
  readAntennaMode,
  readBandSelection,
  readCellLockCommand,
  readOptionalBoolean,
  readTimeSeriesPreset,
} from "./control-input.ts";
import { CpeControlValidationError, type FirewallSwitchState } from "./cpe-domain.ts";
import {
  type CredentialVerdict,
  HttpAuthGuard,
  type WebSessionRecord,
  constantTimeSecretMatch,
} from "./http-auth.ts";
import type {
  AlertsResponse,
  AntennaControlResponse,
  ApiErrorEnvelope,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuthStatusResponse,
  HealthResponse,
  LocaleCatalogResponse,
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
  TelemetryEndpointResponse,
  TelemetryRefreshResponse,
  TimeSeriesEndpointResponse,
  TopologyEndpointResponse,
  Wifi7ControlResponse,
} from "./api-contract.ts";
import { serveStaticAsset } from "./http-static.ts";
import {
  getLocaleCatalog,
  normalizeLocale,
  t,
} from "./i18n.ts";
import { parseJsonSafeNullProto } from "./json-safe.ts";
import type { FengSuiMcpServer } from "./mcp-server.ts";
import type { FengSuiCore } from "./core.ts";
import {
  BrowserSessionYieldedError,
  CircuitBreakerOpenError,
  PeerDaemonStandbyError,
  SchedulerQueueFullError,
  SchedulerStoppedError,
} from "./scheduler.ts";
import type { NotificationHub } from "./notify/hub.ts";
import { SmsHttpRoutes } from "./sms/http-routes.ts";
import type { SmsService } from "./sms/service.ts";
import type { SseEventBus } from "./sse-bus.ts";
import { TimeSeriesValidationError } from "./timeseries.ts";
import type { AppConfig, SupportedLocale } from "./types.ts";
import { FENGSUI_VERSION } from "./version.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_FIREWALL_KEYS = new Set<keyof FirewallSwitchState>([
  "mainSwitch",
  "ipFilterSwitch",
  "wanPortPingSwitch",
  "macFilterSwitch",
  "urlFilterSwitch",
]);

class HttpPayloadError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpPayloadError";
    this.statusCode = statusCode;
  }
}

export { constantTimeSecretMatch };

function parseQueryNullProto(searchParams: URLSearchParams): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of searchParams.entries()) {
    if (!k || FORBIDDEN_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function parseStrictFiniteInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new HttpPayloadError(400, `Invalid integer query parameter "${raw}"`);
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(n)) {
    throw new HttpPayloadError(400, `Out-of-range integer query parameter "${raw}"`);
  }
  return n;
}

export interface FengSuiHttpServerOptions {
  config: AppConfig;
  core: FengSuiCore;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  envPath?: string;
  /** Enables `/api/sms/*`; when absent those routes answer `404 SMS_DISABLED`. */
  sms?: SmsService | null;
  notificationHub?: NotificationHub | null;
  /** Called by `/api/session/reset-breaker` after `.env` is reloaded (key rotation for domain stores). */
  onConfigReloaded?: (config: AppConfig) => Promise<void> | void;
}

/**
 * Hardened zero-dependency HTTP Server hosting:
 * - Authenticated REST API (`/api/*`);
 * - Sub-millisecond SSE stream (`GET /api/events`);
 * - Streamable HTTP MCP JSON-RPC 2.0 endpoint (`POST /mcp`);
 * - Offline prebuilt static frontend assets (`dist/web/public` -> `public`) with strict CSP.
 */
export class FengSuiHttpServer {
  #config: AppConfig;
  readonly core: FengSuiCore;
  readonly sseBus: SseEventBus;
  readonly mcpServer: FengSuiMcpServer;
  readonly envPath: string | undefined;
  readonly startedAtMs: number;
  readonly sms: SmsService | null;
  readonly notificationHub: NotificationHub | null;

  #smsRoutes: SmsHttpRoutes | null;
  #onConfigReloaded: ((config: AppConfig) => Promise<void> | void) | undefined;
  #server: http.Server | null = null;
  readonly #auth = new HttpAuthGuard(() => this.#config);

  constructor(options: FengSuiHttpServerOptions) {
    this.#config = options.config;
    this.core = options.core;
    this.sseBus = options.sseBus;
    this.mcpServer = options.mcpServer;
    this.envPath = options.envPath;
    this.startedAtMs = Date.now();
    this.sms = options.sms ?? null;
    this.notificationHub = options.notificationHub ?? null;
    this.#smsRoutes = this.sms ? new SmsHttpRoutes(this.sms) : null;
    this.#onConfigReloaded = options.onConfigReloaded;
  }

  get config(): AppConfig {
    return this.#config;
  }

  async listen(): Promise<{ host: string; port: number }> {
    if (this.#server) {
      const addr = this.#server.address();
      const port = typeof addr === "object" && addr ? addr.port : this.#config.webPort;
      return { host: this.#config.webHost, port };
    }

    const srv = http.createServer((req, res) => {
      void this.#handleRequest(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          this.#sendJson(res, 500, {
            ok: false,
            errorCode: "INTERNAL_ERROR",
            message: err instanceof Error ? err.message : "Unexpected server error",
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    });

    srv.headersTimeout = 10_000;
    srv.requestTimeout = 15_000;
    srv.maxConnections = 512;

    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(this.#config.webPort, this.#config.webHost, () => {
        srv.off("error", reject);
        resolve();
      });
    });

    this.#server = srv;
    this.#auth.start();
    const addr = srv.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : this.#config.webPort;
    return { host: this.#config.webHost, port: boundPort };
  }

  /**
   * Stop accepting connections. Keep-alive sockets are closed as soon as they are idle; requests
   * still running get `graceMs` to answer (a stopping scheduler answers queued CPE work with 503),
   * then every remaining socket is closed, so shutdown never waits on a slow client or CPE session.
   */
  async close(graceMs = 5000): Promise<void> {
    this.#auth.stop();
    if (!this.#server) return;
    const srv = this.#server;
    this.#server = null;
    const closed = new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
    const sweep = setInterval(() => srv.closeIdleConnections(), 50);
    const force = setTimeout(() => srv.closeAllConnections(), graceMs);
    try {
      await closed;
    } finally {
      clearInterval(sweep);
      clearTimeout(force);
    }
  }

  #sendJson(
    res: ServerResponse,
    statusCode: number,
    body: unknown,
    extraHeaders: Record<string, string> = {}
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(payload, "utf8")),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...extraHeaders,
    });
    res.end(payload);
  }

  #resolveLocale(req: IncomingMessage): SupportedLocale {
    const acceptLang =
      typeof req.headers["accept-language"] === "string"
        ? req.headers["accept-language"]
        : undefined;
    return normalizeLocale(acceptLang, this.#config.defaultLocale);
  }

  /** Answer a failed credential check: `429` with `Retry-After`, otherwise `401`. */
  #sendAuthRejection(
    res: ServerResponse,
    verdict: Extract<CredentialVerdict, { ok: false }>,
    messages: { unauthorized: string; rateLimited: (seconds: number) => string }
  ): void {
    if (verdict.statusCode === 429) {
      const retrySec = verdict.retrySec ?? 60;
      this.#sendJson(
        res,
        429,
        { ok: false, errorCode: "RATE_LIMITED", retryAfterSec: retrySec, message: messages.rateLimited(retrySec) } satisfies ApiErrorEnvelope,
        { "Retry-After": String(retrySec) }
      );
      return;
    }
    this.#sendJson(res, 401, { ok: false, errorCode: "UNAUTHORIZED", message: messages.unauthorized } satisfies ApiErrorEnvelope);
  }

  #apiAuthMessages(locale: SupportedLocale): { unauthorized: string; rateLimited: (seconds: number) => string } {
    return {
      unauthorized: t(locale, "auth.unauthorized"),
      rateLimited: (seconds) => t(locale, "auth.rate_limited", { seconds }),
    };
  }

  async #readBoundedJsonBody(
    req: IncomingMessage,
    maxBytes = MAX_JSON_BODY_BYTES
  ): Promise<Record<string, unknown>> {
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      throw new HttpPayloadError(415, "Expected Content-Type: application/json");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        throw new HttpPayloadError(413, `JSON request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(buf);
    }

    const rawText = Buffer.concat(chunks).toString("utf8").trim();
    if (!rawText) {
      return Object.create(null) as Record<string, unknown>;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonSafeNullProto(rawText);
    } catch {
      throw new HttpPayloadError(400, "Malformed JSON request body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpPayloadError(400, "JSON body must be a key-value object");
    }
    return parsed as Record<string, unknown>;
  }

  async #readRawBodyBounded(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      totalBytes += buf.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        req.destroy();
        throw new HttpPayloadError(413, `Request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawHost = req.headers.host;
    if (!isAllowedHttpHostHeader(rawHost, this.#config.allowedHosts) || !rawHost) {
      this.#sendJson(res, 421, {
        ok: false,
        errorCode: "MISDIRECTED_HOST",
        message: "Rejected by DNS rebinding Host allowlist guard",
      });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    // Never serve permissive CORS preflights; reject OPTIONS to enforce cross-port preflight isolation on NAS
    if (method === "OPTIONS") {
      this.#sendJson(res, 405, {
        ok: false,
        errorCode: "METHOD_NOT_ALLOWED",
        message: "Cross-origin OPTIONS preflight is disabled",
      });
      return;
    }

    const isTlsSocket = Boolean((req.socket as TLSSocket).encrypted);
    const xff =
      typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"]
        : undefined;
    const xfp =
      typeof req.headers["x-forwarded-proto"] === "string"
        ? req.headers["x-forwarded-proto"]
        : undefined;

    const clientIp = resolveClientIp(
      req.socket.remoteAddress,
      xff,
      this.#config.trustedProxies
    );
    const bucketKey = canonicalizeRateLimitBucketKey(clientIp);
    const isHttps = resolveRequestSecureScheme(
      isTlsSocket,
      req.socket.remoteAddress,
      xfp,
      this.#config.trustedProxies
    );
    const locale = this.#resolveLocale(req);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? "/", `${isHttps ? "https" : "http"}://${rawHost}`);
    } catch {
      this.#sendJson(res, 400, { ok: false, errorCode: "BAD_URL", message: "Invalid URL" });
      return;
    }

    const pathname = parsedUrl.pathname;

    // 1. Streamable HTTP MCP Endpoint (`POST /mcp`)
    if (pathname === "/mcp") {
      await this.#handleMcpHttp(req, res, method, bucketKey, rawHost, isHttps);
      return;
    }

    // 2. Public Liveness & Localization Endpoints
    if (pathname === "/api/health" && method === "GET") {
      this.#sendJson(res, 200, {
        ok: true,
        service: "cpe-dash",
        codename: "FengSui",
        version: FENGSUI_VERSION,
        uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      } satisfies HealthResponse);
      return;
    }

    if (pathname.startsWith("/api/i18n/") && method === "GET") {
      const rawTag = pathname.slice("/api/i18n/".length);
      if (rawTag !== "zh-CN" && rawTag !== "en") {
        this.#sendJson(res, 404, {
          ok: false,
          errorCode: "LOCALE_NOT_FOUND",
          message: "Supported locales: zh-CN, en",
        });
        return;
      }
      this.#sendJson(res, 200, {
        ok: true,
        locale: rawTag,
        catalog: getLocaleCatalog(rawTag),
      } satisfies LocaleCatalogResponse);
      return;
    }

    // 3. Authentication Routes
    const authMessages = this.#apiAuthMessages(locale);
    if (pathname === "/api/auth/status" && method === "GET") {
      if (req.headers.authorization !== undefined) {
        const verdict = this.#auth.guardBearer(bucketKey, req.headers.authorization);
        if (!verdict.ok && verdict.statusCode === 429) {
          this.#sendAuthRejection(res, verdict, authMessages);
          return;
        }
        this.#sendJson(res, 200, { ok: true, authenticated: verdict.ok, locale } satisfies AuthStatusResponse);
        return;
      }
      this.#sendJson(res, 200, {
        ok: true,
        authenticated: this.#auth.authenticateCookie(req, bucketKey) !== null,
        locale,
      } satisfies AuthStatusResponse);
      return;
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      if (!this.#auth.validateCsrf(req, rawHost, isHttps)) {
        this.#sendJson(res, 403, { ok: false, errorCode: "CSRF_REJECTED", message: t(locale, "auth.csrf_rejected") });
        return;
      }

      let body: Record<string, unknown>;
      try {
        body = await this.#readBoundedJsonBody(req);
      } catch (err) {
        if (err instanceof HttpPayloadError) {
          this.#sendJson(res, err.statusCode, { ok: false, errorCode: "BAD_PAYLOAD", message: err.message });
          return;
        }
        throw err;
      }

      const candidate =
        typeof body["token"] === "string"
          ? body["token"]
          : typeof body["password"] === "string"
            ? body["password"]
            : "";
      const verdict = this.#auth.guardSecret(bucketKey, candidate);
      if (!verdict.ok) {
        this.#sendAuthRejection(res, verdict, authMessages);
        return;
      }

      // createSession rotates any presented session ID (session fixation defense)
      const newSession = this.#auth.createSession(req, bucketKey);
      const ttlSec = Math.floor(this.#config.sessionTtlMs / 1000);
      this.#sendJson(
        res,
        200,
        { ok: true, authenticated: true, expiresAtIso: new Date(newSession.expiresAtMs).toISOString() } satisfies AuthLoginResponse,
        { "Set-Cookie": this.#auth.sessionCookie(newSession.id, ttlSec, isHttps) }
      );
      return;
    }

    if (pathname === "/api/auth/logout" && method === "POST") {
      const clearCookie = { "Set-Cookie": this.#auth.sessionCookie("logged_out", 0, isHttps) };
      if (req.headers.authorization !== undefined) {
        const verdict = this.#auth.guardBearer(bucketKey, req.headers.authorization);
        if (!verdict.ok) {
          this.#sendAuthRejection(res, verdict, authMessages);
          return;
        }
        this.#sendJson(res, 200, { ok: true, authenticated: false } satisfies AuthLogoutResponse, clearCookie);
        return;
      }

      if (!this.#auth.validateCsrf(req, rawHost, isHttps)) {
        this.#sendJson(res, 403, { ok: false, errorCode: "CSRF_REJECTED", message: t(locale, "auth.csrf_rejected") });
        return;
      }
      const session = this.#auth.authenticateCookie(req, bucketKey);
      if (session) {
        this.#auth.revokeSession(session.id);
        this.sseBus.disconnectBySessionId(session.id);
      }
      this.#sendJson(res, 200, { ok: true, authenticated: false } satisfies AuthLogoutResponse, clearCookie);
      return;
    }

    // 4. Non-API routes -> serve offline static frontend bundle
    if (!pathname.startsWith("/api/")) {
      await serveStaticAsset(res, method, pathname, this.#config.staticDir, (r, code, body) => this.#sendJson(r, code, body));
      return;
    }

    // 5. Protected `/api/*` routes (Cookie OR Bearer auth; a present Authorization header is exclusive)
    const isSseRoute = pathname === "/api/events";
    let session: WebSessionRecord | null = null;
    if (req.headers.authorization !== undefined) {
      const verdict = this.#auth.guardBearer(bucketKey, req.headers.authorization);
      if (!verdict.ok) {
        this.#sendAuthRejection(res, verdict, authMessages);
        return;
      }
    } else {
      session = this.#auth.authenticateCookie(req, bucketKey);
      if (!session) {
        this.#sendJson(res, 401, { ok: false, errorCode: "UNAUTHORIZED", message: authMessages.unauthorized });
        return;
      }
    }

    // Enforce CSRF validation on ALL Cookie-authenticated state mutations
    if (session && method !== "GET" && method !== "HEAD" && !this.#auth.validateCsrf(req, rawHost, isHttps)) {
      this.#sendJson(res, 403, { ok: false, errorCode: "CSRF_REJECTED", message: t(locale, "auth.csrf_rejected") });
      return;
    }

    // SSE Stream (`GET /api/events`)
    if (isSseRoute && method === "GET") {
      const sub = this.sseBus.subscribe({
        req,
        res,
        clientIp: bucketKey,
        sessionId: session?.id ?? null,
        expiresAtMs: session?.expiresAtMs ?? null,
        initialSnapshot: {
          schedulerStatus: this.core.scheduler.getStatus(),
          avoidance: this.core.scheduler.getAvoidanceState(),
          telemetry: this.core.monitor.getCachedTelemetry(),
          lockState: this.core.controls.getPersistedLockState(),
          lockVerification: this.core.controls.getLockVerification(),
          sms: this.sms?.getStatus() ?? null,
        } satisfies SseInitialSnapshot,
      });
      if (!sub.accepted) {
        this.#sendJson(res, 429, {
          ok: false,
          errorCode: "SSE_LIMIT_REACHED",
          message: sub.reason ?? "SSE connection limit reached",
        });
      }
      return;
    }

    await this.#dispatchProtectedApi(req, res, method, pathname, parsedUrl.searchParams);
  }

  async #dispatchProtectedApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
    searchParams: URLSearchParams
  ): Promise<void> {
    try {
      if (pathname === "/api/sms" || pathname.startsWith("/api/sms/")) {
        await this.#dispatchSmsApi(req, res, method, pathname, searchParams);
        return;
      }

      // Strictly side-effect-free GET endpoints (read from cache / ring buffer)
      if (method === "GET") {
        switch (pathname) {
          case "/api/alerts":
            this.#sendJson(res, 200, {
              ok: true,
              alerts: this.core.scheduler.getRecentAlerts(),
              notifications: this.notificationHub?.getStats() ?? null,
            } satisfies AlertsResponse);
            return;

          case "/api/telemetry":
            this.#sendJson(res, 200, {
              ok: true,
              schedulerStatus: this.core.scheduler.getStatus(),
              lockState: this.core.controls.getPersistedLockState(),
              lockVerification: this.core.controls.getLockVerification(),
              telemetry: this.core.monitor.getCachedTelemetry(),
              recentAlerts: this.core.scheduler.getRecentAlerts(),
            } satisfies TelemetryEndpointResponse);
            return;

          case "/api/timeseries": {
            const q = parseQueryNullProto(searchParams);
            const result = this.core.monitor.queryTimeSeries({
              preset: readTimeSeriesPreset(q["preset"]),
              fromMs: parseStrictFiniteInt(q["fromMs"]),
              toMs: parseStrictFiniteInt(q["toMs"]),
              bucketMs: parseStrictFiniteInt(q["bucketMs"]),
              maxPoints: parseStrictFiniteInt(q["maxPoints"]),
            });
            this.#sendJson(res, 200, { ok: true, ...result } satisfies TimeSeriesEndpointResponse);
            return;
          }

          case "/api/neighbors":
            this.#sendJson(res, 200, {
              ok: true,
              schedulerStatus: this.core.scheduler.getStatus(),
              neighbors: this.core.monitor.getCachedNeighbors(),
            } satisfies NeighborsEndpointResponse);
            return;

          case "/api/topology":
            this.#sendJson(res, 200, {
              ok: true,
              schedulerStatus: this.core.scheduler.getStatus(),
              topology: this.core.monitor.getCachedTopology(),
            } satisfies TopologyEndpointResponse);
            return;

          case "/api/settings":
            this.#sendJson(res, 200, {
              ok: true,
              schedulerStatus: this.core.scheduler.getStatus(),
              lockState: this.core.controls.getPersistedLockState(),
              lockVerification: this.core.controls.getLockVerification(),
              settings: this.core.monitor.getCachedSettings(),
            } satisfies SettingsEndpointResponse);
            return;

          case "/api/session/status":
            this.#sendJson(res, 200, {
              ok: true,
              status: this.core.scheduler.getStatus(),
            } satisfies SessionStatusResponse);
            return;

          default:
            this.#sendJson(res, 404, {
              ok: false,
              errorCode: "NOT_FOUND",
              message: `Unknown GET endpoint ${pathname}`,
            });
            return;
        }
      }

      if (method !== "POST") {
        this.#sendJson(res, 405, {
          ok: false,
          errorCode: "METHOD_NOT_ALLOWED",
          message: `Method ${method} not allowed on ${pathname}`,
        });
        return;
      }

      const body = await this.#readBoundedJsonBody(req);

      switch (pathname) {
        case "/api/telemetry/refresh": {
          const telemetry = await this.core.monitor.refreshTelemetry();
          this.#sendJson(res, 200, {
            ok: true,
            schedulerStatus: this.core.scheduler.getStatus(),
            telemetry: telemetry ?? this.core.monitor.getCachedTelemetry(),
          } satisfies TelemetryRefreshResponse);
          return;
        }

        case "/api/neighbors/scan": {
          const neighbors = await this.core.monitor.refreshNeighbors();
          this.#sendJson(res, 200, {
            ok: true,
            schedulerStatus: this.core.scheduler.getStatus(),
            neighbors: neighbors ?? this.core.monitor.getCachedNeighbors(),
          } satisfies NeighborsEndpointResponse);
          return;
        }

        case "/api/topology/refresh": {
          const topology = await this.core.monitor.refreshTopology();
          this.#sendJson(res, 200, {
            ok: true,
            schedulerStatus: this.core.scheduler.getStatus(),
            topology: topology ?? this.core.monitor.getCachedTopology(),
          } satisfies TopologyEndpointResponse);
          return;
        }

        case "/api/settings/refresh": {
          const settings = await this.core.monitor.refreshSettings();
          this.#sendJson(res, 200, {
            ok: true,
            schedulerStatus: this.core.scheduler.getStatus(),
            settings: settings ?? this.core.monitor.getCachedSettings(),
          } satisfies SettingsRefreshResponse);
          return;
        }

        case "/api/session/reset-breaker": {
          const reloadedCfg = loadConfig({
            envPath: this.envPath,
          });
          if (!reloadedCfg.dataEncryptionKey.trim()) {
            throw new CpeControlValidationError(
              "CPE_PASSWORD / DATA_ENCRYPTION_KEY is empty in .env; refusing to re-encrypt stored data under an empty key"
            );
          }
          const tokenRotated = !constantTimeSecretMatch(reloadedCfg.apiToken, this.#config.apiToken);
          this.#config = reloadedCfg;
          this.core.stateStore.rotateEncryptionKey(reloadedCfg.dataEncryptionKey);
          // Re-encrypt now rather than at the next periodic flush (up to 30 min away), so a crash in
          // between cannot leave state.json under a key the reloaded .env no longer provides.
          await this.core.stateStore.flushAsync().catch(() => undefined);
          await this.#onConfigReloaded?.(reloadedCfg);
          if (tokenRotated) {
            this.#auth.revokeAllSessions();
            this.sseBus.disconnectAll();
          }
          const breaker = await this.core.scheduler.reloadCredentialsAndResetBreaker(
            reloadedCfg.cpePassword,
            reloadedCfg.cpeUsername
          );
          this.#sendJson(res, 200, {
            ok: true,
            circuitBreaker: breaker,
            status: this.core.scheduler.getStatus(),
          } satisfies ResetBreakerResponse);
          return;
        }

        case "/api/control/band-lock": {
          const lteBands = readBandSelection(body, "lteBands");
          const nrBands = readBandSelection(body, "nrBands");
          const lockState = await this.core.controls.lockBands({ lteBands, nrBands });
          this.#sendJson(res, 200, { ok: true, lockState } satisfies LockStateResponse);
          return;
        }

        case "/api/control/cell-lock": {
          // Omitted or null pci means a frequency lock; anything else must be a number, never silently dropped
          const lockState = await this.core.controls.lockCell(readCellLockCommand(body, { allowNullPci: true }));
          this.#sendJson(res, 200, { ok: true, lockState } satisfies LockStateResponse);
          return;
        }

        case "/api/control/unlock": {
          const lockState = await this.core.controls.unlockAllLocks();
          this.#sendJson(res, 200, { ok: true, lockState } satisfies LockStateResponse);
          return;
        }

        case "/api/control/reboot": {
          const result = await this.core.controls.rebootRouter({
            confirm: body["confirm"] === true,
          });
          this.#sendJson(res, 200, { ok: true, ...result } satisfies RebootResponse);
          return;
        }

        case "/api/control/reconnect": {
          if (body["confirm"] !== true) {
            throw new CpeControlValidationError(
              "Cellular reconnect requires explicit { confirm: true }"
            );
          }
          const result = await this.core.controls.reconnectCellular();
          this.#sendJson(res, 200, { ok: true, ...result } satisfies ReconnectResponse);
          return;
        }

        case "/api/control/security": {
          const upnpEnabled = readOptionalBoolean(body, "upnpEnabled");

          let dmz: { enabled: boolean; ipAddress?: string } | undefined;
          const rawDmz = body["dmz"];
          if (rawDmz !== undefined) {
            if (!rawDmz || typeof rawDmz !== "object" || Array.isArray(rawDmz)) {
              throw new CpeControlValidationError('Field "dmz" must be an object');
            }
            const dmzObj = rawDmz as Record<string, unknown>;
            if (typeof dmzObj["enabled"] !== "boolean") {
              throw new CpeControlValidationError('Field "dmz.enabled" must be boolean');
            }
            let ipAddress: string | undefined;
            if (dmzObj["ipAddress"] !== undefined) {
              if (typeof dmzObj["ipAddress"] !== "string" || net.isIP(dmzObj["ipAddress"].trim()) !== 4) {
                throw new CpeControlValidationError('Field "dmz.ipAddress" must be a valid IPv4 address');
              }
              ipAddress = dmzObj["ipAddress"].trim();
            }
            dmz = { enabled: dmzObj["enabled"], ipAddress };
          }

          let firewall: Partial<FirewallSwitchState> | undefined;
          const rawFw = body["firewall"];
          if (rawFw !== undefined) {
            if (!rawFw || typeof rawFw !== "object" || Array.isArray(rawFw)) {
              throw new CpeControlValidationError('Field "firewall" must be an object');
            }
            const cleanFw = Object.create(null) as Partial<FirewallSwitchState>;
            for (const [k, v] of Object.entries(rawFw as Record<string, unknown>)) {
              if (!ALLOWED_FIREWALL_KEYS.has(k as keyof FirewallSwitchState)) {
                throw new CpeControlValidationError(`Unknown firewall switch key "${k}"`);
              }
              if (v !== undefined) {
                if (typeof v !== "boolean") {
                  throw new CpeControlValidationError(`Firewall switch "${k}" must be boolean`);
                }
                cleanFw[k as keyof FirewallSwitchState] = v;
              }
            }
            firewall = cleanFw;
          }

          const settings = await this.core.controls.setSecuritySwitches({
            upnpEnabled,
            dmz,
            firewall,
          });
          this.#sendJson(res, 200, { ok: true, settings } satisfies SecurityControlResponse);
          return;
        }

        case "/api/control/wifi7": {
          const mloEnable = readOptionalBoolean(body, "mloEnable");
          const dbhoEnable = readOptionalBoolean(body, "dbhoEnable");
          const wifi7 = await this.core.controls.setWifi7Settings({ mloEnable, dbhoEnable });
          this.#sendJson(res, 200, { ok: true, wifi7 } satisfies Wifi7ControlResponse);
          return;
        }

        case "/api/control/antenna": {
          const antenna = await this.core.controls.setAntennaMode(readAntennaMode(body["mode"]));
          this.#sendJson(res, 200, { ok: true, antenna } satisfies AntennaControlResponse);
          return;
        }

        case "/api/control/mobile-data": {
          const enabled = readOptionalBoolean(body, "enabled");
          if (enabled === undefined) {
            throw new CpeControlValidationError('"enabled" must be a boolean');
          }
          const result = await this.core.controls.setMobileData(enabled);
          this.#sendJson(res, 200, { ok: true, ...result } satisfies MobileDataControlResponse);
          return;
        }

        default:
          this.#sendJson(res, 404, {
            ok: false,
            errorCode: "NOT_FOUND",
            message: `Unknown POST endpoint ${pathname}`,
          });
      }
    } catch (err) {
      if (err instanceof HttpPayloadError) {
        this.#sendJson(res, err.statusCode, {
          ok: false,
          errorCode: "BAD_PAYLOAD",
          message: err.message,
        } satisfies ApiErrorEnvelope);
        return;
      }
      if (err instanceof CpeControlValidationError || err instanceof TimeSeriesValidationError) {
        this.#sendJson(res, 400, {
          ok: false,
          errorCode: "VALIDATION_ERROR",
          message: err.message,
        } satisfies ApiErrorEnvelope);
        return;
      }
      if (err instanceof BrowserSessionYieldedError) {
        this.#sendJson(res, 409, {
          ok: false,
          errorCode: "BROWSER_SESSION_YIELDED",
          message: err.messageZh,
          messageEn: err.messageEn,
          avoidance: this.core.scheduler.getAvoidanceState(),
        } satisfies ApiErrorEnvelope);
        return;
      }
      if (err instanceof PeerDaemonStandbyError) {
        this.#sendJson(res, 409, {
          ok: false,
          errorCode: "PEER_DAEMON_ACTIVE",
          message: err.message,
          peerAddress: err.peerAddress,
        } satisfies ApiErrorEnvelope);
        return;
      }
      if (err instanceof CircuitBreakerOpenError) {
        this.#sendJson(res, 423, {
          ok: false,
          errorCode: "CIRCUIT_BREAKER_OPEN",
          message: err.message,
          circuitBreaker: err.circuitBreaker,
        } satisfies ApiErrorEnvelope);
        return;
      }
      if (err instanceof SchedulerQueueFullError || err instanceof SchedulerStoppedError) {
        this.#sendJson(res, 503, {
          ok: false,
          errorCode: "QUEUE_FULL",
          message: err.message,
        } satisfies ApiErrorEnvelope);
        return;
      }
      this.#sendJson(res, 502, {
        ok: false,
        errorCode: "CPE_UPSTREAM_ERROR",
        message: err instanceof Error ? err.message : String(err),
      } satisfies ApiErrorEnvelope);
    }
  }

  /** Delegate `/api/sms/*` to the SMS route module (errors bubble to the shared error mapping). */
  async #dispatchSmsApi(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    pathname: string,
    searchParams: URLSearchParams
  ): Promise<void> {
    if (!this.#smsRoutes) {
      this.#sendJson(res, 404, {
        ok: false,
        errorCode: "SMS_DISABLED",
        message: "SMS features are disabled (SMS_ENABLED=false)",
      });
      return;
    }
    if (method !== "GET" && method !== "POST") {
      this.#sendJson(res, 405, {
        ok: false,
        errorCode: "METHOD_NOT_ALLOWED",
        message: `Method ${method} not allowed on ${pathname}`,
      });
      return;
    }
    const handled = await this.#smsRoutes.handle({
      method,
      pathname,
      query: parseQueryNullProto(searchParams),
      readJsonBody: (maxBytes) => this.#readBoundedJsonBody(req, maxBytes),
      sendJson: (statusCode, body) => this.#sendJson(res, statusCode, body),
    });
    if (!handled) {
      this.#sendJson(res, 404, {
        ok: false,
        errorCode: "NOT_FOUND",
        message: `Unknown ${method} endpoint ${pathname}`,
      });
    }
  }

  async #handleMcpHttp(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    bucketKey: string,
    validatedHost: string,
    isHttps: boolean
  ): Promise<void> {
    if (!this.#config.mcpHttpEnabled) {
      this.#sendJson(res, 404, {
        ok: false,
        errorCode: "MCP_DISABLED",
        message: "Streamable HTTP MCP endpoint is disabled",
      });
      return;
    }

    if (method !== "POST") {
      this.#sendJson(res, 405, {
        ok: false,
        errorCode: "METHOD_NOT_ALLOWED",
        message: "Streamable HTTP MCP endpoint accepts POST only",
      });
      return;
    }

    // If a browser sends an Origin header to `/mcp`, strictly enforce Same-Origin (MCP DNS-rebinding defense)
    const rawOrigin = req.headers.origin;
    if (rawOrigin !== undefined) {
      if (rawOrigin === "null") {
        this.#sendJson(res, 403, {
          ok: false,
          errorCode: "FORBIDDEN_ORIGIN",
          message: "Rejected null Origin on /mcp",
        });
        return;
      }
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(rawOrigin);
      } catch {
        this.#sendJson(res, 403, {
          ok: false,
          errorCode: "FORBIDDEN_ORIGIN",
          message: "Malformed Origin header on /mcp",
        });
        return;
      }
      const expectedProto = isHttps ? "https:" : "http:";
      if (
        parsedOrigin.protocol !== expectedProto ||
        parsedOrigin.host.toLowerCase() !== validatedHost.toLowerCase()
      ) {
        this.#sendJson(res, 403, {
          ok: false,
          errorCode: "FORBIDDEN_ORIGIN",
          message: "Cross-origin access to /mcp is forbidden",
        });
        return;
      }
    }

    // Streamable HTTP `/mcp` strictly requires Bearer API_TOKEN authentication
    const mcpMessages = {
      unauthorized: "Missing or invalid Bearer API_TOKEN for /mcp",
      rateLimited: () => "Too many authentication failures",
    };
    if (req.headers.authorization === undefined) {
      const bucketRetry = this.#auth.checkBucket(bucketKey);
      this.#sendAuthRejection(
        res,
        bucketRetry !== null ? { ok: false, statusCode: 429, retrySec: bucketRetry } : { ok: false, statusCode: 401 },
        mcpMessages
      );
      return;
    }
    const mcpVerdict = this.#auth.guardBearer(bucketKey, req.headers.authorization);
    if (!mcpVerdict.ok) {
      this.#sendAuthRejection(res, mcpVerdict, mcpMessages);
      return;
    }

    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      this.#sendJson(res, 415, {
        ok: false,
        errorCode: "UNSUPPORTED_MEDIA_TYPE",
        message: "Expected Content-Type: application/json",
      });
      return;
    }

    let rawBody: string;
    try {
      rawBody = await this.#readRawBodyBounded(req);
    } catch (err) {
      if (err instanceof HttpPayloadError) {
        this.#sendJson(res, err.statusCode, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: err.message },
        });
        return;
      }
      throw err;
    }

    const header = (name: string): string | undefined => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const outcome = await this.mcpServer.handleHttpMessage(rawBody, {
      protocolVersion: header("mcp-protocol-version"),
      method: header("mcp-method"),
      name: header("mcp-name"),
    });
    const rpcResponse = outcome.body;
    if (rpcResponse === null) {
      // Valid JSON-RPC notification -> 202 Accepted with empty body per Streamable HTTP spec
      res.writeHead(202, {
        "Content-Length": "0",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end();
      return;
    }

    this.#sendJson(res, outcome.status, rpcResponse);
  }
}
