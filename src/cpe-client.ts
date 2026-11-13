import crypto from "node:crypto";
import {
  CpeLoginMethodError,
  LOGIN_RETRY_SAFE_CODES,
  type LegacyScheme,
  type LoginPlan,
  SCRAM_PROBE_FALLBACK_CODES,
  type ScramChallenge,
  encodeLegacyPassword,
  isNonChallengeAnswer,
  planLogin,
  readScramChallenge,
  readSesTokInfo,
} from "./cpe-auth.ts";
import { aesGcmDecrypt, aesGcmEncrypt, computeScram, generateEccSession, verifyPubkeySignature } from "./crypto.ts";
import { timingSafeEqualString } from "./constant-time.ts";
import { ApiErrorTally, type LoginScheme, type TokenFlow } from "./device-profile.ts";
import { readBoundedResponseText } from "./http-body.ts";
import type { CpeLoginState, EncryptionType } from "./types.ts";
import { type SessionAttempt, type SessionAttemptContext, SessionClient, type SessionPrecheck, type SessionProtocol } from "./session-client.ts";
import { CpeApiError, CpeEncryptionUnavailableError, CpeSessionClosedError, CpeTransportError, LOGIN_UNCONFIRMED_CODE } from "./session-errors.ts";
import { MAX_XML_BYTES, buildXmlRequest, getXmlTag, parseXmlError } from "./xml.ts";


function readCpeResponseText(res: Response): Promise<string> {
  return readBoundedResponseText(res, MAX_XML_BYTES);
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

/**
 * A router that signed its encryption key before handed one over unsigned: the answer may have been
 * altered on the way, so the session is ended (and logged out) instead of encrypting to that key.
 */
export class CpeEccSignatureMissingError extends Error {
  constructor() {
    // Short enough for the router-unreachable alert (160 characters) to keep the remedy
    super("Router key came unsigned though signed before (answer may be altered): session ended. If a firmware update stopped it: CPE_REQUIRE_ECC_SIGNATURE=false in .env");
    this.name = "CpeEccSignatureMissingError";
  }
}

/** The caller runs inside one of `client`'s sessions right now. */
export function isInsideCpeSession(client: HuaweiCpeClient): boolean {
  return client.insideSession;
}

/** An answer to the password that tells what the router made of it: a login error, or a refusal before the check. */
function isPlacedLoginError(err: unknown): boolean {
  return err instanceof CpeApiError && (err.isCircuitBreakerFatal || LOGIN_RETRY_SAFE_CODES.has(err.code));
}

/**
 * The router answered a password in a way FengSui cannot place (`err`: its unknown error code, the
 * redirect it answered with, or why the answer could not be read; `null`: neither `success` nor an
 * error code). On a model nobody verified that may have counted as a wrong attempt, so the error
 * latches the breaker.
 */
function unplacedLoginAnswer(apiPath: string, err: unknown, success: string): CpeApiError {
  if (err instanceof CpeApiError) {
    return new CpeApiError(err.code, `${apiPath}: unexpected answer to the password, no further login attempt`, {
      remainCount: err.remainCount,
      waitTime: err.waitTime,
      latchesBreaker: true,
    });
  }
  const what =
    err === null
      ? `neither ${success} nor an error code`
      : err instanceof CpeTransportError && err.redirected
        ? "a redirect"
        : `unreadable (${err instanceof Error ? err.message : String(err)})`;
  return new CpeApiError(LOGIN_UNCONFIRMED_CODE, `${apiPath}: the answer to the password was ${what}, no further login attempt`, { latchesBreaker: true });
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
  /** This router is known to sign its encryption key: an unsigned one ends the session (CPE_REQUIRE_ECC_SIGNATURE). */
  #eccSignatureRequired = false;
  /** Aborted when logout begins: a request still in flight then (work that did not wait for it) never goes out again. */
  readonly #closing = new AbortController();
  /** Counts every error code the router answers (the device report's error statistics). */
  readonly #onApiError: ((method: "GET" | "POST", apiPath: string, code: string) => void) | null;
  #loginScheme: LoginScheme | null = null;
  #eccVerified = false;
  #tokenFlow: TokenFlow | null = null;

  constructor(opts: {
    baseUrl: string;
    username: string;
    password: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
    deadline?: AbortSignal;
    onApiError?: (method: "GET" | "POST", apiPath: string, code: string) => void;
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
    this.#onApiError = opts.onApiError ?? null;
  }

  /** How this session logged in (`null` until it did); recorded for the device profile, changes nothing. */
  get loginScheme(): LoginScheme | null {
    return this.#loginScheme;
  }

  /** The login answer carried an ECC key with a signature that verified. */
  get eccVerified(): boolean {
    return this.#eccVerified;
  }

  /** Where the first CSRF token came from (`null` until one was fetched). */
  get tokenFlow(): TokenFlow | null {
    return this.#tokenFlow;
  }

  /** Requests can still go out: the deadline has not passed (nor a stop cancelled it) and logout has not begun. */
  get open(): boolean {
    return !this.#releasing && this.#deadline?.aborted !== true;
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
    return AbortSignal.any(this.#deadline ? [this.#deadline, this.#closing.signal, timeout] : [this.#closing.signal, timeout]);
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
      // A legacy login offers no key FengSui could verify: no encrypted channel rather than an unverified one
      if (this.#loginScheme !== "scram") throw new CpeEncryptionUnavailableError("CPE session has no encrypted channel: its login method offers no verified key");
      // A router known to sign its key gave none at login: an unsigned one from publickey is not taken instead
      if (this.#eccSignatureRequired) throw new CpeEccSignatureMissingError();
      const pubXml = await this.get("/api/webserver/publickey");
      const serverPub = getXmlTag(pubXml, "ecc_server_pubkey");
      if (!serverPub) {
        throw new CpeEncryptionUnavailableError("CPE did not return ecc_server_pubkey");
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

  /**
   * A GET of an endpoint FengSui does not know (an AI agent's read-only discovery): its answer never
   * replaces the session's cookies (a stray `SessionID` would make the logout miss this session and
   * leave the router's one admin slot taken) and its error code never counts in the device report's
   * tally.
   */
  async peek(apiPath: string, timeoutMs: number): Promise<string> {
    return await this.#get(apiPath, {}, timeoutMs, false, true);
  }

  async #get(apiPath: string, extraHeaders: Record<string, string>, timeoutMs: number, releasing: boolean, foreign = false): Promise<string> {
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
    if (!foreign) this.#updateCookies(res.headers);
    const text = await readCpeResponseText(res);
    const err = parseXmlError(text);
    if (err) {
      if (!foreign) this.#onApiError?.("GET", apiPath, err.code);
      throw new CpeApiError(err.code, apiPath, err);
    }
    return text;
  }

  /**
   * The next CSRF token: from the pool the router's answers refill, else fetched through this
   * session's token flow. `webserver/token` first (the H168-383's); a router that answers it with
   * `100002` hands them out through `SesTokInfo`, which the session then keeps using.
   */
  async #consumeToken(timeoutMs: number, releasing: boolean): Promise<string> {
    if (this.tokens.length === 0) {
      if (this.#tokenFlow === "sestokinfo") {
        await this.#fetchSesTokInfo(timeoutMs, releasing);
      } else {
        let xml: string | null = null;
        try {
          xml = await this.#get("/api/webserver/token", {}, timeoutMs, releasing);
        } catch (err) {
          if (this.#tokenFlow !== null || !(err instanceof CpeApiError) || err.code !== "100002") throw err;
        }
        if (xml === null) {
          await this.#fetchSesTokInfo(timeoutMs, releasing);
        } else {
          const fullToken = getXmlTag(xml, "token");
          if (!fullToken || fullToken.length < 32) {
            throw new Error("Failed to acquire CSRF token from /api/webserver/token");
          }
          this.tokens.push(fullToken.length > 32 ? fullToken.slice(-32) : fullToken);
          this.#tokenFlow ??= "webserver-token";
        }
      }
    }
    return this.tokens.shift()!;
  }

  /**
   * `GET /api/webserver/SesTokInfo`: one token, and the session cookie in `SesInfo` only while the
   * session has none (a cookie the router set, e.g. the one a login rotated in, is never replaced).
   */
  async #fetchSesTokInfo(timeoutMs: number, releasing: boolean): Promise<void> {
    const info = readSesTokInfo(await this.#get("/api/webserver/SesTokInfo", {}, timeoutMs, releasing));
    if (!info) throw new Error("Failed to acquire CSRF token from /api/webserver/SesTokInfo");
    if (info.sessionCookie && !this.cookies.has(info.sessionCookie.name)) this.cookies.set(info.sessionCookie.name, info.sessionCookie.value);
    this.tokens.push(info.token);
    this.#tokenFlow ??= "sestokinfo";
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

  /**
   * `body` may depend on the token the request carries (the SHA-256 legacy login hashes it in).
   * `onAnswer` runs once the router has answered (status and headers arrived, or a redirect that
   * `redirect: "error"` refused), before its body is read.
   */
  async #post(
    apiPath: string,
    body: string | ((token: string) => string),
    opts: { clearTokensOnResponse?: boolean; contentType?: string; overrideTimeoutMs?: number; onAnswer?: () => void },
    releasing: boolean
  ): Promise<string> {
    const timeoutMs = opts.overrideTimeoutMs ?? this.timeoutMs;
    const run = async (): Promise<string> => {
      const token = await this.#consumeToken(timeoutMs, releasing);
      const payload = typeof body === "string" ? body : body(token);
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

      let res: Response;
      try {
        res = await cpeFetch(this.fetchImpl, `${this.baseUrl}${apiPath}`, apiPath, {
          method: "POST",
          headers,
          body: payload,
          redirect: "error",
          signal,
        });
      } catch (err) {
        if (err instanceof CpeTransportError && err.redirected) opts.onAnswer?.();
        throw err;
      }
      opts.onAnswer?.();
      this.#updateCookies(res.headers);
      this.#captureTokens(res.headers, Boolean(opts.clearTokensOnResponse));
      const text = await readCpeResponseText(res);
      const err = parseXmlError(text);
      if (err) {
        this.#onApiError?.("POST", apiPath, err.code);
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

  /** `timeoutMs`: this request's wait instead of the client's (a router that answers once it has searched or registered). */
  async postXml(apiPath: string, requestObj: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    return await this.postRaw(apiPath, buildXmlRequest(requestObj), timeoutMs === undefined ? {} : { overrideTimeoutMs: timeoutMs });
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
      this.#onApiError?.("POST", apiPath, err.code);
      throw new CpeApiError(err.code, `${apiPath} (decrypted)`, err);
    }
    return decryptedXml;
  }

  /**
   * Log in once, with the method settled before any password goes out (`planLogin`): the router's
   * `password_type` from `state-login`, then the SCRAM challenge, which carries no password. Only a
   * challenge refused the way appendix A.8 allows (or redirected, A.5) leads to the legacy `user/login`; a router known to
   * use SCRAM (`scramKnown`) never gets there. Without options it is SCRAM only, as on the H168-383.
   */
  async login(opts: { passwordType?: string | null; scramKnown?: boolean; unverifiedModel?: boolean; eccSignatureRequired?: boolean } = {}): Promise<void> {
    this.#eccSignatureRequired = opts.eccSignatureRequired === true;
    if (!this.password) {
      throw new Error("The router password is not set: the daemon takes it from Settings → Router in the console, the probes from CPE_PASSWORD in .env");
    }
    const scramKnown = opts.passwordType === undefined || opts.scramKnown === true;
    const passwordType = opts.passwordType ?? null;
    const plan: LoginPlan = planLogin(passwordType, { scramKnown });

    await this.get("/api/monitoring/status", { "Update-Cookie": "UpdateCookie" });

    const firstNonce = crypto.randomBytes(32).toString("hex");
    let challenge: ScramChallenge | null = null;
    /** What refused the challenge: its error code, or `null` for an answer that was no challenge. */
    let refusedWith: string | null = null;
    if (plan.probeScram) {
      try {
        const challengeXml = await this.postRaw(
          "/api/user/challenge_login",
          buildXmlRequest({
            username: this.username,
            firstnonce: firstNonce,
            mode: 1,
          }),
          { clearTokensOnResponse: true }
        );
        challenge = readScramChallenge(challengeXml);
        if (!challenge && !isNonChallengeAnswer(challengeXml)) {
          throw new Error("Invalid SCRAM challenge response from CPE");
        }
      } catch (err) {
        // A redirect is how some models answer an endpoint they lack (appendix A.5): refused like 100002
        const redirected = err instanceof CpeTransportError && err.redirected;
        if (!redirected && (!(err instanceof CpeApiError) || !SCRAM_PROBE_FALLBACK_CODES.has(err.code))) throw err;
        refusedWith = err instanceof CpeApiError ? err.code : null;
      }
    }
    if (challenge) {
      await this.#scramLogin(firstNonce, challenge, opts.unverifiedModel === true);
      return;
    }
    // Refused the way an older model refuses it (appendix A.8); a router known to use SCRAM never gets further
    if (!plan.legacy) throw new CpeLoginMethodError(passwordType, refusedWith, { scramKnown });
    await this.#legacyLogin(plan.legacy.scheme, plan.legacy.passwordType);
  }

  /** Mark the session as possibly logged in while the password's answer is outstanding. */
  async #submitPassword(apiPath: string, body: string | ((token: string) => string), onAnswer?: () => void): Promise<string> {
    // Until the router answers, it may already have logged us in (lost response, aborted request),
    // so `logout()` must run; a CPE error code means the router refused and nothing is open.
    this.#authOutcomeUnknown = true;
    let answer: string;
    try {
      answer = await this.#post(apiPath, body, { clearTokensOnResponse: true, onAnswer }, false);
    } catch (err) {
      if (err instanceof CpeApiError) {
        this.#authOutcomeUnknown = false;
      }
      throw err;
    }
    this.#authOutcomeUnknown = false;
    this.loggedIn = true;
    this.#loginCompletedAtMs = performance.now();
    return answer;
  }

  /**
   * `strict` (a router identified as a model nobody verified, R1-04): once the router has answered
   * the proof, anything but a server signature or a placed error code latches the breaker, as for a
   * legacy login. The H168-383's handling is the verified one: such an answer fails the session and
   * the next one may try again.
   */
  async #scramLogin(firstNonce: string, challenge: ScramChallenge, strict: boolean): Promise<void> {
    const scram = computeScram(this.password, challenge.salt, challenge.iterations, firstNonce, challenge.serverNonce);
    let answered = false;
    let authXml: string;
    try {
      authXml = await this.#submitPassword(
        "/api/user/authentication_login",
        buildXmlRequest({
          clientproof: scram.clientProofHex,
          finalnonce: challenge.serverNonce,
        }),
        () => {
          answered = true;
        }
      );
    } catch (err) {
      if (!strict || !answered || isPlacedLoginError(err)) throw err;
      throw unplacedLoginAnswer("/api/user/authentication_login", err, "a server signature");
    }

    const serverSig = getXmlTag(authXml, "serversignature");
    if (!serverSig) {
      if (strict) throw unplacedLoginAnswer("/api/user/authentication_login", null, "a server signature");
      throw new Error("SCRAM server signature missing (potential MITM)");
    }
    // Compared in constant time, as every other secret-derived value is
    if (!timingSafeEqualString(serverSig.toLowerCase(), scram.expectedServerSig.toLowerCase())) {
      throw new Error("SCRAM server signature mismatch (potential MITM)");
    }

    const eccServerPub = getXmlTag(authXml, "ecc_server_pubkey");
    const eccPubSig = getXmlTag(authXml, "ecc_pubkey_signature");
    if (eccServerPub) {
      if (eccPubSig && !verifyPubkeySignature(eccServerPub, scram.serverKey, eccPubSig)) {
        throw new Error("CPE ECC public key signature verification failed");
      }
      if (!eccPubSig && this.#eccSignatureRequired) throw new CpeEccSignatureMissingError();
      this.ecc = generateEccSession(eccServerPub);
      this.#eccVerified = Boolean(eccPubSig);
    }
    this.#loginScheme = "scram";
  }

  /**
   * `POST /api/user/login`; the SHA-256 form hashes in the very token the request carries. Once the
   * router has answered, anything but `OK` or a code that refuses a login before the password is
   * checked (`LOGIN_RETRY_SAFE_CODES`) latches the breaker: an unknown code, a page, an empty,
   * cut-off or oversized body, a redirect. Without an answer (no token for the request, the connection
   * failed, it timed out) the next session may try again, as with SCRAM.
   */
  async #legacyLogin(scheme: LegacyScheme, passwordType: "0" | "3" | "4"): Promise<void> {
    let answered = false;
    let answer: string;
    try {
      answer = await this.#submitPassword(
        "/api/user/login",
        (token) =>
          buildXmlRequest({
            Username: this.username,
            Password: encodeLegacyPassword(scheme, this.username, this.password, token),
            password_type: passwordType,
          }),
        () => {
          answered = true;
        }
      );
    } catch (err) {
      if (!answered || isPlacedLoginError(err)) throw err;
      throw unplacedLoginAnswer("/api/user/login", err, "OK");
    }
    if (getXmlTag(answer, "response")?.trim() !== "OK") throw unplacedLoginAnswer("/api/user/login", null, "OK");
    this.#loginScheme = scheme;
  }

  async logout(): Promise<number | null> {
    // From here on only logout's own requests may use this session, and none still in flight is resent
    this.#releasing = true;
    this.#closing.abort(new CpeSessionClosedError());
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
  /** `CPE_REQUIRE_ECC_SIGNATURE` (default true): end a session whose router, known to sign its encryption key, sends it unsigned. */
  requireEccSignature?: boolean;
  allowPublicCpeHost?: boolean;
  fetchImpl?: typeof fetch;
  /** Hard upper bound for one session, login to logout (default `DEFAULT_SESSION_MAX_HOLD_MS`). */
  sessionMaxHoldMs?: number;
  /** Where router error codes are counted (a connection test's throwaway client shares the live one's). */
  apiErrors?: ApiErrorTally;
  /**
   * Whether the router is identified as a model nobody verified, asked at each login (the write gate
   * knows): a SCRAM answer FengSui cannot place then latches the breaker like a legacy one (R1-04).
   * Left out: never, as on the H168-383.
   */
  unverifiedModel?: () => boolean;
}

/**
 * The state-login answer (`GET /api/user/state-login`, no login needed): someone signed in, a locked
 * login, and which way the password is to be encoded.
 */
export function readLoginState(xml: string): CpeLoginState {
  const state = getXmlTag(xml, "State") ?? "-1";
  const isLocked = (getXmlTag(xml, "lockstatus") ?? "0") === "1";
  const remainWaitTime = Number.parseInt(getXmlTag(xml, "remainwaittime") ?? "0", 10) || 0;
  return {
    state,
    // H168-383 returns State === "-1" when logged out / idle, and State === "0" when an admin session is active
    isLoggedInElsewhere: state !== "-1",
    isLocked,
    remainWaitTime,
    // `null` when the router names none: the login method is then never guessed (`planLogin`)
    passwordType: getXmlTag(xml, "password_type"),
    firstLogin: getXmlTag(xml, "firstlogin") ?? "0",
  };
}

/** A HiLink GET that needs no login (state-login, check-notifications). */
async function getHilinkPublic(
  ctx: { baseUrl: string; fetchImpl: typeof fetch; timeoutMs: number; apiErrors: ApiErrorTally },
  apiPath: string,
  signal?: AbortSignal
): Promise<string> {
  const timeout = AbortSignal.timeout(ctx.timeoutMs);
  const res = await cpeFetch(ctx.fetchImpl, `${ctx.baseUrl}${apiPath}`, apiPath, {
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
    ctx.apiErrors.record("GET", apiPath, err.code);
    throw new CpeApiError(err.code, apiPath, err);
  }
  return text;
}

/** What the HiLink client remembers about its router between sessions (the login is planned with it). */
interface HilinkMemory {
  loginScheme: LoginScheme | null;
  eccSigned: boolean;
  readonly requireEccSignature: boolean;
  /** Asked at each login, not remembered: the daemon's view of the model moves between sessions. */
  readonly unverifiedModel: () => boolean;
}

/**
 * HiLink's way into a session, for the shared client: `state-login` before the password (someone
 * signed in, a locked login, how to encode the password), one login (SCRAM, or the legacy method the
 * router names), `POST /api/user/logout` in `finally`. A `108003` at login may be tried again when
 * the caller does not respect the browser (the password itself was not refused).
 */
function hilinkProtocol(memory: HilinkMemory): SessionProtocol<EphemeralCpeSession> {
  return {
    retryOccupiedLogin: true,
    attempt(ctx: SessionAttemptContext): SessionAttempt<EphemeralCpeSession> {
      const session = new EphemeralCpeSession({
        baseUrl: ctx.baseUrl,
        username: ctx.username,
        password: ctx.password,
        timeoutMs: ctx.timeoutMs,
        fetchImpl: ctx.fetchImpl,
        deadline: ctx.deadline,
        onApiError: (method, apiPath, code) => ctx.apiErrors.record(method, apiPath, code),
      });
      let passwordType: string | null = null;
      return {
        session,
        async precheck(): Promise<SessionPrecheck> {
          const state = readLoginState(await getHilinkPublic(ctx, "/api/user/state-login", ctx.deadline));
          passwordType = state.passwordType;
          return {
            occupied: state.isLoggedInElsewhere,
            stateCode: state.state,
            locked: state.isLocked ? new CpeApiError("108007", `剩余锁定等待时间 ${state.remainWaitTime} 秒`, { waitTime: state.remainWaitTime }) : null,
          };
        },
        async login(): Promise<void> {
          await session.login({
            passwordType,
            scramKnown: memory.loginScheme === "scram",
            unverifiedModel: memory.unverifiedModel(),
            eccSignatureRequired: memory.requireEccSignature && memory.eccSigned,
          });
          if (session.loginScheme) memory.loginScheme = session.loginScheme;
          if (session.eccVerified) memory.eccSigned = true;
        },
        logout: () => session.logout(),
      };
    },
  };
}

/**
 * The Huawei HiLink client (the H168-383 and other HiLink models): the shared session client
 * (`SessionClient`: one session at a time, `finally` logout, avoidance, breaker) with HiLink's login,
 * plus the login-free reads (`getPublic`, `getLoginState`) and what it learns about how its router
 * logs in.
 */
export class HuaweiCpeClient extends SessionClient<EphemeralCpeSession> {
  readonly #memory: HilinkMemory;

  constructor(config: HuaweiCpeClientOptions) {
    const memory: HilinkMemory = { loginScheme: null, eccSigned: false, requireEccSignature: config.requireEccSignature !== false, unverifiedModel: config.unverifiedModel ?? (() => false) };
    super(hilinkProtocol(memory), {
      cpeUrl: config.cpeUrl,
      cpeUsername: config.cpeUsername ?? "admin",
      cpePassword: config.cpePassword,
      ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
      ...(config.respectBrowserSession !== undefined ? { respectBrowserSession: config.respectBrowserSession } : {}),
      allowPublicCpeHost: Boolean(config.allowPublicCpeHost),
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      ...(config.sessionMaxHoldMs !== undefined ? { sessionMaxHoldMs: config.sessionMaxHoldMs } : {}),
      ...(config.apiErrors !== undefined ? { apiErrors: config.apiErrors } : {}),
    });
    this.#memory = memory;
  }

  /**
   * How this router last logged in (`null`: not known yet). Once it is `scram`, a refused SCRAM
   * challenge fails the session instead of falling back to a legacy login.
   */
  get knownLoginScheme(): LoginScheme | null {
    return this.#memory.loginScheme;
  }

  /** Whether this router has signed its encryption key at a login (it then has to, unless the owner turned that off). */
  get eccSignedKnown(): boolean {
    return this.#memory.eccSigned;
  }

  /** What state.json remembers about this router's key signature. */
  rememberEccSigned(signed: boolean): void {
    this.#memory.eccSigned = signed;
  }

  /** Remember how the router logs in (from a stored identification); `unknown` or `null` forgets it. */
  rememberLoginScheme(scheme: LoginScheme | null): void {
    this.#memory.loginScheme = scheme === "unknown" ? null : scheme;
  }

  /**
   * Point the client at a router connection the console just proved (the scheduler only calls this
   * between sessions) and clear the breaker: the new credentials logged in a moment ago, with
   * `loginScheme`.
   */
  override reconfigure(next: { cpeUrl: string; cpeUsername: string; cpePassword: string; loginScheme?: LoginScheme | null }): void {
    super.reconfigure(next);
    this.rememberLoginScheme(next.loginScheme ?? null);
    // Possibly another router: whether it signs its key is learnt again
    this.#memory.eccSigned = false;
  }

  async getPublic(apiPath: string, signal?: AbortSignal): Promise<string> {
    return await getHilinkPublic(this, apiPath, signal);
  }

  async getLoginState(signal?: AbortSignal): Promise<CpeLoginState> {
    return readLoginState(await this.getPublic("/api/user/state-login", signal));
  }
}
