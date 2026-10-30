import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { AlertEngine, parseDataLimitBytes } from "../src/alert-engine.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { MutexSessionScheduler } from "../src/scheduler.ts";
import type { AlertEventRecord } from "../src/state-store.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";

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
}

function sample(s: SampleInput): GlobalTelemetrySnapshot {
  return {
    capturedAtMs: s.t,
    capturedAtIso: new Date(s.t).toISOString(),
    device: { connectionStatus: s.connectionStatus ?? "901", uptimeSec: s.uptimeSec ?? 1000 },
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
  } as unknown as GlobalTelemetrySnapshot;
}

function createEngineFixture(opts: { failing?: () => boolean } = {}) {
  const mock = createMockSmsCpe({
    intercept: (p) => {
      if (opts.failing?.() && p === "/api/user/state-login") throw new TypeError("connect ECONNREFUSED 192.168.8.1:80");
      return undefined;
    },
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-alerts-"));
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "alert_key" });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const scheduler = new MutexSessionScheduler({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
  });
  scheduler.init();
  let clock = 1_000_000;
  const engine = new AlertEngine({ scheduler, now: () => clock });
  const alerts: AlertEventRecord[] = [];
  scheduler.on("alert", (a: AlertEventRecord) => alerts.push(a));
  return {
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
      await scheduler.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
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

describe("AlertEngine scheduler health rules", () => {
  it("raises CPE unreachable after the hold window and recovery only on a healthy session", async () => {
    let failing = true;
    const fx = createEngineFixture({ failing: () => failing });
    await assert.rejects(() => fx.scheduler.refreshTelemetry(), /ECONNREFUSED/);
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
    await fx.scheduler.refreshTelemetry();
    assert.deepEqual(fx.codes(), ["CPE_UNREACHABLE", "CPE_RECOVERED"]);
    assert.match(fx.alerts[1]?.messageEn ?? "", /after ~90s/);
    fx.engine.start();
    fx.engine.stop();
    fx.engine.stop();
    await fx.cleanup();
  });
});
