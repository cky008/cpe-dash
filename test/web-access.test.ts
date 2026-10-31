import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TerminalHostEntry, TimeRule } from "../src/api-contract.ts";
import { QUARTER_TIMES, dayNames, formatWeekMask, isOvernight, previewGuard, rulesByDevice } from "../web/src/core/access-view.ts";

/** RFC 7042 documentation MACs only (AGENTS.md 铁律二). */
function host(mac: string, over: Partial<TerminalHostEntry> = {}): TerminalHostEntry {
  return {
    macAddress: mac,
    displayName: mac.slice(-2),
    active: true,
    interfaceType: "Wireless",
    layer2Interface: "SSID1",
    frequency: "5GHz",
    medium: "WIFI_5G",
    negotiatedRateMbps: 866,
    rssi: 30,
    ipv4Address: "192.168.8.20",
    ipv6Addresses: [],
    ipv6Active: false,
    addressSource: "DHCP",
    leaseTimeRemainingSec: 3600,
    associatedTimeSec: 60,
    isLocalDevice: false,
    ...over,
  };
}

describe("web core: access-control view helpers", () => {
  it("offers the router UI's 15-minute grid and labels weekly masks", () => {
    assert.equal(QUARTER_TIMES.length, 96);
    assert.deepEqual([QUARTER_TIMES[0], QUARTER_TIMES[1], QUARTER_TIMES.at(-1)], ["00:00", "00:15", "23:45"]);
    assert.deepEqual(dayNames("en").slice(0, 2), ["Mon", "Tue"]);
    assert.equal(formatWeekMask("1111111", "zh-CN"), "每天");
    assert.equal(formatWeekMask("1111100", "zh-CN"), "周一至周五");
    assert.equal(formatWeekMask("0000011", "en"), "Weekends");
    assert.equal(formatWeekMask("1010100", "en"), "Mon, Wed, Fri");
    assert.equal(formatWeekMask("0100001", "zh-CN"), "周二、周日");
    assert.equal(isOvernight("22:00", "06:30"), true);
    assert.equal(isOvernight("08:00", "21:00"), false);
  });

  it("groups rules per device and builds the planner guard from the topology", () => {
    const rule = (id: string, mac: string, start: string): TimeRule => ({ id, enabled: true, devices: [{ macAddress: mac, name: id }], weekMask: "1111111", startTime: start, endTime: "23:00" });
    const groups = rulesByDevice([rule("2", "00:00:5E:00:53:03", "09:00"), rule("1", "00:00:5E:00:53:03", "07:00"), rule("3", "00:00:5E:00:53:04", "08:00")]);
    assert.deepEqual([...groups.keys()], ["00:00:5E:00:53:03", "00:00:5E:00:53:04"]);
    assert.deepEqual(groups.get("00:00:5E:00:53:03")?.map((r) => r.id), ["1", "2"], "earliest window first");

    const hosts = [
      host("00:00:5E:00:53:01", { medium: "LAN_1000M", isLocalDevice: true }),
      host("00:00:5E:00:53:02"),
      host("00:00:5E:00:53:03", { active: false }),
    ];
    assert.deepEqual(previewGuard({ daemonHostMac: "00:00:5E:00:53:01", requesterMac: "00:00:5E:00:53:02" }, hosts), {
      protectedDevices: [
        { macAddress: "00:00:5E:00:53:01", reason: "daemon-host", wireless: false },
        { macAddress: "00:00:5E:00:53:02", reason: "requester", wireless: true },
      ],
      onlineWifiMacs: ["00:00:5E:00:53:02"],
    });
    assert.deepEqual(previewGuard(null, []), { protectedDevices: [], onlineWifiMacs: [] });
  });
});
