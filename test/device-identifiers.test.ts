import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { type GlobalTelemetrySnapshot, fetchGlobalTelemetry } from "../src/cpe-domain.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";

/** RFC / reserved placeholders only (AGENTS.md 铁律二). */
const DEVICE_INFO_WITH_IDENTIFIERS =
  "<response><DeviceName>H168-383</DeviceName><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi>" +
  "<Msisdn>+353830000000</Msisdn><MacAddress1>02:00:5E:10:00:01</MacAddress1><WanIPAddress>198.51.100.42</WanIPAddress>" +
  "<wan_dns_address>203.0.113.53</wan_dns_address><uptime>86400</uptime></response>";

async function collect(deviceInfoXml: string, redactSensitive: boolean): Promise<GlobalTelemetrySnapshot> {
  const cpe = createStrictCpe({
    fault: (p) => (p === "/api/device/information" ? { body: deviceInfoXml } : undefined),
  });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl });
  const outcome = await client.withSessionDetailed((session) => fetchGlobalTelemetry(session, { redactSensitive }));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.value;
}

describe("Device identifiers in the telemetry snapshot (IMEI / IMSI / own number / MAC)", () => {
  it("passes the identifiers through when REDACT_SENSITIVE_IN_API=false", async () => {
    const { device } = await collect(DEVICE_INFO_WITH_IDENTIFIERS, false);
    assert.equal(device.imei, "860000000000000");
    assert.equal(device.imsi, "272010000000000");
    assert.equal(device.msisdn, "+353830000000");
    assert.equal(device.macAddress, "02:00:5E:10:00:01");
    assert.equal(device.wanIpv4, "198.51.100.42");
    assert.equal(device.sensitiveRedacted, false);
  });

  it("masks them before they leave the daemon when REDACT_SENSITIVE_IN_API=true", async () => {
    const { device } = await collect(DEVICE_INFO_WITH_IDENTIFIERS, true);
    assert.equal(device.imei, "860000*********");
    assert.equal(device.imsi, "27201**********");
    assert.equal(device.msisdn, "+353*******00");
    assert.equal(device.macAddress, "02:00:5E:**:**:**");
    assert.equal(device.sensitiveRedacted, true);
    assert.doesNotMatch(JSON.stringify(device), /860000000000000|272010000000000|\+353830000000/);
  });

  it("prefers WanMacAddress and reports absent identifiers as empty strings", async () => {
    const withWanMac = await collect(
      "<response><MacAddress1>02:00:5E:10:00:01</MacAddress1><WanMacAddress>02:00:5E:10:00:09</WanMacAddress></response>",
      false
    );
    assert.equal(withWanMac.device.macAddress, "02:00:5E:10:00:09");
    assert.equal(withWanMac.device.imei, "");
    assert.equal(withWanMac.device.msisdn, "");

    const bare = await collect("<response><DeviceName>H168-383</DeviceName></response>", true);
    assert.deepEqual(
      [bare.device.imei, bare.device.imsi, bare.device.msisdn, bare.device.macAddress],
      ["", "", "", ""]
    );
  });

  it("upgrades a snapshot persisted before these fields existed", async () => {
    const current = await collect(DEVICE_INFO_WITH_IDENTIFIERS, true);
    const { imei, imsi, msisdn, macAddress, sensitiveRedacted, ...olderDevice } = current.device;
    assert.ok(imei && imsi && msisdn && macAddress && sensitiveRedacted);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-upgrade-"));
    try {
      const filePath = path.join(dir, "state.json");
      const writer = new EncryptedStateStore({ filePath, encryptionKey: "upgrade-test-key" });
      writer.update({ latestTelemetry: { ...current, device: olderDevice } as unknown as GlobalTelemetrySnapshot });
      await writer.flushAsync();

      const reader = new EncryptedStateStore({ filePath, encryptionKey: "upgrade-test-key" });
      const device = reader.load().latestTelemetry?.device;
      assert.deepEqual(
        [device?.imei, device?.imsi, device?.msisdn, device?.macAddress, device?.sensitiveRedacted],
        ["", "", "", "", false]
      );
      assert.equal(device?.wanIpv4, current.device.wanIpv4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
