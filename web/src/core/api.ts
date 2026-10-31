import type { ApiErrorCode, ApiErrorEnvelope } from "../../../src/api-contract.ts";

/**
 * Same-origin JSON client for the daemon's REST API. Every POST carries the three CSRF conditions of
 * contract §1.3 (custom header, JSON content type, browser-set Origin), and every failure becomes an
 * `ApiError` whose `kind` tells the UI which state to show: a 423 breaker is never "offline".
 */

export type ApiErrorKind =
  | "unauthorized"
  | "rate_limited"
  | "csrf"
  | "validation"
  | "yielded"
  | "peer_standby"
  | "breaker"
  | "unavailable"
  | "upstream"
  | "sms_send_failed"
  | "sms_disabled"
  | "not_found"
  | "network"
  | "timeout"
  | "unknown";

const KIND_BY_CODE: Readonly<Partial<Record<ApiErrorCode, ApiErrorKind>>> = {
  UNAUTHORIZED: "unauthorized",
  RATE_LIMITED: "rate_limited",
  CSRF_REJECTED: "csrf",
  VALIDATION_ERROR: "validation",
  BAD_PAYLOAD: "validation",
  BROWSER_SESSION_YIELDED: "yielded",
  PEER_DAEMON_ACTIVE: "peer_standby",
  CIRCUIT_BREAKER_OPEN: "breaker",
  QUEUE_FULL: "unavailable",
  CPE_UPSTREAM_ERROR: "upstream",
  SMS_SEND_FAILED: "sms_send_failed",
  SMS_DISABLED: "sms_disabled",
  NOT_FOUND: "not_found",
};

/** Map an HTTP status and (optional) envelope code to the UI state it calls for. */
export function classifyApiError(status: number, code: ApiErrorCode | null): ApiErrorKind {
  const byCode = code ? KIND_BY_CODE[code] : undefined;
  if (byCode) return byCode;
  if (status === 0) return "network";
  if (status === 401) return "unauthorized";
  if (status === 423) return "breaker";
  if (status === 429) return "rate_limited";
  if (status === 503) return "unavailable";
  if (status === 502 || status === 504) return "upstream";
  if (status === 404) return "not_found";
  return "unknown";
}

export function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (value === null || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return rec["ok"] === false && typeof rec["errorCode"] === "string" && typeof rec["message"] === "string";
}

export class ApiError extends Error {
  /** HTTP status, or `0` when no response arrived (network failure or timeout). */
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly envelope: ApiErrorEnvelope | null;

  constructor(status: number, envelope: ApiErrorEnvelope | null, kind?: ApiErrorKind, message?: string) {
    super(message ?? envelope?.message ?? `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.envelope = envelope;
    this.kind = kind ?? classifyApiError(status, envelope?.errorCode ?? null);
  }
}

export interface ApiClientOptions {
  fetchImpl: typeof fetch;
  /** Called once per 401 so the shell can return to the login screen. */
  onUnauthorized?: () => void;
  /** Default per-request budget; control writes pass a longer one (an SMS send polls up to 45 s). */
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export class ApiClient {
  readonly #fetch: typeof fetch;
  readonly #onUnauthorized: (() => void) | undefined;
  readonly #defaultTimeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.#fetch = options.fetchImpl;
    this.#onUnauthorized = options.onUnauthorized;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  }

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>(path, { method: "GET", credentials: "same-origin" }, options);
  }

  post<T>(path: string, body: object = {}, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>(
      path,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body),
      },
      options
    );
  }

  async #request<T>(path: string, init: RequestInit, options: RequestOptions): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.#fetch(path, { ...init, signal: controller.signal });
    } catch {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      throw new ApiError(0, null, timedOut ? "timeout" : "network", timedOut ? `Timed out after ${timeoutMs} ms` : "Network error");
    }
    let payload: unknown = null;
    let parsed = false;
    try {
      payload = await res.json();
      parsed = true;
    } catch {
      payload = null;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      if (parsed) return payload as T;
      // Every daemon route answers JSON: a 2xx whose body stalled past the timeout or arrived cut off
      // must not resolve as `null` into code that expects the typed response
      const timedOut = controller.signal.aborted;
      throw new ApiError(res.status, null, timedOut ? "timeout" : "network", timedOut ? `Timed out after ${timeoutMs} ms` : "Incomplete response body");
    }
    const envelope = isApiErrorEnvelope(payload) ? payload : null;
    const error = new ApiError(res.status, envelope);
    if (error.kind === "unauthorized") this.#onUnauthorized?.();
    throw error;
  }
}
