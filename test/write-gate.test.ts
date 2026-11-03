import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createFengSuiRuntime, startServeDaemon } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { CONTROL_FEATURES, type ControlAction, type DeviceAccessSnapshot } from "../src/device-access.ts";
import type { DeviceProbeResult } from "../src/device-profile.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { type ControlAuditEvent, DeviceNotIdentifiedError, DeviceReadOnlyError } from "../src/scheduler.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type FamilySms, createCpeFamily } from "./helpers/cpe-family.ts";
import { type StrictFault, createStrictCpe } from "./helpers/strict-cpe.ts";

/**
 * Multi-model phase 2: a router that is not a verified model is read-only, enforced in the scheduler
 * (`executeControl`), the one door every write goes through. Each write path is tried and the mock
 * must receive no write. The gate trusts only a model seen in this run; a model stored by an earlier
 * run refuses at once when it names an unverified model, and otherwise the write reads the model in
 * its own session first. Mocks and placeholders only, no network.
 */

const MAILBOX: ReadonlyArray<FamilySms> = [
  { index: 40001, phone: "+353830000001", content: "Dinner at 7?", date: "2026-11-02 18:00:00", smstat: "0", box: 1 },
  { index: 40002, phone: "DemoBank", content: "Your DemoBank code is 482913", date: "2026-11-02 19:00:00", smstat: "1", box: 1 },
  { index: 39001, phone: "+353830000001", content: "See you there", date: "2026-11-02 18:05:00", smstat: "3", box: 2 },
];

function storedProbe(model: string): DeviceProbeResult {
  const at = "2026-11-02T10:00:00.000Z";
  return {
    identity: { model, marketingName: null, softwareVersion: "1.0.0.1", webUiVersion: null, passwordType: "4", loginScheme: "scram", ecc: false, tokenFlow: "webserver-token", detectedAtIso: at },
    endpoints: [],
    lteBands: null,
    probedAtIso: at,
    origin: "startup",
    observations: [],
  };
}

function gateFixture(cpe: { fetchImpl: typeof fetch; password: string }, opts: { stored?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-gate-"));
  const stateStore = new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "gate_key" });
  // What an earlier run stored (no file yet, so init() keeps it, as after a restart)
  if (opts.stored) stateStore.update({ deviceProbe: storedProbe(opts.stored) });
  const core = createFengSuiCore({
    client: new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 }),
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("gate_key");
  const contacts = new ContactBook({ filePath: path.join(dir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(dir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({ scheduler: core.scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
  const audits: ControlAuditEvent[] = [];
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  return {
    core,
    sms,
    audits,
    cleanup: async () => {
      await sms.stop();
      await stopFengSuiCore(core);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof gateFixture>;

/** Every write the scheduler runs, through the service an adapter calls (REST, MCP, Telegram, self-heal). */
const WRITES: ReadonlyArray<[ControlAction, (fx: Fixture) => Promise<unknown>]> = [
  ["lock_band", (fx) => fx.core.controls.lockBands({ lteBands: [1, 3] })],
  ["lock_cell", (fx) => fx.core.controls.lockCell({ rat: "LTE", band: 1, arfcn: 100, pci: 1 })],
  ["unlock_rf_locks", (fx) => fx.core.controls.unlockAllLocks()],
  ["auto_unlock_rf_locks", (fx) => fx.core.controls.rollBackLocks()],
  ["reboot_cpe", (fx) => fx.core.controls.rebootRouter({ confirm: true })],
  ["reconnect_cellular", (fx) => fx.core.controls.reconnectCellular()],
  ["auto_reconnect_cellular", (fx) => fx.core.controls.reconnectWan()],
  ["set_security_switches", (fx) => fx.core.controls.setSecuritySwitches({ upnpEnabled: false })],
  ["set_wifi7_mlo", (fx) => fx.core.controls.setWifi7Settings({ mloEnable: false })],
  ["set_antenna_mode", (fx) => fx.core.controls.setAntennaMode("auto")],
  ["set_mobile_data", (fx) => fx.core.controls.setMobileData(false)],
  ["set_wifi_access", (fx) => fx.core.controls.setWifiAccess({ kind: "block", macAddress: "02:00:5E:10:00:03", name: "phone" }, { requesterIp: null, confirm: true })],
  [
    "manage_time_rule",
    (fx) =>
      fx.core.controls.manageTimeRule(
        { kind: "create", rule: { macAddress: "02:00:5E:10:00:03", name: "phone", weekMask: "1111100", startTime: "07:00", endTime: "21:00" } },
        { requesterIp: null, confirm: true }
      ),
  ],
  ["sms_send", (fx) => fx.sms.send({ phones: ["+353830000001"], content: "gate check", source: "web" })],
  ["sms_mark_read", (fx) => fx.sms.markRead({ uids: fx.sms.mirror.list().filter((m) => m.isUnread).map((m) => m.uid) })],
  ["sms_delete", (fx) => fx.sms.deleteMessages({ uids: fx.sms.mirror.list().slice(0, 1).map((m) => m.uid) })],
];

/** The gate's part of the status (the read sections have tests of their own). */
const gateOf = ({ model, verification, confirmed, writes }: DeviceAccessSnapshot) => ({ model, verification, confirmed, writes });

const refusedFor = (action: ControlAction, model: string) => (err: unknown) =>
  err instanceof DeviceReadOnlyError && err.feature === CONTROL_FEATURES[action] && err.model === model && err.statusCode === 409 && /H168-383/.test(err.message);

describe("write gate: unverified models are read-only", () => {
  it("covers every write the scheduler runs", () => {
    assert.deepEqual(WRITES.map(([action]) => action).sort(), Object.keys(CONTROL_FEATURES).sort());
  });

  it("refuses every write on an identified unverified model before any session: the router gets no write", async () => {
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", sms: MAILBOX });
    const fx = gateFixture(cpe);
    try {
      assert.ok(await fx.core.monitor.identifyDevice());
      assert.ok(await fx.sms.sync("full"), "reading SMS stays allowed");
      assert.ok(fx.sms.mirror.list().some((m) => m.isUnread));
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "H122-373", verification: "unverified-model", confirmed: true, writes: "read_only" });
      const sent = cpe.stats.requests.length;
      for (const [action, run] of WRITES) await assert.rejects(run(fx), refusedFor(action, "H122-373"), action);
      assert.deepEqual(cpe.stats.writes, [], "no write request reached the router");
      assert.equal(cpe.stats.requests.length, sent, "refused before a session: not even a login");
      assert.deepEqual(
        fx.audits.map((a) => [a.action, a.outcome]),
        WRITES.map(([action]) => [action, "refused"]),
        "every refusal is audited"
      );
      assert.ok(fx.sms.mirror.list().some((m) => m.isUnread), "a refused mark-read leaves the mirror as it was");
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses at once after a restart when the stored identification names an unverified model", async () => {
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token" });
    const fx = gateFixture(cpe, { stored: "B535-232" });
    try {
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "B535-232", verification: "unverified-model", confirmed: false, writes: "read_only" });
      await assert.rejects(fx.core.controls.unlockAllLocks(), refusedFor("unlock_rf_locks", "B535-232"));
      assert.deepEqual([cpe.stats.requests.length, cpe.stats.writes.length], [0, 0], "no session for a router known to be read-only");
    } finally {
      await fx.cleanup();
    }
  });

  it("reads the model in the write's own session when this run has not seen it, then writes on the H168-383 as before", async () => {
    const cpe = createStrictCpe();
    const fx = gateFixture(cpe);
    try {
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: null, verification: "unknown", confirmed: false, writes: "unknown" });
      await fx.core.controls.lockBands({ lteBands: [1, 3] });
      const first = cpe.stats.requests.map((r) => `${r.method} ${r.path}`);
      const read = first.indexOf("GET /api/device/information");
      assert.ok(read > first.indexOf("POST /api/user/authentication_login") && read < first.indexOf("POST /api/net/net-mode"), "read after the login, before the write");
      assert.equal(first.filter((r) => r === "GET /api/device/information").length, 1);
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "H168-383", verification: "verified", confirmed: true, writes: "allowed" });
      const before = cpe.stats.requests.length;
      await fx.core.controls.unlockAllLocks();
      assert.equal(cpe.stats.requests.slice(before).filter((r) => r.path === "/api/device/information").length, 0, "seen once, not read again");
    } finally {
      await fx.cleanup();
    }
    // After a poll the write needs no read of its own (test/h168-wire.test.ts pins the exact requests)
    const polled = createStrictCpe();
    const fy = gateFixture(polled);
    try {
      assert.ok(await fy.core.monitor.refreshTelemetry());
      const before = polled.stats.requests.length;
      await fy.core.controls.lockBands({ lteBands: [1, 3] });
      assert.equal(polled.stats.requests.slice(before).filter((r) => r.path === "/api/device/information").length, 0);
    } finally {
      await fy.cleanup();
    }
  });

  it("does not let a stale identification through: a router replaced while the daemon was down gets no write", async () => {
    // The stored identification says H168-383, but another model now answers with the same password
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token" });
    const fx = gateFixture(cpe, { stored: "H168-383" });
    const changed: unknown[] = [];
    fx.core.scheduler.on("device:changed", (snap: unknown) => changed.push(snap));
    try {
      assert.equal(fx.core.scheduler.getStatus().device.writes, "allowed", "likely, not yet confirmed");
      await assert.rejects(fx.core.controls.setMobileData(false), refusedFor("set_mobile_data", "H122-373"));
      assert.deepEqual(cpe.stats.writes, []);
      assert.equal(cpe.count("/api/device/information", "GET"), 1);
      assert.deepEqual(changed.map((snap) => gateOf(snap as DeviceAccessSnapshot)), [{ model: "H122-373", verification: "unverified-model", confirmed: true, writes: "read_only" }], "owed a new identification");
      const sent = cpe.stats.requests.length;
      await assert.rejects(fx.core.controls.setMobileData(false), refusedFor("set_mobile_data", "H122-373"));
      assert.equal(cpe.stats.requests.length, sent, "known now: refused without a session");
    } finally {
      await fx.cleanup();
    }
  });

  it("looks at the model again inside the write's session: a read that sees another model just before cannot let it through", async () => {
    // The read that first sees the model notes it after its session ends, when the write queued
    // behind it has already left the queue past the gate's first look
    const telemetry: Record<string, string> = {
      "/api/device/signal": "<response><rsrp>-97dBm</rsrp><sinr>11dB</sinr><mode>7</mode></response>",
      "/api/monitoring/traffic-statistics": "<response><CurrentDownloadRate>0</CurrentDownloadRate><CurrentUploadRate>0</CurrentUploadRate></response>",
      "/api/monitoring/month_statistics": "<response><CurrentMonthDownload>0</CurrentMonthDownload><CurrentMonthUpload>0</CurrentMonthUpload></response>",
    };
    for (const stored of [undefined, "H168-383"]) {
      for (const read of ["identification", "poll"] as const) {
        const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", endpoints: telemetry });
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let holding = true;
        const fetchImpl: typeof fetch = async (input, init) => {
          // The read's session waits here until the write is queued behind it
          if (holding && new URL(String(input)).pathname === "/api/device/information") {
            holding = false;
            await held;
          }
          return await cpe.fetchImpl(input, init);
        };
        const fx = gateFixture({ fetchImpl, password: cpe.password }, { stored });
        const what = `${stored ?? "nothing"} stored, ${read} in flight`;
        try {
          const reading = read === "identification" ? fx.core.monitor.identifyDevice() : fx.core.monitor.refreshTelemetry();
          while (holding) await new Promise((resolve) => setImmediate(resolve));
          const refused = assert.rejects(fx.core.controls.setMobileData(false), refusedFor("set_mobile_data", "B535-232"), what);
          release();
          assert.ok(await reading, what);
          await refused;
          assert.deepEqual(cpe.stats.writes, [], `${what}: no write reached the router`);
          assert.equal(fx.audits.at(-1)?.outcome, "refused", what);
        } finally {
          await fx.cleanup();
        }
      }
    }
  });

  it("confirms the model again after losing sight of the router, and refuses a write that cannot read it", async () => {
    let fault: StrictFault | undefined;
    let identityFault: StrictFault | undefined;
    const cpe = createStrictCpe({
      fault: (p, method) => {
        if (method === "GET" && (p === "/api/device/information" || p === "/api/device/basic_information")) return identityFault;
        return p === "/api/device/signal" ? fault : undefined;
      },
    });
    const fx = gateFixture(cpe);
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, true);
      fault = "transport";
      await assert.rejects(fx.core.monitor.refreshTelemetry());
      assert.equal(fx.core.scheduler.getStatus().mode, "cpe_unreachable");
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "H168-383", verification: "verified", confirmed: false, writes: "allowed" });
      fault = undefined;

      // Out of sight, then back: the write reads the model first, and nothing gets written without one
      identityFault = { cpeError: "100002" };
      const writesBefore = cpe.stats.writes.length;
      await assert.rejects(fx.core.controls.setAntennaMode("auto"), (err: unknown) => err instanceof DeviceNotIdentifiedError && err.statusCode === 409);
      assert.equal(cpe.stats.writes.length, writesBefore, "no write without a model");
      assert.equal(fx.core.scheduler.getStatus().mode, "idle", "the router answered: not unreachable");
      assert.deepEqual(fx.audits.at(-1)?.outcome, "refused");

      // basic_information names the model when device/information does not
      identityFault = undefined;
      const basicOnly = createStrictCpe({ fault: (p, method) => (method === "GET" && p === "/api/device/information" ? { cpeError: "100003" } : undefined) });
      const fy = gateFixture(basicOnly);
      try {
        await fy.core.controls.setAntennaMode("auto");
        assert.deepEqual([basicOnly.count("/api/device/basic_information", "GET"), basicOnly.stats.writes.map((w) => w.path)], [1, ["/api/device/antenna_set_type"]]);
      } finally {
        await fy.cleanup();
      }
    } finally {
      await fx.cleanup();
    }
  });

  it("confirms the model again after a spell of sending nothing: peer standby, an open breaker that was reset, a quiet window", async () => {
    // Swapped while this daemon sent nothing, for a model with the same admin password: the write
    // that comes first afterwards, before any poll, must look at the router again
    for (const spell of ["peer standby", "open breaker", "quiet window"] as const) {
      let locked = false;
      const h168 = createStrictCpe({ fault: (p) => (locked && p === "/api/user/authentication_login" ? { cpeError: "108007" } : undefined) });
      const other = createCpeFamily({ login: "scram", tokenFlow: "token", model: "B535-232", password: h168.password });
      let router: typeof fetch = h168.fetchImpl;
      const fx = gateFixture({ fetchImpl: async (input, init) => await router(input, init), password: h168.password });
      try {
        assert.ok(await fx.core.monitor.refreshTelemetry());
        assert.equal(fx.core.scheduler.getStatus().device.confirmed, true, spell);
        if (spell === "peer standby") {
          fx.core.scheduler.setPeerStandby("192.168.8.2");
          router = other.fetchImpl;
          fx.core.scheduler.setPeerStandby(null);
        } else if (spell === "quiet window") {
          // Someone on the router's page from another device: the reads leave the router alone for 45 s or more
          h168.human.loginCrossIp();
          assert.equal(await fx.core.monitor.refreshTelemetry(), null);
          assert.equal(fx.core.scheduler.getAvoidanceState().layer, 2);
          router = other.fetchImpl;
          assert.equal(await fx.core.monitor.refreshTelemetry(), null, "the quiet window holds: the read sends nothing");
          assert.equal(other.stats.requests.length, 0);
        } else {
          locked = true;
          await assert.rejects(fx.core.monitor.refreshTelemetry());
          assert.equal(fx.core.scheduler.isCircuitTripped(), true);
          router = other.fetchImpl;
          // 108007 may be reset with the same password once the router's lock has expired
          await fx.core.scheduler.reloadCredentialsAndResetBreaker(h168.password);
        }
        assert.equal(fx.core.scheduler.getStatus().device.confirmed, false, `${spell}: out of sight`);
        await assert.rejects(fx.core.controls.setMobileData(false), refusedFor("set_mobile_data", "B535-232"), spell);
        assert.deepEqual(other.stats.writes, [], `${spell}: no write reached the other router`);
      } finally {
        await fx.cleanup();
      }
    }
  });

  it("keeps the model it saw when the router answers something it cannot read: the router is there", async () => {
    let odd = false;
    const cpe = createStrictCpe({ fault: (p, method) => (odd && method === "GET" && p === "/api/security/upnp" ? { body: "<response></response>" } : undefined) });
    const fx = gateFixture(cpe);
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      odd = true;
      await assert.rejects(fx.core.monitor.refreshSettings(), /without <UpnpStatus>/);
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, true, "answered, so not out of sight");
      odd = false;
      const before = cpe.stats.requests.length;
      await fx.core.controls.setMobileData(false);
      assert.equal(cpe.stats.requests.slice(before).filter((r) => r.path === "/api/device/information").length, 0, "no extra read before the write");
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps writing to a verified model on a new firmware (ADR-007 only warns)", async () => {
    const cpe = createStrictCpe({
      fault: (p, method) =>
        method === "GET" && p === "/api/device/information"
          ? { body: "<response><DeviceName>H168-383</DeviceName><SoftwareVersion>4.4.0.9(H1006SP99C00)</SoftwareVersion></response>" }
          : undefined,
    });
    const fx = gateFixture(cpe);
    try {
      assert.ok(await fx.core.monitor.refreshTelemetry());
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "H168-383", verification: "new-firmware", confirmed: true, writes: "allowed" });
      await fx.core.controls.setMobileData(false);
      assert.deepEqual(cpe.stats.writes.map((w) => w.path), ["/api/dialup/mobile-dataswitch"]);
    } finally {
      await fx.cleanup();
    }
  });
});

describe("write gate over REST: every control and SMS write route answers 409 on an unverified model", () => {
  it("refuses each route, and the router gets no write", async () => {
    const cpe = createCpeFamily({ login: "scram", tokenFlow: "token", sms: MAILBOX });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-gate-rest-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "# write gate test\n", { mode: 0o600 });
    const config = loadConfig({
      envPath,
      ignoreProcessEnv: true,
      overrides: {
        CPE_URL: "http://192.168.8.1",
        CPE_PASSWORD: cpe.password,
        DATA_ENCRYPTION_KEY: "gate_rest_data_key",
        API_TOKEN: "gate_rest_api_token",
        WEB_HOST: "127.0.0.1",
        WEB_PORT: "0",
        ALLOWED_HOSTS: "127.0.0.1",
        STATE_FILE: path.join(dir, "data", "state.json"),
        STATIC_DIR: path.join(dir, "no-static"),
        POLL_INTERVAL_MS: "600000",
        NEIGHBOR_SCAN_INTERVAL_MS: "600000",
      },
    });
    const stack = createFengSuiRuntime({ config: { ...config, peerDiscoveryEnabled: false }, envPath, fetchImpl: cpe.fetchImpl, log: () => undefined });
    try {
      const bound = await startServeDaemon(stack);
      assert.ok(bound);
      const base = `http://${bound.host}:${bound.port}`;
      const headers = { Authorization: "Bearer gate_rest_api_token", "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" };
      const get = async (p: string): Promise<Record<string, unknown>> => (await (await fetch(`${base}${p}`, { headers })).json()) as Record<string, unknown>;
      const deadline = Date.now() + 5000;
      while (((await get("/api/session/status"))["status"] as { device: { writes: string } }).device.writes !== "read_only") {
        assert.ok(Date.now() < deadline, "the daemon identifies the router after it starts");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const synced = await fetch(`${base}/api/sms/sync`, { method: "POST", headers, body: JSON.stringify({ mode: "full" }) });
      assert.equal(synced.status, 200);
      const messages = stack.sms?.mirror.list() ?? [];
      const unread = messages.filter((m) => m.isUnread).map((m) => m.uid);
      assert.ok(unread.length > 0);

      const routes: ReadonlyArray<[string, unknown]> = [
        ["/api/control/band-lock", { lteBands: ["B1", "B3"] }],
        ["/api/control/cell-lock", { rat: "LTE", band: "B1", arfcn: 100, pci: 1 }],
        ["/api/control/unlock", {}],
        ["/api/control/reboot", { confirm: true }],
        ["/api/control/reconnect", { confirm: true }],
        ["/api/control/security", { upnpEnabled: false }],
        ["/api/control/wifi7", { mloEnable: false }],
        ["/api/control/antenna", { mode: "auto" }],
        ["/api/control/mobile-data", { enabled: false }],
        ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:03", confirm: true }],
        ["/api/control/wifi-mac-filter", { mode: "off", confirm: true }],
        ["/api/control/time-rule", { action: "create", rule: { macAddress: "02:00:5E:10:00:03", weekMask: "1111100", startTime: "07:00", endTime: "21:00" }, confirm: true }],
        ["/api/sms/send", { phone: "+353830000001", content: "gate check" }],
        ["/api/sms/read", { uids: unread }],
        ["/api/sms/delete", { uids: messages.slice(0, 1).map((m) => m.uid) }],
      ];
      // A new control route has to be added here
      const served = [...fs.readFileSync("src/http-server.ts", "utf8").matchAll(/case "(\/api\/control\/[a-z0-9-]+)"/g)].map((m) => m[1]);
      assert.deepEqual(served.sort(), routes.map(([p]) => p).filter((p) => p.startsWith("/api/control/")).sort());

      const sent = cpe.stats.requests.length;
      for (const [route, body] of routes) {
        const res = await fetch(`${base}${route}`, { method: "POST", headers, body: JSON.stringify(body) });
        const json = (await res.json()) as Record<string, unknown>;
        assert.deepEqual([res.status, json["errorCode"], json["model"]], [409, "DEVICE_UNVERIFIED_READ_ONLY", "H122-373"], route);
        assert.match(String(json["messageZh"]), /只读/, route);
      }
      assert.deepEqual(cpe.stats.writes, [], "no write request reached the router");
      assert.equal(cpe.stats.requests.length, sent, "no session either");
    } finally {
      await stack.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
