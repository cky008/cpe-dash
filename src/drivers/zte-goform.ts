import type { ApnChoice, ApnRestore, DataLimitSetting, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, SimSlotRef, UssdAnswer, UssdRequest } from "../cellular.ts";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../session-errors.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import { type BatteryStatus, type SimCardStatus, type SimState, type TemperatureSensor, countValue, percentValue } from "../router-status.ts";
import { detectSmsTextMode } from "../sms/text-mode.ts";
import type { SmsCounters, SmsWireMessage } from "../sms/types.ts";
import { bandsToHex, bandsToList, checkCellLock, checkLockBands, hexToBands, listToBands } from "./bands.ts";
import {
  FENGSUI_APN_PROFILE,
  ZTE_APN_PROFILE_KEYS,
  ZTE_GOFORM_SLOTS,
  ZTE_MODE_NAMES,
  awaitOperatorStep,
  awaitZteUssd,
  emptyUssd,
  sameDataLimit,
  settleNothingToRead,
  zteApnFields,
  zteApnProfiles,
  zteAuthOf,
  zteLimitSize,
  zteModeOf,
  ztePdpName,
  ztePdpOf,
  zteScanRows,
  zteUssdText,
} from "./cellular.ts";
import { carriersFromRows, neighbourOf, ratOf, ratOfChannel, servingModeOf } from "./cells.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, md5Hex, sha256Hex, signedInElsewhere, wrongPassword } from "./login.ts";
import { awaitConnection, noteSent, settleBandLock, settleCellLock, settleDataSwitch, settleRestart, settleSetting, settleUnlock } from "./readback.ts";
import { ZTE_SMS_CMD_DELETE, ZTE_SMS_CMD_SEND, awaitZteCommand, parseZteSmsRows, settleSmsListing, storedIndices, ucs2Hex, zteIdList, zteSmsCounters, zteSmsTime } from "./sms.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import { type LanHttp, parseJsonText } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCarrier,
  DriverCell,
  DriverCellular,
  DriverCellularState,
  DriverCellLockTarget,
  DriverDataLink,
  DriverHost,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
  DriverWait,
} from "./types.ts";
import {
  arfcnOf,
  bandOf,
  counterOf,
  ecioOf,
  fieldOf,
  firstOf,
  iccidOf,
  identityOf,
  imeiOf,
  imsiOf,
  intOf,
  ipv4Of,
  ipv6Of,
  isPlainObject,
  labelOf,
  mhzOf,
  msisdnOf,
  nonNegativeOf,
  pciOf,
  plmnOf,
  rowsOf,
  rscpOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
  txPowerOf,
} from "./values.ts";

/**
 * ZTE routers with the goform web interface (MC801A, MC888, MC889, MC7010, MU5001, F50, MF28x…):
 * `GET /goform/goform_get_cmd_process?cmd=a,b&multi_data=1` reads named values, `POST
 * /goform/goform_set_cmd_process` writes, and every write but the login carries `AD`, a digest of the
 * firmware version and a fresh `RD` nonce. The login method is settled before the password goes out:
 * a 64-digit `LD` nonce means the double SHA-256; no nonce means the single SHA-256 the page's
 * `config.js` announces, or Base64; anything else sends nothing. PCIs and cell identities come as
 * hexadecimal. Firmware generations differ in how they write band and cell locks (`zteBranch`).
 *
 * The ZXIC firmware many rebadged 4G routers and MiFis run (ZTE's own and other makers' under their
 * names) spells the same interface `GET /reqproc/proc_get` and `POST /reqproc/proc_post`: the same
 * `cmd` keys and `goformId` actions, a login of its own (the user name and the SHA-256 of a nonce and
 * the password, each as Base64) and a `CSRFToken` from `cmd=get_token` on every write where the
 * goform pages carry `AD`. The driver speaks whichever of the two the router answers.
 *
 * SMS is the store the router's own page shows (device memory): `cmd=sms_data_total` lists it, bodies
 * as UTF-16 hexadecimal; `cmd=sms_capacity_info` counts it; `SEND_SMS` sends and `DELETE_SMS` deletes,
 * each settling through `cmd=sms_cmd_status_info`; `SET_MSG_READ` marks read.
 */

const FAMILY = "zte-goform" as const;
/** Where a firmware answers reads and writes: the goform pages, or the `reqproc` handlers. */
export interface ZteEndpoints {
  variant: "goform" | "reqproc";
  get: string;
  set: string;
}

const GOFORM: ZteEndpoints = { variant: "goform", get: "/goform/goform_get_cmd_process", set: "/goform/goform_set_cmd_process" };
const REQPROC: ZteEndpoints = { variant: "reqproc", get: "/reqproc/proc_get", set: "/reqproc/proc_post" };
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

/**
 * The generation goes by the hardware version and the model name alone. One protocol note also
 * sends a `cr_version` containing `V1.0.0` or `HW1.0` to branch 4, but version strings of the
 * standard generation carry the same marks, so that rule would move an MC801A off the forms it takes.
 */
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

async function getCmd(http: LanHttp, keys: ReadonlyArray<string>, multi = true, at: ZteEndpoints = GOFORM): Promise<Record<string, unknown>> {
  const query: Array<[string, string]> = [
    ["isTest", "false"],
    ["cmd", keys.join(",")],
  ];
  if (multi) query.push(["multi_data", "1"]);
  query.push(["_", String(Date.now())]);
  const answer = await http.getJson(at.get, { query, referer: REFERER, headers: XHR });
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError("GET goform_get_cmd_process: not an object");
  return answer;
}

async function setCmd(http: LanHttp, fields: ReadonlyArray<readonly [string, string]>, at: ZteEndpoints = GOFORM): Promise<Record<string, unknown>> {
  const answer = await http.postForm(at.set, fields, { referer: REFERER, headers: XHR });
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError("POST goform_set_cmd_process: not an object");
  return answer;
}

/** One listing page: the router's page asks for 500 at once; a firmware may hand back fewer. */
const SMS_PAGE_SIZE = 500;
const SMS_MAX_PAGES = 8;
/** Ids per write, as the page batches a large selection (a long form resets some firmware's connection). */
const SMS_ID_BATCH = 20;
/** How long a delete may take to settle before its read-back is taken anyway, and how often its slot is asked. */
const SMS_DELETE_SETTLE_MS = 10_000;
const SMS_DELETE_POLL_MS = 300;

/**
 * A read that takes parameters of its own beside `cmd` (the SMS listing, a status slot). Some
 * firmware writes raw control characters into a message body's JSON: they are dropped before parsing,
 * as the router's own page cannot read such an answer either.
 */
async function getCmdWith(http: LanHttp, cmd: string, params: ReadonlyArray<readonly [string, string]>, at: ZteEndpoints = GOFORM): Promise<Record<string, unknown>> {
  const query: Array<readonly [string, string]> = [["isTest", "false"], ["cmd", cmd], ...params, ["_", String(Date.now())]];
  const res = await http.request({ method: "GET", path: at.get, query, referer: REFERER, headers: XHR });
  if (res.status < 200 || res.status >= 300) throw new CpeAnswerFormatError(`GET goform_get_cmd_process: HTTP ${res.status}`);
  const answer = parseJsonText(res.text.replace(/[\u0000-\u001f]/g, " "), "GET goform_get_cmd_process");
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError("GET goform_get_cmd_process: not an object");
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
  "total_rx_bytes",
  "total_tx_bytes",
  "network_information",
];

/**
 * The router's own status, read in the poll's session with a second request so the telemetry read
 * above stays as it was: battery, SIM card, roaming, data plan, firmware update, Wi-Fi, the device's
 * and the card's identifiers, more temperature sensors, 3G and the second codeword's readings.
 * Docs/dev/sources.md §18.5 names the source of each key.
 */
export const ZTE_STATUS_KEYS: ReadonlyArray<string> = [
  "battery_vol_percent",
  "battery_value",
  "battery_pers",
  "battery_charging",
  "battery_temp",
  "modem_main_state",
  "pin_status",
  "pinnumber",
  "puknumber",
  "sim_slot",
  "simcard_roam",
  "roam_setting_option",
  "data_volume_limit_switch",
  "data_volume_limit_unit",
  "data_volume_limit_size",
  "data_volume_alert_percent",
  "fota_new_version_state",
  "wifi_cur_state",
  "m_ssid_enable",
  "imei",
  "imsi",
  "sim_imsi",
  "msisdn",
  "sim_msisdn",
  "sim_iccid",
  "iccid",
  "rscp",
  "ecio",
  "sc",
  "lte_cqi1",
  "nr_cqi1",
  "nr5g_ul_bandwidth",
  "lte_tx_power",
  "tx_power",
  "nr_tx_power",
  "pm_sensor_pa2",
  "wifi_chip_temp",
  "pm_sensor_wifi24g",
  "pm_sensor_wifi5g",
  "cpu_usage",
  "mem_usage",
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
/**
 * 4G firmware names its automatic mode `NETWORK_auto` and has no 5G mode: the `reqproc` spelling, and a
 * goform router whose mode reads back by that name (both names are on record: notes library A and
 * ZTE's community script have `WL_AND_5G` on the 5G routers, library B and the 4G firmware `NETWORK_auto`).
 */
const BEARER_REQPROC: Readonly<Partial<Record<DriverNetworkMode, string>>> = { auto: "NETWORK_auto", lte: "Only_LTE" };

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
  const named = sensors([
    ["modem_4g", v("pm_sensor_mdm")],
    ["modem_5g", v("pm_modem_5g") ?? v("pm_sensor_5g")],
    ["pa", v("pm_sensor_pa1")],
  ]);
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
      totalDownloadBytes: counterOf(v("total_rx_bytes")),
      totalUploadBytes: counterOf(v("total_tx_bytes")),
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
    temperatures: named,
  };
}

/** `modem_main_state` as ZTE's own page reads it (its SIM page and status bar). */
function simStateOf(value: unknown): SimState | null {
  switch (textOf(value)?.toLowerCase()) {
    case "modem_init_complete":
      return "ready";
    case "modem_waitpin":
      return "pin_required";
    case "modem_waitpuk":
      return "puk_required";
    case "modem_sim_undetected":
    case "modem_undetected":
      return "absent";
    case "modem_sim_destroy":
    case "modem_imsi_waitnck":
      return "error";
    default:
      return null;
  }
}

function switchOf(value: unknown): boolean | null {
  const text = textOf(value);
  return text === "1" ? true : text === "0" ? false : null;
}

/** ZTE's `on` / `off` switches (`roam_setting_option`, `autoConnectWhenRoaming`). */
function onOffOf(value: unknown): boolean | null {
  const text = textOf(value)?.toLowerCase();
  return text === "on" ? true : text === "off" ? false : null;
}

/**
 * What the cellular settings read asks for besides the connection mode: the network mode, the SIM
 * slot and the card's PIN attempts, and the data limit (`docs/dev/sources.md` §18.6).
 */
const CELLULAR_KEYS: ReadonlyArray<string> = [
  "net_select",
  "sim_slot",
  "pinnumber",
  "pin_status",
  "modem_main_state",
  "data_volume_limit_switch",
  "data_volume_limit_unit",
  "data_volume_limit_size",
  "data_volume_alert_percent",
  "net_select_mode",
  "m_netselect_save",
  "apn_mode",
  "wan_apn",
  "ipv6_wan_apn",
  "pdp_type",
  "ipv6_pdp_type",
  "ppp_auth_mode",
  "ppp_username",
  "Current_index",
  "m_profile_name",
  "profile_name",
];

/** The slot number `SET_SIM_SLOT` takes (`null`: a slot ZTE's interface does not have). */
function zteSlotNumber(slot: SimSlotRef): string | null {
  const index = ZTE_GOFORM_SLOTS.findIndex((known) => known.kind === slot.kind && known.index === slot.index);
  return index < 0 ? null : String(index);
}

/**
 * The data plan as ZTE's page reads it: `data_volume_limit_switch` `1` on; `data_volume_limit_unit`
 * `data` makes `data_volume_limit_size` `<amount>_<MB per unit>` (`20_1024` is 20 GB), any other unit
 * counts hours, which FengSui does not show as a plan.
 */
function zteDataPlan(v: (key: string) => unknown): { limitBytes: bigint; alertPercent: number | null } | null {
  if (textOf(v("data_volume_limit_switch")) !== "1" || textOf(v("data_volume_limit_unit")) !== "data") return null;
  const [amount, unit] = (textOf(v("data_volume_limit_size")) ?? "").split("_");
  if (!amount || !unit || !/^\d{1,6}$/.test(amount) || !/^\d{1,7}$/.test(unit)) return null;
  const bytes = BigInt(amount) * BigInt(unit) * 1024n * 1024n;
  return bytes > 0n ? { limitBytes: bytes, alertPercent: percentValue(v("data_volume_alert_percent")) } : null;
}

/**
 * The status read (`ZTE_STATUS_KEYS`) on top of a telemetry read: what the router reports of it, the
 * rest left as the telemetry read had it. A router without a battery leaves the battery keys empty, so
 * no battery is made up; `battery_pers` counts only when the router names no other charge.
 */
export function withZteGoformStatus(t: DriverTelemetry, raw: Record<string, unknown>): DriverTelemetry {
  const v = (key: string): unknown => raw[key];
  // `battery_pers`: library A has it as a percentage, ZTE's page as its 0–4 battery icon; a value up to 4 is read as the icon
  const pers = percentValue(v("battery_pers"));
  const percent = percentValue(v("battery_vol_percent")) ?? percentValue(v("battery_value")) ?? (pers === null || pers === 0 ? null : pers <= 4 ? pers * 25 : pers);
  const battery: BatteryStatus | null =
    percent === null ? null : { percent, charging: switchOf(v("battery_charging")), temperatureC: temperatureOf(v("battery_temp")), minutesToFull: null, minutesToEmpty: null };
  const slot = smallIntOf(v("sim_slot"), 2);
  const sim: SimCardStatus = {
    state: simStateOf(v("modem_main_state")),
    pinLockEnabled: switchOf(v("pin_status")),
    pinAttemptsLeft: countValue(v("pinnumber"), 10),
    pukAttemptsLeft: countValue(v("puknumber"), 10),
    // `0` the card slot, `1` / `2` the built-in cards (notes library A)
    slot: slot === null ? null : slot === 0 ? { kind: "physical", index: 1 } : { kind: "embedded", index: slot },
  };
  const roam = textOf(v("simcard_roam"));
  const fota = textOf(v("fota_new_version_state"))?.toLowerCase();
  const plan = zteDataPlan(v);
  const lteTx = txPowerOf(v("lte_tx_power")) ?? txPowerOf(v("tx_power"));
  const nrTx = txPowerOf(v("nr_tx_power"));
  const extraTemps: TemperatureSensor[] = [
    ...(t.temperatures ?? []),
    ...sensors([
      ["pa", v("pm_sensor_pa2")],
      ["wifi", v("wifi_chip_temp")],
      ["wifi", v("pm_sensor_wifi24g")],
      ["wifi", v("pm_sensor_wifi5g")],
      ["battery", v("battery_temp")],
    ]),
  ];
  const rscp = rscpOf(v("rscp"));
  const ecio = ecioOf(v("ecio"));
  return {
    ...t,
    lte: t.lte ? { ...t.lte, cqi1: smallIntOf(v("lte_cqi1"), 15), puschTxDbm: lteTx } : null,
    nr: t.nr ? { ...t.nr, cqi1: smallIntOf(v("nr_cqi1"), 15), ulBandwidthMhz: mhzOf(v("nr5g_ul_bandwidth")), puschTxDbm: nrTx } : null,
    wcdma: rscp !== null || ecio !== null ? { rscpDbm: rscp, ecioDb: ecio, psc: smallIntOf(v("sc"), 511) } : null,
    temperatures: extraTemps,
    temperatureC: extraTemps.length > 0 ? Math.max(t.temperatureC ?? -Infinity, ...extraTemps.filter((s) => s.kind !== "battery").map((s) => s.celsius)) : t.temperatureC,
    ids: {
      imei: imeiOf(v("imei")),
      imsi: imsiOf(v("imsi")) ?? imsiOf(v("sim_imsi")),
      msisdn: msisdnOf(v("msisdn")) ?? msisdnOf(v("sim_msisdn")),
      iccid: iccidOf(v("sim_iccid")) ?? iccidOf(v("iccid")),
    },
    ...(plan && t.traffic ? { traffic: { ...t.traffic, dataLimitBytes: plan.limitBytes, dataAlertPercent: plan.alertPercent } } : {}),
    status: {
      battery,
      sim,
      // ZTE's page counts both of these as roaming (`Home` otherwise)
      roaming: { active: roam === null ? null : roam === "Internal" || roam === "International", dataAllowed: onOffOf(v("roam_setting_option")) },
      firmwareUpdate: fota === undefined ? null : fota === "has_critical" || fota === "has_optional" || fota === "already_has_pkg" ? "available" : "none",
      wifi: { enabled: switchOf(v("wifi_cur_state")), guestEnabled: switchOf(v("m_ssid_enable")) },
      system: { uptimeSec: null, cpuPercent: percentValue(v("cpu_usage")), memoryPercent: percentValue(v("mem_usage")) },
    },
  };
}

/** Named sensors that report a temperature (absent ones and the sentinels left out). */
function sensors(list: ReadonlyArray<readonly [TemperatureSensor["kind"], unknown]>): TemperatureSensor[] {
  const out: TemperatureSensor[] = [];
  for (const [kind, value] of list) {
    const celsius = temperatureOf(value);
    if (celsius !== null) out.push({ kind, name: null, celsius });
  }
  return out;
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
  // The spacing in kHz, as the community's ZTE script writes it and notes library B records (library A
  // coded it 0 / 1, which no other source shows); docs/dev/sources.md §18.4
  if (scs === null) throw new CpeControlValidationError("This router locks an NR cell with its subcarrier spacing, and none was given");
  return { goformId: "NR5G_LOCK_CELL_SET", fields: [["nr5g_cell_lock", `${pci},${arfcn},${band},${scs}`]] };
}

class ZteGoformSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #version: ZteVersion;
  /** How a write is signed: `AD` in the goform pages' hash, or the `reqproc` firmware's `CSRFToken`. */
  readonly #hash: "sha256" | "md5" | "csrf";
  readonly #at: ZteEndpoints;
  readonly #branch: ZteBranch;
  readonly #password: string;
  readonly #configJs: string | null;
  #developerUnlocked = false;
  /** The router's mode read back as `NETWORK_auto`: it writes the 4G firmware's names. */
  #fourGModes = false;
  #open = true;

  constructor(http: LanHttp, version: ZteVersion, hash: "sha256" | "md5" | "csrf", password = "", configJs: string | null = null, at: ZteEndpoints = GOFORM) {
    this.#http = http;
    this.#version = version;
    this.#hash = hash;
    this.#at = at;
    this.#branch = zteBranch(version);
    this.#password = password;
    this.#configJs = configJs;
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  /**
   * On the MC8020 (branch 3) and the MC888 (branch 2) the login alone may not lock bands or cells:
   * the router wants its developer options opened first, with the same password over a fresh nonce
   * (`DEVELOPER_OPTION_LOGIN`, the one write besides the login that carries no `AD`). Sent once per
   * session, before its first lock write, and named in that write's record. When it fails the lock
   * write still goes out: the router's own answer to it is what the write reports.
   */
  async #ensureDeveloperMode(check: WriteCheck): Promise<void> {
    if (this.#developerUnlocked || (this.#branch !== 2 && this.#branch !== 3) || !this.#password) return;
    this.#developerUnlocked = true;
    try {
      const devLd = textOf((await getCmd(this.#http, ["LD"], false, this.#at))["LD"]);
      const devMethod = zteLoginMethodOf(devLd, this.#configJs);
      if (devMethod !== null) {
        noteSent(check, FAMILY, "DEVELOPER_OPTION_LOGIN");
        await setCmd(
          this.#http,
          [
            ["isTest", "false"],
            ["goformId", "DEVELOPER_OPTION_LOGIN"],
            ["password", zteLoginPassword(devMethod, this.#password)],
          ],
          this.#at
        );
      }
    } catch {
      // The lock write that follows reports what the router makes of it
    }
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    const v = this.#version;
    // A firmware that names neither a model nor a hardware version: the platform its version string starts with
    const platform = /^[A-Za-z0-9]+_[A-Za-z0-9]+/.exec(v.crVersion)?.[0] ?? null;
    // The reqproc spelling is said in the device report (no other facts are recorded for it, so the gate goes by ZTE's own)
    const variant = this.#at.variant === "reqproc" ? { variant: "reqproc" } : {};
    return { model: labelOf(v.modelName) ?? labelOf(v.hardwareVersion) ?? labelOf(platform), softwareVersion: labelOf(v.waInnerVersion) ?? labelOf(v.crVersion), hardwareVersion: labelOf(v.hardwareVersion), ...variant };
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    const t = parseZteGoformTelemetry(await getCmd(this.#http, ZTE_TELEMETRY_KEYS, true, this.#at));
    // The status rides on the same session; a firmware that refuses the request keeps its readings
    const status = await getCmd(this.#http, ZTE_STATUS_KEYS, true, this.#at).catch(() => null);
    return status ? withZteGoformStatus(t, status) : t;
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    const list = parseZteNeighbours(await getCmd(this.#http, NEIGHBOUR_KEYS, true, this.#at));
    if (list === null) throw new SectionUnavailableError("The nearby-cell list", null);
    return list;
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    const raw = await getCmd(this.#http, LOCK_KEYS, true, this.#at);
    // The name the mode reads back by tells which names this firmware writes (a band lock and an unlock read it first)
    const current = (textOf(raw["net_select"]) ?? textOf(raw["BearerPreference"]))?.toUpperCase();
    if (current !== undefined) this.#fourGModes = current === "NETWORK_AUTO";
    return parseZteLockState(raw);
  }

  /**
   * One write: a fresh `RD`, then the form with its `AD` (on the `reqproc` firmware a fresh token,
   * then the form with it as `CSRFToken`); the router must answer `success`.
   */
  async #post(check: WriteCheck | null, goformId: string, fields: Form): Promise<void> {
    const answer = await this.#send(check, goformId, fields);
    if (!accepted(answer)) throw new CpeApiError(answerCode(answer), `${goformId} refused`);
  }

  /** The same write, handing back what the router answered (a PIN the card refuses is an answer, not an error). */
  async #send(check: WriteCheck | null, goformId: string, fields: Form): Promise<unknown> {
    this.#guard();
    let signature: [string, string];
    if (this.#hash === "csrf") {
      signature = ["CSRFToken", await zteCsrfToken(this.#http)];
    } else {
      const rd = textOf((await getCmd(this.#http, ["RD"], false, this.#at))["RD"]);
      if (rd === null) throw new CpeAnswerFormatError(`${goformId}: the router handed out no RD`);
      signature = ["AD", zteActionDigest(this.#hash, this.#version, rd)];
    }
    if (check) noteSent(check, FAMILY, goformId);
    return (await setCmd(this.#http, [["isTest", "false"], ["goformId", goformId], ...fields, signature], this.#at))["result"];
  }

  /** `BearerPreference` for a network mode, as this firmware names it (checked before a lock writes anything). */
  #bearer(mode: DriverNetworkMode): string {
    if (this.#at.variant !== "reqproc" && !this.#fourGModes) return BEARER[mode];
    const name = BEARER_REQPROC[mode];
    if (name === undefined) throw new CpeControlValidationError("This router runs a 4G firmware: its network mode can be automatic or 4G only");
    return name;
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    const bearer = target.networkMode === null ? null : this.#bearer(target.networkMode);
    await this.#ensureDeveloperMode(check);
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null || target.nr === "all" ? target.nr : checkLockBands("NR", target.nr, null);
    const lteForm = zteLteBandForm(this.#branch, lte);
    await this.#post(check, lteForm.goformId, lteForm.fields);
    if (nr !== null) {
      const nrForm = zteNrBandForm(this.#branch, nr);
      await this.#post(check, nrForm.goformId, nrForm.fields);
    }
    if (bearer !== null) await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", bearer]]);
    settleBandLock(check, { lte, nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    await this.#ensureDeveloperMode(check);
    const checked = checkCellLock(target);
    const form = zteCellForm(this.#branch, checked);
    await this.#post(check, form.goformId, form.fields);
    settleCellLock(check, checked, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    await this.#ensureDeveloperMode(check);
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
      // Zeros clear a cell lock, as the community's ZTE script and notes library B write it (library A
      // wrote ones; the read-back takes either as no lock)
      if (lteLocked)
        await this.#post(check, "LTE_LOCK_CELL_SET", [
          ["lte_pci_lock", "0"],
          ["lte_earfcn_lock", "0"],
        ]);
      if (nrLocked) await this.#post(check, "NR5G_LOCK_CELL_SET", [["nr5g_cell_lock", "0,0,0,0"]]);
    }
    // The mode goes back to automatic only when it is known to be something else
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", this.#bearer("auto")]]);
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  /** SMS in the router's own store, as its page reads and writes it. */
  /**
   * The data connection: `DISCONNECT_NETWORK` / `CONNECT_NETWORK` (both notes libraries; the page
   * sends `notCallback`), signed like every other write. The router has no switch state to read, so
   * the read-back is its connection (`ppp_status`) following within a few seconds.
   */
  readonly data: DriverDataLink = {
    enabled: () => Promise.resolve(null),
    set: async (enabled, check, wait) => {
      await this.#post(check, enabled ? "CONNECT_NETWORK" : "DISCONNECT_NETWORK", [["notCallback", "true"]]);
      const after = await awaitConnection(async () => connectedOf((await getCmd(this.#http, ["ppp_status"], true, this.#at))["ppp_status"]), enabled, wait);
      settleDataSwitch(check, true, after);
    },
  };

  /**
   * Connected devices: `station_list` (Wi-Fi) and `lan_station_list` (wired), each asked on its own the
   * way the router's page asks; an entry names `mac_addr`, `hostname` and `ip_addr`, a wired one also
   * `connect_time` in seconds. A firmware without either list answers it empty.
   */
  async hosts(): Promise<DriverHost[]> {
    this.#guard();
    const rows = (value: unknown, link: DriverHost["link"]): DriverHost[] | null =>
      Array.isArray(value)
        ? value.filter(isPlainObject).map((row) => ({ mac: textOf(row["mac_addr"]) ?? "", name: labelOf(row["hostname"]), ipv4: textOf(row["ip_addr"]), ipv6: [], link, connectedSec: nonNegativeOf(row["connect_time"]), leaseSec: null, rssiDbm: null }))
        : null;
    const lan = rows((await getCmd(this.#http, ["lan_station_list"], false, this.#at))["lan_station_list"], "lan");
    const wifi = rows((await getCmd(this.#http, ["station_list"], false, this.#at))["station_list"], "wifi");
    if (lan === null && wifi === null) throw new SectionUnavailableError("The device list", null);
    return [...(lan ?? []), ...(wifi ?? [])];
  }

  /**
   * The cellular settings as ZTE's own pages read and write them: `SET_BEARER_PREFERENCE` (network
   * mode), `SET_SIM_SLOT`, `SET_CONNECTION_MODE` (data roaming, sent with the dial mode the router
   * has), `ENTER_PIN` and `ENABLE_PIN` / `DISABLE_PIN`, `DATA_LIMIT_SETTING`, `USSD_PROCESS`,
   * `SCAN_NETWORK` / `SET_NETWORK` (the operator) and `APN_PROC_EX` (the access point).
   */
  readonly cellular: DriverCellular = {
    read: () => this.#cellularRead(),
    setNetworkMode: (mode, check) => this.#setNetworkMode(mode, check),
    setSimSlot: (slot, check) => this.#setSimSlot(slot, check),
    setRoaming: (enabled, check) => this.#setRoaming(enabled, check),
    setApn: (choice, check, wait) => this.#setApn(choice, check, wait),
    restoreApn: (restore, check, wait) => this.#restoreApn(restore, check, wait),
    scanOperators: (check, wait) => this.#scanOperators(check, wait),
    selectOperator: (selection, check, wait) => this.#selectOperator(selection, check, wait),
    enterPin: (pin, check) => this.#pinWrite(check, "ENTER_PIN", [["PinNumber", pin]], (after) => (after === "pin_required" ? false : after === null ? null : true)),
    setPinLock: (enabled, pin, check) => this.#setPinLock(enabled, pin, check),
    setDataLimit: (limit, check) => this.#setDataLimit(limit, check),
    ussd: (request, check, wait) => this.#ussd(request, check, wait),
  };

  async #cellularRead(): Promise<DriverCellularState> {
    this.#guard();
    const raw = await getCmd(this.#http, CELLULAR_KEYS, true, this.#at);
    const current = textOf(raw["net_select"])?.toUpperCase();
    if (current !== undefined) this.#fourGModes = current === "NETWORK_AUTO";
    const fourG = this.#at.variant === "reqproc" || this.#fourGModes;
    const slot = smallIntOf(raw["sim_slot"], 2);
    const limitOn = textOf(raw["data_volume_limit_switch"]);
    const plan = zteDataPlan((key) => raw[key]);
    const selection = textOf(raw["net_select_mode"]) ?? textOf(raw["m_netselect_save"]);
    const apnMode = textOf(raw["apn_mode"])?.toLowerCase() ?? null;
    const manualApn = apnMode === "manual";
    const v6 = ztePdpOf(raw["pdp_type"]) !== "ipv4" && ztePdpOf(raw["ipv6_pdp_type"]) === "ipv6";
    const profile = textOf(raw["m_profile_name"]) ?? textOf(raw["profile_name"]);
    const index = textOf(raw["Current_index"]);
    return {
      networkMode: zteModeOf(raw["net_select"]),
      // The router says how it chooses, not which operator it was told to stay on
      ...(selection === null ? {} : { operator: { selection: textOf(raw["net_select_mode"]) === "manual_select" || textOf(raw["m_netselect_save"]) === "manual_select" ? ("manual" as const) : ("auto" as const), plmn: null } }),
      ...(apnMode === "auto" || manualApn
        ? {
            apn: {
              mode: manualApn ? ("manual" as const) : ("auto" as const),
              apn: textOf(raw[v6 ? "ipv6_wan_apn" : "wan_apn"]),
              ipType: ztePdpOf(raw["pdp_type"]) === "ipv4" ? ("ipv4" as const) : ztePdpOf(raw["ipv6_pdp_type"]),
              auth: zteAuthOf(raw["ppp_auth_mode"]),
              hasUsername: textOf(raw["ppp_username"]) !== null,
            },
            // FengSui's own profile is overwritten by the next change, so it is nothing to go back to
            apnRestore: !manualApn ? { mode: "auto" as const } : index !== null && /^\d{1,2}$/.test(index) && profile !== null && profile !== FENGSUI_APN_PROFILE ? { mode: "profile" as const, id: index } : null,
          }
        : {}),
      // The 4G firmware has two modes on record; the 5G one the family's list
      ...(fourG ? { networkModes: ["auto", "lte"] as NetworkMode[] } : {}),
      // A router that names no slot has none to switch
      simSlots: slot === null ? [] : [...ZTE_GOFORM_SLOTS],
      simSlot: slot === null ? null : (ZTE_GOFORM_SLOTS[slot] ?? null),
      dataLimit: limitOn === null ? null : { enabled: limitOn === "1", bytes: plan ? Number(plan.limitBytes) : null, alertPercent: plan?.alertPercent ?? percentValue(raw["data_volume_alert_percent"]) },
      pinAttemptsLeft: countValue(raw["pinnumber"], 10),
    };
  }

  async #setNetworkMode(mode: NetworkMode, check: WriteCheck): Promise<void> {
    const fourG = this.#at.variant === "reqproc" || this.#fourGModes;
    const name = fourG ? BEARER_REQPROC[mode as DriverNetworkMode] : ZTE_MODE_NAMES[mode];
    if (name === undefined) throw new CpeControlValidationError(`This router has no "${mode}" network mode`);
    await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", name]]);
    const after = await getCmd(this.#http, ["net_select"], true, this.#at).catch(() => null);
    const read = after === null || textOf(after["net_select"]) === null ? null : zteModeOf(after["net_select"]);
    settleSetting(check, after === null || textOf(after["net_select"]) === null ? null : read === mode);
  }

  async #setSimSlot(slot: SimSlotRef, check: WriteCheck): Promise<void> {
    const number = zteSlotNumber(slot);
    if (number === null) throw new CpeControlValidationError("This router has a card slot and two built-in cards: no such SIM slot");
    await this.#post(check, "SET_SIM_SLOT", [
      ["sim_slot", number],
      ["notCallback", "true"],
    ]);
    const after = await getCmd(this.#http, ["sim_slot"], true, this.#at).catch(() => null);
    const read = after === null ? null : textOf(after["sim_slot"]);
    settleSetting(check, read === null ? null : read === number);
  }

  /** The dial mode travels with the roaming switch in one form, so it is read first and sent back as it is. */
  async #setRoaming(enabled: boolean, check: WriteCheck): Promise<void> {
    this.#guard();
    const dial = textOf((await getCmd(this.#http, ["ConnectionMode"], false, this.#at))["connectionMode"]);
    if (dial === null || !/^[a-z_]{1,24}$/.test(dial)) throw new CpeControlValidationError("The router's dial mode could not be read, and the roaming switch is written together with it: nothing was sent");
    await this.#post(check, "SET_CONNECTION_MODE", [
      ["ConnectionMode", dial],
      ["roam_setting_option", enabled ? "on" : "off"],
    ]);
    const after = await getCmd(this.#http, ["ConnectionMode"], false, this.#at).catch(() => null);
    const read = after === null ? null : onOffOf(after["autoConnectWhenRoaming"]);
    settleSetting(check, read === null ? null : read === enabled);
  }

  /**
   * ZTE's page changes the operator and the access point only with the data connection down: it
   * disconnects first and connects again afterwards. The same here: a connection that is up is taken
   * down with `DISCONNECT_NETWORK`, and `CONNECT_NETWORK` is sent once at the end whatever happened in
   * between. A connection that was down stays down.
   */
  async #whileDisconnected<T>(check: WriteCheck, wait: DriverWait, run: () => Promise<T>): Promise<T> {
    this.#guard();
    const status = textOf((await getCmd(this.#http, ["ppp_status"], true, this.#at))["ppp_status"])?.toLowerCase() ?? "";
    if (status !== "ppp_connected" && status !== "ppp_connecting") return await run();
    const pppStatus = async (): Promise<boolean | null> => connectedOf((await getCmd(this.#http, ["ppp_status"], true, this.#at))["ppp_status"]);
    const connect = async (): Promise<void> => {
      await this.#post(check, "CONNECT_NETWORK", [["notCallback", "true"]]);
    };
    await this.#post(check, "DISCONNECT_NETWORK", [["notCallback", "true"]]);
    let result: T;
    try {
      await awaitConnection(pppStatus, false, wait);
      result = await run();
    } catch (err: unknown) {
      await connect().catch(() => undefined);
      throw err;
    }
    await connect();
    return result;
  }

  /** `SCAN_NETWORK`, then `m_netselect_status` until it is no longer `manual_selecting`, then the list (`m_netselect_contents`). */
  async #scanOperators(check: WriteCheck, wait: DriverWait): Promise<OperatorChoice[]> {
    settleNothingToRead(check);
    return await this.#whileDisconnected(check, wait, async () => {
      await this.#post(check, "SCAN_NETWORK", []);
      const done = await awaitOperatorStep(
        async () => (await getCmd(this.#http, ["m_netselect_status"], false, this.#at))["m_netselect_status"],
        (status) => (status === "manual_selecting" ? null : true),
        wait
      );
      if (done === null) throw new CpeApiError("timeout", "The router was still searching for networks after two minutes");
      return zteScanRows((await getCmd(this.#http, ["m_netselect_contents"], false, this.#at))["m_netselect_contents"]).map((row) => row.choice);
    });
  }

  /**
   * Back to automatic is the page's own way: `SET_BEARER_PREFERENCE` with the mode the router has. One
   * operator is `SET_NETWORK` with the row of the router's last search (the form sends that row's two
   * technology numbers back), then `m_netselect_result` until the router says how it went.
   */
  async #selectOperator(selection: OperatorSelection, check: WriteCheck, wait: DriverWait): Promise<void> {
    this.#guard();
    const state = await getCmd(this.#http, ["net_select", "m_netselect_contents"], true, this.#at);
    if (selection.mode === "auto") {
      const mode = textOf(state["net_select"]);
      if (mode === null || !/^[A-Za-z0-9_]{1,32}$/.test(mode)) throw new CpeControlValidationError("The router's network mode could not be read, and automatic selection is written together with it: nothing was sent");
      await this.#whileDisconnected(check, wait, async () => {
        await this.#post(check, "SET_BEARER_PREFERENCE", [["BearerPreference", mode]]);
      });
      const after = await getCmd(this.#http, ["net_select_mode", "m_netselect_save"], true, this.#at).catch(() => null);
      const kept = after === null ? null : (textOf(after["net_select_mode"]) ?? textOf(after["m_netselect_save"]));
      settleSetting(check, after === null || kept === null ? null : textOf(after["net_select_mode"]) !== "manual_select" && textOf(after["m_netselect_save"]) !== "manual_select");
      return;
    }
    const rows = zteScanRows(state["m_netselect_contents"]).filter((row) => row.choice.plmn === selection.plmn);
    const row = rows.find((found) => selection.rat === null || found.choice.rat === selection.rat);
    if (!row) throw new CpeControlValidationError("This router registers on an operator from its last search, and that search does not list this one: search for networks first");
    // The page's form takes these three technologies and no other
    if (row.act !== "0" && row.act !== "2" && row.act !== "7") throw new CpeControlValidationError("This router's page registers by hand on 2G, 3G and 4G networks only");
    const took = await this.#whileDisconnected(check, wait, async () => {
      await this.#post(check, "SET_NETWORK", [
        ["NetworkNumber", row.choice.plmn],
        ["Rat", row.act],
        ["nSubrat", row.subrat],
      ]);
      return await awaitOperatorStep(
        async () => (await getCmd(this.#http, ["m_netselect_result"], false, this.#at))["m_netselect_result"],
        (result) => (result === "manual_success" ? true : result === "manual_fail" ? false : null),
        wait
      );
    });
    // A registration the router gave up on is a write that did not take: recorded as such, and watched like one
    settleSetting(check, took);
  }

  /**
   * `APN_PROC_EX`. Automatic is one form. An access point set by hand is the page's two: `save` (into
   * FengSui's own profile, added after the router's profiles the first time and overwritten from then
   * on), then `set_default`. No other profile is changed.
   */
  async #setApn(choice: ApnChoice, check: WriteCheck, wait: DriverWait): Promise<void> {
    this.#guard();
    if (choice.mode === "auto") {
      await this.#whileDisconnected(check, wait, async () => {
        await this.#post(check, "APN_PROC_EX", [["apn_mode", "auto"]]);
      });
      const after = await getCmd(this.#http, ["apn_mode"], true, this.#at).catch(() => null);
      const mode = after === null ? null : textOf(after["apn_mode"]);
      settleSetting(check, mode === null ? null : mode.toLowerCase() === "auto");
      return;
    }
    const listed = await getCmd(this.#http, [...ZTE_APN_PROFILE_KEYS, "apn_num_preset"], true, this.#at);
    const profiles = zteApnProfiles(listed);
    // A list that reads empty is not known to be empty: its first place is the profile the router came with
    if (profiles.length === 0) throw new CpeControlValidationError("The router's list of access points could not be read: nothing was sent");
    const own = profiles.find((profile) => profile.name === FENGSUI_APN_PROFILE);
    const room = countValue(listed["apn_num_preset"], 20) || 10;
    if (!own && profiles.length >= room) throw new CpeControlValidationError("The router's list of access points is full: delete one on the router's own page first");
    const index = String(own ? own.index : profiles.length);
    const pdp = ztePdpName(choice.ipType);
    await this.#whileDisconnected(check, wait, async () => {
      await this.#post(check, "APN_PROC_EX", [["apn_action", "save"], ["apn_mode", "manual"], ["profile_name", FENGSUI_APN_PROFILE], ["wan_dial", "*99#"], ["pdp_type", pdp], ["pdp_select", "auto"], ["index", index], ...zteApnFields(choice)]);
      await this.#defaultApn(check, pdp, index);
    });
    const after = await getCmd(this.#http, ["apn_mode", "wan_apn", "ipv6_wan_apn", "Current_index"], true, this.#at).catch(() => null);
    const mode = after === null ? null : textOf(after["apn_mode"]);
    const name = after === null ? null : textOf(after[choice.ipType === "ipv6" ? "ipv6_wan_apn" : "wan_apn"]);
    const current = after === null ? null : textOf(after["Current_index"]);
    settleSetting(check, mode === null || name === null ? null : mode.toLowerCase() === "manual" && name === choice.apn && (current === null || current === index));
  }

  async #defaultApn(check: WriteCheck, pdp: string, index: string): Promise<void> {
    await this.#post(check, "APN_PROC_EX", [
      ["apn_mode", "manual"],
      ["apn_action", "set_default"],
      ["set_default_flag", "1"],
      ["pdp_type", pdp],
      ["index", index],
    ]);
  }

  /** Back to automatic, or to the profile that was the default before (made the default again; its contents were never touched). */
  async #restoreApn(restore: ApnRestore, check: WriteCheck, wait: DriverWait): Promise<void> {
    if (restore.mode === "auto") return await this.#setApn({ mode: "auto" }, check, wait);
    if (restore.mode !== "profile") throw new CpeControlValidationError("This router keeps its access points as profiles: there is no such one to go back to");
    this.#guard();
    const profile = zteApnProfiles(await getCmd(this.#http, ZTE_APN_PROFILE_KEYS, true, this.#at)).find((found) => String(found.index) === restore.id);
    if (!profile || profile.pdpType === null || profile.name === FENGSUI_APN_PROFILE) throw new CpeControlValidationError("The access point profile that was in use is no longer on the router: nothing was sent");
    const pdp = profile.pdpType;
    await this.#whileDisconnected(check, wait, async () => {
      await this.#defaultApn(check, pdp, restore.id);
    });
    const after = await getCmd(this.#http, ["apn_mode", "Current_index"], true, this.#at).catch(() => null);
    const current = after === null ? null : textOf(after["Current_index"]);
    settleSetting(check, current === null ? null : current === restore.id && textOf(after?.["apn_mode"])?.toLowerCase() === "manual");
  }

  /**
   * One PIN write, sent once. `success` is the card taking it; anything else is the card refusing it:
   * an outcome, not an error, and nothing follows it. `settled` judges the SIM's state read afterwards.
   */
  async #pinWrite(check: WriteCheck, goformId: string, fields: Form, settled: (state: SimState | null, status: Record<string, unknown>) => boolean | null): Promise<SimPinOutcome> {
    const took = accepted(await this.#send(check, goformId, fields));
    const after = await getCmd(this.#http, ["modem_main_state", "pin_status", "pinnumber"], true, this.#at).catch(() => null);
    const attemptsLeft = after === null ? null : countValue(after["pinnumber"], 10);
    if (took) settleSetting(check, after === null ? null : settled(simStateOf(after["modem_main_state"]), after));
    else settleNothingToRead(check);
    return { accepted: took, attemptsLeft };
  }

  async #setPinLock(enabled: boolean, pin: string, check: WriteCheck): Promise<SimPinOutcome> {
    return await this.#pinWrite(check, enabled ? "ENABLE_PIN" : "DISABLE_PIN", [["OldPinNumber", pin]], (_state, status) => {
      const on = switchOf(status["pin_status"]);
      return on === null ? null : on === enabled;
    });
  }

  /** The limit by traffic (`data_volume_limit_unit=data`): the size in megabytes, and the share at which the router warns. */
  async #setDataLimit(limit: DataLimitSetting, check: WriteCheck): Promise<void> {
    const fields: Form = [["data_volume_limit_switch", limit.enabled ? "1" : "0"]];
    if (limit.enabled) {
      if (limit.bytes === null) throw new CpeControlValidationError("Turning the data limit on needs its size");
      let percent = limit.alertPercent;
      if (percent === null) {
        // The form takes the warning share with the size: the one the router has is kept
        const before = await getCmd(this.#http, ["data_volume_alert_percent"], true, this.#at).catch(() => null);
        percent = before === null ? null : percentValue(before["data_volume_alert_percent"]);
      }
      if (percent === null || percent < 1) throw new CpeControlValidationError("The router has no warning share set for its data limit: give alertPercent as well");
      fields.push(["data_volume_limit_unit", "data"], ["data_volume_limit_size", zteLimitSize(limit.bytes)], ["data_volume_alert_percent", String(percent)]);
    }
    await this.#post(check, "DATA_LIMIT_SETTING", fields);
    const after = (await this.#cellularRead().catch(() => null))?.dataLimit ?? null;
    settleSetting(check, sameDataLimit(limit, after));
  }

  /**
   * USSD as the router's page does it: `USSD_PROCESS` with `ussd_send` (or `ussd_reply` inside a
   * session), then `ussd_write_flag` until the answer is there, then `ussd_data_info`. A code the
   * network leaves unanswered is cancelled, so no session stays open on the router.
   */
  async #ussd(request: UssdRequest, check: WriteCheck, wait: DriverWait): Promise<UssdAnswer> {
    const flag = async (): Promise<unknown> => (await getCmd(this.#http, ["ussd_write_flag"], false, this.#at))["ussd_write_flag"];
    const cancel = async (): Promise<void> => {
      await this.#post(check, "USSD_PROCESS", [["USSD_operator", "ussd_cancel"]]);
    };
    settleNothingToRead(check);
    if (request.kind === "cancel") {
      await cancel();
      await awaitZteUssd(flag, wait).catch(() => null);
      return emptyUssd("cancelled");
    }
    await this.#post(check, "USSD_PROCESS", [
      ["USSD_operator", request.kind === "send" ? "ussd_send" : "ussd_reply"],
      [request.kind === "send" ? "USSD_send_number" : "USSD_reply_number", request.code],
      ["notCallback", "true"],
    ]);
    const state = await awaitZteUssd(flag, wait);
    if (state !== "answered") {
      if (state === "no_answer") await cancel().catch(() => undefined);
      return emptyUssd(state);
    }
    const info = await getCmd(this.#http, ["ussd_data_info"], false, this.#at);
    // `ussd_action` 1: the network asks for a reply and keeps the session open
    return { state: "answered", text: zteUssdText(info["ussd_data"]), awaitsReply: textOf(info["ussd_action"]) === "1" };
  }

  readonly sms: DriverSms = {
    keepsSent: true,
    list: () => this.#smsList(),
    counters: () => this.#smsCounters(),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
    markRead: (indices, check) => this.#smsMarkRead(indices, check),
    delete: (indices, check) => this.#smsDelete(indices, check),
  };

  async #smsList(): Promise<SmsWireMessage[]> {
    this.#guard();
    const seen = new Map<number, SmsWireMessage>();
    for (let page = 0; page < SMS_MAX_PAGES; page++) {
      const answer = await getCmdWith(
        this.#http,
        "sms_data_total",
        [
          ["page", String(page)],
          ["data_per_page", String(SMS_PAGE_SIZE)],
          ["mem_store", "1"],
          ["tags", "10"],
          ["order_by", "order by id desc"],
        ],
        this.#at
      );
      if (!Array.isArray(answer["messages"])) throw new SectionUnavailableError("SMS", null);
      const rows = answer["messages"];
      const before = seen.size;
      for (const message of parseZteSmsRows(rows)) seen.set(message.index, message);
      // A short page, or one that brought nothing new (a firmware that ignores `page`), is the last
      if (rows.length < SMS_PAGE_SIZE || seen.size === before) break;
    }
    return [...seen.values()];
  }

  /**
   * The store's own counts and the router's unread count. Always these two reads, also after a
   * listing: counts taken two ways would differ on a firmware whose unread count lags, and every
   * difference would start another sync.
   */
  async #smsCounters(): Promise<SmsCounters> {
    this.#guard();
    const capacity = await getCmd(this.#http, ["sms_capacity_info"], false, this.#at);
    const unread = await getCmd(this.#http, ["sms_unread_num"], true, this.#at).catch((): Record<string, unknown> => ({}));
    const counters = zteSmsCounters(capacity, unread["sms_unread_num"]);
    if (!counters) throw new SectionUnavailableError("SMS", null);
    return counters;
  }

  async #smsStatus(slot: number): Promise<Record<string, unknown>> {
    return await getCmdWith(this.#http, "sms_cmd_status_info", [["sms_cmd", String(slot)]], this.#at);
  }

  /** `SEND_SMS`, then the send slot until the router says the message went out or did not. */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    await this.#post(check, "SEND_SMS", [
      ["notCallback", "true"],
      ["Number", phone],
      ["sms_time", zteSmsTime(new Date())],
      ["MessageBody", ucs2Hex(content)],
      ["ID", "-1"],
      ["encode_type", detectSmsTextMode(content).encoding === "7BIT" ? "GSM7_default" : "UNICODE"],
    ]);
    options.onAccepted();
    const status = await awaitZteCommand(() => this.#smsStatus(ZTE_SMS_CMD_SEND), { timeoutMs: options.statusTimeoutMs, sleep: options.sleep });
    return { state: status === "done" ? "sent" : status === "failed" ? "failed" : "unconfirmed", code: null };
  }

  async #smsMarkRead(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const ids = storedIndices(indices);
    for (let i = 0; i < ids.length; i += SMS_ID_BATCH) {
      await this.#post(check, "SET_MSG_READ", [
        ["msg_id", zteIdList(ids.slice(i, i + SMS_ID_BATCH))],
        ["tag", "0"],
      ]);
    }
    settleSmsListing(check, await this.#smsList().catch(() => null), ids, "read");
  }

  async #smsDelete(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const ids = storedIndices(indices);
    for (let i = 0; i < ids.length; i += SMS_ID_BATCH) {
      await this.#post(check, "DELETE_SMS", [
        ["msg_id", zteIdList(ids.slice(i, i + SMS_ID_BATCH))],
        ["notCallback", "true"],
      ]);
      const status = await awaitZteCommand(() => this.#smsStatus(ZTE_SMS_CMD_DELETE), { timeoutMs: SMS_DELETE_SETTLE_MS, intervalMs: SMS_DELETE_POLL_MS });
      if (status === "failed") throw new CpeApiError("failed", "DELETE_SMS did not delete");
    }
    settleSmsListing(check, await this.#smsList().catch(() => null), ids, "gone");
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

/** A write the router took: `success`, or `0` on the forms that answer a number. */
function accepted(result: unknown): boolean {
  const text = textOf(result);
  return text === "success" || text === "0";
}

function lockOf(status: Record<string, unknown>): { waitSec: number | null } | null {
  const wait = intOf(status["login_lock_time"]);
  const left = intOf(status["psw_fail_num_str"]);
  if ((wait !== null && wait > 0) || left === 0) return { waitSec: wait !== null && wait > 0 ? wait : null };
  return null;
}

function versionOf(versions: Record<string, unknown>): ZteVersion {
  return {
    modelName: textOf(versions["model_name"]) ?? "",
    hardwareVersion: textOf(versions["hardware_version"]) ?? "",
    waInnerVersion: textOf(versions["wa_inner_version"]) ?? "",
    crVersion: textOf(versions["cr_version"]) ?? "",
  };
}

/**
 * Which spelling the router answers, with its versions: the goform pages first (their request is
 * the one this driver always sent), then `reqproc`, which names its firmware in `cr_version` alone
 * on some builds. `null`: neither names a firmware, so this is not such a router.
 */
async function zteEndpoints(http: LanHttp): Promise<{ at: ZteEndpoints; version: ZteVersion } | null> {
  const goform = await getCmd(http, VERSION_KEYS).then(versionOf, () => null);
  if (goform && (goform.waInnerVersion !== "" || goform.hardwareVersion !== "")) return { at: GOFORM, version: goform };
  const reqproc = await getCmd(http, VERSION_KEYS, true, REQPROC).then(versionOf, () => null);
  if (reqproc && (reqproc.waInnerVersion !== "" || reqproc.hardwareVersion !== "" || reqproc.crVersion !== "")) return { at: REQPROC, version: reqproc };
  return null;
}

/** The `reqproc` firmware's write token (`cmd=get_token`), sent raw as `CSRFToken`; empty before a login. */
async function zteCsrfToken(http: LanHttp): Promise<string> {
  const answer = await getCmd(http, ["get_token"], false, REQPROC);
  return textOf(answer["token"]) ?? textOf(answer["get_token"]) ?? "";
}

/** The `password` field of the `reqproc` login: the lowercase SHA-256 of nonce + password, that text as Base64. */
export function zteReqprocPassword(randomLogin: string, password: string): string {
  return Buffer.from(sha256Hex(`${randomLogin}${password}`), "utf8").toString("base64");
}

/**
 * What a refused login was, from the router's own count of attempts left and of the lock (read without
 * a password). `2` is a duplicate user in ZTE's own page code and a locked login in both notes
 * libraries: with attempts left and no lock on the router it is someone signed in elsewhere (FengSui
 * yields), otherwise a lock (the breaker latches).
 */
async function zteLoginRefusal(http: LanHttp, at: ZteEndpoints, result: string | null, raw: unknown): Promise<never> {
  const status = await getCmd(http, LOCK_STATUS_KEYS, true, at).catch(() => ({}) as Record<string, unknown>);
  const lock = lockOf(status);
  const left = intOf(status["psw_fail_num_str"]);
  if (result === "2" && lock === null && left !== null && left > 0) throw signedInElsewhere("another administrator is signed in");
  if (result === "2" || lock) throw loginLocked("the router has locked its login", lock?.waitSec ?? null);
  if (result === "1" || result === "3") throw wrongPassword("the router refused the password", intOf(status["psw_fail_num_str"]));
  throw loginUnplaced(`login answered ${answerCode(raw)}`);
}

export const zteGoformProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    return (await zteEndpoints(http)) !== null;
  },

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    // The goform pages first, as always; a router without them is asked the `reqproc` way
    const status = await getCmd(http, LOCK_STATUS_KEYS).catch(() => getCmd(http, LOCK_STATUS_KEYS, true, REQPROC));
    return { occupied: false, locked: lockOf(status) };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const found = await zteEndpoints(http);
    if (!found) throw new DriverLoginMethodError("not a ZTE goform router: no firmware version");
    const { at, version } = found;
    if (at.variant === "reqproc") {
      const nonce = textOf((await getCmd(http, ["get_random_login"], false, at))["random_login"]);
      if (nonce === null) throw new DriverLoginMethodError("the router handed out no login nonce");
      const answer = await setCmd(
        http,
        [
          ["isTest", "false"],
          ["goformId", "LOGIN"],
          ["username", Buffer.from(credentials.username || "admin", "utf8").toString("base64")],
          ["password", zteReqprocPassword(nonce, credentials.password)],
          ["CSRFToken", await zteCsrfToken(http)],
        ],
        at
      );
      const result = textOf(answer["result"]);
      if (result === "0") return new ZteGoformSession(http, version, "csrf", credentials.password, null, at);
      if (result === "4") throw signedInElsewhere("another administrator is signed in");
      return await zteLoginRefusal(http, at, result, answer["result"]);
    }
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
    if (result === "0") return new ZteGoformSession(http, version, method.kind === "sha256-ld" ? "sha256" : "md5", credentials.password, configJs);
    if (result === "4") throw signedInElsewhere("another administrator is signed in");
    return await zteLoginRefusal(http, at, result, answer["result"]);
  },
};
