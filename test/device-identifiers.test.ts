import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import { type GlobalTelemetrySnapshot, type TerminalTopologySnapshot } from "../src/cpe-domain.ts";
import { fetchGlobalTelemetry, fetchTerminalTopology } from "../src/drivers/huawei/requests.ts";
import { REDACTED, auditForOutput, redactTelemetry, redactTopology } from "../src/redact.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/** RFC / reserved placeholders only (AGENTS.md 铁律二). */
const DEVICE_INFO_WITH_IDENTIFIERS =
  "<response><DeviceName>H168-383</DeviceName><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi>" +
  "<Msisdn>+353830000000</Msisdn><Iccid>8935301000000000000</Iccid><MacAddress1>02:00:5E:10:00:01</MacAddress1><WanIPAddress>198.51.100.42</WanIPAddress>" +
  "<WanIPv6Address>2001:db8::42</WanIPv6Address><wan_dns_address>203.0.113.53</wan_dns_address>" +
  "<wan_ipv6_dns_address>2001:db8::53</wan_ipv6_dns_address><uptime>86400</uptime></response>";

const HOST_INFO_WITH_NAMES = JSON.stringify([
  {
    MACAddress: "00:00:5E:00:53:01",
    HostName: "Demo-Laptop",
    IPAddress: "192.168.8.10",
    IPv6Address: "fe80::200:5eff:fe00:5301;2001:db8::10",
    Active: true,
    InterfaceType: "Ethernet",
    Layer2Interface: "LAN1",
    EthernetSpeed: 1000,
  },
]);

async function collect(deviceInfoXml: string): Promise<GlobalTelemetrySnapshot> {
  const cpe = createStrictCpe({
    fault: (p) => (p === "/api/device/information" ? { body: deviceInfoXml } : undefined),
  });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl });
  const outcome = await client.withSessionDetailed((session) => fetchGlobalTelemetry(session));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.value;
}

async function collectTopology(): Promise<TerminalTopologySnapshot> {
  const cpe = createStrictCpe({
    fault: (p) => (p === "/api/system/HostInfo" ? { body: HOST_INFO_WITH_NAMES } : undefined),
  });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl });
  const outcome = await client.withSessionDetailed((session) => fetchTerminalTopology(session));
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.value;
}

describe("Device identifiers in the telemetry snapshot (IMEI / IMSI / own number / MAC)", () => {
  it("keeps the plain identifiers, WAN addresses and cell fingerprints in the daemon's snapshot", async () => {
    const { device, rf } = await collect(DEVICE_INFO_WITH_IDENTIFIERS);
    assert.equal(device.imei, "860000000000000");
    assert.equal(device.imsi, "272010000000000");
    assert.equal(device.msisdn, "+353830000000");
    assert.equal(device.iccid, "8935301000000000000");
    assert.equal(device.macAddress, "02:00:5E:10:00:01");
    assert.equal(device.wanIpv4, "198.51.100.42");
    assert.deepEqual(device.wanDnsV4, ["203.0.113.53"]);
    assert.equal(device.sensitiveRedacted, false);
    assert.deepEqual([rf.cellIdDisplay, rf.eNodeBDisplay, rf.tacDisplay], ["134217758", "0524288", "10001"]);
  });

  it("prefers WanMacAddress and reports absent identifiers as empty strings", async () => {
    const withWanMac = await collect(
      "<response><MacAddress1>02:00:5E:10:00:01</MacAddress1><WanMacAddress>02:00:5E:10:00:09</WanMacAddress></response>"
    );
    assert.equal(withWanMac.device.macAddress, "02:00:5E:10:00:09");
    assert.equal(withWanMac.device.imei, "");
    assert.equal(withWanMac.device.msisdn, "");

    const bare = redactTelemetry(await collect("<response><DeviceName>H168-383</DeviceName></response>"));
    assert.deepEqual(
      [bare.device.imei, bare.device.imsi, bare.device.msisdn, bare.device.iccid, bare.device.macAddress, bare.device.wanIpv4],
      ["", "", "", "", "", ""]
    );
  });

  it("upgrades a snapshot persisted before these fields existed", async () => {
    const current = redactTelemetry(await collect(DEVICE_INFO_WITH_IDENTIFIERS));
    const { imei, imsi, msisdn, macAddress, sensitiveRedacted, ...olderDevice } = current.device;
    assert.ok(imei && imsi && msisdn && macAddress && sensitiveRedacted);
    const dir = tempDir("fengsui-upgrade-");
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
      removeTempDir(dir);
    }
  });

  it("upgrades a snapshot persisted before the router status, the ICCID and the new radio readings existed", async () => {
    const current = await collect(DEVICE_INFO_WITH_IDENTIFIERS);
    const { iccid, ...olderDevice } = current.device;
    const { wcdma, rrcConnected, qci, ulMimoLayers, ...olderRf } = current.rf;
    const { sensors, ...olderThermal } = current.thermal;
    const { status, ...older } = current;
    assert.ok(iccid !== undefined && wcdma === null && rrcConnected === null && qci === null && ulMimoLayers === null && sensors.length === 0 && status === null);
    const dir = tempDir("fengsui-upgrade-");
    try {
      const filePath = path.join(dir, "state.json");
      const writer = new EncryptedStateStore({ filePath, encryptionKey: "upgrade-test-key" });
      writer.update({ latestTelemetry: { ...older, device: olderDevice, rf: olderRf, thermal: olderThermal } as unknown as GlobalTelemetrySnapshot });
      await writer.flushAsync();
      const loaded = new EncryptedStateStore({ filePath, encryptionKey: "upgrade-test-key" }).load().latestTelemetry;
      assert.equal(loaded?.device.iccid, "");
      assert.deepEqual([loaded?.rf.wcdma, loaded?.rf.rrcConnected, loaded?.rf.qci, loaded?.rf.ulMimoLayers], [null, null, null, null]);
      assert.deepEqual(loaded?.thermal.sensors, []);
      assert.equal(loaded?.status, null);
    } finally {
      removeTempDir(dir);
    }
  });
});

describe("REDACT_SENSITIVE_IN_API copies for Bearer API, SSE and MCP clients (src/redact.ts)", () => {
  it("masks identifiers visibly instead of substituting look-alike values, and never touches the daemon's snapshot", async () => {
    const plain = await collect(DEVICE_INFO_WITH_IDENTIFIERS);
    const before = structuredClone(plain);
    const { device, rf } = redactTelemetry(plain);
    assert.deepEqual(plain, before);

    assert.equal(device.imei, "860000*********");
    assert.equal(device.imsi, "27201**********");
    assert.equal(device.msisdn, "+353*******00");
    // The ICCID keeps its industry code, country and issuer only (ITU-T E.118)
    assert.equal(device.iccid, "893530*************");
    assert.equal(device.macAddress, "02:00:5E:**:**:**");
    assert.equal(device.wanIpv4, "198.51.*.*");
    assert.equal(device.wanIpv6, "2001:db8:****");
    assert.deepEqual(device.wanDnsV4, ["203.0.*.*"]);
    assert.deepEqual(device.wanDnsV6, ["2001:db8:****"]);
    assert.equal(device.sensitiveRedacted, true);
    assert.deepEqual([rf.cellIdDisplay, rf.eNodeBDisplay, rf.tacDisplay], [REDACTED, REDACTED, REDACTED]);
    assert.doesNotMatch(
      JSON.stringify({ device, rf }),
      /860000000000000|272010000000000|8935301000000000000|\+353830000000|198\.51\.100\.42|203\.0\.113\.53|134217758|0524288/
    );
  });

  it("returns an already redacted copy unchanged, so its kept prefixes survive", async () => {
    const once = redactTelemetry(await collect(DEVICE_INFO_WITH_IDENTIFIERS));
    assert.equal(redactTelemetry(once), once);
  });

  it("hides LAN client names, MAC tails and IPv6 addresses but keeps the LAN IPv4 that tells clients apart", async () => {
    const plain = await collectTopology();
    const before = structuredClone(plain);
    const host = plain.hosts[0];
    assert.equal(host?.displayName, "Demo-Laptop");
    assert.equal(host?.macAddress, "00:00:5E:00:53:01");
    assert.deepEqual(host?.ipv6Addresses, ["fe80::200:5eff:fe00:5301", "2001:db8::10"]);

    const redacted = redactTopology(plain);
    assert.deepEqual(plain, before);
    const masked = redacted.hosts[0];
    assert.equal(masked?.displayName, REDACTED);
    assert.equal(masked?.macAddress, "00:00:5E:**:**:**");
    assert.deepEqual(masked?.ipv6Addresses, ["fe80:****", "2001:db8:****"]);
    assert.equal(masked?.ipv4Address, "192.168.8.10");
    assert.deepEqual(redacted.countsByMedium, plain.countsByMedium);
  });

  it("masks the addresses in audit details for Bearer readers and leaves the console's copy alone", () => {
    const entry = { tsIso: "2026-11-02T10:00:00.000Z", channel: "web" as const, label: null, action: "login", outcome: "applied" as const };
    const entries = [
      { ...entry, detail: "from 198.51.100.42" },
      { ...entry, detail: "from 2001:db8::42" },
      { ...entry, action: "settings.cpe", detail: "router 192.168.8.1:8080 as admin" },
      { ...entry, action: "settings.cpe", detail: "router [2001:db8::1]:8443 as admin" },
      { ...entry, detail: null },
    ];
    assert.equal(auditForOutput(entries, false), entries, "the web console gets the entries as stored");
    assert.deepEqual(
      auditForOutput(entries, true).map((e) => e.detail),
      ["from 198.51.*.*", "from 2001:db8:****", "router 192.168.*.*:8080 as admin", "router [2001:db8:****]:8443 as admin", null]
    );
    assert.equal(entries[0]?.detail, "from 198.51.100.42", "the stored entries are not modified");
  });
});
