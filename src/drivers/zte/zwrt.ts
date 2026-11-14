import crypto from "node:crypto";
import type { ApnChoice, ApnRestore, DataLimitSetting, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, SimSlotRef } from "../../cellular.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import { SectionUnavailableError } from "../../cpe-domain.ts";
import { CpeControlValidationError } from "../../control-error.ts";
import { type WriteCheck, settleCheck } from "../../device-access.ts";
import { type BatteryStatus, type SimState, type TemperatureSensor, countValue, percentValue } from "../../router-status.ts";
import { detectSmsTextMode } from "../../sms/text-mode.ts";
import type { SmsCounters, SmsWireMessage } from "../../sms/types.ts";
import { bandsToList, checkCellLock, checkLockBands, hexToBands, listToBands } from "../bands.ts";
import { FENGSUI_APN_PROFILE, sameDataLimit, settleNothingToRead } from "../cellular.ts";
import { ZTE_MODE_NAMES, type ZwrtApnProfile, awaitOperatorStep, zteModeOf, zteRegisterDone, zteScanDone, zwrtApnBody, zwrtApnProfiles, zwrtScanRows } from "./cellular.ts";
import { carriersFromRows, servingModeOf } from "../cells.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "../client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, sha256Hex, wrongPassword } from "../login.ts";
import { awaitConnection, noteSent, settleBandLock, settleCellLock, settleDataSwitch, settleRestart, settleUnlock } from "../readback.ts";
import { settleSmsListing, storedIndices, textOfUcs2Hex, ucs2Hex } from "../sms.ts";
import { ZTE_SMS_CMD_DELETE, ZTE_SMS_CMD_SEND, awaitZteCommand, parseZteSmsRows, zteIdList, zteSmsCounters, zteSmsTime } from "./sms.ts";
import { cellHasData } from "../snapshot.ts";
import { type CellLockState, type DriverCell, type DriverNeighbour, type DriverNetworkMode, emptyCell } from "../../protocols/readings.ts";
import type { LanHttp } from "../../protocols/transport.ts";
import { UBUS_ANONYMOUS_SESSION, UbusRpc } from "../../protocols/ubus.ts";
import type {
  DriverBandLockTarget,
  DriverCellLockTarget,
  DriverCellular,
  DriverCellularState,
  DriverDataLink,
  DriverIdentity,
  DriverLockState,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
  DriverWait,
} from "../types.ts";
import {
  arfcnOf,
  bandOf,
  counterOf,
  fieldOf,
  iccidOf,
  identityOf,
  imsiOf,
  intOf,
  ipv4Of,
  ipv6Of,
  isPlainObject,
  labelOf,
  msisdnOf,
  nonNegativeOf,
  pciOf,
  plmnOf,
  rowsOf,
  rsrpOf,
  rsrqOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
} from "../../protocols/values.ts";

/**
 * ZTE routers on zWRT, ZTE's OpenWrt (G5 Pro / Ultra / TS, U60 Pro, U50 Pro, MC888D): JSON-RPC 2.0
 * `call`s to `POST /ubus/?t=<ms>`, `[session, object, method, args]`, answered `[0, {...}]`. Before the
 * login the session is 32 zeros; `zwrt_web.web_login` takes the double uppercase SHA-256 of the
 * password with the salt `web_login_info` hands out and returns the session. No LTE cell lock and no
 * nearby-cell list are documented for it.
 *
 * SMS is the `zwrt_wms` object: the same store, tags and status slots as the goform pages, with one
 * layer more. The web side keeps message bodies and numbers encrypted: the session takes the router's
 * RSA public key (`web_crt_get`), hands it an AES-256 key (`web_http_enstr_set`), and from then on
 * those fields travel as AES-256-GCM. A firmware without that exchange takes and gives them plain.
 */

const FAMILY = "zte-zwrt" as const;
const PATH = "/ubus/";
export const ZWRT_ANONYMOUS = UBUS_ANONYMOUS_SESSION;
const SESSION_ID = /^[0-9A-Za-z]{16,64}$/;

/**
 * zWRT's ubus (`POST /ubus/`, with the time stamp and referer its page sends), whose methods all
 * answer an object: a payload that is not one reads as empty.
 */
class Rpc extends UbusRpc {
  constructor(http: LanHttp) {
    super(http, { path: PATH, stamp: true, referer: "/" });
  }

  override async call(object: string, method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = await super.call(object, method, args);
    return isPlainObject(payload) ? payload : {};
  }

  override async batch(calls: ReadonlyArray<readonly [object: string, method: string, args: Record<string, unknown>]>): Promise<Array<Record<string, unknown>>> {
    return (await super.batch(calls)).map((payload) => (isPlainObject(payload) ? payload : {}));
  }
}

/** ubus answers for an object or a method this firmware does not have. */
const NOT_THERE: ReadonlySet<string> = new Set(["ubus-3", "ubus-4", "rpc-32000", "rpc-32601"]);

function notThere(err: unknown): boolean {
  return err instanceof CpeApiError && NOT_THERE.has(err.code);
}

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * A sensitive field as the router's page sends it once a key is agreed: AES-256-GCM, written as
 * Base64 of the 12-byte IV, the 16-byte tag and the ciphertext.
 */
export function zwrtEncryptField(key: Buffer, plain: string, iv: Buffer = crypto.randomBytes(GCM_IV_BYTES)): string {
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The reverse; `null` for anything that is not such a field under this key. */
export function zwrtDecryptField(key: Buffer, field: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(field)) return null;
  const raw = Buffer.from(field, "base64");
  if (raw.length < GCM_IV_BYTES + GCM_TAG_BYTES) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, GCM_IV_BYTES));
    decipher.setAuthTag(raw.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(GCM_IV_BYTES + GCM_TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The AES key for the router: its 64 hexadecimal digits, encrypted with the router's RSA public key
 * the way the router's page does it (PKCS #1 v1.5, which is what the router decrypts), as Base64. The
 * router hands its key out as PEM on one line, so the body is read as DER. `null`: not such a key.
 */
export function zwrtKeyEnvelope(publicKeyPem: string, key: Buffer): string | null {
  const body = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/.exec(publicKeyPem)?.[1];
  if (!body) return null;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.from(body.replace(/\s+/g, ""), "base64"), format: "der", type: "spki" });
    return crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(key.toString("hex"), "ascii")).toString("base64");
  } catch {
    return null;
  }
}

const SMS_PAGE_SIZE = 500;
const SMS_MAX_PAGES = 8;
const SMS_ID_BATCH = 20;
const SMS_DELETE_SETTLE_MS = 10_000;
const SMS_DELETE_POLL_MS = 300;
const WMS = "zwrt_wms";

export function zwrtLoginPassword(password: string, salt: string): string {
  return sha256Hex(`${sha256Hex(password, true)}${salt}`, true);
}

const NET_SELECT: Readonly<Record<DriverNetworkMode, string>> = { auto: "WL_AND_5G", lte: "Only_LTE", nr_sa: "Only_5G", nr_nsa: "LTE_AND_5G" };

function networkModeOf(value: unknown): DriverNetworkMode | null {
  const text = textOf(value);
  for (const [mode, name] of Object.entries(NET_SELECT) as Array<[DriverNetworkMode, string]>) if (text === name) return mode;
  return null;
}

function connectedOf(value: unknown): boolean | null {
  const text = textOf(value)?.toLowerCase();
  if (!text) return null;
  if (text.includes("disconnect") || text.includes("connecting")) return false;
  return text.endsWith("connected") ? true : null;
}

/** The data switch of a `get_wwaniface` answer (`null`: not named). */
function dataSwitchOf(call: Record<string, unknown> | null): boolean | null {
  const enable = call === null ? null : intOf(call["enable"]);
  return enable === 1 ? true : enable === 0 ? false : null;
}

/** The netinfo, traffic and device readings of one poll in FengSui's shape. */
export function parseZwrtTelemetry(parts: { info: Record<string, unknown>; netinfo: Record<string, unknown>; traffic: Record<string, unknown> | null; device: Record<string, unknown> | null }): DriverTelemetry {
  const n = (key: string): unknown => parts.netinfo[key];
  const mode = servingModeOf(n("network_type"));
  const lte: DriverCell = {
    ...emptyCell(),
    band: bandOf(n("wan_active_band")),
    arfcn: arfcnOf(n("wan_active_channel"), "LTE"),
    pci: pciOf(n("lte_pci"), "LTE", "auto"),
    cellId: identityOf(n("cell_id"), "auto"),
    tac: identityOf(n("lac_code"), "auto"),
    rsrpDbm: rsrpOf(n("lte_rsrp")),
    rsrqDb: rsrqOf(n("lte_rsrq")),
    sinrDb: sinrOf(n("lte_snr")),
  };
  const nr: DriverCell = {
    ...emptyCell(),
    band: bandOf(n("nr5g_action_band")),
    arfcn: arfcnOf(n("nr5g_action_channel"), "NR"),
    pci: pciOf(n("nr5g_pci"), "NR", "auto"),
    cellId: identityOf(n("nr5g_cell_id"), "auto"),
    tac: identityOf(n("lac_code"), "auto"),
    rsrpDbm: rsrpOf(n("nr5g_rsrp")),
    rsrqDb: rsrqOf(n("nr5g_rsrq")),
    sinrDb: sinrOf(n("nr5g_snr")),
  };
  // pci,band,earfcn,dl_bw,rsrp,rsrq,sinr per carrier
  const layout = [{ pci: 0, band: 1, arfcn: 2, bandwidth: 3, rsrp: 4, rsrq: 5, sinr: 6 }];
  const lteRows = carriersFromRows("LTE", n("lteca"), layout);
  const nrRows = carriersFromRows("NR", n("nrca"), layout);
  // A list that starts with the serving cell itself: its bandwidth is the cell's, the rest are secondary carriers
  for (const [rows, cell] of [
    [lteRows, lte],
    [nrRows, nr],
  ] as const) {
    const first = rows[0];
    if (first && first.arfcn === cell.arfcn && first.pci === cell.pci) {
      cell.bandwidthMhz = first.bandwidthMhz;
      rows.shift();
    }
  }
  const carriers = [...lteRows, ...nrRows];

  const t = parts.traffic;
  const d = parts.device;
  return {
    model: labelOf(parts.info["model_name"]),
    softwareVersion: labelOf(parts.info["wa_inner_version"]),
    hardwareVersion: labelOf(parts.info["hardware_version"]),
    operatorName: labelOf(n("network_provider_fullname")) ?? labelOf(n("network_provider")),
    plmn: plmnOf(n("rmcc"), n("rmnc")),
    mode,
    lte: cellHasData(lte) && mode !== "SA" ? lte : null,
    nr: cellHasData(nr) && (nr.rsrpDbm !== null || mode === "SA") ? nr : null,
    carriers,
    wan: {
      connected: t ? connectedOf(t["ppp_status"]) : null,
      ipv4: ipv4Of(n("wan_ipaddr")),
      ipv6: ipv6Of(n("ipv6_wan_ipaddr")),
      uptimeSec: t ? nonNegativeOf(t["real_time"]) : null,
    },
    traffic: t
      ? {
          downloadBytesPerSec: nonNegativeOf(t["real_rx_speed"]),
          uploadBytesPerSec: nonNegativeOf(t["real_tx_speed"]),
          totalDownloadBytes: null,
          totalUploadBytes: null,
          sessionDownloadBytes: counterOf(t["real_rx_bytes"]),
          sessionUploadBytes: counterOf(t["real_tx_bytes"]),
          sessionSeconds: nonNegativeOf(t["real_time"]),
          monthDownloadBytes: counterOf(t["month_rx_bytes"]),
          monthUploadBytes: counterOf(t["month_tx_bytes"]),
          monthTotalBytes: null,
          monthSeconds: nonNegativeOf(t["month_time"]),
        }
      : null,
    temperatureC: d ? temperatureOf(d["bat_temperature"]) : null,
    signalBars: smallIntOf(n("signalbar"), 5),
  };
}

/** A band lock as the router reads it back: a list or a mask, empty for no lock (every band); `null` when absent. */
function bandsOf(value: unknown): number[] | "all" | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "" || text === "0") return "all";
  const bands = /^0x/i.test(text) ? hexToBands(text) : listToBands(text);
  return bands === null ? null : bands.length === 0 ? "all" : bands;
}

/** The device-manager fields the poll asks for: the battery (notes library A, table 3.1) and its temperature. */
export const ZWRT_DEVICE_INFO = "bat_online,bat_percent,bat_charger_connect,bat_time_to_full,bat_time_to_empty,bat_temperature";

/** `sim_states` as the router's app reads it, else `modem_main_state` (open-u60-pro, the app's SIM page). */
function zwrtSimState(sim: Record<string, unknown>): SimState | null {
  switch (textOf(sim["sim_states"])?.toLowerCase()) {
    case "sim ready":
      return "ready";
    case "sim undetected":
      return "absent";
    case "wait pin":
      return "pin_required";
    case "wait puk":
      return "puk_required";
    case "sim destroy":
    case "error":
    case "sim_error":
      return "error";
  }
  switch (textOf(sim["modem_main_state"])?.toLowerCase()) {
    case "modem_init_complete":
      return "ready";
    case "modem_waitpin":
      return "pin_required";
    case "modem_waitpuk":
      return "puk_required";
    case "modem_sim_undetected":
      return "absent";
    default:
      return null;
  }
}

/** A minutes estimate (`-1`: none). */
function minutesOf(value: unknown): number | null {
  const n = intOf(value);
  return n === null || n < 0 || n > 100_000 ? null : n;
}

/**
 * The battery, SIM card and roaming switch on top of a telemetry read. `bat_online` `0` is a router
 * without a battery; `bat_charger_connect` `1` a charger plugged in; `current_sim_slot` `1` the card
 * slot, `2` the built-in eSIM (notes library A); `pin_status` `1` the PIN asked at start, `pinnumber` /
 * `puknumber` the tries left (open-u60-pro); `roam_enable` the data call's roaming switch.
 */
export function withZwrtStatus(
  t: DriverTelemetry,
  parts: { device: Record<string, unknown> | null; sim: Record<string, unknown> | null; wwan: Record<string, unknown> | null }
): DriverTelemetry {
  const d = parts.device ?? {};
  const percent = intOf(d["bat_online"]) === 0 ? null : percentValue(d["bat_percent"]);
  const connected = intOf(d["bat_charger_connect"]);
  const battery: BatteryStatus | null =
    percent === null
      ? null
      : {
          percent,
          charging: connected === 1 ? true : connected === 0 ? false : null,
          temperatureC: temperatureOf(d["bat_temperature"]),
          minutesToFull: minutesOf(d["bat_time_to_full"]),
          minutesToEmpty: minutesOf(d["bat_time_to_empty"]),
        };
  const sim = parts.sim;
  const slot = sim ? intOf(sim["current_sim_slot"]) : null;
  const pin = sim ? textOf(sim["pin_status"]) : null;
  const roam = parts.wwan ? intOf(parts.wwan["roam_enable"]) : null;
  const temperatures: TemperatureSensor[] = battery?.temperatureC != null ? [{ kind: "battery", name: null, celsius: battery.temperatureC }] : [];
  return {
    ...t,
    ...(temperatures.length > 0 ? { temperatures } : {}),
    ids: sim ? { imsi: imsiOf(sim["sim_imsi"]), msisdn: msisdnOf(sim["msisdn"]), iccid: iccidOf(sim["sim_iccid"]) } : {},
    status: {
      battery,
      sim: sim
        ? {
            state: zwrtSimState(sim),
            pinLockEnabled: pin === "1" ? true : pin === "0" ? false : null,
            pinAttemptsLeft: countValue(sim["pinnumber"], 10),
            pukAttemptsLeft: countValue(sim["puknumber"], 10),
            slot: slot === 1 ? { kind: "physical", index: 1 } : slot === 2 ? { kind: "embedded", index: 1 } : null,
          }
        : null,
      roaming: { active: null, dataAllowed: roam === 1 ? true : roam === 0 ? false : null },
    },
  };
}

export function parseZwrtLockState(netinfo: Record<string, unknown>): DriverLockState {
  const lte = bandsOf(netinfo["lte_band_lock"] ?? netinfo["lte_band"]);
  const nr = bandsOf(netinfo["nr5g_sa_band_lock"]);
  const cell = rowsOf(netinfo["lock_nr_cell"])[0];
  let nrCell: CellLockState | null = null;
  if (cell && cell.length >= 3) {
    const arfcn = intOf(cell[1]);
    nrCell = arfcn === null || arfcn === 0 ? { locked: false } : { locked: true, pci: pciOf(cell[0], "NR"), arfcn, band: bandOf(cell[2]) };
  }
  return {
    lteBands: lte,
    nrBands: nr,
    lteCell: null,
    nrCell,
    networkMode: networkModeOf(netinfo["net_select"]),
    supportedLte: null,
    supportedNr: null,
  };
}

class ZwrtSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #rpc: Rpc;
  #info: Record<string, unknown> | null = null;
  #open = true;

  constructor(rpc: Rpc) {
    this.#rpc = rpc;
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  async #commonInfo(): Promise<Record<string, unknown>> {
    if (this.#info) return this.#info;
    const answer = await this.#rpc.call("uci", "get", { config: "zwrt_common_info", section: "common_config" });
    const values = fieldOf(answer, "values");
    this.#info = isPlainObject(values) ? values : {};
    return this.#info;
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    const info = await this.#commonInfo();
    return { model: labelOf(info["model_name"]), softwareVersion: labelOf(info["wa_inner_version"]), hardwareVersion: labelOf(info["hardware_version"]) };
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    const info = await this.#commonInfo();
    const netinfo = await this.#rpc.call("zte_nwinfo_api", "nwinfo_get_netinfo");
    // Traffic and the device sensors are their own calls; a firmware without them still has a signal
    const traffic = await this.#rpc.call("zwrt_data", "get_wwandst", { source_module: "web", cid: 1, type: 4 }).catch(() => null);
    const device = await this.#rpc.call("zwrt_mc.device.manager", "get_device_info", { deviceInfoList: ZWRT_DEVICE_INFO }).catch(() => null);
    const t = parseZwrtTelemetry({ info, netinfo, traffic, device });
    // The SIM card (the web role may call `get_sim_info`; notes library A has `get_sim_info_before`) and the
    // data call's roaming switch ride on the same session; a firmware without them keeps its readings
    const sim =
      (await this.#rpc.call("zwrt_zte_mdm.api", "get_sim_info").catch(() => null)) ?? (await this.#rpc.call("zwrt_zte_mdm.api", "get_sim_info_before").catch(() => null));
    const wwan = await this.#rpc.call("zwrt_data", "get_wwaniface", { source_module: "web", cid: 1 }).catch(() => null);
    return withZwrtStatus(t, { device, sim, wwan });
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    throw new SectionUnavailableError("The nearby-cell list", null);
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    return parseZwrtLockState(await this.#rpc.call("zte_nwinfo_api", "nwinfo_get_netinfo"));
  }

  async #write(check: WriteCheck, method: string, args: Record<string, unknown>, object = "zte_nwinfo_api"): Promise<void> {
    this.#guard();
    noteSent(check, FAMILY, `${object}.${method}`);
    const answer = await this.#rpc.call(object, method, args);
    const result = fieldOf(answer, "result");
    if (result !== undefined && intOf(result) !== 0) throw new CpeApiError(`result${intOf(result) ?? ""}`, `${object}.${method} refused`);
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    // "Every band" is the reset of the band settings, which also clears a cell lock: refuse that mix
    if (target.lte === "all" && target.nr !== null && target.nr !== "all") throw new CpeControlValidationError("Lock the NR bands together with a list of LTE bands on this router, or unlock everything");
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null || target.nr === "all" ? target.nr : checkLockBands("NR", target.nr, null);
    if (lte === "all" && (nr === null || nr === "all")) {
      await this.#write(check, "nwinfo_reset_band_cell_setting", {});
    } else {
      if (lte !== "all") await this.#write(check, "nwinfo_set_lte_ext_band", { lte_band: bandsToList(lte, ",") });
      if (nr !== null && nr !== "all") await this.#write(check, "nwinfo_set_nrbandlock", { nr5g_band: bandsToList(nr, ","), nr5g_type: "0" });
    }
    if (target.networkMode !== null) await this.#write(check, "nwinfo_set_netselect", { net_select: NET_SELECT[target.networkMode] });
    settleBandLock(check, { lte, nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const checked = checkCellLock(target);
    if (checked.rat === "LTE") throw new CpeControlValidationError("This router locks NR cells only");
    await this.#write(check, "nwinfo_lock_nr_cell", { lock_nr_pci: String(checked.pci), lock_nr_earfcn: String(checked.arfcn), lock_nr_cell_band: String(checked.band) });
    settleCellLock(check, checked, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    await this.#write(check, "nwinfo_reset_band_cell_setting", {});
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#write(check, "nwinfo_set_netselect", { net_select: NET_SELECT.auto });
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  /** `undefined`: not asked yet; `null`: this firmware has no field encryption. */
  #fieldKey: Buffer | null | undefined = undefined;
  /** Whether the firmware writes sender numbers as UTF-16 hexadecimal (its `zte_wms_number_encode` setting). */
  #numbersAreHex: boolean | undefined = undefined;

  /**
   * Agree a key for the encrypted fields, once per session. A firmware without the exchange (or one
   * that refuses it) leaves the fields plain, which is how its ubus object takes them.
   */
  async #agreeFieldKey(): Promise<Buffer | null> {
    if (this.#fieldKey !== undefined) return this.#fieldKey;
    this.#fieldKey = null;
    try {
      const pem = textLong((await this.#rpc.call("zwrt_web", "web_crt_get"))["result"]);
      const key = crypto.randomBytes(32);
      const envelope = pem === null ? null : zwrtKeyEnvelope(pem, key);
      if (envelope !== null) {
        await this.#rpc.call("zwrt_web", "web_http_enstr_set", { web_enstr: envelope });
        this.#fieldKey = key;
      }
    } catch {
      // No key: the fields stay plain
    }
    return this.#fieldKey;
  }

  async #hexNumbers(): Promise<boolean> {
    if (this.#numbersAreHex === undefined) {
      const answer = await this.#rpc.call("uci", "get", { config: "zwrt_wms", section: "config" }).catch(() => null);
      const values = answer ? fieldOf(answer, "values") : null;
      const flag = isPlainObject(values) ? textOf(values["zte_wms_number_encode"]) : null;
      // Unreadable: numbers are taken as plain, which shows a hexadecimal one as it came rather than garbling a plain one
      this.#numbersAreHex = flag !== null && flag !== "0";
    }
    return this.#numbersAreHex;
  }

  /** SMS in the router's own store (`zwrt_wms`). */
  readonly sms: DriverSms = {
    keepsSent: true,
    list: () => this.#smsList(),
    counters: () => this.#smsCounters(),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
    markRead: (indices, check) => this.#smsMarkRead(indices, check),
    delete: (indices, check) => this.#smsDelete(indices, check),
  };

  async #smsCounters(): Promise<SmsCounters> {
    this.#guard();
    let capacity: Record<string, unknown>;
    try {
      capacity = await this.#rpc.call(WMS, "zwrt_wms_get_wms_capacity");
    } catch (err) {
      if (notThere(err)) throw new SectionUnavailableError("SMS", null);
      throw err;
    }
    const counters = zteSmsCounters(capacity, capacity["sms_dev_unread_num"]);
    if (!counters) throw new SectionUnavailableError("SMS", null);
    return counters;
  }

  async #smsList(): Promise<SmsWireMessage[]> {
    this.#guard();
    const key = await this.#agreeFieldKey();
    const hexNumbers = await this.#hexNumbers();
    const field = (raw: string, kind: "number" | "content"): string | null => {
      // Under a key a field is ciphertext; one that is not (an older message, another firmware) is read as it came
      const plain = key === null || raw === "" ? raw : (zwrtDecryptField(key, raw) ?? raw);
      return kind === "number" && hexNumbers ? (textOfUcs2Hex(plain) ?? plain) : plain;
    };
    const seen = new Map<number, SmsWireMessage>();
    for (let page = 0; page < SMS_MAX_PAGES; page++) {
      let answer: Record<string, unknown>;
      try {
        answer = await this.#rpc.call(WMS, "zte_libwms_get_sms_data", { page, data_per_page: SMS_PAGE_SIZE, mem_store: 1, tags: 10, order_by: "order by id desc" });
      } catch (err) {
        if (notThere(err)) throw new SectionUnavailableError("SMS", null);
        throw err;
      }
      const rows = answer["messages"];
      if (!Array.isArray(rows)) break;
      const before = seen.size;
      for (const message of parseZteSmsRows(rows, field)) seen.set(message.index, message);
      if (rows.length < SMS_PAGE_SIZE || seen.size === before) break;
    }
    return [...seen.values()];
  }

  /** An SMS write: the ubus status says whether the router took it (its `result` field is no verdict), the status slot what came of it. */
  async #smsWrite(check: WriteCheck, method: string, args: Record<string, unknown>): Promise<void> {
    this.#guard();
    noteSent(check, FAMILY, `${WMS}.${method}`);
    await this.#rpc.call(WMS, method, args);
  }

  async #smsStatus(slot: number): Promise<Record<string, unknown>> {
    return await this.#rpc.call(WMS, "zwrt_wms_get_cmd_status", { sms_cmd: slot });
  }

  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    const key = await this.#agreeFieldKey();
    const seal = (plain: string): string => (key === null ? plain : zwrtEncryptField(key, plain));
    await this.#smsWrite(check, "zte_libwms_send_sms", {
      number: seal(phone),
      sms_time: zteSmsTime(new Date()),
      message_body: seal(ucs2Hex(content)),
      id: "-1",
      encode_type: detectSmsTextMode(content).encoding === "7BIT" ? "GSM7_default" : "UNICODE",
    });
    options.onAccepted();
    const status = await awaitZteCommand(() => this.#smsStatus(ZTE_SMS_CMD_SEND), { timeoutMs: options.statusTimeoutMs, sleep: options.sleep });
    return { state: status === "done" ? "sent" : status === "failed" ? "failed" : "unconfirmed", code: null };
  }

  async #smsMarkRead(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const ids = storedIndices(indices);
    for (let i = 0; i < ids.length; i += SMS_ID_BATCH) await this.#smsWrite(check, "zwrt_wms_modify_tag", { id: zteIdList(ids.slice(i, i + SMS_ID_BATCH)), tag: 0 });
    settleSmsListing(check, await this.#smsList().catch(() => null), ids, "read");
  }

  /** The firmware answers a delete the same whether or not it deleted (rows on the SIM stay): the listing after it tells. */
  async #smsDelete(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const ids = storedIndices(indices);
    for (let i = 0; i < ids.length; i += SMS_ID_BATCH) {
      await this.#smsWrite(check, "zwrt_wms_delete_sms", { id: zteIdList(ids.slice(i, i + SMS_ID_BATCH)) });
      const status = await awaitZteCommand(() => this.#smsStatus(ZTE_SMS_CMD_DELETE), { timeoutMs: SMS_DELETE_SETTLE_MS, intervalMs: SMS_DELETE_POLL_MS });
      if (status === "failed") throw new CpeApiError("failed", "zwrt_wms_delete_sms did not delete");
    }
    settleSmsListing(check, await this.#smsList().catch(() => null), ids, "gone");
  }

  /** The data call as the router's app reads it (`zwrt_data.get_wwaniface`). */
  async #wwan(): Promise<Record<string, unknown>> {
    this.#guard();
    const answer = await this.#rpc.call("zwrt_data", "get_wwaniface", { source_module: "web", cid: 1 });
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError("zwrt_data.get_wwaniface: not an object");
    return answer;
  }

  /**
   * Mobile data: `zwrt_data.set_wwaniface` with `enable` (notes library A; the router's app sends back
   * the call's current `connect_mode` and `roam_enable` with it, automatic when switching data on, so
   * the roaming setting is never reset), read back from `get_wwaniface`. Switching off waits for the
   * call to go down before the read-back, so a redial's connect does not meet a disconnect in progress.
   */
  readonly data: DriverDataLink = {
    enabled: async () => dataSwitchOf(await this.#wwan()),
    set: async (enabled, check, wait) => {
      const current = await this.#wwan().catch(() => null);
      const kept = current === null ? {} : { connect_mode: enabled ? 1 : (intOf(current["connect_mode"]) ?? 1), roam_enable: intOf(current["roam_enable"]) ?? 0 };
      await this.#write(check, "set_wwaniface", { source_module: "web", cid: 1, ...kept, enable: enabled ? 1 : 0 }, "zwrt_data");
      if (!enabled) await awaitConnection(async () => connectedOf((await this.#wwan())["connect_status"]), false, wait);
      settleDataSwitch(check, enabled, dataSwitchOf(await this.#wwan().catch(() => null)));
    },
  };

  /** The SIM card as the web role reads it (`get_sim_info`; notes library A has `get_sim_info_before`, with the slot alone). */
  async #simInfo(): Promise<Record<string, unknown> | null> {
    return (await this.#rpc.call(MDM, "get_sim_info").catch(() => null)) ?? (await this.#rpc.call(MDM, "get_sim_info_before").catch(() => null));
  }

  /**
   * The cellular settings: `nwinfo_set_netselect` (the six modes of notes library A), the SIM slot (two
   * `zwrt_mdm_change_provision_session` calls in one batch), the data call's roaming switch
   * (`set_wwaniface`, sent with the call's other settings as they are), the PIN (`sim_verify_pin_puk`,
   * `sim_change_pin_mode`), the monthly limit (`set_wwandst_monthlimit`), the operator
   * (`nwinfo_manual_scan`, `nwinfo_manual_register`, and `nwinfo_set_netselect` back to automatic) and
   * the access point (`zwrt_apn_object`). `docs/dev/sources.md` §18.6 names the source of each.
   */
  readonly cellular: DriverCellular = {
    read: () => this.#cellularRead(),
    setNetworkMode: (mode, check) => this.#setNetworkMode(mode, check),
    setSimSlot: (slot, check) => this.#setSimSlot(slot, check),
    setRoaming: (enabled, check) => this.#setRoaming(enabled, check),
    setApn: (choice, check) => this.#setApn(choice, check),
    restoreApn: (restore, check) => this.#restoreApn(restore, check),
    scanOperators: (check, wait) => this.#scanOperators(check, wait),
    selectOperator: (selection, check, wait) => this.#selectOperator(selection, check, wait),
    enterPin: (pin, check) => this.#pinWrite(check, "sim_verify_pin_puk", { pin_num: pin, puk_num: "", pin_encode_flag: "0" }, (sim) => (zwrtSimState(sim) === "pin_required" ? false : zwrtSimState(sim) === null ? null : true)),
    setPinLock: (enabled, pin, check) =>
      this.#pinWrite(check, "sim_change_pin_mode", { pin_num_m: pin, pin_mode: enabled ? 1 : 0, pin_encode_flag: "0" }, (sim) => {
        const on = textOf(sim["pin_status"]);
        return on === "1" ? enabled : on === "0" ? !enabled : null;
      }),
    setDataLimit: (limit, check) => this.#setDataLimit(limit, check),
  };

  async #cellularRead(): Promise<DriverCellularState> {
    this.#guard();
    const netinfo = await this.#rpc.call("zte_nwinfo_api", "nwinfo_get_netinfo");
    const sim = await this.#simInfo();
    const limit = await this.#rpc.call("zwrt_data", "get_wwandst_monthlimit", WEB_CALL).catch(() => null);
    const slot = sim ? intOf(sim["current_sim_slot"]) : null;
    const selection = textOf(netinfo["net_select_mode"]);
    const apn = await this.#apnState().catch(() => null);
    const inUse = apn?.profiles.find((profile) => profile.enabled) ?? null;
    return {
      networkMode: zteModeOf(netinfo["net_select"]),
      // The router says how it chooses, not which operator it was told to stay on
      ...(selection === null ? {} : { operator: { selection: selection === "manual_select" ? ("manual" as const) : ("auto" as const), plmn: null } }),
      ...(apn === null
        ? {}
        : {
            // Chosen by the router: which access point that is, it does not say here
            apn: apn.manual && inUse ? { mode: "manual" as const, apn: inUse.apn, ipType: inUse.ipType, auth: inUse.auth, hasUsername: inUse.hasUsername } : { mode: apn.manual ? ("manual" as const) : ("auto" as const), apn: null, ipType: null, auth: null, hasUsername: null },
            // FengSui's own profile is overwritten by the next change, so it is nothing to go back to
            apnRestore: !apn.manual ? { mode: "auto" as const } : inUse && inUse.name !== FENGSUI_APN_PROFILE ? { mode: "profile" as const, id: String(inUse.id) } : null,
          }),
      // A router that names no slot has none to switch
      simSlots: slot === null ? [] : [...ZWRT_SLOTS],
      simSlot: slot === null ? null : (ZWRT_SLOTS[slot - 1] ?? null),
      dataLimit: limit ? zwrtLimit(limit) : null,
      pinAttemptsLeft: sim ? countValue(sim["pinnumber"], 10) : null,
    };
  }

  async #setNetworkMode(mode: NetworkMode, check: WriteCheck): Promise<void> {
    const name = ZTE_MODE_NAMES[mode];
    if (name === undefined) throw new CpeControlValidationError(`This router has no "${mode}" network mode`);
    await this.#write(check, "nwinfo_set_netselect", { net_select: name });
    const after = await this.#rpc.call("zte_nwinfo_api", "nwinfo_get_netinfo").catch(() => null);
    settleCheck(check, after === null || textOf(after["net_select"]) === null ? null : zteModeOf(after["net_select"]) === mode);
  }

  /** `nwinfo_manual_scan`, then `nwinfo_m_netselect_status` until the search is over, then the list. Nothing is disconnected first: the modem drops the data call by itself while it searches. */
  async #scanOperators(check: WriteCheck, wait: DriverWait): Promise<OperatorChoice[]> {
    settleNothingToRead(check);
    await this.#write(check, "nwinfo_manual_scan", {});
    // The status still shows the end of an earlier search for a moment: an end is believed once the router was seen searching, or after six asks
    let asks = 0;
    let busy = false;
    const done = await awaitOperatorStep(
      async () => (await this.#rpc.call("zte_nwinfo_api", "nwinfo_m_netselect_status"))["m_netselect_status"],
      (status) => {
        asks += 1;
        const over = zteScanDone(status);
        if (over === null) {
          busy = busy || status !== null;
          return null;
        }
        return busy || asks > 6 ? over : null;
      },
      wait
    );
    if (done === null) throw new CpeApiError("timeout", "The router was still searching for networks after two minutes");
    if (!done) throw new CpeApiError("failed", "The router could not search for networks");
    return zwrtScanRows((await this.#rpc.call("zte_nwinfo_api", "nwinfo_m_netselect_contents"))["m_netselect_contents"]).map((row) => row.choice);
  }

  /**
   * Back to automatic is `nwinfo_set_netselect` with `net_select_mode`. One operator is
   * `nwinfo_manual_register` with a row of the router's last search (its code, and its technology as
   * the router wrote it), then `nwinfo_m_netselect_result` until the router says how it went.
   */
  async #selectOperator(selection: OperatorSelection, check: WriteCheck, wait: DriverWait): Promise<void> {
    if (selection.mode === "auto") {
      await this.#write(check, "nwinfo_set_netselect", { net_select_mode: "auto_select" });
      const after = await this.#rpc.call("zte_nwinfo_api", "nwinfo_get_netinfo").catch(() => null);
      const mode = after === null ? null : textOf(after["net_select_mode"]);
      settleCheck(check, mode === null ? null : mode === "auto_select");
      return;
    }
    this.#guard();
    const rows = zwrtScanRows((await this.#rpc.call("zte_nwinfo_api", "nwinfo_m_netselect_contents"))["m_netselect_contents"]).filter((row) => row.choice.plmn === selection.plmn && row.choice.state !== "forbidden");
    const row = rows.find((found) => selection.rat === null || found.choice.rat === selection.rat);
    if (!row || row.rat === "") throw new CpeControlValidationError("This router registers on an operator from its last search, and that search does not list this one as allowed: search for networks first");
    await this.#write(check, "nwinfo_manual_register", { m_mcc_mnc: row.choice.plmn, m_rat: row.rat });
    const took = await awaitOperatorStep(async () => (await this.#rpc.call("zte_nwinfo_api", "nwinfo_m_netselect_result"))["m_netselect_result"], zteRegisterDone, wait);
    // A registration the router gave up on is a write that did not take: recorded as such, and watched like one
    settleCheck(check, took);
  }

  async #apnState(): Promise<{ manual: boolean; profiles: ZwrtApnProfile[] }> {
    this.#guard();
    const mode = intOf((await this.#rpc.call(APN, "get_apn_mode"))["apn_mode"]);
    if (mode !== 0 && mode !== 1) throw new CpeAnswerFormatError("zwrt_apn_object.get_apn_mode");
    return { manual: mode === 1, profiles: zwrtApnProfiles((await this.#rpc.call(APN, "get_manu_apn_list"))["apnListArray"]) };
  }

  /**
   * `zwrt_apn_object`. Automatic is `set_apn_mode` 0. An access point set by hand goes into FengSui's
   * own profile (`add_manu_apn` the first time, `modify_manu_apn` from then on), which is then made the
   * one in use (`enable_manu_apn_id`) with the mode set to manual. No other profile is changed.
   */
  async #setApn(choice: ApnChoice, check: WriteCheck): Promise<void> {
    if (choice.mode === "auto") {
      await this.#write(check, "set_apn_mode", { apn_mode: 0 }, APN);
      const after = await this.#apnState().catch(() => null);
      settleCheck(check, after === null ? null : !after.manual);
      return;
    }
    const before = await this.#apnState();
    const own = before.profiles.find((profile) => profile.name === FENGSUI_APN_PROFILE);
    if (own) await this.#write(check, "modify_manu_apn", { profileId: own.id, ...zwrtApnBody(choice) }, APN);
    else await this.#write(check, "add_manu_apn", zwrtApnBody(choice), APN);
    // A new profile gets its id from the router
    const saved = own ?? (await this.#apnState()).profiles.find((profile) => profile.name === FENGSUI_APN_PROFILE);
    if (!saved) throw new CpeApiError("unsaved", "The router did not keep the access point profile");
    await this.#useApnProfile(check, saved.id, before.manual);
    const after = await this.#apnState().catch(() => null);
    const inUse = after?.profiles.find((profile) => profile.enabled) ?? null;
    settleCheck(check, after === null ? null : after.manual && inUse !== null && inUse.name === FENGSUI_APN_PROFILE && inUse.apn === choice.apn);
  }

  async #useApnProfile(check: WriteCheck, id: string | number, manual: boolean): Promise<void> {
    await this.#write(check, "enable_manu_apn_id", { profileId: id }, APN);
    if (!manual) await this.#write(check, "set_apn_mode", { apn_mode: 1 }, APN);
  }

  /** Back to automatic, or to the profile that was in use before (made the one in use again; its contents were never touched). */
  async #restoreApn(restore: ApnRestore, check: WriteCheck): Promise<void> {
    if (restore.mode === "auto") return await this.#setApn({ mode: "auto" }, check);
    if (restore.mode !== "profile") throw new CpeControlValidationError("This router keeps its access points as profiles: there is no such one to go back to");
    const before = await this.#apnState();
    const profile = before.profiles.find((found) => String(found.id) === restore.id);
    if (!profile || profile.name === FENGSUI_APN_PROFILE) throw new CpeControlValidationError("The access point profile that was in use is no longer on the router: nothing was sent");
    await this.#useApnProfile(check, profile.id, before.manual);
    const after = await this.#apnState().catch(() => null);
    settleCheck(check, after === null ? null : after.manual && after.profiles.some((found) => found.enabled && String(found.id) === restore.id));
  }

  /** The slot that goes active and the one that goes inactive, in one request, as the router's page sends them. */
  async #setSimSlot(slot: SimSlotRef, check: WriteCheck): Promise<void> {
    this.#guard();
    const target = ZWRT_SLOTS.findIndex((known) => known.kind === slot.kind && known.index === slot.index) + 1;
    if (target < 1) throw new CpeControlValidationError("This router has a card slot and one built-in card: no such SIM slot");
    const other = target === 1 ? 2 : 1;
    noteSent(check, FAMILY, `${MDM}.zwrt_mdm_change_provision_session`);
    const answers = await this.#rpc.batch([
      [MDM, "zwrt_mdm_change_provision_session", { active_slot: target, active_flag: 1 }],
      [MDM, "zwrt_mdm_change_provision_session", { active_slot: other, active_flag: 0 }],
    ]);
    for (const answer of answers) {
      const result = fieldOf(answer, "result");
      if (result !== undefined && intOf(result) !== 0) throw new CpeApiError(`result${intOf(result) ?? ""}`, "zwrt_mdm_change_provision_session refused");
    }
    const after = await this.#simInfo();
    const read = after ? intOf(after["current_sim_slot"]) : null;
    settleCheck(check, read === null ? null : read === target);
  }

  /** The roaming switch travels with the data call's switch and dial mode: both are read first and sent back as they are. */
  async #setRoaming(enabled: boolean, check: WriteCheck): Promise<void> {
    const current = await this.#wwan();
    const on = intOf(current["enable"]);
    const mode = intOf(current["connect_mode"]);
    if (on === null || mode === null) throw new CpeControlValidationError("The data call's own settings could not be read, and the roaming switch is written together with them: nothing was sent");
    await this.#write(check, "set_wwaniface", { source_module: "web", cid: 1, enable: on, connect_mode: mode, roam_enable: enabled ? 1 : 0 }, "zwrt_data");
    const after = await this.#wwan().catch(() => null);
    const read = after === null ? null : intOf(after["roam_enable"]);
    settleCheck(check, read === null ? null : (read === 1) === enabled);
  }

  /**
   * One PIN write, sent once. `success` (or `0`) is the card taking it; anything else is the card
   * refusing it: an outcome, not an error, and nothing follows it.
   */
  async #pinWrite(check: WriteCheck, method: string, args: Record<string, unknown>, settled: (sim: Record<string, unknown>) => boolean | null): Promise<SimPinOutcome> {
    this.#guard();
    noteSent(check, FAMILY, `${MDM}.${method}`);
    const result = fieldOf(await this.#rpc.call(MDM, method, args), "result");
    const took = textOf(result) === "success" || intOf(result) === 0;
    const after = await this.#rpc.call(MDM, "get_sim_info").catch(() => null);
    if (took) settleCheck(check, after === null ? null : settled(after));
    else settleNothingToRead(check);
    return { accepted: took, attemptsLeft: after === null ? null : countValue(after["pinnumber"], 10) };
  }

  /** The limit by traffic (`type` 2): bytes as text, the share at which the router warns, and its own "disconnect at the limit" left as it is. */
  async #setDataLimit(limit: DataLimitSetting, check: WriteCheck): Promise<void> {
    this.#guard();
    const before = zwrtLimitRaw(await this.#rpc.call("zwrt_data", "get_wwandst_monthlimit", WEB_CALL).catch(() => null));
    const bytes = limit.bytes ?? before.bytes;
    const percent = limit.alertPercent ?? before.alertPercent;
    if (limit.enabled && (bytes === null || percent === null || percent < 1)) throw new CpeControlValidationError("The router has no size or warning share set for its data limit: give bytes and alertPercent");
    await this.#write(
      check,
      "set_wwandst_monthlimit",
      { source_module: "web", cid: 1, enable: limit.enabled ? 1 : 0, type: 2, value: String(bytes ?? 0), ratio: percent ?? 0, overflow_auto_disconn: before.autoDisconnect ? 1 : 0 },
      "zwrt_data"
    );
    const after = await this.#rpc.call("zwrt_data", "get_wwandst_monthlimit", WEB_CALL).catch(() => null);
    settleCheck(check, sameDataLimit({ ...limit, bytes: limit.enabled ? bytes : null }, after ? zwrtLimit(after) : null));
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#write(check, "device_reboot", { moduleName: "web" }, "zwrt_mc.device.manager");
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await this.#rpc.call("zwrt_web", "web_logout");
  }
}

const MDM = "zwrt_zte_mdm.api";
const APN = "zwrt_apn_object";
/** What `zwrt_data` calls of the web side carry. */
const WEB_CALL = { source_module: "web", cid: 1 } as const;
/** `current_sim_slot` 1 is the card slot, 2 the built-in eSIM (notes library A). */
const ZWRT_SLOTS: ReadonlyArray<SimSlotRef> = [
  { kind: "physical", index: 1 },
  { kind: "embedded", index: 1 },
];

/** A `0` / `1` flag the firmware writes as a number or as text. */
function flagOf(value: unknown): boolean | null {
  const n = intOf(value);
  return n === 1 ? true : n === 0 ? false : null;
}

/** The monthly limit as `get_wwandst_monthlimit` answers it: `enable`, `value` in bytes when `type` is 2 (by traffic), `ratio` the warning share. */
function zwrtLimitRaw(answer: Record<string, unknown> | null): { enabled: boolean | null; bytes: number | null; alertPercent: number | null; autoDisconnect: boolean } {
  if (!answer) return { enabled: null, bytes: null, alertPercent: null, autoDisconnect: false };
  // A size in bytes runs past what a reading's digits hold: read as a counter
  const size = intOf(answer["type"]) === 2 ? counterOf(answer["value"]) : null;
  const bytes = size !== null && size > 0n && size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null;
  return { enabled: flagOf(answer["enable"]), bytes, alertPercent: percentValue(answer["ratio"]), autoDisconnect: flagOf(answer["overflow_auto_disconn"]) === true };
}

function zwrtLimit(answer: Record<string, unknown>): { enabled: boolean | null; bytes: number | null; alertPercent: number | null } {
  const { enabled, bytes, alertPercent } = zwrtLimitRaw(answer);
  return { enabled, bytes, alertPercent };
}

/** Text longer than a reading (a PEM key), bounded. */
function textLong(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
}

function lockOf(payload: Record<string, unknown>): { waitSec: number | null } | null {
  const wait = intOf(payload["login_fail_lock_lefttime"]);
  return wait !== null && wait > 0 ? { waitSec: wait } : null;
}

export const zteZwrtProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    // Only ZTE's firmware carries the zwrt_web object; any other ubus answers it with an error
    await new Rpc(http).call("zwrt_web", "web_language_get");
    return true;
  },

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    const info = await new Rpc(http).call("zwrt_web", "web_login_info");
    return { occupied: false, locked: lockOf(info) };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const rpc = new Rpc(http);
    const salt = textOf((await rpc.call("zwrt_web", "web_login_info"))["zte_web_sault"]);
    if (salt === null) throw new DriverLoginMethodError("the router handed out no login salt");
    const answer = await rpc.call("zwrt_web", "web_login", { password: zwrtLoginPassword(credentials.password, salt) });
    const result = intOf(answer["result"]);
    const session = textOf(answer["ubus_rpc_session"]);
    if (result === 0 && session !== null && SESSION_ID.test(session) && session !== ZWRT_ANONYMOUS) {
      rpc.session = session;
      return new ZwrtSession(rpc);
    }
    const lock = lockOf(answer);
    if (lock) throw loginLocked("the router has locked its login", lock.waitSec);
    const left = intOf(answer["login_fail_num"]);
    if (result !== null && result !== 0 && left !== null) throw wrongPassword("the router refused the password", left);
    throw loginUnplaced(`login answered ${result === null ? "no result" : String(result)}`);
  },
};
