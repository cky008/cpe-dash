import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { McpStdioBridge } from "../src/mcp-stdio-bridge.ts";
import { LATEST_LEGACY_MCP_PROTOCOL_VERSION, SUPPORTED_MCP_PROTOCOL_VERSIONS } from "../src/mcp-server.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";

const MODERN = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

async function withDaemon(run: (ctx: { baseUrl: string; rpc: (body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }> }) => Promise<void>): Promise<void> {
  const cpe = createStrictCpe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-mcp-modern-"));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "CPE_URL=http://192.168.8.1",
      `CPE_PASSWORD=${cpe.password}`,
      "API_TOKEN=modern_api_token",
      "DATA_ENCRYPTION_KEY=modern_data_key",
      "WEB_HOST=127.0.0.1",
      "WEB_PORT=0",
      `STATE_FILE=${path.join(dir, "data", "state.json")}`,
      "POLL_INTERVAL_MS=600000",
      "NEIGHBOR_SCAN_INTERVAL_MS=600000",
      "SMS_ENABLED=false",
    ].join("\n")
  );
  const daemon = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
  try {
    const bound = await daemon.httpServer.listen();
    const baseUrl = `http://${bound.host}:${bound.port}/mcp`;
    const rpc = async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { Authorization: "Bearer modern_api_token", "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: res.status === 202 ? null : await res.json() };
    };
    await run({ baseUrl, rpc });
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const modern = (id: number, method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params: { ...params, _meta: { [META_VERSION]: MODERN, "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" } } },
});

describe("MCP 2026-07-28 (stateless) alongside the legacy initialize flow", () => {
  it("advertises both eras and keeps initialize on the latest legacy revision", () => {
    assert.equal(SUPPORTED_MCP_PROTOCOL_VERSIONS[0], MODERN);
    assert.ok(SUPPORTED_MCP_PROTOCOL_VERSIONS.includes("2025-11-25"));
    assert.equal(LATEST_LEGACY_MCP_PROTOCOL_VERSION, "2025-11-25");
  });

  it("serves server/discover and stateless tools/call over HTTP with validated routing headers", async () => {
    await withDaemon(async ({ rpc }) => {
      const discover = await rpc(modern(1, "server/discover"), { "MCP-Protocol-Version": MODERN, "Mcp-Method": "server/discover" });
      assert.equal(discover.status, 200);
      assert.equal(discover.json.result.resultType, "complete");
      assert.deepEqual(discover.json.result.supportedVersions, [...SUPPORTED_MCP_PROTOCOL_VERSIONS]);
      assert.ok(discover.json.result.capabilities.tools);
      assert.equal(discover.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "fengsui-cpe-dash");

      // No initialize needed: every request carries its version
      const call = await rpc(modern(2, "tools/call", { name: "get_cpe_session_status", arguments: {} }), {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "get_cpe_session_status",
      });
      assert.equal(call.status, 200);
      assert.equal(call.json.result.resultType, "complete");
      assert.equal(call.json.result.isError, false);
      assert.equal(call.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "fengsui-cpe-dash");

      const encoded = `=?base64?${Buffer.from("get_cpe_session_status", "utf8").toString("base64")}?=`;
      const sentinel = await rpc(modern(3, "tools/call", { name: "get_cpe_session_status", arguments: {} }), {
        "MCP-Protocol-Version": MODERN,
        "Mcp-Method": "tools/call",
        "Mcp-Name": encoded,
      });
      assert.equal(sentinel.status, 200, "Base64 sentinel Mcp-Name values are decoded before comparison");

      const list = await rpc(modern(4, "tools/list"), { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" });
      assert.equal(list.json.result.resultType, "complete");
      assert.ok(list.json.result.tools.length > 5);
    });
  });

  it("rejects mismatched or missing routing headers (400 -32020) and unknown versions (400 -32022)", async () => {
    await withDaemon(async ({ rpc }) => {
      const cases: Array<[string, Record<string, string>, unknown]> = [
        ["missing Mcp-Method", { "MCP-Protocol-Version": MODERN }, modern(10, "tools/list")],
        ["Mcp-Method mismatch", { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" }, modern(11, "tools/list")],
        [
          "Mcp-Name mismatch",
          { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call", "Mcp-Name": "reboot_cpe" },
          modern(12, "tools/call", { name: "get_cpe_session_status", arguments: {} }),
        ],
        ["missing Mcp-Name", { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/call" }, modern(13, "tools/call", { name: "get_cpe_session_status", arguments: {} })],
        ["missing version header", { "Mcp-Method": "tools/list" }, modern(14, "tools/list")],
        ["header/_meta version mismatch", { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/list" }, modern(15, "tools/list")],
        ["modern header, legacy body", { "MCP-Protocol-Version": MODERN, "Mcp-Method": "tools/list" }, { jsonrpc: "2.0", id: 16, method: "tools/list" }],
      ];
      for (const [label, headers, body] of cases) {
        const res = await rpc(body, headers);
        assert.equal(res.status, 400, label);
        assert.equal(res.json.error.code, -32020, label);
      }

      const unsupported = await rpc({ ...modern(20, "tools/list"), params: { _meta: { [META_VERSION]: "1999-01-01" } } }, { "MCP-Protocol-Version": "1999-01-01", "Mcp-Method": "tools/list" });
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.json.error.code, -32022);
      assert.deepEqual(unsupported.json.error.data, { supported: [...SUPPORTED_MCP_PROTOCOL_VERSIONS], requested: "1999-01-01" });

      const unknown = await rpc(modern(21, "prompts/list"), { "MCP-Protocol-Version": MODERN, "Mcp-Method": "prompts/list" });
      assert.equal(unknown.status, 404, "modern unknown methods are 404 so clients can tell a modern server");
      assert.equal(unknown.json.error.code, -32601);

      // Legacy clients keep the old behaviour (no routing headers, no resultType)
      const legacy = await rpc({ jsonrpc: "2.0", id: 30, method: "tools/list" }, { "MCP-Protocol-Version": "2025-11-25" });
      assert.equal(legacy.status, 200);
      assert.equal(legacy.json.result.resultType, undefined);
      const legacyUnknown = await rpc({ jsonrpc: "2.0", id: 31, method: "prompts/list" });
      assert.equal(legacyUnknown.status, 200);
      assert.equal(legacyUnknown.json.error.code, -32601);
      const init = await rpc({ jsonrpc: "2.0", id: 32, method: "initialize", params: { protocolVersion: MODERN, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(init.json.result.protocolVersion, "2025-11-25", "initialize is the legacy flow and never negotiates the stateless revision");
    });
  });

  it("lets the stdio bridge carry modern requests with the required routing headers", async () => {
    await withDaemon(async ({ baseUrl }) => {
      const seen: Array<Record<string, string>> = [];
      const bridge = new McpStdioBridge({
        daemonUrl: baseUrl,
        apiToken: "modern_api_token",
        fetchImpl: async (input, init) => {
          seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
          return await fetch(input, init);
        },
      });
      const out = JSON.parse((await bridge.forward(JSON.stringify(modern(1, "tools/call", { name: "get_cpe_session_status", arguments: {} })))) ?? "{}") as {
        result?: { resultType: string };
      };
      assert.equal(out.result?.resultType, "complete");
      assert.equal(seen[0]?.["mcp-protocol-version"], MODERN);
      assert.equal(seen[0]?.["mcp-method"], "tools/call");
      assert.equal(seen[0]?.["mcp-name"], "get_cpe_session_status");
      const nonAscii = JSON.parse((await bridge.forward(JSON.stringify(modern(2, "resources/read", { uri: "fengsui://session/status" })))) ?? "{}") as {
        result?: { resultType: string };
      };
      assert.equal(nonAscii.result?.resultType, "complete");
      assert.equal(seen[1]?.["mcp-name"], "fengsui://session/status");
    });
  });
});
