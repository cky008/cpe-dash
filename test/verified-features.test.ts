import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { DEVICE_FEATURES, type DeviceProfile } from "../src/device-profile.ts";
import { DeviceAccess } from "../src/device-access.ts";
import { MODULES, deviceSupportRow, supportMark, supportedDevicesSection } from "../src/device-catalog.ts";
import type { SchedulerStatusSnapshot } from "../src/scheduler.ts";
import { experimentalOffer, experimentalWrites, reportVerified, unconfirmedWrite } from "../web/src/core/device-access-view.ts";
import { WRITE_STATE_KEYS, verificationNotice, writesText } from "../web/src/core/device-view.ts";
import { SETTINGS_TEXT } from "../web/src/i18n/settings.ts";
import { VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isReportVerifiedModel, isVerifiedFeature, isVerifiedModel, reportVerifiedModels } from "../src/firmware.ts";
import { ROUTER_FAMILY_FACTS, familyFeatures, isRouterFamily, isStatusReadFeature } from "../src/router-family.ts";

/**
 * Multi-model phase 3: a feature of another model that a user checked on a real router joins the
 * verified list, per model and feature, reads and writes apart, naming the issue that reported it
 * (never the person). The Supported devices table marks it verified. Placeholders only.
 */

/** The pages that say which routers FengSui is verified on: a model reports verify is named in each (CONTRIBUTING.md). */
const VERIFIED_CLAIMS = [
  "README.md",
  "README_EN.md",
  "docs/guide/zh/overview.md",
  "docs/guide/en/overview.md",
  "docs/guide/zh/other-routers.md",
  "docs/guide/en/other-routers.md",
  "docs/guide/zh/supported-devices.md",
  "docs/guide/en/supported-devices.md",
  "scripts/site-home.ts",
  ".github/ISSUE_TEMPLATE/device-report.yml",
];

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
    assert.equal(deviceSupportRow("zte-zwrt", "MU5250", { verified: list }).modules.find((m) => m.en === "Cell lock")?.mark, "✓");
    // Nothing of this stays in the real list
    assert.equal(supportedDevicesSection("en"), supportedDevicesSection("en", VERIFIED_FEATURES));
    assert.equal(VERIFIED_FEATURES.some((entry) => entry.issue === 41), false);
    assert.ok(VERIFIED_FIRMWARE.length > 0);
  });

  it("counts a model as verified once reports settle every feature FengSui does on it, with nothing more to check", () => {
    const base = { family: "zte-zwrt", model: "MU5250", softwareVersion: "BD_ZTE_MU5250V1.0.0B05", issue: 41 } as const;
    // What FengSui implements on zWRT today: the signal, SMS, battery, SIM card, band and cell locks, reboot, redial, mobile
    // data, and of the cellular settings the network mode, the operator, the SIM slot, the PIN, data roaming, the
    // access point and the data limit
    assert.deepEqual(familyFeatures("zte-zwrt"), [
      { feature: "telemetry", access: "read" },
      { feature: "smsRead", access: "read" },
      { feature: "battery", access: "read" },
      { feature: "simCard", access: "read" },
      { feature: "bandLock", access: "write" },
      { feature: "cellLock", access: "write" },
      { feature: "reboot", access: "write" },
      { feature: "reconnect", access: "write" },
      { feature: "mobileData", access: "write" },
      { feature: "smsWrite", access: "write" },
      { feature: "networkMode", access: "write" },
      { feature: "operatorSelect", access: "write" },
      { feature: "simSlot", access: "write" },
      { feature: "simPin", access: "write" },
      { feature: "roaming", access: "write" },
      { feature: "apn", access: "write" },
      { feature: "dataLimit", access: "write" },
    ]);
    // The status reads (battery, SIM card) are confirmed one by one: a model is verified without them
    const all: VerifiedFeature[] = familyFeatures("zte-zwrt")
      .filter(({ feature }) => !isStatusReadFeature(feature))
      .map(({ feature, access }) => ({ ...base, feature, access }));
    const butReboot = all.filter((entry) => entry.feature !== "reboot");
    assert.equal(isReportVerifiedModel("zte-zwrt", "MU5250", all), true);
    assert.equal(isReportVerifiedModel("zte-zwrt", "MU5250", butReboot), false, "one feature short");
    assert.equal(isReportVerifiedModel("zte-goform", "MU5250", all), false, "on its brand only");
    assert.equal(isReportVerifiedModel("zte-zwrt", "MU5250", []), false);
    // A feature the router turned out not to have settles it too, but one confirmed feature is needed
    assert.equal(isReportVerifiedModel("zte-zwrt", "MU5250", butReboot, [{ family: "zte-zwrt", model: "MU5250", feature: "reboot", issue: 42 }]), true);
    assert.equal(isReportVerifiedModel("zte-zwrt", "MU5250", [], familyFeatures("zte-zwrt").map(({ feature }) => ({ family: "zte-zwrt" as const, model: "MU5250", feature, issue: 42 }))), false);
    assert.equal(isReportVerifiedModel("huawei", "H168-383", []), false, "the verified model is verified another way");
    assert.deepEqual(reportVerifiedModels(all), [{ family: "zte-zwrt", model: "MU5250" }]);
    assert.deepEqual(reportVerifiedModels(), [], "none in the real list yet");

    // The gate and the console call it verified, and it is still written the way its brand is
    const access = new DeviceAccess({ family: "zte-zwrt", verifiedFeatures: all });
    access.see("MU5250", base.softwareVersion);
    const device = access.snapshot();
    assert.deepEqual([device.verification, access.reportVerified, device.writes, access.generic], ["report-verified", true, "experimental", true]);
    assert.deepEqual([device.features.cellLock, device.features.accessControl], ["verified", "not_implemented"], "what it does not implement stays refused");
    const scheduler = { device } as unknown as SchedulerStatusSnapshot;
    assert.equal(reportVerified(scheduler), true);
    assert.equal(writesText(device.writes, experimentalWrites(scheduler).length, (key, params) => SETTINGS_TEXT.en[key].replace("{count}", String(params?.["count"])), true), "Writes: 13 available (each confirmed on a real router)");
    const profile = { identity: { model: "MU5250", softwareVersion: base.softwareVersion }, verification: device.verification } as unknown as DeviceProfile;
    assert.deepEqual(verificationNotice(profile, VERIFIED_FIRMWARE).key, "verification_report_verified");
    assert.equal(verificationNotice(profile, VERIFIED_FIRMWARE).tone, "success");
    // The table names it with the verified models and leaves its row nothing to report
    const en = supportedDevicesSection("en", all);
    assert.match(en, /Reports confirmed every feature FengSui does on the U60 Pro \(MU5250\), which therefore count as verified too\./);
    assert.match(supportedDevicesSection("zh-CN", all), /U60 Pro \(MU5250\) 上烽燧做的每项功能都有真机报告确认过，也算验证过的型号。/);
    assert.ok(en.split("\n").find((line) => line.startsWith("| U60 Pro (MU5250) |"))?.endsWith("|  |"), "no report link");
    // Every page that says which routers FengSui is verified on names it (none to name yet)
    for (const file of VERIFIED_CLAIMS) assert.ok(fs.readFileSync(file, "utf8").includes("H168-383"), `${file}: says which routers FengSui is verified on`);
    for (const { model } of reportVerifiedModels()) for (const file of VERIFIED_CLAIMS) assert.ok(fs.readFileSync(file, "utf8").includes(model), `${file}: name ${model} with the verified models`);
  });
});
