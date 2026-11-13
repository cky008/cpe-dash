import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/session-errors.ts";
import { FENGSUI_APN_PROFILE } from "../src/drivers/cellular.ts";
import { OPERATOR_POLLS, zteApnProfiles, zteScanRows } from "../src/drivers/zte/cellular.ts";
import { cellularOf, daemonOn, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { ZTE_PASSWORD, zteApnProfile, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * Choosing the operator and the access point on a ZTE router with the goform pages. Both are changed
 * the way the router's own page changes them: with the data connection down, and connected again at
 * the end. Mock routers only: made-up operators on a placeholder network code, `internet` and
 * `example.apn` as access points.
 */

const SCAN = '2,"DemoNet","27201",7,1;1,"Three","27202",7,1;3,"OtherNet","27203",2;1,"FarNet","27204",12,0';

const sent = (state: { posts: Array<{ goformId: string }> }): string[] => state.posts.map((post) => post.goformId).filter((id) => id !== "LOGOUT");
const posted = (state: { posts: Array<{ goformId: string; fields: URLSearchParams }> }, goformId: string): Array<Record<string, string>> =>
  state.posts.filter((post) => post.goformId === goformId).map((post) => Object.fromEntries([...post.fields].filter(([key]) => key !== "AD" && key !== "isTest" && key !== "goformId")));

describe("zte-goform: the shared parts", () => {
  it("keeps the two technology numbers of a scan row as the router gave them", () => {
    assert.deepEqual(zteScanRows(SCAN), [
      { choice: { plmn: "27201", name: "DemoNet", rat: "4G", state: "current" }, act: "7", subrat: "1" },
      { choice: { plmn: "27202", name: "Three", rat: "4G", state: "available" }, act: "7", subrat: "1" },
      { choice: { plmn: "27203", name: "OtherNet", rat: "3G", state: "forbidden" }, act: "2", subrat: "" },
      { choice: { plmn: "27204", name: "FarNet", rat: "5G", state: "available" }, act: "12", subrat: "0" },
    ]);
    assert.deepEqual(zteScanRows('1,"x","27201",7,zz;junk;1,"y","12",7'), [{ choice: { plmn: "27201", name: "x", rat: "4G", state: "available" }, act: "7", subrat: "" }]);
    assert.deepEqual(zteScanRows(undefined), []);
  });

  it("counts the profiles that are there, and takes nothing but a name and an address type from them", () => {
    const raw = { APN_configtmp0: zteApnProfile("Default", "internet", "IPv4v6", "pap", "demo-user", "demo-pass"), APN_configtmp1: "", APN_configtmp2: zteApnProfile("Second", "example.apn"), APN_configtmp3: "($)x", APN_configtmp4: "Odd($)x" };
    assert.deepEqual(zteApnProfiles(raw), [
      { index: 0, name: "Default", pdpType: "IPv4v6" },
      { index: 1, name: "Second", pdpType: "IP" },
      { index: 2, name: "Odd", pdpType: null },
    ]);
    assert.deepEqual(zteApnProfiles({}), []);
  });
});

describe("zte-goform: choosing the operator", () => {
  it("searches with the connection down, and connects again once", async () => {
    const { state, client } = zteRouter({ operators: { scan: SCAN, busy: 2 } });
    const check = newCheck();
    const found = await client.withSession((s) => cellularOf(s).scanOperators(check, noWait));
    assert.deepEqual(
      found?.map((row) => [row.plmn, row.name, row.rat, row.state]),
      [
        ["27201", "DemoNet", "4G", "current"],
        ["27202", "Three", "4G", "available"],
        ["27203", "OtherNet", "3G", "forbidden"],
        ["27204", "FarNet", "5G", "available"],
      ]
    );
    assert.deepEqual(sent(state), ["DISCONNECT_NETWORK", "SCAN_NETWORK", "CONNECT_NETWORK"]);
    assert.equal(state.values["ppp_status"], "ppp_connected");
    assert.deepEqual(check, { endpoints: ["zte-goform:DISCONNECT_NETWORK", "zte-goform:SCAN_NETWORK", "zte-goform:CONNECT_NETWORK"], readback: "none", reason: null });
    // A connection that was down already stays down: nothing is connected for the owner
    const down = zteRouter({ operators: { scan: SCAN } });
    down.state.values["ppp_status"] = "ppp_disconnected";
    await down.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    assert.deepEqual(sent(down.state), ["SCAN_NETWORK"]);
    assert.equal(down.state.values["ppp_status"], "ppp_disconnected");
  });

  it("gives up on a search that never ends, and still connects again", async () => {
    const { state, client, mock } = zteRouter({ operators: { scan: SCAN, busy: OPERATOR_POLLS + 5 } });
    const before = mock.requests.length;
    await assert.rejects(client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "timeout");
    assert.deepEqual(sent(state), ["DISCONNECT_NETWORK", "SCAN_NETWORK", "CONNECT_NETWORK"]);
    assert.equal(mock.requests.slice(before).filter((r) => r.query.get("cmd") === "m_netselect_status").length, OPERATOR_POLLS);
    // A router with no search answers the form with a failure: the connection comes back all the same
    const none = zteRouter();
    await assert.rejects(none.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
    assert.deepEqual(sent(none.state), ["DISCONNECT_NETWORK", "SCAN_NETWORK", "CONNECT_NETWORK"]);
  });

  it("registers on a row of the last search with that row's own numbers", async () => {
    const { state, client } = zteRouter({ operators: { scan: SCAN, register: "manual_success" } });
    await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    state.posts.length = 0;
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: "4G" }, check, noWait));
    assert.deepEqual(posted(state, "SET_NETWORK"), [{ NetworkNumber: "27202", Rat: "7", nSubrat: "1" }]);
    assert.deepEqual(sent(state), ["DISCONNECT_NETWORK", "SET_NETWORK", "CONNECT_NETWORK"]);
    assert.deepEqual([check.readback, check.reason], ["match", null]);
    assert.deepEqual((await client.withSession((s) => cellularOf(s).read()))?.operator, { selection: "manual", plmn: null });
    // No technology named: the first row of that operator; a 3G row has no second number to send
    state.posts.length = 0;
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27203", rat: null }, newCheck(), noWait));
    assert.deepEqual(posted(state, "SET_NETWORK"), [{ NetworkNumber: "27203", Rat: "2", nSubrat: "" }]);
  });

  it("sends nothing for an operator the last search does not list, or a technology the page cannot register", async () => {
    const { state, client } = zteRouter({ operators: { scan: SCAN, register: "manual_success" } });
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, newCheck(), noWait)), /search for networks first/);
    await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    state.posts.length = 0;
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27299", rat: null }, newCheck(), noWait)), CpeControlValidationError);
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: "3G" }, newCheck(), noWait)), /search for networks first/);
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27204", rat: null }, newCheck(), noWait)), /2G, 3G and 4G networks only/);
    assert.deepEqual(sent(state), [], "not even a disconnect");
  });

  it("records a registration the router gave up on as a write that did not take", async () => {
    const failed = zteRouter({ operators: { scan: SCAN, register: "manual_fail" } });
    await failed.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    const check = newCheck();
    await failed.client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, check, noWait));
    assert.deepEqual([check.readback, check.reason], ["mismatch", "differs"]);
    assert.equal(posted(failed.state, "SET_NETWORK").length, 1, "sent once");
    assert.equal(sent(failed.state).at(-1), "CONNECT_NETWORK");
    // A router that never says how it went: unknown, and nothing is sent again
    const silent = zteRouter({ operators: { scan: SCAN } });
    await silent.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    const unknown = newCheck();
    await silent.client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, unknown, noWait));
    assert.deepEqual([unknown.readback, unknown.reason, posted(silent.state, "SET_NETWORK").length], ["unknown", "unreadable", 1]);
  });

  it("hands the choice back with the network mode the router has", async () => {
    const { state, client } = zteRouter({ operators: { scan: SCAN, register: "manual_success" } });
    await client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait));
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, newCheck(), noWait));
    state.values["net_select"] = "Only_LTE";
    state.posts.length = 0;
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "auto" }, check, noWait));
    assert.deepEqual(posted(state, "SET_BEARER_PREFERENCE"), [{ BearerPreference: "Only_LTE" }]);
    assert.deepEqual(sent(state), ["DISCONNECT_NETWORK", "SET_BEARER_PREFERENCE", "CONNECT_NETWORK"]);
    assert.deepEqual([check.readback, (await client.withSession((s) => cellularOf(s).read()))?.operator], ["match", { selection: "auto", plmn: null }]);
    // A mode that cannot be read is not guessed
    state.values["net_select"] = "";
    state.posts.length = 0;
    await assert.rejects(client.withSession((s) => cellularOf(s).selectOperator({ mode: "auto" }, newCheck(), noWait)), /nothing was sent/);
    assert.deepEqual(sent(state), []);
  });
});

describe("zte-goform: the access point", () => {
  const router = (extra: Partial<NonNullable<Parameters<typeof zteRouter>[0]>["apn"]> = {}) => zteRouter({ apn: { profiles: [zteApnProfile("Default", "internet", "IPv4v6")], ...extra } });

  it("reads the access point in use without its user name, and what to go back to", async () => {
    const { client, state } = router();
    const auto = await client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([auto?.apn, auto?.apnRestore], [{ mode: "auto", apn: "internet", ipType: "ipv4v6", auth: "none", hasUsername: false }, { mode: "auto" }]);
    Object.assign(state.values, { apn_mode: "manual", ppp_auth_mode: "PAP", ppp_username: "demo-user" });
    const manual = await client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([manual?.apn, manual?.apnRestore], [{ mode: "manual", apn: "internet", ipType: "ipv4v6", auth: "pap", hasUsername: true }, { mode: "profile", id: "0" }]);
    assert.ok(!JSON.stringify(manual).includes("demo-user"));
    // A router that says nothing of its access point: nothing is made up
    const plain = await zteRouter().client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([plain?.apn, plain?.apnRestore, plain?.operator], [undefined, undefined, undefined]);
  });

  it("saves its own profile after the router's, makes it the default, and connects again", async () => {
    const { client, state } = router();
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "chap", username: "demo-user", password: "demo-pass" }, check, noWait));
    assert.deepEqual(sent(state), ["DISCONNECT_NETWORK", "APN_PROC_EX", "APN_PROC_EX", "CONNECT_NETWORK"]);
    assert.deepEqual(posted(state, "APN_PROC_EX"), [
      { apn_action: "save", apn_mode: "manual", profile_name: FENGSUI_APN_PROFILE, wan_dial: "*99#", pdp_type: "IP", pdp_select: "auto", index: "1", wan_apn: "example.apn", ppp_auth_mode: "chap", ppp_username: "demo-user", ppp_passtmp: "demo-pass" },
      { apn_mode: "manual", apn_action: "set_default", set_default_flag: "1", pdp_type: "IP", index: "1" },
    ]);
    assert.deepEqual([check.readback, check.reason], ["match", null]);
    assert.equal(state.values["APN_configtmp0"], zteApnProfile("Default", "internet", "IPv4v6"), "the router's own profile is as it was");
    // FengSui's profile is in use now: the next change overwrites it, and there is nothing of it to go back to
    const now = await client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([now?.apn?.apn, now?.apnRestore], ["example.apn", null]);
    state.posts.length = 0;
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "internet", ipType: "ipv6", auth: "none", username: "", password: "" }, newCheck(), noWait));
    assert.deepEqual(posted(state, "APN_PROC_EX")[0], { apn_action: "save", apn_mode: "manual", profile_name: FENGSUI_APN_PROFILE, wan_dial: "*99#", pdp_type: "IPv6", pdp_select: "auto", index: "1", ipv6_wan_apn: "internet", ipv6_ppp_auth_mode: "none", ipv6_ppp_username: "", ipv6_ppp_passtmp: "" });
    assert.equal(state.values["APN_configtmp2"], undefined, "no third profile");
  });

  it("sends both address families' fields for a dual-stack access point", async () => {
    const { client, state } = router();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "none", username: "", password: "" }, newCheck(), noWait));
    assert.deepEqual(Object.keys(posted(state, "APN_PROC_EX")[0] ?? {}).slice(7), ["wan_apn", "ppp_auth_mode", "ppp_username", "ppp_passtmp", "dns_mode", "prefer_dns_manual", "standby_dns_manual", "ipv6_wan_apn", "ipv6_ppp_auth_mode", "ipv6_ppp_username", "ipv6_ppp_passtmp"]);
  });

  it("sends nothing when the list cannot be read or has no room", async () => {
    const unread = zteRouter({ apn: { profiles: [] } });
    await assert.rejects(unread.client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait)), /could not be read: nothing was sent/);
    const full = router({ profiles: [zteApnProfile("Default", "internet"), zteApnProfile("Second", "example.apn")], room: "2" });
    await assert.rejects(full.client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, newCheck(), noWait)), /list of access points is full/);
    assert.deepEqual([sent(unread.state), sent(full.state)], [[], []]);
  });

  it("switches back to automatic, or to the profile that was in use", async () => {
    const { client, state } = router({ mode: "manual" });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "auto" }, check, noWait));
    assert.deepEqual(posted(state, "APN_PROC_EX"), [{ apn_mode: "auto" }]);
    assert.deepEqual([check.readback, state.values["apn_mode"]], ["match", "auto"]);
    state.posts.length = 0;
    const back = newCheck();
    await client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "0" }, back, noWait));
    assert.deepEqual(posted(state, "APN_PROC_EX"), [{ apn_mode: "manual", apn_action: "set_default", set_default_flag: "1", pdp_type: "IPv4v6", index: "0" }]);
    assert.deepEqual([back.readback, sent(state)], ["match", ["DISCONNECT_NETWORK", "APN_PROC_EX", "CONNECT_NETWORK"]]);
    // A profile that is gone, and a way back this router has no form for: nothing sent
    state.posts.length = 0;
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "7" }, newCheck(), noWait)), /no longer on the router/);
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "context", apn: "internet", ipType: "ipv4" }, newCheck(), noWait)), CpeControlValidationError);
    assert.deepEqual(sent(state), []);
    state.posts.length = 0;
    await client.withSession((s) => cellularOf(s).restoreApn({ mode: "auto" }, newCheck(), noWait));
    assert.deepEqual(posted(state, "APN_PROC_EX"), [{ apn_mode: "auto" }]);
  });
});

describe("zte-goform: the operator and the access point through the daemon", () => {
  it("watches a hand-picked operator, and not the way back to automatic", async () => {
    const { mock, state } = zteRouter({ operators: { scan: SCAN, register: "manual_success" } });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      assert.equal((await fx.core.controls.scanOperators({ confirm: true })).length, 4);
      assert.equal(fx.applied.at(-1)?.summaryEn, "Searched for networks in range (4 found) (experimental write)");
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27202", rat: null }, { confirm: true });
      assert.deepEqual(
        fx.linkChanges.map((notice) => notice.change),
        [{ kind: "operator", previous: { mode: "auto" } }]
      );
      assert.deepEqual(fx.core.scheduler.genericWrites.at(-1)?.endpoints, ["zte-goform:DISCONNECT_NETWORK", "zte-goform:SET_NETWORK", "zte-goform:CONNECT_NETWORK"]);
      // The WAN is up: the watch has nothing to put back
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "auto" } }), { applied: false, skipped: "wan_up" });
      state.values["ppp_status"] = "ppp_disconnected";
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "auto" } }), { applied: true });
      assert.equal(state.values["net_select_mode"], "auto_select");
      assert.equal(fx.applied.at(-1)?.action, "auto_restore_operator");
      await fx.core.controls.selectOperator({ mode: "auto" }, { confirm: true });
      assert.equal(fx.linkChanges.length, 1, "handing the choice back is not watched");
      await assert.rejects(fx.core.controls.scanOperators({ confirm: false }), /confirm: true/);
    } finally {
      await fx.cleanup();
    }
  });

  it("changes the access point, keeps what to go back to, and leaves no name or credential behind", async () => {
    const { mock, state } = zteRouter({ apn: { profiles: [zteApnProfile("Default", "internet")] } });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      const done = await fx.core.controls.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", username: "demo-user", password: "demo-pass" }, { confirm: true });
      assert.equal(done.apnMode, "manual");
      assert.deepEqual(done.cellular?.apn, { mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", hasUsername: true });
      assert.deepEqual(
        fx.linkChanges.map((notice) => notice.change),
        [{ kind: "apn", previous: { mode: "auto" } }]
      );
      const trail = fx.trail();
      assert.ok(!trail.includes("example.apn") && !trail.includes("demo-user") && !trail.includes("demo-pass"), "nothing of the access point is kept");
      state.values["ppp_status"] = "ppp_disconnected";
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous: { mode: "auto" } }), { applied: true });
      assert.equal(state.values["apn_mode"], "auto");
      assert.equal(fx.applied.at(-1)?.action, "auto_restore_apn");
    } finally {
      await fx.cleanup();
    }
  });
});
