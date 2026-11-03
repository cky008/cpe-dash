import crypto from "node:crypto";
import { runAsActor } from "../audit-log.ts";
import { timingSafeEqualString } from "../crypto.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { AtomicFileWriter, StorageCipher, assertKnownDataFormat } from "../encrypted-file.ts";
import { firmwareReviewPrompt } from "../firmware.ts";
import { interpolateTemplate } from "../i18n.ts";
import type { FengSuiCore } from "../core.ts";
import { BrowserSessionYieldedError, DeviceReadOnlyError } from "../scheduler.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../sms/codec.ts";
import { getCountryByDialCode, resolveRecipientPhone } from "../sms/phone.ts";
import type { SmsService } from "../sms/service.ts";
import type { EnrichedSmsMessage } from "../sms/types.ts";
import type { AlertEventRecord } from "../state-store.ts";
import type { SupportedLocale } from "../types.ts";
import type { NotificationChannel } from "./hub.ts";
import { type TelegramApi, TelegramApiError } from "./telegram-api.ts";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    /** `type`: "private", "group", "supergroup" or "channel". */
    chat?: { id?: number | string; type?: string };
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

interface PendingNotification {
  chatId: string;
  html: string;
  keyboard?: InlineKeyboard;
  /** SMS notifications: the number a reply to this message goes to. */
  replyPhone?: string;
  queuedAtMs: number;
}

/** Network failures, timeouts, 429 and 5xx are worth retrying; other Telegram errors are final. */
function isTransientTelegramError(err: unknown): boolean {
  if (err instanceof TelegramApiError) return err.errorCode === null || err.errorCode === 429 || err.errorCode >= 500;
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

const WIZARD_TTL_MS = 15 * 60_000;
const QUICK_COUNTRIES = ["+353", "+86", "+44", "+1", "+852"] as const;
const MAX_VCF_BYTES = 4 * 1024 * 1024;
const MAX_TELEGRAM_TEXT = 3900;
const MAX_REPLY_TARGETS = 500;
const AUTH_WINDOW_MS = 10 * 60_000;
const AUTH_MAX_FAILURES_PER_CHAT = 5;
const AUTH_MAX_FAILURES_GLOBAL = 20;
const MAX_MUTE_MS = 7 * 24 * 60 * 60_000;
/** Notifications kept while Telegram is unreachable (the NAS reaches it through the same WAN). */
const OUTBOX_MAX = 50;
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;
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

/** Room kept for "…" and the closing tags a cut may need (the bot's HTML nests at most three deep). */
const HTML_CUT_RESERVE = 48;

/**
 * Cut Telegram HTML to at most `max` characters without splitting a tag or an entity, then close the
 * tags left open. A plain character cut can end inside `<blockquote>` or `&amp;`, and Telegram
 * rejects the whole message (`400 can't parse entities`).
 */
export function truncateTelegramHtml(html: string, max: number): string {
  if (html.length <= max) return html;
  let cut = html.slice(0, Math.max(0, max - HTML_CUT_RESERVE));
  if (cut.lastIndexOf("<") > cut.lastIndexOf(">")) cut = cut.slice(0, cut.lastIndexOf("<"));
  // Every literal "&" is escaped, so an "&" without its ";" is a cut entity
  if (cut.lastIndexOf("&") > cut.lastIndexOf(";")) cut = cut.slice(0, cut.lastIndexOf("&"));
  const open: string[] = [];
  for (const tag of cut.matchAll(/<(\/?)([a-z-]+)[^>]*>/gi)) {
    const name = (tag[2] ?? "").toLowerCase();
    if (!tag[1]) open.push(name);
    else if (open.lastIndexOf(name) >= 0) open.splice(open.lastIndexOf(name), 1);
  }
  return `${cut}…${open.reverse().map((name) => `</${name}>`).join("")}`;
}

// ---------------------------------------------------------------------------------------------
// Bilingual bot copy (HTML templates; every interpolated value is escaped by `tx`)
// ---------------------------------------------------------------------------------------------

const TEXT = {
  "zh-CN": {
    unauthorized: "<b>烽燧 · 会话未授权</b>\n\nChat ID：<code>{chatId}</code>\n在控制台「设置 → Telegram」生成绑定码，然后发送 <code>/auth 绑定码</code>（也可以用完整权限的访问令牌）。",
    auth_usage: "用法：<code>/auth 绑定码</code>",
    auth_private_only:
      "<b>请在与机器人的私聊中使用 /auth</b>\n\n在群组里绑定会让所有成员都能读取短信与验证码并操作路由器。若消息里是访问令牌且仍可见，请立即删除，并在控制台撤销该令牌。",
    auth_ok: "<b>绑定成功</b>\n\n令牌消息已自动撤回。新短信与告警会推送到这里。",
    auth_already: "<b>当前会话已授权</b>",
    auth_bad: "<b>绑定码或令牌不正确</b>：绑定码 10 分钟内有效，只能用一次。",
    reset_code:
      "🔑 <b>控制台密码重置码</b>：<code>{code}</code>\n\n15 分钟内有效，只能使用一次。在控制台登录页点「忘记密码」，输入重置码并设置新密码。\n如果不是你本人操作，请忽略这条消息，并在控制台「设置 → 安全」关闭 Telegram 重置。",
    reset_disabled: "Telegram 重置密码已在控制台关闭。",
    reset_private_only: "<b>请在与机器人的私聊中使用 /reset</b>",
    reset_limited: "<b>请稍后再试</b>：每小时最多申请 3 次重置码。",
    auth_limited: "<b>验证暂时停用</b>\n\n失败次数过多，请 10 分钟后再试。",
    help:
      "<b>烽燧 · 5G CPE 助手</b>\n\n<b>短信</b>\n/new 引导式发短信\n/inbox 最近会话\n/unread 未读短信\n/chat <code>号码</code> 查看对话\n/send <code>号码 内容</code> 快速发送（需确认）\n/contacts <code>[关键词]</code> 通讯录\n/contact <code>号码 姓名</code> 添加联系人\n/sync 立即同步\n\n<b>设备</b>\n/status 信号、流量与短信概况\n/alerts 最近告警\n/mute <code>30m|2h|1d|off</code> 告警静音\n\n直接<b>回复</b>任意短信通知即可回信；发送 <code>.vcf</code> 文件可导入通讯录。",
    new_sms: "📩 <b>新短信</b>",
    firmware_prompt: "🤖 把下面这段提示词原样交给 Claude Code（在 cpe-dash 仓库里运行），让它核对新固件的兼容性：",
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
    read_only:
      "🔒 <b>这台路由器只读</b>\n\n它是烽燧没有验证过的型号（{model}），烽燧只读取它：不能在这里发短信、标为已读或删除。请在路由器自己的网页上操作；在控制台「设置 → 设备」可以报告它的兼容情况。",
    read_only_short: "🔒 这台路由器只读（{model}），烽燧不能在这里改动短信",
    status_no_data: "暂无遥测数据（服务刚启动或正在让位）。",
    status_mode_idle: "空闲",
    status_mode_polling: "采集中",
    status_mode_yielding_browser: "让位真人后台",
    status_mode_circuit_tripped: "熔断锁定",
    status_mode_cpe_unreachable: "CPE 不可达",
    status_mode_standby_peer: "待机（另一台主机上的守护进程正在管理 CPE）",
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
    unauthorized: "<b>FengSui · chat not authorized</b>\n\nChat ID: <code>{chatId}</code>\nCreate a pairing code in the console (Settings → Telegram), then send <code>/auth CODE</code> (a full-access token works too).",
    auth_usage: "Usage: <code>/auth PAIRING_CODE</code>",
    auth_private_only:
      "<b>Use /auth in a private chat with the bot</b>\n\nLinking a group would let every member read your SMS and codes and control the router. If your message held an access token and is still visible, delete it now and revoke that token in the console.",
    auth_ok: "<b>Linked</b>\n\nYour token message was deleted. New SMS and alerts will be delivered here.",
    auth_already: "<b>This chat is already authorized</b>",
    auth_bad: "<b>Wrong code or token</b>: a pairing code works once, within 10 minutes.",
    reset_code:
      "🔑 <b>Console password reset code</b>: <code>{code}</code>\n\nValid for 15 minutes, once. On the console's sign-in page choose “Forgot password”, enter the code and set a new password.\nIf this was not you, ignore it and turn Telegram reset off in the console (Settings → Security).",
    reset_disabled: "Password reset through Telegram is turned off in the console.",
    reset_private_only: "<b>Use /reset in a private chat with the bot</b>",
    reset_limited: "<b>Try again later</b>: at most 3 reset codes an hour.",
    auth_limited: "<b>Verification paused</b>\n\nToo many failures, try again in 10 minutes.",
    help:
      "<b>FengSui · 5G CPE assistant</b>\n\n<b>SMS</b>\n/new guided send\n/inbox recent conversations\n/unread unread messages\n/chat <code>number</code> show a conversation\n/send <code>number text</code> quick send (with confirmation)\n/contacts <code>[query]</code> contact book\n/contact <code>number name</code> add a contact\n/sync sync now\n\n<b>Device</b>\n/status signal, traffic and SMS overview\n/alerts recent alerts\n/mute <code>30m|2h|1d|off</code> mute alerts\n\n<b>Reply</b> to any SMS notification to answer it; send a <code>.vcf</code> file to import contacts.",
    new_sms: "📩 <b>New SMS</b>",
    firmware_prompt: "🤖 Hand this prompt to Claude Code (run it in the cpe-dash repository) to check the new firmware:",
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
    read_only:
      "🔒 <b>This router is read-only</b>\n\nIt is a model FengSui was not verified on ({model}), so FengSui only reads it: sending, marking read and deleting SMS are not available here. Use the router's own web page; Settings → Device in the console can report how it works.",
    read_only_short: "🔒 Read-only router ({model}): FengSui cannot change SMS here",
    status_no_data: "No telemetry yet (just started or yielding).",
    status_mode_idle: "idle",
    status_mode_polling: "polling",
    status_mode_yielding_browser: "yielding to human admin",
    status_mode_circuit_tripped: "breaker tripped",
    status_mode_cpe_unreachable: "CPE unreachable",
    status_mode_standby_peer: "Standby (a daemon on another host drives the CPE)",
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
    assertKnownDataFormat(this.filePath, parsed?.version, 1);
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
  /** Bound into the confirm card's Send button, so an older card cannot send a newer draft. */
  confirmToken?: string;
  expiresAt: number;
}

export interface TelegramBotOptions {
  api: TelegramApi;
  core: Pick<FengSuiCore, "scheduler" | "monitor">;
  state: TelegramStateStore;
  /** SMS features are hidden when `null` (SMS_ENABLED=false). */
  sms: SmsService | null;
  /** Secret accepted by `/auth` when `linkSecret` is not given (tests, embedders). */
  authToken: string;
  /** Decide an `/auth` secret: a one-time pairing code from the console, or a full-access token. */
  linkSecret?: (secret: string) => boolean;
  /** A console password reset code for `/reset`, or `null` when Telegram reset is turned off. */
  issueResetCode?: () => string | null;
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
/** Buttons that would write to the router (send, mark read, delete). */
const WRITE_CALLBACKS: ReadonlySet<string> = new Set(["wizstart", "wizsend", "read", "readall", "del", "delok"]);

export class TelegramBot implements NotificationChannel {
  readonly name = "telegram";
  readonly api: TelegramApi;
  readonly core: Pick<FengSuiCore, "scheduler" | "monitor">;
  readonly state: TelegramStateStore;
  readonly sms: SmsService | null;
  readonly locale: SupportedLocale;
  readonly defaultCountryCode: string;
  readonly allowedChatIds: ReadonlyArray<string>;
  #authToken: string;
  readonly #linkSecret: ((secret: string) => boolean) | null;
  readonly #issueResetCode: (() => string | null) | null;
  #resetRequests = new Map<string, number[]>();
  readonly #now: () => number;
  readonly #log: (line: string) => void;

  #running = false;
  #standby = false;
  #offset = 0;
  #pollAbort: AbortController | null = null;
  #pollLoop: Promise<void> | null = null;
  /** Aborted by `stop()`: cuts the poll loop's backoff and standby pauses short. */
  #lifecycle: AbortController | null = null;
  #handlers = new Set<Promise<void>>();
  #wizards = new Map<string, WizardSession>();
  #authFailures = new Map<string, number[]>();
  /** Notifications that failed on a network error, oldest first (delivered once Telegram answers again). */
  #outbox: PendingNotification[] = [];
  #flushing: Promise<void> | null = null;
  #globalAuthFailures: number[] = [];

  constructor(opts: TelegramBotOptions) {
    this.api = opts.api;
    this.core = opts.core;
    this.state = opts.state;
    this.sms = opts.sms;
    this.#authToken = opts.authToken;
    this.#linkSecret = opts.linkSecret ?? null;
    this.#issueResetCode = opts.issueResetCode ?? null;
    this.allowedChatIds = (opts.allowedChatIds ?? []).map(String);
    this.locale = opts.locale ?? "zh-CN";
    this.defaultCountryCode = opts.defaultCountryCode ?? "+353";
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => undefined);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#lifecycle = new AbortController();
    await this.api
      .call("setMyCommands", {
        commands: (["new", "inbox", "unread", "status", "alerts", "contacts", "sync", "mute", "help"] as const).map(
          (command) => ({ command, description: this.#tx(`cmd_${command}`) })
        ),
      })
      .catch(() => undefined);
    this.#pollLoop = this.#runPollLoop();
  }

  /**
   * Stop long-polling at once (an in-flight getUpdates and any backoff pause are cut short). Update
   * handlers still running are not awaited here; `drain()` waits for them.
   */
  async stop(): Promise<void> {
    this.#running = false;
    this.#lifecycle?.abort();
    this.#pollAbort?.abort();
    await this.#pollLoop;
    this.#pollLoop = null;
  }

  /**
   * Wait up to `maxWaitMs` for update handlers that are still running, e.g. a send whose result
   * ("submitted" / "failed") must still replace the "Sending…" card so nobody resends blindly.
   */
  async drain(maxWaitMs = 3000): Promise<void> {
    if (this.#handlers.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...this.#handlers]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, maxWaitMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Apply a hot-reloaded `API_TOKEN`. When it changed, chats linked with the previous token via
   * `/auth` are revoked (a leaked token must not keep granting access); `TELEGRAM_CHAT_IDS` stay.
   */
  /** Unlink every chat linked with /auth (TELEGRAM_CHAT_IDS stay authorized); returns how many. */
  unlinkAllChats(): number {
    const revoked = this.state.revokeAll();
    if (revoked > 0) this.#log(`[telegram] unlinked ${revoked} chat(s) from the console`);
    return revoked;
  }

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
    // A read-only router (a model nobody verified) can be read, not answered: no reply, read or delete
    const writable = this.#readOnlyModel() === null;
    const replyPhone = writable && message.sender.dialable ? (message.sender.e164 ?? message.phone) : null;
    if (replyPhone) lines.push(this.#tx("reply_hint", { phone: replyPhone }));

    const row: InlineButton[] = [];
    const readCb = callbackData("read", message.uid);
    const chatCb = callbackData("chat", message.threadKey);
    const delCb = callbackData("del", message.uid);
    if (writable && message.isUnread && readCb) row.push({ text: this.#tx("btn_read"), callback_data: readCb });
    if (chatCb) row.push({ text: this.#tx("btn_chat"), callback_data: chatCb });
    if (writable && delCb) row.push({ text: this.#tx("btn_delete"), callback_data: delCb });

    for (const chatId of this.state.authorizedChats(this.allowedChatIds)) {
      await this.#deliver({ chatId, html: lines.join("\n"), keyboard: { inline_keyboard: [row] }, replyPhone: replyPhone ?? undefined });
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
    const prompt = alert.code === "FIRMWARE_UNVERIFIED" ? this.#firmwarePromptHtml(alert) : null;
    for (const chatId of this.state.authorizedChats(this.allowedChatIds)) {
      await this.#deliver({ chatId, html: text });
      // A separate message, so the prompt is one tap to copy
      if (prompt) await this.#deliver({ chatId, html: prompt });
    }
  }

  /** The firmware review prompt for the build in the telemetry that raised the alert. */
  #firmwarePromptHtml(alert: AlertEventRecord): string | null {
    const device = this.core.monitor.getCachedTelemetry()?.device;
    if (!device?.softwareVersion) return null;
    const prompt = firmwareReviewPrompt(this.locale, {
      model: device.deviceName,
      softwareVersion: device.softwareVersion,
      webUiVersion: device.webUiVersion,
      detectedAtIso: alert.tsIso,
    });
    return `${this.#tx("firmware_prompt")}\n<pre>${escapeTelegramHtml(prompt)}</pre>`;
  }

  /** Notifications waiting for Telegram to become reachable again. */
  get pendingNotifications(): number {
    return this.#outbox.length;
  }

  /**
   * Retry queued notifications in order. Stops at the first one that still cannot be delivered
   * (still offline); one Telegram refuses for good (blocked bot, gone chat) is dropped.
   */
  async flushOutbox(): Promise<void> {
    if (this.#flushing) return await this.#flushing;
    const run = async (): Promise<void> => {
      for (let next = this.#outbox[0]; next; next = this.#outbox[0]) {
        if (this.#now() - next.queuedAtMs > OUTBOX_MAX_AGE_MS) {
          this.#outbox.shift();
          continue;
        }
        try {
          const sent = await this.#send(next.chatId, next.html, next.keyboard);
          this.#outbox.shift();
          this.#afterNotification(next, sent);
        } catch (err) {
          if (isTransientTelegramError(err)) return;
          this.#outbox.shift();
          this.#log(`[telegram] queued notification dropped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    this.#flushing = run().finally(() => {
      this.#flushing = null;
    });
    await this.#flushing;
  }

  /**
   * Send a notification now, or queue it: behind earlier ones for the same chat (order is kept), or
   * after a network error, typically while the WAN this NAS reaches Telegram through is down.
   */
  async #deliver(notification: Omit<PendingNotification, "queuedAtMs">): Promise<void> {
    if (this.#outbox.some((pending) => pending.chatId === notification.chatId)) {
      this.#enqueue(notification);
      await this.flushOutbox();
      return;
    }
    try {
      this.#afterNotification(notification, await this.#send(notification.chatId, notification.html, notification.keyboard));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!isTransientTelegramError(err)) {
        this.#log(`[telegram] notification to a chat failed: ${reason}`);
        return;
      }
      if (this.#outbox.length === 0) this.#log(`[telegram] Telegram unreachable; queueing notifications until it answers: ${reason}`);
      this.#enqueue(notification);
    }
  }

  #enqueue(notification: Omit<PendingNotification, "queuedAtMs">): void {
    this.#outbox.push({ ...notification, queuedAtMs: this.#now() });
    if (this.#outbox.length > OUTBOX_MAX) this.#outbox.splice(0, this.#outbox.length - OUTBOX_MAX);
  }

  #afterNotification(notification: Omit<PendingNotification, "queuedAtMs">, sent: { message_id?: number }): void {
    if (notification.replyPhone && sent.message_id) this.state.bindReply(notification.chatId, sent.message_id, notification.replyPhone);
  }

  // ----------------------------------------------------------------- update dispatch

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const chat = String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "");
    try {
      // Writes a chat triggers are audited as Telegram, with only the chat ID's last digits
      await runAsActor({ channel: "telegram", label: chat ? `chat …${chat.slice(-3)}` : "chat" }, async () => {
        if (update.callback_query) await this.#handleCallback(update.callback_query);
        else if (update.message) await this.#handleMessage(update.message);
      });
    } catch (err) {
      this.#log(`[telegram] update handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * While another FengSui daemon leads (peer standby) this bot stops long-polling, because two
   * getUpdates pollers on one bot token fight each other (HTTP 409); notifications are its peer's job.
   */
  setStandby(standby: boolean): void {
    if (this.#standby === standby) return;
    this.#standby = standby;
    if (standby) this.#pollAbort?.abort();
  }

  /** Sleep `ms`, or less when `stop()` ends the bot. */
  async #pause(ms: number): Promise<void> {
    const lifecycle = this.#lifecycle?.signal;
    if (!lifecycle || lifecycle.aborted) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        lifecycle.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      lifecycle.addEventListener("abort", done, { once: true });
    });
  }

  async #runPollLoop(): Promise<void> {
    let backoffMs = 1500;
    while (this.#running) {
      if (this.#standby) {
        await this.#pause(1000);
        continue;
      }
      this.#pollAbort = new AbortController();
      try {
        const updates = await this.api.call<TelegramUpdate[]>(
          "getUpdates",
          { offset: this.#offset, timeout: 25, allowed_updates: ["message", "callback_query"] },
          { timeoutMs: 35_000, signal: this.#pollAbort.signal }
        );
        backoffMs = 1500;
        // Telegram answers again (the WAN is back): deliver what queued up meanwhile
        if (this.#outbox.length > 0) void this.flushOutbox();
        for (const update of Array.isArray(updates) ? updates : []) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          const handling = this.handleUpdate(update);
          this.#handlers.add(handling);
          void handling.finally(() => this.#handlers.delete(handling));
        }
      } catch (err) {
        if (!this.#running) break;
        if (this.#standby) continue;
        // A 429 names its own wait; polling sooner only extends Telegram's limit
        const waitMs = err instanceof TelegramApiError && err.retryAfterSec !== null ? Math.max(backoffMs, err.retryAfterSec * 1000) : backoffMs;
        this.#log(`[telegram] poll error, retrying in ${waitMs} ms: ${err instanceof Error ? err.message : String(err)}`);
        await this.#pause(waitMs);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async #handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;
    const text = (msg.text ?? "").trim();

    if (/^\/auth(?:@\S+)?(?:\s|$)/i.test(text)) {
      await this.#cmdAuth(chatId, text.replace(/^\/auth(?:@\S+)?\s*/i, ""), msg.message_id, msg.chat?.type === "private");
      return;
    }
    if (!this.state.isAuthorized(chatId, this.allowedChatIds)) {
      await this.#send(chatId, this.#tx("unauthorized", { chatId }));
      return;
    }
    if (/^\/reset(?:@\S+)?$/i.test(text)) {
      await this.#cmdReset(chatId, msg.chat?.type === "private");
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
    if ((command === "new" || command === "send") && (await this.#refuseReadOnly(chatId))) return;
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
      const readOnlyModel = this.#readOnlyModel();
      if (readOnlyModel !== null && WRITE_CALLBACKS.has(action)) {
        await answer(this.#plain("read_only_short", { model: readOnlyModel }), true);
        if (messageId !== undefined && action !== "wizstart") await this.#clearButtons(chatId, messageId);
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
          if (!wiz?.phone || !wiz.content || wiz.step !== "confirm" || arg !== wiz.confirmToken) {
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

  async #cmdAuth(chatId: string, secret: string, messageId: number | undefined, privateChat: boolean): Promise<void> {
    if (messageId !== undefined) {
      void this.api.call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => undefined);
    }
    if (this.state.isAuthorized(chatId, this.allowedChatIds)) return await this.#reply(chatId, "auth_already");
    // A linked group would open SMS, codes and router controls to every member (pre-authorize it via TELEGRAM_CHAT_IDS)
    if (!privateChat) return await this.#reply(chatId, "auth_private_only");
    if (this.#authLimited(chatId)) return await this.#reply(chatId, "auth_limited");
    if (!secret) return await this.#reply(chatId, "auth_usage");
    const linked = this.#linkSecret ? this.#linkSecret(secret) : Boolean(this.#authToken) && timingSafeEqualString(secret, this.#authToken);
    if (linked) {
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

  /** A one-time console password reset code, in a linked private chat only, at most 3 an hour. */
  async #cmdReset(chatId: string, privateChat: boolean): Promise<void> {
    if (!privateChat) return await this.#reply(chatId, "reset_private_only");
    const issue = this.#issueResetCode;
    if (!issue) return await this.#reply(chatId, "reset_disabled");
    const now = this.#now();
    const recent = (this.#resetRequests.get(chatId) ?? []).filter((ts) => now - ts < 60 * 60_000);
    if (recent.length >= 3) return await this.#reply(chatId, "reset_limited");
    const code = issue();
    if (code === null) return await this.#reply(chatId, "reset_disabled");
    this.#resetRequests.set(chatId, [...recent, now]);
    this.#log("[telegram] issued a console password reset code to a linked chat");
    await this.#send(chatId, this.#tx("reset_code", { code }));
  }

  async #cmdStatus(chatId: string): Promise<void> {
    const telemetry = this.core.monitor.getCachedTelemetry();
    const status = this.core.scheduler.getStatus();
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
    const recent = [...this.core.scheduler.getRecentAlerts()].slice(-10).reverse();
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
      lines.join("\n"),
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
    wiz.confirmToken = crypto.randomBytes(4).toString("hex");
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
            { text: this.#tx("btn_send_now"), callback_data: `wizsend:${wiz.confirmToken}` },
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
    if (await this.#refuseReadOnly(chatId)) return;
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
        ...(this.#readOnlyModel() === null ? [[{ text: this.#tx("btn_new"), callback_data: "wizstart:1" }]] : []),
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

  /** The router's model when it is one nobody verified (read-only), else `null`. */
  #readOnlyModel(): string | null {
    const device = this.core.scheduler.device;
    return device.writes === "read_only" ? (device.snapshot().model ?? "?") : null;
  }

  /** Explain instead of writing when the router is read-only; `true` when it was. */
  async #refuseReadOnly(chatId: string): Promise<boolean> {
    const model = this.#readOnlyModel();
    if (model === null) return false;
    this.#wizards.delete(chatId);
    await this.#reply(chatId, "read_only", { model });
    return true;
  }

  #describeError(err: unknown): string {
    if (err instanceof BrowserSessionYieldedError) return this.#plain("yielded");
    if (err instanceof DeviceReadOnlyError) return this.#plain("read_only_short", { model: err.model });
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
      text: truncateTelegramHtml(html, MAX_TELEGRAM_TEXT),
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
        text: truncateTelegramHtml(html, MAX_TELEGRAM_TEXT),
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      })
      .catch(() => undefined);
  }
}

