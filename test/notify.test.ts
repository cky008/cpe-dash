import assert from "node:assert/strict";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import crypto from "node:crypto";
import path from "node:path";
import { describe, it } from "node:test";
import { HuaweiCpeClient } from "../src/cpe-client.ts";
import type { GlobalTelemetrySnapshot } from "../src/cpe-domain.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { NotificationHub, type NotificationChannel, isAlertSeverity } from "../src/notify/hub.ts";
import { TelegramApi, TelegramApiError, normalizeTelegramApiBase } from "../src/notify/telegram-api.ts";
import { TelegramBot, type TelegramBotOptions, TelegramStateStore, type TelegramUpdate, escapeTelegramHtml, truncateTelegramHtml } from "../src/notify/telegram-bot.ts";
import { WebhookNotifier, normalizeWebhookUrl, signWebhookPayload } from "../src/notify/webhook.ts";
import { ContactBook } from "../src/sms/contacts.ts";
import { SmsMirrorStore } from "../src/sms/mirror.ts";
import { SmsService } from "../src/sms/service.ts";
import type { EnrichedSmsMessage } from "../src/sms/types.ts";
import { type AlertEventRecord, EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { createMockSmsCpe } from "./helpers/mock-sms-cpe.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnopqrstuv";
const HUMAN_LOGGED_IN = "<response><State>0</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>";

interface TgCall {
  method: string;
  payload: Record<string, unknown>;
}

function createFakeTelegram(opts: { updates?: TelegramUpdate[][]; vcf?: string; failPolls?: boolean; sendDelayMs?: number; rateLimitPolls?: number } = {}) {
  const calls: TgCall[] = [];
  /** Switch at run time: `"network"` fails every sendMessage like an unreachable host, a number is a Telegram error code. */
  const failures: { send?: "network" | number } = {};
  /** Forum topics deleted or closed since: a sendMessage into one is refused the way Telegram does. */
  const goneTopics = new Set<number>();
  let completedSends = 0;
  let messageSeq = 100;
  const batches = [...(opts.updates ?? [])];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/file/")) return new Response(opts.vcf ?? "", { status: 200 });
    const method = url.pathname.split("/").pop() ?? "";
    calls.push({ method, payload: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === "sendMessage") {
      if (failures.send === "network") throw new TypeError("fetch failed");
      const thread = calls.at(-1)?.payload["message_thread_id"];
      if (typeof thread === "number" && goneTopics.has(thread)) {
        return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message thread not found" }), { status: 400 });
      }
      if (failures.send === 429) {
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } }), { status: 429 });
      }
      if (typeof failures.send === "number") {
        return new Response(JSON.stringify({ ok: false, error_code: failures.send, description: "Forbidden: bot was blocked by the user" }), { status: failures.send });
      }
      if (opts.sendDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.sendDelayMs));
      completedSends += 1;
      return ok({ message_id: ++messageSeq });
    }
    if (method === "getFile") return ok({ file_path: "documents/contacts.vcf", file_size: (opts.vcf ?? "").length });
    if (method === "getMe") return ok({ id: 42, is_bot: true, username: "FengSuiBot" });
    if (method === "getUpdates") {
      if (opts.failPolls) throw new TypeError("fetch failed");
      if (opts.rateLimitPolls) {
        const retryAfter = opts.rateLimitPolls;
        return new Response(JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`, parameters: { retry_after: retryAfter } }), { status: 429 });
      }
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
  return {
    fetchImpl,
    calls,
    failures,
    goneTopics,
    sends,
    lastText,
    buttons,
    completedSends: () => completedSends,
    of: (method: string) => calls.filter((c) => c.method === method),
  };
}

function createBotFixture(
  opts: {
    smsEnabled?: boolean;
    vcf?: string;
    updates?: TelegramUpdate[][];
    failPolls?: boolean;
    sendDelayMs?: number;
    rateLimitPolls?: number;
    linkSecret?: TelegramBotOptions["linkSecret"];
    allowedChatIds?: string[];
    /** Where the bot reads the default country (the daemon passes the SIM's once it is known). */
    country?: () => string;
    /** "Got it" under the AI agent test's reminder. */
    acknowledgeAgentTest?: () => boolean;
  } = {}
) {
  const mock = createMockSmsCpe({
    messages: [
      { index: 40001, phone: "DemoBank", content: "Your verification code is 482913", date: "2026-10-29 09:00:00", smstat: "0", box: 1 },
      { index: 40002, phone: "+353830000001", content: "Dinner at 7?", date: "2026-10-29 18:00:00", smstat: "0", box: 1 },
      { index: 40003, phone: "+353830000001", content: "Sure", date: "2026-10-29 18:05:00", smstat: "3", box: 2 },
    ],
  });
  const tmpDir = tempDir("fengsui-notify-");
  const stateStore = new EncryptedStateStore({ filePath: path.join(tmpDir, "state.json"), encryptionKey: "bot_key" });
  const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: mock.password, fetchImpl: mock.fetchImpl });
  const core = createFengSuiCore({
    client,
    stateStore,
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 24 }),
    pollIntervalMs: 60_000,
    smsCountersEnabled: true,
  });
  const scheduler = core.scheduler;
  core.monitor.init();
  const cipher = StorageCipher.fromSecret("bot_key");
  const contacts = new ContactBook({ filePath: path.join(tmpDir, "contacts.json"), cipher, defaultCountryCode: "+353" });
  const mirror = new SmsMirrorStore({ filePath: path.join(tmpDir, "sms.json"), cipher, defaultCountryCode: "+353", contacts });
  const service = new SmsService({ scheduler, monitor: core.monitor, mirror, contacts, defaultCountryCode: "+353", sleep: async () => undefined, seedExistingOnStart: false });
  const tg = createFakeTelegram({ vcf: opts.vcf, updates: opts.updates, failPolls: opts.failPolls, sendDelayMs: opts.sendDelayMs, rateLimitPolls: opts.rateLimitPolls });
  const api = new TelegramApi({ token: TOKEN, fetchImpl: tg.fetchImpl });
  let clock = Date.parse("2026-10-30T10:00:00Z");
  const state = new TelegramStateStore({ filePath: path.join(tmpDir, "telegram.json"), cipher, now: () => clock });
  const logs: string[] = [];
  const bot = new TelegramBot({
    api,
    core,
    state,
    sms: opts.smsEnabled === false ? null : service,
    authToken: "dashboard_api_token",
    ...(opts.linkSecret ? { linkSecret: opts.linkSecret } : {}),
    ...(opts.acknowledgeAgentTest ? { acknowledgeAgentTest: opts.acknowledgeAgentTest } : {}),
    allowedChatIds: opts.allowedChatIds ?? ["1001"],
    defaultCountryCode: opts.country ?? "+353",
    locale: "en",
    now: () => clock,
    log: (line) => logs.push(line),
  });
  let updateId = 0;
  const message = (chatId: number, text: string, extra: Partial<NonNullable<TelegramUpdate["message"]>> = {}) =>
    // Telegram gives private chats positive IDs and groups negative ones
    bot.handleUpdate({ update_id: ++updateId, message: { message_id: 500 + updateId, chat: { id: chatId, type: chatId > 0 ? "private" : "group" }, text, ...extra } });
  /** `topic`: the forum topic of the card the button is on. */
  const callback = (chatId: number, data: string, messageId = 777, fromId?: number, topic?: number) =>
    bot.handleUpdate({
      update_id: ++updateId,
      callback_query: {
        id: `cb${updateId}`,
        data,
        message: { message_id: messageId, chat: { id: chatId }, ...(topic !== undefined ? { message_thread_id: topic, is_topic_message: true } : {}) },
        ...(fromId !== undefined ? { from: { id: fromId } } : {}),
      },
    });
  /** callback_data of the "Send now" button on the card last sent to this chat. */
  const sendButton = (chatId: number): string =>
    tg.buttons(tg.sends(String(chatId)).at(-1)).find((data) => data.startsWith("wizsend:")) ?? "wizsend:missing";
  return {
    mock,
    core,
    scheduler,
    service,
    contacts,
    state,
    bot,
    tg,
    logs,
    message,
    callback,
    sendButton,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    cipher,
    stateFile: path.join(tmpDir, "telegram.json"),
    cleanup: async () => {
      await bot.stop();
      await service.stop();
      await stopFengSuiCore(core);
      // Linking and unlinking save telegram.json in the background: removing the dir under it fails with ENOTEMPTY
      await state.flush();
      removeTempDir(tmpDir);
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
    // The bot token travels in the URL path: plain http is only acceptable to a LAN Bot API server
    assert.throws(() => normalizeTelegramApiBase("http://tg.example.com"), /https/);
    assert.equal(normalizeTelegramApiBase("http://192.168.8.10:8081"), "http://192.168.8.10:8081");
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
    // SMS bodies and one-time codes must not cross the internet in clear text
    assert.throws(() => normalizeWebhookUrl("http://hooks.example.com/x"), /https/);
    assert.throws(() => normalizeWebhookUrl("http://203.0.113.10/x"), /https/);
    assert.equal(normalizeWebhookUrl("http://192.168.8.10:8123/api/webhook/x"), "http://192.168.8.10:8123/api/webhook/x");
    assert.equal(normalizeWebhookUrl("http://homeassistant.local:8123/x"), "http://homeassistant.local:8123/x");
  });
});

describe("NotificationHub", () => {
  it("announces a recovery wherever its problem was announced, and a dropped carrier as a warning", async () => {
    const fx = createBotFixture();
    try {
      for (const minSeverity of ["warning", "critical"] as const) {
        const received: string[] = [];
        const channel: NotificationChannel = {
          name: "tg",
          notifyAlert: async (a) => {
            received.push(a.code);
          },
        };
        const hub = new NotificationHub({ scheduler: fx.scheduler, channels: [channel], alertMinSeverity: minSeverity });
        for (const code of ["WAN_UP", "SIGNAL_RECOVERED", "LOCK_REALIGNED", "CA_DROPPED", "CPE_RECOVERED", "DUPLICATE_DAEMON_CLEARED", "TEST_NOTE"]) {
          await hub.dispatchAlert({ id: code, tsIso: "2026-11-02T08:00:00.000Z", severity: "info", code, messageZh: code, messageEn: code });
        }
        assert.deepEqual(
          received,
          minSeverity === "warning"
            ? ["WAN_UP", "SIGNAL_RECOVERED", "LOCK_REALIGNED", "CA_DROPPED", "CPE_RECOVERED", "DUPLICATE_DAEMON_CLEARED"]
            : ["CPE_RECOVERED", "DUPLICATE_DAEMON_CLEARED"],
          minSeverity
        );
      }
    } finally {
      await fx.cleanup();
    }
  });

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
    fx.scheduler.raiseAlert({ severity: "info", code: "TEST_NOTE", messageZh: "z", messageEn: "e" });
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

describe("Telegram HTML truncation", () => {
  /** Tags left open (Telegram rejects unbalanced HTML with 400 "can't parse entities"). */
  const unbalanced = (html: string): string[] => {
    const open: string[] = [];
    for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
      if (m[1]) open.splice(open.lastIndexOf(m[2] ?? ""), 1);
      else open.push(m[2] ?? "");
    }
    return open;
  };

  it("cuts long HTML without splitting a tag or an entity and closes what it left open", () => {
    const html = `<b>Title</b>\n<blockquote>${"a &amp; b &lt;c&gt; ".repeat(400)}</blockquote>\n<i>tail</i>`;
    for (const max of [100, 101, 102, 103, 104, 1000, 3900]) {
      const cut = truncateTelegramHtml(html, max);
      assert.ok(cut.length <= max, `${cut.length} > ${max}`);
      assert.deepEqual(unbalanced(cut), [], `balanced at ${max}`);
      assert.doesNotMatch(cut, /&[a-z#0-9]*(?![a-z#0-9;])(?=…|<|$)/i, `no dangling entity at ${max}`);
      assert.doesNotMatch(cut, /<[^>]*$/, `no dangling tag at ${max}`);
      assert.match(cut, /…/);
    }
    assert.equal(truncateTelegramHtml("<b>short</b>", 3900), "<b>short</b>");
  });

  it("keeps /chat on a thread of long messages within Telegram's limit and valid", async () => {
    const fx = createBotFixture();
    for (let i = 0; i < 10; i++) fx.service.mirror.addPending("+353830000001", `${"Long <reply> & more ".repeat(30)}${i}`, `2026-10-30 10:0${i}:00`);
    await fx.message(1001, "/chat 0830000001");
    const text = fx.tg.lastText("1001");
    assert.ok(text.length <= 4096, `${text.length} characters`);
    assert.deepEqual(unbalanced(text), []);
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
    assert.match(fx.tg.lastText("2002"), /Wrong code or token/);
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

  it("forgets failed /auth attempts once their window has passed, however many chats tried", async () => {
    const fx = createBotFixture();
    try {
      for (let chat = 3000; chat < 3015; chat++) await fx.message(chat, "/auth wrong-token");
      assert.equal(fx.bot.authFailureChats, 15);
      fx.advance(11 * 60_000);
      await fx.message(3100, "/auth wrong-token");
      assert.equal(fx.bot.authFailureChats, 1, "only the chat whose failure is inside the window is kept");
      await fx.message(3200, "/auth");
      assert.equal(fx.bot.authFailureChats, 1, "asking for the usage leaves nothing behind");
    } finally {
      await fx.cleanup();
    }
  });

  it("refuses tokens and private codes in groups, voiding the code, and stays quiet there until linked", async () => {
    const outcomes: Array<[string, string]> = [];
    const fx = createBotFixture({
      linkSecret: (secret, where) => {
        outcomes.push([secret, where]);
        return secret === "PRIV-CODE" ? (where === "private" ? "linked" : "private-only") : "invalid";
      },
    });
    const deletesBefore = fx.tg.of("deleteMessage").length;
    await fx.message(-1003, "/auth PRIV-CODE", { from: { id: 7001 } });
    assert.match(fx.tg.lastText("-1003"), /Not a group pairing code[\s\S]*now void/);
    assert.equal(fx.state.isAuthorized("-1003", []), false);
    assert.equal(fx.tg.of("deleteMessage").length, deletesBefore + 1, "still tries to take the message down");
    assert.deepEqual(outcomes, [["PRIV-CODE", "group"]]);

    // Sent anonymously (as the group) nobody can be named its owner: refused before the code is spent
    await fx.message(-1003, "/auth GRP-CODE", { sender_chat: { id: -1003 } });
    assert.match(fx.tg.lastText("-1003"), /Cannot tell who sent/);
    assert.equal(outcomes.length, 1);

    // Unlinked group: commands get the card, chatter gets nothing
    const sendsBefore = fx.tg.sends("-1003").length;
    await fx.message(-1003, "good morning", { from: { id: 7001 } });
    assert.equal(fx.tg.sends("-1003").length, sendsBefore);
    await fx.message(-1003, "/inbox", { from: { id: 7001 } });
    assert.match(fx.tg.lastText("-1003"), /not authorized/);

    // The default secret (a full token) links private chats only
    const plain = createBotFixture();
    await plain.message(-1005, "/auth dashboard_api_token", { from: { id: 7001 } });
    assert.match(plain.tg.lastText("-1005"), /Not a group pairing code/);
    assert.equal(plain.state.isAuthorized("-1005", []), false);
    await plain.message(2002, "/auth dashboard_api_token");
    assert.equal(plain.state.isAuthorized("2002", []), true);
    await plain.cleanup();
    await fx.cleanup();
  });

  it("answers in the forum topic a command, a reply or a button came from in a TELEGRAM_CHAT_IDS group", async () => {
    const fx = createBotFixture({ allowedChatIds: ["1001", "-1004"] });
    try {
      const topic = { message_thread_id: 77, is_topic_message: true };
      const lastTopic = () => fx.tg.sends("-1004").at(-1)?.payload["message_thread_id"];
      for (const command of ["/status", "/help", "/alerts", "/unread", "/inbox", "/contacts", "/mute 1h", "/mute off", "/reset", "/chat", "/nope", "/cancel"]) {
        const before = fx.tg.sends("-1004").length;
        await fx.message(-1004, command, topic);
        assert.equal(fx.tg.sends("-1004").length, before + 1, `${command} answered`);
        assert.equal(lastTopic(), 77, command);
      }
      // The send wizard and its confirmation stay in the topic, step by step
      await fx.message(-1004, "/new", topic);
      assert.equal(lastTopic(), 77, "/new");
      await fx.message(-1004, "+353830000001", topic);
      assert.match(fx.tg.lastText("-1004"), /step 2: text/);
      assert.equal(lastTopic(), 77, "the content step");
      await fx.message(-1004, "See you there", topic);
      assert.match(fx.tg.lastText("-1004"), /New SMS · confirm/);
      assert.equal(lastTopic(), 77, "the confirmation");
      // A button on a card in the topic answers there too
      await fx.callback(-1004, "status:1", 778, undefined, 77);
      assert.equal(lastTopic(), 77, "status button");
      await fx.callback(-1004, "inbox:1", 779, undefined, 77);
      assert.equal(lastTopic(), 77, "inbox button");

      // The General topic and the group's notifications have no topic to answer in
      await fx.message(-1004, "/status");
      assert.equal(lastTopic(), undefined, "General");
      await fx.callback(-1004, "status:1");
      assert.equal(lastTopic(), undefined, "a button in General");
      await fx.bot.notifyAlert({ id: "a1", tsIso: "2026-10-30T10:00:00.000Z", severity: "warning", code: "SIGNAL_WEAK", messageZh: "信号弱", messageEn: "Signal weak" });
      assert.equal(lastTopic(), undefined, "notifications");
      assert.equal(fx.tg.sends("1001").at(-1)?.payload["message_thread_id"], undefined, "a private chat never gets a topic");
    } finally {
      await fx.cleanup();
    }
  });

  it("lists every chat with how and when it was linked, unlinks one at a time, and keeps that across restarts", async () => {
    const fx = createBotFixture({
      allowedChatIds: ["1001", "-1004"],
      linkSecret: (secret, where) => {
        if (secret === "TOKEN-A") return where === "private" ? { outcome: "linked", tokenId: "tok-a" } : { outcome: "private-only", tokenId: null };
        if (secret === "PAIR-CODE") return where === "private" ? "linked" : "private-only";
        return secret === "GRP-CODE" ? "linked" : "invalid";
      },
    });
    try {
      const t0 = fx.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      await fx.message(2002, "/auth TOKEN-A");
      fx.advance(60_000);
      await fx.message(2003, "/auth PAIR-CODE");
      fx.advance(60_000);
      await fx.message(-1003, "/auth GRP-CODE", { from: { id: 7001 }, message_thread_id: 55, is_topic_message: true });
      const records = fx.bot.chatRecords((tokenId) => (tokenId === "tok-a" ? "Phone" : null));
      assert.deepEqual(records, [
        { chatId: "-1003", kind: "group", fromEnv: false, linkedWith: "group-code", tokenName: null, linkedBy: "7001", topic: 55, linkedAtIso: iso(t0 + 120_000) },
        { chatId: "2003", kind: "private", fromEnv: false, linkedWith: "code", tokenName: null, linkedBy: null, topic: null, linkedAtIso: iso(t0 + 60_000) },
        { chatId: "2002", kind: "private", fromEnv: false, linkedWith: "token", tokenName: "Phone", linkedBy: null, topic: null, linkedAtIso: iso(t0) },
        { chatId: "1001", kind: "private", fromEnv: true, linkedWith: null, tokenName: null, linkedBy: null, topic: null, linkedAtIso: null },
        { chatId: "-1004", kind: "group", fromEnv: true, linkedWith: null, tokenName: null, linkedBy: null, topic: null, linkedAtIso: null },
      ]);
      assert.equal(fx.bot.chatRecords()[2]?.tokenName, null, "no token names without a lookup");

      // One chat goes, with the send it had started; the others and .env stay
      await fx.message(2003, "/new");
      assert.equal(fx.bot.unlinkChat("2003"), true);
      assert.equal(fx.state.isAuthorized("2003", fx.bot.allowedChatIds), false);
      assert.equal(fx.bot.unlinkChat("2003"), false, "not linked any more");
      assert.equal(fx.bot.unlinkChat("1001"), false, "only .env authorizes it");
      assert.equal(fx.state.isAuthorized("1001", fx.bot.allowedChatIds), true);
      assert.ok(fx.logs.some((line) => line.includes("unlinked a chat from the console")));
      fx.advance(60_000);
      await fx.message(2003, "/auth PAIR-CODE");
      await fx.message(2003, "+353830000001");
      assert.doesNotMatch(fx.tg.lastText("2003"), /step 2: text/, "the old send did not come back with the new link");
      assert.equal(fx.bot.chatRecords().find((chat) => chat.chatId === "2003")?.linkedAtIso, iso(t0 + 180_000));

      // A supergroup migration keeps how and when the group was linked; a restart reads it all back
      await fx.message(-1003, "", { migrate_to_chat_id: -100555 });
      await fx.state.flush();
      const reloaded = new TelegramStateStore({ filePath: fx.stateFile, cipher: fx.cipher });
      reloaded.load();
      assert.deepEqual(reloaded.linkedChats().sort((a, b) => a.chatId.localeCompare(b.chatId)), [
        { chatId: "-100555", group: { userId: "7001", threadId: 55 }, viaTokenId: null, linkedAtMs: t0 + 120_000 },
        { chatId: "2002", group: null, viaTokenId: "tok-a", linkedAtMs: t0 },
        { chatId: "2003", group: null, viaTokenId: null, linkedAtMs: t0 + 180_000 },
      ]);
      reloaded.revokeAll();
      assert.deepEqual(reloaded.linkedChats(), []);
      await reloaded.flush();
    } finally {
      await fx.cleanup();
    }
  });

  it("links a group with a group code: it posts to that topic, and only the member who linked it acts there", async () => {
    const fx = createBotFixture({ linkSecret: (secret) => (secret === "GRP-CODE" ? "linked" : "invalid") });
    const owner = { from: { id: 7001 } };
    const member = { from: { id: 7002 } };
    await fx.message(-1003, "/auth GRP-CODE", { ...owner, message_thread_id: 55, is_topic_message: true });
    assert.match(fx.tg.lastText("-1003"), /Group linked[\s\S]*every member can read them/);
    assert.equal(fx.state.isAuthorized("-1003", []), true);
    assert.deepEqual(fx.state.groupLink("-1003"), { userId: "7001", threadId: 55 });
    assert.equal(fx.tg.sends("-1003").at(-1)?.payload["message_thread_id"], 55);

    const announced: EnrichedSmsMessage[] = [];
    fx.service.on("sms:new", (m: EnrichedSmsMessage) => announced.push(m));
    await fx.service.sync("full");
    await fx.bot.notifySms(announced.find((m) => m.phone === "DemoBank")!);
    assert.equal(fx.tg.sends("-1003").at(-1)?.payload["message_thread_id"], 55, "notifications go to the linked topic");
    assert.equal(fx.tg.sends("1001").at(-1)?.payload["message_thread_id"], undefined, "private chats have no topic");

    // Another member can read the group but not act in it
    const sendsBefore = fx.tg.sends("-1003").length;
    await fx.message(-1003, "/status", member);
    await fx.message(-1003, "/new", member);
    assert.equal(fx.tg.sends("-1003").length, sendsBefore);
    const uid = fx.service.getThread("alpha:demobank").messages[0]!.uid;
    await fx.callback(-1003, `del:${uid}`, 777, 7002);
    assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /Only the person who linked this group/);
    await fx.callback(-1003, `del:${uid}`, 777);
    assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /Only the person who linked this group/);

    await fx.message(-1003, "/status", owner);
    assert.match(fx.tg.lastText("-1003"), /SMS: unread/);
    await fx.callback(-1003, `del:${uid}`, 777, 7001);
    assert.ok(fx.tg.buttons(fx.tg.of("editMessageReplyMarkup").at(-1)).some((data) => data.startsWith("delok:")));
    // Chatter in the group is not answered with the help text, and /reset stays private
    const quiet = fx.tg.sends("-1003").length;
    await fx.message(-1003, "lunch?", owner);
    assert.equal(fx.tg.sends("-1003").length, quiet);
    await fx.message(-1003, "/reset", owner);
    assert.match(fx.tg.lastText("-1003"), /private chat/);

    // The group becomes a supergroup: the link follows it to the new ID
    await fx.message(-1003, "", { migrate_to_chat_id: -1009 });
    assert.equal(fx.state.isAuthorized("-1003", []), false);
    assert.deepEqual(fx.state.groupLink("-1009"), { userId: "7001", threadId: 55 });
    await fx.message(-1009, "", { migrate_from_chat_id: -1003 });
    assert.equal(fx.state.isAuthorized("-1009", []), true);

    // The link survives a restart, and unlinking all forgets it
    await fx.state.flush();
    const reloaded = new TelegramStateStore({ filePath: fx.state.filePath, cipher: StorageCipher.fromSecret("bot_key") });
    reloaded.load();
    assert.deepEqual(reloaded.groupLink("-1009"), { userId: "7001", threadId: 55 });
    fx.bot.unlinkAllChats();
    assert.equal(fx.state.groupLink("-1009"), null);
    await fx.cleanup();
  });

  it("unlinks the chats a token linked when that token is revoked, and only those", async () => {
    const fx = createBotFixture({
      linkSecret: (secret, where) =>
        secret === "fsk_phone_token"
          ? { outcome: where === "private" ? "linked" : "private-only", tokenId: "tok-phone" }
          : secret === "PAIR-CODE"
            ? "linked"
            : "invalid",
    });
    await fx.message(2001, "/auth fsk_phone_token");
    await fx.message(2002, "/auth PAIR-CODE");
    assert.equal(fx.state.isAuthorized("2001", []), true);
    assert.equal(fx.state.isAuthorized("2002", []), true);

    // Which token linked a chat survives a restart
    await fx.state.flush();
    const reloaded = new TelegramStateStore({ filePath: fx.state.filePath, cipher: StorageCipher.fromSecret("bot_key") });
    reloaded.load();
    assert.equal(reloaded.revokeLinkedVia("tok-phone"), 1);
    assert.equal(reloaded.isAuthorized("2001", []), false);
    assert.equal(reloaded.isAuthorized("2002", []), true);
    // Its own background save must land before the fixture removes the directory
    await reloaded.flush();

    assert.equal(fx.bot.unlinkChatsLinkedBy("tok-other"), 0);
    assert.equal(fx.bot.unlinkChatsLinkedBy("tok-phone"), 1);
    assert.equal(fx.state.isAuthorized("2001", []), false, "the chat the revoked token linked");
    assert.equal(fx.state.isAuthorized("2002", []), true, "a chat linked with a pairing code stays");
    assert.equal(fx.state.isAuthorized("1001", fx.bot.allowedChatIds), true, "TELEGRAM_CHAT_IDS stay");
    assert.equal(fx.bot.unlinkChatsLinkedBy("tok-phone"), 0);
    // Linked again with a pairing code, the chat no longer follows the token
    await fx.message(2001, "/auth PAIR-CODE");
    assert.equal(fx.bot.unlinkChatsLinkedBy("tok-phone"), 0);
    assert.equal(fx.state.isAuthorized("2001", []), true);
    await fx.cleanup();
  });

  it("ignores commands addressed to another bot once it knows its own name", async () => {
    const fx = createBotFixture();
    await fx.bot.start();
    assert.equal(fx.bot.username, "FengSuiBot");
    await fx.message(1001, "/help@OtherBot");
    await fx.message(1001, "/auth@OtherBot dashboard_api_token");
    assert.equal(fx.tg.sends("1001").length, 0);
    assert.equal(fx.tg.of("deleteMessage").length, 0, "another bot's /auth is not ours to delete");
    await fx.message(1001, "/help@fengsuibot");
    assert.match(fx.tg.lastText("1001"), /assistant/);
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
    const send = fx.sendButton(1001);
    await fx.callback(1001, send);
    assert.match(fx.mock.sentRequests.at(-1) ?? "", /Hello from the wizard &lt;3/);
    await fx.callback(1001, send);
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

  it("reads a local number in the country learnt after the wizard opened, and in none before", async () => {
    let country = "";
    const fx = createBotFixture({ country: () => country });
    await fx.service.sync("full");
    await fx.message(1001, "/new");
    await fx.message(1001, "0830000002");
    assert.match(fx.tg.lastText("1001"), /No default country is known/);
    // The first poll read the SIM while the wizard was open
    country = "+353";
    await fx.message(1001, "0830000002");
    assert.match(fx.tg.lastText("1001"), /step 2: text[\s\S]*\+353830000002/);
    await fx.cleanup();
  });

  it("puts the country numbers are read in first on the wizard's country buttons, marked, beside the quick picks", async () => {
    const fx = createBotFixture({ country: () => "+49" });
    await fx.service.sync("full");
    await fx.message(1001, "/new");
    const card = fx.tg.sends("1001").at(-1);
    assert.match(fx.tg.lastText("1001"), /Germany \(\+49\)/);
    assert.deepEqual(fx.tg.buttons(card).slice(0, 6), ["wizcc:+49", "wizcc:+353", "wizcc:+86", "wizcc:+44", "wizcc:+1", "wizcc:+852"]);
    assert.ok(JSON.stringify(card?.payload).includes("+49 ✓"), "the country in use is marked");
    await fx.cleanup();
  });

  it("binds each confirmation card's Send button to its own draft, so an older card never sends a newer one", async () => {
    const fx = createBotFixture();
    await fx.service.sync("full");
    await fx.message(1001, "/send 0830000001 First draft");
    const firstCard = fx.sendButton(1001);
    await fx.message(1001, "/send 0830000001 Second draft");
    const secondCard = fx.sendButton(1001);
    assert.notEqual(firstCard, secondCard);
    await fx.callback(1001, firstCard);
    assert.equal(fx.mock.sentRequests.length, 0, "the stale card sends nothing");
    assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /expired/i);
    await fx.callback(1001, secondCard);
    assert.equal(fx.mock.sentRequests.length, 1);
    assert.match(fx.mock.sentRequests.at(-1) ?? "", /Second draft/);
    await fx.cleanup();
  });

  it("requires a confirmation tap for /send and serves read commands from caches", async () => {
    const fx = createBotFixture();
    await fx.service.sync("full");
    await fx.message(1001, "/send 0830000001 Quick hi");
    assert.match(fx.tg.lastText("1001"), /confirm[\s\S]*Quick hi/);
    assert.equal(fx.mock.sentRequests.length, 0);
    await fx.callback(1001, fx.sendButton(1001));
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

    await fx.core.monitor.refreshTelemetry();
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
    // It says where the message went: the owner's Recently deleted
    assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /Recently deleted for 30 days/);
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

  it("answers every SMS write with an explanation where the gate refuses it on an unverified model, and the router gets no write", async () => {
    const fx = createBotFixture();
    try {
      // The poll saw a model nobody verified, which no identification has shown to have SMS writes:
      // SMS stays readable, nothing is written on a guess
      fx.scheduler.noteRouterModel("B535-232", null);
      assert.ok(await fx.service.sync("full"));
      const unread = fx.service.getThread("+353830000001").messages.find((m) => m.isUnread)!;
      const readOnly = /FengSui cannot change SMS on this router[\s\S]*B535-232/;

      await fx.message(1001, "/new");
      assert.match(fx.tg.lastText("1001"), readOnly);
      await fx.message(1001, "/send +353830000001 hello");
      assert.match(fx.tg.lastText("1001"), readOnly);
      fx.state.bindReply("1001", 999, "+353830000001");
      await fx.message(1001, "on my way", { reply_to_message: { message_id: 999 } });
      assert.match(fx.tg.lastText("1001"), readOnly, "reply-to-send");

      for (const data of ["wizstart:1", `read:${unread.uid}`, "readall:1", `del:${unread.uid}`, `delok:${unread.uid}`, "wizsend:stale"]) {
        await fx.callback(1001, data);
        const answer = fx.tg.of("answerCallbackQuery").at(-1)?.payload;
        assert.deepEqual([String(answer?.["text"]).includes("FengSui cannot change SMS on this router (B535-232)"), answer?.["show_alert"]], [true, true], data);
      }
      assert.deepEqual([fx.mock.sentRequests.length, fx.mock.setReadBatches, fx.mock.deleteBatches], [0, [], []], "no SMS write reached the router");

      // Cards come without write buttons or reply routing; the help keyboard offers no new SMS
      await fx.bot.notifySms(fx.service.mirror.enrich(fx.service.mirror.get(unread.uid)!));
      const card = fx.tg.sends("1001").at(-1);
      assert.deepEqual(fx.tg.buttons(card).map((data) => data.split(":")[0]), ["chat"]);
      assert.doesNotMatch(String(card?.payload["text"]), /Reply to this/);
      await fx.message(1001, "/help");
      assert.ok(!fx.tg.buttons(fx.tg.sends("1001").at(-1)).some((data) => data.startsWith("wizstart")));
      assert.equal(fx.service.getStatus().mirror.unreadTotal > 0, true, "nothing was marked read");
    } finally {
      await fx.cleanup();
    }
  });

  it("has SMS writes open on an unverified model that shows what they read back, the plaintext way, until its owner turns them off", async () => {
    const fx = createBotFixture();
    try {
      fx.scheduler.noteRouterModel("B535-232", null);
      // What the identification found: the SMS counts the generic writes read back
      fx.scheduler.device.noteProbe({
        identity: { model: "B535-232", marketingName: null, softwareVersion: null, webUiVersion: null, passwordType: "4", loginScheme: "sha256", ecc: false, tokenFlow: "webserver-token", detectedAtIso: "2026-10-30T10:00:00.000Z" },
        endpoints: [{ path: "/api/sms/sms-count", state: "supported", code: null }],
        lteBands: null,
        probedAtIso: "2026-10-30T10:00:00.000Z",
        origin: "startup",
        observations: [{ path: "/api/sms/sms-count", format: "xml", truncated: false, fields: [{ tag: "LocalUnread", shape: "int", count: 1 }, { tag: "LocalInbox", shape: "int", count: 1 }] }],
      });
      assert.ok(await fx.service.sync("full"));
      const unread = fx.service.getThread("+353830000001").messages.find((m) => m.isUnread)!;
      const readOnly = /cannot change SMS/i;

      await fx.message(1001, "/new");
      assert.doesNotMatch(fx.tg.lastText("1001"), readOnly);
      await fx.bot.notifySms(fx.service.mirror.enrich(fx.service.mirror.get(unread.uid)!));
      const card = fx.tg.sends("1001").at(-1);
      assert.deepEqual(fx.tg.buttons(card).map((data) => data.split(":")[0]), ["read", "chat", "del"]);
      await fx.callback(1001, `read:${unread.uid}`);
      assert.deepEqual(fx.mock.setReadBatches, [[unread.index]], "one message per request");
      await fx.message(1001, "/send +353830000001 on my way");
      await fx.callback(1001, fx.sendButton(1001));
      const sends = fx.mock.requests.filter((r) => r.path === "/api/sms/send-sms");
      assert.deepEqual(sends.map((r) => [r.method, r.encType]), [["POST", null]], "plaintext send-sms, not the H168-383's encrypted one");
      assert.ok(fx.scheduler.genericWrites.some((w) => w.action === "sms_send"));

      // Turned off under Settings → Device: the explanation at once, naming where to turn it back on
      fx.scheduler.device.setDisabledWrites([{ model: "B535-232", feature: "smsWrite" }]);
      await fx.message(1001, "/new");
      assert.match(fx.tg.lastText("1001"), /FengSui cannot change SMS on this router[\s\S]*B535-232[\s\S]*turned off under Settings → Device/);
    } finally {
      await fx.cleanup();
    }
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
    await fx.callback(1001, fx.sendButton(1001));
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

  it("stops at once while backing off after poll errors (shutdown must fit the container stop grace)", async () => {
    const fx = createBotFixture({ failPolls: true });
    await fx.bot.start();
    while (fx.tg.of("getUpdates").length < 1) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 20));
    const stoppingAt = performance.now();
    await fx.bot.stop();
    assert.ok(performance.now() - stoppingAt < 200, "the 1.5 s (up to 30 s) backoff is cut short");
    assert.equal(fx.tg.of("getUpdates").length, 1, "no poll after stop()");
    assert.ok(fx.logs.some((line) => line.includes("poll error")));
    await fx.cleanup();
  });

  it("waits as long as Telegram asks after a 429 instead of polling again in 1.5 s", async () => {
    const fx = createBotFixture({ rateLimitPolls: 37 });
    await fx.bot.start();
    while (!fx.logs.some((line) => line.includes("poll error"))) await new Promise((r) => setTimeout(r, 2));
    await fx.bot.stop();
    assert.ok(fx.logs.some((line) => /poll error, retrying in 37000 ms[\s\S]*429/.test(line)), fx.logs.join("\n"));
    assert.equal(fx.tg.of("getUpdates").length, 1);
    const err = await new TelegramApi({ token: TOKEN, fetchImpl: fx.tg.fetchImpl }).call("getUpdates").catch((e: unknown) => e);
    assert.ok(err instanceof TelegramApiError);
    assert.equal(err.retryAfterSec, 37);
    await fx.cleanup();
  });

  it("stops polling without waiting for in-flight replies, and drain() waits for them (bounded)", async () => {
    const fx = createBotFixture({ sendDelayMs: 150, updates: [[{ update_id: 7, message: { message_id: 1, chat: { id: 1001 }, text: "/help" } }]] });
    await fx.bot.start();
    while (fx.tg.of("sendMessage").length < 1) await new Promise((r) => setTimeout(r, 2));
    const stoppingAt = performance.now();
    await fx.bot.stop();
    assert.ok(performance.now() - stoppingAt < 100, "stop() only ends polling");
    assert.equal(fx.tg.completedSends(), 0, "the /help reply is still in flight");
    await fx.bot.drain(2000);
    assert.equal(fx.tg.completedSends(), 1, "drain() let the reply finish");
    const drainedAt = performance.now();
    await fx.bot.drain(2000);
    assert.ok(performance.now() - drainedAt < 20, "nothing left to wait for");
    await fx.cleanup();
  });
});

describe("TelegramBot notification outbox", () => {
  let alertSeq = 0;
  const alert = (code: string, severity: AlertEventRecord["severity"] = "warning"): AlertEventRecord => ({
    id: `a${++alertSeq}`,
    tsIso: "2026-10-30T10:00:00.000Z",
    severity,
    code,
    messageZh: code,
    messageEn: code,
  });

  it("waits out Telegram's retry_after before sending notifications again", async () => {
    const fx = createBotFixture();
    try {
      fx.tg.failures.send = 429;
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.equal(fx.bot.pendingNotifications, 1);
      const tried = fx.tg.sends("1001").length;

      // Telegram would answer again, but it asked for 30 s: nothing is sent before then
      fx.tg.failures.send = undefined;
      await fx.bot.flushOutbox();
      await fx.bot.notifyAlert(alert("LOCK_ROLLED_BACK"));
      assert.equal(fx.tg.sends("1001").length, tried, "no request inside the window");
      assert.equal(fx.bot.pendingNotifications, 2, "a new one queues behind");

      fx.advance(30_001);
      await fx.bot.flushOutbox();
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.deepEqual(
        fx.tg.sends("1001").slice(-2).map((c) => String(c.payload["text"]).split("\n")[0]),
        ["⚠️ <b>WAN_DOWN</b>", "⚠️ <b>LOCK_ROLLED_BACK</b>"]
      );
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps notifications while Telegram is unreachable and delivers them in order, replies still routed", async () => {
    const fx = createBotFixture();
    try {
      const announced: EnrichedSmsMessage[] = [];
      fx.service.on("sms:new", (m: EnrichedSmsMessage) => announced.push(m));
      await fx.service.sync("full");
      const personal = announced.find((m) => m.phone === "+353830000001");
      assert.ok(personal);
      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      await fx.bot.notifyAlert(alert("LOCK_ROLLED_BACK"));
      await fx.bot.notifySms(personal);
      assert.equal(fx.bot.pendingNotifications, 3);
      assert.equal(fx.logs.filter((l) => l.includes("queueing notifications")).length, 1, "one log line per outage");
      assert.equal(fx.tg.completedSends(), 0);

      fx.tg.failures.send = undefined;
      await fx.bot.notifyAlert(alert("WAN_UP", "info"));
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.deepEqual(
        fx.tg.sends("1001").filter((_, i, all) => i >= all.length - 4).map((c) => String(c.payload["text"]).split("\n")[0]),
        ["⚠️ <b>WAN_DOWN</b>", "⚠️ <b>LOCK_ROLLED_BACK</b>", "📩 <b>New SMS</b>", "ℹ️ <b>WAN_UP</b>"],
        "the queued ones first, in order, then the new one"
      );

      // The delayed SMS card still routes a reply to its sender
      const cardId = 100 + 3;
      await fx.message(1001, "Delayed reply", { reply_to_message: { message_id: cardId } });
      assert.match(fx.mock.sentRequests.at(-1) ?? "", /Delayed reply/);
    } finally {
      await fx.cleanup();
    }
  });

  it("moves a group-code group to General when its forum topic is gone, says so once, and posts there from then on", async () => {
    const fx = createBotFixture();
    try {
      fx.state.authorize("-1002", { userId: "1001", threadId: 7 });
      fx.tg.goneTopics.add(7);
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      const toGroup = (): Array<[unknown, string]> => fx.tg.sends("-1002").map((c) => [c.payload["message_thread_id"], String(c.payload["text"]).split("\n")[0] ?? ""]);
      assert.deepEqual(toGroup(), [
        [7, "⚠️ <b>WAN_DOWN</b>"],
        [undefined, "⚠️ <b>WAN_DOWN</b>"],
        [undefined, "<b>The topic is gone</b>"],
      ]);
      assert.deepEqual(fx.state.groupLink("-1002"), { userId: "1001", threadId: null }, "the link now posts to General");
      assert.equal(fx.logs.filter((l) => l.includes("forum topic a linked group posts to")).length, 1);
      assert.equal(fx.bot.pendingNotifications, 0);
      await fx.bot.notifyAlert(alert("WAN_UP", "info"));
      assert.deepEqual(toGroup().slice(3), [[undefined, "ℹ️ <b>WAN_UP</b>"]], "straight to General, no failed attempt");
      await fx.state.flush();
      const reread = new TelegramStateStore({ filePath: fx.stateFile, cipher: fx.cipher });
      reread.load();
      assert.deepEqual(reread.groupLink("-1002"), { userId: "1001", threadId: null }, "kept across a restart");
    } finally {
      await fx.cleanup();
    }
  });

  it("answers in General when the topic a command came from is gone, changing nothing stored", async () => {
    const fx = createBotFixture({ allowedChatIds: ["1001", "-1003"] });
    try {
      fx.tg.goneTopics.add(9);
      await fx.message(-1003, "/help", { message_thread_id: 9, is_topic_message: true });
      assert.deepEqual(fx.tg.sends("-1003").map((c) => c.payload["message_thread_id"]), [9, undefined]);
      assert.match(fx.tg.lastText("-1003"), /FengSui/);
      assert.equal(fx.state.groupLink("-1003"), null);
      // Any other refusal is not a gone topic: no second try
      fx.tg.goneTopics.clear();
      fx.tg.failures.send = 403;
      await fx.message(-1003, "/help", { message_thread_id: 9, is_topic_message: true });
      assert.deepEqual(fx.tg.sends("-1003").map((c) => c.payload["message_thread_id"]), [9, undefined, 9]);
    } finally {
      await fx.cleanup();
    }
  });

  it("holds notifications for the wait a rate-limited poll was given, too", async () => {
    const fx = createBotFixture({ rateLimitPolls: 37 });
    try {
      await fx.bot.start();
      while (!fx.logs.some((line) => line.includes("poll error"))) await new Promise((r) => setTimeout(r, 2));
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.equal(fx.tg.sends("1001").length, 0, "nothing sent inside the window Telegram named");
      assert.equal(fx.bot.pendingNotifications, 1);
      fx.advance(37_001);
      await fx.bot.flushOutbox();
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.match(fx.tg.lastText("1001"), /WAN_DOWN/);
    } finally {
      await fx.cleanup();
    }
  });

  it("never delivers a queued notification to a chat that was unlinked while it waited", async () => {
    const fx = createBotFixture();
    try {
      fx.state.authorize("2003");
      fx.state.authorize("2004", undefined, "tok-phone");
      fx.state.authorize("2005");
      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.equal(fx.bot.pendingNotifications, 4);

      // The owner unlinks a chat and revokes a token while Telegram is unreachable
      assert.equal(fx.bot.unlinkChat("2003"), true);
      assert.equal(fx.bot.unlinkChatsLinkedBy("tok-phone"), 1);
      const tried = (chatId: string): number => fx.tg.sends(chatId).length;
      const before = { c2003: tried("2003"), c2004: tried("2004") };
      fx.tg.failures.send = undefined;
      await fx.bot.flushOutbox();
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.equal(tried("2003"), before.c2003, "an unlinked chat gets nothing that was queued for it");
      assert.equal(tried("2004"), before.c2004, "nor does a chat whose token was revoked");
      assert.match(fx.tg.lastText("2005"), /WAN_DOWN/);
      assert.match(fx.tg.lastText("1001"), /WAN_DOWN/);

      // "Unlink all" drops what waits for the linked chats; a chat .env authorizes still gets its own
      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("LOCK_ROLLED_BACK"));
      assert.equal(fx.bot.unlinkAllChats(), 1);
      const c2005 = tried("2005");
      fx.tg.failures.send = undefined;
      await fx.bot.flushOutbox();
      assert.equal(tried("2005"), c2005);
      assert.match(fx.tg.lastText("1001"), /LOCK_ROLLED_BACK/);
      assert.equal(fx.bot.pendingNotifications, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("keeps the next queued notification when a new one pushes the oldest out while it is being sent", async () => {
    const fx = createBotFixture({ sendDelayMs: 20 });
    try {
      fx.tg.failures.send = "network";
      for (let i = 0; i < 50; i++) await fx.bot.notifyAlert(alert(`Q${i}`));
      assert.equal(fx.bot.pendingNotifications, 50, "a full queue");
      fx.tg.failures.send = undefined;
      const start = fx.tg.calls.length;
      const flushing = fx.bot.flushOutbox();
      // While the oldest is on its way, one more arrives and the full queue lets the oldest go
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fx.bot.notifyAlert(alert("NEW"));
      await flushing;
      const sent = fx.tg.calls.slice(start).filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"]).split("\n")[0]);
      assert.ok(sent.includes("⚠️ <b>Q1</b>"), `the one behind the oldest was sent: ${sent.slice(0, 3).join(" | ")}`);
      assert.equal(sent.at(-1), "⚠️ <b>NEW</b>");
      assert.equal(fx.bot.pendingNotifications, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("carries a linked group's queued notifications over when it becomes a supergroup", async () => {
    const fx = createBotFixture();
    try {
      fx.state.authorize("-1003", { userId: "7001", threadId: null });
      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("WHILE_OFFLINE"));
      assert.ok(fx.bot.pendingNotifications >= 1);
      fx.tg.failures.send = undefined;
      await fx.message(-1003, "", { migrate_to_chat_id: -100777 });
      await fx.bot.flushOutbox();
      assert.ok(fx.tg.sends("-100777").some((c) => String(c.payload["text"]).includes("WHILE_OFFLINE")), "delivered to the supergroup");
      assert.equal(fx.bot.pendingNotifications, 0);
    } finally {
      await fx.cleanup();
    }
  });

  it("drops what Telegram refuses for good, bounds the queue and forgets notifications older than a day", async () => {
    const fx = createBotFixture();
    try {
      fx.tg.failures.send = 403;
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.equal(fx.bot.pendingNotifications, 0, "a blocked bot is not retried");
      assert.ok(fx.logs.some((l) => l.includes("notification to a chat failed")));

      fx.tg.failures.send = "network";
      for (let i = 0; i < 55; i++) await fx.bot.notifyAlert(alert(`A${i}`));
      assert.equal(fx.bot.pendingNotifications, 50, "the oldest go first when the queue is full");
      fx.tg.failures.send = 403;
      await fx.bot.flushOutbox();
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.ok(fx.logs.some((l) => l.includes("queued notification dropped")));

      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("OLD"));
      fx.advance(25 * 60 * 60_000);
      fx.tg.failures.send = undefined;
      const before = fx.tg.completedSends();
      await fx.bot.flushOutbox();
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.equal(fx.tg.completedSends(), before, "a day-old alert is not news any more");
    } finally {
      await fx.cleanup();
    }
  });

  it("follows an unverified-firmware alert with a copyable review prompt for a coding agent", async () => {
    const fx = createBotFixture();
    try {
      fx.core.stateStore.update({
        latestTelemetry: {
          device: { deviceName: "H168-383", softwareVersion: "4.4.0.2(H1006SP2C00)", webUiVersion: "WEBUI 4.4.0.2(W2SP1C00)" },
        } as unknown as GlobalTelemetrySnapshot,
      });
      await fx.bot.notifyAlert(alert("FIRMWARE_UNVERIFIED"));
      const [card, prompt] = fx.tg.sends("1001").slice(-2).map((c) => String(c.payload["text"]));
      assert.match(card ?? "", /FIRMWARE_UNVERIFIED/);
      assert.match(prompt ?? "", /^🤖 Hand this prompt to Claude Code/);
      assert.match(prompt ?? "", /<pre>FengSui \(cpe-dash\) reports a router build it was never verified on: H168-383, firmware 4\.4\.0\.2\(H1006SP2C00\), WebUI WEBUI4\.4\.0\.2\(W2SP1C00\)/);
      assert.ok((prompt ?? "").endsWith("</pre>"));

      const before = fx.tg.sends("1001").length;
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.equal(fx.tg.sends("1001").length, before + 1, "other alerts carry no prompt");
      fx.core.stateStore.update({ latestTelemetry: null });
      await fx.bot.notifyAlert(alert("FIRMWARE_UNVERIFIED"));
      assert.equal(fx.tg.sends("1001").length, before + 2, "no telemetry, nothing to describe");
    } finally {
      await fx.cleanup();
    }
  });

  it("puts a Got it button under the AI agent test's reminder, which reads it once", async () => {
    let waiting = true;
    const reads: string[] = [];
    const fx = createBotFixture({
      allowedChatIds: ["1001", "-1004"],
      acknowledgeAgentTest: () => {
        reads.push("read");
        const was = waiting;
        waiting = false;
        return was;
      },
    });
    try {
      await fx.bot.notifyAlert(alert("AGENT_TEST_STILL_ON"));
      assert.deepEqual(fx.tg.buttons(fx.tg.sends("1001").at(-1)), ["testok:1"]);
      assert.equal(fx.tg.buttons(fx.tg.sends("1001").at(-1)).length, 1);
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      assert.deepEqual(fx.tg.buttons(fx.tg.sends("1001").at(-1)), [], "other alerts have no button");

      await fx.callback(1001, "testok:1", 901);
      const answer = fx.tg.of("answerCallbackQuery").at(-1)?.payload;
      assert.match(String(answer?.["text"]), /^OK, no more reminders for this test/);
      assert.equal(answer?.["show_alert"], true);
      assert.deepEqual(fx.tg.of("editMessageReplyMarkup").at(-1)?.payload["message_id"], 901, "the button goes");
      await fx.callback(1001, "testok:1", 902);
      assert.match(String(fx.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /^No test reminder is waiting/);
      assert.equal(reads.length, 2);

      // A chat FengSui does not know reads nothing
      await fx.callback(5555, "testok:1");
      assert.equal(reads.length, 2);
    } finally {
      await fx.cleanup();
    }

    const plain = createBotFixture();
    try {
      await plain.bot.notifyAlert(alert("AGENT_TEST_STILL_ON"));
      assert.deepEqual(plain.tg.buttons(plain.tg.sends("1001").at(-1)), [], "no button without a test to read");
      await plain.callback(1001, "testok:1");
      assert.match(String(plain.tg.of("answerCallbackQuery").at(-1)?.payload["text"]), /^No test reminder is waiting/);
    } finally {
      await plain.cleanup();
    }
  });

  it("flushes the queue as soon as long-polling gets an answer again", async () => {
    const fx = createBotFixture();
    try {
      fx.tg.failures.send = "network";
      await fx.bot.notifyAlert(alert("WAN_DOWN"));
      await fx.bot.start();
      fx.tg.failures.send = undefined;
      for (let i = 0; i < 100 && fx.bot.pendingNotifications > 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fx.bot.pendingNotifications, 0);
      assert.match(fx.tg.lastText("1001"), /WAN_DOWN/);
    } finally {
      await fx.cleanup();
    }
  });
});
