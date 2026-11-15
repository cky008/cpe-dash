import type { ApnChoice, ApnRestore, NetworkMode, UssdAnswer, UssdRequest } from "../../cellular.ts";
import { CpeControlValidationError } from "../../control-error.ts";
import { SectionUnavailableError } from "../../cpe-domain.ts";
import { type WriteCheck, settleCheck } from "../../device-access.ts";
import type { DriverNeighbour } from "../../protocols/readings.ts";
import { type LanHttp, type LanResponse, parseJsonText } from "../../protocols/transport.ts";
import { USSD_POLLS, USSD_POLL_MS, emptyUssd, ussdText } from "../../protocols/ussd.ts";
import { fieldOf, isPlainObject, labelOf, textOf } from "../../protocols/values.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import type { SmsCounters, SmsWireMessage } from "../../sms/types.ts";
import { longTextOf, settleNothingToRead } from "../cellular.ts";
import type { DriverCredentials, DriverProtocol } from "../client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginUnplaced, md5Hex, signedInElsewhere, wrongPassword } from "../login.ts";
import { awaitConnection, noteSent, settleDataSwitch, settleRestart } from "../readback.ts";
import { countListed, settleSmsListing, storedIndices } from "../sms.ts";
import type { DriverCellular, DriverCellularState, DriverDataLink, DriverHost, DriverIdentity, DriverLockState, DriverSessionHandle, DriverSms, DriverSmsSendOptions, DriverSmsSendOutcome, DriverTelemetry, DriverWait } from "../types.ts";
import {
  DLINK_NETWORK_MODES,
  type DlinkApnSettings,
  type DlinkSms,
  dlinkApnView,
  dlinkAuthCode,
  dlinkConnected,
  dlinkEncodedPassword,
  dlinkPreferenceOf,
  parseDlinkApn,
  parseDlinkHosts,
  parseDlinkInbox,
  parseDlinkTelemetry,
} from "./parts.ts";

/**
 * D-Link's DWR 4G routers (DWR-960, DWR-961): the web interface their own page uses. `login.cgi`
 * takes the user name and the password in the form the login page writes it; `data.ria` answers
 * every read as JSON (`DynUpdate=…` for what changes, `CfgType=…` for settings); `webpost.cgi` takes
 * every write as JSON with a token `data.ria?token=1` hands out right before it, and answers
 * `cmd_status: Done`.
 *
 * Two forms of the password are on record: the older page (`index.html`) sends its MD5, the newer
 * one (`login.html`) the output of its own `encode_passwd`. Which one a router wants is read off its
 * login page before anything is sent; a page that shows neither gets no password.
 *
 * The router lets one person in at a time: a login it refuses because someone is signed in to its
 * page makes FengSui yield, and FengSui signs out after every session. Its interface names no nearby
 * cells and no band or cell lock.
 */

const FAMILY = "dlink" as const;
const LOGIN = "/login.cgi";
const READ = "/data.ria";
const WRITE = "/webpost.cgi";
/** The page the router's own requests name once signed in. */
const PANEL = "/controlPanel.html";
const AJAX = { "X-Requested-With": "XMLHttpRequest" } as const;
const FORM = "application/x-www-form-urlencoded; charset=UTF-8";
const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
/** A user name of printable ASCII, short enough for the cookie the page keeps it in. */
const USER_NAME = /^[\x21-\x7e]{1,64}$/;
const TOKEN = /^[A-Za-z0-9+/=_-]{1,256}$/;
/** How long the page's own session lasts, which it writes into a cookie of its own. */
const PAGE_SESSION_SEC = "300";

/** Waiting on a timer, for a caller that hands none in. */
const TIMER_WAIT: DriverWait = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

type PasswordForm = { kind: "md5"; page: string } | { kind: "encoded"; page: string };

/** The JSON object of an answer, or `null` when it is something else (a page, an empty body). */
function objectOf(res: LanResponse): Record<string, unknown> | null {
  if (res.status !== 200 || !res.text.trimStart().startsWith("{")) return null;
  try {
    const parsed = parseJsonText(res.text, "data.ria");
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Which form of the password this router's login page sends, read off the page itself. The newer
 * page is `login.html` and carries `encode_passwd`; a router without that page has the older one
 * (`index.html`, which has to be there), which sends MD5. A `login.html` that shows neither is a
 * page FengSui does not know.
 */
async function passwordForm(http: LanHttp): Promise<PasswordForm> {
  const page = await http.request({ method: "GET", path: "/login.html" });
  if (page.status === 404) {
    // The older page is opened before its login, as a browser would: a router without it is not one of these
    const older = await http.request({ method: "GET", path: "/index.html" });
    if (older.status !== 200) throw new DriverLoginMethodError(`neither login page is there (HTTP ${older.status})`);
    return { kind: "md5", page: "/index.html" };
  }
  if (page.status !== 200) throw new DriverLoginMethodError(`the login page answered HTTP ${page.status}`);
  if (page.text.includes("encode_passwd")) return { kind: "encoded", page: "/login.html" };
  if (/md5/i.test(page.text)) return { kind: "md5", page: "/login.html" };
  throw new DriverLoginMethodError("the login page sends the password in a form FengSui does not know");
}

function notOnRecord(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface has no way on record to ${what}`);
}

class DlinkSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #sid: string;
  #about: Record<string, unknown> | null = null;
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

  /** One read of `data.ria`: the answer as an object, or the reason it is not one. */
  async #read(query: ReadonlyArray<readonly [string, string]>): Promise<Record<string, unknown>> {
    this.#guard();
    const res = await this.#http.request({ method: "GET", path: READ, query, referer: PANEL, headers: AJAX });
    const label = query.map(([key, value]) => `${key}=${value}`).join("&");
    const answer = objectOf(res);
    // Signed out (the page's five minutes passed, or someone else signed in): the router says so, or sends its login page
    if (answer === null) throw new CpeAnswerFormatError(`${label}: not an object`);
    if (fieldOf(answer, "login_fail") !== undefined) throw new CpeApiError("login_fail", `${label}: the router no longer takes this session`);
    return answer;
  }

  /** The token a write carries: the router's page asks for a fresh one before each write. */
  async #token(): Promise<string> {
    this.#guard();
    const res = await this.#http.request({ method: "GET", path: READ, query: [["token", "1"]], referer: PANEL, headers: AJAX });
    const token = res.status === 200 ? res.text.trim() : "";
    if (!TOKEN.test(token)) throw new CpeAnswerFormatError("data.ria token: the router handed out no write token");
    return token;
  }

  /** One write: named in the check before it goes out, sent once, and taken only when the router says `Done`. */
  async #write(check: WriteCheck, command: string, fields: Record<string, unknown>): Promise<void> {
    const authID = await this.#token();
    noteSent(check, FAMILY, command);
    const answer = await this.#http.postJson(WRITE, { ...fields, authID }, { referer: PANEL, headers: AJAX });
    if (textOf(fieldOf(answer, "cmd_status")) !== "Done") throw new CpeApiError(command, `${command} refused`);
  }

  async #aboutInfo(): Promise<Record<string, unknown> | null> {
    this.#about ??= await this.#read([["DynUpdate", "about_sys"]]).catch(() => null);
    return this.#about;
  }

  async identify(): Promise<DriverIdentity> {
    const about = await this.#aboutInfo();
    return { model: labelOf(fieldOf(about, "model_name")), softwareVersion: labelOf(fieldOf(about, "fw_ver")), hardwareVersion: labelOf(fieldOf(about, "hw_ver")) };
  }

  async telemetry(): Promise<DriverTelemetry> {
    const status = await this.#read([["DynUpdate", "up_5s"]]);
    // What the page's other panels read: a firmware without one of them costs the poll only that part
    const service = await this.#read([["DynUpdate", "get_networkserviceinfo"]]).catch(() => null);
    const usage = await this.#read([["DynUpdate", "nw_usage"]]).catch(() => null);
    return parseDlinkTelemetry(status, service, usage, await this.#aboutInfo());
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
    return parseDlinkHosts(await this.#read([["CfgType", "get_client_list"]]));
  }

  // ── Mobile data ────────────────────────────────────────────────────────────

  async #connected(): Promise<boolean | null> {
    return dlinkConnected(await this.#read([["DynUpdate", "up_5s"]]));
  }

  /** The page's connect button: `connect` 1 dials the mobile connection, 0 ends every connection. */
  async #connect(check: WriteCheck, on: boolean): Promise<void> {
    await this.#write(check, on ? "connect_btn.connect" : "connect_btn.disconnect", { connect: on ? 1 : 0, ifc: on ? "lte" : "all", CfgType: "connect_btn" });
  }

  /**
   * Mobile data is the page's connect button. The router has no switch to read, only its connection,
   * so a write is read back from that; a router set to connect by itself may dial again after a
   * disconnect, which the read-back then shows.
   */
  readonly data: DriverDataLink = {
    enabled: () => Promise.resolve(null),
    set: async (enabled, check, wait) => {
      await this.#connect(check, enabled);
      settleDataSwitch(check, enabled, (await awaitConnection(() => this.#connected(), enabled, wait)) === true ? enabled : null);
    },
  };

  // ── Network mode, access point, USSD ───────────────────────────────────────

  async #settings(): Promise<DlinkApnSettings> {
    return parseDlinkApn(await this.#read([["CfgType", "get_apn_cfg"]]));
  }

  /**
   * The data connection taken down after a setting changed, as the router's page does: the change
   * applies to the next connection. A router that says it dials by itself comes back alone. On any
   * other (one that does not, or does not say), FengSui sends the connect, once, whatever happened in
   * between, unless the connection was down before: a restart never leaves a router offline that was
   * online.
   */
  async #restartConnection(check: WriteCheck, before: DlinkApnSettings, wait: DriverWait): Promise<void> {
    const wasUp = await this.#connected().catch((): boolean | null => null);
    const reconnect = before.autoConnect !== true && wasUp !== false;
    try {
      await this.#connect(check, false);
      if (reconnect) await awaitConnection(() => this.#connected(), false, wait);
    } finally {
      if (reconnect) await this.#connect(check, true);
    }
  }

  async #setNetworkMode(mode: NetworkMode, check: WriteCheck, wait: DriverWait): Promise<void> {
    const preference = dlinkPreferenceOf(mode);
    if (preference === null) throw new CpeControlValidationError(`This router has no "${mode}" network mode`);
    const before = await this.#settings();
    await this.#write(check, "apn.netpref", { CfgType: "apn", COMMON: { netpref_value: preference } });
    await this.#restartConnection(check, before, wait);
    const after = await this.#settings().catch(() => null);
    settleCheck(check, after === null || after.networkMode === null ? null : after.networkMode === mode);
  }

  /**
   * The access point as the page's form sends it: the name and the credentials percent-encoded, the
   * password once more as typed (`re_passwd`, as on record), and the IP type only as the router
   * reported it (its values are not on record: one it did not report is not made up).
   */
  async #writeApn(check: WriteCheck, before: DlinkApnSettings, profile: { manual: boolean; apn: string; username: string; password: string; auth: string }, wait: DriverWait): Promise<void> {
    await this.#write(check, "apn.profile", {
      CfgType: "apn",
      APN_0: {
        type: profile.manual ? 1 : 0,
        apn: encodeURIComponent(profile.apn),
        uname: encodeURIComponent(profile.username),
        passwd: encodeURIComponent(profile.password),
        re_passwd: profile.password,
        auth: profile.auth,
        ...(before.profile?.pdpType ? { pdp_type: before.profile.pdpType } : {}),
      },
    });
    await this.#restartConnection(check, before, wait);
    const after = await this.#settings().catch(() => null);
    const now = after?.profile ?? null;
    settleCheck(check, now === null || now.manual === null ? null : now.manual === profile.manual && (!profile.manual || now.apn === profile.apn));
  }

  async #setApn(choice: ApnChoice, check: WriteCheck, wait: DriverWait): Promise<void> {
    const before = await this.#settings();
    const kept = before.profile;
    if (kept === null) throw new CpeAnswerFormatError("get_apn_cfg: the router named no access point");
    // Automatic: the router's own choice for the card, with the fields it holds sent back as its page sends them
    if (choice.mode === "auto") return this.#writeApn(check, before, { manual: false, apn: kept.apn, username: kept.username, password: kept.password, auth: kept.auth }, wait);
    await this.#writeApn(check, before, { manual: true, apn: choice.apn, username: choice.username, password: choice.password, auth: dlinkAuthCode(choice.auth) }, wait);
  }

  async #restoreApn(restore: ApnRestore, check: WriteCheck, wait: DriverWait): Promise<void> {
    const before = await this.#settings();
    const kept = before.profile;
    if (kept === null) throw new CpeAnswerFormatError("get_apn_cfg: the router named no access point");
    if (restore.mode === "auto") return this.#writeApn(check, before, { manual: false, apn: kept.apn, username: kept.username, password: kept.password, auth: kept.auth }, wait);
    if (restore.mode !== "context") throw notOnRecord("switch back to a stored access point");
    await this.#writeApn(check, before, { manual: true, apn: restore.apn, username: "", password: "", auth: kept.auth }, wait);
  }

  /**
   * A USSD code as the page sends it (`do_ussd`), then `get_ussd_state` until the network's answer
   * is there. A code the network leaves unanswered is cancelled, so no session stays open; the
   * interface has no reply inside a session on record.
   */
  async #ussd(request: UssdRequest, check: WriteCheck, wait: DriverWait): Promise<UssdAnswer> {
    settleNothingToRead(check);
    if (request.kind === "reply") throw notOnRecord("answer inside a USSD session");
    if (request.kind === "cancel") {
      await this.#write(check, "do_ussd.cancel", { CfgType: "do_ussd", cmd: "cancel" });
      return emptyUssd("cancelled");
    }
    await this.#write(check, "do_ussd.send", { CfgType: "do_ussd", cmd: "send", code: request.code });
    for (let ask = 0; ask < USSD_POLLS; ask += 1) {
      await wait.sleep(USSD_POLL_MS);
      const state = await this.#read([["DynUpdate", "get_ussd_state"]]).catch(() => null);
      const text = ussdText(longTextOf(fieldOf(state, "resp_data"), 4000));
      if (text !== null) return { state: "answered", text, awaitsReply: false };
    }
    await this.#write(check, "do_ussd.cancel", { CfgType: "do_ussd", cmd: "cancel" }).catch(() => undefined);
    return emptyUssd("no_answer");
  }

  readonly cellular: DriverCellular = {
    read: async (): Promise<DriverCellularState> => {
      const settings = await this.#settings();
      const profile = settings.profile;
      return {
        networkMode: settings.networkMode,
        networkModes: [...DLINK_NETWORK_MODES],
        apn: dlinkApnView(settings),
        // What a change can be undone to without a credential: the router's own choice, or a name that needs none
        apnRestore: profile === null || profile.manual === null ? null : !profile.manual ? { mode: "auto" } : profile.username === "" && profile.apn !== "" ? { mode: "context", apn: profile.apn, ipType: "ipv4v6" } : null,
      };
    },
    setNetworkMode: (mode, check, wait) => this.#setNetworkMode(mode, check, wait ?? TIMER_WAIT),
    setApn: (choice, check, wait) => this.#setApn(choice, check, wait),
    restoreApn: (restore, check, wait) => this.#restoreApn(restore, check, wait),
    ussd: (request, check, wait) => this.#ussd(request, check, wait),
  };

  // ── SMS ────────────────────────────────────────────────────────────────────

  async #inbox(): Promise<DlinkSms[]> {
    const answer = await this.#read([
      ["CfgType", "sms_action"],
      ["cont", "inbox"],
      ["index", "0"],
    ]);
    // A firmware without the SMS page answers the command without a count
    if (fieldOf(answer, "total") === undefined) throw new SectionUnavailableError("SMS", null);
    return parseDlinkInbox(answer);
  }

  /**
   * The tags of the messages FengSui names by `indices`, found by listing in this session. Two
   * messages whose tags give the same handle cannot be told apart: nothing is written to either.
   */
  async #tagsOf(indices: ReadonlyArray<number>): Promise<string[]> {
    const wanted = new Set(storedIndices(indices));
    const chosen = (await this.#inbox()).filter((entry) => wanted.has(entry.message.index));
    if (new Set(chosen.map((entry) => entry.message.index)).size !== chosen.length) {
      throw new CpeControlValidationError("Two messages on the router cannot be told apart here: change them on the router's own page");
    }
    return chosen.map((entry) => entry.tag);
  }

  async #inboxWrite(indices: ReadonlyArray<number>, check: WriteCheck, cmd: "set_read" | "del"): Promise<void> {
    for (const tag of await this.#tagsOf(indices)) await this.#write(check, `sms_action.${cmd}`, { CfgType: "sms_action", type: "inbox", cmd, tag });
    const after = await this.#inbox().catch(() => null);
    settleSmsListing(check, after === null ? null : after.map((entry) => entry.message), storedIndices(indices), cmd === "del" ? "gone" : "read");
  }

  /** `sms_send`: `Done` says the router took the message, not that it went out. */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    await this.#write(check, "sms_action.sms_send", { CfgType: "sms_action", type: "sms_send", msg: content, phone_list: phone });
    options.onAccepted();
    return { state: "unconfirmed", code: null };
  }

  /**
   * SMS as the router's own page reads and writes it. Only the inbox is on record: what the router
   * sends is kept by FengSui. The counts are taken from the listing, on the poll and after a sync
   * alike.
   */
  readonly sms: DriverSms = {
    keepsSent: false,
    list: async (): Promise<SmsWireMessage[]> => (await this.#inbox()).map((entry) => entry.message),
    counters: async (listed): Promise<SmsCounters> => countListed(listed ?? (await this.#inbox()).map((entry) => entry.message), 0, { unread: true }),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
    markRead: (indices, check) => this.#inboxWrite(indices, check, "set_read"),
    delete: (indices, check) => this.#inboxWrite(indices, check, "del"),
  };

  async reboot(check: WriteCheck): Promise<void> {
    await this.#write(check, "reboot_reset.reboot", { CfgType: "reboot_reset", cmd: "reboot" });
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    await this.#http.postJson(LOGIN, { logout: this.#sid }, { referer: PANEL, headers: AJAX }).catch(() => undefined);
  }
}

export const dlinkProtocol: DriverProtocol = {
  family: FAMILY,

  /**
   * Told from two things only this interface has: `data.ria` answering "not signed in" in its own
   * words, or a login page that carries its password function or the names of its session cookies.
   */
  async detect(http: LanHttp): Promise<boolean> {
    const token = await http.request({ method: "GET", path: READ, query: [["token", "1"]], headers: AJAX });
    if (token.status === 200 && fieldOf(objectOf(token), "login_fail") !== undefined) return true;
    for (const path of ["/login.html", "/index.html"]) {
      const page = await http.request({ method: "GET", path });
      if (page.status === 200 && page.text.includes("login.cgi") && /encode_passwd|DWRLOGGEDID/.test(page.text)) return true;
    }
    return false;
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const form = await passwordForm(http);
    const username = credentials.username || "admin";
    // The page copies the user name into a cookie once signed in: one a cookie cannot carry is refused before anything is sent
    if (!USER_NAME.test(username)) throw new DriverLoginMethodError("the login page has no form for this user name");
    const passwd = form.kind === "md5" ? md5Hex(credentials.password) : dlinkEncodedPassword(credentials.password);
    if (passwd === null) throw new DriverLoginMethodError("the login page has no form for a character of this password");
    const post = (fields: ReadonlyArray<readonly [string, string]>, headers: Record<string, string> = {}): Promise<LanResponse> =>
      http.request({ method: "POST", path: LOGIN, body: new URLSearchParams(fields.map(([key, value]) => [key, value])).toString(), contentType: FORM, referer: form.page, headers: { ...AJAX, ...headers } });
    // The newer page asks how many attempts were made before it sends a password; FengSui asks as it does
    if (form.kind === "encoded") await post([["check_attempt_count", "1"]]);
    const res = await post(
      [
        ["uname", username],
        ["passwd", passwd],
      ],
      form.kind === "encoded" ? { "X-Date": String(Math.floor(Date.now() / 1000)) } : {}
    );
    const answer = objectOf(res);
    if (res.text.includes("login_fail")) {
      // The router lets one person in at a time, and says from which address it is in use
      if (res.text.includes("configured by IP")) throw signedInElsewhere("the router is in use from another address");
      throw wrongPassword("the router refused the user name or password");
    }
    const sid = http.cookie("qSessId") ?? textOf(fieldOf(answer, "SessId"));
    if (res.status !== 200 || sid === null || sid === undefined || !SESSION_ID.test(sid)) throw loginUnplaced(`login answered HTTP ${res.status} without a session`);
    // The cookies the page writes itself once signed in: the router's reads ask for them
    http.setCookie("qSessId", sid);
    http.setCookie("DWRLOGGEDID", sid);
    http.setCookie("DWRLOGGEDUSER", encodeURIComponent(username));
    http.setCookie("DWRLOGGEDTIMEOUT", PAGE_SESSION_SEC);
    const session = new DlinkSession(http, sid);
    // The newer page confirms its session right away; the session is there whatever this answers
    if (form.kind === "encoded") await post([["check_valid", `qSessId=${sid}`]]).catch(() => undefined);
    return session;
  },
};
