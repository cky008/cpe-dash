import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_TEST_ASK_FIRST, AGENT_TEST_READ_TOOLS, AGENT_TEST_WRITE_TOOLS, type AgentTestPlan, type AgentTestView, noAgentTestPlan } from "../src/agent-test.ts";
import type { WriteFeatureState } from "../src/device-access.ts";
import { READ_SECTIONS, type ReadFeature, type ReadSection, WRITE_FEATURES, type WriteFeature, featureRead, sectionFeature } from "../src/features.ts";
import { toolOperation } from "../src/operations/registry.ts";
import { ROUTER_FAMILIES, ROUTER_FAMILY_FACTS, type RouterFamily, familyCapabilities, familyFeatures, isDriverFamily } from "../src/router-family.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { type AgentPromptRouter, agentPromptPlan, agentStartBody, agentTestPrompt, agentTestStatus, defaultAgentToken, reminderWaiting, smsOption, startTurnsOn, tokenGets } from "../web/src/core/agent-test-view.ts";
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

/** The safety rules every prompt carries, in each language. */
const SAFETY = {
  zh: [/只用烽燧的 MCP 工具。不要为了测试直接访问或登录路由器/, /先做完全部只读测试，再做写入测试。每项写入之前先问我/, /每项写入测完马上改回原样/, /SIM 卡的 PIN 一律不测，不要调用 sim_pin/, /每次写入之后调用 get_device_report，看 writes 里这次写入的 readback/, /把原因原样记下，不要换个参数再试/, /不得出现 IMEI、IMSI、ICCID、SIM 卡的 PIN、手机号、IP、MAC、小区标识（小区号、TAC、PCI、频点）、短信内容/, /只有 get_device_report 的报告已经脱敏/, /lastError 说烽燧登不进这台路由器.*就不用往下测了：把 lastError 原样写进报告/],
  en: [/Use FengSui's MCP tools only\. Never reach or log in to the router directly/, /Finish every read test before the first write test\. Ask me before each write/, /put each write back right after its test/, /Never test the SIM PIN, and do not call sim_pin/, /After each write, call get_device_report and read the readback/, /note the reason word for word and do not retry/, /Never put in the report an IMEI, IMSI, ICCID, SIM PIN, phone number, IP or MAC address, a cell's identity \(cell ID, TAC, PCI, channel\), SMS text/, /Only get_device_report's report is desensitized/, /If lastError in get_cpe_session_status says FengSui cannot sign in to this router.*go no further: copy lastError word for word/],
};

/** Names in a prompt that read like an MCP tool's, in the order they appear. */
function toolsIn(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)].map((match) => match[0]);
}

function stepsOf(text: string): string[] {
  return text.split("\n").flatMap((line) => /^(\d+)\. /.exec(line)?.[1] ?? []);
}

/** A router of a brand nobody verified, as the console sees it: the writes FengSui implements for its form open, the reads its form has. */
function routerOf(family: RouterFamily, variant: string | null, states: Partial<Record<WriteFeature, WriteFeatureState>> = {}, sms: Partial<AgentPromptRouter["sms"]> = {}): AgentPromptRouter {
  const facts = familyCapabilities(family, variant);
  const features = Object.fromEntries(WRITE_FEATURES.map((feature) => [feature, states[feature] ?? ((facts.writes as ReadonlyArray<string>).includes(feature) ? "enabled" : "not_implemented")])) as Record<WriteFeature, WriteFeatureState>;
  // As the gate reads it: a brand with a driver has the sections its form documents; a Huawei router has not answered any yet
  const reads = Object.fromEntries(
    READ_SECTIONS.map((section) => {
      const feature = sectionFeature(section);
      return [section, { state: !isDriverFamily(family) ? "unknown" : feature !== null && (facts.reads as ReadonlyArray<string>).includes(feature) ? "unknown" : "unavailable" }];
    })
  ) as Record<ReadSection, { state: string }>;
  return {
    family,
    variant,
    model: "MODEL-1",
    firmware: "1.0.0",
    reads,
    features,
    sms: { available: features.smsWrite === "enabled", markRead: ROUTER_FAMILY_FACTS[family].smsReadState === "fengsui" ? "fengsui" : "router", delete: "message", ...sms },
    issueUrl: "https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+MODEL-1",
    // Every brand reports it but Pinsu, whose interface has no connection state on record
    reportsConnection: family !== "pinsu",
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

  it("builds the prompt for every brand and form: only the tools it has, every safety rule, the same steps in both languages", () => {
    const forms: Array<[RouterFamily, string | null]> = ROUTER_FAMILIES.flatMap((family) => [[family, null] as [RouterFamily, string | null], ...Object.keys(ROUTER_FAMILY_FACTS[family].variants ?? {}).map((variant): [RouterFamily, string | null] => [family, variant])]);
    assert.ok(forms.length >= 13, "every brand, and each form of one");
    for (const [family, variant] of forms) {
      const router = routerOf(family, variant);
      const plan = agentPromptPlan(router);
      const label = `${family}${variant ? `/${variant}` : ""}`;
      const texts = { zh: agentTestPrompt(router, "zh-CN", zh), en: agentTestPrompt(router, "en", en) };
      const tools = { zh: toolsIn(texts.zh), en: toolsIn(texts.en) };
      for (const [locale, text] of Object.entries(texts)) {
        // Every name that reads like a tool is one the daemon serves
        for (const tool of toolsIn(text)) assert.ok(toolOperation(tool), `${label} ${locale}: ${tool}`);
        // A write tool shows only where its write is open here; a read tool only where the router has its section
        for (const { tool } of AGENT_TEST_WRITE_TOOLS) assert.equal(toolsIn(text).includes(tool), plan.writeTools.includes(tool), `${label} ${locale}: ${tool}`);
        for (const { tool } of AGENT_TEST_READ_TOOLS) if (tool !== "get_cpe_telemetry") assert.equal(toolsIn(text).includes(tool), plan.reads.includes(tool), `${label} ${locale}: ${tool}`);
        // The HiLink probe only on Huawei; another brand goes through the device report
        assert.equal(text.includes(locale === "zh" ? "用 probe_router_endpoints 查" : "use probe_router_endpoints to find"), family === "huawei", `${label} ${locale}`);
        assert.ok(text.includes(router.issueUrl) && text.includes(router.model));
      }
      for (const rule of SAFETY.zh) assert.match(texts.zh, rule, `${label}: ${rule}`);
      for (const rule of SAFETY.en) assert.match(texts.en, rule, `${label}: ${rule}`);
      // The same lines and steps, naming the same tools in the same order, in both languages
      assert.equal(texts.zh.split("\n").length, texts.en.split("\n").length, label);
      assert.deepEqual(stepsOf(texts.zh), stepsOf(texts.en), label);
      assert.deepEqual(tools.zh, tools.en, label);
      // What waits for the owner's word is named, in the console's own words for each write
      for (const feature of plan.askFirst) assert.ok(texts.en.includes(en(`feature_${feature}`)), `${label}: ${feature}`);
      assert.deepEqual(plan.askFirst, plan.writes.filter((feature) => AGENT_TEST_ASK_FIRST.has(feature)));
      // The report's table has a row for every feature FengSui implements here, and none for one it does not
      const rows = familyFeatures(family, variant).filter(({ feature, access }) => {
        if (access === "write") return true;
        const read = featureRead(feature as ReadFeature);
        return read === "status" || router.reads[read].state !== "unavailable";
      });
      assert.deepEqual(plan.rows, rows, label);
      for (const { feature, access } of rows) assert.ok(texts.en.includes(`${feature} (${access})`), `${label}: ${feature}`);
      for (const feature of WRITE_FEATURES) if (router.features[feature] === "not_implemented") assert.ok(!texts.en.includes(`${feature} (write)`), `${label}: ${feature}`);
    }
  });

  it("asks of the agent what this router allows, and leaves out what its owner turned off", () => {
    const tplink = agentPromptPlan(routerOf("tplink", "ex"));
    assert.deepEqual([tplink.probe, tplink.nrBand, tplink.accessControl], [false, true, false]);
    assert.deepEqual(tplink.reads, ["get_cpe_telemetry", "list_terminal_topology", "get_cellular_settings", "get_sms_status"], "no nearby cells, router switches or access control on this form");
    assert.ok(tplink.writeTools.includes("lock_cell") && tplink.writeTools.includes("set_apn") && !tplink.writeTools.includes("set_airplane_mode"));
    // No lock on D-Link: no lock tool, and no unlock either
    const dlink = agentPromptPlan(routerOf("dlink", null));
    assert.ok(!dlink.writeTools.some((tool) => ["lock_band", "lock_cell", "unlock_rf_locks"].includes(tool)));
    assert.ok(dlink.askFirst.includes("ussd") && dlink.askFirst.includes("apn"));
    // A Huawei router nobody verified: the HiLink probe, a 4G band lock only, and access control left out of the test
    const huawei = agentPromptPlan(routerOf("huawei", null));
    assert.deepEqual([huawei.probe, huawei.nrBand, huawei.accessControl], [true, false, true]);
    assert.match(agentTestPrompt(routerOf("huawei", null), "en", en), /set_device_internet_access, set_wifi_mac_filter, manage_internet_time_rule\) are no part of this test/);
    assert.doesNotMatch(agentTestPrompt(routerOf("huawei", null), "en", en), /5G band in use/);
    // A cell lock alone still gets its unlock
    const cellOnly = agentPromptPlan(routerOf("tplink", null, { bandLock: "disabled" }));
    assert.ok(cellOnly.writeTools.includes("unlock_rf_locks") && !cellOnly.writeTools.includes("lock_band"));
    assert.deepEqual(cellOnly.disabled, ["bandLock"]);
    // Turned off by its owner: skipped and said so, never asked for
    const off = routerOf("zte-goform", null, { reboot: "disabled", simSlot: "disabled" });
    const offPlan = agentPromptPlan(off);
    assert.ok(!offPlan.writes.includes("reboot") && !offPlan.askFirst.includes("simSlot"));
    assert.deepEqual(offPlan.disabled, ["reboot", "simSlot"]);
    assert.match(agentTestPrompt(off, "zh-CN", zh), /我在「设置 → 设备」关掉了这些写入，跳过不测，写进报告：重启、切换 SIM 卡槽。/);
    assert.ok(!toolsIn(agentTestPrompt(off, "en", en)).includes("reboot_cpe"));
    // SMS where the test cannot send is no part of it; where it can, the steps follow what the router does with SMS
    const noSms = routerOf("tozed", null, {}, { available: false });
    assert.ok(!toolsIn(agentTestPrompt(noSms, "en", en)).includes("send_sms"));
    // Its SMS is still read, and the agent may see no SMS tool at all
    assert.match(agentTestPrompt(noSms, "en", en), /leave SMS out/);
    assert.doesNotMatch(agentTestPrompt(routerOf("dlink", null, {}, { available: false }), "en", en).replace(/get_sms_status/g, ""), /send_sms/);
    const tozed = agentTestPrompt(routerOf("tozed", null, {}, { available: true, markRead: "fengsui", delete: "none" }), "en", en);
    assert.match(tozed, /FengSui keeps this router's read state itself/);
    assert.match(tozed, /skip deleting: this router cannot delete messages/);
    assert.ok(!toolsIn(tozed).includes("delete_sms"), "no delete tool where the router cannot delete");
    assert.match(agentTestPrompt(routerOf("fiberhome", null, {}, { available: true, markRead: "router", delete: "conversation" }), "zh-CN", zh), /只能整段对话一起删/);
    // The firmware, where the router named none
    assert.match(agentTestPrompt({ ...routerOf("openwrt", null), firmware: null }, "zh-CN", zh), /固件 未知。/);
  });

  it("promises the 3-minute rollback only where the router says whether it is connected", () => {
    const pinsu = routerOf("pinsu", null);
    for (const locale of ["zh-CN", "en"] as const) {
      const t = locale === "en" ? en : zh;
      const text = agentTestPrompt(pinsu, locale, t);
      // Its band lock, cell lock and network mode are tested, and none of them says FengSui puts it back
      assert.doesNotMatch(text, locale === "en" ? /Should the WAN stay down 3 minutes/ : /断网 3 分钟没恢复，烽燧会/);
      assert.equal(text.split(t("agent_prompt_rollback_none")).length - 1, 3, "after the band lock, the cell lock and the network mode");
      // A router that reports it keeps each write's own sentence
      const zte = agentTestPrompt(routerOf("zte-goform", null), locale, t);
      assert.ok(zte.includes(t("agent_prompt_rollback_cellLock")) && zte.includes(t("agent_prompt_rollback_networkMode")) && !zte.includes(t("agent_prompt_rollback_none")));
    }
  });

  it("finds the newest reminder among the alerts", () => {
    const alert = (id: string, code: string, tsIso: string): AlertEventRecord => ({ id, tsIso, code, severity: "warning", messageZh: "", messageEn: "" });
    assert.equal(latestAgentTestReminder([alert("w", "WAN_DOWN", "2026-11-10T09:00:00.000Z")]), null);
    const alerts = [alert("r1", "AGENT_TEST_STILL_ON", "2026-11-09T09:00:00.000Z"), alert("r2", "AGENT_TEST_STILL_ON", "2026-11-10T09:00:00.000Z"), alert("w", "WAN_DOWN", "2026-11-10T10:00:00.000Z")];
    assert.equal(latestAgentTestReminder(alerts)?.id, "r2");
    assert.equal(latestAgentTestReminder([...alerts].reverse())?.id, "r2");
  });
});
