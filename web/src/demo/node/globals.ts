import { Buffer } from "./buffer.ts";

/**
 * The globals the daemon's code finds in Node, for the live demo's bundle: scripts/build-web.ts
 * injects this module, so a bare `Buffer`, `process` or `Response` in any bundled module means the one
 * here. Loading it also fills in what an older browser lacks (`AbortSignal.any` before Safari 17.4,
 * `Headers.getSetCookie` before Safari 17).
 */

export { Buffer };

/** The few `process` members the bundled code reads: no environment, one process, `/` as its directory. */
export const process = {
  env: Object.create(null) as Record<string, string | undefined>,
  pid: 1,
  platform: "browser",
  cwd: (): string => "/",
  kill: (): never => {
    throw new Error("process.kill is not available in the demo");
  },
};

/**
 * A `Response` that keeps `Set-Cookie`: a browser drops it from a `Response` a script builds (a guard
 * for service workers), but the demo's mock routers hand the daemon's session client its session
 * cookie that way. Used only between the page's routers, its daemon and the console.
 */
export class Response {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers: Headers;
  readonly redirected = false;
  readonly type = "default";
  readonly url = "";
  /** No stream: readers fall back to `text()` (src/http-body.ts). */
  readonly body = null;
  readonly #text: string;
  #used = false;

  constructor(body?: string | Uint8Array | null, init: { status?: number; statusText?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers);
    this.#text = body === undefined || body === null ? "" : typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  }

  get bodyUsed(): boolean {
    return this.#used;
  }

  #consume(): string {
    if (this.#used) throw new TypeError("Body is unusable: Body has already been read");
    this.#used = true;
    return this.#text;
  }

  async text(): Promise<string> {
    return this.#consume();
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.#consume()) as unknown;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = Buffer.from(this.#consume(), "utf8");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  clone(): Response {
    if (this.#used) throw new TypeError("Response.clone: Body has already been consumed.");
    return new Response(this.#text, { status: this.status, statusText: this.statusText, headers: this.headers });
  }
}

/** One signal that aborts when the first of `signals` does (`AbortSignal.any`). */
export function anySignal(signals: Iterable<AbortSignal>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true, signal: controller.signal });
  }
  return controller.signal;
}

/** Split a joined `Set-Cookie` header (what `get` gives where `getSetCookie` is missing) into cookies. */
export function splitSetCookie(joined: string | null): string[] {
  return joined ? joined.split(/,(?=\s*[^;,=\s]+=)/).map((cookie) => cookie.trim()).filter(Boolean) : [];
}

if (typeof AbortSignal.any !== "function") Object.defineProperty(AbortSignal, "any", { value: anySignal, configurable: true, writable: true });
if (typeof Headers.prototype.getSetCookie !== "function") {
  Object.defineProperty(Headers.prototype, "getSetCookie", {
    value(this: Headers): string[] {
      return splitSetCookie(this.get("set-cookie"));
    },
    configurable: true,
    writable: true,
  });
}
