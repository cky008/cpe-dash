import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { runAsActor } from "../src/audit-log.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { readDriverBandLockTarget, readDriverCellLockTarget } from "../src/control-input.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { DeviceAccess, type DeviceAccessSnapshot } from "../src/device-access.ts";
import { bandsToHex } from "../src/drivers/bands.ts";
import { ROUTER_FAMILY_FACTS, type RouterFamily } from "../src/router-family.ts";
import { CircuitBreakerOpenError, type ControlAppliedEvent, type ControlAuditEvent, DeviceReadOnlyError, DeviceWriteDisabledError, NotDriverFamilyError } from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { LanRouterMock } from "./helpers/lan-router.ts";
import { OPENWRT_PASSWORD, type OpenwrtRouterOptions, openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * A router of a driver family in the running daemon: the scheduler's queue, gate, breaker and
 * bookkeeping drive the family's driver, the monitor and the controls go through it, and the HiLink
 * client never opens a session on it (the mock refuses anything but ubus). Mocks only, no network.
 */

interface RuntimeOptions extends OpenwrtRouterOptions {
  family?: RouterFamily;
  url?: string;
  username?: string;
  password?: string;
  /** Another router than the OpenWrt one (the NRadio mock with counters). */
  fetchImpl?: typeof fetch;
  dir?: string;
}

function runtimeFixture(opts: RuntimeOptions = {}) {
  const router = openwrtRouter(opts);
  const dir = opts.dir ?? tempDir("fengsui-driver-rt-");
  const stateStore = new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "driver_key" });
  const core = createFengSuiCore({
    // The HiLink client holds the connection; on a driver family it never opens a session
    client: new HuaweiCpeClient({
      cpeUrl: opts.url ?? "http://192.168.1.1",
      cpeUsername: opts.username ?? "root",
      cpePassword: opts.password ?? OPENWRT_PASSWORD,
      fetchImpl: opts.fetchImpl ?? router.mock.fetchImpl,
      requestTimeoutMs: 2000,
    }),
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    family: opts.family ?? "openwrt",
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  core.monitor.init();
  const audits: ControlAuditEvent[] = [];
  const applied: ControlAppliedEvent[] = [];
  core.scheduler.on("control:audit", (event: ControlAuditEvent) => audits.push(event));
  core.scheduler.on("control:applied", (event: ControlAppliedEvent) => applied.push(event));
  const logins = (): number => router.calls.filter((c) => c.object === "session" && c.method === "login").length;
  const destroys = (): number => router.calls.filter((c) => c.object === "session" && c.method === "destroy").length;
  return {
    ...router,
    core,
    stateStore,
    audits,
    applied,
    logins,
    destroys,
    /** Every request the router saw was a ubus call (no HiLink request leaked). */
    onlyUbus: (): boolean => router.mock.requests.every((r) => r.method === "POST" && r.path === "/ubus"),
    cleanup: async (keepDir = false) => {
      await stopFengSuiCore(core);
      if (!keepDir) removeTempDir(dir);
    },
  };
}

/** The gate's part of the status. */
const gateOf = ({ model, verification, confirmed, writes }: DeviceAccessSnapshot) => ({ model, verification, confirmed, writes });

const OPENWRT = { url: "http://192.168.1.1", username: "root", password: OPENWRT_PASSWORD };

describe("driver runtime: reads", () => {
  it("polls telemetry and neighbours through the driver, in the HiLink snapshot shapes, and skips what the family does not read", async () => {
    const fx = runtimeFixture();
    try {
      assert.equal(fx.core.scheduler.isDriverMode(), true);
      assert.equal(fx.core.scheduler.getFamily(), "openwrt");
      const snap = await fx.core.monitor.refreshTelemetry();
      assert.ok(snap);
      assert.equal(snap.device.deviceName, "RM520N-GL");
      assert.equal(snap.device.softwareVersion, "RM520NGLAAR01A07M4G");
      assert.equal(snap.rf.ratCode, "SA");
      assert.equal(snap.rf.pccBand, "N78");
      assert.equal(snap.rf.nrRsrpDbm, -82);
      assert.equal(snap.rf.nrArfcnRaw, "627264");
      assert.equal(snap.rf.caComponentCount, 2);
      assert.equal(snap.thermal.temperatureCelsius, 46);
      assert.ok(snap.unavailable?.includes("traffic"), "no counters on this module: no made-up zero");
      assert.equal(fx.core.monitor.getCachedTelemetry()?.capturedAtMs, snap.capturedAtMs);

      const status = fx.core.scheduler.getStatus();
      assert.deepEqual(gateOf(status.device), { model: "RM520N-GL", verification: "unverified-model", confirmed: true, writes: "experimental" });
      assert.equal(status.mode, "idle");
      assert.equal(status.totalSessionsCompleted, 1, "the driver's sessions are the live connection's");
      assert.equal(status.device.reads.telemetry.state, "available");
      assert.equal(status.device.reads.neighbors.state, "unknown");
      for (const section of ["topology", "settings", "accessControl"] as const) {
        assert.deepEqual(status.device.reads[section], { state: "unavailable", code: null }, section);
      }
      // SMS is on record for this family; this fixture's poll does not carry its counts
      assert.deepEqual(status.device.reads.sms, { state: "unknown", code: null });

      const neighbours = await fx.core.monitor.refreshNeighbors();
      assert.ok(neighbours);
      assert.equal(neighbours.totalCount, 2);
      assert.equal(neighbours.nrNeighbors[0]?.pci, 145);
      assert.equal(neighbours.lteNeighbors[0]?.pci, 211);
      assert.equal(neighbours.lteNeighbors[0]?.sinrDb, 0);
      assert.equal(fx.core.monitor.getCachedNeighbors()?.totalCount, 2);
      assert.equal(fx.core.scheduler.getStatus().device.reads.neighbors.state, "available");

      // Sections the family does not document read nothing and open no session
      const before = fx.logins();
      assert.equal(await fx.core.monitor.refreshSettings(), null);
      assert.equal(await fx.core.monitor.refreshTopology(), null);
      assert.equal(await fx.core.monitor.refreshAccessControl(), null);
      assert.equal(await fx.core.scheduler.executeRead(async () => "hilink"), null, "a HiLink read reads nothing");
      assert.equal(fx.logins(), before);
      assert.equal(fx.logins(), fx.destroys(), "every session logged out");
      await assert.rejects(fx.core.scheduler.probeLoginState(), CpeControlValidationError);
      await assert.rejects(fx.core.scheduler.probePublic("/api/monitoring/check-notifications"), CpeControlValidationError);
      assert.ok(fx.onlyUbus(), "no HiLink request reached the router");
    } finally {
      await fx.cleanup();
    }
  });

  it("identifies the router through the driver, at start and in the console's connection test", async () => {
    const fx = runtimeFixture();
    try {
      const probe = await fx.core.monitor.identifyDevice();
      assert.ok(probe);
      assert.equal(probe.identity.model, "RM520N-GL");
      assert.equal(probe.identity.softwareVersion, "RM520NGLAAR01A07M4G");
      assert.equal(probe.identity.loginScheme, "unknown");
      assert.equal(probe.origin, "startup");
      assert.deepEqual(probe.endpoints, []);
      assert.equal(fx.core.monitor.getDeviceProbe()?.identity.model, "RM520N-GL");
      assert.deepEqual(gateOf(fx.core.scheduler.getStatus().device), { model: "RM520N-GL", verification: "unverified-model", confirmed: true, writes: "experimental" });

      const test = await fx.core.scheduler.testConnectionDetailed({ ...OPENWRT, family: "openwrt" });
      assert.equal(test.result.ok, true);
      assert.equal(test.result.ok && test.result.model, "RM520N-GL");
      assert.equal(test.probe?.identity.model, "RM520N-GL");
      assert.equal(test.probe?.origin, "connection-test");
      assert.equal(fx.logins(), fx.destroys());
      assert.ok(fx.onlyUbus());
    } finally {
      await fx.cleanup();
    }
  });

  it("latches the breaker on a wrong password like HiLink's, persists it, and clears it with the right password only", async () => {
    const dir = tempDir("fengsui-driver-rt-");
    const fx = runtimeFixture({ password: "the_wrong_password", dir });
    try {
      await assert.rejects(fx.core.monitor.refreshTelemetry(), (err: unknown) => err instanceof CircuitBreakerOpenError && err.code === "108006");
      const status = fx.core.scheduler.getStatus();
      assert.equal(status.mode, "circuit_tripped");
      assert.equal(status.circuitBreaker.code, "108006");
      assert.ok(fx.core.scheduler.getRecentAlerts().some((a) => a.code === "CIRCUIT_108006"));
      const logins = fx.logins();
      assert.equal(await fx.core.monitor.refreshTelemetry(), null, "latched: no further attempt");
      await assert.rejects(fx.core.controls.unlockAllLocks(), CircuitBreakerOpenError);
      assert.equal(fx.logins(), logins, "no password went out while latched");
      assert.deepEqual(fx.audits.map((a) => [a.action, a.outcome]), [["unlock_rf_locks", "refused"]]);
      await assert.rejects(fx.core.scheduler.reloadCredentialsAndResetBreaker("the_wrong_password", "root"), CpeControlValidationError);
    } finally {
      await fx.cleanup(true);
    }
    // The latch survives a restart on the same password
    const again = runtimeFixture({ password: "the_wrong_password", dir });
    try {
      assert.equal(again.core.scheduler.getStatus().mode, "circuit_tripped");
      assert.equal(await again.core.monitor.refreshTelemetry(), null);
      assert.equal(again.logins(), 0);
      const cleared = await again.core.scheduler.reloadCredentialsAndResetBreaker(OPENWRT_PASSWORD, "root");
      assert.equal(cleared.tripped, false);
      assert.ok(await again.core.monitor.refreshTelemetry(), "the right password gets in");
      assert.ok(again.onlyUbus());
    } finally {
      await again.cleanup();
    }
  });
});

describe("driver runtime: writes", () => {
  it("opens the driver's writes by default, refuses the rest and what its owner turned off, and records every write with its read-back", async () => {
    const fx = runtimeFixture();
    try {
      // The owner turned the band lock off for this model. Before any read the write's own session
      // identifies the router, then the gate refuses it as turned off
      fx.core.scheduler.device.setDisabledWrites([{ model: "RM520N-GL", feature: "bandLock" }]);
      await assert.rejects(
        fx.core.controls.lockBands({ lteBands: [1, 3] }),
        (err: unknown) => err instanceof DeviceWriteDisabledError && err.errorCode === "DEVICE_WRITE_DISABLED" && err.feature === "bandLock" && err.model === "RM520N-GL"
      );
      assert.equal(fx.logins(), 1, "identified in the write's own session");
      assert.ok(!fx.state.executedCommands.some((c) => c.startsWith('AT+QNWPREFCFG="lte_band",')), "nothing was written");
      assert.deepEqual(fx.audits.map((a) => [a.action, a.outcome]), [["lock_band", "refused"]]);

      // Writes no driver implements are refused before any session, HiLink ones included, and not as turned off
      const logins = fx.logins();
      await assert.rejects(
        fx.core.controls.reconnectCellular(),
        (err: unknown) => err instanceof DeviceReadOnlyError && !(err instanceof DeviceWriteDisabledError) && err.errorCode === "DEVICE_UNVERIFIED_READ_ONLY" && err.feature === "reconnect"
      );
      await assert.rejects(fx.core.controls.reconnectWan(), DeviceReadOnlyError);
      await assert.rejects(fx.core.controls.setMobileData(false), DeviceReadOnlyError);
      await assert.rejects(fx.core.scheduler.executeControl("set_antenna_mode", async () => 1), DeviceReadOnlyError);
      assert.equal(fx.logins(), logins);
      const features = fx.core.scheduler.getStatus().device.features;
      assert.deepEqual(
        [features.bandLock, features.cellLock, features.reboot, features.reconnect, features.mobileData, features.smsWrite, features.accessControl],
        ["disabled", "enabled", "enabled", "not_implemented", "not_implemented", "enabled", "not_implemented"]
      );

      // Turned back on (as the console keeps it): what the driver implements is open again, with no consent to give
      fx.core.scheduler.device.setDisabledWrites([]);
      assert.equal(fx.core.scheduler.getStatus().device.features.bandLock, "enabled");

      const locked = await runAsActor({ channel: "web" }, () => fx.core.controls.lockBands({ lteBands: ["B1", 3], nrBands: [78], networkMode: "08" }));
      assert.deepEqual({ mode: locked.mode, lteBands: locked.lteBands, nrBands: locked.nrBands, cellLock: locked.cellLock }, { mode: "band_lock", lteBands: [1, 3], nrBands: [78], cellLock: null });
      assert.equal(fx.state.lteBand, "1:3");
      assert.equal(fx.state.nrBand, "78");
      assert.equal(fx.state.modePref, "NR5G");
      assert.equal(fx.state.nrDisableMode, "2");
      assert.equal(fx.core.controls.getPersistedLockState().mode, "band_lock");
      const event = fx.applied.at(-1);
      assert.equal(event?.action, "lock_band");
      assert.ok(event?.check?.endpoints.includes("openwrt:AT+QNWPREFCFG/lte_band"), "the commands sent, never a value");
      assert.equal(event?.check?.readback, "match");
      assert.match(event?.summaryEn ?? "", /LTE=\[1,3\], NR=\[78\]/);
      const record = fx.core.scheduler.genericWrites.at(-1);
      assert.deepEqual([record?.action, record?.feature, record?.model, record?.outcome, record?.readback], ["lock_band", "bandLock", "RM520N-GL", "applied", "match"]);
      assert.ok(record?.endpoints.includes("openwrt:AT+QNWPREFCFG/nr5g_band"));

      // A RAT the command leaves out keeps what the router reports
      const lteOnly = await fx.core.controls.lockBands({ lteBands: [3] });
      assert.deepEqual([lteOnly.lteBands, lteOnly.nrBands], [[3], [78]]);
      assert.equal(fx.state.nrBand, "78");

      const cell = await fx.core.controls.lockCell({ rat: "NR", band: "n78", arfcn: 627264, pci: 142 });
      assert.equal(cell.mode, "cell_lock");
      assert.deepEqual(cell.cellLock, { rat: "NR", band: 78, arfcn: 627264, pci: 142 });
      assert.equal(fx.state.lock5g, "142,627264,30,78");
      const sessions = fx.logins();
      await assert.rejects(fx.core.controls.lockCell({ rat: "LTE", band: 3, arfcn: 1650 }), (err: unknown) => err instanceof CpeControlValidationError && /pci is required/.test(err.message));
      assert.equal(fx.logins(), sessions, "bad input opens no session");

      const unlocked = await fx.core.controls.unlockAllLocks();
      assert.deepEqual([unlocked.mode, unlocked.lteBands, unlocked.nrBands, unlocked.cellLock], ["unlocked", "all", [], null]);
      assert.equal(fx.state.lock5g, "0");
      assert.equal(fx.state.modePref, "AUTO");
      assert.equal(fx.logins(), fx.destroys(), "every session logged out");

      const reboot = await fx.core.controls.rebootRouter({ confirm: true });
      assert.equal(reboot.rebooting, true);
      assert.ok(fx.state.executedCommands.includes("AT+CFUN=1,1"));
      assert.equal(fx.core.scheduler.genericWrites.at(-1)?.readback, "pending");
      assert.deepEqual(
        fx.audits.filter((a) => a.outcome === "applied").map((a) => [a.action, a.actor.channel]),
        [
          ["lock_band", "web"],
          ["lock_band", "system"],
          ["lock_cell", "system"],
          ["unlock_rf_locks", "system"],
          ["reboot_cpe", "system"],
        ],
        "every write is audited with its caller"
      );
      assert.ok(fx.onlyUbus(), "no HiLink request reached the router");
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses a lock of NR bands alone when the router's LTE bands cannot be read", async () => {
    // The LTE bands a command leaves out are kept as the router reports them; unread, they would be overwritten
    const fx = runtimeFixture({ atErrors: ['AT+QNWPREFCFG="lte_band"'] });
    try {
      await fx.core.monitor.refreshTelemetry();
      await assert.rejects(fx.core.controls.lockBands({ nrBands: [78] }), (err: unknown) => err instanceof CpeControlValidationError && /could not be read/.test(err.message));
      assert.deepEqual([fx.state.lteBand, fx.state.nrBand], ["1:3:7", "41:78"], "nothing was written");
      assert.equal(fx.destroys(), fx.logins(), "the session was closed all the same");
      assert.equal(fx.core.controls.getPersistedLockState().mode, "unlocked");
      assert.equal(fx.onlyUbus(), true);
    } finally {
      await fx.cleanup();
    }
  });

  it("rolls a lock back through the driver: skipped when replaced or the WAN is up, else the saved bands or every lock cleared", async () => {
    const fx = runtimeFixture();
    try {
      const locked = await fx.core.controls.lockBands({ lteBands: [1, 3] });
      assert.deepEqual(await fx.core.controls.rollBackLocks("2020-01-01T00:00:00.000Z"), { applied: false, skipped: "lock_changed" });
      assert.deepEqual(await fx.core.controls.rollBackLocks(locked.updatedAtIso), { applied: false, skipped: "wan_up" });
      assert.equal(fx.state.lteBand, "1:3");

      // No service: an AI agent's lock is put back to the bands read before it
      fx.state.serving = "none";
      const restored = await runAsActor({ channel: "self-heal" }, () => fx.core.controls.rollBackLocks(locked.updatedAtIso, { lteMask: bandsToHex([1, 3, 7]) }));
      assert.equal(restored.applied, true);
      assert.deepEqual(restored.applied ? restored.lockState?.lteBands : null, [1, 3, 7]);
      assert.equal(fx.state.lteBand, "1:3:7");
      assert.equal(fx.applied.at(-1)?.action, "auto_unlock_rf_locks");
      assert.equal(fx.applied.at(-1)?.check?.readback, "match");

      // Nothing saved: every lock is cleared
      const current = fx.core.controls.getPersistedLockState();
      const cleared = await runAsActor({ channel: "self-heal" }, () => fx.core.controls.rollBackLocks(current.updatedAtIso));
      assert.equal(cleared.applied && cleared.lockState?.mode, "unlocked");
      assert.equal(fx.state.modePref, "AUTO");
      assert.equal(fx.core.controls.getPersistedLockState().mode, "unlocked");
      // A rollback that decided not to write is not broadcast or audited as applied (as on the H168-383)
      assert.deepEqual(
        fx.audits.map((a) => [a.action, a.outcome, a.actor.channel]),
        [
          ["lock_band", "applied", "system"],
          ["auto_unlock_rf_locks", "applied", "self-heal"],
          ["auto_unlock_rf_locks", "applied", "self-heal"],
        ]
      );
      assert.equal(fx.applied.filter((e) => e.action === "auto_unlock_rf_locks").length, 2);
      assert.ok(fx.onlyUbus());
    } finally {
      await fx.cleanup();
    }
  });

  it("hands every band and cell lock to the safety net, whoever asked: a band lock with the LTE bands read before it, a cell lock with nothing to write back", async () => {
    const fx = runtimeFixture();
    try {
      const seen: Array<{ mode: string; lteBands: number[] | "all"; savedLteMask: string | null }> = [];
      fx.core.controls.onExperimentalLock = (change) => seen.push({ mode: change.lock.mode, lteBands: change.lock.lteBands, savedLteMask: change.savedLteMask });
      await runAsActor({ channel: "mcp" }, () => fx.core.controls.lockBands({ lteBands: [3] }));
      assert.deepEqual(seen, [{ mode: "band_lock", lteBands: [3], savedLteMask: bandsToHex([1, 3, 7]) }]);
      await runAsActor({ channel: "web" }, () => fx.core.controls.lockBands({ lteBands: [1] }));
      assert.deepEqual(seen[1], { mode: "band_lock", lteBands: [1], savedLteMask: bandsToHex([3]) }, "a lock from the console is watched like an agent's");
      await runAsActor({ channel: "telegram" }, () => fx.core.controls.lockCell({ rat: "NR", band: 78, arfcn: 627264, pci: 142 }));
      assert.deepEqual(seen[2], { mode: "cell_lock", lteBands: "all", savedLteMask: null });
      await fx.core.controls.unlockAllLocks();
      assert.equal(seen.length, 3, "an unlock is nothing to watch");
    } finally {
      await fx.cleanup();
    }
  });
});

/** An NRadio router (counters, no rate) whose byte counters the test advances between polls. */
function nradioRouter() {
  let download = 15_849_203_712n;
  let upload = 2_194_810_368n;
  const mock = new LanRouterMock((req) => {
    if (req.method === "POST" && req.path === "/cgi-bin/luci") {
      const form = LanRouterMock.form(req);
      if (form.get("luci_username") !== "root" || form.get("luci_password") !== "test-password") return { status: 200, text: "<p>密码错误</p>" };
      return { status: 302, headers: { location: "/cgi-bin/luci" }, setCookie: ["sysauth=0123456789abcdef0123456789abcdef; path=/cgi-bin/luci"] };
    }
    if (!req.headers["cookie"]?.includes("sysauth=")) return { status: 403, text: "" };
    if (req.path === "/cgi-bin/luci/nradio/system/overview") {
      return { text: `<html><body><div>设备型号: C2000 MAX</div><div>系统版本:1.9.2.n6</div><script>var a={};a['token']='a8f5f167f44f4964e6c998dee827110c';</script></body></html>` };
    }
    if (req.path === "/cgi-bin/luci/nradio/status/runtime/wan,cpe_4") {
      return {
        json: {
          wan: { up: false, download: "0", upload: "0" },
          cpe_4: { up: true, uptime: 86425, isp: "Three", mode: "NR", ipaddr: "198.51.100.42", rsrp: "-79 dBm", rsrq: "-10 dB", sinr: "26 dB", pci: "0x8e", tac: "0x2711", cell: "134217758", earfcn: "650000", band: "78", download: download.toString(10), upload: upload.toString(10) },
        },
      };
    }
    if (req.path === "/cgi-bin/luci/nradio/logout") return { status: 302, headers: { location: "/" } };
    return { status: 404, text: "" };
  });
  return {
    mock,
    advance: (bytes: bigint): void => {
      download += bytes;
      upload += bytes / 4n;
    },
  };
}

describe("driver runtime: the connection's family", () => {
  it("derives rates from a family's counters over two polls, and switches the family with the connection", async () => {
    const nradio = nradioRouter();
    const fx = runtimeFixture({ family: "nradio", url: "http://192.168.66.1", password: "test-password", fetchImpl: nradio.mock.fetchImpl });
    try {
      let speedTicks = 0;
      fx.core.monitor.on("speed", () => speedTicks++);
      const first = await fx.core.monitor.refreshTelemetry();
      assert.ok(first);
      assert.equal(first.device.deviceName, "C2000 MAX");
      assert.equal(first.rf.pccBand, "N78");
      assert.ok(first.unavailable?.includes("traffic"), "one sample of the counters gives no rate yet");
      assert.equal(speedTicks, 0);
      nradio.advance(5_000_000n);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await fx.core.monitor.refreshTelemetry();
      assert.ok(second);
      assert.ok(!second.unavailable?.includes("traffic"));
      assert.ok(second.traffic.downloadBytesPerSec > 0, "the difference over the time between the polls");
      assert.ok(second.traffic.uploadBytesPerSec > 0);
      assert.equal(speedTicks, 1, "charted once there is a rate");

      // The console saves a Huawei connection at the same address: the HiLink client takes over (no session here)
      const toHuawei = await fx.core.scheduler.applyConnection({ url: "http://192.168.66.1", username: "root", password: "test-password", family: "huawei" });
      assert.equal(toHuawei.tripped, false);
      assert.equal(fx.core.scheduler.isDriverMode(), false);
      assert.equal(fx.core.scheduler.getFamily(), "huawei");
      assert.equal(fx.core.scheduler.device.family, "huawei");
      await assert.rejects(fx.core.scheduler.executeDriverTelemetryRead(), NotDriverFamilyError);
      await assert.rejects(fx.core.scheduler.executeDriverControl("reboot_cpe", async () => 1), NotDriverFamilyError);
      assert.deepEqual(fx.audits.at(-1) ? [fx.audits.at(-1)?.action, fx.audits.at(-1)?.outcome] : null, ["reboot_cpe", "refused"]);

      // And back: the driver is rebuilt on the saved connection, the rate starts over with it
      const requests = nradio.mock.requests.length;
      await fx.core.scheduler.applyConnection({ url: "http://192.168.66.1", username: "root", password: "test-password", family: "nradio" });
      assert.equal(fx.core.scheduler.isDriverMode(), true);
      assert.equal(fx.core.scheduler.getStatus().device.confirmed, false, "another connection: the model is confirmed again");
      nradio.advance(5_000_000n);
      const third = await fx.core.monitor.refreshTelemetry();
      assert.ok(third?.unavailable?.includes("traffic"), "the counters' first sample again");
      nradio.advance(1_000n);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const fourth = await fx.core.monitor.refreshTelemetry();
      assert.ok(fourth && !fourth.unavailable?.includes("traffic"));
      assert.ok(nradio.mock.requests.length > requests);

      // Reloading the credentials may name the family too
      const reloaded = await fx.core.scheduler.reloadCredentialsAndResetBreaker("test-password", "root", "nradio");
      assert.equal(reloaded.tripped, false);
      assert.equal(fx.core.scheduler.getFamily(), "nradio");
      await fx.core.scheduler.reloadCredentialsAndResetBreaker("test-password", "root", "huawei");
      assert.equal(fx.core.scheduler.isDriverMode(), false);
      assert.ok(nradio.mock.requests.every((r) => r.path.startsWith("/cgi-bin/luci")), "no HiLink request reached the router");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("write gate on a driver family", () => {
  it("opens the driver's writes once the model is seen, nothing else, and only the family's documented reads", () => {
    const access = new DeviceAccess({ family: "zte-goform" });
    assert.equal(access.driverFamily, true);
    assert.equal(access.writeState("bandLock"), "unknown");
    assert.deepEqual(access.readState("sms"), { state: "unknown", code: null }, "this family's SMS interface is on record");
    assert.deepEqual(access.readState("settings"), { state: "unavailable", code: null });
    assert.deepEqual(access.readState("telemetry"), { state: "unknown", code: null });

    access.see("MC888", "1.0");
    assert.equal(access.writes, "experimental");
    assert.equal(access.generic, true);
    assert.deepEqual(
      (["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "accessControl"] as const).map((f) => access.writeState(f)),
      ["enabled", "enabled", "enabled", "not_implemented", "not_implemented", "enabled", "not_implemented"]
    );
    assert.equal(access.writeAccess("cellLock"), "experimental", "open by default: the driver implements it");
    access.setDisabledWrites([{ model: "MC888", feature: "cellLock" }]);
    assert.equal(access.writeState("cellLock"), "disabled");
    assert.equal(access.writeAccess("cellLock"), "disabled");
    assert.equal(access.writeAccess("bandLock"), "experimental");
    assert.equal(access.writeAccess("reconnect"), "unavailable");
    access.setDisabledWrites([{ model: "OTHER", feature: "cellLock" }]);
    assert.equal(access.writeState("cellLock"), "enabled", "a switch-off names the model");
    assert.equal(access.snapshot().reads.settings.state, "unavailable");
    assert.equal(access.skips("settings"), true);
    assert.equal(access.skips("sms"), false);
    assert.equal(access.skips("neighbors"), false);

    // Back on a Huawei connection the HiLink rules apply (no generic cell lock)
    access.setFamily("huawei");
    assert.equal(access.driverFamily, false);
    assert.equal(access.writeState("cellLock"), "not_implemented");
    assert.deepEqual(access.readState("sms"), { state: "unknown", code: null });

    // A family that documents telemetry only
    const pinsu = new DeviceAccess({ family: "pinsu" });
    assert.deepEqual(pinsu.readState("neighbors"), { state: "unavailable", code: null });
    assert.equal(pinsu.skips("neighbors"), true);
    // No SMS interface on record: nothing to read, and the write stays closed
    assert.equal(pinsu.skips("sms"), true);
    pinsu.see("R200", "1.0");
    assert.equal(pinsu.writeState("smsWrite"), "not_implemented");
  });
});

describe("write gate: another form of a family's interface", () => {
  it("goes by what the form the driver reported has, else by the form the model is on record with", () => {
    const pro = ROUTER_FAMILY_FACTS.fiberhome.variants?.["pro"];
    assert.ok(pro);
    const features = ["bandLock", "cellLock", "reboot", "smsWrite"] as const;
    // Before the driver says: the model on record with the Pro series counts as speaking it
    const access = new DeviceAccess({ family: "fiberhome" });
    access.see("LG6851F", "RP0301");
    assert.equal(access.variant, "pro");
    assert.deepEqual(features.map((f) => access.writeState(f)), ["not_implemented", "not_implemented", "not_implemented", "enabled"]);
    assert.deepEqual([access.readState("neighbors").state, access.readState("sms").state], ["unavailable", "unknown"]);
    assert.equal(access.skips("neighbors"), true);
    // Taking a lock off needs one of the locks: none here
    assert.equal(access.actionAccess("unlock_rf_locks"), "unavailable");
    // The driver found the family's own form on it after all: the family's writes
    access.noteVariant("LG6851F", null);
    assert.equal(access.variant, null);
    assert.deepEqual(features.map((f) => access.writeState(f)), ["enabled", "enabled", "enabled", "enabled"]);
    assert.equal(access.skips("neighbors"), false);
    // A model the list lacks, reported as Pro by its driver; a report for another model says nothing of this one
    const other = new DeviceAccess({ family: "fiberhome" });
    other.noteVariant("LG9999", "pro");
    other.see("LG6121F", "1.0");
    assert.equal(other.variant, null);
    other.see("LG9999", "1.0");
    assert.equal(other.variant, "pro");
    assert.equal(other.snapshot().features.reboot, "not_implemented");
    assert.equal(other.snapshot().reads.neighbors.state, "unavailable");
    // A form the family does not have, or a brand with no forms: the family's own
    other.noteVariant("LG9999", "elsewhere");
    assert.equal(other.variant, null);
    const zte = new DeviceAccess({ family: "zte-goform" });
    zte.noteVariant("MC888", "pro");
    zte.see("MC888", "1.0");
    assert.equal(zte.variant, null);
    assert.equal(zte.writeState("bandLock"), "enabled");
    // Without a model, nothing is noted
    other.noteVariant(null, "pro");
    assert.equal(other.variant, null);
  });
});

describe("write gate: taking a lock off", () => {
  it("is open wherever a lock may be put on, so no lock is left that nobody may undo", async () => {
    const access = new DeviceAccess({ family: "zte-goform" });
    access.see("MC888", null);
    assert.equal(access.actionAccess("unlock_rf_locks"), "experimental");
    // The band lock turned off, the cell lock left on
    access.setDisabledWrites([{ model: "MC888", feature: "bandLock" }]);
    assert.equal(access.actionAccess("lock_cell"), "experimental");
    assert.equal(access.actionAccess("unlock_rf_locks"), "experimental");
    assert.equal(access.actionAccess("auto_unlock_rf_locks"), "experimental");
    assert.equal(access.actionAccess("lock_band"), "disabled", "the band lock stays a switch of its own");
    assert.equal(access.actionAccess("reboot_cpe"), "experimental");
    // Both turned off: nothing can be locked, so there is no unlock either
    access.setDisabledWrites([
      { model: "MC888", feature: "bandLock" },
      { model: "MC888", feature: "cellLock" },
    ]);
    assert.equal(access.actionAccess("unlock_rf_locks"), "disabled");
    // A HiLink model nobody verified has no cell lock to go by: nothing changes there
    const hilink = new DeviceAccess();
    hilink.see("B535-232", null);
    assert.equal(hilink.actionAccess("unlock_rf_locks"), "unavailable", "not identified: no sign that it has a band lock to take off");
    // The verified router writes everything, as before
    const verified = new DeviceAccess();
    verified.see("H168-383", "4.4.0.1");
    assert.equal(verified.actionAccess("unlock_rf_locks"), "allowed");

    // In the running daemon: the band lock turned off, a cell locked, and unlocked again
    const fx = runtimeFixture();
    try {
      await fx.core.monitor.refreshTelemetry();
      fx.core.scheduler.device.setDisabledWrites([{ model: "RM520N-GL", feature: "bandLock" }]);
      await fx.core.controls.lockCell({ rat: "NR", band: 78, arfcn: 627264, pci: 142 });
      assert.equal(fx.state.lock5g, "142,627264,30,78");
      await assert.rejects(fx.core.controls.lockBands({ lteBands: [3] }), DeviceWriteDisabledError);
      const unlocked = await fx.core.controls.unlockAllLocks();
      assert.equal(unlocked.mode, "unlocked");
      assert.equal(fx.state.lock5g, "0");
      assert.deepEqual(fx.core.scheduler.genericWrites.at(-1)?.feature, "bandLock", "the record keeps the feature the action is filed under");
    } finally {
      await fx.cleanup();
    }
  });
});

describe("driver lock input", () => {
  it("reads a band lock against the family's facts", () => {
    const openwrt = ROUTER_FAMILY_FACTS.openwrt;
    assert.deepEqual(readDriverBandLockTarget({ lteBands: ["B3", 1, 3], nrBands: "all", networkMode: "03" }, openwrt), { lte: [1, 3], nr: "all", networkMode: "lte" });
    assert.deepEqual(readDriverBandLockTarget({ nrBands: [78], networkMode: "00" }, openwrt), { lte: null, nr: [78], networkMode: "auto" });
    assert.deepEqual(readDriverBandLockTarget({ lteBands: "all" }, openwrt), { lte: "all", nr: null, networkMode: null });
    assert.throws(() => readDriverBandLockTarget({}, openwrt), (err: unknown) => err instanceof CpeControlValidationError && /lteBands or nrBands/.test(err.message));
    assert.throws(() => readDriverBandLockTarget({ lteBands: [] }, openwrt), /At least one LTE band/);
    assert.throws(() => readDriverBandLockTarget({ nrBands: [] }, openwrt), /At least one NR band/);
    assert.throws(() => readDriverBandLockTarget({ lteBands: ["x"] }, openwrt), CpeControlValidationError);
    assert.throws(() => readDriverBandLockTarget({ lteBands: [1], networkMode: "99" }, openwrt), /networkMode/);
    // A family that locks LTE bands only and offers no 5G-only mode
    const lteOnly = { nrBandLock: false, networkModes: ["auto", "lte"] } as const;
    assert.throws(() => readDriverBandLockTarget({ nrBands: [78] }, lteOnly), /LTE bands only/);
    assert.throws(() => readDriverBandLockTarget({ lteBands: [1], networkMode: "08" }, lteOnly), /offers no/);
    assert.deepEqual(readDriverBandLockTarget({ lteBands: [1], networkMode: "03" }, lteOnly), { lte: [1], nr: null, networkMode: "lte" });
    // NRadio's bridge takes an NR mask and the 5G modes as well
    assert.deepEqual(readDriverBandLockTarget({ nrBands: [78], networkMode: "08" }, ROUTER_FAMILY_FACTS.nradio), { lte: null, nr: [78], networkMode: "nr_sa" });
    // A mode is one of the codes, never a name every object answers to
    for (const mode of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      assert.throws(() => readDriverBandLockTarget({ lteBands: [1], networkMode: mode }, ROUTER_FAMILY_FACTS.openwrt), (err: unknown) => err instanceof CpeControlValidationError && err.message.startsWith(`Invalid networkMode "${mode}"`), mode);
    }
    // Bands are a list (of a size a band table could hold) or "all"
    assert.throws(() => readDriverBandLockTarget({ lteBands: 3 as unknown as number[] }, ROUTER_FAMILY_FACTS.openwrt), /list of band numbers/);
    assert.throws(() => readDriverBandLockTarget({ nrBands: Array.from({ length: 129 }, () => 78) }, ROUTER_FAMILY_FACTS.openwrt), /At most 128/);
  });

  it("reads a cell lock with its PCI", () => {
    assert.deepEqual(readDriverCellLockTarget({ rat: "LTE", band: "B3", arfcn: 1650, pci: 211 }), { rat: "LTE", band: 3, arfcn: 1650, pci: 211, scsKhz: null });
    assert.deepEqual(readDriverCellLockTarget({ rat: "NR", band: 78, arfcn: 627264, pci: 142 }), { rat: "NR", band: 78, arfcn: 627264, pci: 142, scsKhz: null });
    assert.throws(() => readDriverCellLockTarget({ rat: "LTE", band: 3, arfcn: 1650 }), /pci is required/);
    assert.throws(() => readDriverCellLockTarget({ rat: "LTE", band: 3, arfcn: -1, pci: 1 }), /arfcn/);
    assert.throws(() => readDriverCellLockTarget({ rat: "LTE", band: 3, arfcn: 1650, pci: 1.5 }), /pci must/);
    assert.throws(() => readDriverCellLockTarget({ rat: "WCDMA" as "LTE", band: 1, arfcn: 1, pci: 1 }), /rat/);
    assert.throws(() => readDriverCellLockTarget({ rat: "LTE", band: "zz", arfcn: 1650, pci: 1 }), CpeControlValidationError);
  });
});
