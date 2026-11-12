import { isCellularWriteFeature } from "../src/router-family.ts";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type {
  AccessControlChangeResponse,
  AlertEventRecord,
  ApiErrorEnvelope,
  DeviceProfileResponse,
  DeviceReportResponse,
  ExperimentalWritesResponse,
  GlobalTelemetrySnapshot,
  SmsSendResponse,
  SmsThreadsResponse,
  TerminalTopologySnapshot,
  TimeSeriesEndpointResponse,
} from "../src/api-contract.ts";
import { type DemoSession, captureDemoSeed, openDemoSession } from "../scripts/capture-demo-seed.ts";
import { type DemoDaemon, startDemoDaemon } from "../scripts/demo-router.ts";
import { DemoBackend, type DemoEventSource } from "../web/src/demo/backend.ts";
import { type DemoSeed, readDemoSeed, rebaseSeed, rebaseTimestamps } from "../web/src/demo/seed.ts";
import { type Json, assertSameShape, daemonCall, demoCall, listen, settle } from "./helpers/demo-contract.ts";

/**
 * The static demo's in-page backend against the daemon it imitates: both start from the same seed
 * (captured from the real daemon on the demo router), take the same requests, and must answer with
 * the same shapes, the same state changes and the same validation errors. Placeholders only.
 */

const TOKEN = "fengsui-demo-test";

describe("Static demo backend vs the real daemon", () => {
  let daemon: DemoDaemon;
  let session: DemoSession;
  let seed: DemoSeed;
  let backend: DemoBackend;

  before(async () => {
    daemon = await startDemoDaemon({ port: 0, token: TOKEN });
    session = await openDemoSession(daemon.baseUrl, TOKEN);
    seed = readDemoSeed(JSON.parse(JSON.stringify(await captureDemoSeed(session))));
    backend = new DemoBackend({ seed: rebaseSeed(seed, Date.now()), latencyScale: 0 });
  });

  after(async () => {
    backend.stop();
    await daemon.close();
  });

  it("captures a seed of placeholders only, with the daemon's own messages", () => {
    const raw = JSON.stringify(seed);
    assert.ok(raw.includes("860000000000000") && raw.includes("198.51.100.42"));
    for (const mac of raw.match(/\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi) ?? []) assert.match(mac, /^02:00:5E:10:00:/i);
    assert.ok(seed.sms.messages.length >= 5 && seed.sms.contacts.length === 3);
    assert.match(seed.catalog["zh-CN"]["controls.reboot_triggered"] ?? "", /重启/);
    assert.ok(seed.neighbors.neighbors && seed.neighbors.neighbors.totalCount > 0);
  });

  it("answers every read route with the daemon's shapes", async () => {
    for (const route of [
      "/api/health",
      "/api/auth/status",
      "/api/telemetry",
      "/api/session/status",
      "/api/neighbors",
      "/api/topology",
      "/api/settings",
      "/api/alerts",
      "/api/access-control",
      "/api/sms/status",
      "/api/sms/countries",
      "/api/sms/threads?filter=all&search=&limit=500",
      "/api/sms/threads?filter=otp&search=code&limit=50",
      "/api/sms/thread?key=%2B353830000001",
      "/api/sms/contacts?search=&limit=5000",
    ]) {
      const [real, demo] = await Promise.all([daemonCall(session, "GET", route), demoCall(backend, "GET", route)]);
      assert.equal(demo.status, real.status, route);
      assertSameShape(route, real.json, demo.json);
    }
  });

  it("serves a day of history through the daemon's own ring buffer", async () => {
    const day = (await demoCall(backend, "GET", "/api/timeseries?preset=24h&maxPoints=288")).json as unknown as TimeSeriesEndpointResponse;
    assert.ok(day.points.length > 250, `24 h of points (got ${day.points.length})`);
    assert.ok(day.points.every((p) => p.lteRsrpAvgDbm !== null && p.dlPeakBps >= p.dlAvgBps));
    const real = await daemonCall(session, "GET", "/api/timeseries?preset=1h&maxPoints=60");
    const demo = await demoCall(backend, "GET", "/api/timeseries?preset=1h&maxPoints=60");
    assertSameShape("timeseries", real.json, demo.json);
    for (const bad of ["/api/timeseries?preset=week", "/api/timeseries?preset=custom&fromMs=5&toMs=1", "/api/timeseries?preset=1h&maxPoints=1e3"]) {
      const [r, d] = await Promise.all([daemonCall(session, "GET", bad), demoCall(backend, "GET", bad)]);
      assert.equal(d.status, r.status, bad);
      assert.equal(d.json["message"], r.json["message"], bad);
    }
  });

  it("applies band and cell locks like the daemon, and rejects what it rejects", async () => {
    for (const [route, body] of [
      ["/api/control/band-lock", { lteBands: ["B3", 1, "B3"], nrBands: ["N78"] }],
      ["/api/control/cell-lock", { rat: "NR", band: "N78", arfcn: 650000, pci: 211 }],
      ["/api/control/cell-lock", { rat: "LTE", band: "B3", arfcn: 1850, pci: null }],
      ["/api/control/unlock", {}],
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(demo.status, 200, route);
      assertSameShape(route, real.json, demo.json);
      const { updatedAtIso: _a, ...realLock } = real.json["lockState"] as Json;
      const { updatedAtIso: _b, ...demoLock } = demo.json["lockState"] as Json;
      assert.deepEqual(demoLock, realLock, route);
    }
    for (const [route, body] of [
      ["/api/control/band-lock", {}],
      ["/api/control/band-lock", { lteBands: ["B99"] }],
      ["/api/control/band-lock", { nrBands: "N78" }],
      ["/api/control/cell-lock", { rat: "LTE", band: "B3", arfcn: 99_999, pci: 142 }],
      ["/api/control/cell-lock", { rat: "NR", band: "N78", arfcn: 647_424, pci: 5000 }],
      ["/api/control/cell-lock", { rat: "5G", band: "N78", arfcn: 647_424 }],
      ["/api/control/reboot", { confirm: false }],
      ["/api/control/reconnect", {}],
      ["/api/control/antenna", { mode: "sideways" }],
      ["/api/control/wifi7", {}],
      ["/api/control/mobile-data", {}],
      ["/api/control/security", { dmz: { enabled: true, ipAddress: "192.168.8.300" } }],
      ["/api/control/security", { firewall: { teleport: true } }],
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(real.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.json["message"], real.json["message"], `${route} ${JSON.stringify(body)}`);
    }
  });

  it("changes router settings like the daemon", async () => {
    for (const [route, body] of [
      ["/api/control/security", { upnpEnabled: false, dmz: { enabled: true, ipAddress: "192.168.8.21" }, firewall: { wanPortPingSwitch: false } }],
      ["/api/control/wifi7", { mloEnable: false }],
      ["/api/control/antenna", { mode: "external" }],
      ["/api/control/mobile-data", { enabled: true }],
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(demo.status, 200, route);
      assertSameShape(route, real.json, demo.json);
    }
    const settings = (await demoCall(backend, "GET", "/api/settings")).json["settings"] as Json;
    assert.equal(settings["upnpEnabled"], false);
    assert.equal(settings["dmzIpAddress"], "192.168.8.21");
    assert.deepEqual(settings["antenna"], { ...(seed.settings.settings?.antenna ?? {}), mode: "external", rawCode: "2" });
  });

  it("manages the console's router, tokens, switches and audit log like the daemon", async () => {
    const both = (method: string, route: string, body?: Json) => Promise.all([daemonCall(session, method, route, body), demoCall(backend, method, route, body)]);
    const withoutImported = (json: Json): Json => ({ ...json, tokens: (json["tokens"] as Json[]).map(({ imported: _imported, ...token }) => token) });

    for (const [method, route, body] of [
      ["GET", "/api/console", undefined],
      ["POST", "/api/console/cpe/test", {}],
      ["POST", "/api/console/tokens", { name: "Home Assistant", scope: "read", lifetimeDays: 30 }],
      ["POST", "/api/console/switches", { metricsEnabled: true, telegramReset: false }],
      ["POST", "/api/console/review", {}],
      ["POST", "/api/console/telegram/unlink-all", {}],
    ] as const) {
      const [real, demo] = await both(method, route, body);
      assert.equal(demo.status, real.status, route);
      assertSameShape(route, real.json, demo.json);
    }
    const [realTokens, demoTokens] = await both("GET", "/api/console/tokens");
    assertSameShape("/api/console/tokens", withoutImported(realTokens.json), demoTokens.json);
    const minted = (await demoCall(backend, "POST", "/api/console/tokens", { name: "Grafana 2", scope: "full", lifetimeDays: null })).json;
    assert.match(String(minted["token"]), /^fsk_[A-Za-z0-9_-]{43}$/);
    const id = (minted["record"] as Json)["id"];
    assert.equal((await demoCall(backend, "POST", "/api/console/tokens/revoke", { id })).status, 200);

    for (const [route, body] of [
      ["/api/console/tokens", { name: " ", scope: "read", lifetimeDays: 7 }],
      ["/api/console/tokens", { name: "x", scope: "read", lifetimeDays: 2 }],
      ["/api/console/password", { current: "anything", next: "short" }],
      ["/api/console/switches", {}],
      ["/api/console/switches", { telegramReset: "yes" }],
      ["/api/console/cpe/test", { url: " " }],
      ["/api/console/cpe/test", { url: "http://192.168.8.66" }],
      ["/api/console/cpe", { url: "http://203.0.113.10" }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual([demo.status, demo.json["message"]], [real.status, real.json["message"]], `${route} ${JSON.stringify(body)}`);
    }
    for (const [route, body] of [
      ["/api/console/tokens/revoke", { id: "no-such-token" }],
      ["/api/console/cpe", { url: "http://203.0.113.10", password: "typed" }],
    ] as const) {
      const [real, demo] = await both("POST", route, body);
      assert.deepEqual([demo.status, demo.json["errorCode"]], [real.status, real.json["errorCode"]], route);
    }
    const refused = (await demoCall(backend, "POST", "/api/console/cpe", { url: "http://203.0.113.10", password: "typed" })).json;
    assert.equal((refused["connectionTest"] as Json)["reason"], "invalid_url");
    const saved = (await demoCall(backend, "POST", "/api/console/cpe", { url: "192.168.8.1/", username: "" })).json;
    assert.deepEqual((saved["settings"] as Json)["cpe"], { url: "http://192.168.8.1", username: "admin", passwordSet: true });
    assert.equal((await demoCall(backend, "POST", "/api/console/password", { current: "", next: "a long enough passphrase" })).json["errorCode"], "WRONG_PASSWORD");
    assert.equal((await demoCall(backend, "POST", "/api/console/password", { current: "anything", next: "a long enough passphrase" })).status, 200);
    assert.match(String((await demoCall(backend, "POST", "/api/console/telegram/pairing-code")).json["code"]), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const [realAudit, demoAudit] = await both("GET", "/api/audit?limit=5");
    assertSameShape("/api/audit", realAudit.json, demoAudit.json);
    const entries = demoAudit.json["entries"] as Json[];
    assert.equal(entries.length, 5);
    assert.deepEqual(
      entries.slice(0, 3).map((e) => [e["action"], e["outcome"]]),
      [
        ["telegram.pairing-code", "applied"],
        ["settings.password", "applied"],
        ["settings.password", "refused"],
      ],
      "newest first"
    );
    const groupCode = (await demoCall(backend, "POST", "/api/console/telegram/pairing-code", { group: true })).json;
    assert.deepEqual([groupCode["group"], groupCode["command"]], [true, `/auth ${String(groupCode["code"])}`], "the demo has no bot to name");
    assert.equal((await demoCall(backend, "POST", "/api/console/telegram/pairing-code", { group: 1 })).status, 400);
    await demoCall(backend, "POST", "/api/control/antenna", { mode: "auto" });
    const audit = (await demoCall(backend, "GET", "/api/audit?limit=nope")).json["entries"] as Json[];
    assert.deepEqual([audit[0]?.["action"], audit[0]?.["channel"]], ["set_antenna_mode", "web"], "router writes are logged with the daemon's action names");
  });

  it("lists the Telegram chats and unlinks one like the daemon, with its checks and messages", async () => {
    const fresh = new DemoBackend({ seed: rebaseSeed(seed, Date.now()), latencyScale: 0 });
    try {
      const [real, demo] = await Promise.all([daemonCall(session, "GET", "/api/console/telegram/chats"), demoCall(fresh, "GET", "/api/console/telegram/chats")]);
      assert.deepEqual([real.status, demo.status, real.json["chats"]], [200, 200, []], "the demo daemon runs without a bot");
      assert.deepEqual(
        (demo.json["chats"] as Json[]).map((c) => [c["chatId"], c["kind"], c["linkedWith"], c["fromEnv"], c["topic"]]),
        [
          ["-1002", "group", "group-code", false, 7],
          ["1001", "private", "code", false, null],
          ["1003", "private", null, true, null],
        ]
      );
      for (const body of [{ chatId: "abc" }, { chatId: 7 }, { chatId: "999" }, {}]) {
        const [r, d] = await Promise.all([daemonCall(session, "POST", "/api/console/telegram/unlink", body), demoCall(fresh, "POST", "/api/console/telegram/unlink", body)]);
        assert.deepEqual([d.status, d.json["errorCode"], d.json["message"]], [r.status, r.json["errorCode"], r.json["message"]], JSON.stringify(body));
      }
      const env = await demoCall(fresh, "POST", "/api/console/telegram/unlink", { chatId: "1003" });
      assert.deepEqual([env.status, env.json["message"]], [404, "TELEGRAM_CHAT_IDS in .env authorizes this chat: remove it there"]);
      const left = await demoCall(fresh, "POST", "/api/console/telegram/unlink", { chatId: " -1002 " });
      assert.equal(left.status, 200);
      assert.deepEqual((left.json["chats"] as Json[]).map((c) => c["chatId"]), ["1001", "1003"]);
      assert.equal((await demoCall(fresh, "POST", "/api/console/telegram/unlink-all")).json["unlinked"], 1);
      assert.deepEqual(((await demoCall(fresh, "GET", "/api/console/telegram/chats")).json["chats"] as Json[]).map((c) => c["chatId"]), ["1003"], ".env's chat stays");
      const audit = (await demoCall(fresh, "GET", "/api/audit?limit=2")).json["entries"] as Json[];
      assert.deepEqual(
        audit.map((e) => [e["action"], e["detail"]]),
        [
          ["telegram.unlink-all", "1 chat(s)"],
          ["telegram.unlink", "group chat …002"],
        ]
      );
    } finally {
      fresh.stop();
    }
  });

  it("answers the experimental writes switch like the daemon on the verified router", async () => {
    const [realView, demoView] = await Promise.all([daemonCall(session, "GET", "/api/console/experimental"), demoCall(backend, "GET", "/api/console/experimental")]);
    assert.equal(demoView.status, 200);
    assertSameShape("/api/console/experimental", realView.json, demoView.json);
    assert.deepEqual((demoView.json as unknown as ExperimentalWritesResponse).device.features, (realView.json as unknown as ExperimentalWritesResponse).device.features);
    // Verified but for the cellular settings, which came after the model's verification and are not on it
    assert.ok(Object.entries((demoView.json as unknown as ExperimentalWritesResponse).device.features).every(([feature, state]) => state === (isCellularWriteFeature(feature) ? "not_implemented" : "verified")));
    for (const body of [
      { feature: "reboot", enabled: true },
      { feature: "reboot", enabled: false },
      { feature: "teleport", enabled: true },
      { feature: "reboot" },
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", "/api/console/experimental", body), demoCall(backend, "POST", "/api/console/experimental", body)]);
      assert.deepEqual([demo.status, demo.json["errorCode"], demo.json["message"], demo.json["state"]], [real.status, real.json["errorCode"], real.json["message"], real.json["state"]], JSON.stringify(body));
      if (real.status === 200) assertSameShape("POST /api/console/experimental", real.json, demo.json);
    }
    const audit = (await demoCall(backend, "GET", "/api/audit?limit=2")).json["entries"] as Json[];
    // A verified model has no switch to turn off or on: both directions are refused, and audited as such
    assert.deepEqual(audit.map((e) => [e["action"], e["outcome"], e["detail"]]), [
      ["settings.experimental", "refused", "reboot off: verified"],
      ["settings.experimental", "refused", "reboot on: verified"],
    ]);
  });

  it("answers the AI agent test like the daemon on the verified router", async () => {
    for (const body of [{ action: "start", model: "H168-383" }, { action: "end" }, { action: "ack" }, { action: "ack", alertId: 7 }, { action: "go" }, {}] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", "/api/console/agent-test", body), demoCall(backend, "POST", "/api/console/agent-test", body)]);
      assert.deepEqual([demo.status, demo.json["errorCode"], demo.json["message"]], [real.status, real.json["errorCode"], real.json["message"]], JSON.stringify(body));
      if (real.status === 200) {
        assertSameShape("POST /api/console/agent-test", real.json, demo.json);
        assert.deepEqual(demo.json["agentTest"], real.json["agentTest"], "nothing to test on the verified router");
      }
    }
  });

  it("identifies the demo router and builds its device report like the daemon", async () => {
    assert.ok(seed.device, "the seed carries the daemon's identification and report");
    for (const route of ["/api/device/profile", "/api/console/device-report"]) {
      const [real, demo] = await Promise.all([daemonCall(session, "GET", route), demoCall(backend, "GET", route)]);
      assert.equal(demo.status, real.status, route);
      assertSameShape(route, real.json, demo.json);
    }
    const profile = (await demoCall(backend, "GET", "/api/device/profile")).json as unknown as DeviceProfileResponse;
    assert.deepEqual([profile.profile?.identity.model, profile.profile?.verification, profile.profile?.capabilities.lteBands?.length], ["H168-383", "verified", 14]);
    const report = (await demoCall(backend, "GET", "/api/console/device-report")).json as unknown as DeviceReportResponse;
    assert.ok(Date.now() - Date.parse(report.report.generatedAtIso) < 5000, "generated when asked");
    assert.equal(JSON.stringify(report).includes("198.51.100.42"), false, "the demo router's WAN address stays out");

    // A seed captured before identification existed still opens: nothing identified, an empty report
    const older = new DemoBackend({ seed: rebaseSeed({ ...seed, device: undefined }, Date.now()), latencyScale: 0 });
    try {
      assert.equal(((await demoCall(older, "GET", "/api/device/profile")).json as unknown as DeviceProfileResponse).profile, null);
      const empty = (await demoCall(older, "GET", "/api/console/device-report")).json as unknown as DeviceReportResponse;
      assert.deepEqual([empty.report.verification, empty.report.identity, empty.report.endpoints], ["unknown", null, []]);
    } finally {
      older.stop();
    }
  });

  it("plans Wi-Fi access and time rules with the daemon's rules and ends in the same state", async () => {
    const requests: ReadonlyArray<readonly [string, Json]> = [
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5e:10:00:03", name: "living-room-tv", confirm: true }],
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:03", name: "living-room-tv", confirm: true }],
      ["/api/control/wifi-access", { action: "unblock", macAddress: "02:00:5E:10:00:05", confirm: true }],
      ["/api/control/wifi-mac-filter", { add: [{ macAddress: "02:00:5E:10:00:06", name: "e-reader" }], confirm: true }],
      ["/api/control/time-rule", { action: "create", rule: { macAddress: "02:00:5E:10:00:03", name: "living-room-tv", weekMask: "0000011", startTime: "09:00", endTime: "23:00" }, confirm: true }],
      ["/api/control/time-rule", { action: "update", id: "InternetGatewayDevice.X_FireWall.TimeRule.2.", rule: { macAddress: "02:00:5E:10:00:03", name: "living-room-tv", weekMask: "0000011", startTime: "10:00", endTime: "01:00", enabled: false }, confirm: true }],
      ["/api/control/time-rule", { action: "delete", id: "InternetGatewayDevice.X_FireWall.TimeRule.1.", confirm: true }],
    ];
    for (const [route, body] of requests) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(real.status, 200, `${route} ${JSON.stringify(real.json)}`);
      assert.equal(demo.status, 200, `${route} ${JSON.stringify(demo.json)}`);
      const r = real.json as unknown as AccessControlChangeResponse;
      const d = demo.json as unknown as AccessControlChangeResponse;
      assertSameShape(route, r, d);
      assert.equal(d.changed, r.changed, route);
      assert.deepEqual(d.alsoBlocked, r.alsoBlocked, route);
      assert.deepEqual(d.accessControl?.wifiMacFilter, r.accessControl?.wifiMacFilter, route);
      assert.deepEqual(d.accessControl?.timeRules, r.accessControl?.timeRules, route);
    }
    for (const [route, body] of [
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:01", name: "nas-ds923", confirm: true }],
      ["/api/control/wifi-access", { action: "block", macAddress: "not-a-mac", confirm: true }],
      ["/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:04" }],
      ["/api/control/wifi-mac-filter", { mode: "allow", entries: [], confirm: true }],
      ["/api/control/time-rule", { action: "create", rule: { macAddress: "02:00:5E:10:00:04", name: "phone-wifi7", weekMask: "1111111", startTime: "07:07", endTime: "08:00" }, confirm: true }],
      ["/api/control/time-rule", { action: "delete", id: "InternetGatewayDevice.X_FireWall.TimeRule.9.", confirm: true }],
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(real.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.json["message"], real.json["message"], `${route} ${JSON.stringify(body)}`);
    }
  });

  it("handles SMS and contacts like the daemon", async () => {
    const preview = { phone: "0830000003", content: "Hello from the demo 👋", countryCode: "+353" };
    const [rp, dp] = await Promise.all([daemonCall(session, "POST", "/api/sms/preview", preview), demoCall(backend, "POST", "/api/sms/preview", preview)]);
    assert.deepEqual(dp.json, rp.json);

    const contact = { phone: "+447700900456", name: "Demo Florist", note: "Fictional" };
    const [rc, dc] = await Promise.all([daemonCall(session, "POST", "/api/sms/contacts/upsert", contact), demoCall(backend, "POST", "/api/sms/contacts/upsert", contact)]);
    assertSameShape("contacts/upsert", rc.json, dc.json);

    const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Demo Bakery\nTEL:+447700900789\nEND:VCARD\n";
    const [rv, dv] = await Promise.all([daemonCall(session, "POST", "/api/sms/contacts/import-vcf", { vcf }), demoCall(backend, "POST", "/api/sms/contacts/import-vcf", { vcf })]);
    assert.deepEqual(dv.json, rv.json);

    const send = { phone: "+353830000001", content: "See you at 7 🍜" };
    const [rs, ds] = await Promise.all([daemonCall(session, "POST", "/api/sms/send", send), demoCall(backend, "POST", "/api/sms/send", send)]);
    assert.equal(rs.status, 200, JSON.stringify(rs.json));
    assert.equal(ds.status, 200, JSON.stringify(ds.json));
    assertSameShape("sms/send", rs.json, ds.json);
    assert.deepEqual((ds.json as unknown as SmsSendResponse).result, (rs.json as unknown as SmsSendResponse).result);

    for (const [route, body] of [
      ["/api/sms/send", { phone: "+353830000001", content: "   " }],
      ["/api/sms/send", { phone: "not a number", content: "hi" }],
      ["/api/sms/send", { phones: ["1", "2", "3", "4", "5", "6"], content: "hi" }],
      ["/api/sms/read", {}],
      ["/api/sms/delete", { uids: ["missing-uid"] }],
      ["/api/sms/contacts/upsert", { phone: "+353830000009", name: "  " }],
      ["/api/sms/sync", { mode: "sideways" }],
    ] as const) {
      const [real, demo] = await Promise.all([daemonCall(session, "POST", route, body), demoCall(backend, "POST", route, body)]);
      assert.equal(real.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.status, 400, `${route} ${JSON.stringify(body)}`);
      assert.equal(demo.json["message"], real.json["message"], `${route} ${JSON.stringify(body)}`);
    }
  });
});

describe("Static demo backend on its own", () => {
  let seed: DemoSeed;
  let daemon: DemoDaemon;

  before(async () => {
    daemon = await startDemoDaemon({ port: 0, token: TOKEN });
    seed = await captureDemoSeed(await openDemoSession(daemon.baseUrl, TOKEN));
    await daemon.close();
  });

  function fresh(clock: { now: number }): DemoBackend {
    return new DemoBackend({ seed: rebaseSeed(seed, clock.now), now: () => clock.now, random: () => 0.5, latencyScale: 0 });
  }

  it("streams hello, then speed and telemetry on every poll", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const source = backend.createEventSource("/api/events") as DemoEventSource;
    const events = listen(source);
    await settle();
    assert.equal(events[0]?.name, "hello");
    const before = (events[0]?.data["telemetry"] as unknown as GlobalTelemetrySnapshot).traffic.todayUsedBytes;
    clock.now += 5_000;
    backend.tick();
    const telemetry = events.find((e) => e.name === "telemetry")?.data as unknown as GlobalTelemetrySnapshot;
    assert.ok(events.some((e) => e.name === "speed"));
    assert.ok(telemetry.traffic.todayUsedBytes > before);
    assert.equal(telemetry.capturedAtMs, clock.now);
    for (let i = 0; i < 12; i++) {
      clock.now += 5_000;
      backend.tick();
    }
    assert.ok(events.some((e) => e.name === "topology"), "topology refresh every minute");
    source.close();
    clock.now += 5_000;
    const count = events.length;
    backend.tick();
    assert.equal(events.length, count, "a closed stream gets nothing");
    backend.stop();
  });

  it("restarts the router: offline, unreachable alert, then recovered with uptime reset", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    const res = await demoCall(backend, "POST", "/api/control/reboot", { confirm: true });
    assert.equal(res.status, 200);
    await settle();
    const alerts = (): AlertEventRecord[] => events.filter((e) => e.name === "alert").map((e) => e.data as unknown as AlertEventRecord);
    assert.deepEqual(alerts().map((a) => a.code), ["CPE_UNREACHABLE"]);
    assert.equal((await demoCall(backend, "POST", "/api/control/wifi7", { mloEnable: true })).status, 502, "controls wait for the router");
    clock.now += 60_000;
    backend.tick();
    assert.deepEqual(alerts().map((a) => a.code), ["CPE_UNREACHABLE", "CPE_RECOVERED", "REBOOT_DETECTED"]);
    const telemetry = (await demoCall(backend, "GET", "/api/telemetry")).json["telemetry"] as unknown as GlobalTelemetrySnapshot;
    assert.ok(telemetry.device.uptimeSec <= 60);
    assert.equal(((await demoCall(backend, "GET", "/api/alerts")).json["alerts"] as unknown[]).length, 3);
    assert.equal((await demoCall(backend, "POST", "/api/control/reconnect", { confirm: true })).status, 200);
    backend.stop();
  });

  it("takes a blocked Wi-Fi device offline and answers sends with a reply", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    await demoCall(backend, "POST", "/api/control/wifi-access", { action: "block", macAddress: "02:00:5E:10:00:04", name: "phone-wifi7", confirm: true });
    await settle();
    const topology = [...events].reverse().find((e) => e.name === "topology")?.data as unknown as TerminalTopologySnapshot;
    assert.equal(topology.hosts.find((h) => h.macAddress === "02:00:5E:10:00:04")?.active, false);
    assert.equal(topology.countsByMedium.WIFI_5G, 1);

    await demoCall(backend, "POST", "/api/sms/send", { phone: "+353830000002", content: "晚上见" });
    await settle();
    const incoming = events.filter((e) => e.name === "sms:new").map((e) => e.data["content"]);
    assert.match(String(incoming[0]), /收到/);
    const threads = (await demoCall(backend, "GET", "/api/sms/threads?filter=unread")).json as unknown as SmsThreadsResponse;
    const robin = threads.threads.find((t) => t.contact?.name === "Robin Demo");
    assert.equal(robin?.unreadCount, 1);
    const read = await demoCall(backend, "POST", "/api/sms/read", { threadKey: robin?.threadKey });
    assert.equal(read.json["count"], 1);
    const uids = (await demoCall(backend, "GET", `/api/sms/thread?key=${encodeURIComponent(robin?.threadKey ?? "")}`)).json as { thread: { messages: Array<{ uid: string }> } };
    const deleted = await demoCall(backend, "POST", "/api/sms/delete", { uids: uids.thread.messages.map((m) => m.uid) });
    assert.equal(deleted.json["deleted"], 2);
    assert.ok(events.some((e) => e.name === "sms:updated" && e.data["action"] === "deleted"));
    const removed = await demoCall(backend, "POST", "/api/sms/contacts/delete", { id: robin?.contact?.id });
    assert.equal(removed.json["deleted"], true);
    const sync = await demoCall(backend, "POST", "/api/sms/sync", { mode: "incremental" });
    assert.equal((sync.json["summary"] as Json)["mode"], "incremental");
    backend.stop();
  });

  it("keeps deleted messages in Recently deleted like the daemon: restore, delete for good, and the retention from the console", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    const threads = (await demoCall(backend, "GET", "/api/sms/threads?filter=all")).json as unknown as SmsThreadsResponse;
    const [first, second] = threads.threads.map((t) => t.latestMessage.uid);
    assert.ok(first && second);
    const deleted = await demoCall(backend, "POST", "/api/sms/delete", { uids: [first, second] });
    assert.equal(deleted.json["trashDays"], 30);
    const trash = (await demoCall(backend, "GET", "/api/sms/trash")).json as { messages: Array<{ uid: string; purgeAtIso: string }>; trashDays: number };
    assert.deepEqual(trash.messages.map((m) => m.uid).sort(), [first, second].sort());
    assert.equal(((await demoCall(backend, "GET", "/api/sms/status")).json["status"] as { mirror: { trashTotal: number } }).mirror.trashTotal, 2);

    assert.equal((await demoCall(backend, "POST", "/api/sms/trash/restore", { uids: ["missing-uid"] })).status, 400);
    assert.equal((await demoCall(backend, "POST", "/api/sms/trash/restore", {})).status, 400);
    assert.deepEqual((await demoCall(backend, "POST", "/api/sms/trash/restore", { uids: [first] })).json, { ok: true, restored: 1, uids: [first] });
    assert.ok(events.some((e) => e.name === "sms:updated" && e.data["action"] === "restored"));
    assert.equal((await demoCall(backend, "POST", "/api/sms/trash/purge", { all: "yes" })).status, 400);
    assert.deepEqual((await demoCall(backend, "POST", "/api/sms/trash/purge", { uids: [second] })).json, { ok: true, purged: 1, uids: [second] });
    assert.deepEqual((await demoCall(backend, "POST", "/api/sms/trash/purge", { all: true })).json, { ok: true, purged: 0, uids: [] });

    // The visitor's retention applies: 0 keeps nothing, and what outlived a retention is gone
    await demoCall(backend, "POST", "/api/console/behaviour", { smsTrashDays: 0 });
    assert.equal((await demoCall(backend, "POST", "/api/sms/delete", { uids: [first] })).json["trashDays"], 0);
    assert.equal(((await demoCall(backend, "GET", "/api/sms/trash")).json["messages"] as unknown[]).length, 0);
    await demoCall(backend, "POST", "/api/console/behaviour", { smsTrashDays: 1 });
    const third = ((await demoCall(backend, "GET", "/api/sms/threads?filter=all")).json as unknown as SmsThreadsResponse).threads[0]?.latestMessage.uid;
    await demoCall(backend, "POST", "/api/sms/delete", { uids: [third] });
    clock.now += 2 * 24 * 60 * 60_000;
    assert.equal(((await demoCall(backend, "GET", "/api/sms/trash")).json["messages"] as unknown[]).length, 0);
    backend.stop();
  });

  it("delivers DemoBank codes, refreshes on demand and keeps scans moving", async () => {
    const clock = { now: Date.now() };
    const backend = fresh(clock);
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    backend.receiveSms("DemoBank", "Your DemoBank verification code is 135790.");
    const sms = events.find((e) => e.name === "sms:new")?.data;
    assert.equal(sms?.["verificationCode"], "135790");
    for (const route of ["/api/telemetry/refresh", "/api/topology/refresh", "/api/settings/refresh", "/api/access-control/refresh", "/api/neighbors/scan"]) {
      assert.equal((await demoCall(backend, "POST", route, {})).status, 200, route);
    }
    assert.ok(events.some((e) => e.name === "neighbors") && events.some((e) => e.name === "settings") && events.some((e) => e.name === "access-control"));
    assert.equal((await demoCall(backend, "POST", "/api/session/reset-breaker", {})).status, 200);
    backend.start();
    backend.start();
    backend.stop();
  });

  it("gates on the demo sign-in and speaks the daemon's error envelope", async () => {
    const backend = fresh({ now: Date.now() });
    assert.equal((await demoCall(backend, "POST", "/api/auth/logout")).json["authenticated"], false);
    const locked = await demoCall(backend, "GET", "/api/telemetry");
    assert.equal(locked.status, 401);
    assert.equal((locked.json as unknown as ApiErrorEnvelope).errorCode, "UNAUTHORIZED");
    const events = listen(backend.createEventSource("/api/events") as DemoEventSource);
    let errored = false;
    (backend.createEventSource("/api/events") as DemoEventSource).addEventListener("error", () => {
      errored = true;
    });
    await settle();
    assert.ok(errored && events.length === 0, "a signed-out stream fails like the daemon's 401");
    assert.equal((await demoCall(backend, "GET", "/api/health")).status, 200);
    assert.equal((await demoCall(backend, "POST", "/api/auth/login", { token: "" })).status, 401);
    assert.equal((await demoCall(backend, "POST", "/api/auth/login", { token: "anything" })).json["authenticated"], true);
    assert.equal((await demoCall(backend, "POST", "/api/auth/login", { password: "anything" })).json["authenticated"], true);
    assert.equal((await demoCall(backend, "GET", "/api/nope")).status, 404);
    assert.equal((await demoCall(backend, "DELETE", "/api/telemetry")).status, 405);
    const malformed = await backend.fetch("/api/control/wifi7", { method: "POST", body: "{nope" });
    assert.equal(malformed.status, 400);
    const notObject = await backend.fetch(new URL("http://demo.invalid/api/control/wifi7"), { method: "POST", body: "[1]" });
    assert.equal(((await notObject.json()) as Json)["errorCode"], "BAD_PAYLOAD");
    const binary = await backend.fetch("/api/control/wifi7", { method: "POST", body: new Uint8Array([1]) });
    assert.equal(binary.status, 415);
    assert.equal((await demoCall(backend, "GET", "/api/sms/threads?filter=spam")).status, 400);
    assert.equal((await demoCall(backend, "GET", "/api/sms/threads?limit=lots")).status, 400);
    assert.equal((await demoCall(backend, "GET", "/api/sms/thread")).status, 400);
    assert.equal((await demoCall(backend, "POST", "/api/sms/preview", { content: 5 })).status, 400);
    assert.equal((await demoCall(backend, "POST", "/api/sms/send", { phones: [1], content: "x" })).status, 400);
    backend.stop();
  });
});

describe("Static demo seed", () => {
  it("rebases instants, router-local SMS dates and epoch milliseconds, and nothing else", () => {
    const shifted = rebaseTimestamps(
      {
        capturedAtIso: "2026-10-01T10:00:00.000Z",
        capturedAtMs: Date.parse("2026-10-01T10:00:00.000Z"),
        lastSessionHoldMs: 120,
        date: "2026-10-01 12:00:00",
        monthLastClearDate: "2026-10-01",
        list: [{ tsIso: "2026-10-01T09:00:00Z" }],
        ["__proto__"]: { polluted: true },
      },
      3_600_000,
      120
    );
    assert.equal(shifted.capturedAtIso, "2026-10-01T11:00:00.000Z");
    assert.equal(shifted.capturedAtMs, Date.parse("2026-10-01T11:00:00.000Z"));
    assert.equal(shifted.lastSessionHoldMs, 120);
    assert.equal(shifted.monthLastClearDate, "2026-10-01");
    assert.equal(shifted.list[0]?.tsIso, "2026-10-01T10:00:00.000Z");
    // 12:00 at UTC+2 is 10:00Z; an hour later, written in this machine's zone
    const local = new Date(Date.parse("2026-10-01T11:00:00Z"));
    const pad = (n: number): string => String(n).padStart(2, "0");
    assert.equal(shifted.date, `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}:00`);
    assert.equal(({} as Json)["polluted"], undefined);
  });

  it("opens a seed from before identification, and rejects a malformed device block", async () => {
    const minimal = {
      version: 1,
      capturedAtMs: 1,
      capturedUtcOffsetMin: 0,
      ...Object.fromEntries(["health", "telemetry", "neighbors", "topology", "settings", "alerts", "accessControl"].map((key) => [key, { ok: true }])),
      sms: { status: {}, countries: {}, messages: [], contacts: [] },
      catalog: { "zh-CN": {}, en: {} },
    };
    assert.throws(() => readDemoSeed({ ...minimal, device: { profile: { ok: true }, report: {} } }), /malformed device/);
    assert.equal(readDemoSeed({ ...minimal, device: { profile: { ok: true }, report: { ok: true } } }).version, 1);
  });

  it("rejects a stale or truncated seed file", () => {
    assert.throws(() => readDemoSeed(null), /version/);
    assert.throws(() => readDemoSeed({ version: 1 }), /capture time/);
    assert.throws(() => readDemoSeed({ version: 1, capturedAtMs: 1, capturedUtcOffsetMin: 0 }), /missing health/);
    const full = { version: 1, capturedAtMs: 1, capturedUtcOffsetMin: 0, health: { ok: true }, telemetry: { ok: true }, neighbors: { ok: true }, topology: { ok: true }, settings: { ok: true }, alerts: { ok: true }, accessControl: { ok: true } };
    assert.throws(() => readDemoSeed(full), /missing sms/);
    const sms = { status: {}, countries: {}, messages: [], contacts: [] };
    assert.throws(() => readDemoSeed({ ...full, sms }), /missing catalog/);
    assert.equal(readDemoSeed({ ...full, sms, catalog: { "zh-CN": {}, en: {} } }).version, 1);
    assert.throws(() => new DemoBackend({ seed: readDemoSeed({ ...full, sms, catalog: { "zh-CN": {}, en: {} } }) }), /snapshot is missing/);
  });
});
