import type { ApnChoice, ApnRestore, DataLimitSetting, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, UssdAnswer, UssdRequest } from "../../cellular.ts";
import { CpeControlValidationError } from "../../control-error.ts";
import { type AntennaModeName, SectionUnavailableError } from "../../cpe-domain.ts";
import { type WriteCheck, settleCheck } from "../../device-access.ts";
import type { DriverNeighbour } from "../../protocols/readings.ts";
import { type LanHttp, type LanResponse, parseJsonText } from "../../protocols/transport.ts";
import { USSD_POLLS, USSD_POLL_MS, emptyUssd, ussdText } from "../../protocols/ussd.ts";
import { fieldOf, intOf, labelOf, nonNegativeOf, textOf } from "../../protocols/values.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import type { SmsCounters, SmsWireMessage } from "../../sms/types.ts";
import { checkCellLock, checkLockBands } from "../bands.ts";
import { FENGSUI_APN_PROFILE, sameDataLimit, settleNothingToRead } from "../cellular.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "../client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, wrongPassword } from "../login.ts";
import { awaitConnection, noteSent, settleBandLock, settleCellLock, settleDataSwitch, settleRestart, settleUnlock } from "../readback.ts";
import { settleSmsListing, storedIndices } from "../sms.ts";
import type {
  DriverBandLockTarget,
  DriverCellLockTarget,
  DriverCellular,
  DriverCellularState,
  DriverDataLink,
  DriverHost,
  DriverIdentity,
  DriverLockState,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
  DriverWait,
} from "../types.ts";
import { type MrProfile, maskOfBands, mrApnView, mrLockState, mrModeCode, mrModeOf, mrProfileCreate, mrProfileEdit, mrProfileUse, nxBandList, nxLockState, nxModeOf, nxModes, nxSelection, parseMrOperators, parseMrProfiles, parseNxBands, parseNxOperators, tplinkDataLimit, tplinkSimLock } from "./cellular.ts";
import { TplinkEnvelope, type TplinkPublicKey, type TplinkScheme, usableKey } from "./crypto.ts";
import { decoLogin, decoPasswordKey } from "./deco.ts";
import { type TplinkAction, type TplinkResult, exRequest, instance, instances, mrFrame, parseExAnswer, parseMrAnswer, returnCode, scriptVar } from "./frames.ts";
import { TPLINK_SENT_BASE, type TplinkSms, parseTplinkHosts, parseTplinkSmsPage, parseTplinkTelemetry, tplinkBytes } from "./parts.ts";

/**
 * TP-Link's cellular routers on the interface their own page uses, in its two forms:
 *
 * - the MR series (Archer MR600 and its kin): the login is a request of its own (`/cgi/login`), and
 *   a request (`/cgi_gdpr`) carries several actions as text blocks;
 * - the EX and NX series (Archer NX200, NX510v): the login is an action like every other, and a
 *   request (`/cgi_gdpr?9`) carries one action as JSON.
 *
 * Both follow the same steps: the login page (`GET /`, which shows the lock counters), the router's
 * key (`/cgi/getParm` or `/cgi/getGDPRParm`), whether someone is signed in (`/cgi/getBusy`), the login,
 * then the page again for the token every request carries. Every payload is encrypted
 * (`./crypto.ts`); which cipher and signature a router's firmware uses is read off its key and its own
 * script (`/js/tpEncrypt.js`) before the password is sent, and a combination nobody recorded a login
 * for gets no password.
 *
 * The interface names the signal, the band and, where the firmware has a cell lock, the serving cell
 * (the EX and NX series list their serving cells one by one); it has SMS and USSD, a band selection
 * and a cell lock, and the cellular settings of the page's own "Internet" section (`./cellular.ts`).
 * No nearby cells are on record. What the page offers depends on the firmware: a write whose object
 * the router does not have is refused before anything is sent.
 *
 * The Deco line speaks a third interface of its own (`./deco.ts`), told by the key its login hands out.
 */

const FAMILY = "tplink" as const;
type Dialect = "mr" | "ex";

const ROOT = "/";
const BUSY = "/cgi/getBusy";
const SESSION_COOKIE = "JSESSIONID";
/** The page's own answer for a wrong user name or password. */
const WRONG_PASSWORD = 71233;
/** How many wrong passwords the page counts before it locks. */
const LOGIN_ATTEMPTS = 5;
const TOKEN = /^[A-Za-z0-9]{8,128}$/;
const SMS_PAGE_SIZE = 8;
const SMS_MAX_PAGES = 12;
const SEND_POLL_MS = 1000;
/** The page asks every two seconds whether a search for networks is done; FengSui gives it two minutes. */
const SEARCH_POLL_MS = 2000;
const SEARCH_POLLS = 60;
/** The page keeps this many access point profiles. */
const MAX_PROFILES = 8;
/** How long the page waits before it reads the SIM lock again after a PIN. */
const PIN_SETTLE_MS = 3500;
/** The page's script that names what this firmware was built with. */
const BUILD_FLAGS = "/js/oid_str.js";
const MR_CELL_LOCK = "LTE_CELL_LOCK";
/** The band selection switched off, as the page writes it. */
const MR_BANDS_OFF = { bandSelectSwitch: "0", bandSelectedMaskL: "0", bandSelectedMaskH: "0" } as const;
const NX_BAND_SEARCH = "DEV2_LTE_BAND_SEARCH";
const NX_NETWORK_SEARCH = "DEV2_LTE_NETWORK_SEARCH";
const NX_CELL_LOCKS = { LTE: "DEV2_LTE_4G_CELL_LOCK", NR: "DEV2_LTE_5G_CELL_LOCK" } as const;

interface Objects {
  key: string;
  command: string;
  username: string;
  info: string;
  /** The LTE objects and the instance the page asks for; the attributes each form's page names. */
  link: readonly [string, string];
  linkAttrs: ReadonlyArray<string>;
  intf: readonly [string, string];
  net: readonly [string, string];
  /** The attributes of the status the poll asks for (none: the object whole, as the MR series' own status page asks). */
  netAttrs: ReadonlyArray<string>;
  /** The cellular settings and the SIM lock: instances beside the LTE link. */
  wanCfg: string;
  simLock: string;
  prof: readonly [string, string];
  profAttrs: ReadonlyArray<string>;
  cells: string | null;
  wan: TplinkAction;
  hosts: TplinkAction;
  inbox: { box: string; entry: string; page: string };
  outbox: { box: string; entry: string; page: string } | null;
  send: string;
  ussd: string;
}

const OBJECTS: Readonly<Record<Dialect, Objects>> = {
  mr: {
    key: "/cgi/getParm",
    command: "/cgi_gdpr",
    username: "admin",
    info: "IGD_DEV_INFO",
    link: ["WAN_LTE_LINK_CFG", "2,1,0,0,0,0"],
    linkAttrs: ["enable", "connectStatus", "networkType", "roamingStatus", "simStatus"],
    intf: ["WAN_LTE_INTF_CFG", "2,0,0,0,0,0"],
    net: ["LTE_NET_STATUS", "2,1,0,0,0,0"],
    netAttrs: [],
    wanCfg: "LTE_WAN_CFG",
    simLock: "LTE_SIMLOCK",
    prof: ["LTE_PROF_STAT", "2,1,0,0,0,0"],
    profAttrs: ["spn", "ispName"],
    cells: null,
    wan: { operation: "getSub", oid: "WAN_IP_CONN", attrs: ["enable", "externalIPAddress", "connectionStatus"] },
    hosts: { operation: "list", oid: "LAN_HOST_ENTRY", attrs: ["IPAddress", "MACAddress", "hostName", "X_TP_ConnType", "active", "leaseTimeRemaining"] },
    inbox: { box: "LTE_SMS_RECVMSGBOX", entry: "LTE_SMS_RECVMSGENTRY", page: "PageNumber" },
    outbox: { box: "LTE_SMS_SENDMSGBOX", entry: "LTE_SMS_SENDMSGENTRY", page: "PageNumber" },
    send: "LTE_SMS_SENDNEWMSG",
    ussd: "LTE_USSD",
  },
  ex: {
    key: "/cgi/getGDPRParm",
    command: "/cgi_gdpr?9",
    username: "user",
    info: "DEV2_DEV_INFO",
    link: ["DEV2_LTE_LINK_CFG", "1,0,0,0,0,0"],
    linkAttrs: ["enable", "connectStatus", "networkType", "simStatus"],
    intf: ["DEV2_XTP_LTE_INTF_CFG", "1,0,0,0,0,0"],
    net: ["DEV2_LTE_NET_STATUS", "1,0,0,0,0,0"],
    netAttrs: ["smsUnreadCount", "sigLevel", "rfInfoRsrp", "rfInfoRsrq", "rfInfoSnr"],
    wanCfg: "DEV2_LTE_WAN_CFG",
    simLock: "DEV2_LTE_SIMLOCK",
    prof: ["DEV2_LTE_PROF_STAT", "1,0,0,0,0,0"],
    profAttrs: ["ispName"],
    cells: "DEV2_LTE_SERVING_CELL_INFO",
    wan: { operation: "list", oid: "DEV2_ADT_WAN", attrs: ["enable", "connIPv4Address", "connStatusV4"] },
    hosts: { operation: "list", oid: "DEV2_HOST_ENTRY", attrs: ["active", "X_TP_LanConnType", "physAddress", "IPAddress", "hostName"] },
    inbox: { box: "DEV2_LTE_SMS_RECVMSGBOX", entry: "DEV2_LTE_SMS_RECVMSGENTRY", page: "pageNumber" },
    outbox: null,
    send: "DEV2_LTE_SMS_SENDNEWMSG",
    ussd: "DEV2_LTE_USSD",
  },
};

/** What a router hands out before a login: its form of the interface, its key, and the number its signatures count from. */
interface Opening {
  dialect: Dialect;
  key: TplinkPublicKey;
  seq: number;
}

/** The key of one form's key request, or `null` when the router does not answer it as that form does. */
function keyOf(res: LanResponse): { key: TplinkPublicKey; seq: number } | null {
  if (res.status !== 200) return null;
  const seqText = scriptVar(res.text, "seq");
  const modulusHex = scriptVar(res.text, "nn");
  const exponentHex = scriptVar(res.text, "ee");
  if (modulusHex !== null && exponentHex !== null && seqText !== null && /^\d{1,12}$/.test(seqText)) {
    const key: TplinkPublicKey = { kind: "rsa", modulusHex, exponentHex };
    return usableKey(key) ? { key, seq: Number(seqText) } : null;
  }
  // The newer firmware of the MR series: a point on a curve, as JSON
  if (!res.text.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonText(res.text, "the router's key");
  } catch {
    return null;
  }
  const xHex = textOf(fieldOf(parsed, "eccPubKey_X_HEX"));
  const yHex = textOf(fieldOf(parsed, "eccPubKey_Y_HEX"));
  const seq = nonNegativeOf(fieldOf(parsed, "seq"));
  if (xHex === null || yHex === null || seq === null) return null;
  const key: TplinkPublicKey = { kind: "ecc", xHex, yHex };
  return usableKey(key) ? { key, seq } : null;
}

/** Ask for the router's key in each form's own place; the form that answers is the one it speaks. */
async function opening(http: LanHttp): Promise<Opening | null> {
  for (const dialect of ["ex", "mr"] as const) {
    const found = keyOf(await http.request({ method: "POST", path: OBJECTS[dialect].key, referer: ROOT }));
    if (found) return { dialect, ...found };
  }
  return null;
}

/**
 * The cipher and the signature's padding this router's own script uses, read before a login: the
 * original is AES-CBC with an unpadded signature, and a script that names GCM or OAEP says so itself.
 * A router without the script is the original form.
 */
async function schemeOf(http: LanHttp, open: Opening): Promise<TplinkScheme> {
  if (open.key.kind === "ecc") return { cipher: "cbc", padding: "none" };
  const script = await http.request({ method: "GET", path: "/js/tpEncrypt.js", referer: ROOT });
  // No such script: the original form. Any other answer that is not the script (an error, a page) settles nothing
  if (script.status === 404) return { cipher: "cbc", padding: "none" };
  if (script.status !== 200 || script.text.trimStart().startsWith("<")) throw new DriverLoginMethodError(`the page's encryption script could not be read (HTTP ${script.status})`);
  const scheme: TplinkScheme = { cipher: /gcm/i.test(script.text) ? "gcm" : "cbc", padding: /encryptOAEP/.test(script.text) ? "oaep" : "none" };
  // The MR series' login with the newer cipher is not on record: where its tag would go is not known
  if (open.dialect === "mr" && scheme.cipher === "gcm") throw new DriverLoginMethodError("this firmware's cipher has no login on record for the MR series");
  return scheme;
}

function notOnRecord(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface has no way on record to ${what}`);
}

/** The router did not hand out what the page's own form for this reads first: this firmware's page has no such form. */
function noFeature(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's firmware has no ${what}: nothing was sent`);
}

function flagOf(value: string | undefined): boolean | null {
  const n = intOf(value);
  return n === null ? null : n === 1;
}

/** The largest data limit the page's form takes: 9999 GB. */
const MAX_LIMIT_BYTES = 9999 * 1024 ** 3;
const MIN_LIMIT_BYTES = 1024 ** 2;

class TplinkSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #dialect: Dialect;
  readonly #objects: Objects;
  readonly #envelope: TplinkEnvelope;
  readonly #token: string;
  #info: TplinkResult = null;
  #open = true;
  /**
   * SMS as the router's own page reads and writes it. The MR series lists what it sent as well; the
   * other form has only the inbox on record, so what FengSui sends there is kept by FengSui.
   */
  readonly sms: DriverSms;
  /** Mobile data as the page's own switch (`dataSwitchStatusBackup`). */
  readonly data: DriverDataLink;
  /** The cellular settings of the page's "Internet" section, its data settings, its PIN page and USSD. */
  readonly cellular: DriverCellular;

  constructor(http: LanHttp, dialect: Dialect, envelope: TplinkEnvelope, token: string) {
    this.#http = http;
    this.#dialect = dialect;
    this.#objects = OBJECTS[dialect];
    this.#envelope = envelope;
    this.#token = token;
    this.sms = {
      keepsSent: this.#objects.outbox !== null,
      list: async (): Promise<SmsWireMessage[]> => (await this.#smsList()).map((entry) => entry.message),
      counters: () => this.#smsCounters(),
      send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
      markRead: (indices, check) => this.#smsWrite(indices, check, "read"),
      delete: (indices, check) => this.#smsWrite(indices, check, "delete"),
    };
    this.data = {
      enabled: async () => flagOf((await this.#settings())?.["dataSwitchStatusBackup"]),
      set: (enabled, check, wait) => this.#setData(enabled, check, wait),
    };
    this.cellular = {
      read: () => this.#cellularState(),
      setNetworkMode: (mode, check) => this.#setNetworkMode(mode, check),
      setRoaming: (enabled, check) => this.#setRoaming(enabled, check),
      scanOperators: (check, wait) => this.#scanOperators(check, wait),
      selectOperator: (selection, check) => this.#selectOperator(selection, check),
      enterPin: (pin, check, wait) => this.#pin({ simAction: "4", pin }, 2, check, wait),
      setPinLock: (enabled, pin, check, wait) => this.#pin({ simAction: enabled ? "1" : "2", pin }, enabled ? 2 : 3, check, wait),
      setDataLimit: (limit, check) => this.#setDataLimit(limit, check),
      resetTraffic: (check) => this.#resetTraffic(check),
      ussd: (request, check, wait) => this.#ussd(request, check, wait),
      // The MR series' page keeps a list of access point profiles; the other form's manages several at once, which is not done here
      ...(dialect === "mr" ? { setApn: (choice: ApnChoice, check: WriteCheck) => this.#setApn(choice, check), restoreApn: (restore: ApnRestore, check: WriteCheck) => this.#restoreApn(restore, check) } : {}),
    };
  }

  get open(): boolean {
    return this.#open;
  }

  /** One encrypted request and its decrypted answer. */
  async #exchange(plain: string): Promise<string> {
    if (!this.#open) throw new DriverSessionClosedError();
    const res = await this.#http.request({
      method: "POST",
      path: this.#objects.command,
      body: this.#envelope.body(this.#envelope.seal(plain, false)),
      contentType: "text/plain",
      referer: ROOT,
      headers: { TokenID: this.#token, "X-Requested-With": "XMLHttpRequest" },
    });
    // The router answers a session it no longer knows (signed out, or someone else signed in) with an error page
    if (res.status !== 200) throw new CpeApiError("session", `the router answered HTTP ${res.status}: the session is gone`);
    if (res.text.trim() === "") return "";
    try {
      return this.#envelope.open(res.text);
    } catch {
      throw new CpeAnswerFormatError(`${this.#objects.command}: the answer could not be decrypted`);
    }
  }

  /** Run actions and hand back one result each: the MR series takes them in one frame, the EX and NX series one by one. */
  async #run(actions: ReadonlyArray<TplinkAction>): Promise<TplinkResult[]> {
    if (this.#dialect === "mr") {
      const answer = parseMrAnswer(await this.#exchange(mrFrame(actions)), actions.length);
      if (answer.error !== null && answer.error !== 0) throw new CpeApiError(String(answer.error), `the router refused the request (${answer.error})`);
      return answer.results;
    }
    const results: TplinkResult[] = [];
    for (const action of actions) {
      const answer = parseExAnswer(await this.#exchange(exRequest(action)));
      if (!answer.ok) throw new CpeApiError(String(answer.code ?? "refused"), `the router refused ${action.oid}`);
      results.push(answer.result);
    }
    return results;
  }

  async #one(action: TplinkAction): Promise<TplinkResult> {
    return (await this.#run([action]))[0] ?? null;
  }

  /** A write: named in the check before it goes out, sent once. */
  async #write(check: WriteCheck, command: string, actions: ReadonlyArray<TplinkAction>): Promise<TplinkResult[]> {
    noteSent(check, FAMILY, command);
    return this.#run(actions);
  }

  async #deviceInfo(): Promise<TplinkResult> {
    this.#info ??= await this.#one({ operation: "get", oid: this.#objects.info, attrs: ["hardwareVersion", "modelName", "softwareVersion"] }).catch(() => null);
    return this.#info;
  }

  async identify(): Promise<DriverIdentity> {
    const info = instance(await this.#deviceInfo());
    return {
      model: labelOf(info?.["modelName"]),
      softwareVersion: labelOf(info?.["softwareVersion"]),
      hardwareVersion: labelOf(info?.["hardwareVersion"]),
      ...(this.#dialect === "ex" ? { variant: "ex" } : {}),
    };
  }

  /** The LTE link's instance: the cellular settings and the SIM lock are instances beside it. */
  get #lte(): string {
    return this.#objects.link[1];
  }

  /** One object whole, as the page's own forms read it; `null`: the router did not hand it out. */
  async #object(oid: string, stack?: string): Promise<Record<string, string> | null> {
    return instance(await this.#one({ operation: "get", oid, ...(stack === undefined ? {} : { stack }) }).catch(() => null));
  }

  /** The cellular settings (`…LTE_WAN_CFG`). */
  #settings(): Promise<Record<string, string> | null> {
    return this.#object(this.#objects.wanCfg, this.#lte);
  }

  /** Attributes of the cellular settings, written the way the page's switches write them. */
  async #setSettings(check: WriteCheck, attrs: Readonly<Record<string, string>>): Promise<void> {
    const oid = this.#objects.wanCfg;
    await this.#write(check, `${oid}.set`, [{ operation: "set", oid, stack: this.#lte, attrs }]);
  }

  async telemetry(): Promise<DriverTelemetry> {
    const o = this.#objects;
    const [link = null, intf = null, net = null, prof = null] = await this.#run([
      { operation: "get", oid: o.link[0], stack: o.link[1], attrs: o.linkAttrs },
      { operation: "get", oid: o.intf[0], stack: o.intf[1], attrs: ["totalStatistics", "curRxSpeed", "curTxSpeed"] },
      { operation: "get", oid: o.net[0], stack: o.net[1], attrs: o.netAttrs },
      { operation: "get", oid: o.prof[0], stack: o.prof[1], attrs: o.profAttrs },
    ]);
    // What other panels of the page read: a firmware without one of them costs the poll only that part
    const cells = o.cells === null ? null : await this.#one({ operation: "list", oid: o.cells }).catch(() => null);
    const wan = await this.#one(o.wan).catch(() => null);
    // The MR series' status page reads the serving cell from the cell lock, on firmware that has one
    const cell = this.#dialect === "mr" ? await this.#one({ operation: "get", oid: MR_CELL_LOCK }).catch(() => null) : null;
    const cfg = await this.#one({ operation: "get", oid: o.wanCfg, stack: this.#lte, attrs: ["roamingEnabled"] }).catch(() => null);
    return parseTplinkTelemetry({ info: await this.#deviceInfo(), link, intf, net, prof, cells, wan, cell, cfg });
  }

  neighbours(): Promise<DriverNeighbour[]> {
    return Promise.reject(new SectionUnavailableError("Nearby cells", null));
  }

  // ── Band selection and cell lock ───────────────────────────────────────────

  async lockState(): Promise<DriverLockState> {
    const cfg = await this.#settings();
    if (this.#dialect === "mr") return mrLockState(cfg, await this.#object(MR_CELL_LOCK));
    return nxLockState(await this.#object(NX_BAND_SEARCH, this.#lte), await this.#object(NX_CELL_LOCKS.LTE, this.#lte), await this.#object(NX_CELL_LOCKS.NR, this.#lte), cfg);
  }

  /**
   * The page's band selection. The MR series keeps it in the cellular settings (a switch and two bit
   * masks, 4G only); the EX and NX series have a form of their own (`DEV2_LTE_BAND_SEARCH`) that lists
   * the bands the router offers and takes 4G and 5G bands together. Neither changes the network mode.
   */
  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    if (target.networkMode !== null) throw notOnRecord("switch the network mode with a band selection");
    if (this.#dialect === "mr") {
      if ((await this.#settings())?.["bandSelectSwitch"] === undefined) throw noFeature("band selection");
      if (target.nr !== null && target.nr !== "all") throw new CpeControlValidationError("This router selects 4G bands only");
      if (target.lte === "all") await this.#setSettings(check, MR_BANDS_OFF);
      else {
        const mask = maskOfBands(checkLockBands("LTE", target.lte, null));
        if (mask === null) throw new CpeControlValidationError("This router's page selects bands 1 to 31 and 33 to 63");
        await this.#setSettings(check, { bandSelectSwitch: "1", bandSelectedMaskL: String(mask.low), bandSelectedMaskH: String(mask.high) });
      }
    } else {
      const search = await this.#object(NX_BAND_SEARCH, this.#lte);
      const supported = parseNxBands(search?.["supportBandList"]);
      if (search === null || supported === null) throw noFeature("band selection");
      const supportedNr = [...new Set([...supported.nrSa, ...supported.nrNsa])];
      if (target.lte !== "all") checkLockBands("LTE", target.lte, supported.lte);
      if (target.nr !== null && target.nr !== "all") {
        if (supportedNr.length === 0) throw new CpeControlValidationError("This router offers no 5G bands to select");
        checkLockBands("NR", target.nr, supportedNr);
      }
      const selection = nxSelection(target, supported, intOf(search["selectedMode"]) === 2 ? parseNxBands(search["selectedBand"]) : null);
      const attrs: Record<string, string> = selection === null ? { selectedMode: "1" } : { selectedMode: "2", selectedBand: nxBandList(selection) };
      await this.#write(check, `${NX_BAND_SEARCH}.set`, [{ operation: "set", oid: NX_BAND_SEARCH, stack: this.#lte, attrs }]);
    }
    const after = await this.lockState().catch(() => null);
    // "Every 5G band" asks nothing of a router that has none
    settleBandLock(check, after !== null && after.nrBands === null && target.nr === "all" ? { ...target, nr: null } : target, after);
  }

  /**
   * The page's cell lock: a channel and a PCI. The MR series has one for 4G on newer firmware
   * (`LTE_CELL_LOCK`); the EX and NX series have one each for 4G and for 5G standalone, which also
   * take the band (one the router offers) and, for 5G, the subcarrier spacing.
   */
  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    const t = checkCellLock(target);
    // The bound of the page's own form for a 4G channel
    if (t.rat === "LTE" && t.arfcn > 65535) throw new CpeControlValidationError(`This router's page takes 4G channels up to 65535 (asked: ${t.arfcn})`);
    if (this.#dialect === "mr") {
      if (t.rat !== "LTE") throw new CpeControlValidationError("This router locks 4G cells only");
      if ((await this.#object(MR_CELL_LOCK)) === null) throw noFeature("cell lock");
      if (t.arfcn < 1) throw new CpeControlValidationError("This router's page takes 4G channels from 1");
      // The form sends the cell's identity as well, empty when its field is left empty
      const attrs = { rfInfoCellIDLock: "1", rfInfoCellID: "", rfInfoEARFCN: String(t.arfcn), rfInfoPCI: String(t.pci) };
      await this.#write(check, `${MR_CELL_LOCK}.set`, [{ operation: "set", oid: MR_CELL_LOCK, attrs }]);
    } else {
      const oid = NX_CELL_LOCKS[t.rat];
      const supported = parseNxBands((await this.#object(NX_BAND_SEARCH, this.#lte))?.["supportBandList"]);
      if (supported === null || (await this.#object(oid, this.#lte)) === null) throw noFeature(`${t.rat === "NR" ? "5G" : "4G"} cell lock`);
      // The form picks the band from the ones the router offers; a 5G cell is locked standalone only
      const offered = t.rat === "LTE" ? supported.lte : supported.nrSa;
      if (!offered.includes(t.band)) throw new CpeControlValidationError(`Band ${t.rat === "NR" ? "n" : "B"}${t.band} is not one this router's page offers for a ${t.rat === "NR" ? "5G standalone" : "4G"} cell lock`);
      const attrs: Record<string, string> =
        t.rat === "LTE"
          ? { pci: String(t.pci), EARFCN: String(t.arfcn), band: String(t.band), lteCelllockEnable: "1" }
          : { pci: String(t.pci), NRARFCN: String(t.arfcn), band: String(t.band), scs: String(t.scsKhz), nrCelllockEnable: "1" };
      await this.#write(check, `${oid}.set`, [{ operation: "set", oid, stack: this.#lte, attrs }]);
    }
    settleCellLock(check, t, await this.lockState().catch(() => null));
  }

  /** Each lock that is on is switched off the way its form does it; one that is off already is left alone. */
  async unlockAll(check: WriteCheck): Promise<void> {
    if (this.#dialect === "mr") {
      const cfg = await this.#settings();
      const cell = await this.#object(MR_CELL_LOCK);
      const selects = cfg?.["bandSelectSwitch"] !== undefined;
      if (!selects && cell === null) throw noFeature("band selection or cell lock");
      if (selects && intOf(cfg?.["bandSelectSwitch"]) !== 0) await this.#setSettings(check, MR_BANDS_OFF);
      if (cell !== null && intOf(cell["rfInfoCellIDLock"]) !== 0) await this.#write(check, `${MR_CELL_LOCK}.set`, [{ operation: "set", oid: MR_CELL_LOCK, attrs: { rfInfoCellIDLock: "0" } }]);
    } else {
      const stack = this.#lte;
      const search = await this.#object(NX_BAND_SEARCH, stack);
      const cells = { LTE: await this.#object(NX_CELL_LOCKS.LTE, stack), NR: await this.#object(NX_CELL_LOCKS.NR, stack) };
      if (search === null && cells.LTE === null && cells.NR === null) throw noFeature("band selection or cell lock");
      if (search !== null && intOf(search["selectedMode"]) !== 1) await this.#write(check, `${NX_BAND_SEARCH}.set`, [{ operation: "set", oid: NX_BAND_SEARCH, stack, attrs: { selectedMode: "1" } }]);
      for (const rat of ["LTE", "NR"] as const) {
        const enable = rat === "LTE" ? "lteCelllockEnable" : "nrCelllockEnable";
        if (cells[rat] !== null && intOf(cells[rat]?.[enable]) !== 0) await this.#write(check, `${NX_CELL_LOCKS[rat]}.set`, [{ operation: "set", oid: NX_CELL_LOCKS[rat], stack, attrs: { [enable]: "0" } }]);
      }
    }
    const after = await this.lockState().catch(() => null);
    settleUnlock(check, after, { nr: after !== null && after.nrBands !== null, mode: false });
  }

  /**
   * The page's switch between the internal and the external antennas, on firmware built with it: the
   * page's own script (`/js/oid_str.js`) says so, as it tells the page. Where the page restarts the
   * router to switch, FengSui does not switch.
   */
  async setAntennaMode(mode: AntennaModeName, check: WriteCheck): Promise<number> {
    const code = mode === "internal" ? 0 : mode === "external" ? 1 : null;
    if (code === null) throw new CpeControlValidationError("This router switches between its internal and its external antennas only");
    const flags = await this.#http.request({ method: "GET", path: BUILD_FLAGS, referer: ROOT });
    const built = (name: string): boolean => flags.status === 200 && flags.text.includes(`${name}=1`);
    if (!built("INCLUDE_LTE_ANTENNA_TYPE")) throw noFeature("antenna switch");
    if (built("INCLUDE_LTE_Q8RX_SWITCH")) throw new CpeControlValidationError("On this model the router's page restarts the router to switch the antenna: use the router's own page");
    await this.#setSettings(check, { antennaType: String(code), profileAction: "0" });
    const after = intOf((await this.#settings())?.["antennaType"]);
    settleCheck(check, after === null ? null : after === code);
    return code;
  }

  async hosts(): Promise<DriverHost[]> {
    return parseTplinkHosts(await this.#one(this.#objects.hosts));
  }

  // ── SMS ────────────────────────────────────────────────────────────────────

  /** One page of a box: the page is chosen, then its entries listed, as the router's own page does. */
  async #smsPage(box: "in" | "out", page: number): Promise<TplinkSms[]> {
    const names = box === "in" ? this.#objects.inbox : this.#objects.outbox;
    if (names === null) return [];
    const attrs = box === "in" ? ["index", "from", "content", "receivedTime", "unread"] : ["index", "to", "content", "sendTime"];
    const results = await this.#run([
      { operation: "set", oid: names.box, attrs: { [names.page]: String(page) } },
      { operation: "list", oid: names.entry, attrs },
    ]);
    return parseTplinkSmsPage(results[1] ?? null, page, box);
  }

  async #smsBox(box: "in" | "out"): Promise<TplinkSms[]> {
    const all: TplinkSms[] = [];
    for (let page = 1; page <= SMS_MAX_PAGES; page += 1) {
      const entries = await this.#smsPage(box, page);
      all.push(...entries);
      if (entries.length < SMS_PAGE_SIZE) break;
    }
    return all;
  }

  async #smsList(): Promise<TplinkSms[]> {
    return [...(await this.#smsBox("in")), ...(await this.#smsBox("out"))];
  }

  /** How many messages a box holds, by the router's own count. */
  async #boxTotal(box: string): Promise<number> {
    // The MR series' page names the attribute; the other form's asks for the object as a whole
    const read: TplinkAction = this.#dialect === "mr" ? { operation: "get", oid: box, attrs: ["totalNumber"] } : { operation: "get", oid: box };
    return nonNegativeOf(instance(await this.#one(read))?.["totalNumber"]) ?? 0;
  }

  /** The router's own counts, the same on the poll and after a listing: unread from the status, each box's total from the box. */
  async #smsCounters(): Promise<SmsCounters> {
    const o = this.#objects;
    const net = instance(await this.#one({ operation: "get", oid: o.net[0], stack: o.net[1], attrs: ["smsUnreadCount"] }));
    if (net?.["smsUnreadCount"] === undefined) throw new SectionUnavailableError("SMS", null);
    return {
      localUnread: nonNegativeOf(net["smsUnreadCount"]) ?? 0,
      localInbox: await this.#boxTotal(o.inbox.box),
      localOutbox: o.outbox === null ? 0 : await this.#boxTotal(o.outbox.box),
      localDraft: 0,
      localMax: 0,
    };
  }

  /** The message FengSui names by `handle`, found by listing in this session: its page and its instance there. */
  async #locate(handle: number): Promise<{ names: { box: string; entry: string; page: string }; entry: TplinkSms } | null> {
    const sent = handle > TPLINK_SENT_BASE;
    const names = sent ? this.#objects.outbox : this.#objects.inbox;
    if (names === null) return null;
    const entry = (await this.#smsBox(sent ? "out" : "in")).find((candidate) => candidate.message.index === handle);
    return entry ? { names, entry } : null;
  }

  /**
   * Mark read or delete, one message at a time: the page it is on is chosen, then its instance there
   * written. A message is looked up again before each write, since a delete moves the ones after it.
   */
  async #smsWrite(indices: ReadonlyArray<number>, check: WriteCheck, what: "read" | "delete"): Promise<void> {
    const wanted = storedIndices(indices);
    for (const handle of wanted) {
      const found = await this.#locate(handle);
      if (found === null) continue;
      const choose: TplinkAction = { operation: "set", oid: found.names.box, attrs: { [found.names.page]: String(found.entry.page) } };
      const act: TplinkAction = what === "read" ? { operation: "set", oid: found.names.entry, stack: found.entry.stack, attrs: { unread: "0" } } : { operation: "del", oid: found.names.entry, stack: found.entry.stack };
      await this.#write(check, `${found.names.entry}.${what === "read" ? "set" : "del"}`, [choose, act]);
    }
    const after = await this.#smsList().catch(() => null);
    settleSmsListing(check, after === null ? null : after.map((entry) => entry.message), wanted, what === "delete" ? "gone" : "read");
  }

  /**
   * A message handed to the router. The MR series says how it went (`sendResult` 1 sent, 3 not done
   * yet), which is asked until it says or the wait is over; the other form has no such read on record.
   */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    const send = this.#objects.send;
    await this.#write(check, `${send}.set`, [{ operation: "set", oid: send, attrs: { index: "1", to: phone, textContent: content } }]);
    options.onAccepted();
    if (this.#dialect !== "mr") return { state: "unconfirmed", code: null };
    for (let waited = 0; waited <= options.statusTimeoutMs; waited += SEND_POLL_MS) {
      const result = intOf(instance(await this.#one({ operation: "get", oid: send, attrs: ["sendResult"] }).catch(() => null))?.["sendResult"]);
      if (result === 1) return { state: "sent", code: null };
      if (result !== null && result !== 3 && result !== 0) return { state: "failed", code: `sms-${result}` };
      await options.sleep(SEND_POLL_MS);
    }
    return { state: "unconfirmed", code: null };
  }


  // ── Mobile data and the cellular settings ──────────────────────────────────

  async #connected(): Promise<boolean | null> {
    const o = this.#objects;
    const status = intOf(instance(await this.#one({ operation: "get", oid: o.link[0], stack: o.link[1], attrs: ["connectStatus"] }))?.["connectStatus"]);
    return status === null ? null : status === 4;
  }

  /** The page's mobile data switch. Off waits until the connection is down, so a connect sent right after it does not land in the middle. */
  async #setData(enabled: boolean, check: WriteCheck, wait: DriverWait): Promise<void> {
    if ((await this.#settings())?.["dataSwitchStatusBackup"] === undefined) throw noFeature("mobile data switch");
    await this.#setSettings(check, { dataSwitchStatusBackup: enabled ? "1" : "0", profileAction: "0" });
    if (!enabled) await awaitConnection(() => this.#connected(), false, wait);
    settleDataSwitch(check, enabled, flagOf((await this.#settings())?.["dataSwitchStatusBackup"]));
  }

  /** The LTE interface's data settings (`…LTE_INTF_CFG`), whole. */
  #plan(): Promise<Record<string, string> | null> {
    return this.#object(this.#objects.intf[0], this.#objects.intf[1]);
  }

  async #cellularState(): Promise<DriverCellularState> {
    const cfg = await this.#settings();
    const state: DriverCellularState = { dataLimit: tplinkDataLimit(await this.#plan()), pinAttemptsLeft: tplinkSimLock(await this.#object(this.#objects.simLock, this.#lte)).attemptsLeft };
    if (this.#dialect === "mr") {
      if (cfg?.["networkPreferredMode"] !== undefined) {
        state.networkMode = mrModeOf(cfg["networkPreferredMode"]);
        state.networkModes = ["auto", "lte", "wcdma"];
      }
      const selection = intOf(cfg?.["networkSelectionMode"]);
      const mcc = cfg?.["networkSelectionMCC"] ?? "";
      const mnc = cfg?.["networkSelectionMNC"] ?? "";
      const plmn = /^\d{3}$/.test(mcc) && /^\d{1,3}$/.test(mnc) ? `${mcc}${mnc.padStart(2, "0")}` : null;
      state.operator = selection === null ? null : { selection: selection === 1 ? "manual" : "auto", plmn: selection === 1 ? plmn : null };
      const list = cfg === null ? null : await this.#profiles(cfg);
      if (list !== null && list.active !== null) {
        state.apn = mrApnView(list.active, list.active.index < list.defaults);
        // The profile in use is what a change is put back to, by the router's own number for it
        state.apnRestore = { mode: "profile", id: list.active.id };
      }
      return state;
    }
    const modes = nxModes(cfg?.["networkPreferredModeOptionList"]);
    if (modes.size > 0) {
      state.networkMode = nxModeOf(cfg?.["networkPreferredModeSelected"], cfg?.["networkPreferredModeOptionList"]);
      state.networkModes = [...modes.keys()];
    }
    const search = await this.#object(NX_NETWORK_SEARCH, this.#lte);
    const selection = intOf(search?.["selectedMode"]);
    state.operator = selection === null ? null : { selection: selection === 2 ? "manual" : "auto", plmn: selection === 2 ? (parseNxOperators(search?.["selectedOperator"])[0]?.choice.plmn ?? null) : null };
    return state;
  }

  /**
   * The page's network mode: a number on the MR series (3 4G with 3G behind it, 2 4G only, 1 3G
   * only), one of the names the router lists on the EX and NX series.
   */
  async #setNetworkMode(mode: NetworkMode, check: WriteCheck): Promise<void> {
    const cfg = await this.#settings();
    const none = new CpeControlValidationError(`This router offers no "${mode}" network mode`);
    let read: (after: Record<string, string>) => NetworkMode | null;
    if (this.#dialect === "mr") {
      const code = mrModeCode(mode);
      if (cfg?.["networkPreferredMode"] === undefined || code === null) throw none;
      // The page changes the mode only with a card it can use (ready, or its PIN given)
      const o = this.#objects;
      const sim = intOf(instance(await this.#one({ operation: "get", oid: o.link[0], stack: o.link[1], attrs: ["simStatus"] }))?.["simStatus"]);
      if (sim !== 3 && sim !== 5) throw new CpeControlValidationError("The router's page changes the network mode only with a SIM card it can use: nothing was sent");
      await this.#setSettings(check, { networkPreferredMode: code });
      read = (after) => mrModeOf(after["networkPreferredMode"]);
    } else {
      const name = nxModes(cfg?.["networkPreferredModeOptionList"]).get(mode);
      if (name === undefined) throw none;
      await this.#setSettings(check, { networkPreferredModeSelected: name });
      read = (after) => nxModeOf(after["networkPreferredModeSelected"], after["networkPreferredModeOptionList"]);
    }
    const after = await this.#settings();
    settleCheck(check, after === null ? null : read(after) === mode);
  }

  async #setRoaming(enabled: boolean, check: WriteCheck): Promise<void> {
    if ((await this.#settings())?.["roamingEnabled"] === undefined) throw noFeature("roaming switch");
    await this.#setSettings(check, { roamingEnabled: enabled ? "1" : "0", profileAction: "0" });
    const after = flagOf((await this.#settings())?.["roamingEnabled"]);
    settleCheck(check, after === null ? null : after === enabled);
  }

  /**
   * The page's search for networks: started once, then asked every two seconds whether it is done
   * (the MR series counts what it found, the EX and NX series name a status), then the list.
   */
  async #scanOperators(check: WriteCheck, wait: DriverWait): Promise<OperatorChoice[]> {
    settleNothingToRead(check);
    const mr = this.#dialect === "mr";
    if (mr) await this.#write(check, "LTE_NET_SEL.set", [{ operation: "set", oid: "LTE_NET_SEL", attrs: { searchAction: "1" } }]);
    else await this.#write(check, `${NX_NETWORK_SEARCH}.set`, [{ operation: "set", oid: NX_NETWORK_SEARCH, stack: this.#lte, attrs: { action: "1" } }]);
    for (let ask = 0; ask < SEARCH_POLLS; ask += 1) {
      await wait.sleep(SEARCH_POLL_MS);
      if (mr) {
        const found = nonNegativeOf((await this.#object("LTE_NET_SEL"))?.["itemNum"]);
        if (found !== null && found > 0) return parseMrOperators(instances(await this.#one({ operation: "list", oid: "LTE_NET_SEL_LIST" }))).map((entry) => entry.choice);
        continue;
      }
      const search = await this.#object(NX_NETWORK_SEARCH, this.#lte);
      const status = intOf(search?.["status"]);
      if (status === 2) return parseNxOperators(search?.["operatorList"]).map((entry) => entry.choice);
      if (status === 3) throw new CpeApiError("search-failed", "The router's search for networks failed");
    }
    throw new CpeApiError("timeout", "The router was still searching for networks after two minutes");
  }

  /**
   * One operator is chosen from the router's last search, with what that search listed for it (the
   * page's form sends the entry back); automatic is the form's other choice. The MR series writes
   * either into its cellular settings; firmware without that writes the search's own objects.
   */
  async #selectOperator(selection: OperatorSelection, check: WriteCheck): Promise<void> {
    const unlisted = new CpeControlValidationError("This network is not in the router's last search: search for networks first");
    if (this.#dialect === "mr") {
      const settings = (await this.#settings())?.["networkSelectionMode"] !== undefined;
      if (selection.mode === "auto") {
        if (settings) await this.#setSettings(check, { networkSelectionMode: "0", networkSelectionMCC: "0", networkSelectionMNC: "0", networkSelectionISP: "" });
        else await this.#write(check, "LTE_NET_SEL.set", [{ operation: "set", oid: "LTE_NET_SEL", attrs: { netSelType: "0" } }]);
      } else {
        const found = parseMrOperators(instances(await this.#one({ operation: "list", oid: "LTE_NET_SEL_LIST" }).catch(() => null))).find((entry) => entry.choice.plmn === selection.plmn);
        if (!found) throw unlisted;
        if (settings) await this.#setSettings(check, { networkSelectionMCC: found.mcc, networkSelectionMNC: found.mnc, networkSelectionISP: found.name, networkSelectionMode: "1" });
        else await this.#write(check, "LTE_NET_SEL_LIST.set", [{ operation: "set", oid: "LTE_NET_SEL_LIST", stack: found.stack, attrs: { itemStat: "10" } }]);
      }
      const after = settings ? ((await this.#cellularState().catch(() => null))?.operator ?? null) : null;
      settleCheck(check, after === null ? null : selection.mode === "auto" ? after.selection === "auto" : after.selection === "manual" && after.plmn === selection.plmn);
      return;
    }
    const stack = this.#lte;
    if (selection.mode === "auto") await this.#write(check, `${NX_NETWORK_SEARCH}.set`, [{ operation: "set", oid: NX_NETWORK_SEARCH, stack, attrs: { selectedMode: "1" } }]);
    else {
      const found = parseNxOperators((await this.#object(NX_NETWORK_SEARCH, stack))?.["operatorList"]).find((entry) => entry.choice.plmn === selection.plmn);
      if (!found) throw unlisted;
      await this.#write(check, `${NX_NETWORK_SEARCH}.set`, [{ operation: "set", oid: NX_NETWORK_SEARCH, stack, attrs: { selectedMode: "2", selectedOperator: found.entry } }]);
    }
    const after = await this.#object(NX_NETWORK_SEARCH, stack);
    const mode = intOf(after?.["selectedMode"]);
    settleCheck(check, mode === null ? null : selection.mode === "auto" ? mode === 1 : mode === 2 && parseNxOperators(after?.["selectedOperator"])[0]?.choice.plmn === selection.plmn);
  }

  /**
   * The page's access point profiles: its list (`LTE_PROFILE`), which of them is in use, and how many
   * at the head of the list are the router's own for the SIM card (`defaultProfile`). `null`: no list.
   */
  async #profiles(cfg: Record<string, string>): Promise<{ profiles: MrProfile[]; active: MrProfile | null; defaults: number } | null> {
    const defaults = intOf(cfg["defaultProfile"]);
    const activeIndex = intOf(cfg["activeProfile"]);
    if (defaults === null || defaults < 0) return null;
    const profiles = parseMrProfiles(instances(await this.#one({ operation: "list", oid: "LTE_PROFILE" }).catch(() => null)));
    return profiles.length === 0 ? null : { profiles, active: profiles.find((profile) => profile.index === activeIndex) ?? null, defaults };
  }

  /** What every profile form of the page does first (`profileAction` 4), then the settings and the list as they are. */
  async #openProfiles(check: WriteCheck): Promise<{ profiles: MrProfile[]; active: MrProfile | null; defaults: number }> {
    await this.#setSettings(check, { profileAction: "4" });
    const cfg = await this.#settings();
    const list = cfg === null ? null : await this.#profiles(cfg);
    if (list === null) throw noFeature("list of access point profiles");
    return list;
  }

  /** Make `profile` the one in use, with these fields (the settings form's save), and read back that it is. */
  async #useProfile(check: WriteCheck, form: Record<string, string>, index: number, wanted: ApnChoice | null): Promise<void> {
    await this.#setSettings(check, form);
    const cfg = await this.#settings();
    const after = cfg === null ? null : await this.#profiles(cfg);
    const view = after?.active ? mrApnView(after.active, false) : null;
    settleCheck(check, after === null || after.active === null ? null : after.active.index === index && (wanted === null || wanted.mode !== "manual" || (view?.apn === wanted.apn && view.ipType === wanted.ipType)));
  }

  /** The router's own profile for the SIM card: the one a person gets who never made a profile. Several of them: theirs to choose. */
  #ownProfile(list: { profiles: MrProfile[]; defaults: number }): MrProfile {
    const own = list.profiles.filter((profile) => profile.index < list.defaults && profile.name !== "NONE");
    if (own.length !== 1 || !own[0]) throw new CpeControlValidationError(own.length === 0 ? "The router has no access point profile of its own for this SIM card" : "The router has several access point profiles of its own for this SIM card: choose one on the router's own page");
    return own[0];
  }

  /**
   * An access point by hand is FengSui's own profile (named `FengSui`): made with the page's "create
   * profile" form when the list has none, then saved and put in use with its settings form. The
   * router's own profiles and the ones its owner made stay as they are. Automatic is the router's own
   * profile for the SIM card, put in use as it is.
   */
  async #setApn(choice: ApnChoice, check: WriteCheck): Promise<void> {
    if (choice.mode === "manual" && (choice.username.length > 31 || choice.password.length > 31)) throw new CpeControlValidationError("This router's page takes a user name and a password of up to 31 characters");
    const list = await this.#openProfiles(check);
    if (choice.mode === "auto") {
      const own = this.#ownProfile(list);
      return await this.#useProfile(check, mrProfileUse(own), own.index, null);
    }
    const mine = (profiles: ReadonlyArray<MrProfile>): MrProfile | undefined => profiles.find((profile) => profile.index >= list.defaults && profile.name === FENGSUI_APN_PROFILE);
    let profile = mine(list.profiles);
    if (profile === undefined) {
      if (list.profiles.length >= MAX_PROFILES) throw new CpeControlValidationError(`The router keeps ${MAX_PROFILES} access point profiles at most: delete one on the router's own page first`);
      await this.#setSettings(check, { ...mrProfileCreate(FENGSUI_APN_PROFILE, choice), profileAction: "2" });
      const cfg = await this.#settings();
      profile = mine((cfg === null ? null : await this.#profiles(cfg))?.profiles ?? []);
      if (profile === undefined) throw new CpeAnswerFormatError("LTE_PROFILE: the router does not list the profile it was asked to create (nothing is sent again)");
    }
    await this.#useProfile(check, mrProfileEdit(profile, choice), profile.index, choice);
  }

  /** Back to the profile a change replaced, by the router's own number for it, as it is. */
  async #restoreApn(restore: ApnRestore, check: WriteCheck): Promise<void> {
    if (restore.mode === "context") throw notOnRecord("put back an access point that was no profile of the router's");
    const list = await this.#openProfiles(check);
    const profile = restore.mode === "auto" ? this.#ownProfile(list) : list.profiles.find((candidate) => candidate.id === restore.id);
    if (profile === undefined) throw new CpeControlValidationError("The router no longer lists the access point profile it used before");
    await this.#useProfile(check, mrProfileUse(profile), profile.index, null);
  }

  /**
   * One PIN write of the page's PIN form (`simAction` 4 gives the card its PIN, 1 turns "ask for the
   * PIN" on, 2 off), sent once. The page reads the lock again after a wait and shows what it finds;
   * so does FengSui: `wanted` is the state a PIN the card took leaves it in. A PIN it did not take is
   * never followed by another.
   */
  async #pin(action: { simAction: string; pin: string }, wanted: number, check: WriteCheck, wait?: DriverWait): Promise<SimPinOutcome> {
    const oid = this.#objects.simLock;
    const before = await this.#object(oid, this.#lte);
    if (before === null) throw noFeature("SIM PIN form");
    // The form sends its "enter the PIN by itself after a restart" switch along: as the router has it
    const attrs = { ...action, ...(action.simAction === "2" ? {} : { autoUnlockPin: intOf(before["autoUnlockPin"]) === 1 ? "1" : "0" }) };
    let refused = false;
    try {
      await this.#write(check, `${oid}.set`, [{ operation: "set", oid, stack: this.#lte, attrs }]);
    } catch (err) {
      // The router's own refusal of the write is its answer to the PIN; a session that is gone is not
      if (!(err instanceof CpeApiError) || err.code === "session") throw err;
      refused = true;
    }
    await wait?.sleep(PIN_SETTLE_MS);
    const after = tplinkSimLock(await this.#object(oid, this.#lte));
    if (!refused && after.pinState === null) throw new CpeAnswerFormatError(`${oid}: the router did not say whether it took the PIN (it was sent once, and is not sent again)`);
    const accepted = !refused && after.pinState === wanted;
    if (accepted) settleCheck(check, true);
    else settleNothingToRead(check);
    return { accepted, attemptsLeft: after.attemptsLeft };
  }

  /**
   * The data settings as the page's form sends them, all at once: the limit and the billing day as
   * the router has them, unless `change` says otherwise. `adjustStatistics` -1 leaves the used total
   * alone.
   */
  #planForm(before: Record<string, string>, change: Readonly<Record<string, string>>): Record<string, string> {
    // A change of the limit itself replaces what the router has; anything else sends it back as it is
    const limit: Record<string, string> = "enableDataLimit" in change ? {} : intOf(before["enableDataLimit"]) === 1 ? { enableDataLimit: "1", limitation: String(nonNegativeOf(before["limitation"]) ?? 0), warningPercent: String(intOf(before["warningPercent"]) ?? 90) } : { enableDataLimit: "0" };
    const day = intOf(before["paymentDay"]);
    const billing: Record<string, string> = intOf(before["enablePaymentDay"]) === 1 && day !== null && day >= 1 && day <= 31 ? { enablePaymentDay: "1", paymentDay: String(day) } : { enablePaymentDay: "0" };
    return { adjustStatistics: "-1", ...limit, ...billing, ...change };
  }

  async #setDataLimit(limit: DataLimitSetting, check: WriteCheck): Promise<void> {
    const oid = this.#objects.intf[0];
    const before = await this.#plan();
    if (before === null || before["enableDataLimit"] === undefined) throw noFeature("data limit");
    let change: Record<string, string> = { enableDataLimit: "0" };
    if (limit.enabled) {
      const bytes = limit.bytes ?? nonNegativeOf(before["limitation"]);
      const percent = limit.alertPercent ?? tplinkDataLimit(before)?.alertPercent ?? 90;
      if (bytes === null || bytes < MIN_LIMIT_BYTES || bytes > MAX_LIMIT_BYTES) throw new CpeControlValidationError("This router's data limit is between 1 MB and 9999 GB");
      if (percent < 1 || percent > 99) throw new CpeControlValidationError("This router warns at 1 to 99 percent of the limit");
      change = { enableDataLimit: "1", limitation: String(Math.round(bytes)), warningPercent: String(percent) };
    }
    await this.#write(check, `${oid}.set`, [{ operation: "set", oid, stack: this.#objects.intf[1], attrs: this.#planForm(before, change) }]);
    settleCheck(check, sameDataLimit(limit, tplinkDataLimit(await this.#plan())));
  }

  /** The form's "correct the used total", to zero. */
  async #resetTraffic(check: WriteCheck): Promise<void> {
    const oid = this.#objects.intf[0];
    const before = await this.#plan();
    if (before === null || before["totalStatistics"] === undefined) throw noFeature("traffic total to correct");
    await this.#write(check, `${oid}.set`, [{ operation: "set", oid, stack: this.#objects.intf[1], attrs: this.#planForm(before, { adjustStatistics: "0" }) }]);
    const was = tplinkBytes(before["totalStatistics"]);
    const now = tplinkBytes((await this.#plan())?.["totalStatistics"]);
    settleCheck(check, was === null || now === null ? null : now <= was);
  }

  // ── USSD ───────────────────────────────────────────────────────────────────

  /**
   * USSD as the page's form does it: a code is sent (action 1), then the status asked every second
   * until the network answered (`ussdStatus` 1) or the router said how it ended otherwise. An answer
   * that leaves the session open (`sessionStatus` 1) awaits a reply, which is sent the same way;
   * action 2 ends the session.
   */
  async #ussd(request: UssdRequest, check: WriteCheck, wait: DriverWait): Promise<UssdAnswer> {
    const oid = this.#objects.ussd;
    settleNothingToRead(check);
    if (request.kind === "cancel") {
      await this.#write(check, `${oid}.set`, [{ operation: "set", oid, attrs: { action: "2" } }]);
      return emptyUssd("cancelled");
    }
    await this.#write(check, `${oid}.set`, [{ operation: "set", oid, attrs: { action: "1", reqContent: request.code } }]);
    for (let ask = 0; ask < USSD_POLLS; ask += 1) {
      await wait.sleep(USSD_POLL_MS);
      const state = instance(await this.#one({ operation: "get", oid, attrs: ["sessionStatus", "sendResult", "response", "ussdStatus"] }).catch(() => null));
      if (state === null) continue;
      // The router could not send it, or the session ended without an answer (2 the network ended it, 3 not supported, 4 timed out, 5 failed)
      if (state["sendResult"] === "0") break;
      if (state["ussdStatus"] === "1") return { state: "answered", text: ussdText(state["response"] ?? null), awaitsReply: state["sessionStatus"] === "1" };
      if (state["ussdStatus"] !== undefined && state["ussdStatus"] !== "0") break;
    }
    return emptyUssd("no_answer");
  }

  async reboot(check: WriteCheck): Promise<void> {
    await this.#write(check, "ACT_REBOOT", [{ operation: "run", oid: "ACT_REBOOT" }]);
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    // The page's own logout: a script the command endpoint runs
    await this.#exchange(this.#dialect === "mr" ? mrFrame([{ operation: "cgi", oid: "/cgi/logout" }]) : exRequest({ operation: "cgi", oid: "/cgi/logout" })).catch(() => undefined);
    this.#open = false;
  }
}

/** The lock the login page shows before anyone signs in: `forbidFlag`, and for how long (`forbidTime`). */
function lockOf(page: string): { waitSec: number | null } | null {
  const flag = scriptVar(page, "forbidFlag");
  const time = intOf(scriptVar(page, "forbidTime"));
  if (flag !== null && flag !== "0" && flag !== "false") return { waitSec: time !== null && time > 0 ? time : null };
  return null;
}

export const tplinkProtocol: DriverProtocol = {
  family: FAMILY,

  /** Told by the key request no other brand answers: `var nn`, `var ee` and `var seq`, a curve point, or a Deco's password key. */
  async detect(http: LanHttp): Promise<boolean> {
    return (await opening(http)) !== null || (await decoPasswordKey(http)) !== null;
  },

  /** What the page shows before a login: a lock on its login page, and whether someone is signed in. */
  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    const page = await http.request({ method: "GET", path: ROOT, referer: ROOT });
    const busy = await http.request({ method: "POST", path: BUSY, referer: ROOT });
    const signedIn = busy.status === 200 ? scriptVar(busy.text, "isLogined") : null;
    if (signedIn === null && page.status !== 200) return null;
    return { occupied: signedIn !== null && signedIn !== "0", locked: page.status === 200 ? lockOf(page.text) : null };
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const open = await opening(http);
    if (open === null) {
      // Neither form of the Archer routers: a Deco hands out its own key
      const passwordKey = await decoPasswordKey(http);
      if (passwordKey !== null) return decoLogin(http, credentials, passwordKey);
      throw new DriverLoginMethodError("the router handed out no login key");
    }
    const scheme = await schemeOf(http, open);
    const objects = OBJECTS[open.dialect];
    const username = credentials.username || objects.username;
    if (/[\r\n]/.test(`${username}${credentials.password}`)) throw new DriverLoginMethodError("the page's login has no form for a line break");
    const envelope = new TplinkEnvelope({ key: open.key, scheme, seq: open.seq, username, password: credentials.password });
    let res: LanResponse;
    let answer: string;
    if (open.dialect === "mr") {
      // The MR series: the user name and password as two lines, the envelope in the address
      const sealed = envelope.seal(`${username}\n${credentials.password}`, true);
      res = await http.request({
        method: "POST",
        path: "/cgi/login",
        query: [
          ["data", sealed.data],
          ["sign", sealed.sign],
          ["Action", "1"],
          ["LoginStatus", "0"],
          ["isMobile", "0"],
        ],
        referer: ROOT,
      });
      answer = res.text;
    } else {
      // The EX and NX series: the login is an action, the credentials Base64 inside it
      const action = JSON.stringify({
        data: { UserName: Buffer.from(username, "utf8").toString("base64"), Passwd: Buffer.from(credentials.password, "utf8").toString("base64"), Action: "1", stack: "0,0,0,0,0,0", pstack: "0,0,0,0,0,0" },
        operation: "cgi",
        oid: "/cgi/login",
      });
      res = await http.request({ method: "POST", path: objects.command, body: envelope.body(envelope.seal(action, true)), contentType: "text/plain", referer: ROOT, headers: { "X-Requested-With": "XMLHttpRequest" } });
      try {
        answer = envelope.open(res.text);
      } catch {
        answer = res.text;
      }
    }
    const code = returnCode(answer);
    if (code === WRONG_PASSWORD) {
      const used = intOf(scriptVar(answer, "currAuthTimes"));
      const forbid = intOf(scriptVar(answer, "currForbidTime"));
      if (forbid !== null && forbid > 0) throw loginLocked("the router has locked its login", forbid);
      throw wrongPassword("the router refused the user name or password", used !== null && used >= 0 && used <= LOGIN_ATTEMPTS ? LOGIN_ATTEMPTS - used : null);
    }
    // Every answer of the page's login carries its return code: one without it, or with another code, cannot be placed
    if (res.status !== 200 || code !== 0) throw loginUnplaced(`login answered ${code ?? `HTTP ${res.status} without a return code`}`);
    // Some firmware answers a wrong password like a right one, only without a session
    if (http.cookie(SESSION_COOKIE) === undefined) throw wrongPassword("the router opened no session for this user name and password");
    // The page writes how often a login failed into a cookie of its own; a session that was just opened had none fail
    if (open.dialect === "mr") http.setCookie("loginErrorShow", "1");
    const home = await http.request({ method: "GET", path: ROOT, referer: ROOT });
    const token = home.status === 200 ? scriptVar(home.text, "token") : null;
    // Signed in, the page carries the session's token. Without it FengSui cannot tell whether the router took the
    // password, and must not find out by sending it again on the next poll
    if (token === null || !TOKEN.test(token)) {
      // The router may hold a session for this cookie: the page's logout is tried once, without the token it wants, so the seat is not kept
      const logout: TplinkAction = { operation: "cgi", oid: "/cgi/logout" };
      await http
        .request({ method: "POST", path: objects.command, body: envelope.body(envelope.seal(open.dialect === "mr" ? mrFrame([logout]) : exRequest(logout), false)), contentType: "text/plain", referer: ROOT })
        .catch(() => undefined);
      throw loginUnplaced("the router's page carried no token after the login");
    }
    return new TplinkSession(http, open.dialect, envelope, token);
  },
};
