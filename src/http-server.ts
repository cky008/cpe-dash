import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import type { AgentTestService } from "./agent-test-service.ts";
import {
  canonicalizeRateLimitBucketKey,
  isAllowedHttpHostHeader,
  resolveClientIp,
  resolveRequestSecureScheme,
} from "./config.ts";
import { HttpPayloadError } from "./control-error.ts";
import { CpeControlValidationError } from "./cpe-domain.ts";
import { type AuditActor, type AuditLog, runAsActor } from "./audit-log.ts";
import { tokenMay, validateNewPassword } from "./console-policy.ts";
import { type BearerIdentity, type ConsoleSettings, verifyResetLoginProof } from "./console-settings.ts";
import {
  type CredentialVerdict,
  HttpAuthGuard,
  type WebSessionRecord,
} from "./http-auth.ts";
import type {
  ApiErrorEnvelope,
  AuthLoginResponse,
  AuthLogoutResponse,
  AuthStatusResponse,
  HealthResponse,
  LocaleCatalogResponse,
} from "./api-contract.ts";
import type { FengSuiApi } from "./http-api.ts";
import { CONSOLE_ONLY_PATHS, permissionForRoute } from "./operations/registry.ts";
import { serveStaticAsset } from "./http-static.ts";
import {
  getLocaleCatalog,
  normalizeLocale,
  t,
} from "./i18n.ts";
import { parseJsonSafeNullProto } from "./json-safe.ts";
import { type RuntimeSample, renderMetrics } from "./metrics.ts";
import type { FengSuiMcpServer } from "./mcp-server.ts";
import type { FengSuiCore } from "./core.ts";
import { sanitizeFreeText } from "./sanitize.ts";
import type { SseEventBus } from "./sse-bus.ts";
import type { AppConfig, SupportedLocale } from "./types.ts";
import { FENGSUI_VERSION } from "./version.ts";

const MAX_JSON_BODY_BYTES = 64 * 1024;
export { constantTimeSecretMatch } from "./http-auth.ts";

export interface FengSuiHttpServerOptions {
  config: AppConfig;
  /** The REST API behind the sign-in (src/http-api.ts): this server authenticates, then hands each request to it. */
  api: FengSuiApi;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  /** The console login and Bearer tokens: who may sign in. */
  settings: ConsoleSettings;
  audit?: AuditLog | null;
  /** Where an unexpected error's detail goes (the daemon's log); the client only gets a generic message. */
  log?: (line: string) => void;
  /** The daemon process's own figures for `/metrics` (memory, CPU, event-loop delay). */
  runtimeSample?: (() => RuntimeSample) | null;
  /** The AI agent test at one click: it learns which token calls MCP (the agent's). */
  agentTest?: AgentTestService | null;
}

/**
 * Hardened zero-dependency HTTP Server hosting:
 * - Authenticated REST API (`/api/*`), answered by `FengSuiApi` once a request is signed in;
 * - Sub-millisecond SSE stream (`GET /api/events`);
 * - Streamable HTTP MCP JSON-RPC 2.0 endpoint (`POST /mcp`);
 * - Offline prebuilt static frontend assets (`dist/web/public` -> `public`) with strict CSP.
 */
export class FengSuiHttpServer {
  #config: AppConfig;
  readonly api: FengSuiApi;
  readonly sseBus: SseEventBus;
  readonly mcpServer: FengSuiMcpServer;

  #server: http.Server | null = null;
  readonly #auth: HttpAuthGuard;
  readonly settings: ConsoleSettings;
  readonly #audit: AuditLog | null;
  readonly #log: (line: string) => void;
  readonly #runtimeSample: (() => RuntimeSample) | null;
  readonly #agentTest: AgentTestService | null;

  constructor(options: FengSuiHttpServerOptions) {
    this.#config = options.config;
    this.api = options.api;
    this.sseBus = options.sseBus;
    this.mcpServer = options.mcpServer;
    this.#runtimeSample = options.runtimeSample ?? null;
    this.settings = options.settings;
    this.#audit = options.audit ?? null;
    this.#log = options.log ?? (() => undefined);
    this.#auth = new HttpAuthGuard(() => this.#config, options.settings);
    // A password change in the console ends the other console sessions this server keeps
    options.api.attachSessions({ revokeAllSessionsExcept: (keep) => [...this.#auth.revokeAllSessionsExcept(keep)] });
    this.#agentTest = options.agentTest ?? null;
  }

  get core(): FengSuiCore {
    return this.api.core;
  }

  /** The configuration `/api/session/reset-breaker` reloaded from `.env` (src/cli.ts): hosts, proxies, sessions follow it. */
  setConfig(config: AppConfig): void {
    this.#config = config;
  }

  /** Metrics follow the console's switch when set, else METRICS_ENABLED from `.env`. */
  get metricsEnabled(): boolean {
    return this.settings.metricsEnabled ?? this.#config.metricsEnabled;
  }

  /** Tokens get masked identifiers when the console says so, else as REDACT_SENSITIVE_IN_API says. */
  get redactApi(): boolean {
    return this.settings.behaviourOverrides.redactApi ?? this.#config.redactSensitiveInApi;
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
        // A bug's message can carry internal detail: it goes to the daemon's log, the client gets a generic answer
        const where = `${req.method ?? "?"} ${((req.url ?? "").split("?")[0] ?? "").slice(0, 120)}`;
        this.#log(`[http] unexpected error on ${sanitizeFreeText(`${where}: ${err instanceof Error ? err.message : String(err)}`).slice(0, 320)}`);
        if (!res.headersSent) {
          this.#sendJson(res, 500, {
            ok: false,
            errorCode: "INTERNAL_ERROR",
            message: "Unexpected server error",
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

    // Prometheus scrape target (off unless METRICS_ENABLED or the console turns it on; any token)
    if (pathname === "/metrics" && method === "GET") {
      if (!this.metricsEnabled) {
        this.#sendJson(res, 404, { ok: false, errorCode: "NOT_FOUND", message: "Metrics are off (METRICS_ENABLED, or the console's switch)" });
        return;
      }
      const verdict = this.#auth.guardBearerRole(bucketKey, req.headers.authorization ?? "");
      if (!verdict.ok) {
        this.#sendAuthRejection(res, verdict, this.#apiAuthMessages(locale));
        return;
      }
      const body = renderMetrics({
        version: FENGSUI_VERSION,
        daemonUptimeSec: Math.floor((Date.now() - this.api.startedAtMs) / 1000),
        scheduler: this.core.scheduler.getStatus(),
        telemetry: this.core.monitor.getCachedTelemetry(),
        ...(this.#runtimeSample ? { runtime: this.#runtimeSample() } : {}),
      });
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }

    // 2. Public Liveness & Localization Endpoints
    if (pathname === "/api/health" && method === "GET") {
      this.#sendJson(res, 200, this.api.health() satisfies HealthResponse);
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
        this.#sendJson(res, 200, { ok: true, authenticated: verdict.ok, locale, setupRequired: !this.settings.loginConfigured } satisfies AuthStatusResponse);
        return;
      }
      this.#sendJson(res, 200, {
        ok: true,
        authenticated: this.#auth.authenticateCookie(req, bucketKey) !== null,
        locale,
        setupRequired: !this.settings.loginConfigured,
      } satisfies AuthStatusResponse);
      return;
    }

    // `cpe-dash reset-login` on the daemon's own host: proof of the data key, from loopback only. The
    // client address after TRUSTED_PROXIES: a reverse proxy on this host forwards every client from loopback
    if (pathname === "/api/setup/reset-code" && method === "POST") {
      const loopback = clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1";
      const proof = typeof req.headers["x-fengsui-proof"] === "string" ? req.headers["x-fengsui-proof"] : "";
      const verdict = this.#auth.guard(bucketKey, loopback && verifyResetLoginProof(this.#config.dataEncryptionKey, proof, Date.now()));
      if (!verdict.ok) {
        this.#sendAuthRejection(res, verdict, this.#apiAuthMessages(locale));
        return;
      }
      this.#audit?.record({ action: "login.reset-code", outcome: "applied", detail: "issued to cpe-dash reset-login on the daemon host", actor: { channel: "system" } });
      this.#sendJson(res, 200, { ok: true, code: this.settings.issueCode("reset"), expiresInSec: 900 });
      return;
    }

    // First-time setup (no console password yet) and password reset: a one-time code instead of a login
    if ((pathname === "/api/setup/login" || pathname === "/api/auth/reset") && method === "POST") {
      await this.#handleCodeLogin(req, res, pathname === "/api/setup/login" ? "setup" : "reset", { rawHost, isHttps, bucketKey, locale });
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
      const verdict = await this.#auth.guardLogin(bucketKey, candidate);
      if (!verdict.ok) {
        if (verdict.statusCode === 401) this.#audit?.record({ action: "login", outcome: "refused", detail: `wrong password from ${clientIp}`, actor: { channel: "web" } });
        this.#sendAuthRejection(res, verdict, authMessages);
        return;
      }
      this.#audit?.record({ action: "login", outcome: "applied", detail: `from ${clientIp}`, actor: { channel: "web" } });

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
    let identity: BearerIdentity | null = null;
    if (req.headers.authorization !== undefined) {
      const verdict = this.#auth.guardBearerRole(bucketKey, req.headers.authorization);
      if (!verdict.ok) {
        this.#sendAuthRejection(res, verdict, authMessages);
        return;
      }
      identity = verdict.identity;
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

    // Recently deleted is the owner's safety net: tokens (scripts, agents) may fill it and restore from it, never empty it
    if (identity && CONSOLE_ONLY_PATHS.has(pathname)) {
      this.#sendJson(res, 403, {
        ok: false,
        errorCode: "CONSOLE_ONLY",
        message: "Messages are deleted for good only from a signed-in web console, not with a Bearer token",
      } satisfies ApiErrorEnvelope);
      return;
    }

    // A token reads the router's data and runs read sessions; anything else needs its permission (Settings → Tokens)
    const needed = identity ? permissionForRoute(method, pathname) : null;
    if (identity && needed !== null && !tokenMay(identity.permissions, needed)) {
      const changesNothing = identity.permissions.every((permission) => permission === "sms-read");
      this.#sendJson(
        res,
        403,
        needed !== "sms-read" && changesNothing
          ? ({ ok: false, errorCode: "READ_ONLY_TOKEN", message: "This Bearer token is read-only; this request needs a token allowed to make this change" } satisfies ApiErrorEnvelope)
          : ({
              ok: false,
              errorCode: "TOKEN_NOT_PERMITTED",
              message: `This token may not do this: it needs the "${needed}" permission (change it in the console under Settings → Tokens)`,
              permission: needed,
            } satisfies ApiErrorEnvelope)
      );
      return;
    }

    // Credentials, tokens and console switches change only from a console session, never with a token
    if (session === null && (pathname === "/api/console" || pathname.startsWith("/api/console/"))) {
      this.#sendJson(res, 403, {
        ok: false,
        errorCode: "CONSOLE_ONLY",
        message: "Console settings can only be changed from a signed-in web console, not with a Bearer token",
      } satisfies ApiErrorEnvelope);
      return;
    }

    // A cookie session is the web console, which masks identifiers on screen until revealed; Bearer
    // clients (scripts, agents, integrations) get the REDACT_SENSITIVE_IN_API copies instead
    const redact = session === null && this.redactApi;
    // A token without the sms-read permission gets no SMS over the event stream either
    const smsAllowed = identity === null || identity.permissions.includes("sms-read");

    // SSE Stream (`GET /api/events`)
    if (isSseRoute && method === "GET") {
      const sub = this.sseBus.subscribe({
        req,
        res,
        clientIp: bucketKey,
        sessionId: session?.id ?? null,
        tokenId: identity?.tokenId ?? null,
        // The stream ends when what opened it does: the console session, or an expiring token
        expiresAtMs: session?.expiresAtMs ?? identity?.expiresAtMs ?? null,
        redact,
        sms: smsAllowed,
        initialSnapshot: this.api.hello(redact, smsAllowed),
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

    const actor: AuditActor = session ? { channel: "web" } : { channel: "token", label: identity?.name ?? "?" };
    await runAsActor(actor, () =>
      this.api.dispatch(
        {
          method,
          pathname,
          searchParams: parsedUrl.searchParams,
          readJsonBody: (maxBytes?: number) => this.#readBoundedJsonBody(req, maxBytes),
          sendJson: (statusCode: number, body: unknown, headers?: Record<string, string>) => this.#sendJson(res, statusCode, body, headers),
        },
        {
          redact,
          clientIp,
          bucketKey,
          sessionId: session?.id ?? null,
          // The sign-in bucket (an IPv6 /64, as the session is bound to), so rotating addresses does not reset it
          checkPassword: (candidate) => this.#auth.guardLogin(bucketKey, candidate),
        }
      )
    );
  }

  /** `POST /api/setup/login` (no password yet) and `POST /api/auth/reset`: a one-time code sets the password and signs in. */
  async #handleCodeLogin(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "setup" | "reset",
    request: { rawHost: string; isHttps: boolean; bucketKey: string; locale: SupportedLocale }
  ): Promise<void> {
    const { rawHost, isHttps, bucketKey, locale } = request;
    if (!this.#auth.validateCsrf(req, rawHost, isHttps)) {
      this.#sendJson(res, 403, { ok: false, errorCode: "CSRF_REJECTED", message: t(locale, "auth.csrf_rejected") });
      return;
    }
    if (kind === "setup" && this.settings.loginConfigured) {
      this.#sendJson(res, 409, { ok: false, errorCode: "ALREADY_SET_UP", message: "The console password is already set: sign in, or reset it with a reset code" });
      return;
    }
    let body: Record<string, unknown>;
    let password: string;
    try {
      body = await this.#readBoundedJsonBody(req);
      password = validateNewPassword(body["password"]);
    } catch (err) {
      if (err instanceof HttpPayloadError) {
        this.#sendJson(res, err.statusCode, { ok: false, errorCode: "BAD_PAYLOAD", message: err.message });
        return;
      }
      if (err instanceof CpeControlValidationError) {
        this.#sendJson(res, 400, { ok: false, errorCode: "VALIDATION_ERROR", message: err.message });
        return;
      }
      throw err;
    }
    const code = typeof body["code"] === "string" ? body["code"] : "";
    const verdict = this.#auth.guardCode(bucketKey, () => Boolean(code) && this.settings.consumeCode(kind, code));
    if (!verdict.ok) {
      this.#audit?.record({ action: kind === "setup" ? "setup" : "login.reset", outcome: "refused", detail: "wrong or expired code", actor: { channel: "web" } });
      this.#sendAuthRejection(res, verdict, this.#apiAuthMessages(locale));
      return;
    }
    await this.settings.setLogin(password);
    for (const id of this.#auth.revokeAllSessionsExcept(null)) this.sseBus.disconnectBySessionId(id);
    this.#audit?.record({ action: kind === "setup" ? "setup" : "login.reset", outcome: "applied", detail: "console password set", actor: { channel: "web" } });
    const newSession = this.#auth.createSession(req, bucketKey);
    this.#sendJson(
      res,
      200,
      { ok: true, authenticated: true, expiresAtIso: new Date(newSession.expiresAtMs).toISOString() } satisfies AuthLoginResponse,
      { "Set-Cookie": this.#auth.sessionCookie(newSession.id, Math.floor(this.#config.sessionTtlMs / 1000), isHttps) }
    );
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
      unauthorized: "Missing or invalid Bearer token for /mcp (tokens are created in the console under Settings → Tokens)",
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
    const mcpVerdict = this.#auth.guardBearerRole(bucketKey, req.headers.authorization);
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
    // The token an agent calls with: the one the console offers to allow changing the router for a test
    this.#agentTest?.noteAgentCall(mcpVerdict.identity.tokenId);
    const outcome = await runAsActor({ channel: "mcp", label: mcpVerdict.identity.name }, () =>
      this.mcpServer.handleHttpMessage(
        rawBody,
        {
          protocolVersion: header("mcp-protocol-version"),
          method: header("mcp-method"),
          name: header("mcp-name"),
        },
        { permissions: mcpVerdict.identity.permissions }
      )
    );
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
