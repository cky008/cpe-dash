import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { apiReferenceBlocks } from "../scripts/api-reference.ts";
import { loadConfig } from "../src/config.ts";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { FengSuiHttpServer } from "../src/http-server.ts";
import { permissionForRoute } from "../src/operations/registry.ts";
import { AccessControlMcpTools } from "../src/mcp-access-tools.ts";
import { CellularMcpTools } from "../src/mcp-cellular-tools.ts";
import { CoreMcpTools } from "../src/mcp-core-tools.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { McpToolProvider } from "../src/mcp-tool-provider.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMcpTools } from "../src/sms/mcp-tools.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { SseEventBus } from "../src/sse-bus.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { mockConnection } from "./helpers/connection.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { daemonOn } from "./helpers/driver-daemon.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * What every entry offers before the operation registry (docs/dev/architecture.md 19.9), frozen as
 * hashes: the permission a token needs for each path and method, the daemon's answer to each path
 * and method, the MCP tools on three routers (the verified H168-383, an unverified HiLink model, a
 * ZTE router) with the answers to a call without arguments, and the API reference's generated blocks.
 * The registry must leave every one of them as it was. `OPERATIONS_SNAPSHOT_DIR=<dir>` writes each
 * part out, to compare one by name. Mock routers and placeholders only, no network.
 */

const BEFORE: Readonly<Record<string, string>> = {
  "permissions": "aa2aa900c44210ce3f486a55d57a6ea6100596b65deec6f55a9530c46d433104",
  "rest": "86a87932fcf774670f61580fafd790b195597880f83b38213b7f0dba7c78ebf8",
  "mcp:h168:tools": "78c834049c16d13d90ea7366dd05dda691b9a960bd2cf9a3da153f5802424e23",
  "mcp:h168:readToken": "57237479cd2f669b4f2f3e81cef56391317f4da149e73b2e22e0e37db709e4b5",
  "mcp:h168:noPermission": "46fc61871f51553389b6345082980fe1edf13a426ecaadfffc493831dcfcfd6a",
  "mcp:h168:instructions": "1664b27919eb046b4c6c33c677ba9c9eb7cb2abcc7508143b95f1afa363cb31b",
  "mcp:h168:calls": "ed1a508f2cd8f328743680f0f8546ceb64fd68089cc6de73694221236badae21",
  "mcp:definitions": "88b3b16b457c8f4bf3943f41b660c6cb3f2287049269f4f2203036a9369528b2",
  "mcp:b535:tools": "803941898ed4b348352b33d98220f82b4c3ad4b6e66d95da67077b4b144a6bff",
  "mcp:b535:readToken": "5983e3055f028d1cfb4ad00294b6c0954cfe1e67b95ef902ab4b621c86714e6e",
  "mcp:b535:noPermission": "b1fe254dfaeeee99c529fd64aaab32fe1cdeb30da9c937eaeb83afbd7e15c7c1",
  "mcp:b535:instructions": "6bc999420c4cd4e1d33da9332c6b6ea4b1fcc58258ab78a9ab914826eea689c4",
  "mcp:b535:calls": "d086f92c4fb21770551d5ffc70bd76ecb95fd41bedbec62af8344d46abd27d31",
  "mcp:zte:tools": "15fd6a4ba317927dca26bab701e3fa93e9bac794eda499306c42beb19818ec3f",
  "mcp:zte:readToken": "afbee02b5a98a3b656f1ab3163798c3e0fd8e4e5a3459e47f6d5617f4f115810",
  "mcp:zte:noPermission": "afbee02b5a98a3b656f1ab3163798c3e0fd8e4e5a3459e47f6d5617f4f115810",
  "mcp:zte:instructions": "630bf0ee31d6ffa7045b868cda944e0fdfbb751cd9698fd5d3f8f3e4a111b349",
  "mcp:zte:calls": "0d29fdb97d2fc3d3bf8e075faad9141863fb0c93d5d2bff8548eda8eb672c4a4",
  "reference:zh-CN:api-routes": "9badb11bb2f3bac7fedb894ac2c3f2b5ca1cd15372ee4c80d682c239ae25682b",
  "reference:zh-CN:api-events": "ffead99d221268514f1e68cab17a6d078b468d0b061e6bf7edaabcbe18ecb57b",
  "reference:zh-CN:api-errors": "b1e37b2ffcd90d414d4a972d86a3fa3b931ef748912d8ef8bd004349afd3a20b",
  "reference:en:api-routes": "dce5ba8c606f4c3556759a216fbfc90f63e0ca7f6c213b8228b7024d1f9879de",
  "reference:en:api-events": "8c663e538a79b654f870005ca2e5cfe7d11bc3fb5bc9f070c455d3323cf70e97",
  "reference:en:api-errors": "93e0cc67b139f8c159e5d536446baf5a8d22d4171b08626b8a03f38416764335",
};

const PATHS: ReadonlyArray<string> = [
  "/api/telemetry",
  "/api/timeseries",
  "/api/neighbors",
  "/api/topology",
  "/api/settings",
  "/api/access-control",
  "/api/cellular",
  "/api/session/status",
  "/api/device/profile",
  "/api/alerts",
  "/api/audit",
  "/api/telemetry/refresh",
  "/api/neighbors/scan",
  "/api/topology/refresh",
  "/api/settings/refresh",
  "/api/access-control/refresh",
  "/api/cellular/refresh",
  "/api/control/band-lock",
  "/api/control/cell-lock",
  "/api/control/unlock",
  "/api/control/reboot",
  "/api/control/reconnect",
  "/api/control/security",
  "/api/control/wifi7",
  "/api/control/antenna",
  "/api/control/mobile-data",
  "/api/control/network-mode",
  "/api/control/operator-scan",
  "/api/control/operator",
  "/api/control/sim-slot",
  "/api/control/sim-pin",
  "/api/control/airplane-mode",
  "/api/control/roaming",
  "/api/control/apn",
  "/api/control/data-limit",
  "/api/control/traffic-reset",
  "/api/control/ussd",
  "/api/session/reset-breaker",
  "/api/control/wifi-access",
  "/api/control/wifi-mac-filter",
  "/api/control/time-rule",
  "/api/sms/status",
  "/api/sms/countries",
  "/api/sms/threads",
  "/api/sms/thread",
  "/api/sms/contacts",
  "/api/sms/trash",
  "/api/sms/preview",
  "/api/sms/sync",
  "/api/sms/send",
  "/api/sms/read",
  "/api/sms/delete",
  "/api/sms/trash/restore",
  "/api/sms/trash/purge",
  "/api/sms/contacts/upsert",
  "/api/sms/contacts/delete",
  "/api/sms/contacts/import-vcf",
  "/api/health",
  "/api/events",
  "/metrics",
  // Not routes: prefixes, sub-paths, typos and the console's own
  "/api/sms",
  "/api/sms/nope",
  "/api/control",
  "/api/control/nope",
  "/api/control/wifi-access/x",
  "/api/control/time-rule/1",
  "/api/telemetry/refresh/x",
  "/api/session/reset-breaker/x",
  "/api/nope",
  "/api/console",
  "/api/console/cpe",
  "/api/auth/status",
];

const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"] as const;
const TOKEN = "operations_snapshot_token";
const MCP_MODEL = "B535-232";
const MCP_ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};

const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

function smsServiceOn(core: FengSuiCore, dir: string): SmsService {
  const cipher = StorageCipher.fromSecret("operations_snapshot_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  return new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
}

/** Every provider at its widest exposure (as the daemon builds them, with every switch on). */
function mcpServerOn(core: FengSuiCore, sms: SmsService | null): FengSuiMcpServer {
  const providers: McpToolProvider[] = [new AccessControlMcpTools({ core, allowWrites: true, redactSensitive: () => false }), new CellularMcpTools({ core })];
  if (sms) providers.push(new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 }));
  return new FengSuiMcpServer({ core, allowMutations: true, experimental: { allowed: () => true, change: () => ({ ok: true, detail: "" }) }, toolProviders: providers });
}

/** The tool lists, the instructions and the answer to each tool called with nothing (and with confirm and an unknown argument). */
async function mcpWorld(server: FengSuiMcpServer): Promise<Record<string, string>> {
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>, permissions?: string[]): Promise<Record<string, unknown>> =>
    ((await server.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {}, permissions ? { permissions: permissions as never } : {})).body as JsonRpcSuccessResponse).result as Record<string, unknown>;
  const tools = (await rpc("tools/list", {}))["tools"] as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
  const calls: string[] = [];
  for (const tool of tools) {
    for (const args of [{}, { confirm: true, notAnArgument: 1 }]) {
      const result = (await rpc("tools/call", { name: tool.name, arguments: args }))["structuredContent"] as Record<string, unknown>;
      calls.push(`${tool.name} ${JSON.stringify(args)} → ${String(result["ok"])} ${String(result["errorCode"] ?? "")} ${result["ok"] === true ? "" : String(result["message"] ?? "")}`);
    }
  }
  return {
    tools: JSON.stringify(tools, null, 1),
    readToken: JSON.stringify((await rpc("tools/list", {}, ["sms-read"]))["tools"]),
    noPermission: JSON.stringify((await rpc("tools/list", {}, []))["tools"]),
    instructions: String((await rpc("initialize", { protocolVersion: "2025-06-18" }))["instructions"]),
    calls: calls.join("\n"),
  };
}

/** The daemon's own loopback server is asked with the real fetch; the guard blocks every other request. */
const loopbackFetch = globalThis.fetch;
let restore: () => void;
before(() => {
  restore = blockNetwork();
});
after(() => restore());

describe("the entries before the operation registry", () => {
  it("leave the permissions, the routes, the MCP tools and the API reference as they were", async () => {
    const parts: Record<string, string> = {};

    // The permission a token needs, for every path and method
    parts["permissions"] = PATHS.flatMap((p) => METHODS.map((m) => `${m} ${p} ${String(permissionForRoute(m, p))}`)).join("\n");

    // The daemon's answer to each path and method, with an empty object and with a body that is no JSON
    {
      const cpe = createStrictCpe();
      const dir = tempDir("fengsui-ops-snapshot-");
      const envPath = path.join(dir, ".env");
      fs.writeFileSync(
        envPath,
        ["CPE_URL=http://192.168.8.1", `CPE_PASSWORD=${cpe.password}`, `API_TOKEN=${TOKEN}`, "WEB_HOST=127.0.0.1", "WEB_PORT=0", "METRICS_ENABLED=true", `STATE_FILE=${path.join(dir, "state.json")}`, `STATIC_DIR=${path.join(dir, "no-static")}`].join("\n")
      );
      const config = loadConfig({ envPath, ignoreProcessEnv: true });
      const core = createFengSuiCore({
        connection: mockConnection(cpe, { cpeUrl: config.cpeUrl }),
        stateStore: new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey }),
        timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
        pollIntervalMs: 600_000,
        neighborScanIntervalMs: 600_000,
      });
      core.monitor.init();
      assert.ok(await core.monitor.identifyDevice());
      await core.monitor.refreshTelemetry();
      const sms = smsServiceOn(core, dir);
      const sseBus = new SseEventBus({ heartbeatMs: 2000 });
      sseBus.attachCore(core);
      sseBus.attachSms(sms);
      const server = new FengSuiHttpServer({ config, core, sseBus, mcpServer: new FengSuiMcpServer({ allowMutations: false, core }), envPath, sms, settings: consoleSettingsFor(config) });
      const bound = await server.listen();
      const base = `http://${bound.host}:${bound.port}`;
      const answers: string[] = [];
      try {
        for (const p of PATHS) {
          for (const [method, body] of [["GET", undefined], ["POST", "{}"], ["POST", "x"], ["PUT", "{}"]] as const) {
            // The event stream never ends: its first line is enough
            if (p === "/api/events" && method === "GET") continue;
            const res = await loopbackFetch(`${base}${p}`, { method, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, ...(body !== undefined ? { body } : {}) });
            const text = await res.text();
            let detail = "";
            if (res.status >= 300 && text.startsWith("{")) {
              const json = JSON.parse(text) as Record<string, unknown>;
              detail = `${String(json["errorCode"])} ${String(json["message"])}`;
            }
            answers.push(`${method} ${p} ${body ?? "-"} → ${res.status} ${detail}`);
          }
        }
      } finally {
        sseBus.stop();
        await server.close();
        await sms.stop();
        await stopFengSuiCore(core);
        removeTempDir(dir);
      }
      parts["rest"] = answers.join("\n");
    }

    // The MCP tools on the verified H168-383, every provider's own list included (some show only on other routers)
    {
      const cpe = createStrictCpe();
      const dir = tempDir("fengsui-ops-snapshot-mcp-");
      const core = createFengSuiCore({
        connection: mockConnection(cpe),
        stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "operations_snapshot_key" }),
        timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
        pollIntervalMs: 600_000,
        neighborScanIntervalMs: 600_000,
      });
      core.monitor.init();
      const sms = smsServiceOn(core, dir);
      try {
        assert.ok(await core.monitor.identifyDevice());
        for (const [key, value] of Object.entries(await mcpWorld(mcpServerOn(core, sms)))) parts[`mcp:h168:${key}`] = value;
        parts["mcp:definitions"] = JSON.stringify(
          [
            new CoreMcpTools(core).getToolDefinitions(),
            new AccessControlMcpTools({ core, allowWrites: true }).getToolDefinitions(),
            new CellularMcpTools({ core }).getToolDefinitions(),
            new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 }).getToolDefinitions(),
            new SmsMcpTools({ sms, access: "read", sendPolicy: "known", sendLimitPerHour: 10 }).getToolDefinitions(),
          ],
          null,
          1
        );
      } finally {
        await sms.stop();
        await stopFengSuiCore(core);
        removeTempDir(dir);
      }
    }

    // An unverified HiLink model: the experimental forms
    {
      const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MCP_MODEL, endpoints: MCP_ENDPOINTS, sms: [], writes: {} });
      const dir = tempDir("fengsui-ops-snapshot-b535-");
      const core = createFengSuiCore({
        connection: mockConnection(cpe, { requestTimeoutMs: 2000 }),
        stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "operations_snapshot_key" }),
        timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
        pollIntervalMs: 600_000,
        neighborScanIntervalMs: 600_000,
      });
      core.monitor.init();
      const sms = smsServiceOn(core, dir);
      try {
        assert.ok(await core.monitor.identifyDevice());
        for (const [key, value] of Object.entries(await mcpWorld(mcpServerOn(core, sms)))) parts[`mcp:b535:${key}`] = value;
      } finally {
        await sms.stop();
        await stopFengSuiCore(core);
        removeTempDir(dir);
      }
    }

    // A ZTE router: a driver brand, with the cellular settings
    {
      const router = zteRouter({ sim: true, simSlot: "0" });
      const daemon = daemonOn("zte-goform", router.mock.fetchImpl, "http://192.168.0.1", ZTE_PASSWORD);
      try {
        assert.ok(await daemon.core.monitor.identifyDevice());
        for (const [key, value] of Object.entries(await mcpWorld(mcpServerOn(daemon.core, null)))) parts[`mcp:zte:${key}`] = value;
      } finally {
        await daemon.cleanup();
      }
    }

    // The API reference's generated blocks
    for (const locale of ["zh-CN", "en"] as const) {
      for (const [block, text] of Object.entries(apiReferenceBlocks(locale))) parts[`reference:${locale}:${block}`] = text;
    }

    const out = process.env["OPERATIONS_SNAPSHOT_DIR"];
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      for (const [key, text] of Object.entries(parts)) fs.writeFileSync(path.join(out, `${key.replaceAll(":", "_")}.txt`), text);
    }
    const now = Object.fromEntries(Object.entries(parts).map(([key, text]) => [key, sha(text)]));
    const changed = Object.keys({ ...BEFORE, ...now }).filter((key) => BEFORE[key] !== now[key]);
    assert.deepEqual(changed, [], `changed: ${JSON.stringify(Object.fromEntries(changed.map((key) => [key, now[key] ?? null])), null, 1)}`);
  });
});
