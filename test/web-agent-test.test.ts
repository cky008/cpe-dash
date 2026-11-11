import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AgentTestPlan, type AgentTestView, noAgentTestPlan } from "../src/agent-test.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { agentStartBody, agentTestStatus, defaultAgentToken, reminderWaiting, smsOption, startTurnsOn, tokenGets } from "../web/src/core/agent-test-view.ts";
import { interpolate } from "../web/src/core/i18n.ts";
import { latestAgentTestReminder } from "../web/src/core/store.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../web/src/i18n/settings.ts";

/** The Device tab's words for the AI agent test at one click, in both languages. */

const zh = (key: SettingsTextKey, params?: Record<string, string | number>): string => interpolate(SETTINGS_TEXT["zh-CN"][key], params);
const en = (key: SettingsTextKey, params?: Record<string, string | number>): string => interpolate(SETTINGS_TEXT.en[key], params);
const NOW = new Date(2026, 10, 10, 14, 0).getTime();

function plan(extra: Partial<AgentTestPlan> = {}): AgentTestPlan {
  return {
    available: true,
    settings: ["agentExperimental", "agentWrites"],
    sms: { available: true, settings: ["agentSms", "agentSmsSendPolicy"], sendLimitPerHour: 10, markRead: "router", delete: "message" },
    tokens: [
      { id: "t1", name: "Claude", missing: ["control", "sms-write"], agentUsedAtIso: new Date(NOW - 120_000).toISOString() },
      { id: "t2", name: "Home Assistant", missing: ["sms-write"], agentUsedAtIso: null },
    ],
    suggestedTokenId: "t1",
    tokenNeeded: true,
    ...extra,
  };
}

function view(extra: Partial<AgentTestView> = {}): AgentTestView {
  return {
    model: "B535-232",
    startedAtIso: new Date(NOW - 2 * 3_600_000).toISOString(),
    sms: true,
    settings: ["agentExperimental", "agentWrites", "agentSms", "agentSmsSendPolicy"],
    tokens: [{ id: "t1", name: "Claude", permissions: ["control", "sms-write"] }],
    lastActivityAtIso: new Date(NOW - 3_600_000).toISOString(),
    remindedAtIso: null,
    acknowledged: false,
    passed: false,
    remindAtIso: new Date(NOW + 2 * 3_600_000).toISOString(),
    ...extra,
  };
}

describe("the agent test in the Device tab", () => {
  it("starts on the agent's token, and asks first only when copying sets something", () => {
    assert.equal(defaultAgentToken(plan()), "t1");
    assert.equal(defaultAgentToken(plan({ suggestedTokenId: null })), "", "no guess: none chosen");
    assert.equal(defaultAgentToken(plan({ tokenNeeded: false })), "", "the agent's token has what it needs");

    assert.deepEqual([tokenGets(plan(), "t1", true), tokenGets(plan(), "t1", false), tokenGets(plan(), "t2", false), tokenGets(plan(), "", true)], [["control", "sms-write"], ["control"], [], []]);
    assert.equal(startTurnsOn(plan(), "t1", true), true);
    const baseOn = plan({ settings: [] });
    assert.equal(startTurnsOn(baseOn, "", true), true, "the SMS settings still to set");
    assert.equal(startTurnsOn(plan({ settings: [], sms: { available: true, settings: [], sendLimitPerHour: 10, markRead: "router", delete: "message" } }), "", true), false, "everything set already, and the writes need no turning on: copy only");
    assert.equal(startTurnsOn(baseOn, "", false), false, "SMS left out: copy only");
    assert.equal(startTurnsOn(baseOn, "t2", false), false, "that token lacks only SMS");
    assert.equal(startTurnsOn(baseOn, "t2", true), true);
    assert.equal(startTurnsOn(plan({ settings: [], sms: { available: false, settings: ["agentSms"], sendLimitPerHour: 10, markRead: "router", delete: "message" } }), "", true), false, "no SMS here");
    assert.equal(startTurnsOn(noAgentTestPlan(), "", true), false);
  });

  it("lists in the confirmation what the test sets, the risk and how it ends, with SMS as the option below", () => {
    const body = agentStartBody(plan(), "t1", zh);
    assert.deepEqual(body.slice(0, 4), ["烽燧会打开下面这些设置，并复制提示词：", "· 允许 AI 智能体测试这台路由器", "· 允许智能体改动路由器", "· 令牌「Claude」：可以改动路由器"]);
    assert.deepEqual(body.slice(4), [zh("agent_start_risk"), zh("agent_start_end"), zh("agent_start_reconnect")]);
    assert.match(body.join("\n"), /3 小时/);
    // The test turns no write on, and says so nowhere; it says the writes were never checked on a real router
    assert.doesNotMatch(body.join("\n") + (smsOption(plan(), zh) ?? ""), /打开实验性|实验性写入：/);
    assert.match(zh("agent_start_risk"), /没有在真机上验证过/);
    assert.match(en("agent_start_risk"), /never checked on a real one/);
    assert.doesNotMatch(agentStartBody(plan(), "t1", en).join("\n") + (smsOption(plan(), en) ?? ""), /turns on the experimental|Experimental writes:/);
    assert.equal(agentStartBody(plan(), "t2", zh).some((line) => line.includes("Home Assistant")), false, "it lacks only SMS: the option below covers it");

    const none = agentStartBody(plan({ settings: ["agentWrites"] }), "", en);
    assert.deepEqual(none.slice(0, 3), ["FengSui turns on the following and copies the prompt:", "· Let agents change the router", en("agent_no_token")]);
    assert.equal(agentStartBody(plan({ tokenNeeded: false, tokens: [] }), "", en).includes(en("agent_no_token")), false, "no token is needed");

    assert.equal(smsOption(plan(), en), en("agent_sms_check", { limit: 10, steps: "it marks your reply read and deletes both" }));
    assert.match(smsOption(plan(), zh) ?? "", /你回复后，它把回复标为已读，再删掉这两条。[\s\S]*每小时最多 10 条/);
    // Said the way this router's SMS interface allows: where marking read lands, and how (or whether) the two messages go
    const sms = (markRead: "router" | "fengsui", remove: "message" | "conversation" | "none") => plan({ sms: { available: true, settings: [], sendLimitPerHour: 10, markRead, delete: remove } });
    assert.match(smsOption(sms("fengsui", "none"), zh) ?? "", /标为已读（这台路由器的已读状态由烽燧自己记，这一步不写路由器），这台路由器不能删除短信，两条测试短信会留在路由器上。/);
    assert.match(smsOption(sms("router", "conversation"), en) ?? "", /it marks your reply read and deletes the conversation \(this router deletes whole conversations only/);
    assert.match(smsOption(sms("fengsui", "message"), en) ?? "", /nothing is written for it\) and deletes both\./);
    assert.equal(smsOption(plan({ sms: { available: false, settings: [], sendLimitPerHour: 10, markRead: "router", delete: "message" } }), en), null);
    assert.equal(smsOption(noAgentTestPlan(), en), null);
  });

  it("says what ending the test puts back and when the reminder comes", () => {
    const [started, reminder] = agentTestStatus(view(), NOW, "zh-CN", zh);
    assert.equal(
      started,
      "2 小时前开始测试。结束测试会恢复：允许 AI 智能体测试这台路由器；允许智能体改动路由器；智能体的短信权限：读写；智能体发短信：任何号码；令牌「Claude」：改动路由器、发短信、删短信。"
    );
    assert.equal(reminder, "如果到 16:00 还没结束，烽燧会提醒你。");

    const tomorrow = agentTestStatus(view({ settings: ["agentWrites"], tokens: [], remindedAtIso: new Date(NOW).toISOString(), remindAtIso: new Date(NOW + 24 * 3_600_000).toISOString() }), NOW, "en", en);
    assert.deepEqual(tomorrow, ["Started 2h ago. Ending the test puts back: Let agents change the router.", "You were reminded; if the test is still on at 11-11 14:00, you are reminded again."]);
    assert.equal(agentTestStatus(view({ passed: true, remindAtIso: null }), NOW, "en", en)[1], "The test's writes all read back as a match: no reminder.");
    assert.equal(agentTestStatus(view({ acknowledged: true, remindAtIso: null }), NOW, "en", en)[1], "You read the reminder: none follows for this test.");
    assert.equal(agentTestStatus(view({ remindAtIso: null }), NOW, "en", en).length, 1);
    assert.match(agentTestStatus(view({ tokens: [{ id: "t", name: "Ops", permissions: ["access"] }] }), NOW, "en", en)[0] ?? "", /The token “Ops”: manage devices' internet access\./);

    assert.equal(reminderWaiting(null), false);
    assert.equal(reminderWaiting(view()), false, "not reminded yet");
    assert.equal(reminderWaiting(view({ remindedAtIso: new Date(NOW).toISOString() })), true);
    assert.equal(reminderWaiting(view({ remindedAtIso: new Date(NOW).toISOString(), acknowledged: true })), false);
  });

  it("finds the newest reminder among the alerts", () => {
    const alert = (id: string, code: string, tsIso: string): AlertEventRecord => ({ id, tsIso, code, severity: "warning", messageZh: "", messageEn: "" });
    assert.equal(latestAgentTestReminder([alert("w", "WAN_DOWN", "2026-11-10T09:00:00.000Z")]), null);
    const alerts = [alert("r1", "AGENT_TEST_STILL_ON", "2026-11-09T09:00:00.000Z"), alert("r2", "AGENT_TEST_STILL_ON", "2026-11-10T09:00:00.000Z"), alert("w", "WAN_DOWN", "2026-11-10T10:00:00.000Z")];
    assert.equal(latestAgentTestReminder(alerts)?.id, "r2");
    assert.equal(latestAgentTestReminder([...alerts].reverse())?.id, "r2");
  });
});
