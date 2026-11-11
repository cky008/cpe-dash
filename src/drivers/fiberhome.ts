import crypto from "node:crypto";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import type { WriteCheck } from "../device-access.ts";
import type { SmsWireMessage } from "../sms/types.ts";
import { bandsToList, checkCellLock, checkLockBands, listToBands } from "./bands.ts";
import { neighbourOf, ratOfChannel } from "./cells.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverSessionClosedError, loginLocked, loginUnplaced, signedInElsewhere, wrongPassword } from "./login.ts";
import { noteSent, settleBandLock, settleCellLock, settleRestart, settleUnlock } from "./readback.ts";
import { countListed, dateOfParts, settleSmsListing, storedIndices, wireMessage } from "./sms.ts";
import { cellHasData, emptyCell } from "./snapshot.ts";
import { type LanHttp, jsonAnswer, parseJsonText } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCell,
  DriverCellLockTarget,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverRat,
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
  isPlainObject,
  labelOf,
  mhzOf,
  nonNegativeOf,
  numberOf,
  pciOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
} from "./values.ts";

/**
 * FiberHome routers (LG6121F, LG6151M and the FH5G family): JSON calls `{dataObj, ajaxmethod,
 * sessionid}` to `/api/tmp/FHTOOLAPIS`, each with a fresh `sessionid` from `FHNCAPIS` and the page
 * the router expects as `Referer` (`/login.html` for the login calls, `/main.html` for the others,
 * `/html/content.html` for GETs). `app_get_base_info` reads everything at once: the serving cell is
 * element 0 of the `*_NBR` lists, nearby cells the rest. A band lock and a cell lock cannot both be
 * on: a write that would leave both is refused. The LG6151M locks cells through a list of its own.
 *
 * SMS is on the web page's own endpoint, `/api/tmp/FHAPIS`, whose requests and answers are AES-128-CBC
 * (the key is the first 16 characters of the request's `sessionid`, the IV fixed, hexadecimal on the
 * wire): `get_sms_data` lists conversations with their messages, `set_value_by_xmlnode` marks a
 * received message opened, `send_msg` sends, `sms_del_session` deletes a whole conversation. It is
 * asked in the session this driver's login opened; a router that wants its web login for it answers
 * nothing FengSui can read, and SMS then counts as not on that router (no second password goes out).
 */

const FAMILY = "fiberhome" as const;
const TOOL = "/api/tmp/FHTOOLAPIS";
const NC = "/api/tmp/FHNCAPIS";
const GET_REFERER = "/html/content.html";

const MODES: Readonly<Record<DriverNetworkMode, { networkMode: string; ENDC: string }>> = {
  auto: { networkMode: "3", ENDC: "3" },
  nr_sa: { networkMode: "2", ENDC: "1" },
  nr_nsa: { networkMode: "3", ENDC: "2" },
  lte: { networkMode: "0", ENDC: "1" },
};

const WEB = "/api/tmp/FHAPIS";
/** The IV the router's page uses for every message: the bytes 112 to 127. */
const WEB_IV = Buffer.from(Array.from({ length: 16 }, (_, i) => 112 + i));

function webKey(sessionid: string): Buffer {
  return Buffer.from(sessionid.slice(0, 16), "utf8");
}

/** A request body for `FHAPIS`: the JSON as AES-128-CBC under the session id's first 16 characters, in hexadecimal. */
export function fiberhomeEncrypt(plain: string, sessionid: string): string {
  const cipher = crypto.createCipheriv("aes-128-cbc", webKey(sessionid), WEB_IV);
  return Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("hex");
}

/** An answer of `FHAPIS`; `null` when it is not such a message under this session id. */
export function fiberhomeDecrypt(hex: string, sessionid: string): string | null {
  const clean = hex.trim();
  if (clean.length === 0 || clean.length % 32 !== 0 || !/^[0-9A-Fa-f]+$/.test(clean) || sessionid.length < 16) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", webKey(sessionid), WEB_IV);
    return Buffer.concat([decipher.update(Buffer.from(clean, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Sent messages get handles of their own range: received and sent messages are numbered apart. */
const SMS_SENT_HANDLE_BASE = 1_000_000;

/** A conversation of `get_sms_data` with its messages. */
export interface FiberhomeConversation {
  phone: string;
  messages: SmsWireMessage[];
}

/**
 * `get_sms_data`: an object of conversations, each with `session_phone` and one object per message
 * (`msg_content`, `time`, `childnode` its number, `isOpened`, `rcvorsend`). A message's handle is its
 * number plus one (plus a million when sent), so none is zero and the two kinds stay apart.
 */
export function parseFiberhomeSms(answer: unknown): FiberhomeConversation[] {
  if (!isPlainObject(answer)) return [];
  const out: FiberhomeConversation[] = [];
  for (const conversation of Object.values(answer).slice(0, 500)) {
    if (!isPlainObject(conversation)) continue;
    const phone = typeof conversation["session_phone"] === "string" ? conversation["session_phone"] : "";
    const messages: SmsWireMessage[] = [];
    for (const message of Object.values(conversation).slice(0, 2000)) {
      if (!isPlainObject(message) || typeof message["msg_content"] !== "string") continue;
      const number = intOf(message["childnode"]);
      if (number === null || number < 0) continue;
      const outgoing = textOf(message["rcvorsend"]) === "send";
      messages.push(
        wireMessage({
          index: number + 1 + (outgoing ? SMS_SENT_HANDLE_BASE : 0),
          phone,
          content: message["msg_content"],
          date: dateOfParts((textOf(message["time"]) ?? "").split(/[-/.:\sT]+/)),
          unread: textOf(message["isOpened"]) === "0",
          outgoing,
        })
      );
    }
    if (messages.length > 0) out.push({ phone, messages });
  }
  return out;
}

/**
 * What a send may carry on this router. Its firmware hands the text to a command line between double
 * quotes, so the characters a shell acts on there are refused, and only printable ASCII is sent (the
 * one encoding on record for the call is 8-bit). The check is FengSui's: the router makes none.
 */
export function checkFiberhomeSmsText(content: string): void {
  if (!/^[\x20-\x7e]+$/.test(content)) {
    throw new CpeControlValidationError("This router's SMS interface is on record for plain English text only (letters, digits and common punctuation): nothing was sent");
  }
  if (/[`$"\\]/.test(content)) {
    throw new CpeControlValidationError("This router passes an SMS to a command line, so FengSui does not send text with a backquote, a dollar sign, a double quote or a backslash to it: nothing was sent");
  }
}

/** A conversation's sender as the delete command may be handed it (the router puts it into a command line as well). */
const SAFE_SENDER = /^[0-9A-Za-z+_.-]{1,32}$/;

async function freshSession(http: LanHttp): Promise<string> {
  const answer = await http.getJson(NC, { query: [["ajaxmethod", "get_refresh_sessionid"]], referer: GET_REFERER });
  const sid = textOf(fieldOf(answer, "sessionid"));
  if (sid === null || !/^[0-9A-Za-z]{8,128}$/.test(sid)) throw new CpeAnswerFormatError("get_refresh_sessionid: no session id");
  return sid;
}

/** One call, with a fresh `sessionid` and the page the router expects for it. */
async function tool(http: LanHttp, method: string, dataObj: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  const sessionid = await freshSession(http);
  const res = await http.request({
    method: "POST",
    path: TOOL,
    body: JSON.stringify({ dataObj, ajaxmethod: method, sessionid }),
    contentType: "application/json; charset=UTF-8",
    referer: method.toLowerCase().includes("login") ? "/login.html" : "/main.html",
  });
  if (res.text.includes("timeout")) throw new CpeApiError("timeout", `${method}: the router ended the session`);
  const parsed = jsonAnswer(res, method);
  if (!isPlainObject(parsed)) throw new CpeAnswerFormatError(`${method}: not an object`);
  return parsed;
}

/**
 * One call of the web page's endpoint: the request and its answer encrypted under a fresh
 * `sessionid`. An answer that is not such a message (a router that wants another login for this
 * endpoint, a firmware without it) is one FengSui cannot read.
 */
async function web(http: LanHttp, method: string, dataObj: Record<string, unknown> | null): Promise<unknown> {
  const sessionid = await freshSession(http);
  const res = await http.request({
    method: "POST",
    path: WEB,
    body: fiberhomeEncrypt(JSON.stringify({ dataObj, ajaxmethod: method, sessionid }), sessionid),
    contentType: "application/json",
    referer: "/main.html",
  });
  if (res.status < 200 || res.status >= 300) throw new CpeAnswerFormatError(`${method}: HTTP ${res.status}`);
  const plain = fiberhomeDecrypt(res.text, sessionid);
  if (plain === null) throw new CpeAnswerFormatError(`${method}: not an answer of this session`);
  return plain.trim() === "" ? {} : parseJsonText(plain, method);
}

function nbrList(raw: Record<string, unknown>, key: string): string[] {
  return (textOf(raw[key]) ?? "").split(",").slice(0, 64).map((s) => s.trim());
}

/** SINR with the router's "no value" readings (−30, −20 dB) left out. */
function fiberSinr(value: unknown): number | null {
  const text = textOf(value);
  return text === "-30" || text === "-20" ? null : sinrOf(value);
}

/** A cell identity with `PLMN`, `:` and blanks removed and the operator's PLMN in front cut off. */
export function cellGlobalId(value: unknown, plmn: string | null): string | null {
  let text = (textOf(value) ?? "").replace(/PLMN|:|\s+/g, "");
  if (plmn !== null && text.startsWith(plmn) && text.length > plmn.length) text = text.slice(plmn.length);
  return identityOf(text, "auto");
}

export function parseFiberhomeTelemetry(raw: Record<string, unknown>): { telemetry: DriverTelemetry; neighbours: DriverNeighbour[] } {
  const work = textOf(raw["WorkMode"])?.toUpperCase() ?? null;
  const mode = work === "SA" ? "SA" : work === "NSA" ? "NSA" : work === "LTE" ? "LTE" : null;
  const plmn = textOf(raw["PLMN"]);
  const bands = nbrList(raw, "BAND_NBR");
  const freqs = nbrList(raw, "EARFCN_NBR");
  const pcis = nbrList(raw, "PCI_NBR");
  const rsrps = nbrList(raw, "RSRP_NBR");
  const rsrqs = nbrList(raw, "RSRQ_NBR");
  const sinrs = nbrList(raw, "SINR_NBR");
  const nrBand = bandOf(raw["NR_Band"]);
  // Element 0 is the serving cell; under EN-DC the NR leg is the first later element on the NR band
  const nrLeg = mode === "NSA" ? bands.findIndex((b, i) => i > 0 && bandOf(b) === nrBand && ratOfChannel(arfcnOf(freqs[i], "NR")) === "NR") : -1;
  const primary: Pick<DriverCell, "bandwidthMhz" | "dlMcs" | "ulMcs" | "cqi" | "mimoLayers"> = {
    bandwidthMhz: mhzOf(raw["DlBandWidth"]),
    dlMcs: smallIntOf(raw["DlMCS"], 31),
    ulMcs: smallIntOf(raw["UlMCS"], 31),
    cqi: smallIntOf(raw["CQI"], 15),
    mimoLayers: smallIntOf(raw["DlMimo"], 8),
  };
  let lte: DriverCell | null = null;
  let nr: DriverCell | null = null;
  if (mode === "LTE" || mode === "NSA") {
    lte = {
      ...emptyCell(),
      ...primary,
      band: bandOf(raw["BAND"]),
      arfcn: arfcnOf(freqs[0], "LTE"),
      pci: pciOf(pcis[0], "LTE"),
      cellId: cellGlobalId(raw["ECGI"], plmn),
      tac: identityOf(raw["TAC"], "auto"),
      rsrpDbm: rsrpOf(raw["RSRP"]),
      rsrqDb: rsrqOf(raw["RSRQ"]),
      sinrDb: fiberSinr(raw["SINR"]),
      rssiDbm: rssiOf(raw["RSSI"]),
    };
  }
  if (mode === "SA" || nrLeg > 0) {
    const i = mode === "SA" ? 0 : nrLeg;
    nr = {
      ...emptyCell(),
      ...(mode === "SA" ? primary : {}),
      band: nrBand,
      arfcn: arfcnOf(freqs[i], "NR"),
      pci: pciOf(pcis[i], "NR"),
      cellId: mode === "SA" ? cellGlobalId(raw["NCGI"], plmn) : null,
      tac: mode === "SA" ? identityOf(raw["TAC"], "auto") : null,
      rsrpDbm: rsrpOf(raw["SSB_RSRP"]),
      rsrqDb: rsrqOf(rsrqs[i]),
      sinrDb: fiberSinr(raw["SSB_SINR"]),
    };
  }
  const neighbours: DriverNeighbour[] = [];
  for (let i = 1; i < freqs.length; i++) {
    if (i === nrLeg) continue;
    const rat: DriverRat | null = mode === "SA" ? "NR" : mode === "LTE" ? "LTE" : ratOfChannel(arfcnOf(freqs[i], "NR"));
    const cell = rat ? neighbourOf(rat, { band: bands[i], arfcn: freqs[i], pci: pcis[i], rsrp: rsrps[i], rsrq: rsrqs[i], sinr: textOf(sinrs[i]) === "-30" || textOf(sinrs[i]) === "-20" ? undefined : sinrs[i] }, 10) : null;
    if (cell) neighbours.push(cell);
  }
  const telemetry: DriverTelemetry = {
    model: labelOf(raw["modelName"]),
    softwareVersion: labelOf(raw["Software_version"]),
    hardwareVersion: null,
    operatorName: null,
    plmn: plmn !== null && /^\d{5,6}$/.test(plmn) ? plmn : null,
    mode,
    lte: lte && cellHasData(lte) ? lte : null,
    nr: nr && cellHasData(nr) ? nr : null,
    carriers: [],
    wan: { connected: null, ipv4: null, ipv6: null, uptimeSec: null },
    traffic: {
      downloadBytesPerSec: nonNegativeOf(raw["RxSpeed"]),
      uploadBytesPerSec: nonNegativeOf(raw["TxSpeed"]),
      totalDownloadBytes: null,
      totalUploadBytes: null,
      sessionDownloadBytes: null,
      sessionUploadBytes: null,
      sessionSeconds: null,
      monthDownloadBytes: counterOf(raw["monthRxBytes"]),
      monthUploadBytes: counterOf(raw["monthTxBytes"]),
      monthTotalBytes: null,
      monthSeconds: null,
    },
    temperatureC: temperatureOf(raw["Temperature"]),
    signalBars: null,
  };
  return { telemetry, neighbours };
}

function bandListOf(value: unknown): number[] | "all" | null {
  if (typeof value !== "string") return null;
  if (value.trim() === "") return "all";
  return listToBands(value);
}

export function parseFiberhomeLockState(bandLock: Record<string, unknown>, cellLock: Record<string, unknown>, network: Record<string, unknown>, listModel: boolean): DriverLockState {
  const enabled = textOf(bandLock["lockBandEnable"]);
  let lteCell: CellLockState | null = null;
  let nrCell: CellLockState | null = null;
  if (listModel) {
    const on = textOf(cellLock["enable"]);
    const first = Array.isArray(cellLock["lock_cell"]) ? cellLock["lock_cell"].find(isPlainObject) : undefined;
    if (on === "0") lteCell = nrCell = { locked: false };
    else if (on === "1" && first) {
      const arfcn = intOf(first["arfcn"]);
      const rat = ratOfChannel(arfcnOf(arfcn, "NR"));
      const locked: CellLockState = { locked: true, arfcn, pci: pciOf(first["pci"], rat ?? "NR"), band: null };
      lteCell = rat === "LTE" ? locked : { locked: false };
      nrCell = rat === "NR" ? locked : { locked: false };
    }
  } else {
    const on = textOf(cellLock["LockCellEnable"]);
    const act = textOf(cellLock["LockAct"]);
    if (on === "0") lteCell = nrCell = { locked: false };
    else if (on === "1" && (act === "1" || act === "2")) {
      const rat = act === "1" ? "LTE" : "NR";
      const locked: CellLockState = { locked: true, arfcn: intOf(cellLock["LockArfcn"]), pci: pciOf(cellLock["LockPci"], rat), band: null };
      lteCell = rat === "LTE" ? locked : { locked: false };
      nrCell = rat === "NR" ? locked : { locked: false };
    }
  }
  const nm = textOf(network["networkMode"]);
  const endc = textOf(network["ENDC"]);
  const networkMode: DriverNetworkMode | null = nm === "0" ? "lte" : nm === "2" ? "nr_sa" : nm === "3" && endc === "2" ? "nr_nsa" : nm === "3" && endc === "3" ? "auto" : null;
  return {
    lteBands: enabled === "0" ? "all" : enabled === "1" ? bandListOf(bandLock["LTELockBAND"]) : null,
    nrBands: enabled === "0" ? "all" : enabled === "1" ? bandListOf(bandLock["NRLockBAND"]) : null,
    lteCell,
    nrCell,
    networkMode,
    supportedLte: null,
    supportedNr: null,
  };
}

class FiberhomeSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  #base: Record<string, unknown> | null = null;
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

  async #baseInfo(): Promise<Record<string, unknown>> {
    this.#guard();
    const answer = await this.#http.getJson(TOOL, { query: [["ajaxmethod", "app_get_base_info"]], referer: GET_REFERER });
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError("app_get_base_info: not an object");
    this.#base = answer;
    return answer;
  }

  /** The LG6151M locks cells through a list; every other model through one cell. */
  async #listModel(): Promise<boolean> {
    const base = this.#base ?? (await this.#baseInfo());
    return textOf(base["modelName"]) === "LG6151M";
  }

  async identify(): Promise<DriverIdentity> {
    const base = this.#base ?? (await this.#baseInfo());
    return { model: labelOf(base["modelName"]), softwareVersion: labelOf(base["Software_version"]), hardwareVersion: null };
  }

  async telemetry(): Promise<DriverTelemetry> {
    return parseFiberhomeTelemetry(await this.#baseInfo()).telemetry;
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    return parseFiberhomeTelemetry(await this.#baseInfo()).neighbours;
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    const listModel = await this.#listModel();
    const bandLock = await tool(this.#http, "app_get_lockband", null);
    const cellLock = await tool(this.#http, listModel ? "app_get_cell_list" : "app_get_lockcell", null);
    const network = await tool(this.#http, "app_get_network_info", null);
    return parseFiberhomeLockState(bandLock, cellLock, network, listModel);
  }

  /** A write; the router answers with a status object whose success it does not mark, so it is read back. */
  async #write(check: WriteCheck, method: string, dataObj: Record<string, unknown>): Promise<void> {
    this.#guard();
    noteSent(check, FAMILY, method);
    await tool(this.#http, method, dataObj);
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    if (before.lteCell?.locked === true || before.nrCell?.locked === true) throw new CpeControlValidationError("This router cannot lock bands while a cell is locked: unlock the cell first");
    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null ? before.nrBands : target.nr === "all" ? "all" : checkLockBands("NR", target.nr, null);
    if (nr === null) throw new CpeControlValidationError("The router did not say which NR bands are locked: choose the NR bands too");
    const none = lte === "all" && nr === "all";
    await this.#write(check, "app_set_lockband", {
      lockBandEnable: none ? "0" : "1",
      LTELockBAND: lte === "all" ? "" : bandsToList(lte, ","),
      NRLockBAND: nr === "all" ? "" : bandsToList(nr, ","),
    });
    if (target.networkMode !== null) await this.#write(check, "app_set_network_info", { ...MODES[target.networkMode] });
    settleBandLock(check, { lte, nr: target.nr === null ? null : nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const t = checkCellLock(target);
    const before = await this.lockState();
    if (before.lteBands !== "all" || before.nrBands !== "all") throw new CpeControlValidationError("This router cannot lock a cell while bands are locked: unlock the bands first");
    if (await this.#listModel()) await this.#write(check, "app_set_cell_list", { enable: "1", lock_cell: [{ arfcn: String(t.arfcn), pci: String(t.pci) }] });
    else await this.#write(check, "app_set_lockcell", { LockCellEnable: "1", LockAct: t.rat === "LTE" ? "1" : "2", LockArfcn: String(t.arfcn), LockPci: String(t.pci) });
    settleCellLock(check, t, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    const before = await this.lockState();
    if (before.lteBands !== "all" || before.nrBands !== "all") await this.#write(check, "app_set_lockband", { lockBandEnable: "0", LTELockBAND: "", NRLockBAND: "" });
    if (await this.#listModel()) {
      if (before.lteCell?.locked !== false || before.nrCell?.locked !== false) await this.#write(check, "app_set_cell_list", { enable: "0", lock_cell: [] });
    } else {
      if (before.lteCell?.locked !== false) await this.#write(check, "app_set_lockcell", { LockCellEnable: "0", LockAct: "1", LockArfcn: "0", LockPci: "" });
      if (before.nrCell?.locked !== false) await this.#write(check, "app_set_lockcell", { LockCellEnable: "0", LockAct: "2", LockArfcn: "0", LockPci: "" });
    }
    const resetMode = before.networkMode !== null && before.networkMode !== "auto";
    if (resetMode) await this.#write(check, "app_set_network_info", { ...MODES.auto });
    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: resetMode });
  }

  /** SMS on the web page's endpoint, in this session. */
  readonly sms: DriverSms = {
    keepsSent: true,
    list: async () => (await this.#smsConversations()).flatMap((c) => c.messages),
    // Counted from the listing, which holds everything: the poll and a sync count the same way
    counters: async (listed) => countListed(listed ?? (await this.#smsConversations()).flatMap((c) => c.messages), 0, { unread: true }),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
    markRead: (indices, check) => this.#smsMarkRead(indices, check),
    delete: (indices, check) => this.#smsDelete(indices, check),
    deleteScope: "conversation",
  };

  async #smsConversations(): Promise<FiberhomeConversation[]> {
    this.#guard();
    const answer = await web(this.#http, "get_sms_data", null);
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError("get_sms_data: not an object");
    return parseFiberhomeSms(answer);
  }

  /**
   * `send_msg`, once. The router says nothing FengSui knows of the outcome, so the listing after it
   * is asked: a sent message to this number with this text that was not there before means it went out.
   */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    checkFiberhomeSmsText(content);
    const same = (m: SmsWireMessage): boolean => m.direction === "out" && m.phone === phone && m.content === content;
    const before = new Set((await this.#smsConversations()).flatMap((c) => c.messages).filter(same).map((m) => m.index));
    this.#guard();
    noteSent(check, FAMILY, "send_msg");
    await web(this.#http, "send_msg", { recv_number: phone, encode_schema: "GSM_8BIT", content });
    options.onAccepted();
    const after = await this.#smsConversations().catch(() => null);
    const stored = after?.flatMap((c) => c.messages).some((m) => same(m) && !before.has(m.index)) === true;
    return { state: stored ? "sent" : "unconfirmed", code: null };
  }

  /** A received message is opened by its node (`SMS_Recv.SMS_RecvMsg.<n>.isOpened`); sent ones have nothing to mark. */
  async #smsMarkRead(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const received = storedIndices(indices).filter((handle) => handle < SMS_SENT_HANDLE_BASE);
    if (received.length === 0) return;
    this.#guard();
    const url: Record<string, string> = {};
    const value: Record<string, string> = {};
    for (const handle of received) {
      const key = `smsIsopend${handle - 1}`;
      url[key] = `InternetGatewayDevice.X_FH_MobileNetwork.SMS_Recv.SMS_RecvMsg.${handle - 1}.isOpened`;
      value[key] = "1";
    }
    noteSent(check, FAMILY, "set_value_by_xmlnode");
    await web(this.#http, "set_value_by_xmlnode", { url, value });
    settleSmsListing(check, await this.#smsConversations().then((list) => list.flatMap((c) => c.messages)).catch(() => null), received, "read");
  }

  /**
   * The router deletes a conversation at a time (`sms_del_session`), so a delete goes out only when
   * it names every message of each conversation it touches; anything less is refused before a write.
   */
  async #smsDelete(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const wanted = new Set(storedIndices(indices));
    const touched = (await this.#smsConversations()).filter((c) => c.messages.some((m) => wanted.has(m.index)));
    // Already gone from the router: nothing to send
    if (touched.length === 0) return;
    if (touched.some((c) => c.messages.some((m) => !wanted.has(m.index)))) {
      throw new CpeControlValidationError("This router deletes a whole conversation at a time: select every message of the conversation to delete it. Nothing was deleted");
    }
    if (touched.some((c) => !SAFE_SENDER.test(c.phone))) {
      throw new CpeControlValidationError("This router's delete names the conversation by its sender on a command line, and this sender's name has characters FengSui does not pass to it. Nothing was deleted");
    }
    this.#guard();
    noteSent(check, FAMILY, "sms_del_session");
    for (const conversation of touched) await web(this.#http, "sms_del_session", { del_phone: conversation.phone });
    settleSmsListing(check, await this.#smsConversations().then((list) => list.flatMap((c) => c.messages)).catch(() => null), [...wanted], "gone");
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#write(check, "app_do_cmd", { key: "REBOOT_WEB" });
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await tool(this.#http, "app_do_logout", null);
  }
}

export const fiberhomeProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    await freshSession(http);
    return true;
  },

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    const status = await tool(http, "app_get_login_status", null);
    const locked = textOf(status["lockstatus"]) === "1";
    return { occupied: textOf(status["login_status"]) === "1", locked: locked ? { waitSec: intOf(status["remaintime"]) } : null };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const answer = await tool(http, "app_do_login", { username: credentials.username || "admin", password: credentials.password });
    const result = textOf(answer["login_result"]);
    if (result === "0") return new FiberhomeSession(http);
    if (result === "1") throw wrongPassword("the router refused the password");
    if (result === "2") {
      const minutes = numberOf(answer["remaintime"]);
      throw loginLocked("the router has locked its login", minutes !== null && minutes >= 0 ? Math.round(minutes * 60) : null);
    }
    if (result === "3") throw signedInElsewhere("another administrator is signed in");
    // The router's policy keeps this administrator out: no other password would get in either
    if (result === "4") throw loginUnplaced("the router forbids this administrator to sign in");
    throw loginUnplaced(`login answered ${result ?? "no result"}`);
  },
};
