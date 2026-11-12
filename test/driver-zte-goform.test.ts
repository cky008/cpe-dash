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
  ZTE_STATUS_KEYS,
  withZteGoformStatus,
} from "../src/drivers/zte-goform.ts";
import { driverTelemetrySnapshot } from "../src/drivers/snapshot.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { ZTE_LD, ZTE_PASSWORD, ZTE_VERSION, zteRouter } from "./helpers/zte-goform-router.ts";

const PASSWORD = ZTE_PASSWORD;
const LD = ZTE_LD;
const VERSION = ZTE_VERSION;

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
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
    // A version string of the standard generation carries "V1.0.0" too: the model decides, not that mark
    const standard = { hardwareVersion: "MC801A_HW1.0", modelName: "MC801A", waInnerVersion: "BD_ZTE_MC801AV1.0.0B05", crVersion: "CR_ZTE_MC801AV1.0.0B05" };
    assert.equal(zteBranch(standard), 1);
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
      // The telemetry read, then the router's status (battery, SIM card…) in the same session
      "GET /goform/goform_get_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "GET /goform/goform_get_cmd_process",
      "POST /goform/goform_set_cmd_process",
    ]);
    // Every goform request names the page it comes from
    assert.ok(mock.requests.every((r) => r.headers["referer"] === "http://192.168.0.1/index.html" && r.headers["x-requested-with"] === "XMLHttpRequest"));
    assert.deepEqual(state.posts.map((p) => p.goformId), ["LOGOUT"]);
    assert.equal(state.loggedIn, false);
  });

  it("triggers DEVELOPER_OPTION_LOGIN on MC888 (branch 2) and MC8020 (branch 3)", async () => {
    for (const hw of ["MC888HW-1.0.0", "MC8020HW-1.0.0"]) {
      const { state, client } = zteRouter({ hw });
      await client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck()));
      assert.ok(state.posts.some((p) => p.goformId === "DEVELOPER_OPTION_LOGIN"));
    }
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

  it("treats result 2 as someone signed in elsewhere while attempts are left and nothing is locked, else as a lock; 4 as signed in elsewhere", async () => {
    // ZTE's own page calls 2 a duplicate user; both notes libraries call it a lock: the router's count decides
    const elsewhere = zteRouter({ loginResult: "2" });
    const yielded = await elsewhere.client.withSessionDetailed((s) => s.telemetry());
    assert.equal(yielded.status, "yielded");
    assert.equal(elsewhere.client.getCircuitBreakerState().tripped, false);
    const locked = zteRouter({ loginResult: "2", lock: { left: "0", wait: "0" } });
    await assert.rejects(locked.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
    const unreadable = zteRouter({ loginResult: "2", lock: { left: "", wait: "" } });
    await assert.rejects(unreadable.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108007", "no count to go by: the safe reading");
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
    // Lifetime totals only where the firmware keeps them: no made-up zero
    assert.equal(t.traffic?.totalDownloadBytes, null);
    const totals = parseZteGoformTelemetry({ ...raw, total_rx_bytes: "214748364800", total_tx_bytes: "10737418240" }).traffic;
    assert.deepEqual([totals?.totalDownloadBytes, totals?.totalUploadBytes], [214748364800n, 10737418240n]);
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
    assert.deepEqual(zteCellForm(1, nrCell).fields, [["nr5g_cell_lock", "142,650000,78,30"]]);
    assert.deepEqual(zteCellForm(1, { ...nrCell, scsKhz: 15 }).fields, [["nr5g_cell_lock", "142,650000,78,15"]]);
    assert.deepEqual(zteCellForm(2, nrCell).fields[3], ["Z5g_lockcell_scs", "30"]);
    assert.deepEqual(zteCellForm(3, nrCell).fields[2], ["rat", "16"]);
    assert.deepEqual(zteCellForm(4, { rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }).fields[2], ["rat", "12"]);
    assert.throws(() => zteCellForm(1, { ...nrCell, scsKhz: null }), CpeControlValidationError);
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
    assert.deepEqual(state.posts.map((p) => p.goformId), ["DEVELOPER_OPTION_LOGIN", "BAND_SELECT", "WAN_PERFORM_NR5G_BAND_LOCK_MERGE", "SET_BEARER_PREFERENCE", "LOGOUT"]);
    // The developer-option login is part of the write's record, ahead of the forms it opens the way for
    assert.deepEqual(check, { endpoints: ["zte-goform:DEVELOPER_OPTION_LOGIN", "zte-goform:BAND_SELECT", "zte-goform:WAN_PERFORM_NR5G_BAND_LOCK_MERGE", "zte-goform:SET_BEARER_PREFERENCE"], readback: "match", reason: null });
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
    assert.deepEqual(state.posts.at(-2)?.fields.get("lte_earfcn_lock"), "0");
  });

  it("writes the 4G firmware's mode names on a goform router whose mode reads back as NETWORK_auto", async () => {
    const { state, client } = zteRouter({ hw: "MF286A_HW1.0", model: "MF286A" });
    state.values["net_select"] = "NETWORK_auto";
    await client.withSession(async (s) => {
      await s.lockState();
      await s.setBandLock({ lte: [1, 3], nr: null, networkMode: "lte" }, newCheck());
    });
    assert.equal(state.posts.find((p) => p.goformId === "SET_BEARER_PREFERENCE")?.fields.get("BearerPreference"), "Only_LTE");
    // Back to automatic by its own name, and no 5G mode on it
    state.values["net_select"] = "NETWORK_auto";
    await assert.rejects(
      client.withSession(async (s) => {
        await s.lockState();
        await s.setBandLock({ lte: [1], nr: null, networkMode: "nr_sa" }, newCheck());
      }),
      CpeControlValidationError
    );
    state.values["net_select"] = "Only_LTE";
    await client.withSession(async (s) => {
      await s.lockState();
      await s.unlockAll(newCheck());
    });
    // Only_LTE alone does not say 4G firmware: the 5G pages' name is written, as before
    assert.equal(state.posts.filter((p) => p.goformId === "SET_BEARER_PREFERENCE").at(-1)?.fields.get("BearerPreference"), "WL_AND_5G");
    const second = zteRouter({ hw: "MF286A_HW1.0", model: "MF286A" });
    second.state.values["net_select"] = "NETWORK_auto";
    second.state.values["lte_band_lock"] = "0x5";
    await second.client.withSession(async (s) => s.unlockAll(newCheck()));
    assert.ok(!second.state.posts.some((p) => p.goformId === "SET_BEARER_PREFERENCE"), "already automatic: the mode is left alone");
  });

  it("checks a write before it is sent and refuses what a router answers with failure", async () => {
    const { mock, client } = zteRouter();
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 100, pci: 1, scsKhz: 30 }, newCheck())), CpeControlValidationError);
    assert.ok(!mock.requests.some((r) => r.method === "POST" && LanRouterMock.form(r).get("goformId") === "NR5G_LOCK_CELL_SET"));
    mock.handler = ((inner) => (req) => (req.method === "POST" && LanRouterMock.form(req).get("goformId") === "BAND_SELECT" ? { json: { result: "failure" } } : inner(req)))(mock.handler);
    const check = newCheck();
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, check)), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
    assert.deepEqual(check.endpoints, ["zte-goform:DEVELOPER_OPTION_LOGIN", "zte-goform:BAND_SELECT"]);
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

describe("zte-goform: the router's status", () => {
  /** A mobile router's status keys as ZTE's page reads them (placeholders only). */
  const STATUS = {
    battery_vol_percent: "64",
    battery_charging: "1",
    battery_temp: "36",
    modem_main_state: "modem_init_complete",
    pin_status: "1",
    pinnumber: "3",
    puknumber: "10",
    sim_slot: "1",
    simcard_roam: "Home",
    data_volume_limit_switch: "1",
    data_volume_limit_unit: "data",
    data_volume_limit_size: "20_1024",
    data_volume_alert_percent: "90",
    fota_new_version_state: "has_optional",
    wifi_cur_state: "1",
    m_ssid_enable: "0",
    imei: "860000000000000",
    imsi: "272010000000000",
    msisdn: "+353830000000",
    sim_iccid: "8935301000000000000",
    lte_cqi1: "11",
    lte_tx_power: "12",
    wifi_chip_temp: "52",
    cpu_usage: "23",
    mem_usage: "41%",
  };

  it("reads the battery, the SIM card, roaming, the data plan, a firmware update, Wi-Fi and the identifiers in the poll's session", async () => {
    const { mock, state, client } = zteRouter();
    Object.assign(state.values, STATUS);
    const t = await client.withSession((s) => s.telemetry());
    assert.ok(t);
    // The status is its own request, after the telemetry one, so the telemetry read is unchanged
    const cmds = mock.requests.filter((r) => r.method === "GET" && r.query.get("multi_data") === "1").map((r) => r.query.get("cmd") ?? "");
    assert.equal(cmds.at(-1), ZTE_STATUS_KEYS.join(","));
    assert.deepEqual(t.status?.battery, { percent: 64, charging: true, temperatureC: 36, minutesToFull: null, minutesToEmpty: null });
    assert.deepEqual(t.status?.sim, { state: "ready", pinLockEnabled: true, pinAttemptsLeft: 3, pukAttemptsLeft: 10, slot: { kind: "embedded", index: 1 } });
    assert.deepEqual(t.status?.roaming, { active: false, dataAllowed: null });
    assert.equal(t.status?.firmwareUpdate, "available");
    assert.deepEqual(t.status?.wifi, { enabled: true, guestEnabled: false });
    assert.deepEqual(t.status?.system, { uptimeSec: null, cpuPercent: 23, memoryPercent: 41 });
    assert.deepEqual(t.ids, { imei: "860000000000000", imsi: "272010000000000", msisdn: "+353830000000", iccid: "8935301000000000000" });
    assert.deepEqual([t.lte?.cqi1, t.lte?.puschTxDbm], [11, 12]);
    assert.ok(t.temperatures?.some((s) => s.kind === "wifi" && s.celsius === 52));
    assert.ok(t.temperatures?.some((s) => s.kind === "battery" && s.celsius === 36));
    // The plan reads as HiLink's does: 20 × 1024 MB
    const snap = driverTelemetrySnapshot(t, 1_000);
    assert.deepEqual([snap.traffic.dataLimitRaw, snap.traffic.monthThresholdPercent], ["20GB", 90]);
    assert.equal(snap.status?.battery?.percent, 64);
  });

  it("makes up no battery on a CPE, and keeps the readings when the router refuses the status request", async () => {
    const { client } = zteRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.status?.battery, null, "no battery keys: no battery");
    assert.equal(t?.status?.sim?.state, null);
    assert.equal(t?.lte?.pci, 211);
    // A firmware whose answer to the status keys is not an object: the telemetry read stands on its own
    const telemetryOnly = parseZteGoformTelemetry({ network_type: "LTE", lte_pci: "d3", wan_active_band: "LTE B1", wan_active_channel: "300", lte_rsrp: "-90" });
    assert.equal(withZteGoformStatus(telemetryOnly, {}).status?.battery, null);
    assert.equal(withZteGoformStatus(telemetryOnly, {}).wcdma, null);
  });

  it("reads each state as ZTE's own page does", () => {
    const t = parseZteGoformTelemetry({ network_type: "LTE", lte_pci: "d3", wan_active_band: "LTE B1", wan_active_channel: "300", lte_rsrp: "-90", pm_sensor_mdm: "46", pm_modem_5g: "49", pm_sensor_pa1: "44" });
    assert.deepEqual(t.temperatures, [
      { kind: "modem_4g", name: null, celsius: 46 },
      { kind: "modem_5g", name: null, celsius: 49 },
      { kind: "pa", name: null, celsius: 44 },
    ]);
    const states = ["modem_waitpin", "modem_waitpuk", "modem_sim_undetected", "modem_sim_destroy", "modem_imsi_waitnck", "something else"].map(
      (state) => withZteGoformStatus(t, { modem_main_state: state }).status?.sim?.state
    );
    assert.deepEqual(states, ["pin_required", "puk_required", "absent", "error", "error", null]);
    // battery_pers: a 0–4 icon on ZTE's page (25 % a step), a percentage in library A
    assert.equal(withZteGoformStatus(t, { battery_pers: "3" }).status?.battery?.percent, 75);
    assert.equal(withZteGoformStatus(t, { battery_pers: "58" }).status?.battery?.percent, 58);
    assert.equal(withZteGoformStatus(t, { battery_pers: "0" }).status?.battery, null);
    assert.equal(withZteGoformStatus(t, { battery_value: "80", battery_vol_percent: "" }).status?.battery?.percent, 80);
    // Roaming as the page counts it; the card slot and the two built-in cards; no update; a plan in hours is no plan
    assert.equal(withZteGoformStatus(t, { simcard_roam: "International" }).status?.roaming?.active, true);
    assert.equal(withZteGoformStatus(t, { simcard_roam: "Internal" }).status?.roaming?.active, true);
    assert.deepEqual(withZteGoformStatus(t, { sim_slot: "0" }).status?.sim?.slot, { kind: "physical", index: 1 });
    assert.deepEqual(withZteGoformStatus(t, { sim_slot: "2" }).status?.sim?.slot, { kind: "embedded", index: 2 });
    assert.equal(withZteGoformStatus(t, { fota_new_version_state: "none" }).status?.firmwareUpdate, "none");
    assert.equal(withZteGoformStatus(t, {}).status?.firmwareUpdate, null);
    assert.equal(driverTelemetrySnapshot(withZteGoformStatus({ ...t, traffic: { downloadBytesPerSec: 0, uploadBytesPerSec: 0, totalDownloadBytes: null, totalUploadBytes: null, sessionDownloadBytes: null, sessionUploadBytes: null, sessionSeconds: null, monthDownloadBytes: null, monthUploadBytes: null, monthTotalBytes: null, monthSeconds: null } }, { data_volume_limit_switch: "1", data_volume_limit_unit: "time", data_volume_limit_size: "100" }), 1).traffic.dataLimitRaw, "");
    // 3G: RSCP, Ec/Io and the scrambling code
    assert.deepEqual(withZteGoformStatus(t, { rscp: "-80", ecio: "-7", sc: "128" }).wcdma, { rscpDbm: -80, ecioDb: -7, psc: 128 });
  });
});
