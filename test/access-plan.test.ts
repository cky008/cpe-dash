import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AccessPlanError,
  type AccessGuard,
  type TimeRule,
  type WifiMacFilterState,
  findTimeRuleConflicts,
  isDeviceBlocked,
  normalizeMac,
  normalizeTimeRuleInput,
  planTimeRuleChange,
  planWifiAccessChange,
  wifiFilterMode,
} from "../src/access-plan.ts";

/** RFC 7042 documentation MACs only (AGENTS.md 铁律二). */
const NAS = "00:00:5E:00:53:01";
const LAPTOP = "00:00:5E:00:53:02";
const PHONE = "00:00:5E:00:53:03";
const TABLET = "00:00:5E:00:53:04";

function state(over: Partial<WifiMacFilterState> = {}): WifiMacFilterState {
  return { enabled: false, policy: "deny", allowList: [], denyList: [], maxEntries: 4, ...over };
}

const NO_GUARD: AccessGuard = { protectedDevices: [], onlineWifiMacs: [] };
const GUARD: AccessGuard = {
  protectedDevices: [
    { macAddress: NAS, reason: "daemon-host", wireless: false },
    { macAddress: LAPTOP, reason: "requester", wireless: true },
  ],
  onlineWifiMacs: [LAPTOP, PHONE, TABLET],
};

function planError(fn: () => unknown, code: AccessPlanError["code"]): void {
  assert.throws(fn, (err: unknown) => err instanceof AccessPlanError && err.code === code);
}

describe("access-plan: MAC addresses and filter state", () => {
  it("normalizes unicast MACs and rejects broadcast, multicast, all-zero and malformed ones", () => {
    assert.equal(normalizeMac("00-00-5e-00-53-0a"), "00:00:5E:00:53:0A");
    assert.equal(normalizeMac(" 02:00:5E:10:00:01 "), "02:00:5E:10:00:01");
    for (const bad of ["", "FF:FF:FF:FF:FF:FF", "01:00:5E:00:00:01", "00:00:00:00:00:00", "00:00:5E:00:53", "00:00:5E:00:53:0G", "00:00:5E:00:53:01:02"]) {
      assert.equal(normalizeMac(bad), null, bad);
    }
  });

  it("derives the mode and whether a device is blocked from the router's switch, policy and lists", () => {
    const deny = state({ enabled: true, denyList: [{ macAddress: PHONE, name: "phone" }] });
    assert.equal(wifiFilterMode(deny), "deny");
    assert.equal(isDeviceBlocked(deny, PHONE.toLowerCase()), true);
    assert.equal(isDeviceBlocked(deny, TABLET), false);
    const allow = state({ enabled: true, policy: "allow", allowList: [{ macAddress: LAPTOP, name: "laptop" }] });
    assert.equal(wifiFilterMode(allow), "allow");
    assert.equal(isDeviceBlocked(allow, LAPTOP), false);
    assert.equal(isDeviceBlocked(allow, PHONE), true);
    const off = state({ denyList: [{ macAddress: PHONE, name: "phone" }] });
    assert.equal(wifiFilterMode(off), "off");
    assert.equal(isDeviceBlocked(off, PHONE), false, "a stored list blocks nobody while the filter is off");
  });
});

describe("access-plan: block and unblock a Wi-Fi device", () => {
  it("blocks by adding to the blacklist, and warns that switching the filter on also blocks stored entries", () => {
    const plan = planWifiAccessChange(state({ denyList: [{ macAddress: TABLET, name: "tablet" }] }), { kind: "block", macAddress: PHONE, name: "phone" }, GUARD);
    assert.deepEqual(plan.write, {
      status: "2",
      entries: [
        { macAddress: TABLET, name: "tablet" },
        { macAddress: PHONE, name: "phone" },
      ],
    });
    assert.deepEqual(plan.expected, { enabled: true, policy: "deny" });
    assert.deepEqual(plan.alsoBlocked, [TABLET]);
  });

  it("blocks under a whitelist by removing the device, never emptying the whitelist", () => {
    const allow = state({ enabled: true, policy: "allow", allowList: [{ macAddress: LAPTOP, name: "laptop" }, { macAddress: PHONE, name: "phone" }] });
    const plan = planWifiAccessChange(allow, { kind: "block", macAddress: PHONE, name: "phone" }, NO_GUARD);
    assert.deepEqual(plan.write, { status: "1", entries: [{ macAddress: LAPTOP, name: "laptop" }] });
    const lastOne = state({ enabled: true, policy: "allow", allowList: [{ macAddress: PHONE, name: "phone" }] });
    planError(() => planWifiAccessChange(lastOne, { kind: "block", macAddress: PHONE, name: "phone" }, NO_GUARD), "EMPTY_ALLOW_LIST");
  });

  it("unblocks by removing from the blacklist or adding to the whitelist, and is a no-op when nothing blocks it", () => {
    const deny = state({ enabled: true, denyList: [{ macAddress: PHONE, name: "phone" }] });
    assert.deepEqual(planWifiAccessChange(deny, { kind: "unblock", macAddress: PHONE }, NO_GUARD).write, { status: "2", entries: [] });
    const allow = state({ enabled: true, policy: "allow", allowList: [{ macAddress: LAPTOP, name: "laptop" }] });
    assert.deepEqual(planWifiAccessChange(allow, { kind: "unblock", macAddress: PHONE, name: "phone" }, NO_GUARD).write, {
      status: "1",
      entries: [
        { macAddress: LAPTOP, name: "laptop" },
        { macAddress: PHONE, name: "phone" },
      ],
    });
    assert.equal(planWifiAccessChange(state(), { kind: "unblock", macAddress: PHONE }, NO_GUARD).write, null);
    assert.equal(planWifiAccessChange(deny, { kind: "block", macAddress: PHONE, name: "phone" }, NO_GUARD).write, null, "already blocked");
  });

  it("refuses to block the daemon's host or the requesting device, and a full blacklist", () => {
    planError(() => planWifiAccessChange(state(), { kind: "block", macAddress: NAS.toLowerCase(), name: "nas" }, GUARD), "PROTECTED_DEVICE");
    planError(() => planWifiAccessChange(state(), { kind: "block", macAddress: LAPTOP, name: "laptop" }, GUARD), "PROTECTED_DEVICE");
    const full = state({ denyList: [1, 2, 3, 4].map((i) => ({ macAddress: `00:00:5E:00:53:1${i}`, name: `d${i}` })) });
    planError(() => planWifiAccessChange(full, { kind: "block", macAddress: PHONE, name: "phone" }, NO_GUARD), "LIST_FULL");
    planError(() => planWifiAccessChange(state(), { kind: "block", macAddress: "FF:FF:FF:FF:FF:FF", name: "x" }, NO_GUARD), "INVALID_MAC");
  });
});

describe("access-plan: filter mode and list edits", () => {
  it("turns the filter off without discarding the stored list, and is a no-op when already off", () => {
    const deny = state({ enabled: true, denyList: [{ macAddress: PHONE, name: "phone" }] });
    assert.deepEqual(planWifiAccessChange(deny, { kind: "mode", mode: "off" }, NO_GUARD).write, { status: "0", entries: [{ macAddress: PHONE, name: "phone" }] });
    assert.equal(planWifiAccessChange(state(), { kind: "mode", mode: "off" }, NO_GUARD).write, null);
  });

  it("enables a whitelist only when it keeps every protected Wi-Fi device online, and lists who drops off", () => {
    planError(() => planWifiAccessChange(state(), { kind: "mode", mode: "allow" }, GUARD), "EMPTY_ALLOW_LIST");
    planError(
      () => planWifiAccessChange(state(), { kind: "mode", mode: "allow", entries: [{ macAddress: PHONE, name: "phone" }] }, GUARD),
      "PROTECTED_DEVICE"
    );
    const plan = planWifiAccessChange(state(), { kind: "mode", mode: "allow", entries: [{ macAddress: LAPTOP, name: "laptop" }, { macAddress: PHONE, name: "phone" }] }, GUARD);
    assert.deepEqual(plan.write?.status, "1");
    assert.deepEqual(plan.expected, { enabled: true, policy: "allow" });
    assert.deepEqual(plan.alsoBlocked, [TABLET], "the online tablet is not on the whitelist");
  });

  it("switches to the blacklist with its stored list and refuses protected devices on it", () => {
    const stored = state({ denyList: [{ macAddress: PHONE, name: "phone" }] });
    assert.deepEqual(planWifiAccessChange(stored, { kind: "mode", mode: "deny" }, GUARD).write, { status: "2", entries: [{ macAddress: PHONE, name: "phone" }] });
    planError(() => planWifiAccessChange(stored, { kind: "mode", mode: "deny", entries: [{ macAddress: NAS, name: "nas" }] }, GUARD), "PROTECTED_DEVICE");
  });

  it("edits the active list, deduplicating, and needs the filter on", () => {
    planError(() => planWifiAccessChange(state(), { kind: "entries", add: [{ macAddress: PHONE, name: "phone" }] }, NO_GUARD), "FILTER_OFF");
    const deny = state({ enabled: true, denyList: [{ macAddress: PHONE, name: "phone" }] });
    const plan = planWifiAccessChange(
      deny,
      { kind: "entries", add: [{ macAddress: TABLET.toLowerCase(), name: "tablet" }, { macAddress: PHONE, name: "phone again" }], remove: [] },
      NO_GUARD
    );
    assert.deepEqual(plan.write, {
      status: "2",
      entries: [
        { macAddress: PHONE, name: "phone" },
        { macAddress: TABLET, name: "tablet" },
      ],
    });
    assert.deepEqual(planWifiAccessChange(deny, { kind: "entries", remove: [PHONE.toLowerCase()] }, NO_GUARD).write, { status: "2", entries: [] });
    const allow = state({ enabled: true, policy: "allow", allowList: [{ macAddress: LAPTOP, name: "laptop" }, { macAddress: PHONE, name: "phone" }] });
    planError(() => planWifiAccessChange(allow, { kind: "entries", remove: [LAPTOP] }, GUARD), "PROTECTED_DEVICE");
  });

  it("trims device names to the router's limit and strips control characters", () => {
    const plan = planWifiAccessChange(state(), { kind: "block", macAddress: PHONE, name: `phone\u0000\n${"x".repeat(80)}` }, NO_GUARD);
    const name = plan.write?.entries[0]?.name ?? "";
    assert.equal(name.length, 32);
    assert.match(name, /^phone x+$/);
  });
});

describe("access-plan: internet time rules", () => {
  it("normalizes a rule and rejects the inputs the router UI rejects", () => {
    assert.deepEqual(
      normalizeTimeRuleInput({ macAddress: "00-00-5e-00-53-03", name: " phone ", weekMask: "1111100", startTime: "7:30", endTime: "22:00" }),
      { macAddress: PHONE, name: "phone", weekMask: "1111100", startTime: "07:30", endTime: "22:00", enabled: true }
    );
    const base = { macAddress: PHONE, name: "phone", weekMask: "1111111", startTime: "08:00", endTime: "20:00" };
    planError(() => normalizeTimeRuleInput({ ...base, weekMask: "0000000" }), "NO_DAYS");
    planError(() => normalizeTimeRuleInput({ ...base, weekMask: "11111" }), "INVALID_DAYS");
    planError(() => normalizeTimeRuleInput({ ...base, endTime: "08:00" }), "SAME_TIME");
    planError(() => normalizeTimeRuleInput({ ...base, endTime: "00:00" }), "END_MIDNIGHT");
    planError(() => normalizeTimeRuleInput({ ...base, startTime: "08:10" }), "INVALID_TIME");
    planError(() => normalizeTimeRuleInput({ ...base, startTime: "24:00" }), "INVALID_TIME");
    planError(() => normalizeTimeRuleInput({ ...base, macAddress: "nope" }), "INVALID_MAC");
  });

  it("finds overlapping windows for the same device, including rules that run past midnight", () => {
    const rule = (id: string, mac: string, weekMask: string, startTime: string, endTime: string): TimeRule => ({
      id,
      enabled: true,
      devices: [{ macAddress: mac, name: id }],
      weekMask,
      startTime,
      endTime,
    });
    const rules = [rule("weekday", PHONE, "1111100", "08:00", "12:00"), rule("friday-night", PHONE, "0000100", "22:00", "02:00"), rule("tablet", TABLET, "1111111", "00:15", "23:45")];
    const ids = (input: Parameters<typeof findTimeRuleConflicts>[1], ignoreId?: string): string[] =>
      findTimeRuleConflicts(rules, input, ignoreId).map((r) => r.id);
    const cand = { macAddress: PHONE, name: "phone", enabled: true };
    assert.deepEqual(ids({ ...cand, weekMask: "1000000", startTime: "11:00", endTime: "13:00" }), ["weekday"]);
    assert.deepEqual(ids({ ...cand, weekMask: "1000000", startTime: "12:00", endTime: "13:00" }), [], "touching windows do not overlap");
    assert.deepEqual(ids({ ...cand, weekMask: "0000010", startTime: "01:00", endTime: "03:00" }), ["friday-night"], "Friday 22:00-02:00 reaches into Saturday");
    assert.deepEqual(ids({ ...cand, weekMask: "0000001", startTime: "23:00", endTime: "09:00" }), ["weekday"], "Sunday night runs into Monday morning");
    assert.deepEqual(ids({ ...cand, weekMask: "1111100", startTime: "08:00", endTime: "12:00" }, "weekday"), [], "an edited rule never conflicts with itself");
    assert.deepEqual(ids({ ...cand, macAddress: LAPTOP, weekMask: "1111111", startTime: "09:00", endTime: "10:00" }), [], "other devices never conflict");
  });
});

describe("access-plan: internet time rule changes", () => {
  const existing: TimeRule[] = [
    { id: "3", enabled: true, devices: [{ macAddress: PHONE, name: "phone" }], weekMask: "1111100", startTime: "08:00", endTime: "12:00" },
  ];
  const input = { macAddress: PHONE, name: "phone", weekMask: "0000011", startTime: "09:00", endTime: "21:00" };

  it("plans create, update and delete writes the way the router UI sends them", () => {
    assert.deepEqual(planTimeRuleChange(existing, 16, { kind: "create", rule: input }, GUARD), {
      action: "create",
      id: "",
      enabled: true,
      devices: [{ macAddress: PHONE, name: "phone" }],
      weekMask: "0000011",
      startTime: "09:00",
      endTime: "21:00",
    });
    const update = planTimeRuleChange(existing, 16, { kind: "update", id: "3", rule: { ...input, weekMask: "1111100", startTime: "07:00", enabled: false } }, GUARD);
    assert.equal(update.action, "update");
    assert.equal(update.id, "3");
    assert.equal(update.enabled, false);
    assert.deepEqual(planTimeRuleChange(existing, 16, { kind: "delete", id: "3" }, GUARD), { action: "delete", ...existing[0] });
  });

  it("rejects unknown rules, a full rule table, protected devices and overlapping windows", () => {
    planError(() => planTimeRuleChange(existing, 16, { kind: "delete", id: "9" }, GUARD), "RULE_NOT_FOUND");
    planError(() => planTimeRuleChange(existing, 1, { kind: "create", rule: input }, GUARD), "RULES_FULL");
    planError(() => planTimeRuleChange(existing, 16, { kind: "create", rule: { ...input, macAddress: NAS } }, GUARD), "PROTECTED_DEVICE");
    planError(() => planTimeRuleChange(existing, 16, { kind: "create", rule: { ...input, weekMask: "1000000", startTime: "11:00", endTime: "13:00" } }, GUARD), "TIME_CONFLICT");
    assert.equal(planTimeRuleChange(existing, 1, { kind: "update", id: "3", rule: { ...input, weekMask: "1111100", startTime: "08:00", endTime: "11:00" } }, GUARD).action, "update", "editing a rule is not limited by capacity nor by itself");
  });
});

