import type { LanHttp } from "../drivers/transport.ts";
import { fieldOf, intOf, isPlainObject } from "../drivers/values.ts";
import { CpeAnswerFormatError, CpeApiError } from "../session-errors.ts";

/**
 * ubus over HTTP, OpenWrt's JSON-RPC (`{"method":"call","params":[session, object, method, args]}`,
 * answered `{"result":[status, payload]}`): the part every router built on it shares, OpenWrt itself
 * and ZTE's zWRT among them. A brand gives where it listens and what its own page adds to each
 * request; what a call means is the brand's.
 *
 * A refusal is a `CpeApiError`: `rpc<code>` for a JSON-RPC error (`rpc-32601`: no such method),
 * `ubus-<status>` for a ubus status (`ubus-6`: permission denied). The router's own text never goes
 * into the message.
 */

/** The session a login is asked in, before there is one. */
export const UBUS_ANONYMOUS_SESSION = "00000000000000000000000000000000";

export interface UbusOptions {
  /** Where the router listens (`/ubus` on OpenWrt, `/ubus/` on zWRT). */
  path: string;
  /** What the brand's own page adds to each request: a cache-busting time stamp, a referer. */
  stamp?: boolean;
  referer?: string;
  /** What a non-zero status becomes instead of `ubus-<status>` (`null`: the default). */
  statusError?: (status: number, object: string, method: string) => Error | null;
}

export class UbusRpc {
  readonly http: LanHttp;
  readonly #options: UbusOptions;
  #id = 1;
  session = UBUS_ANONYMOUS_SESSION;

  constructor(http: LanHttp, options: UbusOptions) {
    this.http = http;
    this.#options = options;
  }

  #request(timeoutMs: number | undefined): { query?: Array<[string, string]>; referer?: string; timeoutMs?: number } {
    return {
      ...(this.#options.stamp ? { query: [["t", String(Date.now())]] as Array<[string, string]> } : {}),
      ...(this.#options.referer !== undefined ? { referer: this.#options.referer } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  #payload(object: string, method: string, result: unknown): unknown {
    if (!Array.isArray(result) || typeof result[0] !== "number") throw new CpeAnswerFormatError(`${object}.${method}: no result`);
    const status = result[0];
    if (status !== 0) throw this.#options.statusError?.(status, object, method) ?? new CpeApiError(`ubus-${status}`, `${object}.${method} refused`);
    return result[1];
  }

  /** One call; resolves its payload (`undefined` for a bare `[0]`). `timeoutMs`: how long this one request may take. */
  async call(object: string, method: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const id = this.#id++;
    const answer = await this.http.postJson(this.#options.path, { jsonrpc: "2.0", id, method: "call", params: [this.session, object, method, args] }, this.#request(timeoutMs));
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError(`${object}.${method}: not an object`);
    const error = fieldOf(answer, "error");
    if (isPlainObject(error)) throw new CpeApiError(`rpc${intOf(fieldOf(error, "code")) ?? ""}`, `${object}.${method} refused`);
    return this.#payload(object, method, fieldOf(answer, "result"));
  }

  /**
   * Several calls in one request (a JSON-RPC batch), as some pages send the halves of one change
   * together. Resolves the payloads in order; any refusal fails the whole batch.
   */
  async batch(calls: ReadonlyArray<readonly [object: string, method: string, args: Record<string, unknown>]>): Promise<unknown[]> {
    const requests = calls.map(([object, method, args]) => ({ jsonrpc: "2.0", id: this.#id++, method: "call", params: [this.session, object, method, args] }));
    const answer = await this.http.postJson(this.#options.path, requests, this.#request(undefined));
    if (!Array.isArray(answer) || answer.length !== requests.length) throw new CpeAnswerFormatError("ubus batch: not one answer per call");
    return requests.map((request, i) => {
      const [object, method] = calls[i] ?? ["", ""];
      const one = answer.find((item) => isPlainObject(item) && item["id"] === request.id) ?? answer[i];
      const result = isPlainObject(one) ? fieldOf(one, "result") : undefined;
      if (!Array.isArray(result) || typeof result[0] !== "number") throw new CpeApiError("rpc", `${object}.${method} refused`);
      return this.#payload(object, method, result);
    });
  }
}
