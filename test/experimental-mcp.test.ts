import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { WriteFeature } from "../src/device-access.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { AccessControlMcpTools } from "../src/mcp-access-tools.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { McpToolDefinition } from "../src/mcp-tool-provider.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMcpTools } from "../src/sms/mcp-tools.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type FamilySms, blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Multi-model phase 3 on MCP: on a model nobody verified, a tool that writes to the router appears
 * only once its owner consented to that feature for that model, marked experimental and asking for
 * `confirm: true` every time; the experimental band lock offers LTE bands only. Called by name
 * without a consent it is refused before anything else. The H168-383's tools stay as they were.
 * Mocks and placeholders only, no network.
 */

const MODEL = "B535-232";
const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};
const MAILBOX: ReadonlyArray<FamilySms> = [{ index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 }];
const ROUTER_WRITES = [
  "lock_band",
  "lock_cell",
  "unlock_rf_locks",
  "set_security_switches",
  "set_wifi_and_antenna",
  "reconnect_cellular",
  "reboot_cpe",
  "set_device_internet_access",
  "set_wifi_mac_filter",
  "manage_internet_time_rule",
  "send_sms",
  "mark_sms_read",
  "delete_sms",
];

function fixture(cpe: { fetchImpl: typeof fetch; password: string }) {
  const dir = tempDir("fengsui-xmcp-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "xmcp_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("xmcp_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
  contacts.upsert({ phone: "+353830000001", name: "Friend" });
  const server = new FengSuiMcpServer({
    core,
    allowMutations: true,
    toolProviders: [
      new AccessControlMcpTools({ core, allowWrites: true, redactSensitive: () => false }),
      new SmsMcpTools({ sms, access: "full", sendPolicy: "known", sendLimitPerHour: 10 }),
    ],
  });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    ((await server.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {})).body as JsonRpcSuccessResponse).result as Record<string, unknown>;
  const tools = async (): Promise<McpToolDefinition[]> => (await rpc("tools/list"))["tools"] as McpToolDefinition[];
  const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args }))["structuredContent"] as Record<string, unknown>;
  return {
    core,
    sms,
    rpc,
    tools,
    call,
    consent: (...features: WriteFeature[]) => core.scheduler.device.setConsents(features.map((feature) => ({ model: MODEL, feature }))),
    cleanup: async () => {
      await sms.stop();
      await stopFengSuiCore(core);
      removeTempDir(dir);
    },
  };
}

let restore: () => void;
before(() => {
  restore = blockNetwork();
});
after(() => restore());

describe("MCP and experimental writes", () => {
  it("lists no router write without a consent, and refuses one called by name before it reaches the router", async () => {
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: ENDPOINTS, sms: MAILBOX, writes: {} });
    const fx = fixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const listed = (await fx.tools()).map((t) => t.name);
      assert.deepEqual(listed.filter((name) => ROUTER_WRITES.includes(name)), []);
      assert.ok(listed.includes("upsert_contact"));
      const refusal = await fx.call("lock_band", { lteBands: ["B1"], confirm: true });
      assert.deepEqual([refusal["errorCode"], refusal["model"], refusal["feature"]], ["DEVICE_UNVERIFIED_READ_ONLY", MODEL, "bandLock"]);
      assert.deepEqual(cpe.stats.writes, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("lists a consented feature's tools as experimental, asking for confirm every time, and only those", async () => {
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: ENDPOINTS, sms: MAILBOX, writes: {} });
    const fx = fixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.ok(await fx.sms.sync("full"));
      fx.consent("bandLock", "reboot", "smsWrite");
      const listed = await fx.tools();
      const names = listed.map((t) => t.name).filter((name) => ROUTER_WRITES.includes(name));
      assert.deepEqual(names, ["lock_band", "unlock_rf_locks", "reboot_cpe", "send_sms", "mark_sms_read", "delete_sms"]);
      for (const tool of listed.filter((t) => names.includes(t.name))) {
        assert.match(tool.description, new RegExp(`^EXPERIMENTAL on this router \\(${MODEL}`), tool.name);
        assert.ok(tool.inputSchema.required?.includes("confirm") && tool.inputSchema.properties["confirm"] !== undefined, `${tool.name} asks for confirm`);
      }
      const lockBand = listed.find((t) => t.name === "lock_band");
      assert.equal(lockBand?.inputSchema.properties["nrBands"], undefined, "LTE only");
      assert.match(lockBand?.description ?? "", /B1, B3, B7, B8, B20, B32/);
      assert.match((await fx.rpc("initialize", { protocolVersion: "2025-06-18" }))["instructions"] as string, /experimental[\s\S]*bandLock, reboot, smsWrite[\s\S]*confirm: true/);

      assert.equal((await fx.call("lock_band", { lteBands: ["B1", "B3"] }))["errorCode"], "CONFIRMATION_REQUIRED");
      assert.equal((await fx.call("lock_band", { lteBands: ["B1"], nrBands: ["N78"], confirm: true }))["errorCode"], "VALIDATION_ERROR");
      assert.equal((await fx.call("lock_band", { lteBands: ["B28"], confirm: true }))["errorCode"], "VALIDATION_ERROR", "a band the router does not advertise");
      assert.equal((await fx.call("mark_sms_read", { threadKey: "+353830000001" }))["errorCode"], "CONFIRMATION_REQUIRED");
      assert.equal(cpe.stats.writes.length, 0, "nothing written yet");

      assert.equal((await fx.call("lock_band", { lteBands: ["B1", "B3"], confirm: true }))["ok"], true);
      assert.equal((await fx.call("reboot_cpe", { confirm: true }))["ok"], true);
      assert.deepEqual(cpe.stats.writes.map((w) => w.path), ["/api/net/net-mode", "/api/device/control"]);
      const refusal = await fx.call("reconnect_cellular", { confirm: true });
      assert.deepEqual([refusal["errorCode"], refusal["feature"]], ["DEVICE_UNVERIFIED_READ_ONLY", "reconnect"]);

      fx.consent();
      assert.deepEqual((await fx.tools()).map((t) => t.name).filter((name) => ROUTER_WRITES.includes(name)), [], "gone once turned off");
      assert.equal((await fx.call("reboot_cpe", { confirm: true }))["errorCode"], "DEVICE_UNVERIFIED_READ_ONLY");
      assert.equal(cpe.stats.writes.length, 2);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the H168-383's tools as verified: NR bands offered, nothing experimental, confirm as on every write", async () => {
    const fx = fixture(createStrictCpe());
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const lockBand = (await fx.tools()).find((t) => t.name === "lock_band");
      assert.ok(lockBand?.inputSchema.properties["nrBands"]);
      assert.deepEqual(lockBand?.inputSchema.required, ["confirm"]);
      assert.doesNotMatch(lockBand?.description ?? "", /EXPERIMENTAL/);
    } finally {
      await fx.cleanup();
    }
  });
});
