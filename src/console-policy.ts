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

export interface TokenRequest {
  name: string;
  scope: TokenScope;
  lifetimeDays: number | null;
}

export function validateNewPassword(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < MIN_PASSWORD_LENGTH || raw.length > MAX_PASSWORD_LENGTH) {
    throw new CpeControlValidationError(`The console password needs ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters`);
  }
  return raw;
}

/** `{ name, scope, lifetimeDays }` of a token to mint. */
export function readTokenRequest(body: Readonly<Record<string, unknown>>): TokenRequest {
  const rawName = body["name"];
  if (rawName !== undefined && rawName !== null && (typeof rawName !== "string" || rawName.length > MAX_TOKEN_NAME_LENGTH)) {
    throw new CpeControlValidationError(`"name" must be text of at most ${MAX_TOKEN_NAME_LENGTH} characters`);
  }
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new CpeControlValidationError("Give the token a name (who or what will use it)");
  const scope = body["scope"];
  if (scope !== "full" && scope !== "read") throw new CpeControlValidationError('"scope" must be "full" or "read"');
  const lifetime = body["lifetimeDays"];
  const lifetimeDays = lifetime === null ? null : (TOKEN_LIFETIMES_DAYS as ReadonlyArray<unknown>).includes(lifetime) ? (lifetime as number) : undefined;
  if (lifetimeDays === undefined) throw new CpeControlValidationError(`"lifetimeDays" must be one of ${TOKEN_LIFETIMES_DAYS.join(", ")} or null`);
  return { name, scope, lifetimeDays };
}
