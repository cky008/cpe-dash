import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { cellularOf, daemonOn, newCheck } from "./helpers/driver-daemon.ts";
import { ZWRT_PASSWORD, zwrtRouter } from "./helpers/zte-zwrt-router.ts";

/**
 * The cellular settings on a ZTE router with zWRT: what the driver sends for each write, how it reads
 * it back, and what its interface has no way to do. Mock routers only, with placeholder PINs.
 */

describe("zte-zwrt: the cellular settings", () => {
  const callsOf = (calls: Array<{ method: string; args: Record<string, unknown> }>, method: string): Array<Record<string, unknown>> => calls.filter((call) => call.method === method).map((call) => call.args);

  it("reads the mode, the slot, the PIN attempts and the monthly limit", async () => {
    const { client } = zwrtRouter({ sim: { current_sim_slot: "2", sim_states: "sim ready", pinnumber: "3", pin_status: "0" }, monthLimit: { enable: 1, type: 2, value: "21474836480", ratio: 80, overflow_auto_disconn: 1 } });
    assert.deepEqual(await client.withSession((s) => cellularOf(s).read()), {
      networkMode: "auto",
      simSlots: [
        { kind: "physical", index: 1 },
        { kind: "embedded", index: 1 },
      ],
      simSlot: { kind: "embedded", index: 1 },
      dataLimit: { enabled: true, bytes: 20 * 1024 ** 3, alertPercent: 80 },
      pinAttemptsLeft: 3,
    });
    // A firmware without the limit call and whose web role may not read the SIM details: nothing is made up
    const bare = zwrtRouter({ sim: false });
    const read = await bare.client.withSession((s) => cellularOf(s).read());
    assert.deepEqual([read?.dataLimit, read?.pinAttemptsLeft, read?.simSlot], [null, null, { kind: "physical", index: 1 }]);
    // A limit by hours is not a size
    const hours = zwrtRouter({ monthLimit: { enable: 1, type: 1, value: "100", ratio: 80 } });
    assert.deepEqual((await hours.client.withSession((s) => cellularOf(s).read()))?.dataLimit, { enabled: true, bytes: null, alertPercent: 80 });
  });

  it("switches the network mode by the name the notes give it", async () => {
    const { client, calls, netinfo } = zwrtRouter();
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setNetworkMode("wcdma", check));
    assert.deepEqual(callsOf(calls, "nwinfo_set_netselect"), [{ net_select: "Only_WCDMA" }]);
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zte_nwinfo_api.nwinfo_set_netselect"], readback: "match", reason: null });
    assert.equal(netinfo["net_select"], "Only_WCDMA");
    await assert.rejects(client.withSession((s) => cellularOf(s).setNetworkMode("gsm", newCheck())), CpeControlValidationError);
    assert.equal(callsOf(calls, "nwinfo_set_netselect").length, 1);
  });

  it("switches the SIM slot with both halves in one request", async () => {
    const { client, calls, mock, state } = zwrtRouter();
    const before = mock.requests.length;
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setSimSlot({ kind: "embedded", index: 1 }, check));
    assert.deepEqual(callsOf(calls, "zwrt_mdm_change_provision_session"), [
      { active_slot: 2, active_flag: 1 },
      { active_slot: 1, active_flag: 0 },
    ]);
    const batches = mock.requests.slice(before).filter((r) => r.body.startsWith("["));
    assert.equal(batches.length, 1, "one batch, as the router's page sends it");
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zwrt_zte_mdm.api.zwrt_mdm_change_provision_session"], readback: "match", reason: null });
    assert.equal(state.sim["current_sim_slot"], "2");
    await client.withSession((s) => cellularOf(s).setSimSlot({ kind: "physical", index: 1 }, newCheck()));
    assert.equal(state.sim["current_sim_slot"], "1");
    await assert.rejects(client.withSession((s) => cellularOf(s).setSimSlot({ kind: "embedded", index: 2 }, newCheck())), /no such SIM slot/);
    // A router that refuses one half fails the write
    const refusing = zwrtRouter({ fail: "zwrt_zte_mdm.api.zwrt_mdm_change_provision_session" });
    await assert.rejects(refusing.client.withSession((s) => cellularOf(s).setSimSlot({ kind: "embedded", index: 1 }, newCheck())), /refused/);
  });

  it("writes the roaming switch with the data call's own settings as they are", async () => {
    const { client, calls, state } = zwrtRouter();
    state.wwan = { enable: "1", connect_mode: "1", roam_enable: "0", connect_status: "ipv4_ipv6_connected" };
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setRoaming(true, check));
    assert.deepEqual(callsOf(calls, "set_wwaniface"), [{ source_module: "web", cid: 1, enable: 1, connect_mode: 1, roam_enable: 1 }]);
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zwrt_data.set_wwaniface"], readback: "match", reason: null });
    assert.equal(state.wwan["enable"], "1", "mobile data stays as it was");
    // The call's settings unread: nothing is guessed, nothing sent
    const blind = zwrtRouter({ fail: "get_wwaniface" });
    await assert.rejects(blind.client.withSession((s) => cellularOf(s).setRoaming(true, newCheck())));
    assert.deepEqual(callsOf(blind.calls, "set_wwaniface"), []);
  });

  it("enters a PIN and changes the PIN lock once each; a wrong PIN is an answer", async () => {
    const { client, calls, state } = zwrtRouter({ sim: { current_sim_slot: "1", sim_states: "wait pin", pinnumber: "3", pin_status: "1" } });
    const wrong = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("0000", wrong)), { accepted: false, attemptsLeft: 2 });
    assert.deepEqual(callsOf(calls, "sim_verify_pin_puk"), [{ pin_num: "0000", puk_num: "", pin_encode_flag: "0" }]);
    assert.deepEqual(wrong, { endpoints: ["zte-zwrt:zwrt_zte_mdm.api.sim_verify_pin_puk"], readback: "none", reason: null });
    const right = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).enterPin("1234", right)), { accepted: true, attemptsLeft: 3 });
    assert.equal(right.readback, "match");
    assert.equal(state.sim["sim_states"], "sim ready");
    const off = newCheck();
    assert.deepEqual(await client.withSession((s) => cellularOf(s).setPinLock(false, "1234", off)), { accepted: true, attemptsLeft: 3 });
    assert.deepEqual(callsOf(calls, "sim_change_pin_mode"), [{ pin_num_m: "1234", pin_mode: 0, pin_encode_flag: "0" }]);
    assert.deepEqual([off.readback, state.sim["pin_status"]], ["match", "0"]);
  });

  it("sets the monthly limit in bytes and keeps what it was not asked to change", async () => {
    const { client, calls, state } = zwrtRouter({ monthLimit: { enable: 0, type: 2, value: "10737418240", ratio: 90, overflow_auto_disconn: 1 } });
    const check = newCheck();
    await client.withSession((s) => cellularOf(s).setDataLimit({ enabled: true, bytes: 20 * 1024 ** 3, alertPercent: null }, check));
    assert.deepEqual(callsOf(calls, "set_wwandst_monthlimit"), [{ source_module: "web", cid: 1, enable: 1, type: 2, value: "21474836480", ratio: 90, overflow_auto_disconn: 1 }]);
    assert.deepEqual(check, { endpoints: ["zte-zwrt:zwrt_data.set_wwandst_monthlimit"], readback: "match", reason: null });
    await client.withSession((s) => cellularOf(s).setDataLimit({ enabled: false, bytes: null, alertPercent: null }, newCheck()));
    assert.deepEqual([state.monthLimit?.["enable"], state.monthLimit?.["value"]], [0, "21474836480"], "switched off, its size kept");
    // Nothing set on the router and nothing given: no made-up size
    const empty = zwrtRouter({ monthLimit: { enable: 0, type: 2, value: "0", ratio: 0 } });
    await assert.rejects(empty.client.withSession((s) => cellularOf(s).setDataLimit({ enabled: true, bytes: null, alertPercent: null }, newCheck())), /give bytes and alertPercent/);
    assert.deepEqual(callsOf(empty.calls, "set_wwandst_monthlimit"), []);
  });

  it("has no airplane switch, USSD or traffic reset, and the daemon says so before any session", async () => {
    const { mock, client } = zwrtRouter();
    const session = await client.withSession(async (s) => Object.keys(s.cellular ?? {}).sort());
    assert.deepEqual(session, ["enterPin", "read", "restoreApn", "scanOperators", "selectOperator", "setApn", "setDataLimit", "setNetworkMode", "setPinLock", "setRoaming", "setSimSlot"]);
    const fx = daemonOn("zte-zwrt", mock.fetchImpl, "http://192.168.0.1", ZWRT_PASSWORD);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const { features } = fx.core.scheduler.getStatus().device;
      assert.deepEqual(
        [features.networkMode, features.simSlot, features.simPin, features.roaming, features.dataLimit, features.operatorSelect, features.apn, features.airplaneSwitch, features.ussd, features.trafficReset],
        ["enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented", "not_implemented", "not_implemented"]
      );
      const sent = mock.requests.length;
      await assert.rejects(fx.core.controls.sendUssd({ kind: "send", code: "*100#" }, { confirm: true }), DeviceReadOnlyError);
      await assert.rejects(fx.core.controls.setAirplaneMode(true, { confirm: true }), DeviceReadOnlyError);
      assert.equal(mock.requests.length, sent);
      // And a slot switch through the daemon hands self-healing the slot it had
      await fx.core.controls.setSimSlot({ kind: "embedded", index: 1 }, { confirm: true });
      assert.deepEqual(fx.linkChanges.at(-1)?.change, { kind: "sim_slot", previous: { kind: "physical", index: 1 } });
    } finally {
      await fx.cleanup();
    }
  });
});
