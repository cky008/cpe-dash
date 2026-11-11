import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { SectionUnavailableError } from "../src/cpe-domain.ts";
import { driverTopologySnapshot } from "../src/drivers/hosts.ts";
import type { DriverHost } from "../src/drivers/types.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";
import { ZTE_PASSWORD, zteRouter } from "./helpers/zte-goform-router.ts";

/**
 * Connected devices on routers of driver families: the device lists their interfaces document, in the
 * HiLink stack's snapshot. Placeholder MACs and addresses only (RFC 7042, RFC 1918).
 */

const MAC_A = "02:00:5E:10:00:01";
const MAC_B = "00:00:5E:00:53:01";
const MAC_C = "00:00:5E:00:53:02";

function host(overrides: Partial<DriverHost>): DriverHost {
  return { mac: MAC_A, name: null, ipv4: null, ipv6: [], link: null, connectedSec: null, leaseSec: null, rssiDbm: null, ...overrides };
}

describe("driver hosts: the snapshot", () => {
  it("writes each device once, with its link as the router names it and unknown when it names none", () => {
    const snap = driverTopologySnapshot([
      host({ mac: MAC_A.toLowerCase(), name: "laptop", ipv4: "192.168.0.20", link: "wifi_5", rssiDbm: -61.4 }),
      host({ mac: MAC_A, name: "the same device again", link: "lan" }),
      host({ mac: MAC_B, name: "nas", ipv4: "192.168.0.10", link: "lan", connectedSec: 3600 }),
      host({ mac: MAC_C, name: "phone\u0007\u0000", ipv6: ["2001:db8::42", "not an address"], leaseSec: 43170 }),
      host({ mac: "ff:ff:ff:ff:ff:ff", name: "broadcast" }),
      host({ mac: "garbage", name: "nothing" }),
    ]);
    assert.deepEqual(
      snap.hosts.map((h) => [h.macAddress, h.displayName, h.medium, h.frequency, h.interfaceType, h.ipv4Address, h.rssi]),
      [
        [MAC_A, "laptop", "WIFI_5G", "5GHz", "Wireless", "192.168.0.20", -61],
        [MAC_B, "nas", "LAN_OTHER", "", "Ethernet", "192.168.0.10", null],
        [MAC_C, "phone", "UNKNOWN", "", "", "", null],
      ]
    );
    assert.deepEqual(snap.hosts[2]?.ipv6Addresses, ["2001:db8::42"]);
    assert.deepEqual([snap.hosts[2]?.leaseTimeRemainingSec, snap.hosts[2]?.addressSource, snap.hosts[1]?.associatedTimeSec], [43170, "DHCP", 3600]);
    assert.deepEqual(snap.countsByMedium, { LAN_1000M: 0, LAN_100M: 0, LAN_OTHER: 1, WIFI_2_4G: 0, WIFI_5G: 1, WIFI_OTHER: 0, UNKNOWN: 1 });
    assert.deepEqual(snap.summary, { topLevelNodes: 3, totalActiveNodes: 3, meshChildNodes: 0, ethernetNodes: 1, wirelessNodes: 1 });
    // A reading that is not an RSSI is not shown as one
    assert.equal(driverTopologySnapshot([host({ link: "wifi", rssiDbm: 87 })]).hosts[0]?.rssi, null);
    assert.equal(driverTopologySnapshot([host({ link: "lan", rssiDbm: -50 })]).hosts[0]?.rssi, null, "a wired device has no RSSI");
  });
});

describe("zte-goform: connected devices", () => {
  it("lists the wired and the Wi-Fi devices the router's page lists", async () => {
    const { client } = zteRouter({
      stations: {
        lan: [{ connect_time: "86400", hostname: "nas", ip_addr: "192.168.0.10", mac_addr: MAC_B, mac_bind_flag: "1" }],
        wifi: [{ hostname: "laptop", ip_addr: "192.168.0.20", mac_addr: MAC_A }, "not a row"],
      },
    });
    const hosts = await client.withSession((s) => s.hosts!());
    assert.deepEqual(hosts?.map((h) => [h.mac, h.name, h.ipv4, h.link, h.connectedSec]), [
      [MAC_B, "nas", "192.168.0.10", "lan", 86400],
      [MAC_A, "laptop", "192.168.0.20", "wifi", null],
    ]);
  });

  it("says the list is not there when the firmware answers neither list", async () => {
    const { client } = zteRouter();
    await assert.rejects(client.withSession((s) => s.hosts!()), SectionUnavailableError);
  });

  it("feeds the console's device card through the daemon", async () => {
    const { mock } = zteRouter({ stations: { lan: [{ hostname: "nas", ip_addr: "192.168.0.10", mac_addr: MAC_B }] } });
    const dir = tempDir("fengsui-hosts-");
    const core = createFengSuiCore({
      client: new HuaweiCpeClient({ cpeUrl: "http://192.168.0.1", cpeUsername: "", cpePassword: ZTE_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 }),
      stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "hosts_key" }),
      timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
      family: "zte-goform",
      pollIntervalMs: 600_000,
      neighborScanIntervalMs: 600_000,
    });
    core.monitor.init();
    try {
      assert.notEqual(core.scheduler.device.readState("topology").state, "unavailable");
      const snap = await core.monitor.refreshTopology({ ignoreCooldown: true });
      assert.deepEqual(snap?.hosts.map((h) => [h.macAddress, h.medium]), [[MAC_B, "LAN_OTHER"]]);
    } finally {
      await stopFengSuiCore(core);
      removeTempDir(dir);
    }
  });
});

describe("nradio: connected devices", () => {
  it("lists the clients the router's own client page lists, with their link", async () => {
    const mock = new LanRouterMock((req) => {
      if (req.method === "POST" && req.path === "/cgi-bin/luci") return { status: 302, headers: { location: "/cgi-bin/luci" }, setCookie: ["sysauth=0123456789abcdef0123456789abcdef; path=/cgi-bin/luci"] };
      if (req.path === "/cgi-bin/luci/nradio/system/overview") return { text: `<div>设备型号: C2000 MAX</div><script>a['token']='a8f5f167f44f4964e6c998dee827110c';</script>` };
      if (req.path === "/cgi-bin/luci/nradio/client/all_list") {
        return {
          json: {
            result: {
              client: [
                { mac: MAC_B, hostname: "nas", type: "wired", exsit: 1 },
                { mac: MAC_A, hostname: "laptop", type: "wireless", frequency: "5.8G", ssid: "placeholder", rssi: "-55", exsit: "1" },
                { mac: MAC_C, hostname: "phone", type: "wireless", frequency: "2.4G", rssi: "-70", exsit: 1 },
                { mac: "00:00:5E:00:53:09", hostname: "gone", type: "wired", exsit: 0 },
              ],
            },
          },
        };
      }
      if (req.path === "/cgi-bin/luci/nradio/logout") return { status: 302, headers: { location: "/" } };
      return { status: 404, text: "" };
    });
    const { DriverCpeClient } = await import("../src/drivers/client.ts");
    const { nradioProtocol } = await import("../src/drivers/nradio.ts");
    const client = new DriverCpeClient({ protocol: nradioProtocol, cpeUrl: "http://192.168.66.1", cpeUsername: "root", cpePassword: "test-password", fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
    const hosts = await client.withSession((s) => s.hosts!());
    assert.deepEqual(hosts?.map((h) => [h.mac, h.name, h.link, h.rssiDbm]), [
      [MAC_B, "nas", "lan", null],
      [MAC_A, "laptop", "wifi_5", -55],
      [MAC_C, "phone", "wifi_2_4", -70],
    ]);
  });
});

describe("openwrt: connected devices", () => {
  it("lists LuCI's DHCP leases, the IPv6 ones folded in by MAC, with no link claimed", async () => {
    const { client } = openwrtRouter({
      leases: {
        dhcp_leases: [
          { expires: 43170, hostname: "laptop", macaddr: MAC_A.toLowerCase(), ipaddr: "192.168.1.20" },
          { expires: false, macaddr: MAC_B, ipaddr: "192.168.1.10" },
          { expires: 10, hostname: "no mac", ipaddr: "192.168.1.99" },
        ],
        dhcp6_leases: [
          { expires: 3600, hostname: "laptop", macaddr: MAC_A.toLowerCase(), ip6addr: "2001:db8::20", ip6addrs: ["2001:db8::20", "2001:db8::21"] },
          { expires: 3600, hostname: "v6only", macaddr: MAC_C, ip6addr: "2001:db8::30" },
        ],
      },
    });
    const hosts = await client.withSession((s) => s.hosts!());
    assert.deepEqual(hosts?.map((h) => [h.mac.toUpperCase(), h.name, h.ipv4, h.ipv6, h.leaseSec, h.link]), [
      [MAC_A, "laptop", "192.168.1.20", ["2001:db8::20", "2001:db8::21"], 43170, null],
      [MAC_B, null, "192.168.1.10", [], null, null],
      [MAC_C, "v6only", null, ["2001:db8::30"], null, null],
    ]);
  });

  it("says the list is not there on a router without LuCI's lease list", async () => {
    const { client } = openwrtRouter();
    await assert.rejects(client.withSession((s) => s.hosts!()), SectionUnavailableError);
  });
});
