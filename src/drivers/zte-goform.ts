import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import { bandsToHex, bandsToList, checkCellLock, checkLockBands, hexToBands, listToBands } from "./bands.ts";
import { carriersFromRows, neighbourOf, ratOf, ratOfChannel, servingModeOf } from "./cells.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, md5Hex, sha256Hex, signedInElsewhere, wrongPassword } from "./login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleUnlock } from "./readback.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import type { LanHttp } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCarrier,
  DriverCell,
  DriverCellLockTarget,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverSessionHandle,
  DriverTelemetry,
} from "./types.ts";
import {
  arfcnOf,
  bandOf,
  counterOf,
  fieldOf,
  firstOf,
  identityOf,
  intOf,
  ipv4Of,
  ipv6Of,
  isPlainObject,
  labelOf,
  mhzOf,
  nonNegativeOf,
  pciOf,
  plmnOf,
  rowsOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
} from "./values.ts";

/**
 * ZTE routers with the goform web interface (MC801A, MC888, MC889, MC7010, MU5001, F50, MF28x…):
 * `GET /goform/goform_get_cmd_process?cmd=a,b&multi_data=1` reads named values, `POST
 * /goform/goform_set_cmd_process` writes, and every write but the login carries `AD`, a digest of the
 * firmware version and a fresh `RD` nonce. The login method is settled before the password goes out:
 * a 64-digit `LD` nonce means the double SHA-256; no nonce means the single SHA-256 the page's
 * `config.js` announces, or Base64; anything else sends nothing. PCIs and cell identities come as
 * hexadecimal. Firmware generations differ in how they write band and cell locks (`zteBranch`).
 */

const FAMILY = "zte-goform" as const;
const GET_PATH = "/goform/goform_get_cmd_process";
const SET_PATH = "/goform/goform_set_cmd_process";
const REFERER = "/index.html";
const XHR: Readonly<Record<string, string>> = { "X-Requested-With": "XMLHttpRequest" };

/**
 * How a firmware writes band and cell locks: `1` the standard goform (MC801A, MC7010, MU5001), `2`
 * the MC888 / MC8830 merge, `3` the MC8020 / `3351` legacy, `4` the comma lists of the MC8512 / U60 Pro.
 */
export type ZteBranch = 1 | 2 | 3 | 4;

export interface ZteVersion {
  modelName: string;
  hardwareVersion: string;
  waInnerVersion: string;
  crVersion: string;
}

export function zteBranch(version: Pick<ZteVersion, "hardwareVersion" | "modelName">): ZteBranch {
  const hw = `${version.hardwareVersion} ${version.modelName}`;
  if (hw.includes("8020") || hw.includes("3351")) return 3;
  if (hw.includes("888") || hw.includes("MC8830")) return 2;
  if (hw.includes("MC8512") || hw.includes("U60Pro") || hw.includes("MU5250")) return 4;
  return 1;
}

/** `sha256-ld`: double SHA-256 with the login nonce; `sha256`: one SHA-256; `base64`: the oldest pages. */
export type ZteLoginMethod = { kind: "sha256-ld"; ld: string } | { kind: "sha256" } | { kind: "base64" };

/** The `password` field of `goformId=LOGIN`, as the router's page computes it. */
export function zteLoginPassword(method: ZteLoginMethod, password: string): string {
  if (method.kind === "sha256-ld") return sha256Hex(`${sha256Hex(password, true)}${method.ld}`, true);
  if (method.kind === "sha256") return sha256Hex(password, true);
  return Buffer.from(password, "utf8").toString("base64");
}

/** `AD` of a write: SHA-256 (uppercase) on SHA-256 logins, MD5 (lowercase) on the older ones. */
export function zteActionDigest(hash: "sha256" | "md5", version: Pick<ZteVersion, "waInnerVersion" | "crVersion">, rd: string): string {
  const seed = `${version.waInnerVersion}${version.crVersion}`;
  return hash === "sha256" ? sha256Hex(`${sha256Hex(seed, true)}${rd}`, true) : md5Hex(`${md5Hex(seed)}${rd}`);
}

const HEX_64 = /^[0-9A-Fa-f]{64}$/;

/** The login method from the nonce and the page's configuration (`null`: none FengSui can be sure of). */
export function zteLoginMethodOf(ld: string | null, configJs: string | null): ZteLoginMethod | null {
  if (ld !== null && ld !== "") return HEX_64.test(ld) ? { kind: "sha256-ld", ld } : null;
  if (configJs === null) return null;
  // A page that wants the nonce, without one: the login would not be the one the page sends
  if (configJs.includes("WEB_ATTR_IF_SUPPORT_SHA256:2")) return null;
  return configJs.includes("WEB_ATTR_IF_SUPPORT_SHA256:1") ? { kind: "sha256" } : { kind: "base64" };
}

async function getCmd(http: LanHttp, keys: ReadonlyArray<string>, multi = true): Promise<Record<string, unknown>> {
  const query: Array<[string, string]> = [
    ["isTest", "false"],
    ["cmd", keys.join(",")],
  ];
  if (multi) query.push(["multi_data", "1"]);
  query.push(["_", String(Date.now())]);
  const answer = await http.getJson(GET_PATH, { query, referer: REFERER, headers: XHR });
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError("GET goform_get_cmd_process: not an object");
  return answer;
}

async function setCmd(http: LanHttp, fields: ReadonlyArray<readonly [string, string]>): Promise<Record<string, unknown>> {
  const answer = await http.postForm(SET_PATH, fields, { referer: REFERER, headers: XHR });
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError("POST goform_set_cmd_process: not an object");
  return answer;
}

/** A router answer's code as it may be kept (letters, digits, `_` and `-` only). */
export function answerCode(value: unknown): string {
  const text = textOf(value);
  return text !== null && /^[A-Za-z0-9_-]{1,16}$/.test(text) ? text : "refused";
}

const VERSION_KEYS = ["model_name", "hardware_version", "wa_inner_version", "cr_version"] as const;

const LOCK_STATUS_KEYS = ["psw_fail_num_str", "login_lock_time"] as const;

export const ZTE_TELEMETRY_KEYS: ReadonlyArray<string> = [
  ...VERSION_KEYS,
  "network_type",
  "network_provider",
  "network_provider_fullname",
  "Operator",
  "spn_name_data",
  "rmcc",
  "rmnc",
  "ppp_status",
  "wan_connect_status",
  "wan_ipaddr",
  "ipv6_wan_ipaddr",
  "signalbar",
  "wan_active_band",
  "lte_ca_pcell_band",
  "ZCELLINFO_band",
  "wan_active_channel",
  "lte_ca_pcell_arfcn",
  "Z_dl_earfcn",
  "lte_pci",
  "Z_PCI",
  "cell_id",
  "lac_code",
  "lte_rsrp",
  "lte_rsrq",
  "lte_rssi",
  "rssi",
  "lte_snr",
  "sinr",
  "lte_ca_pcell_bandwidth",
  "lte_rank",
  "lte_cqi0",
  "lte_dl_mcs",
  "lte_ul_mcs",
  "lte_rx0_rsrp",
  "lte_rx1_rsrp",
  "lte_rx2_rsrp",
  "lte_rx3_rsrp",
  "wan_lte_ca",
  "lte_multi_ca_scell_info",
  "nr5g_action_band",
  "nr5g_action_nsa_band",
  "Z5g_CELLINFO_band",
  "nr5g_action_channel",
  "Z5g_dlEarfcn",
  "nr_ca_pcell_freq",
  "nr5g_pci",
  "Z5g_PCI",
  "nr5g_cell_id",
  "Z5g_CELL_ID",
  "Z5g_tac",
  "Z5g_rsrp",
  "Z5g_rsrq",
  "Z5g_SINR",
  "Z5g_snr",
  "nr5g_dl_bandwidth",
  "nr_rank",
  "nr_cqi0",
  "nr_dl_mcs",
  "nr_ul_mcs",
  "5g_rx0_rsrp",
  "5g_rx1_rsrp",
  "5g_rx2_rsrp",
  "5g_rx3_rsrp",
  "nr_multi_ca_scell_info",
  "pm_sensor_mdm",
  "pm_modem_5g",
  "pm_sensor_5g",
  "pm_sensor_pa1",
  "realtime_rx_thrpt",
  "realtime_tx_thrpt",
  "flux_realtime_rx_thrpt",
  "flux_realtime_tx_thrpt",
  "realtime_rx_bytes",
  "realtime_tx_bytes",
  "realtime_time",
  "flux_realtime_time",
  "monthly_rx_bytes",
  "monthly_tx_bytes",
  "monthly_time",
  "flux_monthly_rx_bytes",
  "flux_monthly_tx_bytes",
  "flux_monthly_time",
  "network_information",
];

const NEIGHBOUR_KEYS = ["neighbor_cell_info", "neighbour_cell_list", "ngbr_cell_info"] as const;

const LOCK_KEYS = [
  "lte_band_lock",
  "nr5g_band_mask",
  "nr5g_sa_band_lock",
  "Z5g_lockband_sa_mask",
  "Z5g_lockband_no_format_mask",
  "nr_band_lock",
  "lte_pci_lock",
  "lte_earfcn_lock",
  "nr5g_cell_lock",
  "Z5g_lockcell_pci",
  "Z5g_lockcell_arfcn",
  "Z5g_lockcell_band",
  "net_select",
  "BearerPreference",
] as const;

/** Every LTE band, as the router's own "all bands" mask (B1–B48 that ZTE modems carry). */
export const ZTE_LTE_ALL_MASK = "a3e2ab0908df";

/** Every NR band, as ZTE's own pages unlock them. */
export const ZTE_NR_ALL_BANDS: ReadonlyArray<number> = [1, 2, 3, 5, 7, 8, 20, 28, 38, 41, 50, 51, 66, 70, 71, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84];

const BEARER: Readonly<Record<DriverNetworkMode, string>> = { auto: "WL_AND_5G", lte: "Only_LTE", nr_sa: "Only_5G", nr_nsa: "LTE_AND_5G" };

function networkModeOf(value: unknown): DriverNetworkMode | null {
  const text = textOf(value)?.toUpperCase();
  if (!text) return null;
  if (text === "WL_AND_5G" || text === "NETWORK_AUTO" || text === "AUTO") return "auto";
  if (text === "ONLY_LTE") return "lte";
  if (text === "ONLY_5G") return "nr_sa";
  if (text === "LTE_AND_5G") return "nr_nsa";
  return null;
}

function rxChains(raw: Record<string, unknown>, prefix: string): Array<number | null> | null {
  const chains = [0, 1, 2, 3].map((i) => rsrpOf(raw[`${prefix}${i}_rsrp`]));
  return chains.some((v) => v !== null) ? chains : null;
}

function connectedOf(value: unknown): boolean | null {
  const text = textOf(value)?.toLowerCase();
  if (!text) return null;
  if (text.includes("disconnect") || text.includes("no_connected") || text.includes("connecting") || text === "no_service") return false;
  return text.endsWith("connected") ? true : null;
}

/** One telemetry read (`ZTE_TELEMETRY_KEYS`) in FengSui's shape. */
export function parseZteGoformTelemetry(raw: Record<string, unknown>): DriverTelemetry {
  const info = isPlainObject(raw["network_information"]) ? raw["network_information"] : {};
  const v = (key: string): unknown => raw[key];
  const i = (key: string): unknown => fieldOf(info, key);
  const mode = servingModeOf(v("network_type")) ?? servingModeOf(i("network_type"));

  const lte: DriverCell = {
    ...emptyCell(),
    band: firstOf(bandOf, v("wan_active_band"), v("lte_ca_pcell_band"), v("ZCELLINFO_band"), i("Lte_bands")),
    arfcn: firstOf((x) => arfcnOf(x, "LTE"), v("wan_active_channel"), v("lte_ca_pcell_arfcn"), v("Z_dl_earfcn"), i("Lte_fcn")),
    pci: firstOf((x) => pciOf(x, "LTE", 16), v("lte_pci"), v("Z_PCI"), i("Lte_pci")),
    cellId: firstOf((x) => identityOf(x, 16), v("cell_id"), i("Lte_cell_id")),
    tac: firstOf((x) => identityOf(x, 16), v("lac_code"), i("lte_tac")),
    rsrpDbm: firstOf(rsrpOf, v("lte_rsrp"), i("lte_rsrp")),
    rsrqDb: firstOf(rsrqOf, v("lte_rsrq"), i("lte_rsrq")),
    sinrDb: firstOf(sinrOf, v("lte_snr"), v("sinr"), i("Lte_snr")),
    rssiDbm: firstOf(rssiOf, v("lte_rssi"), v("rssi")),
    bandwidthMhz: mhzOf(v("lte_ca_pcell_bandwidth")),
    mimoLayers: smallIntOf(v("lte_rank"), 8),
    cqi: smallIntOf(v("lte_cqi0"), 15),
    dlMcs: smallIntOf(v("lte_dl_mcs"), 31),
    ulMcs: smallIntOf(v("lte_ul_mcs"), 31),
    rxRsrpDbm: rxChains(raw, "lte_rx"),
  };
  const nr: DriverCell = {
    ...emptyCell(),
    band: firstOf(bandOf, v("nr5g_action_band"), v("nr5g_action_nsa_band"), v("Z5g_CELLINFO_band"), i("Nr_bands")),
    arfcn: firstOf((x) => arfcnOf(x, "NR"), v("nr5g_action_channel"), v("Z5g_dlEarfcn"), v("nr_ca_pcell_freq"), i("Nr_fcn")),
    pci: firstOf((x) => pciOf(x, "NR", 16), v("nr5g_pci"), v("Z5g_PCI"), i("Nr_pci")),
    cellId: firstOf((x) => identityOf(x, 16), v("nr5g_cell_id"), v("Z5g_CELL_ID"), i("Nr_cell_id")),
    tac: firstOf((x) => identityOf(x, "auto"), i("nr_tac"), v("Z5g_tac")),
    rsrpDbm: firstOf(rsrpOf, v("Z5g_rsrp"), i("nr_rsrp")),
    rsrqDb: firstOf(rsrqOf, v("Z5g_rsrq"), i("nr_rsrq")),
    sinrDb: firstOf(sinrOf, v("Z5g_SINR"), v("Z5g_snr"), i("Nr_snr")),
    bandwidthMhz: mhzOf(v("nr5g_dl_bandwidth")),
    mimoLayers: smallIntOf(v("nr_rank"), 8),
    cqi: smallIntOf(v("nr_cqi0"), 15),
    dlMcs: smallIntOf(v("nr_dl_mcs"), 31),
    ulMcs: smallIntOf(v("nr_ul_mcs"), 31),
    rxRsrpDbm: rxChains(raw, "5g_rx"),
  };
  // A dormant NR leg of EN-DC keeps its band and channel but reports no RSRP (or a sentinel): not a cell
  const nrActive = cellHasData(nr) && (nr.rsrpDbm !== null || mode === "SA");
  const lteActive = cellHasData(lte) && mode !== "SA";

  const caOn = textOf(v("wan_lte_ca"))?.toLowerCase();
  const carriers: DriverCarrier[] = [];
  if (caOn !== "ca_deactivated") {
    // Two layouts in the field: idx,pci,band,earfcn,dl_bw,ul_bw and idx,pci,state,band,earfcn,dl_bw
    carriers.push(
      ...carriersFromRows(
        "LTE",
        v("lte_multi_ca_scell_info"),
        [
          { pci: 1, band: 2, arfcn: 3, bandwidth: 4 },
          { pci: 1, band: 3, arfcn: 4, bandwidth: 5 },
        ],
        10
      )
    );
  }
  carriers.push(
    ...carriersFromRows(
      "NR",
      v("nr_multi_ca_scell_info"),
      [
        { pci: 1, band: 3, arfcn: 4, bandwidth: 5 },
        { pci: 1, band: 2, arfcn: 3, bandwidth: 4 },
      ],
      10
    )
  );

  const monthDown = counterOf(v("monthly_rx_bytes")) ?? counterOf(v("flux_monthly_rx_bytes"));
  const monthUp = counterOf(v("monthly_tx_bytes")) ?? counterOf(v("flux_monthly_tx_bytes"));
  const temps = [v("pm_sensor_mdm"), v("pm_modem_5g"), v("pm_sensor_5g")].map(temperatureOf).filter((t): t is number => t !== null);
  return {
    model: labelOf(v("model_name")) ?? labelOf(v("hardware_version")),
    softwareVersion: labelOf(v("wa_inner_version")) ?? labelOf(v("cr_version")),
    hardwareVersion: labelOf(v("hardware_version")),
    operatorName: firstOf(labelOf, v("network_provider_fullname"), v("network_provider"), v("Operator"), v("spn_name_data")),
    plmn: plmnOf(v("rmcc"), v("rmnc")),
    mode,
    lte: lteActive ? lte : null,
    nr: nrActive ? nr : null,
    carriers,
    wan: {
      connected: connectedOf(v("ppp_status")) ?? connectedOf(v("wan_connect_status")),
      ipv4: ipv4Of(v("wan_ipaddr")),
      ipv6: ipv6Of(v("ipv6_wan_ipaddr")),
      uptimeSec: nonNegativeOf(v("realtime_time")) ?? nonNegativeOf(v("flux_realtime_time")),
    },
    traffic: {
      downloadBytesPerSec: nonNegativeOf(v("realtime_rx_thrpt")) ?? nonNegativeOf(v("flux_realtime_rx_thrpt")),
      uploadBytesPerSec: nonNegativeOf(v("realtime_tx_thrpt")) ?? nonNegativeOf(v("flux_realtime_tx_thrpt")),
      totalDownloadBytes: null,
      totalUploadBytes: null,
      sessionDownloadBytes: counterOf(v("realtime_rx_bytes")),
      sessionUploadBytes: counterOf(v("realtime_tx_bytes")),
      sessionSeconds: nonNegativeOf(v("realtime_time")) ?? nonNegativeOf(v("flux_realtime_time")),
      monthDownloadBytes: monthDown,
      monthUploadBytes: monthUp,
      monthTotalBytes: null,
      monthSeconds: nonNegativeOf(v("monthly_time")) ?? nonNegativeOf(v("flux_monthly_time")),
    },
    temperatureC: temps.length > 0 ? Math.max(...temps) : temperatureOf(v("pm_sensor_pa1")),
    signalBars: smallIntOf(v("signalbar"), 5),
  };
}

function neighbourRow(row: string[]): DriverNeighbour | null {
  // rat,band,arfcn,pci,rsrp,rsrq,sinr | band,arfcn,pci,rsrp,rsrq,sinr | earfcn,pci,rsrp,rsrq,sinr
  if (row.length >= 7) {
    const rat = ratOf(row[0]) ?? ratOfChannel(arfcnOf(row[2], "NR"));
    return rat ? neighbourOf(rat, { band: row[1], arfcn: row[2], pci: row[3], rsrp: row[4], rsrq: row[5], sinr: row[6] }) : null;
  }
  if (row.length === 6) {
    const rat = /^n/i.test(row[0] ?? "") ? "NR" : ratOfChannel(arfcnOf(row[1], "NR"));
    return rat ? neighbourOf(rat, { band: row[0], arfcn: row[1], pci: row[2], rsrp: row[3], rsrq: row[4], sinr: row[5] }) : null;
  }
  if (row.length === 5) {
    const rat = ratOfChannel(arfcnOf(row[0], "NR"));
    return rat ? neighbourOf(rat, { arfcn: row[0], pci: row[1], rsrp: row[2], rsrq: row[3], sinr: row[4] }) : null;
  }
  return null;
}

/** Nearby cells from whichever list the firmware fills (`null`: it names none). */
export function parseZteNeighbours(raw: Record<string, unknown>): DriverNeighbour[] | null {
  let seen = false;
  const out: DriverNeighbour[] = [];
  for (const key of NEIGHBOUR_KEYS) {
    const value = fieldOf(raw, key);
    if (Array.isArray(value)) {
      seen = true;
      for (const item of value.slice(0, 64)) {
        if (!isPlainObject(item)) continue;
        const arfcn = arfcnOf(fieldOf(item, "earfcn") ?? fieldOf(item, "arfcn"), "NR");
        const rat = ratOf(fieldOf(item, "rat")) ?? (/^n/i.test(textOf(fieldOf(item, "band")) ?? "") ? "NR" : ratOfChannel(arfcn));
        const cell = rat
          ? neighbourOf(rat, { band: fieldOf(item, "band"), arfcn: fieldOf(item, "earfcn") ?? fieldOf(item, "arfcn"), pci: fieldOf(item, "pci"), rsrp: fieldOf(item, "rsrp"), rsrq: fieldOf(item, "rsrq"), sinr: fieldOf(item, "sinr") })
          : null;
        if (cell) out.push(cell);
      }
    } else if (typeof value === "string") {
      seen = true;
      for (const row of rowsOf(value)) {
        const cell = neighbourRow(row);
        if (cell) out.push(cell);
      }
    }
  }
  return seen ? out : null;
}

function lteLockOf(raw: Record<string, unknown>): number[] | "all" | null {
  const text = textOf(raw["lte_band_lock"]);
  if (text === null) return null;
  const bands = /^0x/i.test(text) || /[a-f]/i.test(text) ? hexToBands(text) : listToBands(text);
  if (bands === null) return null;
  const all = hexToBands(ZTE_LTE_ALL_MASK) ?? [];
  if (bands.length === 0 || all.every((b) => bands.includes(b))) return "all";
  return bands;
}

function nrLockOf(raw: Record<string, unknown>): number[] | "all" | null {
  for (const key of ["nr5g_band_mask", "Z5g_lockband_no_format_mask", "nr_band_lock", "nr5g_sa_band_lock", "Z5g_lockband_sa_mask"]) {
    const text = textOf(raw[key]);
    if (text === null) continue;
    const bands = /^0x/i.test(text) ? hexToBands(text) : listToBands(text);
    if (bands === null) continue;
    if (bands.length === 0 || ZTE_NR_ALL_BANDS.every((b) => bands.includes(b))) return "all";
    return bands;
  }
  return null;
}

/** `0` / `1` are the firmware's "no lock" values (also for the channel), never a real lock. */
function unlockedChannel(arfcn: number | null): boolean {
  return arfcn === null || arfcn <= 1;
}

function lteCellOf(raw: Record<string, unknown>): CellLockState | null {
  if (textOf(raw["lte_earfcn_lock"]) === null && textOf(raw["lte_pci_lock"]) === null) return null;
  const arfcn = intOf(raw["lte_earfcn_lock"]);
  if (unlockedChannel(arfcn)) return { locked: false };
  return { locked: true, arfcn, pci: pciOf(raw["lte_pci_lock"], "LTE"), band: null };
}

function nrCellOf(raw: Record<string, unknown>): CellLockState | null {
  const packed = rowsOf(raw["nr5g_cell_lock"])[0];
  if (packed && packed.length >= 3) {
    const arfcn = intOf(packed[1]);
    if (unlockedChannel(arfcn)) return { locked: false };
    return { locked: true, pci: pciOf(packed[0], "NR"), arfcn, band: bandOf(packed[2]) };
  }
  if (textOf(raw["Z5g_lockcell_arfcn"]) !== null) {
    const arfcn = intOf(raw["Z5g_lockcell_arfcn"]);
    if (unlockedChannel(arfcn)) return { locked: false };
    return { locked: true, pci: pciOf(raw["Z5g_lockcell_pci"], "NR"), arfcn, band: bandOf(raw["Z5g_lockcell_band"]) };
  }
  return null;
}

export function parseZteLockState(raw: Record<string, unknown>): DriverLockState {
  return {
    lteBands: lteLockOf(raw),
    nrBands: nrLockOf(raw),
    lteCell: lteCellOf(raw),
    nrCell: nrCellOf(raw),
    networkMode: networkModeOf(raw["net_select"]) ?? networkModeOf(raw["BearerPreference"]),
    supportedLte: null,
    supportedNr: null,
  };
}

type Form = Array<[string, string]>;

/** The LTE band lock of `branch` (`"all"`: the router's every-band mask). */
export function zteLteBandForm(branch: ZteBranch, bands: ReadonlyArray<number> | "all"): { goformId: string; fields: Form } {
  const hex = bands === "all" ? ZTE_LTE_ALL_MASK : bandsToHex(bands);
  if (branch === 3) return { goformId: "SET_NETWORK_BAND_LOCK", fields: [["lte_band_lock", `0x${hex}`], ["wcdma_band_lock", "+"]] };
  if (branch === 4) return { goformId: "LTE_BAND_LOCK", fields: [["lte_band_lock", hex]] };
  return {
    goformId: "BAND_SELECT",
    fields: [
      ["is_gw_band", "0"],
      ["gw_band_mask", "0"],
      ["is_lte_band", "1"],
      ["lte_band_mask", `0x${hex}`],
    ],
  };
}

/** The NR band lock of `branch` (a decimal list; `"all"`: every NR band ZTE's pages list). */
export function zteNrBandForm(branch: ZteBranch, bands: ReadonlyArray<number> | "all"): { goformId: string; fields: Form } {
  const list = bandsToList(bands === "all" ? ZTE_NR_ALL_BANDS : bands, ",");
  if (branch === 2) return { goformId: "WAN_PERFORM_NR5G_BAND_LOCK_MERGE", fields: [["Z5g_lockband_no_format_mask", list]] };
  if (branch === 3)
    return {
      goformId: "WAN_PERFORM_NR5G_BAND_LOCK",
      fields: [
        ["Z5g_lockband_mask", list],
        ["Z5g_lockband_type", "0"],
      ],
    };
  if (branch === 4) return { goformId: "NR_BAND_LOCK", fields: [["nr_band_lock", list]] };
  return { goformId: "WAN_PERFORM_NR5G_BAND_LOCK", fields: [["nr5g_band_mask", list]] };
}

/** The cell lock of `branch` (a target already checked by `checkCellLock`). */
export function zteCellForm(branch: ZteBranch, target: DriverCellLockTarget): { goformId: string; fields: Form } {
  const { rat, band, arfcn, pci } = target;
  if (branch === 3 || branch === 4) {
    return {
      goformId: "CELL_LOCK",
      fields: [
        ["pci", String(pci)],
        ["earfcn", String(arfcn)],
        ["rat", rat === "LTE" ? "12" : "16"],
      ],
    };
  }
  if (rat === "LTE") {
    return {
      goformId: "LTE_LOCK_CELL_SET",
      fields: [
        ["lte_pci_lock", String(pci)],
        ["lte_earfcn_lock", String(arfcn)],
      ],
    };
  }
  const scs = target.scsKhz;
  if (branch === 2) {
    return {
      goformId: "NR5G_LOCK_CELL_SET",
      fields: [
        ["Z5g_lockcell_pci", String(pci)],
        ["Z5g_lockcell_arfcn", String(arfcn)],
        ["Z5g_lockcell_band", String(band)],
        ["Z5g_lockcell_scs", String(scs)],
      ],
    };
  }
  // The standard goform codes the spacing: 0 for 15 kHz, 1 for 30 kHz (no other is documented)
  if (scs !== 15 && scs !== 30) throw new CpeControlValidationError(`This router locks NR cells with a 15 or 30 kHz subcarrier spacing only (asked: ${String(scs)} kHz)`);
  return { goformId: "NR5G_LOCK_CELL_SET", fields: [["nr5g_cell_lock", `${pci},${arfcn},${band},${scs === 30 ? "1" : "0"}`]] };
}

class ZteGoformSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #version: ZteVersion;
  readonly #hash: "sha256" | "md5";
  readonly #branch: ZteBranch;
  #open = true;

  constructor(http: LanHttp, version: ZteVersion, hash: "sha256" | "md5") {
    this.#http = http;
    this.#version = version;
    this.#hash = hash;
    this.#branch = zteBranch(version);
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    const v = this.#version;
    return { model: labelOf(v.modelName) ?? labelOf(v.hardwareVersion), softwareVersion: labelOf(v.waInnerVersion) ?? labelOf(v.crVersion), hardwareVersion: labelOf(v.hardwareVersion) };
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    return parseZteGoformTelemetry(await getCmd(this.#http, ZTE_TELEMETRY_KEYS));
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    const list = parseZteNeighbours(await getCmd(this.#http, NEIGHBOUR_KEYS));
    if (list === null) throw new SectionUnavailableError("The nearby-cell list", null);
    return list;
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    return parseZteLockState(await getCmd(this.#http, LOCK_KEYS));
  }

  /** One write: a fresh `RD`, then the form with its `AD`; the router must answer `success`. */
  async #post(check: WriteCheck | null, goformId: string, fields: Form): Promise<void> {
    this.#guard();
    const rd = textOf((await getCmd(this.#http, ["RD"], false))["RD"]);
    if (rd === null) throw new CpeAnswerFormatError(`${goformId}: the router handed out no RD`);
    if (check) noteSent(check, FAMILY, goformId);
    const answer = await setCmd(this.#http, [["isTest", "false"], ["goformId", goformId], ...fields, ["AD", zteActionDigest(this.#hash, this.#version, rd)]]);
    const result = textOf(answer["result"]);
    if (result !== "success" && result !== "0") throw new CpeApiError(answerCode(answer["result"]), `${goformId} refused`);
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null || target.nr === "all" ? target.nr : checkLockBands("NR", target.nr, null);
    const lteForm = zteLteBandForm(this.#branch, lte);
    await this.#post(check, lteForm.goformId, lteForm.fields);
    if (nr !== null) {
      const nrForm = zteNrBandForm(this.#branch, nr);
      await this.#post(check, nrForm.goformId, nrForm.fields);
    }
    if (target.networkMode !== null) await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", BEARER[target.networkMode]]]);
    settleBandLock(check, { lte, nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const checked = checkCellLock(target);
    const form = zteCellForm(this.#branch, checked);
    await this.#post(check, form.goformId, form.fields);
    settleCellLock(check, checked, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    if (before.lteBands !== "all") {
      const form = zteLteBandForm(this.#branch, "all");
      await this.#post(check, form.goformId, form.fields);
    }
    if (before.nrBands !== "all") {
      const form = zteNrBandForm(this.#branch, "all");
      await this.#post(check, form.goformId, form.fields);
    }
    const lteLocked = before.lteCell?.locked !== false;
    const nrLocked = before.nrCell?.locked !== false;
    if (this.#branch === 3 || this.#branch === 4) {
      if (lteLocked || nrLocked) await this.#post(check, "UNLOCK_ALL_CELL", []);
    } else {
      if (lteLocked)
        await this.#post(check, "LTE_LOCK_CELL_SET", [
          ["lte_pci_lock", "1"],
          ["lte_earfcn_lock", "1"],
        ]);
      if (nrLocked) await this.#post(check, "NR5G_LOCK_CELL_SET", [["nr5g_cell_lock", "1,1,1,1"]]);
    }
    // The mode goes back to automatic only when it is known to be something else
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", BEARER.auto]]);
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#post(check, "REBOOT_DEVICE", []);
    settleRestart(check);
    // The router goes down now: nothing else is sent in this session (the logout would only time out)
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    try {
      await this.#post(null, "LOGOUT", []);
    } finally {
      this.#open = false;
    }
  }
}

function lockOf(status: Record<string, unknown>): { waitSec: number | null } | null {
  const wait = intOf(status["login_lock_time"]);
  const left = intOf(status["psw_fail_num_str"]);
  if ((wait !== null && wait > 0) || left === 0) return { waitSec: wait !== null && wait > 0 ? wait : null };
  return null;
}

export const zteGoformProtocol: DriverProtocol = {
  family: FAMILY,

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    const status = await getCmd(http, LOCK_STATUS_KEYS);
    return { occupied: false, locked: lockOf(status) };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const versions = await getCmd(http, VERSION_KEYS);
    const version: ZteVersion = {
      modelName: textOf(versions["model_name"]) ?? "",
      hardwareVersion: textOf(versions["hardware_version"]) ?? "",
      waInnerVersion: textOf(versions["wa_inner_version"]) ?? "",
      crVersion: textOf(versions["cr_version"]) ?? "",
    };
    if (version.waInnerVersion === "" && version.hardwareVersion === "") throw new DriverLoginMethodError("not a ZTE goform router: no firmware version");
    const ld = textOf((await getCmd(http, ["LD"], false))["LD"]);
    let configJs: string | null = null;
    if (ld === null) {
      const res = await http.request({ method: "GET", path: "/js/config/config.js", referer: "/" });
      configJs = res.status === 200 ? res.text : null;
    }
    const method = zteLoginMethodOf(ld, configJs);
    if (method === null) throw new DriverLoginMethodError(ld !== null ? "a login nonce FengSui does not know" : "no login nonce and no page configuration");
    const answer = await setCmd(http, [
      ["isTest", "false"],
      ["goformId", "LOGIN"],
      ["password", zteLoginPassword(method, credentials.password)],
    ]);
    const result = textOf(answer["result"]);
    if (result === "0") return new ZteGoformSession(http, version, method.kind === "sha256-ld" ? "sha256" : "md5");
    if (result === "4") throw signedInElsewhere("another administrator is signed in");
    // The router's own count of attempts left and of the lock, read without a password
    const status = await getCmd(http, LOCK_STATUS_KEYS).catch(() => ({}) as Record<string, unknown>);
    const lock = lockOf(status);
    if (result === "2" || lock) throw loginLocked("the router has locked its login", lock?.waitSec ?? null);
    if (result === "1" || result === "3") throw wrongPassword("the router refused the password", intOf(status["psw_fail_num_str"]));
    throw loginUnplaced(`login answered ${answerCode(answer["result"])}`);
  },
};
