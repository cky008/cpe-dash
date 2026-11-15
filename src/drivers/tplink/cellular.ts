import type { ApnAuthMode, ApnIpType, ApnSetting, ApnView, NetworkMode, OperatorChoice } from "../../cellular.ts";
import { CpeControlValidationError } from "../../control-error.ts";
import { MAX_SCAN_ROWS, operatorChoice } from "../../protocols/at/common.ts";
import type { CellLockState, DriverNetworkMode } from "../../protocols/readings.ts";
import { arfcnOf, intOf, nonNegativeOf, pciOf, textOf } from "../../protocols/values.ts";
import { lteBandOfIndex } from "../bands.ts";
import { longTextOf } from "../cellular.ts";
import type { DriverLockState } from "../types.ts";

/**
 * The cellular settings of a TP-Link router as its own page reads and writes them, in both forms of
 * the interface: what the status page calls the band, the band selection (a pair of bit masks on the
 * MR series, a list of names on the EX and NX series), the cell lock, the network modes, the networks
 * a search found, the data limit and the SIM lock. Nothing here sends a request.
 */

// ── The band the status names (the MR series) ────────────────────────────────

/**
 * `rfInfoBand` of the MR series' status: the low byte is the band the router is on, the next byte a
 * second band next to it (carrier aggregation), each by the modem's own number for it. `-1`, or a
 * low byte of zero: none.
 */
export function tplinkServingBands(value: unknown): { primary: number | null; secondary: number | null } {
  const n = intOf(value);
  if (n === null || n <= 0 || n > 0xffff) return { primary: null, secondary: null };
  const primary = lteBandOfIndex(n & 0xff);
  return { primary, secondary: primary === null ? null : lteBandOfIndex((n >> 8) & 0xff) };
}

// ── Band selection on the MR series: two bit masks ───────────────────────────

/**
 * Bands as the page's two masks: bit `band - 1` of the low one for bands 1 to 32, bit `band - 33` of
 * the high one above. The page computes them as signed 32-bit numbers and reads a negative one as "no
 * band", so bands 32 and 64 (the sign bit) are ones its own form cannot write: `null`.
 */
export function maskOfBands(bands: ReadonlyArray<number>): { low: number; high: number } | null {
  let low = 0;
  let high = 0;
  for (const band of bands) {
    if (!Number.isInteger(band) || band < 1 || band > 63 || band === 32) return null;
    if (band < 32) low |= 1 << (band - 1);
    else high |= 1 << (band - 33);
  }
  return { low, high };
}

/** The bands of the page's two masks (`null`: a mask that is no number). */
export function bandsOfMask(low: unknown, high: unknown): number[] | null {
  const l = nonNegativeOf(low);
  const h = nonNegativeOf(high);
  if (l === null || h === null || l > 0x7fffffff || h > 0x7fffffff) return null;
  const bands: number[] = [];
  for (let bit = 0; bit < 31; bit += 1) if ((l >> bit) & 1) bands.push(bit + 1);
  for (let bit = 0; bit < 31; bit += 1) if ((h >> bit) & 1) bands.push(bit + 33);
  return bands;
}

function cellLock(on: unknown, arfcn: unknown, pci: unknown, band: unknown, rat: "LTE" | "NR"): CellLockState | null {
  const flag = intOf(on);
  if (flag === null) return null;
  if (flag !== 1) return { locked: false };
  const b = intOf(band);
  return { locked: true, arfcn: arfcnOf(arfcn, rat), pci: pciOf(pci, rat), band: b !== null && b > 0 ? b : null };
}

/** `networkPreferredMode` of the MR series: 3 4G with 3G behind it (the widest it has), 2 4G only, 1 3G only. */
const MR_MODES: Readonly<Record<string, NetworkMode>> = { "3": "auto", "2": "lte", "1": "wcdma" };

export function mrModeOf(value: unknown): NetworkMode | null {
  return MR_MODES[textOf(value) ?? ""] ?? null;
}

export function mrModeCode(mode: NetworkMode): string | null {
  return Object.entries(MR_MODES).find(([, name]) => name === mode)?.[0] ?? null;
}

function lockMode(mode: NetworkMode | null): DriverNetworkMode | null {
  return mode === "auto" || mode === "lte" || mode === "nr_sa" || mode === "nr_nsa" ? mode : null;
}

/**
 * The locks of an MR series router: its band selection (`LTE_WAN_CFG`: the switch and the two masks)
 * and, on firmware that has one, its cell lock (`LTE_CELL_LOCK`).
 */
export function mrLockState(cfg: Record<string, string> | null, cell: Record<string, string> | null): DriverLockState {
  const on = intOf(cfg?.["bandSelectSwitch"]);
  const bands = on === 1 ? bandsOfMask(cfg?.["bandSelectedMaskL"], cfg?.["bandSelectedMaskH"]) : null;
  return {
    lteBands: on === null ? null : on === 1 ? bands : "all",
    nrBands: null,
    lteCell: cell === null ? null : cellLock(cell["rfInfoCellIDLock"], cell["rfInfoEARFCN"], cell["rfInfoPCI"], null, "LTE"),
    nrCell: null,
    networkMode: lockMode(mrModeOf(cfg?.["networkPreferredMode"])),
    supportedLte: null,
    supportedNr: null,
  };
}

// ── Band selection on the EX and NX series: a list of names ──────────────────

/** The bands of one of the page's lists, by what each can be used for. */
export interface NxBands {
  lte: number[];
  /** 5G bands usable standalone, and next to a 4G anchor. */
  nrSa: number[];
  nrNsa: number[];
}

/**
 * A band list of the EX and NX series (`supportBandList`, `selectedBand`): names joined by `;`, `B3`
 * a 4G band, `N78S` a 5G band standalone, `N78N` next to a 4G anchor, a bare `N78` both; `W1` (3G)
 * is not one FengSui selects. `null`: no list.
 */
export function parseNxBands(value: unknown): NxBands | null {
  const text = longTextOf(value, 2048);
  if (text === null) return null;
  const out: NxBands = { lte: [], nrSa: [], nrNsa: [] };
  const add = (list: number[], band: number): void => {
    if (!list.includes(band)) list.push(band);
  };
  for (const name of text.split(";").slice(0, 128)) {
    const match = /^([BN])(\d{1,3})([SN]?)$/.exec(name.trim());
    if (!match) continue;
    const band = Number(match[2]);
    if (band < 1) continue;
    if (match[1] === "B") {
      if (match[3] === "") add(out.lte, band);
      continue;
    }
    if (match[3] !== "N") add(out.nrSa, band);
    if (match[3] !== "S") add(out.nrNsa, band);
  }
  for (const list of [out.lte, out.nrSa, out.nrNsa]) list.sort((a, b) => a - b);
  return out;
}

/** A selection as the page's form writes it: every name ends with `;`, 4G first, then each 5G band's two uses. */
export function nxBandList(bands: NxBands): string {
  return [...bands.lte.map((band) => `B${band}`), ...bands.nrSa.map((band) => `N${band}S`), ...bands.nrNsa.map((band) => `N${band}N`)].map((name) => `${name};`).join("");
}

function union(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

function covers(selected: ReadonlyArray<number>, supported: ReadonlyArray<number>): boolean {
  return supported.every((band) => selected.includes(band));
}

/** `networkPreferredModeSelected` as the EX and NX series' page names the modes. */
const NX_MODE_NAMES: ReadonlyArray<readonly [string, NetworkMode]> = [
  ["5G Preferred", "auto"],
  ["5G/4G", "nr_lte"],
  ["5G NSA/4G", "nr_nsa"],
  ["5G SA Only", "nr_sa"],
  ["4G Preferred", "lte_wcdma"],
  ["4G Only", "lte"],
  ["3G Only", "wcdma"],
];

/**
 * The modes a router of the EX and NX series offers (`networkPreferredModeOptionList`, names joined
 * by commas), each under FengSui's name for it. A 4G router has no "5G Preferred": there the widest
 * mode it has, "4G Preferred", is its automatic one.
 */
export function nxModes(optionList: unknown): Map<NetworkMode, string> {
  const offered = (longTextOf(optionList, 512) ?? "").split(",").map((name) => name.trim());
  const modes = new Map<NetworkMode, string>();
  for (const [name, mode] of NX_MODE_NAMES) if (offered.includes(name)) modes.set(mode, name);
  const fourG = modes.get("lte_wcdma");
  if (!modes.has("auto") && fourG !== undefined) {
    modes.set("auto", fourG);
    modes.delete("lte_wcdma");
  }
  return modes;
}

export function nxModeOf(selected: unknown, optionList: unknown): NetworkMode | null {
  const name = textOf(selected);
  if (name === null) return null;
  for (const [mode, offered] of nxModes(optionList)) if (offered === name) return mode;
  return null;
}

/**
 * The locks of an EX or NX series router: its band selection (`DEV2_LTE_BAND_SEARCH`: mode 1 leaves
 * it to the router, 2 keeps it to `selectedBand`) and its two cell locks. A selection that holds
 * every band the router offers for a technology locks nothing there.
 */
export function nxLockState(search: Record<string, string> | null, lteCell: Record<string, string> | null, nrCell: Record<string, string> | null, cfg: Record<string, string> | null): DriverLockState {
  const supported = parseNxBands(search?.["supportBandList"]);
  const mode = intOf(search?.["selectedMode"]);
  const selected = mode === 2 ? parseNxBands(search?.["selectedBand"]) : null;
  const supportedNr = supported === null ? null : union(supported.nrSa, supported.nrNsa);
  const bandsOf = (chosen: number[] | null, offered: number[] | null): number[] | "all" | null => {
    if (mode === 1) return "all";
    if (mode !== 2 || chosen === null) return null;
    return offered !== null && offered.length > 0 && covers(chosen, offered) ? "all" : chosen;
  };
  return {
    lteBands: bandsOf(selected?.lte ?? null, supported?.lte ?? null),
    nrBands: supportedNr !== null && supportedNr.length === 0 ? null : bandsOf(selected === null ? null : union(selected.nrSa, selected.nrNsa), supportedNr),
    lteCell: lteCell === null ? null : cellLock(lteCell["lteCelllockEnable"], lteCell["EARFCN"], lteCell["pci"], lteCell["band"], "LTE"),
    nrCell: nrCell === null ? null : cellLock(nrCell["nrCelllockEnable"], nrCell["NRARFCN"], nrCell["pci"], nrCell["band"], "NR"),
    networkMode: lockMode(nxModeOf(cfg?.["networkPreferredModeSelected"], cfg?.["networkPreferredModeOptionList"])),
    supportedLte: supported === null || supported.lte.length === 0 ? null : supported.lte,
    supportedNr: supportedNr === null || supportedNr.length === 0 ? null : supportedNr,
  };
}

/**
 * What a band lock writes on the EX and NX series: the selection as the page's form would send it,
 * or `null` when it holds every band the router offers (the page's "automatic"). 4G bands come from
 * the request; 5G bands the request leaves alone stay as the router has them selected.
 */
export function nxSelection(target: { lte: number[] | "all"; nr: number[] | "all" | null }, supported: NxBands, selected: NxBands | null): NxBands | null {
  const lte = target.lte === "all" ? supported.lte : target.lte;
  const kept = selected ?? supported;
  const wanted = target.nr;
  const nr =
    wanted === null
      ? { nrSa: kept.nrSa, nrNsa: kept.nrNsa }
      : wanted === "all"
        ? { nrSa: supported.nrSa, nrNsa: supported.nrNsa }
        : { nrSa: supported.nrSa.filter((band) => wanted.includes(band)), nrNsa: supported.nrNsa.filter((band) => wanted.includes(band)) };
  const out: NxBands = { lte: [...lte].sort((a, b) => a - b), ...nr };
  if (out.lte.length + out.nrSa.length + out.nrNsa.length === 0) throw new CpeControlValidationError("Choose at least one band");
  return covers(out.lte, supported.lte) && covers(out.nrSa, supported.nrSa) && covers(out.nrNsa, supported.nrNsa) ? null : out;
}

// ── Networks a search found ──────────────────────────────────────────────────

/** A network of the MR series' list (`LTE_NET_SEL_LIST`), with what the page writes back to choose it. */
export interface MrOperator {
  choice: OperatorChoice;
  stack: string;
  mcc: string;
  mnc: string;
  name: string;
}

/** The MR series' list: each entry names its operator, its MCC and MNC and a state (1 available, 2 the current one, 3 forbidden). */
export function parseMrOperators(entries: ReadonlyArray<Record<string, string>>): MrOperator[] {
  const out: MrOperator[] = [];
  for (const entry of entries.slice(0, MAX_SCAN_ROWS)) {
    const mcc = textOf(entry["mcc"]);
    const mnc = textOf(entry["mnc"]);
    const stack = entry["stack"];
    if (mcc === null || mnc === null || stack === undefined || !/^\d{3}$/.test(mcc) || !/^\d{1,3}$/.test(mnc)) continue;
    // A router that writes the MNC as a number drops its leading zero
    const choice = operatorChoice(entry["itemStat"], entry["ispName"], `${mcc}${mnc.padStart(2, "0")}`, null);
    if (choice) out.push({ choice, stack, mcc, mnc, name: (entry["ispName"] ?? "").slice(0, 64) });
  }
  return out;
}

/** A network of the EX and NX series' list, with the entry as the router wrote it (the page sends that back). */
export interface NxOperator {
  choice: OperatorChoice;
  entry: string;
}

/** The EX and NX series' list (`operatorList`): `name,numeric,state` joined by `;`. */
export function parseNxOperators(value: unknown): NxOperator[] {
  const out: NxOperator[] = [];
  for (const entry of (longTextOf(value, 8192) ?? "").split(";").slice(0, MAX_SCAN_ROWS)) {
    const [name = "", numeric = "", state = ""] = entry.split(",");
    const choice = operatorChoice(state, name, numeric, null);
    if (choice && /^[^\r\n]{1,96}$/.test(entry)) out.push({ choice, entry });
  }
  return out;
}

// ── The data limit and the SIM lock ──────────────────────────────────────────

/** The data limit of the LTE interface (`…LTE_INTF_CFG`): on or off, its size in bytes, the share it warns at. */
export function tplinkDataLimit(intf: Record<string, string> | null): { enabled: boolean | null; bytes: number | null; alertPercent: number | null } | null {
  if (intf === null || intf["enableDataLimit"] === undefined) return null;
  const on = intOf(intf["enableDataLimit"]);
  const bytes = nonNegativeOf(intf["limitation"]);
  const percent = intOf(intf["warningPercent"]);
  return { enabled: on === null ? null : on === 1, bytes: bytes !== null && bytes > 0 ? Math.round(bytes) : null, alertPercent: percent !== null && percent >= 1 && percent <= 99 ? percent : null };
}

/**
 * The SIM lock (`…LTE_SIMLOCK`): `pinState` 1 the card wants its PIN, 2 the PIN is on and was given,
 * 3 the PIN is off; `remainPinUnlockTime` the attempts the PIN has left.
 */
export function tplinkSimLock(lock: Record<string, string> | null): { pinState: number | null; attemptsLeft: number | null } {
  const attempts = intOf(lock?.["remainPinUnlockTime"]);
  return { pinState: intOf(lock?.["pinState"]), attemptsLeft: attempts !== null && attempts >= 0 && attempts <= 10 ? attempts : null };
}

// ── Access point profiles ────────────────────────────────────────────────────

/**
 * A profile of the page's list (`LTE_PROFILE` on the MR series, `DEV2_LTE_PROFILE` on the EX and NX
 * series), with its fields as the router handed them out.
 */
export interface TplinkProfile {
  /** Its place in the list, which is also what the page calls its `profileID`. */
  index: number;
  id: string;
  name: string;
  fields: Readonly<Record<string, string>>;
}

/** The page's list: a profile's `profileID` is its place in it (the page compares the two as numbers). */
export function parseProfileList(entries: ReadonlyArray<Record<string, string>>): TplinkProfile[] {
  const out: TplinkProfile[] = [];
  entries.slice(0, 32).forEach((entry, index) => {
    const id = textOf(entry["profileID"]);
    if (id === null || !/^\d{1,3}$/.test(id) || Number(id) !== index) return;
    out.push({ index, id, name: (entry["profileName"] ?? "").slice(0, 64), fields: entry });
  });
  return out;
}

const PDP_TYPES: Readonly<Record<ApnIpType, string>> = { ipv4: "0", ipv6: "1", ipv4v6: "2" };
const AUTH_TYPES: Readonly<Record<ApnAuthMode, string>> = { none: "0", pap: "1", chap: "2" };

/** One address family's half of a profile, as the form writes it: a static access point, its credentials, how they are sent. */
function half(family: "ipv4" | "ipv6", setting: ApnSetting): Record<string, string> {
  return { [`${family}ApnType`]: "0", [`${family}Apn`]: setting.apn, [`${family}Username`]: setting.username, [`${family}Password`]: setting.password, [`${family}AuthType`]: AUTH_TYPES[setting.auth] };
}

/** What the page's "create profile" form sends for `setting` (its IPv4 half, or for an IPv6-only profile its IPv6 half). */
export function mrProfileCreate(name: string, setting: ApnSetting): Record<string, string> {
  return { profileName: name, pdpType: PDP_TYPES[setting.ipType], ...half(setting.ipType === "ipv6" ? "ipv6" : "ipv4", setting) };
}

/** What the page's settings form sends to save a profile and make it the one in use: each half the address type has. */
export function mrProfileEdit(profile: Pick<TplinkProfile, "id" | "index" | "name">, setting: ApnSetting): Record<string, string> {
  return {
    profileID: profile.id,
    profileName: profile.name,
    pdpType: PDP_TYPES[setting.ipType],
    ...(setting.ipType === "ipv6" ? {} : half("ipv4", setting)),
    ...(setting.ipType === "ipv4" ? {} : half("ipv6", setting)),
    profileAction: "1",
    activeProfile: String(profile.index),
  };
}

/** The same form for a profile that stays as it is: its own fields go back as the router handed them out, and it becomes the one in use. */
export function mrProfileUse(profile: TplinkProfile): Record<string, string> {
  const pdp = profile.fields["pdpType"] ?? "0";
  const keep = (family: "ipv4" | "ipv6"): Record<string, string> => Object.fromEntries(["ApnType", "Apn", "Username", "Password", "AuthType"].map((field) => [`${family}${field}`, profile.fields[`${family}${field}`] ?? ""]));
  return { profileID: profile.id, profileName: profile.name, pdpType: pdp, ...(pdp === "1" ? {} : keep("ipv4")), ...(pdp === "0" ? {} : keep("ipv6")), profileAction: "1", activeProfile: String(profile.index) };
}

/** The access point of a profile: never its password. `own`: one of the router's own profiles for the SIM card (the page's "default" ones). */
export function mrApnView(profile: TplinkProfile, own: boolean): ApnView {
  const pdp = profile.fields["pdpType"] ?? "";
  const family = pdp === "1" ? "ipv6" : "ipv4";
  const ipType = (Object.entries(PDP_TYPES).find(([, code]) => code === pdp)?.[0] ?? null) as ApnIpType | null;
  const auth = (Object.entries(AUTH_TYPES).find(([, code]) => code === (profile.fields[`${family}AuthType`] ?? ""))?.[0] ?? null) as ApnAuthMode | null;
  const apn = textOf(profile.fields[`${family}Apn`]);
  return { mode: own ? "auto" : "manual", apn: apn === null ? null : apn.slice(0, 100), ipType, auth, hasUsername: (profile.fields[`${family}Username`] ?? "") !== "" };
}

// The EX and NX series name a profile's fields once for both address types: `apnType` 0 is an access
// point typed in, 1 one the network gives (its `apn` is then empty)

const EX_FIELDS = ["pdpType", "apnType", "apn", "username", "password", "authType"] as const;

function flat(setting: ApnSetting): Record<string, string> {
  return { pdpType: PDP_TYPES[setting.ipType], apnType: "0", apn: setting.apn, username: setting.username, password: setting.password, authType: AUTH_TYPES[setting.auth] };
}

/** What the EX and NX page's "create profile" form sends for `setting`. */
export function exProfileCreate(name: string, setting: ApnSetting): Record<string, string> {
  return { profileName: name, ...flat(setting) };
}

/** What its settings form sends to save a profile and make it the one in use. */
export function exProfileEdit(profile: Pick<TplinkProfile, "id" | "index" | "name">, setting: ApnSetting): Record<string, string> {
  return { profileID: profile.id, profileName: profile.name, ...flat(setting), profileAction: "1", activeProfile: String(profile.index) };
}

/** The same form for a profile that stays as it is: its fields go back as the router handed them out. */
export function exProfileUse(profile: TplinkProfile): Record<string, string> {
  return { profileID: profile.id, profileName: profile.name, ...Object.fromEntries(EX_FIELDS.map((field) => [field, profile.fields[field] ?? ""])), profileAction: "1", activeProfile: String(profile.index) };
}

/** The access point of an EX or NX profile, from its fields as the router handed them out: never its password. */
export function exApnView(fields: Readonly<Record<string, string>>, own: boolean): ApnView {
  const pdp = fields["pdpType"] ?? "";
  const ipType = (Object.entries(PDP_TYPES).find(([, code]) => code === pdp)?.[0] ?? null) as ApnIpType | null;
  const auth = (Object.entries(AUTH_TYPES).find(([, code]) => code === (fields["authType"] ?? ""))?.[0] ?? null) as ApnAuthMode | null;
  const apn = fields["apnType"] === "1" ? null : textOf(fields["apn"]);
  return { mode: own ? "auto" : "manual", apn: apn === null ? null : apn.slice(0, 100), ipType, auth, hasUsername: (fields["username"] ?? "") !== "" };
}

// ── Tables of access points (the NX series' page with several at once) ──────

/** A profile of one of the page's tables. */
export interface NxTableProfile {
  /** Its number within its table (`profileID`). */
  id: string;
  name: string;
  /** What it carries (`serviceType`: Internet, IPTV, VOIP, TR069, Others). */
  services: ReadonlyArray<string>;
  fields: Readonly<Record<string, string>>;
}

/**
 * The page's tables of access points on firmware built with several at once (`INCLUDE_LTE_MULTI_APN`
 * in its own script): the profiles of `DEV2_LTE_PROFILE` grouped by their `tableIndex`, the
 * operator's tables for the SIM card first (`ispTableCount` of them, which the page lets nobody
 * change), and which table the router dials with (`DEV2_LTE_PROF_STAT`).
 */
export interface NxTables {
  /** The table the router dials with; `null`: the router does not say. */
  inUse: number | null;
  /** How many tables at the head are the operator's. */
  operatorTables: number;
  /** How many tables of their own the router's owner has made (`usrTableCount`). */
  ownTables: number;
  /** How many profiles the router lists, all tables together. */
  profiles: number;
  tables: ReadonlyMap<number, ReadonlyArray<NxTableProfile>>;
}

export function parseNxTables(stat: Record<string, string> | null, entries: ReadonlyArray<Record<string, string>>): NxTables | null {
  const operatorTables = nonNegativeOf(stat?.["ispTableCount"]);
  const user = intOf(stat?.["usrWhich"]);
  if (operatorTables === null || user === null) return null;
  const operator = intOf(stat?.["ispWhich"]);
  // As the page counts them: an own table's number goes on from the operator's, and above 8 the router dials with an operator's
  const inUse = user > 8 ? (operator !== null && operator >= 0 ? operator : null) : user >= 0 ? operatorTables + user : null;
  const operatorProfiles = nonNegativeOf(stat?.["ispCount"]) ?? 0;
  const byTable = new Map<number, Map<string, NxTableProfile>>();
  const listed = entries.slice(0, 64);
  listed.forEach((entry, i) => {
    const name = (entry["profileName"] ?? "").slice(0, 64);
    // The page leaves out the operator's empty places
    if (i < operatorProfiles && name === "NONE") return;
    const table = intOf(entry["tableIndex"]);
    const id = textOf(entry["profileID"]);
    if (table === null || table < 0 || table > 64 || id === null || !/^\d{1,2}$/.test(id)) return;
    const services = (entry["serviceType"] ?? "").split(",").map((service) => service.trim()).filter((service) => service !== "");
    const profiles = byTable.get(table) ?? new Map<string, NxTableProfile>();
    // A profile number listed twice in a table: the later one, in the first one's place (as the page's own map keeps it)
    profiles.set(String(Number(id)), { id: String(Number(id)), name, services, fields: entry });
    byTable.set(table, profiles);
  });
  const tables = new Map<number, NxTableProfile[]>([...byTable].map(([table, profiles]) => [table, [...profiles.values()]]));
  return { inUse, operatorTables, ownTables: nonNegativeOf(stat?.["usrTableCount"]) ?? 0, profiles: listed.length, tables };
}

/** The profile of a table that carries the data connection: the first that serves the Internet. */
export function nxDataProfile(profiles: ReadonlyArray<NxTableProfile> | undefined): NxTableProfile | null {
  return profiles?.find((profile) => profile.services.includes("Internet")) ?? null;
}

/**
 * What the page's profile form sends for a profile in `table` (`profileAction` 2 adds it, 1 saves it):
 * the access point typed in, for the Internet.
 */
export function nxProfileForm(table: number, id: string, name: string, setting: ApnSetting, action: "1" | "2"): Record<string, string> {
  return { profileIndex: String(table), profileName: name, ...flat(setting), serviceType: "Internet", profileID: id, profileAction: action };
}
