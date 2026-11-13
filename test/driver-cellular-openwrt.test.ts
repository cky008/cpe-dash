import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PIN_REFUSALS } from "../src/backends/driver.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/session-errors.ts";
import { parseCops, parseCopsScan } from "../src/drivers/cellular.ts";
import { parseCgdcont, quectelModeOf } from "../src/drivers/openwrt.ts";
import { cellularOf, daemonOn, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";

/**
 * OpenWrt with a Quectel or Fibocom module: the cellular settings its own AT commands define (the
 * network mode, the radio switch, the card's PIN, the first PDP context's access point). Mock routers
 * only, with placeholder PINs and access point names.
 */

const wrote = (commands: ReadonlyArray<string>, prefix: string): string[] => commands.filter((cmd) => cmd.startsWith(prefix) && !cmd.endsWith("?"));

describe("openwrt: reading the module's answers", () => {
  it("names a Quectel module's mode from mode_pref, with nr5g_disable_mode telling SA from NSA", () => {
    const pref = (value: string): string => `+QNWPREFCFG: "mode_pref",${value}\n\nOK\n`;
    const disable = (value: string): string => `+QNWPREFCFG: "nr5g_disable_mode",${value}\n\nOK\n`;
    assert.equal(quectelModeOf(pref("AUTO"), disable("0")), "auto");
    assert.equal(quectelModeOf(pref("WCDMA"), disable("0")), "wcdma");
    assert.equal(quectelModeOf(pref("LTE"), disable("2")), "lte");
    assert.equal(quectelModeOf(pref("NR5G"), disable("2")), "nr_sa");
    assert.equal(quectelModeOf(pref("LTE:NR5G"), disable("1")), "nr_nsa");
    // 5G with neither half switched off is not one of the modes FengSui names
    assert.equal(quectelModeOf(pref("NR5G"), disable("0")), null);
    assert.equal(quectelModeOf(pref("LTE:NR5G"), ""), null);
    assert.equal(quectelModeOf("ERROR\n", ""), null);
  });

  it("reads the first PDP context of AT+CGDCONT?, and nothing from an answer that is not one", () => {
    const answer = '+CGDCONT: 1,"IPV4V6","internet","0.0.0.0",0,0\n+CGDCONT: 2,"IP","ims","0.0.0.0",0,0\n\nOK\n';
    assert.deepEqual(parseCgdcont(answer), { apn: "internet", ipType: "ipv4v6" });
    assert.deepEqual(parseCgdcont(answer, 2), { apn: "ims", ipType: "ipv4" });
    assert.deepEqual(parseCgdcont('+CGDCONT: 1,"IPV6",""\nOK\n'), { apn: "", ipType: "ipv6" }, "an empty name: the network assigns one");
    assert.equal(parseCgdcont(answer, 3), null);
    assert.equal(parseCgdcont('+CGDCONT: 1,"PPP","internet"\nOK\n'), null, "a type FengSui does not write");
    assert.equal(parseCgdcont('+CGDCONT: 1,"IP","inter net"\nOK\n'), null, "not an access point name");
    assert.equal(parseCgdcont("ERROR\n"), null);
  });
});

describe("openwrt: the cellular settings", () => {
  it("reads the mode, the modes of the module's make, the PIN attempts and the access point", async () => {
    const quectel = openwrtRouter({ brand: "quectel" });
    assert.deepEqual(await quectel.client.withSession((s) => cellularOf(s).read()), {
      networkMode: "auto",
      operator: { selection: "auto", plmn: null },
      networkModes: ["auto", "nr_sa", "nr_nsa", "lte", "wcdma"],
      pinAttemptsLeft: 3,
      apn: { mode: "manual", apn: "internet", ipType: "ipv4v6", auth: null, hasUsername: null },
      apnRestore: { mode: "context", apn: "internet", ipType: "ipv4v6" },
    });
    const fibocom = openwrtRouter({ brand: "fibocom", cgdcont: '"IP",""' });
    const read = await fibocom.client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([read?.networkMode, read?.networkModes, read?.pinAttemptsLeft], ["auto", ["auto", "nr_sa"], null]);
    assert.deepEqual(read?.apn, { mode: "auto", apn: null, ipType: "ipv4", auth: null, hasUsername: null });
  });

  it("sets a Quectel module's mode with mode_pref (3G only too) and reads it back", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel" });
    const wcdma = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("wcdma", wcdma));
    assert.deepEqual(wrote(state.executedCommands, 'AT+QNWPREFCFG="mode_pref",'), ['AT+QNWPREFCFG="mode_pref",WCDMA']);
    assert.deepEqual(wcdma, { endpoints: ["openwrt:AT+QNWPREFCFG/mode_pref"], readback: "match", reason: null });
    const sa = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("nr_sa", sa));
    assert.deepEqual([state.modePref, state.nrDisableMode], ["NR5G", "2"]);
    assert.deepEqual(sa, { endpoints: ["openwrt:AT+QNWPREFCFG/nr5g_disable_mode", "openwrt:AT+QNWPREFCFG/mode_pref"], readback: "match", reason: null });
    const lte = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("lte", lte));
    assert.deepEqual([state.modePref, lte.readback], ["LTE", "match"]);
    const count = state.executedCommands.length;
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("gsm", newCheck())), CpeControlValidationError);
    assert.deepEqual(wrote(state.executedCommands.slice(count), "AT+QNWPREFCFG"), []);
    // A module that answers ERROR refuses the write
    const refusing = openwrtRouter({ brand: "quectel", atErrors: ['AT+QNWPREFCFG="mode_pref",'] });
    await assert.rejects(refusing.client.withSession((s) => cellularOf(s).setNetworkMode("lte", newCheck())), CpeApiError);
  });

  it("sets a Fibocom module's mode in AT+GTACT with its locked bands sent back", async () => {
    const { client, state } = openwrtRouter({ brand: "fibocom" });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("nr_sa", check));
    assert.equal(state.fibocomAct, "14,6,2,101,103,541,578");
    assert.deepEqual(check, { endpoints: ["openwrt:AT+GTACT"], readback: "match", reason: null });
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("lte", newCheck())), /automatic \(4G \+ 5G\) and 5G standalone only/);
    assert.equal(state.fibocomAct, "14,6,2,101,103,541,578");
  });

  it("switches the radio off and on with AT+CFUN, and the poll shows it", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel" });
    const on = newCheck();
    await client.withSession((s) => cellularOf(s).setAirplaneMode(true, on));
    assert.deepEqual([state.cfun, wrote(state.executedCommands, "AT+CFUN=")], [4, ["AT+CFUN=4"]]);
    assert.deepEqual(on, { endpoints: ["openwrt:AT+CFUN"], readback: "match", reason: null });
    assert.equal((await client.withSession((s) => s.telemetry()))?.status?.airplaneMode, true);
    await client.withSession((s) => cellularOf(s).setAirplaneMode(false, newCheck()));
    assert.equal(state.cfun, 1);
  });

  it("enters a PIN and changes the PIN lock once each; the card's error is an answer", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel", cpin: "SIM PIN" });
    const wrong = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("0000", wrong)), { accepted: false, attemptsLeft: 2 });
    assert.deepEqual(wrong, { endpoints: ["openwrt:AT+CPIN"], readback: "none", reason: null });
    assert.equal(wrote(state.executedCommands, "AT+CPIN=").length, 1, "one attempt, nothing after it");
    const right = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("1234", right)), { accepted: true, attemptsLeft: 3 });
    assert.deepEqual([state.cpin, right.readback], ["READY", "match"]);
    const lock = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(true, "1234", lock)), { accepted: true, attemptsLeft: 3 });
    assert.deepEqual([state.pinLock, lock.endpoints, lock.readback], [true, ["openwrt:AT+CLCK"], "match"]);
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(false, "0000", newCheck())), { accepted: false, attemptsLeft: 2 });
    assert.equal(state.pinLock, true, "a wrong PIN changes nothing");
  });

  it("writes the first PDP context's access point and type, and no credentials", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel" });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "none", username: "", password: "" }, check, noWait));
    assert.deepEqual(wrote(state.executedCommands, "AT+CGDCONT="), ['AT+CGDCONT=1,"IP","example.apn"']);
    assert.deepEqual(check, { endpoints: ["openwrt:AT+CGDCONT"], readback: "match", reason: null });
    // Automatic: an empty name, the type the module has
    await client.withSession((s) => cellularOf(s).setApn({ mode: "auto" }, newCheck(), noWait));
    assert.equal(state.cgdcont, '"IP",""');
    // What a change replaced is written back as it was
    await client.withSession((s) => cellularOf(s).restoreApn({ mode: "context", apn: "internet", ipType: "ipv4v6" }, newCheck(), noWait));
    assert.equal(state.cgdcont, '"IPV4V6","internet"');
    const count = wrote(state.executedCommands, "AT+CGDCONT=").length;
    await assert.rejects(client.withSession((s) => cellularOf(s).setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4", auth: "pap", username: "user", password: "pass" }, newCheck(), noWait)), /no command on record for its user name and password/);
    await assert.rejects(client.withSession((s) => cellularOf(s).restoreApn({ mode: "profile", id: "2" }, newCheck(), noWait)), CpeControlValidationError);
    assert.equal(wrote(state.executedCommands, "AT+CGDCONT=").length, count);
  });
});

describe("cellular settings through the daemon (openwrt)", () => {
  it("hands self-healing the access point a change replaced, and puts it back only while the outage is not deliberate", async () => {
    const { mock, state } = openwrtRouter({ brand: "quectel" });
    const fx = daemonOn("openwrt", mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      const result = await fx.core.controls.setApn({ mode: "manual", apn: "example.apn", ipType: "ipv4v6", auth: "none", username: "", password: "" }, { confirm: true });
      assert.deepEqual([result.apnMode, result.cellular?.apn?.apn], ["manual", "example.apn"]);
      const previous = { mode: "context", apn: "internet", ipType: "ipv4v6" } as const;
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "apn", previous });
      assert.equal(fx.applied.at(-1)?.summaryEn, "Access point (APN) changed (experimental write, read back: matches)");
      assert.ok(!fx.trail().includes("example.apn"), "the summary and the records name no access point");
      // The WAN is up: nothing to put back
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous }), { applied: false, skipped: "wan_up" });
      state.serving = "none";
      // The radio was switched off on purpose: the outage is not the change's doing
      state.cfun = 4;
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous }), { applied: false, skipped: "airplane_mode" });
      assert.equal(state.cgdcont, '"IPV4V6","example.apn"');
      state.cfun = 1;
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "apn", previous }), { applied: true });
      assert.equal(state.cgdcont, '"IPV4V6","internet"');
      assert.equal(fx.applied.at(-1)?.action, "auto_restore_apn");
    } finally {
      await fx.cleanup();
    }
  });

  it("sends no PIN on a module that reports no attempts count, and switches airplane mode without a watch", async () => {
    const { mock, state } = openwrtRouter({ brand: "fibocom", cpin: "SIM PIN" });
    const fx = daemonOn("openwrt", mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      await assert.rejects(fx.core.controls.enterSimPin("1234", { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && err.message === PIN_REFUSALS.unknown);
      assert.deepEqual(wrote(state.executedCommands, "AT+CPIN="), []);
      assert.deepEqual(await fx.core.controls.setAirplaneMode(true, { confirm: true }), { airplaneMode: true });
      assert.equal(fx.applied.at(-1)?.summaryZh, "飞行模式已打开，路由器已断开移动网络（实验性写入，回读一致）");
      assert.equal(fx.linkChanges.length, 0, "a deliberate disconnect is never put back");
    } finally {
      await fx.cleanup();
    }
  });
});

/** Two networks found, then the lists of modes and formats the module supports (3GPP TS 27.007 §7.3). */
const COPS_SCAN = '+COPS: (2,"DemoNet","Demo","27201",7),(1,"Three","3","27202",12),(3,"","OtherNet","27203",2),,(0-4),(0-2)';

const searches = (commands: ReadonlyArray<string>): string[] => commands.filter((cmd) => cmd === "AT+COPS=?");

describe("openwrt: choosing the operator with AT+COPS", () => {
  it("reads the answers of AT+COPS? and AT+COPS=?", () => {
    assert.deepEqual(parseCops('+COPS: 0,0,"Three",11\n\nOK\n'), { mode: 0, format: 0, operator: "Three" });
    assert.deepEqual(parseCops('+COPS: 1,2,"27202",7\nOK\n'), { mode: 1, format: 2, operator: "27202" });
    assert.deepEqual(parseCops("+COPS: 2\nOK\n"), { mode: 2, format: null, operator: null });
    assert.equal(parseCops("ERROR\n"), null);
    assert.deepEqual(parseCopsScan(COPS_SCAN), [
      { plmn: "27201", name: "DemoNet", rat: "4G", state: "current" },
      { plmn: "27202", name: "Three", rat: "5G", state: "available" },
      { plmn: "27203", name: "OtherNet", rat: "3G", state: "forbidden" },
    ]);
    assert.deepEqual(parseCopsScan("+COPS: ,,(0-4),(0-2)\nOK\n"), [], "no network found");
    assert.equal(parseCopsScan(`+COPS: ${'(1,"x","x","27201",7),'.repeat(200)}`).length, 64, "a bounded list");
  });

  it("searches once, and says so when the module cannot or the router stops waiting", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel", cops: { scan: COPS_SCAN } });
    const check = newCheck();
    const found = await client.withSession((s) => cellularOf(s).scanOperators(check, noWait));
    assert.deepEqual(found?.map((row) => row.plmn), ["27201", "27202", "27203"]);
    assert.deepEqual(searches(state.executedCommands), ["AT+COPS=?"]);
    assert.deepEqual(check, { endpoints: ["openwrt:AT+COPS/search"], readback: "none", reason: null });
    const refused = openwrtRouter({ brand: "quectel" });
    await assert.rejects(refused.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "cms-3");
    const silent = openwrtRouter({ brand: "quectel", cops: { scan: "" } });
    await assert.rejects(silent.client.withSession((s) => cellularOf(s).scanOperators(newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "timeout");
    assert.equal(searches(silent.state.executedCommands).length, 1, "asked once");
  });

  it("keeps the module on one operator by its code, with the technology only when one is named", async () => {
    const { client, state } = openwrtRouter({ brand: "quectel", cops: { scan: COPS_SCAN } });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, check, noWait));
    assert.deepEqual(wrote(state.executedCommands, "AT+COPS="), ['AT+COPS=1,2,"27202"']);
    assert.deepEqual(check, { endpoints: ["openwrt:AT+COPS"], readback: "match", reason: null });
    assert.deepEqual((await client.withSession((s) => cellularOf(s).read()))?.operator, { selection: "manual", plmn: null });
    state.executedCommands.length = 0;
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27201", rat: "4G" }, newCheck(), noWait));
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: "5G" }, newCheck(), noWait));
    assert.deepEqual(wrote(state.executedCommands, "AT+COPS="), ['AT+COPS=1,2,"27201",7', 'AT+COPS=1,2,"27202",12']);
    // Back to the module's own choice
    state.executedCommands.length = 0;
    const back = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "auto" }, back, noWait));
    assert.deepEqual([wrote(state.executedCommands, "AT+COPS="), back.readback, state.copsMode], [["AT+COPS=0"], "match", 0]);
    assert.deepEqual((await client.withSession((s) => cellularOf(s).read()))?.operator, { selection: "auto", plmn: null });
  });

  it("records a registration the module gave up on as a write that did not take, and sends nothing more", async () => {
    const { client, state } = openwrtRouter({ brand: "fibocom", cops: { registers: false } });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).selectOperator({ mode: "manual", plmn: "27202", rat: null }, check, noWait));
    assert.deepEqual([check.readback, check.reason], ["mismatch", "differs"]);
    assert.deepEqual(wrote(state.executedCommands, "AT+COPS="), ['AT+COPS=1,2,"27202"']);
    assert.equal(state.copsMode, 1, "the module stays in the mode it was told");
  });

  it("watches a hand-picked operator through the daemon, and hands the choice back when the WAN stays down", async () => {
    const { mock, state } = openwrtRouter({ brand: "quectel", cops: { scan: COPS_SCAN, registers: false } });
    const fx = daemonOn("openwrt", mock.fetchImpl, "http://192.168.1.1", OPENWRT_PASSWORD, "root");
    try {
      assert.equal((await fx.core.controls.scanOperators({ confirm: true })).length, 3);
      await fx.core.controls.selectOperator({ mode: "manual", plmn: "27202", rat: null }, { confirm: true });
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "operator", previous: { mode: "auto" } });
      assert.match(fx.applied.at(-1)?.summaryEn ?? "", /read back: differs/);
      // The module found no service on that operator: the way back is automatic selection
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "auto" } }), { applied: true });
      assert.deepEqual([state.copsMode, fx.applied.at(-1)?.action], [0, "auto_restore_operator"]);
    } finally {
      await fx.cleanup();
    }
  });
});
