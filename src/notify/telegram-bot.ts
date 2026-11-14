import crypto from "node:crypto";
import { runAsActor } from "../audit-log.ts";
import { timingSafeEqualString } from "../constant-time.ts";
import { CpeControlValidationError } from "../cpe-domain.ts";
import { AtomicFileWriter, StorageCipher, assertKnownDataFormat } from "../encrypted-file.ts";
import { firmwareReviewPrompt } from "../firmware.ts";
import { interpolateTemplate } from "../i18n.ts";
import type { FengSuiCore } from "../core.ts";
import { gateRefuses } from "../device-access.ts";
import { type WriteFeature } from "../features.ts";
import { type NetworkMode, type UssdRequest, isNetworkMode, readUssdRequest } from "../cellular.ts";
import { BrowserSessionYieldedError, DeviceReadOnlyError, DeviceWriteDisabledError } from "../scheduler.ts";
import { MAX_SMS_SEGMENTS, detectSmsTextMode } from "../sms/text-mode.ts";
import { getCountryByDialCode, resolveRecipientPhone } from "../sms/phone.ts";
import type { SmsService } from "../sms/service.ts";
import type { EnrichedSmsMessage } from "../sms/types.ts";
import type { TelegramChatRecord } from "../api-contract.ts";
import type { TelegramLinkDecision, TelegramLinkOutcome } from "../console-settings.ts";
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
    /** The sender; in groups `sender_chat` is set instead of a person when one posts anonymously or as a channel. */
    from?: { id?: number | string };
    sender_chat?: { id?: number | string };
    /** Forum topic of a message in a group with topics (`is_topic_message`). */
    message_thread_id?: number;
    is_topic_message?: boolean;
    /** Service messages when a group becomes a supergroup (and gets a new chat ID). */
    migrate_to_chat_id?: number | string;
    migrate_from_chat_id?: number | string;
    text?: string;
    reply_to_message?: { message_id?: number };
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    /** Who tapped the button. */
    from?: { id?: number | string };
    /** The card the button is on (with its forum topic in a group with topics). */
    message?: { message_id?: number; chat?: { id?: number | string }; message_thread_id?: number; is_topic_message?: boolean };
  };
}

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = { inline_keyboard: InlineButton[][] };

/** Where an answer goes: the chat, and the forum topic the command, reply or button came from (`null`: none). */
interface ReplyTo {
  chatId: string;
  topic: number | null;
}

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

/** Telegram's answer to a message for a forum topic that was deleted or closed since. */
function isGoneTopicError(err: unknown): boolean {
  return err instanceof TelegramApiError && err.errorCode === 400 && /message thread not found|TOPIC_(?:CLOSED|DELETED)/i.test(err.description);
}

/** The forum topic a message was posted in, or `null` (a private chat, a group without topics, the General topic). */
function topicOf(msg: { message_thread_id?: number; is_topic_message?: boolean } | undefined): number | null {
  return msg?.is_topic_message === true && typeof msg.message_thread_id === "number" ? msg.message_thread_id : null;
}

/** Telegram gives private chats positive IDs and groups (and channels) negative ones. */
function chatKind(chatId: string): TelegramChatRecord["kind"] {
  return chatId.startsWith("-") ? "group" : "private";
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
    topic_gone:
      "<b>原话题已不存在</b>\n\n我发帖的论坛话题已被删除或关闭，之后改在这里（通用话题）发送。要换到别的话题：在控制台「设置 → Telegram」解绑本群，再在那个话题里发送新的群组配对码。",
    unauthorized: "<b>烽燧 · 会话未授权</b>\n\nChat ID：<code>{chatId}</code>\n在控制台「设置 → Telegram」生成绑定码，然后发送 <code>/auth 绑定码</code>（也可以用完整权限的访问令牌）。",
    auth_usage: "用法：<code>/auth 绑定码</code>",
    auth_private_only:
      "<b>这不是群组绑定码</b>\n\n私聊绑定码与访问令牌不能在群组中使用，私聊绑定码发到群里即作废。要在这个群组接收推送，请在控制台「设置 → Telegram」生成群组绑定码。若消息里是访问令牌且仍可见，请立即删除，并在控制台撤销该令牌。",
    auth_group_ok:
      "<b>群组绑定成功</b>\n\n新短信、验证码与告警会推送到这里，群里所有成员都能看到。只有你本人可以在群里操作（发短信、标记已读、删除、静音等）。",
    auth_group_sender: "<b>无法确认是谁发送的 /auth</b>\n\n请以本人身份（不要匿名）在群组里发送：只有绑定群组的人可以在群里操作。",
    group_owner_only: "只有绑定这个群组的人可以操作",
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
      "<b>烽燧 · 5G CPE 助手</b>\n\n<b>短信</b>\n/new 引导式发短信\n/inbox 最近会话\n/unread 未读短信\n/chat <code>号码</code> 查看对话\n/send <code>号码 内容</code> 快速发送（需确认）\n/contacts <code>[关键词]</code> 通讯录\n/contact <code>号码 姓名</code> 添加联系人\n/sync 立即同步\n\n<b>设备</b>\n/status 信号、流量与短信概况\n/alerts 最近告警\n/mute <code>30m|2h|1d|off</code> 告警静音\n\n<b>蜂窝</b>\n/netmode 网络制式\n/airplane 飞行模式\n/ussd <code>代码</code> 发送 USSD 代码（比如查余额）\n\n直接<b>回复</b>任意短信通知即可回信；发送 <code>.vcf</code> 文件可导入通讯录。",
    new_sms: "📩 <b>新短信</b>",
    firmware_prompt: "🤖 把下面这段提示词原样交给 Claude Code（在 cpe-dash 仓库里运行），让它核对新固件的兼容性：",
    otp: "🔑 验证码 <code>{code}</code>",
    reply_hint: "<i>直接回复本消息即可回信至 {phone}</i>",
    btn_read: "✅ 已读",
    btn_chat: "💬 对话",
    btn_delete: "🗑 删除",
    btn_delete_confirm: "⚠️ 确认删除",
    deleted_to_trash: "已删除：在烽燧的「最近删除」里保留 {days} 天，可以恢复",
    deleted_for_good: "已彻底删除",
    btn_cancel: "✖ 取消",
    btn_agent_test_ack: "👌 知道了，不再提醒",
    agent_test_acked: "好的，这次测试不再提醒。要恢复测试前的设置，在控制台「设置 → 设备」点「结束测试」",
    agent_test_nothing: "没有要确认的测试提醒",
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
      "🔒 <b>烽燧不能在这台路由器上改动短信</b>\n\n它是烽燧没有验证过的型号（{model}）：烽燧在这个型号上没有短信写入的实现，或者短信写入已经在控制台「设置 → 设备」关闭。所以不能在这里发短信、标为已读或删除，请在路由器自己的网页上操作；「设置 → 设备」里能看到它是哪一种，也可以报告它的兼容情况。",
    read_only_short: "🔒 烽燧不能在这台路由器（{model}）上改动短信",
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
    cmd_netmode: "网络制式",
    cmd_airplane: "飞行模式",
    cmd_ussd: "发送 USSD 代码",
    cell_refused: "🔒 {what}：{reason}",
    reason_unavailable: "烽燧在这台路由器（{model}）上做不了这项。",
    reason_disabled: "你在控制台「设置 → 设备」里关掉了这项。",
    cell_working: "⏳ 正在发给路由器…",
    cell_expired: "这张卡片已经过期，请重新发送指令。",
    cell_failed: "⚠️ {what}没有完成：{reason}",
    netmode_title: "网络制式",
    netmode_unknown: "读不到这台路由器的网络制式，请稍后再试。",
    netmode_pick: "<b>网络制式</b>\n\n现在：{current}\n选一个新的：",
    netmode_confirm: "<b>改成「{mode}」？</b>\n\n路由器会重新搜网，可能断网一小会儿。改完 3 分钟网络还没恢复，烽燧会把它改回原来的制式。",
    netmode_done: "✅ 网络制式已改成「{mode}」。",
    airplane_title: "飞行模式",
    airplane_state: "<b>飞行模式</b>\n\n现在：{state}",
    airplane_on: "开",
    airplane_off: "关",
    airplane_unknown: "路由器没有报告",
    airplane_confirm_on: "<b>打开飞行模式？</b>\n\n路由器会断开移动网络，烽燧不会自动关掉它。如果运行烽燧的设备也经这台路由器上网，Telegram 也会跟着断开，那时只能回到烽燧控制台里关掉。",
    airplane_confirm_off: "<b>关闭飞行模式？</b>\n\n路由器会重新连上移动网络。",
    airplane_done_on: "✈️ 飞行模式已打开。要关掉，发送 /airplane，或者在控制台的控制抽屉里关。",
    airplane_done_off: "✅ 飞行模式已关闭。",
    ussd_title: "USSD",
    ussd_usage: "用法：/ussd <code>代码</code>，例如 <code>*100#</code>（只能有数字、* 和 #，最多 40 个）。",
    ussd_confirm: "<b>发送 USSD 代码 <code>{code}</code>？</b>\n\n运营商会照这个代码办事，有的代码会扣费或改套餐。只发一次。",
    ussd_answer: "📨 <b>运营商的回复</b>\n\n<blockquote>{text}</blockquote>",
    ussd_awaits: "\n\n运营商在等你回复：直接回复这条消息（只能有数字、* 和 #），或者点「结束」。",
    ussd_no_answer: "运营商没有回复。",
    ussd_ended: "USSD 会话已结束。",
    btn_confirm: "✅ 确认",
    btn_airplane_on: "✈️ 打开飞行模式",
    btn_airplane_off: "📶 关闭飞行模式",
    btn_ussd_send: "📤 发送",
    btn_ussd_end: "✖ 结束",
    mode_auto: "自动",
    mode_nr_sa: "仅 5G（SA）",
    mode_nr_nsa: "5G（NSA）+ 4G",
    mode_nr_lte: "5G + 4G",
    mode_lte: "仅 4G",
    mode_lte_tdd: "仅 4G TDD",
    mode_lte_fdd: "仅 4G FDD",
    mode_lte_wcdma: "4G + 3G",
    mode_wcdma: "仅 3G",
    mode_gsm: "仅 2G",
    mode_unknown: "路由器没有报告",
  },
  en: {
    topic_gone:
      "<b>The topic is gone</b>\n\nThe forum topic I posted to was deleted or closed, so I post here (General) from now on. To move me to another topic, unlink this group in Settings → Telegram and send a new group pairing code in that topic.",
    unauthorized: "<b>FengSui · chat not authorized</b>\n\nChat ID: <code>{chatId}</code>\nCreate a pairing code in the console (Settings → Telegram), then send <code>/auth CODE</code> (a full-access token works too).",
    auth_usage: "Usage: <code>/auth PAIRING_CODE</code>",
    auth_private_only:
      "<b>Not a group pairing code</b>\n\nPrivate pairing codes and access tokens do not work in groups; a private code sent to a group is now void. To get notifications in this group, create a group pairing code in the console (Settings → Telegram). If your message held an access token and is still visible, delete it now and revoke that token in the console.",
    auth_group_ok:
      "<b>Group linked</b>\n\nNew SMS, codes and alerts are posted here, where every member can read them. Only you can act on them in this group (send, mark read, delete, mute and so on).",
    auth_group_sender: "<b>Cannot tell who sent /auth</b>\n\nSend it as yourself, not anonymously: only the person who links a group can act in it.",
    group_owner_only: "Only the person who linked this group can do that",
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
      "<b>FengSui · 5G CPE assistant</b>\n\n<b>SMS</b>\n/new guided send\n/inbox recent conversations\n/unread unread messages\n/chat <code>number</code> show a conversation\n/send <code>number text</code> quick send (with confirmation)\n/contacts <code>[query]</code> contact book\n/contact <code>number name</code> add a contact\n/sync sync now\n\n<b>Device</b>\n/status signal, traffic and SMS overview\n/alerts recent alerts\n/mute <code>30m|2h|1d|off</code> mute alerts\n\n<b>Cellular</b>\n/netmode network mode\n/airplane airplane mode\n/ussd <code>code</code> send a USSD code (a balance check, say)\n\n<b>Reply</b> to any SMS notification to answer it; send a <code>.vcf</code> file to import contacts.",
    new_sms: "📩 <b>New SMS</b>",
    firmware_prompt: "🤖 Hand this prompt to Claude Code (run it in the cpe-dash repository) to check the new firmware:",
    otp: "🔑 Code <code>{code}</code>",
    reply_hint: "<i>Reply to this message to text {phone}</i>",
    btn_read: "✅ Read",
    btn_chat: "💬 Thread",
    btn_delete: "🗑 Delete",
    btn_delete_confirm: "⚠️ Confirm delete",
    deleted_to_trash: "Deleted: FengSui keeps it in Recently deleted for {days} days, where it can be restored",
    deleted_for_good: "Deleted for good",
    btn_cancel: "✖ Cancel",
    btn_agent_test_ack: "👌 Got it, no more reminders",
    agent_test_acked: "OK, no more reminders for this test. To put back the settings from before it, choose “End test” under Settings → Device in the console",
    agent_test_nothing: "No test reminder is waiting for an answer",
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
      "🔒 <b>FengSui cannot change SMS on this router</b>\n\nIt is a model FengSui was not verified on ({model}): FengSui has no SMS write for it, or SMS writes are turned off under Settings → Device in the console. So sending, marking read and deleting are not available here; use the router's own web page. Settings → Device shows which of the two it is and can report how the router works.",
    read_only_short: "🔒 FengSui cannot change SMS on this router ({model})",
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
    cmd_netmode: "Network mode",
    cmd_airplane: "Airplane mode",
    cmd_ussd: "Send a USSD code",
    cell_refused: "🔒 {what}: {reason}",
    reason_unavailable: "FengSui cannot do this on this router ({model}).",
    reason_disabled: "You turned this off under Settings → Device in the console.",
    cell_working: "⏳ Sending it to the router…",
    cell_expired: "This card has expired; send the command again.",
    cell_failed: "⚠️ {what} did not go through: {reason}",
    netmode_title: "Network mode",
    netmode_unknown: "Could not read this router's network mode; try again in a moment.",
    netmode_pick: "<b>Network mode</b>\n\nNow: {current}\nPick a new one:",
    netmode_confirm: "<b>Switch to \"{mode}\"?</b>\n\nThe router searches for the network again, so the internet may drop for a moment. If it is still down 3 minutes later, FengSui switches back to the mode it had.",
    netmode_done: "✅ The network mode is now \"{mode}\".",
    airplane_title: "Airplane mode",
    airplane_state: "<b>Airplane mode</b>\n\nNow: {state}",
    airplane_on: "on",
    airplane_off: "off",
    airplane_unknown: "not reported by the router",
    airplane_confirm_on: "<b>Turn airplane mode on?</b>\n\nThe router drops the mobile network, and FengSui never turns it back off by itself. If the machine FengSui runs on reaches the internet through this router, Telegram goes too, and only FengSui's console can turn it off then.",
    airplane_confirm_off: "<b>Turn airplane mode off?</b>\n\nThe router connects to the mobile network again.",
    airplane_done_on: "✈️ Airplane mode is on. To turn it off, send /airplane or use the controls drawer in the console.",
    airplane_done_off: "✅ Airplane mode is off.",
    ussd_title: "USSD",
    ussd_usage: "Usage: /ussd <code>code</code>, for example <code>*100#</code> (digits, * and # only, at most 40).",
    ussd_confirm: "<b>Send the USSD code <code>{code}</code>?</b>\n\nThe operator acts on it, and some codes cost money or change your plan. It is sent once.",
    ussd_answer: "📨 <b>The operator's answer</b>\n\n<blockquote>{text}</blockquote>",
    ussd_awaits: "\n\nThe operator awaits an answer: reply to this message (digits, * and # only), or tap End.",
    ussd_no_answer: "The operator did not answer.",
    ussd_ended: "The USSD session is over.",
    btn_confirm: "✅ Confirm",
    btn_airplane_on: "✈️ Turn airplane mode on",
    btn_airplane_off: "📶 Turn airplane mode off",
    btn_ussd_send: "📤 Send",
    btn_ussd_end: "✖ End",
    mode_auto: "Automatic",
    mode_nr_sa: "5G only (SA)",
    mode_nr_nsa: "5G (NSA) + 4G",
    mode_nr_lte: "5G + 4G",
    mode_lte: "4G only",
    mode_lte_tdd: "4G TDD only",
    mode_lte_fdd: "4G FDD only",
    mode_lte_wcdma: "4G + 3G",
    mode_wcdma: "3G only",
    mode_gsm: "2G only",
    mode_unknown: "not reported by the router",
  },
} as const satisfies Record<SupportedLocale, Record<string, string>>;

type TextKey = keyof (typeof TEXT)["en"];

// ---------------------------------------------------------------------------------------------
// Encrypted bot state (authorized chats, reply routing, alert mute)
// ---------------------------------------------------------------------------------------------

/** A group linked with a group pairing code: who may act in it, and the forum topic it posts to. */
export interface TelegramGroupLink {
  userId: string;
  threadId: number | null;
}

interface PersistedTelegramState {
  version: 1;
  authorizedChatIds: string[];
  /** Absent before group linking existed; such a file has none. */
  groupLinks?: Array<[string, TelegramGroupLink]>;
  /** Chats a full-access token linked, with the token's ID: revoking it unlinks them. Absent in older files. */
  linkedVia?: Array<[string, string]>;
  /** When `/auth` linked each chat (ms). */
  linkedAt: Array<[string, number]>;
  replyTargets: Array<[string, string]>;
  alertsMutedUntilMs: number | null;
}

function isGroupLinkEntry(entry: unknown): entry is [string, TelegramGroupLink] {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return false;
  const link: unknown = entry[1];
  if (typeof link !== "object" || link === null) return false;
  const { userId, threadId } = link as Record<string, unknown>;
  return typeof userId === "string" && userId !== "" && (threadId === null || (typeof threadId === "number" && Number.isSafeInteger(threadId)));
}

export class TelegramStateStore {
  readonly filePath: string;
  #cipher: StorageCipher;
  #writer: AtomicFileWriter;
  #authorized = new Set<string>();
  #groupLinks = new Map<string, TelegramGroupLink>();
  /** Chat ID → the ID of the token that linked it (chats a pairing code linked are absent). */
  #linkedVia = new Map<string, string>();
  /** Chat ID → when `/auth` linked it. */
  #linkedAt = new Map<string, number>();
  #replyTargets = new Map<string, string>();
  #mutedUntilMs: number | null = null;
  readonly #now: () => number;

  constructor(opts: { filePath: string; cipher: StorageCipher; now?: () => number }) {
    this.filePath = opts.filePath;
    this.#cipher = opts.cipher;
    this.#writer = new AtomicFileWriter(opts.filePath);
    this.#now = opts.now ?? Date.now;
  }

  load(): void {
    const parsed = this.#cipher.readJsonFileOrQuarantine<Partial<PersistedTelegramState>>(this.filePath);
    assertKnownDataFormat(this.filePath, parsed?.version, 1);
    this.#authorized = new Set((parsed?.authorizedChatIds ?? []).filter((id): id is string => typeof id === "string"));
    this.#groupLinks = new Map(
      (Array.isArray(parsed?.groupLinks) ? parsed.groupLinks : [])
        .filter(isGroupLinkEntry)
        .filter(([chatId]) => this.#authorized.has(chatId))
        .map(([chatId, link]) => [chatId, { userId: link.userId, threadId: link.threadId }])
    );
    this.#linkedVia = new Map(
      (Array.isArray(parsed?.linkedVia) ? parsed.linkedVia : []).filter(
        (e): e is [string, string] => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string" && e[1] !== "" && this.#authorized.has(e[0])
      )
    );
    this.#linkedAt = new Map(
      (Array.isArray(parsed?.linkedAt) ? parsed.linkedAt : []).filter(
        (e): e is [string, number] => Array.isArray(e) && typeof e[0] === "string" && Number.isFinite(e[1]) && this.#authorized.has(e[0])
      )
    );
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
      groupLinks: [...this.#groupLinks],
      linkedVia: [...this.#linkedVia],
      linkedAt: [...this.#linkedAt],
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

  /**
   * Link a chat; a group links with who linked it (only they may act there) and its forum topic.
   * `viaTokenId` names the full-access token `/auth` used, so revoking that token unlinks the chat.
   */
  authorize(chatId: string, group?: TelegramGroupLink, viaTokenId: string | null = null): void {
    this.#authorized.add(chatId);
    if (group) this.#groupLinks.set(chatId, { userId: group.userId, threadId: group.threadId });
    else this.#groupLinks.delete(chatId);
    if (viaTokenId) this.#linkedVia.set(chatId, viaTokenId);
    else this.#linkedVia.delete(chatId);
    this.#linkedAt.set(chatId, this.#now());
    this.#commit();
  }

  /** The group link of a chat linked with a group pairing code, or `null`. */
  groupLink(chatId: string): TelegramGroupLink | null {
    const link = this.#groupLinks.get(chatId);
    return link ? { ...link } : null;
  }

  /** Move a group link from forum topic `from` to `to` (`null`: General); `false` when it no longer posts to `from`. */
  setGroupTopic(chatId: string, from: number | null, to: number | null): boolean {
    const link = this.#groupLinks.get(chatId);
    if (!link || link.threadId !== from) return false;
    this.#groupLinks.set(chatId, { userId: link.userId, threadId: to });
    this.#commit();
    return true;
  }

  /** A linked group became a supergroup under a new ID: the link follows it. `false` when `from` was not linked. */
  moveChat(from: string, to: string): boolean {
    if (from === to || !this.#authorized.delete(from)) return false;
    this.#authorized.add(to);
    const link = this.#groupLinks.get(from);
    this.#groupLinks.delete(from);
    if (link) this.#groupLinks.set(to, link);
    const via = this.#linkedVia.get(from);
    this.#linkedVia.delete(from);
    if (via) this.#linkedVia.set(to, via);
    const at = this.#linkedAt.get(from);
    this.#linkedAt.delete(from);
    if (at !== undefined) this.#linkedAt.set(to, at);
    this.#commit();
    return true;
  }

  /** Forget every chat linked through `/auth`; returns how many were revoked. */
  revokeAll(): number {
    const count = this.#authorized.size;
    if (count === 0) return 0;
    this.#authorized.clear();
    this.#groupLinks.clear();
    this.#linkedVia.clear();
    this.#linkedAt.clear();
    this.#commit();
    return count;
  }

  /** Unlink the chats the token `tokenId` linked (it was revoked); returns how many. */
  revokeLinkedVia(tokenId: string): number {
    const chats = [...this.#linkedVia].filter(([, via]) => via === tokenId).map(([chatId]) => chatId);
    for (const chatId of chats) this.#forget(chatId);
    if (chats.length > 0) this.#commit();
    return chats.length;
  }

  /** Unlink one chat linked through `/auth`; `false` when it was not linked that way. */
  unlink(chatId: string): boolean {
    if (!this.#authorized.has(chatId)) return false;
    this.#forget(chatId);
    this.#commit();
    return true;
  }

  /** The chats linked through `/auth`: how (a group link, the token) and when (`null` when not known). */
  linkedChats(): Array<{ chatId: string; group: TelegramGroupLink | null; viaTokenId: string | null; linkedAtMs: number | null }> {
    return [...this.#authorized].map((chatId) => ({
      chatId,
      group: this.groupLink(chatId),
      viaTokenId: this.#linkedVia.get(chatId) ?? null,
      linkedAtMs: this.#linkedAt.get(chatId) ?? null,
    }));
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

  #forget(chatId: string): void {
    this.#authorized.delete(chatId);
    this.#groupLinks.delete(chatId);
    this.#linkedVia.delete(chatId);
    this.#linkedAt.delete(chatId);
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
  core: Pick<FengSuiCore, "scheduler" | "monitor" | "controls">;
  state: TelegramStateStore;
  /** SMS features are hidden when `null` (SMS_ENABLED=false). */
  sms: SmsService | null;
  /** Secret accepted by `/auth` in private chats when `linkSecret` is not given (tests, embedders). */
  authToken: string;
  /**
   * Decide an `/auth` secret sent in a private chat or a group: a one-time pairing code from the
   * console (a group needs a group code), or a full-access token (private chats only).
   */
  linkSecret?: (secret: string, where: "private" | "group") => TelegramLinkOutcome | TelegramLinkDecision;
  /** A console password reset code for `/reset`, or `null` when Telegram reset is turned off. */
  issueResetCode?: () => string | null;
  /** "Got it" under the AI agent test's reminder: no more reminders for that test (`false`: none was waiting). */
  acknowledgeAgentTest?: () => boolean;
  allowedChatIds?: ReadonlyArray<string>;
  locale?: SupportedLocale;
  /** A fixed dial code, or where to read the current one (it can become known after start; `""`: none yet). */
  defaultCountryCode: string | (() => string);
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

/** The cellular cards' buttons: pick, confirm, cancel, and end a USSD session. */
const CELLULAR_CALLBACKS: ReadonlySet<string> = new Set(["nm", "nmok", "ap", "apok", "ussdok", "ussdend", "opno"]);

/** How long a cellular write waits for its confirm button. */
const PENDING_OP_TTL_MS = 2 * 60_000;

/** How long an operator's USSD answer takes a reply (the network ends a session left waiting long before). */
const USSD_REPLY_TTL_MS = 5 * 60_000;

type PendingCellularOpBody = { kind: "netmode"; mode: NetworkMode } | { kind: "airplane"; enabled: boolean } | { kind: "ussd"; request: Exclude<UssdRequest, { kind: "cancel" }> };
type PendingCellularOp = PendingCellularOpBody & { chatId: string; expiresAt: number };

export class TelegramBot implements NotificationChannel {
  readonly name = "telegram";
  readonly api: TelegramApi;
  readonly core: Pick<FengSuiCore, "scheduler" | "monitor" | "controls">;
  readonly state: TelegramStateStore;
  readonly sms: SmsService | null;
  readonly locale: SupportedLocale;
  readonly #countryCode: () => string;
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly #authToken: string;
  readonly #linkSecret: ((secret: string, where: "private" | "group") => TelegramLinkOutcome | TelegramLinkDecision) | null;
  /** The bot's own @username (from getMe), to tell commands meant for another bot in a group apart. */
  #username: string | null = null;
  /** getMe answered once (with or without a usable name): no need to ask again. */
  #identified = false;
  #identifying: Promise<void> | null = null;
  readonly #issueResetCode: (() => string | null) | null;
  readonly #acknowledgeAgentTest: (() => boolean) | null;
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
  /** Cellular writes waiting for their confirm button, by one-time token (in memory only: a restart forgets them). */
  #pendingOps = new Map<string, PendingCellularOp>();
  /** The operator's USSD answers that await a reply, by `chat:message` (in memory only), until they expire. */
  #ussdThreads = new Map<string, number>();
  #authFailures = new Map<string, number[]>();
  /** Notifications that failed on a network error, oldest first (delivered once Telegram answers again). */
  #outbox: PendingNotification[] = [];
  #flushing: Promise<void> | null = null;
  /** Telegram answered 429 with `retry_after`: no notification is sent before this time. */
  #outboxRetryAtMs = 0;
  #globalAuthFailures: number[] = [];

  constructor(opts: TelegramBotOptions) {
    this.api = opts.api;
    this.core = opts.core;
    this.state = opts.state;
    this.sms = opts.sms;
    this.#authToken = opts.authToken;
    this.#linkSecret = opts.linkSecret ?? null;
    this.#issueResetCode = opts.issueResetCode ?? null;
    this.#acknowledgeAgentTest = opts.acknowledgeAgentTest ?? null;
    this.allowedChatIds = (opts.allowedChatIds ?? []).map(String);
    this.locale = opts.locale ?? "zh-CN";
    const country = opts.defaultCountryCode;
    this.#countryCode = typeof country === "function" ? country : () => country;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.log ?? (() => undefined);
  }

  /** Dial code a number typed without `+` is sent to (`""`: none known yet). */
  get defaultCountryCode(): string {
    return this.#countryCode();
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#lifecycle = new AbortController();
    await this.api
      .call("setMyCommands", {
        commands: (["new", "inbox", "unread", "status", "alerts", "contacts", "sync", "mute", "netmode", "airplane", "ussd", "help"] as const).map(
          (command) => ({ command, description: this.#tx(`cmd_${command}`) })
        ),
      })
      .catch(() => undefined);
    await this.#identify();
    this.#pollLoop = this.#runPollLoop();
  }

  /** The bot's @username, once Telegram told it (`null` before, or while Telegram was unreachable). */
  get username(): string | null {
    return this.#username;
  }

  /** Learn the bot's own @username; tried again after each poll until Telegram answered once. */
  async #identify(): Promise<void> {
    if (this.#identified) return;
    this.#identifying ??= this.api
      .call<{ username?: unknown }>("getMe", {})
      .then((me) => {
        this.#identified = true;
        if (typeof me?.username === "string" && /^[A-Za-z0-9_]{1,64}$/.test(me.username)) this.#username = me.username;
      })
      .catch(() => undefined)
      .finally(() => {
        this.#identifying = null;
      });
    await this.#identifying;
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

  /** Unlink every chat linked with /auth (TELEGRAM_CHAT_IDS stay authorized); returns how many. */
  unlinkAllChats(): number {
    const revoked = this.state.revokeAll();
    if (revoked > 0) this.#log(`[telegram] unlinked ${revoked} chat(s) from the console`);
    return revoked;
  }

  /** A full-access token was revoked: unlink the chats it linked with /auth; returns how many. */
  unlinkChatsLinkedBy(tokenId: string): number {
    const revoked = this.state.revokeLinkedVia(tokenId);
    if (revoked > 0) this.#log(`[telegram] unlinked ${revoked} chat(s) linked with a revoked token`);
    return revoked;
  }

  /** Unlink one chat linked with /auth (one TELEGRAM_CHAT_IDS lists stays authorized); `false` when it was not linked. */
  unlinkChat(chatId: string): boolean {
    if (!this.state.unlink(chatId)) return false;
    this.#wizards.delete(chatId);
    this.#log("[telegram] unlinked a chat from the console");
    return true;
  }

  /**
   * Every chat the bot reaches: those linked with /auth, newest first, then those only
   * TELEGRAM_CHAT_IDS authorizes, in its order. `tokenName` names the token that linked a chat.
   */
  chatRecords(tokenName: (tokenId: string) => string | null = () => null): TelegramChatRecord[] {
    const env = new Set(this.allowedChatIds);
    // Reversed first, so links made in the same millisecond also list the newest first
    const linked = this.state
      .linkedChats()
      .reverse()
      .sort((a, b) => (b.linkedAtMs ?? 0) - (a.linkedAtMs ?? 0))
      .map(
        (chat): TelegramChatRecord => ({
          chatId: chat.chatId,
          kind: chatKind(chat.chatId),
          fromEnv: env.has(chat.chatId),
          linkedWith: chat.group ? "group-code" : chat.viaTokenId ? "token" : "code",
          tokenName: chat.viaTokenId ? tokenName(chat.viaTokenId) : null,
          linkedBy: chat.group?.userId ?? null,
          topic: chat.group?.threadId ?? null,
          linkedAtIso: chat.linkedAtMs === null ? null : new Date(chat.linkedAtMs).toISOString(),
        })
      );
    const linkedIds = new Set(linked.map((chat) => chat.chatId));
    const envOnly = [...env]
      .filter((chatId) => !linkedIds.has(chatId))
      .map((chatId): TelegramChatRecord => ({ chatId, kind: chatKind(chatId), fromEnv: true, linkedWith: null, tokenName: null, linkedBy: null, topic: null, linkedAtIso: null }));
    return [...linked, ...envOnly];
  }

  // ----------------------------------------------------------------- notification channel

  async notifySms(message: EnrichedSmsMessage): Promise<void> {
    const lines = [this.#tx("new_sms"), "", this.#senderLine(message), `⏱ ${escapeTelegramHtml(message.date)}`];
    if (message.verificationCode) lines.push(this.#tx("otp", { code: message.verificationCode }));
    lines.push("", `<blockquote>${escapeTelegramHtml(truncate(message.content, 3000))}</blockquote>`);
    // Where the gate refuses SMS writes (a model nobody verified without them, or with them turned off), a message can be read, not answered: no reply, read or delete
    const writable = this.#readOnlyModel() === null;
    // Nor is a button offered for what the router's interface has no way to do (send; delete one message)
    const abilities = this.sms?.abilities ?? null;
    const canSend = abilities?.send !== false;
    const canDelete = (abilities?.delete ?? "message") === "message";
    const replyPhone = writable && canSend && message.sender.dialable ? (message.sender.e164 ?? message.phone) : null;
    if (replyPhone) lines.push(this.#tx("reply_hint", { phone: replyPhone }));

    const row: InlineButton[] = [];
    const readCb = callbackData("read", message.uid);
    const chatCb = callbackData("chat", message.threadKey);
    const delCb = callbackData("del", message.uid);
    if (writable && message.isUnread && readCb) row.push({ text: this.#tx("btn_read"), callback_data: readCb });
    if (chatCb) row.push({ text: this.#tx("btn_chat"), callback_data: chatCb });
    if (writable && canDelete && delCb) row.push({ text: this.#tx("btn_delete"), callback_data: delCb });

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
    // The AI agent test's reminder is read with a tap (Telegram cannot tell that a message was read)
    const keyboard: InlineKeyboard | undefined =
      alert.code === "AGENT_TEST_STILL_ON" && this.#acknowledgeAgentTest ? { inline_keyboard: [[{ text: this.#tx("btn_agent_test_ack"), callback_data: "testok:1" }]] } : undefined;
    for (const chatId of this.state.authorizedChats(this.allowedChatIds)) {
      await this.#deliver({ chatId, html: text, ...(keyboard ? { keyboard } : {}) });
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

  /** Chats whose failed `/auth` attempts still count against them (inside the rate-limit window). */
  get authFailureChats(): number {
    return this.#authFailures.size;
  }

  /**
   * Retry queued notifications in order. Stops at the first one that still cannot be delivered
   * (still offline); one Telegram refuses for good (blocked bot, gone chat) is dropped.
   */
  async flushOutbox(): Promise<void> {
    if (this.#flushing) return await this.#flushing;
    if (this.#now() < this.#outboxRetryAtMs) return;
    const run = async (): Promise<void> => {
      for (let next = this.#outbox[0]; next; next = this.#outbox[0]) {
        // Too old to be news, or for a chat unlinked while it waited (it may carry SMS and codes)
        if (this.#now() - next.queuedAtMs > OUTBOX_MAX_AGE_MS || !this.state.isAuthorized(next.chatId, this.allowedChatIds)) {
          this.#dequeue(next);
          continue;
        }
        try {
          const sent = await this.#send({ chatId: next.chatId, topic: null }, next.html, next.keyboard);
          this.#dequeue(next);
          this.#afterNotification(next, sent);
        } catch (err) {
          if (isTransientTelegramError(err)) {
            this.#noteRetryAfter(err);
            return;
          }
          this.#dequeue(next);
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
    // Sending inside a 429 window would only extend Telegram's limit: queue it for later
    if (this.#now() < this.#outboxRetryAtMs) {
      this.#enqueue(notification);
      return;
    }
    if (this.#outbox.some((pending) => pending.chatId === notification.chatId)) {
      this.#enqueue(notification);
      await this.flushOutbox();
      return;
    }
    try {
      this.#afterNotification(notification, await this.#send({ chatId: notification.chatId, topic: null }, notification.html, notification.keyboard));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (!isTransientTelegramError(err)) {
        this.#log(`[telegram] notification to a chat failed: ${reason}`);
        return;
      }
      if (this.#outbox.length === 0) this.#log(`[telegram] Telegram unreachable; queueing notifications until it answers: ${reason}`);
      this.#noteRetryAfter(err);
      this.#enqueue(notification);
    }
  }

  /** A 429 names how long to wait: keep notifications queued until then. */
  #noteRetryAfter(err: unknown): void {
    if (err instanceof TelegramApiError && err.retryAfterSec !== null) {
      this.#outboxRetryAtMs = Math.max(this.#outboxRetryAtMs, this.#now() + err.retryAfterSec * 1000);
    }
  }

  /**
   * Take a notification off the queue by identity: while it was being sent, a new one may have pushed the oldest out
   * of a full queue, so the head is not necessarily it any more (and it may be gone already).
   */
  #dequeue(notification: PendingNotification): void {
    const at = this.#outbox.indexOf(notification);
    if (at >= 0) this.#outbox.splice(at, 1);
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
        if (!this.#identified) void this.#identify();
        for (const update of Array.isArray(updates) ? updates : []) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          const handling = this.handleUpdate(update);
          this.#handlers.add(handling);
          void handling.finally(() => this.#handlers.delete(handling));
        }
      } catch (err) {
        if (!this.#running) break;
        if (this.#standby) continue;
        // A 429 names its own wait; polling or notifying sooner only extends Telegram's limit
        const waitMs = err instanceof TelegramApiError && err.retryAfterSec !== null ? Math.max(backoffMs, err.retryAfterSec * 1000) : backoffMs;
        this.#noteRetryAfter(err);
        this.#log(`[telegram] poll error, retrying in ${waitMs} ms: ${err instanceof Error ? err.message : String(err)}`);
        await this.#pause(waitMs);
        backoffMs = Math.min(30_000, backoffMs * 2);
      }
    }
  }

  async #handleMessage(msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const chatId = String(msg.chat?.id ?? "");
    if (!chatId) return;
    if (msg.migrate_to_chat_id !== undefined || msg.migrate_from_chat_id !== undefined) {
      this.#migrateChat(msg.migrate_to_chat_id === undefined ? String(msg.migrate_from_chat_id) : chatId, String(msg.migrate_to_chat_id ?? chatId));
      return;
    }
    // In a group with topics everything this message causes is answered in its topic
    const to: ReplyTo = { chatId, topic: topicOf(msg) };
    const text = (msg.text ?? "").trim();
    const privateChat = msg.chat?.type === "private";
    // In a group the bot may see every message: a command for another bot is not ours, nor is chatter
    const addressedTo = /^\/[A-Za-z0-9_]{1,32}@(\S+)/.exec(text)?.[1];
    if (addressedTo !== undefined && this.#username !== null && addressedTo.toLowerCase() !== this.#username.toLowerCase()) return;

    if (/^\/auth(?:@\S+)?(?:\s|$)/i.test(text)) {
      await this.#cmdAuth(to, text.replace(/^\/auth(?:@\S+)?\s*/i, ""), msg);
      return;
    }
    if (!this.state.isAuthorized(chatId, this.allowedChatIds)) {
      if (privateChat || text.startsWith("/")) await this.#send(to, this.#tx("unauthorized", { chatId }));
      return;
    }
    // A group linked with a group code takes commands, replies and files from the member who linked it only
    const group = this.state.groupLink(chatId);
    if (group && (msg.sender_chat !== undefined || String(msg.from?.id ?? "") !== group.userId)) return;
    if (/^\/reset(?:@\S+)?$/i.test(text)) {
      await this.#cmdReset(to, privateChat);
      return;
    }

    if (msg.document) {
      await this.#importVcf(to, msg.document);
      return;
    }
    if (!text) return;

    if (!text.startsWith("/") && msg.reply_to_message?.message_id !== undefined && this.#ussdThreadOpen(chatId, msg.reply_to_message.message_id)) {
      await this.#cmdUssd(to, text, "reply");
      return;
    }
    if (!text.startsWith("/") && msg.reply_to_message?.message_id !== undefined) {
      const target = this.state.replyTarget(chatId, msg.reply_to_message.message_id);
      if (target) {
        this.#wizards.delete(chatId);
        await this.#executeSend(to, target, text);
        return;
      }
    }
    if (!text.startsWith("/") && this.#wizard(chatId)) {
      await this.#handleWizardInput(to, text);
      return;
    }

    const match = text.match(/^\/([A-Za-z0-9_]{1,32})(?:@\S+)?(?:\s+([\s\S]*))?$/);
    if (!match) {
      if (privateChat) await this.#send(to, this.#tx("help"), this.#newSmsKeyboard());
      return;
    }
    const command = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();
    if (command !== "cancel") this.#wizards.delete(chatId);
    await this.#dispatchCommand(to, command, rest);
  }

  /** A linked group became a supergroup: Telegram tells both chats, so the second notice finds nothing to move. */
  #migrateChat(from: string, to: string): void {
    if (this.state.moveChat(from, to)) {
      // What waited for the old chat (an outage) goes to the new one, rather than failing the authorisation check
      for (const pending of this.#outbox) if (pending.chatId === from) pending.chatId = to;
      this.#log("[telegram] a linked group became a supergroup; its link moved to the new chat ID");
    } else if (this.allowedChatIds.includes(from) && !this.allowedChatIds.includes(to)) {
      this.#log("[telegram] a group in TELEGRAM_CHAT_IDS became a supergroup with a new chat ID; send a command there to see it, then update TELEGRAM_CHAT_IDS");
    }
  }

  async #dispatchCommand(to: ReplyTo, command: string, rest: string): Promise<void> {
    switch (command) {
      case "start":
      case "help":
        return await this.#reply(to, "help", undefined, this.#newSmsKeyboard());
      case "status":
        return await this.#cmdStatus(to);
      case "alerts":
        return await this.#cmdAlerts(to);
      case "mute":
        return await this.#cmdMute(to, rest);
      case "netmode":
        return await this.#cmdNetmode(to);
      case "airplane":
        return await this.#cmdAirplane(to);
      case "ussd":
        return await this.#cmdUssd(to, rest, "send");
      case "cancel":
        this.#wizards.delete(to.chatId);
        return await this.#reply(to, "wiz_cancelled");
    }
    const sms = this.sms;
    if (!sms) {
      await this.#send(to, this.#tx(["new", "inbox", "unread", "chat", "send", "contacts", "contact", "sync"].includes(command) ? "sms_disabled" : "unknown_command", { command }));
      return;
    }
    if ((command === "new" || command === "send") && (await this.#refuseReadOnly(to))) return;
    switch (command) {
      case "new":
        return await this.#startWizard(to);
      case "inbox":
        return await this.#cmdInbox(to, sms, Number.parseInt(rest || "1", 10) || 1);
      case "unread":
        return await this.#cmdUnread(to, sms);
      case "chat":
        return await this.#cmdChat(to, sms, rest);
      case "send":
        return await this.#cmdSend(to, rest);
      case "contacts":
        return await this.#cmdContacts(to, sms, rest);
      case "contact":
        return await this.#cmdContact(to, sms, rest);
      case "sync":
        return await this.#cmdSync(to, sms);
      default:
        await this.#send(to, this.#tx("unknown_command", { command }));
    }
  }

  async #handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
    const chatId = String(cq.message?.chat?.id ?? "");
    const messageId = cq.message?.message_id;
    // A button answers in the forum topic its card is in
    const to: ReplyTo = { chatId, topic: topicOf(cq.message) };
    const answer = (text?: string, alert = false): Promise<unknown> =>
      this.api.call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => undefined);
    if (!chatId || !this.state.isAuthorized(chatId, this.allowedChatIds)) {
      await answer(this.#plain("unauthorized", { chatId }), true);
      return;
    }
    const group = this.state.groupLink(chatId);
    if (group && String(cq.from?.id ?? "") !== group.userId) {
      await answer(this.#plain("group_owner_only"), true);
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
        return await this.#cmdStatus(to);
      }
      if (action === "testok") {
        const read = this.#acknowledgeAgentTest?.() ?? false;
        await answer(this.#plain(read ? "agent_test_acked" : "agent_test_nothing"), read);
        if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
        return;
      }
      if (CELLULAR_CALLBACKS.has(action)) return await this.#cellularCallback(to, action, arg, messageId, answer);
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
          return await this.#startWizard(to);
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
          return await this.#advanceToContent(to, arg);
        case "wizback": {
          await answer();
          const wiz = this.#wizard(chatId);
          if (arg === "content" && wiz?.phone) return await this.#advanceToContent(to, wiz.phone);
          return await this.#startWizard(to, wiz?.countryCode);
        }
        case "wizsend": {
          const wiz = this.#wizard(chatId);
          if (!wiz?.phone || !wiz.content || wiz.step !== "confirm" || arg !== wiz.confirmToken) {
            await answer(this.#plain("wiz_expired"), true);
            return;
          }
          this.#wizards.delete(chatId);
          await answer();
          return await this.#executeSend(to, wiz.phone, wiz.content, messageId);
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
          return await this.#cmdChat(to, sms, arg);
        case "inbox":
          await answer();
          return await this.#cmdInbox(to, sms, Number.parseInt(arg || "1", 10) || 1);
        case "unread":
          await answer();
          return await this.#cmdUnread(to, sms);
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
        case "delok": {
          const { trashDays } = await sms.deleteMessages({ uids: [arg] });
          await answer(trashDays > 0 ? this.#plain("deleted_to_trash", { days: trashDays }) : this.#plain("deleted_for_good"));
          if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
          return;
        }
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

  async #cmdAuth(to: ReplyTo, secret: string, msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    const { chatId } = to;
    if (msg.message_id !== undefined) {
      void this.api.call("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => undefined);
    }
    // Answers go to the forum topic /auth was sent in
    const answer = async (key: TextKey): Promise<void> => {
      await this.#send(to, this.#tx(key));
    };
    if (this.state.isAuthorized(chatId, this.allowedChatIds)) return await answer("auth_already");
    if (this.#authLimited(chatId)) return await answer("auth_limited");
    if (!secret) return await answer("auth_usage");
    const where = msg.chat?.type === "private" ? "private" : "group";
    // A group is linked to the member who sent /auth, so an anonymous sender cannot link one (checked before the code is spent)
    const userId = String(msg.from?.id ?? "");
    if (where === "group" && (!userId || msg.sender_chat !== undefined)) return await answer("auth_group_sender");
    const { outcome, tokenId } = this.#decideSecret(secret, where);
    if (outcome === "linked") {
      this.#authFailures.delete(chatId);
      if (where === "private") {
        // Linked with a token: revoking that token unlinks this chat again
        this.state.authorize(chatId, undefined, tokenId);
        await this.#send(to, this.#tx("auth_ok"));
      } else {
        // Notifications go to the forum topic /auth was sent in (none: the group itself, or its General topic)
        this.state.authorize(chatId, { userId, threadId: to.topic }, tokenId);
        await this.#send(to, this.#tx("auth_group_ok"));
      }
      return;
    }
    // A private-chat secret in a group is refused as such (the console spent a private code), not counted as a guess
    if (outcome === "private-only") return await answer("auth_private_only");
    const now = this.#now();
    this.#authFailures.set(chatId, [...(this.#authFailures.get(chatId) ?? []), now]);
    this.#globalAuthFailures.push(now);
    await answer("auth_bad");
  }

  #decideSecret(secret: string, where: "private" | "group"): TelegramLinkDecision {
    if (this.#linkSecret) {
      const decided = this.#linkSecret(secret, where);
      return typeof decided === "string" ? { outcome: decided, tokenId: null } : decided;
    }
    if (!this.#authToken || !timingSafeEqualString(secret, this.#authToken)) return { outcome: "invalid", tokenId: null };
    return { outcome: where === "private" ? "linked" : "private-only", tokenId: null };
  }

  /** A one-time console password reset code, in a linked private chat only, at most 3 an hour. */
  async #cmdReset(to: ReplyTo, privateChat: boolean): Promise<void> {
    if (!privateChat) return await this.#reply(to, "reset_private_only");
    const issue = this.#issueResetCode;
    if (!issue) return await this.#reply(to, "reset_disabled");
    const now = this.#now();
    const recent = (this.#resetRequests.get(to.chatId) ?? []).filter((ts) => now - ts < 60 * 60_000);
    if (recent.length >= 3) return await this.#reply(to, "reset_limited");
    const code = issue();
    if (code === null) return await this.#reply(to, "reset_disabled");
    this.#resetRequests.set(to.chatId, [...recent, now]);
    this.#log("[telegram] issued a console password reset code to a linked chat");
    await this.#send(to, this.#tx("reset_code", { code }));
  }

  async #cmdStatus(to: ReplyTo): Promise<void> {
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
    await this.#send(to, lines.join("\n"), this.#newSmsKeyboard());
  }

  async #cmdAlerts(to: ReplyTo): Promise<void> {
    const recent = [...this.core.scheduler.getRecentAlerts()].slice(-10).reverse();
    if (recent.length === 0) return await this.#reply(to, "alerts_empty");
    const lines = [this.#tx("alerts_title"), ""];
    for (const a of recent) {
      lines.push(
        `${a.severity === "critical" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️"} <b>${escapeTelegramHtml(a.code)}</b> · <i>${escapeTelegramHtml(a.tsIso)}</i>`,
        escapeTelegramHtml(this.locale === "en" ? a.messageEn : a.messageZh)
      );
    }
    await this.#send(to, lines.join("\n"));
  }

  async #cmdMute(to: ReplyTo, rest: string): Promise<void> {
    const arg = rest.trim().toLowerCase();
    if (arg === "off") {
      this.state.setAlertsMutedUntil(null);
      return await this.#reply(to, "mute_off");
    }
    const match = arg.match(/^(\d{1,4})\s*([mhd])$/);
    if (!match?.[1] || !match[2]) return await this.#reply(to, "mute_usage");
    const unitMs = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
    const until = this.#now() + Math.min(MAX_MUTE_MS, Number(match[1]) * unitMs);
    this.state.setAlertsMutedUntil(until);
    await this.#send(to, this.#tx("mute_set", { until: new Date(until).toISOString() }));
  }

  // ----------------------------------------------------------------- cellular settings (each write behind a confirm card)

  /**
   * Say why the gate will not let this write through on this router (turned off in the console, or
   * nothing FengSui can do there), and resolve `true`; `false` when it may go ahead. A router whose
   * model is not known yet goes ahead: the write confirms the model in its own session.
   */
  async #refuseCellular(to: ReplyTo, feature: WriteFeature, what: TextKey): Promise<boolean> {
    const device = this.core.scheduler.device;
    const access = device.writeAccess(feature);
    if (!gateRefuses(access)) return false;
    const reason = access === "disabled" ? this.#plain("reason_disabled") : this.#plain("reason_unavailable", { model: device.snapshot().model ?? "?" });
    await this.#reply(to, "cell_refused", { what: this.#plain(what), reason });
    return true;
  }

  /** A write waiting for its confirm button: a one-time token, bound to the chat, valid for two minutes. */
  #holdOp(chatId: string, op: PendingCellularOpBody): string {
    const nowMs = this.#now();
    for (const [token, pending] of this.#pendingOps) if (pending.expiresAt <= nowMs) this.#pendingOps.delete(token);
    const token = crypto.randomBytes(8).toString("hex");
    this.#pendingOps.set(token, { ...op, chatId, expiresAt: nowMs + PENDING_OP_TTL_MS } as PendingCellularOp);
    return token;
  }

  /** Take a write's token (once): `null` when it expired, was used, or belongs to another chat. */
  #takeOp(chatId: string, token: string): PendingCellularOp | null {
    const pending = this.#pendingOps.get(token);
    this.#pendingOps.delete(token);
    return pending && pending.chatId === chatId && pending.expiresAt > this.#now() ? pending : null;
  }

  #modeName(mode: NetworkMode | null | undefined): string {
    return this.#plain(mode ? (`mode_${mode}` as TextKey) : "mode_unknown");
  }

  /** `/netmode`: the mode now and the router's other modes as buttons; the one picked asks for a confirmation. */
  async #cmdNetmode(to: ReplyTo): Promise<void> {
    if (await this.#refuseCellular(to, "networkMode", "netmode_title")) return;
    const cellular = await this.core.monitor.refreshCellular().catch(() => null);
    const modes = cellular?.networkMode;
    const options = (modes?.options ?? []).filter((mode) => mode !== modes?.current);
    if (!modes || options.length === 0) return await this.#reply(to, "netmode_unknown");
    const buttons = options.flatMap((mode) => {
      const data = callbackData("nm", mode);
      return data ? [{ text: this.#modeName(mode), callback_data: data }] : [];
    });
    const rows: InlineKeyboard["inline_keyboard"] = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    await this.#send(to, this.#tx("netmode_pick", { current: this.#modeName(modes.current) }), { inline_keyboard: rows });
  }

  /** `/airplane`: whether it is on now (from the last poll) and the switch the other way; both when the router does not say. */
  async #cmdAirplane(to: ReplyTo): Promise<void> {
    if (await this.#refuseCellular(to, "airplaneSwitch", "airplane_title")) return;
    const now = this.core.monitor.getCachedTelemetry()?.status?.airplaneMode;
    const state = now === true ? "airplane_on" : now === false ? "airplane_off" : "airplane_unknown";
    const row = [
      ...(now !== true ? [{ text: this.#tx("btn_airplane_on"), callback_data: "ap:1" }] : []),
      ...(now !== false ? [{ text: this.#tx("btn_airplane_off"), callback_data: "ap:0" }] : []),
    ];
    await this.#send(to, this.#tx("airplane_state", { state: this.#plain(state) }), { inline_keyboard: [row] });
  }

  /**
   * `/ussd <code>`, or a reply to an answer that awaits one: the code is checked (digits, `*` and `#`)
   * and asked to be confirmed. Neither it nor the operator's answer is logged anywhere.
   */
  async #cmdUssd(to: ReplyTo, code: string, kind: "send" | "reply"): Promise<void> {
    if (await this.#refuseCellular(to, "ussd", "ussd_title")) return;
    let request: UssdRequest;
    try {
      request = readUssdRequest({ action: kind, code: code.trim() });
    } catch {
      return await this.#reply(to, "ussd_usage");
    }
    if (request.kind === "cancel") return;
    const token = this.#holdOp(to.chatId, { kind: "ussd", request });
    await this.#send(to, this.#tx("ussd_confirm", { code: request.code }), {
      inline_keyboard: [[{ text: this.#tx("btn_ussd_send"), callback_data: `ussdok:${token}` }, { text: this.#tx("btn_cancel"), callback_data: `opno:${token}` }]],
    });
  }

  #ussdThreadOpen(chatId: string, messageId: number): boolean {
    const key = `${chatId}:${messageId}`;
    const until = this.#ussdThreads.get(key);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#ussdThreads.delete(key);
    return false;
  }

  /** The buttons of the cellular cards: a pick asks for a confirmation, a confirmation writes once. */
  async #cellularCallback(to: ReplyTo, action: string, arg: string, messageId: number | undefined, answer: (text?: string, alert?: boolean) => Promise<unknown>): Promise<void> {
    const chatId = to.chatId;
    const card = async (html: string, keyboard?: InlineKeyboard): Promise<void> => {
      if (messageId !== undefined) await this.#edit(chatId, messageId, html, keyboard);
      else await this.#send(to, html, keyboard);
    };
    if (action === "opno") {
      this.#pendingOps.delete(arg);
      await answer(this.#plain("btn_cancel"));
      return await card(this.#tx("wiz_cancelled"));
    }
    if (action === "nm" || action === "ap") {
      const op: PendingCellularOpBody | null = action === "nm" ? (isNetworkMode(arg) ? { kind: "netmode", mode: arg } : null) : arg === "1" || arg === "0" ? { kind: "airplane", enabled: arg === "1" } : null;
      if (!op) return void (await answer());
      await answer();
      const token = this.#holdOp(chatId, op);
      const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: this.#tx("btn_confirm"), callback_data: `${action}ok:${token}` }, { text: this.#tx("btn_cancel"), callback_data: `opno:${token}` }]] };
      if (op.kind === "netmode") return await card(this.#tx("netmode_confirm", { mode: this.#modeName(op.mode) }), keyboard);
      if (op.kind === "airplane") return await card(this.#tx(op.enabled ? "airplane_confirm_on" : "airplane_confirm_off"), keyboard);
      return;
    }
    if (action === "ussdend") {
      await answer();
      if (messageId !== undefined) this.#ussdThreads.delete(`${chatId}:${messageId}`);
      if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
      return await this.#runCellular(to, "ussd_title", async () => {
        await this.core.controls.sendUssd({ kind: "cancel" }, { confirm: true });
        await this.#reply(to, "ussd_ended");
      });
    }
    // A confirmation: its token, once
    const op = this.#takeOp(chatId, arg);
    const expected = action === "nmok" ? "netmode" : action === "apok" ? "airplane" : "ussd";
    if (!op || op.kind !== expected) {
      await answer(this.#plain("cell_expired"), true);
      if (messageId !== undefined) await this.#clearButtons(chatId, messageId);
      return;
    }
    await answer();
    await card(this.#tx("cell_working"));
    if (op.kind === "netmode") {
      return await this.#runCellular(to, "netmode_title", async () => {
        await this.core.controls.setNetworkMode(op.mode, { confirm: true });
        await card(this.#tx("netmode_done", { mode: this.#modeName(op.mode) }));
      }, card);
    }
    if (op.kind === "airplane") {
      return await this.#runCellular(to, "airplane_title", async () => {
        await this.core.controls.setAirplaneMode(op.enabled, { confirm: true });
        await card(this.#tx(op.enabled ? "airplane_done_on" : "airplane_done_off"));
      }, card);
    }
    return await this.#runCellular(to, "ussd_title", async () => {
      const reply = await this.core.controls.sendUssd(op.request, { confirm: true });
      if (reply.state === "cancelled") return await card(this.#tx("ussd_ended"));
      if (reply.state === "no_answer" || reply.text === null) return await card(this.#tx("ussd_no_answer"));
      const html = this.#tx("ussd_answer", { text: reply.text }) + (reply.awaitsReply ? this.#tx("ussd_awaits") : "");
      await card(html, reply.awaitsReply ? { inline_keyboard: [[{ text: this.#tx("btn_ussd_end"), callback_data: "ussdend:0" }]] } : undefined);
      if (reply.awaitsReply && messageId !== undefined) this.#ussdThreads.set(`${chatId}:${messageId}`, this.#now() + USSD_REPLY_TTL_MS);
    }, card);
  }

  /** Run one cellular write; what went wrong is said on the card (or in a message), never logged with its text. */
  async #runCellular(to: ReplyTo, what: TextKey, run: () => Promise<void>, card?: (html: string) => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      const html = this.#tx("cell_failed", { what: this.#plain(what), reason: this.#describeCellularError(err) });
      if (card) await card(html);
      else await this.#send(to, html);
    }
  }

  #describeCellularError(err: unknown): string {
    if (err instanceof DeviceWriteDisabledError) return this.#plain("reason_disabled");
    if (err instanceof DeviceReadOnlyError) return this.#plain("reason_unavailable", { model: err.model });
    return this.#describeError(err);
  }

  async #cmdInbox(to: ReplyTo, sms: SmsService, page: number): Promise<void> {
    const threads = sms.listThreads();
    if (threads.length === 0) return await this.#reply(to, "inbox_empty", undefined, this.#newSmsKeyboard());
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
    await this.#send(to, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async #cmdUnread(to: ReplyTo, sms: SmsService): Promise<void> {
    const threads = sms.listThreads({ filter: "unread" });
    if (threads.length === 0) return await this.#reply(to, "unread_empty");
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
    await this.#send(to, lines.join("\n"), { inline_keyboard: keyboard });
  }

  async #cmdChat(to: ReplyTo, sms: SmsService, key: string): Promise<void> {
    if (!key) return await this.#reply(to, "chat_usage");
    const thread = sms.getThread(key);
    if (thread.messages.length === 0) return await this.#reply(to, "chat_empty", { phone: key });
    const name = thread.contact?.name ?? thread.sender.e164 ?? thread.phone;
    const lines = [this.#tx("chat_title", { name, count: thread.messages.length }), ""];
    for (const m of thread.messages.slice(-10)) {
      const author = m.direction === "out" ? this.#tx("me") : escapeTelegramHtml(name);
      lines.push(
        `<b>${author}</b> <i>${escapeTelegramHtml(m.date)}</i>${m.isUnread ? " 🔵" : ""}`,
        `<blockquote>${escapeTelegramHtml(truncate(m.content, 400))}</blockquote>`
      );
    }
    // A reply only where this router can send
    const replyPhone = sms.abilities?.send === false ? null : thread.replyPhone;
    if (replyPhone) lines.push(this.#tx("reply_hint", { phone: replyPhone }));
    const unreadUid = thread.messages.find((m) => m.isUnread)?.uid;
    const readCb = unreadUid ? callbackData("read", unreadUid) : null;
    const sent = await this.#send(
      to,
      lines.join("\n"),
      readCb ? { inline_keyboard: [[{ text: this.#tx("btn_read"), callback_data: readCb }]] } : undefined
    );
    if (replyPhone && sent.message_id) this.state.bindReply(to.chatId, sent.message_id, replyPhone);
  }

  async #cmdSend(to: ReplyTo, rest: string): Promise<void> {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) return await this.#startWizard(to);
    const resolved = resolveRecipientPhone(match[1], this.defaultCountryCode);
    if (!resolved.ok) return await this.#reply(to, "error", { error: resolved.error });
    const wiz = this.#newWizard(to.chatId);
    wiz.phone = resolved.phone;
    await this.#showConfirm(to, wiz, match[2]);
  }

  async #cmdContacts(to: ReplyTo, sms: SmsService, query: string): Promise<void> {
    const list = sms.listContacts(query, 20);
    if (list.length === 0) return await this.#reply(to, "contacts_empty");
    const lines = [this.#tx("contacts_title", { shown: list.length, total: sms.contacts.size }), ""];
    for (const c of list) lines.push(`<b>${escapeTelegramHtml(c.name)}</b> · <code>${escapeTelegramHtml(c.phones.join(", "))}</code>`);
    await this.#send(to, lines.join("\n"));
  }

  async #cmdContact(to: ReplyTo, sms: SmsService, rest: string): Promise<void> {
    const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match?.[1] || !match[2]) return await this.#reply(to, "contact_usage");
    try {
      const saved = sms.upsertContact({ phone: match[1], name: match[2] });
      await this.#send(to, this.#tx("contact_saved", { name: saved.name, phone: saved.phones[0] ?? "" }));
    } catch (err) {
      await this.#send(to, this.#tx("error", { error: this.#describeError(err) }));
    }
  }

  async #cmdSync(to: ReplyTo, sms: SmsService): Promise<void> {
    try {
      const summary = await sms.sync("full", { priority: "normal" });
      await this.#send(
        to,
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
      await this.#send(to, this.#tx("error", { error: this.#describeError(err) }));
    }
  }

  async #importVcf(to: ReplyTo, doc: NonNullable<NonNullable<TelegramUpdate["message"]>["document"]>): Promise<void> {
    const sms = this.sms;
    const isVcf = /\.vcf$/i.test(doc.file_name ?? "") || /vcard/i.test(doc.mime_type ?? "");
    if (!sms || !isVcf) return;
    try {
      if ((doc.file_size ?? 0) > MAX_VCF_BYTES) throw new CpeControlValidationError(`vCard file exceeds ${MAX_VCF_BYTES} bytes`);
      const summary = sms.importVcard(await this.api.downloadFileText(doc.file_id, MAX_VCF_BYTES));
      await this.#send(to, this.#tx("vcf_imported", { ...summary }));
    } catch (err) {
      await this.#send(to, this.#tx("vcf_failed", { error: this.#describeError(err) }));
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

  async #startWizard(to: ReplyTo, countryCode?: string): Promise<void> {
    const wiz = this.#newWizard(to.chatId, countryCode);
    await this.#send(to, this.#wizardPhonePrompt(wiz), this.#countryKeyboard(wiz.countryCode));
  }

  #wizardPhonePrompt(wiz: WizardSession): string {
    const country = getCountryByDialCode(wiz.countryCode);
    const label = country ? `${country.flag} ${this.locale === "en" ? country.nameEn : country.nameZh} (${country.code})` : wiz.countryCode;
    return this.#tx("wiz_phone", { country: label });
  }

  #countryKeyboard(active: string): InlineKeyboard {
    // The country numbers are read in (the SIM's, or the one tapped) comes first when it is not a quick pick
    const codes = (QUICK_COUNTRIES as ReadonlyArray<string>).includes(active) || !getCountryByDialCode(active) ? QUICK_COUNTRIES : [active, ...QUICK_COUNTRIES];
    const buttons = codes.map((code) => {
      const c = getCountryByDialCode(code);
      return { text: `${c?.flag ?? ""} ${code}${code === active ? " ✓" : ""}`, callback_data: `wizcc:${code}` };
    });
    return {
      inline_keyboard: [buttons.slice(0, 3), buttons.slice(3), [{ text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" }]],
    };
  }

  async #handleWizardInput(to: ReplyTo, text: string): Promise<void> {
    const wiz = this.#wizard(to.chatId);
    if (!wiz) return;
    if (wiz.step === "phone") {
      if (/[A-Za-z一-龥]/.test(text) && this.sms) {
        const matches = this.sms.listContacts(text, 8);
        const options = matches.flatMap((c) => c.phones.slice(0, 2).map((phone) => ({ name: c.name, phone })));
        if (options.length === 0) {
          await this.#send(to, this.#tx("wiz_no_contact", { query: text }), this.#countryKeyboard(wiz.countryCode));
          return;
        }
        if (options.length === 1 && options[0]) return await this.#advanceToContent(to, options[0].phone);
        const rows = options.flatMap((o) => {
          const cb = callbackData("wizpick", o.phone);
          return cb ? [[{ text: truncate(`${o.name} · ${o.phone}`, 40), callback_data: cb }]] : [];
        });
        rows.push([{ text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" }]);
        await this.#send(to, this.#tx("wiz_pick"), { inline_keyboard: rows.slice(0, 10) });
        return;
      }
      // A wizard opened before the SIM's country was known takes it once it is (and never guesses before)
      wiz.countryCode ||= this.defaultCountryCode;
      const resolved = resolveRecipientPhone(text, wiz.countryCode);
      if (!resolved.ok) {
        await this.#send(to, this.#tx("error", { error: resolved.error }), this.#countryKeyboard(wiz.countryCode));
        return;
      }
      return await this.#advanceToContent(to, resolved.phone);
    }
    if (wiz.step === "content") return await this.#showConfirm(to, wiz, text);
    await this.#send(to, this.#tx("wiz_tap_confirm"));
  }

  async #advanceToContent(to: ReplyTo, phone: string): Promise<void> {
    const wiz = this.#wizard(to.chatId) ?? this.#newWizard(to.chatId);
    wiz.phone = phone;
    wiz.step = "content";
    await this.#send(to, this.#tx("wiz_content", { recipient: this.#recipientLabel(phone) }), {
      inline_keyboard: [
        [
          { text: this.#tx("btn_change_phone"), callback_data: "wizback:phone" },
          { text: this.#tx("btn_cancel"), callback_data: "wizcancel:1" },
        ],
      ],
    });
  }

  async #showConfirm(to: ReplyTo, wiz: WizardSession, content: string): Promise<void> {
    const mode = detectSmsTextMode(content);
    if (mode.segments > MAX_SMS_SEGMENTS) {
      wiz.step = "content";
      await this.#send(to, this.#tx("wiz_too_long", { segments: mode.segments, max: MAX_SMS_SEGMENTS }));
      return;
    }
    wiz.step = "confirm";
    wiz.content = content;
    wiz.confirmToken = crypto.randomBytes(4).toString("hex");
    await this.#send(
      to,
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

  async #executeSend(to: ReplyTo, phone: string, content: string, editMessageId?: number): Promise<void> {
    const sms = this.sms;
    if (!sms) return await this.#reply(to, "sms_disabled");
    if (await this.#refuseReadOnly(to)) return;
    const recipient = this.#recipientLabel(phone);
    let statusMessageId = editMessageId;
    if (statusMessageId !== undefined) {
      await this.#edit(to.chatId, statusMessageId, this.#tx("sending", { recipient }));
    } else {
      statusMessageId = (await this.#send(to, this.#tx("sending", { recipient }))).message_id;
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
      await this.#edit(to.chatId, statusMessageId, text);
      this.state.bindReply(to.chatId, statusMessageId, phone);
    } else {
      await this.#send(to, text);
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

  /**
   * The router's model when SMS writes are closed there (a model nobody verified that FengSui has no
   * SMS write for, or whose owner turned SMS writes off), else `null`.
   */
  #readOnlyModel(): string | null {
    const device = this.core.scheduler.device;
    return gateRefuses(device.writeAccess("smsWrite")) ? (device.snapshot().model ?? "?") : null;
  }

  /** Explain instead of writing when the gate refuses SMS writes on this router; `true` when it does. */
  async #refuseReadOnly(to: ReplyTo): Promise<boolean> {
    const model = this.#readOnlyModel();
    if (model === null) return false;
    this.#wizards.delete(to.chatId);
    await this.#reply(to, "read_only", { model });
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
    // Any Telegram user can send /auth: keep only chats with a failure inside the window (at most the global budget)
    for (const [chat, stamps] of this.#authFailures) {
      const fresh = stamps.filter((ts) => ts > cutoff);
      if (fresh.length === 0) this.#authFailures.delete(chat);
      else this.#authFailures.set(chat, fresh);
    }
    const mine = this.#authFailures.get(chatId)?.length ?? 0;
    return mine >= AUTH_MAX_FAILURES_PER_CHAT || this.#globalAuthFailures.length >= AUTH_MAX_FAILURES_GLOBAL;
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

  async #reply(to: ReplyTo, key: TextKey, params?: Readonly<Record<string, string | number>>, keyboard?: InlineKeyboard): Promise<void> {
    await this.#send(to, this.#tx(key, params), keyboard);
  }

  /**
   * A group linked with a group code gets everything in the topic it was linked from; anywhere else
   * an answer goes to the topic of what it answers (`to.topic`), and a notification to none.
   */
  async #send(to: ReplyTo, html: string, keyboard?: InlineKeyboard): Promise<{ message_id?: number }> {
    const link = this.state.groupLink(to.chatId);
    const threadId = link ? link.threadId : to.topic;
    const call = (thread: number | null): Promise<{ message_id?: number }> =>
      this.api.call<{ message_id?: number }>("sendMessage", {
        chat_id: to.chatId,
        ...(thread !== null ? { message_thread_id: thread } : {}),
        text: truncateTelegramHtml(html, MAX_TELEGRAM_TEXT),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    try {
      return await call(threadId);
    } catch (err) {
      // The forum topic was deleted or closed since: the group's General topic rather than nowhere
      if (threadId === null || !isGoneTopicError(err)) throw err;
      const sent = await call(null);
      if (link) this.#leaveGoneTopic(to.chatId, threadId);
      return sent;
    }
  }

  /** A group linked from a topic that is gone posts to its General topic from now on, and says so there once. */
  #leaveGoneTopic(chatId: string, threadId: number): void {
    if (!this.state.setGroupTopic(chatId, threadId, null)) return;
    this.#log("[telegram] the forum topic a linked group posts to was deleted or closed; posting to its General topic now");
    void this.#send({ chatId, topic: null }, this.#tx("topic_gone")).catch(() => undefined);
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

