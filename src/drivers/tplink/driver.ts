import type { UssdAnswer, UssdRequest } from "../../cellular.ts";
import { CpeControlValidationError } from "../../control-error.ts";
import { SectionUnavailableError } from "../../cpe-domain.ts";
import type { WriteCheck } from "../../device-access.ts";
import type { DriverNeighbour } from "../../protocols/readings.ts";
import { type LanHttp, type LanResponse, parseJsonText } from "../../protocols/transport.ts";
import { USSD_POLLS, USSD_POLL_MS, emptyUssd, ussdText } from "../../protocols/ussd.ts";
import { fieldOf, intOf, labelOf, nonNegativeOf, textOf } from "../../protocols/values.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import type { SmsCounters, SmsWireMessage } from "../../sms/types.ts";
import { settleNothingToRead } from "../cellular.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "../client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginLocked, loginUnplaced, wrongPassword } from "../login.ts";
import { noteSent, settleRestart } from "../readback.ts";
import { settleSmsListing, storedIndices } from "../sms.ts";
import type { DriverCellular, DriverHost, DriverIdentity, DriverLockState, DriverSessionHandle, DriverSms, DriverSmsSendOptions, DriverSmsSendOutcome, DriverTelemetry, DriverWait } from "../types.ts";
import { TplinkEnvelope, type TplinkPublicKey, type TplinkScheme, usableKey } from "./crypto.ts";
import { decoLogin, decoPasswordKey } from "./deco.ts";
import { type TplinkAction, type TplinkResult, exRequest, instance, mrFrame, parseExAnswer, parseMrAnswer, returnCode, scriptVar } from "./frames.ts";
import { TPLINK_SENT_BASE, type TplinkSms, parseTplinkHosts, parseTplinkSmsPage, parseTplinkTelemetry } from "./parts.ts";

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
 * The interface names the signal and, on the EX and NX series, the serving cells; it has SMS and, on
 * the MR series, USSD. No nearby cells and no band or cell lock are on record.
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
  prof: readonly [string, string];
  profAttrs: ReadonlyArray<string>;
  cells: string | null;
  wan: TplinkAction;
  hosts: TplinkAction;
  inbox: { box: string; entry: string; page: string };
  outbox: { box: string; entry: string; page: string } | null;
  send: string;
  ussd: string | null;
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
    prof: ["DEV2_LTE_PROF_STAT", "1,0,0,0,0,0"],
    profAttrs: ["ispName"],
    cells: "DEV2_LTE_SERVING_CELL_INFO",
    wan: { operation: "list", oid: "DEV2_ADT_WAN", attrs: ["enable", "connIPv4Address", "connStatusV4"] },
    hosts: { operation: "list", oid: "DEV2_HOST_ENTRY", attrs: ["active", "X_TP_LanConnType", "physAddress", "IPAddress", "hostName"] },
    inbox: { box: "DEV2_LTE_SMS_RECVMSGBOX", entry: "DEV2_LTE_SMS_RECVMSGENTRY", page: "pageNumber" },
    outbox: null,
    send: "DEV2_LTE_SMS_SENDNEWMSG",
    ussd: null,
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
  /** USSD, on the form whose page has it (the MR series): the one cellular setting on record here. */
  readonly cellular?: DriverCellular;

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
    if (this.#objects.ussd !== null) this.cellular = { read: () => Promise.resolve({}), ussd: (request, check, wait) => this.#ussd(request, check, wait) };
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

  async telemetry(): Promise<DriverTelemetry> {
    const o = this.#objects;
    const [link = null, intf = null, net = null, prof = null] = await this.#run([
      { operation: "get", oid: o.link[0], stack: o.link[1], attrs: o.linkAttrs },
      { operation: "get", oid: o.intf[0], stack: o.intf[1], attrs: ["totalStatistics", "curRxSpeed", "curTxSpeed"] },
      { operation: "get", oid: o.net[0], stack: o.net[1], attrs: ["smsUnreadCount", "sigLevel", "rfInfoRsrp", "rfInfoRsrq", "rfInfoSnr"] },
      { operation: "get", oid: o.prof[0], stack: o.prof[1], attrs: o.profAttrs },
    ]);
    // What other panels of the page read: a firmware without one of them costs the poll only that part
    const cells = o.cells === null ? null : await this.#one({ operation: "list", oid: o.cells }).catch(() => null);
    const wan = await this.#one(o.wan).catch(() => null);
    return parseTplinkTelemetry({ info: await this.#deviceInfo(), link, intf, net, prof, cells, wan });
  }

  neighbours(): Promise<DriverNeighbour[]> {
    return Promise.reject(new SectionUnavailableError("Nearby cells", null));
  }

  lockState(): Promise<DriverLockState> {
    return Promise.resolve({ lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
  }

  setBandLock(): Promise<void> {
    return Promise.reject(notOnRecord("lock bands"));
  }

  setCellLock(): Promise<void> {
    return Promise.reject(notOnRecord("lock a cell"));
  }

  unlockAll(): Promise<void> {
    return Promise.reject(notOnRecord("clear a lock"));
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


  // ── USSD ───────────────────────────────────────────────────────────────────

  /**
   * A USSD code as the MR series' page sends it (`LTE_USSD`, action 1), then its status until the
   * network answered (`ussdStatus` 1) or the router gave up (2). Answering inside a session and
   * ending one are not on record.
   */
  async #ussd(request: UssdRequest, check: WriteCheck, wait: DriverWait): Promise<UssdAnswer> {
    const oid = this.#objects.ussd;
    if (oid === null) throw notOnRecord("send a USSD code");
    if (request.kind !== "send") throw notOnRecord(request.kind === "reply" ? "answer inside a USSD session" : "end a USSD session");
    settleNothingToRead(check);
    await this.#write(check, `${oid}.set`, [{ operation: "set", oid, attrs: { action: "1", reqContent: request.code } }]);
    for (let ask = 0; ask < USSD_POLLS; ask += 1) {
      await wait.sleep(USSD_POLL_MS);
      const state = instance(await this.#one({ operation: "get", oid, attrs: ["sessionStatus", "sendResult", "response", "ussdStatus"] }).catch(() => null));
      if (state?.["ussdStatus"] === "1") return { state: "answered", text: ussdText(state["response"] ?? null), awaitsReply: false };
      if (state?.["ussdStatus"] === "2") break;
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
