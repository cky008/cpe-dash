import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTestResponse, AuditResponse, CreateTokenResponse, ExperimentalWritesResponse, SessionStatusResponse } from "../src/api-contract.ts";
import { startDemoDaemon } from "../scripts/demo-router.ts";
import { noAgentTestPlan } from "../src/agent-test.ts";

/**
 * The AI agent test at one click through the daemon's own API: the console sees the plan with the
 * agent's token (the one that called MCP last), starts and ends the test, and nothing else may. The
 * demo world's B535-232 (a model nobody verified), placeholders only.
 */

const TOKEN = "fengsui-demo-agent-test";
const MODEL = "B535-232";

describe("the AI agent test over the console's API", () => {
  it("starts with the agent's token from a console session only, opens the agent's tools, and ends by putting everything back", async () => {
    const demo = await startDemoDaemon({ port: 0, token: TOKEN, scenario: "unverified" });
    const base = demo.baseUrl;
    const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    const consoleHeaders = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, Cookie: cookie });
    try {
      const deadline = Date.now() + 8000;
      while ((((await (await fetch(`${base}/api/session/status`, { headers: bearer(TOKEN) })).json()) as SessionStatusResponse).status.device.writes) !== "experimental") {
        assert.ok(Date.now() < deadline, "identified after start");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: consoleHeaders(""), body: JSON.stringify({ password: TOKEN }) });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const post = async (route: string, body: unknown, headers: Record<string, string> = consoleHeaders(cookie)) => fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
      const view = async (): Promise<ExperimentalWritesResponse> => (await (await fetch(`${base}/api/console/experimental`, { headers: { Cookie: cookie } })).json()) as ExperimentalWritesResponse;
      const mcpTools = async (token: string): Promise<string[]> => {
        const res = (await (await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, bearer(token))).json()) as { result: { tools: Array<{ name: string }> } };
        return res.result.tools.map((tool) => tool.name);
      };

      const before = await view();
      assert.deepEqual([before.agentTest.current, before.agentTest.plan.available], [null, true]);
      assert.deepEqual(before.agentTest.plan.settings, ["agentExperimental", "agentWrites"]);
      assert.deepEqual(before.agentTest.plan.sms, { available: true, settings: ["agentSms", "agentSmsSendPolicy"], sendLimitPerHour: 10 });
      // The writes are on before any test: nothing for it to turn on
      assert.deepEqual([before.device.features.bandLock, before.device.features.smsWrite, before.disabled], ["enabled", "enabled", []]);
      assert.deepEqual([before.agentTest.plan.tokens, before.agentTest.plan.tokenNeeded], [[], false], "the imported API_TOKEN may do everything already");

      // The agent connects with a read-only token from the connection guide
      const minted = (await (await post("/api/console/tokens", { name: "Claude", permissions: ["sms-read"], lifetimeDays: 1 })).json()) as CreateTokenResponse;
      await mcpTools(TOKEN);
      assert.equal((await mcpTools(minted.token)).includes("lock_band"), false);
      const plan = (await view()).agentTest.plan;
      assert.deepEqual([plan.tokens.map((t) => [t.name, t.missing]), plan.suggestedTokenId, plan.tokenNeeded], [[["Claude", ["control", "sms-write"]]], minted.record.id, true]);
      assert.ok(plan.tokens[0]?.agentUsedAtIso, "seen on MCP");

      // Only the console starts it, for the model it showed, with a token it offered
      const asToken = await post("/api/console/agent-test", { action: "start", model: MODEL }, bearer(TOKEN));
      assert.deepEqual([asToken.status, ((await asToken.json()) as { errorCode: string }).errorCode], [403, "CONSOLE_ONLY"]);
      for (const body of [{}, { action: "go" }, { action: "start" }, { action: "start", model: "H168-383" }, { action: "start", model: MODEL, tokenId: "nope" }, { action: "start", model: MODEL, sms: "yes" }, { action: "ack", alertId: 7 }]) {
        const refused = await post("/api/console/agent-test", body);
        assert.deepEqual([refused.status, ((await refused.json()) as { errorCode: string }).errorCode], [400, "VALIDATION_ERROR"], JSON.stringify(body));
      }
      assert.equal((await view()).agentTest.current, null, "nothing changed");

      const started = await post("/api/console/agent-test", { action: "start", model: MODEL.toLowerCase(), tokenId: minted.record.id, sms: true });
      assert.equal(started.status, 200);
      const on = (await started.json()) as AgentTestResponse;
      assert.deepEqual(on.agentTest.current?.settings, ["agentExperimental", "agentWrites", "agentSms", "agentSmsSendPolicy"]);
      assert.deepEqual(on.agentTest.current?.tokens.map((t) => [t.name, t.permissions]), [["Claude", ["control", "sms-write"]]]);
      const behaviour = on.settings.behaviour;
      assert.deepEqual([behaviour.agentWrites.value, behaviour.agentWrites.source, behaviour.agentExperimental.value, behaviour.agentSms.value, behaviour.agentSmsSendPolicy.value], [true, "console", true, "full", "any"]);
      assert.deepEqual([on.device.features.bandLock, on.device.features.smsWrite, on.disabled.length], ["enabled", "enabled", 0]);
      assert.equal(on.agentTest.current?.remindAtIso, new Date(Date.parse(on.agentTest.current?.lastActivityAtIso ?? "") + 3 * 3_600_000).toISOString());
      const tools = await mcpTools(minted.token);
      for (const tool of ["lock_band", "unlock_rf_locks", "reconnect_cellular", "reboot_cpe", "probe_router_endpoints", "set_experimental_write", "send_sms", "mark_sms_read", "delete_sms"]) assert.ok(tools.includes(tool), tool);

      // The number the owner gives the agent: the known-only rule would refuse it, the test lets it through
      const sent = (await (
        await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send_sms", arguments: { phone: "+447700900123", content: "FengSui test", confirm: true } } }, bearer(minted.token))
      ).json()) as { result: { isError: boolean; structuredContent: { ok?: boolean; errorCode?: string } } };
      assert.deepEqual([sent.result.isError, sent.result.structuredContent.ok], [false, true], JSON.stringify(sent.result.structuredContent));

      const audit = (await (await fetch(`${base}/api/audit?limit=5`, { headers: { Cookie: cookie } })).json()) as AuditResponse;
      const entry = audit.entries.find((e) => e.action === "agents.test");
      assert.deepEqual([entry?.channel, entry?.outcome], ["web", "applied"]);
      assert.match(entry?.detail ?? "", /^start for B535-232 with SMS: MCP_ALLOW_EXPERIMENTAL true, MCP_ALLOW_MUTATIONS true, MCP_SMS_ACCESS full, MCP_SMS_SEND_POLICY any, token "Claude" \+ control \+ sms-write$/);

      // No reminder yet: reading one changes nothing
      const ack = (await (await post("/api/console/agent-test", { action: "ack", alertId: "a1" })).json()) as AgentTestResponse;
      assert.equal(ack.agentTest.current?.acknowledged, false);

      const ended = (await (await post("/api/console/agent-test", { action: "end" })).json()) as AgentTestResponse;
      assert.equal(ended.agentTest.current, null);
      assert.deepEqual([ended.settings.behaviour.agentWrites.source, ended.settings.behaviour.agentSms.source, ended.settings.behaviour.agentSmsSendPolicy.source], ["env", "env", "env"]);
      assert.deepEqual([ended.device.features.bandLock, ended.device.features.smsWrite, ended.disabled], ["enabled", "enabled", []], "the writes are as they were: ending the test turns none off");
      assert.deepEqual([ended.agentTest.plan.settings, ended.agentTest.plan.sms.settings], [["agentExperimental", "agentWrites"], ["agentSms", "agentSmsSendPolicy"]], "ready to start again");
      const after = await mcpTools(minted.token);
      assert.deepEqual([after.includes("lock_band"), after.includes("send_sms")], [false, false], "the agent's token reads only again");
      const refused = (await (
        await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_sms", arguments: { phone: "+447700900124", content: "FengSui test", confirm: true } } }, bearer(minted.token))
      ).json()) as { result: { structuredContent: { errorCode?: string } } };
      assert.equal(refused.result.structuredContent.errorCode, "READ_ONLY_TOKEN", "no SMS sending after the test");
    } finally {
      await demo.close();
    }
  });

  it("refuses to start on the verified model", async () => {
    const demo = await startDemoDaemon({ port: 0, token: TOKEN });
    const base = demo.baseUrl;
    const headers = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, Cookie: cookie });
    try {
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: headers(""), body: JSON.stringify({ password: TOKEN }) });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const deadline = Date.now() + 8000;
      while ((((await (await fetch(`${base}/api/console/experimental`, { headers: { Cookie: cookie } })).json()) as ExperimentalWritesResponse).device.writes) !== "allowed") {
        assert.ok(Date.now() < deadline, "identified after start");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const view = (await (await fetch(`${base}/api/console/experimental`, { headers: { Cookie: cookie } })).json()) as ExperimentalWritesResponse;
      assert.deepEqual(view.agentTest, { current: null, plan: noAgentTestPlan() });
      const refused = await fetch(`${base}/api/console/agent-test`, { method: "POST", headers: headers(cookie), body: JSON.stringify({ action: "start", model: "H168-383" }) });
      assert.deepEqual([refused.status, ((await refused.json()) as { errorCode: string }).errorCode], [409, "AGENT_TEST_UNAVAILABLE"]);
      const ended = await fetch(`${base}/api/console/agent-test`, { method: "POST", headers: headers(cookie), body: JSON.stringify({ action: "end" }) });
      assert.equal(ended.status, 200, "nothing to end");
    } finally {
      await demo.close();
    }
  });
});
