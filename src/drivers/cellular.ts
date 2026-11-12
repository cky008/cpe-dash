import { USSD_MAX_TEXT, type ApnAuthMode, type ApnIpType, type ApnSetting, type DataLimitSetting, type NetworkMode, type OperatorChoice, type OperatorRat, type SimSlotRef, type UssdAnswer } from "../cellular.ts";
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

/** A row of ZTE's scan list, with the two numbers its register form sends back as they came (`Rat`, `nSubrat`). */
export interface ZteScanRow {
  choice: OperatorChoice;
  act: string;
  subrat: string;
}

/**
 * ZTE's scan list (`m_netselect_contents`): rows `state,"name",numeric,rat[,subrat]` joined by `;`
 * (the page's own parser reads it this way).
 */
export function zteScanRows(value: unknown): ZteScanRow[] {
  const out: ZteScanRow[] = [];
  for (const row of (longTextOf(value, MAX_SCAN_CHARS) ?? "").split(";").slice(0, MAX_SCAN_ROWS)) {
    const fields = row.split(",");
    if (fields.length < 4) continue;
    const act = fields[3]?.trim() ?? "";
    const choice = operatorChoice(fields[0]?.trim(), fields[1], fields[2], act);
    if (!choice) continue;
    const subrat = fields[4]?.trim() ?? "";
    out.push({ choice, act, subrat: /^\d{1,2}$/.test(subrat) ? subrat : "" });
  }
  return out;
}

export function parseZteOperators(value: unknown): OperatorChoice[] {
  return zteScanRows(value).map((row) => row.choice);
}

/** How long a search for networks and a registration are waited for (ZTE's page asks once a second, up to two minutes). */
export const OPERATOR_POLLS = 120;
export const OPERATOR_POLL_MS = 1000;

/**
 * Ask until `done` says the router has finished (`true` or `false`: its verdict), `OPERATOR_POLLS`
 * times at most. `null`: it never said.
 */
export async function awaitOperatorStep(read: () => Promise<unknown>, done: (value: string | null) => boolean | null, wait: DriverWait): Promise<boolean | null> {
  for (let ask = 0; ask < OPERATOR_POLLS; ask += 1) {
    if (ask > 0) await wait.sleep(OPERATOR_POLL_MS);
    const verdict = done(textOf(await read().catch(() => null)));
    if (verdict !== null) return verdict;
  }
  return null;
}

/** What a technology is called in a scan row that spells it out (zWRT's rows; goform's are `AT+COPS` numbers). */
export function operatorRatNamed(value: unknown): OperatorRat | null {
  const numbered = operatorRatOf(value);
  if (numbered !== null) return numbered;
  const text = textOf(value)?.toUpperCase() ?? "";
  if (/NR|5G/.test(text)) return "5G";
  if (/LTE|4G/.test(text)) return "4G";
  if (/WCDMA|UMTS|HSPA|3G|TD-?SCDMA/.test(text)) return "3G";
  if (/GSM|EDGE|GPRS|2G/.test(text)) return "2G";
  return null;
}

/** A row of zWRT's scan list, with the technology as the router wrote it (the register call takes it back as it is). */
export interface ZwrtScanRow {
  choice: OperatorChoice;
  rat: string;
}

const ZWRT_SCAN_STATES: Readonly<Record<string, OperatorChoice["state"]>> = { current: "current", available: "available", forbidden: "forbidden", "0": "unknown", "1": "available", "2": "current", "3": "forbidden" };

/**
 * zWRT's scan list (`nwinfo_m_netselect_contents`): an array of rows naming `name` (or
 * `operator_name`), `mcc_mnc` (or `plmn`), `rat` and `status`. One row per operator and technology.
 */
export function zwrtScanRows(value: unknown): ZwrtScanRow[] {
  const out: ZwrtScanRow[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value) ? value.slice(0, MAX_SCAN_ROWS) : []) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const plmn = textOf(row["mcc_mnc"]) ?? textOf(row["plmn"]) ?? "";
    const rat = textOf(row["rat"]) ?? "";
    if (!/^\d{5,6}$/.test(plmn) || !/^[A-Za-z0-9_+-]{0,16}$/.test(rat) || seen.has(`${plmn}/${rat}`)) continue;
    seen.add(`${plmn}/${rat}`);
    out.push({ choice: { plmn, name: operatorName(row["name"]) ?? operatorName(row["operator_name"]), rat: operatorRatNamed(rat), state: ZWRT_SCAN_STATES[textOf(row["status"])?.toLowerCase() ?? ""] ?? "unknown" }, rat });
  }
  return out;
}

/** How a search stands (`m_netselect_status`), in the words either of ZTE's interfaces uses. `null`: still going, or not said. */
export function zteScanDone(status: string | null): boolean | null {
  const text = status?.toLowerCase() ?? "";
  if (["done", "complete", "completed", "2", "manual_selected"].includes(text)) return true;
  if (["error", "fail", "failed", "manual_search_fail"].includes(text)) return false;
  return null;
}

/** How a registration went (`m_netselect_result`). `null`: still going, or not said. */
export function zteRegisterDone(result: string | null): boolean | null {
  const text = result?.toLowerCase() ?? "";
  if (["success", "1", "manual_success"].includes(text)) return true;
  if (["fail", "failed", "0", "manual_fail"].includes(text)) return false;
  return null;
}

// ── The module's own operator commands (3GPP TS 27.007 §7.3) ─────────────────

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

// ── Access points ────────────────────────────────────────────────────────────

/**
 * The one access point profile FengSui adds to a router that keeps a list of them, and the only one
 * it ever overwrites: the profiles the router came with and the ones its owner made stay as they are.
 */
export const FENGSUI_APN_PROFILE = "FengSui";

const ZTE_PDP_NAMES: Readonly<Record<ApnIpType, string>> = { ipv4: "IP", ipv6: "IPv6", ipv4v6: "IPv4v6" };

/** ZTE's name for an address type (`pdp_type`). */
export function ztePdpName(ipType: ApnIpType): string {
  return ZTE_PDP_NAMES[ipType];
}

export function ztePdpOf(value: unknown): ApnIpType | null {
  const text = textOf(value)?.toLowerCase();
  if (text === "ip" || text === "ipv4") return "ipv4";
  if (text === "ipv6") return "ipv6";
  if (text === "ipv4v6") return "ipv4v6";
  return null;
}

/** An authentication mode as ZTE's pages name it (`none`, `pap`, `chap`; `pap_chap` is not one FengSui sets). */
export function zteAuthOf(value: unknown): ApnAuthMode | null {
  const text = textOf(value)?.toLowerCase();
  return text === "none" || text === "pap" || text === "chap" ? text : null;
}

/** One profile of the goform pages' list, at the place the page counts it. */
export interface ZteApnProfile {
  index: number;
  name: string;
  /** The page's own name for the address type, sent back as it is when the profile is made the default. */
  pdpType: string | null;
}

/** The keys the goform pages keep their access point profiles under, one profile each. */
export const ZTE_APN_PROFILE_KEYS: ReadonlyArray<string> = Array.from({ length: 20 }, (_unused, slot) => `APN_configtmp${slot}`);

/**
 * The goform pages' profile list: `name($)apn($)…($)…($)auth($)user($)password($)pdpType($)…`, one
 * profile per key; the page counts the ones that are there, in order, and so does this. Only the name
 * and the address type leave here: the credentials stay on the router.
 */
export function zteApnProfiles(raw: Readonly<Record<string, unknown>>): ZteApnProfile[] {
  const out: ZteApnProfile[] = [];
  for (const key of ZTE_APN_PROFILE_KEYS) {
    const text = longTextOf(raw[key], 1024);
    if (text === null) continue;
    const fields = text.split("($)");
    const name = (fields[0] ?? "").trim();
    if (name === "") continue;
    const pdp = (fields[7] ?? "").trim();
    out.push({ index: out.length, name, pdpType: /^(?:IP|IPv6|IPv4v6)$/.test(pdp) ? pdp : null });
  }
  return out;
}

/** The fields the goform pages' save form takes for a profile of each address type (the page's own three shapes). */
export function zteApnFields(setting: ApnSetting): Array<[string, string]> {
  const v4: Array<[string, string]> = [
    ["wan_apn", setting.apn],
    ["ppp_auth_mode", setting.auth],
    ["ppp_username", setting.username],
    ["ppp_passtmp", setting.password],
  ];
  const v6: Array<[string, string]> = [
    ["ipv6_wan_apn", setting.apn],
    ["ipv6_ppp_auth_mode", setting.auth],
    ["ipv6_ppp_username", setting.username],
    ["ipv6_ppp_passtmp", setting.password],
  ];
  if (setting.ipType === "ipv4") return v4;
  if (setting.ipType === "ipv6") return v6;
  return [...v4, ["dns_mode", "auto"], ["prefer_dns_manual", ""], ["standby_dns_manual", ""], ...v6];
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

/** One manual profile of zWRT's list (`get_manu_apn_list`), without its credentials. */
export interface ZwrtApnProfile {
  /** The router's own id for it, sent back as it came. */
  id: string | number;
  name: string | null;
  apn: string | null;
  ipType: ApnIpType | null;
  auth: ApnAuthMode | null;
  hasUsername: boolean;
  enabled: boolean;
}

const ZWRT_PDP: ReadonlyArray<ApnIpType | null> = [null, "ipv4", "ipv6", "ipv4v6"];
const ZWRT_AUTH: ReadonlyArray<ApnAuthMode> = ["none", "pap", "chap"];

export function zwrtApnProfiles(value: unknown): ZwrtApnProfile[] {
  const out: ZwrtApnProfile[] = [];
  for (const item of Array.isArray(value) ? value.slice(0, 32) : []) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const id = row["profileId"];
    if (!(typeof id === "number" && Number.isSafeInteger(id)) && !(typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id))) continue;
    const enabled = row["isEnable"];
    out.push({
      id,
      name: textOf(row["profilename"]),
      apn: textOf(row["wanapn"]),
      ipType: ZWRT_PDP[Number(textOf(row["pdpType"]) ?? row["pdpType"])] ?? null,
      auth: ZWRT_AUTH[Number(textOf(row["pppAuthMode"]) ?? row["pppAuthMode"])] ?? null,
      hasUsername: textOf(row["username"]) !== null,
      enabled: enabled === true || enabled === 1 || enabled === "1",
    });
  }
  return out;
}

/** The body zWRT's `add_manu_apn` and `modify_manu_apn` take: the address type and the authentication as its numbers. */
export function zwrtApnBody(setting: ApnSetting): Record<string, unknown> {
  return { profilename: FENGSUI_APN_PROFILE, wanapn: setting.apn, pdpType: ZWRT_PDP.indexOf(setting.ipType), pppAuthMode: ZWRT_AUTH.indexOf(setting.auth), username: setting.username, password: setting.password };
}
