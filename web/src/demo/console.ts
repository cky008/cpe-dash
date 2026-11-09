import type {
  ApiErrorEnvelope,
  AuditResponse,
  ConsoleSettingsResponse,
  CreateTokenResponse,
  DeviceAccessSnapshot,
  ExperimentalWritesResponse,
  PairingCodeResponse,
  RevokeTokenResponse,
  TokenPermissionsResponse,
  SaveConnectionResponse,
  TelegramChatRecord,
  TelegramChatsResponse,
  TokensResponse,
} from "../../../src/api-contract.ts";
import type { AuditActor, AuditEntry, AuditOutcome } from "../../../src/audit-log.ts";
import { BEHAVIOUR_ENV, type BehaviourOverrides, type BehaviourValues, describeBehaviour, readBehaviourPatch, resolveBehaviour } from "../../../src/behaviour-settings.ts";
import { MAX_TOKENS, describePermissions, readTokenPermissions, readTokenRequest, scopeForPermissions, validateNewPassword } from "../../../src/console-policy.ts";
import { WRITE_FEATURES } from "../../../src/device-access.ts";
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
  /** What the demo's `.env` says for the behaviour settings (as `npm run demo` runs it). */
  behaviourEnv: BehaviourValues;
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
  readonly #behaviourEnv: BehaviourValues;
  #behaviour: BehaviourOverrides = {};
  #tokens: PublicTokenRecord[];
  /** Linked with /auth (newest first), then the one TELEGRAM_CHAT_IDS lists, as the daemon orders them. */
  #chats: TelegramChatRecord[];

  constructor(opts: DemoConsoleOptions) {
    this.#now = opts.now;
    this.#behaviourEnv = opts.behaviourEnv;
    this.#random = opts.random;
    this.#device = opts.device;
    const now = this.#now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    this.#loginChangedAtIso = iso(now - 21 * DAY_MS);
    this.#tokens = [
      // A dashboard reads the router only; an agent also reads SMS (what a read-only token did before permissions)
      { id: globalThis.crypto.randomUUID(), name: "Grafana", scope: "read", permissions: [], hint: this.#chars(TOKEN_ALPHABET, 4), createdAtIso: iso(now - 20 * DAY_MS), expiresAtIso: null, lastUsedAtIso: iso(now - 25_000) },
      {
        id: globalThis.crypto.randomUUID(),
        name: "Claude Code",
        scope: "read",
        permissions: ["sms-read"],
        hint: this.#chars(TOKEN_ALPHABET, 4),
        createdAtIso: iso(now - 6 * DAY_MS),
        expiresAtIso: iso(now + 84 * DAY_MS),
        lastUsedAtIso: iso(now - 2 * 3_600_000),
      },
    ];
    // The owner's own chat (Telegram IDs are placeholders), a family group they linked, and one from .env
    const chat = (chatId: string, extra: Partial<TelegramChatRecord>): TelegramChatRecord => ({
      chatId,
      kind: chatId.startsWith("-") ? "group" : "private",
      fromEnv: false,
      linkedWith: null,
      tokenName: null,
      linkedBy: null,
      topic: null,
      linkedAtIso: null,
      ...extra,
    });
    this.#chats = [
      chat("-1002", { linkedWith: "group-code", linkedBy: "1001", topic: 7, linkedAtIso: iso(now - 2 * DAY_MS) }),
      chat("1001", { linkedWith: "code", linkedAtIso: iso(now - 12 * DAY_MS) }),
      chat("1003", { fromEnv: true }),
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
      behaviour: describeBehaviour(this.#behaviourEnv, this.#behaviour),
    };
  }

  /** The behaviour settings in force (the visitor's choices over the demo's `.env`). */
  get behaviourValues(): BehaviourValues {
    return resolveBehaviour(this.#behaviourEnv, this.#behaviour);
  }

  /** `POST /api/console/behaviour`, as the daemon checks it. */
  behaviour(body: Body): ConsoleSettingsResponse {
    const patch = readBehaviourPatch(body);
    const next: Record<string, unknown> = { ...this.#behaviour };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.#behaviour = next as BehaviourOverrides;
    const detail = Object.entries(patch)
      .map(([key, value]) => `${BEHAVIOUR_ENV[key as keyof typeof BEHAVIOUR_ENV]} ${value === null ? "from .env" : String(value)}`)
      .join(", ");
    this.record("settings.behaviour", "applied", detail);
    return this.summary();
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
    const { name, permissions, lifetimeDays } = readTokenRequest(body);
    if (this.#tokens.length >= MAX_TOKENS) throw new CpeControlValidationError(`At most ${MAX_TOKENS} tokens; revoke one first`);
    const token = `fsk_${this.#chars(TOKEN_ALPHABET, 43)}`;
    const now = this.#now();
    const record: PublicTokenRecord = {
      id: globalThis.crypto.randomUUID(),
      name,
      scope: scopeForPermissions(permissions),
      permissions,
      hint: token.slice(-4),
      createdAtIso: new Date(now).toISOString(),
      expiresAtIso: lifetimeDays === null ? null : new Date(now + lifetimeDays * DAY_MS).toISOString(),
      lastUsedAtIso: null,
    };
    this.#tokens.push(record);
    this.record("token.create", "applied", `${name} (${describePermissions(permissions)}, ${lifetimeDays === null ? "never expires" : `${lifetimeDays} d`})`);
    return { ok: true, token, record: { ...record } };
  }

  /** `POST /api/console/tokens/permissions`, as the daemon checks it. */
  tokenPermissions(body: Body): TokenPermissionsResponse {
    const id = typeof body["id"] === "string" ? body["id"] : "";
    const permissions = readTokenPermissions(body["permissions"]);
    const token = this.#tokens.find((t) => t.id === id);
    if (!token) throw new DemoRefusal(404, { ok: false, errorCode: "NOT_FOUND", message: "No such token" });
    token.permissions = permissions;
    token.scope = scopeForPermissions(permissions);
    this.record("token.permissions", "applied", `${token.name}: ${describePermissions(permissions)}`);
    return { ok: true, record: { ...token, permissions: [...permissions] } };
  }

  revokeToken(body: Body): RevokeTokenResponse {
    const index = this.#tokens.findIndex((token) => token.id === body["id"]);
    const [revoked] = index < 0 ? [] : this.#tokens.splice(index, 1);
    if (!revoked) throw new DemoRefusal(404, { ok: false, errorCode: "NOT_FOUND", message: "No such token" });
    this.record("token.revoke", "applied", revoked.name);
    return { ok: true, record: revoked };
  }

  /** The demo has no bot to name, so a group code's command is the plain `/auth CODE`. */
  pairingCode(body: Body): PairingCodeResponse {
    const group = body["group"] ?? false;
    if (typeof group !== "boolean") throw new CpeControlValidationError('"group" must be true or false');
    this.record("telegram.pairing-code", "applied", group ? "group" : null);
    const code = `${this.#chars(CODE_ALPHABET, 4)}-${this.#chars(CODE_ALPHABET, 4)}`;
    return { ok: true, code, expiresInSec: PAIRING_CODE_SEC, group, command: `/auth ${code}` };
  }

  telegramChats(): TelegramChatsResponse {
    return { ok: true, chats: this.#chats.map((chat) => ({ ...chat })) };
  }

  /** `POST /api/console/telegram/unlink`, with the daemon's checks and messages. */
  unlinkTelegramChat(body: Body): TelegramChatsResponse {
    const raw = body["chatId"];
    if (raw !== undefined && raw !== null && (typeof raw !== "string" || raw.length > 24)) throw new CpeControlValidationError('"chatId" must be text of at most 24 characters');
    const chatId = (typeof raw === "string" ? raw : "").trim();
    if (!/^-?\d{1,20}$/.test(chatId)) throw new CpeControlValidationError('"chatId" must be a Telegram chat ID, e.g. 1001 or -1001');
    const linked = this.#chats.find((chat) => chat.chatId === chatId && chat.linkedWith !== null);
    if (!linked) {
      const fromEnv = this.#chats.some((chat) => chat.chatId === chatId && chat.fromEnv);
      throw new DemoRefusal(404, { ok: false, errorCode: "NOT_FOUND", message: fromEnv ? "TELEGRAM_CHAT_IDS in .env authorizes this chat: remove it there" : "No chat linked with /auth has this ID" });
    }
    this.#unlink(linked);
    this.record("telegram.unlink", "applied", `${linked.kind} chat …${chatId.slice(-3)}`);
    return this.telegramChats();
  }

  /** Every chat linked with /auth goes; the one TELEGRAM_CHAT_IDS lists stays. */
  unlinkTelegram(): { ok: true; unlinked: number } {
    const linked = this.#chats.filter((chat) => chat.linkedWith !== null);
    for (const chat of linked) this.#unlink(chat);
    this.record("telegram.unlink-all", "applied", `${linked.length} chat(s)`);
    return { ok: true, unlinked: linked.length };
  }

  /** A chat .env also lists stays, after the linked ones, like the daemon lists it. */
  #unlink(chat: TelegramChatRecord): void {
    this.#chats.splice(this.#chats.indexOf(chat), 1);
    if (chat.fromEnv) this.#chats.push({ ...chat, linkedWith: null, tokenName: null, linkedBy: null, topic: null, linkedAtIso: null });
  }

  /**
   * `POST /api/console/experimental` as the daemon answers it. The demo's router is the verified
   * H168-383, so every write is already open: turning one on is refused the daemon's way, turning
   * one off changes nothing. Both are audited like the daemon does.
   */
  experimental(body: Body, device: DeviceAccessSnapshot): ExperimentalWritesResponse {
    const feature = body["feature"];
    if (typeof feature !== "string" || !(WRITE_FEATURES as ReadonlyArray<string>).includes(feature)) {
      throw new CpeControlValidationError(`"feature" must be one of ${WRITE_FEATURES.join(", ")}`);
    }
    if (typeof body["enabled"] !== "boolean") throw new CpeControlValidationError('"enabled" must be true or false');
    const view: ExperimentalWritesResponse = { ok: true, device, consents: [], writes: [] };
    if (!body["enabled"]) {
      this.record("settings.experimental", "applied", `${feature} off (was off)`);
      return view;
    }
    const state = device.features[feature as keyof DeviceAccessSnapshot["features"]];
    this.record("settings.experimental", "refused", `${feature} on: ${state}`);
    throw new DemoRefusal(409, {
      ok: false,
      errorCode: "EXPERIMENTAL_UNAVAILABLE",
      message: `${feature} cannot be turned on as an experimental write on this router (${state})`,
      state,
    });
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

  /** Given fields, the stored ones for anything left out (the daemon's rules: the stored password only for the stored address). */
  #candidate(body: Body): { url: string; username: string } {
    const given = (key: string, stored: string): string => {
      const value = body[key];
      return typeof value === "string" ? value.trim() : stored;
    };
    const url = given("url", this.#cpe.url);
    if (!url) throw new CpeControlValidationError('"url" is required, e.g. http://192.168.8.1');
    if (!(typeof body["password"] === "string" && body["password"]) && !this.#isStored(url)) {
      throw new CpeControlValidationError('"password" is required to try another router address');
    }
    return { url, username: given("username", this.#cpe.username) || "admin" };
  }

  #isStored(url: string): boolean {
    try {
      return normalizedUrl(url) === this.#cpe.url;
    } catch {
      return false;
    }
  }

  #chars(alphabet: string, length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.#random() * alphabet.length)] ?? alphabet[0];
    return out;
  }
}
