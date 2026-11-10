import { CpeAnswerFormatError, CpeTransportError } from "../cpe-client.ts";
import { readBoundedResponseText } from "../http-body.ts";
import { parseJsonSafeNullProto } from "../json-safe.ts";

/**
 * HTTP to the router for the driver families, inside one session: the base address was checked by
 * `normalizeCpeUrl` (LAN hosts only), every request stays on that origin, redirects are refused
 * unless a login asks to read one (`redirect: "manual"`), answers are capped at 1 MiB, and each
 * request ends with the session's deadline or its own timeout, whichever comes first. Cookies the
 * router sets live only as long as the session.
 */

export const MAX_ANSWER_BYTES = 1024 * 1024;

const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const COOKIE_VALUE = /^[A-Za-z0-9!#$%&'()*+./:<=>?@[\]^_`{|}~-]{0,512}$/;
const MAX_COOKIES = 16;

/** A stale keep-alive socket: the request never reached the router, so a GET may go again. */
const STALE_SOCKET_CODES: ReadonlySet<string> = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);

export interface LanHttpOptions {
  /** The router's base address (`normalizeCpeUrl`). */
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** The session's deadline and cancellation. */
  signal: AbortSignal;
}

export interface LanRequest {
  method: "GET" | "POST";
  /** Path on the router, starting with `/`; `query` adds parameters. */
  path: string;
  query?: ReadonlyArray<readonly [string, string]>;
  body?: string;
  contentType?: string;
  /** A path on the router sent as `Referer` (several families check it). */
  referer?: string;
  headers?: Readonly<Record<string, string>>;
  /** Read a redirect instead of failing on it (only for a login that answers with one). */
  redirect?: "error" | "manual";
  timeoutMs?: number;
}

export interface LanResponse {
  status: number;
  text: string;
  /** `Location` of a redirect read with `redirect: "manual"`. */
  location: string | null;
}

export class LanHttp {
  readonly baseUrl: string;
  readonly #origin: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  #signal: AbortSignal;
  readonly #cookies = new Map<string, string>();

  constructor(options: LanHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#origin = new URL(this.baseUrl).origin;
    this.#fetchImpl = options.fetchImpl;
    this.#timeoutMs = options.timeoutMs;
    this.#signal = options.signal;
  }

  get origin(): string {
    return this.#origin;
  }

  /** The value of a cookie the router set in this session (`undefined` when none). */
  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  get hasCookies(): boolean {
    return this.#cookies.size > 0;
  }

  clearCookies(): void {
    this.#cookies.clear();
  }

  /** Requests from now on end with `signal` (the `finally` logout, after the session's own deadline). */
  retarget(signal: AbortSignal): void {
    this.#signal = signal;
  }

  /** `http://<router>` + `path`, refused when it would leave the router's origin. */
  url(path: string, query: ReadonlyArray<readonly [string, string]> = []): string {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\@#\s]/.test(path)) throw new Error(`Refusing router path "${path.slice(0, 64)}"`);
    const url = new URL(`${this.baseUrl}${path}`);
    if (url.origin !== this.#origin) throw new Error("Refusing a request outside the router's address");
    for (const [key, value] of query) url.searchParams.append(key, value);
    return url.toString();
  }

  async request(req: LanRequest): Promise<LanResponse> {
    const url = this.url(req.path, req.query);
    const headers: Record<string, string> = { Accept: "application/json, text/javascript, text/html, application/xml, */*; q=0.01", ...req.headers };
    if (req.referer !== undefined) headers["Referer"] = this.url(req.referer);
    if (req.contentType !== undefined) headers["Content-Type"] = req.contentType;
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers["Cookie"] = cookie;
    const label = `${req.method} ${req.path.split("?")[0] ?? req.path}`;
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(req.timeoutMs ?? this.#timeoutMs)]);
      let res: Response;
      try {
        res = await this.#fetchImpl(url, { method: req.method, headers, body: req.body, redirect: req.redirect ?? "error", signal });
      } catch (err) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : err;
        const failure = new CpeTransportError(req.method, req.path, err);
        if (req.method === "GET" && failure.causeCode !== null && STALE_SOCKET_CODES.has(failure.causeCode) && attempt < 2) continue;
        throw failure;
      }
      this.#keepCookies(res.headers);
      let text: string;
      try {
        text = await readBoundedResponseText(res, MAX_ANSWER_BYTES);
      } catch (err) {
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : err;
        throw new CpeAnswerFormatError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      return { status: res.status, text, location };
    }
  }

  /** A GET whose answer must be JSON (2xx). */
  async getJson(path: string, opts: Omit<LanRequest, "method" | "path" | "body"> = {}): Promise<unknown> {
    return jsonAnswer(await this.request({ ...opts, method: "GET", path }), `GET ${path.split("?")[0] ?? path}`);
  }

  /** A POST of a JSON body whose answer must be JSON (2xx). */
  async postJson(path: string, body: unknown, opts: Omit<LanRequest, "method" | "path" | "body" | "contentType"> = {}): Promise<unknown> {
    const res = await this.request({ ...opts, method: "POST", path, body: JSON.stringify(body), contentType: "application/json; charset=UTF-8" });
    return jsonAnswer(res, `POST ${path.split("?")[0] ?? path}`);
  }

  /** A POST of form fields (`application/x-www-form-urlencoded`) whose answer must be JSON (2xx). */
  async postForm(path: string, fields: ReadonlyArray<readonly [string, string]>, opts: Omit<LanRequest, "method" | "path" | "body" | "contentType"> = {}): Promise<unknown> {
    const body = new URLSearchParams(fields.map(([k, v]) => [k, v])).toString();
    const res = await this.request({ ...opts, method: "POST", path, body, contentType: "application/x-www-form-urlencoded; charset=UTF-8" });
    return jsonAnswer(res, `POST ${path.split("?")[0] ?? path}`);
  }

  #keepCookies(headers: Headers): void {
    const lines = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const line of lines.slice(0, MAX_COOKIES)) {
      const pair = (line.split(";")[0] ?? "").trim();
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
      if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
      const expired = /;\s*max-age=0\b/i.test(line) || value === "" || value === "deleted";
      if (expired) this.#cookies.delete(name);
      else if (this.#cookies.has(name) || this.#cookies.size < MAX_COOKIES) this.#cookies.set(name, value);
    }
  }
}

/** The JSON of a 2xx answer (null-prototype objects); anything else is an answer FengSui cannot read. */
export function jsonAnswer(res: LanResponse, label: string): unknown {
  if (res.status < 200 || res.status >= 300) throw new CpeAnswerFormatError(`${label}: HTTP ${res.status}`);
  return parseJsonText(res.text, label);
}

export function parseJsonText(text: string, label: string): unknown {
  try {
    return parseJsonSafeNullProto(text);
  } catch {
    throw new CpeAnswerFormatError(`${label}: the answer is not JSON`);
  }
}
