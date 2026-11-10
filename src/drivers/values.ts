import { stripInvalidControlChars } from "../text-sanitize.ts";

/**
 * Reading values out of router answers that do not agree on anything: numbers as text with units
 * (`"-79 dBm"`), hexadecimal with or without `0x`, and sentinels for "no value" (`-32768`, `255`,
 * `"--"`). Every helper bounds its input and returns `null` for anything it cannot read; it never
 * guesses a number.
 */

const MAX_VALUE_CHARS = 64;

/** A JSON leaf as text (strings and finite numbers), trimmed and bounded; `null` for anything else or empty. */
export function textOf(value: unknown): string | null {
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" && Number.isFinite(value)) text = String(value);
  else if (typeof value === "bigint") text = value.toString();
  else return null;
  const trimmed = stripInvalidControlChars(text.slice(0, 512)).trim();
  return trimmed === "" ? null : trimmed;
}

/** Text a router uses for "no value". */
const EMPTY_MARKERS: ReadonlySet<string> = new Set(["-", "--", "---", "n/a", "na", "null", "none", "unknown", "unknow", "invalid", "未知"]);

function usable(value: unknown): string | null {
  const text = textOf(value);
  if (text === null) return null;
  return EMPTY_MARKERS.has(text.toLowerCase()) ? null : text.slice(0, MAX_VALUE_CHARS);
}

/** A decimal integer (`"42"`, `"-7"`), `null` for anything else. */
export function intOf(value: unknown): number | null {
  const text = usable(value);
  if (text === null || !/^[+-]?\d{1,15}$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : null;
}

/** A hexadecimal integer with or without `0x` (`"d3"`, `"0x138"`), `null` for anything else. */
export function hexIntOf(value: unknown): number | null {
  const text = usable(value);
  if (text === null) return null;
  const clean = text.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,12}$/.test(clean)) return null;
  return Number.parseInt(clean, 16);
}

/** `0x…` (or digits with hex letters) as hexadecimal, plain digits as decimal. */
export function decOrHexIntOf(value: unknown): number | null {
  const text = usable(value);
  if (text === null) return null;
  if (/^0x/i.test(text) || /[a-fA-F]/.test(text)) return hexIntOf(text);
  return intOf(text);
}

/** The leading number of a value with a unit (`"-79 dBm"`, `"100MHz"`, `"19.2"`), `null` without one. */
export function numberOf(value: unknown): number | null {
  const text = usable(value);
  if (text === null) return null;
  const match = /^[+-]?\d{1,9}(?:\.\d{1,6})?/.exec(text);
  if (!match) return null;
  const n = Number.parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

function within(value: number | null, min: number, max: number, exclude: ReadonlyArray<number> = []): number | null {
  if (value === null || value < min || value > max || exclude.includes(value)) return null;
  return value;
}

/** RSRP in dBm: −156 is the lowest NR index and the sentinel several firmwares use, so it is left out. */
export function rsrpOf(value: unknown): number | null {
  return within(numberOf(value), -155.9, -31);
}

/** RSRQ in dB (−43 is a sentinel; nothing above 3 dB is physical). */
export function rsrqOf(value: unknown): number | null {
  return within(numberOf(value), -42.9, 3);
}

/** SINR in dB, the 3GPP reporting range −23..40 dB. */
export function sinrOf(value: unknown): number | null {
  return within(numberOf(value), -23, 40);
}

/** RSSI in dBm. */
export function rssiOf(value: unknown): number | null {
  return within(numberOf(value), -120, -20);
}

/** A board temperature in °C (0 and −40 are what sensors that are not there report). */
export function temperatureOf(value: unknown): number | null {
  return within(numberOf(value), -29.9, 124.9, [0]);
}

/** A physical cell identity (LTE 0–503, NR 0–1007). */
export function pciOf(value: unknown, rat: "LTE" | "NR", radix: 10 | 16 | "auto" = 10): number | null {
  const n = radix === 16 ? hexIntOf(value) : radix === "auto" ? decOrHexIntOf(value) : intOf(value);
  return within(n, 0, rat === "LTE" ? 503 : 1007);
}

/** An EARFCN (LTE, 0–262143) or NR-ARFCN (0–3279165); `zeroIsNone` for firmwares that print 0 for "no cell". */
export function arfcnOf(value: unknown, rat: "LTE" | "NR", opts: { zeroIsNone?: boolean } = {}): number | null {
  const n = within(intOf(value), 0, rat === "LTE" ? 262143 : 3279165);
  return n === 0 && opts.zeroIsNone !== false ? null : n;
}

/** A band number from `3`, `"B3"`, `"LTE BAND 3"`, `"n78"`, `"N78"`, `"NR5G BAND 78"`. */
export function bandOf(value: unknown): number | null {
  const text = usable(value);
  if (text === null) return null;
  const match = /^(?:LTE|NR5G|NR|5G)?\s*(?:BAND|BC|B|N)?\s*(\d{1,3})$/i.exec(text);
  if (!match?.[1]) return null;
  return within(Number.parseInt(match[1], 10), 1, 262);
}

/** A bandwidth in MHz (`"20MHz"`, `"20.0"`, `100`). */
export function mhzOf(value: unknown): number | null {
  return within(numberOf(value), 1.4, 2000);
}

const LTE_BANDWIDTHS: ReadonlyArray<number> = [1.4, 3, 5, 10, 15, 20];
const NR_BANDWIDTHS: ReadonlyArray<number> = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 200, 400];

/** A channel bandwidth 3GPP defines for the RAT (`"20.0"`, `"100MHz"`), `null` for anything else. */
export function channelBandwidthOf(value: unknown, rat: "LTE" | "NR"): number | null {
  const n = numberOf(value);
  if (n === null) return null;
  return (rat === "LTE" ? LTE_BANDWIDTHS : NR_BANDWIDTHS).includes(n) ? n : null;
}

/** A small non-negative integer within `max` (CQI, MCS, MIMO layers, bars). */
export function smallIntOf(value: unknown, max: number): number | null {
  return within(intOf(value), 0, max);
}

/** A non-negative counter as `bigint` (`"85899345920"`), `null` for anything else. */
export function counterOf(value: unknown): bigint | null {
  const text = usable(value);
  if (text === null || !/^\d{1,20}$/.test(text)) return null;
  return BigInt(text);
}

/** A non-negative count of seconds or bytes per second within the safe integer range. */
export function nonNegativeOf(value: unknown): number | null {
  const n = numberOf(value);
  return n === null || n < 0 || !Number.isSafeInteger(Math.round(n)) ? null : Math.round(n);
}

/** Megabytes as a router prints them (`"1548.62"`) to bytes. */
export function megabytesToBytes(value: unknown): bigint | null {
  const n = numberOf(value);
  if (n === null || n < 0) return null;
  return BigInt(Math.round(n * 1024 * 1024));
}

/**
 * A cell identity or tracking area code as decimal digits, read as hexadecimal (`radix: 16`) or
 * decimal; at most 36 bits (an NR cell identity), `null` for zero or anything else.
 */
export function identityOf(value: unknown, radix: 10 | 16 | "auto"): string | null {
  const text = usable(value);
  if (text === null) return null;
  const clean = text.replace(/^0x/i, "");
  const hex = radix === 16 || (radix === "auto" && (/^0x/i.test(text) || /[a-fA-F]/.test(clean)));
  if (hex ? !/^[0-9a-fA-F]{1,9}$/.test(clean) : !/^\d{1,11}$/.test(clean)) return null;
  const n = BigInt(hex ? `0x${clean}` : clean);
  if (n === 0n || n > (1n << 36n) - 1n) return null;
  return n.toString(10);
}

/** Free text a router reports (operator, model, firmware): control characters out, bounded. */
export function labelOf(value: unknown, maxChars = 64): string | null {
  const text = usable(value);
  return text === null ? null : text.slice(0, maxChars);
}

/** An IPv4 address in dotted quad, `null` otherwise. */
export function ipv4Of(value: unknown): string | null {
  const text = usable(value);
  if (text === null) return null;
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return text === "0.0.0.0" ? null : text;
}

/** An IPv6 address (an optional `/prefix` dropped), `null` otherwise. */
export function ipv6Of(value: unknown): string | null {
  const text = usable(value);
  if (text === null) return null;
  const address = text.split("/")[0] ?? "";
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(address) || !address.includes(":")) return null;
  return address === "::" ? null : address;
}

/** Split `"a,b;c,d;"` into rows of fields (empty rows dropped), bounded. */
export function rowsOf(value: unknown, rowSep = ";", fieldSep = ","): string[][] {
  const text = typeof value === "string" ? value.slice(0, 16_384) : "";
  return text
    .split(rowSep)
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .slice(0, 64)
    .map((row) => row.split(fieldSep).map((field) => field.trim()));
}

/** Own property of a parsed JSON object (null-prototype or not), `undefined` when absent. */
export function fieldOf(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
  return Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}

/** The first of `keys` that holds a usable value. */
export function firstField(record: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = fieldOf(record, key);
    if (usable(value) !== null) return value;
  }
  return undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first of `values` that `parse` reads (fallback fields a firmware may fill instead). */
export function firstOf<T>(parse: (value: unknown) => T | null, ...values: unknown[]): T | null {
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** MCC + MNC as one PLMN (`"460"` + `"00"`), `null` unless both are digits of the right length. */
export function plmnOf(mcc: unknown, mnc: unknown): string | null {
  const a = textOf(mcc);
  const b = textOf(mnc);
  if (a === null || b === null || !/^\d{3}$/.test(a) || !/^\d{2,3}$/.test(b)) return null;
  return `${a}${b}`;
}
