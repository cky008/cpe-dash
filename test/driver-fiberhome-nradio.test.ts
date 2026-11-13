import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeAnswerFormatError, CpeApiError } from "../src/session-errors.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { cellGlobalId, fiberhomeAirplaneOf, fiberhomeProtocol, parseFiberhomeLockState, parseFiberhomeProTelemetry, parseFiberhomeTelemetry } from "../src/drivers/fiberhome.ts";
import { NRADIO_ALL_MASK, NRADIO_LTE_ALL_MASK, nradioNrMask, nradioProtocol, parseNradioLockState, parseNradioNeighbours, parseNradioOverview, parseNradioTelemetry, textAfter, withNradioOverview } from "../src/drivers/nradio.ts";
import { getXmlTag } from "../src/xml.ts";
import { cellularOf } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";

const PASSWORD = "test-password";

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

const BASE_SA: Record<string, string> = {
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

function fiberhomeRouter(opts: { model?: string; status?: Record<string, string>; login?: Record<string, string>; airplane?: string; airplaneSticks?: boolean } = {}) {
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
  const mock = new LanRouterMock((req) => {
    if (req.method === "GET" && req.path === "/api/tmp/FHNCAPIS") {
      current = `s${String(++sid).padStart(8, "0")}`;
      return { json: { sessionid: current }, setCookie: ["fh=1; Path=/"] };
    }
    if (req.method === "GET" && req.path === "/api/tmp/FHTOOLAPIS") {
      if (!loggedIn) return { text: "timeout" };
      return req.query.get("ajaxmethod") === "app_get_airplane" ? { json: { airplaneOn: airplane } } : { json: base };
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
  return { mock, store, writes, client };
}

describe("fiberhome: session", () => {
  it("takes a fresh session id before every call, with the page the router expects", async () => {
    const { mock, client } = fiberhomeRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.model, "LG6121F");
    // Login, the base info, airplane mode (same session), logout
    assert.deepEqual(mock.trail, ["GET /api/tmp/FHNCAPIS", "POST /api/tmp/FHTOOLAPIS", "GET /api/tmp/FHNCAPIS", "POST /api/tmp/FHTOOLAPIS", "GET /api/tmp/FHTOOLAPIS", "GET /api/tmp/FHTOOLAPIS", "GET /api/tmp/FHNCAPIS", "POST /api/tmp/FHTOOLAPIS"]);
    assert.equal(mock.requests[5]?.query.get("ajaxmethod"), "app_get_airplane");
    assert.equal(mock.requests[4]?.headers["referer"], "http://192.168.8.1/html/content.html");
  });

  it("yields, latches and refuses as the login answers say", async () => {
    const busy = fiberhomeRouter({ status: { login_status: "1", lockstatus: "0" } });
    assert.equal((await busy.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    const lockedBefore = fiberhomeRouter({ status: { login_status: "0", lockstatus: "1", remaintime: "120" } });
    await assert.rejects(lockedBefore.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 120);
    const wrong = fiberhomeRouter({ login: { login_result: "1" } });
    await assert.rejects(wrong.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    const locked = fiberhomeRouter({ login: { login_result: "2", remaintime: "3" } });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 180);
    const elsewhere = fiberhomeRouter({ login: { login_result: "3" } });
    assert.equal((await elsewhere.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    const forbidden = fiberhomeRouter({ login: { login_result: "4" } });
    await assert.rejects(forbidden.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
  });

  it("reports a session the router ended and answers it cannot read", async () => {
    const { mock, client } = fiberhomeRouter();
    mock.handler = ((inner) => (req) => (req.method === "GET" && req.path === "/api/tmp/FHTOOLAPIS" ? { text: "timeout" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.telemetry()), CpeAnswerFormatError);
    const noSid = new LanRouterMock(() => ({ json: {} }));
    const c2 = new DriverCpeClient({ protocol: fiberhomeProtocol, cpeUrl: "http://192.168.8.1", cpePassword: PASSWORD, fetchImpl: noSid.fetchImpl });
    await assert.rejects(c2.withSession((s) => s.telemetry()), /no session id/);
  });
});

describe("fiberhome: readings", () => {
  it("maps a standalone poll: element 0 is the serving cell, the rest nearby cells", () => {
    const { telemetry: t, neighbours } = parseFiberhomeTelemetry(BASE_SA);
    assert.equal(t.mode, "SA");
    assert.equal(t.lte, null);
    assert.deepEqual([t.nr?.band, t.nr?.arfcn, t.nr?.pci, t.nr?.rsrpDbm, t.nr?.rsrqDb, t.nr?.sinrDb, t.nr?.bandwidthMhz, t.nr?.cellId, t.nr?.tac], [78, 650000, 142, -79, -10, 24, 100, "134217758", "10001"]);
    assert.equal(t.traffic?.downloadBytesPerSec, 8945120);
    assert.equal(t.temperatureC, 46);
    assert.deepEqual(
      neighbours.map((n) => [n.rat, n.band, n.arfcn, n.pci, n.sinrDb]),
      [
        ["NR", 78, 650000, 211, null],
        ["NR", 41, 504990, 1, 5],
      ]
    );
  });

  it("finds the NR leg of EN-DC on the NR band and keeps the other cells as neighbours", () => {
    const { telemetry: t, neighbours } = parseFiberhomeTelemetry({
      WorkMode: "NSA",
      PLMN: "27201",
      ECGI: "27201134217758",
      BAND: "1",
      NR_Band: "N78",
      RSRP: "-80",
      SINR: "-20",
      SSB_RSRP: "-85",
      BAND_NBR: "1,78,3",
      EARFCN_NBR: "300,650000,1850",
      PCI_NBR: "211,142,142",
      RSRQ_NBR: "-9,-11,-12",
    });
    assert.equal(t.mode, "NSA");
    assert.deepEqual([t.lte?.arfcn, t.lte?.pci, t.lte?.cellId, t.lte?.sinrDb], [300, 211, "134217758", null]);
    assert.deepEqual([t.nr?.arfcn, t.nr?.pci, t.nr?.rsrqDb], [650000, 142, -11]);
    assert.deepEqual(
      neighbours.map((n) => [n.rat, n.arfcn]),
      [["LTE", 1850]]
    );
    assert.equal(parseFiberhomeTelemetry({ WorkMode: "LTE", BAND_NBR: "1,1", EARFCN_NBR: "300,300", PCI_NBR: "211,1" }).neighbours[0]?.rat, "LTE");
    assert.equal(parseFiberhomeTelemetry({}).telemetry.mode, null);
    assert.equal(cellGlobalId("0x800001E", null), "134217758");
    assert.equal(cellGlobalId("", "27201"), null);
  });

  it("reads band locks, both cell-lock models and the network mode back", () => {
    const one = parseFiberhomeLockState({ lockBandEnable: "1", LTELockBAND: "1,3", NRLockBAND: "" }, { LockCellEnable: "1", LockAct: "2", LockArfcn: "650000", LockPci: "142" }, { networkMode: "3", ENDC: "2" }, false);
    assert.deepEqual([one.lteBands, one.nrBands, one.networkMode], [[1, 3], "all", "nr_nsa"]);
    assert.deepEqual(one.nrCell, { locked: true, arfcn: 650000, pci: 142, band: null });
    assert.deepEqual(one.lteCell, { locked: false });
    const list = parseFiberhomeLockState({ lockBandEnable: "0" }, { enable: "1", lock_cell: [{ arfcn: "300", pci: "211" }] }, { networkMode: "2" }, true);
    assert.deepEqual(list.lteCell, { locked: true, arfcn: 300, pci: 211, band: null });
    assert.deepEqual(list.nrCell, { locked: false });
    assert.equal(list.networkMode, "nr_sa");
    const unknown = parseFiberhomeLockState({ lockBandEnable: "1", LTELockBAND: 5 }, { enable: "2" }, { networkMode: "9" }, true);
    assert.deepEqual([unknown.lteBands, unknown.lteCell, unknown.networkMode], [null, null, null]);
    assert.equal(parseFiberhomeLockState({}, { LockCellEnable: "0" }, { networkMode: "0" }, false).networkMode, "lte");
    assert.deepEqual(parseFiberhomeLockState({}, { enable: "0" }, { networkMode: "3", ENDC: "3" }, true).nrCell, { locked: false });
  });
});

describe("fiberhome: writes", () => {
  it("locks bands as decimal lists, keeps NR as reported and reads it back", async () => {
    const { writes, client } = fiberhomeRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [3, 1], nr: [78], networkMode: "nr_sa" }, check));
    assert.deepEqual(writes, [
      { method: "app_set_lockband", data: { lockBandEnable: "1", LTELockBAND: "1,3", NRLockBAND: "78" } },
      { method: "app_set_network_info", data: { networkMode: "2", ENDC: "1" } },
    ]);
    assert.equal(check.readback, "match");
    // A cell lock cannot go with a band lock
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: null }, newCheck())), CpeControlValidationError);
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.deepEqual(unlock.endpoints, ["fiberhome:app_set_lockband", "fiberhome:app_set_network_info"]);
    assert.equal(unlock.readback, "match");
  });

  it("locks one cell or a cell list by model, refusing a band lock while one is on", async () => {
    for (const model of ["LG6121F", "LG6151M"]) {
      const { writes, client } = fiberhomeRouter({ model });
      const check = newCheck();
      await client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, check));
      assert.equal(writes[0]?.method, model === "LG6151M" ? "app_set_cell_list" : "app_set_lockcell");
      assert.equal(check.readback, "match", model);
      await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), /unlock the cell first/);
      const unlock = newCheck();
      await client.withSession((s) => s.unlockAll(unlock));
      assert.equal(unlock.readback, "match", model);
    }
  });

  it("refuses to guess NR bands and reboots without a logout", async () => {
    const { store, writes, client, mock } = fiberhomeRouter();
    store["app_get_lockband"] = { lockBandEnable: "1", LTELockBAND: "1", NRLockBAND: 7 };
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), /choose the NR bands too/);
    const reboot = newCheck();
    await client.withSession((s) => s.reboot(reboot));
    assert.deepEqual(writes.at(-1), { method: "app_do_cmd", data: { key: "REBOOT_WEB" } });
    assert.equal(reboot.readback, "pending");
    assert.ok(!mock.requests.slice(-2).some((r) => r.body.includes("app_do_logout")));
    assert.deepEqual(await client.withSession((s) => s.identify()), { model: "LG6121F", softwareVersion: "RP0113", hardwareVersion: null });
    assert.equal((await client.withSession((s) => s.neighbours()))?.length, 2);
  });
});

describe("fiberhome: the cellular settings", () => {
  it("switches airplane mode with the app's own call and reads it back", async () => {
    const { client, writes } = fiberhomeRouter();
    const on = newCheck();
    await client.withSession((s) => cellularOf(s).setAirplaneMode(true, on));
    assert.deepEqual(writes.at(-1), { method: "app_set_airplane", data: { airplaneOn: "1" } });
    assert.deepEqual(on, { endpoints: ["fiberhome:app_set_airplane"], readback: "match", reason: null });
    assert.equal((await client.withSession((s) => s.telemetry()))?.status?.airplaneMode, true, "the next poll shows it");
    const off = newCheck();
    await client.withSession((s) => cellularOf(s).setAirplaneMode(false, off));
    assert.deepEqual([writes.at(-1)?.data, off.readback], [{ airplaneOn: "0" }, "match"]);
    // A router that answers the write and keeps its radio as it was: said, not hidden
    const stuck = fiberhomeRouter({ airplaneSticks: true });
    const kept = newCheck();
    await stuck.client.withSession((s) => cellularOf(s).setAirplaneMode(true, kept));
    assert.deepEqual([kept.readback, kept.reason], ["mismatch", "differs"]);
  });

  it("sets the network mode with the pair of the notes' table, and has no pair for a 3G mode", async () => {
    const { client, writes, store } = fiberhomeRouter();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).read()), { networkMode: "auto" });
    for (const [mode, pair] of [
      ["lte", { networkMode: "0", ENDC: "1" }],
      ["nr_sa", { networkMode: "2", ENDC: "1" }],
      ["nr_nsa", { networkMode: "3", ENDC: "2" }],
      ["auto", { networkMode: "3", ENDC: "3" }],
    ] as const) {
      const check = newCheck();
      await client.withSession((s) => cellularOf(s).setNetworkMode(mode, check));
      assert.deepEqual(writes.at(-1), { method: "app_set_network_info", data: pair }, mode);
      assert.deepEqual(check, { endpoints: ["fiberhome:app_set_network_info"], readback: "match", reason: null }, mode);
    }
    const sent = writes.length;
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("wcdma", newCheck())), CpeControlValidationError);
    assert.equal(writes.length, sent);
    // A pair the table does not list reads as no known mode
    store["app_get_network_info"] = { networkMode: "9", ENDC: "0" };
    assert.deepEqual(await client.withSession((s) => cellularOf(s).read()), { networkMode: null });
    // The Pro series' notes define neither: its session offers no cellular settings
    assert.deepEqual(Object.keys((await client.withSession(async (s) => s.cellular)) ?? {}).sort(), ["read", "setAirplaneMode", "setNetworkMode"]);
  });
});

const OVERVIEW_HTML = `<html><body><div>设备型号: C2000 MAX</div><div>系统版本:1.9.2.n6</div><script>var a={};a['token']='a8f5f167f44f4964e6c998dee827110c';</script></body></html>`;

function nradioRouter(opts: { loginStatus?: number; noCookie?: boolean; overview?: string; nrTag?: "NR5GBand" | "NRBand"; overviewStatus?: unknown } = {}) {
  // A module that names its NR mask does so under one of two tags; one that names none locks LTE bands only
  const nrTag = opts.nrTag ?? null;
  const nrPart = (mask: string): string => (nrTag ? `<${nrTag}>${mask}</${nrTag}>` : "");
  let netMode = `<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7FFFFFFFFFFFFFFF</LTEBand>${nrPart("7FFFFFFFFFFFFFFF")}</response>`;
  const posts: Array<{ path: string; body: string; token: string | null }> = [];
  const mock = new LanRouterMock((req) => {
    if (req.method === "POST" && req.path === "/cgi-bin/luci") {
      const form = LanRouterMock.form(req);
      if (opts.loginStatus) return { status: opts.loginStatus, text: "<form><input name=luci_password></form>" };
      if (form.get("luci_username") !== "root" || form.get("luci_password") !== PASSWORD) return { status: 200, text: "<p>密码错误</p>" };
      return { status: 302, headers: { location: "/cgi-bin/luci" }, setCookie: opts.noCookie ? [] : ["sysauth=0123456789abcdef0123456789abcdef; path=/cgi-bin/luci"] };
    }
    if (!req.headers["cookie"]?.includes("sysauth=")) return { status: 403, text: "" };
    if (req.path === "/cgi-bin/luci/nradio/system/overview") return { text: opts.overview ?? OVERVIEW_HTML };
    if (req.path === "/cgi-bin/luci/nradio/system/overview_status") return opts.overviewStatus === undefined ? { status: 404, text: "" } : { json: opts.overviewStatus };
    if (req.path === "/cgi-bin/luci/nradio/status/runtime/wan,cpe_4") {
      return { json: { wan: { up: false, download: "0", upload: "0" }, cpe_4: { up: true, uptime: 86425, isp: "Three", mode: "NR", ipaddr: "198.51.100.42", ipv6addr: "2001:db8::42/64", rsrp: "-79 dBm", rsrq: "-10 dB", sinr: "26 dB", pci: "0x8e", tac: "0x2711", cell: "134217758", earfcn: "650000", band: "78", download: "15849203712", upload: "2194810368" } } };
    }
    if (req.path === "/cgi-bin/luci/nradioadv/cellular/cpestatus/scaninfo") return { json: { code: 0, result: { neighbour: [[{ BAND: "78", EARFCN: "650000", PCI: "211", RSRP: "-88", RSRQ: "-13" }, { BAND: "1", EARFCN: "300", PCI: "0xd3", RSRP: "-95", RSRQ: "-12" }]] } } };
    if (req.path === "/api/net/net-mode" && req.method === "GET") return { text: netMode };
    if (req.path === "/api/device/information" && req.method === "GET") return { text: "<response><DeviceName>module</DeviceName><HardwareVersion>HW1.0</HardwareVersion></response>" };
    if (req.path === "/cgi-bin/luci/nradio/logout") return { status: 302, headers: { location: "/" } };
    posts.push({ path: req.path, body: req.body, token: req.query.get("token") });
    if (req.path === "/api/net/net-mode") {
      netMode = `<response><NetworkMode>${getXmlTag(req.body, "NetworkMode") ?? ""}</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>${getXmlTag(req.body, "LTEBand") ?? ""}</LTEBand>${nrTag ? nrPart(getXmlTag(req.body, nrTag) ?? "") : ""}</response>`;
      return { text: "<response>OK</response>" };
    }
    if (req.path === "/api/net/lock-freq") return { text: "<response>OK</response>" };
    if (req.path === "/cgi-bin/luci/admin/system/reboot/call") return { status: 200, text: "" };
    return { status: 404, text: "" };
  });
  const client = new DriverCpeClient({ protocol: nradioProtocol, cpeUrl: "http://192.168.66.1", cpeUsername: "root", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, posts, client };
}

describe("nradio: session and readings", () => {
  it("logs in with the LuCI form, reads the overview, and logs out", async () => {
    const { mock, client } = nradioRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual(mock.trail, [
      "POST /cgi-bin/luci",
      "GET /cgi-bin/luci/nradio/system/overview",
      "GET /cgi-bin/luci/nradio/status/runtime/wan,cpe_4",
      // The system overview (uptime, load, identifiers) in the same session
      "GET /cgi-bin/luci/nradio/system/overview_status",
      "GET /cgi-bin/luci/nradio/logout",
    ]);
    // The password goes in the form body, never in the URL
    assert.ok(!mock.requests[0]?.query.has("luci_password"));
    assert.equal(t?.model, "C2000 MAX");
    assert.equal(t?.mode, "SA");
    assert.deepEqual([t?.nr?.pci, t?.nr?.tac, t?.nr?.rsrpDbm, t?.nr?.sinrDb], [142, "10001", -79, 26]);
    assert.equal(t?.traffic?.totalDownloadBytes, 15849203712n);
    assert.equal(t?.wan.uptimeSec, 86425);
    assert.equal(t?.wan.ipv6, "2001:db8::42");
  });

  it("latches on a refused password and anything it cannot place", async () => {
    const wrong = nradioRouter();
    const c = new DriverCpeClient({ protocol: nradioProtocol, cpeUrl: "http://192.168.66.1", cpePassword: "nope", fetchImpl: wrong.mock.fetchImpl });
    await assert.rejects(c.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    const denied = nradioRouter({ loginStatus: 403 });
    await assert.rejects(denied.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    const odd = nradioRouter({ noCookie: true });
    await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
  });

  it("reads the overview without regular expressions and nearby cells from the scan", () => {
    assert.deepEqual(parseNradioOverview(OVERVIEW_HTML), { model: "C2000 MAX", version: "1.9.2.n6", token: "a8f5f167f44f4964e6c998dee827110c" });
    assert.deepEqual(parseNradioOverview("<p>nothing</p>"), { model: null, version: null, token: null });
    // Newer builds carry the token as JSON; anything that is not a token is not taken for one
    assert.equal(parseNradioOverview('<script>var cfg={"token":"0123456789abcdef0123456789abcdef"};</script>').token, "0123456789abcdef0123456789abcdef");
    assert.equal(parseNradioOverview('<script>var cfg={"token":"not a token!"};</script>').token, null);
    assert.equal(textAfter("a: b", "a:", "<"), null);
    assert.equal(textAfter(`x:${"y".repeat(100)}<`, "x:", "<"), null);
    assert.deepEqual(
      parseNradioNeighbours({ result: { neighbour: [{ BAND: "1", EARFCN: "300", PCI: "211", RSRP: "-95" }, "junk"] } })?.map((n) => [n.rat, n.band, n.pci]),
      [["LTE", 1, 211]]
    );
    assert.equal(parseNradioNeighbours({ result: {} }), null);
    const lte = parseNradioTelemetry({ cpe_4: { mode: "LTE", band: "1", earfcn: "300", pci: "211", rsrp: "-85 dBm", up: "yes" } }, { model: null, version: null, token: null });
    assert.deepEqual([lte.mode, lte.lte?.pci, lte.nr, lte.wan.connected], ["LTE", 211, null, null]);
    assert.equal(parseNradioTelemetry({}, { model: null, version: null, token: null }).traffic, null);
    // Some firmware writes the PLMN where the operator's name goes
    const numeric = parseNradioTelemetry({ cpe_4: { mode: "LTE", isp: "46000" } }, { model: null, version: null, token: null });
    assert.deepEqual([numeric.operatorName, numeric.plmn], ["CMCC", "46000"]);
    const named = parseNradioTelemetry({ cpe_4: { mode: "LTE", isp: "Three" } }, { model: null, version: null, token: null });
    assert.deepEqual([named.operatorName, named.plmn], ["Three", null]);
  });

  it("scans nearby cells in a session", async () => {
    const { client, mock } = nradioRouter();
    const cells = await client.withSession((s) => s.neighbours());
    assert.deepEqual(
      cells?.map((n) => [n.rat, n.band, n.arfcn, n.pci]),
      [
        ["NR", 78, 650000, 211],
        ["LTE", 1, 300, 211],
      ]
    );
    mock.handler = ((inner) => (req) => (req.path.endsWith("scaninfo") ? { json: { code: 1 } } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.neighbours()), CpeAnswerFormatError);
  });
});

describe("nradio: writes", () => {
  it("locks LTE bands through the module bridge with the request token, keeping what it reports", async () => {
    const { posts, client } = nradioRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: null, networkMode: "lte" }, check));
    assert.equal(posts[0]?.token, "a8f5f167f44f4964e6c998dee827110c");
    assert.match(posts[0]?.body ?? "", /<request><NetworkMode>03<\/NetworkMode><NetworkBand>3FFFFFFF<\/NetworkBand><LTEBand>5<\/LTEBand><\/request>/);
    assert.equal(check.readback, "match");
    // This module reports no NR mask: an NR lock has no tag to go under, and the LTE lock sends none
    const before = posts.length;
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: [78], networkMode: null }, newCheck())), (err: unknown) => err instanceof CpeControlValidationError && /LTE bands only/.test(err.message));
    assert.equal(posts.length, before, "refused before anything was written");
    assert.ok(!(posts[0]?.body ?? "").includes("NR"));
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.match(posts.at(-3)?.body ?? "", new RegExp(`<NetworkMode>00</NetworkMode>.*<LTEBand>${NRADIO_LTE_ALL_MASK}</LTEBand>`));
    assert.equal(unlock.readback, "match");
  });

  it("locks NR bands under the tag the module reports, switches to the 5G modes, and unlocks both RATs", async () => {
    for (const nrTag of ["NR5GBand", "NRBand"] as const) {
      const { posts, client } = nradioRouter({ nrTag });
      const check = newCheck();
      await client.withSession((s) => s.setBandLock({ lte: "all", nr: [41, 78], networkMode: "nr_sa" }, check));
      // n41 + n78 as one mask (bit 0 is band 1), uppercase, no 0x; 0801 is 5G standalone only
      assert.match(posts[0]?.body ?? "", new RegExp(`<request><NetworkMode>0801</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>${NRADIO_ALL_MASK}</LTEBand><${nrTag}>20000000010000000000</${nrTag}></request>`), nrTag);
      assert.deepEqual([check.readback, check.reason], ["match", null]);
      const locked = await client.withSession((s) => s.lockState());
      assert.deepEqual([locked?.lteBands, locked?.nrBands, locked?.networkMode], ["all", [41, 78], "nr_sa"]);

      // A lock of LTE bands alone sends the NR mask back as the router reports it
      await client.withSession((s) => s.setBandLock({ lte: [3], nr: null, networkMode: "nr_nsa" }, newCheck()));
      assert.match(posts.at(-1)?.body ?? "", new RegExp(`<NetworkMode>0802</NetworkMode>.*<LTEBand>4</LTEBand><${nrTag}>20000000010000000000</${nrTag}>`));

      const unlock = newCheck();
      await client.withSession((s) => s.unlockAll(unlock));
      assert.match(posts.at(-3)?.body ?? "", new RegExp(`<NetworkMode>00</NetworkMode>.*<LTEBand>${NRADIO_ALL_MASK}</LTEBand><${nrTag}>${NRADIO_ALL_MASK}</${nrTag}>`));
      assert.equal(unlock.readback, "match");
      assert.deepEqual((await client.withSession((s) => s.lockState()))?.nrBands, "all");
    }
    assert.deepEqual(nradioNrMask("<response><NRBand>10000000000</NRBand></response>"), { tag: "NRBand", hex: "10000000000" });
    assert.equal(nradioNrMask("<response><NR5GBand></NR5GBand><LTEBand>5</LTEBand></response>"), null);
    assert.deepEqual(parseNradioLockState("<response><NetworkMode>0802</NetworkMode><LTEBand>5</LTEBand><NR5GBand>10000000000</NR5GBand></response>"), {
      lteBands: [1, 3],
      nrBands: [41],
      lteCell: null,
      nrCell: null,
      networkMode: "nr_nsa",
      supportedLte: null,
      supportedNr: null,
    });
  });

  it("locks a cell with the spacing code it needs, and says it cannot read that back", async () => {
    const { posts, client } = nradioRouter();
    const check = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, check));
    assert.match(posts[0]?.body ?? "", /<mode>1<\/mode><enable>2<\/enable><scstype>1<\/scstype><freq>650000<\/freq><band>78<\/band><cellid>142<\/cellid>/);
    assert.deepEqual([check.readback, check.reason], ["unknown", "unreadable"]);
    const lte = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, lte));
    assert.ok(!(posts.at(-1)?.body ?? "").includes("scstype"));
  });

  it("refuses to write without a request token or what to send back, and reboots", async () => {
    const tokenless = nradioRouter({ overview: "<div>设备型号:C2000</div>" });
    await assert.rejects(tokenless.client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, newCheck())), /no request token/);
    await assert.rejects(tokenless.client.withSession((s) => s.reboot(newCheck())), /no request token/);
    const { client, posts, mock } = nradioRouter();
    mock.handler = ((inner) => (req) => (req.method === "GET" && req.path === "/api/net/net-mode" ? { text: "<response><LTEBand>5</LTEBand></response>" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), /refusing to write guessed values/);
    mock.handler = ((inner) => (req) => (req.method === "GET" && req.path === "/api/net/net-mode" ? { text: "<error><code>100003</code></error>" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.lockState()), (err: unknown) => err instanceof CpeApiError && err.code === "100003");
    const reboot = newCheck();
    await client.withSession((s) => s.reboot(reboot));
    assert.equal(posts.at(-1)?.path, "/cgi-bin/luci/admin/system/reboot/call");
    assert.equal(reboot.readback, "pending");
    // The module's hardware version through its bridge; a router without the bridge names none
    assert.deepEqual(await client.withSession((s) => s.identify()), { model: "C2000 MAX", softwareVersion: "1.9.2.n6", hardwareVersion: "HW1.0" });
    mock.handler = ((inner) => (req) => (req.path === "/api/device/information" ? { status: 404, text: "" } : inner(req)))(mock.handler);
    assert.equal((await client.withSession((s) => s.identify()))?.hardwareVersion, null);
    assert.deepEqual(parseNradioLockState("<response><NetworkMode>03</NetworkMode><LTEBand>5</LTEBand></response>").lteBands, [1, 3]);
  });

  it("reports a write the bridge refuses", async () => {
    const { client, mock } = nradioRouter();
    mock.handler = ((inner) => (req) => (req.method === "POST" && req.path === "/api/net/lock-freq" ? { text: "<error><code>112003</code></error>" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "112003");
    mock.handler = ((inner) => (req) => (req.method === "POST" && req.path === "/api/net/lock-freq" ? { text: "<response>NO</response>" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, newCheck())), CpeAnswerFormatError);
    mock.handler = ((inner) => (req) => (req.method === "POST" && req.path === "/api/net/lock-freq" ? { status: 500, text: "" } : inner(req)))(mock.handler);
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "http500");
  });
});

describe("fiberhome and nradio: the router's status", () => {
  it("fiberhome: reads airplane mode in the poll's session, and the link details of the base info", async () => {
    const { client } = fiberhomeRouter({ airplane: "1" });
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.status?.airplaneMode, true);
    assert.equal((await fiberhomeRouter({ airplane: "0" }).client.withSession((s) => s.telemetry()))?.status?.airplaneMode, false);
    assert.equal(fiberhomeAirplaneOf({ airplaneOn: "2" }), null);
    assert.equal(fiberhomeAirplaneOf("timeout"), null);
    // Under SA the transmit powers are the NR cell's; under LTE the LTE cell's, with its transmission mode
    const sa = parseFiberhomeTelemetry({ ...BASE_SA, PUSCH_TX_Power: "5", PUCCH_TX_Power: "-12", UlBandWidth: "100MHz", UlMimo: "2", QCI: "9", RRCStatus: "1" }).telemetry;
    assert.deepEqual([sa.nr?.puschTxDbm, sa.nr?.pucchTxDbm, sa.nr?.ulBandwidthMhz, sa.ulMimoLayers, sa.qci, sa.rrcConnected], [5, -12, 100, 2, 9, true]);
    const lte = parseFiberhomeTelemetry({ ...BASE_SA, WorkMode: "LTE", BAND: "1", EARFCN_NBR: "300", PCI_NBR: "211", RSRP: "-90", LTEDlTM: "4", PUSCH_TX_Power: "7", RRCStatus: "0", QCI: "0" }).telemetry;
    assert.deepEqual([lte.lte?.transmissionMode, lte.lte?.puschTxDbm, lte.rrcConnected, lte.qci], ["TM4", 7, false, null]);
  });

  it("fiberhome Pro: names its 4G and 5G modem temperatures apart", () => {
    const t = parseFiberhomeProTelemetry({ Modem5GTemperature: "48000", Modem4GTemperature: "45500", RSRP: "-90", BAND: "1" });
    assert.deepEqual(t.temperatures, [
      { kind: "modem_4g", name: null, celsius: 45.5 },
      { kind: "modem_5g", name: null, celsius: 48 },
    ]);
    assert.equal(t.temperatureC, 48);
  });

  it("nradio: reads the overview of the notes (uptime, load, identifiers) in the poll's session, and nothing where there is none", async () => {
    const { client } = nradioRouter({ overviewStatus: { system: { uptime: 7200, cpu_usage: "12%", mem_usage: 40 }, modem: { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", msisdn: "" } } });
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual(t?.status?.system, { uptimeSec: 7200, cpuPercent: 12, memoryPercent: 40 });
    assert.deepEqual(t?.ids, { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", msisdn: null });
    // The flat form the notes' reader also accepts
    assert.equal(withNradioOverview(t!, { uptime: 60, cpu: "5", memory: "9", imei: "860000000000000" }).status?.system?.uptimeSec, 60);
    const none = await nradioRouter().client.withSession((s) => s.telemetry());
    assert.equal(none?.status, undefined, "no overview: no status");
    assert.equal(withNradioOverview(t!, "<html>"), t);
  });
});
