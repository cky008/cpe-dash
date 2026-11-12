import assert from "node:assert/strict";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import path from "node:path";
import { describe, it } from "node:test";
import { AlertEngine, parseDataLimitBytes } from "../src/alert-engine.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { DeviceAccess } from "../src/device-access.ts";
import type { GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

interface SampleInput {
  t: number;
  connectionStatus?: string;
  uptimeSec?: number;
  nrRsrp?: number | null;
  nrSinr?: number | null;
  lteRsrp?: number | null;
  lteSinr?: number | null;
  ca?: number;
  sms?: { inbox: number; outbox?: number; max: number } | null;
  monthTotalBytes?: number;
  dataLimitRaw?: string;
  thresholdPercent?: number | null;
  model?: string;
  firmware?: string;
  battery?: { percent: number | null; charging: boolean | null } | null;
  sim?: "ready" | "pin_required" | "puk_required" | null;
}

function sample(s: SampleInput): GlobalTelemetrySnapshot {
  return {
    capturedAtMs: s.t,
    capturedAtIso: new Date(s.t).toISOString(),
    device: {
      connectionStatus: s.connectionStatus ?? "901",
      uptimeSec: s.uptimeSec ?? 1000,
      deviceName: s.model ?? "H168-383",
      softwareVersion: s.firmware ?? "4.4.0.1(H1006SP19C00)",
      webUiVersion: "WEBUI 4.4.0.1(W2SP24C03)",
    },
    rf: {
      nrRsrpDbm: s.nrRsrp === undefined ? -85 : s.nrRsrp,
      nrSinrDb: s.nrSinr === undefined ? 20 : s.nrSinr,
      lteRsrpDbm: s.lteRsrp === undefined ? -90 : s.lteRsrp,
      lteSinrDb: s.lteSinr === undefined ? 15 : s.lteSinr,
      caComponentCount: s.ca ?? 3,
    },
    traffic: {
      monthTotalBytes: s.monthTotalBytes ?? 0,
      monthTotalFormatted: `${((s.monthTotalBytes ?? 0) / 2 ** 30).toFixed(1)} GiB`,
      dataLimitRaw: s.dataLimitRaw ?? "0MB",
      monthThresholdPercent: s.thresholdPercent === undefined ? 90 : s.thresholdPercent,
    },
    sms: s.sms
      ? { localUnread: 0, localInbox: s.sms.inbox, localOutbox: s.sms.outbox ?? 0, localDraft: 0, localMax: s.sms.max }
      : null,
    status:
      s.battery || s.sim
        ? {
            battery: s.battery ? { ...s.battery, temperatureC: null, minutesToFull: null, minutesToEmpty: null } : null,
            sim: s.sim ? { state: s.sim, pinLockEnabled: true, pinAttemptsLeft: 3, pukAttemptsLeft: 10, slot: null } : null,
            airplaneMode: null,
            roaming: null,
            system: null,
            firmwareUpdate: null,
            wifi: null,
          }
        : null,
  } as unknown as GlobalTelemetrySnapshot;
}

function createEngineFixture(opts: { failing?: () => boolean } = {}) {
  const mock = createMockSmsCpe({
    intercept: (p) => {
      if (opts.failing?.() && p === "/api/user/state-login") throw new TypeError("connect ECONNREFUSED 192.168.8.1:80");
      return undefined;
    },
  });
  const tmpDir = tempDir("fengsui-alerts-");
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "alert_key" });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
  });
  const scheduler = core.scheduler;
  core.monitor.init();
  let clock = 1_000_000;
  const engine = new AlertEngine({ scheduler, monitor: core.monitor, now: () => clock });
  const alerts: AlertEventRecord[] = [];
  scheduler.on("alert", (a: AlertEventRecord) => alerts.push(a));
  return {
    core,
    scheduler,
    engine,
    stateStore,
    alerts,
    codes: () => alerts.map((a) => a.code),
    setClock: (ms: number) => {
      clock = ms;
    },
    cleanup: async () => {
      engine.stop();
      await stopFengSuiCore(core);
      removeTempDir(tmpDir);
    },
  };
}

describe("AlertEngine telemetry rules", () => {
  it("raises WAN down only after the hold window and announces recovery once", async () => {
    const fx = createEngineFixture();
    fx.engine.ingestTelemetry(sample({ t: 0, connectionStatus: "902" }));
    fx.engine.ingestTelemetry(sample({ t: 30_000, connectionStatus: "902" }));
    assert.deepEqual(fx.codes(), []);
    fx.engine.ingestTelemetry(sample({ t: 60_000, connectionStatus: "902" }));
    fx.engine.ingestTelemetry(sample({ t: 65_000, connectionStatus: "902" }));
    assert.deepEqual(fx.codes(), ["WAN_DOWN"]);
    assert.equal(fx.alerts[0]?.severity, "warning");
    assert.match(fx.alerts[0]?.messageEn ?? "", /over 60s \(status 902\)/);
    fx.engine.ingestTelemetry(sample({ t: 70_000, connectionStatus: "" }));
    fx.engine.ingestTelemetry(sample({ t: 75_000, connectionStatus: "901" }));
    assert.deepEqual(fx.codes(), ["WAN_DOWN", "WAN_UP"]);
    assert.equal(fx.stateStore.getState().recentAlerts.length, 2);
    await fx.cleanup();
  });

  it("tracks sustained signal degradation on the primary RAT with recovery hysteresis", async () => {
    const fx = createEngineFixture();
    fx.engine.ingestTelemetry(sample({ t: 0, nrRsrp: -115, nrSinr: 5 }));
    fx.engine.ingestTelemetry(sample({ t: 200_000, nrRsrp: -100, nrSinr: 5 }));
    fx.engine.ingestTelemetry(sample({ t: 250_000, nrRsrp: -116, nrSinr: -2 }));
    fx.engine.ingestTelemetry(sample({ t: 549_000, nrRsrp: -116, nrSinr: -2 }));
    assert.deepEqual(fx.codes(), []);
    fx.engine.ingestTelemetry(sample({ t: 550_000, nrRsrp: -116, nrSinr: -2 }));
    assert.deepEqual(fx.codes(), ["SIGNAL_DEGRADED"]);
    assert.match(fx.alerts[0]?.messageEn ?? "", /5G NR signal degraded for 5 min: RSRP -116 dBm \/ SINR -2 dB/);

    // Within hysteresis margin: still degraded; missing samples are ignored
    fx.engine.ingestTelemetry(sample({ t: 560_000, nrRsrp: -108, nrSinr: 1 }));
    fx.engine.ingestTelemetry(sample({ t: 570_000, nrRsrp: null, lteRsrp: null }));
    fx.engine.ingestTelemetry(sample({ t: 580_000, nrRsrp: -100, nrSinr: 10 }));
    fx.engine.ingestTelemetry(sample({ t: 600_000, nrRsrp: -100, nrSinr: 10 }));
    assert.deepEqual(fx.codes(), ["SIGNAL_DEGRADED"]);
    fx.engine.ingestTelemetry(sample({ t: 640_000, nrRsrp: -100, nrSinr: 10 }));
    assert.deepEqual(fx.codes(), ["SIGNAL_DEGRADED", "SIGNAL_RECOVERED"]);

    // LTE-only samples are judged on LTE metrics
    fx.engine.ingestTelemetry(sample({ t: 700_000, nrRsrp: null, lteRsrp: -125, lteSinr: 3 }));
    fx.engine.ingestTelemetry(sample({ t: 1_000_000, nrRsrp: null, lteRsrp: -125, lteSinr: 3 }));
    assert.match(fx.alerts[2]?.messageEn ?? "", /^4G LTE signal degraded/);
    await fx.cleanup();
  });

  it("flags sustained carrier-aggregation drops, reboots, SMS storage and the monthly data threshold", async () => {
    const fx = createEngineFixture();
    fx.engine.ingestTelemetry(sample({ t: 0, ca: 3, uptimeSec: 5000 }));
    fx.engine.ingestTelemetry(sample({ t: 10_000, ca: 1, uptimeSec: 5010 }));
    fx.engine.ingestTelemetry(sample({ t: 100_000, ca: 3, uptimeSec: 5100 }));
    fx.engine.ingestTelemetry(sample({ t: 110_000, ca: 2, uptimeSec: 5110 }));
    fx.engine.ingestTelemetry(sample({ t: 115_000, ca: 0, uptimeSec: 5115 }));
    fx.engine.ingestTelemetry(sample({ t: 410_000, ca: 2, uptimeSec: 5410 }));
    assert.deepEqual(fx.codes(), ["CA_DROPPED"]);
    assert.match(fx.alerts[0]?.messageEn ?? "", /from 3 to 2/);

    fx.engine.ingestTelemetry(sample({ t: 420_000, uptimeSec: 40 }));
    assert.equal(fx.codes().at(-1), "REBOOT_DETECTED");
    fx.engine.ingestTelemetry(sample({ t: 425_000, uptimeSec: 45 }));
    assert.equal(fx.codes().filter((c) => c === "REBOOT_DETECTED").length, 1);

    fx.engine.ingestTelemetry(sample({ t: 430_000, sms: { inbox: 440, outbox: 10, max: 500 } }));
    fx.engine.ingestTelemetry(sample({ t: 435_000, sms: { inbox: 445, outbox: 10, max: 500 } }));
    fx.engine.ingestTelemetry(sample({ t: 440_000, sms: { inbox: 490, outbox: 10, max: 500 } }));
    fx.engine.ingestTelemetry(sample({ t: 445_000, sms: { inbox: 490, outbox: 10, max: 500 } }));
    fx.engine.ingestTelemetry(sample({ t: 450_000, sms: { inbox: 300, max: 500 } }));
    fx.engine.ingestTelemetry(sample({ t: 455_000, sms: { inbox: 460, max: 500 } }));
    assert.deepEqual(
      fx.codes().filter((c) => c.startsWith("SMS_")),
      ["SMS_STORAGE_HIGH", "SMS_STORAGE_FULL", "SMS_STORAGE_HIGH"]
    );
    assert.equal(fx.alerts.find((a) => a.code === "SMS_STORAGE_FULL")?.severity, "critical");

    const gib = 2 ** 30;
    fx.engine.ingestTelemetry(sample({ t: 460_000, dataLimitRaw: "100GB", monthTotalBytes: 80 * gib }));
    fx.engine.ingestTelemetry(sample({ t: 465_000, dataLimitRaw: "100GB", monthTotalBytes: 91 * gib }));
    fx.engine.ingestTelemetry(sample({ t: 470_000, dataLimitRaw: "100GB", monthTotalBytes: 95 * gib }));
    fx.engine.ingestTelemetry(sample({ t: 475_000, dataLimitRaw: "100GB", monthTotalBytes: 1 * gib }));
    fx.engine.ingestTelemetry(sample({ t: 480_000, dataLimitRaw: "100GB", monthTotalBytes: 50 * gib, thresholdPercent: 40 }));
    fx.engine.ingestTelemetry(sample({ t: 485_000, dataLimitRaw: "0MB", monthTotalBytes: 500 * gib }));
    const data = fx.alerts.filter((a) => a.code === "DATA_THRESHOLD");
    assert.equal(data.length, 2);
    assert.match(data[0]?.messageEn ?? "", /Monthly data 91\.0 GiB reached 90% of the 100GB plan/);
    await fx.cleanup();
  });

  it("raises BATTERY_LOW once a minute on battery at the threshold, re-arms on charging, and never on a router without a battery", async () => {
    const fx = createEngineFixture();
    const at = (t: number, percent: number | null, charging: boolean | null) => fx.engine.ingestTelemetry(sample({ t, battery: { percent, charging } }));
    at(10_000, 19, false);
    at(40_000, 18, false);
    assert.deepEqual(fx.codes().filter((c) => c === "BATTERY_LOW"), [], "not before a minute");
    at(71_000, 17, false);
    assert.deepEqual(fx.codes().filter((c) => c === "BATTERY_LOW"), ["BATTERY_LOW"]);
    assert.match(fx.alerts.find((a) => a.code === "BATTERY_LOW")?.messageEn ?? "", /17% left, not charging/);
    assert.equal(fx.alerts.find((a) => a.code === "BATTERY_LOW")?.severity, "warning");
    at(80_000, 16, false);
    at(150_000, 22, false);
    at(160_000, 20, false);
    at(230_000, 20, false);
    assert.equal(fx.codes().filter((c) => c === "BATTERY_LOW").length, 1, "22 % is not 5 points above: still the same episode");
    at(240_000, 19, true);
    at(250_000, 18, false);
    at(320_000, 18, false);
    assert.equal(fx.codes().filter((c) => c === "BATTERY_LOW").length, 2, "charging re-armed it");
    // A CPE (no battery), an unknown charge, or the alert turned off
    fx.engine.ingestTelemetry(sample({ t: 400_000 }));
    at(410_000, null, false);
    at(500_000, null, false);
    assert.equal(fx.codes().filter((c) => c === "BATTERY_LOW").length, 2);
    await fx.cleanup();
    const off = new AlertEngine({ scheduler: fx.scheduler, monitor: fx.core.monitor, batteryLowPercent: 0 });
    assert.equal(off.batteryLowPercent, 0);
  });

  it("raises SIM_LOCKED once while the card waits for its PIN or PUK, with no code in the message", async () => {
    const fx = createEngineFixture();
    fx.engine.ingestTelemetry(sample({ t: 10_000, sim: "pin_required" }));
    fx.engine.ingestTelemetry(sample({ t: 80_000, sim: "pin_required" }));
    fx.engine.ingestTelemetry(sample({ t: 90_000, sim: "pin_required" }));
    assert.deepEqual(fx.codes().filter((c) => c === "SIM_LOCKED"), ["SIM_LOCKED"]);
    assert.match(fx.alerts.find((a) => a.code === "SIM_LOCKED")?.messageEn ?? "", /waiting for its PIN/);
    fx.engine.ingestTelemetry(sample({ t: 100_000, sim: "ready" }));
    fx.engine.ingestTelemetry(sample({ t: 110_000, sim: "puk_required" }));
    fx.engine.ingestTelemetry(sample({ t: 180_000, sim: "puk_required" }));
    assert.equal(fx.codes().filter((c) => c === "SIM_LOCKED").length, 2);
    assert.match(fx.alerts.filter((a) => a.code === "SIM_LOCKED")[1]?.messageZh ?? "", /PUK/);
    // A router that reports no SIM state never raises it
    fx.engine.ingestTelemetry(sample({ t: 300_000 }));
    assert.equal(fx.codes().filter((c) => c === "SIM_LOCKED").length, 2);
    await fx.cleanup();
  });

  it("parses Huawei data-limit strings", () => {
    assert.equal(parseDataLimitBytes("100GB"), 100 * 2 ** 30);
    assert.equal(parseDataLimitBytes(" 1.5 TB "), 1.5 * 2 ** 40);
    assert.equal(parseDataLimitBytes("500mb"), 500 * 2 ** 20);
    assert.equal(parseDataLimitBytes("512KB"), 512 * 1024);
    assert.equal(parseDataLimitBytes("0MB"), 0);
    assert.equal(parseDataLimitBytes(""), 0);
    assert.equal(parseDataLimitBytes("unlimited"), 0);
  });
});

describe("AlertEngine firmware rule", () => {
  it("warns once per unverified build, survives a restart and re-arms when a verified build returns", async () => {
    const fx = createEngineFixture();
    try {
      fx.engine.ingestTelemetry(sample({ t: 0 }));
      fx.engine.ingestTelemetry(sample({ t: 5000, firmware: "4.4.0.1 (H1006SP19C00)" }));
      assert.deepEqual(fx.codes(), [], "the verified build, spaced or not");

      fx.engine.ingestTelemetry(sample({ t: 10_000, firmware: "4.4.0.2(H1006SP2C00)" }));
      fx.engine.ingestTelemetry(sample({ t: 15_000, firmware: "4.4.0.2(H1006SP2C00)" }));
      assert.deepEqual(fx.codes(), ["FIRMWARE_UNVERIFIED"]);
      assert.equal(fx.alerts[0]?.severity, "warning");
      assert.match(fx.alerts[0]?.messageEn ?? "", /H168-383 firmware 4\.4\.0\.2\(H1006SP2C00\).*verified on H168-383 4\.4\.0\.1\(H1006SP19C00\) only/);
      assert.match(fx.alerts[0]?.messageZh ?? "", /Claude Code/);

      // A restarted daemon reads the notice back and stays quiet about the same build
      await fx.stateStore.flushAsync();
      const reloaded = new EncryptedStateStore({ filePath: fx.stateStore.filePath, encryptionKey: "alert_key" }).load();
      assert.equal(reloaded.firmwareNotice?.fingerprint, "H168-383 4.4.0.2(H1006SP2C00)");
      const restarted = new AlertEngine({ scheduler: fx.scheduler, monitor: fx.core.monitor });
      restarted.ingestTelemetry(sample({ t: 20_000, firmware: "4.4.0.2(H1006SP2C00)" }));
      assert.deepEqual(fx.codes(), ["FIRMWARE_UNVERIFIED"]);

      fx.engine.ingestTelemetry(sample({ t: 25_000, firmware: "4.4.0.3(H1006SP1C00)" }));
      // Another model was never checked on a real router: it says so once per model, with no build to check
      fx.engine.ingestTelemetry(sample({ t: 30_000, model: "H158-381" }));
      fx.engine.ingestTelemetry(sample({ t: 31_000, model: "H158-381", firmware: "1.0.0.9" }));
      assert.deepEqual(fx.codes(), ["FIRMWARE_UNVERIFIED", "FIRMWARE_UNVERIFIED", "MODEL_UNVERIFIED"], "each new build of the verified model, each other model once");
      assert.match(fx.alerts[2]?.messageEn ?? "", /reports H158-381, a model FengSui was not verified on \(verified: H168-383\)[\s\S]*writes FengSui implements for this model are available by default[\s\S]*sent once and read back[\s\S]*Settings → Device[\s\S]*turns writes off one at a time/);
      assert.doesNotMatch(`${fx.alerts[2]?.messageEn} ${fx.alerts[2]?.messageZh}`, /only reads it|locked by default|只读取它|默认锁定/);
      assert.match(fx.alerts[2]?.messageZh ?? "", /实现了的写操作默认可用[\s\S]*没有在真机上验证过[\s\S]*逐项关闭/);
      fx.engine.ingestTelemetry(sample({ t: 35_000 }));
      assert.equal(fx.stateStore.getState().firmwareNotice, null, "verified again: the notice is cleared");
      fx.engine.ingestTelemetry(sample({ t: 40_000, firmware: "" }));
      fx.engine.ingestTelemetry(sample({ t: 42_000, model: "" }));
      fx.engine.ingestTelemetry(sample({ t: 45_000, model: "H158-381" }));
      assert.equal(fx.codes().length, 4, "an empty version or model decides nothing; a returning model says so again");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("AlertEngine on a model reports verified", () => {
  it("does not call a model unverified once reports settled every feature FengSui does on it", async () => {
    const fx = createEngineFixture();
    try {
      const base = { family: "huawei", model: "H158-381", softwareVersion: "1.0.0.9" } as const;
      const verified = [
        ...(["telemetry", "neighbors", "topology", "smsRead"] as const).map((feature) => ({ ...base, feature, access: "read" as const, issue: 51 })),
        ...(["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"] as const).map((feature) => ({ ...base, feature, access: "write" as const, issue: 51 })),
      ];
      // The gate the alerts read, with the registered reports of this model
      Object.defineProperty(fx.scheduler, "device", { value: new DeviceAccess({ verifiedFeatures: verified }) });
      fx.scheduler.device.see("H158-381", "1.0.0.9");
      assert.equal(fx.scheduler.device.reportVerified, true);
      fx.engine.ingestTelemetry(sample({ t: 0, model: "H158-381", firmware: "1.0.0.9" }));
      assert.deepEqual(fx.codes(), [], "nothing left to warn about");
      // One feature short, it is still a model nobody verified
      Object.defineProperty(fx.scheduler, "device", { value: new DeviceAccess({ verifiedFeatures: verified.slice(1) }) });
      fx.scheduler.device.see("H158-381", "1.0.0.9");
      fx.engine.ingestTelemetry(sample({ t: 5000, model: "H158-381", firmware: "1.0.0.9" }));
      assert.deepEqual(fx.codes(), ["MODEL_UNVERIFIED"]);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("AlertEngine scheduler health rules", () => {
  it("raises CPE unreachable after the hold window and recovery only on a healthy session", async () => {
    let failing = true;
    const fx = createEngineFixture({ failing: () => failing });
    await assert.rejects(() => fx.core.monitor.refreshTelemetry(), /ECONNREFUSED/);
    assert.equal(fx.scheduler.getStatus().mode, "cpe_unreachable");
    fx.setClock(1_000_000);
    fx.engine.evaluateSchedulerHealth();
    fx.setClock(1_059_000);
    fx.engine.evaluateSchedulerHealth();
    assert.deepEqual(fx.codes(), []);
    fx.setClock(1_061_000);
    fx.engine.evaluateSchedulerHealth();
    fx.engine.evaluateSchedulerHealth();
    assert.deepEqual(fx.codes(), ["CPE_UNREACHABLE"]);
    assert.equal(fx.alerts[0]?.severity, "critical");
    assert.match(fx.alerts[0]?.messageEn ?? "", /unreachable for 61s: .*ECONNREFUSED/);

    failing = false;
    fx.setClock(1_090_000);
    fx.engine.start();
    await fx.core.monitor.refreshTelemetry();
    assert.deepEqual(fx.codes(), ["CPE_UNREACHABLE", "CPE_RECOVERED"]);
    assert.match(fx.alerts[1]?.messageEn ?? "", /after ~90s/);
    fx.engine.start();
    fx.engine.stop();
    fx.engine.stop();
    await fx.cleanup();
  });
});
