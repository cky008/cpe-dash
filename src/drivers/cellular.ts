import { USSD_MAX_TEXT, type DataLimitSetting, type UssdAnswer } from "../cellular.ts";
import type { WriteCheck } from "../device-access.ts";

/**
 * Parts more than one brand's driver uses for the cellular settings (`DriverCellular`): a longer text
 * field of an answer, the text of a USSD answer and how long one is waited for, the name of the one
 * access point profile FengSui keeps on a router, how a data limit is read back, and how a write
 * that has no state to compare is recorded. What only one brand's interfaces use is with that brand
 * (`zte/cellular.ts`); the `+COPS` answers are an AT part (`src/protocols/at/common.ts`).
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
 * An operator's USSD text as it may be shown: control characters out (a menu's line breaks stay),
 * cut at `USSD_MAX_TEXT`. `null`: nothing readable.
 */
export function ussdText(raw: string | null): string | null {
  if (raw === null) return null;
  // Line breaks survive as "\n"; every other control character goes
  const text = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, USSD_MAX_TEXT);
  return text === "" ? null : text;
}

/** How long a USSD answer is waited for, and how often the router is asked. */
export const USSD_POLLS = 30;
export const USSD_POLL_MS = 1000;

/** An answer with nothing in it (the network said nothing in time, or the session was ended). */
export function emptyUssd(state: UssdAnswer["state"]): UssdAnswer {
  return { state, text: null, awaitsReply: false };
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
