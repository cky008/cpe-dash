import crypto from "node:crypto";
import { LOGIN_UNCONFIRMED_CODE } from "../cpe-auth.ts";
import { CpeApiError } from "../session-errors.ts";

/**
 * Login outcomes of the driver families in the HiLink codes the session client and the scheduler
 * already act on (`src/drivers/client.ts`): a wrong password and a locked login latch the breaker,
 * someone signed in elsewhere makes FengSui yield, and an answer it cannot place latches as well
 * rather than risk another attempt. Hashes here are the ones the routers' own login pages compute.
 */

/** The router refused the password (`108006`); `remain`: attempts it says are left. */
export function wrongPassword(detail: string, remain: number | null = null): CpeApiError {
  return new CpeApiError("108006", detail, { remainCount: remain });
}

/** The router has locked its login (`108007`); `waitSec`: for how long, when it says. */
export function loginLocked(detail: string, waitSec: number | null = null): CpeApiError {
  return new CpeApiError("108007", detail, { waitTime: waitSec });
}

/** Someone else is signed in to the router's page (`108003`): FengSui yields, never pushes them out. */
export function signedInElsewhere(detail: string): CpeApiError {
  return new CpeApiError("108003", detail);
}

/** An answer to the password FengSui cannot place: it may have counted as a wrong attempt. */
export function loginUnplaced(detail: string): CpeApiError {
  return new CpeApiError(LOGIN_UNCONFIRMED_CODE, detail, { latchesBreaker: true });
}

/** A login whose method FengSui could not settle before the password went out: nothing was sent. */
export class DriverLoginMethodError extends Error {
  constructor(detail: string) {
    super(`Unsupported router login (${detail}): no password was sent`);
    this.name = "DriverLoginMethodError";
  }
}

/** A session that ended (logged out, or its deadline passed): nothing goes out any more. */
export class DriverSessionClosedError extends Error {
  constructor() {
    super("The router session is over");
    this.name = "DriverSessionClosedError";
  }
}

export function sha256Hex(text: string, upper = false): string {
  const hex = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  return upper ? hex.toUpperCase() : hex;
}

export function md5Hex(text: string): string {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

/** HMAC-MD5 as hexadecimal (lowercase). */
export function hmacMd5Hex(key: string, text: string): string {
  return crypto.createHmac("md5", key).update(text, "utf8").digest("hex");
}
