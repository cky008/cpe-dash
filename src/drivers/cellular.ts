import { USSD_MAX_TEXT, type DataLimitSetting, type NetworkMode, type OperatorChoice, type OperatorRat, type SimSlotRef, type UssdAnswer } from "../cellular.ts";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeApiError } from "../cpe-client.ts";
import type { WriteCheck } from "../device-access.ts";
import { textOfUcs2Hex } from "./sms.ts";
import type { DriverWait } from "./types.ts";
import { textOf } from "./values.ts";

/**
 * Parts the drivers share for the cellular settings (`DriverCellular`): the text of a USSD answer,
 * the network modes and operator rows ZTE's two interfaces write alike, and how a write that has no
 * state to compare is recorded.
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

/** The longest scan list read (64 rows of a quoted name, a code and two numbers fit several times over). */
const MAX_SCAN_CHARS = 8192;

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

/** A USSD answer ZTE's interfaces hand back as UTF-16 hexadecimal (`ussd_data`), or as plain text on firmware that sends it so. */
export function zteUssdText(value: unknown): string | null {
  // Four hexadecimal digits per character
  const raw = longTextOf(value, USSD_MAX_TEXT * 4);
  if (raw === null) return null;
  return ussdText(textOfUcs2Hex(raw) ?? raw);
}

/** How long a USSD answer is waited for, and how often the router is asked. */
export const USSD_POLLS = 30;
export const USSD_POLL_MS = 1000;

/**
 * What `ussd_write_flag` says while a code is out (ZTE's own page): `15` still working, `16` an
 * answer is there, `13` the session was cancelled; anything else is the network or the router
 * declining, kept as the code it gave.
 */
export async function awaitZteUssd(readFlag: () => Promise<unknown>, wait: DriverWait): Promise<"answered" | "cancelled" | "no_answer"> {
  for (let ask = 0; ask < USSD_POLLS; ask += 1) {
    if (ask > 0) await wait.sleep(USSD_POLL_MS);
    const flag = textOf(await readFlag().catch(() => null));
    if (flag === null || flag === "15") continue;
    if (flag === "16") return "answered";
    if (flag === "13") return "cancelled";
    throw new CpeApiError(/^\d{1,4}$/.test(flag) ? flag : "refused", "The network did not answer the USSD code");
  }
  return "no_answer";
}

/** An answer with nothing in it (the network said nothing in time, or the session was ended). */
export function emptyUssd(state: UssdAnswer["state"]): UssdAnswer {
  return { state, text: null, awaitsReply: false };
}

// ── ZTE: the names both of its interfaces use ────────────────────────────────

/** The network modes ZTE's 5G firmware names (notes library A: goform §3.3, zWRT §3.1). */
export const ZTE_MODE_NAMES: Readonly<Partial<Record<NetworkMode, string>>> = {
  auto: "WL_AND_5G",
  nr_sa: "Only_5G",
  nr_nsa: "LTE_AND_5G",
  lte: "Only_LTE",
  lte_wcdma: "WCDMA_AND_LTE",
  wcdma: "Only_WCDMA",
};

/** The mode a ZTE router reports (`net_select`), `null` for a name FengSui has no mode for. */
export function zteModeOf(value: unknown): NetworkMode | null {
  const text = textOf(value)?.toUpperCase();
  if (!text) return null;
  if (text === "NETWORK_AUTO" || text === "AUTO") return "auto";
  for (const [mode, name] of Object.entries(ZTE_MODE_NAMES)) if (name.toUpperCase() === text) return mode as NetworkMode;
  return null;
}

/** The access technology of a scan row, as `AT+COPS` numbers it (3GPP TS 27.007 §7.3). */
export function operatorRatOf(value: unknown): OperatorRat | null {
  const act = textOf(value);
  if (act === null || !/^\d{1,2}$/.test(act)) return null;
  const n = Number(act);
  if (n === 0 || n === 1 || n === 3 || n === 8) return "2G";
  if (n === 2 || (n >= 4 && n <= 6)) return "3G";
  if (n === 7 || n === 9 || n === 10) return "4G";
  if (n >= 11 && n <= 13) return "5G";
  return null;
}

/** The `AT+COPS` number a technology is registered with (`null` for a choice that names none). */
export function operatorActOf(rat: OperatorRat | null): string | null {
  if (rat === null) return null;
  return { "2G": "0", "3G": "2", "4G": "7", "5G": "12" }[rat];
}

/** An operator's name as it may be shown: printable, short; `null` when there is none. */
export function operatorName(value: unknown): string | null {
  const text = textOf(value)
    ?.replace(/["\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 48);
  return text ? text : null;
}

const SCAN_STATES: ReadonlyArray<OperatorChoice["state"]> = ["unknown", "available", "current", "forbidden"];

/** One scan row from its `AT+COPS=?` fields: state, name, numeric code, technology. `null`: not an operator. */
export function operatorChoice(state: unknown, name: unknown, numeric: unknown, act: unknown): OperatorChoice | null {
  const plmn = textOf(numeric)?.replace(/\D/g, "") ?? "";
  if (!/^\d{5,6}$/.test(plmn)) return null;
  const index = Number(textOf(state) ?? "");
  return { plmn, name: operatorName(name), rat: operatorRatOf(act), state: SCAN_STATES[index] ?? "unknown" };
}

/** At most this many networks are kept of a scan (a border area lists a few dozen). */
export const MAX_SCAN_ROWS = 64;

/**
 * ZTE's scan list (`m_netselect_contents`): rows `state,"name",numeric,rat[,subrat]` joined by `;`
 * (the page's own parser reads it this way).
 */
export function parseZteOperators(value: unknown): OperatorChoice[] {
  const out: OperatorChoice[] = [];
  for (const row of (longTextOf(value, MAX_SCAN_CHARS) ?? "").split(";").slice(0, MAX_SCAN_ROWS)) {
    const fields = row.split(",");
    if (fields.length < 4) continue;
    const choice = operatorChoice(fields[0]?.trim(), fields[1], fields[2], fields[3]?.trim());
    if (choice) out.push(choice);
  }
  return out;
}

/** ZTE's slot numbers: `0` the card in the tray, `1` and `2` the built-in ones (notes library A). */
export const ZTE_GOFORM_SLOTS: ReadonlyArray<SimSlotRef> = [
  { kind: "physical", index: 1 },
  { kind: "embedded", index: 1 },
  { kind: "embedded", index: 2 },
];

/**
 * ZTE's data limit size: `<amount>_<MB per unit>` (`20_1024` is 20 GB, `500_1` is 500 MB). Whole
 * megabytes only: the page has no smaller unit.
 */
export function zteLimitSize(bytes: number): string {
  const megabytes = Math.round(bytes / (1024 * 1024));
  if (megabytes < 1) throw new CpeControlValidationError("The router counts its data limit in megabytes: give at least 1 MB");
  return megabytes % 1024 === 0 ? `${megabytes / 1024}_1024` : `${megabytes}_1`;
}

/** What a limit write is compared with on read-back: on or off, and the size when it was set. */
export function sameDataLimit(wanted: DataLimitSetting, got: { enabled: boolean | null; bytes: number | null } | null): boolean | null {
  if (!got || got.enabled === null) return null;
  if (got.enabled !== wanted.enabled) return false;
  if (!wanted.enabled || wanted.bytes === null) return true;
  if (got.bytes === null) return null;
  // The router keeps whole megabytes
  return Math.abs(got.bytes - wanted.bytes) < 1024 * 1024;
}
