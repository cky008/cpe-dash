import assert from "node:assert/strict";
import { hilinkSessionOf } from "../src/drivers/huawei.ts";
import path from "node:path";
import { describe, it } from "node:test";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { type AvoidanceBroadcastPayload, BrowserSessionYieldedError, SchedulerStoppedError } from "../src/scheduler.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMcpTools } from "../src/sms/mcp-tools.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { mockConnection } from "./helpers/connection.ts";
import { type StrictCpe, type StrictCpeOptions, createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

interface ContractFixture {
  cpe: StrictCpe;
  core: FengSuiCore;
  sms: SmsService;
  mcp: FengSuiMcpServer;
  dir: string;
  avoidance: AvoidanceBroadcastPayload[];
  tool: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; structuredContent: Record<string, unknown> }>;
  close: () => Promise<void>;
}

function createContractFixture(
  opts: StrictCpeOptions & {
    clientPassword?: string;
    dir?: string;
    layer2InitialBackoffMs?: number;
    pollIntervalMs?: number;
    sessionMaxHoldMs?: number;
    requestTimeoutMs?: number;
    stopGraceMs?: number;
  } = {}
): ContractFixture {
  const cpe = createStrictCpe(opts);
  const dir = opts.dir ?? tempDir("fengsui-contract-");
  const core = createFengSuiCore({
    connection: mockConnection({ password: opts.clientPassword ?? cpe.password, fetchImpl: cpe.fetchImpl }, { requestTimeoutMs: opts.requestTimeoutMs ?? 3000, sessionMaxHoldMs: opts.sessionMaxHoldMs }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "contract_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: opts.pollIntervalMs ?? 60_000,
    neighborScanIntervalMs: 120_000,
    smsCountersEnabled: true,
    layer2InitialBackoffMs: opts.layer2InitialBackoffMs,
    stopGraceMs: opts.stopGraceMs,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("contract_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({
    scheduler: core.scheduler,
    monitor: core.monitor,
    mirror,
    contacts,
    defaultCountryCode: "+353",
    sleep: async () => undefined,
  });
  const mcp = new FengSuiMcpServer({
      allowMutations: true,
    core,
    toolProviders: [new SmsMcpTools({ sms, access: "full", sendPolicy: "any", sendLimitPerHour: 10 })],
  });
  const avoidance: AvoidanceBroadcastPayload[] = [];
  core.scheduler.on("session:avoidance", (ev: AvoidanceBroadcastPayload) => avoidance.push(ev));
  let rpcId = 0;
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.handleRawJsonMessage(
      JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
    )) as JsonRpcSuccessResponse;
    return res.result as { isError: boolean; structuredContent: Record<string, unknown> };
  };
  return {
    cpe,
    core,
    sms,
    mcp,
    dir,
    avoidance,
    tool,
    close: async () => {
      await sms.stop();
      await stopFengSuiCore(core);
      if (!opts.dir) removeTempDir(dir);
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function assertSingleSlotInvariants(cpe: StrictCpe): void {
  assert.equal(cpe.stats.overlapLoginAttempts, 0, "never two FengSui admin sessions at once");
  assert.equal(cpe.stats.tokenRejections, 0, "every POST used a fresh, session-bound CSRF token");
  assert.equal(cpe.stats.staleSessionRequests, 0, "no request outlived its session");
  assert.equal(cpe.stats.logins, cpe.stats.logouts, "every login was paired with a logout");
  assert.equal(cpe.isSlotTaken(), false, "the admin slot is free once the work settles");
}

describe("session contract on a strict single-admin router model", () => {
  it("serializes telemetry, sweeps, SMS sync/send, controls and MCP calls fired concurrently onto one slot", async () => {
    const fx = createContractFixture({ latencyMs: () => Math.floor(Math.random() * 3) });
    try {
      fx.cpe.pushIncoming({ phone: "+353830000001", content: "Code 482913", date: "2026-10-30 09:00:00" });
      const work = await Promise.all([
        ...Array.from({ length: 6 }, () => fx.core.monitor.refreshTelemetry()),
        fx.core.monitor.refreshNeighbors(),
        fx.core.monitor.refreshNeighbors({ ignoreCooldown: true }),
        fx.core.monitor.refreshTopology(),
        fx.core.monitor.refreshSettings(),
        fx.sms.sync("full"),
        fx.sms.sync("incremental"),
        fx.core.controls.setSecuritySwitches({ upnpEnabled: false, firewall: { wanPortPingSwitch: true } }),
        fx.core.controls.setWifi7Settings({ mloEnable: false }),
        fx.core.controls.lockBands({ lteBands: ["B1", "B3"] }),
        fx.tool("get_cpe_telemetry", { refresh: true }),
        fx.tool("list_terminal_topology", { refresh: true }),
        fx.sms.send({ phones: ["+353830000002"], content: "Contract check (1/2)", source: "web" }),
        fx.tool("send_sms", { phone: "+353830000003", content: "Contract check (2/2)", confirm: true }),
      ]);
      const [telemetry] = work;
      assert.ok(telemetry && "rf" in telemetry, "telemetry refreshed");
      for (const result of work.filter((w): w is { isError: boolean; structuredContent: Record<string, unknown> } => typeof w === "object" && w !== null && "isError" in w)) {
        assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
      }
      assertSingleSlotInvariants(fx.cpe);
      assert.ok(fx.cpe.stats.logins >= 8, `expected several serialized sessions, got ${fx.cpe.stats.logins}`);
      assert.equal(fx.core.scheduler.getStatus().totalSessionsCompleted, fx.cpe.stats.logins);
      assert.equal(fx.cpe.outbox.length, 2, "both sends reached the router exactly once");
      assert.deepEqual(fx.cpe.router.wifi, { MloEnable: false, DbhoEnable: true }, "untouched Wi-Fi switch preserved");
      assert.equal(fx.cpe.router.firewall.wanPing, 1);
      assert.equal(fx.cpe.router.firewall.macFilter, 0, "untouched firewall switches preserved");
    } finally {
      await fx.close();
    }
  });

  it("spends exactly one password attempt on 108006, however much polling, REST, MCP and SMS pressure follows", async () => {
    const fx = createContractFixture({ clientPassword: "wrong_password", pollIntervalMs: 1000 });
    try {
      await assert.rejects(() => fx.core.monitor.refreshTelemetry(), /108006/);
      const afterTrip = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => fx.core.monitor.refreshTelemetry()),
        fx.core.monitor.refreshNeighbors(),
        fx.sms.sync("full"),
        fx.core.controls.lockBands({ lteBands: ["B3"] }),
        fx.core.controls.rebootRouter({ confirm: true }),
        fx.tool("get_cpe_telemetry", { refresh: true }),
      ]);
      const mcpUnlock = await fx.tool("unlock_rf_locks", { confirm: true });
      assert.equal(fx.cpe.stats.authCalls, 1, "no second authentication_login after the breaker tripped");
      assert.equal(fx.cpe.failedLogins(), 1);
      assert.equal(fx.cpe.isLocked(), false, "the router never reaches the 3-strike 108007 lockout");
      const status = fx.core.scheduler.getStatus();
      assert.equal(status.mode, "circuit_tripped");
      assert.equal(status.circuitBreaker.code, "108006");
      assert.equal(status.circuitBreaker.remainCount, 2);
      const reads = afterTrip.slice(0, 7);
      assert.ok(reads.every((r) => r.status === "fulfilled" && r.value === null), "reads short-circuit to cached data");
      assert.equal(afterTrip[7]?.status, "rejected");
      assert.equal(afterTrip[8]?.status, "rejected");
      assert.equal(mcpUnlock.isError, true);
      assert.equal(mcpUnlock.structuredContent["errorCode"], "CIRCUIT_BREAKER_OPEN");
      // The way out an agent relays: the console's router settings, where the password lives
      assert.match(String(mcpUnlock.structuredContent["message"]), /Settings → Router/);
      assert.doesNotMatch(String(mcpUnlock.structuredContent["message"]), /\.env|CPE_PASSWORD/);
      assert.equal((mcpUnlock.structuredContent["circuitBreaker"] as { code?: string }).code, "108006");
      const alerts = fx.core.scheduler.getRecentAlerts().filter((a) => a.code === "CIRCUIT_108006");
      assert.equal(alerts.length, 1, "the breaker alert is raised once");
      await fx.core.scheduler.stop();

      // A restart with the same wrong password stays latched and never touches the login endpoints
      const restarted = createContractFixture({ clientPassword: "wrong_password", dir: fx.dir });
      try {
        await restarted.core.monitor.refreshTelemetry();
        assert.equal(restarted.core.scheduler.getStatus().mode, "circuit_tripped");
        assert.equal(restarted.cpe.stats.challengeCalls + restarted.cpe.stats.authCalls, 0);
      } finally {
        await restarted.close();
      }
    } finally {
      await fx.close();
      removeTempDir(fx.dir);
    }
  });

  it("yields to a human on the same LAN IP without logging in, refuses writes with 409 and resumes once they leave", async () => {
    const fx = createContractFixture();
    try {
      fx.cpe.human.loginSameIp();
      assert.equal(await fx.core.monitor.refreshTelemetry(), null);
      assert.equal(await fx.core.monitor.refreshTelemetry(), null);
      await assert.rejects(() => fx.core.controls.unlockAllLocks(), BrowserSessionYieldedError);
      const mcpWrite = await fx.tool("lock_band", { lteBands: ["B1"], confirm: true });
      assert.equal(mcpWrite.isError, true);
      assert.equal(mcpWrite.structuredContent["errorCode"], "BROWSER_SESSION_YIELDED");
      assert.equal(fx.cpe.stats.challengeCalls, 0, "Layer 1 never sends a SCRAM handshake");
      assert.equal(fx.avoidance.length, 1, "one avoidance transition, not one event per poll");
      assert.equal(fx.avoidance[0]?.active, true);
      assert.equal(fx.avoidance[0]?.layer, 1);

      await fx.sms.pollWhileYielding();
      assert.equal(fx.cpe.count("/api/monitoring/check-notifications"), 1, "SMS badge uses the login-free probe");

      fx.cpe.human.logout();
      const resumed = await fx.core.monitor.refreshTelemetry();
      assert.ok(resumed);
      assert.equal(fx.avoidance.length, 2);
      assert.equal(fx.avoidance[1]?.active, false);
      assert.equal(fx.avoidance[1]?.stateCode, "-1");
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("bounds how long one session can hold the admin slot, then logs out and frees the queue", async () => {
    let hangSignal = false;
    const fx = createContractFixture({
      sessionMaxHoldMs: 80,
      requestTimeoutMs: 10_000,
      fault: (p) => (hangSignal && p === "/api/device/signal" ? "timeout" : undefined),
    });
    try {
      const startedAt = performance.now();
      await assert.rejects(
        () => fx.core.scheduler.read(() => new Promise<never>(() => undefined)),
        (err: unknown) => err instanceof Error && err.name === "CpeSessionDeadlineError"
      );
      assert.ok(performance.now() - startedAt < 2000, "a hung domain function cannot hold the slot");
      assert.equal(fx.cpe.isSlotTaken(), false, "the deadline still ran the finally logout");

      hangSignal = true;
      await assert.rejects(() => fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof Error && err.name === "CpeSessionDeadlineError");
      assert.equal(fx.cpe.isSlotTaken(), false, "an in-flight request is aborted and logout uses a fresh signal");

      hangSignal = false;
      assert.ok(await fx.core.monitor.refreshTelemetry(), "the queue keeps serving after a deadline");
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("lets one session hold the slot longer when its write needs it, never shorter than the client's bound", async () => {
    const fx = createContractFixture();
    try {
      // The bound is the session client's: asked of one directly, on the fixture's router
      const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: fx.cpe.password, fetchImpl: fx.cpe.fetchImpl, requestTimeoutMs: 10_000, sessionMaxHoldMs: 80 });
      const slow = (ms: number) => () => new Promise<string>((resolve) => setTimeout(() => resolve("done"), ms));
      const longer = await client.withSessionDetailed(slow(200), { maxHoldMs: 2000 });
      assert.equal(longer.status === "ok" ? longer.value : null, "done", "an operator scan may take longer than the client's bound");
      await assert.rejects(client.withSessionDetailed(slow(200), { maxHoldMs: 10 }), (err: unknown) => err instanceof Error && err.name === "CpeSessionDeadlineError");
      assert.equal(fx.cpe.isSlotTaken(), false);
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("reports an SMS the router accepted as submitted, never as failed, when the hold deadline cuts its status poll", async () => {
    // send-status never answers, so the session runs into its hold budget after send-sms was accepted
    const fx = createContractFixture({
      sessionMaxHoldMs: 300,
      requestTimeoutMs: 10_000,
      fault: (p) => (p === "/api/sms/send-status" ? "timeout" : undefined),
    });
    try {
      const sent: unknown[] = [];
      fx.sms.on("sms:sent", (ev: unknown) => sent.push(ev));
      const outcome = await fx.sms.send({ phones: ["+353830000002"], content: "Deadline check (1/2)", source: "web" });
      assert.equal(outcome.result.ok, true, "an accepted send must never read as failed: callers would resend it");
      assert.equal(outcome.result.submitted, true);
      assert.equal(outcome.result.timedOutWaitingStatus, true);
      assert.deepEqual(outcome.result.sentPhones, ["+353830000002"]);
      assert.equal(outcome.messages.length, 1);
      assert.equal(outcome.messages[0]?.pending, true, "kept as a provisional record until the next sync reads it back");
      assert.equal(sent.length, 1);

      const viaMcp = await fx.tool("send_sms", { phone: "+353830000003", content: "Deadline check (2/2)", confirm: true });
      assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.structuredContent));
      assert.equal((viaMcp.structuredContent["result"] as { timedOutWaitingStatus?: boolean }).timedOutWaitingStatus, true);

      assert.equal(fx.cpe.outbox.length, 2, "each message reached the router exactly once");
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("cancels the in-flight session when the scheduler stops, so the admin slot is free before the process exits", async () => {
    const fx = createContractFixture({
      requestTimeoutMs: 60_000,
      sessionMaxHoldMs: 90_000,
      stopGraceMs: 50,
      fault: (p) => (p === "/api/device/nbrcellinfo" ? "timeout" : undefined),
    });
    try {
      const scan = fx.core.monitor.refreshNeighbors().then(
        () => null,
        (err: unknown) => err
      );
      const queued = fx.core.monitor.refreshTelemetry().then(
        () => null,
        (err: unknown) => err
      );
      await waitFor(() => fx.cpe.count("/api/device/nbrcellinfo") === 1, "the scan request hanging inside its session");
      assert.equal(fx.cpe.isSlotTaken(), true);

      const startedAt = performance.now();
      await fx.core.scheduler.stop();
      assert.ok(performance.now() - startedAt < 1500, "stop() does not wait out a hung session");
      assert.equal(fx.cpe.isSlotTaken(), false, "the cancelled session still logged out");
      assert.ok((await scan) instanceof SchedulerStoppedError);
      assert.ok((await queued) instanceof SchedulerStoppedError, "queued work is refused, never run");
      assert.equal(fx.cpe.count("/api/device/signal"), 0);
      assert.equal(fx.core.scheduler.getStatus().mode, "idle", "a cancelled session says nothing about the router");
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("cancels a console connection test's session too when the scheduler stops, so the slot is free before exit", async () => {
    const fx = createContractFixture({
      requestTimeoutMs: 60_000,
      sessionMaxHoldMs: 90_000,
      stopGraceMs: 50,
      fault: (p) => (p === "/api/device/information" ? "timeout" : undefined),
    });
    try {
      // The test logs in on a throwaway client of its own, inside the shared queue
      const test = fx.core.scheduler.testConnectionDetailed({ url: "http://192.168.8.1", username: "admin", password: fx.cpe.password }).then(
        (outcome) => outcome,
        (err: unknown) => err
      );
      await waitFor(() => fx.cpe.count("/api/device/information") === 1, "the test's request hanging inside its session");
      assert.equal(fx.cpe.isSlotTaken(), true);

      const startedAt = performance.now();
      await fx.core.scheduler.stop();
      assert.ok(performance.now() - startedAt < 1500, "stop() does not wait out a hung test");
      assert.equal(fx.cpe.isSlotTaken(), false, "the test's session logged out before stop() returned");
      await test;
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("reports an SMS interrupted by shutdown as submitted once the router accepted it", async () => {
    const fx = createContractFixture({
      requestTimeoutMs: 60_000,
      stopGraceMs: 50,
      fault: (p) => (p === "/api/sms/send-status" ? "timeout" : undefined),
    });
    try {
      const sending = fx.sms.send({ phones: ["+353830000002"], content: "Shutdown check", source: "telegram" });
      await waitFor(() => fx.cpe.count("/api/sms/send-status") === 1, "the status poll hanging after send-sms");
      const stoppingAt = performance.now();
      await fx.core.scheduler.stop();
      assert.equal(fx.cpe.isSlotTaken(), false, "logged out before stop() resolved");
      const outcome = await sending;
      assert.ok(performance.now() - stoppingAt < 1500, "the send settles with the cancelled session, not at its request timeout");
      assert.equal(outcome.result.ok, true);
      assert.equal(outcome.result.timedOutWaitingStatus, true);
      assert.equal(fx.cpe.outbox.length, 1);
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("keeps a timed-out session's orphaned work off the router", async () => {
    const fx = createContractFixture({ sessionMaxHoldMs: 60 });
    try {
      const lateErrors: unknown[] = [];
      let orphanDone!: () => void;
      const orphan = new Promise<void>((resolve) => {
        orphanDone = resolve;
      });
      await assert.rejects(
        () =>
          fx.core.scheduler.read(async (session) => {
            // Ignores its deadline: wakes up after the hold budget and keeps using the session
            await new Promise((resolve) => setTimeout(resolve, 150));
            for (const late of [() => hilinkSessionOf(session).get("/api/device/signal"), () => hilinkSessionOf(session).postXml("/api/sms/set-read", { Index: [40001] })]) {
              await late().catch((err: unknown) => lateErrors.push(err));
            }
            orphanDone();
          }),
        (err: unknown) => err instanceof Error && err.name === "CpeSessionDeadlineError"
      );
      const requestsAtLogout = fx.cpe.stats.requests.length;
      await orphan;
      assert.equal(fx.cpe.stats.requests.length, requestsAtLogout, "nothing reaches the router after the session ended");
      assert.equal(lateErrors.length, 2);
      assert.ok(lateErrors.every((err) => err instanceof Error && err.name === "CpeSessionDeadlineError"));
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });

  it("backs off after a cross-IP 108003 and stays silent during the Layer-2 quiet window", async () => {
    const fx = createContractFixture({ layer2InitialBackoffMs: 60 });
    try {
      fx.cpe.human.loginCrossIp();
      assert.equal(await fx.core.monitor.refreshTelemetry(), null);
      assert.equal(fx.cpe.stats.challengeCalls, 1);
      const status = fx.core.scheduler.getStatus();
      assert.equal(status.mode, "yielding_browser");
      assert.equal(status.avoidance.layer, 2);
      assert.equal(status.avoidance.stateCode, "108003");

      const requestsBefore = fx.cpe.stats.requests.length;
      for (let i = 0; i < 5; i++) assert.equal(await fx.core.monitor.refreshTelemetry(), null);
      assert.equal(fx.cpe.stats.requests.length, requestsBefore, "zero router traffic inside the quiet window");

      await new Promise((resolve) => setTimeout(resolve, 80));
      fx.cpe.human.logout();
      assert.ok(await fx.core.monitor.refreshTelemetry(), "resumes after the cooldown once the human left");
      assert.equal(fx.avoidance.filter((a) => a.active).length, 1);
      assertSingleSlotInvariants(fx.cpe);
    } finally {
      await fx.close();
    }
  });
});
