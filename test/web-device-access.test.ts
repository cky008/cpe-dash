import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DeviceAccessSnapshot, SchedulerStatusSnapshot, WriteResultRecord } from "../src/api-contract.ts";
import { CONTROL_FEATURES, type ControlAction, READ_SECTIONS } from "../src/device-access.ts";
import { WRITE_FEATURES } from "../src/device-access.ts";
import { FAMILY_WRITE_FEATURES } from "../src/router-family.ts";
import { canWrite, experimentalOffer, experimentalWrites, hasSwitch, readbackTone, unavailableSection, unconfirmedWrite, unverifiedModel, versionLabel, writeState } from "../web/src/core/device-access-view.ts";
import { FEATURE_KEYS, READBACK_KEYS, READ_STATE_KEYS, REASON_KEYS, SECTION_KEYS, WRITE_STATE_KEYS, readText, switchScope, writeResultDetail, writesText } from "../web/src/core/device-view.ts";
import { SETTINGS_TEXT } from "../web/src/i18n/settings.ts";

/** What the console offers for the router it watches (multi-model phase 2), decided without the DOM. */

function status(device: Partial<DeviceAccessSnapshot>): SchedulerStatusSnapshot {
  const reads = Object.fromEntries(READ_SECTIONS.map((section) => [section, { state: "verified", code: null }])) as DeviceAccessSnapshot["reads"];
  return { device: { model: "H168-383", verification: "verified", confirmed: true, writes: "allowed", reads, ...device } } as unknown as SchedulerStatusSnapshot;
}

describe("console: the router's write and read access", () => {
  it("names a model nobody verified, and no other", () => {
    assert.equal(unverifiedModel(null), null, "nothing known: the daemon decides");
    assert.equal(unverifiedModel(status({})), null);
    const other = status({ model: "B535-232", verification: "unverified-model", writes: "experimental" });
    assert.equal(unverifiedModel(other), "B535-232");
    assert.equal(unverifiedModel(status({ model: null, writes: "experimental" })), "?");
    assert.equal(unverifiedModel(status({ model: null, writes: "unknown" })), null);
  });

  it("says which sections the model does not provide", () => {
    const reads = { ...status({}).device.reads, neighbors: { state: "unavailable", code: "100002" }, sms: { state: "unavailable", code: null }, topology: { state: "unknown", code: null } } as DeviceAccessSnapshot["reads"];
    const other = status({ model: "B535-232", writes: "experimental", reads });
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
      for (const key of [...Object.values(SECTION_KEYS), ...Object.values(READ_STATE_KEYS), "access_writes_allowed", "access_writes_experimental", "access_writes_none", "access_writes_unknown", "access_title", "access_note"] as const) {
        assert.ok(text[key].trim(), `${locale}: ${key}`);
      }
    }
    const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT.en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));
    // What FengSui writes to this router, in a line: never "read-only" for a model whose writes are open
    assert.equal(writesText("allowed", 0, t), "Writes: available (a verified model)");
    assert.equal(writesText("experimental", 3, t), "Writes: 3 available (never checked on a real router)");
    assert.equal(writesText("experimental", 0, t), "Writes: none available (not implemented for this model, or turned off)");
    assert.equal(writesText("unknown", 0, t), "Writes: only once the model is known");
    assert.equal(readText({ state: "unavailable", code: "100002" }, t), "not on this model · 100002");
    assert.equal(readText({ state: "available", code: null }, t), "readable");
  });
});

describe("console: experimental writes on a model nobody verified", () => {
  const features = (over: Partial<DeviceAccessSnapshot["features"]> = {}): DeviceAccessSnapshot["features"] =>
    ({ ...Object.fromEntries(WRITE_FEATURES.map((f) => [f, "not_implemented"])), bandLock: "enabled", reboot: "enabled", ...over }) as DeviceAccessSnapshot["features"];

  it("offers the writes that are open, a switch for those FengSui implements, and leaves the verified model as it was", () => {
    const verified = status({ features: Object.fromEntries(WRITE_FEATURES.map((f) => [f, "verified"])) as DeviceAccessSnapshot["features"] });
    assert.deepEqual([canWrite(verified, "bandLock"), experimentalWrites(verified), experimentalOffer(verified), hasSwitch(verified, "bandLock")], [true, [], [], false]);
    assert.deepEqual([writeState(null, "reboot"), canWrite(null, "reboot"), hasSwitch(null, "reboot")], ["unknown", true, false], "no model yet: the daemon checks in the write's session");
    const legacy = status({ model: "B535-232", writes: "experimental" });
    delete (legacy.device as Partial<DeviceAccessSnapshot>).features;
    assert.deepEqual([writeState(legacy, "reboot"), experimentalWrites(legacy), experimentalOffer(legacy)], ["unknown", [], []], "a status without the states offers nothing");

    // On by default; one its owner turned off; one the router lacks; one users verified on this model
    const other = status({ model: "B535-232", verification: "unverified-model", writes: "experimental", features: features({ smsWrite: "disabled", mobileData: "unsupported", reconnect: "verified" }) });
    // A write someone verified on this model stays offered with the others; its confirmation drops "never checked"
    assert.deepEqual(experimentalWrites(other), ["bandLock", "reboot", "reconnect"]);
    assert.deepEqual([unconfirmedWrite(other, ["reboot"]), unconfirmedWrite(other, ["reconnect"])], [true, false]);
    assert.equal(unconfirmedWrite(other, ["reconnect", "bandLock"]), true, "an unlock that either lock allows: one of them was never checked");
    assert.equal(unconfirmedWrite(verified, ["bandLock"]), false);
    assert.deepEqual([canWrite(other, "bandLock"), canWrite(other, "reconnect"), canWrite(other, "smsWrite"), canWrite(other, "mobileData"), canWrite(other, "cellLock")], [true, true, false, false, false]);
    assert.deepEqual(
      experimentalOffer(other).filter(({ state }) => state !== "not_implemented"),
      [
        { feature: "bandLock", state: "enabled" },
        { feature: "reboot", state: "enabled" },
        { feature: "reconnect", state: "verified" },
        { feature: "mobileData", state: "unsupported" },
        { feature: "smsWrite", state: "disabled" },
      ]
    );
    // A switch where FengSui implements the write for this router (to turn it off, or back on), nowhere else
    assert.deepEqual(
      WRITE_FEATURES.filter((feature) => hasSwitch(other, feature)),
      ["bandLock", "reboot", "reconnect", "smsWrite"]
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

  it("says, at each switch, every action the gate files under it: SMS read state and deletion too, and what FengSui does on its own (R3-11)", () => {
    // How each action filed under a switchable feature is named by the switch's label and the line under it, per language
    const NAMED: Readonly<Partial<Record<ControlAction, Readonly<Record<"zh-CN" | "en", RegExp>>>>> = {
      lock_band: { "zh-CN": /锁频段/, en: /band lock/i },
      lock_cell: { "zh-CN": /锁小区/, en: /cell lock/i },
      unlock_rf_locks: { "zh-CN": /也管解除锁定/, en: /also covers unlocking/i },
      auto_unlock_rf_locks: { "zh-CN": /断网 3 分钟[\s\S]*锁频回滚[\s\S]*自己解锁/, en: /WAN down 3 minutes[\s\S]*lock rollback[\s\S]*on its own/i },
      reboot_cpe: { "zh-CN": /重启/, en: /reboot/i },
      reconnect_cellular: { "zh-CN": /重拨/, en: /redial/i },
      auto_reconnect_cellular: { "zh-CN": /WAN 自动重拨[\s\S]*自己重拨/, en: /WAN auto-redial[\s\S]*on its own/i },
      set_mobile_data: { "zh-CN": /移动数据/, en: /mobile data/i },
      sms_send: { "zh-CN": /发送/, en: /sending/i },
      sms_mark_read: { "zh-CN": /标为已读[\s\S]*自动标为已读/, en: /marking read[\s\S]*auto mark-as-read/i },
      sms_delete: { "zh-CN": /删除/, en: /deleting/i },
    };
    const switchable: ReadonlySet<string> = new Set(FAMILY_WRITE_FEATURES);
    for (const [action, feature] of Object.entries(CONTROL_FEATURES) as Array<[ControlAction, (typeof FAMILY_WRITE_FEATURES)[number]]>) {
      if (!switchable.has(feature)) continue;
      const named = NAMED[action];
      assert.ok(named, `${action} goes with the ${feature} switch: name it there`);
      for (const locale of ["zh-CN", "en"] as const) {
        const t = (key: keyof (typeof SETTINGS_TEXT)["en"], params?: Record<string, string | number>): string => SETTINGS_TEXT[locale][key].replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ""));
        assert.match(`${t(FEATURE_KEYS[feature])} ${switchScope(feature, t) ?? ""}`, named[locale], `${locale}: ${action}`);
      }
    }
    const en = (key: keyof (typeof SETTINGS_TEXT)["en"]): string => SETTINGS_TEXT.en[key];
    assert.equal(switchScope("mobileData", en), null, "its name says all it covers");
    assert.equal(switchScope("accessControl", en), null);
    assert.match(SETTINGS_TEXT.en.exp_scope_reboot, /never a factory reset/, "a reboot never sends Control 2");
    // The switch and the results name the SMS feature as more than sending
    assert.deepEqual([SETTINGS_TEXT["zh-CN"].feature_sms_write, SETTINGS_TEXT.en.feature_sms_write], ["发送与管理短信", "Send and manage SMS"]);
    // The list says the writes were never checked on a real router, in place of the consent dialog that is gone
    assert.match(SETTINGS_TEXT["zh-CN"].exp_intro, /没有在真机上验证过[\s\S]*默认可用[\s\S]*逐项关闭/);
    assert.match(SETTINGS_TEXT.en.exp_intro, /never checked on a real one[\s\S]*available by default[\s\S]*Turn off/);
    assert.match(SETTINGS_TEXT["zh-CN"].exp_state_enabled, /没有在真机上验证过/);
    for (const locale of ["zh-CN", "en"] as const) {
      for (const gone of ["exp_type_model", "exp_confirm", "exp_on_title", "exp_risk_breaks"]) assert.equal(Object.hasOwn(SETTINGS_TEXT[locale], gone), false, `${locale}: ${gone}`);
    }
  });
});
