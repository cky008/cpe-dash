import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { runAsActor } from "../src/audit-log.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { type ControlAuditEvent, CpeNotConfiguredError } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

function fixture(opts: { password?: string; fault?: (p: string) => StrictFault | undefined } = {}) {
  const cpe = createStrictCpe({ fault: opts.fault });
  const dir = tempDir("fengsui-conn-");
  const core = createFengSuiCore({
    connection: mockConnection({ password: opts.password ?? cpe.password, fetchImpl: cpe.fetchImpl }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "conn_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
  });
  core.monitor.init();
  return {
    cpe,
    core,
    good: { url: "http://192.168.8.1", username: "admin", password: cpe.password },
    cleanup: async () => {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

describe("router connection test and switch", () => {
  it("proves a connection with one throwaway session, leaving the live client and its breaker alone", async () => {
    const fx = fixture({ password: "the_old_wrong_password" });
    try {
      const ok = await fx.core.scheduler.testConnection(fx.good);
      assert.equal(ok.ok, true);
      assert.equal(ok.ok && ok.model, "H168-383");
      assert.equal(fx.cpe.stats.logins, fx.cpe.stats.logouts, "logged out again");

      const wrong = await fx.core.scheduler.testConnection({ ...fx.good, password: "typo" });
      assert.deepEqual(wrong.ok ? null : [wrong.reason, wrong.code, wrong.remainCount], ["wrong_password", "108006", 2]);
      assert.equal(fx.core.scheduler.getStatus().circuitBreaker.tripped, false, "the live breaker never saw the test");

      const second = await fx.core.scheduler.testConnection({ ...fx.good, password: "typo again" });
      assert.deepEqual(second.ok ? null : [second.reason, second.remainCount], ["wrong_password", 1]);
      const authCalls = fx.cpe.stats.authCalls;
      const guarded = await fx.core.scheduler.testConnection({ ...fx.good, password: "third guess" });
      assert.deepEqual(guarded.ok ? null : [guarded.reason, guarded.remainCount], ["last_attempt", 1]);
      assert.equal(fx.cpe.stats.authCalls, authCalls, "the last attempt is not spent without a confirmation");
      const confirmed = await fx.core.scheduler.testConnection(fx.good, { lastAttempt: true });
      assert.equal(confirmed.ok, true, "a confirmed attempt with the right password works and resets the count");
      assert.equal((await fx.core.scheduler.testConnection(fx.good)).ok, true);

      // Switch the live client over: the old wrong password and its latch are gone
      const breaker = await fx.core.scheduler.applyConnection(fx.good);
      assert.equal(breaker.tripped, false);
      assert.ok(await fx.core.monitor.refreshTelemetry(), "the live client logs in with the new connection");
    } finally {
      await fx.cleanup();
    }
  });

  it("names why a connection failed: locked, a human on the WebUI, unreachable, router error, bad address, standby", async () => {
    const human = fixture();
    try {
      human.cpe.human.loginSameIp();
      const busy = await human.core.scheduler.testConnection(human.good);
      assert.equal(busy.ok ? null : busy.reason, "human_logged_in");
      human.cpe.human.logout();
      for (const guess of ["a", "b"]) await human.core.scheduler.testConnection({ ...human.good, password: guess });
      const locked = await human.core.scheduler.testConnection({ ...human.good, password: "c" }, { lastAttempt: true });
      assert.deepEqual(locked.ok ? null : [locked.reason, locked.code, locked.waitTimeSec], ["locked", "108007", 600]);
      const invalid = await human.core.scheduler.testConnection({ ...human.good, url: "http://203.0.113.10" });
      assert.equal(invalid.ok ? null : invalid.reason, "invalid_url");
      human.core.scheduler.setPeerStandby("192.168.8.20");
      const standby = await human.core.scheduler.testConnection(human.good);
      assert.equal(standby.ok ? null : standby.reason, "standby");
    } finally {
      await human.cleanup();
    }

    const offline = fixture({ fault: (p) => (p === "/api/user/state-login" ? "transport" : undefined) });
    try {
      const down = await offline.core.scheduler.testConnection(offline.good);
      assert.equal(down.ok ? null : down.reason, "unreachable");
    } finally {
      await offline.cleanup();
    }

    const odd = fixture({ fault: (p) => (p === "/api/device/information" ? { cpeError: "100002" } : undefined) });
    try {
      const error = await odd.core.scheduler.testConnection(odd.good);
      assert.deepEqual(error.ok ? null : [error.reason, error.code], ["router_error", "100002"]);
    } finally {
      await odd.cleanup();
    }
  });

  it("logs nothing in before setup and audits every write with the caller captured where it was asked for", async () => {
    const fx = fixture({ password: "" });
    try {
      assert.equal(await fx.core.scheduler.read(async () => "never"), null);
      assert.deepEqual(fx.cpe.stats.requests, [], "not even a state-login probe");
      const events: ControlAuditEvent[] = [];
      fx.core.scheduler.on("control:audit", (e: ControlAuditEvent) => events.push(e));
      await assert.rejects(runAsActor({ channel: "token", label: "ci" }, () => fx.core.controls.unlockAllLocks()), CpeNotConfiguredError);
      assert.deepEqual(events.map((e) => [e.actor.channel, e.actor.label, e.action, e.outcome]), [["token", "ci", "unlock_rf_locks", "refused"]]);

      await fx.core.scheduler.applyConnection(fx.good);
      // A web write queued behind a poll the system started still carries the web caller
      const poll = fx.core.monitor.refreshTelemetry();
      await runAsActor({ channel: "web" }, () => fx.core.controls.unlockAllLocks());
      await poll;
      const last = events.at(-1);
      assert.deepEqual([last?.actor.channel, last?.action, last?.outcome], ["web", "unlock_rf_locks", "applied"]);
      assert.match(last?.detail ?? "", /Cleared all band and cell locks/);
    } finally {
      await fx.cleanup();
    }
  });
});
