import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ExperimentalWritesResponse, LockVerification, SessionStatusResponse, TelemetryEndpointResponse } from "../src/api-contract.ts";
import { type DemoSession, captureDemoSeed, openDemoSession } from "../scripts/capture-demo-seed.ts";
import { type DemoDaemon, startDemoDaemon } from "../scripts/demo-router.ts";
import { DemoBackend } from "../web/src/demo/backend.ts";
import { type DemoSeed, readDemoSeed, rebaseSeed } from "../web/src/demo/seed.ts";
import { type Json, assertSameShape, daemonCall, demoCall } from "./helpers/demo-contract.ts";

/**
 * The static demo's ZTE router (`?router=zte`) against the daemon on the same router: a 5G mobile
 * router with ZTE's goform pages, read and written through FengSui's ZTE driver. Both start from the
 * seed the daemon produced and must show the same status (battery, SIM card), refuse the same writes
 * and record the same experimental ones. Placeholders only.
 */

const TOKEN = "fengsui-demo-zte";

/** What a write answers that the visitor compares: status, error and message. */
function verdict(r: { status: number; json: Json }): unknown[] {
  return [r.status, r.json["errorCode"], r.json["message"], r.json["model"], r.json["feature"]];
}

/** A write result without what differs per run (its id and time). */
function brief(writes: ExperimentalWritesResponse["writes"]): unknown[] {
  return writes.map((w) => [w.action, w.feature, w.model, w.outcome, w.code, w.readback, w.reason, w.endpoints]);
}

function check(v: LockVerification): unknown[] {
  return [v.status, v.routerLteBands, v.issues];
}

describe("Static demo backend vs the real daemon on a ZTE mobile router", () => {
  let daemon: DemoDaemon;
  let session: DemoSession;
  let seed: DemoSeed;
  let backend: DemoBackend;
  const both = (method: string, route: string, body?: unknown) => Promise.all([daemonCall(session, method, route, body), demoCall(backend, method, route, body)]);

  before(async () => {
    daemon = await startDemoDaemon({ port: 0, token: TOKEN, scenario: "zte" });
    session = await openDemoSession(daemon.baseUrl, TOKEN);
    seed = readDemoSeed(JSON.parse(JSON.stringify(await captureDemoSeed(session))));
    // The demo's two tokens, so both sides offer the same ones
    await session.post("/api/console/tokens", { name: "Grafana", permissions: [], lifetimeDays: null });
    await session.post("/api/console/tokens", { name: "Claude Code", permissions: ["sms-read"], lifetimeDays: 90 });
    backend = new DemoBackend({ seed: rebaseSeed(seed, Date.now()), latencyScale: 0 });
  });

  after(async () => {
    backend.stop();
    await daemon.close();
  });

  it("captures a ZTE mobile router through its driver: its battery, SIM card and status, and what it does not provide", () => {
    const device = seed.telemetry.schedulerStatus.device;
    assert.deepEqual([device.family, device.model, device.verification, device.writes], ["zte-goform", "MU5001", "unverified-model", "experimental"]);
    assert.deepEqual(
      [device.features.bandLock, device.features.cellLock, device.features.reboot, device.features.reconnect, device.features.mobileData, device.features.smsWrite, device.features.antenna, device.features.accessControl],
      ["enabled", "enabled", "enabled", "enabled", "enabled", "enabled", "not_implemented", "not_implemented"]
    );
    const telemetry = seed.telemetry.telemetry;
    assert.ok(telemetry?.status);
    assert.equal(telemetry.status.battery?.percent !== null, true);
    assert.deepEqual(telemetry.status.sim, { state: "ready", pinLockEnabled: false, pinAttemptsLeft: 3, pukAttemptsLeft: 10, slot: { kind: "physical", index: 1 } });
    assert.equal(telemetry.status.firmwareUpdate, "available");
    assert.deepEqual([telemetry.device.iccid, telemetry.traffic.dataLimitRaw, telemetry.unavailable], ["8935301000000000000", "200GB", ["uptime"]]);
    assert.ok(telemetry.thermal.sensors.length >= 4);
    assert.ok((seed.topology.topology?.hosts.length ?? 0) >= 3, "its connected devices");
    assert.ok((seed.neighbors.neighbors?.totalCount ?? 0) >= 2, "its neighbour cells");
    assert.ok(seed.sms.messages.length >= 3);
    assert.deepEqual(seed.sms.status.abilities, { send: true, delete: "message", markRead: "router" });
    // The supported-devices row of a mobile router: a battery and a SIM card (its slot and PIN too), no airplane mode
    // on this interface; the network mode without operator selection, roaming and the data limit, and USSD
    assert.deepEqual(seed.device?.profile.support?.modules.slice(-6).map((m) => [m.en, m.mark]), [
      ["Battery", "?"],
      ["SIM card", "?"],
      ["Airplane mode", ""],
      ["Network mode & operator", "△"],
      ["Data settings", "△"],
      ["USSD", "?"],
    ]);
    const raw = JSON.stringify(seed);
    for (const mac of raw.match(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi) ?? []) assert.match(mac, /^02:00:5E:10:00:/i);
  });

  it("answers every read with the daemon's shapes, status and write gate", async () => {
    for (const route of [
      "/api/health",
      "/api/telemetry",
      "/api/session/status",
      "/api/neighbors",
      "/api/topology",
      "/api/settings",
      "/api/access-control",
      "/api/sms/status",
      "/api/console/experimental",
      "/api/device/profile",
      "/api/console/device-report",
    ]) {
      const [real, demo] = await both("GET", route);
      assert.equal(demo.status, real.status, route);
      assertSameShape(route, real.json, demo.json);
    }
    const [real, demo] = await both("GET", "/api/session/status");
    assert.deepEqual((demo.json as unknown as SessionStatusResponse).status.device, (real.json as unknown as SessionStatusResponse).status.device);
    const [t1, t2] = await both("GET", "/api/telemetry");
    const statusOf = (r: { json: Json }) => (r.json as unknown as TelemetryEndpointResponse).telemetry?.status;
    assert.deepEqual(statusOf(t2)?.sim, statusOf(t1)?.sim);
    assert.equal(typeof statusOf(t2)?.battery?.percent, "number");
    // The report counts the battery and the SIM card as read, on both
    const [r1, r2] = await both("GET", "/api/console/device-report");
    const checksOf = (r: { json: Json }) => ((r.json["report"] as Json)["checks"] as Array<{ feature: string; result: string }>).filter((c) => ["battery", "simCard", "airplaneMode"].includes(c.feature));
    assert.deepEqual(checksOf(r2), checksOf(r1));
    assert.deepEqual(checksOf(r1).map((c) => c.result), ["works", "works", "untested"]);
  });

  it("refuses what the ZTE driver has no implementation of, with the daemon's code, and checks a cell lock alike", async () => {
    for (const [route, body] of [
      ["/api/control/antenna", { mode: "auto", confirm: true }],
      ["/api/control/security", { upnpEnabled: true, confirm: true }],
      ["/api/control/wifi7", { mloEnable: true, confirm: true }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual(verdict(demo), verdict(real), route);
      assert.equal(real.status, 409, route);
    }
    // A frequency without a PCI: the driver locks cells only
    const [real, demo] = await both("POST", "/api/control/cell-lock", { rat: "LTE", band: 1, arfcn: 300, pci: null, confirm: true });
    assert.deepEqual([demo.status, demo.json["errorCode"]], [real.status, real.json["errorCode"]]);
  });

  it("writes through the driver like the daemon: 5G bands, a cell, an unlock and mobile data, each recorded alike", async () => {
    for (const [route, body] of [
      ["/api/control/band-lock", { lteBands: [1, 3], nrBands: [78], confirm: true }],
      ["/api/control/cell-lock", { rat: "LTE", band: 1, arfcn: 300, pci: 211, confirm: true }],
      ["/api/control/unlock", { confirm: true }],
      ["/api/control/mobile-data", { enabled: false, confirm: true }],
      ["/api/control/mobile-data", { enabled: true, confirm: true }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.equal(demo.status, real.status, route);
      const lockOf = (r: { json: Json }) => {
        const lock = r.json["lockState"] as Json | undefined;
        return lock ? [lock["mode"], lock["lteBands"], lock["nrBands"], lock["cellLock"]] : r.json["mobileDataEnabled"];
      };
      assert.deepEqual(lockOf(demo), lockOf(real), route);
    }
    const [real, demo] = await both("GET", "/api/console/experimental");
    assert.deepEqual(brief((demo.json as unknown as ExperimentalWritesResponse).writes), brief((real.json as unknown as ExperimentalWritesResponse).writes));
    // No band mask to check a lock against on this interface: undetermined on both
    const [t1, t2] = await both("GET", "/api/telemetry");
    const verification = (r: { json: Json }) => check((r.json as unknown as TelemetryEndpointResponse).lockVerification as LockVerification);
    assert.deepEqual(verification(t2), verification(t1));
  });
});
