import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BEHAVIOUR_ENV, type BehaviourValues, DEFAULT_BEHAVIOUR, behaviourFromConfig, describeBehaviour, readBehaviourPatch, resolveBehaviour, sanitizeBehaviourOverrides } from "../src/behaviour-settings.ts";
import { loadConfig } from "../src/config.ts";
import { CpeControlValidationError } from "../src/control-error.ts";

const ENV: BehaviourValues = {
  agentWrites: false,
  agentAccessControl: false,
  agentSms: "read",
  agentSmsSendPolicy: "known",
  agentSmsSendLimitPerHour: 10,
  redactApi: true,
  lockRollbackAfterMin: 0,
  wanReconnectAfterMin: 0,
  alertsEnabled: true,
  alertNotifyMinSeverity: "warning",
  alertRsrpThresholdDbm: -110,
  alertSinrThresholdDb: 0,
  smsAutoMarkRead: false,
  defaultCountryCode: "",
};

describe("Behaviour settings the console sets over .env", () => {
  it("reads .env's values as AppConfig parsed them", () => {
    const config = loadConfig({
      envPath: "/nonexistent/.env",
      ignoreProcessEnv: true,
      overrides: { MCP_ALLOW_MUTATIONS: "true", MCP_SMS_ACCESS: "full", LOCK_ROLLBACK_AFTER_MIN: "10", WAN_AUTO_RECONNECT_AFTER_MIN: "3", DEFAULT_COUNTRY_CODE: "353", ALERT_RSRP_THRESHOLD_DBM: "-105" },
    });
    const env = behaviourFromConfig(config);
    assert.equal(env.agentWrites, true);
    assert.equal(env.agentSms, "full");
    assert.equal(env.lockRollbackAfterMin, 10);
    assert.equal(env.wanReconnectAfterMin, 3);
    assert.equal(env.defaultCountryCode, "+353");
    assert.equal(env.alertRsrpThresholdDbm, -105);
    assert.deepEqual(Object.keys(env).sort(), Object.keys(BEHAVIOUR_ENV).sort(), "every setting names its .env key");
  });

  it("follows .env where the console set nothing and the console where it did", () => {
    const resolved = resolveBehaviour(ENV, { agentWrites: true, lockRollbackAfterMin: 10, alertsEnabled: null });
    assert.equal(resolved.agentWrites, true);
    assert.equal(resolved.lockRollbackAfterMin, 10);
    assert.equal(resolved.alertsEnabled, true, "null follows .env");
    assert.equal(resolved.agentSms, "read");
    const report = describeBehaviour(ENV, { agentWrites: true });
    assert.deepEqual(report.agentWrites, { value: true, source: "console", envValue: false });
    assert.deepEqual(report.agentSms, { value: "read", source: "env", envValue: "read" });
  });

  it("accepts a valid value or null for each setting, and normalises the country code", () => {
    const patch = readBehaviourPatch({
      agentWrites: true,
      agentAccessControl: null,
      agentSms: "full",
      agentSmsSendPolicy: "any",
      agentSmsSendLimitPerHour: 0,
      redactApi: false,
      lockRollbackAfterMin: 3,
      wanReconnectAfterMin: 0,
      alertsEnabled: false,
      alertNotifyMinSeverity: "critical",
      alertRsrpThresholdDbm: -120,
      alertSinrThresholdDb: -5,
      smsAutoMarkRead: true,
      defaultCountryCode: "44",
    });
    assert.equal(patch.agentAccessControl, null);
    assert.equal(patch.defaultCountryCode, "+44");
    assert.equal(patch.lockRollbackAfterMin, 3);
    assert.equal(readBehaviourPatch({ defaultCountryCode: "" }).defaultCountryCode, "", "empty: from the SIM");
    assert.deepEqual(readBehaviourPatch({ lockRollbackAfterMin: 1440, wanReconnectAfterMin: 1 }), { lockRollbackAfterMin: 1440, wanReconnectAfterMin: 1 });
  });

  it("refuses what .env would refuse or clamp, an unknown setting and an empty patch", () => {
    const refused: ReadonlyArray<Record<string, unknown>> = [
      { agentWrites: "yes" },
      { agentSms: "write" },
      { agentSmsSendPolicy: "all" },
      { agentSmsSendLimitPerHour: -1 },
      { agentSmsSendLimitPerHour: 1.5 },
      { agentSmsSendLimitPerHour: 1001 },
      { lockRollbackAfterMin: 2 },
      { lockRollbackAfterMin: 1441 },
      { wanReconnectAfterMin: -1 },
      { alertNotifyMinSeverity: "debug" },
      { alertRsrpThresholdDbm: -141 },
      { alertRsrpThresholdDbm: -43 },
      { alertSinrThresholdDb: 41 },
      { alertSinrThresholdDb: -21 },
      { defaultCountryCode: "+12345" },
      { defaultCountryCode: "Ireland" },
      { pollIntervalMs: 1000 },
      {},
    ];
    for (const body of refused) assert.throws(() => readBehaviourPatch(body), CpeControlValidationError, JSON.stringify(body));
  });

  it("keeps only stored values this version can honour, and defaults to an empty .env's values", () => {
    assert.deepEqual(sanitizeBehaviourOverrides({ agentWrites: "yes", lockRollbackAfterMin: 5, alertsEnabled: null, junk: 1 }), { lockRollbackAfterMin: 5 });
    assert.deepEqual(sanitizeBehaviourOverrides("corrupt"), {});
    const empty = behaviourFromConfig(loadConfig({ envPath: "/nonexistent/.env", ignoreProcessEnv: true, overrides: { CPE_URL: "http://192.168.8.1" } }));
    assert.deepEqual(empty, DEFAULT_BEHAVIOUR);
  });
});
