import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEVICE_FEATURES, type DeviceProfile, type DeviceReport, buildDeviceReport } from "../src/device-profile.ts";
import {
  FEATURE_KEYS,
  STATE_KEYS,
  bandText,
  detectedText,
  endpointText,
  loginText,
  reportFileName,
  reportIssueLink,
  reportJson,
  verificationNotice,
} from "../web/src/core/device-view.ts";
import { deviceIssueUrl } from "../src/feedback.ts";
import { schemeText, tokenFlowText } from "../web/src/core/console-view.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../web/src/i18n/settings.ts";

const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const VERIFIED = [{ model: "H168-383", softwareVersion: "4.4.0.1(H1006SP19C00)" }];

function profile(over: Partial<DeviceProfile["identity"]> = {}, verification: DeviceProfile["verification"] = "verified"): DeviceProfile {
  const features = Object.fromEntries(DEVICE_FEATURES.map((f) => [f, { state: "supported", source: "verified" }])) as DeviceProfile["capabilities"]["features"];
  return {
    identity: {
      model: "H168-383",
      marketingName: "HUAWEI 5G CPE Ultra 6",
      softwareVersion: "4.4.0.1(H1006SP19C00)",
      webUiVersion: "WEBUI 4.4.0.1(W2SP24C03)",
      passwordType: "4",
      loginScheme: "scram",
      ecc: true,
      tokenFlow: "webserver-token",
      detectedAtIso: "2026-11-02T09:57:00.000Z",
      ...over,
    },
    verification,
    capabilities: { probedAtIso: "2026-11-02T09:57:00.000Z", endpoints: [], lteBands: [1, 3, 20], features },
    origin: "startup",
  };
}

const text = (locale: "zh-CN" | "en") => (key: SettingsTextKey, params: Record<string, string | number> = {}): string =>
  SETTINGS_TEXT[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));

describe("web core: device view", () => {
  it("opens with the verification state: verified, a new build, an unverified model, or nothing yet", () => {
    assert.deepEqual(verificationNotice(profile(), VERIFIED), { key: "verification_verified", params: { model: "H168-383", firmware: "4.4.0.1(H1006SP19C00)" }, tone: "success" });
    assert.deepEqual(verificationNotice(profile({ softwareVersion: "4.4.0.2(H1006SP20C00)" }, "new-firmware"), VERIFIED), {
      key: "verification_new_firmware",
      params: { model: "H168-383", firmware: "4.4.0.2(H1006SP20C00)", verified: "H168-383 4.4.0.1(H1006SP19C00)" },
      tone: "pending",
    });
    assert.deepEqual(verificationNotice(profile({ model: "B535-232" }, "unverified-model"), VERIFIED), {
      key: "verification_unverified_model",
      params: { model: "B535-232", verified: "H168-383 4.4.0.1(H1006SP19C00)" },
      tone: "pending",
    });
    assert.deepEqual(verificationNotice(profile({ model: null }, "unknown"), VERIFIED), { key: "verification_unknown", params: {}, tone: "info" });
    assert.deepEqual(verificationNotice(null, VERIFIED), { key: "device_none", params: {}, tone: "info" });
    for (const locale of ["zh-CN", "en"] as const) {
      const shown = text(locale)(verificationNotice(profile({ model: "B535-232" }, "unverified-model"), VERIFIED).key, { model: "B535-232", verified: "H168-383" });
      assert.ok(shown.includes("B535-232") && shown.includes("H168-383"), shown);
    }
  });

  it("names the login, its encryption, when and how the router was identified", () => {
    const zh = text("zh-CN");
    const en = text("en");
    assert.equal(loginText(profile().identity, en), "SCRAM · password_type 4");
    assert.equal(loginText(profile({ loginScheme: "unknown", passwordType: null }).identity, en), SETTINGS_TEXT.en.login_unknown);
    assert.equal(loginText(profile({ loginScheme: "sha256" }).identity, zh), "SHA-256 · password_type 4");
    assert.deepEqual(
      (["webserver-token", "sestokinfo", "unknown"] as const).map((flow) => tokenFlowText(flow, zh)),
      ["webserver/token", "webserver/SesTokInfo", SETTINGS_TEXT["zh-CN"].token_flow_unknown],
      "where the tokens came from"
    );
    assert.equal(schemeText("base64", en), "Base64");
    assert.match(detectedText(profile(), NOW, "zh-CN", zh), /3 分钟前/);
    assert.match(detectedText({ ...profile(), origin: "connection-test" }, NOW, "en", en), /3m ago/);
    assert.notEqual(detectedText(profile(), NOW, "en", en), detectedText({ ...profile(), origin: "connection-test" }, NOW, "en", en));
  });

  it("labels every feature and endpoint state in both languages", () => {
    for (const feature of DEVICE_FEATURES) assert.ok(FEATURE_KEYS[feature], feature);
    for (const state of ["supported", "unsupported", "restricted", "unknown"] as const) assert.ok(STATE_KEYS[state], state);
    const en = text("en");
    assert.equal(endpointText({ path: "/api/net/net-mode-list", state: "supported", code: null }, en), SETTINGS_TEXT.en.state_supported);
    assert.equal(endpointText({ path: "/api/system/devcapacity", state: "restricted", code: "100003" }, en), `${SETTINGS_TEXT.en.state_restricted} · 100003`);
    assert.equal(bandText([1, 3, 20]), "B1 B3 B20");
    assert.equal(bandText([]), null);
    assert.equal(bandText(null), null);
  });

  it("names the report file after the model and the time, and pretty-prints it", () => {
    const report: DeviceReport = buildDeviceReport({ probe: null, apiErrors: { sinceIso: "2026-11-02T08:00:00.000Z", entries: [] }, fengsuiVersion: "1.5.0", generatedAtIso: "2026-11-02T10:00:00.123Z" });
    assert.equal(reportFileName(report), "fengsui-device-report-unknown-20261102T100000Z.json");
    assert.equal(reportFileName({ ...report, identity: { ...profile({ model: "B535 / 232?" }).identity } }), "fengsui-device-report-B535-232-20261102T100000Z.json");
    const json = reportJson(report);
    assert.ok(json.endsWith("}\n"));
    assert.deepEqual(JSON.parse(json), report);
    assert.match(json, /\n {2}"reportVersion": 1,/);
  });

  it("links the report to a new GitHub issue, except in the static demo, whose report is the demo router's", () => {
    const report: DeviceReport = { ...buildDeviceReport({ probe: null, apiErrors: { sinceIso: "2026-11-02T08:00:00.000Z", entries: [] }, fengsuiVersion: "1.5.0", generatedAtIso: "2026-11-02T10:00:00.123Z" }), identity: profile({ model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)" }).identity };
    assert.equal(reportIssueLink(report, false), deviceIssueUrl(report.identity));
    assert.equal(reportIssueLink(report, true), null);
  });
});
