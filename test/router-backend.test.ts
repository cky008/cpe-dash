import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DriverBackend, HilinkBackend, routerBackendOf } from "../src/backends/index.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { selectRouterBackend } from "../src/router-backend.ts";
import { prepareSmsSubmission } from "../src/sms/protocol.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * One interface for every brand: the services above `RouterBackend` never ask which stack speaks
 * to the router. Mock routers only, no network.
 */

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sources(full) : entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("router backend: one interface for every brand", () => {
  it("chooses the stack in one place, by the connection's family", () => {
    const backends = { hilink: { family: "huawei" }, driver: { family: "openwrt" } } as unknown as Parameters<typeof selectRouterBackend>[1];
    assert.equal(selectRouterBackend({ isDriverMode: () => false }, backends), backends.hilink);
    assert.equal(selectRouterBackend({ isDriverMode: () => true }, backends), backends.driver);
  });

  it("follows the connection: another brand saved is spoken to by the other backend from the next call on", async () => {
    const router = openwrtRouter();
    const dir = tempDir("fengsui-backend-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.1.1", cpeUsername: "root", cpePassword: OPENWRT_PASSWORD, fetchImpl: router.mock.fetchImpl, requestTimeoutMs: 1000 }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "backend_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      family: "openwrt",
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    try {
      core.monitor.init();
      const backend = routerBackendOf(core.scheduler);
      assert.ok(backend() instanceof DriverBackend);
      assert.equal(backend().family, "openwrt");
      const snap = await backend().readTelemetry({ smsCounters: false });
      assert.equal(snap?.device.deviceName, "RM520N-GL");

      // What no driver reads yet has nothing to show, and costs no request
      const before = router.mock.requests.length;
      assert.deepEqual([await backend().readTopology({}), await backend().readSettings({}), await backend().readAccessControl({})], [null, null, null]);
      assert.equal(router.mock.requests.length, before);

      await core.scheduler.reloadCredentialsAndResetBreaker(OPENWRT_PASSWORD, "root", "huawei");
      assert.ok(backend() instanceof HilinkBackend);
      assert.equal(backend().family, "huawei");
      // Asked for on a HiLink connection, the driver backend names no family
      assert.throws(() => new DriverBackend(core.scheduler).family, /HiLink connection/);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("keeps the brand out of everything above it", () => {
    // The stack is chosen in router-backend.ts; the scheduler owns the two clients; the backends speak to them
    const allowed = (file: string): boolean => file === "src/scheduler.ts" || file === "src/router-backend.ts" || file.startsWith("src/backends/");
    for (const file of sources("src")) {
      if (allowed(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!/\bisDriverMode\(/.test(source), `${file} asks which stack speaks to the router: add the verb to RouterBackend instead`);
      assert.ok(!/\bexecuteDriver[A-Z]\w*\(/.test(source), `${file} opens a driver session itself: go through RouterBackend`);
    }
    // The read and write services name no driver and no HiLink read of their own
    for (const file of ["src/cpe-monitor.ts", "src/cpe-controls.ts"]) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!source.includes('"./drivers/'), `${file} imports a driver`);
    }
    assert.ok(!/\bexecuteRead\(/.test(fs.readFileSync("src/cpe-monitor.ts", "utf8")), "the monitor reads through the backend only");
    // SMS is a set of verbs like every other capability: its service opens no session and speaks no router's wire format
    const sms = fs.readFileSync("src/sms/service.ts", "utf8");
    assert.ok(!/\bexecute(Read|Control)\(/.test(sms), "the SMS service opens a session itself: go through RouterBackend");
    assert.ok(!/\bprobePublic\(/.test(sms), "the SMS service asks a HiLink endpoint itself: go through RouterBackend");
    const wire = [...sms.matchAll(/import \{([^}]+)\} from "\.\/protocol\.ts"/g)].flatMap((m) => (m[1] ?? "").split(",").map((name) => name.replace(/\btype\b/, "").trim())).filter(Boolean);
    assert.deepEqual(wire.sort(), ["PreparedSmsSubmission", "prepareSmsSubmission", "unconfirmedSendResult"], "the SMS service takes only the brand-neutral checks from the HiLink protocol module");
  });

  it("answers the SMS verbs on a brand without SMS: nothing to list, every write refused by the gate, no request", async () => {
    const router = new LanRouterMock(() => {
      throw new Error("a brand without SMS was sent a request");
    });
    const dir = tempDir("fengsui-backend-sms-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.66.1", cpeUsername: "root", cpePassword: "placeholder_password", fetchImpl: router.fetchImpl, requestTimeoutMs: 1000 }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "backend_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      family: "nradio",
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    try {
      core.monitor.init();
      // The gate knows the model, so it answers before any session
      core.scheduler.device.see("C8-668", "NROS 2.1");
      const backend = routerBackendOf(core.scheduler);
      const summary = (): { zh: string; en: string } => ({ zh: "", en: "" });
      assert.equal(await backend().listSms({ mode: "full", recentCount: 20, expandThread: () => true, priority: "low" }), null);
      assert.equal(await backend().peekSmsUnread(), null);
      await assert.rejects(backend().sendSms(prepareSmsSubmission(["+353830000001"], "hello"), {}, summary), DeviceReadOnlyError);
      await assert.rejects(backend().markSmsRead([1], summary), DeviceReadOnlyError);
      await assert.rejects(backend().deleteSms([1], summary), DeviceReadOnlyError);
      assert.equal(router.requests.length, 0);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });
});
