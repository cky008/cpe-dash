import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { scanText } from "../scripts/audit-secrets.ts";
import { BUNDLE_FILES, BUNDLE_INPUTS, ENTRY_POINT, type BuiltMcpb, buildMcpb, checkBundle, extensionManifest, readPackageJson } from "../scripts/build-mcpb.ts";
import { startDemoDaemon, type DemoDaemon } from "../scripts/demo-router.ts";
import { type JsonSchema, validateJsonSchema } from "../scripts/json-schema.ts";
import { readZip, writeZip } from "../scripts/zip.ts";
import type { ExtensionProcess } from "../src/desktop-extension.ts";
import { BRIDGE_DAEMON_REJECTED, BRIDGE_NOT_SET_UP } from "../src/mcp-stdio-bridge.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * The Claude Desktop extension as it ships: `npm run build:mcpb` (scripts/build-mcpb.ts) packs the bridge into
 * dist/fengsui-<version>.mcpb. These tests build it once, check the manifest against the official MCP Bundle schema
 * (mcpb/, taken unchanged from modelcontextprotocol/mcpb) and what is in the archive, then run the packed server the
 * way Claude Desktop does: its own Node, the bundle's server/index.js, and only the two variables of the manifest's
 * mcp_config. The daemon is the demo's (an in-process mock router, nothing leaves the machine); the tokens are made
 * up and the addresses are RFC placeholders (AGENTS.md 铁律二).
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const TOKEN = "fs_mcpb_test_token_0123456789";
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, "mcpb", "mcpb-manifest-v0.3.schema.json"), "utf8")) as JsonSchema;
const pkg = readPackageJson();

// Claude Desktop hands the extension the real `process`: it has every part the entry uses
const realProcess: ExtensionProcess = process;
void realProcess;

let outDir = "";
let built: BuiltMcpb;

before(async () => {
  outDir = tempDir("fengsui-mcpb-");
  built = await buildMcpb({ outDir });
});

after(() => removeTempDir(outDir));

interface RpcLine {
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface Run {
  answers: RpcLine[];
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Start the installed bundle's server as Claude Desktop does (`node <dir>/server/index.js`, the manifest's env only),
 * send `initialize`, then `requests` once it has answered, close stdin and wait for the process to end.
 */
async function runInstalled(installDir: string, env: Record<string, string>, requests: ReadonlyArray<Record<string, unknown>>, cwd = installDir): Promise<Run> {
  const child = spawn(process.execPath, [path.join(installDir, ENTRY_POINT)], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const answers = (): RpcLine[] =>
    stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as RpcLine);
  const waitFor = async (count: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (answers().length < count) {
      if (Date.now() > deadline) throw new Error(`the extension gave ${answers().length} of ${count} answers; stderr: ${stderr}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-ai", version: "0" } } })}\n`);
    await waitFor(1);
    for (const request of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...request })}\n`);
    await waitFor(1 + requests.filter((r) => "id" in r).length);
  } finally {
    child.stdin.end();
  }
  const code = await exited;
  return { answers: answers(), stdout, stderr, code };
}

/** Unpack the archive as Claude Desktop installs it: every entry under one directory. */
function install(archive: Uint8Array, dir: string): void {
  for (const entry of readZip(archive)) {
    const file = path.join(dir, entry.name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
}

describe("The Claude Desktop extension: its manifest", () => {
  it("passes the official MCP Bundle schema (manifest 0.3), with the name, version and entry Desktop runs", () => {
    const manifest = built.manifest;
    assert.deepEqual(validateJsonSchema(SCHEMA, manifest), []);
    assert.equal(manifest["manifest_version"], "0.3");
    assert.equal(manifest["name"], "fengsui");
    assert.equal(manifest["version"], pkg.version, "the extension's version is FengSui's");
    assert.equal(manifest["license"], pkg.license);
    assert.deepEqual(manifest["server"], {
      type: "node",
      entry_point: ENTRY_POINT,
      mcp_config: { command: "node", args: [`\${__dirname}/${ENTRY_POINT}`], env: { MCP_DAEMON_URL: "${user_config.daemon_url}", API_TOKEN: "${user_config.api_token}" } },
    });
  });

  it("asks for the FengSui MCP address and a token, the token kept as a secret (Desktop puts it in the keychain)", () => {
    const config = built.manifest["user_config"] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(config), ["daemon_url", "api_token"]);
    assert.equal(config["api_token"]?.["type"], "string");
    assert.equal(config["api_token"]?.["sensitive"], true);
    assert.equal(config["api_token"]?.["required"], true);
    assert.equal(config["daemon_url"]?.["sensitive"], undefined, "the address is shown as typed");
    assert.equal(config["daemon_url"]?.["required"], true);
    for (const option of Object.values(config)) assert.equal(option["default"], undefined, "nothing is filled in for the person");
    // The form tells people to enter an IP on their LAN or Tailscale, in both languages
    const address = String(config["daemon_url"]?.["description"]);
    assert.match(address, /http:\/\/100\.64\.0\.10:18384\/mcp/);
    assert.match(address, /not a domain name/);
    assert.match(address, /不要填域名/);
    assert.match(String(config["api_token"]?.["description"]), /Settings → Tokens & AI/);
  });

  it("asks for the Node that package.json's engines asks for, and names the icons", () => {
    assert.deepEqual((built.manifest["compatibility"] as Record<string, unknown>)["runtimes"], { node: pkg.engines.node });
    assert.equal(built.manifest["icon"], "icon.png");
    assert.deepEqual(built.manifest["icons"], [
      { src: "icon.png", size: "512x512", theme: "light" },
      { src: "icon-dark.png", size: "512x512", theme: "dark" },
    ]);
    assert.equal(built.manifest["documentation"], "https://fengsui.iocky.com/en/docs/agents/");
  });

  it("builds the manifest from package.json alone, so a new version needs no other edit", () => {
    const next = extensionManifest({ ...pkg, version: "9.8.7", engines: { node: ">=24.0.0" } });
    assert.equal(next["version"], "9.8.7");
    assert.deepEqual((next["compatibility"] as Record<string, unknown>)["runtimes"], { node: ">=24.0.0" });
    assert.deepEqual(validateJsonSchema(SCHEMA, next), []);
  });

  it("refuses a manifest the official checks would refuse", () => {
    const files = new Map(readZip(fs.readFileSync(built.file)).map((entry) => [entry.name, entry.data]));
    assert.deepEqual(checkBundle(built.manifest, files), []);
    const broken = (patch: (m: Record<string, unknown>) => void): Record<string, unknown> => {
      const copy = structuredClone(built.manifest);
      patch(copy);
      return copy;
    };
    const server = (m: Record<string, unknown>): Record<string, unknown> => m["server"] as Record<string, unknown>;
    const env = (m: Record<string, unknown>): Record<string, string> => (server(m)["mcp_config"] as Record<string, Record<string, string>>)["env"] ?? {};
    for (const [label, manifest, why] of [
      ["no manifest_version", broken((m) => delete m["manifest_version"]), /manifest_version/],
      ["an unknown field", broken((m) => (m["homepage_url"] = "https://github.com/cky008/cpe-dash")), /homepage_url: not a field/],
      ["an icon size that is not WxH", broken((m) => ((m["icons"] as Array<Record<string, string>>)[0]!["size"] = "512")), /icons\[0\]\.size: does not match/],
      ["a missing icon", broken((m) => (m["icon"] = "missing.png")), /icon missing\.png is not in the bundle/],
      ["an icon that is not a PNG", broken((m) => (m["icon"] = "manifest.json")), /icon manifest\.json is not a PNG/],
      ["a missing entry point", broken((m) => (server(m)["entry_point"] = "server/main.js")), /entry point server\/main\.js is not in the bundle/],
      ["a variable Desktop does not replace", broken((m) => (env(m)["API_TOKEN"] = "${HOME}")), /\$\{HOME\} in mcp_config\.env\.API_TOKEN/],
      ["a setting nobody declared", broken((m) => (env(m)["API_TOKEN"] = "${user_config.token}")), /user_config\.token is not declared/],
      ["a sensitive setting that is not text", broken((m) => ((m["user_config"] as Record<string, Record<string, unknown>>)["api_token"]!["type"] = "number")), /user_config\.api_token is sensitive but not a string/],
    ] as const) {
      assert.match(checkBundle(manifest, files).join("\n"), why, label);
    }
  });

  it("checks with the schema's own keywords only, and refuses a schema it cannot fully check", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { size: { type: "string", pattern: "^\\d+x\\d+$" }, kind: { enum: ["a", "b"] }, link: { type: "string", format: "uri" }, mail: { type: "string", format: "email" }, ref: { $ref: "#/properties/kind" }, any: { anyOf: [{ type: "number" }, { type: "array", items: { type: "string" } }] }, theme: { type: "string", minLength: 1 } },
      required: ["kind"],
      additionalProperties: false,
    };
    assert.deepEqual(validateJsonSchema(schema, { kind: "a", size: "16x16", link: "https://example.com/", mail: "a@example.com", ref: "b", any: ["x"], theme: "dark" }), []);
    assert.deepEqual(validateJsonSchema(schema, { size: "16", kind: "c", link: "not a uri", mail: "no-at", ref: "c", any: [1], theme: "", extra: 1 }).sort(), [
      "size: does not match ^\\d+x\\d+$",
      "kind: must be one of \"a\", \"b\"",
      "link: not a valid uri",
      "mail: not a valid email",
      "ref: must be one of \"a\", \"b\"",
      "any: matches none of the allowed shapes",
      "theme: shorter than 1",
      "extra: not a field of this schema",
    ].sort());
    assert.throws(() => validateJsonSchema({ type: "object", minProperties: 1 }, {}), /minProperties/);
    assert.throws(() => validateJsonSchema({ $ref: "https://example.com/schema.json" }, {}), /local \$ref/);
  });
});

describe("The Claude Desktop extension: the packed file", () => {
  it("is a zip of the manifest, the bundled bridge, the icons and the licence, named after the version", () => {
    assert.equal(path.basename(built.file), `fengsui-${pkg.version}.mcpb`);
    const entries = readZip(fs.readFileSync(built.file));
    assert.deepEqual(entries.map((e) => e.name), [...BUNDLE_FILES]);
    const byName = new Map(entries.map((e) => [e.name, Buffer.from(e.data)]));
    assert.deepEqual(JSON.parse(byName.get("manifest.json")?.toString("utf8") ?? "{}"), built.manifest);
    assert.deepEqual(JSON.parse(byName.get("package.json")?.toString("utf8") ?? "{}"), { name: "fengsui", version: pkg.version, private: true, type: "module", license: pkg.license });
    assert.ok(byName.get("icon.png")?.equals(fs.readFileSync(path.join(ROOT, "mcpb", "icon.png"))));
    assert.ok(byName.get("icon-dark.png")?.equals(fs.readFileSync(path.join(ROOT, "mcpb", "icon-dark.png"))));
    assert.ok(byName.get("LICENSE")?.equals(fs.readFileSync(path.join(ROOT, "LICENSE"))), "FengSui's licence travels with it");
  });

  it("carries the bridge alone: none of the daemon's modules, no file access, no source map, no local path, no secret", () => {
    assert.deepEqual([...built.inputs].sort(), [...BUNDLE_INPUTS].sort());
    const server = Buffer.from(readZip(fs.readFileSync(built.file)).find((e) => e.name === ENTRY_POINT)?.data ?? []).toString("utf8");
    assert.ok(server.length > 1000, "the bundled bridge");
    for (const absent of ["node:fs", 'from "fs"', "readFileSync", "process.env.", "sourceMappingURL", ROOT, "/Users/", "C:\\\\", "MutexSessionScheduler", "HuaweiCpeClient", "StorageCipher", "loadConfig", "parseDotEnv", "CPE_PASSWORD"]) {
      assert.ok(!server.includes(absent), `the bundle has no ${absent}`);
    }
    assert.ok(!readZip(fs.readFileSync(built.file)).some((e) => e.name.endsWith(".map")), "no source map");
    for (const entry of readZip(fs.readFileSync(built.file))) {
      if (entry.name.endsWith(".png")) continue;
      assert.deepEqual(scanText(entry.name, Buffer.from(entry.data).toString("utf8"), [TOKEN]), [], `${entry.name} passes the secret scan`);
    }
  });

  it("comes out byte for byte the same from the same sources", async () => {
    const again = tempDir("fengsui-mcpb-again-");
    try {
      const second = await buildMcpb({ outDir: again });
      const digest = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      assert.equal(digest(second.file), digest(built.file));
    } finally {
      removeTempDir(again);
    }
  });

  it("reads back what the zip writer wrote, and refuses names that could escape the install directory", () => {
    const entries = [
      { name: "a.txt", data: Buffer.from("one") },
      { name: "dir/b.bin", data: new Uint8Array([0, 1, 2, 255]) },
    ];
    assert.deepEqual(readZip(writeZip(entries)).map((e) => [e.name, [...e.data]]), entries.map((e) => [e.name, [...e.data]]));
    for (const name of ["../evil", "/abs", "dir/../x", "a\\b", "dir//x", ""]) assert.throws(() => writeZip([{ name, data: new Uint8Array() }]), /relative path/, name);
    assert.throws(() => writeZip([entries[0]!, entries[0]!]), /twice/);
    const damaged = writeZip(entries);
    const firstByte = 30 + "a.txt".length;
    damaged.writeUInt8(damaged.readUInt8(firstByte) ^ 0xff, firstByte);
    assert.throws(() => readZip(damaged), /CRC/);
  });
});

describe("The Claude Desktop extension: run as Desktop runs it", () => {
  let demo: DemoDaemon;
  let installDir = "";

  before(async () => {
    demo = await startDemoDaemon({ port: 0, token: TOKEN });
    installDir = tempDir("fengsui-mcpb-installed-");
    install(fs.readFileSync(built.file), installDir);
  });

  after(async () => {
    await demo.close();
    removeTempDir(installDir);
  });

  it("lists FengSui's tools from the daemon, given only the address and the token", async () => {
    const run = await runInstalled(installDir, { MCP_DAEMON_URL: `${demo.baseUrl}/mcp`, API_TOKEN: TOKEN }, [{ method: "notifications/initialized" }, { id: 1, method: "tools/list" }]);
    assert.equal(run.code, 0, "ends when Desktop closes stdin");
    assert.equal(run.answers[0]?.id, 0);
    assert.equal((run.answers[0]?.result?.["serverInfo"] as Record<string, unknown>)["name"], "fengsui-cpe-dash");
    const tools = (run.answers[1]?.result?.["tools"] as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(tools.includes("get_cpe_telemetry"), "the daemon's read tools");
    assert.ok(!tools.includes("reboot_cpe"), "writes stay off, as on the daemon");
    assert.match(run.stderr, /ready -> http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN), "the token appears in no output");
  });

  it("says plainly when the daemon refuses the token, without repeating it", async () => {
    const wrong = "fs_not_the_daemons_token_42";
    const run = await runInstalled(installDir, { MCP_DAEMON_URL: `${demo.baseUrl}/mcp`, API_TOKEN: wrong }, []);
    assert.equal(run.answers[0]?.error?.code, BRIDGE_DAEMON_REJECTED);
    assert.match(run.answers[0]?.error?.message ?? "", /HTTP 401 UNAUTHORIZED.*FengSui did not accept the token/);
    assert.equal(run.code, 0);
    for (const token of [wrong, TOKEN]) assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token));
  });

  it("refuses an address on the internet and sends nothing there", async () => {
    const run = await runInstalled(installDir, { MCP_DAEMON_URL: "http://203.0.113.10:18384/mcp", API_TOKEN: TOKEN }, [{ id: 1, method: "tools/list" }]);
    for (const answer of run.answers) {
      assert.equal(answer.error?.code, BRIDGE_NOT_SET_UP);
      assert.match(answer.error?.message ?? "", /"203\.0\.113\.10" is not a private\/LAN address/);
    }
    assert.equal(run.code, 0);
    assert.ok(!run.stdout.includes(TOKEN) && !run.stderr.includes(TOKEN));
  });

  it("reads no .env: a file beside it or in its working directory changes nothing", async () => {
    const envFile = `MCP_DAEMON_URL=${demo.baseUrl}/mcp\nAPI_TOKEN=${TOKEN}\n`;
    const workDir = tempDir("fengsui-mcpb-cwd-");
    try {
      fs.writeFileSync(path.join(installDir, ".env"), envFile);
      fs.writeFileSync(path.join(installDir, "server", ".env"), envFile);
      fs.writeFileSync(path.join(workDir, ".env"), envFile);
      for (const cwd of [installDir, workDir]) {
        const run = await runInstalled(installDir, {}, [], cwd);
        assert.equal(run.answers[0]?.error?.code, BRIDGE_NOT_SET_UP, cwd);
        assert.match(run.answers[0]?.error?.message ?? "", /the FengSui MCP address is empty/);
        assert.equal(run.code, 0);
      }
    } finally {
      for (const file of [path.join(installDir, ".env"), path.join(installDir, "server", ".env")]) fs.rmSync(file, { force: true });
      removeTempDir(workDir);
    }
  });
});
