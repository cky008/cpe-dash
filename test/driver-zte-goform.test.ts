import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeApiError } from "../src/cpe-client.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError, md5Hex, sha256Hex } from "../src/drivers/login.ts";
import {
  ZTE_LTE_ALL_MASK,
  ZTE_NR_ALL_BANDS,
  parseZteGoformTelemetry,
  parseZteLockState,
  parseZteNeighbours,
  zteActionDigest,
  zteBranch,
  zteCellForm,
  zteGoformProtocol,
  zteLoginMethodOf,
  zteLoginPassword,
  zteLteBandForm,
  zteNrBandForm,
} from "../src/drivers/zte-goform.ts";
import { LanRouterMock, type LanRequestRecord } from "./helpers/lan-router.ts";

const PASSWORD = "test-password";
const LD = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";
const VERSION = { modelName: "MC888", hardwareVersion: "MC888HW-1.0.0", waInnerVersion: "BD_ZTE_MC888V1.0.0B05", crVersion: "CR_ZTE_MC888V1.0.0B05" };

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

interface ZteState {
  loggedIn: boolean;
  rd: number;
  values: Record<string, string>;
  posts: Array<{ goformId: string; fields: URLSearchParams }>;
}

/** A goform router: versions, LD or config.js, a password, and lock values the writes change. */
function zteRouter(opts: { ld?: string | null; configJs?: string; hw?: string; model?: string; loginResult?: string; lock?: { left: string; wait: string } } = {}) {
  const ld = opts.ld === undefined ? LD : opts.ld;
  const hash = ld ? "sha256" : "md5";
  const version = { ...VERSION, hardwareVersion: opts.hw ?? VERSION.hardwareVersion, modelName: opts.model ?? VERSION.modelName };
  const expectedPassword = ld ? zteLoginPassword({ kind: "sha256-ld", ld }, PASSWORD) : opts.configJs?.includes("SHA256:1") ? zteLoginPassword({ kind: "sha256" }, PASSWORD) : zteLoginPassword({ kind: "base64" }, PASSWORD);
  const state: ZteState = {
    loggedIn: false,
    rd: 0,
    posts: [],
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
    },
  };
  const mock = new LanRouterMock((req: LanRequestRecord) => {
    if (req.method === "GET" && req.path === "/js/config/config.js") return opts.configJs === undefined ? { status: 404, text: "" } : { text: opts.configJs };
    if (req.method === "GET" && req.path === "/goform/goform_get_cmd_process") {
      const keys = (req.query.get("cmd") ?? "").split(",");
      const out: Record<string, string> = {};
      for (const key of keys) {
        if (key === "LD") out["LD"] = ld ?? "";
        else if (key === "RD") out["RD"] = `RD${++state.rd}`;
        else if (state.values[key] !== undefined) out[key] = state.values[key] ?? "";
        else out[key] = "";
      }
      return { json: out };
    }
    if (req.method === "POST" && req.path === "/goform/goform_set_cmd_process") {
      const fields = LanRouterMock.form(req);
      const goformId = fields.get("goformId") ?? "";
      if (goformId === "LOGIN") {
        if (opts.loginResult) return { json: { result: opts.loginResult } };
        if (fields.get("password") !== expectedPassword) return { json: { result: "3" } };
        state.loggedIn = true;
        return { json: { result: "0" }, setCookie: ["stok=abc123; Path=/; HttpOnly"] };
      }
      if (!state.loggedIn || !req.headers["cookie"]?.includes("stok=abc123")) return { json: { result: "failure" } };
      if (fields.get("AD") !== zteActionDigest(hash, version, `RD${state.rd}`)) return { json: { result: "failure" } };
      state.posts.push({ goformId, fields });
      if (goformId === "LOGOUT") state.loggedIn = false;
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
      return { json: { result: "success" } };
    }
    return { status: 404, text: "" };
  });
  const client = new DriverCpeClient({ protocol: zteGoformProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, client };
}

describe("zte-goform: login and digests", () => {
  it("computes the login password and AD the way the router's page does", () => {
    const inner = sha256Hex(PASSWORD).toUpperCase();
    assert.equal(zteLoginPassword({ kind: "sha256-ld", ld: LD }, PASSWORD), sha256Hex(`${inner}${LD}`).toUpperCase());
    assert.equal(zteLoginPassword({ kind: "sha256" }, PASSWORD), inner);
    assert.equal(zteLoginPassword({ kind: "base64" }, PASSWORD), Buffer.from(PASSWORD).toString("base64"));
    const seed = `${VERSION.waInnerVersion}${VERSION.crVersion}`;
    assert.equal(zteActionDigest("sha256", VERSION, "RD1"), sha256Hex(`${sha256Hex(seed).toUpperCase()}RD1`).toUpperCase());
    assert.equal(zteActionDigest("md5", VERSION, "RD1"), md5Hex(`${md5Hex(seed)}RD1`));
  });

  it("settles the method before any password goes out", () => {
    assert.deepEqual(zteLoginMethodOf(LD, null), { kind: "sha256-ld", ld: LD });
    assert.equal(zteLoginMethodOf("0123456789abcdef0123456789abcdef", null), null);
    assert.deepEqual(zteLoginMethodOf(null, "x WEB_ATTR_IF_SUPPORT_SHA256:1 y"), { kind: "sha256" });
    assert.deepEqual(zteLoginMethodOf(null, "var config = {}"), { kind: "base64" });
    assert.equal(zteLoginMethodOf(null, "WEB_ATTR_IF_SUPPORT_SHA256:2"), null);
    assert.equal(zteLoginMethodOf(null, null), null);
  });

  it("names the firmware branch from the hardware version", () => {
    assert.equal(zteBranch({ hardwareVersion: "MC801A_HW1.0", modelName: "MC801A" }), 1);
    assert.equal(zteBranch({ hardwareVersion: "MC888HW-1.0.0", modelName: "" }), 2);
    assert.equal(zteBranch({ hardwareVersion: "MC8830", modelName: "" }), 2);
    assert.equal(zteBranch({ hardwareVersion: "MC8020", modelName: "" }), 3);
    assert.equal(zteBranch({ hardwareVersion: "", modelName: "MU5250" }), 4);
  });

  it("logs in with the double SHA-256, reads, and logs out with a fresh AD", async () => {
    const { mock, state, client } = zteRouter();
    const telemetry = await client.withSession((s) => s.telemetry());
    assert.equal(telemetry?.lte?.pci, 211);
    assert.deepEqual(mock.trail, [
      "GET /goform/goform_get_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "POST /goform/goform_set_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "POST /goform/goform_set_cmd_process",
    ]);
    // Every goform request names the page it comes from
    assert.ok(mock.requests.every((r) => r.headers["referer"] === "http://192.168.0.1/index.html" && r.headers["x-requested-with"] === "XMLHttpRequest"));
    assert.deepEqual(state.posts.map((p) => p.goformId), ["LOGOUT"]);
    assert.equal(state.loggedIn, false);
  });

  it("logs in with the single SHA-256 or Base64 the page announces, and signs writes with MD5", async () => {
    for (const configJs of ["WEB_ATTR_IF_SUPPORT_SHA256:1", "var x = 1;"]) {
      const { state, client } = zteRouter({ ld: null, configJs });
      await client.withSession(async (s) => s.reboot(newCheck()));
      assert.deepEqual(state.posts.map((p) => p.goformId), ["REBOOT_DEVICE"]);
    }
  });

  it("sends no password for a nonce it does not know", async () => {
    const { mock, client } = zteRouter({ ld: "0123456789abcdef0123456789abcdef" });
    await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.ok(!mock.requests.some((r) => r.method === "POST"));
    assert.equal(client.getCircuitBreakerState().tripped, false);
  });

  it("latches the breaker on a wrong password and sends nothing more", async () => {
    const { mock, client } = zteRouter({ loginResult: "3" });
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === 5);
    const before = mock.requests.length;
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(mock.requests.length, before);
  });

  it("refuses to log in while the router's login is locked", async () => {
    const { mock, client } = zteRouter({ lock: { left: "0", wait: "300" } });
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 300);
    assert.ok(!mock.requests.some((r) => r.method === "POST"));
  });

  it("treats result 2 as a lock and result 4 as someone signed in elsewhere", async () => {
    const locked = zteRouter({ loginResult: "2" });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
    const busy = zteRouter({ loginResult: "4" });
    const outcome = await busy.client.withSessionDetailed((s) => s.telemetry());
    assert.equal(outcome.status, "yielded");
    assert.equal(busy.client.getCircuitBreakerState().tripped, false);
    const odd = zteRouter({ loginResult: "9" });
    await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
  });

  it("refuses a router that names no firmware version", async () => {
    const mock = new LanRouterMock(() => ({ json: {} }));
    const client = new DriverCpeClient({ protocol: zteGoformProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl });
    await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
  });
});

describe("zte-goform: telemetry", () => {
  const raw: Record<string, unknown> = {
    model_name: "MC888",
    hardware_version: "MC888HW-1.0.0",
    wa_inner_version: "BD_ZTE_MC888V1.0.0B05",
    network_type: "ENDC",
    network_provider: "Three",
    rmcc: "272",
    rmnc: "01",
    ppp_status: "ipv4_ipv6_connected",
    wan_ipaddr: "198.51.100.42",
    ipv6_wan_ipaddr: "2001:db8::42",
    signalbar: "4",
    wan_active_band: "LTE BAND 1",
    wan_active_channel: "300",
    lte_pci: "d3",
    cell_id: "0800001e",
    lac_code: "2711",
    lte_rsrp: "-81",
    lte_rsrq: "-8",
    lte_rssi: "-54",
    lte_snr: "19.2",
    lte_ca_pcell_bandwidth: "20.0",
    lte_rx0_rsrp: "-80",
    lte_rx1_rsrp: "-83",
    lte_rx2_rsrp: "",
    lte_rx3_rsrp: "-32768",
    wan_lte_ca: "ca_activated",
    lte_multi_ca_scell_info: "1,142,3,1850,20.0,0.0;",
    nr5g_action_band: "n78",
    nr5g_action_channel: "650000",
    nr5g_pci: "8e",
    Z5g_rsrp: "-76",
    Z5g_rsrq: "-10",
    Z5g_SINR: "25.5",
    nr5g_dl_bandwidth: "100",
    pm_sensor_mdm: "46",
    pm_modem_5g: "49",
    realtime_rx_thrpt: "15600000",
    realtime_tx_thrpt: "125000",
    realtime_rx_bytes: "1073741824",
    realtime_tx_bytes: "104857600",
    realtime_time: "86400",
    monthly_rx_bytes: "85899345920",
    monthly_tx_bytes: "5368709120",
    monthly_time: "999999",
  };

  it("maps an EN-DC poll: hexadecimal identities, four antennas, carriers, traffic and temperature", () => {
    const t = parseZteGoformTelemetry(raw);
    assert.equal(t.mode, "NSA");
    assert.equal(t.model, "MC888");
    assert.equal(t.plmn, "27201");
    assert.equal(t.lte?.band, 1);
    assert.equal(t.lte?.arfcn, 300);
    assert.equal(t.lte?.pci, 211);
    assert.equal(t.lte?.cellId, "134217758");
    assert.equal(t.lte?.tac, "10001");
    assert.deepEqual(t.lte?.rxRsrpDbm, [-80, -83, null, null]);
    assert.equal(t.nr?.pci, 142);
    assert.equal(t.nr?.arfcn, 650000);
    assert.deepEqual(t.carriers, [{ rat: "LTE", band: 3, arfcn: 1850, pci: 142, bandwidthMhz: 20, rsrpDbm: null, rsrqDb: null, rssiDbm: null, sinrDb: null }]);
    assert.equal(t.wan.connected, true);
    assert.equal(t.wan.ipv4, "198.51.100.42");
    assert.equal(t.traffic?.downloadBytesPerSec, 15600000);
    assert.equal(t.traffic?.monthDownloadBytes, 85899345920n);
    assert.equal(t.temperatureC, 49);
    assert.equal(t.signalBars, 4);
  });

  it("reads the other carrier layout the same way", () => {
    const t = parseZteGoformTelemetry({ ...raw, lte_multi_ca_scell_info: "1,142,1,3,1850,20.0;" });
    assert.deepEqual(
      t.carriers.map((c) => [c.band, c.arfcn, c.pci, c.bandwidthMhz]),
      [[3, 1850, 142, 20]]
    );
    assert.deepEqual(parseZteGoformTelemetry({ ...raw, wan_lte_ca: "ca_deactivated" }).carriers, []);
  });

  it("drops a dormant NR leg and the LTE cell of a standalone poll", () => {
    const dormant = parseZteGoformTelemetry({ ...raw, Z5g_rsrp: "-32768", Z5g_SINR: "-20.0" });
    assert.equal(dormant.nr, null);
    const sa = parseZteGoformTelemetry({ ...raw, network_type: "SA" });
    assert.equal(sa.lte, null);
    assert.equal(sa.nr?.band, 78);
  });

  it("falls back to the composite object and the flux counters", () => {
    const t = parseZteGoformTelemetry({
      network_information: { network_type: "SA", Nr_bands: "78", Nr_fcn: "650000", Nr_pci: "8e", nr_rsrp: "-90" },
      flux_realtime_rx_thrpt: "1000",
      flux_monthly_rx_bytes: "42",
      ppp_status: "ppp_disconnected",
      pm_sensor_pa1: "41",
    });
    assert.equal(t.mode, "SA");
    assert.equal(t.nr?.pci, 142);
    assert.equal(t.traffic?.downloadBytesPerSec, 1000);
    assert.equal(t.traffic?.monthDownloadBytes, 42n);
    assert.equal(t.wan.connected, false);
    assert.equal(t.temperatureC, 41);
  });

  it("reads nearby cells from a JSON list or packed rows, and says when there are none", () => {
    const json = parseZteNeighbours({ neighbor_cell_info: [{ band: "3", earfcn: "1850", pci: "142", rsrp: "-95", rsrq: "-12", sinr: "3" }, "junk"] });
    assert.deepEqual(json, [{ rat: "LTE", band: 3, arfcn: 1850, pci: 142, rsrpDbm: -95, rsrqDb: -12, rssiDbm: null, sinrDb: 3 }]);
    const rows = parseZteNeighbours({ neighbour_cell_list: "LTE,1,300,211,-90,-9,10;NR,78,650000,142,-99,-11,2;n78,650000,142,-99,-11,2;1850,142,-95,-12,3;x,y" });
    assert.deepEqual(
      rows?.map((n) => [n.rat, n.band, n.arfcn, n.pci]),
      [
        ["LTE", 1, 300, 211],
        ["NR", 78, 650000, 142],
        ["NR", 78, 650000, 142],
        ["LTE", 3, 1850, 142],
      ]
    );
    assert.equal(parseZteNeighbours({}), null);
  });
});

describe("zte-goform: locks", () => {
  it("builds each branch's band and cell lock forms", () => {
    assert.deepEqual(zteLteBandForm(1, [1, 3]), {
      goformId: "BAND_SELECT",
      fields: [
        ["is_gw_band", "0"],
        ["gw_band_mask", "0"],
        ["is_lte_band", "1"],
        ["lte_band_mask", "0x5"],
      ],
    });
    assert.deepEqual(zteLteBandForm(3, "all").fields[0], ["lte_band_lock", `0x${ZTE_LTE_ALL_MASK}`]);
    assert.deepEqual(zteLteBandForm(4, [1, 3]), { goformId: "LTE_BAND_LOCK", fields: [["lte_band_lock", "5"]] });
    assert.equal(zteNrBandForm(1, [78, 41]).fields[0]?.[1], "41,78");
    assert.equal(zteNrBandForm(2, [78]).goformId, "WAN_PERFORM_NR5G_BAND_LOCK_MERGE");
    assert.deepEqual(zteNrBandForm(3, [78]).fields[1], ["Z5g_lockband_type", "0"]);
    assert.equal(zteNrBandForm(4, [41, 78]).goformId, "NR_BAND_LOCK");
    const nrCell = { rat: "NR" as const, band: 78, arfcn: 650000, pci: 142, scsKhz: 30 as const };
    assert.deepEqual(zteCellForm(1, nrCell).fields, [["nr5g_cell_lock", "142,650000,78,1"]]);
    assert.deepEqual(zteCellForm(2, nrCell).fields[3], ["Z5g_lockcell_scs", "30"]);
    assert.deepEqual(zteCellForm(3, nrCell).fields[2], ["rat", "16"]);
    assert.deepEqual(zteCellForm(4, { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }).fields[2], ["rat", "12"]);
    assert.throws(() => zteCellForm(1, { ...nrCell, scsKhz: 60 }), CpeControlValidationError);
  });

  it("reads locks back, the firmware's 0 / 1 meaning no lock", () => {
    const state = parseZteLockState({ lte_band_lock: "0x5", nr5g_band_mask: "41,78", lte_pci_lock: "211", lte_earfcn_lock: "300", nr5g_cell_lock: "1,1,1,1", net_select: "Only_5G" });
    assert.deepEqual(state.lteBands, [1, 3]);
    assert.deepEqual(state.nrBands, [41, 78]);
    assert.deepEqual(state.lteCell, { locked: true, arfcn: 300, pci: 211, band: null });
    assert.deepEqual(state.nrCell, { locked: false });
    assert.equal(state.networkMode, "nr_sa");
    const open = parseZteLockState({ lte_band_lock: `0x${ZTE_LTE_ALL_MASK.toUpperCase()}`, Z5g_lockband_no_format_mask: ZTE_NR_ALL_BANDS.join(","), lte_earfcn_lock: "0", Z5g_lockcell_arfcn: "650000", Z5g_lockcell_pci: "142", Z5g_lockcell_band: "78" });
    assert.equal(open.lteBands, "all");
    assert.equal(open.nrBands, "all");
    assert.deepEqual(open.lteCell, { locked: false });
    assert.deepEqual(open.nrCell, { locked: true, pci: 142, arfcn: 650000, band: 78 });
    assert.deepEqual(parseZteLockState({}), { lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
  });

  it("locks bands on an MC888, signs every write and reads it back", async () => {
    const { state, client } = zteRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [1, 3], nr: [78], networkMode: "nr_nsa" }, check));
    assert.deepEqual(state.posts.map((p) => p.goformId), ["BAND_SELECT", "WAN_PERFORM_NR5G_BAND_LOCK_MERGE", "SET_BEARER_PREFERENCE", "LOGOUT"]);
    assert.deepEqual(check, { endpoints: ["zte-goform:BAND_SELECT", "zte-goform:WAN_PERFORM_NR5G_BAND_LOCK_MERGE", "zte-goform:SET_BEARER_PREFERENCE"], readback: "match", reason: null });
  });

  it("locks a cell and unlocks everything, writing only what is locked", async () => {
    const { state, client } = zteRouter({ hw: "MC801A_HW1.0", model: "MC801A" });
    const lock = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, lock));
    assert.equal(lock.readback, "match");
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.deepEqual(unlock.endpoints, ["zte-goform:LTE_LOCK_CELL_SET"]);
    assert.equal(unlock.readback, "match");
    assert.deepEqual(state.posts.at(-2)?.fields.get("lte_earfcn_lock"), "1");
  });

  it("checks a write before it is sent and refuses what a router answers with failure", async () => {
    const { mock, client } = zteRouter();
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 100, pci: 1, scsKhz: 30 }, newCheck())), CpeControlValidationError);
    assert.ok(!mock.requests.some((r) => r.method === "POST" && LanRouterMock.form(r).get("goformId") === "NR5G_LOCK_CELL_SET"));
    mock.handler = ((inner) => (req) => (req.method === "POST" && LanRouterMock.form(req).get("goformId") === "BAND_SELECT" ? { json: { result: "failure" } } : inner(req)))(mock.handler);
    const check = newCheck();
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, check)), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
    assert.deepEqual(check.endpoints, ["zte-goform:BAND_SELECT"]);
  });

  it("reboots without a logout after it, and reads an empty nearby-cell list as no cells", async () => {
    const { state, client } = zteRouter();
    const check = newCheck();
    await client.withSession((s) => s.reboot(check));
    assert.deepEqual(state.posts.map((p) => p.goformId), ["REBOOT_DEVICE"]);
    assert.equal(check.readback, "pending");
    // The firmware answers every key it is asked for, an empty list included
    assert.deepEqual(await client.withSession((s) => s.neighbours()), []);
    const identity = await client.withSession((s) => s.identify());
    assert.deepEqual(identity, { model: "MC888", softwareVersion: VERSION.waInnerVersion, hardwareVersion: VERSION.hardwareVersion });
  });
});
