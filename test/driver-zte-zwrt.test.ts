import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeAnswerFormatError, CpeApiError } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { WriteCheck } from "../src/device-access.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError, sha256Hex } from "../src/drivers/login.ts";
import { ZWRT_ANONYMOUS, ZWRT_DEVICE_INFO, parseZwrtLockState, parseZwrtTelemetry, withZwrtStatus, zteZwrtProtocol, zwrtLoginPassword } from "../src/drivers/zte-zwrt.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { ZWRT_PASSWORD, ZWRT_SALT, ZWRT_SESSION, zwrtRouter } from "./helpers/zte-zwrt-router.ts";

const PASSWORD = ZWRT_PASSWORD;
const SALT = ZWRT_SALT;
const SESSION = ZWRT_SESSION;

function newCheck(): WriteCheck {
  return { endpoints: [], readback: "none", reason: null };
}

describe("zte-zwrt: session", () => {
  it("logs in with the salted double SHA-256 and carries the session it got", async () => {
    assert.equal(zwrtLoginPassword(PASSWORD, SALT), sha256Hex(`${sha256Hex(PASSWORD).toUpperCase()}${SALT}`).toUpperCase());
    const { mock, calls, client } = zwrtRouter();
    const identity = await client.withSession((s) => s.identify());
    assert.deepEqual(identity, { model: "MC8512", softwareVersion: "BD_ZTEMC8512V1.0.0B05", hardwareVersion: "MC8512_HW1.0" });
    assert.deepEqual(
      calls.map((c) => [c.session === ZWRT_ANONYMOUS ? "anon" : c.session === SESSION ? "session" : "?", `${c.object}.${c.method}`]),
      [
        ["anon", "zwrt_web.web_login_info"],
        ["anon", "zwrt_web.web_login_info"],
        ["anon", "zwrt_web.web_login"],
        ["session", "uci.get"],
        ["session", "zwrt_web.web_logout"],
      ]
    );
    assert.ok(mock.requests.every((r) => r.path === "/ubus/" && r.query.has("t") && r.headers["referer"] === "http://192.168.0.1/"));
  });

  it("latches on a wrong password or a locked login, and yields nothing it cannot place", async () => {
    const wrong = zwrtRouter({ login: { result: 1, login_fail_num: 2, login_fail_lock_lefttime: 0 } });
    await assert.rejects(wrong.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108006" && err.remainCount === 2);
    const locked = zwrtRouter({ login: { result: 1, login_fail_lock_lefttime: 120 } });
    await assert.rejects(locked.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108007" && err.waitTime === 120);
    const odd = zwrtRouter({ login: { result: 0 } });
    await assert.rejects(odd.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
  });

  it("checks the lock before the password, and refuses a router without a salt", async () => {
    const locked = zwrtRouter();
    locked.mock.handler = ((inner) => (req) => {
      const body = JSON.parse(req.body) as { id: number; params: unknown[] };
      return body.params[2] === "web_login_info" ? { json: { jsonrpc: "2.0", id: body.id, result: [0, { login_fail_lock_lefttime: 60 }] } } : inner(req);
    })(locked.mock.handler);
    await assert.rejects(locked.client.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "108007");
    assert.ok(!locked.calls.some((c) => c.method === "web_login"));
    const saltless = new LanRouterMock((req) => ({ json: { jsonrpc: "2.0", id: (JSON.parse(req.body) as { id: number }).id, result: [0, {}] } }));
    const client = new DriverCpeClient({ protocol: zteZwrtProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: saltless.fetchImpl });
    await assert.rejects(client.withSession((s) => s.identify()), DriverLoginMethodError);
  });

  it("turns ubus and JSON-RPC errors into router errors", async () => {
    const { client } = zwrtRouter({ fail: "zte_nwinfo_api.nwinfo_get_netinfo" });
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "ubus-6");
    const broken = new LanRouterMock((req) => {
      const body = JSON.parse(req.body) as { id: number; params: unknown[] };
      if (body.params[2] === "web_login_info") return { json: { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "x" } } };
      return { json: { nope: true } };
    });
    const c2 = new DriverCpeClient({ protocol: zteZwrtProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: broken.fetchImpl });
    await assert.rejects(c2.withSession((s) => s.identify()), (err: unknown) => err instanceof CpeApiError && err.code === "rpc-32601");
    const empty = new LanRouterMock(() => ({ json: [] }));
    const c3 = new DriverCpeClient({ protocol: zteZwrtProtocol, cpeUrl: "http://192.168.0.1", cpePassword: PASSWORD, fetchImpl: empty.fetchImpl });
    await assert.rejects(c3.withSession((s) => s.identify()), CpeAnswerFormatError);
  });
});

describe("zte-zwrt: readings", () => {
  it("maps a standalone poll with traffic and the board temperature", async () => {
    const { client } = zwrtRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.mode, "SA");
    assert.equal(t?.lte, null);
    assert.equal(t?.nr?.pci, 142);
    assert.equal(t?.plmn, "27201");
    assert.equal(t?.wan.connected, true);
    assert.equal(t?.traffic?.monthDownloadBytes, 53687091200n);
    assert.equal(t?.traffic?.downloadBytesPerSec, 1250000);
    assert.equal(t?.temperatureC, 36);
    await assert.rejects(client.withSession((s) => s.neighbours()), SectionUnavailableError);
  });

  it("splits carrier lists, taking a serving cell listed first as the cell", () => {
    const t = parseZwrtTelemetry({
      info: {},
      netinfo: { network_type: "NSA", wan_active_band: "1", wan_active_channel: "300", lte_pci: "211", lte_rsrp: "-85", nr5g_action_band: "78", nr5g_action_channel: "650000", nr5g_pci: "142", nr5g_rsrp: "-88", lteca: "211,1,300,20,-85,-9,12;142,3,1850,20,-90,-11,8;", nrca: "142,78,650000,100,-88,-10,15;" },
      traffic: null,
      device: null,
    });
    assert.equal(t.lte?.bandwidthMhz, 20);
    assert.equal(t.nr?.bandwidthMhz, 100);
    assert.deepEqual(
      t.carriers.map((c) => [c.rat, c.band, c.arfcn, c.pci, c.rsrpDbm]),
      [["LTE", 3, 1850, 142, -90]]
    );
    assert.equal(t.traffic, null);
    assert.equal(t.wan.connected, null);
  });

  it("reads locks back: lists or masks, an empty list meaning every band", () => {
    const state = parseZwrtLockState({ lte_band_lock: "0x5", nr5g_sa_band_lock: "41,78", lock_nr_cell: "142,650000,78", net_select: "Only_5G" });
    assert.deepEqual(state.lteBands, [1, 3]);
    assert.deepEqual(state.nrBands, [41, 78]);
    assert.deepEqual(state.nrCell, { locked: true, pci: 142, arfcn: 650000, band: 78 });
    assert.equal(state.networkMode, "nr_sa");
    const open = parseZwrtLockState({ lte_band: "", nr5g_sa_band_lock: "", lock_nr_cell: "0,0,0", net_select: "odd" });
    assert.equal(open.lteBands, "all");
    assert.equal(open.nrBands, "all");
    assert.equal(parseZwrtLockState({}).lteBands, null);
    assert.deepEqual(open.nrCell, { locked: false });
    assert.equal(open.networkMode, null);
  });
});

describe("zte-zwrt: writes", () => {
  it("locks LTE and NR bands as decimal lists and reads them back", async () => {
    const { calls, client } = zwrtRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: [3, 1], nr: [78], networkMode: "nr_sa" }, check));
    const set = calls.filter((c) => c.method.startsWith("nwinfo_set"));
    assert.deepEqual(set.map((c) => [c.method, c.args]), [
      ["nwinfo_set_lte_ext_band", { lte_band: "1,3" }],
      ["nwinfo_set_nrbandlock", { nr5g_band: "78", nr5g_type: "0" }],
      ["nwinfo_set_netselect", { net_select: "Only_5G" }],
    ]);
    assert.equal(check.readback, "match");
    assert.deepEqual(check.endpoints, ["zte-zwrt:zte_nwinfo_api.nwinfo_set_lte_ext_band", "zte-zwrt:zte_nwinfo_api.nwinfo_set_nrbandlock", "zte-zwrt:zte_nwinfo_api.nwinfo_set_netselect"]);
  });

  it("unlocks with the router's reset, and refuses mixes it cannot write", async () => {
    const { calls, client } = zwrtRouter();
    const check = newCheck();
    await client.withSession((s) => s.setBandLock({ lte: "all", nr: null, networkMode: null }, check));
    assert.ok(calls.some((c) => c.method === "nwinfo_reset_band_cell_setting"));
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: "all", nr: [78], networkMode: null }, newCheck())), CpeControlValidationError);
    const unlock = newCheck();
    await client.withSession((s) => s.unlockAll(unlock));
    assert.deepEqual(unlock.endpoints, ["zte-zwrt:zte_nwinfo_api.nwinfo_reset_band_cell_setting"]);
  });

  it("locks NR cells only, then reboots without a logout", async () => {
    const { calls, client } = zwrtRouter();
    await assert.rejects(client.withSession((s) => s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, newCheck())), CpeControlValidationError);
    const lock = newCheck();
    await client.withSession((s) => s.setCellLock({ rat: "NR", band: 78, arfcn: 650000, pci: 142, scsKhz: 30 }, lock));
    assert.equal(lock.readback, "match");
    const before = calls.length;
    const reboot = newCheck();
    await client.withSession((s) => s.reboot(reboot));
    const after = calls.slice(before).map((c) => c.method);
    assert.deepEqual(after.slice(-1), ["device_reboot"]);
    assert.equal(reboot.readback, "pending");
  });

  it("reports a write the router refuses", async () => {
    const { client, mock } = zwrtRouter();
    mock.handler = ((inner) => (req) => {
      const body = JSON.parse(req.body) as { id: number; params: unknown[] };
      return body.params[2] === "nwinfo_set_lte_ext_band" ? { json: { jsonrpc: "2.0", id: body.id, result: [0, { result: 3 }] } } : inner(req);
    })(mock.handler);
    await assert.rejects(client.withSession((s) => s.setBandLock({ lte: [1], nr: null, networkMode: null }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "result3");
  });
});

describe("zte-zwrt: the router's status", () => {
  it("reads the battery, the SIM card and the roaming switch in the poll's session", async () => {
    const { calls, client } = zwrtRouter({
      device: { bat_online: 1, bat_percent: 64, bat_charger_connect: 1, bat_time_to_full: 92, bat_time_to_empty: -1, bat_temperature: 38 },
      sim: { sim_states: "sim ready", current_sim_slot: "2", pin_status: "0", pinnumber: "3", puknumber: 10, sim_iccid: "8935301000000000000", sim_imsi: "272010000000000", msisdn: "" },
    });
    const t = await client.withSession((s) => s.telemetry());
    assert.ok(t);
    assert.deepEqual(t.status?.battery, { percent: 64, charging: true, temperatureC: 38, minutesToFull: 92, minutesToEmpty: null });
    assert.deepEqual(t.status?.sim, { state: "ready", pinLockEnabled: false, pinAttemptsLeft: 3, pukAttemptsLeft: 10, slot: { kind: "embedded", index: 1 } });
    assert.deepEqual(t.status?.roaming, { active: null, dataAllowed: true });
    assert.deepEqual(t.ids, { imsi: "272010000000000", msisdn: null, iccid: "8935301000000000000" });
    assert.deepEqual(t.temperatures, [{ kind: "battery", name: null, celsius: 38 }]);
    // The battery fields the notes name, in one call; then the card and the data call, same session
    const device = calls.find((c) => c.method === "get_device_info");
    assert.equal(device?.args["deviceInfoList"], ZWRT_DEVICE_INFO);
    assert.deepEqual(
      calls.filter((c) => ["get_device_info", "get_sim_info", "get_wwaniface"].includes(c.method)).map((c) => c.method),
      ["get_device_info", "get_sim_info", "get_wwaniface"]
    );
  });

  it("makes up no battery on a router without one, and falls back to the slot the notes name when the card's details are refused", async () => {
    const cpe = zwrtRouter({ device: { bat_online: 0, bat_percent: 0, bat_temperature: 36 }, sim: false });
    const t = await cpe.client.withSession((s) => s.telemetry());
    assert.equal(t?.status?.battery, null);
    assert.deepEqual(t?.status?.sim?.slot, { kind: "physical", index: 1 });
    assert.equal(t?.status?.sim?.state, null);
    assert.ok(cpe.calls.some((c) => c.method === "get_sim_info_before"));
    assert.equal(t?.temperatureC, 36, "the temperature the poll always read stays");
  });

  it("reads each SIM state as the router's app does", () => {
    const base = parseZwrtTelemetry({ info: {}, netinfo: { network_type: "LTE" }, traffic: null, device: null });
    const state = (sim: Record<string, unknown>) => withZwrtStatus(base, { device: null, sim, wwan: null }).status?.sim?.state;
    assert.deepEqual(
      ["sim undetected", "wait pin", "wait puk", "sim destroy", "error"].map((s) => state({ sim_states: s })),
      ["absent", "pin_required", "puk_required", "error", "error"]
    );
    assert.deepEqual(
      ["modem_init_complete", "modem_waitpin", "modem_waitpuk", "modem_sim_undetected", "other"].map((s) => state({ modem_main_state: s })),
      ["ready", "pin_required", "puk_required", "absent", null]
    );
    assert.equal(withZwrtStatus(base, { device: null, sim: null, wwan: { roam_enable: "0" } }).status?.roaming?.dataAllowed, false);
    assert.equal(withZwrtStatus(base, { device: null, sim: null, wwan: null }).status?.sim, null);
  });
});
