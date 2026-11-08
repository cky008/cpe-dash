import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig, resolveDaemonMcpUrl } from "../src/config.ts";
import {
  BRIDGE_DAEMON_REJECTED,
  BRIDGE_DAEMON_UNREACHABLE,
  McpStdioBridge,
  attachNdjsonLineReader,
} from "../src/mcp-stdio-bridge.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

interface RpcLine {
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function capture(output: PassThrough): RpcLine[] {
  const lines: RpcLine[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) lines.push(JSON.parse(line) as RpcLine);
    }
  });
  return lines;
}

async function settle(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("cpe-dash mcp: zero-state stdio bridge to the serve daemon", () => {
  it("imports nothing that could open a CPE session or touch the encrypted stores", () => {
    const source = fs.readFileSync(fileURLToPath(new URL("../src/mcp-stdio-bridge.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ["./http-body.ts", "./json-safe.ts", "./mcp-headers.ts", "node:stream"]);
  });

  it("forwards stdio JSON-RPC to the daemon's /mcp, sharing its one CPE session scheduler", async () => {
    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-bridge-");
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "CPE_URL=http://192.168.8.1",
        `CPE_PASSWORD=${cpe.password}`,
        "API_TOKEN=bridge_api_token_v1",
        "DATA_ENCRYPTION_KEY=bridge_data_key",
        "WEB_HOST=127.0.0.1",
        "WEB_PORT=0",
        `STATE_FILE=${path.join(dir, "data", "state.json")}`,
        "POLL_INTERVAL_MS=600000",
        "NEIGHBOR_SCAN_INTERVAL_MS=600000",
      ].join("\n")
    );
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const daemon = createFengSuiRuntime({ config, envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await daemon.httpServer.listen();
      const sentHeaders: Array<Record<string, string>> = [];
      const spyFetch: typeof fetch = async (input, init) => {
        sentHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
        return await fetch(input, init);
      };
      const bridge = new McpStdioBridge({
        daemonUrl: resolveDaemonMcpUrl(undefined, "127.0.0.1", bound.port),
        apiToken: config.apiToken,
        fetchImpl: spyFetch,
      });
      const input = new PassThrough();
      const output = new PassThrough();
      const lines = capture(output);
      const session = bridge.attach(input, output);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
      await settle(() => lines.length === 1, "initialize");
      assert.equal(lines[0]?.result?.["protocolVersion"], "2025-11-25");

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n   \n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tl", method: "tools/list" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_cpe_telemetry", arguments: { refresh: true } } })}\n`);
      await settle(() => lines.length === 3, "tools/list + tools/call");
      const byId = new Map(lines.map((l) => [l.id, l]));
      assert.ok((byId.get("tl")?.result?.["tools"] as unknown[]).length > 5);
      const telemetryCall = byId.get(3)?.result as { isError: boolean; structuredContent: { telemetry: unknown } };
      assert.equal(telemetryCall.isError, false);
      assert.ok(telemetryCall.structuredContent.telemetry, "the daemon polled the router for the agent");
      assert.equal(cpe.stats.logins, 1, "exactly the daemon's own session");
      assert.equal(cpe.stats.overlapLoginAttempts, 0);
      assert.equal(sentHeaders[0]?.["mcp-protocol-version"], undefined, "initialize carries no version header");
      assert.ok(sentHeaders.slice(1).every((h) => h["mcp-protocol-version"] === "2025-11-25"));
      assert.ok(sentHeaders.every((h) => h["authorization"] === "Bearer bridge_api_token_v1"));

      // Oversized frames are rejected locally, then the stream recovers
      input.write(`${"x".repeat(65 * 1024)}\n${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" })}\n`);
      await settle(() => lines.length === 5, "oversized frame + ping");
      assert.equal(lines[3]?.error?.code, -32600);
      assert.deepEqual(lines[4]?.result, {});

      // A daemon rejection (wrong token) becomes a JSON-RPC error for that id
      const wrongToken = new McpStdioBridge({ daemonUrl: bridge.daemonUrl, apiToken: "nope" });
      const rejected = JSON.parse((await wrongToken.forward(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }))) ?? "{}") as RpcLine;
      assert.equal(rejected.id, 9);
      assert.equal(rejected.error?.code, BRIDGE_DAEMON_REJECTED);
      assert.match(rejected.error?.message ?? "", /HTTP 401 UNAUTHORIZED/);
      assert.equal(await wrongToken.forward(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);

      session.detach();
      await session.drained();
    } finally {
      await daemon.close();
      removeTempDir(dir);
    }
  });

  it("answers every request even when the daemon is down, and survives a closed stdout", async () => {
    const bridge = new McpStdioBridge({
      daemonUrl: "http://127.0.0.1:9/mcp",
      apiToken: "t",
      fetchImpl: async () => {
        throw new TypeError("fetch failed (connect ECONNREFUSED 127.0.0.1:9)");
      },
    });
    const down = JSON.parse((await bridge.forward(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" }))) ?? "{}") as RpcLine;
    assert.equal(down.id, "a");
    assert.equal(down.error?.code, BRIDGE_DAEMON_UNREACHABLE);
    assert.match(down.error?.message ?? "", /Start "cpe-dash serve"/);
    assert.equal(await bridge.forward(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" })), null);
    const malformed = JSON.parse((await bridge.forward("{not json")) ?? "{}") as RpcLine;
    assert.equal(malformed.error?.code, BRIDGE_DAEMON_UNREACHABLE, "malformed lines still get an answer");

    const input = new PassThrough();
    const output = new PassThrough();
    const session = bridge.attach(input, output);
    output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    await session.drained();
    session.detach();
  });

  it("frames NDJSON across chunks and discards newline-less floods until the next newline", () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let oversized = 0;
    const detach = attachNdjsonLineReader(input, { onLine: (l) => lines.push(l), onOversized: () => (oversized += 1) }, 16);
    input.write('{"a":');
    input.write("1}\n\n  \n");
    input.write("y".repeat(40));
    input.write("still discarding");
    input.write('\n{"b":2}\n');
    input.write(`${"z".repeat(20)}\n`);
    detach();
    input.write('{"c":3}\n');
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    assert.equal(oversized, 2);
  });

  it("derives the daemon URL from WEB_HOST/WEB_PORT and validates MCP_DAEMON_URL", () => {
    assert.equal(resolveDaemonMcpUrl(undefined, "0.0.0.0", 18384), "http://127.0.0.1:18384/mcp");
    assert.equal(resolveDaemonMcpUrl("", "::", 18384), "http://127.0.0.1:18384/mcp");
    assert.equal(resolveDaemonMcpUrl(undefined, "192.168.8.10", 18384), "http://192.168.8.10:18384/mcp");
    assert.equal(resolveDaemonMcpUrl(undefined, "::1", 18384), "http://[::1]:18384/mcp");
    assert.equal(resolveDaemonMcpUrl("http://nas.lan:18384", "0.0.0.0", 1), "http://nas.lan:18384/mcp");
    assert.equal(resolveDaemonMcpUrl("https://100.64.0.7/fengsui/mcp", "0.0.0.0", 1), "https://100.64.0.7/fengsui/mcp");
    assert.throws(() => resolveDaemonMcpUrl("ftp://192.168.8.10/mcp", "0.0.0.0", 1), /http\(s\)/);
    assert.throws(() => resolveDaemonMcpUrl("http://user:pw@192.168.8.10/mcp", "0.0.0.0", 1), /credentials/);
    assert.throws(() => resolveDaemonMcpUrl("http://203.0.113.10/mcp", "0.0.0.0", 1), /not a private\/LAN address/);
    assert.equal(loadConfig({ ignoreProcessEnv: true, envPath: "/nonexistent/.env" }).mcpDaemonUrl, "http://127.0.0.1:18384/mcp");
  });
});
