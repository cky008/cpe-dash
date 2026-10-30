import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { type FengSuiCore, createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type StrictCpe, type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

function setup(fault?: (p: string, method: string) => StrictFault | undefined): { cpe: StrictCpe; core: FengSuiCore; close: () => Promise<void> } {
  const cpe = createStrictCpe({ fault });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-fidelity-"));
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 3000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "fidelity_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
  });
  core.monitor.init();
  return {
    cpe,
    core,
    close: async () => {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const settingsWrites = (cpe: StrictCpe): string[] =>
  cpe.stats.writes.map((w) => w.path).filter((p) => p.startsWith("/api/security/") || p === "/api/wlan/wlandbho");

describe("telemetry snapshots never fabricate data from failed reads", () => {
  it("fails the whole refresh on a transport error in a core endpoint instead of caching zeros", async () => {
    let broken = false;
    const fx = setup((p) => (broken && p === "/api/monitoring/traffic-statistics" ? "transport" : undefined));
    try {
      const good = await fx.core.monitor.refreshTelemetry();
      assert.ok(good && good.traffic.downloadBps > 0);
      const pointsBefore = fx.core.monitor.queryTimeSeries({ preset: "1h" }).points.length;

      broken = true;
      await assert.rejects(() => fx.core.monitor.refreshTelemetry(), /fetch failed/);
      assert.equal(fx.core.monitor.getCachedTelemetry()?.capturedAtMs, good.capturedAtMs, "cache keeps the last real snapshot");
      const points = fx.core.monitor.queryTimeSeries({ preset: "1h" }).points;
      assert.equal(points.length, pointsBefore);
      assert.ok(points.every((pt) => pt.dlAvgBps > 0), "no 0 bps sample from a broken session");
      assert.equal(fx.core.scheduler.getStatus().mode, "cpe_unreachable");
      assert.equal(fx.cpe.isSlotTaken(), false, "the failed session still logged out");
    } finally {
      await fx.close();
    }
  });

  it("requires the core endpoints even when the router answers them with an error code", async () => {
    const fx = setup((p) => (p === "/api/device/signal" ? { cpeError: "100003" } : undefined));
    try {
      await assert.rejects(() => fx.core.monitor.refreshTelemetry(), /100003/);
      assert.equal(fx.core.monitor.getCachedTelemetry(), null);
    } finally {
      await fx.close();
    }
  });

  it("degrades optional endpoints only on router error codes, never on transport failures", async () => {
    const unsupported = setup((p) => (p === "/api/device/ri" ? { cpeError: "100002" } : undefined));
    try {
      const snap = await unsupported.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.equal(snap.rf.lteMimoRank, null, "unsupported optional endpoint degrades to null");
      assert.equal(snap.rf.lteRsrpDbm, -87);
    } finally {
      await unsupported.close();
    }
    const dropped = setup((p) => (p === "/api/device/ri" ? "transport" : undefined));
    try {
      await assert.rejects(() => dropped.core.monitor.refreshTelemetry(), /fetch failed/);
    } finally {
      await dropped.close();
    }
  });

  it("reads router settings all-or-nothing", async () => {
    const fx = setup((p) => (p === "/api/security/nat" ? { cpeError: "100003" } : undefined));
    try {
      await assert.rejects(() => fx.core.monitor.refreshSettings(), /100003/);
      assert.equal(fx.core.monitor.getCachedSettings(), null, "no snapshot with guessed switch states");
    } finally {
      await fx.close();
    }
  });
});

describe("read-modify-write controls never write guessed values", () => {
  it("aborts a firewall change before any write when the current switches cannot be read", async () => {
    for (const fault of ["transport", { cpeError: "100003" }, { body: "<response></response>" }] satisfies StrictFault[]) {
      const fx = setup((p, method) => (p === "/api/security/firewall-switch" && method === "GET" ? fault : undefined));
      try {
        await assert.rejects(() =>
          fx.core.controls.setSecuritySwitches({ upnpEnabled: false, firewall: { wanPortPingSwitch: true } })
        );
        assert.deepEqual(settingsWrites(fx.cpe), [], `no UPnP or firewall write after a failed read (${JSON.stringify(fault)})`);
        assert.equal(fx.cpe.router.firewall.macFilter, 0);
      } finally {
        await fx.close();
      }
    }
  });

  it("aborts a DMZ change before the UPnP write when the current DMZ host cannot be read", async () => {
    const fx = setup((p, method) => (p === "/api/security/dmz" && method === "GET" ? "transport" : undefined));
    try {
      await assert.rejects(() => fx.core.controls.setSecuritySwitches({ upnpEnabled: true, dmz: { enabled: false } }));
      assert.deepEqual(settingsWrites(fx.cpe), []);
    } finally {
      await fx.close();
    }
  });

  it("aborts a Wi-Fi 7 toggle when the current MLO/DBHO state cannot be read or parsed", async () => {
    for (const fault of ["transport", { body: "<html>not json</html>" }, { body: '{"MloEnable":true}' }] satisfies StrictFault[]) {
      const fx = setup((p, method) => (p === "/api/wlan/wlandbho" && method === "GET" ? fault : undefined));
      try {
        await assert.rejects(() => fx.core.controls.setWifi7Settings({ mloEnable: false }));
        assert.deepEqual(settingsWrites(fx.cpe), [], `no Wi-Fi write after ${JSON.stringify(fault)}`);
        assert.deepEqual(fx.cpe.router.wifi, { MloEnable: true, DbhoEnable: true });
      } finally {
        await fx.close();
      }
    }
  });

  it("keeps the untouched switches when the reads succeed", async () => {
    const fx = setup();
    try {
      fx.cpe.router.firewall.macFilter = 1;
      await fx.core.controls.setSecuritySwitches({ firewall: { wanPortPingSwitch: true } });
      assert.deepEqual(fx.cpe.router.firewall, { main: 1, ipFilter: 1, wanPing: 1, macFilter: 1, urlFilter: 0 });
      await fx.core.controls.setWifi7Settings({ dbhoEnable: false });
      assert.deepEqual(fx.cpe.router.wifi, { MloEnable: true, DbhoEnable: false });
    } finally {
      await fx.close();
    }
  });
});
