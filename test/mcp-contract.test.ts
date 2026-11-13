import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { readAntennaMode, readBandSelection, readCellLockCommand, readTimeSeriesPreset } from "../src/control-input.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { CpeControlValidationError } from "../src/cpe-domain.ts";
import { validateToolArguments } from "../src/mcp-schema.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse, LATEST_MCP_PROTOCOL_VERSION } from "../src/mcp-server.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer, TimeSeriesValidationError } from "../src/timeseries.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

function createServer() {
  const cpe = createStrictCpe();
  const dir = tempDir("fengsui-mcp-contract-");
  const core = createFengSuiCore({
    connection: mockConnection(cpe),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "mcp_contract_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
  });
  core.monitor.init();
  const server = new FengSuiMcpServer({ allowMutations: true, core });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}) =>
    ((await server.handleRawJsonMessage(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }))) as JsonRpcSuccessResponse).result;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await rpc("tools/call", { name, arguments: args })) as { isError: boolean; structuredContent: { errorCode?: string; message?: string } };
  return {
    cpe,
    core,
    server,
    rpc,
    call,
    close: async () => {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

describe("MCP tool contract enforcement", () => {
  it("rejects unknown, missing and mistyped arguments before any CPE session", async () => {
    const fx = createServer();
    try {
      const typo = await fx.call("set_security_switches", { upnpEnabled: false, firewallMacFilter: true, confirm: true });
      assert.equal(typo.isError, true);
      assert.equal(typo.structuredContent.errorCode, "VALIDATION_ERROR");
      assert.match(typo.structuredContent.message ?? "", /unknown parameter "firewallMacFilter"/);

      const cases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["lock_cell", { rat: "LTE", band: "B3", confirm: true }, /missing required parameter "arfcn"/],
        ["lock_cell", { rat: "LTE", band: "B3", arfcn: 1850.5, confirm: true }, /"arfcn" must be an integer/],
        ["lock_cell", { rat: "LTE", band: "B3", arfcn: 1850, pci: 1008, confirm: true }, /"pci" must be <= 1007/],
        ["lock_cell", { rat: "UMTS", band: "B3", arfcn: 1850, confirm: true }, /"rat" must be one of "LTE", "NR"/],
        ["lock_band", { lteBands: ["B1", true], confirm: true }, /"lteBands"/],
        ["query_telemetry_history", { preset: 6 }, /"preset" must be a string/],
        ["get_cpe_telemetry", { refresh: "yes" }, /"refresh" must be a boolean/],
        ["unlock_rf_locks", { force: true, confirm: true }, /unknown parameter "force" \(expected "confirm"\)/],
      ];
      for (const [tool, args, pattern] of cases) {
        const res = await fx.call(tool, args);
        assert.equal(res.structuredContent.errorCode, "VALIDATION_ERROR", `${tool} ${JSON.stringify(args)}`);
        assert.match(res.structuredContent.message ?? "", pattern);
      }
      assert.match(validateToolArguments({ type: "object", properties: {}, additionalProperties: false }, { force: true }) ?? "", /takes no parameters/);
      assert.equal(fx.cpe.stats.requests.length, 0, "validation never touched the router");
    } finally {
      await fx.close();
    }
  });

  it("checks explicit confirmation before the schema and before any session", async () => {
    const fx = createServer();
    try {
      for (const args of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }]) {
        const reboot = await fx.call("reboot_cpe", args);
        assert.equal(reboot.structuredContent.errorCode, "CONFIRMATION_REQUIRED", JSON.stringify(args));
        assert.equal((await fx.call("reconnect_cellular", args)).structuredContent.errorCode, "CONFIRMATION_REQUIRED");
      }
      assert.equal(fx.cpe.stats.requests.length, 0);
      const confirmed = await fx.call("reboot_cpe", { confirm: true });
      assert.equal(confirmed.isError, false);
      assert.ok(fx.cpe.stats.writes.some((w) => w.path === "/api/device/control"));
    } finally {
      await fx.close();
    }
  });

  it("negotiates initialize within the legacy revisions and answers server/discover for the stateless one", async () => {
    const fx = createServer();
    try {
      assert.equal(LATEST_MCP_PROTOCOL_VERSION, "2026-07-28");
      for (const [requested, expected] of [
        ["2025-11-25", "2025-11-25"],
        ["2024-11-05", "2024-11-05"],
        ["2026-07-28", "2025-11-25"],
        ["1999-01-01", "2025-11-25"],
      ] as const) {
        const init = (await fx.rpc("initialize", { protocolVersion: requested, capabilities: {}, clientInfo: { name: "t", version: "1" } })) as {
          protocolVersion: string;
        };
        assert.equal(init.protocolVersion, expected, requested);
      }
      assert.equal(fx.server.isSupportedProtocolVersion("2025-11-25"), true);
      assert.equal(fx.server.isSupportedProtocolVersion("2026-07-28"), true);
      assert.equal(fx.server.isSupportedProtocolVersion("1999-01-01"), false);
      const discover = (await fx.rpc("server/discover")) as { resultType: string; supportedVersions: string[] };
      assert.equal(discover.resultType, "complete");
      assert.ok(discover.supportedVersions.includes("2026-07-28"));
      const unsupported = (await fx.server.handleRawJsonMessage(
        JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1999-01-01" } } })
      )) as { error?: { code: number; data: { requested: string } } };
      assert.equal(unsupported.error?.code, -32022, "stdio answers an unsupported per-request version with UnsupportedProtocolVersionError");
      assert.equal(unsupported.error?.data.requested, "1999-01-01");
    } finally {
      await fx.close();
    }
  });
});

describe("shared REST/MCP input guards and the schema validator", () => {
  it("parses bands, cell locks, antenna modes and presets with one rule set", () => {
    assert.equal(readBandSelection({ b: "all" }, "b"), "all");
    assert.deepEqual(readBandSelection({ b: ["B1", 3] }, "b"), ["B1", 3]);
    assert.equal(readBandSelection({}, "b"), undefined);
    assert.throws(() => readBandSelection({ b: "B1" }, "b"), CpeControlValidationError);
    assert.throws(() => readBandSelection({ b: [null] }, "b"), /Invalid band entry/);

    assert.deepEqual(readCellLockCommand({ rat: "NR", band: "N78", arfcn: 650000 }, { allowNullPci: false }), {
      rat: "NR",
      band: "N78",
      arfcn: 650000,
    });
    assert.deepEqual(readCellLockCommand({ rat: "LTE", band: 3, arfcn: 1850, pci: null }, { allowNullPci: true }), {
      rat: "LTE",
      band: 3,
      arfcn: 1850,
    });
    assert.throws(() => readCellLockCommand({ rat: "LTE", band: 3, arfcn: 1850, pci: null }, { allowNullPci: false }), /"pci"/);
    assert.throws(() => readCellLockCommand({ rat: "LTE", band: 3, arfcn: "1850" }, { allowNullPci: true }), /"arfcn"/);
    assert.throws(() => readCellLockCommand({ rat: "LTE", arfcn: 1850 }, { allowNullPci: true }), /"band"/);

    assert.equal(readAntennaMode("external"), "external");
    assert.throws(() => readAntennaMode("satellite"), /"mode" must be/);
    assert.equal(readTimeSeriesPreset(undefined), "1h");
    assert.equal(readTimeSeriesPreset("24h"), "24h");
    assert.throws(() => readTimeSeriesPreset("48h"), TimeSeriesValidationError);
  });

  it("validates the declared JSON Schema subset", () => {
    const schema = {
      type: "object" as const,
      properties: {
        bands: { oneOf: [{ type: "string" as const, enum: ["all"] }, { type: "array" as const, maxItems: 2, items: { type: "integer" as const } }] },
        name: { type: "string" as const, maxLength: 4 },
        level: { type: "number" as const, minimum: 0 },
      },
      required: ["name"],
      additionalProperties: false,
    };
    assert.equal(validateToolArguments(schema, { name: "abc", bands: "all" }), null);
    assert.equal(validateToolArguments(schema, { name: "abc", bands: [1, 2], level: 0 }), null);
    assert.match(validateToolArguments(schema, {}) ?? "", /missing required parameter "name"/);
    assert.match(validateToolArguments(schema, { name: "abcde" }) ?? "", /exceeds 4 characters/);
    assert.match(validateToolArguments(schema, { name: "a", bands: [1, 2, 3] }) ?? "", /at most 2 items/);
    assert.match(validateToolArguments(schema, { name: "a", bands: [1.5] }) ?? "", /"bands"\[0\] must be an integer/);
    assert.match(validateToolArguments(schema, { name: "a", bands: "some" }) ?? "", /"bands" must be one of "all"/);
    assert.match(validateToolArguments(schema, { name: "a", level: -1 }) ?? "", />= 0/);
    assert.match(validateToolArguments(schema, { name: "a", extra: 1 }) ?? "", /unknown parameter "extra" \(expected "bands", "name", "level"\)/);
    assert.equal(validateToolArguments({ ...schema, additionalProperties: true }, { name: "a", extra: 1 }), null);
    // Names every object inherits are no declared parameter either
    for (const inherited of ["toString", "valueOf", "hasOwnProperty", "constructor"]) {
      assert.match(validateToolArguments(schema, { name: "a", [inherited]: "x" }) ?? "", new RegExp(`unknown parameter "${inherited}"`), inherited);
    }
  });
});
