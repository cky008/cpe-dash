import type { ApiErrorEnvelope, AuthLoginResponse, AuthLogoutResponse, AuthStatusResponse, LocaleCatalogResponse } from "../../../src/api-contract.ts";
import { HttpPayloadError } from "../../../src/control-error.ts";
import type { ApiExchange } from "../../../src/http-api.ts";
import { getLocaleCatalog } from "../../../src/i18n.ts";
import { parseJsonSafeNullProto } from "../../../src/json-safe.ts";
import type { FengSuiServices } from "../../../src/services.ts";
import type { SseResponse } from "../../../src/sse-bus.ts";
import type { EventSourceLike } from "../core/sse.ts";
import { DEMO_CPE_PASSWORD } from "./worlds.ts";

/**
 * How the console in the page reaches the daemon's services in the same page: its `fetch` goes to the
 * daemon's REST API behind the sign-in (src/http-api.ts), its `EventSource` to the daemon's event bus,
 * each frame handed over as the bus writes it. What the daemon's HTTP server does before that (Host
 * allow-list, cookies, CSRF, rate limits, static files, MCP, metrics) has no place in a page with no
 * network; what the demo does instead is its own: the sign-in, where any password opens the demo (a
 * public demo has nothing to keep secret), and the router's password, which a visitor does not know,
 * put into a connection test or save for them.
 */

const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Where the console seems to be (a LAN address of the household; the daemon's guard protects that device). */
const CONSOLE_IP = "192.168.8.20";
const SESSION_ID = "demo-console";
const SESSION_TTL_MS = 12 * 3_600_000;

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://demo.invalid");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** A request body as the daemon reads one: a JSON object within `maxBytes`, or nothing. */
function readBody(raw: string, maxBytes: number): Record<string, unknown> {
  if (new TextEncoder().encode(raw).length > maxBytes) throw new HttpPayloadError(413, `JSON request body exceeds ${maxBytes} bytes`);
  const text = raw.trim();
  if (!text) return Object.create(null) as Record<string, unknown>;
  let parsed: unknown;
  try {
    parsed = parseJsonSafeNullProto(text);
  } catch {
    throw new HttpPayloadError(400, "Malformed JSON request body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpPayloadError(400, "JSON body must be a key-value object");
  return parsed as Record<string, unknown>;
}

/** The console's `EventSource`: the bus writes `event:` / `data:` frames into it, its listeners get them. */
export class DemoEventSource implements EventSourceLike {
  readonly #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  readonly #onClose: () => void;
  #closed = false;
  #buffer = "";

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  get closed(): boolean {
    return this.#closed;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onClose();
  }

  dispatch(type: string, data?: string): void {
    if (this.#closed) return;
    for (const listener of this.#listeners.get(type) ?? []) listener(data === undefined ? {} : { data });
  }

  /** Text the bus wrote: whole frames go out, a partial one waits for the rest. */
  receive(chunk: string): void {
    this.#buffer += chunk;
    let end = this.#buffer.indexOf("\n\n");
    while (end >= 0) {
      const frame = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        // ": heartbeat …" comments and "id:" lines carry nothing for the console
      }
      if (data.length > 0) this.dispatch(type, data.join("\n"));
      end = this.#buffer.indexOf("\n\n");
    }
  }
}

export interface DemoTransportOptions {
  services: FengSuiServices;
}

export class DemoTransport {
  readonly #services: FengSuiServices;
  readonly #sources = new Set<DemoEventSource>();
  #authenticated = false;

  constructor(opts: DemoTransportOptions) {
    this.#services = opts.services;
  }

  /** The visitor arrives signed in, as an owner opening their console. */
  signIn(): void {
    if (this.#authenticated) return;
    this.#authenticated = true;
    this.#services.audit.record({ action: "login", outcome: "applied", detail: `from ${CONSOLE_IP}`, actor: { channel: "web" } });
  }

  /** `fetch` for the console's ApiClient. */
  readonly fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : "";
    try {
      const own = await this.#demoRoute(method, url.pathname, raw);
      if (own) return own;
      if (!this.#authenticated) return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Sign in first" } satisfies ApiErrorEnvelope);
      return await this.#dispatch(method, url, raw);
    } catch (err) {
      if (err instanceof HttpPayloadError) return json(err.statusCode, { ok: false, errorCode: "BAD_PAYLOAD", message: err.message } satisfies ApiErrorEnvelope);
      return json(500, { ok: false, errorCode: "INTERNAL_ERROR", message: "Unexpected server error" } satisfies ApiErrorEnvelope);
    }
  };

  /** `EventSource` factory for the console's SseClient. */
  readonly createEventSource = (_url: string): EventSourceLike => {
    const source = new DemoEventSource(() => {
      this.#sources.delete(source);
      for (const listener of closeListeners) listener();
    });
    const closeListeners: Array<() => void> = [];
    this.#sources.add(source);
    // A stream opens after the page has added its listeners, as a browser's does
    setTimeout(() => {
      if (source.closed) return;
      if (!this.#authenticated) {
        source.dispatch("error");
        return;
      }
      let ended = false;
      const response: SseResponse = {
        writeHead: () => undefined,
        write: (chunk: string) => {
          source.receive(chunk);
          return true;
        },
        end: () => {
          ended = true;
          source.dispatch("error");
        },
        get writableEnded() {
          return ended;
        },
        get destroyed() {
          return source.closed;
        },
        on: (event, listener) => {
          if (event === "close") closeListeners.push(listener);
        },
      };
      this.#services.sseBus.subscribe({
        req: { on: (event, listener) => void (event === "close" && closeListeners.push(listener)) },
        res: response,
        clientIp: CONSOLE_IP,
        sessionId: SESSION_ID,
        expiresAtMs: null,
        redact: false,
        sms: true,
        initialSnapshot: this.#services.api.hello(false, true),
      });
    }, 0);
    return source;
  };

  /** Close every stream (the page is going away, or the visitor signed out). */
  close(): void {
    for (const source of [...this.#sources]) source.close();
  }

  /** The demo's own routes: the sign-in, liveness, the dictionaries. */
  async #demoRoute(method: string, pathname: string, raw: string): Promise<Response | null> {
    if (pathname === "/api/health" && method === "GET") return json(200, this.#services.api.health());
    if (pathname === "/api/auth/status" && method === "GET") {
      return json(200, { ok: true, authenticated: this.#authenticated, locale: "zh-CN", setupRequired: false } satisfies AuthStatusResponse);
    }
    if (pathname === "/api/auth/login" && method === "POST") {
      const body = readBody(raw, MAX_JSON_BODY_BYTES);
      // Any password opens the demo; the daemon also takes it as `token` (older consoles)
      const password = typeof body["password"] === "string" ? body["password"] : body["token"];
      if (typeof password !== "string" || !password) return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "Invalid console password" } satisfies ApiErrorEnvelope);
      this.signIn();
      return json(200, { ok: true, authenticated: true, expiresAtIso: new Date(Date.now() + SESSION_TTL_MS).toISOString() } satisfies AuthLoginResponse);
    }
    if (pathname === "/api/auth/logout" && method === "POST") {
      this.#authenticated = false;
      this.close();
      return json(200, { ok: true, authenticated: false } satisfies AuthLogoutResponse);
    }
    if (pathname.startsWith("/api/i18n/") && method === "GET") {
      const tag = pathname.slice("/api/i18n/".length);
      if (tag !== "zh-CN" && tag !== "en") return json(404, { ok: false, errorCode: "LOCALE_NOT_FOUND", message: "Supported locales: zh-CN, en" });
      return json(200, { ok: true, locale: tag, catalog: getLocaleCatalog(tag) } satisfies LocaleCatalogResponse);
    }
    return null;
  }

  /** Everything else: the daemon's REST API, on behalf of the web console. */
  async #dispatch(method: string, url: URL, raw: string): Promise<Response> {
    let answer: Response | null = null;
    const exchange: ApiExchange = {
      method,
      pathname: url.pathname,
      searchParams: url.searchParams,
      readJsonBody: async (maxBytes = MAX_JSON_BODY_BYTES) => {
        const body = readBody(raw, maxBytes);
        // The visitor does not know the demo router's password: a test or save of the connection uses it
        if ((url.pathname === "/api/console/cpe/test" || url.pathname === "/api/console/cpe") && typeof body["password"] === "string" && body["password"] !== "") {
          body["password"] = DEMO_CPE_PASSWORD;
        }
        return body;
      },
      sendJson: (statusCode, body, headers) => {
        answer = json(statusCode, body, headers);
      },
    };
    await this.#services.api.dispatch(exchange, {
      redact: false,
      clientIp: CONSOLE_IP,
      bucketKey: CONSOLE_IP,
      sessionId: SESSION_ID,
      // Any password opens the demo, so any current password is the right one
      checkPassword: async () => ({ ok: true }),
      actor: { channel: "web" },
    });
    return answer ?? json(404, { ok: false, errorCode: "NOT_FOUND", message: `Unknown ${method} endpoint ${url.pathname}` });
  }
}
