import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { type McpOperation, OPERATION_NAMES, REST_OPERATIONS, operationRecord, restBinding, toolDefinition } from "../src/operations/registry.ts";

/**
 * Contract manifest (ADR-008): what the code exposes, read from the code itself, must be documented.
 * A new tool, route, SSE event, alert code or setting that skips the docs fails here.
 */

const read = (file: string): string => fs.readFileSync(file, "utf8");
const CONTRACT = read("docs/dev/api.md");
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
  it("documents every MCP tool of the operation registry", () => {
    const tools = OPERATION_NAMES.flatMap((op) => (operationRecord(op).mcp ? [toolDefinition(op as McpOperation).name] : []));
    assert.ok(tools.length >= 42, `found ${tools.length} tools`);
    assert.deepEqual(missing(tools, { "docs/dev/api.md": CONTRACT, ...GUIDE_AGENTS }), []);
  });

  it("lists every alert code the daemon raises in the contract's AlertCode union", () => {
    const codes = SOURCES.flatMap(([, text]) => [
      ...matchesIn(text, /#raise(?:Link)?\(\s*"(?:info|warning|critical)",\s*"([A-Z][A-Z_]+)"/g),
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
    assert.deepEqual(missing(events, { "docs/dev/api.md": CONTRACT }), []);
  });

  it("documents every REST route in the contract: the registry's, and the console's own", () => {
    const routes = [...REST_OPERATIONS.map((op) => restBinding(op).path), ...["src/http-server.ts", "src/http-settings.ts"].flatMap((file) => matchesIn(read(file), /"(\/api\/[a-z0-9/_-]+?)\/?"/g))];
    assert.ok(routes.length >= 40, `found ${routes.length} routes`);
    assert.deepEqual(missing(routes, { "docs/dev/api.md": CONTRACT }, false), []);
  });

  it("documents every setting the loader reads in .env.example and the configuration guide in both languages", () => {
    const keys = matchesIn(read("src/config.ts"), /(?:get|dataFile)\(\s*"([A-Z][A-Z0-9_]+)"/g);
    assert.ok(keys.length >= 50, `found ${keys.length} keys`);
    // .env.example names each setting as a (possibly commented-out) `KEY=` line
    const unlisted = [...new Set(keys)].filter((key) => !new RegExp(`^#?\\s*${key}=`, "m").test(ENV_EXAMPLE)).map((key) => `.env.example: ${key}`);
    assert.deepEqual([...unlisted, ...missing(keys, GUIDE_CONFIG)].sort(), []);
  });
});
