import { DriverCpeClient } from "../../src/drivers/client.ts";
import { fiberhomeProtocol } from "../../src/drivers/fiberhome.ts";
import { LanRouterMock } from "./lan-router.ts";

/** The password the FiberHome mock router takes. */
export const FIBERHOME_PASSWORD = "test-password";

/** The address the FiberHome mock router answers on (its page checks the referer against it). */
export const FIBERHOME_URL = "http://192.168.8.1";

const PASSWORD = FIBERHOME_PASSWORD;

/** The base readings of a FiberHome 5G router registered on SA (placeholder cells, AGENTS.md 铁律二). */
export const FIBERHOME_BASE_SA: Record<string, string> = {
  modelName: "LG6121F",
  Software_version: "RP0113",
  WorkMode: "SA",
  PLMN: "27201",
  TAC: "10001",
  NCGI: "PLMN:27201 134217758",
  NR_Band: "78",
  SSB_RSRP: "-79",
  SSB_SINR: "24",
  DlBandWidth: "100MHz",
  DlMCS: "27",
  UlMCS: "22",
  CQI: "14",
  DlMimo: "4",
  BAND_NBR: "78,78,41",
  EARFCN_NBR: "650000,650000,504990",
  PCI_NBR: "142,211,1",
  RSRP_NBR: "-79,-89,-96",
  RSRQ_NBR: "-10,-12,-15",
  SINR_NBR: "24,-30,5",
  Temperature: "46",
  RxSpeed: "8945120",
  TxSpeed: "125829",
  monthRxBytes: "85899345920",
  monthTxBytes: "5368709120",
};

const BASE_SA = FIBERHOME_BASE_SA;

/**
 * A FiberHome router's `FHNCAPIS` / `FHTOOLAPIS` interface: a fresh session id before every call,
 * the page each call must name, the login with its lock, the readings and the writes, stored and read
 * back. Tests only.
 */
export function fiberhomeRouter(opts: { model?: string; status?: Record<string, string>; login?: Record<string, string>; airplane?: string; airplaneSticks?: boolean; header?: Record<string, string> | null } = {}) {
  const base = { ...BASE_SA, modelName: opts.model ?? "LG6121F" };
  let sid = 0;
  let current = "";
  let loggedIn = false;
  const store: Record<string, Record<string, unknown>> = {
    app_get_lockband: { lockBandEnable: "0", LTELockBAND: "", NRLockBAND: "" },
    app_get_lockcell: { LockCellEnable: "0", LockAct: "1", LockArfcn: "0", LockPci: "" },
    app_get_cell_list: { enable: "0", lock_cell: [] },
    app_get_network_info: { networkMode: "3", ENDC: "3" },
  };
  const writes: Array<{ method: string; data: Record<string, unknown> }> = [];
  let airplane = opts.airplane ?? "0";
  // The web page's header (`get_header_info`); `null`: a firmware without the call
  const header: { info: Record<string, string> | null } = { info: opts.header === undefined ? { connetStatus: "1", upStatus: "1" } : opts.header };
  const mock = new LanRouterMock((req) => {
    if (req.method === "GET" && req.path === "/api/tmp/FHNCAPIS") {
      current = `s${String(++sid).padStart(8, "0")}`;
      return { json: { sessionid: current }, setCookie: ["fh=1; Path=/"] };
    }
    if (req.method === "GET" && req.path === "/api/tmp/FHTOOLAPIS") {
      if (!loggedIn) return { text: "timeout" };
      return req.query.get("ajaxmethod") === "app_get_airplane" ? { json: { airplaneOn: airplane } } : { json: base };
    }
    if (req.method === "GET" && req.path === "/api/tmp/FHAPIS" && req.query.get("ajaxmethod") === "get_header_info") {
      if (!loggedIn) return { text: "timeout" };
      return header.info === null ? { status: 404, text: "" } : { json: header.info };
    }
    const body = JSON.parse(req.body) as { dataObj: Record<string, unknown> | null; ajaxmethod: string; sessionid: string };
    if (body.sessionid !== current) return { text: "timeout" };
    const wantRef = body.ajaxmethod.includes("login") ? "/login.html" : "/main.html";
    if (req.headers["referer"] !== `http://192.168.8.1${wantRef}`) return { status: 403, text: "" };
    if (body.ajaxmethod === "app_get_login_status") return { json: opts.status ?? { login_status: "0", lockstatus: "0", remaintime: "0" } };
    if (body.ajaxmethod === "app_do_login") {
      if (opts.login) return { json: opts.login };
      if (body.dataObj?.["password"] !== PASSWORD) return { json: { login_result: "1" } };
      loggedIn = true;
      return { json: { login_result: "0" } };
    }
    if (!loggedIn) return { text: "timeout" };
    if (body.ajaxmethod === "app_do_logout") {
      loggedIn = false;
      return { json: { login_status: "0" } };
    }
    if (body.ajaxmethod.startsWith("app_get_")) return { json: store[body.ajaxmethod] ?? {} };
    writes.push({ method: body.ajaxmethod, data: body.dataObj ?? {} });
    if (body.ajaxmethod === "app_set_lockband") store["app_get_lockband"] = { ...body.dataObj };
    if (body.ajaxmethod === "app_set_network_info") store["app_get_network_info"] = { ...body.dataObj };
    if (body.ajaxmethod === "app_set_lockcell") store["app_get_lockcell"] = { ...body.dataObj };
    if (body.ajaxmethod === "app_set_cell_list") store["app_get_cell_list"] = { ...body.dataObj };
    if (body.ajaxmethod === "app_set_airplane" && !opts.airplaneSticks) airplane = String(body.dataObj?.["airplaneOn"]);
    return { json: { result: "0" } };
  });
  const client = new DriverCpeClient({ protocol: fiberhomeProtocol, cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, store, writes, header, client };
}
