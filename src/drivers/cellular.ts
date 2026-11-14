import type { DataLimitSetting } from "../cellular.ts";
import type { WriteCheck } from "../device-access.ts";

/**
 * Parts more than one brand's driver uses for the cellular settings (`DriverCellular`): a longer text
 * field of an answer, the name of the one access point profile FengSui keeps on a router, how a data
 * limit is read back, and how a write that has no state to compare is recorded. What only one
 * brand's interfaces use is with that brand (`zte/cellular.ts`); the `+COPS` answers are an AT part
 * (`src/protocols/at/common.ts`), and a USSD answer's text and waits are a part of their own
 * (`src/protocols/ussd.ts`).
 */

/**
 * A longer text field of a router answer (a scan list, a USSD answer in hexadecimal), bounded: the
 * drivers' `textOf` keeps 512 characters, which a list of networks or a 182-character USSD message
 * written as hexadecimal does not fit in. `null` for anything but a non-empty string.
 */
export function longTextOf(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.slice(0, maxChars).trim();
  return text === "" ? null : text;
}

/** A write the router answered and that leaves nothing to read back (a USSD code, a counter cleared, a PIN the card refused). */
export function settleNothingToRead(check: WriteCheck): void {
  check.readback = "none";
  check.reason = null;
}

/**
 * The one access point profile FengSui adds to a router that keeps a list of them, and the only one
 * it ever overwrites: the profiles the router came with and the ones its owner made stay as they are.
 */
export const FENGSUI_APN_PROFILE = "FengSui";

/** What a limit write is compared with on read-back: on or off, and the size when it was set. */
export function sameDataLimit(wanted: DataLimitSetting, got: { enabled: boolean | null; bytes: number | null } | null): boolean | null {
  if (!got || got.enabled === null) return null;
  if (got.enabled !== wanted.enabled) return false;
  if (!wanted.enabled || wanted.bytes === null) return true;
  if (got.bytes === null) return null;
  // The router keeps whole megabytes
  return Math.abs(got.bytes - wanted.bytes) < 1024 * 1024;
}
