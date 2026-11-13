import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { CpeApiError } from "../src/session-errors.ts";
import { DeviceAccess, isReadRecord } from "../src/device-access.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { parseHostInfoJsonList, parseHostListXml } from "../src/parsers.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { FAMILY_LOGINS, FAMILY_TOKEN_FLOWS, type FamilySms, blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * Multi-model phase 2: a model nobody verified is read the tolerant way. A part or a section the
 * router answers without (`100002` / `100003`, or an answer FengSui cannot read) is marked "not on
 * this model" and never fails the rest of the poll; the H168-383 keeps the verified, strict reads.
 * Placeholders only, no network.
 */

/** An LTE-only router nobody verified: the HiLink basics, an XML host list, plaintext SMS, nothing else. */
const LTE_ROUTER: Readonly<Record<string, string>> = {
  "/api/device/signal":
    "<response><pci>25</pci><cell_id>134217758</cell_id><rsrq>-9dB</rsrq><rsrp>-97dBm</rsrp><rssi>-71dBm</rssi><sinr>11dB</sinr><mode>7</mode><tac>10001</tac><plmn>27201</plmn></response>",
  "/api/net/current-plmn": "<response><State>0</State><FullName>Carrier-Lab</FullName><ShortName>CARRIER</ShortName><Numeric>27201</Numeric><Rat>7</Rat></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>80800C5</LTEBand></response>",
  "/api/monitoring/traffic-statistics":
    "<response><CurrentConnectTime>3600</CurrentConnectTime><CurrentUpload>524288</CurrentUpload><CurrentDownload>1048576</CurrentDownload><CurrentDownloadRate>250000</CurrentDownloadRate><CurrentUploadRate>50000</CurrentUploadRate><TotalUpload>10485760</TotalUpload><TotalDownload>20971520</TotalDownload><TotalConnectTime>86400</TotalConnectTime></response>",
  "/api/monitoring/month_statistics":
    "<response><CurrentMonthDownload>10485760</CurrentMonthDownload><CurrentMonthUpload>2097152</CurrentMonthUpload><MonthDuration>43200</MonthDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime><CurrentDayUsed>1048576</CurrentDayUsed><CurrentDayDuration>7200</CurrentDayDuration></response>",
  "/api/lan/HostInfo":
    "<response><Hosts><Host><ID>1</ID><MacAddress>02:00:5E:10:00:01</MacAddress><IpAddress>192.168.8.10</IpAddress><HostName>nas</HostName><Active>1</Active><InterfaceType>Ethernet</InterfaceType></Host><Host><ID>2</ID><MacAddress>02:00:5E:10:00:03</MacAddress><IpAddress>192.168.8.30</IpAddress><HostName>phone</HostName><Active>1</Active><InterfaceType>802.11</InterfaceType><Frequency>2.4GHz</Frequency></Host></Hosts></response>",
};

const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
  { index: 39001, phone: "+353830000001", content: "See you there", date: "2026-11-02 18:05:00", smstat: "3", box: 2 },
];

function readFixture(cpe: { fetchImpl: typeof fetch; password: string }, opts: { neighborScanIntervalMs?: number; dir?: string } = {}) {
  const dir = opts.dir ?? tempDir("fengsui-reads-");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "reads_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: opts.neighborScanIntervalMs ?? 600_000,
    smsCountersEnabled: true,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("reads_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
  return {
    dir,
    core,
    sms,
    reads: () => Object.fromEntries(Object.entries(core.scheduler.getStatus().device.reads).map(([section, r]) => [section, r.code ? `${r.state} ${r.code}` : r.state])),
    cleanup: async (keep = false) => {
      await sms.stop();
      await stopFengSuiCore(core);
      if (!keep) removeTempDir(dir);
    },
  };
}

describe("read strategies on models nobody verified", () => {
  let restoreNetwork: () => void = () => undefined;
  before(() => {
    restoreNetwork = blockNetwork();
  });
  after(() => restoreNetwork());

  it("runs a full read-only round on every mock family: what the router has is read right, the rest is marked unavailable", async () => {
    for (const login of FAMILY_LOGINS) {
      for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
        const label = `${login} × ${tokenFlow}`;
        const cpe = createCpeFamily({ login, tokenFlow, model: "B535-232", endpoints: LTE_ROUTER, sms: MAILBOX });
        const fx = readFixture(cpe);
        try {
          assert.ok(await fx.core.monitor.identifyDevice(), label);
          assert.equal(fx.core.scheduler.getStatus().device.writes, "experimental", label);

          const telemetry = await fx.core.monitor.refreshTelemetry();
          assert.ok(telemetry, label);
          assert.deepEqual(telemetry.unavailable, [], `${label}: every core part answered`);
          assert.deepEqual(
            [telemetry.device.deviceName, telemetry.rf.lteRsrpDbm, telemetry.rf.lteSinrDb, telemetry.rf.pci, telemetry.rf.nrRsrpDbm, telemetry.rf.nrSinrDb],
            ["B535-232", -97, 11, 25, null, null],
            `${label}: LTE values, and no NR on an LTE-only model`
          );
          assert.deepEqual([telemetry.traffic.downloadBytesPerSec, telemetry.traffic.monthTotalBytes, telemetry.sms?.localInbox], [250000, 12582912, 1], label);

          assert.equal(await fx.core.monitor.refreshNeighbors(), null, `${label}: no neighbour list on this model, and no error`);
          const topology = await fx.core.monitor.refreshTopology();
          assert.deepEqual(
            [topology?.source, topology?.hosts.map((h) => [h.macAddress, h.ipv4Address, h.displayName, h.medium, h.active])],
            [
              "lan/HostInfo",
              [
                ["02:00:5E:10:00:01", "192.168.8.10", "nas", "LAN_OTHER", true],
                ["02:00:5E:10:00:03", "192.168.8.30", "phone", "WIFI_2_4G", true],
              ],
            ],
            label
          );
          assert.equal(await fx.core.monitor.refreshSettings(), null, label);
          assert.equal(await fx.core.monitor.refreshAccessControl(), null, label);
          assert.ok(await fx.sms.sync("full"), label);
          assert.deepEqual(fx.sms.mirror.list().map((m) => m.content).sort(), ["Dinner at 7?", "See you there"], label);

          assert.deepEqual(
            fx.reads(),
            { telemetry: "available", neighbors: "unavailable 100002", topology: "available", settings: "unavailable 100002", accessControl: "unavailable 100002", sms: "available" },
            label
          );
          assert.notEqual(fx.core.scheduler.getStatus().mode, "cpe_unreachable", `${label}: an absent section is no outage`);
          assert.deepEqual(cpe.stats.writes, [], `${label}: reads only`);
        } finally {
          await fx.cleanup();
        }
      }
    }
  });

  it("keeps the rest of the poll when a whole part is missing or a field is odd", async () => {
    const cpe = createCpeFamily({
      login: "scram",
      tokenFlow: "token",
      model: "B535-232",
      endpoints: {
        ...LTE_ROUTER,
        "/api/device/signal": "<response><vendor_tag>x</vendor_tag><rsrp>--</rsrp><sinr>11dB</sinr><pci>25</pci><nested><deep>1</deep></nested></response>",
        "/api/monitoring/month_statistics": { cpeError: "100002" },
      },
    });
    const fx = readFixture(cpe);
    try {
      await fx.core.monitor.identifyDevice();
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.deepEqual(snap.unavailable, ["month"]);
      assert.deepEqual([snap.rf.lteRsrpDbm, snap.rf.lteSinrDb, snap.rf.pci, snap.traffic.downloadBytesPerSec], [null, 11, 25, 250000], "an odd value is null, its neighbours stay");
      assert.equal(fx.core.monitor.queryTimeSeries({ preset: "1h" }).points.length > 0, true, "the sample is kept");
    } finally {
      await fx.cleanup();
    }

    // No traffic counters: no throughput sample rather than a made-up zero, and no speed tick
    const noTraffic = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: { ...LTE_ROUTER, "/api/monitoring/traffic-statistics": { cpeError: "100002" } } });
    const fy = readFixture(noTraffic);
    const speed: unknown[] = [];
    fy.core.monitor.on("speed", (tick: unknown) => speed.push(tick));
    try {
      await fy.core.monitor.identifyDevice();
      const snap = await fy.core.monitor.refreshTelemetry();
      assert.deepEqual(snap?.unavailable, ["traffic"]);
      assert.deepEqual([fy.core.monitor.queryTimeSeries({ preset: "1h" }).points.length, speed.length], [0, 0]);
    } finally {
      await fy.cleanup();
    }

    // Only monitoring/status (which every family answers): a snapshot of what there is, the rest listed
    const bare = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232" });
    const fz = readFixture(bare);
    try {
      await fz.core.monitor.identifyDevice();
      const snap = await fz.core.monitor.refreshTelemetry();
      assert.deepEqual([snap?.unavailable, snap?.device.connectionStatus], [["signal", "traffic", "month"], "901"]);
      assert.equal(fz.reads()["telemetry"], "available");
    } finally {
      await fz.cleanup();
    }
  });

  it("finds the device list through the endpoints other models use, and never shows an unreadable one as empty", async () => {
    const run = async (endpoints: Record<string, string | { cpeError: string }>) => {
      const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints });
      const fx = readFixture(cpe);
      try {
        await fx.core.monitor.identifyDevice();
        const topology = await fx.core.monitor.refreshTopology();
        return { topology, reads: fx.reads()["topology"] };
      } finally {
        await fx.cleanup();
      }
    };
    const json = await run({ "/api/system/HostInfo": JSON.stringify([{ MACAddress: "02:00:5E:10:00:04", HostName: "tv", IPAddress: "192.168.8.40", Active: true, InterfaceType: "Ethernet", EthernetSpeed: 1000 }]) });
    assert.deepEqual([json.topology?.source, json.topology?.hosts.map((h) => h.medium)], [undefined, ["LAN_1000M"]]);

    const wifi = await run({
      "/api/lan/HostInfo": "<!DOCTYPE html><html><body>login</body></html>",
      "/api/wlan/host-list": "<response><Hosts><Host><MacAddress>02:00:5E:10:00:05</MacAddress><IpAddress>192.168.8.50</IpAddress><HostName>plug</HostName><Frequency>2.4GHz</Frequency></Host></Hosts></response>",
    });
    assert.deepEqual(
      [wifi.topology?.source, wifi.topology?.hosts.map((h) => [h.interfaceType, h.active, h.medium])],
      ["wlan/host-list", [["Wireless", true, "WIFI_2_4G"]]],
      "a page is no list; the Wi-Fi list then counts associated clients as online"
    );

    const empty = await run({ "/api/lan/HostInfo": "<response><Hosts></Hosts></response>" });
    assert.deepEqual([empty.topology?.hosts, empty.reads], [[], "available"], "an empty list is a list");

    const unreadable = await run({ "/api/lan/HostInfo": "<response><Hosts><Host><Name>x</Name></Host></Hosts></response>" });
    assert.deepEqual([unreadable.topology, unreadable.reads], [null, "unavailable"], "hosts none of which reads are not an empty list");

    const none = await run({});
    assert.deepEqual([none.topology, none.reads], [null, "unavailable 100002"]);

    assert.equal(parseHostInfoJsonList("{}"), null);
    assert.equal(parseHostInfoJsonList("not json"), null);
    assert.equal(parseHostListXml("", { wifiOnly: false }), null);
    assert.deepEqual(parseHostListXml("<response/>", { wifiOnly: true }), []);
  });

  it("fails the device list read on a code that does not say the endpoint is missing, as every other section does (A.10)", async () => {
    // Busy (100004), or a code that is no code at all: the read fails and tries again next time,
    // never "not on this model", which would stop the background sweeps and show the router's text
    for (const code of ["100004", "not-a-code"]) {
      const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: { "/api/lan/HostInfo": { cpeError: code } } });
      const fx = readFixture(cpe);
      try {
        await fx.core.monitor.identifyDevice();
        await assert.rejects(fx.core.monitor.refreshTopology(), (err: unknown) => err instanceof CpeApiError && err.code === code, code);
        assert.equal(fx.reads()["topology"], "unknown", code);
        assert.equal(fx.core.scheduler.device.skips("topology"), false, `${code}: the sweeps keep asking`);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("skips a section this model lacks in the background sweeps, while a refresh someone asks for still tries", async () => {
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: LTE_ROUTER });
    const fx = readFixture(cpe, { neighborScanIntervalMs: 20 });
    try {
      await fx.core.monitor.identifyDevice();
      assert.equal(await fx.core.monitor.refreshNeighbors(), null);
      assert.equal(cpe.count("/api/device/nbrcellinfo"), 1);
      fx.core.monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(cpe.count("/api/device/nbrcellinfo"), 1, "not asked again in the background");
      assert.ok(cpe.count("/api/lan/HostInfo") >= 2, "the other sweeps go on");
      await fx.core.monitor.refreshNeighbors();
      assert.equal(cpe.count("/api/device/nbrcellinfo"), 2, "an explicit refresh asks");
    } finally {
      await fx.cleanup();
    }
  });

  it("remembers what the model answered across a restart, and forgets it for another model", async () => {
    // No SMS on this model
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: LTE_ROUTER });
    const fx = readFixture(cpe);
    await fx.core.monitor.identifyDevice();
    await fx.core.monitor.refreshNeighbors();
    assert.equal(await fx.sms.sync("full"), null, "skipped, not failed");
    assert.equal(fx.reads()["sms"], "unavailable 100002");
    await fx.cleanup(true);
    const restarted = readFixture(cpe, { dir: fx.dir });
    try {
      assert.deepEqual([restarted.reads()["neighbors"], restarted.reads()["sms"]], ["unavailable 100002", "unavailable 100002"], "known at once after a restart");
      const asked = cpe.count("/api/sms/sms-count", "GET");
      restarted.sms.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(cpe.count("/api/sms/sms-count", "GET"), asked, "no SMS sync at start on a model without SMS");
      restarted.core.scheduler.noteRouterModel("E5576-320", null);
      assert.deepEqual(restarted.reads(), { telemetry: "unknown", neighbors: "unknown", topology: "unknown", settings: "unknown", accessControl: "unknown", sms: "unknown" }, "another model: nothing known yet");
    } finally {
      await restarted.cleanup();
    }

    const access = new DeviceAccess();
    assert.equal(access.noteRead("sms", { available: true }), false, "nothing is kept before a model is known");
    access.remember("H168-383", null);
    assert.equal(access.noteRead("sms", { available: false, code: "100002" }), false, "nor for a verified model");
    assert.equal(access.readState("sms").state, "verified");
    for (const odd of [null, [], { model: 1, reads: {} }, { model: "X", reads: { sms: { state: "verified", code: null } } }, { model: "X", reads: { mms: { state: "available", code: null } } }, { model: "X", reads: { sms: { state: "unavailable", code: "abc" } } }]) {
      assert.equal(isReadRecord(odd), false, JSON.stringify(odd));
    }
  });

  it("counts what worked before the first identification for the model identified next", async () => {
    // A fresh install: the start-up SMS sync runs before the router is identified
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: LTE_ROUTER, sms: MAILBOX });
    const fx = readFixture(cpe);
    try {
      assert.ok(await fx.sms.sync("full"));
      assert.equal(fx.reads()["sms"], "unknown", "no model yet: nothing to say");
      await fx.core.monitor.identifyDevice();
      assert.equal(fx.reads()["sms"], "available", "SMS worked, so it is known to work on this model");
      assert.deepEqual(fx.core.stateStore.getState().deviceReads?.reads["sms"], { state: "available", code: null }, "stored with the identification");
    } finally {
      await fx.cleanup();
    }
    // The H168-383 keeps nothing of the kind
    const h168 = createStrictCpe();
    const fy = readFixture(h168);
    try {
      assert.ok(await fy.core.monitor.refreshTelemetry());
      await fy.core.monitor.identifyDevice();
      assert.deepEqual([fy.reads()["telemetry"], fy.core.stateStore.getState().deviceReads], ["verified", null]);
    } finally {
      await fy.cleanup();
    }
  });

  it("tells a router replaced mid-run by the model its failed poll names: device:changed, tolerant reads, a new identification", async () => {
    // The H168-383 is unplugged (the polls cannot reach it) and a router of another model with the same
    // address and admin password takes its place. Read the verified way, its first poll fails on a part
    // the H168-383 has (this one keeps no traffic counters), yet in that very poll it named its model
    const h168 = createStrictCpe();
    const endpoints = { ...LTE_ROUTER, "/api/monitoring/traffic-statistics": { cpeError: "100002" } };
    const lte = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints, password: h168.password });
    let router: typeof fetch = h168.fetchImpl;
    const fx = readFixture({ fetchImpl: async (input, init) => await router(input, init), password: h168.password });
    let changed = 0;
    fx.core.scheduler.on("device:changed", () => (changed += 1));
    try {
      assert.equal((await fx.core.monitor.identifyDevice())?.identity.model, "H168-383");
      assert.ok(await fx.core.monitor.refreshTelemetry());
      router = async () => {
        throw new TypeError("fetch failed");
      };
      await assert.rejects(fx.core.monitor.refreshTelemetry());
      router = lte.fetchImpl;
      await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CpeApiError && err.code === "100002", "read the verified way, the poll fails");
      assert.equal(changed, 1, "the model the router named in that poll contradicts the identification");
      const { model, writes } = fx.core.scheduler.getStatus().device;
      assert.deepEqual([model, writes], ["B535-232", "experimental"]);
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.equal(snap?.device.deviceName, "B535-232", "the next poll reads it the tolerant way");
      for (let i = 0; i < 100 && fx.core.monitor.getDeviceProbe()?.identity.model !== "B535-232"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fx.core.monitor.getDeviceProbe()?.identity.model, "B535-232", "and identified again right after it");
      assert.deepEqual(lte.stats.writes, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("leaves the H168-383 on its verified reads: an error still fails the read and nothing is recorded", async () => {
    const cpe = createStrictCpe({ fault: (p) => (p === "/api/device/nbrcellinfo" ? { cpeError: "100002" } : undefined) });
    const fx = readFixture(cpe);
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.equal(fx.core.monitor.getCachedTelemetry()?.unavailable, undefined, "no tolerant fields on the verified model");
      await assert.rejects(fx.core.monitor.refreshNeighbors(), (err: unknown) => err instanceof CpeApiError && err.code === "100002");
      assert.deepEqual(Object.values(fx.reads()), ["verified", "verified", "verified", "verified", "verified", "verified"]);
      const topology = await fx.core.monitor.refreshTopology();
      assert.equal(topology?.source, undefined);
    } finally {
      await fx.cleanup();
    }
  });
});
