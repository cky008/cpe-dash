import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { FengSuiHttpServer } from "../src/http-server.ts";
import { FengSuiMcpServer } from "../src/mcp-server.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { SMS_SSE_EVENTS, SseEventBus } from "../src/sse-bus.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { API_ERRORS, API_EVENTS, API_ROUTES, CONSOLE_ROUTE_PREFIXES, ERRORS_NOT_LISTED, apiRoutesSection, readBlock, replaceBlock, routePermission } from "../scripts/api-reference.ts";
import { syncDocs } from "../scripts/sync-docs.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * The guide's API reference (docs/guide/{zh,en}/api.md) writes its routes, SSE events and error codes
 * from scripts/api-reference.ts, and that list answers to the code: every route the daemon serves to
 * tokens is listed and every listed one is served, with the method the list says, every SSE event and
 * every error code a script can meet is described, and the pages hold exactly the generated text.
 */

const read = (file: string): string => fs.readFileSync(file, "utf8");
/** The route strings of the three route modules, as test/contract-manifest.test.ts reads them. */
const CODE_ROUTES = new Set(["src/http-server.ts", "src/http-settings.ts", "src/http-cellular.ts", "src/sms/http-routes.ts"].flatMap((file) => [...read(file).matchAll(/"(\/api\/[a-z0-9/_-]+?)\/?"/g)].map((m) => m[1] ?? "")));

function unionMembers(source: string, start: string): string[] {
  // Comments may hold a ";" of their own: the union ends at the first one outside them
  const from = source.slice(source.indexOf(start)).replace(/\/\/[^\n]*/g, "");
  return [...from.slice(0, from.indexOf(";")).matchAll(/\| "([A-Z][A-Z_]+)"/g)].map((m) => m[1] ?? "");
}

describe("the API reference in the guide", () => {
  it("holds exactly what the generator writes, in both languages (npm run docs:sync)", () => {
    assert.deepEqual(syncDocs(process.cwd(), true), [], "run npm run docs:sync");
  });

  it("lists every route the daemon serves to tokens, and only those", () => {
    const listed = new Set(API_ROUTES.map((route) => route.path));
    assert.equal(listed.size + API_ROUTES.filter((r) => r.path === "/api/sms/contacts").length - 1, API_ROUTES.length, "each path once (GET and POST of one path aside)");
    const isConsole = (p: string): boolean => CONSOLE_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
    // A string that is only the start of listed routes (`/api/sms`, `/api/control`) is a prefix check in the router, not a route
    const isPrefix = (p: string): boolean => [...listed].some((route) => route.startsWith(`${p}/`));
    const unlisted = [...CODE_ROUTES].filter((p) => !listed.has(p) && !isConsole(p) && !isPrefix(p));
    assert.deepEqual(unlisted, [], "describe these in scripts/api-reference.ts");
    const gone = [...listed].filter((p) => p !== "/metrics" && !CODE_ROUTES.has(p));
    assert.deepEqual(gone, [], "these are no longer in the code");
    assert.ok(read("src/http-server.ts").includes('pathname === "/metrics"'));
  });

  it("names the permission the daemon asks for", () => {
    const byPath = (p: string, method = "POST") => API_ROUTES.find((route) => route.path === p && route.method === method);
    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["GET", "/api/telemetry", "any"],
      ["POST", "/api/neighbors/scan", "any"],
      ["POST", "/api/control/band-lock", "control"],
      ["POST", "/api/session/reset-breaker", "control"],
      ["POST", "/api/control/time-rule", "access"],
      ["GET", "/api/sms/threads", "sms-read"],
      ["POST", "/api/sms/sync", "sms-read"],
      ["POST", "/api/sms/send", "sms-write"],
      ["POST", "/api/sms/trash/purge", "console"],
      ["GET", "/api/health", "open"],
    ];
    for (const [method, p, permission] of table) {
      const route = byPath(p, method);
      assert.ok(route, p);
      assert.equal(routePermission(route), permission, p);
    }
    // The generated table says it in words, never as the raw permission key
    const cells = apiRoutesSection("en").split("\n").flatMap((line) => line.split("|").map((cell) => cell.trim()));
    for (const key of ["sms-read", "sms-write", "control", "access", "all", "open", "console", "any"]) assert.ok(!cells.includes(key), key);
  });

  it("describes every SSE event, marking the SMS ones a token without 'read SMS' never gets", () => {
    const api = read("src/api-contract.ts");
    const block = api.slice(api.indexOf("export interface SseEventPayloads {"));
    const events = [...block.slice(0, block.indexOf("\n}")).matchAll(/^ {2}"?([a-z][a-z:-]*)"?:/gm)].map((m) => m[1] ?? "");
    assert.deepEqual(API_EVENTS.map((e) => e.name).sort(), [...events].sort());
    const sms: ReadonlyArray<string> = SMS_SSE_EVENTS;
    assert.deepEqual(API_EVENTS.filter((e) => e.sms).map((e) => e.name).sort(), [...sms].sort());
  });

  it("describes every error code a script can meet, and says which ones it leaves out", () => {
    const codes = unionMembers(read("src/api-contract.ts"), "export type ApiErrorCode");
    assert.ok(codes.length >= 40, `found ${codes.length} codes`);
    const listed = API_ERRORS.map((e) => e.code);
    assert.equal(new Set(listed).size, listed.length, "each code once");
    assert.deepEqual(listed.filter((code) => ERRORS_NOT_LISTED.includes(code)), [], "listed and left out at once");
    assert.deepEqual([...listed, ...ERRORS_NOT_LISTED].sort(), [...codes].sort(), "describe a new code in API_ERRORS, or add it to ERRORS_NOT_LISTED");
    for (const error of API_ERRORS) assert.match(error.status, /^[1-5]\d\d( \/ [1-5]\d\d)*$/, error.code);
  });

  it("rewrites one block and leaves the hand-written text around it alone", () => {
    const page = "intro\n<!-- api-events:begin -->\nold\n<!-- api-events:end -->\noutro\n";
    const next = replaceBlock(page, "api-events", "new\nrows");
    assert.equal(next, "intro\n<!-- api-events:begin -->\nnew\nrows\n<!-- api-events:end -->\noutro\n");
    assert.equal(readBlock(next, "api-events"), "new\nrows");
    assert.equal(readBlock(next, "api-routes"), null);
    assert.throws(() => replaceBlock(page, "api-routes", "x"), /no <!-- api-routes:begin -->/);
  });

  it("serves each listed route with its method, and takes each example body", async () => {
    const mock = createMockSmsCpe({ messages: [] });
    const dir = tempDir("fengsui-api-reference-");
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "CPE_URL=http://192.168.8.1",
        `CPE_PASSWORD=${mock.password}`,
        "API_TOKEN=api_reference_token",
        "WEB_HOST=127.0.0.1",
        "WEB_PORT=0",
        "METRICS_ENABLED=true",
        `STATE_FILE=${path.join(dir, "state.json")}`,
        `STATIC_DIR=${path.join(dir, "no-static")}`,
      ].join("\n")
    );
    const config = loadConfig({ envPath, ignoreProcessEnv: true });
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: config.cpeUrl, cpePassword: config.cpePassword, fetchImpl: mock.fetchImpl }),
      stateStore: new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      pollIntervalMs: 60_000,
    });
    core.monitor.init();
    const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
    const contacts = new ContactBook({ filePath: config.contactsFile, cipher, defaultCountryCode: "+353" });
    const mirror = new SmsMirrorStore({ filePath: config.smsFile, cipher, defaultCountryCode: "+353", contacts });
    const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
    const sseBus = new SseEventBus({ heartbeatMs: 2000 });
    sseBus.attachCore(core);
    sseBus.attachSms(sms);
    const server = new FengSuiHttpServer({ config, core, sseBus, mcpServer: new FengSuiMcpServer({ allowMutations: false, core }), envPath, sms, settings: consoleSettingsFor(config) });
    const bound = await server.listen();
    const base = `http://${bound.host}:${bound.port}`;
    try {
      const problems: string[] = [];
      for (const route of API_ROUTES) {
        const controller = new AbortController();
        const res = await fetch(`${base}${route.path}`, {
          method: route.method,
          headers: { Authorization: "Bearer api_reference_token", "Content-Type": "application/json" },
          ...(route.method === "POST" ? { body: route.body ?? "{}" } : {}),
          signal: controller.signal,
        });
        const text = route.path === "/api/events" || route.path === "/metrics" ? "" : await res.text();
        controller.abort();
        let code: unknown = null;
        if (text.startsWith("{")) code = (JSON.parse(text) as { errorCode?: unknown }).errorCode ?? null;
        const where = `${route.method} ${route.path}: ${res.status} ${String(code)}`;
        if (res.status === 404 || res.status === 405) problems.push(`${where} (not served)`);
        else if (route.consoleOnly && code !== "CONSOLE_ONLY") problems.push(`${where} (should be console only)`);
        else if (route.body && !route.needsState && (code === "VALIDATION_ERROR" || code === "BAD_PAYLOAD")) problems.push(`${where} (example body refused)`);
        else if (!route.body && code === "BAD_PAYLOAD") problems.push(`${where} (an empty object refused)`);
      }
      assert.deepEqual(problems, []);
    } finally {
      sseBus.stop();
      await server.close();
      await sms.stop();
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });
});
