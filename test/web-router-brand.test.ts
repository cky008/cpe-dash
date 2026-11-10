import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROUTER_FAMILIES, ROUTER_FAMILY_FACTS } from "../src/router-family.ts";
import type { ConnectionTestResult } from "../src/scheduler.ts";
import { connectionNotice } from "../web/src/core/console-view.ts";
import { interpolate } from "../web/src/core/i18n.ts";
import { asksUsername, brandLabel, brandNote, brandOf, brandOptions, connectionBody, draftOf, showsStored, switchBrand, usualAddress } from "../web/src/core/router-brand.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../web/src/i18n/settings.ts";

const tZh = (key: SettingsTextKey): string => SETTINGS_TEXT["zh-CN"][key];
const failure = (reason: Extract<ConnectionTestResult, { ok: false }>["reason"], extra: Partial<Extract<ConnectionTestResult, { ok: false }>> = {}): ConnectionTestResult => ({ ok: false, reason, code: null, remainCount: null, waitTimeSec: null, message: reason, ...extra });

describe("web core: the router's brand in Settings", () => {
  it("offers detection first, then every brand the daemon knows, in both languages", () => {
    const zh = brandOptions("zh-CN", "自动识别（推荐）");
    assert.deepEqual(zh.map((o) => o.value), ["auto", ...ROUTER_FAMILIES]);
    assert.equal(zh[0]?.label, "自动识别（推荐）");
    const en = brandOptions("en", "Detect automatically");
    assert.equal(en.find((o) => o.value === "zte-goform")?.label, brandLabel("zte-goform", "en"));
    for (const option of [...zh, ...en]) assert.ok(option.label.length > 1, option.value);
    assert.equal(brandOf("auto"), "auto");
    assert.equal(brandOf("openwrt"), "openwrt");
    assert.equal(brandOf("not a brand"), "huawei", "a value the field cannot hold falls back to the verified brand");
  });

  it("starts a first connection on detection, and a stored one on its brand", () => {
    assert.deepEqual(draftOf(null), { brand: "auto", url: "http://192.168.8.1", username: "", password: "", lastAttempt: false });
    // A connection stored before brands existed names none: it is the HiLink one
    assert.deepEqual(draftOf({ url: "http://192.168.8.1", username: "admin", passwordSet: true }), { brand: "huawei", url: "http://192.168.8.1", username: "admin", password: "", lastAttempt: false });
    assert.equal(draftOf({ url: "http://192.168.66.1", username: "root", passwordSet: true, family: "nradio" }).brand, "nradio");
  });

  it("moves the address and the user to the new brand's usual ones, and keeps what was typed", () => {
    const first = draftOf(null);
    const nradio = switchBrand(first, "nradio");
    assert.deepEqual([nradio.brand, nradio.url, nradio.username], ["nradio", "http://192.168.66.1", "root"]);
    const zte = switchBrand(nradio, "zte-goform");
    assert.deepEqual([zte.url, zte.username], ["http://192.168.0.1", ""], "ZTE's page asks for no user");
    const back = switchBrand(zte, "auto");
    assert.deepEqual([back.url, back.username], ["http://192.168.8.1", ""]);
    // Typed values are the owner's: another brand does not overwrite them
    const typed = switchBrand({ brand: "huawei", url: "http://192.168.50.1", username: "operator", password: "typed-password", lastAttempt: true }, "openwrt");
    assert.deepEqual(typed, { brand: "openwrt", url: "http://192.168.50.1", username: "operator", password: "typed-password", lastAttempt: false });
    for (const family of ROUTER_FAMILIES) assert.equal(usualAddress(family), `http://${ROUTER_FAMILY_FACTS[family].defaultAddress}`);
  });

  it("sends the brand with every test, a user only when there is one to send", () => {
    assert.deepEqual(connectionBody({ brand: "auto", url: " 192.168.8.1 ", username: " ", password: "pw", lastAttempt: false }), { url: "192.168.8.1", family: "auto", password: "pw" });
    assert.deepEqual(connectionBody({ brand: "huawei", url: "http://192.168.8.1", username: "admin", password: "", lastAttempt: true }), { url: "http://192.168.8.1", family: "huawei", username: "admin", lastAttempt: true });
    // A brand that signs in with a password only sends an empty user, whatever an earlier brand left in the form
    assert.deepEqual(connectionBody({ brand: "zte-zwrt", url: "http://192.168.0.1", username: "admin", password: "pw", lastAttempt: false }), { url: "http://192.168.0.1", family: "zte-zwrt", username: "", password: "pw" });
    assert.equal(asksUsername("zte-goform"), false);
    assert.equal(asksUsername("auto"), true, "the brand is not known yet: its page may ask for one");
    assert.equal(asksUsername("openwrt"), true);
  });

  it("knows when the form still shows the stored connection", () => {
    const stored = { url: "http://192.168.1.1", username: "root", passwordSet: true, family: "openwrt" } as const;
    assert.equal(showsStored(draftOf(stored), stored), true);
    assert.equal(showsStored({ ...draftOf(stored), brand: "huawei" }, stored), false, "another brand is another connection");
    assert.equal(showsStored({ ...draftOf(stored), password: "x" }, stored), false);
    assert.equal(showsStored(draftOf(null), null), false);
  });

  it("says how detection works, and what a brand nobody verified reads", () => {
    assert.deepEqual(brandNote("auto"), { key: "brand_auto_hint" });
    assert.equal(brandNote("huawei"), null);
    assert.deepEqual(brandNote("openwrt"), { key: "brand_note", reads: "brand_reads_cells" });
    assert.deepEqual(brandNote("pinsu"), { key: "brand_note", reads: "brand_reads_signal" }, "no nearby-cell list on this brand");
    for (const locale of ["zh-CN", "en"] as const) {
      const text = interpolate(SETTINGS_TEXT[locale].brand_note, { reads: SETTINGS_TEXT[locale].brand_reads_cells });
      assert.ok(!text.includes("{"), locale);
      assert.ok(SETTINGS_TEXT[locale].brand_auto_hint.length > 20);
    }
  });

  it("explains a test of another brand in that brand's terms", () => {
    const tested = { family: "openwrt", address: "192.168.1.1" } as const;
    const ok: ConnectionTestResult = { ok: true, holdMs: 140, model: "RM520N-GL", firmware: null, loginScheme: "unknown", tokenFlow: "unknown", ecc: false };
    // No HiLink login details for a router that has none
    assert.deepEqual(connectionNotice(ok, tZh, tested), { key: "ok_result_brand", params: { model: "RM520N-GL", firmware: "?", ms: 140 }, tone: "success" });
    assert.equal(connectionNotice(ok, tZh).key, "ok_result");

    assert.equal(connectionNotice(failure("router_error", { code: "rpc-32002" }), tZh, tested).key, "fail_router_error_brand");
    assert.equal(connectionNotice(failure("router_error", { code: "100003" }), tZh).key, "fail_router_error");
    // Attempts left are named only when the router named them
    assert.equal(connectionNotice(failure("wrong_password"), tZh, tested).key, "fail_wrong_password_nocount");
    assert.equal(connectionNotice(failure("wrong_password", { remainCount: 2 }), tZh, tested).key, "fail_wrong_password");
    const unknown = connectionNotice(failure("unknown_brand"), tZh, { family: "huawei", address: "http://192.168.0.1" });
    assert.deepEqual([unknown.key, unknown.tone], ["fail_unknown_brand", "danger"]);

    // The guidance names the address typed and the brand's usual one, never the verified router's by rote
    const busy = connectionNotice(failure("human_logged_in"), tZh, tested);
    assert.match(interpolate(tZh(busy.key), busy.params), /192\.168\.1\.1/);
    const away = connectionNotice(failure("unreachable"), tZh, { family: "nradio", address: "http://192.168.66.9" });
    assert.match(interpolate(tZh(away.key), away.params), /http:\/\/192\.168\.66\.1/);
    for (const locale of ["zh-CN", "en"] as const) {
      for (const key of ["fail_last_attempt", "fail_password_change_required", "fail_human_logged_in", "fail_unreachable", "fail_invalid_url"] as const) {
        assert.ok(!SETTINGS_TEXT[locale][key].includes("192.168.8.1"), `${locale} ${key} names no fixed address`);
      }
    }
  });
});
