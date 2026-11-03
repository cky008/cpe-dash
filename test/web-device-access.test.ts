import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceAccessSnapshot, SchedulerStatusSnapshot } from "../src/api-contract.ts";
import { READ_SECTIONS } from "../src/device-access.ts";
import { readOnlyModel, unavailableSection, versionLabel, writesLocked } from "../web/src/core/device-access-view.ts";
import { READ_STATE_KEYS, SECTION_KEYS, WRITES_KEYS, readText } from "../web/src/core/device-view.ts";
import { SETTINGS_TEXT } from "../web/src/i18n/settings.ts";

/** What the console offers for the router it watches (multi-model phase 2), decided without the DOM. */

function status(device: Partial<DeviceAccessSnapshot>): SchedulerStatusSnapshot {
  const reads = Object.fromEntries(READ_SECTIONS.map((section) => [section, { state: "verified", code: null }])) as DeviceAccessSnapshot["reads"];
  return { device: { model: "H168-383", verification: "verified", confirmed: true, writes: "allowed", reads, ...device } } as unknown as SchedulerStatusSnapshot;
}

describe("console: the router's write and read access", () => {
  it("offers writes only for a verified model, and names a read-only one", () => {
    assert.deepEqual([writesLocked(null), readOnlyModel(null)], [false, null], "nothing known: the daemon decides");
    assert.deepEqual([writesLocked(status({})), readOnlyModel(status({}))], [false, null]);
    const other = status({ model: "B535-232", verification: "unverified-model", writes: "read_only" });
    assert.deepEqual([writesLocked(other), readOnlyModel(other)], [true, "B535-232"]);
    assert.equal(readOnlyModel(status({ model: null, writes: "read_only" })), "?");
    assert.equal(writesLocked(status({ model: null, writes: "unknown" })), false);
  });

  it("says which sections the model does not provide", () => {
    const reads = { ...status({}).device.reads, neighbors: { state: "unavailable", code: "100002" }, sms: { state: "unavailable", code: null }, topology: { state: "unknown", code: null } } as DeviceAccessSnapshot["reads"];
    const other = status({ model: "B535-232", writes: "read_only", reads });
    assert.deepEqual(unavailableSection(other, "neighbors"), { code: "100002" });
    assert.deepEqual(unavailableSection(other, "sms"), { code: null });
    assert.equal(unavailableSection(other, "topology"), null, "not read yet is not missing");
    assert.equal(unavailableSection(other, "telemetry"), null);
    assert.equal(unavailableSection(null, "neighbors"), null);
  });

  it("labels the version with the model the daemon goes by", () => {
    assert.equal(versionLabel("1.6.0", status({})), "v1.6.0 · H168-383");
    assert.equal(versionLabel("1.6.0", status({ model: "B535-232" })), "v1.6.0 · B535-232");
    assert.equal(versionLabel("1.6.0", status({ model: null })), "v1.6.0");
    assert.equal(versionLabel("1.6.0", null), "v1.6.0");
  });

  it("names every section, state and write verdict in both languages", () => {
    assert.deepEqual(Object.keys(SECTION_KEYS), [...READ_SECTIONS]);
    for (const locale of ["zh-CN", "en"] as const) {
      const text = SETTINGS_TEXT[locale];
      for (const key of [...Object.values(SECTION_KEYS), ...Object.values(READ_STATE_KEYS), ...Object.values(WRITES_KEYS), "access_title", "access_note"] as const) {
        assert.ok(text[key].trim(), `${locale}: ${key}`);
      }
    }
    const t = (key: keyof (typeof SETTINGS_TEXT)["en"]): string => SETTINGS_TEXT.en[key];
    assert.equal(readText({ state: "unavailable", code: "100002" }, t), "not on this model · 100002");
    assert.equal(readText({ state: "available", code: null }, t), "readable");
  });
});
