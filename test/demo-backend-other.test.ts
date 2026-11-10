import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type {
  AgentTestResponse,
  AlertEventRecord,
  ExperimentalWritesResponse,
  GlobalTelemetrySnapshot,
  LockVerification,
  SessionStatusResponse,
  SmsThreadResponse,
  SmsThreadsResponse,
  TimeSeriesEndpointResponse,
  TokensResponse,
} from "../src/api-contract.ts";
import { type DemoSession, captureDemoSeed, openDemoSession } from "../scripts/capture-demo-seed.ts";
import { type DemoDaemon, startDemoDaemon } from "../scripts/demo-router.ts";
import { DemoBackend, type DemoEventSource } from "../web/src/demo/backend.ts";
import { type DemoSeed, readDemoSeed, rebaseSeed } from "../web/src/demo/seed.ts";
import { type Json, assertSameShape, daemonCall, demoCall, listen, settle } from "./helpers/demo-contract.ts";

/**
 * The static demo's other router (`?router=other`) against the daemon on the same router: an LTE-only
 * Huawei model FengSui was not verified on. Both start from the seed the daemon produced and must
 * refuse the same writes, take the same experimental ones once turned on, read them back alike and run
 * the one-click AI agent test the same way. Placeholders only.
 */

const TOKEN = "fengsui-demo-other";
const MODEL = "B535-232";

/** What a write answers that the visitor compares: status, error and message (the 409's details too). */
function verdict(r: { status: number; json: Json }): unknown[] {
  return [r.status, r.json["errorCode"], r.json["message"], r.json["messageZh"], r.json["model"], r.json["feature"], r.json["state"]];
}

/** A write result without what differs per run (its id and time). */
function brief(writes: ExperimentalWritesResponse["writes"]): unknown[] {
  return writes.map((w) => [w.action, w.feature, w.model, w.outcome, w.code, w.readback, w.reason, w.endpoints]);
}

/** A lock check without its time. */
function check(v: LockVerification): unknown[] {
  return [v.status, v.routerLteBands, v.issues];
}

async function threadUids(call: (route: string) => Promise<{ json: Json }>, phone: string): Promise<string[]> {
  const threads = (await call("/api/sms/threads?filter=all&search=&limit=500")).json as unknown as SmsThreadsResponse;
  const key = threads.threads.find((t) => t.latestMessage.phone === phone)?.threadKey ?? phone;
  const thread = (await call(`/api/sms/thread?${new URLSearchParams({ key }).toString()}`)).json as unknown as SmsThreadResponse;
  return thread.thread.messages.map((m) => m.uid);
}

async function startOther(): Promise<{ daemon: DemoDaemon; session: DemoSession; seed: DemoSeed }> {
  const daemon = await startDemoDaemon({ port: 0, token: TOKEN, scenario: "unverified" });
  const session = await openDemoSession(daemon.baseUrl, TOKEN);
  const seed = readDemoSeed(JSON.parse(JSON.stringify(await captureDemoSeed(session))));
  // The demo's two tokens, so the agent test has the same ones to offer on both sides
  await session.post("/api/console/tokens", { name: "Grafana", permissions: [], lifetimeDays: null });
  await session.post("/api/console/tokens", { name: "Claude Code", permissions: ["sms-read"], lifetimeDays: 90 });
  return { daemon, session, seed };
}

describe("Static demo backend vs the real daemon on another Huawei model", () => {
  let daemon: DemoDaemon;
  let session: DemoSession;
  let seed: DemoSeed;
  let backend: DemoBackend;
  const both = (method: string, route: string, body?: unknown) => Promise.all([daemonCall(session, method, route, body), demoCall(backend, method, route, body)]);

  before(async () => {
    ({ daemon, session, seed } = await startOther());
    backend = new DemoBackend({ seed: rebaseSeed(seed, Date.now()), latencyScale: 0 });
  });

  after(async () => {
    backend.stop();
    await daemon.close();
  });

  it("captures an LTE-only router of another model, read-only, with what it does not provide", () => {
    const device = seed.telemetry.schedulerStatus.device;
    assert.deepEqual([device.model, device.verification, device.writes], [MODEL, "unverified-model", "read_only"]);
    assert.deepEqual(
      [device.reads.neighbors.state, device.reads.settings.state, device.reads.accessControl.state, device.reads.telemetry.state, device.reads.sms.state],
      ["unavailable", "unavailable", "unavailable", "available", "available"]
    );
    assert.deepEqual([seed.neighbors.neighbors, seed.settings.settings, seed.accessControl.accessControl], [null, null, null]);
    const rf = seed.telemetry.telemetry?.rf;
    assert.deepEqual([rf?.nrRsrpDbm, rf?.nrSinrDb, rf?.nrScc.length], [null, null, 0], "no 5G value on a router without 5G");
    assert.deepEqual([seed.telemetry.telemetry?.device.marketingName, seed.telemetry.telemetry?.device.uptimeSec], ["", 0]);
    assert.deepEqual(seed.alerts.alerts.map((a) => a.code), ["MODEL_UNVERIFIED"]);
    const raw = JSON.stringify(seed);
    for (const mac of raw.match(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi) ?? []) assert.match(mac, /^02:00:5E:10:00:/i);
  });

  it("answers every read with the daemon's shapes and write gate", async () => {
    for (const route of [
      "/api/health",
      "/api/telemetry",
      "/api/session/status",
      "/api/neighbors",
      "/api/topology",
      "/api/settings",
      "/api/alerts",
      "/api/access-control",
      "/api/sms/status",
      "/api/sms/threads?filter=all&search=&limit=500",
      "/api/console/experimental",
      "/api/device/profile",
      "/api/console/device-report",
    ]) {
      const [real, demo] = await both("GET", route);
      assert.equal(demo.status, real.status, route);
      assertSameShape(route, real.json, demo.json);
    }
    const [real, demo] = await both("GET", "/api/session/status");
    assert.deepEqual((demo.json as unknown as SessionStatusResponse).status.device, (real.json as unknown as SessionStatusResponse).status.device);
    for (const route of ["/api/neighbors/scan", "/api/settings/refresh", "/api/access-control/refresh"]) {
      const [r, d] = await both("POST", route, {});
      assert.equal(d.status, r.status, route);
      assertSameShape(route, r.json, d.json);
    }
    const [r, d] = await both("POST", "/api/settings/refresh", {});
    assert.deepEqual([d.json["settings"], r.json["settings"]], [null, null]);
  });

  it("refuses every write the daemon refuses until it is turned on, with the same checks first", async () => {
    const demoBank = await threadUids((route) => demoCall(backend, "GET", route), "DemoBank");
    assert.deepEqual(demoBank, await threadUids((route) => daemonCall(session, "GET", route), "DemoBank"), "the seed keeps the daemon's uids");
    for (const [route, body] of [
      ["/api/control/band-lock", { lteBands: ["B3"] }],
      ["/api/control/band-lock", {}],
      ["/api/control/band-lock", { nrBands: ["N78"] }],
      ["/api/control/band-lock", { lteBands: "B3" }],
      ["/api/control/cell-lock", { rat: "LTE", band: "B3", arfcn: 1850, pci: 142 }],
      ["/api/control/cell-lock", { rat: "5G", band: "N78", arfcn: 1 }],
      ["/api/control/unlock", {}],
      ["/api/control/reboot", { confirm: false }],
      ["/api/control/reboot", { confirm: true }],
      ["/api/control/reconnect", {}],
      ["/api/control/reconnect", { confirm: true }],
      ["/api/control/mobile-data", {}],
      ["/api/control/mobile-data", { enabled: false }],
      ["/api/control/security", { upnpEnabled: false }],
      ["/api/control/security", { firewall: { teleport: true } }],
      ["/api/control/wifi7", { mloEnable: false }],
      ["/api/control/wifi7", {}],
      ["/api/control/antenna", { mode: "external" }],
      ["/api/control/antenna", { mode: "sideways" }],
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:03", name: "living-room-tv", confirm: true }],
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:03" }],
      ["/api/control/wifi-mac-filter", { mode: "deny", confirm: true }],
      ["/api/control/time-rule", { action: "delete", id: "InternetGatewayDevice.X_FireWall.TimeRule.1.", confirm: true }],
      ["/api/sms/send", { phone: "+353830000001", content: "See you at 8" }],
      ["/api/sms/send", { phone: "+353830000001", content: "  " }],
      ["/api/sms/read", { uids: demoBank }],
      ["/api/sms/read", { threadKey: "+353830000001" }],
      ["/api/sms/delete", { uids: demoBank }],
      ["/api/sms/delete", { uids: ["missing-uid"] }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual(verdict(demo), verdict(real), `${route} ${JSON.stringify(body)}`);
    }
    const audit = (await demoCall(backend, "GET", "/api/audit?limit=1")).json["entries"] as Json[];
    assert.deepEqual([audit[0]?.["action"], audit[0]?.["outcome"]], ["sms_delete", "refused"], "a refused write is audited like the daemon's");
  });

  it("turns experimental writes on and off like the daemon", async () => {
    for (const body of [
      { feature: "cellLock", enabled: true, model: MODEL },
      { feature: "bandLock", enabled: true, model: "H168-383" },
      { feature: "bandLock", enabled: true },
      { feature: "bandLock", enabled: false },
      { feature: "bandLock", enabled: true, model: " b535-232 " },
      { feature: "reconnect", enabled: true, model: MODEL },
      { feature: "reboot", enabled: true, model: MODEL },
      { feature: "mobileData", enabled: true, model: MODEL },
      { feature: "smsWrite", enabled: true, model: MODEL },
      { feature: "teleport", enabled: true },
    ] as const) {
      const [real, demo] = await both("POST", "/api/console/experimental", body);
      assert.deepEqual(verdict(demo), verdict(real), JSON.stringify(body));
      if (real.status !== 200) continue;
      const r = real.json as unknown as ExperimentalWritesResponse;
      const d = demo.json as unknown as ExperimentalWritesResponse;
      assertSameShape("POST /api/console/experimental", r, d);
      assert.deepEqual(d.device.features, r.device.features, JSON.stringify(body));
      assert.deepEqual(d.consents.map((c) => [c.model, c.feature]), r.consents.map((c) => [c.model, c.feature]));
    }
    const [real, demo] = await both("GET", "/api/audit?limit=12");
    const entries = (json: Json): unknown[] => (json["entries"] as Json[]).filter((e) => e["action"] === "settings.experimental").map((e) => [e["outcome"], e["detail"]]);
    assert.deepEqual(entries(demo.json), entries(real.json));
  });

  it("writes the generic way once turned on, LTE bands only, and reads each write back", async () => {
    for (const [route, body] of [
      ["/api/control/band-lock", { lteBands: ["B3", 1, "B3"] }],
      ["/api/control/band-lock", { lteBands: ["B28"] }],
      ["/api/control/band-lock", { nrBands: ["N78"] }],
      ["/api/control/band-lock", { lteBands: ["B3"], nrBands: ["N78"] }],
      ["/api/control/band-lock", {}],
      ["/api/control/band-lock", { lteBands: [] }],
      ["/api/control/band-lock", { lteBands: ["B99"] }],
      ["/api/control/cell-lock", { rat: "LTE", band: "B3", arfcn: 1850, pci: 142 }],
      ["/api/control/security", { upnpEnabled: false }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual(verdict(demo), verdict(real), `${route} ${JSON.stringify(body)}`);
      if (real.status !== 200) continue;
      const { updatedAtIso: _a, ...realLock } = real.json["lockState"] as Json;
      const { updatedAtIso: _b, ...demoLock } = demo.json["lockState"] as Json;
      assert.deepEqual(demoLock, realLock, route);
    }
    // Until the next poll the router still shows its old mask; afterwards it shows the lock
    const verification = async (): Promise<unknown[][]> => {
      const [r, d] = await both("GET", "/api/telemetry");
      return [check(d.json["lockVerification"] as LockVerification), check(r.json["lockVerification"] as LockVerification)];
    };
    const [settling, settlingReal] = await verification();
    assert.deepEqual(settling, settlingReal);
    assert.equal(settling?.[0], "settling");
    daemon.router.advance();
    await both("POST", "/api/telemetry/refresh", {});
    const [locked, lockedReal] = await verification();
    assert.deepEqual(locked, lockedReal);
    assert.deepEqual(locked, ["consistent", [1, 3], []]);

    for (const [route, body] of [
      ["/api/control/band-lock", { lteBands: "all" }],
      ["/api/control/band-lock", { lteBands: ["B20", "B7"] }],
      ["/api/control/unlock", {}],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual([demo.status, demo.json["lockState"] && { ...(demo.json["lockState"] as Json), updatedAtIso: 0 }], [real.status, { ...(real.json["lockState"] as Json), updatedAtIso: 0 }], route);
      const [d, r] = await verification();
      assert.deepEqual(d, r, `${route}: before the poll`);
    }
    daemon.router.advance();
    await both("POST", "/api/telemetry/refresh", {});
    const [unlocked, unlockedReal] = await verification();
    assert.deepEqual(unlocked, unlockedReal);
    assert.equal(unlocked?.[0], "consistent");

    // A redial is read back once the router shows a new connection
    const [rr, dr] = await both("POST", "/api/control/reconnect", { confirm: true });
    assert.deepEqual([dr.status, rr.status], [200, 200]);
    const pending = await both("GET", "/api/console/experimental");
    assert.deepEqual(brief((pending[1].json as unknown as ExperimentalWritesResponse).writes).slice(-1), brief((pending[0].json as unknown as ExperimentalWritesResponse).writes).slice(-1));
    await settle(30);
    daemon.router.advance();
    await both("POST", "/api/telemetry/refresh", {});

    for (const [route, body] of [
      ["/api/control/mobile-data", { enabled: false }],
      ["/api/control/mobile-data", { enabled: true }],
      ["/api/sms/send", { phone: "+353830000001", content: "See you at 8 🍜" }],
      ["/api/sms/send", { phone: "+353830000001", content: "See you at 8" }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual(verdict(demo), verdict(real), `${route} ${JSON.stringify(body)}`);
      if (real.status === 200 && route === "/api/sms/send") assert.deepEqual(demo.json["result"], real.json["result"]);
      if (real.status === 200 && route === "/api/control/mobile-data") assert.deepEqual(demo.json, real.json);
    }
    const demoBank = await threadUids((route) => demoCall(backend, "GET", route), "DemoBank");
    for (const [route, body] of [
      ["/api/sms/read", { uids: demoBank }],
      ["/api/sms/delete", { uids: demoBank }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual([demo.status, demo.json["count"] ?? demo.json["deleted"]], [real.status, real.json["count"] ?? real.json["deleted"]], route);
    }

    const [real, demo] = await both("GET", "/api/console/experimental");
    const r = real.json as unknown as ExperimentalWritesResponse;
    const d = demo.json as unknown as ExperimentalWritesResponse;
    assert.deepEqual(brief(d.writes), brief(r.writes));
    assert.deepEqual(
      d.writes.map((w) => w.action),
      ["lock_band", "lock_band", "lock_band", "unlock_rf_locks", "reconnect_cellular", "set_mobile_data", "set_mobile_data", "sms_send", "sms_mark_read", "sms_delete"]
    );
    assert.ok(d.writes.every((w) => w.readback === "match"), "every write read back as a match");

    const [realAudit, demoAudit] = await both("GET", "/api/audit?limit=30");
    const summaries = (json: Json): unknown[] => (json["entries"] as Json[]).filter((e) => e["outcome"] === "applied" && String(e["action"]).match(/^(lock_band|unlock_rf_locks|set_mobile_data|sms_)/)).map((e) => [e["action"], e["detail"]]);
    assert.deepEqual(summaries(demoAudit.json), summaries(realAudit.json), "the daemon's summaries with the read-back added");

    const [realReport, demoReport] = await both("GET", "/api/console/device-report");
    assertSameShape("/api/console/device-report", realReport.json, demoReport.json);
    const writes = (json: Json): unknown => ((json["report"] as Json)["writes"] as Json[]).map((w) => [w["action"], w["readback"], w["endpoints"]]);
    assert.deepEqual(writes(demoReport.json), writes(realReport.json));
    assert.deepEqual(((demoReport.json["report"] as Json)["access"] as Json)["features"], ((realReport.json["report"] as Json)["access"] as Json)["features"]);
  });
});

describe("Static demo backend vs the real daemon: the one-click AI agent test on another model", () => {
  let daemon: DemoDaemon;
  let session: DemoSession;
  let backend: DemoBackend;
  const both = (method: string, route: string, body?: unknown) => Promise.all([daemonCall(session, method, route, body), demoCall(backend, method, route, body)]);

  before(async () => {
    const started = await startOther();
    ({ daemon, session } = started);
    backend = new DemoBackend({ seed: rebaseSeed(started.seed, Date.now()), latencyScale: 0 });
  });

  after(async () => {
    backend.stop();
    await daemon.close();
  });

  it("starts the test, turns on the same settings and writes, and puts them back", async () => {
    for (const body of [
      { action: "start", model: "H168-383" },
      { action: "start", model: MODEL, sms: "yes" },
      { action: "start", model: MODEL, tokenId: "nope" },
      { action: "ack" },
      { action: "ack", alertId: 7 },
      { action: "go" },
    ] as const) {
      const [real, demo] = await both("POST", "/api/console/agent-test", body);
      assert.deepEqual(verdict(demo), verdict(real), JSON.stringify(body));
    }
    const plan = (json: Json): unknown => {
      const { tokens: _tokens, suggestedTokenId: _suggested, tokenNeeded: _needed, ...rest } = (json["agentTest"] as AgentTestResponse["agentTest"]).plan;
      return rest;
    };
    const [realView, demoView] = await both("GET", "/api/console/experimental");
    assert.deepEqual(plan(demoView.json), plan(realView.json), "the same plan, tokens apart (the demo has its own)");

    const [real, demo] = await both("POST", "/api/console/agent-test", { action: "start", model: MODEL, sms: true });
    assert.deepEqual([demo.status, real.status], [200, 200]);
    assertSameShape("POST /api/console/agent-test", real.json, demo.json);
    const current = (json: Json): unknown => {
      const view = (json as unknown as AgentTestResponse).agentTest.current;
      return view && [view.model, view.sms, view.settings, view.features, view.passed, view.acknowledged];
    };
    assert.deepEqual(current(demo.json), current(real.json));
    assert.deepEqual(current(demo.json), [MODEL, true, ["agentExperimental", "agentWrites", "agentSms", "agentSmsSendPolicy"], ["bandLock", "reconnect", "reboot", "smsWrite"], false, false]);
    const behaviour = (json: Json): unknown => {
      const values = (json as unknown as AgentTestResponse).settings.behaviour;
      return [values.agentExperimental, values.agentWrites, values.agentSms, values.agentSmsSendPolicy];
    };
    assert.deepEqual(behaviour(demo.json), behaviour(real.json));
    assert.deepEqual(
      (demo.json as unknown as AgentTestResponse).consents.map((c) => c.feature),
      (real.json as unknown as AgentTestResponse).consents.map((c) => c.feature)
    );

    const [realEnd, demoEnd] = await both("POST", "/api/console/agent-test", { action: "end" });
    assert.deepEqual(current(demoEnd.json), current(realEnd.json));
    assert.deepEqual([(demoEnd.json as unknown as AgentTestResponse).consents, behaviour(demoEnd.json)], [[], behaviour(realEnd.json)]);
    const [realAudit, demoAudit] = await both("GET", "/api/audit?limit=5");
    const tests = (json: Json): unknown[] => (json["entries"] as Json[]).filter((e) => e["action"] === "agents.test").map((e) => e["detail"]);
    assert.deepEqual(tests(demoAudit.json), tests(realAudit.json));
  });
});

describe("The static demo's other router on its own", () => {
  let seed: DemoSeed;

  before(async () => {
    const started = await startOther();
    seed = started.seed;
    await started.daemon.close();
  });

  function fresh(clock: { now: number }): DemoBackend {
    return new DemoBackend({ seed: rebaseSeed(seed, clock.now), now: () => clock.now, random: () => 0.5, latencyScale: 0 });
  }

  const consent = async (backend: DemoBackend, ...features: string[]): Promise<void> => {
    for (const feature of features) assert.equal((await demoCall(backend, "POST", "/api/console/experimental", { feature, enabled: true, model: MODEL })).status, 200, feature);
  };

  it("keeps 5G and the uptime empty on a router without them, history included", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const day = (await demoCall(backend, "GET", "/api/timeseries?preset=24h&maxPoints=288")).json as unknown as TimeSeriesEndpointResponse;
    assert.ok(day.points.length > 250 && day.points.every((p) => p.nrRsrpAvgDbm === null && p.lteRsrpAvgDbm !== null));
    clock.now += 5_000;
    backend.tick();
    const telemetry = (await demoCall(backend, "GET", "/api/telemetry")).json["telemetry"] as unknown as GlobalTelemetrySnapshot;
    assert.deepEqual([telemetry.rf.nrRsrpDbm, telemetry.rf.nrSinrDb, telemetry.device.uptimeSec], [null, null, 0]);
    backend.stop();
  });

  it("reboots without a reboot alert (no uptime to show it) and reads the reboot back once the router is back", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    await consent(backend, "reboot");
    assert.equal((await demoCall(backend, "POST", "/api/control/reboot", { confirm: true })).status, 200);
    const applied = events.find((e) => e.name === "control:applied")?.data;
    assert.match(String(applied?.["summaryEn"]), /experimental write, the next polls check it/);
    assert.deepEqual(applied?.["check"], { endpoints: ["/api/device/control"], readback: "pending", reason: null });
    await settle();
    clock.now += 60_000;
    backend.tick();
    const alerts = events.filter((e) => e.name === "alert").map((e) => (e.data as unknown as AlertEventRecord).code);
    assert.deepEqual(alerts, ["CPE_UNREACHABLE", "CPE_RECOVERED"]);
    const view = (await demoCall(backend, "GET", "/api/console/experimental")).json as unknown as ExperimentalWritesResponse;
    assert.deepEqual(view.writes.map((w) => [w.action, w.readback]), [["reboot_cpe", "match"]]);
    backend.stop();
  });

  it("drops the connection while mobile data is off", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    await consent(backend, "mobileData");
    await demoCall(backend, "POST", "/api/control/mobile-data", { enabled: false });
    clock.now += 5_000;
    backend.tick();
    let telemetry = (await demoCall(backend, "GET", "/api/telemetry")).json["telemetry"] as unknown as GlobalTelemetrySnapshot;
    assert.deepEqual([telemetry.device.connectionStatus, telemetry.traffic.downloadBps], ["902", 0]);
    await demoCall(backend, "POST", "/api/control/mobile-data", { enabled: true });
    clock.now += 5_000;
    backend.tick();
    telemetry = (await demoCall(backend, "GET", "/api/telemetry")).json["telemetry"] as unknown as GlobalTelemetrySnapshot;
    assert.equal(telemetry.device.connectionStatus, "901");
    backend.stop();
  });

  it("gives the agent's token what the test needs and takes it back, and passes once every covered write read back", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const view = (await demoCall(backend, "GET", "/api/console/experimental")).json as unknown as ExperimentalWritesResponse;
    const agent = (await demoCall(backend, "GET", "/api/console/tokens")).json as unknown as TokensResponse;
    const claude = agent.tokens.find((t) => t.name === "Claude Code");
    assert.ok(claude);
    assert.deepEqual([view.agentTest.plan.suggestedTokenId, view.agentTest.plan.tokenNeeded], [claude.id, true], "the token an agent used last is suggested");

    const started = (await demoCall(backend, "POST", "/api/console/agent-test", { action: "start", model: MODEL, sms: true, tokenId: claude.id })).json as unknown as AgentTestResponse;
    assert.deepEqual(started.agentTest.current?.tokens, [{ id: claude.id, name: "Claude Code", permissions: ["control", "sms-write"] }]);
    let tokens = (await demoCall(backend, "GET", "/api/console/tokens")).json as unknown as TokensResponse;
    assert.deepEqual(tokens.tokens.find((t) => t.id === claude.id)?.permissions, ["sms-read", "control", "sms-write"]);
    // Starting again adds nothing new, but still answers with the test
    assert.equal(((await demoCall(backend, "POST", "/api/console/agent-test", { action: "start", model: MODEL, sms: true })).json as unknown as AgentTestResponse).agentTest.current?.model, MODEL);

    await demoCall(backend, "POST", "/api/control/band-lock", { lteBands: ["B3"] });
    await demoCall(backend, "POST", "/api/control/reconnect", { confirm: true });
    await settle();
    clock.now += 10_000;
    backend.tick();
    await demoCall(backend, "POST", "/api/control/reboot", { confirm: true });
    await settle();
    clock.now += 60_000;
    backend.tick();
    await demoCall(backend, "POST", "/api/sms/send", { phone: "+353830000001", content: "A test message from FengSui" });
    const passed = (await demoCall(backend, "GET", "/api/console/experimental")).json as unknown as ExperimentalWritesResponse;
    assert.deepEqual([passed.agentTest.current?.passed, passed.agentTest.current?.remindAtIso], [true, null], "every covered write matched: no reminder");

    const ended = (await demoCall(backend, "POST", "/api/console/agent-test", { action: "end" })).json as unknown as AgentTestResponse;
    assert.deepEqual([ended.agentTest.current, ended.consents], [null, []]);
    tokens = (await demoCall(backend, "GET", "/api/console/tokens")).json as unknown as TokensResponse;
    assert.deepEqual(tokens.tokens.find((t) => t.id === claude.id)?.permissions, ["sms-read"]);
    assert.equal(((await demoCall(backend, "POST", "/api/console/agent-test", { action: "end" })).json as unknown as AgentTestResponse).agentTest.current, null, "ending twice changes nothing");
    backend.stop();
  });

  it("ends a test with nothing left on, and refuses a token the test cannot give anything to", async () => {
    const backend = fresh({ now: Date.now() });
    const grafana = ((await demoCall(backend, "GET", "/api/console/tokens")).json as unknown as TokensResponse).tokens.find((t) => t.name === "Grafana");
    assert.ok(grafana);
    await demoCall(backend, "POST", "/api/console/tokens/revoke", { id: grafana.id });
    assert.equal((await demoCall(backend, "POST", "/api/console/agent-test", { action: "start", model: MODEL, tokenId: grafana.id })).status, 400);
    await demoCall(backend, "POST", "/api/console/agent-test", { action: "start", model: MODEL });
    for (const feature of ["bandLock", "reconnect", "reboot"]) await demoCall(backend, "POST", "/api/console/experimental", { feature, enabled: false });
    await demoCall(backend, "POST", "/api/console/behaviour", { agentExperimental: null, agentWrites: null });
    const view = (await demoCall(backend, "GET", "/api/console/experimental")).json as unknown as ExperimentalWritesResponse;
    assert.equal(view.agentTest.current, null);
    const audit = (await demoCall(backend, "GET", "/api/audit?limit=1")).json["entries"] as Json[];
    assert.deepEqual([audit[0]?.["action"], audit[0]?.["channel"], audit[0]?.["detail"]], ["agents.test", "system", "ended: nothing it turned on is still on"]);
    backend.stop();
  });

  it("deletes FengSui's own restored copy without the router, so without a consent", async () => {
    const backend = fresh({ now: Date.now() });
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    await consent(backend, "smsWrite");
    const [uid] = await threadUids((route) => demoCall(backend, "GET", route), "DemoBank");
    await demoCall(backend, "POST", "/api/sms/delete", { uids: [uid] });
    await demoCall(backend, "POST", "/api/sms/trash/restore", { uids: [uid] });
    await demoCall(backend, "POST", "/api/console/experimental", { feature: "smsWrite", enabled: false });
    const applied = events.filter((e) => e.name === "control:applied").length;
    const deleted = await demoCall(backend, "POST", "/api/sms/delete", { uids: [uid] });
    assert.deepEqual([deleted.status, deleted.json["deleted"]], [200, 1]);
    assert.equal(events.filter((e) => e.name === "control:applied").length, applied, "no router write for a copy only FengSui keeps");
    backend.stop();
  });
});
