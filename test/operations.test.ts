import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { API_ROUTES, CONSOLE_ROUTE_PREFIXES } from "../scripts/api-reference.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { AccessControlMcpTools } from "../src/mcp-access-tools.ts";
import { CellularMcpTools } from "../src/mcp-cellular-tools.ts";
import { CoreMcpTools } from "../src/mcp-core-tools.ts";
import type { McpToolProvider } from "../src/mcp-tool-provider.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMcpTools } from "../src/sms/mcp-tools.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { mockConnection } from "./helpers/connection.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { CONTROL_FEATURES, type ControlAction } from "../src/features.ts";
import {
  MCP_TOOLS,
  OPERATION_NAMES,
  REST_OPERATIONS,
  type McpOperation,
  operationActions,
  operationFeatures,
  operationRecord,
  permissionForRoute,
  restBinding,
  restOperation,
  toolDefinition,
  toolOperation,
} from "../src/operations/registry.ts";

/**
 * The operation registry (src/operations/, docs/dev/architecture.md 19.9) holds together: every
 * route and tool once, each write's actions filed in the capability registry, every MCP tool in one
 * provider's list, every write tool asking for `confirm`, and a registered route's permission is
 * what a token is asked for.
 */

const MCP_OPERATIONS = OPERATION_NAMES.filter((op): op is McpOperation => operationRecord(op).mcp !== undefined);

describe("the operation registry", () => {
  it("has each REST route once, under /api/sms exactly the SMS table's, and the server's own routes as GETs", () => {
    assert.equal(REST_OPERATIONS.length, OPERATION_NAMES.filter((op) => operationRecord(op).rest).length, "a method and path twice");
    for (const op of REST_OPERATIONS) {
      const rest = restBinding(op);
      assert.equal(restOperation(rest.method, rest.path), op);
      assert.equal(rest.group === "sms", rest.path.startsWith("/api/sms/"), `${op}: the SMS table is the routes under /api/sms/`);
      if (rest.served) assert.equal(rest.method, "GET", op);
      if (rest.example !== undefined) {
        assert.equal(rest.method, "POST", `${op}: only a POST has a body`);
        if (!rest.example.includes("…") && !rest.example.includes("<")) assert.equal(typeof JSON.parse(rest.example), "object", op);
      }
    }
    assert.deepEqual(REST_OPERATIONS.filter((op) => restBinding(op).served).map((op) => restBinding(op).path), ["/api/health", "/api/events", "/metrics"]);
  });

  it("asks a token for a registered route's own permission, and reads need none but SMS reading", () => {
    for (const op of REST_OPERATIONS) {
      const record = operationRecord(op);
      const rest = restBinding(op);
      assert.equal(permissionForRoute(rest.method, rest.path), record.permission, op);
      if (record.access === "read") assert.ok(record.permission === null || record.permission === "sms-read", op);
      else assert.notEqual(record.permission, null, `${op}: a write needs a permission`);
    }
  });

  it("files every router write it runs in the capability registry", () => {
    for (const op of OPERATION_NAMES) {
      const actions = operationActions(op);
      if (operationRecord(op).access === "read") assert.deepEqual(actions, [], `${op}: a read runs no write`);
      for (const action of actions) assert.ok(Object.hasOwn(CONTROL_FEATURES, action), `${op}: ${action}`);
      assert.equal(operationFeatures(op).length, new Set(actions.map((action: ControlAction) => CONTROL_FEATURES[action])).size, op);
    }
    assert.deepEqual(operationFeatures("wifiAndAntenna"), ["wifi", "antenna"]);
    assert.deepEqual(operationFeatures("simPin"), ["simPin"]);
  });

  it("lists every MCP tool in one provider, each name once", () => {
    const listed = Object.values(MCP_TOOLS).flat() as ReadonlyArray<McpOperation>;
    assert.equal(new Set(listed).size, listed.length, "a tool in two lists");
    assert.deepEqual([...listed].sort(), [...MCP_OPERATIONS].sort(), "every tool of the registry in a provider's list");
    const names = MCP_OPERATIONS.map((op) => toolDefinition(op).name);
    assert.equal(new Set(names).size, names.length);
    for (const op of MCP_OPERATIONS) assert.equal(toolOperation(toolDefinition(op).name), op);
    assert.equal(toolOperation("no_such_tool"), null);
  });

  it("makes every write tool require confirm: true, and no read tool take it", () => {
    for (const op of MCP_OPERATIONS) {
      const { inputSchema } = toolDefinition(op);
      const write = operationRecord(op).access === "write";
      assert.equal(inputSchema.additionalProperties, false, op);
      if (write) {
        assert.equal(inputSchema.properties["confirm"]?.type, "boolean", op);
        assert.ok(inputSchema.required?.includes("confirm"), op);
      } else {
        assert.equal(inputSchema.properties["confirm"], undefined, op);
      }
      assert.equal(toolDefinition(op).annotations?.readOnlyHint, !write, op);
    }
  });

  it("judges a path no route takes by where it lies, as the routes around it need", () => {
    const cases: ReadonlyArray<readonly [string, string, string | null]> = [
      ["GET", "/api/control/band-lock", null],
      ["PUT", "/api/telemetry/refresh", null],
      ["POST", "/api/telemetry", "all"],
      ["POST", "/api/control/nope", "control"],
      ["POST", "/api/control/wifi-access/x", "access"],
      ["POST", "/api/session/reset-breaker/x", "all"],
      ["PUT", "/api/sms/preview", "sms-read"],
      ["POST", "/api/sms/nope", "sms-write"],
      ["GET", "/api/sms/nope", "sms-read"],
      ["POST", "/api/console/cpe", "all"],
    ];
    for (const [method, pathname, needed] of cases) assert.equal(permissionForRoute(method, pathname), needed, `${method} ${pathname}`);
  });
});

describe("the entries take what they offer from the registry", () => {
  it("lists each provider's tools exactly as the registry defines them, in its order", async () => {
    const dir = tempDir("fengsui-operations-");
    const core = createFengSuiCore({
      connection: mockConnection(createStrictCpe()),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "operations_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    });
    const cipher = StorageCipher.fromSecret("operations_key");
    const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
    const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
    const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353" });
    try {
      const listed = (provider: McpToolProvider) => provider.getToolDefinitions();
      const defined = (ops: ReadonlyArray<McpOperation>) => ops.map(toolDefinition);
      assert.deepEqual(listed(new CoreMcpTools(core)), defined(MCP_TOOLS.core));
      assert.deepEqual(listed(new AccessControlMcpTools({ core, allowWrites: true })), defined(MCP_TOOLS.access));
      assert.deepEqual(listed(new AccessControlMcpTools({ core, allowWrites: false })), defined(MCP_TOOLS.access.filter((op) => operationRecord(op).access === "read")));
      assert.deepEqual(listed(new CellularMcpTools({ core })), defined(MCP_TOOLS.cellular));
      assert.deepEqual(listed(new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 })), defined(MCP_TOOLS.sms));
      assert.deepEqual(listed(new SmsMcpTools({ sms, access: "read", sendPolicy: "known", sendLimitPerHour: 10 })), defined(MCP_TOOLS.sms.filter((op) => operationRecord(op).access === "read")));
      assert.deepEqual(listed(new SmsMcpTools({ sms, access: "none", sendPolicy: "known", sendLimitPerHour: 10 })), []);
      // Each provider takes exactly the tools of its list
      for (const [provider, ops] of [
        [new CoreMcpTools(core), MCP_TOOLS.core],
        [new AccessControlMcpTools({ core, allowWrites: true }), MCP_TOOLS.access],
        [new CellularMcpTools({ core }), MCP_TOOLS.cellular],
        [new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 }), MCP_TOOLS.sms],
      ] as const) {
        const ownNames = new Set<string>(ops.map((op) => toolDefinition(op).name));
        for (const op of MCP_OPERATIONS) assert.equal(provider.handles(toolDefinition(op).name), ownNames.has(toolDefinition(op).name), toolDefinition(op).name);
      }
    } finally {
      await sms.stop();
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("gives the API reference exactly the registry's routes, none of the console's own", () => {
    assert.deepEqual(API_ROUTES, REST_OPERATIONS.map(restBinding));
    for (const route of API_ROUTES) assert.ok(!CONSOLE_ROUTE_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)), route.path);
  });
});
