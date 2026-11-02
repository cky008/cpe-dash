import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERIFIED_FIRMWARE, firmwareFingerprint, firmwareReviewPrompt, isVerifiedFirmware, verifiedFirmwareLabel } from "../src/firmware.ts";

describe("verified firmware", () => {
  it("matches the verified model and build only, ignoring whitespace", () => {
    assert.deepEqual(VERIFIED_FIRMWARE, [{ model: "H168-383", softwareVersion: "4.4.0.1(H1006SP19C00)" }]);
    assert.equal(isVerifiedFirmware("H168-383", "4.4.0.1(H1006SP19C00)"), true);
    assert.equal(isVerifiedFirmware(" H168-383 ", "4.4.0.1 (H1006SP19C00)"), true);
    assert.equal(isVerifiedFirmware("H168-383", "4.4.0.1(H1006SP20C00)"), false, "a new service pack is a new build");
    assert.equal(isVerifiedFirmware("H168-383", "4.4.0.2(H1006SP19C00)"), false);
    assert.equal(isVerifiedFirmware("H158-381", "4.4.0.1(H1006SP19C00)"), false);
    assert.equal(firmwareFingerprint("H168-383 ", "4.4.0.2 (H1006SP2C00)"), "H168-383 4.4.0.2(H1006SP2C00)");
    assert.equal(verifiedFirmwareLabel(), "H168-383 4.4.0.1(H1006SP19C00)");
  });

  it("writes a review prompt that carries the build and the real-device safety rules", () => {
    const input = { model: "H168-383", softwareVersion: "4.4.0.2(H1006SP2C00)", webUiVersion: " ", detectedAtIso: "2026-11-02T08:00:00.000Z" };
    const zh = firmwareReviewPrompt("zh-CN", input);
    const en = firmwareReviewPrompt("en", input);
    for (const prompt of [zh, en]) {
      assert.ok(prompt.includes("H168-383") && prompt.includes("4.4.0.2(H1006SP2C00)") && prompt.includes("2026-11-02T08:00:00.000Z"));
      assert.ok(prompt.includes("4.4.0.1(H1006SP19C00)"), "names what was verified");
      assert.ok(prompt.includes("WebUI ?"), "an empty WebUI version reads as unknown");
      for (const needle of ["AGENTS.md", "docs/PHASE1_PROTOCOL_SPEC.md", ".env", "108006", "npm run demo", "probe:session", "src/firmware.ts", "VERIFIED_FIRMWARE"]) {
        assert.ok(prompt.includes(needle), needle);
      }
      assert.ok(prompt.length < 3000, "fits one Telegram message with room to spare");
    }
    assert.match(zh, /只做只读检查/);
    assert.match(zh, /登录失败绝不重试/);
    assert.match(en, /Read only/);
    assert.match(en, /Never retry a failed login/);
  });
});
