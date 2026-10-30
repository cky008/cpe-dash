import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { NotificationHub, type NotificationChannel, isAlertSeverity } from "../src/notify/hub.ts";
import { TelegramApi, TelegramApiError, normalizeTelegramApiBase } from "../src/notify/telegram-api.ts";
import { TelegramBot, TelegramStateStore, type TelegramUpdate, escapeTelegramHtml } from "../src/notify/telegram-bot.ts";
import { WebhookNotifier, normalizeWebhookUrl, signWebhookPayload } from "../src/notify/webhook.ts";
import { MutexSessionScheduler } from "../src/scheduler.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import type { EnrichedSmsMessage } from "../src/sms/types.ts";
import { type AlertEventRecord, EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";

const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuv";
const HUMAN_LOGGED_IN = "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";

interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

function createFakeTelegram(opts: { updates?: TelegramUpdate[][]; vcf?: string } = {}) {
  const calls: TgCall[] = [];
  let messageSeq = 100;
  const batches = [...(opts.updates ?? [])];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/file/")) return new Response(opts.vcf ?? "", { status: 200 });
    const method = url.pathname.split("/").pop() ?? "";
    calls.push({ method, payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === "sendMessage") return ok({ message_id: ++messageSeq });
    if (method === "getFile") return ok({ file_path: "documents/contacts.vcf", file_size: (opts.vcf ?? "").length });
    if (method === "getUpdates") {
      const batch = batches.shift();
      if (batch) return ok(batch);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 20);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
      return ok([]);
    }
    return ok(true);
  };
  const sends = (chatId?: string) =>
    calls.filter((c) => c.method === "sendMessage" && (chatId === undefined || c.payload["chat_id"] === chatId));
  const lastText = (chatId: string) => String(sends(chatId).at(-1)?.payload["text"] ?? "");
  const buttons = (call: TgCall | undefined) =>
    ((call?.payload["reply_markup"] as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)?.inline_keyboard ?? [])
      .flat()
      .map((b) => b.callback_data);
  return { fetchImpl, calls, sends, lastText, buttons, of: (method: string) => calls.filter((c) => c.method === method) };
}

function createBotFixture(opts: { smsEnabled?: boolean; vcf?: string; updates?: TelegramUpdate[][] } = {}) {
  const mock = createMockSmsCpe({
    messages: [
      { index: 40001, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "0", box: 1 },
      { index: 40002, phone: "+353830000001", content: "Dinner at 7?", date: "2026-10-29 18:00:00", smstat: "0", box: 1 },
      { index: 40003, phone: "+353830000001", content: "Sure", date: "2026-10-29 18:05:00", smstat: "3", box: 2 },
    ],
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-notify-"));
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "bot_key" });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const scheduler = new MutexSessionScheduler({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
    smsCountersEnabled: true,
  });
  scheduler.init();
  const cipher = StorageCipher.fromSecret("bot_key");
  const contacts = new ContactBook({ filePath: path.join(tmpDir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(tmpDir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const service = new SmsService({ scheduler, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined, seedExistingOnStart: false });
  const tg = createFakeTelegram({ vcf: opts.vcf, updates: opts.updates });
  const api = new TelegramApi({ token: TOKEN, fetchImpl: tg.fetchImpl });
  const state = new TelegramStateStore({ filePath: path.join(tmpDir, "telegram.json"), cipher });
  let clock = Date.parse("2026-10-30T10:00:00Z");
  const logs: string[] = [];
  const bot = new TelegramBot({
    api,
    scheduler,
    state,
    sms: opts.smsEnabled === false ? null : service,
    authToken: "dashboard_api_token",
    allowedChatIds: ["1001"],
    locale: "en",
    now: () => clock,
    log: (line) => logs.push(line),
  });
  let updateId = 0;
  const message = (chatId: number, text: string, extra: Partial<NonNullable<TelegramUpdate["message"]>> = {}) =>
    bot.handleUpdate({ update_id: ++updateId, message: { message_id: 500 + updateId, chat: { id: chatId }, text, ...extra } });
  const callback = (chatId: number, data: string, messageId = 777) =>
    bot.handleUpdate({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, data, message: { message_id: messageId, chat: { id: chatId } } } });
  return {
    mock,
    scheduler,
    service,
    contacts,
    state,
    bot,
    tg,
    logs,
    message,
    callback,
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: async () => {
      await bot.stop();
      await service.stop();
      await scheduler.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("TelegramApi transport", () => {
  it("validates the token format and normalizes the Bot API base URL", () => {
    assert.throws(() => new TelegramApi({ token: "not-a-token" }), /invalid format/);
    assert.throws(() => new TelegramApi({ token: "123:short" }), /invalid format/);
    assert.equal(normalizeTelegramApiBase("https://tg.example.com/bot-api/"), "https://tg.example.com/bot-api");
    assert.throws(() => normalizeTelegramApiBase("ftp://tg.example.com"), /http\(s\)/);
    assert.throws(() => normalizeTelegramApiBase("https://user:pw@tg.example.com"), /credentials/);
    assert.throws(() => normalizeTelegramApiBase("https://tg.example.com/?x=1"), /query/);
  });

  it("maps API failures without ever leaking the token and bounds file downloads", async () => {
    const responses: Array<() => Response | Promise<Response>> = [
      () => new Response(JSON.stringify({ ok: true, result: { id: 1 } })),
      () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked" }), { status: 403 }),
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("<html>gateway</html>", { status: 502 }),
      () => new Response(JSON.stringify({ ok: true, result: { file_path: "../../etc/passwd" } })),
      () => new Response(JSON.stringify({ ok: true, result: { file_path: "docs/big.vcf", file_size: 10_000 } })),
      () => new Response(JSON.stringify({ ok: true, result: { file_path: "docs/a.vcf" } })),
      () => new Response("x".repeat(50), { status: 200 }),
      () => new Response(JSON.stringify({ ok: true, result: { file_path: "docs/a.vcf" } })),
      () => new Response("missing", { status: 404 }),
    ];
    const urls: string[] = [];
    const api = new TelegramApi({
      token: TOKEN,
      apiBase: "https://tg.example.com",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return await responses.shift()!();
      },
    });
    assert.equal((await api.call<{ id: number }>("getMe")).id, 1);
    assert.equal(urls[0], `https://tg.example.com/bot${TOKEN}/getMe`);
    for (const pattern of [/\(403\): Forbidden: bot was blocked/, /fetch failed/, /invalid JSON response/]) {
      await assert.rejects(
        () => api.call("sendMessage", { chat_id: 1 }),
        (err: unknown) => err instanceof TelegramApiError && pattern.test(err.message) && !err.message.includes(TOKEN)
      );
    }
    await assert.rejects(() => api.call("bad method!"), /Invalid Telegram method/);
    await assert.rejects(() => api.downloadFileText("f1", 1000), /missing file path/);
    await assert.rejects(() => api.downloadFileText("f2", 1000), /exceeds 1000 bytes/);
    await assert.rejects(() => api.downloadFileText("f3", 10), /exceeds 10 bytes/);
    await assert.rejects(() => api.downloadFileText("f4", 1000), /\(404\): download failed/);
  });
});

describe("WebhookNotifier", () => {
  it("posts timestamp-signed JSON and retries once on network errors and 5xx", async () => {
    const seen: Array<{ headers: Headers; body: string }> = [];
    const statuses = [503, 200];
    const notifier = new WebhookNotifier({
      url: "https://hooks.example.com/fengsui",
      secret: "hook_secret",
      now: () => Date.parse("2026-10-30T10:00:00Z"),
      sleep: async () => undefined,
      fetchImpl: async (_input, init) => {
        seen.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response(null, { status: statuses.shift() ?? 200 });
      },
    });
    await notifier.notifyAlert({ id: "a1", tsIso: "2026-10-30T10:00:00Z", severity: "warning", code: "WAN_DOWN", messageZh: "zh", messageEn: "en" });
    assert.equal(seen.length, 2);
    const first = seen[0]!;
    const timestamp = first.headers.get("x-fengsui-timestamp") ?? "";
    assert.equal(timestamp, String(Date.parse("2026-10-30T10:00:00Z") / 1000));
    assert.equal(first.headers.get("x-fengsui-signature"), signWebhookPayload("hook_secret", timestamp, first.body));
    assert.equal(
      first.headers.get("x-fengsui-signature"),
      `sha256=${crypto.createHmac("sha256", "hook_secret").update(`${timestamp}.${first.body}`).digest("hex")}`
    );
    assert.equal(first.headers.get("x-fengsui-event"), "alert");
    const body = JSON.parse(first.body) as { event: string; data: { alert: { code: string } } };
    assert.equal(body.event, "alert");
    assert.equal(body.data.alert.code, "WAN_DOWN");

    let attempts = 0;
    const flaky = new WebhookNotifier({
      url: "http://192.168.8.10:9000/hook",
      sleep: async () => undefined,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        return new Response("ok", { status: 200 });
      },
    });
    await flaky.notifySms({ uid: "u1" } as unknown as EnrichedSmsMessage);
    assert.equal(attempts, 2);
  });

  it("does not retry client errors, omits the signature without a secret, and validates the URL", async () => {
    let calls = 0;
    let headers = new Headers();
    const notifier = new WebhookNotifier({
      url: "https://hooks.example.com/x",
      sleep: async () => undefined,
      fetchImpl: async (_input, init) => {
        calls += 1;
        headers = new Headers(init?.headers);
        return new Response(null, { status: 400 });
      },
    });
    await assert.rejects(() => notifier.deliver("alert", {}), /responded 400/);
    assert.equal(calls, 1);
    assert.equal(headers.get("x-fengsui-signature"), null);
    assert.throws(() => normalizeWebhookUrl("file:///etc/passwd"), /http\(s\)/);
    assert.throws(() => normalizeWebhookUrl("https://u:p@hooks.example.com"), /credentials/);
    assert.equal(normalizeWebhookUrl(" https://hooks.example.com/a?b=1 "), "https://hooks.example.com/a?b=1");
  });
});

describe("NotificationHub", () => {
  it("filters alerts by severity, fans SMS out to every channel and isolates channel failures", async () => {
    const fx = createBotFixture();
    const received: string[] = [];
    const good: NotificationChannel = {
      name: "good",
      notifySms: async (m) => {
        received.push(`sms:${m.uid}`);
      },
      notifyAlert: async (a) => {
        received.push(`alert:${a.code}`);
      },
    };
    const broken: NotificationChannel = {
      name: "broken",
      notifySms: async () => {
        throw new Error("down");
      },
    };
    const logs: string[] = [];
    const hub = new NotificationHub({ scheduler: fx.scheduler, sms: fx.service, channels: [good, broken], alertMinSeverity: "warning", log: (l) => logs.push(l) });
    hub.start();
    hub.start();
    fx.scheduler.raiseAlert({ severity: "info", code: "WAN_UP", messageZh: "z", messageEn: "e" });
    fx.scheduler.raiseAlert({ severity: "critical", code: "CPE_UNREACHABLE", messageZh: "z", messageEn: "e" });
    fx.service.emit("sms:new", { uid: "m1" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(received.sort(), ["alert:CPE_UNREACHABLE", "sms:m1"]);
    assert.deepEqual(hub.getStats()["broken"], { delivered: 0, failed: 1, lastError: "down" });
    assert.equal(hub.getStats()["good"]?.delivered, 2);
    assert.match(logs[0] ?? "", /broken failed to deliver sms\.received: down/);
    hub.stop();
    hub.stop();
    fx.service.emit("sms:new", { uid: "m2" });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(received.length, 2);
    assert.equal(isAlertSeverity("warning"), true);
    assert.equal(isAlertSeverity("loud"), false);
    await fx.cleanup();
  });
});

describe("TelegramBot", () => {
  it("authorizes chats with the API token, deletes the token message and rate-limits guesses", async () => {
    const fx = createBotFixture();
    await fx.message(2002, "/inbox");
    assert.match(fx.tg.lastText("2002"), /not authorized[\s\S]*<code>2002<\/code>/);
    await fx.message(2002, "/auth");
    assert.match(fx.tg.lastText("2002"), /Usage: <code>\/auth/);
    for (let i = 0; i < 5; i++) await fx.message(2002, "/auth wrong-token");
    assert.match(fx.tg.lastText("2002"), /Wrong token/);
    await fx.message(2002, "/auth dashboard_api_token");
    assert.match(fx.tg.lastText("2002"), /Verification paused/);
    assert.ok(fx.tg.of("deleteMessage").length >= 7);

    fx.advance(11 * 60_000);
    await fx.message(2002, "/auth dashboard_api_token");
    assert.match(fx.tg.lastText("2002"), /Linked/);
    assert.equal(fx.state.isAuthorized("2002", []), true);
    await fx.message(2002, "/auth@FengSuiBot dashboard_api_token");
    assert.match(fx.tg.lastText("2002"), /already authorized/);
    await fx.state.flush();
    await fx.cleanup();
  });

  it("delivers SMS cards with OTP, buttons and reply routing, then sends replies to the bound number", async () => {
    const fx = createBotFixture();
    fx.state.authorize("1002");
    const announced: EnrichedSmsMessage[] = [];
    fx.service.on("sms:new", (m: EnrichedSmsMessage) => announced.push(m));
    await fx.service.sync("full");
    const otp = announced.find((m) => m.phone === "DemoBank")!;
    const personal = announced.find((m) => m.phone === "+353830000001")!;
    await fx.bot.notifySms(otp);
    await fx.bot.notifySms(personal);

    const otpCard = fx.tg.sends("1001")[0];
    assert.match(String(otpCard?.payload["text"]), /🔑 Code <code>482913<\/code>/);
    assert.doesNotMatch(String(otpCard?.payload["text"]), /Reply to this message/);
    assert.deepEqual(fx.tg.buttons(otpCard), [`read:${otp.uid}`, "chat:alpha:demobank", `del:${otp.uid}`]);
    assert.equal(fx.tg.sends("1002").length, 2);

    const personalCard = fx.tg.sends("1001")[1]!;
    assert.match(String(personalCard.payload["text"]), /Reply to this message to text \+353830000001/);
    const cardId = 100 + fx.tg.sends().indexOf(personalCard) + 1;
    await fx.message(1001, "Thanks, see you!", { reply_to_message: { message_id: cardId } });
    assert.match(fx.mock.sentRequests[0] ?? "", /Thanks, see you!/);
    const edits = fx.tg.of("editMessageText").map((c) => String(c.payload["text"]));
    assert.ok(edits.some((t) => /✅ <b>Sent<\/b> · \+353830000001/.test(t)));

    // Replies to unbound messages fall through to the help text
    await fx.message(1001, "random chatter", { reply_to_message: { message_id: 9999 } });
    assert.match(fx.tg.lastText("1001"), /FengSui · 5G CPE assistant/);
    assert.equal(escapeTelegramHtml("<b>&"), "&lt;b&gt;&amp;");
    await fx.cleanup();
  });

  it("runs the guided send wizard with country switch, contact pick, segment preview and confirmation", async () => {
    const fx = createBotFixture();
    await fx.service.sync("full");
    fx.service.upsertContact({ phone: "0830000001", name: "Aoife" });
    fx.service.upsertContact({ phone: "0830000005", name: "Aoife Work" });

    await fx.message(1001, "/new");
    assert.match(fx.tg.lastText("1001"), /step 1: recipient[\s\S]*Ireland \(\+353\)/);
    assert.ok(fx.tg.buttons(fx.tg.sends("1001").at(-1)).includes("wizcc:+44"));
    await fx.callback(1001, "wizcc:+44");
    assert.match(String(fx.tg.of("editMessageText").at(-1)?.payload["text"]), /United Kingdom \(\+44\)/);

    await fx.message(1001, "Aoife");
    assert.match(fx.tg.lastText("1001"), /Choose a recipient/);
    assert.ok(fx.tg.buttons(fx.tg.sends("1001").at(-1)).includes("wizpick:+353830000005"));
    await fx.callback(1001, "wizpick:+353830000005");
    assert.match(fx.tg.lastText("1001"), /step 2: text[\s\S]*Aoife Work · \+353830000005/);

    await fx.message(1001, "x".repeat(700));
    assert.match(fx.tg.lastText("1001"), /Too long[\s\S]*Needs 5 segments/);
    await fx.message(1001, "Hello from the wizard <3");
    assert.match(fx.tg.lastText("1001"), /confirm[\s\S]*7BIT · 1 segment[\s\S]*Hello from the wizard &lt;3/);
    await fx.message(1001, "typing instead of tapping");
    assert.match(fx.tg.lastText("1001"), /Tap “Send now”/);
    await fx.callback(1001, "wizback:content");
    assert.match(fx.tg.lastText("1001"), /step 2: text/);
    await fx.message(1001, "Hello from the wizard <3");
    await fx.callback(1001, "wizsend:1");
    assert.match(fx.mock.sentRequests.at(-1) ?? "", /Hello from the wizard &lt;3/);
    await fx.callback(1001, "wizsend:1");
    assert.equal(fx.mock.sentRequests.length, 1);

    // Plain numbers, invalid input, unknown names, cancel and expiry
    await fx.message(1001, "/new");
    await fx.message(1001, "12");
    assert.match(fx.tg.lastText("1001"), /Failed: Invalid recipient/);
    await fx.message(1001, "Zed");
    assert.match(fx.tg.lastText("1001"), /No contact matches “Zed”/);
    await fx.message(1001, "0830000002");
    assert.match(fx.tg.lastText("1001"), /\+353830000002/);
    await fx.callback(1001, "wizback:phone");
    assert.match(fx.tg.lastText("1001"), /step 1: recipient/);
    await fx.callback(1001, "wizcancel:1");
    assert.match(String(fx.tg.of("editMessageText").at(-1)?.payload["text"]), /Cancelled/);
    await fx.message(1001, "/new");
    fx.advance(16 * 60_000);
    await fx.message(1001, "0830000002");
    assert.match(fx.tg.lastText("1001"), /FengSui · 5G CPE assistant/);
    await fx.message(1001, "/cancel");
    assert.match(fx.tg.lastText("1001"), /Cancelled/);
    await fx.cleanup();
  });

  it("requires a confirmation tap for /send and serves read commands from caches", async () => {
    const fx = createBotFixture();
    await fx.service.sync("full");
    await fx.message(1001, "/send 0830000001 Quick hi");
    assert.match(fx.tg.lastText("1001"), /confirm[\s\S]*Quick hi/);
    assert.equal(fx.mock.sentRequests.length, 0);
    await fx.callback(1001, "wizsend:1");
    assert.equal(fx.mock.sentRequests.length, 1);
    await fx.message(1001, "/send nope text");
    assert.match(fx.tg.lastText("1001"), /Invalid recipient/);
    await fx.message(1001, "/send");
    assert.match(fx.tg.lastText("1001"), /step 1: recipient/);

    const logins = fx.mock.getLoginCount();
    await fx.message(1001, "/inbox 99");
    assert.match(fx.tg.lastText("1001"), /Conversations<\/b> · page 1\/1 · 2 total/);
    await fx.message(1001, "/unread");
    assert.match(fx.tg.lastText("1001"), /Unread<\/b> · 2 conversation\(s\)[\s\S]*🔑 <code>482913<\/code>/);
    await fx.message(1001, "/chat 0830000001");
    assert.match(fx.tg.lastText("1001"), /\+353830000001<\/b> · 3 message\(s\)/);
    await fx.message(1001, "/chat");
    assert.match(fx.tg.lastText("1001"), /Usage: <code>\/chat/);
    await fx.message(1001, "/chat +353830000099");
    assert.match(fx.tg.lastText("1001"), /No messages with/);
    await fx.message(1001, "/contact 0830000009 Brian <script>");
    assert.match(fx.tg.lastText("1001"), /Contact saved[\s\S]*Brian &lt;script&gt;/);
    await fx.message(1001, "/contact bad");
    assert.match(fx.tg.lastText("1001"), /Usage: <code>\/contact/);
    await fx.message(1001, "/contact 12 X");
    assert.match(fx.tg.lastText("1001"), /Failed: Invalid recipient/);
    await fx.message(1001, "/contacts brian");
    assert.match(fx.tg.lastText("1001"), /Contacts<\/b> · 1\/1/);
    await fx.message(1001, "/contacts zzz");
    assert.match(fx.tg.lastText("1001"), /empty or nothing matched/);
    await fx.message(1001, "/alerts");
    assert.match(fx.tg.lastText("1001"), /No alerts/);
    fx.scheduler.raiseAlert({ severity: "critical", code: "CPE_UNREACHABLE", messageZh: "离线", messageEn: "offline" });
    await fx.message(1001, "/alerts");
    assert.match(fx.tg.lastText("1001"), /🚨 <b>CPE_UNREACHABLE<\/b>[\s\S]*offline/);
    await fx.message(1001, "/status");
    assert.match(fx.tg.lastText("1001"), /No telemetry yet[\s\S]*SMS: unread 2[\s\S]*Session: idle/);
    assert.equal(fx.mock.getLoginCount(), logins);

    await fx.scheduler.refreshTelemetry();
    await fx.message(1001, "/status");
    assert.match(fx.tg.lastText("1001"), /📡 <b>/);
    await fx.message(1001, "/sync");
    assert.match(fx.tg.lastText("1001"), /Synced/);
    await fx.message(1001, "/frobnicate");
    assert.match(fx.tg.lastText("1001"), /Unknown command <code>\/frobnicate<\/code>/);
    await fx.message(1001, "/help");
    assert.deepEqual(fx.tg.buttons(fx.tg.sends("1001").at(-1)), ["wizstart:1", "inbox:1", "unread:1", "status:1"]);
    await fx.cleanup();
  });

  it("handles read, read-all and delete-with-confirmation callbacks plus vCard imports", async () => {
    const fx = createBotFixture({ vcf: "BEGIN:VCARD\nFN:Cara\nTEL:0830000003\nEND:VCARD" });
    await fx.service.sync("full");
    const unread = fx.service.getThread("+353830000001").messages.find((m) => m.isUnread)!;
    await fx.callback(1001, `read:${unread.uid}`);
    assert.deepEqual(fx.mock.setReadBatches, [[40002]]);
    assert.equal(fx.tg.of("editMessageReplyMarkup").length, 1);

    const otp = fx.service.getThread("alpha:demobank").messages[0]!;
    await fx.callback(1001, `del:${otp.uid}`);
    const confirm = fx.tg.of("editMessageReplyMarkup").at(-1);
    assert.deepEqual(
      (confirm?.payload["reply_markup"] as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]?.map((b) => b.callback_data),
      [`delok:${otp.uid}`, "delno:0"]
    );
    assert.equal(fx.mock.deleteBatches.length, 0);
    await fx.callback(1001, "delno:0");
    await fx.callback(1001, `delok:${otp.uid}`);
    assert.deepEqual(fx.mock.deleteBatches, [[40001]]);
    await fx.callback(1001, `delok:${otp.uid}`);
    const answers = fx.tg.of("answerCallbackQuery");
    assert.match(String(answers.at(-1)?.payload["text"]), /Unknown message uid/);
    assert.equal(answers.at(-1)?.payload["show_alert"], true);

    fx.mock.store.find((m) => m.index === 40003)!.smstat = "3";
    fx.mock.pushIncoming({ phone: "+353830000004", content: "New one", date: "2026-10-30 08:00:00" });
    await fx.service.sync("full");
    await fx.callback(1001, "readall:1");
    assert.equal(fx.service.getStatus().mirror.unreadTotal, 0);
    for (const data of ["inbox:1", "unread:1", "chat:+353830000001", "status:1", "noop:1"]) await fx.callback(1001, data);
    assert.match(fx.tg.lastText("1001"), /Session: idle/);

    await fx.bot.handleUpdate({
      update_id: 900,
      message: { message_id: 901, chat: { id: 1001 }, document: { file_id: "f1", file_name: "contacts.vcf", file_size: 40 } },
    });
    assert.match(fx.tg.lastText("1001"), /Contacts imported[\s\S]*added 1/);
    await fx.bot.handleUpdate({
      update_id: 902,
      message: { message_id: 903, chat: { id: 1001 }, document: { file_id: "f2", file_name: "big.vcf", file_size: 5 * 1024 * 1024 } },
    });
    assert.match(fx.tg.lastText("1001"), /Contact import failed: vCard file exceeds/);
    await fx.callback(4040, "read:x");
    assert.equal(fx.tg.of("answerCallbackQuery").at(-1)?.payload["show_alert"], true);
    await fx.cleanup();
  });

  it("mutes alert delivery, explains yielding, and hides SMS commands when SMS is disabled", async () => {
    const fx = createBotFixture();
    const alert: AlertEventRecord = { id: "a", tsIso: "2026-10-30T10:00:00Z", severity: "warning", code: "WAN_DOWN", messageZh: "断开", messageEn: "down" };
    await fx.message(1001, "/mute 2h");
    assert.match(fx.tg.lastText("1001"), /muted until 2026-10-30T12:00:00\.000Z/);
    const before = fx.tg.sends().length;
    await fx.bot.notifyAlert(alert);
    assert.equal(fx.tg.sends().length, before);
    fx.advance(3 * 3_600_000);
    await fx.bot.notifyAlert(alert);
    assert.match(fx.tg.lastText("1001"), /⚠️ <b>WAN_DOWN<\/b>\ndown/);
    await fx.message(1001, "/mute 1d");
    await fx.message(1001, "/mute off");
    assert.match(fx.tg.lastText("1001"), /resumed/);
    await fx.message(1001, "/mute forever");
    assert.match(fx.tg.lastText("1001"), /Usage: <code>\/mute 30m/);

    await fx.service.sync("full");
    fx.mock.control.stateLoginXml = () => HUMAN_LOGGED_IN;
    await fx.message(1001, "/send 0830000001 hi");
    await fx.callback(1001, "wizsend:1");
    assert.match(String(fx.tg.of("editMessageText").at(-1)?.payload["text"]), /yielding politely/);
    await fx.callback(1001, `read:${fx.service.getThread("alpha:demobank").messages[0]!.uid}`);
    assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /yielding politely/);
    await fx.cleanup();

    const off = createBotFixture({ smsEnabled: false });
    await off.message(1001, "/inbox");
    assert.match(off.tg.lastText("1001"), /SMS is disabled/);
    await off.message(1001, "/status");
    assert.doesNotMatch(off.tg.lastText("1001"), /SMS: unread/);
    await off.callback(1001, "wizstart:1");
    assert.match(String(off.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /SMS is disabled/);
    await off.message(1001, "/help");
    assert.equal(off.tg.sends("1001").at(-1)?.payload["reply_markup"], undefined);
    await off.bot.notifySms({ uid: "u", threadKey: "+1", sender: { dialable: false, flag: "", countryZh: "", countryEn: "", type: "other" }, phone: "x", content: "c", date: "d", isUnread: false } as unknown as EnrichedSmsMessage);
    await off.cleanup();
  });

  it("long-polls getUpdates, dispatches updates, backs off on errors and stops cleanly", async () => {
    const fx = createBotFixture({ updates: [[{ update_id: 41, message: { message_id: 1, chat: { id: 1001 }, text: "/help" } }]] });
    await fx.bot.start();
    await fx.bot.start();
    const started = Date.now();
    while (!fx.tg.sends("1001").length && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 5));
    assert.match(fx.tg.lastText("1001"), /assistant/);
    assert.equal(fx.tg.of("setMyCommands").length, 1);
    const commands = fx.tg.of("setMyCommands")[0]?.payload["commands"] as Array<{ command: string }>;
    assert.ok(commands.some((c) => c.command === "new"));
    await fx.bot.stop();
    const polls = fx.tg.of("getUpdates");
    assert.equal(polls.at(-1)?.payload["offset"], 42);
    await fx.cleanup();
  });
});
