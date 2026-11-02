import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DeviceProfileResponse, DeviceReportResponse } from "../src/api-contract.ts";
import { createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ApiErrorTally, DEVICE_PROBE_PATHS, type DeviceProbePath, type ProbeSession, buildDeviceReport, probeDevice } from "../src/device-profile.ts";
import { sanitizeDeviceReport } from "../src/sanitize.ts";
import { createStrictCpe } from "./helpers/strict-cpe.ts";

/**
 * The device report a user may choose to attach to an issue: structure only (tag paths and value
 * shapes), values just for the allowlist, then a second pass through src/sanitize.ts. Every
 * placeholder identifier of AGENTS.md 铁律二 goes in; none may come out.
 */

const NOW = "2026-11-02T08:00:00.000Z";

const PLACEHOLDERS = [
  "860000000000000",
  "272010000000000",
  "8935301000000000000",
  "+353830000000",
  "02:00:5E:10:00:01",
  "198.51.100.42",
  "2001:db8::42",
  "10001",
  "134217758",
  "FengSui_Lab_WiFi",
  "SN00000000000000",
];

function leaks(json: string): string[] {
  return PLACEHOLDERS.filter((id) => json.toLowerCase().includes(id.toLowerCase()));
}

/** Every identifier, in every probed endpoint, in the tags an unknown model might use. */
const IDENTIFIERS =
  "<Imei>860000000000000</Imei><Imsi>272010000000000</Imsi><Iccid>8935301000000000000</Iccid><Msisdn>+353830000000</Msisdn><MacAddress1>02:00:5E:10:00:01</MacAddress1><WanIPAddress>198.51.100.42</WanIPAddress><WanIPv6Address>2001:db8::42</WanIPv6Address><tac>10001</tac><cell_id>134217758</cell_id><ssid>FengSui_Lab_WiFi</ssid><SerialNumber>SN00000000000000</SerialNumber>";

const BODIES: Readonly<Record<DeviceProbePath, string>> = {
  "/api/user/state-login": `<response><password_type>4</password_type><State>0</State>${IDENTIFIERS}</response>`,
  "/api/device/information": `<response><DeviceName>H168-383</DeviceName><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion>${IDENTIFIERS}</response>`,
  "/api/device/basic_information": `<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en>${IDENTIFIERS}</response>`,
  "/api/device/basicinformation": `<response><Info>${IDENTIFIERS}</Info></response>`,
  "/api/device/device-feature-switch": `<response><sms_enabled>1</sms_enabled>${IDENTIFIERS}</response>`,
  "/api/net/net-feature-switch": `<response><lock_freq_switch>3</lock_freq_switch><select_band_switch>1</select_band_switch>${IDENTIFIERS}</response>`,
  "/api/wlan/wifi-feature-switch": `<response><wifimaxmacfilternum>64</wifimaxmacfilternum>${IDENTIFIERS}</response>`,
  "/api/system/devcapacity": `<response>${IDENTIFIERS}</response>`,
  "/api/net/net-mode-list": `<response><LTEBandList><LTEBand><Name>LTE BC1/LTE BC3</Name><Value>5</Value></LTEBand></LTEBandList>${IDENTIFIERS}</response>`,
  "/api/global/module-switch": `<response><ussd_enabled>0</ussd_enabled>${IDENTIFIERS}</response>`,
};

const session: ProbeSession = {
  open: true,
  loginScheme: "scram",
  eccVerified: true,
  tokenFlow: "webserver-token",
  get: async (apiPath) => BODIES[apiPath as DeviceProbePath] ?? "",
};

describe("device report: desensitization", () => {
  it("carries no placeholder identifier from any answer, and keeps the allowlist", async () => {
    const probe = await probeDevice(session, { nowIso: NOW, origin: "startup" });
    const tally = new ApiErrorTally(() => Date.parse(NOW));
    tally.record("POST", "/api/sms/sms-list-contact?ecc-client-pubkey=0123456789abcdef0123456789abcdef&enc-type=1", "100002");
    const report = sanitizeDeviceReport(buildDeviceReport({ probe, apiErrors: tally.snapshot(), fengsuiVersion: "1.5.0", generatedAtIso: NOW }));
    const json = JSON.stringify(report);
    assert.deepEqual(leaks(json), []);
    assert.equal(json.includes("<redacted>"), false, "nothing had to be caught by the second pass");
    assert.equal(json.includes("ecc-client-pubkey"), false);

    assert.deepEqual(
      [report.identity?.model, report.identity?.marketingName, report.identity?.softwareVersion, report.identity?.webUiVersion, report.identity?.passwordType],
      ["H168-383", "HUAWEI 5G CPE Ultra 6", "4.4.0.1(H1006SP19C00)", "WEBUI 4.4.0.1(W2SP24C03)", "4"]
    );
    assert.deepEqual(report.capabilities?.lteBands, [1, 3]);
    const switches = report.endpoints.find((e) => e.path === "/api/net/net-feature-switch")?.fields.filter((f) => f.value !== undefined);
    assert.deepEqual(switches?.map((f) => `${f.tag}=${f.value}`), ["lock_freq_switch=3", "select_band_switch=1"]);
    assert.equal(report.endpoints.length, DEVICE_PROBE_PATHS.length);
    const imei = report.endpoints.find((e) => e.path === "/api/device/information")?.fields.find((f) => f.tag === "Imei");
    assert.deepEqual(imei, { tag: "Imei", shape: "int", count: 1 }, "the shape says what kind of value, never which");
  });

  it("catches in its second pass what a broken allowlist would let through, keeping versions and times", async () => {
    const probe = await probeDevice(session, { nowIso: NOW, origin: "startup" });
    const report = buildDeviceReport({ probe, apiErrors: new ApiErrorTally(() => Date.parse(NOW)).snapshot(), fengsuiVersion: "1.5.0", generatedAtIso: NOW });
    const tampered = structuredClone(report);
    assert.ok(tampered.identity && tampered.endpoints[0]);
    tampered.identity.model = "860000000000000";
    tampered.identity.marketingName = "Lab 02-00-5e-10-00-01";
    tampered.endpoints[0].fields.push({ tag: "x", shape: "02:00:5E:10:00:01", count: 1 });
    tampered.endpoints[0].fields.push({ tag: "y", shape: "text(12)", count: 1, value: "2001:db8::42" });
    tampered.endpoints[0].fields.push({ tag: "z", shape: "text(12)", count: 1, value: "+353830000000" });
    tampered.endpoints[0].fields.push({ tag: "w", shape: "2001:0db8:0000:0000:0000:0000:0000:0042", count: 1 });
    tampered.apiErrors.entries.push({ method: "GET", path: "/api/198.51.100.42", code: "100002", count: 1, lastAtIso: NOW });
    tampered.fengsuiVersion = "8935301000000000000";
    const clean = sanitizeDeviceReport(tampered);
    const json = JSON.stringify(clean);
    assert.deepEqual(leaks(json), []);
    assert.equal(json.split("<redacted>").length - 1, 8);
    assert.equal(json.includes("0db8"), false, "an IPv6 address written out in full");
    assert.equal(clean.identity?.softwareVersion, "4.4.0.1(H1006SP19C00)", "a dotted version is not an address");
    assert.equal(clean.identity?.webUiVersion, "WEBUI 4.4.0.1(W2SP24C03)");
    assert.equal(clean.generatedAtIso, NOW);
    assert.equal(clean.identity?.detectedAtIso, NOW, "times are not addresses either");
    assert.equal(JSON.stringify(sanitizeDeviceReport(report)), JSON.stringify(report), "a clean report passes unchanged");
  });
});

describe("device profile: the token route", () => {
  it("passes the profile tokens and agents read through the report's second pass", async () => {
    const cpe = createStrictCpe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-profile-"));
    const env: Record<string, string> = {
      CPE_URL: "http://192.168.8.1",
      CPE_PASSWORD: cpe.password,
      API_TOKEN_READONLY: "profile_read_token",
      DATA_ENCRYPTION_KEY: "profile_data_key",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: "0",
      ALLOWED_HOSTS: "127.0.0.1",
      STATE_FILE: path.join(dir, "data", "state.json"),
      SMS_ENABLED: "false",
    };
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    const stack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await stack.httpServer.listen();
      const profileOf = async () => {
        const res = await fetch(`http://${bound.host}:${bound.port}/api/device/profile`, { headers: { Authorization: "Bearer profile_read_token" } });
        assert.equal(res.status, 200);
        return ((await res.json()) as DeviceProfileResponse).profile;
      };
      const probe = await probeDevice(session, { nowIso: NOW, origin: "startup" });
      await stack.monitor.recordDeviceProbe(probe);
      assert.deepEqual([(await profileOf())?.identity.model, (await profileOf())?.identity.softwareVersion], ["H168-383", "4.4.0.1(H1006SP19C00)"], "a clean profile is served as it is");

      // A router whose allowlisted identity fields carry identifiers: the allowlist alone would let them through
      const odd = structuredClone(probe);
      odd.identity.model = "SN0000000000ABCD";
      odd.identity.marketingName = "Lab 02-00-5E-10-00-01";
      odd.identity.softwareVersion = "860000000000000";
      odd.identity.webUiVersion = "+353830000000";
      await stack.monitor.recordDeviceProbe(odd);
      const served = await profileOf();
      assert.deepEqual(leaks(JSON.stringify(served)), []);
      assert.ok(!JSON.stringify(served).includes("0000000000"), "no long digit run either");
      assert.deepEqual([served?.identity.model, served?.identity.marketingName, served?.identity.softwareVersion, served?.identity.webUiVersion], ["<redacted>", "<redacted>", "<redacted>", "<redacted>"]);
      assert.equal(served?.verification, "unverified-model");
    } finally {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("device report: the console route", () => {
  it("is generated for the console only (403 CONSOLE_ONLY for tokens) and holds nothing of the strict router's identifiers", async () => {
    const cpe = createStrictCpe();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-report-"));
    const env: Record<string, string> = {
      CPE_URL: "http://192.168.8.1",
      CPE_PASSWORD: cpe.password,
      API_TOKEN: "report_console_token",
      API_TOKEN_READONLY: "report_read_token",
      DATA_ENCRYPTION_KEY: "report_data_key",
      WEB_HOST: "127.0.0.1",
      WEB_PORT: "0",
      ALLOWED_HOSTS: "127.0.0.1",
      STATE_FILE: path.join(dir, "data", "state.json"),
      POLL_INTERVAL_MS: "600000",
      NEIGHBOR_SCAN_INTERVAL_MS: "600000",
      SMS_ENABLED: "false",
    };
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n"));
    const stack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await stack.httpServer.listen();
      const base = `http://${bound.host}:${bound.port}`;
      await stack.start();
      for (let i = 0; i < 200 && !stack.monitor.getDeviceProbe(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      await stack.monitor.refreshTelemetry();

      for (const token of ["report_console_token", "report_read_token"]) {
        const denied = await fetch(`${base}/api/console/device-report`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(denied.status, 403);
        assert.equal(((await denied.json()) as { errorCode: string }).errorCode, "CONSOLE_ONLY");
      }

      const login = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base },
        body: JSON.stringify({ password: "report_console_token" }),
      });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const res = await fetch(`${base}/api/console/device-report`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as DeviceReportResponse;
      assert.equal(body.report.verification, "verified");
      assert.equal(body.report.identity?.model, "H168-383");
      assert.equal(body.report.endpoints.length, DEVICE_PROBE_PATHS.length);
      assert.ok(body.report.apiErrors.entries.some((e) => e.path === "/api/net/net-mode-list" && e.code === "100002"), "the strict mock's unsupported endpoints are counted");
      assert.deepEqual(leaks(JSON.stringify(body)), [], "the strict router's WAN addresses stay out");
    } finally {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
