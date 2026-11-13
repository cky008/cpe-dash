import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import type { WanRepairOutcome } from "../src/cpe-controls.ts";
import type { JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { GlobalTelemetrySnapshot, PersistedLockState } from "../src/cpe-domain.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { BrowserSessionYieldedError, CircuitBreakerOpenError, type ControlAppliedEvent, DeviceReadOnlyError, PeerDaemonStandbyError } from "../src/scheduler.ts";
import { RECONNECT_MAX_PER_DAY, SELF_HEAL_OFF, type SelfHealStatus, WanSelfHeal } from "../src/self-heal.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createCpeFamily } from "./helpers/cpe-family.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-02T08:00:00.000Z");

function unlocked(atMs: number): PersistedLockState {
  return { mode: "unlocked", updatedAtIso: new Date(atMs).toISOString(), lteBands: "all", nrBands: [], cellLock: null };
}

function bandLock(atMs: number): PersistedLockState {
  return { mode: "band_lock", updatedAtIso: new Date(atMs).toISOString(), lteBands: [20], nrBands: [], cellLock: null };
}

function sample(capturedAtMs: number, connectionStatus: string): GlobalTelemetrySnapshot {
  return { capturedAtMs, capturedAtIso: new Date(capturedAtMs).toISOString(), device: { connectionStatus } } as unknown as GlobalTelemetrySnapshot;
}

/** `stateFile`: start from the state an earlier core left there (a restarted daemon); that core's cleanup removes it. */
function createCore(fault?: (p: string, method: string, headers: Headers) => StrictFault | undefined, stateFile?: string) {
  const cpe = createStrictCpe({ fault });
  const dir = stateFile ? null : tempDir("fengsui-selfheal-");
  const core: FengSuiCore = createFengSuiCore({
    connection: mockConnection(cpe),
    stateStore: new EncryptedStateStore({ filePath: stateFile ?? path.join(dir ?? "", "state.json"), encryptionKey: "selfheal_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
  });
  core.monitor.init();
  return {
    cpe,
    core,
    cleanup: async () => {
      await stopFengSuiCore(core);
      if (dir) removeTempDir(dir);
    },
  };
}

type Plan = Array<() => Promise<WanRepairOutcome>>;

function fixture(opts: { lockMin?: number; reconnectMin?: number; lock?: PersistedLockState; stateFile?: string }) {
  const base = createCore(undefined, opts.stateFile);
  let clock = T0;
  let lockState = opts.lock ?? unlocked(T0 - 60 * MIN);
  const calls = { rollback: 0, reconnect: 0 };
  /** The lock each rollback was asked to clear (its `updatedAtIso`). */
  const rollbackArgs: string[] = [];
  /** The saved LTE mask each rollback was asked to write back instead (`null`: clear every lock). */
  const restoreArgs: Array<string | null> = [];
  const rollbackPlan: Plan = [];
  const reconnectPlan: Plan = [];
  const controls = {
    getPersistedLockState: () => lockState,
    rollBackLocks: async (expectedLockUpdatedAtIso: string, restore?: { lteMask: string }): Promise<WanRepairOutcome> => {
      calls.rollback += 1;
      rollbackArgs.push(expectedLockUpdatedAtIso);
      restoreArgs.push(restore?.lteMask ?? null);
      const next = rollbackPlan.shift();
      if (next) return await next();
      lockState = unlocked(clock);
      return { applied: true, lockState };
    },
    reconnectWan: async (): Promise<WanRepairOutcome> => {
      calls.reconnect += 1;
      const next = reconnectPlan.shift();
      return next ? await next() : { applied: true };
    },
  };
  const logs: string[] = [];
  const heal = new WanSelfHeal({
    scheduler: base.core.scheduler,
    monitor: base.core.monitor,
    controls,
    lockRollbackAfterMs: (opts.lockMin ?? 0) * MIN,
    reconnectAfterMs: (opts.reconnectMin ?? 0) * MIN,
    now: () => clock,
    log: (line) => logs.push(line),
  });
  const alerts: AlertEventRecord[] = [];
  base.core.scheduler.on("alert", (a: AlertEventRecord) => alerts.push(a));
  return {
    heal,
    core: base.core,
    calls,
    rollbackArgs,
    restoreArgs,
    alerts,
    logs,
    setLock: (next: PersistedLockState) => {
      lockState = next;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
    rollbackPlan,
    reconnectPlan,
    codes: () => alerts.map((a) => a.code),
    /** Telemetry captured `minutes` after T0 (the clock moves with it). */
    at: async (minutes: number, status: string) => {
      clock = T0 + minutes * MIN;
      await heal.ingestTelemetry(sample(clock, status));
    },
    /** A lock applied through FengSui `minutes` after T0. */
    lockAt: (minutes: number, action: "lock_band" | "lock_cell" = "lock_band") => {
      clock = T0 + minutes * MIN;
      lockState = bandLock(clock);
      const event: ControlAppliedEvent = { action, tsIso: lockState.updatedAtIso, summaryZh: "", summaryEn: "", lockState };
      heal.noteControl(event);
    },
    unlockAt: (minutes: number) => {
      clock = T0 + minutes * MIN;
      lockState = unlocked(clock);
      heal.noteControl({ action: "unlock_rf_locks", tsIso: lockState.updatedAtIso, summaryZh: "", summaryEn: "", lockState });
    },
    cleanup: base.cleanup,
  };
}

describe("WanSelfHeal lock rollback (LOCK_ROLLBACK_AFTER_MIN)", () => {
  it("clears the locks once when the WAN is still down at the end of the window", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(0);
      assert.equal(fx.heal.lockDeadlineMs, T0 + 10 * MIN);
      for (const minute of [0.5, 3, 6, 9.9]) await fx.at(minute, "902");
      assert.equal(fx.calls.rollback, 0, "no write inside the window");
      await fx.at(10, "902");
      assert.equal(fx.calls.rollback, 1);
      assert.deepEqual(fx.codes(), ["LOCK_ROLLED_BACK"]);
      assert.equal(fx.alerts[0]?.severity, "warning");
      assert.match(fx.alerts[0]?.messageEn ?? "", /still down 10 min after the lock/);
      assert.equal(fx.heal.lockDeadlineMs, null);
      for (const minute of [11, 20, 40]) await fx.at(minute, "902");
      assert.equal(fx.calls.rollback, 1, "one rollback per lock");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps a lock once the WAN stays up for two minutes, and treats a flap before that as down", async () => {
    const kept = fixture({ lockMin: 10 });
    try {
      kept.lockAt(0, "lock_cell");
      await kept.at(0.5, "902");
      await kept.at(1, "901");
      await kept.at(2.5, "901");
      assert.notEqual(kept.heal.lockDeadlineMs, null, "1.5 min up is not yet proof");
      await kept.at(3, "901");
      assert.equal(kept.heal.lockDeadlineMs, null);
      await kept.at(12, "902");
      assert.equal(kept.calls.rollback, 0, "a later outage is not the lock's fault");
    } finally {
      await kept.cleanup();
    }

    const flapping = fixture({ lockMin: 10 });
    try {
      flapping.lockAt(0);
      await flapping.at(9, "901");
      await flapping.at(10, "901");
      assert.equal(flapping.calls.rollback, 0, "up at the deadline: wait for proof");
      await flapping.at(10.5, "902");
      assert.equal(flapping.calls.rollback, 1);
    } finally {
      await flapping.cleanup();
    }
  });

  it("ignores snapshots from before the lock, stale or without a status, and disarms on any unlock", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(20);
      await fx.heal.ingestTelemetry(sample(T0 + 19 * MIN, "902"));
      await fx.at(30, "");
      assert.equal(fx.calls.rollback, 0, "no status, no decision");
      await fx.heal.ingestTelemetry(sample(T0 + 25 * MIN, "902"));
      assert.equal(fx.calls.rollback, 0, "a snapshot 5 min old never drives a write");

      fx.unlockAt(31);
      await fx.at(45, "902");
      assert.equal(fx.calls.rollback, 0);

      fx.lockAt(50);
      assert.equal(fx.heal.lockDeadlineMs, T0 + 60 * MIN, "a new lock opens a fresh window");
    } finally {
      await fx.cleanup();
    }
  });

  it("waits for a human on the WebUI, then gives up after repeated failures with a critical alert", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(0);
      fx.rollbackPlan.push(
        async () => {
          throw new BrowserSessionYieldedError();
        },
        async () => {
          throw new Error("CPE returned error 125003");
        },
        async () => {
          throw new Error("CPE returned error 125003");
        },
        async () => {
          throw new Error("CPE returned error 125003");
        }
      );
      await fx.at(10, "902");
      await fx.at(10.5, "902");
      assert.equal(fx.calls.rollback, 1, "retry waits a minute");
      await fx.at(11, "902");
      await fx.at(12, "902");
      assert.deepEqual(fx.codes(), [], "a yield and one failure are not the end");
      await fx.at(13, "902");
      assert.equal(fx.calls.rollback, 4);
      assert.deepEqual(fx.codes(), ["LOCK_ROLLBACK_FAILED"]);
      assert.equal(fx.alerts[0]?.severity, "critical");
      assert.match(fx.alerts[0]?.messageEn ?? "", /125003/);
      assert.equal(fx.logs.filter((l) => l.includes("125003")).length, 1, "one log line per distinct reason");
      await fx.at(20, "902");
      assert.equal(fx.calls.rollback, 4);
    } finally {
      await fx.cleanup();
    }
  });

  it("stops at once on a tripped breaker, and gives up an hour after the deadline", async () => {
    const tripped = fixture({ lockMin: 10 });
    try {
      tripped.lockAt(0);
      tripped.rollbackPlan.push(async () => {
        throw new CircuitBreakerOpenError({ tripped: true, code: "108006", reason: "wrong password", trippedAtIso: null });
      });
      await tripped.at(10, "902");
      assert.deepEqual(tripped.codes(), ["LOCK_ROLLBACK_FAILED"]);
      await tripped.at(12, "902");
      assert.equal(tripped.calls.rollback, 1);
    } finally {
      await tripped.cleanup();
    }

    const human = fixture({ lockMin: 10 });
    try {
      human.lockAt(0);
      for (let i = 0; i < 80; i++) {
        human.rollbackPlan.push(async () => {
          throw new BrowserSessionYieldedError();
        });
      }
      for (let minute = 10; minute <= 70; minute += 1) await human.at(minute, "902");
      assert.deepEqual(human.codes(), [], "an hour of a human on the WebUI is still waited for");
      await human.at(71, "902");
      assert.deepEqual(human.codes(), ["LOCK_ROLLBACK_FAILED"]);
      assert.equal(human.calls.rollback, 61);
    } finally {
      await human.cleanup();
    }
  });

  it("follows what the session re-reads: WAN already back keeps watching, mobile data off disarms quietly", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(0);
      fx.rollbackPlan.push(async () => ({ applied: false, skipped: "wan_up" }));
      await fx.at(10, "902");
      assert.equal(fx.calls.rollback, 1);
      assert.notEqual(fx.heal.lockDeadlineMs, null);
      await fx.at(10.5, "902");
      assert.equal(fx.calls.rollback, 1, "the session just saw it up: look again after a minute, not at every poll");
      await fx.at(11, "902");
      assert.equal(fx.calls.rollback, 2, "down again after the deadline: roll back");
      assert.deepEqual(fx.codes(), ["LOCK_ROLLED_BACK"]);

      fx.lockAt(20);
      fx.rollbackPlan.push(async () => ({ applied: false, skipped: "mobile_data_off" }));
      await fx.at(30, "902");
      assert.equal(fx.heal.lockDeadlineMs, null);
      assert.deepEqual(fx.codes(), ["LOCK_ROLLED_BACK"]);
      assert.ok(fx.logs.some((l) => l.includes("mobile data is switched off")));
    } finally {
      await fx.cleanup();
    }
  });

  it("names the lock it rolls back, and keeps a newer lock's watch when that one replaced it in the queue", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(0);
      // The owner locks again while the rollback of the first lock waits behind that write
      fx.rollbackPlan.push(async () => {
        fx.lockAt(10.05);
        return { applied: false, skipped: "lock_changed" };
      });
      await fx.at(10, "902");
      assert.deepEqual(fx.rollbackArgs, [new Date(T0).toISOString()]);
      assert.equal(fx.heal.lockDeadlineMs, T0 + 20.05 * MIN, "the newer lock keeps its own window");
      assert.deepEqual(fx.codes(), []);
      await fx.at(20.05, "902");
      assert.deepEqual(fx.rollbackArgs.at(-1), new Date(T0 + 10.05 * MIN).toISOString());
      assert.deepEqual(fx.codes(), ["LOCK_ROLLED_BACK"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("follows control events and telemetry once started, and drops a lock replaced behind its back", async () => {
    const fx = fixture({ lockMin: 10 });
    const silent = fixture({ lockMin: 10 });
    try {
      fx.heal.start();
      const lock = bandLock(T0);
      fx.setLock(lock);
      const event: ControlAppliedEvent = { action: "lock_band", tsIso: lock.updatedAtIso, summaryZh: "", summaryEn: "", lockState: lock };
      fx.core.scheduler.emit("control:applied", event);
      assert.equal(fx.heal.lockDeadlineMs, T0 + 10 * MIN);
      fx.setClock(T0 + 10 * MIN);
      fx.core.monitor.emit("telemetry", sample(T0 + 10 * MIN, "902"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fx.calls.rollback, 1);
      await fx.heal.stop();
      fx.core.scheduler.emit("control:applied", event);
      assert.equal(fx.heal.lockDeadlineMs, null, "stopped: no longer listening");

      silent.lockAt(0);
      silent.setLock(bandLock(T0 + 5 * MIN));
      await silent.at(10, "902");
      assert.equal(silent.calls.rollback, 0, "only the lock the window was opened for is rolled back");
      assert.equal(silent.heal.lockDeadlineMs, null);
    } finally {
      await fx.cleanup();
      await silent.cleanup();
    }
  });

  it("picks an open watch back up after a restart past the deadline, and never re-arms a lock the WAN proved", async () => {
    const open = fixture({ lockMin: 10 });
    const proved = fixture({ lockMin: 10 });
    const restarted: Array<ReturnType<typeof fixture>> = [];
    const restart = async (before: ReturnType<typeof fixture>, minutes: number): Promise<ReturnType<typeof fixture>> => {
      await before.heal.stop();
      await before.core.scheduler.stateStore.flushAsync();
      const next = fixture({ lockMin: 10, lock: bandLock(T0), stateFile: before.core.scheduler.stateStore.filePath });
      restarted.push(next);
      next.setClock(T0 + minutes * MIN);
      next.heal.start();
      return next;
    };
    try {
      // Down since the lock; the daemon is away across the deadline and comes back with the WAN still down
      open.lockAt(0);
      await open.at(5, "902");
      const back = await restart(open, 25);
      assert.equal(back.heal.lockDeadlineMs, T0 + 10 * MIN);
      await back.at(25, "902");
      assert.equal(back.calls.rollback, 1);
      assert.deepEqual(back.codes(), ["LOCK_ROLLED_BACK"]);

      // Up for two minutes after the lock: proved, so a restart inside the window leaves it alone
      proved.lockAt(0);
      await proved.at(0.5, "901");
      await proved.at(2.5, "901");
      assert.equal(proved.heal.lockDeadlineMs, null);
      const later = await restart(proved, 4);
      assert.equal(later.heal.lockDeadlineMs, null);
      await later.at(12, "902");
      assert.equal(later.calls.rollback, 0, "an outage after the proof is not the lock's fault, restart or not");
    } finally {
      for (const fx of restarted) await fx.cleanup();
      await open.cleanup();
      await proved.cleanup();
    }
  });

  it("re-arms after a restart inside the window, and never for an older lock or with the switch off", async () => {
    const recent = fixture({ lockMin: 10, lock: bandLock(T0 - 4 * MIN) });
    const old = fixture({ lockMin: 10, lock: bandLock(T0 - 11 * MIN) });
    const off = fixture({ lockMin: 0, reconnectMin: 0, lock: bandLock(T0 - MIN) });
    try {
      recent.heal.start();
      old.heal.start();
      off.heal.start();
      assert.equal(recent.heal.lockDeadlineMs, T0 + 6 * MIN);
      assert.equal(old.heal.lockDeadlineMs, null);
      assert.equal(off.heal.enabled, false);
      assert.equal(off.heal.lockDeadlineMs, null);
      await recent.at(6, "902");
      assert.equal(recent.calls.rollback, 1);
      await recent.heal.stop();
      await recent.heal.stop();
      await off.heal.stop();
    } finally {
      await recent.cleanup();
      await old.cleanup();
      await off.cleanup();
    }
  });

  it("drops telemetry snapshots that arrive while a write is in flight", async () => {
    const fx = fixture({ lockMin: 10 });
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    try {
      fx.lockAt(0);
      fx.rollbackPlan.push(async () => {
        await gate;
        return { applied: true };
      });
      fx.setClock(T0 + 10 * MIN);
      const first = fx.heal.ingestTelemetry(sample(T0 + 10 * MIN, "902"));
      assert.equal(fx.calls.rollback, 1);
      fx.setClock(T0 + 11 * MIN);
      const second = fx.heal.ingestTelemetry(sample(T0 + 11 * MIN, "902"));
      assert.equal(fx.calls.rollback, 1);
      unblock();
      await Promise.all([first, second]);
      assert.equal(fx.calls.rollback, 1);
    } finally {
      unblock();
      await fx.cleanup();
    }
  });

  it("stop() does not resolve while a write is in flight", async () => {
    const fx = fixture({ lockMin: 10 });
    let unblock: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    try {
      fx.heal.start();
      fx.lockAt(0);
      fx.rollbackPlan.push(async () => {
        await gate;
        return { applied: true };
      });
      fx.setClock(T0 + 10 * MIN);
      const writePromise = fx.heal.ingestTelemetry(sample(T0 + 10 * MIN, "902"));
      assert.equal(fx.calls.rollback, 1);
      let stopped = false;
      const stopPromise = fx.heal.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      assert.equal(stopped, false, "stop() must not resolve before write completes");
      unblock();
      await Promise.all([writePromise, stopPromise]);
      assert.equal(stopped, true, "stop() resolves once write completes");
    } finally {
      unblock();
      await fx.cleanup();
    }
  });

  it("ends the watch at once with a critical alert when the peer daemon is standby", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.lockAt(0);
      fx.rollbackPlan.push(async () => {
        throw new PeerDaemonStandbyError("192.168.8.2");
      });
      await fx.at(10, "902");
      assert.deepEqual(fx.codes(), ["LOCK_ROLLBACK_FAILED"]);
      assert.equal(fx.alerts[0]?.severity, "critical");
      assert.equal(fx.heal.lockDeadlineMs, null, "watch ended at once");
      await fx.at(11, "902");
      assert.equal(fx.calls.rollback, 1, "no retry when standby");
    } finally {
      await fx.cleanup();
    }
  });

  it("does not re-arm an unsettled lock after a restart past the give-up window", async () => {
    const lock = bandLock(T0 - 71 * MIN);
    const fx = fixture({ lockMin: 10, lock });
    try {
      fx.core.scheduler.stateStore.update({
        selfHealLockWatch: { lockUpdatedAtIso: lock.updatedAtIso, settled: false },
      });
      fx.heal.start();
      assert.equal(fx.heal.status().lockRollback.watch, null);
      await fx.at(0, "902");
      assert.equal(fx.calls.rollback, 0);
      assert.equal(fx.heal.status().lockRollback.watch, null);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("WanSelfHeal reconnect (WAN_AUTO_RECONNECT_AFTER_MIN)", () => {
  it("redials after the threshold, backs off 10 / 30 / 60 min and stops at 4 in 24 h", async () => {
    const fx = fixture({ reconnectMin: 3 });
    try {
      for (const minute of [0, 1, 2]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 0);
      await fx.at(3, "902");
      assert.equal(fx.calls.reconnect, 1);
      assert.match(fx.alerts[0]?.messageEn ?? "", /down for 3 min; redialled automatically \(1\/4 in 24 h/);
      await fx.at(12.9, "902");
      assert.equal(fx.calls.reconnect, 1);
      await fx.at(13, "902");
      await fx.at(42.9, "902");
      assert.equal(fx.calls.reconnect, 2);
      await fx.at(43, "902");
      await fx.at(102.9, "902");
      assert.equal(fx.calls.reconnect, 3);
      await fx.at(103, "902");
      assert.equal(fx.calls.reconnect, RECONNECT_MAX_PER_DAY);
      await fx.at(163, "902");
      await fx.at(300, "902");
      assert.equal(fx.calls.reconnect, RECONNECT_MAX_PER_DAY, "never more than 4 in 24 h, and never a reboot");
      assert.deepEqual(fx.codes(), ["WAN_AUTO_RECONNECT", "WAN_AUTO_RECONNECT", "WAN_AUTO_RECONNECT", "WAN_AUTO_RECONNECT", "WAN_RECONNECT_EXHAUSTED"]);
      assert.equal(fx.alerts[4]?.severity, "critical");

      // Back up: the next outage starts with the short wait, but the 24 h budget still counts
      await fx.at(310, "901");
      for (const minute of [320, 323, 330]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, RECONNECT_MAX_PER_DAY);
      assert.equal(fx.codes().filter((c) => c === "WAN_RECONNECT_EXHAUSTED").length, 2, "said again for the new outage");
      await fx.at(24 * 60 + 3, "902");
      assert.equal(fx.calls.reconnect, RECONNECT_MAX_PER_DAY + 1, "the first attempt left the 24 h window");
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves an outage after a fresh lock to the rollback, then starts the redial clock afresh", async () => {
    const fx = fixture({ lockMin: 10, reconnectMin: 3 });
    try {
      fx.lockAt(0);
      for (const minute of [1, 4, 8]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 0, "the lock window owns this outage");
      await fx.at(10, "902");
      assert.equal(fx.calls.rollback, 1);
      await fx.at(12, "902");
      assert.equal(fx.calls.reconnect, 0, "the unlocked modem gets time to attach");
      await fx.at(13, "902");
      assert.equal(fx.calls.reconnect, 1);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not spend the budget on refusals, retries a failed write later, and respects mobile data off", async () => {
    const fx = fixture({ reconnectMin: 1 });
    try {
      fx.reconnectPlan.push(
        async () => {
          throw new BrowserSessionYieldedError();
        },
        async () => {
          throw new Error("fetch failed");
        },
        async () => ({ applied: false, skipped: "mobile_data_off" }),
        async () => ({ applied: false, skipped: "wan_up" })
      );
      await fx.at(0, "902");
      await fx.at(1, "902");
      await fx.at(1.5, "902");
      assert.equal(fx.calls.reconnect, 1, "a refusal is retried after a minute");
      await fx.at(2, "902");
      assert.equal(fx.calls.reconnect, 2);
      // The failed write may have reached the router: it counts, and waits its backoff step like a redial
      await fx.at(3, "902");
      await fx.at(11.9, "902");
      assert.equal(fx.calls.reconnect, 2, "not again a minute later");
      await fx.at(12, "902");
      assert.equal(fx.calls.reconnect, 3);
      assert.ok(fx.logs.some((l) => l.includes("not redialling")));
      await fx.at(21.9, "902");
      assert.equal(fx.calls.reconnect, 3, "mobile data off: look again after 10 min");
      await fx.at(22, "902");
      for (const minute of [32, 62, 122, 182]) await fx.at(minute, "902");
      // The failed write and three redials are the day's four; the yield and the skips did not count
      assert.equal(fx.calls.reconnect, 7);
      assert.deepEqual(fx.codes(), ["WAN_AUTO_RECONNECT", "WAN_AUTO_RECONNECT", "WAN_AUTO_RECONNECT", "WAN_RECONNECT_EXHAUSTED"]);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the day's redials and the outage's backoff across a restart", async () => {
    const fx = fixture({ reconnectMin: 3 });
    let restarted: ReturnType<typeof fixture> | null = null;
    try {
      fx.heal.start();
      for (const minute of [0, 3, 13, 43]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 3);
      assert.equal(fx.core.scheduler.stateStore.getState().selfHealReconnect?.reconnectsMs.length, 3, "each redial is saved at once");
      await fx.heal.stop();
      // A deploy or a crash: the next daemon reads state.json afresh
      await fx.core.scheduler.stateStore.flushAsync();
      restarted = fixture({ reconnectMin: 3, stateFile: fx.core.scheduler.stateStore.filePath });
      restarted.setClock(T0 + 44 * MIN);
      restarted.heal.start();
      for (const minute of [44, 47, 102.9]) await restarted.at(minute, "902");
      assert.equal(restarted.calls.reconnect, 0, "the outage's 60 min step still holds after the restart");
      await restarted.at(103, "902");
      assert.equal(restarted.calls.reconnect, 1);
      assert.match(restarted.alerts[0]?.messageEn ?? "", /\(4\/4 in 24 h/);
      await restarted.at(163, "902");
      assert.equal(restarted.calls.reconnect, 1, "the day's four were spent before and after the restart");
      assert.deepEqual(restarted.codes(), ["WAN_AUTO_RECONNECT", "WAN_RECONNECT_EXHAUSTED"]);

      // Back up: the backoff starts over, the day's redials stay counted, and both are saved
      await restarted.at(170, "901");
      assert.deepEqual(restarted.core.scheduler.stateStore.getState().selfHealReconnect, {
        reconnectsMs: [3, 13, 43, 103].map((minute) => T0 + minute * MIN),
        nextReconnectAtMs: 0,
        backoffIndex: 0,
      });
    } finally {
      await restarted?.cleanup();
      await fx.cleanup();
    }
  });

  it("restores only what is plausible from a damaged or out-of-range saved budget", async () => {
    const fx = fixture({ reconnectMin: 3 });
    try {
      fx.core.scheduler.stateStore.update({
        // One redial within the day survives; the junk, a day-old entry and a wait ten days out do not
        selfHealReconnect: { reconnectsMs: ["x", T0 - 25 * 60 * MIN, T0 - 30 * MIN, Number.NaN], nextReconnectAtMs: T0 + 10 * 24 * 60 * MIN, backoffIndex: -3 },
      } as unknown as Parameters<typeof fx.core.scheduler.stateStore.update>[0]);
      fx.heal.start();
      for (const minute of [0, 3]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 1);
      assert.match(fx.alerts[0]?.messageEn ?? "", /\(2\/4 in 24 h/);
      await fx.at(12.9, "902");
      assert.equal(fx.calls.reconnect, 1);
      await fx.at(13, "902");
      assert.equal(fx.calls.reconnect, 2, "the first backoff step, as in a fresh outage");
    } finally {
      await fx.cleanup();
    }
  });

  it("paces a new outage from the first step when every saved redial is over a day old", async () => {
    // A daemon stopped for more than a day, or an older version that never updated the record, ran meanwhile
    const fx = fixture({ reconnectMin: 3 });
    try {
      const DAY = 24 * 60 * MIN;
      fx.core.scheduler.stateStore.update({
        selfHealReconnect: { reconnectsMs: [T0 - DAY - 100 * MIN, T0 - DAY - 90 * MIN, T0 - DAY - 60 * MIN], nextReconnectAtMs: T0 - DAY, backoffIndex: 3 },
      });
      fx.heal.start();
      for (const minute of [0, 3]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 1);
      assert.match(fx.alerts[0]?.messageEn ?? "", /\(1\/4 in 24 h/);
      await fx.at(12.9, "902");
      assert.equal(fx.calls.reconnect, 1);
      await fx.at(13, "902");
      assert.equal(fx.calls.reconnect, 2, "10 min after the first redial, not the old outage's 60 min step");
    } finally {
      await fx.cleanup();
    }
  });

  it("starts with an empty budget when nothing was saved, and saves nothing while the WAN is up", async () => {
    const fx = fixture({ reconnectMin: 3 });
    try {
      fx.heal.start();
      for (const minute of [0, 1, 2]) await fx.at(minute, "901");
      assert.equal(fx.core.scheduler.stateStore.getState().selfHealReconnect, null);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not spend the budget or save state when the peer daemon is standby and retries in one minute", async () => {
    const fx = fixture({ reconnectMin: 1 });
    try {
      fx.reconnectPlan.push(async () => {
        throw new PeerDaemonStandbyError("192.168.8.2");
      });
      await fx.at(0, "902");
      await fx.at(1, "902");
      assert.equal(fx.calls.reconnect, 1);
      assert.equal(fx.heal.status().reconnect.redialsLast24h, 0, "does not spend a redial");
      assert.equal(fx.core.scheduler.stateStore.getState().selfHealReconnect, null, "nothing saved in state store");
      await fx.at(1.5, "902");
      assert.equal(fx.calls.reconnect, 1, "retry waits a minute");
      await fx.at(2, "902");
      assert.equal(fx.calls.reconnect, 2, "retried after SELF_HEAL_RETRY_MS");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("WanSelfHeal status (what it will do next, for the console and agents)", () => {
  it("reports the lock window, the day's redials and the next allowed redial, and nothing when off", async () => {
    assert.deepEqual(SELF_HEAL_OFF, {
      lockRollback: { afterMin: null, watch: null },
      reconnect: { afterMin: null, redialsLast24h: 0, maxPer24h: RECONNECT_MAX_PER_DAY, nextAllowedAtIso: null, wanDownSinceIso: null },
    });
    const fx = fixture({ lockMin: 10, reconnectMin: 3 });
    try {
      assert.deepEqual(fx.heal.status(), {
        lockRollback: { afterMin: 10, watch: null },
        reconnect: { afterMin: 3, redialsLast24h: 0, maxPer24h: RECONNECT_MAX_PER_DAY, nextAllowedAtIso: null, wanDownSinceIso: null },
      });
      fx.lockAt(0);
      await fx.at(1, "901");
      assert.deepEqual(fx.heal.status().lockRollback.watch, {
        lockUpdatedAtIso: new Date(T0).toISOString(),
        deadlineIso: new Date(T0 + 10 * MIN).toISOString(),
        wanUpSinceIso: new Date(T0 + MIN).toISOString(),
      });
      await fx.at(3, "901");
      assert.equal(fx.heal.status().lockRollback.watch, null, "proved: no longer watched");

      // An outage: the redial clock, then a redial and its backoff
      await fx.at(20, "902");
      assert.equal(fx.heal.status().reconnect.wanDownSinceIso, new Date(T0 + 20 * MIN).toISOString());
      await fx.at(23, "902");
      const after = fx.heal.status().reconnect;
      assert.deepEqual([after.redialsLast24h, after.nextAllowedAtIso], [1, new Date(T0 + 33 * MIN).toISOString()]);
      await fx.at(40, "901");
      assert.deepEqual(fx.heal.status().reconnect, { afterMin: 3, redialsLast24h: 1, maxPer24h: RECONNECT_MAX_PER_DAY, nextAllowedAtIso: null, wanDownSinceIso: null });
      fx.setClock(T0 + (23 + 24 * 60) * MIN);
      assert.equal(fx.heal.status().reconnect.redialsLast24h, 0, "a day later the redial no longer counts");
    } finally {
      await fx.cleanup();
    }
  });

  it("names when the day's cap lets the next redial through once all four are spent", async () => {
    const fx = fixture({ reconnectMin: 3 });
    try {
      fx.heal.start();
      for (const minute of [0, 3, 13, 43, 103, 163]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 4);
      const capped = new Date(T0 + (3 + 24 * 60) * MIN).toISOString();
      assert.deepEqual([fx.heal.status().reconnect.redialsLast24h, fx.heal.status().reconnect.nextAllowedAtIso], [4, capped], "the 60 min step is over, the cap is not");
      await fx.at(170, "901");
      assert.equal(fx.heal.status().reconnect.nextAllowedAtIso, capped, "the cap holds while the WAN is up too");
      fx.setClock(T0 + (3 + 24 * 60) * MIN);
      assert.deepEqual([fx.heal.status().reconnect.redialsLast24h, fx.heal.status().reconnect.nextAllowedAtIso], [3, null]);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("WanSelfHeal on a router of an unverified model (read-only)", () => {
  it("redials nothing in that outage and alerts once, without spending the day's budget", async () => {
    const fx = fixture({ reconnectMin: 1 });
    try {
      const refuse = async (): Promise<WanRepairOutcome> => {
        throw new DeviceReadOnlyError("B535-232", "reconnect");
      };
      fx.reconnectPlan.push(refuse, refuse);
      await fx.at(0, "902");
      await fx.at(1, "902");
      for (const minute of [2, 5, 30, 90]) await fx.at(minute, "902");
      assert.equal(fx.calls.reconnect, 1, "tried once, then left alone for this outage");
      assert.deepEqual(fx.codes(), ["SELF_HEAL_READ_ONLY"]);
      assert.match(fx.alerts[0]?.messageEn ?? "", /down for 1 min[\s\S]*\(B535-232\)[\s\S]*router's own page/);
      // The next outage asks once more (the router may have been replaced meanwhile)
      await fx.at(91, "901");
      await fx.at(92, "902");
      await fx.at(93, "902");
      assert.deepEqual([fx.calls.reconnect, fx.codes()], [2, ["SELF_HEAL_READ_ONLY", "SELF_HEAL_READ_ONLY"]]);
      await fx.at(94, "901");
      for (const minute of [95, 96, 106, 136, 196]) await fx.at(minute, "902");
      assert.equal(fx.codes().filter((c) => c === "WAN_AUTO_RECONNECT").length, RECONNECT_MAX_PER_DAY, "the refusals spent none of the four redials");
    } finally {
      await fx.cleanup();
    }
  });

  it("drops the lock watch with one alert instead of failing three times", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.rollbackPlan.push(async () => {
        throw new DeviceReadOnlyError("B535-232", "bandLock");
      });
      fx.lockAt(0);
      await fx.at(10, "902");
      for (const minute of [11, 12, 13, 20]) await fx.at(minute, "902");
      assert.equal(fx.calls.rollback, 1);
      assert.deepEqual(fx.codes(), ["SELF_HEAL_READ_ONLY"]);
      assert.equal(fx.heal.lockDeadlineMs, null);
    } finally {
      await fx.cleanup();
    }
  });

  it("goes through the real write gate: neither action reaches the router", async () => {
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232" });
    const dir = tempDir("fengsui-selfheal-gate-");
    const core = createFengSuiCore({
      connection: mockConnection(cpe),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "selfheal_gate_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    core.monitor.init();
    let clock = T0;
    const heal = new WanSelfHeal({ scheduler: core.scheduler, monitor: core.monitor, controls: core.controls, lockRollbackAfterMs: 10 * MIN, reconnectAfterMs: 1 * MIN, now: () => clock });
    const codes: string[] = [];
    core.scheduler.on("alert", (a: AlertEventRecord) => codes.push(a.code));
    try {
      assert.ok(await core.monitor.identifyDevice());
      const sent = cpe.stats.requests.length;
      // A lock FengSui applied before the router was replaced: the rollback watch is armed
      heal.noteControl({ action: "lock_band", tsIso: new Date(clock).toISOString(), summaryZh: "", summaryEn: "", lockState: bandLock(clock) });
      core.stateStore.update({ lockState: bandLock(clock) });
      for (const minute of [0, 1, 2, 10]) {
        clock = T0 + minute * MIN;
        await heal.ingestTelemetry(sample(clock, "902"));
      }
      assert.deepEqual(codes, ["SELF_HEAL_READ_ONLY"], "the outage is the rollback's until its deadline, which is refused");
      for (const minute of [11, 12, 13, 20]) {
        clock = T0 + minute * MIN;
        await heal.ingestTelemetry(sample(clock, "902"));
      }
      assert.deepEqual(codes, ["SELF_HEAL_READ_ONLY", "SELF_HEAL_READ_ONLY"], "then the redial it would do next is refused, once for the outage");
      assert.deepEqual([cpe.stats.writes, cpe.stats.requests.length], [[], sent], "no session, no write");
    } finally {
      await heal.stop();
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });
});

describe("guarded automatic writes through the control queue", () => {
  // The session bootstrap (`Update-Cookie`) is served normally; only the in-session re-read sees the WAN down
  const down = (dataSwitch: "0" | "1") => (p: string, _method: string, headers: Headers): StrictFault | undefined => {
    if (p === "/api/monitoring/status" && !headers.get("update-cookie")) return { body: "<response><ConnectionStatus>902</ConnectionStatus><SignalIcon>0</SignalIcon><SimStatus>1</SimStatus></response>" };
    if (p === "/api/dialup/mobile-dataswitch") return { body: `<response><dataswitch>${dataSwitch}</dataswitch></response>` };
    return undefined;
  };

  it("rolls the locks back and broadcasts only when the session saw the WAN down", async () => {
    const live = createCore();
    try {
      const events: ControlAppliedEvent[] = [];
      live.core.scheduler.on("control:applied", (e: ControlAppliedEvent) => events.push(e));
      assert.deepEqual(await live.core.controls.rollBackLocks(live.core.controls.getPersistedLockState().updatedAtIso), { applied: false, skipped: "wan_up" });
      assert.deepEqual(await live.core.controls.reconnectWan(), { applied: false, skipped: "wan_up" });
      assert.deepEqual(live.cpe.stats.writes.map((w) => w.path), [], "nothing written while the WAN is up");
      assert.deepEqual(events, [], "no control:applied for a write that did not happen");
    } finally {
      await live.cleanup();
    }

    const dead = createCore(down("1"));
    try {
      const events: ControlAppliedEvent[] = [];
      dead.core.scheduler.on("control:applied", (e: ControlAppliedEvent) => events.push(e));
      const outcome = await dead.core.controls.rollBackLocks(dead.core.controls.getPersistedLockState().updatedAtIso);
      assert.equal(outcome.applied, true);
      assert.equal(dead.core.controls.getPersistedLockState().mode, "unlocked");
      assert.deepEqual(dead.cpe.stats.writes.map((w) => w.path), ["/api/net/lock-freq", "/api/net/net-mode"]);
      assert.equal(events[0]?.action, "auto_unlock_rf_locks");
      assert.equal(events[0]?.lockState?.mode, "unlocked");

      assert.deepEqual(await dead.core.controls.reconnectWan(), { applied: true });
      assert.equal(dead.cpe.stats.writes.at(-1)?.path, "/api/net/reconnect");
      assert.equal(events[1]?.action, "auto_reconnect_cellular");
      assert.equal(dead.cpe.stats.logins, dead.cpe.stats.logouts, "every session logged out");
    } finally {
      await dead.cleanup();
    }

    const dataOff = createCore(down("0"));
    try {
      assert.deepEqual(await dataOff.core.controls.reconnectWan(), { applied: false, skipped: "mobile_data_off" });
      assert.deepEqual(await dataOff.core.controls.rollBackLocks(dataOff.core.controls.getPersistedLockState().updatedAtIso), { applied: false, skipped: "mobile_data_off" });
      assert.deepEqual(dataOff.cpe.stats.writes, []);
    } finally {
      await dataOff.cleanup();
    }
  });

  it("leaves alone a lock that replaced the one it was asked to roll back while it waited in the queue", async () => {
    const dead = createCore(down("1"));
    try {
      const watched = dead.core.controls.getPersistedLockState().updatedAtIso;
      // The owner's lock is queued first; the rollback of the lock before it runs right after it
      const owner = dead.core.controls.lockBands({ lteBands: [20] });
      const rollback = dead.core.controls.rollBackLocks(watched);
      const lock = await owner;
      const written = dead.cpe.stats.writes.length;
      assert.deepEqual(await rollback, { applied: false, skipped: "lock_changed" });
      assert.equal(dead.cpe.stats.writes.length, written, "nothing written over the owner's lock");
      assert.deepEqual(dead.core.controls.getPersistedLockState(), lock);
      assert.equal(dead.cpe.stats.logins, dead.cpe.stats.logouts);
    } finally {
      await dead.cleanup();
    }
  });
});

describe("self-heal configuration and wiring", () => {
  function envFile(dir: string, extra: string, password = "selfheal_pw"): string {
    const file = path.join(dir, ".env");
    fs.writeFileSync(
      file,
      `CPE_URL=http://192.168.8.1\nCPE_PASSWORD=${password}\nDATA_ENCRYPTION_KEY=selfheal_key\nWEB_ENABLED=false\nSTATE_FILE=${path.join(dir, "data", "state.json")}\nPOLL_INTERVAL_MS=600000\nNEIGHBOR_SCAN_INTERVAL_MS=600000\nSMS_ENABLED=false\n${extra}`
    );
    return file;
  }

  it("is off by default, clamps the windows and writes only when asked", async () => {
    const dir = tempDir("fengsui-selfheal-cfg-");
    try {
      const off = loadConfig({ envPath: envFile(dir, ""), ignoreProcessEnv: true });
      assert.equal(off.lockRollbackAfterMs, 0);
      assert.equal(off.wanReconnectAfterMs, 0);
      const cfg = (extra: string) => loadConfig({ envPath: envFile(dir, extra), ignoreProcessEnv: true });
      assert.equal(cfg("LOCK_ROLLBACK_AFTER_MIN=10\nWAN_AUTO_RECONNECT_AFTER_MIN=3\n").lockRollbackAfterMs, 10 * MIN);
      assert.equal(cfg("WAN_AUTO_RECONNECT_AFTER_MIN=3\n").wanReconnectAfterMs, 3 * MIN);
      assert.equal(cfg("LOCK_ROLLBACK_AFTER_MIN=1\n").lockRollbackAfterMs, 3 * MIN, "too short would undo good locks");
      assert.equal(cfg("LOCK_ROLLBACK_AFTER_MIN=99999\n").lockRollbackAfterMs, 1440 * MIN);
      assert.equal(cfg("LOCK_ROLLBACK_AFTER_MIN=ten\nWAN_AUTO_RECONNECT_AFTER_MIN=-5\n").lockRollbackAfterMs, 0);
      assert.equal(cfg("WAN_AUTO_RECONNECT_AFTER_MIN=-5\n").wanReconnectAfterMs, 0);

      const sessionStatus = async (stack: ReturnType<typeof createFengSuiRuntime>): Promise<unknown> => {
        const res = (await stack.mcpServer.handleRawJsonMessage(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_cpe_session_status", arguments: {} } })
        )) as JsonRpcSuccessResponse;
        return (res.result as { structuredContent: { selfHeal: unknown } }).structuredContent.selfHeal;
      };
      const plain = createFengSuiRuntime({ config: off, log: () => undefined });
      assert.equal(plain.selfHeal?.enabled, false, "built (Settings can turn it on), but off");
      assert.deepEqual(await sessionStatus(plain), SELF_HEAL_OFF, "agents see that nothing writes on its own");
      await plain.close();

      const cpe = createStrictCpe();
      const config = loadConfig({
        envPath: envFile(dir, "LOCK_ROLLBACK_AFTER_MIN=10\nWAN_AUTO_RECONNECT_AFTER_MIN=3\n", cpe.password),
        ignoreProcessEnv: true,
      });
      const stack = createFengSuiRuntime({ config, fetchImpl: cpe.fetchImpl, log: () => undefined });
      assert.ok(stack.selfHeal);
      assert.equal(stack.selfHeal.lockRollbackAfterMs, 10 * MIN);
      assert.equal(stack.selfHeal.reconnectAfterMs, 3 * MIN);
      const status = (await sessionStatus(stack)) as SelfHealStatus;
      assert.deepEqual([status.lockRollback.afterMin, status.reconnect.afterMin], [10, 3]);
      await stack.start();
      await stack.close();
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("WanSelfHeal and a lock on a router nobody verified", () => {
  it("writes back the band setting from before the lock after 3 minutes down with the rollback off, and keeps watching when the owner changes the rollback", async () => {
    const fx = fixture({});
    try {
      fx.setClock(T0);
      const lock = bandLock(T0);
      fx.setLock(lock);
      // The router was locked to B3 before this lock: that is what comes back, not "every band"
      fx.heal.guardExperimentalLock({ lock, savedLteMask: "4" });
      assert.equal(fx.heal.lockDeadlineMs, T0 + 3 * MIN);
      fx.heal.reconfigure();
      assert.equal(fx.heal.lockDeadlineMs, T0 + 3 * MIN, "the rollback being off does not end this watch");
      await fx.at(2, "902");
      assert.equal(fx.calls.rollback, 0);
      await fx.at(3, "902");
      assert.deepEqual([fx.rollbackArgs, fx.restoreArgs], [[lock.updatedAtIso], ["4"]]);
      const rolled = fx.alerts.find((a) => a.code === "LOCK_ROLLED_BACK");
      assert.match(rolled?.messageEn ?? "", /^The WAN was still down 3 min after a lock on a router FengSui was not verified on, so the band setting from before the lock was written back/);
      assert.doesNotMatch(`${rolled?.messageEn} ${rolled?.messageZh}`, /agent|智能体/i, "whoever locked: the console, a token, an agent or Telegram");
    } finally {
      await fx.cleanup();
    }
  });

  it("restores the saved setting even when the owner's own rollback window is the longer one, and clears every lock when nothing was saved", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.setClock(T0);
      const lock = bandLock(T0);
      fx.setLock(lock);
      fx.heal.guardExperimentalLock({ lock, savedLteMask: "800800c5" });
      await fx.at(10, "902");
      assert.deepEqual(fx.restoreArgs, ["800800c5"]);
      assert.match(fx.alerts.find((a) => a.code === "LOCK_ROLLED_BACK")?.messageEn ?? "", /written back/);

      // No mask to read before the lock: the documented rollback (every lock cleared)
      fx.setClock(T0 + 20 * MIN);
      const blind = bandLock(T0 + 20 * MIN);
      fx.setLock(blind);
      fx.heal.guardExperimentalLock({ lock: blind, savedLteMask: null });
      await fx.at(30, "902");
      assert.deepEqual(fx.restoreArgs, ["800800c5", null]);
      // The owner's own, longer window decided this one: it is named as the rollback they set
      assert.match(fx.alerts.filter((a) => a.code === "LOCK_ROLLED_BACK").at(-1)?.messageEn ?? "", /^The WAN was still down 10 min after the lock, so every band and cell lock was cleared automatically \(LOCK_ROLLBACK_AFTER_MIN\)/);
    } finally {
      await fx.cleanup();
    }
  });

  it("takes a cell lock off after 3 minutes down: there is no setting to write back", async () => {
    const fx = fixture({});
    try {
      fx.setClock(T0);
      const lock: PersistedLockState = { mode: "cell_lock", updatedAtIso: new Date(T0).toISOString(), lteBands: "all", nrBands: [78], cellLock: { rat: "NR", band: 78, arfcn: 650000, pci: 211 } };
      fx.setLock(lock);
      fx.heal.guardExperimentalLock({ lock, savedLteMask: null });
      await fx.at(2.9, "902");
      assert.equal(fx.calls.rollback, 0);
      await fx.at(3, "902");
      assert.deepEqual([fx.rollbackArgs, fx.restoreArgs], [[lock.updatedAtIso], [null]]);
      assert.match(fx.alerts.find((a) => a.code === "LOCK_ROLLED_BACK")?.messageZh ?? "", /未验证的路由器上锁定后 3 分钟 WAN 仍未恢复，已自动解除全部频段与小区锁定/);
    } finally {
      await fx.cleanup();
    }
  });

  it("goes on counting after a restart, with the rollback off: the saved setting, the same deadline, and never for a lock the WAN proved", async () => {
    const open = fixture({});
    const proved = fixture({});
    const restarted: Array<ReturnType<typeof fixture>> = [];
    const restart = async (before: ReturnType<typeof fixture>, lock: PersistedLockState, minutes: number): Promise<ReturnType<typeof fixture>> => {
      await before.heal.stop();
      await before.core.scheduler.stateStore.flushAsync();
      const next = fixture({ lock, stateFile: before.core.scheduler.stateStore.filePath });
      restarted.push(next);
      next.setClock(T0 + minutes * MIN);
      next.heal.start();
      return next;
    };
    try {
      const lock = bandLock(T0);
      open.setClock(T0);
      open.setLock(lock);
      open.heal.start();
      open.heal.guardExperimentalLock({ lock, savedLteMask: "800800c5" });
      await open.at(1, "902");
      // The daemon is away for a minute and comes back inside the 3 minutes
      const back = await restart(open, lock, 2);
      assert.equal(back.heal.lockDeadlineMs, T0 + 3 * MIN, "the lock's own 3 minutes, not 3 more from the restart");
      await back.at(2.5, "902");
      assert.equal(back.calls.rollback, 0);
      await back.at(3, "902");
      assert.deepEqual([back.rollbackArgs, back.restoreArgs], [[lock.updatedAtIso], ["800800c5"]]);
      // Done once: another restart finds the watch ended
      const again = await restart(back, bandLock(T0), 4);
      assert.equal(again.heal.lockDeadlineMs, null);

      // Away across the deadline: undone at the first poll that still shows the WAN down
      const late = fixture({});
      restarted.push(late);
      late.setClock(T0);
      late.setLock(lock);
      late.heal.start();
      late.heal.guardExperimentalLock({ lock, savedLteMask: null });
      const after = await restart(late, lock, 30);
      await after.at(30, "902");
      assert.deepEqual(after.restoreArgs, [null]);

      // Up two minutes after the lock: kept, and a restart does not watch it again
      proved.setClock(T0);
      proved.setLock(lock);
      proved.heal.start();
      proved.heal.guardExperimentalLock({ lock, savedLteMask: "800800c5" });
      await proved.at(0.5, "901");
      await proved.at(2.5, "901");
      const kept = await restart(proved, lock, 2.8);
      assert.equal(kept.heal.lockDeadlineMs, null);
      await kept.at(5, "902");
      assert.equal(kept.calls.rollback, 0);
    } finally {
      for (const fx of restarted) await fx.cleanup();
      await open.cleanup();
      await proved.cleanup();
    }
  });

  it("reads a stored watch as input: a mask that is not one is not written back, and a watch of an older version has no guard", async () => {
    const lock = bandLock(T0);
    const opened: Array<ReturnType<typeof fixture>> = [];
    /** A daemon starting a minute after the lock on the state an earlier run left with this watch record. */
    const startWith = async (record: Record<string, unknown>): Promise<ReturnType<typeof fixture>> => {
      const earlier = fixture({});
      opened.push(earlier);
      earlier.core.scheduler.stateStore.update({ selfHealLockWatch: record as never });
      await earlier.core.scheduler.stateStore.flushAsync();
      const next = fixture({ lock, stateFile: earlier.core.scheduler.stateStore.filePath });
      opened.unshift(next);
      next.setClock(T0 + MIN);
      next.heal.start();
      return next;
    };
    try {
      const odd = await startWith({ lockUpdatedAtIso: lock.updatedAtIso, settled: false, guard: true, restoreLteMask: "not-a-mask" });
      assert.equal(odd.heal.lockDeadlineMs, T0 + 3 * MIN);
      await odd.at(3, "902");
      assert.deepEqual(odd.restoreArgs, [null], "the documented way back: every lock cleared");

      // What 1.8.3 stored: no guard, so with the rollback off nothing is watched
      const old = await startWith({ lockUpdatedAtIso: lock.updatedAtIso, settled: false });
      assert.equal(old.heal.lockDeadlineMs, null);
      // And a guard that is not `true` is not one
      const vague = await startWith({ lockUpdatedAtIso: lock.updatedAtIso, settled: false, guard: "yes", restoreLteMask: "800800c5" });
      assert.equal(vague.heal.lockDeadlineMs, null);
    } finally {
      for (const fx of opened) await fx.cleanup();
    }
  });

  it("keeps a lock the WAN proves, and ignores an unlock handed to the guard", async () => {
    const fx = fixture({ lockMin: 10 });
    try {
      fx.setClock(T0);
      const lock = bandLock(T0);
      fx.setLock(lock);
      fx.heal.guardExperimentalLock({ lock, savedLteMask: "800800c5" });
      assert.equal(fx.heal.lockDeadlineMs, T0 + 10 * MIN, "a longer rollback window wins");
      await fx.at(1, "901");
      await fx.at(3.5, "901");
      assert.equal(fx.heal.lockDeadlineMs, null, "up 2 minutes: kept");
      fx.heal.guardExperimentalLock({ lock: unlocked(T0 + 5 * MIN), savedLteMask: "5" });
      assert.equal(fx.heal.lockDeadlineMs, null);
      assert.equal(fx.calls.rollback, 0);
    } finally {
      await fx.cleanup();
    }
  });
});

