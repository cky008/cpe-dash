import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrivacyState, displayValue, maskCodeInText, maskValue } from "../web/src/core/privacy.ts";

describe("web core: privacy mode", () => {
  it("masks each identifier kind like the daemon's REDACT switch", () => {
    assert.equal(maskValue("imei", "860000000000000"), "860000*********");
    assert.equal(maskValue("imsi", "272010000000000"), "27201**********");
    assert.equal(maskValue("phone", "+353830000001"), "+353*******01");
    assert.equal(maskValue("mac", "02:00:5E:10:00:01"), "02:00:5E:**:**:**");
    assert.equal(maskValue("ip", "198.51.100.42"), "198.51.*.*");
    assert.equal(maskValue("cell", "10001"), "*****");
    assert.equal(maskValue("cell", "1"), "****");
    assert.equal(maskValue("otp", "482913"), "••••••");
    assert.equal(maskValue("otp", " "), "");
    assert.equal(displayValue("ip", "198.51.100.42", false), "198.51.100.42");
    assert.equal(maskCodeInText("Code 482913, again 482913", "482913"), "Code ••••••, again ••••••");
    assert.equal(maskCodeInText("Code 12", "12"), "Code 12");
    assert.equal(maskCodeInText("plain", null), "plain");
  });

  it("lets a card override the global mode until the global mode changes", () => {
    const p = new PrivacyState();
    let changes = 0;
    const off = p.onChange(() => (changes += 1));
    assert.equal(p.isMasked("identity"), true);
    p.toggleScope("identity");
    assert.equal(p.isMasked("identity"), false);
    assert.equal(p.isMasked("network"), true);
    p.setGlobal(false);
    assert.equal(p.globalMasked, false);
    assert.equal(p.isMasked("identity"), false);
    p.toggleScope("network");
    assert.equal(p.isMasked("network"), true);
    p.setGlobal(true);
    assert.equal(p.isMasked("network"), true);
    assert.equal(p.isMasked("identity"), true);
    off();
    p.setGlobal(false);
    assert.equal(changes, 4);
  });
});
