import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessGuardFromHosts,
  applyTimeRuleChange,
  applyWifiAccessChange,
  fetchAccessControl,
  parseTimeRules,
  parseWifiMacFilter,
} from "../src/access-control.ts";
import { HuaweiCpeClient, type EphemeralCpeSession } from "../src/cpe-client.ts";
import { CpeControlValidationError, fetchTerminalTopology } from "../src/cpe-domain.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

/** RFC 7042 documentation MACs and the 192.168.8.0/24 LAN only (AGENTS.md 铁律二). */
const NAS = "00:00:5E:00:53:01";
const LAPTOP = "00:00:5E:00:53:02";
const PHONE = "00:00:5E:00:53:03";
const TABLET = "00:00:5E:00:53:04";
const HOSTS = JSON.stringify([
  { MACAddress: NAS, HostName: "nas", IPAddress: "192.168.8.10", Active: true, InterfaceType: "Ethernet", EthernetSpeed: 1000, IsLocalDevice: true },
  { MACAddress: LAPTOP, HostName: "laptop", IPAddress: "192.168.8.20", IPv6Address: "fe80::2;2001:db8::20", Active: true, InterfaceType: "Wireless", Frequency: "5GHz", rate: 1201 },
  { MACAddress: PHONE, HostName: "Kid's phone", IPAddress: "192.168.8.30", Active: true, InterfaceType: "Wireless", Frequency: "5GHz", rate: 866 },
  { MACAddress: TABLET, HostName: "tablet", IPAddress: "192.168.8.40", Active: true, InterfaceType: "Wireless", Frequency: "2.4GHz", rate: 72 },
]);

function setup(extraFault?: (path: string, method: string) => StrictFault | undefined) {
  const cpe = createStrictCpe({
    fault: (p, method) => extraFault?.(p, method) ?? (method === "GET" && p === "/api/system/HostInfo" ? { body: HOSTS } : undefined),
  });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl });
  const run = async <T>(fn: (session: EphemeralCpeSession) => Promise<T>): Promise<T> => {
    const outcome = await client.withSessionDetailed(fn);
    if (outcome.status !== "ok") throw new Error(`session ${outcome.status}`);
    return outcome.value;
  };
  const writes = (path: string): string[] => cpe.stats.writes.filter((w) => w.path === path).map((w) => w.body);
  return { cpe, run, writes };
}

describe("access-control: reading the router", () => {
  it("parses the captured Wi-Fi MAC filter and time rule formats, decoding Huawei-escaped names", () => {
    const ex =
      "<response><Ssids><Ssid><wifimacwhitelist></wifimacwhitelist><Index>0</Index><wifimacblacklist><wifihostname0>Kid&#x27;s phone</wifihostname0>" +
      `<WifiMacFilterMac0>${PHONE.toLowerCase()}</WifiMacFilterMac0><wifihostname2>tablet</wifihostname2><WifiMacFilterMac2>${TABLET}</WifiMacFilterMac2></wifimacblacklist></Ssid>` +
      "<Ssid><wifimacwhitelist></wifimacwhitelist><Index>6</Index><wifimacblacklist></wifimacblacklist></Ssid></Ssids><wifimacfilterstatus>2</wifimacfilterstatus><enable>1</enable></response>";
    const parsed = parseWifiMacFilter(ex, "<response><wifimaxmacfilternum>64</wifimaxmacfilternum></response>");
    assert.deepEqual(parsed.state, {
      enabled: true,
      policy: "deny",
      allowList: [],
      denyList: [
        { macAddress: PHONE, name: "Kid's phone" },
        { macAddress: TABLET, name: "tablet" },
      ],
      maxEntries: 64,
    });
    assert.deepEqual(parsed.slots, { allow: 0, deny: 3 }, "slot 1 is empty but slot 2 is used");
    assert.equal(parseWifiMacFilter("<response><Ssids></Ssids></response>", "").state.maxEntries, 10, "the router UI's default");

    const rules = parseTimeRules(
      "<response><TimeControlRules><TimeControlRule><ID>4</ID><Enable>1</Enable><TimeMode>1</TimeMode><WeekEnable>1111100</WeekEnable><StartTime>08:00</StartTime><EndTime>21:00</EndTime>" +
        `<DevicesMACs><DevicesMAC>${PHONE}</DevicesMAC></DevicesMACs><DevicesNames><DevicesName>Kid&#x27;s phone</DevicesName></DevicesNames></TimeControlRule></TimeControlRules><TimeRuleMaxNum>16</TimeRuleMaxNum></response>`
    );
    assert.deepEqual(rules, {
      supported: true,
      maxRules: 16,
      rules: [{ id: "4", enabled: true, devices: [{ macAddress: PHONE, name: "Kid's phone" }], weekMask: "1111100", startTime: "08:00", endTime: "21:00" }],
    });
    assert.deepEqual(parseTimeRules(""), { supported: false, maxRules: 0, rules: [] });
  });

  it("parses the H168-383's own time rule read-back: TR-069 rule IDs and a stray DevicesMAC outside DevicesMACs", () => {
    // Captured from the real router after a create (MAC replaced with a documentation address)
    const real =
      "<response><TimeRuleMaxNum>16</TimeRuleMaxNum><TimeControlRules><TimeControlRule><DevicesNames><DevicesName>phone</DevicesName></DevicesNames>" +
      `<ID>InternetGatewayDevice.X_FireWall.TimeRule.1.</ID><Enable>1</Enable><StartTime>03:00</StartTime><EndTime>04:00</EndTime><WeekEnable>1111111</WeekEnable><TimeMode>0</TimeMode>` +
      `<DevicesMACs><DevicesMAC>${PHONE}</DevicesMAC></DevicesMACs><DevicesMAC>${PHONE}</DevicesMAC></TimeControlRule></TimeControlRules></response>`;
    assert.deepEqual(parseTimeRules(real).rules, [
      { id: "InternetGatewayDevice.X_FireWall.TimeRule.1.", enabled: true, devices: [{ macAddress: PHONE, name: "phone" }], weekMask: "1111111", startTime: "03:00", endTime: "04:00" },
    ]);
  });

  it("fetches one snapshot of both features", async () => {
    const { run } = setup();
    const snap = await run((session) => fetchAccessControl(session));
    assert.deepEqual(snap.wifiMacFilter, { enabled: false, policy: "deny", allowList: [], denyList: [], maxEntries: 64 });
    assert.deepEqual(snap.timeRules, { supported: true, maxRules: 16, rules: [] });
    assert.equal(typeof snap.capturedAtMs, "number");
  });

  it("derives the protected devices from IsLocalDevice and the requester's address", async () => {
    const { run } = setup();
    const hosts = (await run((session) => fetchTerminalTopology(session))).hosts;
    assert.deepEqual(accessGuardFromHosts(hosts, "::ffff:192.168.8.20"), {
      protectedDevices: [
        { macAddress: NAS, reason: "daemon-host", wireless: false },
        { macAddress: LAPTOP, reason: "requester", wireless: true },
      ],
      onlineWifiMacs: [LAPTOP, PHONE, TABLET],
    });
    assert.deepEqual(accessGuardFromHosts(hosts, "2001:DB8::20").protectedDevices.map((d) => d.reason), ["daemon-host", "requester"]);
    assert.deepEqual(accessGuardFromHosts(hosts, "100.64.0.7").protectedDevices.map((d) => d.reason), ["daemon-host"], "a Tailscale peer is not a LAN host");
  });
});

describe("access-control: Wi-Fi MAC filter writes", () => {
  it("blocks and unblocks a device with the payloads the router UI sends, and the router enforces them", async () => {
    const { cpe, run, writes } = setup();
    const blocked = await run((session) => applyWifiAccessChange(session, { kind: "block", macAddress: PHONE, name: "Kid's phone" }, { requesterIp: "192.168.8.20" }));
    assert.equal(
      writes("/api/wlan/multi-macfilter-settings")[0],
      `<?xml version="1.0" encoding="UTF-8"?><request><Ssids><Ssid><WifiMacFilterStatus>2</WifiMacFilterStatus><Index>0</Index><WifiMacFilterMac0>${PHONE}</WifiMacFilterMac0><wifihostname0>Kid&#39;s phone</wifihostname0></Ssid></Ssids></request>`
    );
    assert.deepEqual(blocked.wifiMacFilter.denyList, [{ macAddress: PHONE, name: "Kid's phone" }]);
    assert.equal(blocked.wifiMacFilter.enabled, true);
    assert.equal(cpe.isWifiBlocked(PHONE), true);

    const restored = await run((session) => applyWifiAccessChange(session, { kind: "unblock", macAddress: PHONE }, { requesterIp: null }));
    assert.match(writes("/api/wlan/multi-macfilter-settings")[1] ?? "", /<WifiMacFilterStatus>2<\/WifiMacFilterStatus><Index>0<\/Index><WifiMacFilterMac0><\/WifiMacFilterMac0><wifihostname0><\/wifihostname0>/);
    assert.deepEqual(restored.wifiMacFilter.denyList, []);
    assert.equal(cpe.isWifiBlocked(PHONE), false);

    const again = await run((session) => applyWifiAccessChange(session, { kind: "unblock", macAddress: PHONE }, { requesterIp: null }));
    assert.equal(again.plan.write, null);
    assert.equal(writes("/api/wlan/multi-macfilter-settings").length, 2, "nothing to write, nothing written");
  });

  it("clears every slot a shorter list no longer uses", async () => {
    const { run, writes } = setup();
    await run((session) => applyWifiAccessChange(session, { kind: "mode", mode: "deny", entries: [{ macAddress: PHONE, name: "p" }, { macAddress: TABLET, name: "t" }] }, { requesterIp: null }));
    const after = await run((session) => applyWifiAccessChange(session, { kind: "entries", remove: [PHONE] }, { requesterIp: null }));
    assert.match(writes("/api/wlan/multi-macfilter-settings")[1] ?? "", new RegExp(`<WifiMacFilterMac0>${TABLET}</WifiMacFilterMac0><wifihostname0>t</wifihostname0><WifiMacFilterMac1></WifiMacFilterMac1><wifihostname1></wifihostname1>`));
    assert.deepEqual(after.wifiMacFilter.denyList, [{ macAddress: TABLET, name: "t" }]);
  });

  it("refuses to cut off the daemon's host or the requesting device before writing anything", async () => {
    const { run, writes } = setup();
    for (const [mac, ip] of [[NAS, null], [LAPTOP, "192.168.8.20"]] as const) {
      await assert.rejects(
        () => run((session) => applyWifiAccessChange(session, { kind: "block", macAddress: mac, name: "x" }, { requesterIp: ip })),
        (err: unknown) => err instanceof CpeControlValidationError && /cannot be cut off/.test(err.message)
      );
    }
    await assert.rejects(
      () => run((session) => applyWifiAccessChange(session, { kind: "mode", mode: "allow", entries: [{ macAddress: PHONE, name: "p" }] }, { requesterIp: "192.168.8.20" })),
      CpeControlValidationError
    );
    assert.equal(writes("/api/wlan/multi-macfilter-settings").length, 0);

    const allowed = await run((session) =>
      applyWifiAccessChange(session, { kind: "mode", mode: "allow", entries: [{ macAddress: LAPTOP, name: "l" }, { macAddress: PHONE, name: "p" }] }, { requesterIp: "192.168.8.20" })
    );
    assert.deepEqual(allowed.plan.alsoBlocked, [TABLET]);
    assert.equal(allowed.wifiMacFilter.policy, "allow");
  });

  it("fails loudly when the router acknowledges a write it did not apply", async () => {
    const { run } = setup((p, method) =>
      method === "POST" && p === "/api/wlan/multi-macfilter-settings" ? { body: "<response>OK</response>" } : undefined
    );
    await assert.rejects(
      () => run((session) => applyWifiAccessChange(session, { kind: "block", macAddress: PHONE, name: "p" }, { requesterIp: null })),
      /did not apply/
    );
  });
});

describe("access-control: internet time rules", () => {
  it("creates, updates and deletes rules with the router UI's payloads and re-reads the table", async () => {
    const { cpe, run, writes } = setup();
    const created = await run((session) =>
      applyTimeRuleChange(session, { kind: "create", rule: { macAddress: PHONE, name: "Kid's phone", weekMask: "1111100", startTime: "07:00", endTime: "21:30" } }, { requesterIp: null })
    );
    assert.equal(
      writes("/api/timerule/timerule")[0],
      `<?xml version="1.0" encoding="UTF-8"?><request><TimeControlRules><TimeControlRule><Action>create</Action><Enable>1</Enable><TimeMode>1</TimeMode><ID></ID><DevicesMACs><DevicesMAC>${PHONE}</DevicesMAC></DevicesMACs><DevicesNames><DevicesName>Kid&#39;s phone</DevicesName></DevicesNames><WeekEnable>1111100</WeekEnable><StartTime>07:00</StartTime><EndTime>21:30</EndTime></TimeControlRule></TimeControlRules></request>`
    );
    assert.equal(created.rules.length, 1);
    const id = created.rules[0]?.id ?? "";

    await assert.rejects(
      () => run((session) => applyTimeRuleChange(session, { kind: "create", rule: { macAddress: PHONE, name: "p", weekMask: "1000000", startTime: "21:00", endTime: "23:00" } }, { requesterIp: null })),
      (err: unknown) => err instanceof CpeControlValidationError && /Overlaps rule/.test(err.message)
    );
    await assert.rejects(
      () => run((session) => applyTimeRuleChange(session, { kind: "create", rule: { macAddress: NAS, name: "nas", weekMask: "1111111", startTime: "07:00", endTime: "08:00" } }, { requesterIp: null })),
      /runs FengSui/
    );

    const updated = await run((session) =>
      applyTimeRuleChange(session, { kind: "update", id, rule: { macAddress: PHONE, name: "Kid's phone", weekMask: "1111111", startTime: "07:00", endTime: "21:30", enabled: false } }, { requesterIp: null })
    );
    assert.match(writes("/api/timerule/timerule")[1] ?? "", new RegExp(`<Action>update</Action><Enable>0</Enable><TimeMode>0</TimeMode><ID>${id}</ID>`));
    assert.equal(updated.rules[0]?.enabled, false);

    const deleted = await run((session) => applyTimeRuleChange(session, { kind: "delete", id }, { requesterIp: null }));
    assert.match(writes("/api/timerule/timerule")[2] ?? "", /<Action>delete<\/Action>/);
    assert.deepEqual(deleted.rules, []);
    assert.equal(cpe.router.timeRules.rules.length, 0);
  });
});
