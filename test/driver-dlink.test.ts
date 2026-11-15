import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { dlinkProtocol } from "../src/drivers/dlink/driver.ts";
import { dlinkApnView, dlinkBandOf, dlinkEncodedPassword, dlinkPlainText, dlinkPreferenceOf, dlinkSmsHandle, parseDlinkApn, parseDlinkHosts, parseDlinkInbox, parseDlinkTelemetry } from "../src/drivers/dlink/parts.ts";
import { DriverCpeClient } from "../src/drivers/client.ts";
import { DriverLoginMethodError } from "../src/drivers/login.ts";
import type { DriverSms } from "../src/drivers/types.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { CpeApiError } from "../src/session-errors.ts";
import { DLINK_PASSWORD, DLINK_PASSWORD_MD5, DLINK_URL, dlinkRouter } from "./helpers/dlink-router.ts";
import { cellularOf, daemonOn, fullSession, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";

/**
 * D-Link's DWR 4G routers on their own web interface. Mocks only: the stand-in keeps a session, a
 * write token and its own state, so every read-back sees what a write did.
 */

describe("d-link: what the router answers, read into FengSui's shapes", () => {
  it("writes a password as the newer login page does, and refuses a character the page has no form for", () => {
    // The page's own examples: H (72) and z (122)
    assert.equal(dlinkEncodedPassword("H"), "0750");
    assert.equal(dlinkEncodedPassword("z"), "1250");
    assert.equal(dlinkEncodedPassword("\t"), "0057", "a code of one digit");
    assert.equal(dlinkEncodedPassword("Hz"), "07501250");
    assert.equal(dlinkEncodedPassword(""), "");
    assert.equal(dlinkEncodedPassword("密"), null);
  });

  it("names an LTE band by the router's own number for it", () => {
    assert.deepEqual([120, 122, 126, 133, 134, 142, 145, 149, 158].map(dlinkBandOf), [1, 3, 7, 14, 17, 40, 20, 41, 28]);
    assert.deepEqual([0, 47, 119, 155, 161, "x", null].map(dlinkBandOf), [null, null, null, null, null, null, null]);
  });

  it("reads a poll: the serving cell, the connection, the period's traffic, the SIM card and what the router is", () => {
    const t = parseDlinkTelemetry(
      { system_uptime: 86_400, sim_status: { status: 1 }, signal: { modem: { service: "LTE", op_name: "Three", strength: -67, level: 4 } }, ipv4: { status: "Connected", ip: "198.51.100.42" }, ipv6: { status: "Disconnected" } },
      { oper_name: "Three", service_type: "LTE", rsrp: -95, rsrq: -11, sinr: 14, rssi: -67, bm_currentBand: 120, earfcn: 300, cell_id: 134217758, tac: 10001, PLMN: "27201", roaming: 1 },
      { rx: 2948105728, tx: 104857600 },
      { model_name: "DWR-960", fw_ver: "V1.0.1.2", hw_ver: "B1", imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", my_number: "+353830000000" }
    );
    assert.equal(t.mode, "LTE");
    assert.deepEqual([t.lte?.band, t.lte?.arfcn, t.lte?.pci, t.lte?.rsrpDbm, t.lte?.rsrqDb, t.lte?.sinrDb, t.lte?.rssiDbm, t.lte?.cellId, t.lte?.tac], [1, 300, null, -95, -11, 14, -67, "134217758", "10001"]);
    assert.deepEqual([t.operatorName, t.plmn, t.model, t.softwareVersion, t.hardwareVersion, t.signalBars], ["Three", "27201", "DWR-960", "V1.0.1.2", "B1", 4]);
    assert.deepEqual(t.wan, { connected: true, ipv4: "198.51.100.42", ipv6: null, uptimeSec: null });
    assert.deepEqual([t.traffic?.totalDownloadBytes, t.traffic?.totalUploadBytes, t.traffic?.monthDownloadBytes, t.traffic?.downloadBytesPerSec], [2948105728n, 104857600n, 2948105728n, null]);
    assert.deepEqual(t.status?.sim, { state: "ready", pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null });
    assert.deepEqual(t.status?.roaming, { active: true, dataAllowed: null });
    assert.equal(t.status?.system?.uptimeSec, 86_400);
    assert.deepEqual(t.ids, { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", msisdn: "+353830000000" });
    assert.equal(t.nr, null);
  });

  it("leaves out what the router did not say: no made-up zero, a band taken from the channel, no cell without service", () => {
    const bare = parseDlinkTelemetry({ signal: { modem: { service: "NO SIM", op_name: "NO SIM", strength: 0 } }, sim_status: { status: 0 } }, null, null, null);
    assert.deepEqual([bare.mode, bare.lte, bare.operatorName, bare.traffic, bare.wan.connected, bare.model], ["NONE", null, null, null, null, null]);
    assert.equal(bare.status?.sim?.state, "absent");
    // A band number the page does not list: the channel names the band
    const byChannel = parseDlinkTelemetry({ signal: { modem: { service: "LTE" } } }, { service_type: "LTE", rsrp: -100, bm_currentBand: 161, earfcn: 1850 }, null, null);
    assert.equal(byChannel.lte?.band, 3);
    // 3G is a serving mode of its own and carries no LTE cell; 2G has no name among them
    assert.equal(parseDlinkTelemetry({}, { service_type: "3G", rsrp: -100 }, null, null).mode, "WCDMA");
    assert.equal(parseDlinkTelemetry({}, { service_type: "3G", rsrp: -100 }, null, null).lte, null);
    assert.equal(parseDlinkTelemetry({}, { service_type: "2G" }, null, null).mode, null);
    // The strength the status names is the received power, never an RSRP
    const strength = parseDlinkTelemetry({ signal: { modem: { service: "LTE", strength: -71 } } }, { service_type: "LTE", rsrp: 0 }, null, null);
    assert.deepEqual([strength.lte?.rsrpDbm, strength.lte?.rssiDbm], [null, -71]);
  });

  it("lists the connected devices by the band or the cable they are on", () => {
    const hosts = parseDlinkHosts({
      "WiFi_2.4G_clilist": [{ hname: "phone", ip: "192.168.0.100", mac: "02:00:5E:10:00:01", leasetm: "3600" }],
      WiFi_5G_clilist: [{ hname: "", ip: "192.168.0.101", mac: "00:00:5E:00:53:01", leasetm: "" }],
      lan_clilist: [{ hname: "nas", ip: "192.168.0.2", mac: "02:00:5E:10:00:02" }, { hname: "ghost", mac: "" }, "junk"],
      other: "ignored",
    });
    assert.deepEqual(
      hosts.map((h) => [h.mac, h.name, h.ipv4, h.link, h.leaseSec]),
      [
        ["02:00:5E:10:00:01", "phone", "192.168.0.100", "wifi_2_4", 3600],
        ["00:00:5E:00:53:01", null, "192.168.0.101", "wifi_5", null],
        ["02:00:5E:10:00:02", "nas", "192.168.0.2", "lan", null],
      ]
    );
    assert.deepEqual(parseDlinkHosts({}), []);
  });

  it("reads the inbox: the page's escapes undone, the time in the mirror's form, a handle per tag", () => {
    assert.equal(dlinkPlainText("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2F; &unknown; &#0; &#xD800;"), "a & b <c> \"d\" 'e' / &unknown; &#0; &#xD800;");
    assert.equal(dlinkSmsHandle("1001"), 1001);
    const hashed = dlinkSmsHandle("msg-a");
    assert.ok(Number.isSafeInteger(hashed) && hashed > 0 && hashed <= 0x7fffffff);
    assert.equal(dlinkSmsHandle("msg-a"), hashed, "the same tag, the same handle");
    assert.notEqual(dlinkSmsHandle("msg-b"), hashed);
    assert.ok(dlinkSmsHandle("0") > 0, "a tag of zero is no handle by itself");
    const inbox = parseDlinkInbox({
      total: 3,
      M1: { tag: "1001", phone: "+353830000001", date: "26/10/10 04:07:40", msg: "Hello &amp; welcome", read: 0, storeInSim: 0 },
      M2: { tag: "t-2", phone: "DemoBank", date: "garbled", msg: 7, read: 1 },
      M3: { phone: "no tag" },
    });
    assert.deepEqual(
      inbox.map((e) => [e.tag, e.message.index, e.message.phone, e.message.date, e.message.content, e.message.isUnread, e.message.direction]),
      [
        ["1001", 1001, "+353830000001", "2026-10-10 04:07:40", "Hello & welcome", true, "in"],
        ["t-2", dlinkSmsHandle("t-2"), "DemoBank", "", "", false, "in"],
      ]
    );
    assert.deepEqual(parseDlinkInbox({}), []);
  });

  it("reads the network type and the access point, and never shows the access point's credentials", () => {
    const settings = parseDlinkApn({ apn: { COMMON: { netpref_value: "6", auto_conx: "0" }, APN_0: { type: "1", apn: "example.apn", uname: "user", passwd: "secret", auth: "2", pdp_type: 2 } } });
    assert.deepEqual([settings.networkMode, settings.autoConnect], ["lte", false]);
    assert.deepEqual(dlinkApnView(settings), { mode: "manual", apn: "example.apn", ipType: null, auth: "chap", hasUsername: true });
    assert.ok(!JSON.stringify(dlinkApnView(settings)).includes("secret"));
    const auto = parseDlinkApn({ apn: { COMMON: { netpref_value: "9" }, APN_0: { type: "0", apn: "internet", auth: "3" } } });
    assert.deepEqual([auto.networkMode, auto.autoConnect], [null, null]);
    assert.deepEqual(dlinkApnView(auto), { mode: "auto", apn: "internet", ipType: null, auth: null, hasUsername: false });
    assert.equal(dlinkApnView(parseDlinkApn({})), null);
    assert.deepEqual(["auto", "lte", "wcdma", "gsm", "nr_sa"].map((mode) => dlinkPreferenceOf(mode as "auto")), ["0", "6", "7", "8", null]);
  });
});

describe("d-link: signing in and out", () => {
  it("sends the MD5 of the password to the older page, carries the page's own cookies, and signs out", async () => {
    const { mock, client, state, logins } = dlinkRouter();
    const t = await client.withSession((s) => s.telemetry());
    assert.equal(t?.lte?.rsrpDbm, -95);
    assert.deepEqual(mock.trail, ["GET /login.html", "POST /login.cgi", "GET /data.ria", "GET /data.ria", "GET /data.ria", "GET /data.ria", "POST /login.cgi"]);
    assert.deepEqual([...(logins[0]?.entries() ?? [])], [["uname", "admin"], ["passwd", DLINK_PASSWORD_MD5]]);
    const login = mock.requests[1];
    assert.equal(login?.headers["referer"], `${DLINK_URL}/index.html`);
    assert.equal(login?.headers["x-requested-with"], "XMLHttpRequest");
    assert.equal(login?.headers["x-date"], undefined);
    const firstRead = mock.requests[2];
    assert.equal(firstRead?.headers["cookie"], "qSessId=sess1abcdef012345; DWRLOGGEDID=sess1abcdef012345; DWRLOGGEDUSER=admin; DWRLOGGEDTIMEOUT=300");
    assert.equal(firstRead?.headers["referer"], `${DLINK_URL}/controlPanel.html`);
    assert.deepEqual(JSON.parse(mock.requests.at(-1)?.body ?? "{}"), { logout: "sess1abcdef012345" });
    assert.equal(state.sid, null, "the router's one seat is free again");
    assert.ok(!mock.requests.some((r) => r.body.includes(DLINK_PASSWORD) || [...r.query.values()].some((v) => v.includes(DLINK_PASSWORD))), "the password never goes out as typed");
  });

  it("sends the newer page's own form of the password, with the steps that page takes around it", async () => {
    const { mock, client, logins } = dlinkRouter({ page: "encoded" });
    assert.equal((await client.withSession((s) => s.identify()))?.model, "DWR-960");
    assert.deepEqual(mock.trail, ["GET /login.html", "POST /login.cgi", "POST /login.cgi", "POST /login.cgi", "GET /data.ria", "POST /login.cgi"]);
    assert.equal(mock.requests[1]?.body, "check_attempt_count=1");
    assert.equal(logins[0]?.get("passwd"), dlinkEncodedPassword(DLINK_PASSWORD));
    assert.match(mock.requests[2]?.headers["x-date"] ?? "", /^\d{10}$/);
    assert.equal(mock.requests[2]?.headers["referer"], `${DLINK_URL}/login.html`);
    assert.equal(mock.requests[3]?.body, "check_valid=qSessId%3Dsess1abcdef012345");
  });

  it("sends no password to a login page it does not know, or one that has no form for the password", async () => {
    const unknown = dlinkRouter({ page: "unknown" });
    await assert.rejects(unknown.client.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.deepEqual(unknown.mock.trail, ["GET /login.html"]);
    assert.equal(unknown.client.getCircuitBreakerState().tripped, false, "nothing was tried, nothing latched");
    const broken = new LanRouterMock(() => ({ status: 500, text: "" }));
    const client = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpePassword: DLINK_PASSWORD, fetchImpl: broken.fetchImpl });
    await assert.rejects(client.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.deepEqual(broken.trail, ["GET /login.html"]);
    // The newer page's function has no form for this character: nothing goes out
    const odd = dlinkRouter({ page: "encoded" });
    const wide = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpePassword: "密码", fetchImpl: odd.mock.fetchImpl });
    await assert.rejects(wide.withSession((s) => s.telemetry()), DriverLoginMethodError);
    assert.equal(odd.logins.length, 0);
    // A page that names MD5 itself is the older form under the newer name
    const named = new LanRouterMock((req) => (req.path === "/login.html" ? { text: "<script>passwd: hex_md5(p)</script>" } : { json: { login_fail: "fail" } }));
    const md5Client = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpePassword: DLINK_PASSWORD, fetchImpl: named.fetchImpl });
    await assert.rejects(md5Client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(named.requests[1]?.headers["referer"], `${DLINK_URL}/login.html`);
  });

  it("yields to someone signed in to the router's page, and latches on a wrong password or an answer it cannot place", async () => {
    const busy = dlinkRouter({ busyFrom: "192.168.0.23" });
    assert.equal((await busy.client.withSessionDetailed((s) => s.telemetry())).status, "yielded");
    assert.equal(busy.logins.length, 1, "the password went out once, and is not sent again");
    assert.equal(busy.client.getCircuitBreakerState().tripped, false);
    const wrong = dlinkRouter({ loginAnswer: { json: { login_fail: "fail" } } });
    await assert.rejects(wrong.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.code === "108006");
    assert.equal(wrong.client.getCircuitBreakerState().tripped, true);
    await assert.rejects(wrong.client.withSession((s) => s.telemetry()));
    assert.equal(wrong.logins.length, 1, "a latched breaker sends nothing");
    for (const loginAnswer of [{ json: { ok: true } }, { text: "<html>busy</html>" }, { status: 500, json: { SessId: "sess1abcdef012345" } }, { json: { SessId: "bad id!" } }]) {
      const odd = dlinkRouter({ loginAnswer });
      await assert.rejects(odd.client.withSession((s) => s.telemetry()), (err: unknown) => err instanceof CpeApiError && err.latchesBreaker);
      assert.equal(odd.logins.length, 1);
    }
  });

  it("takes the session from the answer where the router sets no cookie, and fails a read the router no longer answers", async () => {
    const { client, state } = dlinkRouter({ loginAnswer: undefined });
    await client.withSession(async (s) => {
      assert.equal((await s.telemetry()).operatorName, "Three");
      // Someone else signed in meanwhile: the router answers its "not signed in"
      state.sid = "other-session-0123";
      await assert.rejects(s.telemetry(), (err: unknown) => err instanceof CpeApiError && err.code === "login_fail");
    });
    const bodyOnly = new LanRouterMock((req) => {
      if (req.path === "/login.html") return { status: 404, text: "" };
      if (req.path === "/login.cgi") return { json: { SessId: "bodyonly0123456789" } };
      return { text: "<html>login</html>" };
    });
    const c = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpePassword: DLINK_PASSWORD, fetchImpl: bodyOnly.fetchImpl });
    await assert.rejects(c.withSession((s) => s.telemetry()), /not an object/);
    assert.match(bodyOnly.requests[2]?.headers["cookie"] ?? "", /^qSessId=bodyonly0123456789; DWRLOGGEDID=bodyonly0123456789; /);
  });
});

describe("d-link: reads", () => {
  it("costs a poll only the part a firmware lacks, and identifies the router once a session", async () => {
    const { mock, client } = dlinkRouter({ missing: ["get_networkserviceinfo", "nw_usage", "about_sys"] });
    const t = await client.withSession(async (s) => {
      await s.identify();
      return s.telemetry();
    });
    assert.deepEqual([t?.mode, t?.lte?.rsrpDbm, t?.lte?.rssiDbm, t?.traffic, t?.model, t?.wan.connected], ["LTE", null, -67, null, null, true]);
    const reads = mock.requests.filter((r) => r.path === "/data.ria").map((r) => r.query.get("DynUpdate"));
    assert.deepEqual(reads, ["about_sys", "up_5s", "get_networkserviceinfo", "nw_usage", "about_sys"], "a read that failed is asked again, one that answered is not");
    const ok = dlinkRouter();
    await ok.client.withSession(async (s) => {
      await s.identify();
      await s.telemetry();
    });
    assert.equal(ok.mock.requests.filter((r) => r.query.get("DynUpdate") === "about_sys").length, 1);
  });

  it("lists the connected devices, and has no nearby cells and no lock to report", async () => {
    const { client } = dlinkRouter();
    await client.withSession(async (s) => {
      const session = fullSession(s);
      assert.equal((await session.hosts()).length, 3);
      await assert.rejects(session.neighbours(), SectionUnavailableError);
      assert.deepEqual(await session.lockState(), { lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
      const check = newCheck();
      await assert.rejects(session.setBandLock({ lte: [1], nr: null, networkMode: null }, check), CpeControlValidationError);
      await assert.rejects(session.setCellLock({ rat: "LTE", band: 1, arfcn: 300, pci: 211, scsKhz: null }, check), CpeControlValidationError);
      await assert.rejects(session.unlockAll(check), CpeControlValidationError);
      assert.deepEqual(check.endpoints, [], "nothing was sent");
    });
  });
});

describe("d-link: writes, each sent once with a fresh token and read back", () => {
  it("switches mobile data with the page's connect button and reads the connection back", async () => {
    const { client, state, writes } = dlinkRouter({ autoConnect: false });
    await client.withSession(async (s) => {
      const data = fullSession(s).data;
      assert.equal(await data.enabled(), null, "the router has a connection to read, no switch");
      const off = newCheck();
      await data.set(false, off, noWait);
      assert.deepEqual([off.endpoints, off.readback, state.connected], [["dlink:connect_btn.disconnect"], "match", false]);
      const on = newCheck();
      await data.set(true, on, noWait);
      assert.deepEqual([on.endpoints, on.readback, state.connected], [["dlink:connect_btn.connect"], "match", true]);
    });
    assert.deepEqual(writes, [
      { connect: 0, ifc: "all", CfgType: "connect_btn" },
      { connect: 1, ifc: "lte", CfgType: "connect_btn" },
    ]);
    // A router that dials by itself comes back after a disconnect: the read-back says it did not follow
    const dialing = dlinkRouter({ autoConnect: true });
    await dialing.client.withSession(async (s) => {
      const check = newCheck();
      await fullSession(s).data.set(false, check, noWait);
      assert.equal(check.readback, "unknown");
    });
  });

  it("refuses a write the router does not take, and a write without a token", async () => {
    const refused = dlinkRouter({ refuse: "reboot_reset" });
    await refused.client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(s.reboot(check), (err: unknown) => err instanceof CpeApiError && err.code === "reboot_reset.reboot");
      assert.deepEqual(check.endpoints, ["dlink:reboot_reset.reboot"], "what was sent is on record even when it was refused");
      assert.equal(s.open, true);
    });
    const noToken = new LanRouterMock((req) => {
      if (req.path === "/login.html") return { status: 404, text: "" };
      if (req.path === "/login.cgi") return { json: { SessId: "sessnotoken012345" } };
      if (req.path === "/data.ria") return { text: "<html>error</html>" };
      return { json: { cmd_status: "Done" } };
    });
    const client = new DriverCpeClient({ protocol: dlinkProtocol, cpeUrl: DLINK_URL, cpePassword: DLINK_PASSWORD, fetchImpl: noToken.fetchImpl });
    await client.withSession(async (s) => {
      const check = newCheck();
      await assert.rejects(s.reboot(check), /no write token/);
      assert.deepEqual(check.endpoints, []);
    });
    assert.ok(!noToken.requests.some((r) => r.path === "/webpost.cgi"), "nothing is written without the router's token");
  });

  it("reboots once and ends the session without a logout the router could not answer", async () => {
    const { mock, client, state, writes } = dlinkRouter();
    await client.withSession(async (s) => {
      const check = newCheck();
      await s.reboot(check);
      assert.deepEqual([check.endpoints, check.readback, s.open], [["dlink:reboot_reset.reboot"], "pending", false]);
      await assert.rejects(s.telemetry(), /session is over/);
    });
    assert.deepEqual(writes, [{ CfgType: "reboot_reset", cmd: "reboot" }]);
    assert.equal(state.rebooted, true);
    assert.equal(mock.requests.filter((r) => r.path === "/login.cgi").length, 1, "no logout after the reboot");
  });

  it("switches the network type, restarts the data connection as the page does, and reads the type back", async () => {
    const { client, state, writes } = dlinkRouter({ autoConnect: false });
    await client.withSession(async (s) => {
      const cellular = cellularOf(s);
      const before = await cellular.read();
      assert.deepEqual([before.networkMode, before.networkModes], ["auto", ["auto", "lte", "wcdma", "gsm"]]);
      const check = newCheck();
      await cellular.setNetworkMode("lte", check, noWait);
      assert.deepEqual([check.endpoints, check.readback], [["dlink:apn.netpref", "dlink:connect_btn.disconnect", "dlink:connect_btn.connect"], "match"]);
      assert.equal((await cellular.read()).networkMode, "lte");
      await assert.rejects(cellular.setNetworkMode("nr_sa", newCheck(), noWait), CpeControlValidationError);
    });
    assert.deepEqual(writes, [
      { CfgType: "apn", COMMON: { netpref_value: "6" } },
      { connect: 0, ifc: "all", CfgType: "connect_btn" },
      { connect: 1, ifc: "lte", CfgType: "connect_btn" },
    ]);
    assert.equal(state.connected, true, "a router that does not dial by itself is connected again");
    // One that dials by itself gets the disconnect only
    const dialing = dlinkRouter({ autoConnect: true });
    await dialing.client.withSession((s) => cellularOf(s).setNetworkMode("wcdma", newCheck(), noWait));
    assert.deepEqual(dialing.writes.map((w) => [w["CfgType"], w["connect"]]), [["apn", undefined], ["connect_btn", 0]]);
  });

  it("sends the connect even when the disconnect fails, once", async () => {
    const { client, writes } = dlinkRouter({ autoConnect: false, refuse: "connect_btn" });
    await client.withSession(async (s) => {
      await assert.rejects(cellularOf(s).setNetworkMode("lte", newCheck(), noWait), CpeApiError);
    });
    assert.deepEqual(writes.map((w) => [w["CfgType"], w["connect"]]), [["apn", undefined], ["connect_btn", 0], ["connect_btn", 1]]);
  });

  it("changes the access point as the page's form does, and switches back without a credential", async () => {
    const { client, state, writes } = dlinkRouter();
    await client.withSession(async (s) => {
      const cellular = cellularOf(s);
      const before = await cellular.read();
      assert.deepEqual(before.apn, { mode: "auto", apn: "internet", ipType: null, auth: null, hasUsername: false });
      assert.deepEqual(before.apnRestore, { mode: "auto" });
      const check = newCheck();
      await cellular.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "chap", username: "u ser", password: "p&ss" }, check, noWait);
      assert.deepEqual([check.endpoints, check.readback], [["dlink:apn.profile", "dlink:connect_btn.disconnect"], "match"]);
      assert.ok(!JSON.stringify(check).includes("p&ss"), "the record names commands, never a value");
      const manual = await cellular.read();
      assert.deepEqual(manual.apn, { mode: "manual", apn: "example.apn", ipType: null, auth: "chap", hasUsername: true });
      assert.equal(manual.apnRestore, null, "an access point with a user name cannot be put back without its password");
      // Back to the router's own choice: the fields it holds go back as its page sends them
      const back = newCheck();
      await cellular.restoreApn({ mode: "auto" }, back, noWait);
      assert.equal(back.readback, "match");
      assert.equal(state.profile.type, "0");
      const named = newCheck();
      await cellular.restoreApn({ mode: "context", apn: "internet", ipType: "ipv4v6" }, named, noWait);
      assert.deepEqual([state.profile.type, state.profile.apn, state.profile.uname, state.profile.passwd], ["1", "internet", "", ""]);
      assert.deepEqual((await cellular.read()).apnRestore, { mode: "context", apn: "internet", ipType: "ipv4v6" });
      await assert.rejects(cellular.restoreApn({ mode: "profile", id: "1" }, newCheck(), noWait), CpeControlValidationError);
      const auto = newCheck();
      await cellular.setApn({ mode: "auto" }, auto, noWait);
      assert.deepEqual([auto.readback, state.profile.type], ["match", "0"]);
    });
    assert.deepEqual(writes[0], { CfgType: "apn", APN_0: { type: 1, apn: "example.apn", uname: "u%20ser", passwd: "p%26ss", re_passwd: "p&ss", auth: "2", pdp_type: "2" } });
  });

  it("sends a USSD code, waits for the network's answer, and cancels a code that got none", async () => {
    const answered = dlinkRouter({ ussdAnswer: "Your balance: 5.00\r\nThank you" });
    await answered.client.withSession(async (s) => {
      const check = newCheck();
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, check, noWait), { state: "answered", text: "Your balance: 5.00\nThank you", awaitsReply: false });
      assert.deepEqual([check.endpoints, check.readback], [["dlink:do_ussd.send"], "none"]);
      assert.deepEqual(await cellularOf(s).ussd({ kind: "cancel" }, newCheck(), noWait), { state: "cancelled", text: null, awaitsReply: false });
      await assert.rejects(cellularOf(s).ussd({ kind: "reply", code: "1" }, newCheck(), noWait), CpeControlValidationError);
    });
    assert.deepEqual(answered.writes, [
      { CfgType: "do_ussd", cmd: "send", code: "*100#" },
      { CfgType: "do_ussd", cmd: "cancel" },
    ]);
    const silent = dlinkRouter({ ussdAnswer: null });
    await silent.client.withSession(async (s) => {
      const check = newCheck();
      assert.deepEqual(await cellularOf(s).ussd({ kind: "send", code: "*100#" }, check, noWait), { state: "no_answer", text: null, awaitsReply: false });
      assert.deepEqual(check.endpoints, ["dlink:do_ussd.send", "dlink:do_ussd.cancel"]);
    });
    assert.equal(silent.mock.requests.filter((r) => r.query.get("DynUpdate") === "get_ussd_state").length, 30);
  });

  it("reads the inbox, counts it the same way on the poll and after a listing, and sends a message once", async () => {
    const { client, writes } = dlinkRouter();
    await client.withSession(async (s) => {
      const sms = fullSession(s).sms as Required<DriverSms>;
      const messages = await sms.list();
      assert.deepEqual(messages.map((m) => [m.index, m.phone, m.content, m.isUnread]), [[1001, "+353830000001", "Hello & welcome 'home'", true], [1002, "DemoBank", "Balance ready", false]]);
      assert.deepEqual(await sms.counters(), { localUnread: 1, localInbox: 2, localOutbox: 0, localDraft: 0, localMax: 0 });
      assert.deepEqual(await sms.counters(messages), await sms.counters());
      assert.equal(sms.keepsSent, false);
      let accepted = 0;
      const check = newCheck();
      const outcome = await sms.send("+353830000002", "Hello", check, { statusTimeoutMs: 1000, sleep: noWait.sleep, onAccepted: () => (accepted += 1) });
      assert.deepEqual([outcome, accepted, check.endpoints], [{ state: "unconfirmed", code: null }, 1, ["dlink:sms_action.sms_send"]]);
    });
    assert.deepEqual(writes, [{ CfgType: "sms_action", type: "sms_send", msg: "Hello", phone_list: "+353830000002" }]);
    const refused = dlinkRouter({ refuse: "sms_action" });
    await refused.client.withSession(async (s) => {
      let accepted = 0;
      await assert.rejects((fullSession(s).sms as Required<DriverSms>).send("+353830000002", "Hello", newCheck(), { statusTimeoutMs: 1000, sleep: noWait.sleep, onAccepted: () => (accepted += 1) }), CpeApiError);
      assert.equal(accepted, 0, "a message the router refused is not on its way");
    });
    const none = dlinkRouter({ missing: ["sms_action"] });
    await none.client.withSession(async (s) => {
      await assert.rejects(fullSession(s).sms.list());
    });
  });

  it("marks a message read and deletes one by the router's own tag, found again by listing", async () => {
    const { client, state, writes } = dlinkRouter({
      inbox: [
        { tag: "inbox-a", phone: "+353830000001", date: "26/10/10 04:07:40", msg: "one", read: 0 },
        { tag: "1002", phone: "DemoBank", date: "26/10/11 09:30:00", msg: "two", read: 0 },
      ],
    });
    const handle = dlinkSmsHandle("inbox-a");
    await client.withSession(async (s) => {
      const sms = fullSession(s).sms as Required<DriverSms>;
      const read = newCheck();
      await sms.markRead([handle, 999_999], read);
      assert.deepEqual([read.endpoints, read.readback], [["dlink:sms_action.set_read"], "match"], "a handle the router no longer lists costs no write");
      const both = newCheck();
      await sms.markRead([1002], both);
      assert.equal(both.readback, "match");
      const gone = newCheck();
      await sms.delete([handle], gone);
      assert.deepEqual([gone.endpoints, gone.readback], [["dlink:sms_action.del"], "match"]);
    });
    assert.deepEqual(writes, [
      { CfgType: "sms_action", type: "inbox", cmd: "set_read", tag: "inbox-a" },
      { CfgType: "sms_action", type: "inbox", cmd: "set_read", tag: "1002" },
      { CfgType: "sms_action", type: "inbox", cmd: "del", tag: "inbox-a" },
    ]);
    assert.deepEqual(state.inbox.map((m) => [m.tag, m.read]), [["1002", 1]]);
  });
});

describe("d-link: through the daemon, like every other brand", () => {
  it("polls in the shapes every brand fills, opens the brand's writes, and refuses a lock before any session", async () => {
    const { mock, state, logins } = dlinkRouter({ autoConnect: false });
    const fx = daemonOn("dlink", mock.fetchImpl, DLINK_URL, DLINK_PASSWORD, "admin");
    try {
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.deepEqual([snap.device.deviceName, snap.rf.ratCode, snap.rf.pccBand, snap.rf.lteRsrpDbm, snap.status?.sim?.state], ["DWR-960", "LTE", "B1", -95, "ready"]);
      assert.equal(logins.length, 1);
      const features = fx.core.scheduler.getStatus().device.features;
      assert.deepEqual(
        [features.reboot, features.reconnect, features.mobileData, features.smsWrite, features.networkMode, features.apn, features.ussd, features.bandLock, features.cellLock, features.antenna, features.roaming],
        ["enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented", "not_implemented", "not_implemented", "not_implemented"]
      );
      // No lock on this interface: refused before any session, nothing sent
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [1, 3] }), (err: unknown) => err instanceof DeviceReadOnlyError && err.errorCode === "DEVICE_UNVERIFIED_READ_ONLY" && err.feature === "bandLock");
      assert.equal(logins.length, 1, "no session for a write the brand does not have");
      assert.equal(fx.core.scheduler.device.skips("neighbors"), true, "the background sweep leaves nearby cells out on this brand");
      assert.equal(await fx.core.monitor.refreshNeighbors(), null, "and a read someone asks for finds none");

      // A redial is the connect button off, then on, and the connect goes out whatever happened
      const done = await fx.core.controls.reconnectCellular();
      assert.equal(done.reconnecting, true);
      const record = fx.core.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.endpoints], ["reconnect_cellular", "reconnect", ["dlink:connect_btn.disconnect", "dlink:connect_btn.connect"]]);
      assert.equal(state.connected, true);

      // A network type change is watched for the WAN like on every brand, with the type it replaced
      const mode = await fx.core.controls.setNetworkMode("lte", { confirm: true });
      assert.equal(mode.networkMode, "lte");
      assert.deepEqual(fx.linkChanges.map((notice) => [notice.kind, notice.change]), [["network_mode", { kind: "network_mode", previous: "auto" }]]);
      await assert.rejects(fx.core.controls.setNetworkMode("nr_sa", { confirm: true }), /offers no "nr_sa" network mode \(it offers auto, lte, wcdma, gsm\)/);

      // An access point's credentials are in no summary, audit detail or write record
      await fx.core.controls.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "pap", username: "demo-user", password: "demo-secret" }, { confirm: true });
      assert.equal(state.profile.passwd, "demo-secret");
      assert.ok(!/demo-user|demo-secret/.test(fx.trail()));
      const answer = await fx.core.controls.sendUssd({ kind: "cancel" }, { confirm: true });
      assert.equal(answer.state, "cancelled");
    } finally {
      await fx.cleanup();
    }
  });
});
