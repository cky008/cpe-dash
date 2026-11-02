import type {
  ApiErrorEnvelope,
  AuditResponse,
  ConsoleSettingsResponse,
  CreateTokenResponse,
  PairingCodeResponse,
  RevokeTokenResponse,
  SaveConnectionResponse,
  TokensResponse,
} from "../../../src/api-contract.ts";
import type { AuditActor, AuditEntry, AuditOutcome } from "../../../src/audit-log.ts";
import { MAX_TOKENS, readTokenRequest, validateNewPassword } from "../../../src/console-policy.ts";
import type { PublicTokenRecord } from "../../../src/console-settings.ts";
import { CpeControlValidationError } from "../../../src/control-error.ts";
import type { ConnectionTestResult } from "../../../src/scheduler.ts";

type Body = Readonly<Record<string, unknown>>;

const DAY_MS = 86_400_000;
const AUDIT_MAX = 500;
const PAIRING_CODE_SEC = 600;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Where a router can live: RFC 1918, RFC 6598 and loopback. */
const PRIVATE_IPV4 = /^(?:10|127)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** A refusal with the status and envelope the daemon would answer. */
export class DemoRefusal extends Error {
  readonly status: number;
  readonly envelope: ApiErrorEnvelope;

  constructor(status: number, envelope: ApiErrorEnvelope) {
    super(envelope.message);
    this.status = status;
    this.envelope = envelope;
  }
}

/** Why the daemon (normalizeCpeUrl) would refuse a router address, or `null`. */
function urlProblem(raw: string): string | null {
  let text = raw;
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return "Only http: and https: router addresses are allowed";
    text = `http://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Not a valid URL";
  }
  if (url.username || url.password) return "The router address must not embed credentials";
  if (url.search) return "The router address must not contain query parameters";
  if (url.hostname !== "localhost" && !PRIVATE_IPV4.test(url.hostname)) return "The router address must be a LAN or private address";
  return null;
}

/** The address as the daemon stores it: scheme added, trailing slashes dropped. */
function normalizedUrl(raw: string): string {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export interface DemoConsoleOptions {
  now: () => number;
  random: () => number;
  /** What a connection test reports back: the demo router's own model, firmware and login. */
  device: Pick<Extract<ConnectionTestResult, { ok: true }>, "model" | "firmware" | "loginScheme" | "tokenFlow" | "ecc">;
}

/**
 * The demo's console settings and audit log, in memory. With no router behind it, every LAN
 * address "connects", minted tokens and codes open nothing, and the log keeps what the visitor
 * did in this page (plus a few entries so it does not start empty).
 */
export class DemoConsole {
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #device: DemoConsoleOptions["device"];
  readonly #audit: AuditEntry[] = [];
  #cpe = { url: "http://192.168.8.1", username: "admin" };
  #loginChangedAtIso: string;
  #telegramReset = true;
  #metrics: boolean | null = null;
  #tokens: PublicTokenRecord[];

  constructor(opts: DemoConsoleOptions) {
    this.#now = opts.now;
    this.#random = opts.random;
    this.#device = opts.device;
    const now = this.#now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    this.#loginChangedAtIso = iso(now - 21 * DAY_MS);
    this.#tokens = [
      { id: globalThis.crypto.randomUUID(), name: "Grafana", scope: "read", hint: this.#chars(TOKEN_ALPHABET, 4), createdAtIso: iso(now - 20 * DAY_MS), expiresAtIso: null, lastUsedAtIso: iso(now - 25_000) },
      {
        id: globalThis.crypto.randomUUID(),
        name: "Claude Code",
        scope: "read",
        hint: this.#chars(TOKEN_ALPHABET, 4),
        createdAtIso: iso(now - 6 * DAY_MS),
        expiresAtIso: iso(now + 84 * DAY_MS),
        lastUsedAtIso: iso(now - 2 * 3_600_000),
      },
    ];
    this.record("token.create", "applied", "Grafana (read, never expires)", { channel: "web" }, now - 20 * DAY_MS);
    this.record("token.create", "applied", "Claude Code (read, 90 d)", { channel: "web" }, now - 6 * DAY_MS);
    this.record("login", "applied", "from 192.168.8.20", { channel: "web" }, now - 3 * 3_600_000);
  }

  record(action: string, outcome: AuditOutcome, detail: string | null, actor: AuditActor = { channel: "web" }, atMs = this.#now()): void {
    this.#audit.push({ tsIso: new Date(atMs).toISOString(), channel: actor.channel, label: actor.label ?? null, action, outcome, detail });
    if (this.#audit.length > AUDIT_MAX) this.#audit.splice(0, this.#audit.length - AUDIT_MAX);
  }

  summary(): ConsoleSettingsResponse {
    return {
      ok: true,
      cpe: { ...this.#cpe, passwordSet: true },
      login: { changedAtIso: this.#loginChangedAtIso, fromEnv: false },
      reviewPending: false,
      telegram: { configured: true, resetEnabled: this.#telegramReset },
      metrics: { enabled: this.#metrics ?? false, source: this.#metrics === null ? "env" : "console", envEnabled: false },
    };
  }

  /** The connection a body asks for; anything left out keeps the stored value, like the daemon. */
  test(body: Body): ConnectionTestResult {
    const problem = urlProblem(this.#candidate(body).url);
    if (problem) return { ok: false, reason: "invalid_url", code: null, remainCount: null, waitTimeSec: null, message: problem };
    return { ok: true, holdMs: 80 + Math.round(this.#random() * 160), ...this.#device };
  }

  save(body: Body): SaveConnectionResponse {
    const result = this.test(body);
    if (!result.ok) {
      this.record("settings.cpe", "refused", `test failed: ${result.reason}`);
      throw new DemoRefusal(400, { ok: false, errorCode: "CPE_TEST_FAILED", message: result.message, connectionTest: result });
    }
    const candidate = this.#candidate(body);
    const url = normalizedUrl(candidate.url);
    this.#cpe = { url, username: candidate.username };
    this.record("settings.cpe", "applied", `router ${new URL(url).host} as ${candidate.username}`);
    return { ok: true, result, settings: this.summary() };
  }

  review(): ConsoleSettingsResponse {
    this.record("settings.review", "applied", null);
    return this.summary();
  }

  /** The demo has no console password to check, so every non-empty current one is accepted. */
  changePassword(body: Body): ConsoleSettingsResponse {
    validateNewPassword(body["next"]);
    if (typeof body["current"] !== "string" || !body["current"]) {
      this.record("settings.password", "refused", "wrong current password");
      throw new DemoRefusal(403, { ok: false, errorCode: "WRONG_PASSWORD", message: "The current console password is wrong" });
    }
    this.#loginChangedAtIso = new Date(this.#now()).toISOString();
    this.record("settings.password", "applied", "other console sessions signed out");
    return this.summary();
  }

  tokens(): TokensResponse {
    return { ok: true, tokens: this.#tokens.map((token) => ({ ...token })) };
  }

  createToken(body: Body): CreateTokenResponse {
    const { name, scope, lifetimeDays } = readTokenRequest(body);
    if (this.#tokens.length >= MAX_TOKENS) throw new CpeControlValidationError(`At most ${MAX_TOKENS} tokens; revoke one first`);
    const token = `fsk_${this.#chars(TOKEN_ALPHABET, 43)}`;
    const now = this.#now();
    const record: PublicTokenRecord = {
      id: globalThis.crypto.randomUUID(),
      name,
      scope,
      hint: token.slice(-4),
      createdAtIso: new Date(now).toISOString(),
      expiresAtIso: lifetimeDays === null ? null : new Date(now + lifetimeDays * DAY_MS).toISOString(),
      lastUsedAtIso: null,
    };
    this.#tokens.push(record);
    this.record("token.create", "applied", `${name} (${scope}, ${lifetimeDays === null ? "never expires" : `${lifetimeDays} d`})`);
    return { ok: true, token, record: { ...record } };
  }

  revokeToken(body: Body): RevokeTokenResponse {
    const index = this.#tokens.findIndex((token) => token.id === body["id"]);
    const [revoked] = index < 0 ? [] : this.#tokens.splice(index, 1);
    if (!revoked) throw new DemoRefusal(404, { ok: false, errorCode: "NOT_FOUND", message: "No such token" });
    this.record("token.revoke", "applied", revoked.name);
    return { ok: true, record: revoked };
  }

  pairingCode(): PairingCodeResponse {
    this.record("telegram.pairing-code", "applied", null);
    return { ok: true, code: `${this.#chars(CODE_ALPHABET, 4)}-${this.#chars(CODE_ALPHABET, 4)}`, expiresInSec: PAIRING_CODE_SEC };
  }

  /** The demo has no bot, so no chat was ever linked. */
  unlinkTelegram(): { ok: true; unlinked: number } {
    this.record("telegram.unlink-all", "applied", "0 chat(s)");
    return { ok: true, unlinked: 0 };
  }

  switches(body: Body): ConsoleSettingsResponse {
    const changes: string[] = [];
    const reset = body["telegramReset"];
    if (reset !== undefined) {
      if (typeof reset !== "boolean") throw new CpeControlValidationError('"telegramReset" must be true or false');
      this.#telegramReset = reset;
      changes.push(`telegram reset ${reset ? "on" : "off"}`);
    }
    const metrics = body["metricsEnabled"];
    if (metrics !== undefined) {
      if (metrics !== null && typeof metrics !== "boolean") throw new CpeControlValidationError('"metricsEnabled" must be true, false or null (follow .env)');
      this.#metrics = metrics;
      changes.push(`metrics ${metrics === null ? "from .env" : metrics ? "on" : "off"}`);
    }
    if (changes.length === 0) throw new CpeControlValidationError("Nothing to change");
    this.record("settings.switches", "applied", changes.join(", "));
    return this.summary();
  }

  /** Newest first, like the daemon's log. */
  audit(query: URLSearchParams): AuditResponse {
    const limit = Number.parseInt(query.get("limit") ?? "200", 10);
    const count = Math.min(AUDIT_MAX, Math.max(1, Number.isFinite(limit) ? limit : 200));
    return { ok: true, entries: this.#audit.slice(-count).reverse() };
  }

  /** Given fields, the stored ones for anything left out (the daemon's rules). */
  #candidate(body: Body): { url: string; username: string } {
    const given = (key: string, stored: string): string => {
      const value = body[key];
      return typeof value === "string" ? value.trim() : stored;
    };
    const url = given("url", this.#cpe.url);
    if (!url) throw new CpeControlValidationError('"url" is required, e.g. http://192.168.8.1');
    return { url, username: given("username", this.#cpe.username) || "admin" };
  }

  #chars(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.#random() * alphabet.length)] ?? alphabet[0];
    return out;
  }
}
