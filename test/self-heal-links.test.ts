import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type { LinkChange } from "../src/cellular.ts";
import type { WanRepairOutcome } from "../src/cpe-controls.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { GlobalTelemetrySnapshot, PersistedLockState } from "../src/cpe-domain.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { BrowserSessionYieldedError, CircuitBreakerOpenError, DeviceReadOnlyError } from "../src/scheduler.ts";
import { EXPERIMENT_GUARD_MS, ROLLBACK_GIVE_UP_MS, WanSelfHeal } from "../src/self-heal.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * The 3-minute way back from a change that can cut the WAN by accident (SIM slot, network mode,
 * operator selection, access point): watched whoever asked for it and whatever the self-healing
 * settings say, put back once to the value read before the change, never while the disconnect is
 * deliberate, and carried across a restart.
 */

const MIN = 60_000;
const T0 = Date.parse("2026-11-12T08:00:00.000Z");
const SLOT: LinkChange = { kind: "sim_slot", previous: { kind: "physical", index: 1 } };

function sample(capturedAtMs: number, connectionStatus: string): GlobalTelemetrySnapshot {
  return { capturedAtMs, capturedAtIso: new Date(capturedAtMs).toISOString(), device: { connectionStatus } } as unknown as GlobalTelemetrySnapshot;
}

function fixture(opts: { stateFile?: string; reconnectMin?: number } = {}) {
  const cpe = createStrictCpe();
  const dir = opts.stateFile ? null : tempDir("fengsui-selfheal-links-");
  const stateFile = opts.stateFile ?? path.join(dir ?? "", "state.json");
  const core: FengSuiCore = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
    stateStore: new EncryptedStateStore({ filePath: stateFile, encryptionKey: "selfheal_links_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
  });
  core.monitor.init();
  let clock = T0;
  const lock: PersistedLockState = { mode: "unlocked", updatedAtIso: new Date(T0 - 60 * MIN).toISOString(), lteBands: "all", nrBands: [], cellLock: null };
  const reverted: LinkChange[] = [];
  const plan: Array<() => Promise<WanRepairOutcome>> = [];
  let redials = 0;
  const controls = {
    getPersistedLockState: () => lock,
    rollBackLocks: async (): Promise<WanRepairOutcome> => ({ applied: true }),
    reconnectWan: async (): Promise<WanRepairOutcome> => {
      redials += 1;
      return { applied: true };
    },
    revertLinkChange: async (change: LinkChange): Promise<WanRepairOutcome> => {
      reverted.push(change);
      const next = plan.shift();
      return next ? await next() : { applied: true };
    },
  };
  const logs: string[] = [];
  const heal = new WanSelfHeal({ scheduler: core.scheduler, monitor: core.monitor, controls, lockRollbackAfterMs: 0, reconnectAfterMs: (opts.reconnectMin ?? 0) * MIN, now: () => clock, log: (line) => logs.push(line) });
  const alerts: AlertEventRecord[] = [];
  core.scheduler.on("alert", (a: AlertEventRecord) => alerts.push(a));
  return {
    heal,
    core,
    stateFile,
    reverted,
    plan,
    alerts,
    logs,
    redials: () => redials,
    codes: () => alerts.map((a) => a.code),
    /** A change applied `minutes` after T0. */
    change: (minutes: number, change: LinkChange | null, kind: LinkChange["kind"] = change?.kind ?? "sim_slot") => {
      clock = T0 + minutes * MIN;
      heal.guardLinkChange({ kind, change, appliedAtMs: clock });
    },
    /** Telemetry captured `minutes` after T0 (the clock moves with it). */
    at: async (minutes: number, status: string) => {
      clock = T0 + minutes * MIN;
      await heal.ingestTelemetry(sample(clock, status));
    },
    stored: () => core.stateStore.getState().selfHealLinkWatches,
    cleanup: async () => {
      await heal.stop();
      await stopFengSuiCore(core);
      if (dir) removeTempDir(dir);
    },
  };
}

describe("self-heal: a changed setting that cut the WAN", () => {
  it("puts the setting back after 3 minutes down, once, with self-healing off", async () => {
    const fx = fixture();
    try {
      assert.equal(fx.heal.enabled, false, "both opt-in parts are off");
      assert.equal(EXPERIMENT_GUARD_MS, 3 * MIN);
      fx.change(0, SLOT);
      assert.deepEqual(fx.heal.linkWatches, [{ kind: "sim_slot", deadlineMs: T0 + 3 * MIN, restorable: true }]);
      await fx.at(1, "902");
      await fx.at(2.9, "902");
      assert.deepEqual(fx.reverted, [], "not before the 3 minutes are over");
      await fx.at(3, "902");
      assert.deepEqual(fx.reverted, [SLOT]);
      assert.deepEqual(fx.codes(), ["SETTING_ROLLED_BACK"]);
      assert.equal(fx.alerts[0]?.messageEn, "The WAN was still down 3 min after a change to the SIM slot, so it was put back to what it was automatically");
      assert.equal(fx.alerts[0]?.messageZh, "SIM 卡槽更改后 3 分钟 WAN 仍未恢复，已自动改回之前的值");
      await fx.at(5, "902");
      assert.equal(fx.reverted.length, 1, "once: the watch is over");
      assert.deepEqual([fx.heal.linkWatches, fx.stored()], [[], []]);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a change the WAN proves: up for 2 minutes ends the watch without a write", async () => {
    const fx = fixture();
    try {
      fx.change(0, { kind: "network_mode", previous: "auto" });
      await fx.at(0.5, "902");
      await fx.at(1, "901");
      await fx.at(2, "901");
      assert.equal(fx.heal.linkWatches.length, 1, "up, not yet for 2 minutes");
      await fx.at(3.1, "901");
      assert.deepEqual([fx.heal.linkWatches, fx.reverted, fx.codes()], [[], [], []]);
      assert.ok(fx.logs.some((line) => /WAN stayed up after the network_mode change/.test(line)));
      await fx.at(10, "902");
      assert.deepEqual(fx.reverted, [], "a later outage is not this change's doing");
    } finally {
      await fx.cleanup();
    }
  });

  it("says so, and writes nothing, when no value was read before the change", async () => {
    const fx = fixture();
    try {
      fx.change(0, null, "apn");
      assert.deepEqual(fx.heal.linkWatches, [{ kind: "apn", deadlineMs: T0 + 3 * MIN, restorable: false }]);
      await fx.at(3, "902");
      assert.deepEqual([fx.reverted, fx.codes()], [[], ["SETTING_NOT_ROLLED_BACK"]]);
      assert.match(fx.alerts[0]?.messageEn ?? "", /a change to the access point \(APN\)\. FengSui could not read the value it had before the change/);
      assert.deepEqual(fx.heal.linkWatches, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("goes back to the value from before the first of two changes inside one watch", async () => {
    const fx = fixture();
    try {
      fx.change(0, { kind: "network_mode", previous: "auto" });
      // Changed again a minute later, the WAN never seen up in between: `auto` is still the last that worked
      fx.change(1, { kind: "network_mode", previous: "wcdma" });
      await fx.at(3.5, "902");
      assert.deepEqual(fx.reverted, [], "the 3 minutes count from the later change");
      await fx.at(4, "902");
      assert.deepEqual(fx.reverted, [{ kind: "network_mode", previous: "auto" }]);
      // Each setting has a watch of its own
      fx.change(10, SLOT);
      fx.change(10, { kind: "apn", previous: { mode: "auto" } });
      assert.deepEqual(fx.heal.linkWatches.map((w) => w.kind), ["sim_slot", "apn"]);
      await fx.at(13, "902");
      await fx.at(13.1, "902");
      assert.deepEqual((fx.reverted as LinkChange[]).slice(1).map((c) => c.kind), ["sim_slot", "apn"], "one write per snapshot");
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves a deliberate disconnect alone, and looks again when the WAN is up inside the session", async () => {
    const fx = fixture();
    try {
      fx.change(0, SLOT);
      fx.plan.push(async () => ({ applied: false, skipped: "wan_up" }));
      await fx.at(3, "902");
      assert.equal(fx.heal.linkWatches.length, 1, "seen up in the session: still watched");
      await fx.at(3.5, "902");
      assert.equal(fx.reverted.length, 1, "not at every poll: a minute apart");
      fx.plan.push(async () => ({ applied: false, skipped: "airplane_mode" }));
      await fx.at(4.1, "902");
      assert.deepEqual([fx.reverted.length, fx.heal.linkWatches, fx.codes()], [2, [], []]);
      assert.ok(fx.logs.some((line) => /airplane mode is on; not putting the sim_slot change back/.test(line)));
      fx.change(10, SLOT);
      fx.plan.push(async () => ({ applied: false, skipped: "mobile_data_off" }));
      await fx.at(13, "902");
      assert.deepEqual([fx.heal.linkWatches, fx.codes()], [[], []]);
      assert.ok(fx.logs.some((line) => /mobile data is switched off; not putting the sim_slot change back/.test(line)));
    } finally {
      await fx.cleanup();
    }
  });

  it("waits for a person on the router's page, gives up after three failures, and stops at a refusal", async () => {
    const fx = fixture();
    try {
      fx.change(0, SLOT);
      fx.plan.push(async () => Promise.reject(new BrowserSessionYieldedError()));
      await fx.at(3, "902");
      assert.deepEqual([fx.heal.linkWatches.length, fx.codes()], [1, []], "waiting is not failing");
      for (const minute of [4.1, 5.2, 6.3]) {
        fx.plan.push(async () => Promise.reject(new Error("router answered 500")));
        await fx.at(minute, "902");
      }
      assert.deepEqual(fx.codes(), ["SETTING_ROLLBACK_FAILED"]);
      assert.match(fx.alerts[0]?.messageEn ?? "", /putting it back did not complete: router answered 500\. Change it back from the console on the LAN/);
      assert.deepEqual(fx.heal.linkWatches, []);
      // Turned off under Settings → Device meanwhile, or the breaker latched: no retry would reach the router
      for (const refusal of [new DeviceReadOnlyError("MC888", "simSlot"), new CircuitBreakerOpenError({ tripped: true, code: "108006", reason: "wrong password", trippedAtIso: new Date(T0).toISOString() })]) {
        fx.change(20, SLOT);
        fx.plan.push(async () => Promise.reject(refusal));
        await fx.at(23, "902");
        assert.deepEqual(fx.heal.linkWatches, []);
      }
      assert.deepEqual(fx.codes(), ["SETTING_ROLLBACK_FAILED", "SETTING_ROLLBACK_FAILED", "SETTING_ROLLBACK_FAILED"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not redial while a change is watched", async () => {
    const fx = fixture({ reconnectMin: 1 });
    try {
      await fx.at(0, "902");
      fx.change(0.5, SLOT);
      await fx.at(2, "902");
      assert.equal(fx.redials(), 0, "the watch comes first");
      await fx.at(3.5, "902");
      assert.deepEqual([fx.reverted.length, fx.redials()], [1, 0]);
      // Afterwards the outage counts from the write, and the redial has its turn
      await fx.at(5, "902");
      assert.equal(fx.redials(), 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("carries an open watch across a restart, and drops one long past", async () => {
    const first = fixture();
    let second: ReturnType<typeof fixture> | null = null;
    try {
      first.heal.start();
      first.change(0, SLOT);
      assert.deepEqual(first.stored(), [{ kind: "sim_slot", change: SLOT, armedAtMs: T0 }]);
      await first.core.stateStore.flushAsync();
      await first.heal.stop();
      second = fixture({ stateFile: first.stateFile });
      second.core.stateStore.load();
      second.heal.start();
      assert.deepEqual(second.heal.linkWatches, [{ kind: "sim_slot", deadlineMs: T0 + 3 * MIN, restorable: true }]);
      await second.at(3, "902");
      assert.deepEqual(second.reverted, [SLOT]);
      await second.heal.stop();
      // An hour past its deadline nothing is put back any more
      second.core.stateStore.update({ selfHealLinkWatches: [{ kind: "sim_slot", change: SLOT, armedAtMs: T0 - EXPERIMENT_GUARD_MS - ROLLBACK_GIVE_UP_MS - MIN }] });
      const third = new WanSelfHeal({ scheduler: second.core.scheduler, monitor: second.core.monitor, controls: { getPersistedLockState: () => ({ mode: "unlocked", updatedAtIso: "", lteBands: "all", nrBands: [], cellLock: null }), rollBackLocks: async () => ({ applied: true }), reconnectWan: async () => ({ applied: true }) }, lockRollbackAfterMs: 0, reconnectAfterMs: 0, now: () => T0 });
      third.start();
      assert.deepEqual([third.linkWatches, second.stored()], [[], []]);
      await third.stop();
    } finally {
      if (second) await second.cleanup();
      await first.cleanup();
    }
  });

  it("drops stored watches this version cannot read", async () => {
    const fx = fixture();
    try {
      await fx.core.stateStore.flushAsync();
      fx.core.stateStore.update({
        selfHealLinkWatches: [
          { kind: "sim_slot", change: SLOT, armedAtMs: T0 },
          { kind: "apn", change: { kind: "sim_slot", previous: { kind: "physical", index: 1 } }, armedAtMs: T0 },
          { kind: "reboot", change: null, armedAtMs: T0 },
          { kind: "apn", change: null, armedAtMs: Number.NaN },
        ] as never,
      });
      await fx.core.stateStore.flushAsync();
      const reread = new EncryptedStateStore({ filePath: fx.stateFile, encryptionKey: "selfheal_links_key" });
      assert.deepEqual(reread.load().selfHealLinkWatches, [{ kind: "sim_slot", change: SLOT, armedAtMs: T0 }]);
    } finally {
      await fx.cleanup();
    }
  });
});
