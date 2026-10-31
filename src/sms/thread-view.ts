import { canonicalThreadKey, extractBrandSignature, parseSenderInfo } from "./phone.ts";
import type {
  ContactBrief,
  EnrichedSmsMessage,
  SmsMessageRecord,
  SmsThreadDetail,
  SmsThreadFilter,
  SmsThreadSummary,
} from "./types.ts";

/**
 * Conversation views over a set of stored messages: enrichment, the thread list with its filters
 * and search, one thread, and totals. Shared by the daemon's SMS mirror and the browser demo, so it
 * has zero runtime dependencies beyond `phone.ts` (no Node built-in).
 */

export const MAX_SEARCH_QUERY = 100;

export interface ThreadViewContext {
  defaultCountryCode: string;
  /** Contact book lookup by any spelling of a number. */
  contactOf: (phone: string) => ContactBrief | null;
}

export function newestFirst(a: SmsMessageRecord, b: SmsMessageRecord): number {
  return a.date === b.date ? b.index - a.index : a.date > b.date ? -1 : 1;
}

export function enrichSmsMessage(record: SmsMessageRecord, ctx: ThreadViewContext): EnrichedSmsMessage {
  return {
    ...record,
    threadKey: canonicalThreadKey(record.phone, ctx.defaultCountryCode),
    sender: parseSenderInfo(record.phone, record.content, ctx.defaultCountryCode),
    contact: ctx.contactOf(record.phone),
  };
}

/**
 * Conversation list (newest activity first) with unread / OTP filters and search over names,
 * numbers, country, bodies and OTP codes.
 */
export function listSmsThreads(
  messages: Iterable<SmsMessageRecord>,
  ctx: ThreadViewContext,
  opts: { filter?: SmsThreadFilter; search?: string; limit?: number } = {}
): SmsThreadSummary[] {
  const q = (opts.search ?? "").trim().toLowerCase().slice(0, MAX_SEARCH_QUERY);
  const threads = new Map<string, SmsThreadSummary>();
  for (const msg of [...messages].sort(newestFirst)) {
    const key = canonicalThreadKey(msg.phone, ctx.defaultCountryCode);
    let thread = threads.get(key);
    if (!thread) {
      const sender = parseSenderInfo(msg.phone, msg.content, ctx.defaultCountryCode);
      const contact = ctx.contactOf(msg.phone);
      thread = {
        threadKey: key,
        phone: msg.phone,
        replyPhone: sender.dialable ? (sender.e164 ?? msg.phone) : null,
        dialable: sender.dialable,
        sender,
        contact,
        displayName:
          contact?.name ??
          (sender.type === "alphanumeric"
            ? msg.phone
            : sender.brandHint
              ? `${msg.phone} (${sender.brandHint})`
              : (sender.e164 ?? msg.phone)),
        unreadCount: 0,
        totalCount: 0,
        hasOtp: false,
        latestOtp: null,
        latestMessage: { ...msg },
      };
      threads.set(key, thread);
    } else if (!thread.sender.brandHint && !thread.contact) {
      const hint = extractBrandSignature(msg.content);
      if (hint) {
        thread.sender = { ...thread.sender, brandHint: hint };
        if (thread.sender.type !== "alphanumeric") thread.displayName = `${thread.phone} (${hint})`;
      }
    }
    thread.totalCount += 1;
    if (msg.isUnread) thread.unreadCount += 1;
    if (msg.verificationCode) {
      thread.hasOtp = true;
      thread.latestOtp ??= msg.verificationCode;
    }
    if (q && thread.matchedPreview === undefined) {
      if (msg.content.toLowerCase().includes(q) || Boolean(msg.verificationCode?.includes(q))) {
        thread.matchedPreview = msg.content;
      }
    }
  }

  let list = [...threads.values()];
  if (opts.filter === "unread") list = list.filter((t) => t.unreadCount > 0);
  else if (opts.filter === "otp") list = list.filter((t) => t.hasOtp);
  if (q) {
    list = list.filter(
      (t) =>
        t.displayName.toLowerCase().includes(q) ||
        t.phone.toLowerCase().includes(q) ||
        Boolean(t.sender.e164?.toLowerCase().includes(q)) ||
        t.sender.countryZh.toLowerCase().includes(q) ||
        t.sender.countryEn.toLowerCase().includes(q) ||
        t.matchedPreview !== undefined
    );
  }
  return opts.limit !== undefined ? list.slice(0, Math.max(1, opts.limit)) : list;
}

/** Thread key of a key (`+353…`, `alpha:<brand>`, `unknown`) or any spelling of a phone number. */
export function threadKeyOf(keyOrPhone: string, defaultCountryCode: string): string {
  return keyOrPhone.startsWith("alpha:") || keyOrPhone === "unknown" ? keyOrPhone : canonicalThreadKey(keyOrPhone, defaultCountryCode);
}

/** Full conversation (oldest first) for a thread key or any phone spelling. */
export function getSmsThread(messages: Iterable<SmsMessageRecord>, ctx: ThreadViewContext, keyOrPhone: string): SmsThreadDetail {
  const key = threadKeyOf(keyOrPhone, ctx.defaultCountryCode);
  const thread = [...messages]
    .filter((m) => canonicalThreadKey(m.phone, ctx.defaultCountryCode) === key)
    .sort((a, b) => newestFirst(b, a))
    .map((m) => enrichSmsMessage(m, ctx));
  const phone = thread[thread.length - 1]?.phone ?? keyOrPhone.replace(/^alpha:/, "");
  const brandSample = [...thread].reverse().find((m) => m.sender.brandHint)?.content ?? "";
  const sender = parseSenderInfo(phone, brandSample, ctx.defaultCountryCode);
  return {
    threadKey: key,
    phone,
    replyPhone: sender.dialable ? (sender.e164 ?? phone) : null,
    dialable: sender.dialable,
    sender,
    contact: ctx.contactOf(phone),
    messages: thread,
  };
}

export function smsThreadStats(
  messages: Iterable<SmsMessageRecord>,
  defaultCountryCode: string
): { messagesTotal: number; unreadTotal: number; threadsTotal: number } {
  const keys = new Set<string>();
  let total = 0;
  let unread = 0;
  for (const m of messages) {
    total += 1;
    keys.add(canonicalThreadKey(m.phone, defaultCountryCode));
    if (m.isUnread) unread += 1;
  }
  return { messagesTotal: total, unreadTotal: unread, threadsTotal: keys.size };
}
