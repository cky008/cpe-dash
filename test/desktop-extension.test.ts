import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { EXTENSION_SETTINGS_PLACE, type ExtensionProcess, readExtensionSettings, startDesktopExtension } from "../src/desktop-extension.ts";
import { BRIDGE_DAEMON_REJECTED, BRIDGE_DAEMON_UNREACHABLE, BRIDGE_NOT_SET_UP } from "../src/mcp-stdio-bridge.ts";

/**
 * The Claude Desktop extension's entry (src/desktop-extension.ts): the stdio bridge, set up from the two variables
 * Desktop passes (MCP_DAEMON_URL, API_TOKEN) and nothing else. The packed extension is run end to end in
 * test/mcpb.test.ts. Addresses are RFC placeholders (AGENTS.md 铁律二): 192.168.8.0/24 for the LAN, 100.64.0.10 for
 * Tailscale, 203.0.113.10 for the internet; the tokens are made up.
 */

const TOKEN = "fs_desktop_extension_test_token";

interface RpcLine {
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** A stand-in for `process`: its stdio, the environment Desktop passes, and what exit() was called with. */
function fakeProcess(env: Record<string, string>): Omit<ExtensionProcess, "stdin"> & { stdin: PassThrough; lines(): RpcLine[]; stdoutText(): string; stderrText(): string; exited: Promise<number> } {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
  let exit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  return {
    env,
    stdin,
    stdout,
    stderr,
    once: () => undefined,
    exit: (code?: number) => exit(code ?? 0),
    lines: () =>
      out
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as RpcLine),
    stdoutText: () => out,
    stderrText: () => err,
    exited,
  };
}

async function settle(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } })}\n`;

describe("Claude Desktop extension: its settings", () => {
  it("takes the FengSui MCP address on the LAN or Tailscale, or any https address, adding /mcp to a bare address", () => {
    assert.deepEqual(readExtensionSettings({ MCP_DAEMON_URL: "http://192.168.8.10:18384/mcp", API_TOKEN: TOKEN }), { ok: true, daemonUrl: "http://192.168.8.10:18384/mcp", apiToken: TOKEN });
    assert.deepEqual(readExtensionSettings({ MCP_DAEMON_URL: "  http://100.64.0.10:18384  ", API_TOKEN: ` ${TOKEN} ` }), { ok: true, daemonUrl: "http://100.64.0.10:18384/mcp", apiToken: TOKEN });
    assert.deepEqual(readExtensionSettings({ MCP_DAEMON_URL: "https://100.64.0.10/fengsui/mcp", API_TOKEN: TOKEN }), { ok: true, daemonUrl: "https://100.64.0.10/fengsui/mcp", apiToken: TOKEN });
    // Behind an HTTPS reverse proxy: its domain, or a public address, the token encrypted on the way
    assert.deepEqual(readExtensionSettings({ MCP_DAEMON_URL: "https://cpe.example.com", API_TOKEN: TOKEN }), { ok: true, daemonUrl: "https://cpe.example.com/mcp", apiToken: TOKEN });
    assert.deepEqual(readExtensionSettings({ MCP_DAEMON_URL: "https://203.0.113.10:8443/mcp", API_TOKEN: TOKEN }), { ok: true, daemonUrl: "https://203.0.113.10:8443/mcp", apiToken: TOKEN });
  });

  it("refuses plain http to an address on the internet, a scheme other than http(s), credentials, and what is not a URL", () => {
    for (const [url, why] of [
      ["http://203.0.113.10:18384/mcp", /"203\.0\.113\.10" is not a private\/LAN address; plain http:\/\/ goes only to LAN, private and Tailscale hosts \(use https:\/\//],
      ["http://cpe.example.com:18384/mcp", /"cpe\.example\.com" is not a private\/LAN address/],
      ["https://user:pw@cpe.example.com/mcp", /must not contain credentials/],
      ["ftp://192.168.8.10/mcp", /must use http\(s\)/],
      ["http://admin:pw@192.168.8.10:18384/mcp", /must not contain credentials/],
      ["http://192.168.8.10:18384/mcp?token=x", /must not contain credentials, a query/],
      ["192.168.8.10:18384", /must use http\(s\)|is not a URL/],
      ["not an address", /is not a URL/],
    ] as const) {
      const settings = readExtensionSettings({ MCP_DAEMON_URL: url, API_TOKEN: TOKEN });
      assert.equal(settings.ok, false, url);
      if (!settings.ok) {
        assert.match(settings.problem, why, url);
        assert.match(settings.problem, /^the FengSui MCP address /, "names the setting the person sees in Desktop");
      }
    }
  });

  it("says which setting is missing, and treats a placeholder Desktop left unfilled as missing", () => {
    const missing = (env: Record<string, string>): string => {
      const settings = readExtensionSettings(env);
      assert.equal(settings.ok, false);
      return settings.ok ? "" : settings.problem;
    };
    assert.match(missing({ API_TOKEN: TOKEN }), /the FengSui MCP address is empty/);
    assert.match(missing({ MCP_DAEMON_URL: " ", API_TOKEN: TOKEN }), /the FengSui MCP address is empty/);
    assert.match(missing({ MCP_DAEMON_URL: "${user_config.daemon_url}", API_TOKEN: TOKEN }), /the FengSui MCP address is empty/);
    assert.match(missing({ MCP_DAEMON_URL: "http://192.168.8.10:18384/mcp" }), /the token is empty/);
    assert.match(missing({ MCP_DAEMON_URL: "http://192.168.8.10:18384/mcp", API_TOKEN: "${user_config.api_token}" }), /the token is empty/);
  });

  it("refuses a token no HTTP header can carry, without repeating it", () => {
    for (const token of ["fs bad token", "fs_bad\ntoken", "fs_令牌", "x".repeat(4097)]) {
      const settings = readExtensionSettings({ MCP_DAEMON_URL: "http://192.168.8.10:18384/mcp", API_TOKEN: token });
      assert.equal(settings.ok, false);
      if (!settings.ok) {
        assert.match(settings.problem, /the token /);
        assert.ok(!settings.problem.includes(token.trim()), "the problem never quotes the token");
      }
    }
  });

  it("reads only the two variables Desktop passes, never a file", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", "desktop-extension.ts"), "utf8");
    const imports = [...source.matchAll(/^import (?!type )[^\n]* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(imports, ["./lan-address.ts", "./mcp-stdio-bridge.ts"], "the code it runs");
    const types = [...source.matchAll(/^import type [^\n]* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(types, ["node:stream"], "types only, erased when it is built");
    assert.doesNotMatch(source, /process\.env|node:fs|readFile/, "the environment comes in as an argument");
  });
});

describe("Claude Desktop extension: running", () => {
  it("answers every request with where to set it up, forwarding nothing, until the settings are right", async () => {
    let fetched = 0;
    const proc = fakeProcess({ MCP_DAEMON_URL: "http://203.0.113.10:18384/mcp", API_TOKEN: TOKEN });
    startDesktopExtension(proc, {
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("must not be called");
      },
    });
    proc.stdin.write(initialize);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tl", method: "tools/list" })}\n{not json\n`);
    await settle(() => proc.lines().length === 3, "three answers");
    const [first, second, third] = proc.lines();
    assert.equal(first?.id, 1);
    assert.equal(second?.id, "tl");
    assert.equal(third?.id, null, "a malformed line still gets its answer");
    for (const line of [first, second, third]) {
      assert.equal(line?.error?.code, BRIDGE_NOT_SET_UP);
      assert.match(line?.error?.message ?? "", /^FengSui extension is not set up: the FengSui MCP address host "203\.0\.113\.10" is not a private\/LAN address; /);
      assert.match(line?.error?.message ?? "", /or its https:\/\/ address behind an HTTPS reverse proxy/);
      assert.ok(line?.error?.message.includes(EXTENSION_SETTINGS_PLACE), "says where to fix it");
    }
    assert.equal(fetched, 0);
    assert.match(proc.stderrText(), /not set up/);
    proc.stdin.end();
    assert.equal(await proc.exited, 0);
    assert.ok(!proc.stdoutText().includes(TOKEN) && !proc.stderrText().includes(TOKEN), "the token appears in no output");
  });

  it("forwards to the daemon with the token, and says what to do when the daemon refuses it or cannot be reached", async () => {
    const sent: Array<{ url: string; authorization: string | null }> = [];
    let mode: "ok" | "refuse" | "down" = "ok";
    const fetchImpl: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      if (mode === "down") throw new TypeError(`fetch failed (connect ECONNREFUSED; sent Bearer ${TOKEN})`);
      if (mode === "refuse") return Response.json({ ok: false, errorCode: "UNAUTHORIZED", message: "Unauthorized or invalid access token" }, { status: 401 });
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fengsui-cpe-dash", version: "0" } } });
    };
    const proc = fakeProcess({ MCP_DAEMON_URL: "http://100.64.0.10:18384", API_TOKEN: TOKEN });
    startDesktopExtension(proc, { fetchImpl });
    assert.match(proc.stderrText(), /ready -> http:\/\/100\.64\.0\.10:18384\/mcp/);

    proc.stdin.write(initialize);
    await settle(() => proc.lines().length === 1, "initialize");
    assert.equal(proc.lines()[0]?.result?.["protocolVersion"], "2025-11-25");
    assert.deepEqual(sent[0], { url: "http://100.64.0.10:18384/mcp", authorization: `Bearer ${TOKEN}` });

    mode = "refuse";
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await settle(() => proc.lines().length === 2, "the refusal");
    const refused = proc.lines()[1];
    assert.equal(refused?.error?.code, BRIDGE_DAEMON_REJECTED);
    assert.match(refused?.error?.message ?? "", /HTTP 401 UNAUTHORIZED/);
    assert.match(refused?.error?.message ?? "", /did not accept the token/);
    assert.ok(refused?.error?.message.includes(EXTENSION_SETTINGS_PLACE));

    mode = "down";
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
    await settle(() => proc.lines().length === 3, "unreachable");
    const down = proc.lines()[2];
    assert.equal(down?.error?.code, BRIDGE_DAEMON_UNREACHABLE);
    assert.match(down?.error?.message ?? "", /LAN or Tailscale/);
    assert.doesNotMatch(down?.error?.message ?? "", /cpe-dash serve/, "the daemon runs elsewhere: nothing to start on this computer");

    proc.stdin.end();
    assert.equal(await proc.exited, 0);
    assert.ok(!proc.stdoutText().includes(TOKEN), "the token appears in no answer, even when an error message carried it");
    assert.ok(!proc.stderrText().includes(TOKEN), "nor in the log");
  });
});
