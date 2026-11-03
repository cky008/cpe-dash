import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DeviceReportResponse, ExperimentalWritesResponse } from "../src/api-contract.ts";
import { type FengSuiRuntimeStack, createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import type { WriteResultRecord } from "../src/device-access.ts";
import { ApiErrorTally, buildDeviceReport } from "../src/device-profile.ts";
import { sanitizeDeviceReport } from "../src/sanitize.ts";
import { type FamilySms, createCpeFamily } from "./helpers/cpe-family.ts";

/**
 * Multi-model phase 3: the device report's "recent write results" carry, per experimental write, the
 * endpoints, the router's code and the read-back, never a value written (bands, switches, numbers,
 * message text), and take the report's second pass. Every placeholder identifier goes in; none may
 * come out. Mocks and placeholders only.
 */

const NOW = "2026-11-03T08:00:00.000Z";
const PLACEHOLDERS = ["860000000000000", "272010000000000", "8935301000000000000", "+353830000000", "02:00:5E:10:00:01", "198.51.100.42", "203.0.113.10", "2001:db8::42", "10001", "134217758", "FengSui_Lab_WiFi"];
const leaks = (json: string): string[] => PLACEHOLDERS.filter((id) => json.toLowerCase().includes(id.toLowerCase()));

const ENDPOINTS: Readonly<Record<string, string>> = {
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
  "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
  "/api/device/device-feature-switch": "<response><tac>10001</tac><cell_id>134217758</cell_id><wifissid>FengSui_Lab_WiFi</wifissid></response>",
};
const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000000", content: "IMEI 860000000000000 from 198.51.100.42", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
];

const record = (over: Partial<WriteResultRecord>): WriteResultRecord => ({
  id: "3f2b1d70-1234-4567-8901-234567890123",
  atIso: NOW,
  action: "set_mobile_data",
  feature: "mobileData",
  model: "B535-232",
  endpoints: ["/api/dialup/mobile-dataswitch"],
  outcome: "applied",
  code: null,
  readback: "match",
  reason: null,
  ...over,
});

describe("experimental writes in the device report", () => {
  it("lists each result without its id, and nothing when there is none", () => {
    const apiErrors = new ApiErrorTally(() => Date.parse(NOW)).snapshot();
    const base = { probe: null, apiErrors, fengsuiVersion: "1.6.0", generatedAtIso: NOW };
    assert.deepEqual(buildDeviceReport(base).writes, []);
    const report = buildDeviceReport({ ...base, writes: [record({}), record({ action: "reboot_cpe", feature: "reboot", endpoints: ["/api/device/control"], outcome: "failed", code: "100002", readback: "none" })] });
    assert.deepEqual(report.writes, [
      { atIso: NOW, action: "set_mobile_data", feature: "mobileData", model: "B535-232", endpoints: ["/api/dialup/mobile-dataswitch"], outcome: "applied", code: null, readback: "match", reason: null },
      { atIso: NOW, action: "reboot_cpe", feature: "reboot", model: "B535-232", endpoints: ["/api/device/control"], outcome: "failed", code: "100002", readback: "none", reason: null },
    ]);
    // A model label that slipped past the allowlist is caught by the second pass
    const tampered = sanitizeDeviceReport(buildDeviceReport({ ...base, writes: [record({ model: "860000000000000" })] }));
    assert.equal(tampered.writes[0]?.model, "<redacted>");
  });

  it("carries none of the values written, end to end through the console", async () => {
    const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", model: "B535-232", endpoints: ENDPOINTS, sms: MAILBOX, writes: { ignore: false } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-xreport-"));
    const env: Record<string, string> = {
      CPE_URL: "http://192.168.8.1",
      CPE_PASSWORD: cpe.password,
      API_TOKEN: "report_full_token",
      DATA_ENCRYPTION_KEY: "report_data_key",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: "0",
      ALLOWED_HOSTS: "127.0.0.1",
      STATE_FILE: path.join(dir, "data", "state.json"),
      POLL_INTERVAL_MS: "600000",
      NEIGHBOR_SCAN_INTERVAL_MS: "600000",
    };
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    const stack: FengSuiRuntimeStack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await stack.httpServer.listen();
      const base = `http://${bound.host}:${bound.port}`;
      const send = (method: string, p: string, cookie: string, body?: unknown) =>
        fetch(`${base}${p}`, {
          method,
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const login = await send("POST", "/api/auth/login", "", { password: "report_full_token" });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      assert.ok(await stack.monitor.identifyDevice());
      assert.ok(await stack.sms?.sync("full"));
      for (const feature of ["bandLock", "mobileData", "smsWrite"]) {
        assert.equal((await send("POST", "/api/console/experimental", cookie, { feature, enabled: true, model: "B535-232" })).status, 200, feature);
      }
      await stack.controls.lockBands({ lteBands: [1, 3] });
      await stack.controls.setMobileData(false);
      await stack.sms?.send({ phones: ["+353830000000"], content: "IMEI 860000000000000, IP 198.51.100.42", source: "web" });
      await stack.sms?.markRead({ uids: stack.sms.mirror.list().filter((m) => m.isUnread).map((m) => m.uid) });

      const view = (await (await send("GET", "/api/console/experimental", cookie)).json()) as ExperimentalWritesResponse;
      assert.deepEqual(view.writes.map((w) => [w.action, w.readback]), [
        ["lock_band", "match"],
        ["set_mobile_data", "match"],
        ["sms_send", "match"],
        ["sms_mark_read", "match"],
      ]);
      const report = ((await (await send("GET", "/api/console/device-report", cookie)).json()) as DeviceReportResponse).report;
      assert.deepEqual(report.access?.features, { ...view.device.features }, "which writes were on, and which this router lacks");
      assert.deepEqual([report.access?.features?.bandLock, report.access?.features?.reboot, report.access?.features?.cellLock], ["consented", "available", "not_implemented"]);
      assert.deepEqual(report.writes.map((w) => [w.action, w.endpoints.join(","), w.outcome, w.readback]), [
        ["lock_band", "/api/net/net-mode", "applied", "match"],
        ["set_mobile_data", "/api/dialup/mobile-dataswitch", "applied", "match"],
        ["sms_send", "/api/sms/send-sms", "applied", "match"],
        ["sms_mark_read", "/api/sms/set-read", "applied", "match"],
      ]);
      const json = JSON.stringify(report);
      assert.deepEqual(leaks(json), []);
      for (const value of ["800800c5", "IMEI", "40001", '"dataswitch":"0"']) assert.ok(!json.includes(value), `no value written: ${value}`);
      assert.equal(json.includes("<redacted>"), false, "nothing had to be caught by the second pass");
    } finally {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
