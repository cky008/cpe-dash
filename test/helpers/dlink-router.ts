import crypto from "node:crypto";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { dlinkEncodedPassword } from "../../src/drivers/dlink/parts.ts";
import { dlinkProtocol } from "../../src/drivers/dlink/driver.ts";
import { type LanReply, type LanRequestRecord, LanRouterMock } from "./lan-router.ts";

/**
 * A stand-in for a D-Link DWR 4G router's web interface (`login.cgi`, `data.ria`, `webpost.cgi`):
 * it keeps a session, hands out one write token at a time and changes its own state on a write, so a
 * read-back sees what the write did. Every identifier is a reserved placeholder; nothing here talks
 * to a real router.
 */

export const DLINK_PASSWORD = "test-password";
export const DLINK_URL = "http://192.168.0.1";

export interface DlinkInboxEntry {
  tag: string;
  phone: string;
  date: string;
  msg: string;
  read: number;
}

export interface DlinkRouterOptions {
  /** The login page: the older one (MD5), the newer one (`encode_passwd`), or one FengSui does not know. */
  page?: "md5" | "encoded" | "unknown";
  /** Someone is signed in to the router's page from this address. */
  busyFrom?: string;
  /** What the login answers instead of checking the password. */
  loginAnswer?: LanReply;
  /** The reads this firmware lacks (their `DynUpdate` or `CfgType` name). */
  missing?: ReadonlyArray<string>;
  /** The router dials by itself after a disconnect. */
  autoConnect?: boolean;
  /** What the network answers a USSD code with (`null`: nothing). */
  ussdAnswer?: string | null;
  /** A write the router refuses (its `CfgType`). */
  refuse?: string;
  inbox?: DlinkInboxEntry[];
}

const OLD_PAGE = '<html><head><script src="js/md5.js"></script></head><body><script>function doLogin(){ $.post("login.cgi", {uname: u, passwd: hex_md5(p)}, function(d){ setCookie("DWRLOGGEDID", d.SessId); }); }</script></body></html>';
const NEW_PAGE = '<html><body><script>function encode_passwd(passtext){ /* the page\'s own form */ } function doLogin(){ $.post("login.cgi", {uname: u, passwd: encode_passwd(p)}); setCookie("DWRLOGGEDID", sid); }</script></body></html>';
const OTHER_PAGE = '<html><body><script>function doLogin(){ $.post("login.cgi", {uname: u, passwd: scramble(p)}); }</script></body></html>';

export function dlinkRouter(opts: DlinkRouterOptions = {}) {
  const page = opts.page ?? "md5";
  const state = {
    sid: null as string | null,
    token: null as string | null,
    connected: true,
    autoConnect: opts.autoConnect ?? true,
    preference: "0",
    profile: { type: "0", apn: "internet", uname: "", passwd: "", auth: "3", pdp_type: "2" },
    inbox: opts.inbox ?? [
      { tag: "1001", phone: "+353830000001", date: "26/10/10 04:07:40", msg: "Hello &amp; welcome &#39;home&#39;", read: 0 },
      { tag: "1002", phone: "DemoBank", date: "26/10/11 09:30:00", msg: "Balance ready", read: 1 },
    ],
    ussdPending: false,
    rebooted: false,
  };
  /** Every write the router took: its `CfgType` and the body (the token left out). */
  const writes: Array<Record<string, unknown>> = [];
  const logins: URLSearchParams[] = [];
  const expected = page === "encoded" ? dlinkEncodedPassword(DLINK_PASSWORD) : crypto.createHash("md5").update(DLINK_PASSWORD, "utf8").digest("hex");
  const signedIn = (req: LanRequestRecord): boolean => {
    const cookies = new Map((req.headers["cookie"] ?? "").split("; ").map((pair) => pair.split("=") as [string, string]));
    return state.sid !== null && cookies.get("qSessId") === state.sid && cookies.get("DWRLOGGEDID") === state.sid && cookies.get("DWRLOGGEDUSER") === "admin";
  };

  const read = (name: string): LanReply => {
    if (opts.missing?.includes(name)) return { status: 404, text: "<html>Not Found</html>" };
    if (name === "up_5s") {
      return {
        json: {
          system_uptime: 86_400,
          system_date: "2026-10-12 08:00:00",
          new_sms: 1,
          sim_status: { status: 1, result: 0, retry: 3 },
          signal: { modem: { service: "LTE", op_name: "Three", strength: -67, level: 4, max_level: 5, cat: 6, netreg: 1, roaming: 0 } },
          ipv4: state.connected ? { status: "Connected", ip: "198.51.100.42", subnet_mask: "255.255.255.252", gateway: "198.51.100.41", dns1: "203.0.113.10", dns2: "203.0.113.11" } : { status: "Disconnected" },
          clientNum: { ssid1: 1, ssid2: 1, lan: 1 },
        },
      };
    }
    if (name === "get_networkserviceinfo") {
      return { json: { oper_name: "Three", service_type: "LTE", rsrp: -95, rsrq: -11, sinr: 14, rssi: -67, bm_currentBand: 120, earfcn: 300, mimo: "2x2", cell_id: 134217758, tac: 10001, PLMN: "27201", roaming: 0 } };
    }
    if (name === "nw_usage") return { json: { rx: 2948105728, tx: 104857600, start: "26/10/01", end: "26/10/31" } };
    if (name === "about_sys") {
      return { json: { model_name: "DWR-960", fw_ver: "V1.0.1.2", hw_ver: "B1", modem_ver: "MODEM_1.1.0", imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", my_number: "+353830000000" } };
    }
    if (name === "get_client_list") {
      return {
        json: {
          "WiFi_2.4G_clilist": [{ hname: "phone", ip: "192.168.0.100", mac: "02:00:5E:10:00:01", leasetm: "3600" }],
          WiFi_5G_clilist: [{ hname: "", ip: "192.168.0.101", mac: "00:00:5E:00:53:01", leasetm: "" }],
          lan_clilist: [{ hname: "nas", ip: "192.168.0.2", mac: "02:00:5E:10:00:02", leasetm: "0" }, { hname: "ghost", ip: "", mac: "" }],
        },
      };
    }
    if (name === "get_apn_cfg") {
      return { json: { apn: { COMMON: { netpref_value: state.preference, auto_conx: state.autoConnect ? "1" : "0" }, APN_0: { ...state.profile } }, apn_list: { multi_apn0: [{ apn: "internet", uname: "", pwd: "", auth: "3" }] } } };
    }
    if (name === "sms_action") {
      const out: Record<string, unknown> = { total: state.inbox.length };
      state.inbox.forEach((entry, i) => {
        out[`M${i + 1}`] = { ...entry, storeInSim: 0 };
      });
      return { json: out };
    }
    if (name === "get_ussd_state") return { json: { resp_data: state.ussdPending && opts.ussdAnswer ? opts.ussdAnswer : "" } };
    return { status: 404, text: "<html>Not Found</html>" };
  };

  const write = (body: Record<string, unknown>): LanReply => {
    const { authID, ...fields } = body;
    if (authID !== state.token || state.token === null) return { json: { cmd_status: "Fail" } };
    state.token = null;
    writes.push(fields);
    const type = String(fields["CfgType"]);
    if (opts.refuse === type) return { json: { cmd_status: "Fail" } };
    if (type === "connect_btn") {
      state.connected = fields["connect"] === 1;
      // A router that dials by itself is up again by the next read
      if (!state.connected && state.autoConnect) queueMicrotask(() => (state.connected = true));
    } else if (type === "apn") {
      const common = fields["COMMON"] as Record<string, string> | undefined;
      const profile = fields["APN_0"] as Record<string, unknown> | undefined;
      if (common) state.preference = common["netpref_value"] ?? state.preference;
      if (profile) {
        state.profile = {
          type: String(profile["type"]),
          apn: decodeURIComponent(String(profile["apn"])),
          uname: decodeURIComponent(String(profile["uname"])),
          passwd: decodeURIComponent(String(profile["passwd"])),
          auth: String(profile["auth"]),
          pdp_type: String(profile["pdp_type"]),
        };
      }
    } else if (type === "sms_action" && fields["type"] === "inbox") {
      const entry = state.inbox.find((m) => m.tag === fields["tag"]);
      if (entry && fields["cmd"] === "set_read") entry.read = 1;
      if (entry && fields["cmd"] === "del") state.inbox = state.inbox.filter((m) => m !== entry);
    } else if (type === "do_ussd") {
      state.ussdPending = fields["cmd"] === "send";
    } else if (type === "reboot_reset") {
      state.rebooted = true;
    }
    return { json: { cmd_status: "Done" } };
  };

  const mock = new LanRouterMock((req) => {
    if (req.method === "GET" && req.path === "/login.html") return page === "md5" ? { status: 404, text: "<html>Not Found</html>" } : { text: page === "encoded" ? NEW_PAGE : OTHER_PAGE };
    if (req.method === "GET" && req.path === "/index.html") return { text: page === "md5" ? OLD_PAGE : "<html><script>location.href='login.html'</script></html>" };
    if (req.method === "POST" && req.path === "/login.cgi") {
      if (req.body.startsWith("{")) {
        const body = JSON.parse(req.body) as { logout?: string };
        if (body.logout !== undefined && body.logout === state.sid) state.sid = null;
        return { json: { logout: "ok" } };
      }
      const form = new URLSearchParams(req.body);
      if (form.has("check_attempt_count")) return { json: { attempt_count: 0 } };
      if (form.has("check_valid")) return { json: { valid: form.get("check_valid") === `qSessId=${state.sid}` ? 1 : 0 } };
      logins.push(form);
      if (opts.loginAnswer) return opts.loginAnswer;
      if (opts.busyFrom) return { json: { login_fail: `The device is being configured by IP ${opts.busyFrom}` } };
      if (form.get("uname") !== "admin" || form.get("passwd") !== expected) return { json: { login_fail: "fail" } };
      state.sid = `sess${logins.length}abcdef012345`;
      return { json: { SessId: state.sid, remain: 300 }, setCookie: [`qSessId=${state.sid}; path=/`] };
    }
    if (req.method === "GET" && req.path === "/data.ria") {
      if (!signedIn(req)) return { json: { login_fail: "timeout" } };
      if (req.query.get("token") === "1") {
        state.token = `tok${writes.length + 1}x${logins.length}`;
        return { text: `${state.token}\n` };
      }
      return read(req.query.get("DynUpdate") ?? req.query.get("CfgType") ?? "");
    }
    if (req.method === "POST" && req.path === "/webpost.cgi") return signedIn(req) ? write(JSON.parse(req.body) as Record<string, unknown>) : { json: { login_fail: "timeout" } };
    return { status: 404, text: "<html>Not Found</html>" };
  });
  const client = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpeUsername: "admin", cpePassword: DLINK_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, client, state, writes, logins };
}
