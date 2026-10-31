import type { SmsSendResult } from "../../../src/api-contract.ts";
import type { ApiError } from "./api.ts";
import type { Locale } from "./i18n.ts";

/**
 * SMS presentation helpers (dates, grouping, avatars, links) carried over from cpe-sms, plus the
 * send-outcome classification that keeps an accepted-but-unconfirmed send from looking like a
 * failure the user should retry (that would deliver the message twice).
 */

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function splitDate(datePart: string): [number, number, number] | null {
  const parts = datePart.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return [y, m, d];
}

/** Whole days between `now` and a router-local `yyyy-MM-dd` (0 = today). */
export function daysAgo(datePart: string, now: Date = new Date()): number {
  const ymd = splitDate(datePart);
  if (!ymd) return Number.POSITIVE_INFINITY;
  const then = new Date(ymd[0], ymd[1] - 1, ymd[2]).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((today - then) / 86_400_000);
}

/** Router `yyyy-MM-dd HH:mm:ss` (local) → epoch ms; 0 when malformed. */
export function parseMsgTime(dateStr: string): number {
  const [d, t] = dateStr.split(" ");
  const ymd = splitDate(d ?? "");
  if (!ymd) return 0;
  const [hh = 0, mm = 0, ss = 0] = (t ?? "").split(":").map(Number);
  return new Date(ymd[0], ymd[1] - 1, ymd[2], hh, mm, ss).getTime();
}

/** Thread-list timestamp: `14:05`, `昨天`/`Yesterday`, weekday, or date. */
export function formatShortTime(dateStr: string, locale: Locale, now: Date = new Date()): string {
  const [d, t] = dateStr.split(" ");
  if (!d || !t) return dateStr;
  const en = locale === "en";
  const diff = daysAgo(d, now);
  if (diff === 0) return t.slice(0, 5);
  if (diff === 1) return en ? "Yesterday" : "昨天";
  const ymd = splitDate(d);
  if (!ymd) return dateStr;
  const [y, m, day] = ymd;
  if (diff > 1 && diff < 7) {
    const idx = new Date(y, m - 1, day).getDay();
    return (en ? WEEKDAYS_EN[idx] : WEEKDAYS_ZH[idx]) ?? d;
  }
  const sameYear = y === now.getFullYear();
  if (en) return sameYear ? `${MONTHS_EN[m - 1]} ${day}` : `${MONTHS_EN[m - 1]} ${day}, ${y}`;
  return sameYear ? `${m}月${day}日` : `${y}/${m}/${day}`;
}

/** Day separator inside a conversation. */
export function formatDayLabel(datePart: string, locale: Locale, now: Date = new Date()): string {
  const en = locale === "en";
  const diff = daysAgo(datePart, now);
  if (diff === 0) return en ? "Today" : "今天";
  if (diff === 1) return en ? "Yesterday" : "昨天";
  const ymd = splitDate(datePart);
  if (!ymd) return datePart;
  const [y, m, d] = ymd;
  const idx = new Date(y, m - 1, d).getDay();
  const sameYear = y === now.getFullYear();
  if (en) return sameYear ? `${MONTHS_EN[m - 1]} ${d}, ${WEEKDAYS_EN[idx]}` : `${MONTHS_EN[m - 1]} ${d}, ${y}`;
  return sameYear ? `${m}月${d}日 ${WEEKDAYS_ZH[idx]}` : `${y}年${m}月${d}日`;
}

export type ThreadGroup = "today" | "yesterday" | "week" | "month" | "earlier";

export function threadGroup(dateStr: string, now: Date = new Date()): ThreadGroup {
  const diff = daysAgo(dateStr.split(" ")[0] ?? "", now);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return "week";
  if (diff < 31) return "month";
  return "earlier";
}

/** Avatar initials: a CJK name's first character, otherwise up to two Latin initials. */
export function initialsOf(name: string): string {
  const clean = name.trim().replace(/^[^\p{L}\p{N}]+/u, "");
  const first = clean[0];
  if (!first) return "?";
  if (/[㐀-鿿]/.test(first)) return first;
  const words = clean.split(/[\s_-]+/).filter(Boolean);
  const a = words[0]?.[0];
  const b = words[1]?.[0];
  const letters = a && b && /\p{L}/u.test(a) && /\p{L}/u.test(b) ? `${a}${b}` : clean.replace(/\s+/g, "").slice(0, 2);
  return letters.toUpperCase();
}

export interface TextSegment {
  text: string;
  /** Set for an `http(s)` link; the DOM layer renders it as an anchor with a text node, never HTML. */
  href?: string;
}

/** Split untrusted message text into plain and link segments (linear scan; no markup is produced). */
export function linkifySegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const re = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    let url = match[0];
    // Trailing punctuation belongs to the sentence, not the URL
    const trimmed = url.replace(/[.,;:!?)\]}，。；：！？）】]+$/u, "");
    url = trimmed || url;
    if (start > cursor) segments.push({ text: text.slice(cursor, start) });
    segments.push({ text: url, href: url });
    cursor = start + url.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments;
}

/** Letters without a run of 3+ digits: a contact-name search rather than a phone number. */
export function isLikelyContactNameQuery(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return /\p{L}/u.test(trimmed) && !/\d{3,}/.test(trimmed);
}

/**
 * - `sent`: the router confirmed delivery to every recipient.
 * - `partial`: some recipients failed.
 * - `unconfirmed`: the router accepted the message but its status never came back; it is very likely
 *   on its way, so the UI must warn against resending (contract §6.5).
 * - `failed`: the router reported a send failure; retrying is safe.
 */
export type SendResultKind = "sent" | "partial" | "unconfirmed" | "failed";

export function classifySendResult(result: SmsSendResult): SendResultKind {
  if (!result.ok) return "failed";
  if (result.timedOutWaitingStatus) return "unconfirmed";
  if (result.failedPhones.length > 0) return result.sentPhones.length > 0 ? "partial" : "failed";
  return "sent";
}

/**
 * Why a send request failed:
 * - `failed`: `502 SMS_SEND_FAILED`, the router itself reported the failure;
 * - `not_sent`: refused before reaching the router (validation, human admin online, breaker, queue);
 * - `unknown`: transport failure after the request left the browser — it may have been submitted,
 *   so the user should check the outbox (next sync) before sending again.
 */
export type SendErrorKind = "failed" | "not_sent" | "unknown";

export function classifySendError(error: Pick<ApiError, "kind">): SendErrorKind {
  switch (error.kind) {
    case "sms_send_failed":
      return "failed";
    case "validation":
    case "yielded":
    case "peer_standby":
    case "breaker":
    case "unavailable":
    case "unauthorized":
    case "csrf":
    case "rate_limited":
    case "sms_disabled":
    case "not_found":
      return "not_sent";
    default:
      return "unknown";
  }
}
