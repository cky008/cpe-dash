import type { NetworkMode } from "../cellular.ts";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import type { SmsCounters, SmsWireMessage } from "../sms/types.ts";
import { bandsToHex, checkCellLock, checkLockBands, hexToBands } from "./bands.ts";
import { neighbourOf, servingModeOf } from "./cells.ts";
import type { DriverCredentials, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, sha256Hex, wrongPassword } from "./login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleSetting, settleUnlock } from "./readback.ts";
import { dateOfParts, wireMessage } from "./sms.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import type { LanHttp } from "./transport.ts";
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
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
} from "./types.ts";
import {
  arfcnOf,
  bandOf,
  fieldOf,
  identityOf,
  intOf,
  isPlainObject,
  labelOf,
  megabytesToBytes,
  mhzOf,
  numberOf,
  operatorOfPlmn,
  pciOf,
  plmnCodeOf,
  rowsOf,
  rsrpOf,
  rsrqOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
} from "./values.ts";

/**
 * Tozed / ZLT routers (China Unicom VN007, ZLT X21, X28, S10G…): every call is a `POST` of JSON
 * `{cmd, method, language, sessionId, ...}` to `/cgi-bin/http.cgi`. The login takes a one-time
 * token (`cmd 232`) and sends SHA-256 of token + password (`cmd 100`), which returns the session id
 * later calls carry. Readings: `205` signal and traffic, `207` board and temperature, `282` nearby
 * cells; settings: `218` network mode, `161` band masks (bare lowercase hexadecimal), `160` cell
 * locks. Every write carries the token `233` hands out right before it, as the router's page sends
 * it. The answers some operator builds wrap in AES are not supported (no documented key).
 *
 * SMS: `12` lists a box page by page (`subcmd` 0 the inbox, 1 the sent box) as comma-separated
 * Base64 entries, each `index read-flag number date time text`; `13` sends, with the text as Base64
 * and the write token `233` hands out. No command to mark a message read or to delete one is on
 * record, so FengSui keeps the read state itself and offers no delete here.
 */

const FAMILY = "tozed" as const;
const PATH = "/cgi-bin/http.cgi";
/** The session id the login request itself carries, as the router's page sends it. */
export const TOZED_LOGIN_SESSION = "b854a90669ca1d59e59931d6bca2f02f86e0be95000f2013e5858f16c8df19d4";
const SESSION_ID = /^[0-9A-Fa-f]{16,128}$/;

export function tozedLoginPassword(token: string, password: string): string {
  return sha256Hex(`${token}${password}`);
}

async function call(http: LanHttp, sessionId: string, cmd: number, method: "GET" | "POST", params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = await http.postJson(PATH, { cmd, method, ...params, language: "CN", sessionId }, { referer: "/" });
  if (!isPlainObject(answer)) throw new CpeAnswerFormatError(`cmd ${cmd}: not an object`);
  return answer;
}

function requireSuccess(answer: Record<string, unknown>, cmd: number): void {
  if (fieldOf(answer, "success") !== true) throw new CpeApiError(`cmd${cmd}`, `cmd ${cmd} refused`);
}

/** The boxes `cmd 12` lists by `subcmd`. */
const SMS_INBOX = 0;
const SMS_SENT = 1;
/** Sent messages get handles of their own range: each box numbers its messages from the start. */
const SMS_SENT_HANDLE_BASE = 1_000_000;
const SMS_MAX_PAGES = 10;

/**
 * One box page of `cmd 12` (`sms_list`: comma-separated Base64, each `index read-flag number date
 * time text`, the read flag `1` once read) as stored messages. An entry that is not that is left out.
 */
export function parseTozedSmsPage(smsList: unknown, box: typeof SMS_INBOX | typeof SMS_SENT): SmsWireMessage[] {
  if (typeof smsList !== "string" || smsList === "") return [];
  const out: SmsWireMessage[] = [];
  for (const entry of smsList.split(",").slice(0, 500)) {
    const encoded = entry.trim();
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
    const parts = Buffer.from(encoded, "base64").toString("utf8").split(" ");
    if (parts.length < 5 || !/^\d{1,6}$/.test(parts[0] ?? "")) continue;
    const index = Number.parseInt(parts[0] ?? "", 10);
    out.push(
      wireMessage({
        // Above zero, and apart from the other box's
        index: index + 1 + (box === SMS_SENT ? SMS_SENT_HANDLE_BASE : 0),
        phone: parts[2] ?? "",
        date: dateOfParts(`${parts[3] ?? ""} ${parts[4] ?? ""}`.split(/[-/.:\s]+/)),
        unread: parts[1] !== "1",
        outgoing: box === SMS_SENT,
        content: parts.slice(5).join(" "),
      })
    );
  }
  return out;
}

const MODES: Readonly<Record<DriverNetworkMode, { networkMode: string; mode5g: string }>> = {
  auto: { networkMode: "131", mode5g: "1" },
  nr_sa: { networkMode: "128", mode5g: "1" },
  nr_nsa: { networkMode: "131", mode5g: "0" },
  lte: { networkMode: "3", mode5g: "0" },
};

/** Every pair of the notes' mode table (library A §4.1): the four above, and 3G only. */
const CELLULAR_MODES: Readonly<Partial<Record<NetworkMode, { networkMode: string; mode5g: string }>>> = { ...MODES, wcdma: { networkMode: "11", mode5g: "0" } };

/** The mode `cmd 218` reports, as the network mode setting names it (`null`: a pair the notes do not list). */
export function tozedModeOf(answer: Record<string, unknown>): NetworkMode | null {
  const nm = textOf(answer["networkMode"]);
  const m5 = textOf(answer["mode5g"]);
  return (Object.entries(CELLULAR_MODES) as Array<[NetworkMode, { networkMode: string; mode5g: string }]>).find(([, v]) => v.networkMode === nm && v.mode5g === m5)?.[0] ?? null;
}

function modeOf(answer: Record<string, unknown>): DriverNetworkMode | null {
  const nm = textOf(answer["networkMode"]);
  const m5 = textOf(answer["mode5g"]);
  return (Object.entries(MODES) as Array<[DriverNetworkMode, { networkMode: string; mode5g: string }]>).find(([, v]) => v.networkMode === nm && v.mode5g === m5)?.[0] ?? null;
}

/** A temperature in m°C (`"54200"`) or °C (`"54"`). */
function boardTemperature(value: unknown): number | null {
  const n = numberOf(value);
  if (n === null) return null;
  return temperatureOf(Math.abs(n) >= 1000 ? n / 1000 : n);
}

function servingMode(text: unknown, nrRsrp: number | null): DriverTelemetry["mode"] {
  const raw = textOf(text)?.toUpperCase() ?? "";
  if (raw.includes("5G(SA)") || (raw.includes("5G") && raw.includes("SA") && !raw.includes("NSA"))) return "SA";
  // A 5G reading outside standalone is the NR leg of EN-DC
  if (raw.includes("5G") || nrRsrp !== null) return "NSA";
  return servingModeOf(raw);
}

/** `cmd 205` (signal, traffic) and `cmd 207` (board, temperature) in FengSui's shape. */
export function parseTozedTelemetry(signal: Record<string, unknown>, board: Record<string, unknown> | null): DriverTelemetry {
  const v = (key: string): unknown => signal[key];
  const nrRsrp = rsrpOf(v("RSRP_5G"));
  const mode = servingMode(v("network_type_str"), nrRsrp);
  const lte: DriverCell = {
    ...emptyCell(),
    band: bandOf(v("currentband")),
    arfcn: arfcnOf(v("FREQ"), "LTE"),
    pci: pciOf(v("PCI"), "LTE"),
    cellId: identityOf(v("CELL_ID"), 16),
    rsrpDbm: rsrpOf(v("RSRP")),
    rsrqDb: rsrqOf(v("RSRQ")),
    sinrDb: sinrOf(v("SINR")),
    bandwidthMhz: mhzOf(v("bandwidth")),
    cqi: smallIntOf(v("CQI"), 15),
    dlMcs: smallIntOf(v("dl_mcs"), 31),
    ulMcs: smallIntOf(v("ul_mcs"), 31),
    mimoLayers: smallIntOf(v("rank_4g"), 8),
  };
  const nr: DriverCell = {
    ...emptyCell(),
    band: bandOf(v("currentband_5g")),
    arfcn: arfcnOf(v("FREQ_5G"), "NR"),
    pci: pciOf(v("PCI_5G"), "NR"),
    cellId: identityOf(v("CELL_ID_5G"), 16),
    rsrpDbm: nrRsrp,
    rsrqDb: rsrqOf(v("RSRQ_5G")),
    sinrDb: sinrOf(v("SINR_5G")),
    bandwidthMhz: mhzOf(v("bandwidth_5g")),
    cqi: smallIntOf(v("CQI_5G"), 15),
    dlMcs: smallIntOf(v("dl_mcs_5g"), 31),
    ulMcs: smallIntOf(v("ul_mcs_5g"), 31),
    mimoLayers: smallIntOf(v("rank_5g"), 8),
  };
  const sessionDown = megabytesToBytes(v("flow_dl"));
  const sessionUp = megabytesToBytes(v("flow_ul"));
  const plmn = plmnCodeOf(v("network_operator"));
  return {
    model: board ? labelOf(board["board_type"]) : null,
    softwareVersion: board ? labelOf(board["real_fwversion"]) : null,
    hardwareVersion: null,
    // The router names the PLMN only; the notes' table names its operator
    operatorName: operatorOfPlmn(plmn),
    plmn,
    mode,
    lte: cellHasData(lte) && mode !== "SA" ? lte : null,
    nr: cellHasData(nr) && (nrRsrp !== null || mode === "SA") ? nr : null,
    carriers: [],
    wan: { connected: null, ipv4: null, ipv6: null, uptimeSec: null },
    traffic: {
      downloadBytesPerSec: null,
      uploadBytesPerSec: null,
      // The session's counters, in MB: the polls derive the rate from them
      totalDownloadBytes: sessionDown,
      totalUploadBytes: sessionUp,
      sessionDownloadBytes: sessionDown,
      sessionUploadBytes: sessionUp,
      sessionSeconds: null,
      monthDownloadBytes: null,
      monthUploadBytes: null,
      monthTotalBytes: megabytesToBytes(v("mon_total_flow")),
      monthSeconds: null,
    },
    temperatureC: board ? (boardTemperature(board["apcpu0-thmzone"]) ?? boardTemperature(board["apcpu0_thmzone"])) : null,
    signalBars: smallIntOf(v("signal_lvl"), 5),
  };
}

/** `cmd 282`: `earfcn,pci,rsrp,rsrq,rssi;` (LTE) and `arfcn,pci,rsrp,rsrq,sinr;` (NR). */
export function parseTozedNeighbours(answer: Record<string, unknown>): DriverNeighbour[] {
  const out: DriverNeighbour[] = [];
  for (const row of rowsOf(answer["lte_info"])) {
    const cell = row.length >= 5 ? neighbourOf("LTE", { arfcn: row[0], pci: row[1], rsrp: row[2], rsrq: row[3], rssi: row[4] }, 10) : null;
    if (cell) out.push(cell);
  }
  for (const row of rowsOf(answer["nr_info"])) {
    const cell = row.length >= 5 ? neighbourOf("NR", { arfcn: row[0], pci: row[1], rsrp: row[2], rsrq: row[3], sinr: row[4] }, 10) : null;
    if (cell) out.push(cell);
  }
  return out;
}

function maskOf(sw: unknown, mask: unknown): number[] | "all" | null {
  const on = textOf(sw);
  if (on === "0") return "all";
  if (on !== "1") return null;
  const bands = hexToBands(textOf(mask));
  return bands && bands.length > 0 ? bands : null;
}

function cellOf(sw: unknown, freq: unknown, pci: unknown, rat: "LTE" | "NR"): CellLockState | null {
  const on = textOf(sw);
  if (on === "0") return { locked: false };
  if (on !== "1") return null;
  return { locked: true, arfcn: intOf(freq), pci: pciOf(pci, rat), band: null };
}

export function parseTozedLockState(bands: Record<string, unknown>, cells: Record<string, unknown>, mode: Record<string, unknown>): DriverLockState {
  const supportedLte = hexToBands(textOf(bands["all_band_4g"]));
  const supportedNr = hexToBands(textOf(bands["all_band_5g"]));
  return {
    lteBands: maskOf(bands["band_4g_switch"], bands["band_4g_mask"]),
    nrBands: maskOf(bands["band_5g_switch"], bands["band_5g_mask"]),
    lteCell: cellOf(cells["lte_lock_sw"], cells["lte_lock_freq"], cells["lte_lock_pci"], "LTE"),
    nrCell: cellOf(cells["nr_lock_sw"], cells["nr_lock_freq"], cells["nr_lock_pci"], "NR"),
    networkMode: modeOf(mode),
    supportedLte: supportedLte && supportedLte.length > 0 ? supportedLte : null,
    supportedNr: supportedNr && supportedNr.length > 0 ? supportedNr : null,
  };
}

class TozedSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #sid: string;
  #board: Record<string, unknown> | null = null;
  #open = true;

  constructor(http: LanHttp, sid: string) {
    this.#http = http;
    this.#sid = sid;
  }

  get open(): boolean {
    return this.#open;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  async #get(cmd: number): Promise<Record<string, unknown>> {
    this.#guard();
    const answer = await call(this.#http, this.#sid, cmd, "GET");
    requireSuccess(answer, cmd);
    return answer;
  }

  async #boardInfo(): Promise<Record<string, unknown> | null> {
    this.#board ??= await this.#get(207).catch(() => null);
    return this.#board;
  }

  async identify(): Promise<DriverIdentity> {
    const board = await this.#boardInfo();
    return { model: board ? labelOf(board["board_type"]) : null, softwareVersion: board ? labelOf(board["real_fwversion"]) : null, hardwareVersion: null };
  }

  async telemetry(): Promise<DriverTelemetry> {
    const signal = await this.#get(205);
    return parseTozedTelemetry(signal, await this.#boardInfo());
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    return parseTozedNeighbours(await this.#get(282));
  }

  async lockState(): Promise<DriverLockState> {
    return parseTozedLockState(await this.#get(161), await this.#get(160), await this.#get(218));
  }

  /**
   * The token a write carries: the router's page asks `cmd 233` for a fresh one before each write
   * and sends it as `token`. A firmware that hands none out is sent an empty one, as its page would.
   */
  async #writeToken(): Promise<string> {
    this.#guard();
    return textOf((await call(this.#http, this.#sid, 233, "GET").catch((): Record<string, unknown> => ({})))["token"]) ?? "";
  }

  async #post(check: WriteCheck, cmd: number, params: Record<string, unknown>): Promise<void> {
    const token = await this.#writeToken();
    noteSent(check, FAMILY, params["subcmd"] === undefined ? `cmd${cmd}` : `cmd${cmd}.${String(params["subcmd"])}`);
    requireSuccess(await call(this.#http, this.#sid, cmd, "POST", { token, ...params }), cmd);
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, before.supportedLte);
    const nr = target.nr === null ? before.nrBands : target.nr === "all" ? "all" : checkLockBands("NR", target.nr, before.supportedNr);
    if (nr === null) throw new CpeControlValidationError("The router did not say which NR bands are locked: choose the NR bands too");
    await this.#post(check, 161, {
      band5gRadio: nr === "all" ? "0" : "1",
      band4gRadio: lte === "all" ? "0" : "1",
      lock5gBand: nr === "all" ? "" : bandsToHex(nr),
      lock4gBand: lte === "all" ? "" : bandsToHex(lte),
    });
    if (target.networkMode !== null) await this.#post(check, 218, { ...MODES[target.networkMode] });
    settleBandLock(check, { lte, nr: target.nr === null ? null : nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  /** The network mode as a setting of its own: `cmd 218` with the pair of the notes' table, read back with the same command. */
  readonly cellular: DriverCellular = {
    read: async () => ({ networkMode: tozedModeOf(await this.#get(218)) }),
    setNetworkMode: async (mode, check) => {
      const pair = CELLULAR_MODES[mode];
      if (pair === undefined) throw new CpeControlValidationError(`This router has no "${mode}" network mode`);
      await this.#post(check, 218, { ...pair });
      const after = await this.#get(218).catch(() => null);
      settleSetting(check, after === null ? null : tozedModeOf(after) === mode);
    },
  };

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const t = checkCellLock(target);
    if (t.rat === "LTE") await this.#post(check, 160, { lte_lock_sw: "1", lte_lock_freq: String(t.arfcn), lte_lock_pci: String(t.pci), subcmd: 0 });
    else await this.#post(check, 160, { nr_lock_sw: "1", nr_lock_freq: String(t.arfcn), nr_lock_pci: String(t.pci), subcmd: 1 });
    settleCellLock(check, t, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    if (before.lteBands !== "all" || before.nrBands !== "all") await this.#post(check, 161, { band5gRadio: "0", band4gRadio: "0", lock5gBand: "", lock4gBand: "" });
    if (before.lteCell?.locked !== false) await this.#post(check, 160, { lte_lock_sw: "0", lte_lock_freq: "", lte_lock_pci: "", subcmd: 0 });
    if (before.nrCell?.locked !== false) await this.#post(check, 160, { nr_lock_sw: "0", nr_lock_freq: "", nr_lock_pci: "", subcmd: 1 });
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#post(check, 218, { ...MODES.auto });
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  /**
   * SMS as the router's own page reads and sends it. Its interface has no command on record to mark
   * a message read or to delete one: FengSui keeps the read state, and offers no delete.
   */
  readonly sms: DriverSms = {
    keepsSent: true,
    list: () => this.#smsList(),
    counters: () => this.#smsCounters(),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
  };

  async #smsPage(box: typeof SMS_INBOX | typeof SMS_SENT, page: number): Promise<SmsWireMessage[]> {
    this.#guard();
    const answer = await call(this.#http, this.#sid, 12, "GET", { page_num: page, subcmd: box });
    // A firmware without the SMS page answers the command without a list
    if (fieldOf(answer, "success") !== true || typeof answer["sms_list"] !== "string") throw new SectionUnavailableError("SMS", null);
    return parseTozedSmsPage(answer["sms_list"], box);
  }

  async #smsList(): Promise<SmsWireMessage[]> {
    const seen = new Map<number, SmsWireMessage>();
    for (const box of [SMS_INBOX, SMS_SENT] as const) {
      for (let page = 1; page <= SMS_MAX_PAGES; page++) {
        const before = seen.size;
        for (const message of await this.#smsPage(box, page)) seen.set(message.index, message);
        // An empty page, or one that brought nothing new (a firmware that lists everything at once), is the last
        if (seen.size === before) break;
      }
    }
    return [...seen.values()];
  }

  /**
   * The inbox's first page, the same one read on every poll and after every listing: how many
   * messages it holds, and the newest handle on it, so that a new message shows even when the page
   * is full. No unread count: the router's never goes down (nothing can tell it a message was read).
   */
  async #smsCounters(): Promise<SmsCounters> {
    const page = await this.#smsPage(SMS_INBOX, 1);
    return { localUnread: 0, localInbox: page.length, localOutbox: 0, localDraft: 0, localMax: 0, newest: page.reduce((max, m) => Math.max(max, m.index), 0) };
  }

  /** `cmd 13` with the write token of `cmd 233`: the router answers whether the message went out (`message` `0`). */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    const token = await this.#writeToken();
    noteSent(check, FAMILY, "cmd13");
    const answer = await call(this.#http, this.#sid, 13, "POST", { token, phoneNo: phone, content: Buffer.from(content, "utf8").toString("base64") });
    requireSuccess(answer, 13);
    options.onAccepted();
    const verdict = textOf(answer["message"]);
    if (verdict === "0") return { state: "sent", code: null };
    return verdict === null ? { state: "unconfirmed", code: null } : { state: "failed", code: /^\d{1,6}$/.test(verdict) ? `sms-${verdict}` : null };
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#post(check, 6, {});
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await call(this.#http, this.#sid, 101, "POST");
  }
}

export const tozedProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    return textOf((await call(http, "", 232, "GET"))["token"]) !== null;
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const challenge = await call(http, "", 232, "GET");
    const token = textOf(challenge["token"]);
    if (token === null) throw new DriverLoginMethodError("the router handed out no login token");
    const answer = await call(http, TOZED_LOGIN_SESSION, 100, "POST", { username: credentials.username || "admin", passwd: tozedLoginPassword(token, credentials.password), isAutoUpgrade: "0" });
    const sid = textOf(answer["sessionId"]);
    if (sid !== null && SESSION_ID.test(sid) && sid !== TOZED_LOGIN_SESSION) return new TozedSession(http, sid);
    // Exact matches: "login_fail" is a prefix of "login_fail2"
    const res = textOf(answer["res"]);
    if (res === "login_fail2") throw loginLocked("the router has locked its login", intOf(answer["login_time"]));
    if (res === "login_fail") throw wrongPassword("the router refused the user name or password");
    throw loginUnplaced(`login answered ${res ?? "no session"}`);
  },
};
