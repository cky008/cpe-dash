import type { NetworkMode, OperatorChoice } from "../../cellular.ts";
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
