import crypto from "node:crypto";
import { normalizeCpeUrl } from "./config.ts";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  computeScram,
  generateEccSession,
  verifyPubkeySignature,
} from "./crypto.ts";
import type {
  CircuitBreakerState,
  CpeLoginState,
  EncryptionType,
  SessionTelemetry,
} from "./types.ts";
import { buildXmlRequest, escapeXmlBasic, getXmlTag, parseXmlError } from "./xml.ts";

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

  constructor(opts: {
    baseUrl: string;
    username: string;
    password: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
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

  async get(apiPath: string, extraHeaders: Record<string, string> = {}): Promise<string> {
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest",
      _ResponseSource: "Broswer",
      Accept: "*/*",
      ...extraHeaders,
    };
    const cookie = this.#cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.#updateCookies(res.headers);
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  /**
   * Perform an authenticated GET that supplies `ecc-client-pubkey` and automatically decrypts
   * AES-256-GCM hex payloads if the endpoint returns encrypted response data (`enc-type=1`).
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

  async #consumeToken(): Promise<string> {
    if (this.tokens.length === 0) {
      const xml = await this.get("/api/webserver/token");
      const fullToken = getXmlTag(xml, "token");
      if (!fullToken || fullToken.length < 32) {
        throw new Error("Failed to acquire CSRF token from /api/webserver/token");
      }
      this.tokens.push(fullToken.length > 32 ? fullToken.slice(32) : fullToken);
    }
    return this.tokens.shift()!;
  }

  async postRaw(
    apiPath: string,
    body: string,
    opts: { clearTokensOnResponse?: boolean } = {}
  ): Promise<string> {
    const token = await this.#consumeToken();
    const headers: Record<string, string> = {
      "X-Requested-With": "XMLHttpRequest",
      _ResponseSource: "Broswer",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "*/*",
      __RequestVerificationToken: token,
    };
    const cookie = this.#cookieHeader();
    if (cookie) headers.Cookie = cookie;

    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.#updateCookies(res.headers);
    this.#captureTokens(res.headers, Boolean(opts.clearTokensOnResponse));
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  async postXml(apiPath: string, requestObj: Record<string, unknown>): Promise<string> {
    return await this.postRaw(apiPath, buildXmlRequest(requestObj));
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
        username: escapeXmlBasic(this.username),
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

    const authXml = await this.postRaw(
      "/api/user/authentication_login",
      buildXmlRequest({
        clientproof: scram.clientProofHex,
        finalnonce: serverNonce,
      }),
      { clearTokensOnResponse: true }
    );

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
    if (!this.loggedIn) return null;
    try {
      await this.postRaw("/api/user/logout", buildXmlRequest({ Logout: 1 }));
    } catch {
      // Ignore logout network/session errors if session already expired
    } finally {
      this.loggedIn = false;
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
}

export interface WithSessionOptions {
  respectBrowserSession?: boolean;
  retriesOnOccupied?: number;
  occupiedRetryDelayMs?: number;
}

/**
 * Huawei 5G CPE Ultra 6 (H168-383) client enforcing:
 *   1. Single-admin ephemeral sessions (`finally` logout ~200ms).
 *   2. Active browser avoidance via `/api/user/state-login` (`State !== "-1"`).
 *   3. Latched `108006` / `108007` anti-brute-force circuit breaker.
 */
export class HuaweiCpeClient {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly defaultRespectBrowserSession: boolean;
  readonly fetchImpl: typeof fetch;

  #mutex: Promise<unknown>;
  #trippedError: CpeApiError | null;
  #trippedAtIso: string | null;
  #lastSessionHoldMs: number | null;
  #totalSessionsCompleted: number;
  #browserYieldCount: number;

  constructor(config: HuaweiCpeClientOptions) {
    this.baseUrl = normalizeCpeUrl(config.cpeUrl, {
      allowPublicHost: Boolean(config.allowPublicCpeHost),
    });
    this.username = config.cpeUsername ?? "admin";
    this.password = config.cpePassword;
    this.timeoutMs = config.requestTimeoutMs ?? 15000;
    this.defaultRespectBrowserSession = config.respectBrowserSession ?? true;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;

    this.#mutex = Promise.resolve();
    this.#trippedError = null;
    this.#trippedAtIso = null;
    this.#lastSessionHoldMs = null;
    this.#totalSessionsCompleted = 0;
    this.#browserYieldCount = 0;
  }

  getCircuitBreakerState(): CircuitBreakerState {
    if (!this.#trippedError) {
      return { tripped: false, code: null, reason: null, trippedAtIso: null };
    }
    return {
      tripped: true,
      code: this.#trippedError.code,
      reason: this.#trippedError.message,
      trippedAtIso: this.#trippedAtIso,
    };
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
  }

  #tripCircuitBreaker(err: CpeApiError): never {
    if (!this.#trippedError) {
      this.#trippedError = err;
      this.#trippedAtIso = new Date().toISOString();
    }
    throw this.#trippedError;
  }

  async getPublic(apiPath: string): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
      method: "GET",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        _ResponseSource: "Broswer",
        Accept: "*/*",
      },
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const err = parseXmlError(text);
    if (err) {
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  async getLoginState(): Promise<CpeLoginState> {
    const xml = await this.getPublic("/api/user/state-login");
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

  async withSession<T>(
    fn: (session: EphemeralCpeSession) => Promise<T>,
    options: WithSessionOptions = {}
  ): Promise<T | null> {
    const respectBrowser = options.respectBrowserSession ?? this.defaultRespectBrowserSession;
    const retryBaseDelayMs = options.occupiedRetryDelayMs ?? 1500;
    const retriesOnOccupied = options.retriesOnOccupied ?? (respectBrowser ? 0 : 2);

    const run = async (): Promise<T | null> => {
      if (this.#trippedError) {
        throw this.#trippedError;
      }

      const maxAttempts = retriesOnOccupied + 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const loginState = await this.getLoginState();
        if (loginState.isLocked) {
          this.#tripCircuitBreaker(
            new CpeApiError("108007", `剩余锁定等待时间 ${loginState.remainWaitTime} 秒`, {
              waitTime: loginState.remainWaitTime,
            })
          );
        }
        if (respectBrowser && loginState.isLoggedInElsewhere) {
          this.#browserYieldCount += 1;
          return null;
        }

        const session = new EphemeralCpeSession({
          baseUrl: this.baseUrl,
          username: this.username,
          password: this.password,
          timeoutMs: this.timeoutMs,
          fetchImpl: this.fetchImpl,
        });

        try {
          await session.login();
          return await fn(session);
        } catch (err) {
          if (err instanceof CpeApiError && err.isCircuitBreakerFatal) {
            this.#tripCircuitBreaker(err);
          }
          if (err instanceof CpeApiError && err.isSessionOccupied) {
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, retryBaseDelayMs * attempt));
              continue;
            }
            if (respectBrowser) {
              this.#browserYieldCount += 1;
              return null;
            }
          }
          throw err;
        } finally {
          const holdMs = await session.logout();
          if (holdMs !== null) {
            this.#lastSessionHoldMs = holdMs;
            this.#totalSessionsCompleted += 1;
          }
        }
      }
      return null;
    };

    const next = this.#mutex.then(run, run);
    this.#mutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
