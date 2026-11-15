import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError } from "../src/drivers/login.ts";
import { rsaSign } from "../src/drivers/tplink/crypto.ts";
import { parseDecoHosts, parseDecoTelemetry } from "../src/drivers/tplink/deco.ts";
import { tplinkProtocol } from "../src/drivers/tplink/driver.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { CpeApiError } from "../src/session-errors.ts";
import { daemonOn, fullSession, newCheck } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { decoRouter } from "./helpers/tplink-deco-router.ts";
import { TPLINK_PASSWORD, TPLINK_URL } from "./helpers/tplink-router.ts";

/**
 * TP-Link's Deco line with a modem, on its own LuCI forms. Mocks only: the stand-in decrypts the
 * password and each signature with its private keys, as the router does.
 */

describe("tp-link deco: what the forms answer, read into FengSui's shapes", () => {
  const master = { device_model: "X50-5G", hardware_ver: "1.0", software_ver: "1.2.3" };

  it("reads the modem's signal without a band or a cell, the data used, and the SIM card's state", () => {
    const t = parseDecoTelemetry({ mobile_cpe: { signal_strength: 60, rsrp: -91, snr: 7.2, rssi: -83, rsrq: -9, sim_status: "ready", dial_status: "connected", profile_name: "RGVtbyBJbnRlcm5ldA==", data_usage: 12_948_105_728, downlink_rate: 5680, uplink_rate: 1080, network_type: "lte_plus" } }, "198.51.100.42", master);
    assert.deepEqual([t.mode, t.lte?.rsrpDbm, t.lte?.rsrqDb, t.lte?.sinrDb, t.lte?.rssiDbm, t.lte?.band, t.lte?.pci, t.nr, t.signalBars], ["LTE", -91, -9, 7.2, -83, null, null, null, 3]);
    assert.deepEqual([t.model, t.softwareVersion, t.hardwareVersion, t.operatorName], ["X50-5G", "1.2.3", "1.0", null], "the access point's name is not an operator's");
    assert.deepEqual(t.wan, { connected: true, ipv4: "198.51.100.42", ipv6: null, uptimeSec: null });
    assert.deepEqual([t.traffic?.monthTotalBytes, t.traffic?.downloadBytesPerSec, t.traffic?.uploadBytesPerSec], [12_948_105_728n, 5680, 1080], "a total past ten digits is read whole");
    assert.equal(t.status?.sim?.state, "ready");
    const mode = (network_type: string): unknown => {
      const read = parseDecoTelemetry({ mobile_cpe: { rsrp: -90, network_type } }, null, null);
      return [read.mode, read.lte !== null, read.nr !== null];
    };
    assert.deepEqual(["lte", "5g_sa", "5g_nr", "5g_nsa", "wcdma", "gsm"].map(mode), [["LTE", true, false], ["SA", false, true], ["SA", false, true], ["NSA", true, false], ["WCDMA", false, false], [null, false, false]]);
    // No SIM card: the page reports every reading as 0, and none of them is one
    const none = parseDecoTelemetry({ mobile_cpe: { signal_strength: 0, rsrp: 0, snr: 0, rssi: 0, rsrq: 0, sim_status: "absent", dial_status: "disconnected", data_usage: "0" } }, null, null);
    assert.deepEqual([none.lte, none.nr, none.wan.connected, none.status?.sim?.state, none.traffic?.monthTotalBytes, none.signalBars], [null, null, false, "absent", 0n, 0]);
    const states = ["locked", "error", "odd"].map((sim_status) => parseDecoTelemetry({ mobile_cpe: { sim_status } }, null, null).status?.sim?.state);
    assert.deepEqual(states, ["pin_required", "error", null]);
    const bare = parseDecoTelemetry(null, null, null);
    assert.deepEqual([bare.mode, bare.traffic, bare.wan.connected, bare.model, bare.signalBars], [null, null, null, null, null]);
  });

  it("lists the devices that are online, names decoded, by the band or the cable", () => {
    const hosts = parseDecoHosts({
      client_list: [
        { mac: "02-00-5E-10-00-01", ip: "192.168.68.100", name: "cGhvbmU=", online: true, wire_type: "wireless", connection_type: "band5" },
        { mac: "02-00-5E-10-00-02", ip: "192.168.68.2", name: "nas", online: true, wire_type: "wired" },
        { mac: "00-00-5E-00-53-01", name: "Z29uZQ==", online: false },
        { mac: "02-00-5E-10-00-03", online: true, wire_type: "wireless", connection_type: "band6" },
        { online: true },
      ],
    });
    assert.deepEqual(hosts.map((h) => [h.mac, h.name, h.ipv4, h.link]), [["02:00:5E:10:00:01", "phone", "192.168.68.100", "wifi_5"], ["02:00:5E:10:00:02", "nas", "192.168.68.2", "lan"], ["02:00:5E:10:00:03", null, null, "wifi"]]);
    assert.deepEqual([parseDecoHosts(null), parseDecoHosts({ client_list: "x" })], [[], []]);
  });

  it("encrypts in blocks the PKCS #1 padding leaves room for", () => {
    const key = { modulusHex: `c${"0".repeat(126)}1`, exponentHex: "010001" };
    assert.equal(rsaSign("x".repeat(53), key, "pkcs1").length, 128);
    assert.equal(rsaSign("x".repeat(54), key, "pkcs1").length, 256);
  });
});

describe("tp-link deco: a session", () => {
  it("signs in with the password encrypted for one key and the request signed for another, reads, and signs out", async () => {
    const { mock, client, state, logins, forms } = decoRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.deepEqual([t?.mode, t?.lte?.rsrpDbm, t?.model, t?.wan.ipv4, t?.traffic?.monthTotalBytes], ["LTE", -91, "X50-5G", "198.51.100.42", 12_948_105_728n]);
    assert.deepEqual(mock.trail.slice(0, 7), ["GET /", "POST /cgi/getBusy", "POST /cgi/getGDPRParm", "POST /cgi/getParm", "POST /cgi-bin/luci/;stok=/login", "POST /cgi-bin/luci/;stok=/login", "POST /cgi-bin/luci/;stok=/login"]);
    assert.deepEqual(logins.map((l) => [l.password, Object.keys(l.fields)]), [[TPLINK_PASSWORD, ["k", "i", "h", "s"]]]);
    assert.deepEqual(forms.map((f) => f.form), ["network internet", "network wan_ipv4", "device device_list", "system logout"]);
    assert.deepEqual([state.session, state.loggedOut], [null, 1]);
    const request = mock.requests[7];
    assert.deepEqual([request?.path, request?.query.get("form"), request?.headers["cookie"], request?.headers["content-type"]], ["/cgi-bin/luci/;stok=5t0k0123456789abcdef/admin/network", "internet", "sysauth=deco5e55104", "application/x-www-form-urlencoded; charset=UTF-8"]);
    assert.ok(!mock.requests.some((r) => `${r.body} ${[...r.query.values()].join(" ")}`.includes(TPLINK_PASSWORD)), "the password never goes out as typed");
  });

  it("says which form the router speaks, lists the mesh's devices, and has no nearby cells, no lock and no SMS", async () => {
    const { client } = decoRouter({ missing: ["network wan_ipv4"] });
    await client.withSession(async (s) => {
      assert.deepEqual(await s.identify(), { model: "X50-5G", softwareVersion: "1.2.3 Build 20260101", hardwareVersion: "1.0", variant: "deco" });
      assert.equal((await s.telemetry()).wan.ipv4, null, "a form the firmware lacks costs only its part");
      assert.equal((await fullSession(s).hosts()).length, 3);
      assert.deepEqual([s.sms, s.cellular, s.data], [undefined, undefined, undefined]);
      await assert.rejects(s.neighbours(), SectionUnavailableError);
      assert.equal((await s.lockState()).lteBands, null);
      const check = newCheck();
      await assert.rejects(s.setBandLock({ lte: [1], nr: null, networkMode: null }, check), CpeControlValidationError);
      await assert.rejects(s.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, check), CpeControlValidationError);
      await assert.rejects(s.unlockAll(check), CpeControlValidationError);
      assert.deepEqual(check.endpoints, []);
    });
    const refusing = decoRouter({ missing: ["network internet"] });
    await assert.rejects(refusing.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "-40210");
  });

  it("restarts the main unit alone, once, and ends the session", async () => {
    const { client, state, forms } = decoRouter();
    await client.withSession(async (s) => {
      const check = newCheck();
      await s.reboot(check);
      assert.deepEqual([check.endpoints, check.readback, s.open], [["tplink:device.system.reboot"], "pending", false]);
      await assert.rejects(s.telemetry(), /session is over/);
    });
    assert.deepEqual(state.rebooted, ["02-00-5E-10-00-0A"], "the unit with the modem, not the whole mesh");
    assert.deepEqual(forms.map((f) => f.form), ["device device_list", "device system"], "no logout the restarting router could not answer");
    const noUnits = decoRouter({ missing: ["device device_list"] });
    await noUnits.client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(s.reboot(check), /no main unit/);
      assert.deepEqual(check.endpoints, [], "nothing was sent");
    });
  });

  it("latches on a password the router refused and on an answer it cannot read, and sends none it has no form for", async () => {
    const wrong = decoRouter();
    const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "wrong-password", fetchImpl: wrong.mock.fetchImpl });
    await assert.rejects(client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(client.getCircuitBreakerState().tripped, true);
    await assert.rejects(client.withSession((s) => s.telemetry()));
    assert.equal(wrong.logins.length, 1, "a latched breaker sends nothing");
    for (const options of [{ loginAnswer: { status: 403, text: "" } }, { loginAnswer: { json: { data: "bm90IGVuY3J5cHRlZA==" } } }, { loginAnswer: { text: "<html>" } }, { loginResult: { error_code: 0, result: { stok: "bad token!" } } }]) {
      const odd = decoRouter(options);
      await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker, JSON.stringify(options));
      assert.equal(odd.logins.length, 1);
    }
    const noToken = decoRouter({ loginResult: { error_code: 0, result: {} } });
    await assert.rejects(noToken.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    // A password longer than one block of the router's key: the page has no form for it
    const long = decoRouter();
    const longClient = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: "x".repeat(300), fetchImpl: long.mock.fetchImpl });
    await assert.rejects(longClient.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.equal(long.logins.length, 0);
    // No key for the signature: nothing to sign a login with
    const noAuth = new LanRouterMock((req) => (req.query.get("form") === "keys" ? { json: { error_code: 0, result: { password: long.passwordKey } } } : { status: 404, text: "" }));
    const c = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: noAuth.fetchImpl });
    await assert.rejects(c.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.ok(!noAuth.requests.some((r) => r.query.get("form") === "login"));
  });

  it("is told from the Archer routers and from routers that only look alike", async () => {
    const lan = async (mock: LanRouterMock): Promise<boolean> => tplinkProtocol.detect(new (await import("../src/protocols/transport.ts")).LanHttp({ baseUrl: TPLINK_URL, fetchImpl: mock.fetchImpl, timeoutMs: 1000, signal: new AbortController().signal }));
    assert.equal(await lan(decoRouter().mock), true);
    // A TP-Link Wi-Fi router answers the same form under `data`, not `result`: it has no modem, and is not named
    const wifiOnly = new LanRouterMock((req) => (req.query.get("form") === "keys" ? { json: { success: true, data: { password: decoRouter().passwordKey } } } : { status: 404, text: "" }));
    assert.equal(await lan(wifiOnly), false);
    for (const answer of [{ json: { error_code: -1, result: { password: ["ab", "cd"] } } }, { json: { error_code: 0, result: { password: ["zz", "010001"] } } }, { json: { error_code: 0, result: { password: "x" } } }, { text: "<html>" }, { text: "{broken" }]) {
      assert.equal(await lan(new LanRouterMock(() => answer)), false, JSON.stringify(answer));
    }
  });

  it("goes by the Deco form's own writes through the daemon", async () => {
    const { mock, state } = decoRouter({ networkType: "5g_nsa" });
    const fx = daemonOn("tplink", mock.fetchImpl, TPLINK_URL, TPLINK_PASSWORD);
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.deepEqual([snap?.device.deviceName, snap?.rf.ratCode, snap?.rf.lteRsrpDbm, snap?.status?.sim?.state], ["X50-5G", "NSA", -91, "ready"]);
      assert.equal(fx.core.scheduler.device.variant, "deco", "by the name the model is on record with, before the driver said");
      // The identification every start runs: the driver names the form itself
      assert.equal((await fx.core.monitor.identifyDevice())?.identity.variant, "deco");
      assert.equal(fx.core.scheduler.device.variant, "deco");
      const features = fx.core.scheduler.getStatus().device.features;
      assert.deepEqual([features.reboot, features.smsWrite, features.ussd, features.bandLock], ["enabled", "not_implemented", "not_implemented", "not_implemented"]);
      await assert.rejects(fx.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), DeviceReadOnlyError);
      await fx.core.controls.rebootRouter({ confirm: true });
      assert.deepEqual(state.rebooted, ["02-00-5E-10-00-0A"]);
    } finally {
      await fx.cleanup();
    }
  });
});
