import { type ApnIpType, type OperatorChoice, type OperatorRat, isApnName } from "../../cellular.ts";
import { type SimCardStatus, type SimState, countValue } from "../../router-status.ts";
import { labelOf, textOf } from "../values.ts";

/**
 * AT commands every cellular module answers the same way (3GPP TS 27.007 / 27.005), and how a
 * module tells its make in `ATI`: the parts any brand whose router passes AT commands through can use.
 */

export type ModemBrand = "quectel" | "fibocom";

/**
 * The module's make from what `ATI` / `AT+CGMM` say, when they say: the maker's name, or a model
 * name of its series (Fibocom FM150 / FM160 / FM350 / FM650 / FG370...; Quectel RM5xx / RG5xx and
 * the EM / EG / EC / EP 4G series). `null` when neither names one (the session then probes).
 */
export function modemBrandOf(text: string): ModemBrand | null {
  // A series letter pair and three digits, whatever follows (`FM160-NA`, `RM520N-GL`, `EM120R-GL`)
  const upper = text.toUpperCase();
  if (upper.includes("FIBOCOM") || /\bF[MG]\d{3}/.test(upper)) return "fibocom";
  if (upper.includes("QUECTEL") || /\b(?:R[MG]|E[MGCP])\d{3}/.test(upper)) return "quectel";
  return null;
}

/** Identify whether the modem is Quectel or Fibocom from `ATI` or version query (Quectel when it says neither). */
export function detectModemBrand(atiText: string): ModemBrand {
  return modemBrandOf(atiText) ?? "quectel";
}

/** The answer to an AT command was an error (`ERROR`, `+CME ERROR: ...`, `+CMS ERROR: ...`): the command is not one of this module's. */
export function isAtError(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .some((line) => line === "ERROR" || line.startsWith("+CME ERROR") || line.startsWith("+CMS ERROR"));
}

/** Split a raw comma-separated AT line, stripping quotes and whitespace. */
export function splitAtCsv(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

/**
 * `AT+CFUN?` (3GPP TS 27.007 §8.2): `1` full functionality; `4` (transmit and receive off, the
 * "airplane mode") and `0` (minimum functionality) leave the radio off. `null` for anything else.
 */
export function parseCfun(text: string): boolean | null {
  const match = /\+CFUN:\s*(\d+)/.exec(text);
  if (!match?.[1]) return null;
  const fun = Number(match[1]);
  return fun === 1 ? false : fun === 0 || fun === 4 ? true : null;
}

/**
 * The SIM card through the module: `AT+CPIN?` (3GPP TS 27.007 §8.3: `READY`, `SIM PIN`, `SIM PUK`),
 * `AT+QPINC="SC"` on Quectel (its AT manual: `+QPINC: "SC",<PIN tries left>,<PUK tries left>`).
 */
export function parseSimPin(cpin: string, qpinc: string): Pick<SimCardStatus, "state" | "pinAttemptsLeft" | "pukAttemptsLeft"> {
  const code = /\+CPIN:\s*([A-Z0-9 -]+)/i.exec(cpin)?.[1]?.trim().toUpperCase() ?? null;
  const state: SimState | null =
    code === "READY" ? "ready" : code === "SIM PIN" ? "pin_required" : code === "SIM PUK" ? "puk_required" : /\+CME ERROR:\s*(10|13)\b/.test(cpin) ? (/\b10\b/.test(cpin) ? "absent" : "error") : null;
  const counts = /\+QPINC:\s*"SC"\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(qpinc);
  return { state, pinAttemptsLeft: countValue(counts?.[1], 10), pukAttemptsLeft: countValue(counts?.[2], 10) };
}

/** The first line of an AT answer that is only digits (`AT+CGSN`, `AT+CIMI`), else what follows its `+CGSN:` / `+QCCID:` prefix. */
export function atValueLine(text: string, prefix: string | null): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (prefix && line.toUpperCase().startsWith(prefix)) return line.slice(prefix.length).trim().replace(/^"|"$/g, "");
    if (/^\d{6,22}F?$/i.test(line)) return line;
  }
  return null;
}

export const PDP_TYPES: Readonly<Record<ApnIpType, string>> = { ipv4: "IP", ipv6: "IPV6", ipv4v6: "IPV4V6" };

/**
 * `AT+CGDCONT?` (3GPP TS 27.007 §10.1.1): `+CGDCONT: <cid>,"<PDP_type>","<APN>",…`. The context `cid`
 * as the access point in use (an empty APN is the one the network assigns); `null` when it is not listed.
 */
export function parseCgdcont(text: string, cid = 1): { apn: string; ipType: ApnIpType } | null {
  for (const raw of text.slice(0, 4096).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith("+CGDCONT:")) continue;
    const fields = splitAtCsv(line.slice("+CGDCONT:".length));
    if (fields[0] !== String(cid)) continue;
    const type = (fields[1] ?? "").toUpperCase();
    const ipType = (Object.entries(PDP_TYPES) as Array<[ApnIpType, string]>).find(([, name]) => name === type)?.[0];
    const apn = fields[2] ?? "";
    return ipType === undefined || (apn !== "" && !isApnName(apn)) ? null : { apn, ipType };
  }
  return null;
}

/** `+CME ERROR: 16` / `12`: the card says the PIN is wrong (3GPP TS 27.007 §9.2), or wants its PUK. */
export function pinRefused(answer: string): boolean {
  return isAtError(answer);
}

export const COPS_LINE = /\+COPS:\s*\d\s*,\s*([012])\s*,\s*"([^"\r\n]{1,64})"/;

/**
 * The operator of `AT+COPS?` (`+COPS: <mode>,<format>,"<oper>"[,<AcT>]`, 3GPP TS 27.007): the name in
 * the long or short alphanumeric format; `null` for the numeric format (a PLMN, not a name) or no
 * registration.
 */
export function parseOperatorName(raw: string): string | null {
  const match = COPS_LINE.exec(raw.slice(0, 512));
  if (!match || match[1] === "2") return null;
  return labelOf(match[2]);
}

/** The first line of an `ATI` / `AT+CGMM` answer that names the module rather than its maker (or `OK`). */
export function modelLineOf(text: string): string | null {
  return labelOf(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && line.toUpperCase() !== "OK" && !line.toUpperCase().includes("QUECTEL") && !line.toUpperCase().includes("FIBOCOM"))
  );
}

// The operator commands (3GPP TS 27.007 §7.3). A router's own page may hand its search result on in
// the same fields (ZTE's interfaces, HiLink's `plmn-list`), so their drivers read a row with these too.

/** The longest scan list read (64 rows of a quoted name, a code and two numbers fit several times over). */
export const MAX_SCAN_CHARS = 8192;

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

/** `AT+COPS?`: how the module chooses (0 by itself, 1 kept on one operator, 4 one operator first), and the operator in the format it is set to. */
export interface CopsState {
  mode: number;
  /** 0 and 1 a name, 2 the code; `null` when the module names no operator. */
  format: number | null;
  operator: string | null;
}

export function parseCops(raw: string): CopsState | null {
  const match = /\+COPS:\s*([0-4])(?:\s*,\s*([012])\s*,\s*"([^"\r\n]{0,64})")?/.exec(raw.slice(0, 512));
  if (!match) return null;
  return { mode: Number(match[1]), format: match[2] === undefined ? null : Number(match[2]), operator: match[3] === undefined ? null : match[3] };
}

/** `AT+COPS=?`: one `(state,"long name","short name","code"[,technology])` per network found; the lists of modes and formats after them are not networks. */
export function parseCopsScan(raw: string): OperatorChoice[] {
  const out: OperatorChoice[] = [];
  for (const match of raw.slice(0, MAX_SCAN_CHARS).matchAll(/\((\d)\s*,\s*"([^"\r\n]{0,64})"\s*,\s*"([^"\r\n]{0,64})"\s*,\s*"(\d{5,6})"(?:\s*,\s*(\d{1,2}))?\s*\)/g)) {
    if (out.length >= MAX_SCAN_ROWS) break;
    const choice = operatorChoice(match[1], match[2] || match[3], match[4], match[5]);
    if (choice) out.push(choice);
  }
  return out;
}
