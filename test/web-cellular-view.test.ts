import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CellularSettingsSnapshot } from "../src/cellular.ts";
import { emptyRouterStatus } from "../src/router-status.ts";
import { MODE_KEYS, alertPercent, apnForm, apnTakesCredentials, apnUsesProfile, cellularOpen, isPin, isUssdCode, limitBytes, limitFields, modeChoices, operatorLine, pinOffer, slotChoices } from "../web/src/core/cellular-view.ts";
import { CELLULAR_TEXT } from "../web/src/i18n/cellular.ts";

/**
 * What the control drawer shows of the cellular settings: which settings a router has, what a PIN
 * dialog may offer, and the checks on what was typed. Placeholder values only.
 */

const snapshot = (over: Partial<CellularSettingsSnapshot> = {}): CellularSettingsSnapshot => ({ capturedAtIso: "2026-11-12T00:00:00.000Z", capturedAtMs: 0, networkMode: null, simSlots: null, operator: null, apn: null, dataLimit: null, dataRoaming: null, ...over });
const withSim = (sim: Partial<NonNullable<ReturnType<typeof emptyRouterStatus>["sim"]>>) => ({ ...emptyRouterStatus(), sim: { state: "ready" as const, pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null, ...sim } });

describe("console: the cellular settings a router has", () => {
  it("shows the settings that are open, in one order", () => {
    assert.deepEqual(cellularOpen(["ussd", "reboot", "apn", "bandLock", "networkMode"]), ["networkMode", "apn", "ussd"]);
    assert.deepEqual(cellularOpen(["reboot", "mobileData"]), []);
  });

  it("offers the router's own modes, and names every mode in both languages", () => {
    assert.deepEqual(modeChoices(null), { current: null, options: [] });
    assert.deepEqual(modeChoices(snapshot({ networkMode: { current: "lte", options: ["auto", "lte"] } })), { current: "lte", options: ["auto", "lte"] });
    for (const key of Object.values(MODE_KEYS)) for (const locale of ["zh-CN", "en"] as const) assert.ok(CELLULAR_TEXT[locale][key].length > 0, key);
    assert.deepEqual(Object.keys(CELLULAR_TEXT.en).sort(), Object.keys(CELLULAR_TEXT["zh-CN"]).sort());
  });

  it("marks the slot the router's status says is in use", () => {
    const slots = [
      { kind: "physical", index: 1 },
      { kind: "embedded", index: 1 },
    ] as const;
    assert.deepEqual(slotChoices(snapshot({ simSlots: [...slots] }), withSim({ slot: { kind: "embedded", index: 1 } })), [
      { slot: slots[0], current: false },
      { slot: slots[1], current: true },
    ]);
    assert.deepEqual(slotChoices(snapshot(), null), []);
    assert.deepEqual(
      slotChoices(snapshot({ simSlots: [...slots] }), null).map((row) => row.current),
      [false, false]
    );
  });
});

describe("console: what a PIN dialog may offer", () => {
  it("offers a PIN only with more than one attempt reported, and never a PUK", () => {
    assert.deepEqual(pinOffer(withSim({ state: "pin_required", pinAttemptsLeft: 3 })), { kind: "enter", attemptsLeft: 3, lockEnabled: null });
    assert.deepEqual(pinOffer(withSim({ pinAttemptsLeft: 2, pinLockEnabled: true })), { kind: "lock", attemptsLeft: 2, lockEnabled: true });
    assert.deepEqual(pinOffer(withSim({ state: "pin_required", pinAttemptsLeft: 1 })), { kind: "none", reason: "last_attempt" });
    assert.deepEqual(pinOffer(withSim({ state: "pin_required", pinAttemptsLeft: 0 })), { kind: "none", reason: "none_left" });
    assert.deepEqual(pinOffer(withSim({ state: "pin_required" })), { kind: "none", reason: "unknown" });
    assert.deepEqual(pinOffer(withSim({ state: "puk_required", pinAttemptsLeft: 3 })), { kind: "none", reason: "puk" });
    assert.deepEqual(pinOffer(withSim({ state: "absent", pinAttemptsLeft: 3 })), { kind: "none", reason: "no_card" });
    assert.deepEqual(pinOffer(null), { kind: "none", reason: "no_card" });
    for (const reason of ["unknown", "last_attempt", "none_left", "puk", "no_card"] as const) assert.ok(CELLULAR_TEXT.en[`pin_none_${reason}`]);
    assert.deepEqual([isPin("0000"), isPin("12345678"), isPin("123"), isPin("123456789"), isPin("12a4")], [true, true, false, false, false]);
  });
});

describe("console: checking what was typed", () => {
  it("turns a typed limit into whole megabytes within what the router keeps", () => {
    assert.equal(limitBytes("20", "GB"), 20 * 1024 ** 3);
    assert.equal(limitBytes("1.5", "GB"), 1536 * 1024 ** 2);
    assert.equal(limitBytes("500", "MB"), 500 * 1024 ** 2);
    assert.deepEqual([limitBytes("0", "MB"), limitBytes("", "GB"), limitBytes("abc", "GB"), limitBytes("9999999", "GB"), limitBytes("1.234", "GB")], [null, null, null, null, null]);
    assert.deepEqual(limitFields(20 * 1024 ** 3), { amount: "20", unit: "GB" });
    assert.deepEqual(limitFields(500 * 1024 ** 2), { amount: "500", unit: "MB" });
    assert.deepEqual([limitFields(null), limitFields(0)], [{ amount: "", unit: "GB" }, { amount: "", unit: "GB" }]);
    assert.deepEqual([alertPercent("80"), alertPercent(" "), alertPercent("0"), alertPercent("101"), alertPercent("8x")], [80, null, undefined, undefined, undefined]);
  });

  it("checks an access point before it is sent, by the daemon's own rules", () => {
    const ok = { apn: "example.apn", auth: "none", username: "", password: "" } as const;
    assert.equal(apnForm(ok), "ok");
    assert.equal(apnForm({ ...ok, apn: "bad apn" }), "apn");
    assert.equal(apnForm({ ...ok, apn: "" }), "apn");
    assert.equal(apnForm({ ...ok, username: "demo-user" }), "credentials", "a user name needs an authentication mode");
    assert.equal(apnForm({ ...ok, auth: "pap", username: "demo-user", password: "demo-pass" }), "ok");
    assert.equal(apnForm({ ...ok, auth: "chap", username: "demo user" }), "credentials");
    assert.deepEqual([apnUsesProfile("zte-goform"), apnUsesProfile("zte-zwrt"), apnUsesProfile("openwrt"), apnUsesProfile(null)], [true, true, false, false]);
    assert.deepEqual([apnTakesCredentials("openwrt"), apnTakesCredentials("zte-goform"), apnTakesCredentials(null)], [false, true, true]);
  });

  it("takes a USSD code of digits, stars and hashes, and describes a scan row", () => {
    assert.deepEqual([isUssdCode("*100#"), isUssdCode("1"), isUssdCode(""), isUssdCode("*100# "), isUssdCode("call me")], [true, true, false, false, false]);
    assert.deepEqual(operatorLine({ plmn: "27202", name: "Three", rat: "4G", state: "available" }), { name: "Three", detail: "27202 · 4G", selectable: true });
    assert.deepEqual(operatorLine({ plmn: "27203", name: null, rat: null, state: "forbidden" }), { name: "27203", detail: "", selectable: false });
  });
});
