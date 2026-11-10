import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import type { SmsStatusSnapshot } from "../src/api-contract.ts";
import { ApiClient, ApiError, classifyApiError, isApiErrorEnvelope } from "../web/src/core/api.ts";
import { createEndpoints } from "../web/src/core/endpoints.ts";
import {
  DASH,
  formatAgo,
  formatBitRate,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDuration,
  formatSigned,
  joinScaled,
  parseDateTimeLocalValue,
  toDateTimeLocalValue,
  toMbps,
} from "../web/src/core/format.ts";
import {
  ALERTS_SEEN_KEY,
  DEFAULT_PREFERENCES,
  type KeyValueStorage,
  PREF_KEYS,
  effectiveTheme,
  isAccentId,
  isThemeId,
  loadAlertsSeen,
  loadPreferences,
  saveAlertsSeen,
  savePreference,
} from "../web/src/core/prefs.ts";
import { type EventSourceLike, SSE_EVENT_NAMES, SseClient, type SseEvent, type SseStatus, backoffDelayMs } from "../web/src/core/sse.ts";
import { LIVE_CAPACITY, MAX_ALERTS, Store, appendLive, initialState, mergeAlerts, reduceSseEvent, seedLive, unreadBadgeCount, unseenAlertCount } from "../web/src/core/store.ts";
import { zhCN } from "../web/src/i18n/zh-CN.ts";

const NOW = new Date(2026, 9, 31, 12, 0, 0); // local time, Saturday 2026-10-31 12:00

interface RecordedRequest {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (url: string, init: RequestInit | undefined) => Promise<Response> | Response): {
  fetchImpl: typeof fetch;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetchImpl, calls };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("web core: API client", () => {
  it("classifies error envelopes into UI states (a breaker is never 'offline')", () => {
    assert.equal(classifyApiError(423, "CIRCUIT_BREAKER_OPEN"), "breaker");
    assert.equal(classifyApiError(423, null), "breaker");
    assert.equal(classifyApiError(409, "BROWSER_SESSION_YIELDED"), "yielded");
    assert.equal(classifyApiError(409, "PEER_DAEMON_ACTIVE"), "peer_standby");
    assert.equal(classifyApiError(503, "QUEUE_FULL"), "unavailable");
    assert.equal(classifyApiError(503, null), "unavailable");
    assert.equal(classifyApiError(502, "SMS_SEND_FAILED"), "sms_send_failed");
    assert.equal(classifyApiError(502, "CPE_UPSTREAM_ERROR"), "upstream");
    assert.equal(classifyApiError(504, null), "upstream");
    assert.equal(classifyApiError(400, "BAD_PAYLOAD"), "validation");
    assert.equal(classifyApiError(401, null), "unauthorized");
    assert.equal(classifyApiError(429, "SSE_LIMIT_REACHED"), "rate_limited");
    assert.equal(classifyApiError(404, null), "not_found");
    assert.equal(classifyApiError(0, null), "network");
    assert.equal(classifyApiError(500, "INTERNAL_ERROR"), "unknown");
    assert.equal(isApiErrorEnvelope({ ok: false, errorCode: "X", message: "m" }), true);
    assert.equal(isApiErrorEnvelope({ ok: true }), false);
    assert.equal(isApiErrorEnvelope(null), false);
  });

  it("sends the CSRF trio on POST and parses JSON", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true, value: 7 }));
    const api = new ApiClient({ fetchImpl });
    assert.deepEqual(await api.post<{ ok: true; value: number }>("/api/x", { a: 1 }), { ok: true, value: 7 });
    assert.deepEqual(await api.get("/api/y"), { ok: true, value: 7 });
    const post = calls[0]?.init;
    const headers = new Headers(post?.headers);
    assert.equal(post?.method, "POST");
    assert.equal(post?.credentials, "same-origin");
    assert.equal(headers.get("x-requested-with"), "XMLHttpRequest");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(post?.body, '{"a":1}');
    assert.equal(calls[1]?.init?.method, "GET");
  });

  it("turns failures into typed ApiErrors and reports a 401 once per request", async () => {
    let unauthorized = 0;
    const { fetchImpl } = fakeFetch((url) => {
      if (url === "/api/breaker") {
        return json(423, { ok: false, errorCode: "CIRCUIT_BREAKER_OPEN", message: "tripped", circuitBreaker: { tripped: true } });
      }
      if (url === "/api/auth") return json(401, { ok: false, errorCode: "UNAUTHORIZED", message: "login" });
      if (url === "/api/html") return new Response("<html>bad gateway</html>", { status: 502 });
      throw new TypeError("fetch failed");
    });
    const api = new ApiClient({ fetchImpl, onUnauthorized: () => (unauthorized += 1) });
    await assert.rejects(api.get("/api/breaker"), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "breaker");
      assert.equal(err.status, 423);
      assert.equal(err.envelope?.circuitBreaker?.tripped, true);
      assert.equal(err.message, "tripped");
      return true;
    });
    await assert.rejects(api.get("/api/auth"), (err: unknown) => err instanceof ApiError && err.kind === "unauthorized");
    assert.equal(unauthorized, 1);
    await assert.rejects(api.get("/api/html"), (err: unknown) => err instanceof ApiError && err.kind === "upstream" && err.envelope === null);
    await assert.rejects(api.get("/api/down"), (err: unknown) => err instanceof ApiError && err.kind === "network" && err.status === 0);
  });

  it("aborts a request that outlives its timeout", async () => {
    const { fetchImpl } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })
    );
    const api = new ApiClient({ fetchImpl, defaultTimeoutMs: 20 });
    await assert.rejects(api.get("/api/slow"), (err: unknown) => err instanceof ApiError && err.kind === "timeout");
  });

  it("never resolves a 2xx whose JSON body did not arrive intact", async () => {
    const { fetchImpl } = fakeFetch((url, init) => {
      if (url === "/api/truncated") return new Response('{"ok":tr', { status: 200, headers: { "Content-Type": "application/json" } });
      // Headers arrive, then the body stalls until the client's timeout aborts it
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const api = new ApiClient({ fetchImpl, defaultTimeoutMs: 20 });
    await assert.rejects(api.get("/api/stalled"), (err: unknown) => err instanceof ApiError && err.kind === "timeout" && err.status === 200);
    await assert.rejects(api.get("/api/truncated"), (err: unknown) => err instanceof ApiError && err.kind === "network" && err.status === 200);
  });

  it("maps every endpoint to its contract path, method and body", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    const ep = createEndpoints(new ApiClient({ fetchImpl }));
    await ep.cellLock({ rat: "NR", band: "N78", arfcn: 650000, pci: 211 });
    await ep.reboot();
    await ep.smsThreads("otp", "Demo&Bank", 50);
    await ep.smsThread("+353830000001");
    await ep.timeseries("preset=6h&maxPoints=360");
    await ep.antenna("external");
    await ep.smsSend({ phone: "+353830000001", content: "hi", countryCode: "+353" });
    assert.deepEqual(
      calls.map((c) => [c.init?.method, c.url]),
      [
        ["POST", "/api/control/cell-lock"],
        ["POST", "/api/control/reboot"],
        ["GET", "/api/sms/threads?filter=otp&search=Demo%26Bank&limit=50"],
        ["GET", "/api/sms/thread?key=%2B353830000001"],
        ["GET", "/api/timeseries?preset=6h&maxPoints=360"],
        ["POST", "/api/control/antenna"],
        ["POST", "/api/sms/send"],
      ]
    );
    assert.equal(calls[1]?.init?.body, '{"confirm":true}');
    assert.equal(calls[5]?.init?.body, '{"mode":"external"}');
  });
});

describe("web core: endpoint table", () => {
  it("calls every REST route of the contract with its method, path and body", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json(200, { ok: true }));
    const ep = createEndpoints(new ApiClient({ fetchImpl }));
    const expected: Record<keyof typeof ep, [method: string, url: string, body?: unknown]> = {
      health: ["GET", "/api/health"],
      authStatus: ["GET", "/api/auth/status"],
      login: ["POST", "/api/auth/login", { password: "t" }],
      logout: ["POST", "/api/auth/logout", {}],
      setupLogin: ["POST", "/api/setup/login", { code: "ABCD-2345", password: "a long passphrase" }],
      resetLogin: ["POST", "/api/auth/reset", { code: "ABCD-2345", password: "a long passphrase" }],
      consoleSettings: ["GET", "/api/console"],
      testConnection: ["POST", "/api/console/cpe/test", { url: "http://192.168.8.1" }],
      saveConnection: ["POST", "/api/console/cpe", { url: "http://192.168.8.1", username: "admin", password: "pw", lastAttempt: true }],
      confirmReview: ["POST", "/api/console/review", {}],
      changePassword: ["POST", "/api/console/password", { current: "old", next: "a long passphrase" }],
      tokens: ["GET", "/api/console/tokens"],
      createToken: ["POST", "/api/console/tokens", { name: "Grafana", permissions: [], lifetimeDays: null }],
      setTokenPermissions: ["POST", "/api/console/tokens/permissions", { id: "t1", permissions: ["sms-read", "control"] }],
      revokeToken: ["POST", "/api/console/tokens/revoke", { id: "t1" }],
      pairingCode: ["POST", "/api/console/telegram/pairing-code", { group: true }],
      unlinkTelegram: ["POST", "/api/console/telegram/unlink-all", {}],
      telegramChats: ["GET", "/api/console/telegram/chats"],
      unlinkTelegramChat: ["POST", "/api/console/telegram/unlink", { chatId: "-1003" }],
      consoleSwitches: ["POST", "/api/console/switches", { metricsEnabled: null }],
      consoleBehaviour: ["POST", "/api/console/behaviour", { agentWrites: true, lockRollbackAfterMin: null }],
      audit: ["GET", "/api/audit?limit=200"],
      deviceProfile: ["GET", "/api/device/profile"],
      deviceReport: ["GET", "/api/console/device-report"],
      experimental: ["GET", "/api/console/experimental"],
      setExperimental: ["POST", "/api/console/experimental", { feature: "reboot", enabled: true, model: "B535-232" }],
      agentTest: ["POST", "/api/console/agent-test", { action: "start", model: "B535-232", tokenId: "t1" }],
      telemetry: ["GET", "/api/telemetry"],
      refreshTelemetry: ["POST", "/api/telemetry/refresh", {}],
      sessionStatus: ["GET", "/api/session/status"],
      timeseries: ["GET", "/api/timeseries?preset=1h"],
      neighbors: ["GET", "/api/neighbors"],
      scanNeighbors: ["POST", "/api/neighbors/scan", {}],
      topology: ["GET", "/api/topology"],
      refreshTopology: ["POST", "/api/topology/refresh", {}],
      settings: ["GET", "/api/settings"],
      refreshSettings: ["POST", "/api/settings/refresh", {}],
      alerts: ["GET", "/api/alerts"],
      bandLock: ["POST", "/api/control/band-lock", { lteBands: ["B3"] }],
      cellLock: ["POST", "/api/control/cell-lock", { rat: "LTE", band: 3, arfcn: 1850, pci: null }],
      unlock: ["POST", "/api/control/unlock", {}],
      reboot: ["POST", "/api/control/reboot", { confirm: true }],
      reconnect: ["POST", "/api/control/reconnect", { confirm: true }],
      security: ["POST", "/api/control/security", { upnpEnabled: false }],
      wifi7: ["POST", "/api/control/wifi7", { mloEnable: true }],
      antenna: ["POST", "/api/control/antenna", { mode: "auto" }],
      mobileData: ["POST", "/api/control/mobile-data", { enabled: false }],
      resetBreaker: ["POST", "/api/session/reset-breaker", {}],
      accessControl: ["GET", "/api/access-control"],
      refreshAccessControl: ["POST", "/api/access-control/refresh", {}],
      wifiAccess: ["POST", "/api/control/wifi-access", { action: "block", macAddress: "00:00:5E:00:53:03", confirm: true }],
      wifiMacFilter: ["POST", "/api/control/wifi-mac-filter", { mode: "off", confirm: true }],
      timeRule: ["POST", "/api/control/time-rule", { action: "delete", id: "1", confirm: true }],
      smsStatus: ["GET", "/api/sms/status"],
      smsCountries: ["GET", "/api/sms/countries"],
      smsThreads: ["GET", "/api/sms/threads?filter=all&search=&limit=500"],
      smsThread: ["GET", "/api/sms/thread?key=alpha%3Ademobank"],
      smsContacts: ["GET", "/api/sms/contacts?search=&limit=5000"],
      smsPreview: ["POST", "/api/sms/preview", { content: "hi" }],
      smsSend: ["POST", "/api/sms/send", { phone: "+353830000001", content: "hi" }],
      smsRead: ["POST", "/api/sms/read", { threadKey: "alpha:demobank" }],
      smsDelete: ["POST", "/api/sms/delete", { uids: ["u1"] }],
      smsTrash: ["GET", "/api/sms/trash"],
      smsRestore: ["POST", "/api/sms/trash/restore", { uids: ["u1"] }],
      smsPurge: ["POST", "/api/sms/trash/purge", { all: true }],
      smsSync: ["POST", "/api/sms/sync", { mode: "full" }],
      contactUpsert: ["POST", "/api/sms/contacts/upsert", { phone: "+353830000001", name: "Demo" }],
      contactDelete: ["POST", "/api/sms/contacts/delete", { id: "c1" }],
      importVcf: ["POST", "/api/sms/contacts/import-vcf", { vcf: "BEGIN:VCARD" }],
    };
    await ep.health();
    await ep.authStatus();
    await ep.login("t");
    await ep.logout();
    await ep.setupLogin("ABCD-2345", "a long passphrase");
    await ep.resetLogin("ABCD-2345", "a long passphrase");
    await ep.consoleSettings();
    await ep.testConnection({ url: "http://192.168.8.1" });
    await ep.saveConnection({ url: "http://192.168.8.1", username: "admin", password: "pw", lastAttempt: true });
    await ep.confirmReview();
    await ep.changePassword("old", "a long passphrase");
    await ep.tokens();
    await ep.createToken({ name: "Grafana", permissions: [], lifetimeDays: null });
    await ep.setTokenPermissions("t1", ["sms-read", "control"]);
    await ep.revokeToken("t1");
    await ep.pairingCode(true);
    await ep.unlinkTelegram();
    await ep.telegramChats();
    await ep.unlinkTelegramChat("-1003");
    await ep.consoleSwitches({ metricsEnabled: null });
    await ep.consoleBehaviour({ agentWrites: true, lockRollbackAfterMin: null });
    await ep.audit();
    await ep.deviceProfile();
    await ep.deviceReport();
    await ep.experimental();
    await ep.setExperimental({ feature: "reboot", enabled: true, model: "B535-232" });
    await ep.agentTest({ action: "start", model: "B535-232", tokenId: "t1" });
    await ep.telemetry();
    await ep.refreshTelemetry();
    await ep.sessionStatus();
    await ep.timeseries("preset=1h");
    await ep.neighbors();
    await ep.scanNeighbors();
    await ep.topology();
    await ep.refreshTopology();
    await ep.settings();
    await ep.refreshSettings();
    await ep.alerts();
    await ep.bandLock({ lteBands: ["B3"] });
    await ep.cellLock({ rat: "LTE", band: 3, arfcn: 1850, pci: null });
    await ep.unlock();
    await ep.reboot();
    await ep.reconnect();
    await ep.security({ upnpEnabled: false });
    await ep.wifi7({ mloEnable: true });
    await ep.antenna("auto");
    await ep.mobileData(false);
    await ep.resetBreaker();
    await ep.accessControl();
    await ep.refreshAccessControl();
    await ep.wifiAccess({ action: "block", macAddress: "00:00:5E:00:53:03", confirm: true });
    await ep.wifiMacFilter({ mode: "off", confirm: true });
    await ep.timeRule({ action: "delete", id: "1", confirm: true });
    await ep.smsStatus();
    await ep.smsCountries();
    await ep.smsThreads("all", "");
    await ep.smsThread("alpha:demobank");
    await ep.smsContacts();
    await ep.smsPreview({ content: "hi" });
    await ep.smsSend({ phone: "+353830000001", content: "hi" });
    await ep.smsRead({ threadKey: "alpha:demobank" });
    await ep.smsDelete(["u1"]);
    await ep.smsTrash();
    await ep.smsRestore(["u1"]);
    await ep.smsPurge({ all: true });
    await ep.smsSync();
    await ep.contactUpsert({ phone: "+353830000001", name: "Demo" });
    await ep.contactDelete("c1");
    await ep.importVcf("BEGIN:VCARD");
    const seen = calls.map((c) => [c.init?.method ?? "", c.url, typeof c.init?.body === "string" ? JSON.parse(c.init.body) : undefined]);
    assert.deepEqual(
      seen,
      Object.values(expected).map(([method, url, body]) => [method, url, body])
    );
  });
});

class FakeEventSource implements EventSourceLike {
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }
}

function sseHarness(authenticated: () => Promise<boolean>) {
  const sources: FakeEventSource[] = [];
  const events: SseEvent[] = [];
  const statuses: SseStatus[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const client = new SseClient({
    url: "/api/events",
    createEventSource: (url) => {
      const es = new FakeEventSource(url);
      sources.push(es);
      return es;
    },
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    isAuthenticated: authenticated,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    now: () => 1_000,
    random: () => 0.5,
  });
  const flushTimers = (): void => {
    for (const [id, timer] of [...timers]) {
      timers.delete(id);
      timer.fn();
    }
  };
  return { client, sources, events, statuses, timers, flushTimers };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("web core: SSE reconnect state machine", () => {
  it("lists the 16 contract events and backs off with capped jitter", () => {
    assert.equal(SSE_EVENT_NAMES.length, 16);
    assert.equal(backoffDelayMs(0, () => 0), 500);
    assert.equal(backoffDelayMs(0, () => 1), 1000);
    assert.equal(backoffDelayMs(3, () => 1), 8000);
    assert.equal(backoffDelayMs(20, () => 1), 30_000);
    assert.equal(backoffDelayMs(-5, () => 0.5), 750);
  });

  it("goes live on hello, dispatches parsed frames and ignores malformed ones", () => {
    const h = sseHarness(async () => true);
    h.client.start();
    assert.equal(h.client.state, "connecting");
    const es = h.sources[0];
    assert.ok(es);
    es.emit("hello", JSON.stringify({ clientId: "c1" }));
    assert.equal(h.client.state, "live");
    es.emit("speed", JSON.stringify({ tsMs: 1, downloadBps: 8, uploadBps: 4 }));
    es.emit("telemetry", "{not json");
    es.emit("telemetry", JSON.stringify(42));
    es.emit("telemetry");
    assert.deepEqual(
      h.events.map((e) => e.name),
      ["hello", "speed"]
    );
    h.client.start(); // already running: no second EventSource
    assert.equal(h.sources.length, 1);
  });

  it("closes the stream on error and reconnects after a backoff while the session is valid", async () => {
    const h = sseHarness(async () => true);
    h.client.start();
    h.sources[0]?.emit("error");
    assert.equal(h.sources[0]?.closed, true);
    await tick();
    assert.equal(h.client.state, "reconnecting");
    assert.equal(h.statuses.at(-1)?.nextRetryAtMs, 1_000 + 750);
    assert.equal(h.timers.size, 1);
    h.sources[0]?.emit("hello", "{}"); // stale stream: ignored
    assert.equal(h.client.state, "reconnecting");
    h.flushTimers();
    assert.equal(h.sources.length, 2);
    h.sources[1]?.emit("error");
    await tick();
    assert.equal(h.statuses.at(-1)?.attempt, 2);
    h.client.reconnectNow();
    assert.equal(h.timers.size, 0);
    assert.equal(h.sources.length, 3);
    h.sources[2]?.emit("hello", "{}");
    assert.equal(h.statuses.at(-1)?.attempt, 0);
  });

  it("stops for good when the session is gone, and stop() clears pending retries", async () => {
    const gone = sseHarness(async () => false);
    gone.client.start();
    gone.sources[0]?.emit("error");
    await tick();
    assert.equal(gone.client.state, "unauthorized");
    assert.equal(gone.timers.size, 0);
    gone.client.start(); // a fresh login restarts it
    assert.equal(gone.sources.length, 2);

    const flaky = sseHarness(async () => {
      throw new Error("daemon down");
    });
    flaky.client.start();
    flaky.sources[0]?.emit("error");
    await tick();
    assert.equal(flaky.client.state, "reconnecting");
    flaky.client.stop();
    assert.equal(flaky.client.state, "stopped");
    assert.equal(flaky.timers.size, 0);
    flaky.client.reconnectNow(); // not reconnecting: no-op
    assert.equal(flaky.sources.length, 1);
  });
});

describe("web core: formatting", () => {
  it("scales rates and sizes in binary steps like the daemon", () => {
    assert.deepEqual(formatBitRate(512), { value: "512", unit: "bps" });
    assert.deepEqual(formatBitRate(100 * 1024 * 1024), { value: "100", unit: "Mbps" });
    assert.deepEqual(formatBitRate(12.34 * 1024 * 1024), { value: "12.3", unit: "Mbps" });
    assert.deepEqual(formatBitRate(1.5 * 1024 ** 3), { value: "1.50", unit: "Gbps" });
    assert.deepEqual(formatBitRate(Number.NaN), { value: "0", unit: "bps" });
    assert.equal(joinScaled(formatBytes(3221225472)), "3.00 GiB");
    assert.equal(joinScaled(formatBytes(1024 ** 5 * 3)), "3072.0 TiB");
    assert.equal(toMbps(1024 * 1024), 1);
  });

  it("formats signed readings, durations, countdowns and relative times", () => {
    assert.equal(formatSigned(-87, "dBm"), "-87 dBm");
    assert.equal(formatSigned(13.5, "dB", 1), "13.5 dB");
    assert.equal(formatSigned(null, "dB"), DASH);
    assert.equal(formatDuration(3 * 86_400 + 4 * 3600 + 5, "zh-CN"), "3天 4小时");
    assert.equal(formatDuration(3600 + 120, "en"), "1h 2m");
    assert.equal(formatDuration(3600, "en"), "1h");
    assert.equal(formatDuration(0, "zh-CN"), "0秒");
    assert.equal(formatDuration(42, "en"), "42s");
    assert.equal(formatCountdown(72302), "20:05:02");
    assert.equal(formatCountdown(2 * 86_400 + 61), "2d 00:01:01");
    assert.equal(formatAgo(0, 2_000, "en"), "just now");
    assert.equal(formatAgo(0, 30_000, "zh-CN"), "30 秒前");
    assert.equal(formatAgo(0, 5 * 60_000, "en"), "5m ago");
    assert.equal(formatAgo(0, 3 * 3_600_000, "zh-CN"), "3 小时前");
    assert.equal(formatAgo(0, 72 * 3_600_000, "en"), "3d ago");
  });

  it("round-trips datetime-local values in local time", () => {
    const ms = NOW.getTime();
    assert.equal(toDateTimeLocalValue(ms), "2026-10-31T12:00");
    assert.equal(parseDateTimeLocalValue("2026-10-31T12:00"), ms);
    assert.equal(parseDateTimeLocalValue("yesterday"), null);
    assert.equal(formatClock(ms, false), "12:00");
    assert.equal(formatClock(ms, true), "10-31 12:00");
  });
});

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  failing = false;

  getItem(key: string): string | null {
    if (this.failing) throw new Error("denied");
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failing) throw new Error("quota");
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("web core: preferences", () => {
  it("validates stored values and falls back to defaults", () => {
    const storage = new MemoryStorage();
    assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
    storage.data.set(PREF_KEYS.theme, "fengsui-ziming");
    storage.data.set(PREF_KEYS.accent, "jade");
    storage.data.set(PREF_KEYS.followSystem, "0");
    storage.data.set(PREF_KEYS.locale, "en");
    storage.data.set(PREF_KEYS.monthlyCapBytes, "107374182400");
    storage.data.set(PREF_KEYS.dailyCapBytes, "-5");
    assert.deepEqual(loadPreferences(storage), {
      ...DEFAULT_PREFERENCES,
      theme: "fengsui-ziming",
      accent: "jade",
      followSystem: false,
      locale: "en",
      dailyCapBytes: null,
      monthlyCapBytes: 107374182400,
    });
    storage.data.set(PREF_KEYS.theme, "<script>");
    storage.data.set(PREF_KEYS.dailyCapBytes, "0");
    assert.equal(loadPreferences(storage).theme, "fengsui-sujian");
    assert.equal(loadPreferences(storage).dailyCapBytes, null);
    storage.failing = true;
    assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES);
  });

  it("persists single fields and survives a throwing storage", () => {
    const storage = new MemoryStorage();
    savePreference(storage, "followSystem", false);
    savePreference(storage, "theme", "fengsui-jiye");
    savePreference(storage, "monthlyCapBytes", 42);
    assert.equal(storage.data.get(PREF_KEYS.followSystem), "0");
    assert.equal(storage.data.get(PREF_KEYS.theme), "fengsui-jiye");
    savePreference(storage, "monthlyCapBytes", null);
    assert.equal(storage.data.has(PREF_KEYS.monthlyCapBytes), false);
    storage.failing = true;
    savePreference(storage, "locale", "en");
    assert.equal(isThemeId("fengsui-chenxi"), true);
    assert.equal(isAccentId("neon"), false);
    const pair = { theme: "fengsui-chenxi", dayTheme: "fengsui-yuebai", nightTheme: "fengsui-konruri" } as const;
    assert.equal(effectiveTheme({ ...pair, followSystem: true }, true), "fengsui-konruri");
    assert.equal(effectiveTheme({ ...pair, followSystem: true }, false), "fengsui-yuebai");
    assert.equal(effectiveTheme({ ...pair, followSystem: false }, true), "fengsui-chenxi");
  });

  it("remembers when this browser last looked at the alerts, so a reload shows nothing it saw as new", () => {
    const storage = new MemoryStorage();
    assert.equal(loadAlertsSeen(storage), "");
    saveAlertsSeen(storage, "2026-11-03T09:30:00.000Z");
    assert.equal(storage.data.get(ALERTS_SEEN_KEY), "2026-11-03T09:30:00.000Z");
    assert.equal(loadAlertsSeen(storage), "2026-11-03T09:30:00.000Z");
    storage.data.set(ALERTS_SEEN_KEY, "<script>");
    assert.equal(loadAlertsSeen(storage), "", "only a timestamp counts");
    storage.failing = true;
    assert.equal(loadAlertsSeen(storage), "");
    saveAlertsSeen(storage, "2026-11-03T09:31:00.000Z");
  });
});

const SMS_STATUS: SmsStatusSnapshot = {
  counters: { localUnread: 2, localInbox: 10, localOutbox: 3, localDraft: 0, localMax: 500 },
  unreadOnCpe: 3,
  storageFull: false,
  storageUsedPercent: 2.6,
  mirror: { messagesTotal: 13, unreadTotal: 2, threadsTotal: 4, trashTotal: 1 },
  contactsTotal: 5,
  seeded: true,
  lastSyncAt: null,
  lastFullSyncAt: null,
  via: "sms-list",
  syncInProgress: false,
  syncPending: true,
  defaultCountryCode: "+353",
  trashDays: 30,
};

describe("web core: state store and SSE reducer", () => {
  it("keeps the live ring ordered and bounded", () => {
    let live = appendLive([], { tsMs: 1, downloadBps: 1, uploadBps: 1 }, 3);
    live = appendLive(live, { tsMs: 2, downloadBps: 2, uploadBps: 2 }, 3);
    live = appendLive(live, { tsMs: 2, downloadBps: 9, uploadBps: 9 }, 3);
    live = appendLive(live, { tsMs: 3, downloadBps: 3, uploadBps: 3 }, 3);
    live = appendLive(live, { tsMs: 4, downloadBps: 4, uploadBps: 4 }, 3);
    assert.deepEqual(
      live.map((s) => s.tsMs),
      [2, 3, 4]
    );
    assert.equal(LIVE_CAPACITY, 720);
  });

  it("seeds the live ring with history buckets that ended before the first live sample", () => {
    const bucket = (tsMs: number, dl: number) => ({ tsMs, dlAvgBps: dl, ulAvgBps: dl / 10 });
    // A fresh page: everything the 5 s tier holds, in order, without duplicate buckets
    assert.deepEqual(seedLive([], [bucket(10_000, 8), bucket(0, 1), bucket(5_000, 4), bucket(5_000, 4)], 5_000), [
      { tsMs: 0, downloadBps: 1, uploadBps: 0.1 },
      { tsMs: 5_000, downloadBps: 4, uploadBps: 0.4 },
      { tsMs: 10_000, downloadBps: 8, uploadBps: 0.8 },
    ]);
    // SSE frames arrived first: only buckets that closed before them, never one covering the same slot
    const live = [{ tsMs: 13_400, downloadBps: 9, uploadBps: 1 }];
    assert.deepEqual(
      seedLive(live, [bucket(0, 1), bucket(5_000, 4), bucket(10_000, 8)], 5_000).map((s) => s.tsMs),
      [0, 5_000, 13_400]
    );
    assert.deepEqual(seedLive(live, [], 5_000), live);
    // Still bounded by the ring capacity, keeping the newest samples
    assert.deepEqual(
      seedLive(live, [bucket(0, 1), bucket(5_000, 4)], 5_000, 2).map((s) => s.tsMs),
      [5_000, 13_400]
    );
  });

  it("deduplicates, orders and caps alerts", () => {
    const mk = (id: string, ts: string) => ({ id, tsIso: ts, severity: "info" as const, code: "WAN_UP", messageZh: "", messageEn: "" });
    const merged = mergeAlerts([mk("a", "2026-10-31T10:00:00Z")], [mk("b", "2026-10-31T09:00:00Z"), mk("a", "2026-10-31T10:00:00Z")]);
    assert.deepEqual(
      merged.map((a) => a.id),
      ["b", "a"]
    );
    const many = Array.from({ length: MAX_ALERTS + 5 }, (_, i) => mk(`x${i}`, new Date(i * 1000).toISOString()));
    assert.equal(mergeAlerts([], many).length, MAX_ALERTS);
  });

  it("counts on the bell the warnings and criticals newer than the last look, never info", () => {
    const mk = (id: string, ts: string, severity: "info" | "warning" | "critical") => ({ id, tsIso: ts, severity, code: "WAN_DOWN", messageZh: "", messageEn: "" });
    const alerts = [mk("a", "2026-10-31T09:00:00.000Z", "warning"), mk("b", "2026-10-31T10:00:00.000Z", "info"), mk("c", "2026-10-31T11:00:00.000Z", "critical")];
    assert.equal(unseenAlertCount(alerts, ""), 2, "never looked: every warning and critical");
    assert.equal(unseenAlertCount(alerts, "2026-10-31T09:00:00.000Z"), 1);
    assert.equal(unseenAlertCount(alerts, "2026-10-31T11:00:00.000Z"), 0);
  });

  it("folds every SSE event into state and the right topics", () => {
    const state = initialState();
    const hello = reduceSseEvent(state, {
      name: "hello",
      data: {
        clientId: "c",
        connectedAtIso: "",
        heartbeatMs: 15000,
        schedulerStatus: { mode: "idle" } as never,
        avoidance: { active: false } as never,
        telemetry: null,
        lockState: { mode: "unlocked" } as never,
        lockVerification: { status: "unknown" } as never,
        sms: null,
      },
    });
    assert.equal(hello.patch.smsEnabled, false);
    assert.deepEqual(hello.topics, ["scheduler", "telemetry", "locks", "sms", "smsMessages"]);
    const avoidance = { active: true, layer: 1, stateCode: "0", sinceIso: null, cooldownUntilMs: null, messageZh: "", messageEn: "" } as const;
    const withScheduler = { ...state, scheduler: { mode: "idle" } as never };
    const av = reduceSseEvent(withScheduler, { name: "session:avoidance", data: avoidance });
    assert.equal(av.patch.scheduler?.avoidance.active, true);
    assert.equal(reduceSseEvent(state, { name: "session:avoidance", data: avoidance }).patch.scheduler, null);
    const speed = reduceSseEvent(state, { name: "speed", data: { tsMs: 5, tsIso: "", downloadBps: 8, uploadBps: 4, downloadRateFormatted: "", uploadRateFormatted: "" } });
    assert.deepEqual(speed.patch.live, [{ tsMs: 5, downloadBps: 8, uploadBps: 4 }]);
    assert.deepEqual(reduceSseEvent(state, { name: "control:applied", data: { action: "reboot_cpe", tsIso: "", summaryZh: "", summaryEn: "" } }).topics, []);
    assert.deepEqual(
      reduceSseEvent(state, { name: "control:applied", data: { action: "lock_band", tsIso: "", summaryZh: "", summaryEn: "", lockState: { mode: "band_lock" } as never } }).topics,
      ["locks"]
    );
    assert.deepEqual(reduceSseEvent(state, { name: "sms:status", data: SMS_STATUS }).patch, { sms: SMS_STATUS, smsEnabled: true });
    assert.deepEqual(reduceSseEvent(state, { name: "sms:updated", data: { action: "read", uids: [] } }).patch, { smsRevision: 1 });
    assert.deepEqual(reduceSseEvent(state, { name: "contacts:updated", data: { total: 3 } }).topics, ["contacts", "smsMessages"]);
    for (const name of ["telemetry", "neighbors", "topology", "settings"] as const) {
      const r = reduceSseEvent(state, { name, data: {} as never });
      assert.deepEqual(r.topics, [name]);
    }
    assert.equal(reduceSseEvent(state, { name: "alert", data: { id: "1", tsIso: "t", severity: "warning", code: "WAN_DOWN", messageZh: "", messageEn: "" } }).patch.alerts?.length, 1);
    for (const name of ["sms:new", "sms:sent", "sms:sync"] as const) {
      assert.deepEqual(reduceSseEvent(state, { name, data: {} as never }).topics, ["smsMessages"]);
    }
  });

  it("notifies each subscriber once per update and stops after unsubscribe", () => {
    const store = new Store();
    let calls = 0;
    const off = store.subscribe(["telemetry", "live"], () => (calls += 1));
    store.update({ telemetry: null }, ["telemetry", "live"]);
    store.apply({ patch: {}, topics: [] });
    store.subscribe("sms", () => undefined);
    off();
    store.update({}, ["telemetry"]);
    assert.equal(calls, 1);
    assert.equal(unreadBadgeCount(SMS_STATUS), 3);
    assert.equal(unreadBadgeCount(null), 0);
    assert.equal(unreadBadgeCount({ ...SMS_STATUS, unreadOnCpe: null }), 2);
  });
});

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const full = path.join(dir, ent.name);
    return ent.isDirectory() ? sourceFiles(full) : ent.name.endsWith(".ts") ? [full] : [];
  });
}

describe("web shell: markup and source guards", () => {
  it("translates every data-i18n key used in index.html", () => {
    const html = fs.readFileSync("web/index.html", "utf8");
    const keys = [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)].map((m) => m[1] ?? "");
    assert.ok(keys.length > 10);
    for (const key of keys) assert.ok(Object.hasOwn(zhCN, key), `index.html uses unknown key ${key}`);
  });

  it("keeps index.html free of inline scripts and external origins (CSP script-src 'self', offline)", () => {
    const html = fs.readFileSync("web/index.html", "utf8");
    for (const tag of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.match(tag[0], /\ssrc="\{\{[A-Z_]+\}\}"/, "every script must be an external same-origin file");
      assert.equal((tag[1] ?? "").trim(), "", "inline script body");
    }
    // Only links out (opened on click): the repository, its GitHub Sponsors page and the author's site
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\/(?!github\.com\/(?:sponsors\/)?cky008|iocky\.com\/")/i, "no CDN or remote asset");
  });

  it("builds every dialog's click-outside layer with the shared helper (translated, out of the tab order)", () => {
    const dom = fs.readFileSync("web/src/ui/dom.ts", "utf8");
    assert.match(dom, /export function modalBackdrop\(label: string\)/);
    assert.match(dom, /tabindex: "-1"/);
    for (const file of sourceFiles("web/src/ui")) {
      if (file.endsWith(path.join("ui", "dom.ts"))) continue;
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"modal-backdrop"/, `${file}: use modalBackdrop(ctx.t("common.close"))`);
    }
  });

  it("never writes HTML from strings and never imports Node built-ins in browser code", () => {
    for (const file of sourceFiles("web/src")) {
      const text = fs.readFileSync(file, "utf8").replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, "");
      assert.doesNotMatch(text, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(|new Function\(|\beval\(/, file);
      assert.doesNotMatch(text, /from\s+"node:/, file);
    }
  });
});
