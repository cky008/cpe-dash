import assert from "node:assert/strict";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { FengSuiHttpServer } from "../src/http-server.ts";
import { FengSuiMcpServer } from "../src/mcp-server.ts";
import { NotificationHub } from "../src/notify/hub.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import { SseEventBus } from "../src/sse-bus.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { type MockSmsCpeOptions, createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";
import { consoleSettingsFor } from "./helpers/console-settings.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

async function createSmsHttpFixture(opts: { smsEnabled?: boolean; mock?: MockSmsCpeOptions } = {}) {
  const mock = createMockSmsCpe({
    messages: [
      { index: 40001, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "0", box: 1 },
      { index: 40002, phone: "+353830000001", content: "Dinner at 7?", date: "2026-10-29 18:00:00", smstat: "0", box: 1 },
    ],
    ...opts.mock,
  });
  const tmpDir = tempDir("fengsui-sms-http-");
  const envPath = path.join(tmpDir, ".env");
  fs.writeFileSync(
    envPath,
    [
      "CPE_URL=http://192.168.8.1",
      `CPE_PASSWORD=${mock.password}`,
      "API_TOKEN=sms_http_api_token",
      "WEB_HOST=127.0.0.1",
      "WEB_PORT=0",
      "ALLOWED_HOSTS=127.0.0.1",
      `STATE_FILE=${path.join(tmpDir, "state.json")}`,
      `STATIC_DIR=${path.join(tmpDir, "no-static")}`,
    ].join("\n")
  );
  const config = loadConfig({ envPath, ignoreProcessEnv: true });
  const stateStore = new EncryptedStateStore({ filePath: config.stateFile, encryptionKey: config.dataEncryptionKey });
  const client = new HuaweiCpeClient({ cpeUrl: config.cpeUrl, cpePassword: config.cpePassword, fetchImpl: mock.fetchImpl });
  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
    smsCountersEnabled: true,
  });
  const scheduler = core.scheduler;
  core.monitor.init();
  const cipher = StorageCipher.fromSecret(config.dataEncryptionKey);
  const contacts = new ContactBook({ filePath: config.contactsFile, cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: config.smsFile, cipher, defaultCountryCode: "+353", contacts });
  const sms = new SmsService({ scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined });
  const sseBus = new SseEventBus({ heartbeatMs: 2000 });
  sseBus.attachCore(core);
  sseBus.attachSms(sms);
  const hub = new NotificationHub({ scheduler, sms, channels: [{ name: "test", notifyAlert: async () => undefined }] });
  hub.start();
  const smsEnabled = opts.smsEnabled !== false;
  const server = new FengSuiHttpServer({
    config,
    core,
    sseBus,
    mcpServer: new FengSuiMcpServer({ allowMutations: true, core }),
    envPath,
    sms: smsEnabled ? sms : null,
    notificationHub: hub,
    settings: consoleSettingsFor(config),
  });
  const bound = await server.listen();
  const baseUrl = `http://${bound.host}:${bound.port}`;
  const headers = { Authorization: "Bearer sms_http_api_token", "Content-Type": "application/json" };
  const get = async (p: string) => {
    const res = await fetch(`${baseUrl}${p}`, { headers });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = async (p: string, body: unknown, extraHeaders: Record<string, string> = {}) => {
    const res = await fetch(`${baseUrl}${p}`, { method: "POST", headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return {
    mock,
    scheduler,
    sms,
    hub,
    sseBus,
    baseUrl,
    headers,
    get,
    post,
    cleanup: async () => {
      hub.stop();
      sseBus.stop();
      await server.close();
      await sms.stop();
      await stopFengSuiCore(core);
      removeTempDir(tmpDir);
    },
  };
}

async function readSseUntil(res: Response, needle: string, timeoutMs = 3000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (!buffer.includes(needle)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`SSE did not deliver ${needle}`);
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`SSE did not deliver ${needle}`)), remaining)),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return buffer;
}

describe("SMS / alert / notification configuration", () => {
  it("parses typed SMS, Telegram, alert and MCP SMS settings with safe fallbacks", () => {
    const tmpDir = tempDir("fengsui-sms-cfg-");
    try {
      const base = { CPE_PASSWORD: "pw_fixture", STATE_FILE: path.join(tmpDir, "data", "state.json") };
      const defaults = loadConfig({ overrides: base, ignoreProcessEnv: true, envPath: path.join(tmpDir, "none.env") });
      assert.equal(defaults.smsEnabled, true);
      assert.equal(defaults.defaultCountryCode, "", "unset: taken from the SIM at runtime");
      assert.equal(defaults.smsFile, path.join(tmpDir, "data", "sms.json"));
      assert.equal(defaults.contactsFile, path.join(tmpDir, "data", "contacts.json"));
      assert.equal(defaults.telegramStateFile, path.join(tmpDir, "data", "telegram.json"));
      assert.equal(defaults.smsFullSyncIntervalMs, 1_800_000);
      assert.equal(defaults.smsSendStatusTimeoutMs, 45_000);
      assert.equal(defaults.alertNotifyMinSeverity, "warning");
      assert.equal(defaults.mcpSmsAccess, "read");
      assert.equal(defaults.mcpSmsSendPolicy, "known");
      assert.equal(defaults.mcpSmsSendLimitPerHour, 10);
      assert.equal(defaults.telegramApiBase, "https://api.telegram.org");
      assert.deepEqual(defaults.telegramChatIds, []);

      const custom = loadConfig({
        overrides: {
          ...base,
          SMS_ENABLED: "false",
          DEFAULT_COUNTRY_CODE: "86",
          SMS_FILE: path.join(tmpDir, "x", "m.json"),
          SMS_FULL_SYNC_INTERVAL_MS: "1000",
          SMS_SEND_STATUS_TIMEOUT_MS: "999999",
          SMS_AUTO_MARK_READ: "yes",
          SMS_SEED_EXISTING_ON_START: "off",
          TELEGRAM_CHAT_IDS: "123, -1001234, bad, ",
          ALERT_NOTIFY_MIN_SEVERITY: "CRITICAL",
          ALERTS_ENABLED: "0",
          ALERT_RSRP_THRESHOLD_DBM: "-105",
          MCP_SMS_ACCESS: "Full",
          MCP_SMS_SEND_POLICY: "whatever",
          MCP_SMS_SEND_LIMIT_PER_HOUR: "-3",
          WEBHOOK_URL: "https://hooks.example.com/x",
        },
        ignoreProcessEnv: true,
        envPath: path.join(tmpDir, "none.env"),
      });
      assert.equal(custom.smsEnabled, false);
      assert.equal(custom.defaultCountryCode, "+86");
      assert.equal(custom.smsFile, path.join(tmpDir, "x", "m.json"));
      assert.equal(custom.smsFullSyncIntervalMs, 60_000);
      assert.equal(custom.smsSendStatusTimeoutMs, 120_000);
      assert.equal(custom.smsAutoMarkRead, true);
      assert.equal(custom.smsSeedExistingOnStart, false);
      assert.deepEqual(custom.telegramChatIds, ["123", "-1001234"]);
      assert.equal(custom.alertNotifyMinSeverity, "critical");
      assert.equal(custom.alertsEnabled, false);
      assert.equal(custom.alertRsrpThresholdDbm, -105);
      assert.equal(custom.mcpSmsAccess, "full");
      assert.equal(custom.mcpSmsSendPolicy, "known");
      assert.equal(custom.mcpSmsSendLimitPerHour, 0);
      assert.equal(custom.webhookUrl, "https://hooks.example.com/x");
      assert.equal(
        loadConfig({ overrides: { ...base, DEFAULT_COUNTRY_CODE: "abc" }, ignoreProcessEnv: true, envPath: path.join(tmpDir, "none.env") })
          .defaultCountryCode,
        "",
        "an unreadable value is ignored: the SIM decides"
      );
    } finally {
      removeTempDir(tmpDir);
    }
  });
});

describe("/api/sms REST routes, /api/alerts and SMS SSE events", () => {
  it("serves status, countries, threads, thread detail and contacts from the mirror", async () => {
    const fx = await createSmsHttpFixture();
    await fx.sms.sync("full");
    const status = await fx.get("/api/sms/status");
    assert.equal(status.status, 200);
    assert.equal((status.body["status"] as { mirror: { messagesTotal: number } }).mirror.messagesTotal, 2);
    const countries = await fx.get("/api/sms/countries");
    assert.equal(countries.body["defaultCountryCode"], "+353");
    assert.equal((countries.body["countries"] as unknown[]).length, 54);

    const threads = await fx.get("/api/sms/threads?filter=otp&limit=5");
    assert.deepEqual((threads.body["threads"] as Array<{ threadKey: string }>).map((t) => t.threadKey), ["alpha:demobank"]);
    const searched = await fx.get("/api/sms/threads?search=dinner");
    assert.equal((searched.body["threads"] as unknown[]).length, 1);
    for (const bad of ["/api/sms/threads?filter=spam", "/api/sms/threads?limit=-1", "/api/sms/thread", `/api/sms/thread?key=${"x".repeat(65)}`]) {
      const res = await fx.get(bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body["errorCode"], "VALIDATION_ERROR");
    }
    const thread = await fx.get("/api/sms/thread?phone=0830000001");
    assert.equal((thread.body["thread"] as { threadKey: string; messages: unknown[] }).threadKey, "+353830000001");
    const contacts = await fx.get("/api/sms/contacts?search=&limit=10");
    assert.deepEqual(contacts.body, { ok: true, total: 0, contacts: [] });
    assert.equal((await fx.get("/api/sms/nope")).status, 404);
    await fx.cleanup();
  });

  it("previews, sends, marks read, deletes and syncs through the guarded POST routes", async () => {
    const fx = await createSmsHttpFixture();
    await fx.sms.sync("full");
    const preview = await fx.post("/api/sms/preview", { phone: "0830000001", content: "你好" });
    assert.equal((preview.body["preview"] as { encoding: { encoding: string } }).encoding.encoding, "UCS2");
    assert.equal((await fx.post("/api/sms/preview", { content: 42 })).status, 400);

    const sent = await fx.post("/api/sms/send", { phone: "0830000001", content: "On my way" });
    assert.equal(sent.status, 200);
    assert.deepEqual(sent.body["resolvedPhones"], ["+353830000001"]);
    assert.equal((sent.body["messages"] as Array<{ content: string }>)[0]?.content, "On my way");
    assert.equal((await fx.post("/api/sms/send", { phones: ["0830000001", 5], content: "x" })).status, 400);
    assert.equal((await fx.post("/api/sms/send", { phone: "abc", content: "x" })).status, 400);
    assert.equal((await fx.post("/api/sms/send", { phone: "0830000001" })).status, 400);
    assert.equal((await fx.post("/api/sms/send", { phones: Array(6).fill("0830000001"), content: "x" })).status, 400);

    const read = await fx.post("/api/sms/read", { threadKey: "+353830000001" });
    assert.deepEqual([read.status, read.body["count"]], [200, 1]);
    const otpUid = fx.sms.getThread("alpha:demobank").messages[0]!.uid;
    assert.equal((await fx.post("/api/sms/delete", { uids: ["unknown"] })).status, 400);
    assert.equal((await fx.post("/api/sms/delete", {})).status, 400);
    const deleted = await fx.post("/api/sms/delete", { uids: [otpUid] });
    assert.deepEqual(deleted.body, { ok: true, deleted: 1, uids: [otpUid], trashDays: 30 });
    assert.deepEqual(fx.mock.deleteBatches, [[40001]]);

    assert.equal((await fx.post("/api/sms/sync", { mode: "weekly" })).status, 400);
    const synced = await fx.post("/api/sms/sync", {});
    assert.equal((synced.body["summary"] as { mode: string }).mode, "full");
    const incremental = await fx.post("/api/sms/sync", { mode: "incremental" });
    assert.equal(incremental.status, 200);
    assert.equal((await fx.post("/api/sms/unknown", {})).status, 404);
    const put = await fetch(`${fx.baseUrl}/api/sms/send`, { method: "PUT", headers: fx.headers });
    assert.equal(put.status, 405);
    const anon = await fetch(`${fx.baseUrl}/api/sms/status`);
    assert.equal(anon.status, 401);
    await fx.cleanup();
  });

  it("lists and restores Recently deleted with a token, and deletes for good only from a signed-in console", async () => {
    const fx = await createSmsHttpFixture();
    try {
      await fx.sms.sync("full");
      const otpUid = fx.sms.getThread("alpha:demobank").messages[0]!.uid;
      const dinnerUid = fx.sms.getThread("+353830000001").messages[0]!.uid;
      await fx.post("/api/sms/delete", { uids: [otpUid, dinnerUid] });

      const listed = await fx.get("/api/sms/trash");
      assert.equal(listed.status, 200);
      assert.equal(listed.body["trashDays"], 30);
      const messages = listed.body["messages"] as Array<{ uid: string; deletedAtIso: string; purgeAtIso: string; content: string }>;
      assert.deepEqual(messages.map((m) => m.uid).sort(), [otpUid, dinnerUid].sort());
      assert.ok(messages.every((m) => Date.parse(m.purgeAtIso) - Date.parse(m.deletedAtIso) === 30 * 24 * 60 * 60_000));

      assert.equal((await fx.post("/api/sms/trash/restore", { uids: ["unknown"] })).status, 400);
      assert.equal((await fx.post("/api/sms/trash/restore", {})).status, 400);
      assert.deepEqual((await fx.post("/api/sms/trash/restore", { uids: [dinnerUid] })).body, { ok: true, restored: 1, uids: [dinnerUid] });
      assert.equal(fx.sms.getThread("+353830000001").messages[0]?.localOnly, true);

      // For good: never with a token, however strong
      const refused = await fx.post("/api/sms/trash/purge", { all: true });
      assert.deepEqual([refused.status, refused.body["errorCode"]], [403, "CONSOLE_ONLY"]);
      assert.equal(fx.sms.listTrash().length, 1);

      const origin = fx.baseUrl;
      const console = (cookie: string) => ({ "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest", Origin: origin, Cookie: cookie });
      const login = await fetch(`${fx.baseUrl}/api/auth/login`, { method: "POST", headers: console(""), body: JSON.stringify({ password: "sms_http_api_token" }) });
      assert.equal(login.status, 200);
      const cookie = `fengsui_sid=${/fengsui_sid=([0-9a-f]{64})/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? ""}`;
      const purge = async (body: unknown) => {
        const res = await fetch(`${fx.baseUrl}/api/sms/trash/purge`, { method: "POST", headers: console(cookie), body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };
      assert.equal((await purge({ uids: ["unknown"] })).status, 400);
      assert.equal((await purge({ all: "yes" })).status, 400);
      assert.equal((await purge({})).status, 400);
      assert.deepEqual((await purge({ uids: [otpUid] })).body, { ok: true, purged: 1, uids: [otpUid] });
      assert.deepEqual((await purge({ all: true })).body, { ok: true, purged: 0, uids: [] });
      assert.equal(fx.sms.listTrash().length, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("maps router send failures to 502 SMS_SEND_FAILED and a yielding router to 409", async () => {
    const fx = await createSmsHttpFixture({ mock: { sendOutcome: "fail", pendingStatusPolls: 0 } });
    await fx.sms.sync("full");
    const failed = await fx.post("/api/sms/send", { phones: ["+353830000001"], content: "x" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body["errorCode"], "SMS_SEND_FAILED");
    assert.match(String(failed.body["message"]), /code 113018/);
    fx.mock.control.stateLoginXml = () =>
      "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";
    const yielded = await fx.post("/api/sms/send", { phone: "+353830000001", content: "x" });
    assert.equal(yielded.status, 409);
    assert.equal(yielded.body["errorCode"], "BROWSER_SESSION_YIELDED");
    await fx.cleanup();
  });

  it("answers 423 CIRCUIT_BREAKER_OPEN once a wrong password tripped the breaker, without another login", async () => {
    const fx = await createSmsHttpFixture({
      mock: { intercept: (p) => (p === "/api/user/authentication_login" ? "<error><code>108006</code><remaincount>2</remaincount></error>" : undefined) },
    });
    try {
      const logins = (): number => fx.mock.requests.filter((r) => r.path === "/api/user/authentication_login").length;
      const first = await fx.post("/api/sms/send", { phone: "+353830000001", content: "x" });
      assert.equal(first.status, 423);
      assert.equal(first.body["errorCode"], "CIRCUIT_BREAKER_OPEN");
      const breaker = first.body["circuitBreaker"] as { code: string; remainCount: number };
      assert.deepEqual([breaker.code, breaker.remainCount], ["108006", 2]);
      assert.match(String(first.body["message"]), /Settings → Router/, "the way out: fix the password in the console");
      const retried = await fx.post("/api/sms/send", { phone: "+353830000001", content: "x" });
      assert.equal(retried.status, 423);
      assert.equal(logins(), 1, "the latched breaker spends no second password attempt");
    } finally {
      await fx.cleanup();
    }
  });

  it("manages contacts including large vCard imports beyond the default 64 KiB body cap", async () => {
    const fx = await createSmsHttpFixture();
    const saved = await fx.post("/api/sms/contacts/upsert", { phone: "0830000001", name: "Aoife", note: "neighbour" });
    const id = (saved.body["contact"] as { id: string }).id;
    assert.equal((await fx.post("/api/sms/contacts/upsert", { phone: "0830000001" })).status, 400);
    assert.deepEqual((await fx.post("/api/sms/contacts/delete", { id })).body, { ok: true, deleted: true });

    // Numbers in the spare country code 999 (no subscriber anywhere): the reserved test blocks hold too few
    const cards = Array.from({ length: 900 }, (_, i) => `BEGIN:VCARD\nFN:Person ${i}\nNOTE:${"n".repeat(60)}\nTEL:+9992${String(i).padStart(7, "0")}\nEND:VCARD`).join("\n");
    assert.ok(cards.length > 64 * 1024);
    const imported = await fx.post("/api/sms/contacts/import-vcf", { vcf: cards });
    assert.equal(imported.status, 200);
    assert.equal((imported.body["summary"] as { added: number }).added, 900);
    const huge = await fetch(`${fx.baseUrl}/api/sms/contacts/import-vcf`, {
      method: "POST",
      headers: fx.headers,
      body: JSON.stringify({ vcf: "x".repeat(4 * 1024 * 1024 + 10) }),
    }).catch(() => null);
    assert.ok(huge === null || huge.status === 413);
    await fx.cleanup();
  });

  it("streams SMS events and the SMS status snapshot over /api/events, and lists alerts", async () => {
    const fx = await createSmsHttpFixture();
    await fx.sms.sync("full");
    const stream = await fetch(`${fx.baseUrl}/api/events`, { headers: { Authorization: "Bearer sms_http_api_token" } });
    const pending = readSseUntil(stream, "event: contacts:updated");
    await new Promise((r) => setTimeout(r, 30));
    await fx.post("/api/sms/send", { phone: "0830000001", content: "Streamed" });
    await fx.post("/api/sms/contacts/upsert", { phone: "0830000009", name: "Brian" });
    const frames = await pending;
    assert.match(frames, /event: hello\ndata: .*"sms":\{"counters"/);
    assert.match(frames, /event: sms:sent\ndata: .*"source":"web"/);
    assert.match(frames, /event: sms:status/);
    assert.match(frames, /event: contacts:updated\ndata: \{"total":1\}/);

    fx.scheduler.raiseAlert({ severity: "warning", code: "WAN_DOWN", messageZh: "z", messageEn: "e" });
    await new Promise((r) => setTimeout(r, 10));
    const alerts = await fx.get("/api/alerts");
    assert.equal((alerts.body["alerts"] as Array<{ code: string }>).at(-1)?.code, "WAN_DOWN");
    assert.deepEqual(alerts.body["notifications"], { test: { delivered: 1, failed: 0, lastError: null } });
    await fx.cleanup();
  });

  it("answers 404 SMS_DISABLED when SMS is turned off", async () => {
    const fx = await createSmsHttpFixture({ smsEnabled: false });
    const res = await fx.get("/api/sms/status");
    assert.equal(res.status, 404);
    assert.equal(res.body["errorCode"], "SMS_DISABLED");
    await fx.cleanup();
  });
});
