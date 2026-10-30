import { timingSafeEqualString } from "../crypto.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { AtomicFileWriter, StorageCipher } from "../encrypted-file.ts";
import { interpolateTemplate } from "../i18n.ts";
import { BrowserSessionYieldedError, type MutexSessionScheduler } from "../scheduler.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../sms/codec.ts";
import { getCountryByDialCode, resolveRecipientPhone } from "../sms/phone.ts";
import type { SmsService } from "../sms/service.ts";
import type { EnrichedSmsMessage } from "../sms/types.ts";
import type { AlertEventRecord } from "../state-store.ts";
import type { SupportedLocale } from "../types.ts";
import type { NotificationChannel } from "./hub.ts";
import type { TelegramApi } from "./telegram-api.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    text?: string;
    reply_to_message?: { message_id?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id?: number; chat?: { id?: number | string } };
  };
}

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = { inline_keyboard: InlineButton[][] };

const WIZARD_TTL_MS = 15 * 60_000;
const QUICK_COUNTRIES = ["+353", "+86", "+44", "+1", "+852"] as const;
const MAX_VCF_BYTES = 4 * 1024 * 1024;
const MAX_TELEGRAM_TEXT = 3900;
const MAX_REPLY_TARGETS = 500;
const AUTH_WINDOW_MS = 10 * 60_000;
const AUTH_MAX_FAILURES_PER_CHAT = 5;
const AUTH_MAX_FAILURES_GLOBAL = 20;
const MAX_MUTE_MS = 7 * 24 * 60 * 60_000;
const INBOX_PAGE_SIZE = 8;

export function escapeTelegramHtml(text: string | number): string {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function callbackData(action: string, arg: string | number): string | null {
  const data = `${action}:${arg}`;
  return Buffer.byteLength(data, "utf8") <= 64 ? data : null;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// Bilingual bot copy (HTML templates; every interpolated value is escaped by `tx`)
// ---------------------------------------------------------------------------------------------

const TEXT = {
  "zh-CN": {
    unauthorized: "<b>烽燧 · 会话未授权</b>\n\nChat ID：<code>{chatId}</code>\n发送 <code>/auth 访问令牌</code> 完成绑定（令牌为 .env 中的 API_TOKEN）。",
    auth_usage: "用法：<code>/auth 访问令牌</code>",
    auth_ok: "<b>绑定成功</b>\n\n令牌消息已自动撤回。新短信与告警会推送到这里。",
    auth_already: "<b>当前会话已授权</b>",
    auth_bad: "<b>令牌不正确</b>，请检查后重试。",
    auth_limited: "<b>验证暂时停用</b>\n\n失败次数过多，请 10 分钟后再试。",
    help:
      "<b>烽燧 · 5G CPE 助手</b>\n\n<b>短信</b>\n/new 引导式发短信\n/inbox 最近会话\n/unread 未读短信\n/chat <code>号码</code> 查看对话\n/send <code>号码 内容</code> 快速发送（需确认）\n/contacts <code>[关键词]</code> 通讯录\n/contact <code>号码 姓名</code> 添加联系人\n/sync 立即同步\n\n<b>设备</b>\n/status 信号、流量与短信概况\n/alerts 最近告警\n/mute <code>30m|2h|1d|off</code> 告警静音\n\n直接<b>回复</b>任意短信通知即可回信；发送 <code>.vcf</code> 文件可导入通讯录。",
    new_sms: "📩 <b>新短信</b>",
    otp: "🔑 验证码 <code>{code}</code>",
    reply_hint: "<i>直接回复本消息即可回信至 {phone}</i>",
    btn_read: "✅ 已读",
    btn_chat: "💬 对话",
    btn_delete: "🗑 删除",
    btn_delete_confirm: "⚠️ 确认删除",
    btn_cancel: "✖ 取消",
    btn_new: "✍️ 发短信",
    btn_prev: "◀ 上一页",
    btn_next: "下一页 ▶",
    btn_read_all: "✅ 全部标为已读",
    btn_send_now: "📤 立即发送",
    btn_edit_content: "✏️ 改内容",
    btn_change_phone: "👤 换号码",
    btn_inbox: "💬 会话",
    btn_unread: "🔵 未读",
    btn_status: "📡 状态",
    wiz_phone:
      "<b>发短信 · 第 1 步：收件人</b>\n\n当前区号：{country}\n直接发送本地号码、带 + 的国际号码，或联系人姓名。",
    wiz_content: "<b>发短信 · 第 2 步：正文</b>\n\n收件人：{recipient}\n直接发送短信内容。",
    wiz_confirm:
      "<b>发短信 · 确认</b>\n\n收件人：{recipient}\n编码：{encoding} · {segments} 段\n\n<blockquote>{content}</blockquote>",
    wiz_too_long: "<b>内容过长</b>\n\n需要 {segments} 段，CPE 单次最多 {max} 段，请精简后重发。",
    wiz_no_contact: "没有匹配“{query}”的联系人，请直接输入号码。",
    wiz_pick: "<b>选择收件人</b>",
    wiz_cancelled: "<b>已取消</b>",
    wiz_expired: "发送流程已过期，请重新开始。",
    wiz_tap_confirm: "请点击上方「立即发送」或「取消」。",
    country_switched: "已切换区号 {code}",
    sending: "📤 正在发送至 {recipient}…",
    sent_ok: "✅ <b>已发送</b> · {recipient}\n编码：{encoding} · {segments} 段",
    sent_unknown: "📨 <b>已提交</b> · {recipient}\nCPE 未在超时内回报投递结果。",
    sent_failed: "❌ <b>发送失败</b> · {recipient}\n错误码：<code>{code}</code>",
    yielded: "⏸ 有人正在使用 CPE 官方后台，烽燧已礼貌让位，请稍后重试。",
    error: "⚠️ 操作失败：{error}",
    not_dialable: "<code>{phone}</code> 是服务号，无法直接回复。",
    inbox_title: "<b>最近会话</b> · 第 {page}/{pages} 页 · 共 {total} 个",
    inbox_empty: "<b>暂无短信</b>",
    unread_title: "<b>未读短信</b> · {count} 个会话",
    unread_empty: "<b>没有未读短信</b>",
    chat_title: "<b>{name}</b> · {count} 条",
    chat_empty: "没有与 <code>{phone}</code> 的短信记录。",
    chat_usage: "用法：<code>/chat 号码</code>",
    me: "我",
    contacts_title: "<b>通讯录</b> · {shown}/{total}",
    contacts_empty: "通讯录为空，或没有匹配的联系人。",
    contact_usage: "用法：<code>/contact 号码 姓名</code>",
    contact_saved: "<b>联系人已保存</b>\n{name} · <code>{phone}</code>",
    sync_done: "🔄 <b>同步完成</b>\n新增 {added} · 更新 {updated} · 移除 {removed} · 新短信 {fresh}",
    sync_skipped: "⏸ 同步已跳过（真人正在使用后台、熔断或冷却中）。",
    alerts_title: "<b>最近告警</b>",
    alerts_empty: "<b>暂无告警</b>",
    mute_set: "🔕 告警通知已静音至 {until}（短信照常推送）。",
    mute_off: "🔔 告警通知已恢复。",
    mute_usage: "用法：<code>/mute 30m</code>、<code>/mute 2h</code>、<code>/mute 1d</code> 或 <code>/mute off</code>",
    vcf_imported: "📇 <b>通讯录已导入</b>\n解析 {parsed} · 新增 {added} · 合并 {updated} · 共 {total}",
    vcf_failed: "📇 通讯录导入失败：{error}",
    unknown_command: "未知命令 <code>/{command}</code>，发送 /help 查看用法。",
    sms_disabled: "短信功能未启用（SMS_ENABLED=false）。",
    status_no_data: "暂无遥测数据（服务刚启动或正在让位）。",
    status_mode_idle: "空闲",
    status_mode_polling: "采集中",
    status_mode_yielding_browser: "让位真人后台",
    status_mode_circuit_tripped: "熔断锁定",
    status_mode_cpe_unreachable: "CPE 不可达",
    status_line_sms: "💬 短信：未读 {unread} · 存储 {used}% · 会话 {threads}",
    status_line_session: "🛡 会话：{mode}",
    cmd_new: "引导式发短信",
    cmd_inbox: "最近会话",
    cmd_unread: "未读短信",
    cmd_status: "信号与流量概况",
    cmd_alerts: "最近告警",
    cmd_contacts: "通讯录",
    cmd_sync: "立即同步短信",
    cmd_mute: "告警静音",
    cmd_help: "使用说明",
  },
  en: {
    unauthorized: "<b>FengSui · chat not authorized</b>\n\nChat ID: <code>{chatId}</code>\nSend <code>/auth ACCESS_TOKEN</code> to link this chat (the API_TOKEN from .env).",
    auth_usage: "Usage: <code>/auth ACCESS_TOKEN</code>",
    auth_ok: "<b>Linked</b>\n\nYour token message was deleted. New SMS and alerts will be delivered here.",
    auth_already: "<b>This chat is already authorized</b>",
    auth_bad: "<b>Wrong token</b>, please try again.",
    auth_limited: "<b>Verification paused</b>\n\nToo many failures, try again in 10 minutes.",
    help:
      "<b>FengSui · 5G CPE assistant</b>\n\n<b>SMS</b>\n/new guided send\n/inbox recent conversations\n/unread unread messages\n/chat <code>number</code> show a conversation\n/send <code>number text</code> quick send (with confirmation)\n/contacts <code>[query]</code> contact book\n/contact <code>number name</code> add a contact\n/sync sync now\n\n<b>Device</b>\n/status signal, traffic and SMS overview\n/alerts recent alerts\n/mute <code>30m|2h|1d|off</code> mute alerts\n\n<b>Reply</b> to any SMS notification to answer it; send a <code>.vcf</code> file to import contacts.",
    new_sms: "📩 <b>New SMS</b>",
    otp: "🔑 Code <code>{code}</code>",
    reply_hint: "<i>Reply to this message to text {phone}</i>",
    btn_read: "✅ Read",
    btn_chat: "💬 Thread",
    btn_delete: "🗑 Delete",
    btn_delete_confirm: "⚠️ Confirm delete",
    btn_cancel: "✖ Cancel",
    btn_new: "✍️ New SMS",
    btn_prev: "◀ Prev",
    btn_next: "Next ▶",
    btn_read_all: "✅ Mark all read",
    btn_send_now: "📤 Send now",
    btn_edit_content: "✏️ Edit text",
    btn_change_phone: "👤 Change number",
    btn_inbox: "💬 Inbox",
    btn_unread: "🔵 Unread",
    btn_status: "📡 Status",
    wiz_phone:
      "<b>New SMS · step 1: recipient</b>\n\nCountry code: {country}\nSend a local number, a +international number, or a contact name.",
    wiz_content: "<b>New SMS · step 2: text</b>\n\nTo: {recipient}\nSend the message text.",
    wiz_confirm:
      "<b>New SMS · confirm</b>\n\nTo: {recipient}\nEncoding: {encoding} · {segments} segment(s)\n\n<blockquote>{content}</blockquote>",
    wiz_too_long: "<b>Too long</b>\n\nNeeds {segments} segments; the CPE accepts at most {max}. Please shorten it.",
    wiz_no_contact: "No contact matches “{query}”; send a number instead.",
    wiz_pick: "<b>Choose a recipient</b>",
    wiz_cancelled: "<b>Cancelled</b>",
    wiz_expired: "This send flow expired, please start again.",
    wiz_tap_confirm: "Tap “Send now” or “Cancel” above.",
    country_switched: "Country code set to {code}",
    sending: "📤 Sending to {recipient}…",
    sent_ok: "✅ <b>Sent</b> · {recipient}\nEncoding: {encoding} · {segments} segment(s)",
    sent_unknown: "📨 <b>Submitted</b> · {recipient}\nThe CPE did not report delivery before the timeout.",
    sent_failed: "❌ <b>Send failed</b> · {recipient}\nError code: <code>{code}</code>",
    yielded: "⏸ Someone is using the CPE web admin; FengSui is yielding politely, try again later.",
    error: "⚠️ Failed: {error}",
    not_dialable: "<code>{phone}</code> is a service sender and cannot be replied to.",
    inbox_title: "<b>Conversations</b> · page {page}/{pages} · {total} total",
    inbox_empty: "<b>No messages yet</b>",
    unread_title: "<b>Unread</b> · {count} conversation(s)",
    unread_empty: "<b>No unread messages</b>",
    chat_title: "<b>{name}</b> · {count} message(s)",
    chat_empty: "No messages with <code>{phone}</code>.",
    chat_usage: "Usage: <code>/chat number</code>",
    me: "Me",
    contacts_title: "<b>Contacts</b> · {shown}/{total}",
    contacts_empty: "The contact book is empty or nothing matched.",
    contact_usage: "Usage: <code>/contact number name</code>",
    contact_saved: "<b>Contact saved</b>\n{name} · <code>{phone}</code>",
    sync_done: "🔄 <b>Synced</b>\nadded {added} · updated {updated} · removed {removed} · new {fresh}",
    sync_skipped: "⏸ Sync skipped (human admin session, breaker or cooldown).",
    alerts_title: "<b>Recent alerts</b>",
    alerts_empty: "<b>No alerts</b>",
    mute_set: "🔕 Alert notifications muted until {until} (SMS still delivered).",
    mute_off: "🔔 Alert notifications resumed.",
    mute_usage: "Usage: <code>/mute 30m</code>, <code>/mute 2h</code>, <code>/mute 1d</code> or <code>/mute off</code>",
    vcf_imported: "📇 <b>Contacts imported</b>\nparsed {parsed} · added {added} · merged {updated} · total {total}",
    vcf_failed: "📇 Contact import failed: {error}",
    unknown_command: "Unknown command <code>/{command}</code>; send /help.",
    sms_disabled: "SMS is disabled (SMS_ENABLED=false).",
    status_no_data: "No telemetry yet (just started or yielding).",
    status_mode_idle: "idle",
    status_mode_polling: "polling",
    status_mode_yielding_browser: "yielding to human admin",
    status_mode_circuit_tripped: "breaker tripped",
    status_mode_cpe_unreachable: "CPE unreachable",
    status_line_sms: "💬 SMS: unread {unread} · storage {used}% · threads {threads}",
    status_line_session: "🛡 Session: {mode}",
    cmd_new: "Guided SMS send",
    cmd_inbox: "Recent conversations",
    cmd_unread: "Unread SMS",
    cmd_status: "Signal and traffic overview",
    cmd_alerts: "Recent alerts",
    cmd_contacts: "Contact book",
    cmd_sync: "Sync SMS now",
    cmd_mute: "Mute alerts",
    cmd_help: "Help",
  },
} as const satisfies Record<SupportedLocale, Record<string, string>>;

type TextKey = keyof (typeof TEXT)["en"];

// ---------------------------------------------------------------------------------------------
// Encrypted bot state (authorized chats, reply routing, alert mute)
// ---------------------------------------------------------------------------------------------

interface PersistedTelegramState {
  version: 1;
  authorizedChatIds: string[];
  replyTargets: Array<[string, string]>;
  alertsMutedUntilMs: number | null;
}

export class TelegramStateStore {
  readonly filePath: string;
  #cipher: StorageCipher;
  #writer: AtomicFileWriter;
  #authorized = new Set<string>();
  #replyTargets = new Map<string, string>();
  #mutedUntilMs: number | null = null;

  constructor(opts: { filePath: string; cipher: StorageCipher }) {
    this.filePath = opts.filePath;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedTelegramState>>(this.filePath);
    this.#authorized = new Set((parsed?.authorizedChatIds ?? []).filter((id): id is string => typeof id === "string"));
    this.#replyTargets = new Map(
      (parsed?.replyTargets ?? []).filter(
        (e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string"
      )
    );
    this.#mutedUntilMs = typeof parsed?.alertsMutedUntilMs === "number" ? parsed.alertsMutedUntilMs : null;
  }

  async flush(): Promise<void> {
    const payload: PersistedTelegramState = {
      version: 1,
      authorizedChatIds: [...this.#authorized],
      replyTargets: [...this.#replyTargets],
      alertsMutedUntilMs: this.#mutedUntilMs,
    };
    await this.#writer.write(() => this.#cipher.serializeJson(payload));
  }

  rotateEncryptionKey(secret: string): void {
    this.#cipher = StorageCipher.fromSecret(secret);
  }

  isAuthorized(chatId: string, envIds: ReadonlyArray<string>): boolean {
    return envIds.includes(chatId) || this.#authorized.has(chatId);
  }

  authorizedChats(envIds: ReadonlyArray<string>): string[] {
    return [...new Set([...envIds, ...this.#authorized])];
  }

  authorize(chatId: string): void {
    this.#authorized.add(chatId);
    this.#commit();
  }

  /** Forget every chat linked through `/auth`; returns how many were revoked. */
  revokeAll(): number {
    const count = this.#authorized.size;
    if (count === 0) return 0;
    this.#authorized.clear();
    this.#commit();
    return count;
  }

  bindReply(chatId: string, messageId: number, phone: string): void {
    const key = `${chatId}:${messageId}`;
    this.#replyTargets.delete(key);
    this.#replyTargets.set(key, phone);
    for (const oldest of this.#replyTargets.keys()) {
      if (this.#replyTargets.size <= MAX_REPLY_TARGETS) break;
      this.#replyTargets.delete(oldest);
    }
    this.#commit();
  }

  replyTarget(chatId: string, messageId: number): string | null {
    return this.#replyTargets.get(`${chatId}:${messageId}`) ?? null;
  }

  setAlertsMutedUntil(ms: number | null): void {
    this.#mutedUntilMs = ms;
    this.#commit();
  }

  alertsMutedUntil(): number | null {
    return this.#mutedUntilMs;
  }

  #commit(): void {
    void this.flush().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Two-way bot
// ---------------------------------------------------------------------------------------------

interface WizardSession {
  step: "phone" | "content" | "confirm";
  countryCode: string;
  phone?: string;
  content?: string;
  expiresAt: number;
}

export interface TelegramBotOptions {
  api: TelegramApi;
  scheduler: MutexSessionScheduler;
  state: TelegramStateStore;
  /** SMS features are hidden when `null` (SMS_ENABLED=false). */
  sms: SmsService | null;
  /** Secret accepted by `/auth` (the dashboard `API_TOKEN`). */
  authToken: string;
  allowedChatIds?: ReadonlyArray<string>;
  locale?: SupportedLocale;
  defaultCountryCode?: string;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Two-way Telegram bot for FengSui: SMS notification cards (OTP, reply-to-send, read / thread /
 * delete-with-confirmation buttons), a guided send wizard with segment preview, conversation and
 * contact commands, device status, alert delivery with mute, and `.vcf` contact import.
 * Every CPE action goes through `SmsService` / the shared scheduler; reads come from caches.
 */
export class TelegramBot implements NotificationChannel {
  readonly name = "telegram";
  readonly api: TelegramApi;
  readonly scheduler: MutexSessionScheduler;
  readonly state: TelegramStateStore;
  readonly sms: SmsService | null;
  readonly locale: SupportedLocale;
  readonly defaultCountryCode: string;
  readonly allowedChatIds: ReadonlyArray<string>;
  #authToken: string;
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  #running = false;
  #offset = 0;
  #pollAbort: AbortController | null = null;
  #pollLoop: Promise<void> | null = null;
  #wizards = new Map<string, WizardSession>();
  #authFailures = new Map<string, number[]>();
  #globalAuthFailures: number[] = [];

  constructor(opts: TelegramBotOptions) {
    this.api = opts.api;
    this.scheduler = opts.scheduler;
    this.state = opts.state;
    this.sms = opts.sms;
    this.#authToken = opts.authToken;
    this.allowedChatIds = (opts.allowedChatIds ?? []).map(String);
    this.locale = opts.locale ?? "zh-CN";
    this.defaultCountryCode = opts.defaultCountryCode ?? "+353";
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.api
      .call("setMyCommands", {
        commands: (["new", "inbox", "unread", "status", "alerts", "contacts", "sync", "mute", "help"] as const).map(
          (command) => ({ command, description: this.#tx(`cmd_${command}`) })
        ),
      })
      .catch(() => undefined);
    this.#pollLoop = this.#runPollLoop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#pollAbort?.abort();
    await this.#pollLoop;
    this.#pollLoop = null;
  }

  /**
   * Apply a hot-reloaded `API_TOKEN`. When it changed, chats linked with the previous token via
   * `/auth` are revoked (a leaked token must not keep granting access); `TELEGRAM_CHAT_IDS` stay.
   */
  rotateAuthToken(token: string): number {
    if (timingSafeEqualString(token, this.#authToken)) return 0;
    this.#authToken = token;
    const revoked = this.state.revokeAll();
    if (revoked > 0) this.#log(`[telegram] API token rotated; revoked ${revoked} linked chat(s)`);
    return revoked;
  }

  // ----------------------------------------------------------------- notification channel

  async notifySms(message: EnrichedSmsMessage): Promise<void> {
    const lines = [this.#tx("new_sms"), "", this.#senderLine(message), `⏱ ${escapeTelegramHtml(message.date)}`];
    if (message.verificationCode) lines.push(this.#tx("otp", { code: message.verificationCode }));
    lines.push("", `<blockquote>${escapeTelegramHtml(truncate(message.content, 3000))}</blockquote>`);
    const replyPhone = message.sender.dialable ? (message.sender.e164 ?? message.phone) : null;
    if (replyPhone) lines.push(this.#tx("reply_hint", { phone: replyPhone }));

    const row: InlineButton[] = [];
    const readCb = callbackData("read", message.uid);
    const chatCb = callbackData("chat", message.threadKey);
    const delCb = callbackData("del", message.uid);
    if (message.isUnread && readCb) row.push({ text: this.#tx("btn_read"), callback_data: readCb });
    if (chatCb) row.push({ text: this.#tx("btn_chat"), callback_data: chatCb });
    if (delCb) row.push({ text: this.#tx("btn_delete"), callback_data: delCb });

    for (const chatId of this.state.authorizedChats(this.allowedChatIds)) {
      try {
        const sent = await this.#send(chatId, lines.join("\n"), { inline_keyboard: [row] });
        if (replyPhone && sent.message_id) this.state.bindReply(chatId, sent.message_id, replyPhone);
      } catch (err) {
        this.#log(`[telegram] SMS notification to a chat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async notifyAlert(alert: AlertEventRecord): Promise<void> {
    const mutedUntil = this.state.alertsMutedUntil();
    if (mutedUntil !== null && this.#now() < mutedUntil) return;
    const icon = alert.severity === "critical" ? "🚨" : alert.severity === "warning" ? "⚠️" : "ℹ️";
    const text = [
      `${icon} <b>${escapeTelegramHtml(alert.code)}</b>`,
      escapeTelegramHtml(this.locale === "en" ? alert.messageEn : alert.messageZh),
      `<i>${escapeTelegramHtml(alert.tsIso)}</i>`,
    ].join("\n");
    for (const chatId of this.state.authorizedChats(this.allowedChatIds)) {
      await this.#send(chatId, text).catch((err: unknown) =>
        this.#log(`[telegram] alert notification failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
  }

  // ----------------------------------------------------------------- update dispatch

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.callback_query) await this.#handleCallback(update.callback_query);
      else if (update.message) await this.#handleMessage(update.message);
    } catch (err) {
      this.#log(`[telegram] update handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async #runPollLoop(): Promise<void> {
    let backoffMs = 1500;
    while (this.#running) {
      this.#pollAbort = new AbortController();
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          { offset: this.#offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
          { timeoutMs: 35_000, signal: this.#pollAbort.signal }
        );
        backoffMs = 1500;
        for (const update of Array.isArray(updates) ? updates : []) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          void this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.#running) break;
        this.#log(`[telegram] poll error, retrying in ${backoffMs} ms: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async #handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;
    const text = (msg.text ?? "").trim();

    if (/^\/auth(?:@\S+)?(?:\s|$)/i.test(text)) {
      await this.#cmdAuth(chatId, text.replace(/^\/auth(?:@\S+)?\s*/i, ""), msg.message_id);
      return;
    }
    if (!this.state.isAuthorized(chatId, this.allowedChatIds)) {
      await this.#send(chatId, this.#tx("unauthorized", { chatId }));
      return;
    }

    if (msg.document) {
      await this.#importVcf(chatId, msg.document);
      return;
    }
    if (!text) return;

    if (!text.startsWith("/") && msg.reply_to_message?.message_id !== undefined) {
      const target = this.state.replyTarget(chatId, msg.reply_to_message.message_id);
      if (target) {
        this.#wizards.delete(chatId);
        await this.#executeSend(chatId, target, text);
        return;
      }
    }
    if (!text.startsWith("/") && this.#wizard(chatId)) {
      await this.#handleWizardInput(chatId, text);
      return;
    }

    const match = text.match(/^\/([A-Za-z0-9_]{1,32})(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!match) {
      await this.#send(chatId, this.#tx("help"), this.#newSmsKeyboard());
      return;
    }
    const command = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (command !== "cancel") this.#wizards.delete(chatId);
    await this.#dispatchCommand(chatId, command, rest);
  }

  async #dispatchCommand(chatId: string, command: string, rest: string): Promise<void> {
    switch (command) {
      case "start":
      case "help":
        return await this.#reply(chatId, "help", undefined, this.#newSmsKeyboard());
      case "status":
        return await this.#cmdStatus(chatId);
      case "alerts":
        return await this.#cmdAlerts(chatId);
      case "mute":
        return await this.#cmdMute(chatId, rest);
      case "cancel":
        this.#wizards.delete(chatId);
        return await this.#reply(chatId, "wiz_cancelled");
    }
    const sms = this.sms;
    if (!sms) {
      await this.#send(chatId, this.#tx(["new", "inbox", "unread", "chat", "send", "contacts", "contact", "sync"].includes(command) ? "sms_disabled" : "unknown_command", { command }));
      return;
    }
    switch (command) {
      case "new":
        return await this.#startWizard(chatId);
      case "inbox":
        return await this.#cmdInbox(chatId, sms, Number.parseInt(rest || "1", 10) || 1);
      case "unread":
        return await this.#cmdUnread(chatId, sms);
      case "chat":
        return await this.#cmdChat(chatId, sms, rest);
      case "send":
        return await this.#cmdSend(chatId, rest);
      case "contacts":
        return await this.#cmdContacts(chatId, sms, rest);
      case "contact":
        return await this.#cmdContact(chatId, sms, rest);
      case "sync":
        return await this.#cmdSync(chatId, sms);
      default:
        await this.#send(chatId, this.#tx("unknown_command", { command }));
    }
  }

  async #handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const chatId = String(cq.message?.chat?.id ?? "");
    const messageId = cq.message?.message_id;
    const answer = (text?: string, alert = false): Promise<unknown> =>
      this.api.call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => undefined);
    if (!chatId || !this.state.isAuthorized(chatId, this.allowedChatIds)) {
      await answer(this.#plain("unauthorized", { chatId }), true);
      return;
    }
    const data = String(cq.data ?? "");
    const colon = data.indexOf(":");
    const action = colon >= 0 ? data.slice(0, colon) : data;
    const arg = colon >= 0 ? data.slice(colon + 1) : "";
    const sms = this.sms;

    try {
      if (action === "status") {
        await answer();
        return await this.#cmdStatus(chatId);
      }
      if (!sms) {
        await answer(this.#plain("sms_disabled"), true);
        return;
      }
      switch (action) {
        case "wizstart":
          await answer();
          return await this.#startWizard(chatId);
        case "wizcancel":
          this.#wizards.delete(chatId);
          await answer(this.#plain("wiz_cancelled"));
          if (messageId !== undefined) await this.#edit(chatId, messageId, this.#tx("wiz_cancelled"));
          return;
        case "wizcc": {
          const wiz = this.#wizard(chatId) ?? this.#newWizard(chatId);
          wiz.countryCode = getCountryByDialCode(arg)?.code ?? wiz.countryCode;
          wiz.step = "phone";
          await answer(this.#plain("country_switched", { code: wiz.countryCode }));
          if (messageId !== undefined) await this.#edit(chatId, messageId, this.#wizardPhonePrompt(wiz), this.#countryKeyboard(wiz.countryCode));
          return;
        }
        case "wizpick":
          await answer();
          return await this.#advanceToContent(chatId, arg);
        case "wizback": {
          await answer();
          const wiz = this.#wizard(chatId);
          if (arg === "content" && wiz?.phone) return await this.#advanceToContent(chatId, wiz.phone);
          return await this.#startWizard(chatId, wiz?.countryCode);
        }
        case "wizsend": {
          const wiz = this.#wizard(chatId);
          if (!wiz?.phone || !wiz.content || wiz.step !== "confirm") {
            await answer(this.#plain("wiz_expired"), true);
            return;
          }
          this.#wizards.delete(chatId);
          await answer();
          return await this.#executeSend(chatId, wiz.phone, wiz.content, messageId);
        }
        case "read":
          await sms.markRead({ uids: [arg] });
          await answer(this.#plain("btn_read"));
          if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
          return;
        case "readall": {
          const uids = sms
            .listThreads({ filter: "unread" })
            .flatMap((thread) => sms.getThread(thread.threadKey).messages.filter((m) => m.isUnread).map((m) => m.uid))
            .slice(0, 200);
          if (uids.length > 0) await sms.markRead({ uids });
          await answer(this.#plain("btn_read_all"));
          return;
        }
        case "chat":
          await answer();
          return await this.#cmdChat(chatId, sms, arg);
        case "inbox":
          await answer();
          return await this.#cmdInbox(chatId, sms, Number.parseInt(arg || "1", 10) || 1);
        case "unread":
          await answer();
          return await this.#cmdUnread(chatId, sms);
        case "del": {
          const okCb = callbackData("delok", arg);
          await answer();
          if (messageId !== undefined && okCb) {
            await this.api.call("editMessageReplyMarkup", {
              chat_id: chatId,
              message_id: messageId,
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: this.#tx("btn_delete_confirm"), callback_data: okCb },
                    { text: this.#tx("btn_cancel"), callback_data: "delno:0" },
                  ],
                ],
              },
            });
          }
          return;
        }
        case "delok":
          await sms.deleteMessages({ uids: [arg] });
          await answer(this.#plain("btn_delete"));
          if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
          return;
        case "delno":
          await answer(this.#plain("btn_cancel"));
          if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
          return;
        default:
          await answer();
      }
    } catch (err) {
      await answer(this.#describeError(err), true);
    }
  }

  // ----------------------------------------------------------------- commands

  async #cmdAuth(chatId: string, secret: string, messageId: number | undefined): Promise<void> {
    if (messageId !== undefined) {
      void this.api.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined);
    }
    if (this.state.isAuthorized(chatId, this.allowedChatIds)) return await this.#reply(chatId, "auth_already");
    if (this.#authLimited(chatId)) return await this.#reply(chatId, "auth_limited");
    if (!secret) return await this.#reply(chatId, "auth_usage");
    if (this.#authToken && timingSafeEqualString(secret, this.#authToken)) {
      this.state.authorize(chatId);
      this.#authFailures.delete(chatId);
      await this.#send(chatId, this.#tx("auth_ok"));
      return;
    }
    const now = this.#now();
    this.#authFailures.set(chatId, [...(this.#authFailures.get(chatId) ?? []), now]);
    this.#globalAuthFailures.push(now);
    await this.#send(chatId, this.#tx("auth_bad"));
  }

  async #cmdStatus(chatId: string): Promise<void> {
    const telemetry = this.scheduler.getCachedTelemetry();
    const status = this.scheduler.getStatus();
    const lines: string[] = [];
    if (!telemetry) {
      lines.push(this.#tx("status_no_data"));
    } else {
      const rf = telemetry.rf;
      const metric = (rsrp: number | null, sinr: number | null) =>
        `RSRP ${rsrp ?? "—"} dBm / SINR ${sinr ?? "—"} dB`;
      lines.push(
        `📡 <b>${escapeTelegramHtml(telemetry.device.marketingName)}</b> (${escapeTelegramHtml(telemetry.device.deviceName)})`,
        `🏢 ${escapeTelegramHtml(rf.operatorName || rf.plmnNumeric || "—")} · ${escapeTelegramHtml(telemetry.device.connectionStatus || "—")}`,
        `5G ${metric(rf.nrRsrpDbm, rf.nrSinrDb)}`,
        `4G ${metric(rf.lteRsrpDbm, rf.lteSinrDb)}`,
        `📶 ${rf.caComponentCount}CC · ${rf.totalAggregatedBandwidthMhz} MHz · ${escapeTelegramHtml(rf.caBannerRaw || "—")}`,
        `⇅ ↓ ${escapeTelegramHtml(telemetry.traffic.downloadRateFormatted)} ↑ ${escapeTelegramHtml(telemetry.traffic.uploadRateFormatted)} · Σ ${escapeTelegramHtml(telemetry.traffic.monthTotalFormatted)}`
      );
    }
    if (this.sms) {
      const smsStatus = this.sms.getStatus();
      lines.push(
        this.#tx("status_line_sms", {
          unread: smsStatus.unreadOnCpe ?? smsStatus.mirror.unreadTotal,
          used: smsStatus.storageUsedPercent ?? "—",
          threads: smsStatus.mirror.threadsTotal,
        })
      );
    }
    lines.push(this.#tx("status_line_session", { mode: this.#tx(`status_mode_${status.mode}`) }));
    await this.#send(chatId, lines.join("\n"), this.#newSmsKeyboard());
  }

  async #cmdAlerts(chatId: string): Promise<void> {
    const recent = [...this.scheduler.getRecentAlerts()].slice(-10).reverse();
    if (recent.length === 0) return await this.#reply(chatId, "alerts_empty");
    const lines = [this.#tx("alerts_title"), ""];
    for (const a of recent) {
      lines.push(
        `${a.severity === "critical" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️"} <b>${escapeTelegramHtml(a.code)}</b> · <i>${escapeTelegramHtml(a.tsIso)}</i>`,
        escapeTelegramHtml(this.locale === "en" ? a.messageEn : a.messageZh)
      );
    }
    await this.#send(chatId, lines.join("\n"));
  }

  async #cmdMute(chatId: string, rest: string): Promise<void> {
    const arg = rest.trim().toLowerCase();
    if (arg === "off") {
      this.state.setAlertsMutedUntil(null);
      return await this.#reply(chatId, "mute_off");
    }
    const match = arg.match(/^(\d{1,4})\s*([mhd])$/);
    if (!match?.[1] || !match[2]) return await this.#reply(chatId, "mute_usage");
    const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
    const until = this.#now() + Math.min(MAX_MUTE_MS, Number(match[1]) * unitMs);
    this.state.setAlertsMutedUntil(until);
    await this.#send(chatId, this.#tx("mute_set", { until: new Date(until).toISOString() }));
  }

  async #cmdInbox(chatId: string, sms: SmsService, page: number): Promise<void> {
    const threads = sms.listThreads();
    if (threads.length === 0) return await this.#reply(chatId, "inbox_empty", undefined, this.#newSmsKeyboard());
    const pages = Math.max(1, Math.ceil(threads.length / INBOX_PAGE_SIZE));
    const current = Math.min(Math.max(1, page), pages);
    const slice = threads.slice((current - 1) * INBOX_PAGE_SIZE, current * INBOX_PAGE_SIZE);
    const lines = [this.#tx("inbox_title", { page: current, pages, total: threads.length }), ""];
    const keyboard: InlineButton[][] = [[{ text: this.#tx("btn_new"), callback_data: "wizstart:1" }]];
    let row: InlineButton[] = [];
    for (const thread of slice) {
      const m = thread.latestMessage;
      const badge = thread.unreadCount > 0 ? `🔵 ${thread.unreadCount} · ` : "";
      lines.push(
        `${badge}<b>${escapeTelegramHtml(thread.displayName)}</b> · <i>${escapeTelegramHtml(m.date)}</i>`,
        `${m.direction === "out" ? "↗ " : ""}${escapeTelegramHtml(truncate(m.content.replace(/\s+/g, " "), 60))}`,
        ""
      );
      const cb = callbackData("chat", thread.threadKey);
      if (cb) {
        row.push({ text: truncate(thread.displayName, 14), callback_data: cb });
        if (row.length === 2) {
          keyboard.push(row);
          row = [];
        }
      }
    }
    if (row.length > 0) keyboard.push(row);
    const nav: InlineButton[] = [];
    if (current > 1) nav.push({ text: this.#tx("btn_prev"), callback_data: `inbox:${current - 1}` });
    if (current < pages) nav.push({ text: this.#tx("btn_next"), callback_data: `inbox:${current + 1}` });
    if (nav.length > 0) keyboard.push(nav);
    await this.#send(chatId, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async #cmdUnread(chatId: string, sms: SmsService): Promise<void> {
    const threads = sms.listThreads({ filter: "unread" });
    if (threads.length === 0) return await this.#reply(chatId, "unread_empty");
    const lines = [this.#tx("unread_title", { count: threads.length }), ""];
    const keyboard: InlineButton[][] = [];
    for (const thread of threads.slice(0, 10)) {
      const unread = sms.getThread(thread.threadKey).messages.filter((m) => m.isUnread);
      lines.push(`<b>${escapeTelegramHtml(thread.displayName)}</b> · ${unread.length}`);
      for (const m of unread.slice(-3)) {
        lines.push(
          `<i>${escapeTelegramHtml(m.date)}</i> ${escapeTelegramHtml(truncate(m.content.replace(/\s+/g, " "), 120))}` +
            (m.verificationCode ? ` · 🔑 <code>${escapeTelegramHtml(m.verificationCode)}</code>` : "")
        );
      }
      lines.push("");
      const cb = callbackData("chat", thread.threadKey);
      if (cb) keyboard.push([{ text: `💬 ${truncate(thread.displayName, 24)}`, callback_data: cb }]);
    }
    keyboard.push([{ text: this.#tx("btn_read_all"), callback_data: "readall:1" }]);
    await this.#send(chatId, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async #cmdChat(chatId: string, sms: SmsService, key: string): Promise<void> {
    if (!key) return await this.#reply(chatId, "chat_usage");
    const thread = sms.getThread(key);
    if (thread.messages.length === 0) return await this.#reply(chatId, "chat_empty", { phone: key });
    const name = thread.contact?.name ?? thread.sender.e164 ?? thread.phone;
    const lines = [this.#tx("chat_title", { name, count: thread.messages.length }), ""];
    for (const m of thread.messages.slice(-10)) {
      const author = m.direction === "out" ? this.#tx("me") : escapeTelegramHtml(name);
      lines.push(
        `<b>${author}</b> <i>${escapeTelegramHtml(m.date)}</i>${m.isUnread ? " 🔵" : ""}`,
        `<blockquote>${escapeTelegramHtml(truncate(m.content, 400))}</blockquote>`
      );
    }
    if (thread.replyPhone) lines.push(this.#tx("reply_hint", { phone: thread.replyPhone }));
    const unreadUid = thread.messages.find((m) => m.isUnread)?.uid;
    const readCb = unreadUid ? callbackData("read", unreadUid) : null;
    const sent = await this.#send(
      chatId,
      truncate(lines.join("\n"), MAX_TELEGRAM_TEXT),
      readCb ? { inline_keyboard: [[{ text: this.#tx("btn_read"), callback_data: readCb }]] } : undefined
    );
    if (thread.replyPhone && sent.message_id) this.state.bindReply(chatId, sent.message_id, thread.replyPhone);
  }

  async #cmdSend(chatId: string, rest: string): Promise<void> {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) return await this.#startWizard(chatId);
    const resolved = resolveRecipientPhone(match[1], this.defaultCountryCode);
    if (!resolved.ok) return await this.#reply(chatId, "error", { error: resolved.error });
    const wiz = this.#newWizard(chatId);
    wiz.phone = resolved.phone;
    await this.#showConfirm(chatId, wiz, match[2]);
  }

  async #cmdContacts(chatId: string, sms: SmsService, query: string): Promise<void> {
    const list = sms.listContacts(query, 20);
    if (list.length === 0) return await this.#reply(chatId, "contacts_empty");
    const lines = [this.#tx("contacts_title", { shown: list.length, total: sms.contacts.size }), ""];
    for (const c of list) lines.push(`<b>${escapeTelegramHtml(c.name)}</b> · <code>${escapeTelegramHtml(c.phones.join(", "))}</code>`);
    await this.#send(chatId, lines.join("\n"));
  }

  async #cmdContact(chatId: string, sms: SmsService, rest: string): Promise<void> {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) return await this.#reply(chatId, "contact_usage");
    try {
      const saved = sms.upsertContact({ phone: match[1], name: match[2] });
      await this.#send(chatId, this.#tx("contact_saved", { name: saved.name, phone: saved.phones[0] ?? "" }));
    } catch (err) {
      await this.#send(chatId, this.#tx("error", { error: this.#describeError(err) }));
    }
  }

  async #cmdSync(chatId: string, sms: SmsService): Promise<void> {
    try {
      const summary = await sms.sync("full", { priority: "normal" });
      await this.#send(
        chatId,
        summary
          ? this.#tx("sync_done", {
              added: summary.added,
              updated: summary.updated,
              removed: summary.removed,
              fresh: summary.newIncoming,
            })
          : this.#tx("sync_skipped")
      );
    } catch (err) {
      await this.#send(chatId, this.#tx("error", { error: this.#describeError(err) }));
    }
  }

  async #importVcf(chatId: string, doc: NonNullable<NonNullable<TelegramUpdate["message"]>["document"]>): Promise<void> {
    const sms = this.sms;
    const isVcf = /\.vcf$/i.test(doc.file_name ?? "") || /vcard/i.test(doc.mime_type ?? "");
    if (!sms || !isVcf) return;
    try {
      if ((doc.file_size ?? 0) > MAX_VCF_BYTES) throw new CpeControlValidationError(`vCard file exceeds ${MAX_VCF_BYTES} bytes`);
      const summary = sms.importVcard(await this.api.downloadFileText(doc.file_id, MAX_VCF_BYTES));
      await this.#send(chatId, this.#tx("vcf_imported", { ...summary }));
    } catch (err) {
      await this.#send(chatId, this.#tx("vcf_failed", { error: this.#describeError(err) }));
    }
  }

  // ----------------------------------------------------------------- guided send wizard

  #newWizard(chatId: string, countryCode = this.defaultCountryCode): WizardSession {
    const wiz: WizardSession = { step: "phone", countryCode, expiresAt: this.#now() + WIZARD_TTL_MS };
    this.#wizards.set(chatId, wiz);
    return wiz;
  }

  #wizard(chatId: string): WizardSession | null {
    const wiz = this.#wizards.get(chatId);
    if (!wiz) return null;
    if (this.#now() > wiz.expiresAt) {
      this.#wizards.delete(chatId);
      return null;
    }
    wiz.expiresAt = this.#now() + WIZARD_TTL_MS;
    return wiz;
  }

  async #startWizard(chatId: string, countryCode?: string): Promise<void> {
    const wiz = this.#newWizard(chatId, countryCode);
    await this.#send(chatId, this.#wizardPhonePrompt(wiz), this.#countryKeyboard(wiz.countryCode));
  }

  #wizardPhonePrompt(wiz: WizardSession): string {
    const country = getCountryByDialCode(wiz.countryCode);
    const label = country ? `${country.flag} ${this.locale === "en" ? country.nameEn : country.nameZh} (${country.code})` : wiz.countryCode;
    return this.#tx("wiz_phone", { country: label });
  }

  #countryKeyboard(active: string): InlineKeyboard {
    const buttons = QUICK_COUNTRIES.map((code) => {
      const c = getCountryByDialCode(code);
      return { text: `${c?.flag ?? ""} ${code}${code === active ? " ✓" : ""}`, callback_data: `wizcc:${code}` };
    });
    return {
      inline_keyboard: [buttons.slice(0, 3), buttons.slice(3), [{ text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" }]],
    };
  }

  async #handleWizardInput(chatId: string, text: string): Promise<void> {
    const wiz = this.#wizard(chatId);
    if (!wiz) return;
    if (wiz.step === "phone") {
      if (/[A-Za-z一-龥]/.test(text) && this.sms) {
        const matches = this.sms.listContacts(text, 8);
        const options = matches.flatMap((c) => c.phones.slice(0, 2).map((phone) => ({ name: c.name, phone })));
        if (options.length === 0) {
          await this.#send(chatId, this.#tx("wiz_no_contact", { query: text }), this.#countryKeyboard(wiz.countryCode));
          return;
        }
        if (options.length === 1 && options[0]) return await this.#advanceToContent(chatId, options[0].phone);
        const rows = options.flatMap((o) => {
          const cb = callbackData("wizpick", o.phone);
          return cb ? [[{ text: truncate(`${o.name} · ${o.phone}`, 40), callback_data: cb }]] : [];
        });
        rows.push([{ text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" }]);
        await this.#send(chatId, this.#tx("wiz_pick"), { inline_keyboard: rows.slice(0, 10) });
        return;
      }
      const resolved = resolveRecipientPhone(text, wiz.countryCode);
      if (!resolved.ok) {
        await this.#send(chatId, this.#tx("error", { error: resolved.error }), this.#countryKeyboard(wiz.countryCode));
        return;
      }
      return await this.#advanceToContent(chatId, resolved.phone);
    }
    if (wiz.step === "content") return await this.#showConfirm(chatId, wiz, text);
    await this.#send(chatId, this.#tx("wiz_tap_confirm"));
  }

  async #advanceToContent(chatId: string, phone: string): Promise<void> {
    const wiz = this.#wizard(chatId) ?? this.#newWizard(chatId);
    wiz.phone = phone;
    wiz.step = "content";
    await this.#send(chatId, this.#tx("wiz_content", { recipient: this.#recipientLabel(phone) }), {
      inline_keyboard: [
        [
          { text: this.#tx("btn_change_phone"), callback_data: "wizback:phone" },
          { text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" },
        ],
      ],
    });
  }

  async #showConfirm(chatId: string, wiz: WizardSession, content: string): Promise<void> {
    const mode = detectSmsTextMode(content);
    if (mode.segments > MAX_SMS_SEGMENTS) {
      wiz.step = "content";
      await this.#send(chatId, this.#tx("wiz_too_long", { segments: mode.segments, max: MAX_SMS_SEGMENTS }));
      return;
    }
    wiz.step = "confirm";
    wiz.content = content;
    await this.#send(
      chatId,
      this.#tx("wiz_confirm", {
        recipient: this.#recipientLabel(wiz.phone ?? ""),
        encoding: mode.encoding,
        segments: mode.segments,
        content,
      }),
      {
        inline_keyboard: [
          [
            { text: this.#tx("btn_send_now"), callback_data: "wizsend:1" },
            { text: this.#tx("btn_edit_content"), callback_data: "wizback:content" },
          ],
          [
            { text: this.#tx("btn_change_phone"), callback_data: "wizback:phone" },
            { text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" },
          ],
        ],
      }
    );
  }

  async #executeSend(chatId: string, phone: string, content: string, editMessageId?: number): Promise<void> {
    const sms = this.sms;
    if (!sms) return await this.#reply(chatId, "sms_disabled");
    const recipient = this.#recipientLabel(phone);
    let statusMessageId = editMessageId;
    if (statusMessageId !== undefined) {
      await this.#edit(chatId, statusMessageId, this.#tx("sending", { recipient }));
    } else {
      statusMessageId = (await this.#send(chatId, this.#tx("sending", { recipient }))).message_id;
    }

    let text: string;
    try {
      const outcome = await sms.send({ phones: [phone], content, source: "telegram" });
      const r = outcome.result;
      text = r.ok
        ? r.timedOutWaitingStatus
          ? this.#tx("sent_unknown", { recipient })
          : this.#tx("sent_ok", { recipient, encoding: r.encoding, segments: r.segments })
        : this.#tx("sent_failed", { recipient, code: r.failCode ?? "unknown" });
    } catch (err) {
      text = err instanceof BrowserSessionYieldedError ? this.#tx("yielded") : this.#tx("error", { error: this.#describeError(err) });
    }
    if (statusMessageId !== undefined) {
      await this.#edit(chatId, statusMessageId, text);
      this.state.bindReply(chatId, statusMessageId, phone);
    } else {
      await this.#send(chatId, text);
    }
  }

  // ----------------------------------------------------------------- helpers

  #senderLine(message: EnrichedSmsMessage): string {
    const number = message.sender.e164 ?? message.phone;
    const country = this.locale === "en" ? message.sender.countryEn : message.sender.countryZh;
    const who = message.contact
      ? `<b>${escapeTelegramHtml(message.contact.name)}</b> · ${escapeTelegramHtml(number)}`
      : message.sender.brandHint && message.sender.type !== "alphanumeric"
        ? `<b>${escapeTelegramHtml(message.sender.brandHint)}</b> · ${escapeTelegramHtml(number)}`
        : `<b>${escapeTelegramHtml(number)}</b>`;
    return `${who} ${message.sender.flag} ${escapeTelegramHtml(country)}`;
  }

  #recipientLabel(phone: string): string {
    const contact = this.sms?.contacts.resolvePhone(phone);
    return contact ? `${contact.name} · ${phone}` : phone;
  }

  #newSmsKeyboard(): InlineKeyboard | undefined {
    if (!this.sms) return undefined;
    return {
      inline_keyboard: [
        [{ text: this.#tx("btn_new"), callback_data: "wizstart:1" }],
        [
          { text: this.#tx("btn_inbox"), callback_data: "inbox:1" },
          { text: this.#tx("btn_unread"), callback_data: "unread:1" },
          { text: this.#tx("btn_status"), callback_data: "status:1" },
        ],
      ],
    };
  }

  async #clearButtons(chatId: string, messageId: number): Promise<void> {
    await this.api
      .call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
      .catch(() => undefined);
  }

  #describeError(err: unknown): string {
    if (err instanceof BrowserSessionYieldedError) return this.#plain("yielded");
    return truncate(err instanceof Error ? err.message : String(err), 180);
  }

  #authLimited(chatId: string): boolean {
    const cutoff = this.#now() - AUTH_WINDOW_MS;
    this.#globalAuthFailures = this.#globalAuthFailures.filter((ts) => ts > cutoff);
    const mine = (this.#authFailures.get(chatId) ?? []).filter((ts) => ts > cutoff);
    this.#authFailures.set(chatId, mine);
    return mine.length >= AUTH_MAX_FAILURES_PER_CHAT || this.#globalAuthFailures.length >= AUTH_MAX_FAILURES_GLOBAL;
  }

  #tx(key: TextKey, params?: Readonly<Record<string, string | number>>): string {
    const escaped = params
      ? Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escapeTelegramHtml(v)]))
      : undefined;
    return interpolateTemplate(TEXT[this.locale][key], escaped);
  }

  /** Plain-text variant for callback toasts (Telegram renders those without HTML). */
  #plain(key: TextKey, params?: Readonly<Record<string, string | number>>): string {
    return interpolateTemplate(TEXT[this.locale][key], params)
      .replace(/<[^>]{1,40}>/g, "")
      .slice(0, 190);
  }

  async #reply(
    chatId: string,
    key: TextKey,
    params?: Readonly<Record<string, string | number>>,
    keyboard?: InlineKeyboard
  ): Promise<void> {
    await this.#send(chatId, this.#tx(key, params), keyboard);
  }

  async #send(chatId: string, html: string, keyboard?: InlineKeyboard): Promise<{ message_id?: number }> {
    return await this.api.call<{ message_id?: number }>("sendMessage", {
      chat_id: chatId,
      text: truncate(html, MAX_TELEGRAM_TEXT),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }

  async #edit(chatId: string, messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    await this.api
      .call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: truncate(html, MAX_TELEGRAM_TEXT),
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch(() => undefined);
  }
}

