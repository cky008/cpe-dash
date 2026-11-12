import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PIN_REFUSALS } from "../src/backends/driver.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { CpeApiError } from "../src/cpe-client.ts";
import { USSD_POLLS } from "../src/drivers/cellular.ts";
import { DeviceReadOnlyError, DeviceWriteDisabledError } from "../src/scheduler.ts";
import { cellularOf, daemonOn, newCheck, noWait } from "./helpers/driver-daemon.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * The cellular settings on a ZTE router with the goform pages: what the driver sends for each write,
 * how it reads each back, and what the daemon makes of them (the gate, the PIN rule, the value kept for
 * the way back, and that no PIN or USSD text is left anywhere). Mock routers only: placeholder PINs,
 * `*100#`, a made-up operator answer.
 */

const posted = (state: { posts: Array<{ goformId: string; fields: URLSearchParams }> }, goformId: string): Array<Record<string, string>> =>
  state.posts.filter((post) => post.goformId === goformId).map((post) => Object.fromEntries([...post.fields].filter(([key]) => key !== "AD" && key !== "isTest" && key !== "goformId")));

describe("zte-goform: reading the cellular settings", () => {
  it("reads the mode, the slots, the data limit and the PIN attempts in one request", async () => {
    const { state, client, mock } = zteRouter({ sim: true, simSlot: "1" });
    Object.assign(state.values, { data_volume_limit_switch: "1", data_volume_limit_unit: "data", data_volume_limit_size: "20_1024", data_volume_alert_percent: "80" });
    const before = mock.requests.length;
    const read = await client.withSession((s) => cellularOf(s).read());
    assert.deepEqual(read, {
      networkMode: "auto",
      simSlots: [
        { kind: "physical", index: 1 },
        { kind: "embedded", index: 1 },
        { kind: "embedded", index: 2 },
      ],
      simSlot: { kind: "embedded", index: 1 },
      dataLimit: { enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 },
      pinAttemptsLeft: 3,
    });
    const reads = mock.requests.slice(before).filter((r) => r.method === "GET" && (r.query.get("cmd") ?? "").includes("net_select"));
    assert.equal(reads.length, 1);
  });

  it("offers no slot on a router that names none, and two modes on the 4G firmware", async () => {
    const plain = zteRouter();
    const read = await plain.client.withSession((s) => cellularOf(s).read());
    assert.ok(read);
    assert.deepEqual([read.simSlots, read.simSlot, read.dataLimit, read.pinAttemptsLeft], [[], null, null, null]);
    assert.equal(read.networkModes, undefined, "the 5G firmware: the family's own list");
    const fourG = zteRouter({ reqproc: true });
    fourG.state.values["net_select"] = "NETWORK_auto";
    assert.deepEqual((await fourG.client.withSession((s) => cellularOf(s).read()))?.networkModes, ["auto", "lte"]);
  });
});

describe("zte-goform: writing the cellular settings", () => {
  it("switches the network mode with the page's name for it and reads it back", async () => {
    for (const [mode, name] of [
      ["wcdma", "Only_WCDMA"],
      ["lte_wcdma", "WCDMA_AND_LTE"],
      ["nr_sa", "Only_5G"],
      ["auto", "WL_AND_5G"],
    ] as const) {
      const { state, client } = zteRouter();
      const check = newCheck();
      await client.withSession((s) => cellularOf(s).setNetworkMode(mode, check));
      assert.deepEqual(posted(state, "SET_BEARER_PREFERENCE"), [{ BearerPreference: name }], mode);
      assert.deepEqual(check, { endpoints: ["zte-goform:SET_BEARER_PREFERENCE"], readback: "match", reason: null }, mode);
    }
    // A mode ZTE's pages have no name for, and one the 4G firmware lacks: nothing is sent
    const { state, client } = zteRouter();
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("gsm", newCheck())), CpeControlValidationError);
    const fourG = zteRouter({ reqproc: true });
    await assert.rejects(fourG.client.withSession((s) => cellularOf(s).setNetworkMode("nr_sa", newCheck())), /no "nr_sa" network mode/);
    assert.deepEqual([posted(state, "SET_BEARER_PREFERENCE"), posted(fourG.state, "SET_BEARER_PREFERENCE")], [[], []]);
    // A router that answers `success` and keeps its mode: the read-back says so
    const stuck = zteRouter();
    const kept = newCheck();
    const answer = stuck.mock.handler;
    stuck.mock.handler = async (req) => {
      const reply = await answer(req);
      if (req.method === "POST" && LanRouterMock.form(req).get("goformId") === "SET_BEARER_PREFERENCE") stuck.state.values["net_select"] = "WL_AND_5G";
      return reply;
    };
    await stuck.client.withSession((s) => cellularOf(s).setNetworkMode("lte", kept));
    assert.deepEqual([kept.readback, kept.reason], ["mismatch", "differs"]);
  });

  it("switches the SIM slot by ZTE's slot number, once", async () => {
    const { state, client } = zteRouter({ simSlot: "0" });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setSimSlot({ kind: "embedded", index: 2 }, check));
    assert.deepEqual(posted(state, "SET_SIM_SLOT"), [{ sim_slot: "2", notCallback: "true" }]);
    assert.deepEqual(check, { endpoints: ["zte-goform:SET_SIM_SLOT"], readback: "match", reason: null });
    await assert.rejects(client.withSession((s) => cellularOf(s).setSimSlot({ kind: "physical", index: 2 }, newCheck())), /no such SIM slot/);
    assert.equal(posted(state, "SET_SIM_SLOT").length, 1);
    // A router that answers the write and keeps its slot is a mismatch
    const refused = zteRouter({ simSlot: "0", refuse: ["SET_SIM_SLOT"] });
    await assert.rejects(refused.client.withSession((s) => cellularOf(s).setSimSlot({ kind: "embedded", index: 1 }, newCheck())), (err: unknown) => err instanceof CpeApiError && err.code === "failure");
  });

  it("writes the roaming switch together with the dial mode the router has", async () => {
    const { state, client } = zteRouter({ sim: true });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setRoaming(true, check));
    assert.deepEqual(posted(state, "SET_CONNECTION_MODE"), [{ ConnectionMode: "auto_dial", roam_setting_option: "on" }]);
    assert.deepEqual(check, { endpoints: ["zte-goform:SET_CONNECTION_MODE"], readback: "match", reason: null });
    await client.withSession((s) => cellularOf(s).setRoaming(false, newCheck()));
    assert.equal(state.values["roam_setting_option"], "off");
  });

  it("enters a PIN once: a wrong one is an answer, never a second try", async () => {
    const { state, client } = zteRouter({ sim: true });
    state.values["modem_main_state"] = "modem_waitpin";
    const wrong = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("0000", wrong)), { accepted: false, attemptsLeft: 2 });
    assert.equal(posted(state, "ENTER_PIN").length, 1, "one attempt spent, nothing sent after it");
    assert.deepEqual(wrong, { endpoints: ["zte-goform:ENTER_PIN"], readback: "none", reason: null });
    const right = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("1234", right)), { accepted: true, attemptsLeft: 3 });
    assert.deepEqual(right, { endpoints: ["zte-goform:ENTER_PIN"], readback: "match", reason: null });
    assert.deepEqual(posted(state, "ENTER_PIN").at(-1), { PinNumber: "1234" });
  });

  it("turns the PIN lock on and off with the card's PIN and reads the lock back", async () => {
    const { state, client } = zteRouter({ sim: true });
    const on = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(true, "1234", on)), { accepted: true, attemptsLeft: 3 });
    assert.deepEqual([posted(state, "ENABLE_PIN"), state.values["pin_status"], on.readback], [[{ OldPinNumber: "1234" }], "1", "match"]);
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(false, "0000", newCheck())), { accepted: false, attemptsLeft: 2 });
    assert.equal(state.values["pin_status"], "1", "a wrong PIN changes nothing");
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(false, "1234", newCheck())), { accepted: true, attemptsLeft: 3 });
    assert.equal(state.values["pin_status"], "0");
  });

  it("sets the data limit in megabytes with the warning share, and keeps the router's share when none is given", async () => {
    const { state, client } = zteRouter({ sim: true });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setDataLimit({ enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 }, check));
    assert.deepEqual(posted(state, "DATA_LIMIT_SETTING"), [{ data_volume_limit_switch: "1", data_volume_limit_unit: "data", data_volume_limit_size: "20_1024", data_volume_alert_percent: "80" }]);
    assert.deepEqual(check, { endpoints: ["zte-goform:DATA_LIMIT_SETTING"], readback: "match", reason: null });
    await client.withSession((s) => cellularOf(s).setDataLimit({ enabled: true, bytes: 500 * 1024 ** 2, alertPercent: null }, newCheck()));
    assert.deepEqual(posted(state, "DATA_LIMIT_SETTING").at(-1), { data_volume_limit_switch: "1", data_volume_limit_unit: "data", data_volume_limit_size: "500_1", data_volume_alert_percent: "80" });
    await client.withSession((s) => cellularOf(s).setDataLimit({ enabled: false, bytes: null, alertPercent: null }, newCheck()));
    assert.deepEqual(posted(state, "DATA_LIMIT_SETTING").at(-1), { data_volume_limit_switch: "0" });
    // No share on the router and none given: nothing is made up
    const bare = zteRouter();
    await assert.rejects(bare.client.withSession((s) => cellularOf(s).setDataLimit({ enabled: true, bytes: 1024 ** 3, alertPercent: null }, newCheck())), /give alertPercent as well/);
    assert.deepEqual(posted(bare.state, "DATA_LIMIT_SETTING"), []);
  });

  it("sends a USSD code, waits for the answer and hands back the operator's text", async () => {
    const menu = "Balance: 5.00 EUR\n1. Top up\n2. Exit";
    const { state, client } = zteRouter({ ussd: { text: menu, awaitsReply: true } });
    const check = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).ussd({ kind: "send", code: "*100#" }, check, noWait)), { state: "answered", text: menu, awaitsReply: true });
    assert.deepEqual(posted(state, "USSD_PROCESS"), [{ USSD_operator: "ussd_send", USSD_send_number: "*100#", notCallback: "true" }]);
    assert.deepEqual(check, { endpoints: ["zte-goform:USSD_PROCESS"], readback: "none", reason: null });
    await client.withSession((s) => cellularOf(s).ussd({ kind: "reply", code: "2" }, newCheck(), noWait));
    assert.deepEqual(posted(state, "USSD_PROCESS").at(-1), { USSD_operator: "ussd_reply", USSD_reply_number: "2", notCallback: "true" });
    // A full-length answer in Chinese survives the trip (it is longer than the drivers' usual text bound)
    const long = "余".repeat(182);
    const chinese = zteRouter({ ussd: { text: long } });
    assert.deepEqual(await chinese.client.withSession((s) => cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), noWait)), { state: "answered", text: long, awaitsReply: false });
  });

  it("cancels a code the network leaves unanswered, and says what the network declined", async () => {
    const silent = zteRouter();
    let sleeps = 0;
    const answer = await silent.client.withSession((s) => cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), { sleep: async () => void (sleeps += 1) }));
    assert.deepEqual(answer, { state: "no_answer", text: null, awaitsReply: false });
    assert.equal(sleeps, USSD_POLLS - 1, "asked a bounded number of times");
    assert.deepEqual(
      posted(silent.state, "USSD_PROCESS").map((p) => p["USSD_operator"]),
      ["ussd_send", "ussd_cancel"],
      "no session is left open on the router"
    );
    const declined = zteRouter({ ussd: { flag: "99" } });
    await assert.rejects(declined.client.withSession((s) => cellularOf(s).ussd({ kind: "send", code: "*100#" }, newCheck(), noWait)), (err: unknown) => err instanceof CpeApiError && err.code === "99");
    const cancel = zteRouter();
    assert.deepEqual(await cancel.client.withSession((s) => cellularOf(s).ussd({ kind: "cancel" }, newCheck(), noWait)), { state: "cancelled", text: null, awaitsReply: false });
    assert.deepEqual(posted(cancel.state, "USSD_PROCESS"), [{ USSD_operator: "ussd_cancel" }]);
  });
});

describe("cellular settings through the daemon (zte-goform)", () => {
  it("reads the settings as one snapshot, with the family's modes on offer", async () => {
    const { mock } = zteRouter({ sim: true, simSlot: "0" });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      const snapshot = await fx.core.controls.readCellular();
      assert.ok(snapshot);
      assert.deepEqual(snapshot.networkMode, { current: "auto", options: ["auto", "nr_sa", "nr_nsa", "lte", "lte_wcdma", "wcdma"] });
      assert.equal(snapshot.simSlots?.length, 3);
      assert.deepEqual([snapshot.operator, snapshot.apn], [null, null], "nothing made up for what the driver does not read");
      assert.deepEqual(snapshot.dataLimit, { enabled: false, bytes: null, alertPercent: null });
      assert.equal(fx.core.monitor.getCachedCellular(), snapshot);
    } finally {
      await fx.cleanup();
    }
  });

  it("changes a setting once, records the command and hands self-healing the value it had", async () => {
    const { mock, state } = zteRouter({ sim: true, simSlot: "0" });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      await assert.rejects(fx.core.controls.setSimSlot({ kind: "embedded", index: 1 }, { confirm: false }), /require explicit \{ confirm: true \}/);
      const result = await fx.core.controls.setSimSlot({ kind: "embedded", index: 1 }, { confirm: true });
      assert.deepEqual(result.simSlot, { kind: "embedded", index: 1 });
      assert.equal(posted(state, "SET_SIM_SLOT").length, 1);
      assert.equal(fx.linkChanges.length, 1);
      assert.deepEqual([fx.linkChanges[0]?.kind, fx.linkChanges[0]?.change], ["sim_slot", { kind: "sim_slot", previous: { kind: "physical", index: 1 } }]);
      const record = fx.core.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.endpoints, record?.readback], ["set_sim_slot", "simSlot", ["zte-goform:SET_SIM_SLOT"], "match"]);
      assert.match(fx.applied.at(-1)?.summaryEn ?? "", /^SIM slot switched to: built-in card 1 \(experimental write, read back: matches\)$/);
      assert.match(fx.applied.at(-1)?.summaryZh ?? "", /^已切换 SIM 卡槽：内置卡 1/);

      const mode = await fx.core.controls.setNetworkMode("wcdma", { confirm: true });
      assert.equal(mode.networkMode, "wcdma");
      assert.equal(mode.cellular?.networkMode?.current, "wcdma", "the snapshot after the write");
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "network_mode", previous: "auto" });
      // The same value again: nothing new to go back to
      await fx.core.controls.setNetworkMode("wcdma", { confirm: true });
      assert.equal(fx.linkChanges.at(-1)?.change, null);
      // A mode the family does not offer never reaches the router
      const before = posted(state, "SET_BEARER_PREFERENCE").length;
      await assert.rejects(fx.core.controls.setNetworkMode("gsm", { confirm: true }), /offers no "gsm" network mode/);
      assert.equal(posted(state, "SET_BEARER_PREFERENCE").length, before);
    } finally {
      await fx.cleanup();
    }
  });

  it("puts a setting back in one session, unless the WAN is up again", async () => {
    const { mock, state } = zteRouter({ sim: true, simSlot: "1" });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "sim_slot", previous: { kind: "physical", index: 1 } }), { applied: false, skipped: "wan_up" });
      assert.deepEqual(posted(state, "SET_SIM_SLOT"), []);
      state.values["ppp_status"] = "ppp_disconnected";
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "sim_slot", previous: { kind: "physical", index: 1 } }), { applied: true });
      assert.equal(state.values["sim_slot"], "0");
      assert.equal(fx.applied.at(-1)?.action, "auto_restore_sim_slot");
      assert.match(fx.applied.at(-1)?.summaryEn ?? "", /^The WAN did not come back: put the SIM slot back to what it was/);
      assert.deepEqual(await fx.core.controls.revertLinkChange({ kind: "network_mode", previous: "lte" }), { applied: true });
      assert.equal(state.values["net_select"], "Only_LTE");
      // What the driver has no way back for is refused, not guessed
      await assert.rejects(fx.core.controls.revertLinkChange({ kind: "operator", previous: { mode: "auto" } }), DeviceReadOnlyError);
      assert.equal(fx.linkChanges.length, 0, "a way back is not itself watched");
    } finally {
      await fx.cleanup();
    }
  });

  it("sends a PIN only while the router reports more than one attempt left, and leaves it nowhere", async () => {
    const { mock, state } = zteRouter({ sim: true, simPin: "0000" });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      state.values["modem_main_state"] = "modem_waitpin";
      // A wrong PIN: one attempt, reported as refused
      assert.deepEqual(await fx.core.controls.enterSimPin("1234", { confirm: true }), { accepted: false, attemptsLeft: 2 });
      assert.match(fx.applied.at(-1)?.summaryEn ?? "", /^The SIM card did not accept the PIN; FengSui did not try again/);
      assert.deepEqual(await fx.core.controls.enterSimPin("1234", { confirm: true }), { accepted: false, attemptsLeft: 1 });
      // One attempt left: FengSui sends nothing more, whatever PIN is given
      const sent = posted(state, "ENTER_PIN").length;
      await assert.rejects(fx.core.controls.enterSimPin("0000", { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && err.message === PIN_REFUSALS.last_attempt);
      await assert.rejects(fx.core.controls.setSimPinLock(true, "0000", { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && err.message === PIN_REFUSALS.last_attempt);
      assert.equal(posted(state, "ENTER_PIN").length, sent);
      assert.deepEqual(posted(state, "ENABLE_PIN"), []);
      // No count from the router: nothing sent either
      state.values["pinnumber"] = "";
      await assert.rejects(fx.core.controls.enterSimPin("0000", { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && err.message === PIN_REFUSALS.unknown);
      state.values["pinnumber"] = "0";
      await assert.rejects(fx.core.controls.enterSimPin("0000", { confirm: true }), (err: unknown) => err instanceof CpeControlValidationError && err.message === PIN_REFUSALS.none_left);
      // With attempts left the right PIN is taken
      state.values["pinnumber"] = "3";
      assert.deepEqual(await fx.core.controls.enterSimPin("0000", { confirm: true }), { accepted: true, attemptsLeft: 3 });
      assert.deepEqual(await fx.core.controls.setSimPinLock(true, "0000", { confirm: true }), { accepted: true, attemptsLeft: 3 });
      assert.match(fx.applied.at(-1)?.summaryZh ?? "", /^已打开「开机要 PIN」/);
      await assert.rejects(fx.core.controls.enterSimPin("0000", { confirm: false }), /confirm: true/);
      // Neither PIN is in a summary, an audit detail, a write record or the status
      const trail = fx.trail();
      assert.ok(!trail.includes("0000") && !/\b1234\b/.test(trail), "no PIN in anything kept");
    } finally {
      await fx.cleanup();
    }
  });

  it("sends USSD and keeps neither the code nor the operator's answer", async () => {
    const { mock } = zteRouter({ ussd: { text: "Balance: 5.00 EUR" } });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      assert.deepEqual(await fx.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), { state: "answered", text: "Balance: 5.00 EUR", awaitsReply: false });
      assert.equal(fx.applied.at(-1)?.summaryEn, "Sent a USSD code (experimental write)");
      assert.equal(fx.applied.at(-1)?.summaryZh, "已发送一条 USSD 指令（实验性写入）");
      const trail = fx.trail();
      assert.ok(!trail.includes("*100#") && !trail.includes("Balance"), "neither the code nor the answer is kept");
      assert.deepEqual(fx.core.scheduler.genericWrites.at(-1)?.endpoints, ["zte-goform:USSD_PROCESS"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a setting its owner turned off, and one the brand has no write for, before any session", async () => {
    const { mock, state } = zteRouter({ sim: true, simSlot: "0" });
    const fx = daemonOn("zte-goform", mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const { features } = fx.core.scheduler.getStatus().device;
      assert.deepEqual(
        [features.networkMode, features.simSlot, features.simPin, features.roaming, features.dataLimit, features.ussd, features.airplaneSwitch, features.apn, features.operatorSelect, features.trafficReset],
        ["enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented", "not_implemented", "not_implemented", "not_implemented"]
      );
      fx.core.scheduler.device.setDisabledWrites([{ model: "MC888", feature: "simSlot" }]);
      const requests = mock.requests.length;
      await assert.rejects(fx.core.controls.setSimSlot({ kind: "embedded", index: 1 }, { confirm: true }), DeviceWriteDisabledError);
      await assert.rejects(fx.core.controls.setAirplaneMode(true, { confirm: true }), (err: unknown) => err instanceof DeviceReadOnlyError && !(err instanceof DeviceWriteDisabledError) && err.feature === "airplaneSwitch");
      await assert.rejects(fx.core.controls.resetTraffic({ confirm: true }), DeviceReadOnlyError);
      assert.equal(mock.requests.length, requests, "not even a login");
      assert.deepEqual(posted(state, "SET_SIM_SLOT"), []);
      assert.deepEqual(
        fx.audits.slice(-3).map((a) => [a.action, a.outcome]),
        [
          ["set_sim_slot", "refused"],
          ["set_airplane_mode", "refused"],
          ["reset_traffic", "refused"],
        ]
      );
      assert.equal(fx.linkChanges.length, 0);
    } finally {
      await fx.cleanup();
    }
  });
});
