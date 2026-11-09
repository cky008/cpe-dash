import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { BearerIdentity } from "./console-settings.ts";
import type { AppConfig } from "./types.ts";

export const SESSION_COOKIE_NAME = "fengsui_sid";
const MAX_ACTIVE_SESSIONS = 128;
const MAX_TRACKED_BUCKETS = 4096;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface WebSessionRecord {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  clientBucket: string;
}

/** Outcome of a credential check: `401` for a bad credential, `429` while the bucket is locked out. */
export type CredentialVerdict = { ok: true } | { ok: false; statusCode: 401 | 429; retrySec?: number };

/** `full`: a full-access token; `readonly`: a read token (reads and read-only refreshes only). */
export type BearerRole = "full" | "readonly";

/** Where the console login and the Bearer tokens are checked (the encrypted console settings). */
export interface CredentialDirectory {
  verifyLogin(candidate: string): Promise<boolean>;
  resolveBearer(token: string): BearerIdentity | null;
}

function sha256Buffer(input: string): Buffer {
  return crypto.createHash("sha256").update(input, "utf8").digest();
}

/** Constant-time comparison over SHA-256 digests (no length side channel). */
export function constantTimeSecretMatch(candidate: string, expectedSecret: string): boolean {
  if (!expectedSecret) return false;
  return crypto.timingSafeEqual(sha256Buffer(candidate), sha256Buffer(expectedSecret));
}

export function parseCookiesNullProto(cookieHeader: string | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!cookieHeader) return out;
  const bounded = cookieHeader.slice(0, 16384);
  for (const part of bounded.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    if (!key || FORBIDDEN_KEYS.has(key)) continue;
    out[key] = part.slice(eqIdx + 1).trim();
  }
  return out;
}

/**
 * Authentication state of the HTTP server: Bearer checks, cookie sessions bound to the client IP
 * bucket, CSRF validation for cookie mutations, and the per-bucket + global auth-failure limiter.
 * Limits come from `getConfig`; the login and the tokens from the credential directory.
 */
export class HttpAuthGuard {
  readonly #getConfig: () => AppConfig;
  readonly #directory: CredentialDirectory;
  #sessions = new Map<string, WebSessionRecord>();
  #failuresByBucket = new Map<string, number[]>();
  #globalFailures: number[] = [];
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(getConfig: () => AppConfig, directory: CredentialDirectory) {
    this.#getConfig = getConfig;
    this.#directory = directory;
  }

  start(): void {
    if (this.#sweepTimer) return;
    this.#sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.#sweepTimer.unref?.();
  }

  stop(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }

  sweep(nowMs = Date.now()): void {
    const windowMs = this.#getConfig().rateLimitWindowMs;
    this.#globalFailures = this.#globalFailures.filter((tMs) => nowMs - tMs < windowMs);
    for (const [key, stamps] of this.#failuresByBucket.entries()) {
      const fresh = stamps.filter((tMs) => nowMs - tMs < windowMs);
      if (fresh.length === 0) this.#failuresByBucket.delete(key);
      else this.#failuresByBucket.set(key, fresh);
    }
  }

  /** Seconds until the bucket may try again, or `null` when it is not locked out. */
  checkBucket(bucketKey: string, nowMs = Date.now()): number | null {
    const { rateLimitWindowMs: windowMs, rateLimitMaxAuthFailures: maxPerIp } = this.#getConfig();
    const stamps = this.#failuresByBucket.get(bucketKey);
    if (!stamps) return null;
    const fresh = stamps.filter((tMs) => nowMs - tMs < windowMs);
    if (fresh.length === 0) {
      this.#failuresByBucket.delete(bucketKey);
      return null;
    }
    this.#failuresByBucket.set(bucketKey, fresh);
    if (fresh.length >= maxPerIp) {
      const oldest = fresh[0] ?? nowMs;
      return Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 1000));
    }
    return null;
  }

  /**
   * Synchronous credential & brute-force guard:
   * 1. A locked-out bucket is refused unconditionally (even with valid credentials).
   * 2. Valid credentials from a clean bucket pass, so junk from other IPs cannot DoS the admin.
   * 3. The global failure ceiling applies before a new failure is recorded.
   */
  guard(bucketKey: string, isValid: boolean, nowMs = Date.now()): CredentialVerdict {
    const bucketRetrySec = this.checkBucket(bucketKey, nowMs);
    if (bucketRetrySec !== null) {
      return { ok: false, statusCode: 429, retrySec: bucketRetrySec };
    }
    if (isValid) return { ok: true };

    const { rateLimitWindowMs: windowMs, rateLimitMaxAuthFailures } = this.#getConfig();
    const maxGlobal = rateLimitMaxAuthFailures * 8;
    this.#globalFailures = this.#globalFailures.filter((tMs) => nowMs - tMs < windowMs);
    if (this.#globalFailures.length >= maxGlobal) {
      const oldest = this.#globalFailures[0] ?? nowMs;
      return { ok: false, statusCode: 429, retrySec: Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 1000)) };
    }
    this.#recordFailure(bucketKey, nowMs);
    return { ok: false, statusCode: 401 };
  }

  /**
   * Check a console login (scrypt, off the event loop) through the limiter. A locked-out bucket is
   * refused before any hashing, so a flood of guesses cannot keep the thread pool busy.
   */
  async guardLogin(bucketKey: string, candidate: string): Promise<CredentialVerdict> {
    const retrySec = this.checkBucket(bucketKey);
    if (retrySec !== null) return { ok: false, statusCode: 429, retrySec };
    return this.guard(bucketKey, await this.#directory.verifyLogin(candidate));
  }

  /**
   * Check a one-time code through the limiter. `consume` spends the code when it matches, so it runs only
   * once the bucket is known not to be locked out: a valid code typed after a few typos still works later.
   */
  guardCode(bucketKey: string, consume: () => boolean): CredentialVerdict {
    const retrySec = this.checkBucket(bucketKey);
    if (retrySec !== null) return { ok: false, statusCode: 429, retrySec };
    return this.guard(bucketKey, consume());
  }

  /** Validate an `Authorization: Bearer <token>` header through the limiter. */
  guardBearer(bucketKey: string, authHeader: string): CredentialVerdict {
    const verdict = this.guardBearerRole(bucketKey, authHeader);
    return verdict.ok ? { ok: true } : verdict;
  }

  /** Resolve a Bearer token (unknown, revoked and expired ones fail) through the limiter. */
  guardBearerRole(bucketKey: string, authHeader: string): ({ ok: true; role: BearerRole; identity: BearerIdentity }) | Extract<CredentialVerdict, { ok: false }> {
    // "Bearer", whitespace, the token: read without a backtracking pattern (the header is unauthenticated input)
    const token = /^Bearer\s/i.test(authHeader) ? authHeader.slice(6).trim() : "";
    const identity = token ? this.#directory.resolveBearer(token) : null;
    const verdict = this.guard(bucketKey, identity !== null);
    if (!verdict.ok) return verdict;
    if (!identity) return { ok: false, statusCode: 401 };
    return { ok: true, role: identity.scope === "full" ? "full" : "readonly", identity };
  }

  /**
   * Cookie-authenticated state changes need `X-Requested-With: XMLHttpRequest`, a JSON content type
   * and an `Origin` that exactly matches the validated `Host` (and scheme).
   */
  validateCsrf(req: IncomingMessage, validatedHost: string, isHttps: boolean): boolean {
    if (req.headers["x-requested-with"] !== "XMLHttpRequest") return false;
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) return false;
    const rawOrigin = req.headers.origin;
    if (!rawOrigin || rawOrigin === "null") return false;
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(rawOrigin);
    } catch {
      return false;
    }
    if (parsedOrigin.protocol !== (isHttps ? "https:" : "http:")) return false;
    return parsedOrigin.host.toLowerCase() === validatedHost.toLowerCase();
  }

  /** The live cookie session for this request (bound to its IP bucket), or `null`. */
  authenticateCookie(req: IncomingMessage, bucketKey: string): WebSessionRecord | null {
    const sid = parseCookiesNullProto(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (!sid || !/^[0-9a-f]{64}$/.test(sid)) return null;
    const record = this.#sessions.get(sid);
    if (!record) return null;
    if (Date.now() >= record.expiresAtMs) {
      this.#sessions.delete(sid);
      return null;
    }
    return record.clientBucket === bucketKey ? record : null;
  }

  /** Start a fresh session (rotating any previous one presented by the request: no fixation). */
  createSession(req: IncomingMessage, clientBucket: string): WebSessionRecord {
    const previous = parseCookiesNullProto(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (previous) this.#sessions.delete(previous);
    const nowMs = Date.now();
    for (const [id, rec] of this.#sessions.entries()) {
      if (nowMs >= rec.expiresAtMs) this.#sessions.delete(id);
    }
    while (this.#sessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldestKey = this.#sessions.keys().next().value;
      if (oldestKey === undefined) break;
      this.#sessions.delete(oldestKey);
    }
    const session: WebSessionRecord = {
      id: crypto.randomBytes(32).toString("hex"),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + this.#getConfig().sessionTtlMs,
      clientBucket,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  revokeSession(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  revokeAllSessions(): void {
    this.#sessions.clear();
  }

  /** End every session except `keepSessionId` (a password change keeps the caller signed in); returns the ended IDs. */
  revokeAllSessionsExcept(keepSessionId: string | null): string[] {
    const ended = [...this.#sessions.keys()].filter((id) => id !== keepSessionId);
    for (const id of ended) this.#sessions.delete(id);
    return ended;
  }

  sessionCookie(sessionId: string, maxAgeSec: number, isHttps: boolean): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=${sessionId}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${Math.max(0, Math.trunc(maxAgeSec))}`,
    ];
    if (isHttps) parts.push("Secure");
    return parts.join("; ");
  }

  #recordFailure(bucketKey: string, nowMs: number): void {
    this.#globalFailures.push(nowMs);
    let stamps = this.#failuresByBucket.get(bucketKey);
    if (!stamps) {
      if (this.#failuresByBucket.size >= MAX_TRACKED_BUCKETS) {
        this.sweep(nowMs);
        while (this.#failuresByBucket.size >= MAX_TRACKED_BUCKETS) {
          const oldestKey = this.#failuresByBucket.keys().next().value;
          if (oldestKey === undefined) break;
          this.#failuresByBucket.delete(oldestKey);
        }
      }
      stamps = [];
      this.#failuresByBucket.set(bucketKey, stamps);
    }
    stamps.push(nowMs);
  }
}
