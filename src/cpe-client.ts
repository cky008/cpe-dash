import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { normalizeCpeUrl } from "./config.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  computeScram,
  generateEccSession,
  verifyPubkeySignature,
} from "./crypto.ts";
import { readBoundedResponseText } from "./http-body.ts";
import { t } from "./i18n.ts";
import type {
  CircuitBreakerState,
  CpeLoginState,
  EncryptionType,
  SessionExecutionOutcome,
  SessionTelemetry,
} from "./types.ts";
import { MAX_XML_BYTES, buildXmlRequest, getXmlTag, parseXmlError } from "./xml.ts";

const activeSessionContext = new AsyncLocalStorage<HuaweiCpeClient>();

function readCpeResponseText(res: Response): Promise<string> {
  return readBoundedResponseText(res, MAX_XML_BYTES);
}

export const CPE_ERROR_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "100002": "系统不支持该接口 (No support)",
  "100003": "权限不足或未登录 (Unauthorized)",
  "100004": "系统繁忙 (System busy)",
  "100005": "数据格式错误 (Format error)",
  "100006": "参数错误 (Parameter error)",
  "108001": "用户名错误 (Wrong username)",
  "108002": "密码错误 (Wrong password)",
  "108003": "已有其他管理员登录管理后台 (Already logged in)",
  "108005": "重复登录冲突 (Duplicate login)",
  "108006": "登录密码错误，防爆破断路器已触发 (Authentication failed)",
  "108007": "密码错误次数过多，账户已暂时锁定 (Login locked)",
  "108009": "已有其他终端占用管理会话 (Session occupied)",
  "108010": "登录过于频繁，请稍后重试 (Too frequent login)",
  "120001": "语音通话占线中 (Voice busy)",
  "125001": "CSRF Token 校验失败 (Wrong token)",
  "125002": "会话已过期 (Session expired)",
  "125003": "会话 Token 无效 (Invalid session token)",
};

export class ReentrantCpeSessionError extends Error {
  constructor() {
    super("Nested withSession() call detected inside an active CPE session; reuse the open session instead");
    this.name = "ReentrantCpeSessionError";
  }
}

/**
 * The session exceeded its hold budget (`sessionMaxHoldMs`): every request of that session was
 * aborted, the `finally` logout ran on a fresh signal and the mutex moved on to the next task.
 */
export class CpeSessionDeadlineError extends Error {
  readonly maxHoldMs: number;

  constructor(maxHoldMs: number) {
    super(`CPE session exceeded its ${maxHoldMs} ms hold budget and was logged out`);
    this.name = "CpeSessionDeadlineError";
    this.maxHoldMs = maxHoldMs;
  }
}

/** A request on a session whose `logout()` already started: work that outlived its session. */
export class CpeSessionClosedError extends Error {
  constructor() {
    super("CPE session is already logged out; the request was not sent");
    this.name = "CpeSessionClosedError";
  }
}

/**
 * A request that never got an answer from the CPE (connection reset or refused, DNS, socket closed
 * mid-response). The message names the endpoint and the socket-level cause, which `fetch` hides
 * behind a bare "fetch failed".
 */
export class CpeTransportError extends Error {
  readonly method: string;
  readonly apiPath: string;
  /** Socket-level cause, e.g. `ECONNRESET` or `UND_ERR_SOCKET`; `null` when unknown. */
  readonly causeCode: string | null;

  constructor(method: string, apiPath: string, err: unknown) {
    const cause = err instanceof Error && err.cause && typeof err.cause === "object" ? err.cause : null;
    const code = cause && "code" in cause && typeof cause.code === "string" ? cause.code : null;
    const detail = cause && "message" in cause && typeof cause.message === "string" ? cause.message : null;
    const base = err instanceof Error ? err.message : String(err);
    super(`${method} ${apiPath.split("?")[0]}: ${base}${code || detail ? ` (${[code, detail].filter(Boolean).join(": ")})` : ""}`);
    this.name = "CpeTransportError";
    this.method = method;
    this.apiPath = apiPath.split("?")[0] ?? apiPath;
    this.causeCode = code;
  }
}

/**
 * The H168-383 web server closes keep-alive connections that `fetch` then tries to reuse
 * (`UND_ERR_SOCKET: other side closed`, roughly one telemetry session in four on the real device).
 * Such a request never reached the router's handler, so an idempotent GET is safe to resend.
 */
const STALE_SOCKET_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CLOSED", "ECONNRESET", "EPIPE"]);
const MAX_GET_RETRIES_ON_STALE_SOCKET = 2;

/**
 * `fetch` with transport failures mapped to `CpeTransportError`; aborts and deadlines pass through.
 * GETs are resent (at most twice) when the failure was a stale keep-alive socket; POSTs never are.
 */
async function cpeFetch(fetchImpl: typeof fetch, url: string, apiPath: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? "GET";
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (init.signal?.aborted) throw err;
      const failure = new CpeTransportError(method, apiPath, err);
      const retryable = method === "GET" && failure.causeCode !== null && STALE_SOCKET_CODES.has(failure.causeCode);
      if (!retryable || attempt >= MAX_GET_RETRIES_ON_STALE_SOCKET) throw failure;
    }
  }
}

/** Default upper bound for one admin session (covers SMS send-status polling plus read-back). */
export const DEFAULT_SESSION_MAX_HOLD_MS = 90_000;

export function isInsideCpeSession(client: HuaweiCpeClient): boolean {
  return activeSessionContext.getStore() === client;
}

export class CpeApiError extends Error {
  readonly code: string;
  readonly remainCount: number | null;
  readonly waitTime: number | null;

  constructor(
    code: string,
    detail = "",
    meta: { remainCount?: number | null; waitTime?: number | null } = {}
  ) {
    const desc = CPE_ERROR_DESCRIPTIONS[code] ?? "CPE 接口错误";
    const suffix = detail ? `: ${detail}` : "";
    super(`[CPE ${code}] ${desc}${suffix}`);
    this.name = "CpeApiError";
    this.code = code;
    this.remainCount = meta.remainCount ?? null;
    this.waitTime = meta.waitTime ?? null;
  }

  get isAuthWrongPassword(): boolean {
    return this.code === "108006" || this.code === "108002" || this.code === "108001";
  }

  get isLocked(): boolean {
    return this.code === "108007";
  }

  get isCircuitBreakerFatal(): boolean {
    return this.isAuthWrongPassword || this.isLocked;
  }

  get isSessionOccupied(): boolean {
    return this.code === "108003" || this.code === "108005" || this.code === "108009";
  }
}

export class EphemeralCpeSession {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  cookies: Map<string, string>;
  tokens: string[];
  ecc: { clientPubHex: string; shareKeyHex: string } | null;
  loggedIn: boolean;
  #loginCompletedAtMs: number | null;
  #authOutcomeUnknown: boolean;
  #postChain: Promise<unknown>;
  /** Session-wide deadline; `logout()` uses fresh signals so the slot can always be released. */
  readonly #deadline: AbortSignal | null;
  #releasing = false;

  constructor(opts: {
    baseUrl: string;
    username: string;
    password: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    deadline?: AbortSignal;
  }) {
    this.baseUrl = opts.baseUrl;
    this.username = opts.username;
    this.password = opts.password;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;
    this.cookies = new Map();
    this.tokens = [];
    this.ecc = null;
    this.loggedIn = false;
    this.#loginCompletedAtMs = null;
    this.#authOutcomeUnknown = false;
    this.#postChain = Promise.resolve();
    this.#deadline = opts.deadline ?? null;
  }

  /**
   * Signal for one request. Logout's own requests (`releasing`) only time out; any other request
   * fails locally once the deadline passed or logout began, so work that outlived its session never
   * reaches the router again.
   */
  #requestSignal(timeoutMs: number, releasing: boolean): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    if (releasing) return timeout;
    if (this.#deadline?.aborted) throw this.#deadline.reason;
    if (this.#releasing) throw new CpeSessionClosedError();
    return this.#deadline ? AbortSignal.any([this.#deadline, timeout]) : timeout;
  }

  #updateCookies(headers: Headers): void {
    const setCookieVal = headers.get("set-cookie");
    const rawList: Array<string | null> =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : setCookieVal
          ? [setCookieVal]
          : [];
    for (const raw of rawList) {
      if (!raw) continue;
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  #cookieHeader(): string {
    if (this.cookies.size === 0) return "";
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  #captureTokens(headers: Headers, clearFirst = false): void {
    if (clearFirst) {
      this.tokens = [];
    }
    const t1 = headers.get("__requestverificationtokenone");
    const t2 = headers.get("__requestverificationtokentwo");
    const t0 = headers.get("__requestverificationtoken");
    if (t1) {
      this.tokens.push(t1.trim());
      if (t2) this.tokens.push(t2.trim());
    } else if (t0) {
      this.tokens.push(t0.trim());
    }
  }

  async #ensureEcc(): Promise<{ clientPubHex: string; shareKeyHex: string }> {
    if (!this.ecc) {
      const pubXml = await this.get("/api/webserver/publickey");
      const serverPub = getXmlTag(pubXml, "ecc_server_pubkey");
      if (!serverPub) {
        throw new Error("CPE did not return ecc_server_pubkey");
      }
      this.ecc = generateEccSession(serverPub);
    }
    return this.ecc;
  }

  async get(
    apiPath: string,
    extraHeaders: Record<string, string> = {},
    overrideTimeoutMs?: number
  ): Promise<string> {
    return await this.#get(apiPath, extraHeaders, overrideTimeoutMs ?? this.timeoutMs, false);
  }

  async #get(apiPath: string, extraHeaders: Record<string, string>, timeoutMs: number, releasing: boolean): Promise<string> {
    const signal = this.#requestSignal(timeoutMs, releasing);
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest",
      _ResponseSource: "Broswer",
      Accept: "*/*",
      ...extraHeaders,
    };
    const cookie = this.#cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const res = await cpeFetch(this.fetchImpl, `${this.baseUrl}${apiPath}`, apiPath, {
      method: "GET",
      headers,
      redirect: "error",
      signal,
    });
    this.#updateCookies(res.headers);
    const text = await readCpeResponseText(res);
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  /**
   * Perform an authenticated GET that automatically decrypts AES-256-GCM hex payloads if returned.
   */
  async getDecryptedIfNeeded(apiPath: string): Promise<string> {
    const trimmedCheck = await this.get(apiPath);
    const clean = trimmedCheck.trim();
    if (clean.startsWith("<") || clean.length < 64 || !/^[0-9a-fA-F]+$/.test(clean)) {
      return trimmedCheck;
    }
    if (this.ecc) {
      return aesGcmDecrypt(clean, this.ecc.shareKeyHex);
    }
    return trimmedCheck;
  }

  async #consumeToken(timeoutMs: number, releasing: boolean): Promise<string> {
    if (this.tokens.length === 0) {
      const xml = await this.#get("/api/webserver/token", {}, timeoutMs, releasing);
      const fullToken = getXmlTag(xml, "token");
      if (!fullToken || fullToken.length < 32) {
        throw new Error("Failed to acquire CSRF token from /api/webserver/token");
      }
      this.tokens.push(fullToken.length > 32 ? fullToken.slice(-32) : fullToken);
    }
    return this.tokens.shift()!;
  }

  async postRaw(
    apiPath: string,
    body: string,
    opts: {
      clearTokensOnResponse?: boolean;
      contentType?: string;
      overrideTimeoutMs?: number;
    } = {}
  ): Promise<string> {
    return await this.#post(apiPath, body, opts, false);
  }

  async #post(
    apiPath: string,
    body: string,
    opts: { clearTokensOnResponse?: boolean; contentType?: string; overrideTimeoutMs?: number },
    releasing: boolean
  ): Promise<string> {
    const timeoutMs = opts.overrideTimeoutMs ?? this.timeoutMs;
    const run = async (): Promise<string> => {
      const token = await this.#consumeToken(timeoutMs, releasing);
      const signal = this.#requestSignal(timeoutMs, releasing);
      const headers: Record<string, string> = {
        "X-Requested-With": "XMLHttpRequest",
        _ResponseSource: "Broswer",
        "Content-Type": opts.contentType ?? "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "*/*",
        __RequestVerificationToken: token,
      };
      const cookie = this.#cookieHeader();
      if (cookie) headers.Cookie = cookie;

      const res = await cpeFetch(this.fetchImpl, `${this.baseUrl}${apiPath}`, apiPath, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal,
      });
      this.#updateCookies(res.headers);
      this.#captureTokens(res.headers, Boolean(opts.clearTokensOnResponse));
      const text = await readCpeResponseText(res);
      const err = parseXmlError(text);
      if (err) {
        throw new CpeApiError(err.code, apiPath, err);
      }
      return text;
    };
    const next = this.#postChain.then(run, run);
    this.#postChain = next.then(
      () => undefined,
      () => undefined
    );
    return await next;
  }

  async postXml(apiPath: string, requestObj: Record<string, unknown>): Promise<string> {
    return await this.postRaw(apiPath, buildXmlRequest(requestObj));
  }

  /**
   * Perform an authenticated JSON POST (e.g. `POST /api/wlan/wlandbho`) with CSRF token rotation.
   */
  async postJson(apiPath: string, payloadObj: Record<string, unknown>): Promise<string> {
    return await this.postRaw(apiPath, JSON.stringify(payloadObj), {
      contentType: "application/json; charset=UTF-8",
    });
  }

  async postEncrypted(
    apiPath: string,
    requestObj: Record<string, unknown>,
    encType: EncryptionType
  ): Promise<string> {
    const ecc = await this.#ensureEcc();
    const plainXml = buildXmlRequest(requestObj);
    const body = encType === 1 ? plainXml : aesGcmEncrypt(plainXml, ecc.shareKeyHex);
    const sep = apiPath.includes("?") ? "&" : "?";
    const urlWithQuery = `${apiPath}${sep}ecc-client-pubkey=${ecc.clientPubHex}&enc-type=${encType}`;

    const rawResponse = await this.postRaw(urlWithQuery, body);
    if (encType === 2) {
      return rawResponse;
    }

    const decryptedXml = aesGcmDecrypt(rawResponse, ecc.shareKeyHex);
    const err = parseXmlError(decryptedXml);
    if (err) {
      throw new CpeApiError(err.code, `${apiPath} (decrypted)`, err);
    }
    return decryptedXml;
  }

  async login(): Promise<void> {
    if (!this.password) {
      throw new Error("CPE_PASSWORD 未配置，请在 .env 中设置 CPE 管理密码");
    }

    await this.get("/api/monitoring/status", { "Update-Cookie": "UpdateCookie" });

    const firstNonce = crypto.randomBytes(32).toString("hex");
    const challengeXml = await this.postRaw(
      "/api/user/challenge_login",
      buildXmlRequest({
        username: this.username,
        firstnonce: firstNonce,
        mode: 1,
      }),
      { clearTokensOnResponse: true }
    );

    const salt = getXmlTag(challengeXml, "salt");
    const iterationsRaw = getXmlTag(challengeXml, "iterations");
    const serverNonce = getXmlTag(challengeXml, "servernonce");
    if (!salt || !iterationsRaw || !serverNonce) {
      throw new Error("Invalid SCRAM challenge response from CPE");
    }

    const iterations = Number.parseInt(iterationsRaw, 10);
    const scram = computeScram(this.password, salt, iterations, firstNonce, serverNonce);

    // Until the router answers, it may already have logged us in (lost response, aborted request),
    // so `logout()` must run; a CPE error code means the router refused and nothing is open.
    this.#authOutcomeUnknown = true;
    let authXml: string;
    try {
      authXml = await this.postRaw(
        "/api/user/authentication_login",
        buildXmlRequest({
          clientproof: scram.clientProofHex,
          finalnonce: serverNonce,
        }),
        { clearTokensOnResponse: true }
      );
    } catch (err) {
      if (err instanceof CpeApiError) {
        this.#authOutcomeUnknown = false;
      }
      throw err;
    }

    this.#authOutcomeUnknown = false;
    this.loggedIn = true;
    this.#loginCompletedAtMs = performance.now();

    const serverSig = getXmlTag(authXml, "serversignature");
    if (serverSig && serverSig.toLowerCase() !== scram.expectedServerSig.toLowerCase()) {
      throw new Error("SCRAM server signature mismatch (potential MITM)");
    }

    const eccServerPub = getXmlTag(authXml, "ecc_server_pubkey");
    const eccPubSig = getXmlTag(authXml, "ecc_pubkey_signature");
    if (eccServerPub) {
      if (eccPubSig && !verifyPubkeySignature(eccServerPub, scram.serverKey, eccPubSig)) {
        throw new Error("CPE ECC public key signature verification failed");
      }
      this.ecc = generateEccSession(eccServerPub);
    }
  }

  async logout(): Promise<number | null> {
    // From here on only logout's own requests may use this session
    this.#releasing = true;
    if (!this.loggedIn && !this.#authOutcomeUnknown) return null;
    const boundedLogoutMs = Math.min(this.timeoutMs, 3000);
    try {
      await this.#post("/api/user/logout", buildXmlRequest({ Logout: 1 }), { overrideTimeoutMs: boundedLogoutMs }, true);
    } catch {
      // Ignore logout network/session errors if session already expired or router is rebooting
    } finally {
      this.loggedIn = false;
      this.#authOutcomeUnknown = false;
    }
    if (this.#loginCompletedAtMs === null) return null;
    const elapsed = Math.max(0, Math.round(performance.now() - this.#loginCompletedAtMs));
    this.#loginCompletedAtMs = null;
    return elapsed;
  }
}

export interface HuaweiCpeClientOptions {
  cpeUrl: string;
  cpeUsername?: string;
  cpePassword: string;
  requestTimeoutMs?: number;
  respectBrowserSession?: boolean;
  allowPublicCpeHost?: boolean;
  fetchImpl?: typeof fetch;
  /** Hard upper bound for one session, login to logout (default `DEFAULT_SESSION_MAX_HOLD_MS`). */
  sessionMaxHoldMs?: number;
}

export interface WithSessionOptions {
  respectBrowserSession?: boolean;
  retriesOnOccupied?: number;
  occupiedRetryDelayMs?: number;
}

/** Resolve after `ms`, or reject with `signal.reason` as soon as it aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reject when `signal` aborts, even if `work` never settles (non-I/O hangs cannot pin the mutex). */
function raceDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

function hashCredentialsFingerprint(username: string, password: string): string {
  return crypto
    .createHash("sha256")
    .update(`fengsui-cpe-cred:${username}:${password}`, "utf8")
    .digest("hex");
}

/**
 * Huawei 5G CPE Ultra 6 (H168-383) client enforcing:
 *   1. Single-admin ephemeral sessions (`finally` logout ~200ms, non-reentrant mutex).
 *   2. Dual-layer active browser avoidance (`/api/user/state-login` + cross-IP `108003`).
 *   3. Latched & restart-persistent `108006` / `108007` anti-brute-force circuit breaker.
 */
export class HuaweiCpeClient {
  readonly baseUrl: string;
  #username: string;
  #password: string;
  readonly timeoutMs: number;
  readonly defaultRespectBrowserSession: boolean;
  readonly fetchImpl: typeof fetch;
  readonly sessionMaxHoldMs: number;

  #mutex: Promise<unknown>;
  /** Cancels the session run that holds the mutex right now (`abortActiveSession`). */
  #activeCancel: AbortController | null = null;
  #trippedError: CpeApiError | null;
  #trippedAtIso: string | null;
  #trippedPwdFingerprint: string | null;
  #lastSessionHoldMs: number | null;
  #totalSessionsCompleted: number;
  #browserYieldCount: number;

  constructor(config: HuaweiCpeClientOptions) {
    this.baseUrl = normalizeCpeUrl(config.cpeUrl, {
      allowPublicHost: Boolean(config.allowPublicCpeHost),
    });
    this.#username = config.cpeUsername ?? "admin";
    this.#password = config.cpePassword;
    this.timeoutMs = config.requestTimeoutMs ?? 15000;
    this.defaultRespectBrowserSession = config.respectBrowserSession ?? true;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.sessionMaxHoldMs = Math.max(50, config.sessionMaxHoldMs ?? DEFAULT_SESSION_MAX_HOLD_MS);

    this.#mutex = Promise.resolve();
    this.#trippedError = null;
    this.#trippedAtIso = null;
    this.#trippedPwdFingerprint = null;
    this.#lastSessionHoldMs = null;
    this.#totalSessionsCompleted = 0;
    this.#browserYieldCount = 0;
  }

  get username(): string {
    return this.#username;
  }

  get password(): string {
    return this.#password;
  }

  getPasswordFingerprint(): string {
    return hashCredentialsFingerprint(this.#username, this.#password);
  }

  getCircuitBreakerState(): CircuitBreakerState {
    if (!this.#trippedError) {
      return {
        tripped: false,
        code: null,
        reason: null,
        trippedAtIso: null,
        remainCount: null,
        waitTime: null,
        passwordFingerprintHex: null,
      };
    }
    return {
      tripped: true,
      code: this.#trippedError.code,
      reason: this.#trippedError.message,
      trippedAtIso: this.#trippedAtIso,
      remainCount: this.#trippedError.remainCount,
      waitTime: this.#trippedError.waitTime,
      passwordFingerprintHex: this.#trippedPwdFingerprint,
    };
  }

  /**
   * Restore a persisted circuit-breaker latch at startup: stays tripped ONLY if the configured
   * password fingerprint still matches the bad password that originally tripped it.
   */
  hydrateCircuitBreaker(saved: CircuitBreakerState | null | undefined): boolean {
    if (!saved?.tripped || !saved.code) return false;
    const currentFp = this.getPasswordFingerprint();
    if (saved.passwordFingerprintHex && saved.passwordFingerprintHex !== currentFp) {
      return false;
    }
    this.#trippedError = new CpeApiError(saved.code, "persisted latch", {
      remainCount: saved.remainCount ?? null,
      waitTime: saved.waitTime ?? null,
    });
    this.#trippedAtIso = saved.trippedAtIso ?? new Date().toISOString();
    this.#trippedPwdFingerprint = saved.passwordFingerprintHex ?? currentFp;
    return true;
  }

  /**
   * Hot-reload updated credentials from `.env` and clear the circuit breaker if the password changed.
   */
  reloadCredentials(newPassword: string, newUsername?: string): boolean {
    const nextUser = newUsername ?? this.#username;
    const prevFp = this.getPasswordFingerprint();
    const nextFp = hashCredentialsFingerprint(nextUser, newPassword);
    this.#username = nextUser;
    this.#password = newPassword;
    if (prevFp !== nextFp) {
      this.resetCircuitBreaker();
      return true;
    }
    return false;
  }

  getTelemetry(): SessionTelemetry {
    return {
      lastSessionHoldMs: this.#lastSessionHoldMs,
      totalSessionsCompleted: this.#totalSessionsCompleted,
      browserYieldCount: this.#browserYieldCount,
      circuitBreaker: this.getCircuitBreakerState(),
    };
  }

  resetCircuitBreaker(): void {
    this.#trippedError = null;
    this.#trippedAtIso = null;
    this.#trippedPwdFingerprint = null;
  }

  #tripCircuitBreaker(err: CpeApiError, credentialFp = this.getPasswordFingerprint()): never {
    // If credentials were hot-reloaded mid-session, do not latch the breaker under the new password!
    if (credentialFp !== this.getPasswordFingerprint()) {
      throw err;
    }
    if (!this.#trippedError) {
      this.#trippedError = err;
      this.#trippedAtIso = new Date().toISOString();
      this.#trippedPwdFingerprint = credentialFp;
    }
    throw this.#trippedError;
  }

  /**
   * Wait for any currently running ephemeral session + `finally` logout to finish (e.g., on SIGTERM).
   * Resolves `true` once idle, `false` if the session was still running after `maxWaitMs`.
   */
  async waitForIdle(maxWaitMs = 4000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.#mutex.then(
          () => true,
          () => true
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), maxWaitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Cancel the session that is running now (e.g. on shutdown) with `reason`: its pending requests
   * abort, a login or retry still to come never starts, and its `finally` logout still runs on a
   * fresh bounded signal. Returns `false` when no session is running.
   */
  abortActiveSession(reason: Error): boolean {
    const active = this.#activeCancel;
    if (!active || active.signal.aborted) return false;
    active.abort(reason);
    return true;
  }

  async getPublic(apiPath: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await cpeFetch(this.fetchImpl, `${this.baseUrl}${apiPath}`, apiPath, {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        _ResponseSource: "Broswer",
        Accept: "*/*",
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await readCpeResponseText(res);
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  async getLoginState(signal?: AbortSignal): Promise<CpeLoginState> {
    const xml = await this.getPublic("/api/user/state-login", signal);
    const state = getXmlTag(xml, "State") ?? "-1";
    const isLocked = (getXmlTag(xml, "lockstatus") ?? "0") === "1";
    const remainWaitTime = Number.parseInt(getXmlTag(xml, "remainwaittime") ?? "0", 10) || 0;
    return {
      state,
      // H168-383 returns State === "-1" when logged out / idle, and State === "0" when an admin session is active
      isLoggedInElsewhere: state !== "-1",
      isLocked,
      remainWaitTime,
      passwordType: getXmlTag(xml, "password_type") ?? "4",
      firstLogin: getXmlTag(xml, "firstlogin") ?? "0",
    };
  }

  async withSessionDetailed<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    options: WithSessionOptions = {}
  ): Promise<SessionExecutionOutcome<T>> {
    if (activeSessionContext.getStore() === this) {
      throw new ReentrantCpeSessionError();
    }

    const respectBrowser = options.respectBrowserSession ?? this.defaultRespectBrowserSession;
    const retryBaseDelayMs = options.occupiedRetryDelayMs ?? 1500;
    const retriesOnOccupied = options.retriesOnOccupied ?? (respectBrowser ? 0 : 2);

    const run = async (): Promise<SessionExecutionOutcome<T>> => {
      if (this.#trippedError) {
        throw this.#trippedError;
      }
      // Run-scoped cancellation (`abortActiveSession`): pre-check, login, `fn` and retry waits
      const cancel = new AbortController();
      this.#activeCancel = cancel;
      try {
        return await this.#runSession(fn, cancel.signal, { respectBrowser, retriesOnOccupied, retryBaseDelayMs });
      } finally {
        if (this.#activeCancel === cancel) this.#activeCancel = null;
      }
    };

    const next = this.#mutex.then(run, run).then((outcome) => {
      if (outcome.status === "ok" && this.#lastSessionHoldMs !== null) {
        return { ...outcome, holdMs: this.#lastSessionHoldMs };
      }
      return outcome;
    });
    this.#mutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async #runSession<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    cancel: AbortSignal,
    opts: { respectBrowser: boolean; retriesOnOccupied: number; retryBaseDelayMs: number }
  ): Promise<SessionExecutionOutcome<T>> {
    const username = this.#username;
    const password = this.#password;
    const credentialFp = hashCredentialsFingerprint(username, password);
    const maxAttempts = opts.retriesOnOccupied + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      cancel.throwIfAborted();
      const loginState = await this.getLoginState(cancel);
      if (loginState.isLocked) {
        this.#tripCircuitBreaker(
          new CpeApiError("108007", `剩余锁定等待时间 ${loginState.remainWaitTime} 秒`, {
            waitTime: loginState.remainWaitTime,
          }),
          credentialFp
        );
      }
      if (opts.respectBrowser && loginState.isLoggedInElsewhere) {
        this.#browserYieldCount += 1;
        return {
          status: "yielded",
          layer: 1,
          stateCode: loginState.state,
          messageZh: t("zh-CN", "session.mode_yielding"),
          messageEn: t("en", "session.mode_yielding"),
        };
      }
      cancel.throwIfAborted();

      const deadline = new AbortController();
      // Deliberately not unref()'d: a session waiting only on its deadline (a hung request or domain
      // function) must keep the event loop alive until the deadline frees the slot; `finally` clears it.
      const deadlineTimer = setTimeout(
        () => deadline.abort(new CpeSessionDeadlineError(this.sessionMaxHoldMs)),
        this.sessionMaxHoldMs
      );
      const forwardCancel = (): void => deadline.abort(cancel.reason);
      cancel.addEventListener("abort", forwardCancel, { once: true });
      const session = new EphemeralCpeSession({
        baseUrl: this.baseUrl,
        username,
        password,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        deadline: deadline.signal,
      });

      let loginFinished = false;
      let lastHoldMs = 0;
      try {
        await raceDeadline(session.login(), deadline.signal);
        loginFinished = true;
        const value = await raceDeadline(
          activeSessionContext.run(this, () => fn(session)),
          deadline.signal
        );
        return {
          status: "ok",
          value,
          holdMs: lastHoldMs,
        };
      } catch (err) {
        if (!loginFinished && err instanceof CpeApiError && err.isCircuitBreakerFatal) {
          this.#tripCircuitBreaker(err, credentialFp);
        }
        // Only retry/yield on occupied BEFORE `fn(session)` starts so mutating writes are never replayed!
        if (!loginFinished && err instanceof CpeApiError && err.isSessionOccupied) {
          if (attempt < maxAttempts) {
            await abortableDelay(opts.retryBaseDelayMs * attempt, cancel);
            continue;
          }
          if (opts.respectBrowser) {
            this.#browserYieldCount += 1;
            return {
              status: "yielded",
              layer: 2,
              stateCode: err.code,
              messageZh: t("zh-CN", "session.mode_yielding"),
              messageEn: t("en", "session.mode_yielding"),
            };
          }
        }
        throw err;
      } finally {
        clearTimeout(deadlineTimer);
        cancel.removeEventListener("abort", forwardCancel);
        const holdMs = await session.logout();
        if (holdMs !== null) {
          lastHoldMs = holdMs;
          this.#lastSessionHoldMs = holdMs;
          this.#totalSessionsCompleted += 1;
        }
      }
    }

    return {
      status: "yielded",
      layer: 2,
      stateCode: "108003",
      messageZh: t("zh-CN", "session.mode_yielding"),
      messageEn: t("en", "session.mode_yielding"),
    };
  }

  async withSession<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    options: WithSessionOptions = {}
  ): Promise<T | null> {
    const outcome = await this.withSessionDetailed(fn, options);
    return outcome.status === "ok" ? outcome.value : null;
  }
}
