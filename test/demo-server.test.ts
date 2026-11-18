import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { demoServerEnv, startDemoDaemon } from "../scripts/demo-router.ts";

/**
 * `npm run demo` (scripts/demo-server.ts): the real daemon against the simulated router. Its AI agent
 * tools that change the router stay off, as in any install, unless `DEMO_MCP_WRITES=true` turns them on;
 * a directory's check (Glama) then sees the full set, and every write still reaches the simulated router
 * only.
 */

const TOKEN = "demo-server-test-token";

async function toolNames(baseUrl: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const json = (await res.json()) as { result?: { tools: Array<{ name: string }> } };
  return (json.result?.tools ?? []).map((tool) => tool.name);
}

describe("npm run demo", () => {
  it("turns the agent tools that change the router on only with DEMO_MCP_WRITES=true", () => {
    assert.equal(demoServerEnv({}), undefined);
    assert.equal(demoServerEnv({ DEMO_MCP_WRITES: "false" }), undefined);
    assert.equal(demoServerEnv({ DEMO_MCP_WRITES: "yes" }), undefined);
    assert.deepEqual(demoServerEnv({ DEMO_MCP_WRITES: "true" }), { MCP_ALLOW_MUTATIONS: "true", MCP_ALLOW_ACCESS_CONTROL: "true", MCP_SMS_ACCESS: "full" });
  });

  it("lists the read tools by default, and the write tools too with DEMO_MCP_WRITES=true", async () => {
    for (const [processEnv, writes] of [[{}, false], [{ DEMO_MCP_WRITES: "true" }, true]] as const) {
      const env = demoServerEnv(processEnv);
      const demo = await startDemoDaemon({ port: 0, token: TOKEN, ...(env ? { env } : {}) });
      try {
        const names = await toolNames(demo.baseUrl);
        assert.ok(names.includes("get_cpe_telemetry"), "the read tools either way");
        for (const tool of ["lock_band", "lock_cell", "reboot_cpe", "set_wifi_mac_filter", "send_sms", "set_network_mode"]) {
          assert.equal(names.includes(tool), writes, `${tool} with DEMO_MCP_WRITES=${writes}`);
        }
      } finally {
        await demo.close();
      }
    }
  });
});
