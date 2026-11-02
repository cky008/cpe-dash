import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DeviceProfileResponse } from "../src/api-contract.ts";
import { type FengSuiRuntimeStack, createFengSuiRuntime } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { ConsoleSettings } from "../src/console-settings.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { DEVICE_PROBE_PATHS, type DeviceProbeResult, deviceProfileOf } from "../src/device-profile.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { SettingsHttpRoutes } from "../src/http-settings.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

/**
 * Phase 0 of multi-model support only records: the router is identified once at start and when the
 * console tests or saves a connection, in one read session of the listed GETs, and nothing about the
 * H168-383's login, polling or writes changes. Strict mock router only; nothing leaves the process.
 */

const LOGIN = ["GET /api/user/state-login", "GET /api/monitoring/status", "GET /api/webserver/token", "POST /api/user/challenge_login", "POST /api/user/authentication_login"];
const LOGOUT = "POST /api/user/logout";
const TELEMETRY_GETS = [
  "GET /api/device/signal",
  "GET /api/device/seccellinfo",
  "GET /api/device/ri",
  "GET /api/net/cell-info",
  "GET /api/net/current-plmn",
  "GET /api/net/net-mode",
  "GET /api/device/information",
  "GET /api/device/basic_information",
  "GET /api/monitoring/status",
  "GET /api/monitoring/traffic-statistics",
  "GET /api/monitoring/month_statistics",
  "GET /api/monitoring/start_date",
];
/** Recorded on the strict H168-383 before multi-model support existed (v1.5.0 + logo, caf4282). */
const POLL_SEQUENCES = {
  telemetry: [...LOGIN, ...TELEMETRY_GETS, LOGOUT],
  telemetryWithSms: [...LOGIN, ...TELEMETRY_GETS, "GET /api/sms/sms-count", LOGOUT],
  neighbors: [...LOGIN, "GET /api/device/nbrcellinfo", LOGOUT],
  topology: [...LOGIN, "GET /api/system/HostInfo", "GET /api/system/topology", LOGOUT],
  accessControl: [...LOGIN, "GET /api/wlan/multi-macfilter-settings-ex", "GET /api/wlan/wifi-feature-switch", "GET /api/timerule/timerule", LOGOUT],
};
const PROBE_SESSION = [...LOGIN, ...DEVICE_PROBE_PATHS.map((p) => `GET ${p}`), LOGOUT];

async function waitFor(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200 && !what(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(what(), label);
}

function coreFixture(opts: { password?: string; smsCounters?: boolean; fault?: (p: string, method: string, headers: Headers) => StrictFault | undefined; fetchWrap?: (inner: typeof fetch) => typeof fetch } = {}) {
  const cpe = createStrictCpe({ fault: opts.fault });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-identify-"));
  const stateFile = path.join(dir, "state.json");
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: opts.password ?? cpe.password,
      fetchImpl: opts.fetchWrap ? opts.fetchWrap(cpe.fetchImpl) : cpe.fetchImpl,
    }),
    stateStore: new EncryptedStateStore({ filePath: stateFile, encryptionKey: "identify_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    smsCountersEnabled: opts.smsCounters === true,
  });
  core.monitor.init();
  /** The requests `run` sends, as "METHOD /path". */
  const during = async (run: () => Promise<unknown>): Promise<string[]> => {
    const start = cpe.stats.requests.length;
    await run();
    return cpe.stats.requests.slice(start).map((r) => `${r.method} ${r.path}`);
  };
  return {
    cpe,
    core,
    dir,
    stateFile,
    during,
    cleanup: async () => {
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("device identification on the strict H168-383", () => {
  it("leaves every polling session's requests exactly as they were, before and after identifying", async () => {
    const fx = coreFixture();
    const sms = coreFixture({ smsCounters: true });
    try {
      const polls = async (): Promise<Record<keyof typeof POLL_SEQUENCES, string[]>> => ({
        telemetry: await fx.during(() => fx.core.monitor.refreshTelemetry()),
        telemetryWithSms: await sms.during(() => sms.core.monitor.refreshTelemetry()),
        neighbors: await fx.during(() => fx.core.monitor.refreshNeighbors()),
        topology: await fx.during(() => fx.core.monitor.refreshTopology()),
        accessControl: await fx.during(() => fx.core.monitor.refreshAccessControl()),
      });
      assert.deepEqual(await polls(), POLL_SEQUENCES);
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.ok(await sms.core.monitor.identifyDevice());
      assert.deepEqual(await polls(), POLL_SEQUENCES, "identifying adds nothing to the polls");
    } finally {
      await fx.cleanup();
      await sms.cleanup();
    }
  });

  it("identifies in one read session: one password submission, then only the listed GETs", async () => {
    const fx = coreFixture();
    try {
      const authCalls = fx.cpe.stats.authCalls;
      const writes = fx.cpe.stats.writes.length;
      let probe: DeviceProbeResult | null = null;
      const sent = await fx.during(async () => (probe = await fx.core.monitor.identifyDevice()));
      assert.deepEqual(sent, PROBE_SESSION);
      assert.deepEqual(
        sent.filter((r) => r.startsWith("POST ")),
        ["POST /api/user/challenge_login", "POST /api/user/authentication_login", LOGOUT],
        "no POST but the login handshake and the logout"
      );
      assert.equal(fx.cpe.stats.authCalls - authCalls, 1, "the password went out once");
      assert.equal(fx.cpe.stats.writes.length, writes, "nothing was written");
      assert.equal(fx.cpe.isSlotTaken(), false);

      assert.ok(probe);
      const profile = deviceProfileOf(probe);
      assert.deepEqual(
        [profile.identity.model, profile.identity.softwareVersion, profile.identity.webUiVersion, profile.identity.passwordType, profile.verification, profile.origin],
        ["H168-383", "4.4.0.1(H1006SP19C00)", "WEBUI 4.4.0.1(W2SP24C03)", "4", "verified", "startup"]
      );
      assert.deepEqual([profile.identity.loginScheme, profile.identity.ecc, profile.identity.tokenFlow], ["scram", true, "webserver-token"]);
      const state = Object.fromEntries(profile.capabilities.endpoints.map((e) => [e.path, e.state]));
      assert.equal(state["/api/wlan/wifi-feature-switch"], "supported");
      assert.equal(state["/api/device/device-feature-switch"], "unsupported", "the strict mock answers 100002");

      assert.equal(fx.core.monitor.getDeviceProbe(), probe);
      const reloaded = new EncryptedStateStore({ filePath: fx.stateFile, encryptionKey: "identify_key" });
      assert.deepEqual(reloaded.load().deviceProbe, probe, "kept encrypted across restarts");
    } finally {
      await fx.cleanup();
    }
  });

  it("never probes past a person on the router's page, a latched breaker or a missing password", async () => {
    const fx = coreFixture();
    try {
      fx.cpe.human.loginSameIp();
      assert.deepEqual(await fx.during(async () => assert.equal(await fx.core.monitor.identifyDevice(), null)), ["GET /api/user/state-login"]);
      fx.cpe.human.loginCrossIp();
      const authCalls = fx.cpe.stats.authCalls;
      const crossIp = await fx.during(async () => assert.equal(await fx.core.monitor.identifyDevice(), null));
      assert.equal(fx.cpe.stats.authCalls, authCalls, "no password was submitted");
      assert.ok(!crossIp.some((r) => DEVICE_PROBE_PATHS.some((p) => r === `GET ${p}` && p !== "/api/user/state-login")), crossIp.join());
      assert.equal(fx.core.monitor.getDeviceProbe(), null);
    } finally {
      await fx.cleanup();
    }

    const wrong = coreFixture({ password: "not_the_router_password" });
    try {
      await assert.rejects(wrong.core.monitor.refreshTelemetry());
      assert.equal(wrong.core.scheduler.isCircuitTripped(), true);
      assert.deepEqual(await wrong.during(async () => assert.equal(await wrong.core.monitor.identifyDevice(), null)), [], "a latched breaker sends nothing");
    } finally {
      await wrong.cleanup();
    }

    const unset = coreFixture({ password: "" });
    try {
      assert.deepEqual(await unset.during(async () => assert.equal(await unset.core.monitor.identifyDevice(), null)), []);
    } finally {
      await unset.cleanup();
    }
  });

  it("identifies right after the first read that gets in when the start had to step aside for a person", async () => {
    const fx = coreFixture();
    try {
      fx.cpe.human.loginSameIp();
      assert.deepEqual(await fx.during(async () => assert.equal(await fx.core.monitor.identifyDevice(), null)), ["GET /api/user/state-login"]);
      assert.deepEqual(await fx.during(() => fx.core.monitor.refreshTelemetry()), ["GET /api/user/state-login"], "nothing more while the person stays");

      fx.cpe.human.logout();
      const authCalls = fx.cpe.stats.authCalls;
      const sent = await fx.during(async () => {
        await fx.core.monitor.refreshTelemetry();
        await waitFor(() => fx.core.monitor.getDeviceProbe() !== null, "identified after the person left");
      });
      assert.deepEqual(sent, [...POLL_SEQUENCES.telemetry, ...PROBE_SESSION], "the identification is the very next session");
      assert.equal(fx.cpe.stats.authCalls - authCalls, 2, "one password submission per session");
      assert.equal(fx.core.monitor.getDeviceProbe()?.origin, "startup");
      assert.deepEqual(await fx.during(() => fx.core.monitor.refreshTelemetry()), POLL_SEQUENCES.telemetry, "and only once");
    } finally {
      await fx.cleanup();
    }
  });

  it("identifies right after the first read that gets in once a latched breaker is reset, sending nothing while it is latched", async () => {
    const fx = coreFixture({ password: "not_the_router_password" });
    try {
      await assert.rejects(fx.core.monitor.refreshTelemetry());
      assert.deepEqual(await fx.during(async () => assert.equal(await fx.core.monitor.identifyDevice(), null)), []);
      assert.deepEqual(await fx.during(() => fx.core.monitor.refreshTelemetry()), [], "a latched breaker sends nothing");
      assert.equal(fx.cpe.stats.authCalls, 1, "the wrong password went out once");

      await fx.core.scheduler.reloadCredentialsAndResetBreaker(fx.cpe.password);
      const sent = await fx.during(async () => {
        await fx.core.monitor.refreshTelemetry();
        await waitFor(() => fx.core.monitor.getDeviceProbe() !== null, "identified after the reset");
      });
      assert.deepEqual(sent, [...POLL_SEQUENCES.telemetry, ...PROBE_SESSION]);
      assert.deepEqual(await fx.during(() => fx.core.monitor.refreshTelemetry()), POLL_SEQUENCES.telemetry);
    } finally {
      await fx.cleanup();
    }
  });

  it("owes nothing more once a connection test of the router in use has identified it", async () => {
    const fx = coreFixture();
    try {
      fx.cpe.human.loginSameIp();
      assert.equal(await fx.core.monitor.identifyDevice(), null);
      fx.cpe.human.logout();
      const { probe } = await fx.core.scheduler.testConnectionDetailed({ url: "http://192.168.8.1", username: "admin", password: fx.cpe.password });
      assert.ok(probe);
      await fx.core.monitor.recordDeviceProbe(probe);
      assert.deepEqual(await fx.during(() => fx.core.monitor.refreshTelemetry()), POLL_SEQUENCES.telemetry);
      assert.equal(fx.core.monitor.getDeviceProbe(), probe);
    } finally {
      await fx.cleanup();
    }
  });

  it("stops catching up after three failed identifications in a row", async () => {
    // Odd logins fail before the password goes out (no answer), even ones work: every poll gets in,
    // every identification after it fails
    let challenges = 0;
    const fx = coreFixture({ fault: (p, method) => (p === "/api/user/challenge_login" && method === "POST" && ++challenges % 2 === 1 ? "transport" : undefined) });
    try {
      await assert.rejects(fx.core.monitor.identifyDevice());
      for (let failed = 2; failed <= 3; failed++) {
        await fx.core.monitor.refreshTelemetry();
        await waitFor(() => challenges === failed * 2 - 1, `identification attempt ${failed}`);
      }
      const last = await fx.during(async () => {
        await fx.core.monitor.refreshTelemetry();
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      assert.deepEqual(last, POLL_SEQUENCES.telemetry, "no fourth attempt");
      assert.equal(challenges, 6);
      assert.equal(fx.core.monitor.getDeviceProbe(), null);
      assert.equal(fx.cpe.stats.authCalls, 3, "only the polls submitted the password");
    } finally {
      await fx.cleanup();
    }
  });

  it("identifies again when the console tests the live router or saves a connection, never for another router", async () => {
    const fx = coreFixture();
    const settings = new ConsoleSettings({ filePath: path.join(fx.dir, "settings.json"), cipher: new StorageCipher("identify_key"), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
    settings.importFromEnv({ cpeUrl: "http://192.168.8.1", cpeUsername: "admin", cpePassword: fx.cpe.password, apiToken: "t0ken_for_identify", apiTokenReadonly: "" });
    const routes = new SettingsHttpRoutes({
      settings,
      scheduler: fx.core.scheduler,
      audit: null,
      metricsFromEnv: false,
      telegramConfigured: false,
      onConnectionReady: () => undefined,
      revokeSessions: () => undefined,
      disconnectToken: () => undefined,
      unlinkTelegram: () => 0,
      onDeviceProbe: (probe) => void fx.core.monitor.recordDeviceProbe(probe),
    });
    const post = async (pathname: string, body: Record<string, unknown>) => {
      let status = 0;
      await routes.handle({ method: "POST", pathname, query: Object.create(null) as Record<string, string>, readJsonBody: async () => body, sendJson: (code) => void (status = code) }, "session-1");
      return status;
    };
    try {
      const sent = await fx.during(() => post("/api/console/cpe/test", {}));
      assert.ok(DEVICE_PROBE_PATHS.every((p) => sent.includes(`GET ${p}`)), "the connection test runs the same probe");
      const tested = fx.core.monitor.getDeviceProbe();
      assert.equal(tested?.origin, "connection-test");
      assert.equal(tested?.identity.model, "H168-383");

      assert.equal(await post("/api/console/cpe/test", { url: "http://192.168.9.1", password: fx.cpe.password }), 200);
      assert.equal(fx.core.monitor.getDeviceProbe(), tested, "a test of another address leaves the profile alone");
      assert.equal(await post("/api/console/cpe/test", { password: "a wrong guess" }), 200);
      assert.equal(fx.core.monitor.getDeviceProbe(), tested, "a failed test records nothing");

      assert.equal(await post("/api/console/cpe", { url: "http://192.168.9.1", password: fx.cpe.password }), 200);
      const saved = fx.core.monitor.getDeviceProbe();
      assert.notEqual(saved, tested, "saving a connection keeps the profile its test found");
      assert.equal(saved?.origin, "connection-test");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the connection test's verdict, and still identifies, when an endpoint's answer cannot be read", async () => {
    const tooBig = `<response><x>${"a".repeat(2 * 1024 * 1024)}</x></response>`;
    /** Headers arrive, then the router drops the connection mid-answer. */
    const cutOff = (): Response => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) {
            controller.error(new TypeError("terminated"));
            return;
          }
          sent = true;
          controller.enqueue(new TextEncoder().encode("<response><a>"));
        },
      });
      return new Response(body, { status: 200 });
    };
    const fx = coreFixture({
      fault: (p, method) => {
        if (method !== "GET") return undefined;
        if (p === "/api/system/devcapacity") return { body: tooBig };
        if (p === "/api/device/basicinformation") return { body: "<error><code>ERR</code><message></message></error>" };
        return undefined;
      },
      fetchWrap: (inner) => async (input, init) => (String(input).endsWith("/api/global/module-switch") ? cutOff() : inner(input, init)),
    });
    try {
      const authCalls = fx.cpe.stats.authCalls;
      const { result, probe } = await fx.core.scheduler.testConnectionDetailed({ url: "http://192.168.8.1", username: "admin", password: fx.cpe.password });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(fx.cpe.stats.authCalls - authCalls, 1, "the password went out once");
      assert.equal(fx.cpe.isSlotTaken(), false);
      const unreadable = (found: DeviceProbeResult | null) =>
        found?.endpoints.filter((e) => e.state === "unknown").map((e) => `${e.path} ${e.code}`);
      const expected = ["/api/device/basicinformation null", "/api/system/devcapacity null", "/api/global/module-switch null"];
      assert.deepEqual(unreadable(probe), expected);
      assert.equal(probe?.identity.model, "H168-383");

      const identified = await fx.core.monitor.identifyDevice();
      assert.deepEqual(unreadable(identified), expected, "identification at start completes too");
      const status = fx.core.scheduler.getStatus();
      assert.deepEqual([status.mode, status.lastError], ["idle", null], "an unreadable answer is no unreachable router");
    } finally {
      await fx.cleanup();
    }
  });

  it("lists the probe's GETs in the protocol spec", () => {
    const spec = fs.readFileSync("docs/PHASE1_PROTOCOL_SPEC.md", "utf8");
    const section = spec.slice(spec.indexOf("### A.7"));
    assert.ok(section.length > 0 && spec.includes("### A.7"));
    for (const p of DEVICE_PROBE_PATHS) assert.ok(section.includes(`\`GET ${p}\``), p);
  });
});

describe("router error counts and login facts", () => {
  it("counts router error codes per endpoint, connection tests included", async () => {
    const flags = { failStateLogin: false };
    const fx = coreFixture({ fault: (p, method) => (p === "/api/user/state-login" && method === "GET" && flags.failStateLogin ? { cpeError: "100004" } : undefined) });
    try {
      await fx.core.monitor.identifyDevice();
      const codes = (): string[] => fx.core.scheduler.apiErrorSnapshot().entries.map((e) => `${e.method} ${e.path} ${e.code} ×${e.count}`);
      assert.ok(codes().includes("GET /api/device/device-feature-switch 100002 ×1"), codes().join("\n"));
      assert.ok(codes().includes("GET /api/global/module-switch 100002 ×1"));
      const test = await fx.core.scheduler.testConnection({ url: "http://192.168.8.1", username: "admin", password: "a wrong guess" });
      assert.equal(test.ok, false);
      assert.ok(codes().includes("POST /api/user/authentication_login 108006 ×1"), "the throwaway client shares the tally");
      flags.failStateLogin = true;
      await assert.rejects(fx.core.scheduler.probeLoginState());
      assert.ok(codes().includes("GET /api/user/state-login 100004 ×1"), "login-free reads count too");
    } finally {
      await fx.cleanup();
    }
  });

  it("reports how a session logged in: SCRAM, the token from webserver/token, ECC only when signed", async () => {
    const facts = async (fetchWrap?: (inner: typeof fetch) => typeof fetch) => {
      const fx = coreFixture({ fetchWrap });
      try {
        return await fx.core.scheduler.executeRead(async (session) => [session.loginScheme, session.tokenFlow, session.eccVerified, session.ecc !== null]);
      } finally {
        await fx.cleanup();
      }
    };
    assert.deepEqual(await facts(), ["scram", "webserver-token", true, true]);
    const unsigned = (inner: typeof fetch): typeof fetch => async (input, init) => {
      const res = await inner(input, init);
      if (!String(input).endsWith("/api/user/authentication_login")) return res;
      const body = (await res.text()).replace(/<ecc_pubkey_signature>[^<]*<\/ecc_pubkey_signature>/, "");
      return new Response(body, { status: res.status, headers: res.headers });
    };
    assert.deepEqual(await facts(unsigned), ["scram", "webserver-token", false, true], "an unsigned key is used but not counted as verified");
  });
});

async function startRuntime(env: Record<string, string>) {
  const cpe = createStrictCpe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-identify-rt-"));
  const values: Record<string, string> = {
    CPE_URL: "http://192.168.8.1",
    DATA_ENCRYPTION_KEY: "identify_data_key",
    WEB_HOST: "127.0.0.1",
    WEB_PORT: "0",
    ALLOWED_HOSTS: "127.0.0.1",
    STATE_FILE: path.join(dir, "data", "state.json"),
    POLL_INTERVAL_MS: "600000",
    NEIGHBOR_SCAN_INTERVAL_MS: "600000",
    SMS_ENABLED: "false",
    ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.replace("{ROUTER}", cpe.password)])),
  };
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"));
  const logs: string[] = [];
  const stack: FengSuiRuntimeStack = createFengSuiRuntime({ config: loadConfig({ envPath, ignoreProcessEnv: true }), envPath, fetchImpl: cpe.fetchImpl, log: (line) => logs.push(line) });
  const bound = await stack.httpServer.listen();
  const base = `http://${bound.host}:${bound.port}`;
  const post = (p: string, body: unknown, cookie = "") =>
    fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const get = (p: string, token: string) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  const waitFor = async (what: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 200 && !what(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(what(), label);
  };
  return {
    cpe,
    stack,
    logs,
    post,
    get,
    waitFor,
    cleanup: async () => {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("device identification in the daemon", () => {
  it("identifies once at start, not on later polls, and serves GET /api/device/profile to any signed-in caller", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "identify_full_token", API_TOKEN_READONLY: "identify_read_token" });
    try {
      const empty = (await (await fx.get("/api/device/profile", "identify_read_token")).json()) as DeviceProfileResponse;
      assert.deepEqual(empty, { ok: true, profile: null, verifiedFirmware: [{ model: "H168-383", softwareVersion: "4.4.0.1(H1006SP19C00)" }] });

      await fx.stack.start();
      await fx.waitFor(() => fx.stack.monitor.getDeviceProbe() !== null, "identified after the start");
      await fx.stack.monitor.refreshTelemetry();
      await fx.stack.monitor.refreshTopology();
      assert.equal(fx.cpe.count("/api/device/device-feature-switch"), 1, "once, at the start");
      assert.equal(fx.cpe.count("/api/net/net-mode-list"), 1);

      for (const token of ["identify_read_token", "identify_full_token"]) {
        const res = await fx.get("/api/device/profile", token);
        assert.equal(res.status, 200);
        const body = (await res.json()) as DeviceProfileResponse;
        assert.deepEqual([body.profile?.identity.model, body.profile?.verification, body.profile?.origin], ["H168-383", "verified", "startup"]);
        assert.equal(JSON.stringify(body).includes("observations"), false, "the structure stays in the console's report");
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("catches up on the identification a start missed because someone was on the router's page", async () => {
    const fx = await startRuntime({ CPE_PASSWORD: "{ROUTER}", API_TOKEN: "identify_full_token" });
    try {
      fx.cpe.human.loginSameIp();
      await fx.stack.start();
      // The first polls and the identification each check once, and step aside
      await fx.waitFor(() => fx.cpe.stats.stateLoginChecks >= 4, "the start stepped aside");
      assert.equal(fx.stack.monitor.getDeviceProbe(), null);
      assert.equal(fx.cpe.count("/api/device/device-feature-switch"), 0);

      fx.cpe.human.logout();
      await fx.stack.monitor.refreshTelemetry();
      await fx.waitFor(() => fx.stack.monitor.getDeviceProbe() !== null, "identified once the person left");
      assert.equal(fx.stack.monitor.getDeviceProbe()?.origin, "startup");
      await fx.stack.monitor.refreshTelemetry();
      assert.equal(fx.cpe.count("/api/device/device-feature-switch"), 1, "once");
    } finally {
      await fx.cleanup();
    }
  });

  it("does not identify twice when the first connection is saved during the setup", async () => {
    const fx = await startRuntime({});
    try {
      await fx.stack.start();
      assert.equal(fx.stack.awaitingSetup(), true);
      const code = /setup code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(fx.logs.join("\n"))?.[1] ?? "";
      const setup = await fx.post("/api/setup/login", { code, password: "a long console passphrase" });
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(setup.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      assert.equal((await fx.post("/api/console/cpe", { url: "http://192.168.8.1", password: fx.cpe.password }, cookie)).status, 200);
      await fx.waitFor(() => fx.cpe.stats.logins >= 2, "polling started");
      await fx.stack.monitor.refreshTelemetry();
      assert.equal(fx.stack.monitor.getDeviceProbe()?.origin, "connection-test");
      assert.equal(fx.cpe.count("/api/device/device-feature-switch"), 1, "the save's test identified; the start of polling did not again");
    } finally {
      await fx.cleanup();
    }
  });
});
