import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeAnswerFormatError, CpeApiError } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { bandsToHex } from "../src/drivers/bands.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError, sha256Hex } from "../src/drivers/login.ts";
import {
  lteRsrpOfIndex,
  lteRsrqOfIndex,
  lteSinrOfIndex,
  nrRsrpOfIndex,
  nrRsrqOfIndex,
  nrSinrOfIndex,
  parseBandClauses,
  parsePinsuLockState,
  parsePinsuTelemetry,
  pinsuBandClauses,
  pinsuLoginFields,
  pinsuProtocol,
  rssiOfIndex,
} from "../src/drivers/pinsu.ts";
import { TOZED_LOGIN_SESSION, parseTozedLockState, parseTozedNeighbours, parseTozedTelemetry, tozedLoginPassword, tozedProtocol } from "../src/drivers/tozed.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";

const PASSWORD = "test-password";

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

function pinsuRouter(opts: { loginStatus?: string; login?: Record<string, unknown>; refuse?: string; noSync?: boolean } = {}) {
  const values: Record<string, string> = {
    mnet_sysmode: "lte",
    mnet_rsrp: "58",
    mnet_wnw_band: "1",
    mnet_wnw_pci: "211",
    mnet_band_lock_list: "lte:B1,B3,B5,B8,B38,B41;nr5g:N1,N28,N41,N78",
    mnet_band_lock_type: "unlock,unlock",
    mnet_band_lock_info: "",
    mnet_cell_lock_info: "",
    mnet_acqorder: "auto",
  };
  const actions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const expected = pinsuLoginFields("admin", PASSWORD);
  let loggedIn = false;
  const mock = new LanRouterMock((req) => {
    const body = req.body === "" ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    if (req.path === "/goform/sync") return opts.noSync ? { status: 404, text: "<html>Not Found</html>" } : { json: { retcode: "0" } };
    if (req.path === "/goform/get_login_info") return { json: { retcode: "0", loginStatus: opts.loginStatus ?? "0" } };
    if (req.path === "/goform/login") {
      if (opts.login) return { json: opts.login };
      if (body["username"] !== expected.username || body["password"] !== expected.password) return { json: { retcode: "201", remain_times: "4" } };
      loggedIn = true;
      return { json: { retcode: "0" }, setCookie: ["sid=pinsu; Path=/"] };
    }
    if (!loggedIn || req.headers["cookie"] !== "sid=pinsu") return { json: { retcode: "300" } };
    if (req.path === "/action/get_mgdb_params") {
      const out: Record<string, string> = { retcode: "0" };
      for (const key of body["keys"] as string[]) if (values[key] !== undefined) out[key] = values[key] ?? "";
      return { json: out };
    }
    actions.push({ path: req.path, body });
    if (req.path === `/action/${opts.refuse}`) return { json: { retcode: "5" } };
    if (req.path === "/action/logout") loggedIn = false;
    if (req.path === "/action/mnet_set_band_lock_switch") {
      values["mnet_band_lock_type"] = String(body["mnet_band_lock_type"]);
      values["mnet_band_lock_info"] = String(body["mnet_band_lock_info"]);
    }
    if (req.path === "/action/mnet_set_prefer_net_mode") values["mnet_acqorder"] = String(body["mnet_acqorder"]);
    if (req.path === "/action/mnet_set_celllock_switch") {
      const rat = body["mnet_cell_lock_rat"];
      if (rat === "3") values["mnet_cell_lock_info"] = `lte,${String(body["mnet_cell_lock_arfcn"])},${String(body["mnet_cell_lock_pci"])};nr5g,,,,`;
      if (rat === "4") values["mnet_cell_lock_info"] = `lte,,;nr5g,${String(body["mnet_cell_lock_arfcn"])},${String(body["mnet_cell_lock_pci"])},${String(body["mnet_cell_lock_band"])},${String(body["mnet_cell_lock_scs"])}`;
      if (rat === "13" || rat === "14") values["mnet_cell_lock_info"] = "lte,,;nr5g,,,,";
    }
    return { json: { retcode: "0" } };
  });
  const client = new DriverCpeClient({ protocol: pinsuProtocol, cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, values, actions, client };
}

describe("pinsu: indexes and login", () => {
  it("converts CESQ report indexes into dBm and dB", () => {
    assert.equal(lteRsrpOfIndex("58"), -82);
    assert.equal(lteRsrpOfIndex("-82"), -82);
    assert.equal(lteRsrpOfIndex("99"), null);
    assert.equal(lteRsrpOfIndex("x"), null);
    assert.equal(nrRsrpOfIndex("74"), -82);
    assert.equal(nrRsrpOfIndex("-90"), -90);
    assert.equal(nrRsrpOfIndex("255"), null);
    assert.equal(nrRsrpOfIndex(""), null);
    assert.equal(lteRsrqOfIndex("24"), -8);
    assert.equal(lteRsrqOfIndex("47"), null);
    assert.equal(nrRsrqOfIndex("66"), -10);
    assert.equal(nrRsrqOfIndex("128"), null);
    assert.equal(lteSinrOfIndex("161"), 12);
    assert.equal(lteSinrOfIndex("255"), null);
    assert.equal(nrSinrOfIndex("68"), 10.5);
    assert.equal(nrSinrOfIndex("255"), null);
    assert.equal(rssiOfIndex("45"), -65);
    assert.equal(rssiOfIndex("-65"), -65);
    assert.equal(rssiOfIndex("99"), null);
    assert.equal(rssiOfIndex(""), null);
  });

  it("sends the user name and password as HMAC-MD5 with the page's key", () => {
    assert.deepEqual(pinsuLoginFields("admin", "12345678"), { username: "4cc68e3626e5b94602c325f7c4ca5dee", password: "7f868cf13f8e5e2079b3df7b43d4995d" });
  });

  it("logs in, reads, and logs out, every call naming the login page", async () => {
    const { mock, client } = pinsuRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.lte?.rsrpDbm, -82);
    assert.deepEqual(mock.trail, ["POST /goform/sync", "POST /goform/get_login_info", "POST /goform/login", "POST /action/get_mgdb_params", "POST /action/logout"]);
    assert.ok(mock.requests.every((r) => r.headers["referer"] === "http://192.168.0.1/common/login.html" && r.headers["content-type"] === "application/json"));
    assert.deepEqual(await client.withSession((s) => s.identify()), { model: null, softwareVersion: null, hardwareVersion: null });
    await assert.rejects(client.withSession((s) => s.neighbours()), SectionUnavailableError);
  });

  it("sends no password to a router that does not answer the page's handshake", async () => {
    // Another brand at this address (the wrong choice in Settings): it is told apart before the login
    const other = pinsuRouter({ noSync: true });
    await assert.rejects(other.client.withSession((s) => s.telemetry()));
    assert.deepEqual(other.mock.trail, ["POST /goform/sync"]);
    assert.equal(other.client.getCircuitBreakerState().tripped, false, "nothing was tried, nothing latched");
  });

  it("takes a running countdown for a lock, whatever the attempts left say", async () => {
    const counting = pinsuRouter({ login: { retcode: "201", remain_secs: "240" } });
    await assert.rejects(counting.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
    assert.equal(counting.client.getCircuitBreakerState().waitTime, 240);
  });

  it("yields to someone on the router's page, and latches on a wrong password or a lock", async () => {
    const busy = pinsuRouter({ loginStatus: "1" });
    assert.equal((await busy.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    assert.ok(!busy.mock.requests.some((r) => r.path === "/goform/login"));
    const wrong = pinsuRouter({ login: { retcode: "201", remain_times: "3" } });
    await assert.rejects(wrong.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === 3);
    const locked = pinsuRouter({ login: { retcode: "201", remain_times: "0", remain_secs: "300" } });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 300);
    const odd = pinsuRouter({ login: { retcode: "9" } });
    await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
    const broken = new LanRouterMock(() => ({ text: "<html>" }));
    const c = new DriverCpeClient({ protocol: pinsuProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: broken.fetchImpl });
    await assert.rejects(c.withSession((s) => s.telemetry()), CpeAnswerFormatError);
  });
});

describe("pinsu: readings and locks", () => {
  it("maps LTE, EN-DC and standalone polls by the serving mode", () => {
    const lte = parsePinsuTelemetry({ mnet_sysmode: "lte", mnet_rsrp: "58", mnet_rsrq: "24", mnet_snr: "161", mnet_rssi: "45", mnet_wnw_band: "1", mnet_wnw_pci: "211", mnet_operator_name: "Three", statistics_rx_bytes: "2948105728", statistics_tx_bytes: "158392041" });
    assert.equal(lte.mode, "LTE");
    assert.deepEqual([lte.lte?.band, lte.lte?.pci, lte.lte?.rsrpDbm, lte.lte?.rsrqDb, lte.lte?.sinrDb, lte.lte?.rssiDbm], [1, 211, -82, -8, 12, -65]);
    assert.equal(lte.traffic?.totalDownloadBytes, 2948105728n);
    assert.equal(lte.operatorName, "Three");
    const endc = parsePinsuTelemetry({ mnet_sysmode: "lte", mnet_rsrp: "58", mnet_wnw_band: "1", mnet_wnw_psband: "78", mnet_wnw_pspci: "142", mnet_endc_rsrp: "72", mnet_endc_rsrq: "65", mnet_endc_snr: "68" });
    assert.equal(endc.mode, "NSA");
    assert.deepEqual([endc.nr?.band, endc.nr?.pci, endc.nr?.rsrpDbm, endc.nr?.rsrqDb, endc.nr?.sinrDb], [78, 142, -84, -10.5, 10.5]);
    const sa = parsePinsuTelemetry({ mnet_sysmode: "nr5g", mnet_rsrp: "74", mnet_rsrq: "66", mnet_snr: "68", mnet_sinr: "14", mnet_wnw_band: "78", mnet_wnw_pci: "142" });
    assert.equal(sa.mode, "SA");
    assert.equal(sa.lte, null);
    assert.deepEqual([sa.nr?.rsrpDbm, sa.nr?.sinrDb], [-82, 14]);
    assert.equal(parsePinsuTelemetry({ mnet_sysmode: "wcdma" }).mode, "WCDMA");
    assert.equal(parsePinsuTelemetry({ mnet_sysmode: "none" }).mode, "NONE");
    assert.equal(parsePinsuTelemetry({}).mode, null);
  });

  it("reads and writes band clauses, cell locks and the network mode", () => {
    assert.deepEqual(parseBandClauses("lte:B1,B3;nr5g:N41,N78"), { lte: [1, 3], nr: [41, 78] });
    assert.deepEqual(parseBandClauses(""), { lte: null, nr: null });
    assert.equal(pinsuBandClauses([3, 1], [78, 41]), "lte:B1,B3;nr5g:N41,N78");
    assert.equal(pinsuBandClauses([], [78]), "nr5g:N78");
    assert.equal(pinsuBandClauses([], []), "");
    const state = parsePinsuLockState({ mnet_band_lock_type: "lock,unlock", mnet_band_lock_info: "lte:B1,B3", mnet_band_lock_list: "lte:B1,B3;nr5g:N78", mnet_cell_lock_info: "lte,300,211;nr5g,650000,142,78,30", mnet_acqorder: "5g only" });
    assert.deepEqual(state.lteBands, [1, 3]);
    assert.equal(state.nrBands, "all");
    assert.deepEqual(state.lteCell, { locked: true, arfcn: 300, pci: 211, band: null });
    assert.deepEqual(state.nrCell, { locked: true, arfcn: 650000, pci: 142, band: 78 });
    assert.equal(state.networkMode, "nr_sa");
    assert.deepEqual(state.supportedNr, [78]);
    const open = parsePinsuLockState({ mnet_band_lock_type: "lock,odd", mnet_cell_lock_info: "lte,,;nr5g,,,," });
    assert.equal(open.lteBands, null);
    assert.equal(open.nrBands, null);
    assert.deepEqual(open.lteCell, { locked: false });
    assert.equal(parsePinsuLockState({}).lteCell, null);
    assert.deepEqual(parsePinsuLockState({ mnet_cell_lock_info: "" }).nrCell, { locked: false });
  });

  it("locks bands within the router's own list and reads them back", async () => {
    const { actions, client } = pinsuRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [3, 1], nr: [78], networkMode: "lte" }, check));
    assert.deepEqual(actions.slice(0, 2), [
      { path: "/action/mnet_set_band_lock_switch", body: { mnet_band_lock_type: "lock,lock", mnet_band_lock_info: "lte:B1,B3;nr5g:N78" } },
      { path: "/action/mnet_set_prefer_net_mode", body: { mnet_acqorder: "4g only", mnet_band: "auto", mnet_scan_mode: "auto" } },
    ]);
    assert.equal(check.readback, "match");
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [7], nr: null, networkMode: null }, newCheck())), /not one this router supports/);
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: "nr_nsa" }, newCheck())), CpeControlValidationError);
    // NR left as it is keeps the bands the router reports
    const keep = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, keep));
    assert.deepEqual(actions.at(-2)?.body, { mnet_band_lock_type: "lock,lock", mnet_band_lock_info: "lte:B1;nr5g:N78" });
    assert.equal(keep.readback, "match");
  });

  it("refuses to guess NR bands it cannot read, and reports a refused write", async () => {
    const { values, client } = pinsuRouter({ refuse: "mnet_set_band_lock_switch" });
    values["mnet_band_lock_type"] = "lock,lock";
    values["mnet_band_lock_info"] = "lte:B1";
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), /choose the NR bands too/);
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: "all", nr: "all", networkMode: null }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "5");
  });

  it("locks cells, unlocks everything that is locked, and reboots", async () => {
    const { actions, client } = pinsuRouter();
    const lte = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, lte));
    assert.equal(lte.readback, "match");
    const nr = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: null }, nr));
    assert.equal(nr.readback, "match");
    assert.equal(actions.find((a) => a.body["mnet_cell_lock_rat"] === "4")?.body["mnet_cell_lock_scs"], "30");
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "NR", band: 257, arfcn: 2054166, pci: 1, scsKhz: null }, newCheck())), /15 or 30 kHz/);
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.deepEqual(unlock.endpoints, ["pinsu:mnet_set_celllock_switch"]);
    assert.equal(unlock.readback, "match");
    const reboot = newCheck();
    await client.withSession((s) => s.reboot(reboot));
    assert.equal(actions.at(-1)?.path, "/action/reboot");
    assert.equal(reboot.readback, "pending");
  });
});

function tozedRouter(opts: { login?: Record<string, unknown>; token?: string | null; refuse?: number } = {}) {
  const token = opts.token === undefined ? "a1b2c3d4e5f60718293a4b5c6d7e8f90" : opts.token;
  const sid = "7c9e1a00000000000000000000000000000000000000000000000000000000ff";
  const state: Record<string, Record<string, unknown>> = {
    161: { band_4g_switch: "0", band_5g_switch: "0", all_band_4g: bandsToHex([1, 3, 5, 7, 8, 20, 38, 40, 41]), all_band_5g: bandsToHex([1, 3, 28, 41, 78, 79]), band_4g_mask: "", band_5g_mask: "" },
    160: { lte_lock_sw: "0", lte_lock_freq: "", lte_lock_pci: "", nr_lock_sw: "0", nr_lock_freq: "", nr_lock_pci: "" },
    218: { networkMode: "131", mode5g: "1" },
  };
  const posts: Array<Record<string, unknown>> = [];
  const mock = new LanRouterMock((req) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const cmd = body["cmd"];
    if (cmd === 232) return { json: { success: true, cmd, ...(token === null ? {} : { token }) } };
    if (cmd === 100) {
      if (opts.login) return { json: opts.login };
      return body["sessionId"] === TOZED_LOGIN_SESSION && body["passwd"] === tozedLoginPassword(token ?? "", PASSWORD) ? { json: { success: true, cmd, sessionId: sid } } : { json: { success: false, cmd, res: "login_fail", login_times: "1" } };
    }
    if (body["sessionId"] !== sid) return { json: { success: false, cmd } };
    if (body["method"] === "GET") {
      if (cmd === 205) return { json: { success: true, cmd, network_type_str: "5G(SA)", currentband_5g: "78", RSRP_5G: "-79", PCI_5G: "142", FREQ_5G: "650000", CELL_ID_5G: "1000", bandwidth_5g: "100MHz", RSRP: "-", flow_dl: "1548.62", flow_ul: "312.45", mon_total_flow: "48920.18", signal_lvl: "5", network_operator: "27201" } };
      if (cmd === 207) return { json: { success: true, cmd, board_type: "VN007+", real_fwversion: "2.10.22", "apcpu0-thmzone": "54200" } };
      if (cmd === 282) return { json: { success: true, cmd, lte_info: "1850,142,-85,-9,-58;", nr_info: "650000,142,-79,-10,24;bad" } };
      return { json: { success: true, cmd, ...state[String(cmd)] } };
    }
    posts.push(body);
    if (cmd === opts.refuse) return { json: { success: false, cmd } };
    if (cmd === 161) {
      state[161] = { ...state[161], band_4g_switch: body["band4gRadio"], band_5g_switch: body["band5gRadio"], band_4g_mask: body["lock4gBand"], band_5g_mask: body["lock5gBand"] };
    }
    if (cmd === 160 && body["subcmd"] === 0) state[160] = { ...state[160], lte_lock_sw: body["lte_lock_sw"], lte_lock_freq: body["lte_lock_freq"], lte_lock_pci: body["lte_lock_pci"] };
    if (cmd === 160 && body["subcmd"] === 1) state[160] = { ...state[160], nr_lock_sw: body["nr_lock_sw"], nr_lock_freq: body["nr_lock_freq"], nr_lock_pci: body["nr_lock_pci"] };
    if (cmd === 218) state[218] = { networkMode: body["networkMode"], mode5g: body["mode5g"] };
    return { json: { success: true, cmd } };
  });
  const client = new DriverCpeClient({ protocol: tozedProtocol, cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, posts, client };
}

describe("tozed: login and readings", () => {
  it("hashes the one-time token with the password", () => {
    assert.equal(tozedLoginPassword("a1b2c3d4e5f60718293a4b5c6d7e8f90", "admin"), sha256Hex("a1b2c3d4e5f60718293a4b5c6d7e8f90admin"));
  });

  it("logs in with the token, carries the session id, and logs out with cmd 101", async () => {
    const { mock, client } = tozedRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual(
      mock.requests.map((r) => (JSON.parse(r.body) as { cmd: number }).cmd),
      [232, 100, 205, 207, 101]
    );
    assert.ok(mock.requests.every((r) => r.path === "/cgi-bin/http.cgi" && r.headers["referer"] === "http://192.168.0.1/"));
    assert.equal(t?.mode, "SA");
    assert.equal(t?.model, "VN007+");
    assert.equal(t?.nr?.bandwidthMhz, 100);
    assert.equal(t?.nr?.cellId, "4096");
    assert.equal(t?.temperatureC, 54.2);
    assert.equal(t?.plmn, "27201");
    assert.equal(t?.traffic?.totalDownloadBytes, BigInt(Math.round(1548.62 * 1024 * 1024)));
    assert.equal(t?.traffic?.monthTotalBytes, BigInt(Math.round(48920.18 * 1024 * 1024)));
    assert.deepEqual(await client.withSession((s) => s.identify()), { model: "VN007+", softwareVersion: "2.10.22", hardwareVersion: null });
  });

  it("tells a lock from a wrong password by the exact answer", async () => {
    const locked = tozedRouter({ login: { success: false, cmd: 100, res: "login_fail2", login_time: "180" } });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 180);
    const wrong = tozedRouter({ login: { success: false, cmd: 100, res: "login_fail", login_times: "1" } });
    await assert.rejects(wrong.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    const odd = tozedRouter({ login: { success: true, cmd: 100 } });
    await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
    const tokenless = tozedRouter({ token: null });
    await assert.rejects(tokenless.client.withSession((s) => s.telemetry()), DriverLoginMethodError);
  });

  it("maps EN-DC readings, nearby cells and a temperature in °C", () => {
    const t = parseTozedTelemetry(
      { network_type_str: "4G", currentband: "1", FREQ: "300", PCI: "211", CELL_ID: "800001e", RSRP: "-80", RSRQ: "-9", SINR: "15", bandwidth: "20MHz", CQI: "12", dl_mcs: "27", ul_mcs: "20", rank_4g: "2", currentband_5g: "78", FREQ_5G: "650000", PCI_5G: "142", RSRP_5G: "-85", flow_dl: "-", mon_total_flow: "" },
      { board_type: "ZLT X28", "apcpu0_thmzone": "54" }
    );
    assert.equal(t.mode, "NSA");
    assert.equal(t.lte?.cellId, "134217758");
    assert.equal(t.nr?.pci, 142);
    assert.equal(t.temperatureC, 54);
    assert.equal(t.traffic?.sessionDownloadBytes, null);
    assert.equal(parseTozedTelemetry({ network_type_str: "", RSRP_5G: "-" }, null).mode, null);
    assert.equal(parseTozedTelemetry({ network_type_str: "3G" }, null).mode, "WCDMA");
    assert.deepEqual(
      parseTozedNeighbours({ lte_info: "1850,142,-85,-9,-58;", nr_info: "650000,142,-79,-10,24;1,2" }).map((n) => [n.rat, n.band, n.arfcn, n.pci, n.rssiDbm, n.sinrDb]),
      [
        ["LTE", 3, 1850, 142, -58, null],
        ["NR", 78, 650000, 142, null, 24],
      ]
    );
  });
});

describe("tozed: locks", () => {
  it("reads masks, switches, cell locks and the mode back", () => {
    const state = parseTozedLockState(
      { band_4g_switch: "1", band_4g_mask: "5", band_5g_switch: "0", all_band_4g: "x", all_band_5g: "" },
      { lte_lock_sw: "1", lte_lock_freq: "300", lte_lock_pci: "211", nr_lock_sw: "2" },
      { networkMode: "3", mode5g: "0" }
    );
    assert.deepEqual(state.lteBands, [1, 3]);
    assert.equal(state.nrBands, "all");
    assert.deepEqual(state.lteCell, { locked: true, arfcn: 300, pci: 211, band: null });
    assert.equal(state.nrCell, null);
    assert.equal(state.networkMode, "lte");
    assert.equal(state.supportedLte, null);
    assert.equal(parseTozedLockState({ band_4g_switch: "1", band_4g_mask: "" }, {}, {}).lteBands, null);
  });

  it("locks bands as bare hexadecimal within what the modem supports", async () => {
    const { posts, client } = tozedRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: [41, 78], networkMode: "nr_nsa" }, check));
    assert.deepEqual(posts[0], { cmd: 161, method: "POST", band5gRadio: "1", band4gRadio: "1", lock5gBand: "20000000010000000000", lock4gBand: "5", language: "CN", sessionId: posts[0]?.["sessionId"] });
    assert.deepEqual(posts[1], { cmd: 218, method: "POST", networkMode: "131", mode5g: "0", language: "CN", sessionId: posts[1]?.["sessionId"] });
    assert.deepEqual(check, { endpoints: ["tozed:cmd161", "tozed:cmd218"], readback: "match", reason: null });
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [2], nr: null, networkMode: null }, newCheck())), /not one this router supports/);
    const keep = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: "all", nr: null, networkMode: null }, keep));
    const last = posts.filter((p) => p["cmd"] === 161).at(-1);
    assert.deepEqual([last?.["band4gRadio"], last?.["lock5gBand"]], ["0", "20000000010000000000"]);
    assert.equal(keep.readback, "match");
  });

  it("locks and unlocks cells by sub-command, reboots, and reports a refusal", async () => {
    const { posts, client, state } = tozedRouter({ refuse: 6 });
    const lock = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, lock));
    assert.deepEqual(lock.endpoints, ["tozed:cmd160.1"]);
    assert.equal(lock.readback, "match");
    const lteLock = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, lteLock));
    assert.equal(lteLock.readback, "match");
    state[218] = { networkMode: "3", mode5g: "0" };
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.deepEqual(unlock.endpoints, ["tozed:cmd160.0", "tozed:cmd160.1", "tozed:cmd218"]);
    assert.equal(unlock.readback, "match");
    assert.ok(posts.length > 0);
    await assert.rejects(client.withSession((s) => s.reboot(newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "cmd6");
    state[161] = { band_4g_switch: "1", band_4g_mask: "5", band_5g_switch: "1", band_5g_mask: "" };
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), /choose the NR bands too/);
  });

  it("reboots and sends nothing after", async () => {
    const { mock, client } = tozedRouter();
    const check = newCheck();
    await client.withSession((s) => s.reboot(check));
    assert.equal((JSON.parse(mock.requests.at(-1)?.body ?? "{}") as { cmd: number }).cmd, 6);
    assert.equal(check.readback, "pending");
  });
});
