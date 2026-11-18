import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { type ConnectionPauseStatus, PAUSE_MAX_MINUTES, readPauseMinutes } from "../src/connection-pause.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { type ApiExchange, FengSuiApi } from "../src/http-api.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { permissionForRoute } from "../src/operations/registry.ts";
import { WanSelfHeal } from "../src/self-heal.ts";
import { SseEventBus } from "../src/sse-bus.ts";
import { type ControlAuditEvent, ConnectionPausedError, isRefusal } from "../src/scheduler.ts";
import { type AlertEventRecord, EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { mockConnection } from "./helpers/connection.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Pausing the connection (Settings → Router): for a time its owner chooses, FengSui opens no session
 * on the router and sends it nothing, so they can use the router's own page on a router that keeps
 * one admin session. Reads are skipped, writes are refused before any session, and the pause ends by
 * itself. Strict mock router only.
 */

const MINUTE = 60_000;

function pauseFixture(opts: { dir?: string; at?: number; cellular?: boolean; transport?: (fetchImpl: typeof fetch) => typeof fetch } = {}) {
  const router = createStrictCpe({ cellular: opts.cellular === true });
  const dir = opts.dir ?? tempDir("fengsui-pause-");
  const clock = { now: opts.at ?? Date.parse("2026-11-16T12:00:00.000Z") };
  const stateStore = new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "pause_key" });
  const core = createFengSuiCore({
    connection: mockConnection({ password: router.password, fetchImpl: opts.transport ? opts.transport(router.fetchImpl) : router.fetchImpl }),
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
    now: () => clock.now,
  });
  core.monitor.init();
  const events: ConnectionPauseStatus[] = [];
  const audits: ControlAuditEvent[] = [];
  const alerts: AlertEventRecord[] = [];
  core.scheduler.on("session:pause", (status: ConnectionPauseStatus) => events.push(status));
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  core.scheduler.on("alert", (alert: AlertEventRecord) => alerts.push(alert));
  return {
    router,
    dir,
    clock,
    core,
    stateStore,
    events,
    audits,
    alerts,
    sent: (): number => router.stats.requests.length,
    cleanup: async (keepDir = false): Promise<void> => {
      await stopFengSuiCore(core);
      if (!keepDir) removeTempDir(dir);
    },
  };
}

describe("pausing the connection to the router", () => {
  it("sends the router nothing while paused: reads are skipped, writes are refused before any session", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry(), "reads before the pause");
      assert.deepEqual(fx.core.scheduler.getStatus().pause, { active: false, sinceIso: null, untilIso: null, blocked: null });
      const paused = fx.core.scheduler.pauseConnection(30);
      assert.deepEqual(paused, { active: true, sinceIso: "2026-11-16T12:00:00.000Z", untilIso: "2026-11-16T12:30:00.000Z", blocked: null });
      const sent = fx.sent();

      assert.equal(await fx.core.monitor.refreshTelemetry(), null, "a poll is skipped, as while a person is on the router's page");
      assert.equal(await fx.core.scheduler.read(async () => "read"), null);
      await assert.rejects(fx.core.controls.unlockAllLocks(), (err: unknown) => {
        assert.ok(err instanceof ConnectionPausedError, String(err));
        assert.equal(err.statusCode, 409);
        assert.equal(err.pause.untilIso, "2026-11-16T12:30:00.000Z");
        assert.match(err.messageEn, /paused.*nothing was sent/i);
        assert.match(err.messageZh, /暂停/);
        assert.ok(isRefusal(err), "counted nowhere as a failed write");
        return true;
      });
      await assert.rejects(fx.core.controls.rebootRouter({ confirm: true }), ConnectionPausedError);
      // Login-free requests are requests too
      await assert.rejects(fx.core.scheduler.probeLoginState(), ConnectionPausedError);
      await assert.rejects(fx.core.scheduler.probePublic("/api/monitoring/check-notifications"), ConnectionPausedError);
      // A connection test or a brand detection would talk to the router as well
      const test = await fx.core.scheduler.testConnection({ url: "http://192.168.8.1", username: "admin", password: fx.router.password });
      assert.deepEqual([test.ok, test.ok ? null : test.reason], [false, "paused"]);
      const detected = await fx.core.scheduler.detectFamily("http://192.168.8.1");
      assert.deepEqual(typeof detected === "string" ? detected : detected.reason, "paused");
      assert.equal(await fx.core.scheduler.routerCertificate("https://192.168.8.1"), null);

      assert.equal(fx.sent(), sent, "not one request reached the router");
      const status = fx.core.scheduler.getStatus();
      assert.deepEqual([status.mode, status.pause.active], ["paused", true]);
      assert.deepEqual(fx.audits.filter((event) => event.action === "unlock_rf_locks").map((event) => event.outcome), ["refused"]);
      assert.deepEqual(fx.alerts.map((alert) => [alert.severity, alert.code]), [["info", "CONNECTION_PAUSED"]]);
      assert.match(fx.alerts[0]?.messageEn ?? "", /30 minutes/);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a write that was already waiting when the pause began", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      let inside = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = fx.core.scheduler.read(async () => {
        inside = true;
        await held;
        return "read";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const writing = fx.core.controls.unlockAllLocks();
      const refused = assert.rejects(writing, ConnectionPausedError);
      fx.core.scheduler.pauseConnection(15);
      release();
      assert.equal(await reading, "read", "the session that was running ends as it would have");
      await refused;
      assert.equal(fx.router.stats.requests.filter((request) => request.path === "/api/net/net-mode" && request.method === "POST").length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("resumes by itself when the time is up, and at once when asked", async () => {
    const fx = pauseFixture();
    try {
      fx.core.scheduler.pauseConnection(15);
      fx.clock.now += 14 * MINUTE;
      assert.equal(await fx.core.monitor.refreshTelemetry(), null, "still paused a minute before the end");
      fx.clock.now += MINUTE;
      assert.ok(await fx.core.monitor.refreshTelemetry(), "the time is up: the next poll reads");
      assert.deepEqual(fx.core.scheduler.getStatus().pause, { active: false, sinceIso: null, untilIso: null, blocked: null });
      assert.deepEqual(fx.events.map((event) => event.active), [true, false], "both ends are announced");

      fx.core.scheduler.pauseConnection(60);
      assert.equal(fx.core.scheduler.resumeConnection().active, false);
      assert.equal(fx.core.scheduler.resumeConnection().active, false, "resuming twice is nothing");
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.deepEqual(fx.events.map((event) => event.active), [true, false, true, false]);
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, true, "the poll after the pause saw the router's model again");
      assert.deepEqual(fx.audits.filter((event) => event.action.endsWith("_connection")).map((event) => [event.action, event.outcome]), [
        ["pause_connection", "applied"],
        ["pause_connection", "applied"],
        ["resume_connection", "applied"],
      ]);
    } finally {
      await fx.cleanup();
    }
  });

  it("forgets the router's model when a pause ends: it may have been replaced meanwhile", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, true);
      fx.core.scheduler.pauseConnection(15);
      fx.core.scheduler.resumeConnection();
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, false, "a write confirms the model in its own session first");
    } finally {
      await fx.cleanup();
    }
  });

  it("takes whole minutes from 1 to the cap, and a new pause replaces the one running", async () => {
    const fx = pauseFixture();
    try {
      for (const minutes of [0, -5, 1.5, PAUSE_MAX_MINUTES + 1, Number.NaN]) {
        assert.throws(() => fx.core.scheduler.pauseConnection(minutes), CpeControlValidationError, String(minutes));
      }
      assert.equal(fx.core.scheduler.getStatus().pause.active, false);
      assert.equal(fx.core.scheduler.pauseConnection(PAUSE_MAX_MINUTES).untilIso, "2026-11-16T14:00:00.000Z");
      fx.clock.now += 10 * MINUTE;
      assert.equal(fx.core.scheduler.pauseConnection(15).untilIso, "2026-11-16T12:25:00.000Z", "counted from now, not added on");
      // The body of the REST route
      assert.deepEqual(readPauseMinutes({ minutes: 30 }), { minutes: 30 });
      for (const body of [{}, { minutes: "30" }, { minutes: 0 }, { minutes: 121 }, { minutes: 2.5 }]) assert.throws(() => readPauseMinutes(body), CpeControlValidationError, JSON.stringify(body));
    } finally {
      await fx.cleanup();
    }
  });

  it("goes on after a restart until its own end, never longer", async () => {
    const first = pauseFixture();
    first.core.scheduler.init();
    first.core.scheduler.pauseConnection(60);
    await first.cleanup(true);
    assert.deepEqual(first.stateStore.getState().connectionPause, { sinceMs: Date.parse("2026-11-16T12:00:00.000Z"), untilMs: Date.parse("2026-11-16T13:00:00.000Z") });

    // Twenty minutes later the daemon is back: forty minutes of the pause are left
    const second = pauseFixture({ dir: first.dir, at: Date.parse("2026-11-16T12:20:00.000Z") });
    second.core.scheduler.init();
    assert.deepEqual(second.core.scheduler.getStatus().pause, { active: true, sinceIso: "2026-11-16T12:00:00.000Z", untilIso: "2026-11-16T13:00:00.000Z", blocked: null });
    assert.equal(await second.core.monitor.refreshTelemetry(), null);
    assert.equal(second.sent(), 0);
    await second.cleanup(true);

    // Back only after its end: over, and no longer on record
    const third = pauseFixture({ dir: first.dir, at: Date.parse("2026-11-16T13:00:01.000Z") });
    third.core.scheduler.init();
    assert.equal(third.core.scheduler.getStatus().pause.active, false);
    assert.equal(third.stateStore.getState().connectionPause, null);
    assert.ok(await third.core.monitor.refreshTelemetry());
    await third.cleanup(true);

    // A record that would run past the cap (the clock was set back, or the file was edited) is not a pause
    const fourth = pauseFixture({ dir: first.dir, at: Date.parse("2026-11-16T12:00:00.000Z") });
    fourth.stateStore.load();
    fourth.stateStore.update({ connectionPause: { sinceMs: fourth.clock.now, untilMs: fourth.clock.now + (PAUSE_MAX_MINUTES + 1) * MINUTE } });
    await fourth.stateStore.flushAsync();
    await fourth.cleanup(true);
    const fifth = pauseFixture({ dir: first.dir, at: Date.parse("2026-11-16T12:00:00.000Z") });
    fifth.core.scheduler.init();
    assert.equal(fifth.core.scheduler.getStatus().pause.active, false, "no pause can have more than the cap left");
    for (const junk of [{ sinceMs: "a", untilMs: 1 }, { untilMs: Number.MAX_SAFE_INTEGER }, 42, "paused"]) {
      fifth.stateStore.update({ connectionPause: junk as never });
      await fifth.stateStore.flushAsync();
      const reloaded = new EncryptedStateStore({ filePath: path.join(first.dir, "state.json"), encryptionKey: "pause_key" });
      assert.equal(reloaded.load().connectionPause, null, JSON.stringify(junk));
    }
    await fifth.cleanup();
  });

  it("does not begin while a change is still watched, and says until about when", async () => {
    const fx = pauseFixture();
    try {
      let block: { reason: "watch"; untilIso: string | null } | null = { reason: "watch", untilIso: "2026-11-16T12:03:00.000Z" };
      fx.core.scheduler.setPauseGuard(() => block);
      assert.deepEqual(fx.core.scheduler.getStatus().pause.blocked, block);
      assert.throws(() => fx.core.scheduler.pauseConnection(15), (err: unknown) => err instanceof CpeControlValidationError && /still watching a change/.test(err.message));
      assert.equal(fx.core.scheduler.getStatus().pause.active, false);
      assert.deepEqual(fx.events, []);
      block = null;
      assert.equal(fx.core.scheduler.pauseConnection(15).active, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not begin while a write is in its session: what it changes may need watching once it is done", async () => {
    const fx = pauseFixture();
    let inside = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      const writing = fx.core.scheduler.control("unlock_rf_locks", async () => {
        inside = true;
        await held;
        return "written";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(inside, "the write's session is running");
      assert.deepEqual(fx.core.scheduler.getStatus().pause.blocked, { reason: "write", untilIso: null });
      assert.throws(() => fx.core.scheduler.pauseConnection(15), (err: unknown) => err instanceof CpeControlValidationError && /in the middle of a change/.test(err.message));
      assert.equal(fx.core.scheduler.getStatus().pause.active, false);
      assert.deepEqual(fx.events, []);
      release();
      assert.equal(await writing, "written", "the write ends as it would have");
      assert.equal(fx.core.scheduler.getStatus().pause.blocked, null, "nothing in the way once it is done");
      assert.equal(fx.core.scheduler.pauseConnection(15).active, true);
    } finally {
      release();
      await fx.cleanup();
    }
  });

  it("is not kept from beginning by a read in its session, nor by a write that only waits", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      let inside = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = fx.core.scheduler.read(async () => {
        inside = true;
        await held;
        return "read";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      const waiting = assert.rejects(fx.core.controls.unlockAllLocks(), ConnectionPausedError);
      assert.equal(fx.core.scheduler.getStatus().pause.blocked, null);
      assert.equal(fx.core.scheduler.pauseConnection(15).active, true);
      release();
      assert.equal(await reading, "read");
      await waiting;
    } finally {
      await fx.cleanup();
    }
  });

  it("tells when the read that was running as the pause began has ended, opening nothing to find out", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.equal(await fx.core.scheduler.whenSessionEnds(100), true, "no session running: at once");
      let inside = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = fx.core.scheduler.read(async () => {
        inside = true;
        await held;
        return "read";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      fx.core.scheduler.pauseConnection(15);
      const before = fx.core.scheduler.getStatus().totalSessionsCompleted;
      assert.equal(await fx.core.scheduler.whenSessionEnds(20), false, "still in its session");
      release();
      assert.equal(await fx.core.scheduler.whenSessionEnds(2000), true);
      assert.equal(await reading, "read");
      // The running read ended and logged out; nothing else was opened, then or after
      assert.equal(fx.core.scheduler.getStatus().totalSessionsCompleted, before + 1);
      const sent = fx.sent();
      assert.equal(await fx.core.scheduler.whenSessionEnds(100), true);
      assert.equal(fx.sent(), sent);
    } finally {
      await fx.cleanup();
    }
  });

  it("sends nothing for a connection test, a brand detection or a look at the certificate that waited while the pause began", async () => {
    const fx = pauseFixture();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      let inside = false;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reading = fx.core.scheduler.read(async () => {
        inside = true;
        await held;
        return "read";
      });
      for (let i = 0; i < 200 && !inside; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      // Asked before the pause, so each is let into the queue; the pause begins before their turn comes
      const testing = fx.core.scheduler.testConnection({ url: "http://192.168.8.1", username: "admin", password: fx.router.password });
      const detecting = fx.core.scheduler.detectFamily("http://192.168.8.1");
      fx.core.scheduler.pauseConnection(15);
      const sent = fx.sent();
      release();
      assert.equal(await reading, "read");
      const tested = await testing;
      assert.deepEqual([tested.ok, tested.ok ? null : tested.reason], [false, "paused"]);
      const detected = await detecting;
      assert.equal(typeof detected === "string" ? detected : detected.reason, "paused");
      // Only the sign-out of the session that was running may have gone out since the pause began
      const since = fx.router.stats.requests.slice(sent).map((request) => request.path);
      assert.deepEqual(since.filter((requestPath) => requestPath !== "/api/user/logout"), [], "nothing but that session's own sign-out");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("pausing the connection: the entries", () => {
  function exchange(method: string, route: string, body: Record<string, unknown> = {}): ApiExchange & { answers: Array<{ status: number; body: Record<string, unknown> }> } {
    const url = new URL(route, "http://api.invalid");
    const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
    return { method, pathname: url.pathname, searchParams: url.searchParams, readJsonBody: async () => body, sendJson: (status, payload) => void answers.push({ status, body: payload as Record<string, unknown> }), answers };
  }

  it("pauses and resumes over REST with a control token's permission, and answers 409 ROUTER_PAUSED to a write on REST and to an agent's tool", async () => {
    const fx = pauseFixture();
    const envPath = path.join(fx.dir, ".env");
    fs.writeFileSync(envPath, ["CPE_URL=http://192.168.8.1", "CPE_PASSWORD=unused", "API_TOKEN=pause_test_token", `STATE_FILE=${path.join(fx.dir, "state.json")}`, "DATA_ENCRYPTION_KEY=pause_key"].join("\n"));
    const api = new FengSuiApi({ core: fx.core, settings: consoleSettingsFor(loadConfig({ envPath, ignoreProcessEnv: true })), sseBus: new SseEventBus() });
    const caller = { redact: false, clientIp: "192.168.8.20", bucketKey: "192.168.8.20", sessionId: null, checkPassword: async () => ({ ok: false as const, statusCode: 401 as const }), actor: { channel: "web" as const } };
    const post = async (route: string, body: Record<string, unknown>) => {
      const sent = exchange("POST", route, body);
      await api.dispatch(sent, caller);
      const answer = sent.answers[0];
      assert.ok(answer, `${route} answered`);
      return answer;
    };
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.deepEqual([permissionForRoute("POST", "/api/session/pause"), permissionForRoute("POST", "/api/session/resume")], ["control", "control"], "not for a read-only token");
      assert.deepEqual([(await post("/api/session/pause", { minutes: 30 })).status, (await post("/api/session/pause", { minutes: 0, confirm: true })).status], [400, 400], "confirm, and minutes in range");
      const sent = fx.sent();
      const paused = await post("/api/session/pause", { minutes: 30, confirm: true });
      assert.deepEqual([paused.status, (paused.body["pause"] as ConnectionPauseStatus).untilIso, (paused.body["status"] as { mode: string }).mode], [200, "2026-11-16T12:30:00.000Z", "paused"]);

      // Reads answer from the cache; a write is refused with the pause and its end
      const read = exchange("GET", "/api/telemetry");
      await api.dispatch(read, caller);
      assert.equal(read.answers[0]?.status, 200);
      const refresh = await post("/api/telemetry/refresh", {});
      assert.equal(refresh.status, 200, "a refresh is skipped, not an error");
      const write = await post("/api/control/unlock", { confirm: true });
      assert.deepEqual([write.status, write.body["errorCode"], (write.body["pause"] as ConnectionPauseStatus).untilIso], [409, "ROUTER_PAUSED", "2026-11-16T12:30:00.000Z"]);
      assert.match(String(write.body["message"]), /paused/);
      assert.match(String(write.body["messageZh"]), /暂停/);
      const server = new FengSuiMcpServer({ allowMutations: true, core: fx.core });
      const call = async (name: string, args: Record<string, unknown>) =>
        ((await server.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }))) as JsonRpcSuccessResponse).result as {
          isError: boolean;
          structuredContent: Record<string, unknown>;
        };
      const tool = await call("reboot_cpe", { confirm: true });
      assert.deepEqual([tool.isError, tool.structuredContent["errorCode"], (tool.structuredContent["pause"] as ConnectionPauseStatus).active], [true, "ROUTER_PAUSED", true]);
      const status = await call("get_cpe_session_status", {});
      assert.deepEqual([status.isError, ((status.structuredContent["status"] as { pause: ConnectionPauseStatus }).pause).active], [false, true], "an agent sees the pause in the status");
      assert.equal(fx.sent(), sent, "nothing reached the router through any of them");

      const resumed = await post("/api/session/resume", { confirm: true });
      assert.deepEqual([resumed.status, (resumed.body["pause"] as ConnectionPauseStatus).active], [200, false]);
      assert.equal((await post("/api/control/unlock", { confirm: true })).status, 200, "writes go through again, the model confirmed in their own session");
    } finally {
      await fx.cleanup();
    }
  });

  it("is kept from beginning by a change self-healing still watches, until that is settled", async () => {
    const fx = pauseFixture();
    const heal = new WanSelfHeal({ scheduler: fx.core.scheduler, monitor: fx.core.monitor, controls: fx.core.controls, lockRollbackAfterMs: 0, reconnectAfterMs: 0, now: () => fx.clock.now, log: () => undefined });
    fx.core.scheduler.setPauseGuard(() => heal.pauseBlock());
    heal.start();
    try {
      assert.equal(heal.pauseBlock(), null);
      // A changed network mode is watched for 3 minutes, with the value to put back
      heal.guardLinkChange({ kind: "network_mode", change: { kind: "network_mode", previous: "auto" }, appliedAtMs: fx.clock.now });
      const block = heal.pauseBlock();
      assert.deepEqual([block?.reason, block?.untilIso], ["watch", "2026-11-16T12:03:00.000Z"]);
      assert.throws(() => fx.core.scheduler.pauseConnection(15), CpeControlValidationError);
      assert.equal(fx.core.scheduler.getStatus().pause.blocked?.untilIso, "2026-11-16T12:03:00.000Z");
    } finally {
      await heal.stop();
      await fx.cleanup();
    }
  });

  it("never has a watch open under a pause: a network mode change still in its session keeps the pause from beginning", async () => {
    // The router takes its time over the network mode (the H168-383's own page waits up to 90 s for it)
    let entered = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fx = pauseFixture({
      cellular: true,
      transport: (fetchImpl) => async (input, init) => {
        if (String(input).endsWith("/api/net/net-mode") && init?.method === "POST") {
          entered = true;
          await held;
        }
        return await fetchImpl(input, init);
      },
    });
    const heal = new WanSelfHeal({ scheduler: fx.core.scheduler, monitor: fx.core.monitor, controls: fx.core.controls, lockRollbackAfterMs: 0, reconnectAfterMs: 0, now: () => fx.clock.now, log: () => undefined });
    fx.core.scheduler.setPauseGuard(() => heal.pauseBlock());
    fx.core.controls.onLinkChange = (notice) => heal.guardLinkChange(notice);
    heal.start();
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      const changing = fx.core.controls.setNetworkMode("lte", { confirm: true });
      for (let i = 0; i < 400 && !entered; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(entered, "the write reached the router and waits for its answer");
      assert.equal(heal.pauseBlock(), null, "not watched yet: the change has not applied");
      // The owner asks for a pause right now: it would leave the change unwatched for as long as it lasts
      assert.throws(() => fx.core.scheduler.pauseConnection(120), CpeControlValidationError);
      release();
      assert.equal((await changing).networkMode, "lte");
      assert.equal(heal.linkWatches.length, 1, "the change is watched from the moment it applied");
      assert.equal(fx.core.scheduler.getStatus().pause.active, false, "and no pause runs over that watch");
      assert.equal(fx.core.scheduler.getStatus().pause.blocked?.reason, "watch");
    } finally {
      release();
      await heal.stop();
      await fx.cleanup();
    }
  });
});

