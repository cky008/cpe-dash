import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  AGENT_TEST_REMIND_AFTER_MS,
  AGENT_TEST_REMIND_EVERY_MS,
  type AgentTestRecord,
  type AgentTestTokenInfo,
  agentTestCovered,
  agentTestPassed,
  agentTestPlan,
  agentTestReminderDueMs,
  agentTestStillOn,
  agentTestView,
  copyAgentTestRecord,
  isAgentTestRecord,
} from "../src/agent-test.ts";
import { AgentTestService, AgentTestUnavailableError } from "../src/agent-test-service.ts";
import { AuditLog, runAsActor } from "../src/audit-log.ts";
import { type BehaviourValues, DEFAULT_BEHAVIOUR, resolveBehaviour } from "../src/behaviour-settings.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import type { SmsAbilities } from "../src/sms/types.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { WRITE_FEATURES, type WriteFeature, type WriteFeatureState } from "../src/device-access.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { switchExperimentalWrite } from "../src/experimental-switch.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

/**
 * The AI agent test at one click (Settings → Device): what starting it sets (the agent switches and
 * the token's permissions, those of SMS too unless the owner leaves it out; never a write's own
 * switch), how ending it puts back exactly that, and when the owner is reminded that it is still on.
 * Mocks and placeholders only.
 */

const MODEL = "B535-232";
const HOUR = 3_600_000;
const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};
const VALUES = { ...DEFAULT_BEHAVIOUR };

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
    sms: true,
    settings: [
      { key: "agentExperimental", before: null },
      { key: "agentWrites", before: false },
      { key: "agentSms", before: "read" },
      { key: "agentSmsSendPolicy", before: null },
    ],
    tokens: [{ id: "t1", name: "agent", added: ["control", "sms-write"] }],
    lastActivityAtIso: "2026-11-10T08:00:00.000Z",
    remindedAtIso: null,
    reminderAlertId: null,
    acknowledgedAtIso: null,
    ...extra,
  };
}

describe("the agent test's rules", () => {
  const NOW = Date.parse("2026-11-10T09:00:00.000Z");
  const plan = (input: { states: Partial<Record<WriteFeature, WriteFeatureState>>; writes?: "allowed" | "experimental" | "unknown"; values?: Partial<BehaviourValues>; smsReadable?: boolean; smsAbilities?: SmsAbilities; tokens?: AgentTestTokenInfo[] }) =>
    agentTestPlan({
      device: { writes: input.writes ?? "experimental", features: features(input.states) },
      values: { ...VALUES, ...input.values },
      smsReadable: input.smsReadable ?? true,
      smsAbilities: input.smsAbilities ?? null,
      tokens: input.tokens ?? [],
      nowMs: NOW,
    });

  it("offers the test only on a model nobody verified that has a covered write open, SMS apart, and never turns a write on", () => {
    const writable = { bandLock: "enabled", reboot: "enabled", reconnect: "disabled", mobileData: "enabled", smsWrite: "enabled" } as const;
    for (const writes of ["allowed", "unknown"] as const) assert.equal(plan({ states: writable, writes }).available, false, writes);
    assert.equal(plan({ states: { bandLock: "unsupported", reboot: "unsupported", mobileData: "enabled" } }).available, false, "mobile data is not the test's");

    const all = plan({ states: writable, values: { agentExperimental: true } });
    assert.deepEqual([all.available, all.settings], [true, ["agentWrites"]], "the settings not set its way; the writes are on already");
    assert.equal(Object.hasOwn(all, "features"), false, "no write for the test to turn on");
    assert.deepEqual(all.sms, { available: true, settings: ["agentSms", "agentSmsSendPolicy"], sendLimitPerHour: 10, markRead: "router", delete: "message" });
    assert.deepEqual(plan({ states: writable, values: { agentSms: "full", agentSmsSendPolicy: "any" } }).sms.settings, [], "SMS already set its way");
    assert.equal(plan({ states: { ...writable, smsWrite: "disabled" } }).sms.available, false, "SMS writes its owner turned off are not the test's to turn back on");
    assert.equal(plan({ states: writable, smsReadable: false }).sms.available, false, "no SMS here (SMS_ENABLED=false, or the router has none)");
    assert.equal(plan({ states: { ...writable, smsWrite: "unsupported" } }).sms.available, false);
    // The test sends its own message first: a router that cannot send has no SMS test, and what it can do is passed on
    assert.equal(plan({ states: writable, smsAbilities: { send: false, delete: "message", markRead: "router" } }).sms.available, false);
    const tozedLike = plan({ states: writable, smsAbilities: { send: true, delete: "none", markRead: "fengsui" } }).sms;
    assert.deepEqual([tozedLike.available, tozedLike.markRead, tozedLike.delete], [true, "fengsui", "none"]);
    assert.deepEqual([all.sms.markRead, all.sms.delete], ["router", "message"], "nothing listed yet: taken as a router that does it all");
    const smsOnly = plan({ states: { smsWrite: "enabled" } });
    assert.deepEqual([smsOnly.available, smsOnly.sms.available], [true, true], "SMS alone is a test too");
    // Every covered write turned off by its owner: nothing for an agent to test, and the test does not undo that
    assert.equal(plan({ states: { bandLock: "disabled", reboot: "disabled", reconnect: "disabled", smsWrite: "disabled", mobileData: "enabled" } }).available, false);
  });

  it("suggests the token an agent called with last, else the only one there is to choose, and says what each lacks", () => {
    const states = { bandLock: "enabled", smsWrite: "enabled" } as const;
    const seen = plan({ states, tokens: [token("old", { agentUsedAtMs: NOW - 9 * HOUR }), token("ha", { permissions: [] }), token("agent", { agentUsedAtMs: NOW - 60_000 })] });
    assert.deepEqual(seen.tokens.map((t) => [t.id, t.missing]), [["agent", ["control", "sms-write"]], ["old", ["control", "sms-write"]], ["ha", ["control", "sms-read", "sms-write"]]], "the agent's first");
    assert.deepEqual([seen.suggestedTokenId, seen.tokenNeeded], ["agent", true]);
    assert.equal(seen.tokens[0]?.agentUsedAtIso, new Date(NOW - 60_000).toISOString());

    const allowed = plan({ states, tokens: [token("ha"), token("agent", { permissions: ["sms-read", "control", "sms-write"], agentUsedAtMs: NOW })] });
    assert.deepEqual([allowed.tokens.map((t) => t.id), allowed.suggestedTokenId, allowed.tokenNeeded], [["ha"], null, false], "the agent's token has all it needs");
    const noSms = plan({ states, smsReadable: false, tokens: [token("agent", { permissions: ["control"], agentUsedAtMs: NOW })] });
    assert.deepEqual([noSms.tokens, noSms.tokenNeeded], [[], false], "without SMS the router permission is all it needs");

    assert.deepEqual([plan({ states, tokens: [token("only")] }).suggestedTokenId, plan({ states, tokens: [token("only")] }).tokenNeeded], ["only", true], "no agent seen, one token");
    const two = plan({ states, tokens: [token("a", { createdAtIso: "2026-11-02T00:00:00.000Z" }), token("b", { createdAtIso: "2026-11-03T00:00:00.000Z" })] });
    assert.deepEqual([two.tokens.map((t) => t.id), two.suggestedTokenId, two.tokenNeeded], [["b", "a"], null, true], "no agent seen, two tokens: newest first, no guess");
    const expired = plan({ states, tokens: [token("gone", { expiresAtIso: new Date(NOW - 1).toISOString(), agentUsedAtMs: NOW }), token("live")] });
    assert.deepEqual([expired.tokens.map((t) => t.id), expired.suggestedTokenId], [["live"], "live"], "an expired token is neither offered nor the agent's");
  });

  it("counts as still on only what is as the test left it", () => {
    const test = record();
    const now = {
      overrides: { agentExperimental: true, agentWrites: true, agentSms: "full", agentSmsSendPolicy: "any" },
      tokens: [{ id: "t1", permissions: ["sms-read", "control", "sms-write"] as const }],
    };
    assert.deepEqual(agentTestStillOn(test, now), {
      settings: ["agentExperimental", "agentWrites", "agentSms", "agentSmsSendPolicy"],
      tokens: [{ id: "t1", name: "agent", permissions: ["control", "sms-write"] }],
    });
    const changed = agentTestStillOn(test, {
      overrides: { agentExperimental: null, agentWrites: false, agentSms: "read", agentSmsSendPolicy: "known" },
      tokens: [{ id: "t1", permissions: ["sms-read", "sms-write"] }],
    });
    assert.deepEqual(changed, { settings: [], tokens: [{ id: "t1", name: "agent", permissions: ["sms-write"] }] }, "set back, or partly taken back by the owner");
  });

  it("passes when every covered write that is open was tried since the start and always read back as a match", () => {
    const test = record();
    const write = (feature: "bandLock" | "reconnect" | "smsWrite", atIso: string, outcome: "applied" | "failed", readback: "match" | "mismatch" | "pending") => ({ feature, atIso, outcome, readback });
    const after = "2026-11-10T08:10:00.000Z";
    assert.equal(agentTestPassed(test, [], [write("bandLock", after, "applied", "match")]), false, "nothing on to pass");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", "2026-11-10T07:00:00.000Z", "applied", "match")]), false, "tried before the test only");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "applied", "match")]), true);
    assert.equal(agentTestPassed(test, ["bandLock", "reconnect"], [write("bandLock", after, "applied", "match")]), false, "the redial not tried");
    assert.equal(agentTestPassed(test, ["bandLock", "reconnect"], [write("bandLock", after, "applied", "match"), write("reconnect", after, "applied", "pending")]), false, "still being checked");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "applied", "match"), write("bandLock", after, "applied", "mismatch")]), false, "one try read back differently");
    assert.equal(agentTestPassed(test, ["bandLock"], [write("bandLock", after, "failed", "match")]), false, "refused by the router");

    const on = (feature: string): boolean => feature === "bandLock" || feature === "smsWrite";
    assert.deepEqual(agentTestCovered({ sms: true }, on), ["bandLock", "smsWrite"]);
    assert.deepEqual(agentTestCovered({ sms: false }, on), ["bandLock"], "SMS left out of the test does not count, even if it is on");
  });

  it("reminds 3 hours after the last activity, then daily, and never after a read reminder, a pass or with nothing on", () => {
    const test = record({ lastActivityAtIso: "2026-11-10T09:30:00.000Z" });
    assert.equal(agentTestReminderDueMs(test, true, false), Date.parse(test.lastActivityAtIso) + AGENT_TEST_REMIND_AFTER_MS);
    const reminded = record({ remindedAtIso: "2026-11-10T12:30:00.000Z" });
    assert.equal(agentTestReminderDueMs(reminded, true, false), Date.parse("2026-11-10T12:30:00.000Z") + AGENT_TEST_REMIND_EVERY_MS);
    assert.equal(agentTestReminderDueMs(record({ remindedAtIso: "2026-11-10T12:30:00.000Z", acknowledgedAtIso: "2026-11-10T13:00:00.000Z" }), true, false), null);
    assert.equal(agentTestReminderDueMs(test, false, false), null);
    assert.equal(agentTestReminderDueMs(test, true, true), null);
    const view = agentTestView(test, { settings: ["agentWrites"], tokens: [] }, false);
    assert.deepEqual([view.settings, view.sms, view.passed, view.acknowledged, view.remindAtIso], [["agentWrites"], true, false, false, "2026-11-10T12:30:00.000Z"]);
  });

  it("keeps only a stored test it can read in full", () => {
    assert.equal(isAgentTestRecord(record()), true);
    assert.equal(isAgentTestRecord(record({ sms: false, remindedAtIso: "2026-11-10T10:00:00.000Z", reminderAlertId: "a1", acknowledgedAtIso: "2026-11-10T11:00:00.000Z" })), true);
    const broken: Array<[string, unknown]> = [
      ["not an object", "test"],
      ["no model", { ...record(), model: "" }],
      ["a bad time", { ...record(), startedAtIso: "yesterday" }],
      ["no SMS choice", { ...record(), sms: "yes" }],
      ["an unknown setting", { ...record(), settings: [{ key: "redactApi", before: null }] }],
      ["a bad before", { ...record(), settings: [{ key: "agentWrites", before: "off" }] }],
      ["a before of another setting", { ...record(), settings: [{ key: "agentSms", before: true }] }],
      ["a token without a name", { ...record(), tokens: [{ id: "t1", added: ["control"] }] }],
      ["a token given nothing", { ...record(), tokens: [{ id: "t1", name: "agent", added: [] }] }],
      ["a permission the test never gives", { ...record(), tokens: [{ id: "t1", name: "agent", added: ["access"] }] }],
      ["a bad alert id", { ...record(), reminderAlertId: 7 }],
      ["a bad read time", { ...record(), acknowledgedAtIso: "soon" }],
    ];
    for (const [label, value] of broken) assert.equal(isAgentTestRecord(value), false, label);
    // A test a version before 1.9.0 stored also lists the writes it had turned on: read, and not kept
    const old = { ...record(), features: [{ feature: "bandLock", grantedAtIso: "2026-11-10T08:00:00.000Z" }] };
    assert.equal(isAgentTestRecord(old), true);
    assert.deepEqual(copyAgentTestRecord(old), record());
  });
});

/** A B535-232 (a model nobody verified) with SMS, the console's store, the audit log, MCP and the test service on one clock. */
async function fixture(env: BehaviourValues = DEFAULT_BEHAVIOUR) {
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: ENDPOINTS, writes: {}, sms: [] });
  const dir = tempDir("fengsui-agent-test-");
  const core = createFengSuiCore({
    connection: mockConnection(cpe, { requestTimeoutMs: 2000 }),
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
    smsEnabled: true,
    onBehaviourChanged: (values) => changes.push(values),
    onTokenChanged: (id) => tokenChanges.push(id),
    now: () => clock,
  });
  const server = new FengSuiMcpServer({
    core,
    allowMutations: () => inForce().agentWrites,
    experimental: { allowed: () => inForce().agentExperimental, change: (request) => switchExperimentalWrite(settings, core.scheduler.device, request) },
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
  it("sets what the test needs in one go, SMS and the agent's token included, leaves the writes as they are, and ends by putting exactly that back", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 }).record;
      const other = fx.settings.createToken({ name: "Home Assistant", permissions: [], lifetimeDays: null }).record;
      fx.settings.setBehaviour({ agentWrites: false });
      fx.service.noteAgentCall(agent.id);
      const plan = fx.service.status().plan;
      assert.deepEqual([plan.available, plan.settings], [true, ["agentExperimental", "agentWrites"]]);
      assert.deepEqual(plan.sms, { available: true, settings: ["agentSms", "agentSmsSendPolicy"], sendLimitPerHour: 10, markRead: "router", delete: "message" });
      // The writes are on before the test starts, with nothing asked of the owner: the agent only lacks the leave to use them
      for (const feature of ["bandLock", "reconnect", "reboot", "smsWrite"] as const) assert.equal(fx.core.scheduler.device.writeState(feature), "enabled", feature);
      assert.deepEqual([plan.tokens.map((t) => [t.id, t.missing]), plan.suggestedTokenId, plan.tokenNeeded], [[[agent.id, ["control", "sms-write"]], [other.id, ["control", "sms-read", "sms-write"]]], agent.id, true]);
      assert.equal((await fx.tools(agent.permissions)).includes("lock_band"), false, "nothing to test with yet");

      const started = await runAsActor({ channel: "web" }, async () => fx.service.begin({ model: MODEL.toLowerCase(), tokenId: agent.id, sms: true }));
      assert.equal(started.plan.settings.length + started.plan.sms.settings.length, 0, "nothing left to set");
      assert.deepEqual([started.current?.settings, started.current?.sms], [["agentExperimental", "agentWrites", "agentSms", "agentSmsSendPolicy"], true]);
      assert.equal(Object.hasOwn(started.current ?? {}, "features"), false, "ending the test has no write to turn off");
      assert.deepEqual(started.current?.tokens, [{ id: agent.id, name: "Claude", permissions: ["control", "sms-write"] }]);
      const values = fx.inForce();
      assert.deepEqual([values.agentExperimental, values.agentWrites, values.agentSms, values.agentSmsSendPolicy], [true, true, "full", "any"]);
      assert.deepEqual([fx.changes.length, fx.tokenChanges], [1, [agent.id]], "the running parts and the token's event streams hear of it");
      assert.equal(fx.settings.disabledWrites.length, 0, "the test touched no write's switch");
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read", "control", "sms-write"]);
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === other.id)?.permissions, [], "another token keeps what it had");
      const listed = await fx.tools(["sms-read", "control", "sms-write"]);
      for (const tool of ["lock_band", "unlock_rf_locks", "reconnect_cellular", "reboot_cpe", "probe_router_endpoints"]) assert.ok(listed.includes(tool), tool);
      const entry = fx.audit.list(5).find((e) => e.action === "agents.test");
      assert.equal(entry?.channel, "web");
      assert.equal(
        entry?.detail,
        `start for ${MODEL} with SMS: MCP_ALLOW_EXPERIMENTAL true, MCP_ALLOW_MUTATIONS true, MCP_SMS_ACCESS full, MCP_SMS_SEND_POLICY any, token "Claude" + control + sms-write`
      );

      // Starting again with nothing new to turn on changes nothing
      const again = fx.service.begin({ model: MODEL, sms: true });
      assert.equal(again.current?.startedAtIso, started.current?.startedAtIso);
      assert.equal(fx.audit.list(10).filter((e) => e.action === "agents.test").length, 1);

      const ended = fx.service.end();
      assert.equal(ended.current, null);
      assert.deepEqual(fx.settings.behaviourOverrides, { agentWrites: false }, "the settings that followed .env follow it again; the other is off again");
      for (const feature of ["bandLock", "reconnect", "reboot", "smsWrite"] as const) assert.equal(fx.core.scheduler.device.writeState(feature), "enabled", `${feature}: as before the test`);
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, ["sms-read"]);
      assert.deepEqual(fx.tokenChanges, [agent.id, agent.id]);
      assert.equal((await fx.tools(["sms-read"])).includes("probe_router_endpoints"), false);
      assert.equal(
        fx.audit.list(1)[0]?.detail,
        `end: MCP_ALLOW_EXPERIMENTAL from .env, MCP_ALLOW_MUTATIONS false, MCP_SMS_ACCESS from .env, MCP_SMS_SEND_POLICY from .env, token "Claude" - control - sms-write`
      );
      assert.equal(fx.settings.agentTest, null);
      assert.deepEqual(fx.service.end().current, null, "ending twice changes nothing");
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves SMS out when the owner does, and adds it when started again with SMS", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 }).record;
      const first = fx.service.begin({ model: MODEL, tokenId: agent.id, sms: false });
      assert.deepEqual([first.current?.settings, first.current?.sms], [["agentExperimental", "agentWrites"], false]);
      assert.deepEqual(first.current?.tokens.map((t) => t.permissions), [["control"]], "the router permission only");
      assert.equal(fx.inForce().agentSms, "read", "agents still only read SMS");
      assert.deepEqual([first.plan.sms.settings, first.plan.tokens.map((t) => t.missing)], [["agentSms", "agentSmsSendPolicy"], [["sms-write"]]], "SMS still on offer");

      const more = fx.service.begin({ model: MODEL, tokenId: agent.id, sms: true });
      assert.deepEqual([more.current?.sms, more.current?.tokens.map((t) => t.permissions)], [true, [["control", "sms-write"]]]);
      assert.equal(fx.audit.list(1)[0]?.detail, `more for ${MODEL} with SMS: MCP_SMS_ACCESS full, MCP_SMS_SEND_POLICY any, token "Claude" + sms-write`);
      fx.service.end();
      assert.deepEqual([fx.settings.behaviourOverrides, fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions], [{}, ["sms-read"]]);

      assert.throws(() => fx.service.begin({ model: MODEL, sms: "yes" }), CpeControlValidationError);
      // A test already on with everything set: keeping SMS in only changes what counts for a pass
      fx.settings.setBehaviour({ agentSms: "full", agentSmsSendPolicy: "any" });
      fx.service.begin({ model: MODEL, sms: false });
      assert.equal(fx.service.status().current?.sms, false);
      fx.service.begin({ model: MODEL, sms: true });
      assert.equal(fx.service.status().current?.sms, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves alone what the owner changed during the test, and adds what was missing when started again", async () => {
    const fx = await fixture();
    try {
      fx.service.begin({ model: MODEL });
      assert.deepEqual([fx.service.status().current?.tokens, fx.service.status().current?.sms], [[], false], "no token chosen, SMS left out by default");
      // The owner turns the redial off (a choice of their own) and hands the agents' switch back to .env
      switchExperimentalWrite(fx.settings, fx.core.scheduler.device, { feature: "reconnect", enabled: false });
      fx.settings.setBehaviour({ agentWrites: null });
      assert.deepEqual(fx.service.status().plan.settings, ["agentWrites"], "the test needs it again");
      assert.equal(fx.service.status().plan.available, true, "the band lock and the reboot are still there to test");

      const agent = fx.settings.createToken({ name: "Codex", permissions: [], lifetimeDays: 7 }).record;
      const more = fx.service.begin({ model: MODEL, tokenId: agent.id });
      assert.deepEqual([more.current?.settings, more.current?.tokens.map((t) => t.name)], [["agentExperimental", "agentWrites"], ["Codex"]]);
      assert.match(fx.audit.list(1)[0]?.detail ?? "", /^more for B535-232: MCP_ALLOW_MUTATIONS true, token "Codex" \+ control$/);

      fx.service.end();
      assert.deepEqual(fx.settings.disabledWrites.map((d) => d.feature), ["reconnect"], "what the owner turned off stays off: neither starting nor ending the test touches it");
      assert.equal(fx.core.scheduler.device.writeState("reconnect"), "disabled");
      assert.deepEqual(fx.settings.behaviourOverrides, {});
      assert.deepEqual(fx.settings.listTokens().find((t) => t.id === agent.id)?.permissions, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a start for another model or a token it cannot offer, and on a verified router", async () => {
    const fx = await fixture();
    try {
      const allowed = fx.settings.createToken({ name: "full", permissions: ["sms-read", "control", "sms-write"], lifetimeDays: 1 }).record;
      assert.throws(() => fx.service.begin({ model: "H168-383" }), CpeControlValidationError);
      assert.throws(() => fx.service.begin({ model: 42 }), CpeControlValidationError);
      assert.throws(() => fx.service.begin({ model: MODEL, tokenId: allowed.id }), /cannot be given what the test needs/, "it has it already");
      assert.throws(() => fx.service.begin({ model: MODEL, tokenId: 7 }), CpeControlValidationError);
      assert.deepEqual([fx.settings.behaviourOverrides, fx.settings.disabledWrites.length, fx.settings.agentTest], [{}, 0, null], "nothing changed");
      // A token that lacks only SMS permissions gets nothing when SMS is left out
      const smsless = fx.settings.createToken({ name: "agent", permissions: ["control"], lifetimeDays: 1 }).record;
      const started = fx.service.begin({ model: MODEL, tokenId: smsless.id, sms: false });
      assert.deepEqual([started.current?.tokens, fx.settings.listTokens().find((t) => t.id === smsless.id)?.permissions], [[], ["control"]]);
      // Every write the test covers turned off by the owner: no test to start, and none of them is turned back on
      fx.service.end();
      for (const feature of ["bandLock", "reconnect", "reboot", "smsWrite"]) switchExperimentalWrite(fx.settings, fx.core.scheduler.device, { feature, enabled: false });
      assert.equal(fx.service.status().plan.available, false);
      assert.throws(() => fx.service.begin({ model: MODEL }), AgentTestUnavailableError);
      assert.equal(fx.settings.disabledWrites.length, 4);
    } finally {
      await fx.cleanup();
    }

    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-agent-test-verified-");
    const core = createFengSuiCore({
      connection: mockConnection(cpe),
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
      fx.service.begin({ model: MODEL, tokenId: agent.id, sms: true });
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
        `What the AI agent test turned on is still on (${MODEL}): Let AI agents test this router; Let agents change the router; agents' SMS access: read and write; agents may send SMS to any number; the token “Claude”: change the router, send and delete SMS. When the test is done, choose “End test” under Settings → Device and FengSui puts back the settings from before it. Once you have seen this in the console's alerts, or chosen “Got it” in Telegram, it is not repeated`
      );
      assert.match(reminder?.messageZh ?? "", /^AI 智能体测试打开的设置还开着（B535-232）：允许 AI 智能体测试这台路由器；允许智能体改动路由器；智能体的短信权限：读写；智能体发短信：任何号码；令牌「Claude」：改动路由器、发短信、删短信。/);
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

  it("does not remind once every covered write that is open passed", async () => {
    const fx = await fixture();
    try {
      fx.service.begin({ model: MODEL, sms: false });
      // The owner keeps only the band lock, which the agent then tests and puts back
      for (const feature of ["reconnect", "reboot"]) switchExperimentalWrite(fx.settings, fx.core.scheduler.device, { feature, enabled: false });
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

      // SMS kept in the test counts too: open and never tried, so no pass
      assert.equal(fx.core.scheduler.device.writeState("smsWrite"), "enabled");
      assert.equal(fx.service.status().current?.passed, true, "SMS was left out of this test");
      fx.service.begin({ model: MODEL, sms: true });
      assert.equal(fx.service.status().current?.passed, false, "SMS is in now, and untried");
    } finally {
      await fx.cleanup();
    }
  });

  it("ends by itself once nothing it turned on is still on, and survives a restart", async () => {
    const fx = await fixture();
    try {
      const agent = fx.settings.createToken({ name: "Claude", permissions: [], lifetimeDays: 1 }).record;
      fx.service.begin({ model: MODEL, tokenId: agent.id, sms: true });
      await fx.settings.flush();
      const reloaded = new ConsoleSettings({ filePath: path.join(fx.dir, "settings.json"), cipher: fx.cipher });
      assert.equal(reloaded.load(), true);
      assert.deepEqual(reloaded.agentTest, fx.settings.agentTest, "kept in settings.json");

      // Everything set back by hand: the next check forgets the test
      fx.settings.setBehaviour({ agentExperimental: null, agentWrites: null, agentSms: null, agentSmsSendPolicy: null });
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
