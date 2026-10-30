import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CpeApiError,
  HuaweiCpeClient,
  ReentrantCpeSessionError,
} from "../src/cpe-client.ts";
import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  type SecurityUpdateCommand,
} from "../src/cpe-domain.ts";
import { computeScram } from "../src/crypto.ts";
import {
  BrowserSessionYieldedError,
  type ControlAppliedEvent,
  MutexSessionScheduler,
  SchedulerQueueFullError,
  SchedulerStoppedError,
  type SpeedTickPayload,
} from "../src/scheduler.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import {
  TimeSeriesRingBuffer,
  TimeSeriesValidationError,
} from "../src/timeseries.ts";
import { getXmlTag } from "../src/xml.ts";

describe("TimeSeriesRingBuffer multi-scale circular buffer & tier seam joining", () => {
  it("records high-res 5s slots, seals 60s rollups, skips null channels accurately, and serves 1h/6h/12h/24h/custom", () => {
    const ring = new TimeSeriesRingBuffer({ retentionHours: 48 });
    const baseMs = 1_760_000_000_000;

    // Push 8 hours of samples every 30s -> exercises coarseRing sealing + fineRing tail seamlessly
    for (let offsetMin = -480; offsetMin <= 0; offsetMin++) {
      const ts1 = baseMs + offsetMin * 60_000;
      const ts2 = ts1 + 30_000;
      const nrActive = offsetMin % 2 === 0;
      ring.push({
        tsMs: ts1,
        downloadBps: 100_000_000,
        uploadBps: 20_000_000,
        lteRsrpDbm: -85,
        lteSinrDb: 18,
        nrRsrpDbm: nrActive ? -80 : null, // NSA intermittent NR must NOT pull average toward 0!
        nrSinrDb: nrActive ? 24 : null,
        temperatureCelsius: null, // Unsupported temperature stays null, never 0!
      });
      if (offsetMin < 0) {
        ring.push({
          tsMs: ts2,
          downloadBps: 200_000_000,
          uploadBps: 40_000_000,
          lteRsrpDbm: -87,
          lteSinrDb: 16,
          nrRsrpDbm: nrActive ? -82 : null,
          nrSinrDb: nrActive ? 22 : null,
          temperatureCelsius: null,
        });
      }
    }

    const q1h = ring.query({ preset: "1h", nowMs: baseMs });
    assert.ok(q1h.points.length > 0);
    const samplePt = q1h.points[0]!;
    assert.equal(samplePt.temperatureAvgCelsius, null);
    if (samplePt.nrRsrpAvgDbm !== null) {
      assert.ok(samplePt.nrRsrpAvgDbm <= -79 && samplePt.nrRsrpAvgDbm >= -83);
    }

    const q6h = ring.query({ preset: "6h", nowMs: baseMs });
    assert.ok(q6h.points.length >= 300);

    const q12h = ring.query({ preset: "12h", nowMs: baseMs });
    assert.ok(q12h.points.length > 0);

    const q24h = ring.query({ preset: "24h", nowMs: baseMs });
    assert.ok(q24h.points.length > 0);

    const qCustom = ring.query({
      preset: "custom",
      fromMs: baseMs - 5 * 3600_000,
      toMs: baseMs,
      maxPoints: 60,
      nowMs: baseMs,
    });
    assert.ok(qCustom.points.length > 0 && qCustom.points.length <= 61);

    // Snapshot & restore round-trip (simulates NAS restart where fineSlots might be cleared)
    const snap = ring.toSnapshot(baseMs);
    const restored = new TimeSeriesRingBuffer({ retentionHours: 48 });
    restored.restoreSnapshot({ ...snap, fineSlots: [] });
    const afterRestart1h = restored.query({ preset: "1h", nowMs: baseMs });
    assert.ok(afterRestart1h.points.length >= 50);

    assert.throws(
      () => ring.query({ preset: "custom", fromMs: baseMs, toMs: baseMs - 1000, nowMs: baseMs }),
      TimeSeriesValidationError
    );
  });

  it("rejects invalid timestamps, drops >60s out-of-order samples, merges <60s earlier samples directly into coarse ring, and handles openMinute seam join", () => {
    const ring = new TimeSeriesRingBuffer({ retentionHours: 24 });
    const base = 1_760_000_000_000;

    // Reject non-positive or non-finite tsMs
    assert.equal(
      ring.push({
        tsMs: 0,
        downloadBps: 100,
        uploadBps: 100,
        lteRsrpDbm: -80,
        lteSinrDb: 15,
        nrRsrpDbm: null,
        nrSinrDb: null,
        temperatureCelsius: null,
      }),
      false
    );
    assert.equal(
      ring.push({
        tsMs: NaN,
        downloadBps: 100,
        uploadBps: 100,
        lteRsrpDbm: -80,
        lteSinrDb: 15,
        nrRsrpDbm: null,
        nrSinrDb: null,
        temperatureCelsius: null,
      }),
      false
    );

    // Push first sample at minute 2
    assert.equal(
      ring.push({
        tsMs: base + 120_000,
        downloadBps: 1000,
        uploadBps: 500,
        lteRsrpDbm: -80,
        lteSinrDb: 20,
        nrRsrpDbm: -75,
        nrSinrDb: 25,
        temperatureCelsius: 40,
      }),
      true
    );

    // Reject sample that jumps backwards > 60s
    assert.equal(
      ring.push({
        tsMs: base + 50_000, // 70s earlier than 120_000 (> 60s)
        downloadBps: 1000,
        uploadBps: 500,
        lteRsrpDbm: -80,
        lteSinrDb: 20,
        nrRsrpDbm: null,
        nrSinrDb: null,
        temperatureCelsius: null,
      }),
      false
    );

    // Accept sample that is slightly earlier within 60s tolerance (merges into coarse ring)
    assert.equal(
      ring.push({
        tsMs: base + 70_000, // 50s earlier than 120_000 (within 60s)
        downloadBps: 1200,
        uploadBps: 600,
        lteRsrpDbm: -82,
        lteSinrDb: 18,
        nrRsrpDbm: null,
        nrSinrDb: null,
        temperatureCelsius: null,
      }),
      true
    );

    // Push another sample to minute 1 to test existing coarse slot merge in branch
    assert.equal(
      ring.push({
        tsMs: base + 80_000,
        downloadBps: 1400,
        uploadBps: 700,
        lteRsrpDbm: -81,
        lteSinrDb: 19,
        nrRsrpDbm: null,
        nrSinrDb: null,
        temperatureCelsius: null,
      }),
      true
    );

    // Push to minute 3 -> seals open minute 2
    assert.equal(
      ring.push({
        tsMs: base + 180_000,
        downloadBps: 2000,
        uploadBps: 1000,
        lteRsrpDbm: -78,
        lteSinrDb: 22,
        nrRsrpDbm: -70,
        nrSinrDb: 28,
        temperatureCelsius: 42,
      }),
      true
    );

    // Test toSnapshot & restoreSnapshot roundtrip preserving fineSlots and coarseSlots
    const snap = ring.toSnapshot(base + 180_000);
    assert.ok(snap.fineSlots.length > 0);
    assert.ok(snap.coarseSlots.length > 0);

    const restored = new TimeSeriesRingBuffer({ retentionHours: 24 });
    // Corrupt one fine and coarse slot to test sanitizeAcc and sanitizeSlot null rejection
    const corruptedSnapshot = {
      ...snap,
      fineSlots: [
        ...snap.fineSlots,
        { epochMs: -1, sampleCount: 0 } as unknown as import("../src/timeseries.ts").TimeSeriesSlotRecord,
        {
          epochMs: 12345,
          sampleCount: 1,
          dl: { count: 0, sum: NaN, min: 0, max: 0 },
        } as unknown as import("../src/timeseries.ts").TimeSeriesSlotRecord,
      ],
      coarseSlots: [
        ...snap.coarseSlots,
        { epochMs: NaN, sampleCount: 5 } as unknown as import("../src/timeseries.ts").TimeSeriesSlotRecord,
      ],
    };
    restored.restoreSnapshot(corruptedSnapshot);
    const qRestored = restored.query({ preset: "1h", nowMs: base + 180_000 });
    assert.ok(qRestored.points.length > 0);

    // Test TimeSeriesValidationError branches
    assert.throws(
      () => ring.query({ preset: "unsupported_preset" as unknown as import("../src/timeseries.ts").TimeSeriesPreset }),
      TimeSeriesValidationError
    );
    assert.throws(() => ring.query({ nowMs: -1 }), TimeSeriesValidationError);
    assert.throws(() => ring.query({ nowMs: NaN }), TimeSeriesValidationError);
    assert.throws(() => ring.query({ preset: "custom", fromMs: NaN, toMs: 100 }), TimeSeriesValidationError);
    assert.throws(() => ring.query({ preset: "custom", fromMs: 100, toMs: NaN }), TimeSeriesValidationError);
    assert.throws(() => ring.query({ preset: "custom", fromMs: 500, toMs: 500 }), TimeSeriesValidationError);
    assert.throws(() => ring.query({ preset: "custom", fromMs: 600, toMs: 500 }), TimeSeriesValidationError);
  });
});

describe("EncryptedStateStore crash-safe persistence & key rotation recovery", () => {
  it("persists encrypted state asynchronously and archives unreadable files on password rotation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-state-"));
    const stateFile = path.join(tmpDir, "state.json");

    const store1 = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "old_secret_key",
    });
    store1.update({
      lockState: {
        mode: "band_lock",
        updatedAtIso: new Date().toISOString(),
        lteBands: [1, 3],
        nrBands: [78],
        cellLock: null,
      },
    });
    store1.appendAlert({
      severity: "info",
      code: "LOCK_APPLIED",
      messageZh: "已锁定频段",
      messageEn: "Band lock applied",
    });
    await store1.flushAsync();

    // Reload with matching key -> decrypts cleanly
    const storeReload = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "old_secret_key",
    });
    const loaded = storeReload.load();
    assert.deepEqual(loaded.lockState.nrBands, [78]);
    assert.equal(loaded.recentAlerts.length, 1);

    // Reload with rotated key (e.g. after 108006 recovery) -> renames unreadable file & boots cleanly!
    const storeRotated = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "brand_new_secret_key",
    });
    const cleanBoot = storeRotated.load();
    assert.equal(cleanBoot.lockState.mode, "unlocked");
    const files = fs.readdirSync(tmpDir);
    assert.ok(files.some((f) => f.startsWith("state.json.unreadable-")));
  });

  it("exposes getState(), trims alerts beyond 100 entries, and handles rotateEncryptionKey() seamlessly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-store-"));
    const stateFile = path.join(tmpDir, "state.json");

    const store = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "key_v1_secret",
    });

    assert.equal(store.getState().schemaVersion, 1);

    // Append 105 alerts -> verify trimmed to exactly 100
    for (let i = 1; i <= 105; i++) {
      store.appendAlert({
        severity: "info",
        code: `ALERT_${i}`,
        messageZh: `警告 ${i}`,
        messageEn: `Alert ${i}`,
      });
    }
    assert.equal(store.getState().recentAlerts.length, 100);
    assert.equal(store.getState().recentAlerts[0]?.code, "ALERT_6");
    assert.equal(store.getState().recentAlerts[99]?.code, "ALERT_105");

    await store.flushAsync();

    // Rotate encryption key to key_v2
    store.rotateEncryptionKey("key_v2_secret");
    store.update({
      lockState: {
        mode: "band_lock",
        updatedAtIso: new Date().toISOString(),
        lteBands: [1],
        nrBands: [78],
        cellLock: null,
      },
    });
    await store.flushAsync();

    // Reload with key_v2 -> succeeds
    const storeV2 = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "key_v2_secret",
    });
    const loadedV2 = storeV2.load();
    assert.equal(loadedV2.lockState.mode, "band_lock");
    assert.equal(loadedV2.recentAlerts.length, 100);

    // Reload with old key_v1 -> fails, archives unreadable, boots clean default state
    const storeOld = new EncryptedStateStore({
      filePath: stateFile,
      encryptionKey: "key_v1_secret",
    });
    const loadedOld = storeOld.load();
    assert.equal(loadedOld.lockState.mode, "unlocked");
    const archivedFiles = fs.readdirSync(tmpDir).filter((f) => f.includes("unreadable-"));
    assert.ok(archivedFiles.length >= 1);
  });
});

describe("MutexSessionScheduler single-flight coalescing, anti-flapping browser avoidance & control safety", () => {
  function createSchedulerFixture(opts: {
    password?: string;
    getStateXml?: () => string;
    challengeOverride?: () => string | null;
    authOverride?: () => string | null;
    customRoutes?: Record<string, (method: string, body: string) => string | Promise<string>>;
    delayMs?: number;
  } = {}) {
    const password = opts.password ?? "sched_test_password";
    const saltHex = "aa".repeat(32);
    const serverNonce = `${"bb".repeat(32)}${"cc".repeat(32)}`;
    let loginCount = 0;
    let tokenSeq = 0;
    let lastFirstNonce = "";
    const nextToken = () => `st_${String(++tokenSeq).padStart(29, "0")}`;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const p = url.pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? init.body : "";

      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }

      const makeRes = (payload: string, withTok = true, status = 200) => {
        const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
        if (withTok) {
          headers.set("__RequestVerificationTokenone", nextToken());
          headers.set("__RequestVerificationTokentwo", nextToken());
        }
        headers.set("Set-Cookie", "SessionID=mock_session_cookie; Path=/; HttpOnly");
        return new Response(payload, { status, headers });
      };

      if (opts.customRoutes?.[p]) {
        const customPayload = await opts.customRoutes[p]!(method, body);
        return makeRes(customPayload);
      }

      if (p === "/api/user/state-login") {
        const xml =
          opts.getStateXml?.() ??
          "<response><State>-1</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";
        return makeRes(xml, false);
      }
      if (p === "/api/user/challenge_login") {
        const override = opts.challengeOverride?.() ?? null;
        if (override) return makeRes(override);
        loginCount += 1;
        lastFirstNonce = getXmlTag(body, "firstnonce") ?? "";
        return makeRes(
          `<response><salt>${saltHex}</salt><iterations>1000</iterations><servernonce>${serverNonce}</servernonce></response>`
        );
      }
      if (p === "/api/user/authentication_login") {
        const override = opts.authOverride?.() ?? null;
        if (override) return makeRes(override);
        const scram = computeScram(password, saltHex, 1000, lastFirstNonce, serverNonce);
        const clientProof = getXmlTag(body, "clientproof") ?? "";
        if (clientProof.toLowerCase() !== scram.clientProofHex.toLowerCase()) {
          return makeRes("<error><code>108006</code><remaincount>2</remaincount></error>");
        }
        return makeRes(`<response><serversignature>${scram.expectedServerSig}</serversignature></response>`);
      }
      if (p === "/api/user/logout") {
        return makeRes("<response>OK</response>");
      }
      if (p === "/api/webserver/token") {
        return makeRes(`<response><token>${"0".repeat(32)}${nextToken()}</token></response>`, false);
      }

      // Default telemetry fixtures matching PHASE1_PROTOCOL_SPEC.md & cpe-domain
      if (p === "/api/device/signal") {
        return makeRes(
          "<response><band>20MHz@100(B1) + 100MHz@647424(N78)</band><rsrp>-84dBm</rsrp><sinr>20dB</sinr><nrrsrp>-80dBm</nrrsrp><nrsinr>25dB</nrsinr></response>"
        );
      }
      if (p === "/api/monitoring/traffic-statistics") {
        return makeRes(
          "<response><CurrentDownloadRate>6250000</CurrentDownloadRate><CurrentUploadRate>1250000</CurrentUploadRate><CurrentDownload>1048576</CurrentDownload><CurrentUpload>524288</CurrentUpload><TotalDownload>20971520</TotalDownload><TotalUpload>10485760</TotalUpload><CurrentConnectTime>3600</CurrentConnectTime><TotalConnectTime>86400</TotalConnectTime></response>"
        );
      }
      if (p === "/api/monitoring/month_statistics") {
        return makeRes(
          "<response><CurrentDayUsed>1048576</CurrentDayUsed><CurrentMonthDownload>10485760</CurrentMonthDownload><CurrentMonthUpload>2097152</CurrentMonthUpload><MonthDuration>43200</MonthDuration><CurrentDayDuration>7200</CurrentDayDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime></response>"
        );
      }
      if (p === "/api/monitoring/status") {
        return makeRes("<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>5</SignalIcon><SimStatus>1</SimStatus></response>");
      }
      if (p === "/api/monitoring/start_date") {
        return makeRes("<response><StartDay>1</StartDay><DataLimit>0MB</DataLimit><MonthThreshold>90</MonthThreshold></response>");
      }
      if (p === "/api/device/information") {
        return makeRes(
          "<response><DeviceName>H168-383</DeviceName><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1</WebUIVersion><WanIPAddress>198.51.100.42</WanIPAddress><WanIPv6Address>2001:db8::42</WanIPv6Address><workmode>LTE</workmode><uptime>86400</uptime></response>"
        );
      }
      if (p === "/api/device/basic_information") {
        return makeRes("<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en></response>");
      }
      if (p === "/api/device/seccellinfo") {
        return makeRes("<response><lteseccell_list>1700,3,20MHz,321,-89dBm,-9dB,-60dBm,17dB;</lteseccell_list></response>");
      }
      if (p === "/api/device/ri") {
        return makeRes("<response><ri>2</ri></response>");
      }
      if (p === "/api/net/cell-info") {
        return makeRes("<response><lac>2711</lac><cellinfo>800001e</cellinfo></response>");
      }
      if (p === "/api/net/current-plmn") {
        return makeRes("<response><FullName>MockTel 5G</FullName><Numeric>27201</Numeric><Rat>7</Rat></response>");
      }
      if (p === "/api/net/net-mode") {
        return makeRes("<response><NetworkMode>00</NetworkMode><NetworkBand>3fffffff</NetworkBand><LTEBand>5</LTEBand></response>");
      }

      // Neighbors
      if (p === "/api/device/nbrcellinfo") {
        return makeRes(
          "<response><nbrcell_ltelist>100,1,322,-94dBm,-11dB,-66dBm,8dB;</nbrcell_ltelist><nbrcell_nrlist>647424,78,513,-88dBm,-11dB,-60dBm,18dB;</nbrcell_nrlist></response>"
        );
      }

      // Topology
      if (p === "/api/system/HostInfo") {
        return makeRes(
          JSON.stringify([
            {
              MACAddress: "02:00:5E:10:00:01",
              HostName: "nas-ds923",
              InterfaceType: "Ethernet",
              Active: 1,
              IPAddress: "192.168.8.10",
            },
          ])
        );
      }
      if (p === "/api/system/topology") {
        return makeRes(
          JSON.stringify([
            { Active: 1, AccessType: "Ethernet", ConnectedDevices: [] },
          ])
        );
      }

      // Settings
      if (p === "/api/security/upnp") {
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><UpnpStatus>0</UpnpStatus></response>");
      }
      if (p === "/api/security/dmz") {
        return makeRes(
          method === "POST"
            ? "<response>OK</response>"
            : "<response><DmzStatus>0</DmzStatus><DmzIPAddress>192.168.8.100</DmzIPAddress></response>"
        );
      }
      if (p === "/api/security/firewall-switch") {
        return makeRes(
          method === "POST"
            ? "<response>OK</response>"
            : "<response><FirewallMainSwitch>1</FirewallMainSwitch><FirewallIPFilterSwitch>1</FirewallIPFilterSwitch><FirewallWanPortPingSwitch>0</FirewallWanPortPingSwitch><firewallmacfilterswitch>1</firewallmacfilterswitch><firewallurlfilterswitch>1</firewallurlfilterswitch></response>"
        );
      }
      if (p === "/api/security/nat") {
        return makeRes("<response><NATType>1</NATType></response>");
      }
      if (p === "/api/security/bridgemode") {
        return makeRes("<response><bridgemode>0</bridgemode></response>");
      }
      if (p === "/api/wlan/wlandbho") {
        return makeRes(method === "POST" ? '{"errcode":0}' : '{"MloEnable":true,"DbhoEnable":true}');
      }
      if (p === "/api/device/antenna_set_type") {
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><antennasettype>0</antennasettype></response>");
      }
      if (p === "/api/device/antenna_type") {
        return makeRes("<response><antenna1insertstatus>0</antenna1insertstatus><antenna2insertstatus>0</antenna2insertstatus></response>");
      }
      if (p === "/api/dialup/mobile-dataswitch") {
        return makeRes(method === "POST" ? "<response>OK</response>" : "<response><dataswitch>1</dataswitch></response>");
      }

      // Control endpoints
      if (p === "/api/net/lock-freq" || p === "/api/device/control" || p === "/api/net/reconnect") {
        return makeRes("<response>OK</response>");
      }

      return makeRes("<response>OK</response>");
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-sched-"));
    const stateStore = new EncryptedStateStore({
      filePath: path.join(tmpDir, "state.json"),
      encryptionKey: password,
    });
    const client = new HuaweiCpeClient({
      cpeUrl: "http://192.168.8.1",
      cpePassword: password,
      fetchImpl,
    });
    const ring = new TimeSeriesRingBuffer({ retentionHours: 24 });

    return {
      client,
      stateStore,
      ring,
      tmpDir,
      password,
      getLoginCount: () => loginCount,
    };
  }

  it("coalesces concurrent telemetry reads into a single ephemeral CPE login", async () => {
    const fx = createSchedulerFixture({});
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      pollIntervalMs: 60_000,
      neighborScanIntervalMs: 120_000,
    });
    scheduler.init();

    const [r1, r2, r3, r4] = await Promise.all([
      scheduler.refreshTelemetry(),
      scheduler.refreshTelemetry(),
      scheduler.refreshTelemetry(),
      scheduler.refreshTelemetry(),
    ]);

    assert.equal(fx.getLoginCount(), 1);
    assert.ok(r1 && r2 && r3 && r4);
    assert.equal(r1.capturedAtMs, r4.capturedAtMs);
    await scheduler.stop();
  });

  it("broadcasts polite avoidance once on Layer-1/Layer-2 yield, enforces Layer-2 anti-flap cooldown, and rejects mutations while yielding", async () => {
    let browserLoggedIn = true;
    const avoidanceEvents: Array<{ active: boolean; messageZh: string }> = [];

    const fx = createSchedulerFixture({
      getStateXml: () =>
        browserLoggedIn
          ? "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>"
          : "<response><State>-1</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>",
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      pollIntervalMs: 60_000,
      neighborScanIntervalMs: 120_000,
      layer2InitialBackoffMs: 5_000,
    });
    scheduler.on("session:avoidance", (ev) => {
      avoidanceEvents.push({ active: ev.active, messageZh: ev.messageZh });
    });
    scheduler.init();

    // First refresh sees State=0 -> transitions to yielding_browser & emits avoidance ONCE
    const y1 = await scheduler.refreshTelemetry();
    const y2 = await scheduler.refreshTelemetry();
    assert.equal(y1, null);
    assert.equal(y2, null);
    assert.equal(avoidanceEvents.length, 1);
    assert.equal(avoidanceEvents[0]?.active, true);
    assert.equal(avoidanceEvents[0]?.messageZh, "用户正在使用 CPE 后台，监控自动避让中");
    assert.equal(scheduler.getStatus().mode, "yielding_browser");

    // Control mutations during human browser session must politely abort with BrowserSessionYieldedError
    await assert.rejects(
      () => scheduler.executeControl("reboot", async () => ({ ok: true })),
      BrowserSessionYieldedError
    );

    // Human logs out -> State=-1 -> resumes cleanly and emits active: false!
    browserLoggedIn = false;
    const recovered = await scheduler.refreshTelemetry();
    assert.ok(recovered);
    assert.equal(avoidanceEvents.length, 2);
    assert.equal(avoidanceEvents[1]?.active, false);
    assert.equal(scheduler.getStatus().mode, "idle");

    await scheduler.stop();
  });

  it("applies Layer-2 anti-flapping backoff when cross-IP 108003 occurs with State=-1", async () => {
    let crossIpOccupied = true;
    const fx = createSchedulerFixture({
      challengeOverride: () =>
        crossIpOccupied ? "<error><code>108003</code><message>occupied</message></error>" : null,
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      pollIntervalMs: 60_000,
      neighborScanIntervalMs: 120_000,
      layer2InitialBackoffMs: 60_000,
    });
    scheduler.init();

    const first = await scheduler.refreshTelemetry();
    assert.equal(first, null);
    const st = scheduler.getStatus();
    assert.equal(st.mode, "yielding_browser");
    assert.equal(st.avoidance.layer, 2);
    assert.ok((st.avoidance.cooldownUntilMs ?? 0) > Date.now());

    // Subsequent background poll during Layer-2 cooldown skips challenge_login completely (zero flapping!)
    const second = await scheduler.refreshTelemetry();
    assert.equal(second, null);

    // Force-bypass cooldown when human explicitly clears or cooldown expires
    crossIpOccupied = false;
    const resumed = await scheduler.refreshTelemetry({ ignoreCooldown: true });
    assert.ok(resumed);
    assert.equal(scheduler.getStatus().avoidance.active, false);

    await scheduler.stop();
  });

  it("manages start() and stop() lifecycle with periodic polling, sweep and flush intervals, and handles idempotent start/stop", async () => {
    const fx = createSchedulerFixture({ delayMs: 1 });
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      pollIntervalMs: 15,
      neighborScanIntervalMs: 25,
      stateFlushIntervalMs: 35,
    });

    scheduler.start();
    // Idempotent: calling start() again while running is a no-op
    scheduler.start();
    assert.equal(scheduler.getStatus().running, true);

    // Calling init() again is also a no-op
    scheduler.init();

    // Wait for the timers to trigger at least once (covers intervals)
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Stop gracefully
    await scheduler.stop();
    assert.equal(scheduler.getStatus().running, false);

    // Idempotent: calling stop() again when already stopped
    await scheduler.stop();
    assert.equal(scheduler.getStatus().running, false);
  });

  it("hydrates latched circuit breaker state on init() and returns null during read sessions", async () => {
    const fx = createSchedulerFixture({});
    // Pre-seed stateStore with latched circuit breaker matching client password
    fx.stateStore.update({
      circuitBreaker: {
        tripped: true,
        code: "108006",
        reason: "Pre-latched test breaker",
        trippedAtIso: new Date().toISOString(),
        remainCount: 1,
        waitTime: 60,
        passwordFingerprintHex: fx.client.getPasswordFingerprint(),
      },
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });

    scheduler.init();
    assert.equal(scheduler.getStatus().mode, "circuit_tripped");
    assert.equal(scheduler.getStatus().circuitBreaker.tripped, true);

    // Read sessions return null immediately when tripped
    const tele = await scheduler.refreshTelemetry();
    assert.equal(tele, null);
    const nbr = await scheduler.refreshNeighbors();
    assert.equal(nbr, null);
    const topo = await scheduler.refreshTopology();
    assert.equal(topo, null);
    const settings = await scheduler.refreshSettings();
    assert.equal(settings, null);
  });

  it("coalesces concurrent refreshNeighbors, refreshTopology, and refreshSettings into single-flight sessions and emits events", async () => {
    const fx = createSchedulerFixture({ delayMs: 10 });
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });
    scheduler.init();

    let neighborEvents = 0;
    let topologyEvents = 0;
    let settingsEvents = 0;
    scheduler.on("neighbors", () => neighborEvents++);
    scheduler.on("topology", () => topologyEvents++);
    scheduler.on("settings", () => settingsEvents++);

    // 1. refreshNeighbors coalescing
    const initialLogins1 = fx.getLoginCount();
    const [n1, n2, n3] = await Promise.all([
      scheduler.refreshNeighbors(),
      scheduler.refreshNeighbors(),
      scheduler.refreshNeighbors(),
    ]);
    assert.ok(n1 && n2 && n3);
    assert.equal(n1.capturedAtMs, n3.capturedAtMs);
    assert.equal(fx.getLoginCount(), initialLogins1 + 1);
    assert.equal(neighborEvents, 1);
    assert.equal(scheduler.getCachedNeighbors()?.capturedAtMs, n1.capturedAtMs);

    // 2. refreshTopology coalescing
    const initialLogins2 = fx.getLoginCount();
    const [t1, t2, t3] = await Promise.all([
      scheduler.refreshTopology(),
      scheduler.refreshTopology(),
      scheduler.refreshTopology(),
    ]);
    assert.ok(t1 && t2 && t3);
    assert.equal(t1.capturedAtMs, t3.capturedAtMs);
    assert.equal(fx.getLoginCount(), initialLogins2 + 1);
    assert.equal(topologyEvents, 1);
    assert.equal(scheduler.getCachedTopology()?.capturedAtMs, t1.capturedAtMs);

    // 3. refreshSettings coalescing
    const initialLogins3 = fx.getLoginCount();
    const [s1, s2, s3] = await Promise.all([
      scheduler.refreshSettings(),
      scheduler.refreshSettings(),
      scheduler.refreshSettings(),
    ]);
    assert.ok(s1 && s2 && s3);
    assert.equal(s1.capturedAtMs, s3.capturedAtMs);
    assert.equal(fx.getLoginCount(), initialLogins3 + 1);
    assert.equal(settingsEvents, 1);
    assert.equal(scheduler.getCachedSettings()?.capturedAtMs, s1.capturedAtMs);

    await scheduler.stop();
  });

  it("provides getCachedTelemetry, getCachedNeighbors, getCachedTopology, getCachedSettings, getPersistedLockState, getRecentAlerts, and queryTimeSeries", async () => {
    const fx = createSchedulerFixture({});
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });
    scheduler.init();

    let speedEmitted: SpeedTickPayload | null = null;
    scheduler.on("speed", (st: SpeedTickPayload) => {
      speedEmitted = st;
    });

    const snap = await scheduler.refreshTelemetry();
    assert.ok(snap);
    assert.ok(speedEmitted);
    assert.equal((speedEmitted as SpeedTickPayload).downloadBps, snap.traffic.downloadBps);

    await scheduler.refreshNeighbors();
    await scheduler.refreshTopology();
    await scheduler.refreshSettings();

    assert.equal(scheduler.getCachedTelemetry()?.capturedAtMs, snap.capturedAtMs);
    assert.ok(scheduler.getCachedNeighbors());
    assert.ok(scheduler.getCachedTopology());
    assert.ok(scheduler.getCachedSettings());
    assert.equal(scheduler.getPersistedLockState().mode, "unlocked");
    assert.ok(Array.isArray(scheduler.getRecentAlerts()));

    const tsResult = scheduler.queryTimeSeries({ preset: "1h" });
    assert.equal(tsResult.preset, "1h");
    assert.ok(tsResult.points.length > 0);

    await scheduler.stop();
  });

  it("executes all domain control actions (lockBands, lockCell, unlockAllLocks, rebootRouter, reconnectCellular, setSecuritySwitches, setWifi7Settings, setAntennaMode, setMobileData) and emits control:applied", async () => {
    const fx = createSchedulerFixture({});
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });
    scheduler.init();

    const appliedActions: string[] = [];
    scheduler.on("control:applied", (ev: ControlAppliedEvent) => {
      appliedActions.push(ev.action);
    });

    // 1. lockBands
    const bandState = await scheduler.lockBands({ lteBands: [1, 3], nrBands: [78] } satisfies BandLockCommand);
    assert.equal(bandState.mode, "band_lock");
    assert.deepEqual(bandState.lteBands, [1, 3]);
    assert.deepEqual(bandState.nrBands, [78]);
    assert.equal(scheduler.getPersistedLockState().mode, "band_lock");

    // 2. lockCell
    const cellState = await scheduler.lockCell({
      rat: "NR",
      band: 78,
      arfcn: 647424,
      pci: 512,
    } satisfies CellLockCommand);
    assert.equal(cellState.mode, "cell_lock");
    assert.equal(cellState.cellLock?.rat, "NR");
    assert.equal(scheduler.getPersistedLockState().mode, "cell_lock");

    // 3. unlockAllLocks
    const unlockedState = await scheduler.unlockAllLocks();
    assert.equal(unlockedState.mode, "unlocked");
    assert.equal(scheduler.getPersistedLockState().mode, "unlocked");

    // 4. rebootRouter
    const rebootResult = await scheduler.rebootRouter({ confirm: true });
    assert.equal(rebootResult.rebooting, true);

    // 5. reconnectCellular
    const reconnectResult = await scheduler.reconnectCellular();
    assert.equal(reconnectResult.reconnecting, true);

    // 6. setSecuritySwitches
    const settingsAfterSec = await scheduler.setSecuritySwitches({
      upnpEnabled: true,
      firewall: { mainSwitch: true },
    } satisfies SecurityUpdateCommand);
    assert.ok(settingsAfterSec);

    // 7. setWifi7Settings
    const wifi7Result = await scheduler.setWifi7Settings({
      mloEnable: true,
      dbhoEnable: true,
    });
    assert.deepEqual(wifi7Result, { mloEnable: true, dbhoEnable: true });

    // 8. setAntennaMode
    const antResult = await scheduler.setAntennaMode("auto" satisfies AntennaModeName);
    assert.equal(antResult.mode, "auto");

    // 9. setMobileData
    const dataResult = await scheduler.setMobileData(false);
    assert.equal(dataResult.mobileDataEnabled, false);

    // 10. executeControl without summary
    const directResult = await scheduler.executeControl("custom_noop", async () => "ok_val");
    assert.equal(directResult, "ok_val");

    // 11. executeControl with custom summary and nextLockState
    const customLockState = {
      mode: "cell_lock" as const,
      updatedAtIso: new Date().toISOString(),
      lteBands: [1] as number[],
      nrBands: [] as number[],
      cellLock: { rat: "LTE" as const, band: 1, arfcn: 100, pci: 10 },
    };
    await scheduler.executeControl(
      "custom_with_lock_state",
      async () => "ok_lock",
      { zh: "自定义锁", en: "Custom Lock", nextLockState: customLockState }
    );
    assert.equal(scheduler.getPersistedLockState().mode, "cell_lock");

    assert.ok(appliedActions.includes("lock_band"));
    assert.ok(appliedActions.includes("lock_cell"));
    assert.ok(appliedActions.includes("unlock_rf_locks"));
    assert.ok(appliedActions.includes("reboot_cpe"));
    assert.ok(appliedActions.includes("reconnect_cellular"));
    assert.ok(appliedActions.includes("set_security_switches"));
    assert.ok(appliedActions.includes("set_wifi7_mlo"));
    assert.ok(appliedActions.includes("set_antenna_mode"));
    assert.ok(appliedActions.includes("set_mobile_data"));
    assert.ok(appliedActions.includes("custom_noop"));

    await scheduler.stop();
  });

  it("trips circuit breaker on 108006, emits critical alert event, latches breaker in stateStore, and recovers via reloadCredentialsAndResetBreaker()", async () => {
    let authError = true;
    const fx = createSchedulerFixture({
      authOverride: () =>
        authError ? "<error><code>108006</code><remaincount>2</remaincount></error>" : null,
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });
    scheduler.init();

    const alerts: Array<{ severity: string; code: string }> = [];
    scheduler.on("alert", (al: { severity: string; code: string }) => {
      alerts.push({ severity: al.severity, code: al.code });
    });

    await assert.rejects(
      () => scheduler.refreshTelemetry(),
      (err: unknown) => err instanceof CpeApiError && err.code === "108006"
    );

    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]?.severity, "critical");
    assert.equal(alerts[0]?.code, "CIRCUIT_108006");
    assert.equal(scheduler.getStatus().mode, "circuit_tripped");
    assert.equal(scheduler.getStatus().circuitBreaker.tripped, true);
    assert.equal(fx.stateStore.getState().circuitBreaker.tripped, true);
    assert.equal(fx.stateStore.getState().recentAlerts.length, 1);

    // While tripped, reads return null without making network calls
    const skipped = await scheduler.refreshTelemetry();
    assert.equal(skipped, null);

    // Reset via reloadCredentialsAndResetBreaker
    authError = false;
    const newPassword = "new_correct_password";
    const cb = await scheduler.reloadCredentialsAndResetBreaker(newPassword);
    assert.equal(cb.tripped, false);
    assert.equal(scheduler.getStatus().mode, "idle");
    assert.equal(scheduler.getStatus().lastError, null);
    assert.equal(fx.stateStore.getState().circuitBreaker.tripped, false);

    await scheduler.stop();
  });

  it("throws SchedulerQueueFullError when maxQueueDepth is exceeded and respects queue priority ordering (high > normal > low)", async () => {
    let releaseFirstTask: (() => void) | null = null;
    const firstTaskPromise = new Promise<void>((resolve) => {
      releaseFirstTask = resolve;
    });

    const fx = createSchedulerFixture({
      customRoutes: {
        "/api/slow-task": async () => {
          await firstTaskPromise;
          return "<response>SLOW_OK</response>";
        },
      },
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      maxQueueDepth: 1,
    });
    scheduler.init();

    // Start slow task 1: shifts out of queue, but #drainQueue awaits it
    const task1Promise = scheduler.executeControl("slow_op", async (session) => {
      return await session.get("/api/slow-task");
    });

    // Enqueue task 2: queue length becomes 1 (which equals maxQueueDepth)
    const task2Promise = scheduler.executeControl("second_op", async () => "second_ok");

    // Enqueue task 3: queue length is 1 >= maxQueueDepth -> rejects immediately!
    await assert.rejects(
      () => scheduler.executeControl("third_op", async () => "third_ok"),
      (err: unknown) => {
        assert.ok(err instanceof SchedulerQueueFullError);
        assert.equal(err.statusCode, 503);
        assert.match(err.message, /queue is full/);
        return true;
      }
    );

    // Release task 1 so task 1 and task 2 finish cleanly
    releaseFirstTask!();
    const [res1, res2] = await Promise.all([task1Promise, task2Promise]);
    assert.ok(res1);
    assert.equal(res2, "second_ok");

    // Test priority sorting (high > normal > low)
    const execOrder: string[] = [];
    let releaseGate: (() => void) | null = null;
    const gatePromise = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const sched2 = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
      maxQueueDepth: 10,
    });
    sched2.init();

    // Block the queue with gate
    const gateTask = sched2.executeControl("gate", async () => {
      await gatePromise;
      execOrder.push("gate");
    });

    // Enqueue low, normal, and high tasks while gate is holding the worker
    const lowTask = sched2.refreshNeighbors().then(() => execOrder.push("low"));
    const normalTask = sched2.refreshTelemetry().then(() => execOrder.push("normal"));
    const highTask = sched2.executeControl("high_op", async () => {
      execOrder.push("high");
    });

    releaseGate!();
    await Promise.all([gateTask, lowTask, normalTask, highTask]);

    assert.equal(execOrder[0], "gate");
    assert.equal(execOrder[1], "high"); // High priority must run before normal and low!
    assert.equal(execOrder[2], "normal");
    assert.equal(execOrder[3], "low");

    await sched2.stop();
  });

  it("handles execution errors gracefully: sets lastError on non-fatal CpeApiError, and transitions to cpe_unreachable on generic Error", async () => {
    let errorMode: "none" | "non_fatal_cpe" | "network_crash" = "non_fatal_cpe";

    const fx = createSchedulerFixture({
      customRoutes: {
        "/api/custom-err": () => {
          if (errorMode === "non_fatal_cpe") {
            return "<error><code>100001</code><message>system busy</message></error>";
          }
          if (errorMode === "network_crash") {
            throw new Error("Socket hang up / network disconnected");
          }
          return "<response>OK</response>";
        },
      },
    });

    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });
    scheduler.init();

    // 1. Non-fatal CpeApiError
    await assert.rejects(
      () =>
        scheduler.executeControl("failing_cpe", async (session) => {
          return await session.get("/api/custom-err");
        }),
      (err: unknown) => {
        assert.ok(err instanceof CpeApiError);
        assert.equal(err.code, "100001");
        return true;
      }
    );
    assert.notEqual(scheduler.getStatus().mode, "cpe_unreachable");
    assert.match(scheduler.getStatus().lastError ?? "", /100001/);

    // 2. Generic Error (network disconnection)
    errorMode = "network_crash";
    await assert.rejects(
      () =>
        scheduler.executeControl("network_fail", async (session) => {
          return await session.get("/api/custom-err");
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Socket hang up/);
        return true;
      }
    );
    assert.equal(scheduler.getStatus().mode, "cpe_unreachable");
    assert.match(scheduler.getStatus().lastError ?? "", /Socket hang up/);

    await scheduler.stop();
  });

  it("hardens concurrency & clock edge cases (Opus audit #1-#12): stop() drains queue safely, deduplicates control:applied & breaker alerts, isolates listener throws, blocks scheduler reentrancy, and rebases NTP clock steps", async () => {
    const fx = createSchedulerFixture();
    const scheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: fx.stateStore,
      timeseries: fx.ring,
    });

    // #1b: stop() before init() must NOT overwrite an existing persisted state file
    fx.stateStore.update({
      lockState: {
        mode: "band_lock",
        updatedAtIso: new Date().toISOString(),
        lteBands: [3],
        nrBands: [78],
        cellLock: null,
      },
    });
    await fx.stateStore.flushAsync();
    const uninitializedScheduler = new MutexSessionScheduler({
      client: fx.client,
      stateStore: new EncryptedStateStore({
        filePath: fx.stateStore.filePath,
        encryptionKey: "sched_test_password",
      }),
      timeseries: new TimeSeriesRingBuffer(),
    });
    await uninitializedScheduler.stop();
    const verifyStore = new EncryptedStateStore({
      filePath: fx.stateStore.filePath,
      encryptionKey: "sched_test_password",
    });
    assert.deepEqual(verifyStore.load().lockState.lteBands, [3]);

    scheduler.init();

    // #3 & #4: lockBands / unlockAllLocks emit control:applied EXACTLY ONCE, and throwing listener does NOT fail mutation!
    const controlEvents: ControlAppliedEvent[] = [];
    scheduler.on("control:applied", (ev: ControlAppliedEvent) => {
      controlEvents.push(ev);
    });
    const boomListener = (): void => {
      throw new Error("Rogue SSE listener boom");
    };
    scheduler.on("control:applied", boomListener);

    const locked = await scheduler.lockBands({ lteBands: ["B1"], nrBands: ["N78"] });
    assert.equal(locked.mode, "band_lock");
    assert.equal(controlEvents.filter((e) => e.action === "lock_band").length, 1);
    assert.equal(controlEvents[0]?.lockState?.mode, "band_lock");
    assert.equal(scheduler.getStatus().mode, "idle");
    scheduler.off("control:applied", boomListener);

    const unlocked = await scheduler.unlockAllLocks();
    assert.equal(unlocked.mode, "unlocked");
    const unlockEvs = controlEvents.filter((e) => e.action === "unlock_rf_locks");
    assert.equal(unlockEvs.length, 1);
    assert.equal(unlockEvs[0]?.lockState?.mode, "unlocked");

    // #5: Nested scheduler call inside active session rejects immediately with ReentrantCpeSessionError instead of deadlocking
    await assert.rejects(
      () =>
        scheduler.executeControl("outer_op", async () => {
          await scheduler.refreshNeighbors();
          return "never";
        }),
      ReentrantCpeSessionError
    );

    // #1a: stop() rejects queued tasks with SchedulerStoppedError so no post-shutdown logins start
    let unblockRunning: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      unblockRunning = r;
    });
    const runningTask = scheduler.executeControl("in_flight", async () => {
      await gate;
      return "done";
    });
    const queuedTask = scheduler.executeControl("queued_after_stop", async () => "should_not_run");
    const stopPromise = scheduler.stop();
    await assert.rejects(() => queuedTask, SchedulerStoppedError);
    unblockRunning!();
    assert.equal(await runningTask, "done");
    await stopPromise;
    await assert.rejects(
      () => scheduler.executeControl("after_stopped", async () => "nope"),
      SchedulerStoppedError
    );

    // #10, #11, #12: TimeSeriesRingBuffer future skew rejection, sustained backward NTP step rebase, seamMs start, and exact maxPoints cap
    const ring = new TimeSeriesRingBuffer({ retentionHours: 24 });
    const wallMs = 1_760_500_000_000;
    // Reject >5m future skew relative to wallNowMs
    assert.equal(
      ring.push(
        {
          tsMs: wallMs + 10 * 60_000,
          downloadBps: 1000,
          uploadBps: 1000,
          lteRsrpDbm: -80,
          lteSinrDb: 15,
          nrRsrpDbm: null,
          nrSinrDb: null,
          temperatureCelsius: null,
        },
        wallMs
      ),
      false
    );
    // Simulate clock running 2h ahead, then stepping back 2h for 3 consecutive polls -> rebases cleanly!
    const aheadMs = wallMs + 2 * 3600_000;
    assert.equal(
      ring.push(
        {
          tsMs: aheadMs,
          downloadBps: 5000,
          uploadBps: 1000,
          lteRsrpDbm: -80,
          lteSinrDb: 15,
          nrRsrpDbm: null,
          nrSinrDb: null,
          temperatureCelsius: null,
        },
        aheadMs
      ),
      true
    );
    // First 2 backward samples rejected as stray out-of-order; 3rd triggers rebase and succeeds!
    assert.equal(
      ring.push(
        {
          tsMs: wallMs,
          downloadBps: 2000,
          uploadBps: 500,
          lteRsrpDbm: -82,
          lteSinrDb: 14,
          nrRsrpDbm: null,
          nrSinrDb: null,
          temperatureCelsius: null,
        },
        wallMs
      ),
      false
    );
    assert.equal(
      ring.push(
        {
          tsMs: wallMs + 5_000,
          downloadBps: 2000,
          uploadBps: 500,
          lteRsrpDbm: -82,
          lteSinrDb: 14,
          nrRsrpDbm: null,
          nrSinrDb: null,
          temperatureCelsius: null,
        },
        wallMs + 5_000
      ),
      false
    );
    assert.equal(
      ring.push(
        {
          tsMs: wallMs + 10_000,
          downloadBps: 3000,
          uploadBps: 600,
          lteRsrpDbm: -81,
          lteSinrDb: 16,
          nrRsrpDbm: null,
          nrSinrDb: null,
          temperatureCelsius: null,
        },
        wallMs + 10_000
      ),
      true
    );

    // Fill 65 minutes of 5s samples to verify maxPoints exact cap (<= 360, never 361) and seamMs partial-minute start
    const ringSeam = new TimeSeriesRingBuffer({ retentionHours: 24 });
    const t0 = 1_760_000_000_000; // exact minute multiple (divisible by 60_000? Check: Math.floor)
    const alignedMin = Math.floor(t0 / 60_000) * 60_000;
    for (let s = 35; s <= 3 * 3600 + 30; s += 5) {
      const ts = alignedMin + s * 1000;
      ringSeam.push(
        {
          tsMs: ts,
          downloadBps: 10_000_000,
          uploadBps: 2_000_000,
          lteRsrpDbm: -85,
          lteSinrDb: 18,
          nrRsrpDbm: -79,
          nrSinrDb: 22,
          temperatureCelsius: null,
        },
        ts
      );
    }
    const endNow = alignedMin + (3 * 3600 + 32.5) * 1000;
    const q1hCap = ringSeam.query({ preset: "1h", maxPoints: 360, nowMs: alignedMin + 3600_000 + 2000 });
    assert.ok(q1hCap.points.length <= 360);
    const qSeam = ringSeam.query({
      preset: "custom",
      fromMs: Math.trunc(endNow - 3 * 3600_000),
      toMs: Math.trunc(endNow),
      bucketMs: 5_000,
      maxPoints: 1440,
      nowMs: Math.trunc(endNow),
    });
    // Oldest fine slot at alignedMin + 35_000 must NOT be dropped by seamMs rounding up to +60_000!
    assert.equal(
      qSeam.points[0]?.tsMs,
      Math.floor((alignedMin + 35_000) / qSeam.bucketMs) * qSeam.bucketMs
    );
  });
});
