import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { DeviceReadOnlyError } from "../src/scheduler.ts";
import { SessionBackend } from "../src/router-backend.ts";
import { ROUTER_FAMILY_FACTS } from "../src/router-family.ts";
import { prepareSmsSubmission } from "../src/sms/protocol.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { mockConnection } from "./helpers/connection.ts";

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
  it("has one backend, which names no brand: what a session sends is the brand's driver's", () => {
    const source = fs.readFileSync("src/router-backend.ts", "utf8");
    assert.ok(!source.includes('"./drivers/'), "the backend imports a brand's driver");
    for (const family of Object.keys(ROUTER_FAMILY_FACTS)) assert.ok(!source.includes(`"${family}"`), `the backend names the brand ${family}`);
    assert.ok(!/\bisDriverFamily\(/.test(source), "the backend asks which brand it speaks to");
  });

  it("follows the connection: another brand saved is spoken to by the other backend from the next call on", async () => {
    const router = openwrtRouter();
    const dir = tempDir("fengsui-backend-");
    const core = createFengSuiCore({
      connection: mockConnection({ password: OPENWRT_PASSWORD, fetchImpl: router.mock.fetchImpl }, { cpeUrl: "http://192.168.1.1", cpeUsername: "root", requestTimeoutMs: 1000 }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "backend_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      family: "openwrt",
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    try {
      core.monitor.init();
      const one = new SessionBackend(core.scheduler);
      const backend = (): SessionBackend => one;
      assert.equal(core.scheduler.driver.family, "openwrt");
      assert.equal(backend().family, "openwrt");
      const snap = await backend().readTelemetry({ smsCounters: false });
      assert.equal(snap?.device.deviceName, "RM520N-GL");

      // What no driver reads yet has nothing to show, and costs no request
      const before = router.mock.requests.length;
      assert.deepEqual([await backend().readSettings({}), await backend().readAccessControl({})], [null, null]);
      assert.equal(router.mock.requests.length, before);
      // The device list is on record for this family; this router has no LuCI lease list to read
      assert.equal(await backend().readTopology({}), null);
      assert.ok(router.calls.some((c) => c.object === "luci-rpc" && c.method === "getDHCPLeases"));

      await core.scheduler.reloadCredentialsAndResetBreaker(OPENWRT_PASSWORD, "root", "huawei");
      // The same backend: the connection's driver is HiLink's from the next verb on
      assert.equal(core.scheduler.driver.family, "huawei");
      assert.equal(backend().family, "huawei");
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });

  it("keeps the brand out of everything above it", () => {
    // The scheduler owns the connection and opens its sessions; only the backend asks it for one
    for (const file of sources("src")) {
      if (file === "src/scheduler.ts" || file === "src/router-backend.ts") continue;
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!/\bscheduler\.(read|control|refuse)\(/.test(source), `${file} opens a router session itself: add the verb to RouterBackend instead`);
      assert.ok(!/\.withSession(Detailed)?\(/.test(source) || file === "src/session-client.ts" || file.startsWith("src/drivers/") || file === "src/cpe-client.ts", `${file} opens a session around the scheduler`);
    }
    // The read and write services name no driver and no HiLink read of their own
    for (const file of ["src/cpe-monitor.ts", "src/cpe-controls.ts"]) {
      const source = fs.readFileSync(file, "utf8");
      assert.ok(!source.includes('"./drivers/'), `${file} imports a driver`);
    }
    assert.ok(!/\.read\(\s*async \(session/.test(fs.readFileSync("src/cpe-monitor.ts", "utf8")), "the monitor reads through the backend only");
    // Every write is a verb too: the write service opens no session of either stack
    const controls = fs.readFileSync("src/cpe-controls.ts", "utf8");
    assert.ok(!/\bexecute(Read|Control)\(/.test(controls), "the write service opens a session itself: go through RouterBackend");
    assert.ok(!/from "\.\/(generic-writes|access-control)\.ts"/.test(controls.replace(/import type [^;]+;/g, "")), "the write service speaks a router's wire format: go through RouterBackend");
    // SMS is a set of verbs like every other capability: its service opens no session and speaks no router's wire format
    const sms = fs.readFileSync("src/sms/service.ts", "utf8");
    assert.ok(!/\bexecute(Read|Control)\(/.test(sms), "the SMS service opens a session itself: go through RouterBackend");
    assert.ok(!/\bprobePublic\(/.test(sms), "the SMS service asks a HiLink endpoint itself: go through RouterBackend");
    const wire = [...sms.matchAll(/import \{([^}]+)\} from "\.\/protocol\.ts"/g)].flatMap((m) => (m[1] ?? "").split(",").map((name) => name.replace(/\btype\b/, "").trim())).filter(Boolean);
    assert.deepEqual(wire.sort(), ["prepareSmsSubmission", "unconfirmedSendResult"], "the SMS service takes only the brand-neutral checks from the HiLink protocol module");
  });

  it("answers the SMS verbs on a brand without SMS: nothing to list, every write refused by the gate, no request", async () => {
    const router = new LanRouterMock(() => {
      throw new Error("a brand without SMS was sent a request");
    });
    const dir = tempDir("fengsui-backend-sms-");
    const core = createFengSuiCore({
      connection: mockConnection({ password: "placeholder_password", fetchImpl: router.fetchImpl }, { cpeUrl: "http://192.168.66.1", cpeUsername: "root", requestTimeoutMs: 1000 }),
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
      const one = new SessionBackend(core.scheduler);
      const backend = (): SessionBackend => one;
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
