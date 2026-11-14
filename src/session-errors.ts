import crypto from "node:crypto";

/**
 * The errors every router session can end with, whatever the brand: the router's own error codes
 * (`CpeApiError`, in the HiLink numbering the rest of FengSui reads), a request that got no answer,
 * an answer FengSui cannot read, and the session client's own limits (deadline, reentrancy).
 */

/**
 * The breaker's code when an answer to the password carried no error code and no sign of success (a
 * page, an empty, cut-off or oversized body, a redirect; for SCRAM, no server signature): the router
 * has the password and FengSui cannot tell what it made of it.
 */
export const LOGIN_UNCONFIRMED_CODE = "unconfirmed";

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
  "115002": "路由器要求先修改管理密码 (Password modify)",
  "120001": "语音通话占线中 (Voice busy)",
  "125001": "CSRF Token 校验失败 (Wrong token)",
  "125002": "会话已过期 (Session expired)",
  "125003": "会话 Token 无效 (Invalid session token)",
  // Not a router code: a legacy login answer that was neither OK nor an error code (the breaker's code)
  [LOGIN_UNCONFIRMED_CODE]: "路由器对密码的应答无法判断 (Login not confirmed)",
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

/** The router answered, but not in a shape FengSui reads (a missing tag, odd JSON): nothing is guessed from it. */
export class CpeAnswerFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpeAnswerFormatError";
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
  /**
   * The CPE answered with a redirect, which `redirect: "error"` turns into a failed request (`fetch`
   * says "unexpected redirect"): unlike a lost request, the router had all of it and replied.
   */
  readonly redirected: boolean;

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
    this.redirected = detail === "unexpected redirect";
  }
}

/** The session has no encrypted channel (a legacy login, or no server key), so an encrypted endpoint is out of reach. */
export class CpeEncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpeEncryptionUnavailableError";
  }
}

/**
 * A login whose method could not be settled before the password went out: nothing carrying the
 * password was sent, so no attempt was used and the breaker stays as it was. Every brand's login
 * throws it, each saying what it saw. The router answered, so it is there.
 */
export class LoginMethodError extends Error {
  /** The router's own code for refusing the method it was asked for (`null`: it gave none). */
  readonly refusalCode: string | null;
  /**
   * The router logged in before by the method it now refuses: nothing gets in until its owner acts,
   * so the daemon alerts as it does for a router out of reach.
   */
  readonly refusesKnownMethod: boolean;

  constructor(message: string, opts: { refusalCode?: string | null; refusesKnownMethod?: boolean } = {}) {
    super(message);
    this.name = "LoginMethodError";
    this.refusalCode = opts.refusalCode ?? null;
    this.refusesKnownMethod = opts.refusesKnownMethod === true;
  }
}

/** Default upper bound for one admin session (covers SMS send-status polling plus read-back). */
export const DEFAULT_SESSION_MAX_HOLD_MS = 90_000;

export class CpeApiError extends Error {
  readonly code: string;
  readonly remainCount: number | null;
  readonly waitTime: number | null;
  /** The answer to a password FengSui cannot place: latch the breaker rather than risk another attempt. */
  readonly latchesBreaker: boolean;

  constructor(
    code: string,
    detail = "",
    meta: { remainCount?: number | null; waitTime?: number | null; latchesBreaker?: boolean } = {}
  ) {
    const desc = CPE_ERROR_DESCRIPTIONS[code] ?? "CPE 接口错误";
    const suffix = detail ? `: ${detail}` : "";
    super(`[CPE ${code}] ${desc}${suffix}`);
    this.name = "CpeApiError";
    this.code = code;
    this.remainCount = meta.remainCount ?? null;
    this.waitTime = meta.waitTime ?? null;
    this.latchesBreaker = meta.latchesBreaker === true;
  }

  get isAuthWrongPassword(): boolean {
    return this.code === "108006" || this.code === "108002" || this.code === "108001";
  }

  get isLocked(): boolean {
    return this.code === "108007";
  }

  /** The router wants its admin password changed on its own web page before it lets anyone in. */
  get isPasswordChangeRequired(): boolean {
    return this.code === "115002";
  }

  get isCircuitBreakerFatal(): boolean {
    return this.isAuthWrongPassword || this.isLocked || this.isPasswordChangeRequired || this.latchesBreaker;
  }

  get isSessionOccupied(): boolean {
    return this.code === "108003" || this.code === "108005" || this.code === "108009";
  }
}

/**
 * Tells whether the router credentials changed since a breaker latched on them (kept with the latch
 * in the encrypted state file; it never leaves the daemon). One implementation for every client:
 * the driver families' client uses it too.
 */
export function hashCredentialsFingerprint(username: string, password: string): string {
  return crypto
    .createHash("sha256")
    .update(`fengsui-cpe-cred:${username}:${password}`, "utf8")
    .digest("hex");
}
