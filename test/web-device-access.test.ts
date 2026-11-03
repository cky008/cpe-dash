import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceAccessSnapshot, SchedulerStatusSnapshot, WriteResultRecord } from "../src/api-contract.ts";
import { CONTROL_FEATURES, type ControlAction, READ_SECTIONS } from "../src/device-access.ts";
import { WRITE_FEATURES } from "../src/device-access.ts";
import { EXPERIMENTAL_FEATURES } from "../src/device-profile.ts";
import { canWrite, experimentalOffer, experimentalWrites, readOnlyModel, readbackTone, unavailableSection, versionLabel, writeState, writesLocked } from "../web/src/core/device-access-view.ts";
import { READBACK_KEYS, READ_STATE_KEYS, REASON_KEYS, SECTION_KEYS, WRITES_KEYS, WRITE_STATE_KEYS, experimentalRiskBody, readText, writeResultDetail } from "../web/src/core/device-view.ts";
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

describe("console: experimental writes on a model nobody verified", () => {
  const features = (over: Partial<DeviceAccessSnapshot["features"]> = {}): DeviceAccessSnapshot["features"] =>
    ({ ...Object.fromEntries(WRITE_FEATURES.map((f) => [f, "not_implemented"])), bandLock: "available", reboot: "available", ...over }) as DeviceAccessSnapshot["features"];

  it("offers a write it may do, names the ones turned on, and leaves the verified model as it was", () => {
    const verified = status({ features: Object.fromEntries(WRITE_FEATURES.map((f) => [f, "verified"])) as DeviceAccessSnapshot["features"] });
    assert.deepEqual([canWrite(verified, "bandLock"), experimentalWrites(verified), experimentalOffer(verified)], [true, [], []]);
    assert.deepEqual([writeState(null, "reboot"), canWrite(null, "reboot")], ["unknown", true], "no model yet: the daemon checks in the write's session");
    const legacy = status({ model: "B535-232", writes: "read_only" });
    delete (legacy.device as Partial<DeviceAccessSnapshot>).features;
    assert.deepEqual([writeState(legacy, "reboot"), experimentalWrites(legacy), experimentalOffer(legacy)], ["unknown", [], []], "a status without the states offers nothing");

    const other = status({ model: "B535-232", verification: "unverified-model", writes: "read_only", features: features({ smsWrite: "consented", reboot: "consented" }) });
    assert.deepEqual(experimentalWrites(other), ["reboot", "smsWrite"]);
    assert.deepEqual([canWrite(other, "smsWrite"), canWrite(other, "bandLock"), canWrite(other, "cellLock")], [true, false, false]);
    assert.deepEqual(
      experimentalOffer(other).filter(({ state }) => state !== "not_implemented"),
      [
        { feature: "bandLock", state: "available" },
        { feature: "reboot", state: "consented" },
        { feature: "smsWrite", state: "consented" },
      ]
    );
  });

  it("reads a write result's tone and detail without any value", () => {
    const result: WriteResultRecord = { id: "x", atIso: "2026-11-03T08:00:00.000Z", action: "reboot_cpe", feature: "reboot", model: "B535-232", endpoints: ["/api/device/control"], outcome: "applied", code: null, readback: "mismatch", reason: "no_restart" };
    assert.equal(readbackTone(result), "warning");
    assert.equal(readbackTone({ outcome: "failed", readback: "none" }), "error");
    assert.equal(readbackTone({ outcome: "applied", readback: "match" }), "success");
    assert.equal(readbackTone({ outcome: "applied", readback: "pending" }), "info");
    const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT.en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));
    const detail = writeResultDetail({ ...result, code: "100002" }, Date.parse("2026-11-03T08:05:00.000Z"), "en", t);
    assert.match(detail, /^5m ago · POST \/api\/device\/control · error code 100002 · the next polls show no restart or new connection$/);
    for (const locale of ["zh-CN", "en"] as const) {
      for (const key of [...Object.values(WRITE_STATE_KEYS), ...Object.values(READBACK_KEYS), ...Object.values(REASON_KEYS)]) assert.ok(SETTINGS_TEXT[locale][key].trim(), `${locale}: ${key}`);
    }
  });

  it("says, before a write is turned on, every action the gate then lets through: SMS read state and deletion too, and the self-healing's own writes (R3-11)", () => {
    // How each action the gate files under an experimental feature is named, per language
    const NAMED: Readonly<Partial<Record<ControlAction, Readonly<Record<"zh-CN" | "en", RegExp>>>>> = {
      lock_band: { "zh-CN": /锁定 LTE 频段/, en: /lock the LTE bands/i },
      unlock_rf_locks: { "zh-CN": /解除锁定/, en: /unlock/i },
      auto_unlock_rf_locks: { "zh-CN": /LOCK_ROLLBACK_AFTER_MIN/, en: /LOCK_ROLLBACK_AFTER_MIN/ },
      reboot_cpe: { "zh-CN": /重启路由器/, en: /restart the router/i },
      reconnect_cellular: { "zh-CN": /重新拨号/, en: /redial/i },
      auto_reconnect_cellular: { "zh-CN": /WAN_AUTO_RECONNECT_AFTER_MIN/, en: /WAN_AUTO_RECONNECT_AFTER_MIN/ },
      set_mobile_data: { "zh-CN": /移动数据/, en: /mobile data/i },
      sms_send: { "zh-CN": /发送短信/, en: /send SMS/i },
      sms_mark_read: { "zh-CN": /标为已读[\s\S]*SMS_AUTO_MARK_READ/, en: /mark SMS read[\s\S]*SMS_AUTO_MARK_READ/i },
      sms_delete: { "zh-CN": /删除短信/, en: /delete them/i },
    };
    const experimental: ReadonlySet<string> = new Set(EXPERIMENTAL_FEATURES);
    for (const [action, feature] of Object.entries(CONTROL_FEATURES) as Array<[ControlAction, string]>) {
      if (!experimental.has(feature)) continue;
      const named = NAMED[action];
      assert.ok(named, `${action} opens with ${feature}: name it in the dialog`);
      for (const locale of ["zh-CN", "en"] as const) {
        const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT[locale][key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));
        const body = experimentalRiskBody(feature as (typeof EXPERIMENTAL_FEATURES)[number], "B535-232", t);
        assert.match(body[0] ?? "", named[locale], `${locale}: ${action}`);
        // The risks, the recovery and the model to type stay in the dialog after what it opens
        assert.deepEqual(body.slice(1), [t("exp_risk_breaks"), t("exp_risk_unverified", { model: "B535-232" }), t("exp_risk_recover"), t("exp_type_model", { model: "B535-232" })]);
      }
    }
    assert.match(SETTINGS_TEXT.en.exp_scope_reboot, /never a factory reset/, "a reboot never sends Control 2");
    // The switch, the dialog's title and the results name the SMS feature as more than sending
    assert.deepEqual([SETTINGS_TEXT["zh-CN"].feature_sms_write, SETTINGS_TEXT.en.feature_sms_write], ["发送与管理短信", "Send and manage SMS"]);
  });
});
