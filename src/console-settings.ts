import crypto from "node:crypto";
import { type BehaviourKey, type BehaviourOverrides, sanitizeBehaviourOverrides } from "./behaviour-settings.ts";
import { MAX_TOKENS, type TokenRequest, type TokenScope } from "./console-policy.ts";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature } from "./device-profile.ts";
import { AtomicFileWriter, type StorageCipher, assertKnownDataFormat } from "./encrypted-file.ts";
import type { AppConfig } from "./types.ts";

/**
 * Settings the web console owns, kept encrypted in `settings.json` next to the other stores: the
 * router connection, the console login (an scrypt hash), Bearer tokens (SHA-256 of 256-bit random
 * values) and a few switches. `.env` keeps the bootstrap (DATA_ENCRYPTION_KEY, ports, paths); on the
 * first start of a version with this store, its CPE_* / API_TOKEN* values are imported once, after
 * which the console is authoritative and those `.env` values are ignored.
 */

const FORMAT = 1;
const TOKEN_PREFIX = "fsk_";
const SETUP_CODE_TTL_MS = 24 * 60 * 60_000;
export const RESET_CODE_TTL_MS = 15 * 60_000;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/** A token's last use reaches the disk at most this often (it is exact in memory). */
const LAST_USED_PERSIST_MS = 5 * 60_000;
/** Unambiguous code alphabet (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface CpeConnection {
  url: string;
  username: string;
  password: string;
}

export interface TokenRecord {
  id: string;
  name: string;
  scope: TokenScope;
  /** SHA-256 (hex) of the token: tokens are 256-bit random, so a fast hash is enough. */
  hash: string;
  /** Its last four characters, to tell tokens apart in the list. */
  hint: string;
  createdAtIso: string;
  expiresAtIso: string | null;
  lastUsedAtIso: string | null;
  /** Imported from `.env` (API_TOKEN / API_TOKEN_READONLY) on the first start. */
  imported?: true;
  /**
   * When it was sent to a Telegram group with `/auth`: every member saw it, so it no longer links a
   * chat (it keeps working as a token, and the console points at it to be revoked).
   */
  telegramExposedAtIso?: string;
}

export type PublicTokenRecord = Omit<TokenRecord, "hash">;

/**
 * An owner's informed consent to one experimental write on one router model (multi-model phase 3).
 * Kept only for one model at a time: a router of another model ends them all.
 */
export interface ExperimentalConsent {
  model: string;
  feature: ExperimentalFeature;
  grantedAtIso: string;
}

const EXPERIMENTAL: ReadonlySet<unknown> = new Set<unknown>(EXPERIMENTAL_FEATURES);

/** A stored consent this version can read; anything else is dropped, never half-honoured. */
function isExperimentalConsent(value: unknown): value is ExperimentalConsent {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["model"] === "string" &&
    entry["model"].length > 0 &&
    entry["model"].length <= 256 &&
    EXPERIMENTAL.has(entry["feature"]) &&
    typeof entry["grantedAtIso"] === "string"
  );
}

export interface BearerIdentity {
  tokenId: string;
  name: string;
  scope: TokenScope;
  /** When the token stops working (`null`: never), so a stream it opened ends then too. */
  expiresAtMs: number | null;
}

/** Where the saved router password is also a secret of the console (see `routerPasswordReuse`). */
export interface RouterPasswordReuse {
  /** A live token whose value is the router password (an `.env` import makes one). */
  tokenName: string | null;
  /** The console password is the router password. */
  login: boolean;
}

interface PersistedConsoleSettings {
  format: 1;
  cpe: CpeConnection | null;
  /** `scrypt$N$r$p$salt$key` (base64url). */
  loginHash: string | null;
  loginChangedAtIso: string | null;
  /** The login is still the API_TOKEN imported from `.env`: the console suggests changing it. */
  loginFromEnv: boolean;
  tokens: TokenRecord[];
  /** Linked private Telegram chats may ask for a password reset code with /reset. */
  telegramReset: boolean;
  /** `null` follows METRICS_ENABLED from `.env`. */
  metricsEnabled: boolean | null;
  /** AI master switches, self-healing, alerts and SMS behaviour set in the console; a missing key follows `.env`. */
  behaviour: BehaviourOverrides;
  /** Imported from `.env` and not yet confirmed in the console's guided check. */
  reviewPending: boolean;
  /** Experimental writes the owner turned on (one model at a time). */
  experimental: ExperimentalConsent[];
}

/** `pair` links a private Telegram chat; `pair-group` also links a group (the owner chose so in the console). */
export type OneTimeCodeKind = "setup" | "reset" | "pair" | "pair-group";

/** What `/auth <secret>` does: link the chat, refuse it (a private-chat secret sent to a group), or fail. */
export type TelegramLinkOutcome = "linked" | "private-only" | "invalid";

/** `/auth`'s outcome and the token that linked the chat (`null` for a pairing code): revoking that token unlinks it. */
export interface TelegramLinkDecision {
  outcome: TelegramLinkOutcome;
  tokenId: string | null;
}

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** Default cost: 32 MiB and ~50–100 ms per check, off the event loop (libuv thread pool). */
export const DEFAULT_SCRYPT_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function scryptParams(cost: ScryptCost): crypto.ScryptOptions {
  return { N: cost.N, r: cost.r, p: cost.p, maxmem: 128 * cost.N * cost.r * 2 };
}

function encodeHash(cost: ScryptCost, salt: Buffer, key: Buffer): string {
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function hashLoginSync(secret: string, cost: ScryptCost = DEFAULT_SCRYPT_COST): string {
  const salt = crypto.randomBytes(16);
  return encodeHash(cost, salt, crypto.scryptSync(secret, salt, 32, scryptParams(cost)));
}

export async function hashLogin(secret: string, cost: ScryptCost = DEFAULT_SCRYPT_COST): Promise<string> {
  const salt = crypto.randomBytes(16);
  return encodeHash(cost, salt, await scryptAsync(secret, salt, cost));
}

function scryptAsync(secret: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, scryptParams(cost), (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Check a secret against an encoded hash in constant time; a malformed hash never matches. */
export async function verifyLogin(secret: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0) || N > 2 ** 20) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length < 16 || expected.length !== 32) return false;
  const actual = await scryptAsync(secret, salt, { N, r, p });
  return crypto.timingSafeEqual(actual, expected);
}

function randomCode(): string {
  // randomInt draws without the modulo bias of byte % 31
  const chars = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** Codes are typed by people: case, spaces and dashes do not matter. */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

function defaultState(): PersistedConsoleSettings {
  return {
    format: FORMAT,
    cpe: null,
    loginHash: null,
    loginChangedAtIso: null,
    loginFromEnv: false,
    tokens: [],
    telegramReset: true,
    metricsEnabled: null,
    behaviour: {},
    reviewPending: false,
    experimental: [],
  };
}

export interface ConsoleSettingsOptions {
  filePath: string;
  cipher: StorageCipher;
  now?: () => number;
  /** Lower only in tests. */
  scryptCost?: ScryptCost;
}

export class ConsoleSettings {
  readonly filePath: string;
  #cipher: StorageCipher;
  readonly #writer: AtomicFileWriter;
  readonly #now: () => number;
  readonly #cost: ScryptCost;
  #state: PersistedConsoleSettings = defaultState();
  #byHash = new Map<string, TokenRecord>();
  #codes = new Map<string, { kind: OneTimeCodeKind; expiresAtMs: number }>();
  #persistedUse = new Map<string, number>();

  constructor(opts: ConsoleSettingsOptions) {
    this.filePath = opts.filePath;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
    this.#now = opts.now ?? Date.now;
    this.#cost = opts.scryptCost ?? DEFAULT_SCRYPT_COST;
  }

  /** Load the store; `false` when there is none yet (a first start). */
  load(): boolean {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedConsoleSettings>>(this.filePath);
    assertKnownDataFormat(this.filePath, parsed?.format, FORMAT);
    if (!parsed) return false;
    const tokens = Array.isArray(parsed.tokens) ? parsed.tokens.filter((t) => t && typeof t.hash === "string" && typeof t.id === "string") : [];
    const experimental = Array.isArray(parsed.experimental) ? parsed.experimental.filter(isExperimentalConsent).map((c) => ({ ...c })) : [];
    this.#state = { ...defaultState(), ...parsed, format: FORMAT, tokens, experimental, behaviour: sanitizeBehaviourOverrides(parsed.behaviour) };
    this.#reindex();
    return true;
  }

  /**
   * First start: carry the `.env` setup over, so nothing changes for an existing install. The router
   * connection comes from CPE_*; API_TOKEN (CPE_PASSWORD when unset) becomes the console password
   * and, like API_TOKEN_READONLY, a token existing clients keep using until it is revoked.
   */
  importFromEnv(config: Pick<AppConfig, "cpeUrl" | "cpeUsername" | "cpePassword" | "apiToken" | "apiTokenReadonly">): void {
    const nowIso = new Date(this.#now()).toISOString();
    const state = defaultState();
    if (config.cpePassword) state.cpe = { url: config.cpeUrl, username: config.cpeUsername, password: config.cpePassword };
    if (config.apiToken) {
      state.loginHash = hashLoginSync(config.apiToken, this.#cost);
      state.loginChangedAtIso = nowIso;
      state.loginFromEnv = true;
      state.tokens.push(this.#record("API_TOKEN (.env)", "full", config.apiToken, nowIso, null, true));
    }
    if (config.apiTokenReadonly) state.tokens.push(this.#record("API_TOKEN_READONLY (.env)", "read", config.apiTokenReadonly, nowIso, null, true));
    state.reviewPending = state.cpe !== null || state.loginHash !== null;
    this.#state = state;
    this.#reindex();
  }

  rotateEncryptionKey(cipher: StorageCipher): void {
    this.#cipher = cipher;
  }

  async flush(): Promise<void> {
    await this.#writer.write(() => this.#cipher.serializeJson(this.#state));
  }

  #save(): void {
    void this.flush().catch(() => undefined);
  }

  // ------------------------------------------------------------ router connection and review

  get cpe(): CpeConnection | null {
    return this.#state.cpe ? { ...this.#state.cpe } : null;
  }

  setCpe(connection: CpeConnection): void {
    this.#state.cpe = { ...connection };
    this.#save();
  }

  get reviewPending(): boolean {
    return this.#state.reviewPending;
  }

  markReviewed(): void {
    this.#state.reviewPending = false;
    this.#save();
  }

  // ------------------------------------------------------------ console login

  get loginConfigured(): boolean {
    return this.#state.loginHash !== null;
  }

  get loginFromEnv(): boolean {
    return this.#state.loginFromEnv;
  }

  get loginChangedAtIso(): string | null {
    return this.#state.loginChangedAtIso;
  }

  async verifyLogin(candidate: string): Promise<boolean> {
    const hash = this.#state.loginHash;
    return Boolean(candidate) && hash !== null && (await verifyLogin(candidate, hash));
  }

  async setLogin(password: string): Promise<void> {
    this.#state.loginHash = await hashLogin(password, this.#cost);
    this.#state.loginChangedAtIso = new Date(this.#now()).toISOString();
    this.#state.loginFromEnv = false;
    this.#save();
  }

  // ------------------------------------------------------------ switches

  get telegramReset(): boolean {
    return this.#state.telegramReset;
  }

  setTelegramReset(enabled: boolean): void {
    this.#state.telegramReset = enabled;
    this.#save();
  }

  get metricsEnabled(): boolean | null {
    return this.#state.metricsEnabled;
  }

  setMetricsEnabled(enabled: boolean | null): void {
    this.#state.metricsEnabled = enabled;
    this.#save();
  }

  /** What the console set over `.env` (a missing key follows `.env`). */
  get behaviourOverrides(): BehaviourOverrides {
    return { ...this.#state.behaviour };
  }

  /** Apply a validated patch: a value sets it, `null` goes back to `.env`. */
  setBehaviour(patch: BehaviourOverrides): void {
    const next: Record<string, unknown> = { ...this.#state.behaviour };
    for (const [key, value] of Object.entries(patch) as Array<[BehaviourKey, unknown]>) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    this.#state.behaviour = next as BehaviourOverrides;
    this.#save();
  }

  // ------------------------------------------------------------ experimental writes

  get experimentalConsents(): ExperimentalConsent[] {
    return this.#state.experimental.map((c) => ({ ...c }));
  }

  /** Turn an experimental write on for `model`; consents for any other model end (a router of another model). */
  grantExperimental(model: string, feature: ExperimentalFeature): ExperimentalConsent {
    const consent: ExperimentalConsent = { model, feature, grantedAtIso: new Date(this.#now()).toISOString() };
    this.#state.experimental = [...this.#state.experimental.filter((c) => c.model === model && c.feature !== feature), consent];
    this.#save();
    return { ...consent };
  }

  /** Turn an experimental write off, whatever model it was given for; `false` when it was off. */
  revokeExperimental(feature: string): boolean {
    const before = this.#state.experimental.length;
    this.#state.experimental = this.#state.experimental.filter((c) => c.feature !== feature);
    if (this.#state.experimental.length === before) return false;
    this.#save();
    return true;
  }

  /** The router is `model` now: drop every consent given for another; returns how many. */
  retainExperimentalFor(model: string): number {
    const before = this.#state.experimental.length;
    this.#state.experimental = this.#state.experimental.filter((c) => c.model === model);
    const dropped = before - this.#state.experimental.length;
    if (dropped > 0) this.#save();
    return dropped;
  }

  // ------------------------------------------------------------ Bearer tokens

  #record(name: string, scope: TokenScope, token: string, nowIso: string, expiresAtIso: string | null, imported = false): TokenRecord {
    return {
      id: crypto.randomUUID(),
      name,
      scope,
      hash: sha256Hex(token),
      hint: token.slice(-4),
      createdAtIso: nowIso,
      expiresAtIso,
      lastUsedAtIso: null,
      ...(imported ? { imported: true as const } : {}),
    };
  }

  #reindex(): void {
    this.#byHash = new Map(this.#state.tokens.map((t) => [t.hash, t]));
  }

  listTokens(): PublicTokenRecord[] {
    return this.#state.tokens.map(({ hash: _hash, ...rest }) => ({ ...rest }));
  }

  /** Mint a token; the value is returned once and only its hash is kept. */
  createToken(input: TokenRequest): { token: string; record: PublicTokenRecord } {
    if (this.#state.tokens.length >= MAX_TOKENS) throw new Error(`At most ${MAX_TOKENS} tokens; revoke one first`);
    const nowMs = this.#now();
    const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAtIso = input.lifetimeDays === null ? null : new Date(nowMs + input.lifetimeDays * 86_400_000).toISOString();
    const record = this.#record(input.name, input.scope, token, new Date(nowMs).toISOString(), expiresAtIso);
    this.#state.tokens.push(record);
    this.#byHash.set(record.hash, record);
    this.#save();
    const { hash: _hash, ...visible } = record;
    return { token, record: visible };
  }

  revokeToken(id: string): PublicTokenRecord | null {
    const index = this.#state.tokens.findIndex((t) => t.id === id);
    if (index < 0) return null;
    const [removed] = this.#state.tokens.splice(index, 1);
    if (!removed) return null;
    this.#byHash.delete(removed.hash);
    this.#save();
    const { hash: _hash, ...visible } = removed;
    return visible;
  }

  /** The identity behind a Bearer token, or `null` (unknown, revoked or expired). */
  resolveBearer(token: string): BearerIdentity | null {
    if (!token) return null;
    const record = this.#byHash.get(sha256Hex(token));
    if (!record) return null;
    const nowMs = this.#now();
    if (record.expiresAtIso !== null && Date.parse(record.expiresAtIso) <= nowMs) return null;
    record.lastUsedAtIso = new Date(nowMs).toISOString();
    if (nowMs - (this.#persistedUse.get(record.id) ?? 0) >= LAST_USED_PERSIST_MS) {
      this.#persistedUse.set(record.id, nowMs);
      this.#save();
    }
    return { tokenId: record.id, name: record.name, scope: record.scope, expiresAtMs: record.expiresAtIso === null ? null : Date.parse(record.expiresAtIso) };
  }

  /**
   * Whether the saved router password also opens the console: as a live token (the first start
   * imports API_TOKEN, which falls back to CPE_PASSWORD) or as the console password. Either puts the
   * router's admin password into client configs or Telegram. Uses nothing: no token's last use moves.
   */
  async routerPasswordReuse(): Promise<RouterPasswordReuse> {
    const password = this.#state.cpe?.password ?? "";
    if (!password) return { tokenName: null, login: false };
    const record = this.#byHash.get(sha256Hex(password));
    const live = record !== undefined && (record.expiresAtIso === null || Date.parse(record.expiresAtIso) > this.#now());
    return { tokenName: live ? record.name : null, login: await this.verifyLogin(password) };
  }

  // ------------------------------------------------------------ one-time codes

  /** Issue a one-time code (setup: until used or a day; reset: 15 min; pairing: 10 min). */
  issueCode(kind: OneTimeCodeKind): string {
    // One live setup code at a time; earlier reset / pairing codes stay valid until they expire
    if (kind === "setup") for (const [code, entry] of this.#codes) if (entry.kind === "setup") this.#codes.delete(code);
    const code = randomCode();
    const ttl = kind === "setup" ? SETUP_CODE_TTL_MS : kind === "reset" ? RESET_CODE_TTL_MS : PAIRING_CODE_TTL_MS;
    this.#codes.set(normalizeCode(code), { kind, expiresAtMs: this.#now() + ttl });
    return code;
  }

  /**
   * Decide a Telegram `/auth` secret. A group pairing code links any chat; a private pairing code or a
   * full-access token links a private chat only. A private code sent to a group is spent there all
   * the same: the members saw it and could otherwise link their own private chats with it. A full
   * token sent to a group never links a chat again for the same reason (revoking it, which would cut
   * off whatever else uses it, stays the owner's call).
   */
  linkTelegramChat(secret: string, where: "private" | "group"): TelegramLinkOutcome {
    return this.decideTelegramLink(secret, where).outcome;
  }

  /** `linkTelegramChat`, naming the token that linked the chat so revoking it can unlink the chat too. */
  decideTelegramLink(secret: string, where: "private" | "group"): TelegramLinkDecision {
    if (this.consumeCode("pair-group", secret)) return { outcome: "linked", tokenId: null };
    if (this.consumeCode("pair", secret)) return { outcome: where === "private" ? "linked" : "private-only", tokenId: null };
    const identity = this.resolveBearer(secret);
    const record = identity?.scope === "full" ? this.#state.tokens.find((t) => t.id === identity.tokenId) : undefined;
    if (!record) return { outcome: "invalid", tokenId: null };
    if (where === "group") {
      record.telegramExposedAtIso ??= new Date(this.#now()).toISOString();
      this.#save();
      return { outcome: "private-only", tokenId: null };
    }
    return record.telegramExposedAtIso === undefined ? { outcome: "linked", tokenId: record.id } : { outcome: "invalid", tokenId: null };
  }

  /** Spend a code of `kind`: `true` once, for an unexpired match. */
  consumeCode(kind: OneTimeCodeKind, candidate: string): boolean {
    const nowMs = this.#now();
    for (const [code, entry] of this.#codes) if (entry.expiresAtMs <= nowMs) this.#codes.delete(code);
    const wanted = sha256Hex(normalizeCode(candidate));
    for (const [code, entry] of this.#codes) {
      if (entry.kind !== kind) continue;
      if (crypto.timingSafeEqual(Buffer.from(sha256Hex(code), "hex"), Buffer.from(wanted, "hex"))) {
        this.#codes.delete(code);
        return true;
      }
    }
    return false;
  }
}

/** How long a `cpe-dash reset-login` proof stays valid. */
export const RESET_PROOF_WINDOW_MS = 60_000;

/**
 * Proof that the caller can read the daemon's `.env` (its data key): what `cpe-dash reset-login`
 * sends to the local daemon to be handed a reset code. `<unix ms>.<HMAC-SHA256 hex>`.
 */
export function resetLoginProof(dataKey: string, nowMs: number): string {
  return `${nowMs}.${crypto.createHmac("sha256", dataKey).update(`fengsui-reset-login|${nowMs}`).digest("hex")}`;
}

export function verifyResetLoginProof(dataKey: string, proof: string, nowMs: number): boolean {
  const [ts, mac] = proof.split(".");
  const issuedMs = Number(ts);
  if (!Number.isSafeInteger(issuedMs) || Math.abs(nowMs - issuedMs) > RESET_PROOF_WINDOW_MS || !mac || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const expected = resetLoginProof(dataKey, issuedMs).split(".")[1] ?? "";
  return crypto.timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"));
}

