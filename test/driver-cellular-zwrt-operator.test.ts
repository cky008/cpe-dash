import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/cpe-client.ts";
import { FENGSUI_APN_PROFILE, OPERATOR_POLLS, zwrtApnProfiles, zwrtScanRows } from "../src/drivers/cellular.ts";
import { cellularOf, daemonOn, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { ZWRT_PASSWORD, zwrtRouter } from "./helpers/zte-zwrt-router.ts";

/**
 * Choosing the operator and the access point on a ZTE router with zWRT. Mock routers only: made-up
 * operators on a placeholder network code, `internet` and `example.apn` as access points.
 */

const ROWS = [
  { name: "DemoNet", mcc_mnc: "27201", rat: "NR", status: "current" },
  { operator_name: "Three", plmn: "27202", rat: "LTE", status: "available" },
  { name: "OtherNet", mcc_mnc: "27203", rat: "LTE", status: "forbidden" },
];

const callsOf = (calls: Array<{ method: string; args: Record<string, unknown> }>, method: string): Array<Record<string, unknown>> => calls.filter((call) => call.method === method).map((call) => call.args);
const writesOf = (calls: Array<{ object: string; method: string }>): string[] => calls.filter((call) => call.object === "zwrt_apn_object" && !call.method.startsWith("get_")).map((call) => call.method);

describe("zte-zwrt: the shared parts", () => {
  it("reads a scan row by either of its spellings, once per operator and technology", () => {
    assert.deepEqual(zwrtScanRows([...ROWS, ROWS[0], { name: "x", mcc_mnc: "12", rat: "LTE" }, "junk", null, { name: "y", mcc_mnc: "27205", rat: "bad rat!" }]), [
      { choice: { plmn: "27201", name: "DemoNet", rat: "5G", state: "current" }, rat: "NR" },
      { choice: { plmn: "27202", name: "Three", rat: "4G", state: "available" }, rat: "LTE" },
      { choice: { plmn: "27203", name: "OtherNet", rat: "4G", state: "forbidden" }, rat: "LTE" },
    ]);
    assert.deepEqual(
      zwrtScanRows([
        { name: "a", mcc_mnc: "27201", rat: "7", status: "1" },
        { name: "b", mcc_mnc: "27202", rat: "WCDMA" },
        { name: "c", mcc_mnc: "27203", rat: "GSM" },
        { name: "d", mcc_mnc: "27204", rat: "" },
      ]).map((row) => [row.choice.rat, row.choice.state]),
      [
        ["4G", "available"],
        ["3G", "unknown"],
        ["2G", "unknown"],
        [null, "unknown"],
      ]
    );
    assert.deepEqual(zwrtScanRows("nothing"), []);
  });

  it("reads the profiles without their credentials", () => {
    const profiles = zwrtApnProfiles([{ profileId: 1, profilename: "Default", wanapn: "internet", pdpType: 3, pppAuthMode: 1, username: "demo-user", password: "demo-pass", isEnable: 1 }, { profileId: "p2", profilename: "Second", wanapn: "example.apn", pdpType: "1", pppAuthMode: "0", isEnable: false }, { profilename: "no id" }, 7]);
    assert.deepEqual(profiles, [
      { id: 1, name: "Default", apn: "internet", ipType: "ipv4v6", auth: "pap", hasUsername: true, enabled: true },
      { id: "p2", name: "Second", apn: "example.apn", ipType: "ipv4", auth: "none", hasUsername: false, enabled: false },
    ]);
    assert.ok(!JSON.stringify(profiles).includes("demo-"));
  });
});

describe("zte-zwrt: choosing the operator", () => {
  it("searches, waits for the router to say it is done, and reads the list", async () => {
    const { client, calls } = zwrtRouter({ operators: { rows: ROWS, busy: 3 } });
    const check = newCheck();
    const found = await client.withSession((s) => cellularOf(s).scanOperators(check, noWait));
    assert.deepEqual(
      found?.map((row) => [row.plmn, row.name, row.rat, row.state]),
      [
        ["27201", "DemoNet", "5G", "current"],
        ["27202", "Three", "4G", "available"],
        ["27203", "OtherNet", "4G", "forbidden"],
      ]
    );
    assert.deepEqual(callsOf(calls, "nwinfo_manual_scan"), [{}]);
    assert.equal(callsOf(calls, "nwinfo_m_netselect_status").length, 4);
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zte_nwinfo_api.nwinfo_manual_scan"], readback: "none", reason: null });
    assert.equal(callsOf(calls, "set_wwaniface").length, 0, "the data call is left to the modem");
  });

  it("does not take the end of an earlier search for this one's", async () => {
    // The status says "done" from the first ask: believed only after a few
    const { client, calls } = zwrtRouter({ operators: { rows: ROWS, busy: 0 } });
    assert.equal((await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)))?.length, 3);
    assert.equal(callsOf(calls, "nwinfo_m_netselect_status").length, 7);
  });

  it("gives up on a search that fails or never ends", async () => {
    for (const status of ["failed", "manual_search_fail"]) {
      const failed = zwrtRouter({ operators: { rows: ROWS, status } });
      await assert.rejects(failed.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "failed", status);
    }
    // The words the router's own page waits on: still searching, then done
    const paged = zwrtRouter({ operators: { rows: ROWS, status: "manual_selected" } });
    assert.equal((await paged.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)))?.length, 3);
    const endless = zwrtRouter({ operators: { rows: ROWS, busy: OPERATOR_POLLS + 5 } });
    await assert.rejects(endless.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "timeout");
    assert.equal(callsOf(endless.calls, "nwinfo_manual_scan").length, 1, "asked once");
  });

  it("registers on a row of the last search with the technology as the router wrote it", async () => {
    const { client, calls } = zwrtRouter({ operators: { rows: ROWS, register: "success" } });
    await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: "4G" }, check, noWait));
    assert.deepEqual(callsOf(calls, "nwinfo_manual_register"), [{ m_mcc_mnc: "27202", m_rat: "LTE" }]);
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zte_nwinfo_api.nwinfo_manual_register"], readback: "match", reason: null });
    assert.deepEqual((await client.withSession((s) => cellularOf(s).read()))?.operator, { selection: "manual", plmn: null });
  });

  it("sends nothing for an operator the search does not list, lists as forbidden, or lists on another technology", async () => {
    const { client, calls } = zwrtRouter({ operators: { rows: ROWS, register: "success" } });
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, newCheck(), noWait)), /search for networks first/);
    await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27299", rat: null }, newCheck(), noWait)), CpeControlValidationError);
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27203", rat: null }, newCheck(), noWait)), CpeControlValidationError);
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: "3G" }, newCheck(), noWait)), CpeControlValidationError);
    assert.deepEqual(callsOf(calls, "nwinfo_manual_register"), []);
  });

  it("records a registration the router gave up on, or never reported, without sending it again", async () => {
    const failed = zwrtRouter({ operators: { rows: ROWS, register: "fail" } });
    await failed.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    const check = newCheck();
    await failed.client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, check, noWait));
    assert.deepEqual([check.readback, check.reason, callsOf(failed.calls, "nwinfo_manual_register").length], ["mismatch", "differs", 1]);
    const silent = zwrtRouter({ operators: { rows: ROWS } });
    await silent.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    const unknown = newCheck();
    await silent.client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, unknown, noWait));
    assert.deepEqual([unknown.readback, unknown.reason, callsOf(silent.calls, "nwinfo_manual_register").length], ["unknown", "unreadable", 1]);
  });

  it("hands the choice back to the router", async () => {
    const { client, calls, netinfo } = zwrtRouter({ operators: { rows: ROWS, register: "success" } });
    netinfo["net_select_mode"] = "manual_select";
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "auto" }, check, noWait));
    assert.deepEqual(callsOf(calls, "nwinfo_set_netselect"), [{ net_select_mode: "auto_select" }]);
    assert.deepEqual([check.readback, netinfo["net_select"], netinfo["net_select_mode"]], ["match", "WL_AND_5G", "auto_select"]);
  });
});

describe("zte-zwrt: the access point", () => {
  const DEFAULT = { profileId: 1, profilename: "Default", wanapn: "internet", pdpType: 3, pppAuthMode: 1, username: "demo-user", password: "demo-pass", isEnable: 1 };

  it("reads the mode, the profile in use without its credentials, and what to go back to", async () => {
    const auto = await zwrtRouter({ apn: { mode: 0, profiles: [DEFAULT] } }).client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([auto?.apn, auto?.apnRestore], [{ mode: "auto", apn: null, ipType: null, auth: null, hasUsername: null }, { mode: "auto" }]);
    const manual = await zwrtRouter({ apn: { mode: 1, profiles: [DEFAULT] } }).client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([manual?.apn, manual?.apnRestore], [{ mode: "manual", apn: "internet", ipType: "ipv4v6", auth: "pap", hasUsername: true }, { mode: "profile", id: "1" }]);
    assert.ok(!JSON.stringify(manual).includes("demo-"));
    // A firmware without the object: nothing is made up
    const plain = await zwrtRouter().client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([plain?.apn, plain?.apnRestore, plain?.operator], [undefined, undefined, undefined]);
  });

  it("adds its own profile, makes it the one in use and switches to manual", async () => {
    const { client, calls, state } = zwrtRouter({ apn: { mode: 0, profiles: [DEFAULT] } });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "chap", username: "demo-user", password: "demo-pass" }, check, noWait));
    assert.deepEqual(writesOf(calls), ["add_manu_apn", "enable_manu_apn_id", "set_apn_mode"]);
    assert.deepEqual(callsOf(calls, "add_manu_apn"), [{ profilename: FENGSUI_APN_PROFILE, wanapn: "example.apn", pdpType: 1, pppAuthMode: 2, username: "demo-user", password: "demo-pass" }]);
    assert.deepEqual([callsOf(calls, "enable_manu_apn_id"), callsOf(calls, "set_apn_mode")], [[{ profileId: 2 }], [{ apn_mode: 1 }]]);
    assert.deepEqual([check.readback, check.reason], ["match", null]);
    assert.deepEqual(state.apn?.profiles[0], { ...DEFAULT, isEnable: 0 }, "the router's own profile keeps its contents");
    // FengSui's profile is in use: the next change overwrites it, with nothing of it to go back to
    assert.equal((await client.withSession((s) => cellularOf(s).read()))?.apnRestore, null);
    calls.length = 0;
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "internet", ipType: "ipv6", auth: "none", username: "", password: "" }, newCheck(), noWait));
    assert.deepEqual(writesOf(calls), ["modify_manu_apn", "enable_manu_apn_id"]);
    assert.deepEqual(callsOf(calls, "modify_manu_apn"), [{ profileId: 2, profilename: FENGSUI_APN_PROFILE, wanapn: "internet", pdpType: 2, pppAuthMode: 0, username: "", password: "" }]);
    assert.equal(state.apn?.profiles.length, 2, "no third profile");
  });

  it("switches back to automatic, or to the profile that was in use", async () => {
    const { client, calls, state } = zwrtRouter({ apn: { mode: 1, profiles: [DEFAULT, { profileId: 2, profilename: FENGSUI_APN_PROFILE, wanapn: "example.apn", pdpType: 1, pppAuthMode: 0, isEnable: 0 }] } });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "auto" }, check, noWait));
    assert.deepEqual([callsOf(calls, "set_apn_mode"), check.readback, state.apn?.mode], [[{ apn_mode: 0 }], "match", 0]);
    calls.length = 0;
    const back = newCheck();
    await client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "1" }, back, noWait));
    assert.deepEqual(writesOf(calls), ["enable_manu_apn_id", "set_apn_mode"]);
    assert.deepEqual([callsOf(calls, "enable_manu_apn_id"), back.readback, state.apn?.mode], [[{ profileId: 1 }], "match", 1]);
    // A profile that is gone, FengSui's own, and a way back this router has no call for: nothing sent
    calls.length = 0;
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "9" }, newCheck(), noWait)), /no longer on the router/);
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "2" }, newCheck(), noWait)), /no longer on the router/);
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "context", apn: "internet", ipType: "ipv4" }, newCheck(), noWait)), CpeControlValidationError);
    assert.deepEqual(writesOf(calls), []);
    await client.withSession((s) => cellularOf(s).restoreApn({ mode: "auto" }, newCheck(), noWait));
    assert.deepEqual(callsOf(calls, "set_apn_mode"), [{ apn_mode: 0 }]);
  });

  it("stops when the router did not keep the profile", async () => {
    const forgetful = zwrtRouter({ apn: { mode: 0, profiles: [DEFAULT] } });
    const original = forgetful.mock.handler;
    forgetful.mock.handler = async (req) => {
      const reply = await original(req);
      if (forgetful.state.apn) forgetful.state.apn.profiles = forgetful.state.apn.profiles.filter((profile) => profile["profilename"] !== FENGSUI_APN_PROFILE);
      return reply;
    };
    await assert.rejects(forgetful.client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "unsaved");
    assert.deepEqual(writesOf(forgetful.calls), ["add_manu_apn"], "nothing is switched to a profile that is not there");
  });
});

describe("zte-zwrt: the operator and the access point through the daemon", () => {
  it("watches a hand-picked operator and a changed access point, and puts each back", async () => {
    const { mock, state, netinfo } = zwrtRouter({ operators: { rows: ROWS, register: "success" }, apn: { mode: 0, profiles: [{ profileId: 1, profilename: "Default", wanapn: "internet", pdpType: 3, pppAuthMode: 0, isEnable: 1 }] } });
    const fx = daemonOn("zte-zwrt", mock.fetchImpl, "http://192.168.0.1", ZWRT_PASSWORD);
    try {
      assert.equal((await fx.core.controls.scanOperators({ confirm: true })).length, 3);
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27202", rat: null }, { confirm: true });
      const done = await fx.core.controls.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", username: "demo-user", password: "demo-pass" }, { confirm: true });
      assert.deepEqual(done.cellular?.apn, { mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", hasUsername: true });
      assert.deepEqual(
        fx.linkChanges.map((notice) => notice.change),
        [
          { kind: "operator", previous: { mode: "auto" } },
          { kind: "apn", previous: { mode: "auto" } },
        ]
      );
      const trail = fx.trail();
      assert.ok(!trail.includes("example.apn") && !trail.includes("demo-user") && !trail.includes("demo-pass"), "nothing of the access point is kept");
      // The WAN is up: nothing is put back. Down: each goes back to what it was
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous: { mode: "auto" } }), { applied: false, skipped: "wan_up" });
      state.wwan["connect_status"] = "disconnected";
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous: { mode: "auto" } }), { applied: true });
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "auto" } }), { applied: true });
      assert.deepEqual([state.apn?.mode, netinfo["net_select_mode"]], [0, "auto_select"]);
      assert.deepEqual(
        fx.applied.slice(-2).map((event) => event.action),
        ["auto_restore_apn", "auto_restore_operator"]
      );
    } finally {
      await fx.cleanup();
    }
  });
});
