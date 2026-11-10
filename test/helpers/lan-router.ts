/**
 * A stand-in for a router of a driver family (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt): an
 * injectable `fetchImpl` that hands every request to a handler and records it. Nothing here talks
 * to a real router.
 */

export interface LanRequestRecord {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
  headers: Record<string, string>;
}

export interface LanReply {
  status?: number;
  /** Sent as JSON (`Content-Type: application/json`). */
  json?: unknown;
  /** Sent as is. */
  text?: string;
  setCookie?: string[];
  headers?: Record<string, string>;
}

export type LanHandler = (req: LanRequestRecord) => LanReply | Promise<LanReply>;

export class LanRouterMock {
  readonly requests: LanRequestRecord[] = [];
  handler: LanHandler;

  constructor(handler: LanHandler) {
    this.handler = handler;
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const record: LanRequestRecord = {
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init?.body === "string" ? init.body : "",
      headers,
    };
    this.requests.push(record);
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    // Like fetch: a request whose signal fires before the answer rejects with the signal's reason
    const reply = await new Promise<LanReply>((resolve, reject) => {
      const onAbort = (): void => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      Promise.resolve()
        .then(() => this.handler(record))
        .then(
          (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (err: unknown) => {
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          }
        );
    });
    const out = new Headers(reply.headers);
    for (const cookie of reply.setCookie ?? []) out.append("set-cookie", cookie);
    let body = reply.text ?? "";
    if (reply.json !== undefined) {
      body = JSON.stringify(reply.json);
      out.set("content-type", "application/json");
    }
    return new Response(body, { status: reply.status ?? 200, headers: out });
  };

  /** `METHOD /path` of every request, in order. */
  get trail(): string[] {
    return this.requests.map((r) => `${r.method} ${r.path}`);
  }

  /** The form fields of a request body. */
  static form(req: LanRequestRecord): URLSearchParams {
    return new URLSearchParams(req.body);
  }
}
