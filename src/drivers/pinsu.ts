import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import type { WcdmaSignal } from "../parsers.ts";
import { checkCellLock, checkLockBands } from "./bands.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverSessionClosedError, hmacMd5Hex, loginLocked, loginUnplaced, wrongPassword } from "./login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleSetting, settleUnlock } from "./readback.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import { type LanHttp, jsonAnswer } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCell,
  DriverCellLockTarget,
  DriverCellular,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverSessionHandle,
  DriverTelemetry,
} from "./types.ts";
import { bandOf, counterOf, intOf, isPlainObject, labelOf, numberOf, operatorOfPlmn, pciOf, plmnCodeOf, rsrpOf, rsrqOf, rssiOf, sinrOf, smallIntOf, textOf } from "./values.ts";

/**
 * Pinsu routers (R200C, R200, R100, M1, U200) and other UNISOC V510 boards on the same firmware:
 * every call is a `POST` of JSON with `Referer: /common/login.html`; the login sends the user name
 * and the password each as HMAC-MD5 with the fixed key the router's page uses, and values come from
 * the `mgdb` database (`/action/get_mgdb_params`) as 3GPP `CESQ` report indexes, which are turned
 * into dBm / dB here by the serving mode. Band locks are `lte:B1,B3;nr5g:N41,N78` clauses; the
 * telemetry names no channel numbers and the firmware no nearby-cell list.
 */

const FAMILY = "pinsu" as const;
const REFERER = "/common/login.html";
/** The key the router's own login page uses for both HMACs. */
const PAGE_KEY = "0123456789";

export function pinsuLoginFields(username: string, password: string): { username: string; password: string } {
  return { username: hmacMd5Hex(PAGE_KEY, username), password: hmacMd5Hex(PAGE_KEY, password) };
}

async function post(http: LanHttp, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await http.request({ method: "POST", path, body: body === "" ? "" : JSON.stringify(body), contentType: "application/json", referer: REFERER });
  const parsed = jsonAnswer(res, `POST ${path}`);
  if (!isPlainObject(parsed)) throw new CpeAnswerFormatError(`POST ${path}: not an object`);
  return parsed;
}

/** A write answer: `retcode` must be `"0"`. */
function requireOk(answer: Record<string, unknown>, what: string): void {
  const code = textOf(answer["retcode"]);
  if (code !== "0") throw new CpeApiError(code !== null && /^\d{1,6}$/.test(code) ? code : "refused", `${what} refused`);
}

async function mgdb(http: LanHttp, keys: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const answer = await post(http, "/action/get_mgdb_params", { keys });
  const code = textOf(answer["retcode"]);
  // Some firmwares answer the values without a retcode
  if (code !== null && code !== "0") throw new CpeApiError(/^\d{1,6}$/.test(code) ? code : "refused", "get_mgdb_params refused");
  return answer;
}

// 3GPP CESQ report indexes (TS 27.007, TS 36.133, TS 38.133); a value already in dBm is kept

/** LTE RSRP: index 0–97 is −140 + index dBm. */
export function lteRsrpOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  if (n === null) return null;
  if (n < 0) return rsrpOf(n);
  return Number.isInteger(n) && n <= 97 ? n - 140 : null;
}

/** NR SS-RSRP: index 0–127 is −156 + index dBm. */
export function nrRsrpOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  if (n === null) return null;
  if (n < 0) return rsrpOf(n);
  return Number.isInteger(n) && n <= 127 ? rsrpOf(n - 156) : null;
}

/** LTE RSRQ: index −30–46 (Rel-12 range) is (index − 40) / 2 dB. */
export function lteRsrqOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  return n !== null && Number.isInteger(n) && n >= -30 && n <= 46 ? rsrqOf((n - 40) / 2) : null;
}

/** NR SS-RSRQ: index 0–127 is index / 2 − 43 dB. */
export function nrRsrqOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 127 ? rsrqOf(n / 2 - 43) : null;
}

/** LTE SINR the UNISOC way: index 0–250 is (index − 1) × 0.2 − 20 dB (255: none). */
export function lteSinrOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  if (n === null || n < 0 || n > 250) return null;
  return sinrOf(Math.round(((Math.trunc(n) - 1) * 0.2 - 20) * 10) / 10);
}

/** NR SS-SINR: index 0–127 is (index − 47) / 2 dB. */
export function nrSinrOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  return n !== null && Number.isInteger(n) && n >= 0 && n <= 127 ? sinrOf((n - 47) / 2) : null;
}

/** RSSI: `rxlev` index 0–63 is index − 110 dBm. */
export function rssiOfIndex(value: unknown): number | null {
  const n = numberOf(value);
  if (n === null) return null;
  if (n < 0) return rssiOf(n);
  return Number.isInteger(n) && n <= 63 ? rssiOf(n - 110) : null;
}

export const PINSU_TELEMETRY_KEYS: ReadonlyArray<string> = [
  "statistics_tx_bytes",
  "statistics_rx_bytes",
  "mnet_sysmode",
  "mnet_operator_name",
  "mnet_rsrp",
  "mnet_rssi",
  "mnet_rsrq",
  "mnet_sinr",
  "mnet_snr",
  "mnet_rscp",
  "mnet_ecio",
  "mnet_wnw_pci",
  "mnet_wnw_band",
  "mnet_wnw_pspci",
  "mnet_wnw_psband",
  "mnet_endc_rsrp",
  "mnet_endc_snr",
  "mnet_endc_rsrq",
];

const LOCK_KEYS = ["mnet_band_lock_list", "mnet_band_lock_type", "mnet_band_lock_info", "mnet_cell_lock_info", "mnet_acqorder"] as const;

const ACQ_ORDER: Readonly<Record<"auto" | "lte" | "nr_sa", string>> = { auto: "auto", lte: "4g only", nr_sa: "5g only" };

/** The firmware's own SINR in dB when it reports one, else its index converted. */
function sinrOfEither(direct: unknown, index: unknown, convert: (value: unknown) => number | null): number | null {
  const n = numberOf(direct);
  return n !== null && n >= -23 && n <= 40 && textOf(direct) !== "255" ? n : convert(index);
}

export function parsePinsuTelemetry(raw: Record<string, unknown>): DriverTelemetry {
  const sysmode = textOf(raw["mnet_sysmode"])?.toLowerCase() ?? null;
  const sa = sysmode === "nr5g";
  const psBand = bandOf(raw["mnet_wnw_psband"]);
  const endcRsrp = nrRsrpOfIndex(raw["mnet_endc_rsrp"]);
  const endc = !sa && (psBand !== null || endcRsrp !== null);
  let lte: DriverCell | null = null;
  let nr: DriverCell | null = null;
  if (sa) {
    nr = {
      ...emptyCell(),
      band: bandOf(raw["mnet_wnw_band"]),
      pci: pciOf(raw["mnet_wnw_pci"], "NR"),
      rsrpDbm: nrRsrpOfIndex(raw["mnet_rsrp"]),
      rsrqDb: nrRsrqOfIndex(raw["mnet_rsrq"]),
      sinrDb: sinrOfEither(raw["mnet_sinr"], raw["mnet_snr"], nrSinrOfIndex),
    };
  } else {
    lte = {
      ...emptyCell(),
      band: bandOf(raw["mnet_wnw_band"]),
      pci: pciOf(raw["mnet_wnw_pci"], "LTE"),
      rsrpDbm: lteRsrpOfIndex(raw["mnet_rsrp"]),
      rsrqDb: lteRsrqOfIndex(raw["mnet_rsrq"]),
      sinrDb: sinrOfEither(raw["mnet_sinr"], raw["mnet_snr"], lteSinrOfIndex),
      rssiDbm: rssiOfIndex(raw["mnet_rssi"]),
    };
    if (endc) {
      nr = { ...emptyCell(), band: psBand, pci: pciOf(raw["mnet_wnw_pspci"], "NR"), rsrpDbm: endcRsrp, rsrqDb: nrRsrqOfIndex(raw["mnet_endc_rsrq"]), sinrDb: nrSinrOfIndex(raw["mnet_endc_snr"]) };
    }
  }
  const mode = sa ? "SA" : sysmode === "lte" ? (endc ? "NSA" : "LTE") : sysmode === "wcdma" ? "WCDMA" : sysmode === null ? null : "NONE";
  return {
    model: null,
    softwareVersion: null,
    hardwareVersion: null,
    // The operator's name, or on some firmware its PLMN (notes: "46000" / "CMCC" / "CHINA MOBILE")
    operatorName: operatorOfPlmn(plmnCodeOf(raw["mnet_operator_name"])) ?? labelOf(raw["mnet_operator_name"]),
    plmn: plmnCodeOf(raw["mnet_operator_name"]),
    mode,
    lte: lte && cellHasData(lte) ? lte : null,
    nr: nr && cellHasData(nr) ? nr : null,
    carriers: [],
    wan: { connected: null, ipv4: null, ipv6: null, uptimeSec: null },
    traffic: {
      downloadBytesPerSec: null,
      uploadBytesPerSec: null,
      totalDownloadBytes: counterOf(raw["statistics_rx_bytes"]),
      totalUploadBytes: counterOf(raw["statistics_tx_bytes"]),
      sessionDownloadBytes: null,
      sessionUploadBytes: null,
      sessionSeconds: null,
      monthDownloadBytes: null,
      monthUploadBytes: null,
      monthTotalBytes: null,
      monthSeconds: null,
    },
    temperatureC: null,
    signalBars: null,
    wcdma: pinsuWcdma(raw["mnet_rscp"], raw["mnet_ecio"]),
  };
}

/**
 * The 3G serving cell from the module's CESQ indices (3GPP TS 27.007 `+CESQ`, notes library A §4.1):
 * RSCP `0`–`96` is −120 to −24 dBm, Ec/Io `0`–`49` is −24 to +0.5 dB in half-dB steps; `255` is "not
 * on 3G". `null` when neither is reported.
 */
export function pinsuWcdma(rscpIndex: unknown, ecioIndex: unknown): WcdmaSignal | null {
  const r = smallIntOf(rscpIndex, 96);
  const e = smallIntOf(ecioIndex, 49);
  if (r === null && e === null) return null;
  return { rscpDbm: r === null ? null : r - 120, ecioDb: e === null ? null : e * 0.5 - 24, psc: null };
}

/** `lte:B1,B3;nr5g:N41,N78` (either clause optional) as band lists; `null` for a clause that is absent or unreadable. */
export function parseBandClauses(value: unknown): { lte: number[] | null; nr: number[] | null } {
  const text = textOf(value) ?? "";
  const out: { lte: number[] | null; nr: number[] | null } = { lte: null, nr: null };
  for (const clause of text.split(";").slice(0, 4)) {
    const [name, list = ""] = clause.split(":", 2).map((s) => s.trim());
    const bands = list
      .split(",")
      .map((item) => bandOf(item))
      .filter((b): b is number => b !== null);
    if (name?.toLowerCase() === "lte") out.lte = bands;
    if (name?.toLowerCase() === "nr5g") out.nr = bands;
  }
  return out;
}

export function pinsuBandClauses(lte: ReadonlyArray<number>, nr: ReadonlyArray<number>): string {
  const clauses: string[] = [];
  if (lte.length > 0) clauses.push(`lte:${[...lte].sort((a, b) => a - b).map((b) => `B${b}`).join(",")}`);
  if (nr.length > 0) clauses.push(`nr5g:${[...nr].sort((a, b) => a - b).map((b) => `N${b}`).join(",")}`);
  return clauses.join(";");
}

function cellOf(parts: string[] | undefined, rat: "LTE" | "NR"): CellLockState | null {
  if (!parts) return null;
  const arfcn = intOf(parts[0]);
  const pci = pciOf(parts[1], rat);
  if (arfcn === null || arfcn <= 0) return { locked: false };
  return { locked: true, arfcn, pci, band: rat === "NR" ? bandOf(parts[2]) : null };
}

export function parsePinsuLockState(raw: Record<string, unknown>): DriverLockState {
  const types = (textOf(raw["mnet_band_lock_type"]) ?? "").split(",").map((s) => s.trim().toLowerCase());
  const info = parseBandClauses(raw["mnet_band_lock_info"]);
  const list = parseBandClauses(raw["mnet_band_lock_list"]);
  const lockOf = (type: string | undefined, bands: number[] | null): number[] | "all" | null => {
    if (type === "unlock") return "all";
    if (type === "lock") return bands && bands.length > 0 ? bands : null;
    return null;
  };
  // lte,<earfcn>,<pci>;nr5g,<arfcn>,<pci>,<band>,<scs>
  const cells = (textOf(raw["mnet_cell_lock_info"]) ?? "").split(";");
  const lteCell = cells.find((c) => c.trim().toLowerCase().startsWith("lte,"));
  const nrCell = cells.find((c) => c.trim().toLowerCase().startsWith("nr5g,"));
  const order = textOf(raw["mnet_acqorder"])?.toLowerCase();
  const mode = (Object.entries(ACQ_ORDER) as Array<[DriverNetworkMode, string]>).find(([, name]) => name === order)?.[0] ?? null;
  const known = typeof raw["mnet_cell_lock_info"] === "string";
  return {
    lteBands: lockOf(types[0], info.lte),
    nrBands: lockOf(types[1], info.nr),
    lteCell: lteCell ? cellOf(lteCell.split(",").slice(1), "LTE") : known ? { locked: false } : null,
    nrCell: nrCell ? cellOf(nrCell.split(",").slice(1), "NR") : known ? { locked: false } : null,
    networkMode: mode,
    supportedLte: list.lte && list.lte.length > 0 ? list.lte : null,
    supportedNr: list.nr && list.nr.length > 0 ? list.nr : null,
  };
}

class PinsuSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  #open = true;

  constructor(http: LanHttp) {
    this.#http = http;
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    // The firmware names no model or version where FengSui reads
    return { model: null, softwareVersion: null, hardwareVersion: null };
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    return parsePinsuTelemetry(await mgdb(this.#http, PINSU_TELEMETRY_KEYS));
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    throw new SectionUnavailableError("The nearby-cell list", null);
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    return parsePinsuLockState(await mgdb(this.#http, LOCK_KEYS));
  }

  async #write(check: WriteCheck, action: string, body: unknown): Promise<void> {
    this.#guard();
    noteSent(check, FAMILY, action);
    requireOk(await post(this.#http, `/action/${action}`, body), action);
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    if (target.networkMode === "nr_nsa") throw new CpeControlValidationError("This router offers automatic, 4G only and 5G only, not 5G NSA only");
    // LTE and NR are written together: NR bands left as they are need the current ones
    const before = await this.lockState();
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, before.supportedLte);
    const nr = target.nr === null ? before.nrBands : target.nr === "all" ? "all" : checkLockBands("NR", target.nr, before.supportedNr);
    if (nr === null) throw new CpeControlValidationError("The router did not say which NR bands are locked: choose the NR bands too");
    await this.#write(check, "mnet_set_band_lock_switch", {
      mnet_band_lock_type: `${lte === "all" ? "unlock" : "lock"},${nr === "all" ? "unlock" : "lock"}`,
      mnet_band_lock_info: pinsuBandClauses(lte === "all" ? [] : lte, nr === "all" ? [] : nr),
    });
    if (target.networkMode !== null) await this.#write(check, "mnet_set_prefer_net_mode", { mnet_acqorder: ACQ_ORDER[target.networkMode], mnet_band: "auto", mnet_scan_mode: "auto" });
    settleBandLock(check, { lte, nr: target.nr === null ? null : nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  /** The network mode as a setting of its own: `mnet_set_prefer_net_mode` with one of the three orders the notes list, read back from `mnet_acqorder`. */
  readonly cellular: DriverCellular = {
    read: async () => {
      this.#guard();
      return { networkMode: parsePinsuLockState(await mgdb(this.#http, ["mnet_acqorder"])).networkMode };
    },
    setNetworkMode: async (mode, check) => {
      const order = Object.hasOwn(ACQ_ORDER, mode) ? ACQ_ORDER[mode as keyof typeof ACQ_ORDER] : undefined;
      if (order === undefined) throw new CpeControlValidationError(`This router has no "${mode}" network mode`);
      await this.#write(check, "mnet_set_prefer_net_mode", { mnet_acqorder: order, mnet_band: "auto", mnet_scan_mode: "auto" });
      const after = await mgdb(this.#http, ["mnet_acqorder"]).catch(() => null);
      settleSetting(check, after === null ? null : parsePinsuLockState(after).networkMode === mode);
    },
  };

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const t = checkCellLock(target);
    if (t.rat === "LTE") {
      await this.#write(check, "mnet_set_celllock_switch", { mnet_cell_lock_rat: "3", mnet_cell_lock_arfcn: String(t.arfcn), mnet_cell_lock_pci: String(t.pci), mnet_cell_lock_type: "1" });
    } else {
      if (t.scsKhz !== 15 && t.scsKhz !== 30) throw new CpeControlValidationError(`This router locks NR cells with a 15 or 30 kHz subcarrier spacing only (asked: ${String(t.scsKhz)} kHz)`);
      await this.#write(check, "mnet_set_celllock_switch", {
        mnet_cell_lock_rat: "4",
        mnet_cell_lock_arfcn: String(t.arfcn),
        mnet_cell_lock_scs: String(t.scsKhz),
        mnet_cell_lock_pci: String(t.pci),
        mnet_cell_lock_band: String(t.band),
        mnet_cell_lock_type: "1",
      });
    }
    settleCellLock(check, t, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    if (before.lteBands !== "all" || before.nrBands !== "all") await this.#write(check, "mnet_set_band_lock_switch", { mnet_band_lock_type: "unlock,unlock", mnet_band_lock_info: "" });
    if (before.lteCell?.locked !== false) await this.#write(check, "mnet_set_celllock_switch", { mnet_cell_lock_rat: "13", mnet_cell_lock_type: "1" });
    if (before.nrCell?.locked !== false) await this.#write(check, "mnet_set_celllock_switch", { mnet_cell_lock_rat: "14", mnet_cell_lock_type: "1" });
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#write(check, "mnet_set_prefer_net_mode", { mnet_acqorder: "auto", mnet_band: "auto", mnet_scan_mode: "auto" });
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#write(check, "reboot", "");
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await post(this.#http, "/action/logout", "");
  }
}

export const pinsuProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    const status = textOf((await post(http, "/goform/get_login_info", ""))["loginStatus"]);
    return status === "0" || status === "1";
  },

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    // The page's own first request: a router that does not answer it is not of this family, and gets no password
    await post(http, "/goform/sync", "");
    const info = await post(http, "/goform/get_login_info", "");
    // Signed in, and not by this session (it has none yet): someone is on the router's page
    return { occupied: textOf(info["loginStatus"]) === "1", locked: null };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const answer = await post(http, "/goform/login", pinsuLoginFields(credentials.username || "admin", credentials.password));
    const code = textOf(answer["retcode"]);
    if (code === "0") return new PinsuSession(http);
    const remain = intOf(answer["remain_times"]);
    const waitSec = intOf(answer["remain_secs"]);
    // Locked: no attempt left, or a countdown running (some builds name only the countdown)
    if (code === "201" && (remain === 0 || (waitSec !== null && waitSec > 0))) throw loginLocked("the router has locked its login", waitSec);
    if (code === "201") throw wrongPassword("the router refused the user name or password", remain);
    throw loginUnplaced(`login answered ${code ?? "no retcode"}`);
  },
};
