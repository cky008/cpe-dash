import { DriverCpeClient } from "../../src/drivers/client.ts";
import { ucs2Hex } from "../../src/drivers/sms.ts";
import { ZTE_LTE_ALL_MASK, ZTE_NR_ALL_BANDS, zteActionDigest, zteGoformProtocol, zteLoginPassword, zteReqprocPassword } from "../../src/drivers/zte-goform.ts";
import { LanRouterMock, type LanRequestRecord } from "./lan-router.ts";

/**
 * A stand-in for a ZTE router with the goform pages: versions, the login nonce (or `config.js`), a
 * password, lock values the writes change, and the SMS store of the router's own page. Placeholder
 * values only; nothing here talks to a real router.
 */

export const ZTE_PASSWORD = "test-password";
export const ZTE_LD = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";
/** The login nonce of a router that spells the interface `reqproc`. */
export const ZTE_RANDOM_LOGIN = "5e8f1c2a";

export const ZTE_VERSION = { modelName: "MC888", hardwareVersion: "MC888HW-1.0.0", waInnerVersion: "BD_ZTE_MC888V1.0.0B05", crVersion: "CR_ZTE_MC888V1.0.0B05" };

/** A stored message as the router lists it (`tag`: `0` read, `1` unread, `2` sent, `3` not sent, `4` draft). */
export interface ZteSmsRow {
  id: number;
  number: string;
  /** UTF-16 hexadecimal, as the router keeps it. */
  content: string;
  tag: string;
  date: string;
}

export interface ZteState {
  loggedIn: boolean;
  rd: number;
  values: Record<string, string>;
  posts: Array<{ goformId: string; fields: URLSearchParams }>;
  sms: ZteSmsRow[];
  /** What a status slot answers (`4` send, `6` delete); a slot nothing was asked of answers no status at all. */
  smsStatus: Record<string, string>;
  nextSmsId: number;
}

export interface ZteRouterOptions {
  ld?: string | null;
  configJs?: string;
  hw?: string;
  model?: string;
  loginResult?: string;
  lock?: { left: string; wait: string };
  /** The messages the router starts with (`false`: a firmware without SMS). */
  sms?: ZteSmsRow[] | false;
  /** What the send slot says after a send (`3` sent, `2` failed, `1` still sending). */
  sendStatus?: string;
  /** What the router answers a `SEND_SMS` with instead of `success`. */
  sendResult?: string;
  /** A firmware that hands back the first page whatever page is asked for. */
  smsIgnoresPage?: boolean;
  /**
   * The ZXIC firmware's spelling: `/reqproc/proc_get` and `/reqproc/proc_post`, a login by user name
   * and nonce, a `random` cookie, and `CSRFToken` on writes. Its versions name only `cr_version`.
   */
  reqproc?: boolean;
  /** The unread count the firmware reports (some lag behind the rows). */
  unreadCount?: string;
  /** Writes the router answers with `failure` (after checking the session and the signature). */
  refuse?: ReadonlyArray<string>;
  /** A connection that does not follow `CONNECT_NETWORK` / `DISCONNECT_NETWORK` (it stays as it is). */
  pppSticks?: boolean;
  /** The device lists `lan_station_list` and `station_list` answer (left out: an empty value, as a firmware without them). */
  stations?: { lan?: unknown[]; wifi?: unknown[] };
}

/** A message row; `text` is stored as UTF-16 hexadecimal. */
export function zteSms(id: number, number: string, text: string, tag = "1", date = "26,11,10,12,34,56,+0"): ZteSmsRow {
  return { id, number, content: ucs2Hex(text), tag, date };
}

export function zteRouter(opts: ZteRouterOptions = {}) {
  const ld = opts.ld === undefined ? ZTE_LD : opts.ld;
  const hash = ld ? "sha256" : "md5";
  const version = { ...ZTE_VERSION, hardwareVersion: opts.hw ?? ZTE_VERSION.hardwareVersion, modelName: opts.model ?? ZTE_VERSION.modelName };
  const expectedPassword = ld
    ? zteLoginPassword({ kind: "sha256-ld", ld }, ZTE_PASSWORD)
    : opts.configJs?.includes("SHA256:1")
      ? zteLoginPassword({ kind: "sha256" }, ZTE_PASSWORD)
      : zteLoginPassword({ kind: "base64" }, ZTE_PASSWORD);
  const state: ZteState = {
    loggedIn: false,
    rd: 0,
    posts: [],
    sms: opts.sms === false || opts.sms === undefined ? [] : opts.sms.map((row) => ({ ...row })),
    smsStatus: {},
    nextSmsId: 900,
    values: {
      model_name: version.modelName,
      hardware_version: version.hardwareVersion,
      wa_inner_version: version.waInnerVersion,
      cr_version: version.crVersion,
      psw_fail_num_str: opts.lock?.left ?? "5",
      login_lock_time: opts.lock?.wait ?? "0",
      lte_band_lock: `0x${ZTE_LTE_ALL_MASK}`,
      nr5g_band_mask: ZTE_NR_ALL_BANDS.join(","),
      lte_pci_lock: "0",
      lte_earfcn_lock: "0",
      nr5g_cell_lock: "0,0,0,0",
      net_select: "WL_AND_5G",
      network_type: "ENDC",
      wan_active_band: "LTE BAND 1",
      wan_active_channel: "300",
      lte_pci: "d3",
      lte_rsrp: "-81",
      ppp_status: "ppp_connected",
    },
  };
  const reqproc = opts.reqproc === true;
  const cookie = reqproc ? "random=9d41c7" : "stok=abc123";
  const getPath = reqproc ? "/reqproc/proc_get" : "/goform/goform_get_cmd_process";
  const setPath = reqproc ? "/reqproc/proc_post" : "/goform/goform_set_cmd_process";
  let token = 0;
  if (reqproc) {
    // This firmware names itself in cr_version alone
    state.values["model_name"] = "";
    state.values["hardware_version"] = "";
    state.values["wa_inner_version"] = "";
    state.values["cr_version"] = "CPE_NV8645_230A_E-P42U17";
  }
  const signedIn = (req: LanRequestRecord): boolean => state.loggedIn && (req.headers["cookie"]?.includes(cookie) ?? false);
  const ids = (raw: string | null): number[] =>
    (raw ?? "")
      .split(";")
      .filter(Boolean)
      .map((id) => Number.parseInt(id, 10));
  const smsAnswer = (req: LanRequestRecord, cmd: string): Record<string, unknown> | null => {
    if (opts.sms === false) return null;
    if (cmd === "sms_data_total") {
      if (!signedIn(req)) return { messages: [] };
      const size = Number.parseInt(req.query.get("data_per_page") ?? "500", 10);
      const page = opts.smsIgnoresPage ? 0 : Number.parseInt(req.query.get("page") ?? "0", 10);
      const rows = [...state.sms].sort((a, b) => b.id - a.id).slice(page * size, page * size + size);
      return { messages: rows.map((row) => ({ id: String(row.id), number: row.number, content: row.content, tag: row.tag, date: row.date, draft_group_id: "" })) };
    }
    if (cmd === "sms_capacity_info") {
      const count = (tags: string[]): string => String(state.sms.filter((row) => tags.includes(row.tag)).length);
      return { sms_nv_total: "100", sms_sim_total: "50", sms_nv_rev_total: count(["0", "1"]), sms_nv_send_total: count(["2", "3"]), sms_nv_draftbox_total: count(["4"]), sms_sim_rev_total: "0", sms_sim_send_total: "0", sms_sim_draftbox_total: "0" };
    }
    if (cmd === "sms_cmd_status_info") {
      const slot = req.query.get("sms_cmd") ?? "";
      const result = state.smsStatus[slot];
      return result === undefined ? { messages: [] } : { sms_cmd: slot, sms_cmd_status_result: result };
    }
    return null;
  };
  const mock = new LanRouterMock((req: LanRequestRecord) => {
    if (req.method === "GET" && req.path === "/js/config/config.js") return opts.configJs === undefined ? { status: 404, text: "" } : { text: opts.configJs };
    if (req.method === "GET" && req.path === getPath) {
      const cmd = req.query.get("cmd") ?? "";
      if (reqproc && cmd === "get_random_login") return { json: { random_login: ZTE_RANDOM_LOGIN } };
      // Empty until a session's cookie is presented, then a fresh one per read
      if (reqproc && cmd === "get_token") return { json: { token: signedIn(req) ? `tok${++token}` : "" } };
      const sms = smsAnswer(req, cmd);
      if (sms) return { json: sms };
      const out: Record<string, string> = {};
      for (const key of cmd.split(",")) {
        if (key === "LD") out["LD"] = ld ?? "";
        else if (key === "RD") out["RD"] = `RD${++state.rd}`;
        else if (key === "sms_unread_num" && opts.sms !== false) out[key] = opts.unreadCount ?? String(state.sms.filter((row) => row.tag === "1").length);
        else if (key === "lan_station_list" && opts.stations?.lan) (out as Record<string, unknown>)[key] = opts.stations.lan;
        else if (key === "station_list" && opts.stations?.wifi) (out as Record<string, unknown>)[key] = opts.stations.wifi;
        else if (state.values[key] !== undefined) out[key] = state.values[key] ?? "";
        else out[key] = "";
      }
      return { json: out };
    }
    if (req.method === "POST" && req.path === setPath) {
      const fields = LanRouterMock.form(req);
      const goformId = fields.get("goformId") ?? "";
      if (goformId === "LOGIN") {
        if (opts.loginResult) return { json: { result: opts.loginResult } };
        const wanted = reqproc ? zteReqprocPassword(ZTE_RANDOM_LOGIN, ZTE_PASSWORD) : expectedPassword;
        if (fields.get("password") !== wanted) return { json: { result: "3" } };
        if (reqproc && (fields.get("username") !== Buffer.from("admin").toString("base64") || fields.get("CSRFToken") !== "")) return { json: { result: "3" } };
        state.loggedIn = true;
        return { json: { result: "0" }, setCookie: [`${cookie}; Path=/; HttpOnly`] };
      }
      if (goformId === "DEVELOPER_OPTION_LOGIN") {
        state.posts.push({ goformId, fields });
        return { json: { result: "0" } };
      }
      if (!signedIn(req)) return { json: { result: "failure" } };
      if (reqproc ? fields.get("CSRFToken") !== `tok${token}` || fields.has("AD") : fields.get("AD") !== zteActionDigest(hash, version, `RD${state.rd}`)) return { json: { result: "failure" } };
      state.posts.push({ goformId, fields });
      if (opts.refuse?.includes(goformId)) return { json: { result: "failure" } };
      if (goformId === "LOGOUT") state.loggedIn = false;
      if (goformId === "DISCONNECT_NETWORK" && !opts.pppSticks) state.values["ppp_status"] = "ppp_disconnected";
      if (goformId === "CONNECT_NETWORK" && !opts.pppSticks) state.values["ppp_status"] = "ppp_connected";
      if (goformId === "BAND_SELECT") state.values["lte_band_lock"] = fields.get("lte_band_mask") ?? "";
      if (goformId === "WAN_PERFORM_NR5G_BAND_LOCK_MERGE") state.values["nr5g_band_mask"] = fields.get("Z5g_lockband_no_format_mask") ?? "";
      if (goformId === "SET_BEARER_PREFERENCE") state.values["net_select"] = fields.get("BearerPreference") ?? "";
      if (goformId === "LTE_LOCK_CELL_SET") {
        state.values["lte_pci_lock"] = fields.get("lte_pci_lock") ?? "";
        state.values["lte_earfcn_lock"] = fields.get("lte_earfcn_lock") ?? "";
      }
      if (goformId === "NR5G_LOCK_CELL_SET") {
        const packed = fields.get("nr5g_cell_lock");
        state.values["nr5g_cell_lock"] = packed ?? `${fields.get("Z5g_lockcell_pci")},${fields.get("Z5g_lockcell_arfcn")},${fields.get("Z5g_lockcell_band")},${fields.get("Z5g_lockcell_scs")}`;
      }
      if (goformId === "SEND_SMS") {
        if (opts.sendResult) return { json: { result: opts.sendResult } };
        const status = opts.sendStatus ?? "3";
        state.smsStatus["4"] = status;
        if (status !== "2") state.sms.push({ id: state.nextSmsId++, number: fields.get("Number") ?? "", content: fields.get("MessageBody") ?? "", tag: "2", date: (fields.get("sms_time") ?? "").replace(/;/g, ",") });
      }
      if (goformId === "SET_MSG_READ") {
        for (const row of state.sms) if (ids(fields.get("msg_id")).includes(row.id) && row.tag === "1") row.tag = fields.get("tag") ?? "0";
      }
      if (goformId === "DELETE_SMS") {
        const gone = ids(fields.get("msg_id"));
        state.sms = state.sms.filter((row) => !gone.includes(row.id));
        state.smsStatus["6"] = "3";
      }
      return { json: { result: "success" } };
    }
    return { status: 404, text: "" };
  });
  const client = new DriverCpeClient({ protocol: zteGoformProtocol, cpeUrl: "http://192.168.0.1", cpePassword: ZTE_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, client };
}
