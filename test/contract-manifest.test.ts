import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { AccessControlMcpTools } from "../src/mcp-access-tools.ts";
import { CoreMcpTools } from "../src/mcp-core-tools.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMcpTools } from "../src/sms/mcp-tools.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Contract manifest (ADR-008): what the code exposes, read from the code itself, must be documented.
 * A new tool, route, SSE event, alert code or setting that skips the docs fails here.
 */

const read = (file: string): string => fs.readFileSync(file, "utf8");
const CONTRACT = read("docs/PHASE2_BACKEND_CONTRACT.md");
/** The user guide is the reference for settings and agent tools (the READMEs link to it). */
const GUIDE_CONFIG = { "docs/guide/zh/configuration.md": read("docs/guide/zh/configuration.md"), "docs/guide/en/configuration.md": read("docs/guide/en/configuration.md") };
const GUIDE_AGENTS = { "docs/guide/zh/agents.md": read("docs/guide/zh/agents.md"), "docs/guide/en/agents.md": read("docs/guide/en/agents.md") };
const ENV_EXAMPLE = read(".env.example");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const SOURCES = sourceFiles("src").map((file) => [file, read(file)] as const);

function matchesIn(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] ?? "").filter(Boolean);
}

function missing(names: Iterable<string>, docs: Record<string, string>, quote = true): string[] {
  const gaps: string[] = [];
  for (const name of new Set(names)) {
    for (const [doc, text] of Object.entries(docs)) {
      const found = quote ? text.includes(`\`${name}\``) || text.includes(`"${name}"`) || text.includes(`\`${name}=`) : text.includes(name);
      if (!found) gaps.push(`${doc}: ${name}`);
    }
  }
  return gaps.sort();
}

describe("contract manifest: code ↔ docs", () => {
  it("documents every MCP tool, with every provider at its widest exposure", async () => {
    const cpe = createStrictCpe();
    const dir = tempDir("fengsui-manifest-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "manifest_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    });
    try {
      const cipher = StorageCipher.fromSecret("manifest_key");
      const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
      const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
      const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353" });
      const server = new FengSuiMcpServer({
        core,
        allowMutations: true,
        experimental: { allowed: () => true, settings: { experimentalConsents: [] }, change: () => ({ ok: true, detail: "" }) },
        toolProviders: [
          new AccessControlMcpTools({ core, allowWrites: true, redactSensitive: () => false }),
          new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 }),
        ],
      });
      const reply = (await server.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }))) as JsonRpcSuccessResponse;
      // Plus the tools listed only on some routers (set_experimental_write: a model nobody verified)
      const tools = [...((reply.result as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name), ...new CoreMcpTools(core).getToolDefinitions().map((t) => t.name)];
      assert.ok(new Set(tools).size >= 30, `found ${new Set(tools).size} tools`);
      assert.deepEqual(missing(tools, { "docs/PHASE2_BACKEND_CONTRACT.md": CONTRACT, ...GUIDE_AGENTS }), []);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("lists every alert code the daemon raises in the contract's AlertCode union", () => {
    const codes = SOURCES.flatMap(([, text]) => [
      ...matchesIn(text, /#raise\(\s*"(?:info|warning|critical)",\s*"([A-Z][A-Z_]+)"/g),
      ...matchesIn(text, /raiseAlert\(\{\s*severity:\s*"(?:info|warning|critical)",\s*code:\s*"([A-Z][A-Z_]+)"/g),
    ]);
    assert.ok(codes.length >= 20, `found ${codes.length} codes`);
    const union = CONTRACT.slice(CONTRACT.indexOf("export type AlertCode"));
    const declared = new Set(matchesIn(union.slice(0, union.indexOf(";")), /\| "([A-Z][A-Z_]+)"/g));
    assert.deepEqual([...new Set(codes)].filter((code) => !declared.has(code)).sort(), []);
  });

  it("documents every SSE event of the payload map", () => {
    const api = read("src/api-contract.ts");
    const block = api.slice(api.indexOf("export interface SseEventPayloads {"));
    const events = matchesIn(block.slice(0, block.indexOf("\n}")), /^ {2}"?([a-z][a-z:-]*)"?:/gm);
    assert.ok(events.length >= 15, `found ${events.length} events`);
    assert.deepEqual(missing(events, { "docs/PHASE2_BACKEND_CONTRACT.md": CONTRACT }), []);
  });

  it("documents every REST route in the contract", () => {
    const routes = ["src/http-server.ts", "src/http-settings.ts", "src/sms/http-routes.ts"].flatMap((file) => matchesIn(read(file), /"(\/api\/[a-z0-9/_-]+?)\/?"/g));
    assert.ok(routes.length >= 40, `found ${routes.length} routes`);
    assert.deepEqual(missing(routes, { "docs/PHASE2_BACKEND_CONTRACT.md": CONTRACT }, false), []);
  });

  it("documents every setting the loader reads in .env.example and the configuration guide in both languages", () => {
    const keys = matchesIn(read("src/config.ts"), /(?:get|dataFile)\(\s*"([A-Z][A-Z0-9_]+)"/g);
    assert.ok(keys.length >= 50, `found ${keys.length} keys`);
    // .env.example names each setting as a (possibly commented-out) `KEY=` line
    const unlisted = [...new Set(keys)].filter((key) => !new RegExp(`^#?\\s*${key}=`, "m").test(ENV_EXAMPLE)).map((key) => `.env.example: ${key}`);
    assert.deepEqual([...unlisted, ...missing(keys, GUIDE_CONFIG)].sort(), []);
  });
});
