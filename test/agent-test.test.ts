import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AGENT_TEST_REMIND_AFTER_MS,
  AGENT_TEST_REMIND_EVERY_MS,
  type AgentTestRecord,
  type AgentTestTokenInfo,
  agentTestPassed,
  agentTestPlan,
  agentTestReminderDueMs,
  agentTestStillOn,
  agentTestView,
  isAgentTestRecord,
} from "../src/agent-test.ts";
import { AgentTestService, AgentTestUnavailableError } from "../src/agent-test-service.ts";
import { AuditLog, runAsActor } from "../src/audit-log.ts";
import { type BehaviourValues, DEFAULT_BEHAVIOUR, resolveBehaviour } from "../src/behaviour-settings.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { WRITE_FEATURES, type WriteFeature, type WriteFeatureState } from "../src/device-access.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { changeExperimentalConsent } from "../src/experimental-consent.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * The AI agent test at one click (Settings → Device): what starting it turns on, how ending it puts
 * back exactly that, and when the owner is reminded that it is still on. Mocks and placeholders only.
 */

const MODEL = "B535-232";
const HOUR = 3_600_000;
const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};

function features(states: Partial<Record<WriteFeature, WriteFeatureState>>): Record<WriteFeature, WriteFeatureState> {
  return Object.fromEntries(WRITE_FEATURES.map((feature) => [feature, states[feature] ?? "not_implemented"])) as Record<WriteFeature, WriteFeatureState>;
}

function token(id: string, extra: Partial<AgentTestTokenInfo> = {}): AgentTestTokenInfo {
  return { id, name: `token ${id}`, permissions: ["sms-read"], createdAtIso: "2026-11-01T00:00:00.000Z", expiresAtIso: null, agentUsedAtMs: null, ...extra };
}

function record(extra: Partial<AgentTestRecord> = {}): AgentTestRecord {
  return {
    model: MODEL,
    startedAtIso: "2026-11-10T08:00:00.000Z",
    switches: [
      { key: "agentExperimental", before: null },
      { key: "agentWrites", before: false },
    ],
    features: [{ feature: "bandLock", grantedAtIso: "2026-11-10T08:00:00.000Z" }],
    tokens: [{ id: "t1", name: "agent" }],
    lastActivityAtIso: "2026-11-10T08:00:00.000Z",
    remindedAtIso: null,
    reminderAlertId: null,
    acknowledgedAtIso: null,
    ...extra,
  };
}

describe("the agent test's rules", () => {
  const NOW = Date.parse("2026-11-10T09:00:00.000Z");
  const OFF = { agentExperimental: false, agentWrites: false };

  it("offers the test only on a model nobody verified that has a covered write", () => {
    const writable = features({ bandLock: "available", reboot: "available", reconnect: "consented", mobileData: "available", smsWrite: "available" });
    for (const writes of ["allowed", "unknown"] as const) {
      assert.deepEqual(agentTestPlan({ device: { writes, features: writable }, switches: OFF, tokens: [], nowMs: NOW }).available, false, writes);
    }
    const none = features({ bandLock: "unsupported", reboot: "unsupported", reconnect: "not_implemented", mobileData: "available", smsWrite: "available" });
    assert.equal(agentTestPlan({ device: { writes: "read_only", features: none }, switches: OFF, tokens: [], nowMs: NOW }).available, false, "mobile data and SMS are not the test's");

    const plan = agentTestPlan({ device: { writes: "read_only", features: writable }, switches: { agentExperimental: true, agentWrites: false }, tokens: [], nowMs: NOW });
    assert.deepEqual([plan.available, plan.switches, plan.features], [true, ["agentWrites"], ["bandLock", "reboot"]], "what is off, the covered writes still off");
    assert.deepEqual([plan.tokens, plan.suggestedTokenId, plan.tokenNeeded], [[], null, false], "no token to offer");
  });

  it("suggests the token an agent called with last, else the only one there is to choose", () => {
    const device = { writes: "read_only" as const, features: features({ bandLock: "available" }) };
    const plan = (tokens: AgentTestTokenInfo[]) => agentTestPlan({ device, switches: OFF, tokens, nowMs: NOW });

    const seen = plan([token("old", { agentUsedAtMs: NOW - 9 * HOUR }), token("ha"), token("agent", { agentUsedAtMs: NOW - 60_000 })]);
    assert.deepEqual(seen.tokens.map((t) => t.id), ["agent", "old", "ha"], "the agent's first");
    assert.deepEqual([seen.suggestedTokenId, seen.tokenNeeded], ["agent", true]);
    assert.equal(seen.tokens[0]?.agentUsedAtIso, new Date(NOW - 60_000).toISOString());

    const allowed = plan([token("ha"), token("agent", { permissions: ["control"], agentUsedAtMs: NOW })]);
    assert.deepEqual([allowed.tokens.map((t) => t.id), allowed.suggestedTokenId, allowed.tokenNeeded], [["ha"], null, false], "the agent's token may change the router already");

    assert.deepEqual([plan([token("only")]).suggestedTokenId, plan([token("only")]).tokenNeeded], ["only", true], "no agent seen, one token");
    const two = plan([token("a", { createdAtIso: "2026-11-02T00:00:00.000Z" }), token("b", { createdAtIso: "2026-11-03T00:00:00.000Z" })]);
    assert.deepEqual([two.tokens.map((t) => t.id), two.suggestedTokenId, two.tokenNeeded], [["b", "a"], null, true], "no agent seen, two tokens: newest first, no guess");

    const expired = plan([token("gone", { expiresAtIso: new Date(NOW - 1).toISOString(), agentUsedAtMs: NOW }), token("live")]);
    assert.deepEqual([expired.tokens.map((t) => t.id), expired.suggestedTokenId], [["live"], "live"], "an expired token is neither offered nor the agent's");
    assert.equal(plan([token("full", { permissions: ["control"] })]).tokenNeeded, false, "every token may change the router");
  });

  it("counts as still on only what is as the test left it", () => {
    const test = record();
    const now = { overrides: { agentExperimental: true, agentWrites: true }, consents: [{ feature: "bandLock", grantedAtIso: test.features[0]?.grantedAtIso ?? "" }], tokens: [{ id: "t1", permissions: ["control" as const] }] };
    assert.deepEqual(agentTestStillOn(test, now), { switches: ["agentExperimental", "agentWrites"], features: ["bandLock"], tokens: [{ id: "t1", name: "agent" }] });
    const changed = agentTestStillOn(test, {
      overrides: { agentExperimental: null, agentWrites: false },
      consents: [{ feature: "bandLock", grantedAtIso: "2026-11-10T08:30:00.000Z" }],
      tokens: [{ id: "t1", permissions: ["sms-read"] }],
    });
    assert.deepEqual(changed, { switches: [], features: [], tokens: [] }, "set back by the owner, turned on again later, or no longer allowed");
  });

  it("passes when every covered write that is on was tried since the start and always read back as a match", () => {
    const test = record();
    const write = (feature: "bandLock" | "reconnect", atIso: string, outcome: "applied" | "failed", readback: "match" | "mismatch" | "pending") => ({ feature, atIso, outcome, readback });
    const after = "2026-11-10T08:10:00.000Z";
    assert.equal(agentTestPassed(test, [], [write("bandLock", after, "applied", "match")]), false, "nothing on to pass");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", "2026-11-10T07:00:00.000Z", "applied", "match")]), false, "tried before the test only");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "applied", "match")]), true);
    assert.equal(agentTestPassed(test, ["bandLock", "reconnect"], [write("bandLock", after, "applied", "match")]), false, "the redial not tried");
    assert.equal(agentTestPassed(test, ["bandLock", "reconnect"], [write("bandLock", after, "applied", "match"), write("reconnect", after, "applied", "pending")]), false, "still being checked");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "applied", "match"), write("bandLock", after, "applied", "mismatch")]), false, "one try read back differently");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "failed", "match")]), false, "refused by the router");
  });

  it("reminds 3 hours after the last activity, then daily, and never after a read reminder, a pass or with nothing on", () => {
    const test = record({ lastActivityAtIso: "2026-11-10T09:30:00.000Z" });
    assert.equal(agentTestReminderDueMs(test, true, false), Date.parse(test.lastActivityAtIso) + AGENT_TEST_REMIND_AFTER_MS);
    const reminded = record({ remindedAtIso: "2026-11-10T12:30:00.000Z" });
    assert.equal(agentTestReminderDueMs(reminded, true, false), Date.parse("2026-11-10T12:30:00.000Z") + AGENT_TEST_REMIND_EVERY_MS);
    assert.equal(agentTestReminderDueMs(record({ remindedAtIso: "2026-11-10T12:30:00.000Z", acknowledgedAtIso: "2026-11-10T13:00:00.000Z" }), true, false), null);
    assert.equal(agentTestReminderDueMs(test, false, false), null);
    assert.equal(agentTestReminderDueMs(test, true, true), null);
    const view = agentTestView(test, { switches: ["agentWrites"], features: [], tokens: [] }, false);
    assert.deepEqual([view.switches, view.passed, view.acknowledged, view.remindAtIso], [["agentWrites"], false, false, "2026-11-10T12:30:00.000Z"]);
  });

  it("keeps only a stored test it can read in full", () => {
    assert.equal(isAgentTestRecord(record()), true);
    assert.equal(isAgentTestRecord(record({ remindedAtIso: "2026-11-10T10:00:00.000Z", reminderAlertId: "a1", acknowledgedAtIso: "2026-11-10T11:00:00.000Z" })), true);
    const broken: Array<[string, unknown]> = [
      ["not an object", "test"],
      ["no model", { ...record(), model: "" }],
      ["a bad time", { ...record(), startedAtIso: "yesterday" }],
      ["an unknown switch", { ...record(), switches: [{ key: "agentSms", before: null }] }],
      ["a bad before", { ...record(), switches: [{ key: "agentWrites", before: "off" }] }],
      ["an uncovered write", { ...record(), features: [{ feature: "smsWrite", grantedAtIso: "2026-11-10T08:00:00.000Z" }] }],
      ["a token without a name", { ...record(), tokens: [{ id: "t1" }] }],
      ["a bad alert id", { ...record(), reminderAlertId: 7 }],
      ["a bad read time", { ...record(), acknowledgedAtIso: "soon" }],
    ];
    for (const [label, value] of broken) assert.equal(isAgentTestRecord(value), false, label);
  });
});

/** A B535-232 (a model nobody verified), the console's store, the audit log, MCP and the test service on one clock. */
async function fixture(env: BehaviourValues = DEFAULT_BEHAVIOUR) {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: ENDPOINTS, writes: {} });
  const dir = tempDir("fengsui-agent-test-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "agent_test_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("agent_test_key");
  const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher });
  settings.load();
  const audit = new AuditLog({ filePath: path.join(dir, "audit.json"), cipher });
  let clock = Date.now();
  const inForce = (): BehaviourValues => resolveBehaviour(env, settings.behaviourOverrides);
  const changes: BehaviourValues[] = [];
  const tokenChanges: string[] = [];
  const service = new AgentTestService({
    settings,
    scheduler: core.scheduler,
    audit,
    behaviourFromEnv: () => env,
    onBehaviourChanged: (values) => changes.push(values),
    onTokenChanged: (id) => tokenChanges.push(id),
    now: () => clock,
  });
  const server = new FengSuiMcpServer({
    core,
    allowMutations: () => inForce().agentWrites,
    experimental: { allowed: () => inForce().agentExperimental, settings, change: (request) => changeExperimentalConsent(settings, core.scheduler.device, request) },
    onToolCall: (name) => service.noteToolCall(name),
  });
  const alerts: AlertEventRecord[] = [];
  core.scheduler.on("alert", (alert: AlertEventRecord) => alerts.push(alert));
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>, permissions: string[]): Promise<Record<string, unknown>> =>
    ((await server.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {}, { permissions: permissions as never })).body as JsonRpcSuccessResponse).result as Record<string, unknown>;
  const tools = async (permissions: string[]): Promise<string[]> => ((await rpc("tools/list", {}, permissions))["tools"] as Array<{ name: string }>).map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown>, permissions: string[]) =>
    (await rpc("tools/call", { name, arguments: args }, permissions))["structuredContent"] as Record<string, unknown>;
  assert.ok(await core.monitor.identifyDevice(), "the router is identified");
  return {
    cpe,
    core,
    settings,
    audit,
    service,
    changes,
    tokenChanges,
    alerts,
    tools,
    call,
    inForce,
    dir,
    cipher,
    tick: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    cleanup: async () => {
      service.stop();
      await stopFengSuiCore(core);
      await settings.flush();
      removeTempDir(dir);
    },
  };
}

let restoreNetwork: () => void;
before(() => {
  restoreNetwork = blockNetwork();
});
after(() => restoreNetwork());

describe("the agent test at one click", () => {
  it("turns on what the test needs in one go, the agent's token included, and ends by putting exactly that back", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 }).record;
      const other = fx.settings.createToken({ name: "Home Assistant", permissions: [], lifetimeDays: null }).record;
      fx.settings.setBehaviour({ agentWrites: false });
      fx.service.noteAgentCall(agent.id);
      const plan = fx.service.status().plan;
      assert.deepEqual([plan.available, plan.switches, plan.features], [true, ["agentExperimental", "agentWrites"], ["bandLock", "reconnect", "reboot"]]);
      assert.deepEqual([plan.tokens.map((t) => t.id), plan.suggestedTokenId, plan.tokenNeeded], [[agent.id, other.id], agent.id, true]);
      assert.equal((await fx.tools(agent.permissions)).includes("lock_band"), false, "nothing to test with yet");

      const started = await runAsActor({ channel: "web" }, async () => fx.service.begin({ model: MODEL.toLowerCase(), tokenId: agent.id }));
      assert.equal(started.plan.switches.length + started.plan.features.length, 0, "nothing left to turn on");
      assert.deepEqual([started.current?.switches, started.current?.features, started.current?.tokens], [["agentExperimental", "agentWrites"], ["bandLock", "reconnect", "reboot"], [{ id: agent.id, name: "Claude" }]]);
      assert.deepEqual([fx.inForce().agentExperimental, fx.inForce().agentWrites], [true, true]);
      assert.deepEqual([fx.changes.length, fx.tokenChanges], [1, [agent.id]], "the running parts and the token's event streams hear of it");
      for (const feature of ["bandLock", "reconnect", "reboot"] as const) assert.equal(fx.core.scheduler.device.writeState(feature), "consented", feature);
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read", "control"]);
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === other.id)?.permissions, [], "another token keeps what it had");
      const listed = await fx.tools(["sms-read", "control"]);
      for (const tool of ["lock_band", "unlock_rf_locks", "reconnect_cellular", "reboot_cpe", "probe_router_endpoints"]) assert.ok(listed.includes(tool), tool);
      const entry = fx.audit.list(5).find((e) => e.action === "agents.test");
      assert.equal(entry?.channel, "web");
      assert.equal(entry?.detail, `start for ${MODEL}: MCP_ALLOW_EXPERIMENTAL on, MCP_ALLOW_MUTATIONS on, bandLock on, reconnect on, reboot on, token "Claude" + control`);

      // Starting again with nothing new to turn on changes nothing
      const again = fx.service.begin({ model: MODEL });
      assert.equal(again.current?.startedAtIso, started.current?.startedAtIso);
      assert.equal(fx.audit.list(10).filter((e) => e.action === "agents.test").length, 1);

      const ended = fx.service.end();
      assert.equal(ended.current, null);
      assert.deepEqual(fx.settings.behaviourOverrides, { agentWrites: false }, "the switch that followed .env follows it again; the other is off again");
      assert.deepEqual(fx.settings.experimentalConsents, []);
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read"]);
      assert.deepEqual(fx.tokenChanges, [agent.id, agent.id]);
      assert.equal((await fx.tools(["sms-read"])).includes("probe_router_endpoints"), false);
      assert.equal(fx.audit.list(1)[0]?.detail, `end: MCP_ALLOW_EXPERIMENTAL from .env, MCP_ALLOW_MUTATIONS false, bandLock off, reconnect off, reboot off, token "Claude" - control`);
      assert.equal(fx.settings.agentTest, null);
      assert.deepEqual(fx.service.end().current, null, "ending twice changes nothing");
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves alone what the owner changed during the test, and adds what was missing when started again", async () => {
    const fx = await fixture();
    try {
      fx.service.begin({ model: MODEL });
      assert.deepEqual(fx.service.status().current?.tokens, [], "no token chosen");
      // The owner turns the redial off and on again (a consent of their own) and hands the agents' switch back to .env
      changeExperimentalConsent(fx.settings, fx.core.scheduler.device, { feature: "reconnect", enabled: false });
      fx.tick(1000);
      await new Promise((resolve) => setTimeout(resolve, 2));
      changeExperimentalConsent(fx.settings, fx.core.scheduler.device, { feature: "reconnect", enabled: true, model: MODEL });
      fx.settings.setBehaviour({ agentWrites: null });
      assert.deepEqual(fx.service.status().current?.features, ["bandLock", "reboot"]);
      assert.deepEqual(fx.service.status().plan.switches, ["agentWrites"], "the test needs it again");

      const agent = fx.settings.createToken({ name: "Codex", permissions: [], lifetimeDays: 7 }).record;
      const more = fx.service.begin({ model: MODEL, tokenId: agent.id });
      assert.deepEqual([more.current?.switches, more.current?.tokens.map((t) => t.name)], [["agentExperimental", "agentWrites"], ["Codex"]]);
      assert.match(fx.audit.list(1)[0]?.detail ?? "", /^more for B535-232: MCP_ALLOW_MUTATIONS on, token "Codex" \+ control$/);

      fx.service.end();
      assert.deepEqual(fx.settings.experimentalConsents.map((c) => c.feature), ["reconnect"], "the owner's own consent stays");
      assert.deepEqual(fx.settings.behaviourOverrides, {});
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a start for another model or a token it cannot offer, and on a verified router", async () => {
    const fx = await fixture();
    try {
      const allowed = fx.settings.createToken({ name: "full", permissions: ["control"], lifetimeDays: 1 }).record;
      assert.throws(() => fx.service.begin({ model: "H168-383" }), CpeControlValidationError);
      assert.throws(() => fx.service.begin({ model: 42 }), CpeControlValidationError);
      assert.throws(() => fx.service.begin({ model: MODEL, tokenId: allowed.id }), /cannot be allowed to change the router/, "it may already");
      assert.throws(() => fx.service.begin({ model: MODEL, tokenId: 7 }), CpeControlValidationError);
      assert.deepEqual([fx.settings.behaviourOverrides, fx.settings.experimentalConsents, fx.settings.agentTest], [{}, [], null], "nothing changed");
    } finally {
      await fx.cleanup();
    }

    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-agent-test-verified-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "agent_test_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    });
    try {
      core.monitor.init();
      assert.ok(await core.monitor.identifyDevice());
      const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: StorageCipher.fromSecret("agent_test_key") });
      const service = new AgentTestService({ settings, scheduler: core.scheduler, audit: null, behaviourFromEnv: () => DEFAULT_BEHAVIOUR });
      assert.equal(service.status().plan.available, false);
      assert.throws(() => service.begin({ model: "H168-383" }), AgentTestUnavailableError);
      await settings.flush();
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("reminds 3 hours after the test's last call, again a day later, and stops once a reminder is read", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 }).record;
      fx.service.begin({ model: MODEL, tokenId: agent.id });
      fx.tick(2 * HOUR);
      // A read of the report is the test going on; reading the signal is not
      await fx.call("get_device_report", {}, ["sms-read", "control"]);
      fx.tick(30 * 60_000);
      await fx.call("get_cpe_session_status", {}, ["sms-read", "control"]);
      fx.tick(2 * HOUR);
      fx.service.check();
      assert.equal(fx.alerts.length, 0, "2.5 h after the report");
      fx.tick(31 * 60_000);
      fx.service.check();
      assert.equal(fx.alerts.length, 1);
      const [reminder] = fx.alerts;
      assert.equal(reminder?.code, "AGENT_TEST_STILL_ON");
      assert.equal(reminder?.severity, "warning");
      assert.equal(
        reminder?.messageEn,
        `What the AI agent test turned on is still on (${MODEL}): Let AI agents test this router; Let agents change the router; experimental writes (band lock, redial, reboot); the token “Claude” may change the router. When the test is done, choose “End test” under Settings → Device and FengSui puts back the settings from before it. Once you have seen this in the console's alerts, or chosen “Got it” in Telegram, it is not repeated`
      );
      assert.match(reminder?.messageZh ?? "", /^AI 智能体测试打开的设置还开着（B535-232）：允许 AI 智能体测试这台路由器；允许智能体改动路由器；实验性写入（锁频段、重拨、重启）；令牌「Claude」可以改动路由器。/);
      const shown = fx.service.status().current;
      assert.deepEqual([shown?.remindedAtIso, shown?.acknowledged, shown?.remindAtIso], [new Date(fx.now()).toISOString(), false, new Date(fx.now() + AGENT_TEST_REMIND_EVERY_MS).toISOString()]);

      fx.tick(23 * HOUR);
      fx.service.check();
      assert.equal(fx.alerts.length, 1, "not before a day has passed");
      assert.equal(fx.service.acknowledge("another-alert"), false, "an older reminder shown in the console");
      fx.tick(HOUR);
      fx.service.check();
      assert.equal(fx.alerts.length, 2, "a day later");

      assert.equal(await runAsActor({ channel: "telegram", label: "chat …001" }, async () => fx.service.acknowledge()), true);
      assert.deepEqual([fx.audit.list(1)[0]?.detail, fx.audit.list(1)[0]?.channel], ["reminder read", "telegram"]);
      assert.equal(fx.service.acknowledge(), false, "read once");
      fx.tick(10 * 24 * HOUR);
      fx.service.check();
      assert.equal(fx.alerts.length, 2, "never again for this test");
      const read = fx.service.status().current;
      assert.deepEqual([read?.acknowledged, read?.remindAtIso], [true, null]);

      // Starting it again (something new turned on) is a new round of reminders
      fx.settings.setBehaviour({ agentWrites: null });
      fx.service.begin({ model: MODEL });
      assert.deepEqual([fx.service.status().current?.acknowledged, fx.service.status().current?.remindedAtIso], [false, null]);
    } finally {
      await fx.cleanup();
    }
  });

  it("reads a reminder through the alert the console showed, and only the latest", async () => {
    const fx = await fixture();
    try {
      fx.service.begin({ model: MODEL });
      assert.equal(fx.service.acknowledge(), false, "no reminder yet");
      fx.tick(AGENT_TEST_REMIND_AFTER_MS);
      fx.service.check();
      const alert = fx.alerts.at(-1);
      assert.ok(alert);
      assert.equal(fx.service.acknowledge("an-older-one"), false);
      assert.equal(fx.service.acknowledge(alert.id), true);
      assert.equal(fx.service.status().current?.acknowledged, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("does not remind once every covered write that is on passed", async () => {
    const fx = await fixture();
    try {
      fx.service.begin({ model: MODEL });
      // The owner keeps only the band lock, which the agent then tests and puts back
      for (const feature of ["reconnect", "reboot"]) changeExperimentalConsent(fx.settings, fx.core.scheduler.device, { feature, enabled: false });
      assert.equal(fx.service.status().current?.passed, false, "not tried yet");
      const locked = await fx.call("lock_band", { lteBands: ["B1"], confirm: true }, ["control"]);
      assert.equal(locked["ok"], true);
      const unlocked = await fx.call("unlock_rf_locks", { confirm: true }, ["control"]);
      assert.equal(unlocked["ok"], true);
      assert.deepEqual(fx.core.scheduler.genericWrites.map((w) => [w.action, w.readback]), [["lock_band", "match"], ["unlock_rf_locks", "match"]]);
      const current = fx.service.status().current;
      assert.deepEqual([current?.passed, current?.remindAtIso], [true, null]);
      fx.tick(2 * AGENT_TEST_REMIND_EVERY_MS);
      fx.service.check();
      assert.deepEqual(fx.alerts.map((a) => a.code), [], "passed: no reminder");
      assert.notEqual(fx.settings.agentTest, null, "still on until the owner ends it");
    } finally {
      await fx.cleanup();
    }
  });

  it("ends by itself once nothing it turned on is still on, and survives a restart", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: [], lifetimeDays: 1 }).record;
      fx.service.begin({ model: MODEL, tokenId: agent.id });
      await fx.settings.flush();
      const reloaded = new ConsoleSettings({ filePath: path.join(fx.dir, "settings.json"), cipher: fx.cipher });
      assert.equal(reloaded.load(), true);
      assert.deepEqual(reloaded.agentTest, fx.settings.agentTest, "kept in settings.json");

      // Everything set back by hand: the next check forgets the test
      fx.settings.setBehaviour({ agentExperimental: null, agentWrites: null });
      for (const feature of ["bandLock", "reconnect", "reboot"]) fx.settings.revokeExperimental(feature);
      fx.settings.setTokenPermissions(agent.id, []);
      assert.equal(fx.service.status().current, null);
      fx.service.check();
      assert.equal(fx.settings.agentTest, null);
      assert.deepEqual([fx.audit.list(1)[0]?.detail, fx.audit.list(1)[0]?.channel], ["ended: nothing it turned on is still on", "system"]);
      fx.service.check();
      assert.deepEqual(fx.alerts, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("checks for a due reminder on its own once started", async () => {
    const fx = await fixture();
    const service = new AgentTestService({ settings: fx.settings, scheduler: fx.core.scheduler, audit: null, behaviourFromEnv: () => DEFAULT_BEHAVIOUR, now: () => fx.now() + AGENT_TEST_REMIND_AFTER_MS, checkEveryMs: 5 });
    try {
      fx.service.begin({ model: MODEL });
      service.start();
      service.start();
      const deadline = Date.now() + 2000;
      while (fx.alerts.length === 0) {
        assert.ok(Date.now() < deadline, "a reminder within the check interval");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(fx.alerts[0]?.code, "AGENT_TEST_STILL_ON");
    } finally {
      service.stop();
      service.stop();
      await fx.cleanup();
    }
  });
});
