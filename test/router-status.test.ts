import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hilinkRouterStatus } from "../src/drivers/huawei/requests.ts";
import { driverRouterStatus, driverTelemetrySnapshot, emptyCell } from "../src/drivers/snapshot.ts";
import type { DriverTelemetry } from "../src/drivers/types.ts";
import { ecioOf, iccidOf, imeiOf, imsiOf, msisdnOf, rscpOf, txPowerOf } from "../src/drivers/values.ts";
import { wcdmaSignal } from "../src/protocols/hilink/parsers.ts";
import {
  DEFAULT_BATTERY_LOW_PERCENT,
  batteryIsLow,
  countValue,
  emptyRouterStatus,
  hasRouterStatus,
  partOrNull,
  percentValue,
  simIsLocked,
} from "../src/router-status.ts";

/** A driver reading with every part present (placeholders only, AGENTS.md 铁律二). */
function reading(over: Partial<DriverTelemetry> = {}): DriverTelemetry {
  return {
    model: "MU5250",
    softwareVersion: "BD_ZTE_MU5250V1.0.0B05",
    hardwareVersion: null,
    operatorName: "Carrier-Lab",
    plmn: "27201",
    mode: "LTE",
    lte: { ...emptyCell(), band: 1, arfcn: 300, pci: 211, rsrpDbm: -90, bandwidthMhz: 20 },
    nr: null,
    carriers: [],
    wan: { connected: true, ipv4: "198.51.100.42", ipv6: null, uptimeSec: 600 },
    traffic: null,
    temperatureC: 41,
    signalBars: 4,
    ...over,
  };
}

describe("router status: shared rules (src/router-status.ts)", () => {
  it("reads a percentage and a small count the way routers write them, and nothing implausible", () => {
    assert.deepEqual(["85", "85%", " 85 % ", 85, "100", "0", "12.6"].map(percentValue), [85, 85, 85, 85, 100, 0, 13]);
    assert.deepEqual(["101", "-1", "", "full", null, undefined, {}].map(percentValue), [null, null, null, null, null, null, null]);
    assert.deepEqual([countValue("3"), countValue(10), countValue("11", 10), countValue("-1"), countValue("x")], [3, 10, null, null, null]);
  });

  it("says nothing for a part of nothing, and tells an empty status apart", () => {
    assert.equal(partOrNull({ a: null, b: null }), null);
    assert.deepEqual(partOrNull({ a: null, b: false }), { a: null, b: false });
    assert.equal(hasRouterStatus(emptyRouterStatus()), false);
    assert.equal(hasRouterStatus({ ...emptyRouterStatus(), airplaneMode: false }), true);
  });

  it("calls a battery low on battery at or below the threshold, never while charging, and not with the alert off", () => {
    const battery = (percent: number | null, charging: boolean | null) => ({ percent, charging, temperatureC: null, minutesToFull: null, minutesToEmpty: null });
    assert.equal(DEFAULT_BATTERY_LOW_PERCENT, 20);
    assert.equal(batteryIsLow(battery(20, false), 20), true);
    assert.equal(batteryIsLow(battery(21, null), 20), false);
    assert.equal(batteryIsLow(battery(5, true), 20), false);
    assert.equal(batteryIsLow(battery(5, false), 0), null, "0 turns it off");
    assert.equal(batteryIsLow(battery(null, false), 20), null);
    assert.equal(batteryIsLow(null, 20), null);
  });

  it("calls a SIM card locked when it waits for its PIN or PUK", () => {
    const sim = (state: "ready" | "pin_required" | "puk_required" | null) => ({ state, pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null });
    assert.deepEqual([simIsLocked(sim("pin_required")), simIsLocked(sim("puk_required")), simIsLocked(sim("ready")), simIsLocked(sim(null)), simIsLocked(null)], [true, true, false, null, null]);
  });
});

describe("router status: HiLink (from answers the poll reads anyway)", () => {
  it("reads the battery of a mobile router from monitoring/status: a percentage, or bars worth 25 % each", () => {
    assert.deepEqual(hilinkRouterStatus("<response><ConnectionStatus>901</ConnectionStatus><BatteryStatus>1</BatteryStatus><BatteryLevel>85</BatteryLevel></response>")?.battery, {
      percent: 85,
      charging: true,
      temperatureC: null,
      minutesToFull: null,
      minutesToEmpty: null,
    });
    assert.equal(hilinkRouterStatus("<response><BatteryStatus>0</BatteryStatus><BatteryLevel>3</BatteryLevel></response>")?.battery?.percent, 75);
    assert.equal(hilinkRouterStatus("<response><BatteryStatus>0</BatteryStatus><BatteryLevel>3</BatteryLevel></response>")?.battery?.charging, false);
    assert.equal(hilinkRouterStatus("<response><BatteryLevel>60</BatteryLevel></response>")?.battery?.charging, null);
  });

  it("shows no battery on a CPE: empty tags, or a level of 0, say nothing", () => {
    assert.equal(hilinkRouterStatus("<response><ConnectionStatus>901</ConnectionStatus></response>"), null);
    assert.equal(hilinkRouterStatus("<response><BatteryStatus></BatteryStatus><BatteryLevel></BatteryLevel></response>"), null);
    assert.equal(hilinkRouterStatus("<response><BatteryStatus>0</BatteryStatus><BatteryLevel>0</BatteryLevel></response>"), null);
  });

  it("reads a 3G serving cell from device/signal only when it reports one in range", () => {
    assert.deepEqual(wcdmaSignal("<response><rscp>-78dBm</rscp><ecio>-6dB</ecio><sc>128</sc></response>"), { rscpDbm: -78, ecioDb: -6, psc: 128 });
    assert.equal(wcdmaSignal("<response><rscp></rscp><ecio></ecio><rsrp>-90dBm</rsrp></response>"), null, "a 4G answer with empty 3G tags");
    assert.deepEqual(wcdmaSignal("<response><rscp>0dBm</rscp><ecio>-12dB</ecio><sc>9999</sc></response>"), { rscpDbm: null, ecioDb: -12, psc: null });
  });
});

describe("router status: values the drivers read (src/drivers/values.ts)", () => {
  it("reads identifiers only in their own shapes", () => {
    assert.deepEqual([imeiOf("860000000000000"), imeiOf("0000000000000000"), imeiOf("86000"), imeiOf("-")], ["860000000000000", null, null, null]);
    assert.deepEqual([imsiOf("272010000000000"), imsiOf("27201"), imsiOf("not a number")], ["272010000000000", null, null]);
    assert.deepEqual([iccidOf("8935301000000000000"), iccidOf("8935301000000000000F"), iccidOf("1235301000000000000"), iccidOf("89")], ["8935301000000000000", "8935301000000000000", null, null]);
    assert.deepEqual([msisdnOf("+353 83 000 0000"), msisdnOf("+353-830000000"), msisdnOf("abc")], ["+353830000000", "+353830000000", null]);
  });

  it("bounds the uplink power and the 3G readings to what 3GPP allows", () => {
    assert.deepEqual([txPowerOf("23"), txPowerOf("-12 dBm"), txPowerOf("34"), txPowerOf("-51")], [23, -12, null, null]);
    assert.deepEqual([rscpOf("-78"), rscpOf("-121"), rscpOf("0"), ecioOf("-6.5"), ecioOf("1"), ecioOf("-25")], [-78, null, null, -6.5, null, null]);
  });
});

describe("router status: a driver reading in the snapshot", () => {
  it("carries the status a driver read, a part it said nothing of null, and no status for none", () => {
    const status = driverRouterStatus(
      reading({
        status: {
          battery: { percent: 64, charging: true, temperatureC: 38, minutesToFull: 92, minutesToEmpty: null },
          sim: { state: null, pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null },
          airplaneMode: false,
          roaming: { active: null, dataAllowed: null },
        },
      })
    );
    assert.deepEqual(status?.battery, { percent: 64, charging: true, temperatureC: 38, minutesToFull: 92, minutesToEmpty: null });
    assert.deepEqual([status?.sim, status?.roaming, status?.system, status?.firmwareUpdate, status?.wifi, status?.airplaneMode], [null, null, null, null, null, false]);
    assert.equal(driverRouterStatus(reading()), null);
    assert.equal(driverRouterStatus(reading({ status: { sim: null, battery: null } })), null);
  });

  it("puts identifiers, sensors, uplink details and 3G where the HiLink snapshot has them", () => {
    const snap = driverTelemetrySnapshot(
      reading({
        lte: { ...emptyCell(), band: 1, arfcn: 300, pci: 211, rsrpDbm: -90, cqi: 12, cqi1: 11, ulBandwidthMhz: 10, puschTxDbm: 8, pucchTxDbm: -4, transmissionMode: "TM4" },
        ids: { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000", msisdn: null },
        temperatures: [{ kind: "modem", name: null, celsius: 41 }],
        wcdma: { rscpDbm: -80, ecioDb: -7, psc: null },
        rrcConnected: true,
        qci: 9,
        ulMimoLayers: 2,
        status: { system: { uptimeSec: 7200, cpuPercent: 12, memoryPercent: 40 } },
      }),
      1_000
    );
    assert.deepEqual([snap.device.imei, snap.device.imsi, snap.device.iccid, snap.device.msisdn], ["860000000000000", "272010000000000", "8935301000000000000", ""]);
    assert.equal(snap.device.uptimeSec, 7200);
    // No traffic counters in this reading, but an uptime of the router's own
    assert.deepEqual(snap.unavailable, ["traffic", "month"]);
    assert.deepEqual(snap.thermal.sensors, [{ kind: "modem", name: null, celsius: 41 }]);
    assert.deepEqual([snap.rf.lteCqi0, snap.rf.lteCqi1, snap.rf.lteUlBandwidthMhz, snap.rf.transmissionMode], [12, 11, 10, "TM4"]);
    assert.deepEqual(snap.rf.lteTxPower, { puschDbm: 8, pucchDbm: -4, srsDbm: null, prachDbm: null });
    assert.deepEqual([snap.rf.wcdma, snap.rf.rrcConnected, snap.rf.qci, snap.rf.ulMimoLayers], [{ rscpDbm: -80, ecioDb: -7, psc: null }, true, 9, 2]);
    assert.deepEqual(snap.status?.system, { uptimeSec: 7200, cpuPercent: 12, memoryPercent: 40 });
    // A router that names none of it: empty strings, nothing invented
    const bare = driverTelemetrySnapshot(reading(), 1_000);
    assert.deepEqual([bare.device.iccid, bare.rf.transmissionMode, bare.rf.wcdma, bare.status, bare.thermal.sensors], ["", "", null, null, []]);
    assert.deepEqual(bare.rf.lteTxPower, { puschDbm: null, pucchDbm: null, srsDbm: null, prachDbm: null });
  });

  it("writes a data plan the router names in the form the plan's usage reads", () => {
    const traffic = { downloadBytesPerSec: 1, uploadBytesPerSec: 1, totalDownloadBytes: null, totalUploadBytes: null, sessionDownloadBytes: null, sessionUploadBytes: null, sessionSeconds: null, monthDownloadBytes: 1n, monthUploadBytes: 1n, monthTotalBytes: null, monthSeconds: null };
    const gb = driverTelemetrySnapshot(reading({ traffic: { ...traffic, dataLimitBytes: 20n * 1024n ** 3n, dataAlertPercent: 80 } }), 1_000).traffic;
    assert.deepEqual([gb.dataLimitRaw, gb.monthThresholdPercent], ["20GB", 80]);
    assert.equal(driverTelemetrySnapshot(reading({ traffic: { ...traffic, dataLimitBytes: 500n * 1024n ** 2n } }), 1_000).traffic.dataLimitRaw, "500MB");
    assert.deepEqual([driverTelemetrySnapshot(reading({ traffic }), 1_000).traffic.dataLimitRaw, driverTelemetrySnapshot(reading({ traffic }), 1_000).traffic.monthThresholdPercent], ["", null]);
  });
});
