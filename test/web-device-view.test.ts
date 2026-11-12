import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { CATALOG_SECTIONS, deviceSupportRow } from "../src/device-catalog.ts";
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
  SUPPORT_MARK_KEYS,
  checksSummary,
  supportCells,
  supportDocsUrl,
  supportMarkText,
  supportNotes,
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

describe("console: the router's row of Supported devices", () => {
  const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT.en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));

  it("shows the daemon's row in the console's language, says what each mark means and links the brand's section", () => {
    const row = deviceSupportRow("zte-zwrt", "MU5250");
    assert.equal(supportDocsUrl(row, "zh-CN"), "https://fengsui.iocky.com/docs/supported-devices/#brand-zte");
    assert.equal(supportDocsUrl(row, "en"), "https://fengsui.iocky.com/en/docs/supported-devices/#brand-zte");
    assert.deepEqual(supportCells(row, "en")[5], { label: "Cell lock", mark: "△" });
    assert.deepEqual(supportCells(row, "zh-CN")[0], { label: "信号与流量", mark: "?" });
    assert.equal(supportNotes(row, "zh-CN")[0], "锁小区：只能锁 5G 小区，不能锁 4G 小区");
    assert.deepEqual(["✓", "?", "△", "—", "", "✓/?"].map((mark) => supportMarkText(mark as "✓", t)), [
      "verified on a real router",
      "implemented, waiting for a report",
      "partly, or with a condition",
      "not available",
      "FengSui does not do this yet",
      "verified on a real router / implemented, waiting for a report",
    ]);
    for (const locale of ["zh-CN", "en"] as const) for (const key of Object.values(SUPPORT_MARK_KEYS)) assert.ok(SETTINGS_TEXT[locale][key].trim(), `${locale}: ${key}`);
    // Every section the daemon may name has its anchor on the page the link opens
    const page = fs.readFileSync("docs/guide/en/supported-devices.md", "utf8");
    for (const section of CATALOG_SECTIONS) assert.ok(page.includes(`<a id="brand-${section.id}"></a>`), section.id);
  });
});

describe("console: the device report's summary", () => {
  const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT.en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));

  it("groups the report's lines into what works, what does not and what is not tried, named as the console names them", () => {
    const report = buildDeviceReport({
      probe: null,
      apiErrors: { sinceIso: "2026-11-11T00:00:00.000Z", entries: [] },
      fengsuiVersion: "1.9.0",
      generatedAtIso: "2026-11-11T00:00:00.000Z",
      access: {
        family: "zte-zwrt",
        writes: "experimental",
        reads: {
          telemetry: { state: "available", code: null },
          neighbors: { state: "unavailable", code: null },
          topology: { state: "unknown", code: null },
          settings: { state: "unknown", code: null },
          accessControl: { state: "unknown", code: null },
          sms: { state: "unknown", code: null },
        },
      },
      writes: [{ id: "a", atIso: "2026-11-11T00:00:00.000Z", action: "lock_cell", feature: "cellLock", model: "MU5250", endpoints: ["zte-zwrt:zwrt_bsp.lte.lock"], outcome: "applied", code: null, readback: "match", reason: null }],
    });
    const summary = checksSummary(report, t);
    assert.deepEqual(summary.map((line) => [line.result, line.count]), [["works", 2], ["failed", 1], ["untested", 24]]);
    assert.equal(summary[0]?.text, `2 work: ${t(FEATURE_KEYS.telemetry)}, ${t(FEATURE_KEYS.cellLock)}`);
    assert.equal(summary[1]?.text, `1 do not work: ${t(FEATURE_KEYS.neighbors)}`);
    assert.deepEqual(checksSummary({ checks: [] }, t).map((line) => line.text), ["0 work", "0 do not work", "0 not tried yet"]);
    for (const locale of ["zh-CN", "en"] as const) for (const key of ["report_summary_title", "report_summary_works", "report_summary_failed", "report_summary_untested", "report_summary_hint"] as const) assert.ok(SETTINGS_TEXT[locale][key].trim());
  });
});
