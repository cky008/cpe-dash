import crypto from "node:crypto";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import { CpeControlValidationError } from "../control-error.ts";
import type { WriteCheck } from "../device-access.ts";
import { detectSmsTextMode } from "../sms/text-mode.ts";
import type { SmsCounters, SmsWireMessage } from "../sms/types.ts";
import { bandsToList, checkCellLock, checkLockBands, hexToBands, listToBands } from "./bands.ts";
import { carriersFromRows, servingModeOf } from "./cells.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, sha256Hex, wrongPassword } from "./login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleUnlock } from "./readback.ts";
import { ZTE_SMS_CMD_DELETE, ZTE_SMS_CMD_SEND, awaitZteCommand, parseZteSmsRows, settleSmsListing, storedIndices, textOfUcs2Hex, ucs2Hex, zteIdList, zteSmsCounters, zteSmsTime } from "./sms.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import type { LanHttp } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCell,
  DriverCellLockTarget,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
} from "./types.ts";
import {
  arfcnOf,
  bandOf,
  counterOf,
  fieldOf,
  identityOf,
  intOf,
  ipv4Of,
  ipv6Of,
  isPlainObject,
  labelOf,
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
} from "./values.ts";

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
export const ZWRT_ANONYMOUS = "00000000000000000000000000000000";
const SESSION_ID = /^[0-9A-Za-z]{16,64}$/;

/** `UBUS_STATUS_*` codes, as a router error code. */
function ubusCode(status: number): string {
  return `ubus-${status}`;
}

class Rpc {
  readonly #http: LanHttp;
  #id = 1;
  session = ZWRT_ANONYMOUS;

  constructor(http: LanHttp) {
    this.#http = http;
  }

  /** One call; resolves the payload of `[0, payload]` (an empty object for `[0]`). */
  async call(object: string, method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.#id++;
    const answer = await this.#http.postJson(PATH, { jsonrpc: "2.0", id, method: "call", params: [this.session, object, method, args] }, { query: [["t", String(Date.now())]], referer: "/" });
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError(`${object}.${method}: not an object`);
    const error = fieldOf(answer, "error");
    if (isPlainObject(error)) throw new CpeApiError(`rpc${intOf(fieldOf(error, "code")) ?? ""}`, `${object}.${method} refused`);
    const result = fieldOf(answer, "result");
    if (!Array.isArray(result) || typeof result[0] !== "number") throw new CpeAnswerFormatError(`${object}.${method}: no result`);
    if (result[0] !== 0) throw new CpeApiError(ubusCode(result[0]), `${object}.${method} refused`);
    const payload: unknown = result[1];
    return isPlainObject(payload) ? payload : {};
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
    const device = await this.#rpc.call("zwrt_mc.device.manager", "get_device_info", { deviceInfoList: "bat_temperature" }).catch(() => null);
    return parseZwrtTelemetry({ info, netinfo, traffic, device });
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
