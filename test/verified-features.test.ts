import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVICE_FEATURES, EXPERIMENTAL_FEATURES } from "../src/device-profile.ts";
import { VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, compatibilityTable, isVerifiedFeature, isVerifiedModel } from "../src/firmware.ts";

/**
 * Multi-model phase 3: a feature of another model that a user checked on a real router joins the
 * verified list, per model and feature, reads and writes apart, naming the issue that reported it
 * (never the person). The guide's compatibility table is written from it. Placeholders only.
 */

const SAMPLE: ReadonlyArray<VerifiedFeature> = [
  { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "telemetry", access: "read", issue: 12 },
  { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "bandLock", access: "write", issue: 12 },
  { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "smsWrite", access: "write", issue: 15 },
  { model: "E5576-320", softwareVersion: "21.180.99.00.00", feature: "reboot", access: "write", issue: 21 },
];

describe("verified features of other models", () => {
  it("holds well-formed entries only: another model, a known feature, read or write, an issue number", () => {
    const features: ReadonlySet<string> = new Set(DEVICE_FEATURES);
    const generic: ReadonlySet<string> = new Set(EXPERIMENTAL_FEATURES);
    for (const entry of VERIFIED_FEATURES) {
      assert.match(entry.model, /^[A-Za-z0-9 ._()+-]{1,64}$/);
      assert.match(entry.softwareVersion, /^[A-Za-z0-9 ._()+-]{1,64}$/);
      assert.ok(!isVerifiedModel(entry.model), `${entry.model}: a verified model needs no per-feature entry`);
      assert.ok(features.has(entry.feature), entry.feature);
      assert.ok(entry.access === "read" || entry.access === "write");
      // A verified write runs the generic implementation: one without it would be listed but stay locked
      assert.ok(entry.access === "read" || generic.has(entry.feature), `${entry.model} ${entry.feature}: no generic implementation to verify`);
      assert.ok(Number.isSafeInteger(entry.issue) && entry.issue > 0);
    }
    const keys = VERIFIED_FEATURES.map((e) => `${e.model}|${e.feature}|${e.access}`);
    assert.equal(new Set(keys).size, keys.length, "one entry per model, feature and access");
  });

  it("answers per model, feature and access", () => {
    assert.equal(isVerifiedFeature("B535-232", "bandLock", "write", SAMPLE), true);
    assert.equal(isVerifiedFeature(" B535-232 ", "bandLock", "write", SAMPLE), true, "surrounding spaces aside");
    assert.equal(isVerifiedFeature("B535-232", "bandLock", "read", SAMPLE), false, "a verified write says nothing about reads");
    assert.equal(isVerifiedFeature("B535-232", "reboot", "write", SAMPLE), false);
    assert.equal(isVerifiedFeature("B535-233", "bandLock", "write", SAMPLE), false, "the exact model");
    assert.equal(isVerifiedFeature("B535-232", "bandLock", "write"), VERIFIED_FEATURES.some((e) => e.model === "B535-232" && e.feature === "bandLock" && e.access === "write"));
  });

  it("writes one table row per model and build, naming the features and their issues", () => {
    const zh = compatibilityTable("zh-CN", SAMPLE).split("\n");
    const en = compatibilityTable("en", SAMPLE).split("\n");
    assert.deepEqual(zh.slice(0, 4), compatibilityTable("zh-CN", []).split("\n").slice(0, 4), "the H168-383 rows stay first");
    assert.equal(zh.length, compatibilityTable("zh-CN", []).split("\n").length + 2);
    assert.equal(en.length, zh.length);
    assert.equal(zh.at(-3), "| B535-232 | `11.0.1.2(H7SP2C00)` | ✅ 已验证：遥测（#12）；其他项目可能可用，未验证 | ✅ 已验证：锁 LTE 频段（#12）、写短信（#15）；其他写操作默认锁定 |");
    assert.equal(en.at(-3), "| B535-232 | `11.0.1.2(H7SP2C00)` | ✅ verified: telemetry (#12); other parts may work, not verified | ✅ verified: LTE band lock (#12), SMS writes (#15); other writes locked by default |");
    assert.equal(zh.at(-2), "| E5576-320 | `21.180.99.00.00` | ⚠️ 可能可用，未验证 | ✅ 已验证：重启（#21）；其他写操作默认锁定 |");
    assert.equal(en.at(-2), "| E5576-320 | `21.180.99.00.00` | ⚠️ may work, not verified | ✅ verified: reboot (#21); other writes locked by default |");
    assert.equal(zh.at(-1), compatibilityTable("zh-CN", []).split("\n").at(-1), "every other model last");
    assert.equal(compatibilityTable("en"), compatibilityTable("en", VERIFIED_FEATURES));
    assert.ok(VERIFIED_FIRMWARE.length > 0);
  });
});
