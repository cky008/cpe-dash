import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVICE_FEATURES } from "../src/device-profile.ts";
import { DeviceAccess } from "../src/device-access.ts";
import { MODULES, deviceSupportRow, supportMark, supportedDevicesSection } from "../src/device-catalog.ts";
import type { SchedulerStatusSnapshot } from "../src/scheduler.ts";
import { experimentalOffer, unconfirmedWrite } from "../web/src/core/device-access-view.ts";
import { WRITE_STATE_KEYS } from "../web/src/core/device-view.ts";
import { SETTINGS_TEXT } from "../web/src/i18n/settings.ts";
import { VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isVerifiedFeature, isVerifiedModel } from "../src/firmware.ts";
import { ROUTER_FAMILY_FACTS, isRouterFamily } from "../src/router-family.ts";

/**
 * Multi-model phase 3: a feature of another model that a user checked on a real router joins the
 * verified list, per model and feature, reads and writes apart, naming the issue that reported it
 * (never the person). The Supported devices table marks it verified. Placeholders only.
 */

const SAMPLE: ReadonlyArray<VerifiedFeature> = [
  { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "telemetry", access: "read", issue: 12 },
  { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "bandLock", access: "write", issue: 12 },
  { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "smsWrite", access: "write", issue: 15 },
  { family: "huawei", model: "E5576-320", softwareVersion: "21.180.99.00.00", feature: "reboot", access: "write", issue: 21 },
];

describe("verified features of other models", () => {
  it("holds well-formed entries only: a brand, another model, a known feature, read or write, an issue number", () => {
    const features: ReadonlySet<string> = new Set(DEVICE_FEATURES);
    for (const entry of VERIFIED_FEATURES) {
      assert.ok(isRouterFamily(entry.family), entry.family);
      assert.match(entry.model, /^[A-Za-z0-9 ._()+-]{1,64}$/);
      assert.match(entry.softwareVersion, /^[A-Za-z0-9 ._()+-]{1,64}$/);
      assert.ok(!isVerifiedModel(entry.model), `${entry.model}: a verified model needs no per-feature entry`);
      assert.ok(features.has(entry.feature), entry.feature);
      assert.ok(entry.access === "read" || entry.access === "write");
      // A verified write runs what FengSui implements for the brand: one without it would be listed but stay locked
      const writes: ReadonlyArray<string> = ROUTER_FAMILY_FACTS[entry.family].writes;
      assert.ok(entry.access === "read" || writes.includes(entry.feature), `${entry.model} ${entry.feature}: nothing implemented on ${entry.family} to verify`);
      assert.ok(Number.isSafeInteger(entry.issue) && entry.issue > 0);
    }
    const keys = VERIFIED_FEATURES.map((e) => `${e.family}|${e.model}|${e.feature}|${e.access}`);
    assert.equal(new Set(keys).size, keys.length, "one entry per brand, model, feature and access");
  });

  it("answers per brand, model, feature and access", () => {
    assert.equal(isVerifiedFeature("huawei", "B535-232", "bandLock", "write", SAMPLE), true);
    assert.equal(isVerifiedFeature("huawei", " B535-232 ", "bandLock", "write", SAMPLE), true, "surrounding spaces aside");
    assert.equal(isVerifiedFeature("huawei", "B535-232", "bandLock", "read", SAMPLE), false, "a verified write says nothing about reads");
    assert.equal(isVerifiedFeature("huawei", "B535-232", "reboot", "write", SAMPLE), false);
    assert.equal(isVerifiedFeature("huawei", "B535-233", "bandLock", "write", SAMPLE), false, "the exact model");
    assert.equal(isVerifiedFeature("zte-goform", "B535-232", "bandLock", "write", SAMPLE), false, "the same name on another brand is another router");
    assert.equal(isVerifiedFeature("huawei", "B535-232", "bandLock", "write"), VERIFIED_FEATURES.some((e) => e.model === "B535-232" && e.feature === "bandLock" && e.access === "write"));
  });

  it("carries one registered report from the entry to the table, the gate and the console, on a router of another brand", () => {
    // One entry, written as CONTRIBUTING.md says from a device report: brand, the model as the router reports it, build, feature, access, issue
    const report: VerifiedFeature = { family: "zte-zwrt", model: "MU5250", softwareVersion: "BD_ZTE_MU5250V1.0.0B05", feature: "cellLock", access: "write", issue: 41 };
    const list = [report];
    // The table: that cell of that model's row turns into ✓, and nothing else changes
    const table = (verified: ReadonlyArray<VerifiedFeature>): string[] | undefined =>
      supportedDevicesSection("en", verified)
        .split("\n")
        .find((line) => line.startsWith("| U60 Pro (MU5250) |"))
        ?.slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
    const cellColumn = 3 + MODULES.findIndex((module) => module.features.includes("cellLock"));
    assert.deepEqual([table([])?.[cellColumn], table(list)?.[cellColumn]], ["△", "✓"]);
    assert.deepEqual(table(list)?.filter((_, i) => i !== cellColumn), table([])?.filter((_, i) => i !== cellColumn));
    assert.equal(supportMark("zte-zwrt", "U60 Pro (MU5250)", "cellLock", list), "✓");
    assert.equal(supportMark("zte-zwrt", "U60 Pro (MU5250)", "bandLock", list), "?", "only the feature reported");
    // The router: the gate counts it as verified, so Settings → Device and the controls say so
    const access = new DeviceAccess({ family: "zte-zwrt", verifiedFeatures: list });
    access.see("MU5250", report.softwareVersion);
    const device = access.snapshot();
    assert.equal(device.features.cellLock, "verified");
    const scheduler = { device } as unknown as SchedulerStatusSnapshot;
    const offered = experimentalOffer(scheduler).find((entry) => entry.feature === "cellLock");
    assert.deepEqual([offered?.state, SETTINGS_TEXT["zh-CN"][WRITE_STATE_KEYS.verified], SETTINGS_TEXT.en[WRITE_STATE_KEYS.verified]], ["verified", "已验证", "verified"]);
    assert.equal(unconfirmedWrite(scheduler, ["cellLock"]), false, "its confirmation no longer says it was never checked");
    assert.equal(unconfirmedWrite(scheduler, ["bandLock"]), true);
    // And the row the console shows for this router
    assert.equal(deviceSupportRow("zte-zwrt", "MU5250", list).modules.find((m) => m.en === "Cell lock")?.mark, "✓");
    // Nothing of this stays in the real list
    assert.equal(supportedDevicesSection("en"), supportedDevicesSection("en", VERIFIED_FEATURES));
    assert.equal(VERIFIED_FEATURES.some((entry) => entry.issue === 41), false);
    assert.ok(VERIFIED_FIRMWARE.length > 0);
  });
});
