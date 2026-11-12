import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runAsActor } from "../src/audit-log.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { ExperimentalLockChange } from "../src/cpe-controls.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { switchExperimentalWrite } from "../src/experimental-switch.ts";
import { FengSuiMcpServer, type JsonRpcSuccessResponse } from "../src/mcp-server.ts";
import type { ControlAppliedEvent } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * AI agents testing a model nobody verified: `get_device_report` for everyone, and
 * `set_experimental_write` (turning one of the default-on writes off, or back on) only while the
 * owner allows it (Settings → Device), under the console's own rules. Mocks and placeholders only,
 * no network.
 */

const MODEL = "B535-232";
const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
};

function fixture(cpe: { fetchImpl: typeof fetch; password: string }) {
  const dir = tempDir("fengsui-agent-exp-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "agent_exp_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: StorageCipher.fromSecret("agent_exp_key") });
  settings.load();
  let allowed = false;
  let clock = 1_000_000;
  const probes: string[] = [];
  const server = new FengSuiMcpServer({
    core,
    allowMutations: true,
    experimental: {
      allowed: () => allowed,
      change: (request) => switchExperimentalWrite(settings, core.scheduler.device, request),
      probed: (outcome, detail) => probes.push(`${outcome} ${detail}`),
      now: () => clock,
    },
  });
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>, permissions?: string[]): Promise<Record<string, unknown>> =>
    ((await server.handleHttpMessage(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), {}, permissions ? { permissions: permissions as never } : {})).body as JsonRpcSuccessResponse)
      .result as Record<string, unknown>;
  const tools = async (): Promise<string[]> => ((await rpc("tools/list", {}))["tools"] as Array<{ name: string }>).map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown>, permissions?: string[]) => (await rpc("tools/call", { name, arguments: args }, permissions))["structuredContent"] as Record<string, unknown>;
  return {
    core,
    settings,
    tools,
    call,
    probes,
    allow: (on: boolean) => {
      allowed = on;
    },
    tick: (ms: number) => {
      clock += ms;
    },
    cleanup: async () => {
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

describe("AI agents testing a model nobody verified", () => {
  it("gives every token the desensitized report, and lets an agent turn an experimental write off or back on only while the owner allows it", async () => {
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: ENDPOINTS, writes: {} });
    const fx = fixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      const report = await fx.call("get_device_report", {}, []);
      assert.equal(report["ok"], true);
      assert.equal(report["agentsMayTestExperimental"], false);
      assert.match(JSON.stringify(report["report"]), /B535-232/);
      // The report says what each write is on this router: on by default where FengSui implements it
      const access = (report["report"] as { access: { writes: string; features: Record<string, string> } }).access;
      assert.deepEqual([access.writes, access.features["bandLock"], access.features["cellLock"]], ["experimental", "enabled", "not_implemented"]);
      assert.ok((await fx.tools()).includes("lock_band"), "the write is offered without anyone turning it on");

      // Not allowed: not listed, refused by name, nothing changed
      assert.equal((await fx.tools()).includes("set_experimental_write"), false);
      const refused = await fx.call("set_experimental_write", { feature: "bandLock", enabled: false, confirm: true });
      assert.equal(refused["errorCode"], "EXPERIMENTAL_NOT_ALLOWED");
      assert.equal(fx.settings.disabledWrites.length, 0);

      // Allowed: the console's rules, the router permission, confirm
      fx.allow(true);
      assert.ok((await fx.tools()).includes("set_experimental_write"));
      assert.equal((await fx.call("get_device_report", {}))["agentsMayTestExperimental"], true);
      assert.equal((await fx.call("set_experimental_write", { feature: "bandLock", enabled: false, confirm: true }, ["sms-read"]))["errorCode"], "READ_ONLY_TOKEN");
      assert.equal((await fx.call("set_experimental_write", { feature: "bandLock", enabled: false }))["errorCode"], "CONFIRMATION_REQUIRED");
      assert.equal((await fx.call("set_experimental_write", { feature: "bandLock", enabled: false, model: MODEL, confirm: true }))["errorCode"], "VALIDATION_ERROR", "there is no model to type any more");
      assert.equal((await fx.call("set_experimental_write", { feature: "wifi", enabled: false, confirm: true }))["errorCode"], "VALIDATION_ERROR", "no brand has a switch for it");
      // A switch some brand has, which this router's brand does not implement
      const antenna = await fx.call("set_experimental_write", { feature: "antenna", enabled: false, confirm: true });
      assert.deepEqual([antenna["errorCode"], antenna["state"]], ["EXPERIMENTAL_UNAVAILABLE", "not_implemented"]);
      // A write FengSui has nothing for on this router has no switch
      const none = await fx.call("set_experimental_write", { feature: "cellLock", enabled: true, confirm: true });
      assert.deepEqual([none["errorCode"], none["state"]], ["EXPERIMENTAL_UNAVAILABLE", "not_implemented"]);

      const off = await fx.call("set_experimental_write", { feature: "bandLock", enabled: false, confirm: true }, ["control"]);
      assert.deepEqual([off["ok"], off["change"], (off["features"] as Record<string, string>)["bandLock"]], [true, `bandLock off for ${MODEL}`, "disabled"]);
      assert.equal(fx.core.scheduler.device.writeAccess("bandLock"), "disabled");
      assert.deepEqual(fx.settings.disabledWrites.map((d) => [d.model, d.feature]), [[MODEL, "bandLock"]]);
      assert.equal((await fx.tools()).includes("lock_band"), false, "the write it turned off is gone from the list");
      assert.equal((await fx.call("lock_band", { lteBands: ["B1"], confirm: true }))["errorCode"], "DEVICE_WRITE_DISABLED");
      const on = await fx.call("set_experimental_write", { feature: "bandLock", enabled: true, confirm: true }, ["control"]);
      assert.deepEqual([on["ok"], on["change"], (on["features"] as Record<string, string>)["bandLock"]], [true, `bandLock on for ${MODEL}`, "enabled"]);
      assert.equal(fx.core.scheduler.device.writeAccess("bandLock"), "experimental");
      assert.ok((await fx.tools()).includes("lock_band"), "and offered again");

      // The safety net hears of an agent's band lock
      const guarded: ExperimentalLockChange[] = [];
      fx.core.controls.onExperimentalLock = (change) => guarded.push(change);
      const locked = await runAsActor({ channel: "mcp", label: "test agent" }, () => fx.call("lock_band", { lteBands: ["B1"], confirm: true }));
      assert.equal(locked["ok"], true);
      // With the router's mask from right before the lock, read in the lock's own session
      assert.deepEqual(guarded.map((change) => [change.lock.mode, change.savedLteMask]), [["band_lock", "800800c5"]]);

      // The WAN stays down: the safety net writes that mask back (here every advertised band, so unlocked)
      cpe.setConnectionStatus("902");
      const applied: ControlAppliedEvent[] = [];
      fx.core.scheduler.on("control:applied", (event: ControlAppliedEvent) => applied.push(event));
      const restored = await fx.core.controls.rollBackLocks(fx.core.controls.getPersistedLockState().updatedAtIso, { lteMask: guarded[0]?.savedLteMask ?? "" });
      assert.equal(restored.applied ? restored.lockState?.mode : restored.skipped, "unlocked");
      assert.equal(cpe.settings.netMode["LTEBand"], "800800c5");
      assert.equal(applied[0]?.check?.readback, "match");
      assert.match(applied[0]?.summaryEn ?? "", /^The WAN did not come back: wrote back the band setting from before the lock/);
      cpe.setConnectionStatus("901");

      // And of every other lock on this router alike: the console, a token, Telegram
      await runAsActor({ channel: "web" }, () => fx.core.controls.lockBands({ lteBands: [1] }));
      await fx.core.controls.unlockAllLocks();
      assert.equal(guarded.length, 2, "taking the locks off is nothing to watch");
      await runAsActor({ channel: "token", label: "a token" }, () => fx.core.controls.lockBands({ lteBands: [3] }));
      // Each with the mask the router had right before it (after the unlock: every band)
      assert.deepEqual(guarded.map((change) => [change.lock.lteBands, change.savedLteMask]), [[[1], "800800c5"], [[1], "800800c5"], [[3], "7fffffffffffffff"]]);

    } finally {
      await fx.cleanup();
    }
  });

  it("offers no experimental write on the verified model, but the read-only endpoint probe", async () => {
    const fx = fixture(createStrictCpe());
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      fx.allow(true);
      assert.equal((await fx.tools()).includes("set_experimental_write"), false);
      assert.ok((await fx.tools()).includes("probe_router_endpoints"));
      const report = await fx.call("get_device_report", {});
      assert.deepEqual([report["agentsMayTestExperimental"], report["agentsMayProbeEndpoints"]], [false, true]);
      assert.equal((await fx.call("set_experimental_write", { feature: "reboot", enabled: false, confirm: true }))["errorCode"], "EXPERIMENTAL_UNAVAILABLE");
    } finally {
      await fx.cleanup();
    }
  });

  it("lets an agent read endpoints FengSui does not use only while the owner allows it, for every token, one probe at a time, each one audited", async () => {
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: MODEL, endpoints: { ...ENDPOINTS, "/api/device/autorun-version": "<response><Version>9.9.9-placeholder</Version></response>" } });
    const fx = fixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.equal((await fx.tools()).includes("probe_router_endpoints"), false);
      assert.equal((await fx.call("probe_router_endpoints", { paths: ["/api/device/autorun-version"] }))["errorCode"], "EXPERIMENTAL_NOT_ALLOWED");

      fx.allow(true);
      assert.equal((await fx.call("probe_router_endpoints", { paths: [] }))["errorCode"], "VALIDATION_ERROR");
      assert.equal((await fx.call("probe_router_endpoints", { paths: ["/api/../etc"] }))["errorCode"], "VALIDATION_ERROR");
      assert.deepEqual(fx.probes, [], "nothing to record before a valid call");

      const probe = await fx.call("probe_router_endpoints", { paths: ["/api/device/autorun-version", "/api/net/plmn-list", "/api/net/net-mode"] }, []);
      assert.equal(probe["ok"], true);
      const endpoints = probe["endpoints"] as Array<{ path: string; state: string; known: boolean }>;
      assert.deepEqual(
        endpoints.map((e) => [e.path, e.state, e.known]),
        [
          ["/api/device/autorun-version", "supported", false],
          ["/api/net/plmn-list", "refused", true],
          ["/api/net/net-mode", "supported", true],
        ]
      );
      assert.ok(!JSON.stringify(probe).includes("9.9.9-placeholder"), "structure only");
      assert.equal(cpe.count("/api/net/plmn-list"), 0);
      assert.deepEqual(fx.probes, ["applied 2 read: /api/device/autorun-version, /api/net/plmn-list (refused), /api/net/net-mode"]);

      const soon = await fx.call("probe_router_endpoints", { paths: ["/api/device/autorun-version"] });
      assert.deepEqual([soon["errorCode"], soon["retryAfterSec"]], ["PROBE_TOO_SOON", 10]);
      fx.tick(10_000);
      // Every path refused: answered without a session, recorded as refused
      const logins = cpe.stats.logins;
      assert.equal((await fx.call("probe_router_endpoints", { paths: ["/api/webserver/token"] }))["ok"], true);
      assert.equal(cpe.stats.logins, logins);
      assert.equal(fx.probes.at(-1), "refused 0 read: /api/webserver/token (refused)");

      // Someone logged in to the router's web page: FengSui yields and reads nothing
      fx.tick(10_000);
      cpe.human.loginSameIp();
      const skipped = await fx.call("probe_router_endpoints", { paths: ["/api/device/autorun-version"] });
      assert.equal(skipped["errorCode"], "PROBE_SKIPPED");
      assert.equal(fx.probes.at(-1), "refused skipped: /api/device/autorun-version");
      cpe.human.logout();
    } finally {
      await fx.cleanup();
    }
  });
});
