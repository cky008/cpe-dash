import { CpeControlValidationError } from "./control-error.ts";

/**
 * Console account rules, shared by the daemon, the web console and the online demo (no
 * dependencies): console password length, and the name, scope and lifetime of a new token.
 */

/** Console passwords: long enough to resist guessing at the limiter's pace, short enough to type. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;
/** Lifetimes the console offers; `null` never expires. */
export const TOKEN_LIFETIMES_DAYS = [1, 7, 30, 90, 365] as const;
export const MAX_TOKENS = 50;
const MAX_TOKEN_NAME_LENGTH = 64;

export type TokenScope = "full" | "read";

/**
 * What a token may do besides reading the router's data, through REST and MCP alike: read SMS and
 * contacts, change the router (locks, switches, reconnect, reboot), manage devices' internet access,
 * and send / delete SMS or edit contacts. Agents' MCP writes still need the console's master switches.
 */
export const TOKEN_PERMISSIONS = ["sms-read", "control", "access", "sms-write"] as const;
export type TokenPermission = (typeof TOKEN_PERMISSIONS)[number];

/** The old scopes: a read-only token read SMS too, a full one could do everything. */
export function permissionsForScope(scope: TokenScope): TokenPermission[] {
  return scope === "full" ? [...TOKEN_PERMISSIONS] : ["sms-read"];
}

/** The scope a client that knows only scopes (or an older FengSui) sees: full only with every permission. */
export function scopeForPermissions(permissions: ReadonlyArray<TokenPermission>): TokenScope {
  return TOKEN_PERMISSIONS.every((permission) => permissions.includes(permission)) ? "full" : "read";
}

/** For the audit log: the old scope names where they fit, else the permissions. */
export function describePermissions(permissions: ReadonlyArray<TokenPermission>): string {
  if (scopeForPermissions(permissions) === "full") return "full";
  if (permissions.length === 1 && permissions[0] === "sms-read") return "read";
  return permissions.length === 0 ? "read, no SMS" : `read + ${permissions.join(" + ")}`;
}

/** Whether `permissions` cover `needed` (`all`: every permission, for a change no single permission names). */
export function tokenMay(permissions: ReadonlyArray<TokenPermission>, needed: TokenPermission | "all"): boolean {
  return needed === "all" ? TOKEN_PERMISSIONS.every((permission) => permissions.includes(permission)) : permissions.includes(needed);
}

/** A list of permissions: each known, none twice; returned in the canonical order. */
export function readTokenPermissions(raw: unknown): TokenPermission[] {
  const known: ReadonlyArray<unknown> = TOKEN_PERMISSIONS;
  if (!Array.isArray(raw) || raw.some((entry) => !known.includes(entry)) || new Set(raw).size !== raw.length) {
    throw new CpeControlValidationError(`"permissions" must list some of ${TOKEN_PERMISSIONS.map((p) => `"${p}"`).join(", ")}, each once`);
  }
  return TOKEN_PERMISSIONS.filter((permission) => raw.includes(permission));
}

export interface TokenRequest {
  name: string;
  permissions: TokenPermission[];
  lifetimeDays: number | null;
}

export function validateNewPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) {
    throw new CpeControlValidationError(`The console password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
  }
  return raw;
}

/** `{ name, permissions, lifetimeDays }` of a token to mint (`scope` is still accepted). */
export function readTokenRequest(body: Readonly<Record<string, unknown>>): TokenRequest {
  const rawName = body["name"];
  if (rawName !== undefined && rawName !== null && (typeof rawName !== "string" || rawName.length > MAX_TOKEN_NAME_LENGTH)) {
    throw new CpeControlValidationError(`"name" must be text of at most ${MAX_TOKEN_NAME_LENGTH} characters`);
  }
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new CpeControlValidationError("Give the token a name (who or what will use it)");
  // `permissions`, or the older `scope` ("read": read SMS too; "full": everything)
  let permissions: TokenPermission[];
  if (body["permissions"] !== undefined) {
    permissions = readTokenPermissions(body["permissions"]);
  } else {
    const scope = body["scope"];
    if (scope !== "full" && scope !== "read") throw new CpeControlValidationError('Give "permissions" (or "scope": "full" or "read")');
    permissions = permissionsForScope(scope);
  }
  const lifetime = body["lifetimeDays"];
  const lifetimeDays = lifetime === null ? null : (TOKEN_LIFETIMES_DAYS as ReadonlyArray<unknown>).includes(lifetime) ? (lifetime as number) : undefined;
  if (lifetimeDays === undefined) throw new CpeControlValidationError(`"lifetimeDays" must be one of ${TOKEN_LIFETIMES_DAYS.join(", ")} or null`);
  return { name, permissions, lifetimeDays };
}
