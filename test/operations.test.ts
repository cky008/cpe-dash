import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
