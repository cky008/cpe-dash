import type { WriteCheck } from "../device-access.ts";
import type { SmsSegment } from "../protocols/at/sms.ts";
import type { SmsCounters, SmsWireMessage } from "../sms/types.ts";
import { stripInvalidControlChars } from "../text-sanitize.ts";
import type { DriverSmsSendOutcome } from "./types.ts";

/**
 * What the drivers share for SMS: the text and time formats more than one family uses, joining the
 * parts of a long message, counting a listing, and how an SMS write is read back. Nothing here knows
 * a router: each driver names its own requests.
 */

/** `smstat` as the HiLink stack writes it, which the mirror reads: unread, read, sent. */
export const SMSTAT_UNREAD = "0";
export const SMSTAT_READ = "1";
export const SMSTAT_SENT = "3";

/** The longest text kept of one message (a long message of the most parts the standard allows fits). */
const MAX_CONTENT_CHARS = 40_000;

/** A stored message in the shape every driver hands back; what the router sent is text, bounded and free of control characters. */
export function wireMessage(message: { index: number; phone: string; content: string; date: string; unread: boolean; outgoing: boolean }): SmsWireMessage {
  const unread = message.unread && !message.outgoing;
  return {
    index: message.index,
    phone: stripInvalidControlChars(message.phone.slice(0, 64)).trim(),
    content: stripInvalidControlChars(message.content.slice(0, MAX_CONTENT_CHARS)),
    date: message.date,
    smstat: message.outgoing ? SMSTAT_SENT : unread ? SMSTAT_UNREAD : SMSTAT_READ,
    isUnread: unread,
    direction: message.outgoing ? "out" : "in",
  };
}

/** Text as UTF-16 code units, four uppercase hexadecimal digits each (ZTE's message bodies). */
export function ucs2Hex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  return out;
}

const HEX_UNITS = /^(?:[0-9A-Fa-f]{4})+$/;

/** The reverse; NUL padding and tabs are dropped, as the router's own page drops them. `null`: not such text. */
export function textOfUcs2Hex(hex: string): string | null {
  if (hex === "") return "";
  if (!HEX_UNITS.test(hex)) return null;
  let out = "";
  for (let i = 0; i < hex.length; i += 4) {
    const unit = Number.parseInt(hex.slice(i, i + 4), 16);
    if (unit !== 0x0000 && unit !== 0x0009) out += String.fromCharCode(unit);
  }
  return out;
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * A time as parts (`yy`, `MM`, `dd`, `HH`, `mm`, `ss`, in that order, each number-like) in the form
 * the mirror keeps: `yyyy-MM-dd HH:mm:ss`. `""` when the parts are not a date.
 */
export function dateOfParts(parts: ReadonlyArray<string>): string {
  const n = parts.slice(0, 6).map((part) => (/^\d{1,4}$/.test(part.trim()) ? Number.parseInt(part.trim(), 10) : Number.NaN));
  const [year, month, day, hour, minute, second] = n;
  if (n.length < 6 || n.some((value) => Number.isNaN(value))) return "";
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined) return "";
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return "";
  return `${year < 100 ? 2000 + year : year}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:${two(second)}`;
}

/** Storage handles as they may be written: whole, above zero, each once. */
export function storedIndices(indices: ReadonlyArray<number>): number[] {
  return [...new Set(indices.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

export interface AssembledSms {
  message: SmsWireMessage;
  /** The handles of every stored part, lowest first (the message's own). */
  parts: number[];
}

/**
 * Join the parts of long messages: parts of one sender with one reference and one total, in
 * sequence order. The message takes the handle and the time of its lowest-numbered stored part, and
 * is unread while any part is. Parts that have not arrived are left out of the text (what is there
 * is shown, and completes when they come).
 */
export function assembleSegments(segments: ReadonlyArray<SmsSegment>): AssembledSms[] {
  const groups = new Map<string, SmsSegment[]>();
  const out: AssembledSms[] = [];
  for (const segment of segments) {
    if (!segment.concat) {
      out.push({ message: wireMessage({ ...segment, content: segment.text }), parts: [segment.index] });
      continue;
    }
    const key = `${segment.outgoing ? "o" : "i"}\u0000${segment.phone}\u0000${segment.concat.reference}\u0000${segment.concat.total}`;
    const group = groups.get(key);
    if (group) group.push(segment);
    else groups.set(key, [segment]);
  }
  for (const group of groups.values()) {
    const stored = [...group].sort((a, b) => a.index - b.index);
    // A part stored twice (a network resend) counts once, the lower handle
    const bySequence = new Map<number, SmsSegment>();
    for (const segment of stored) {
      const sequence = segment.concat?.sequence ?? 0;
      if (!bySequence.has(sequence)) bySequence.set(sequence, segment);
    }
    const ordered = [...bySequence.entries()].sort((a, b) => a[0] - b[0]).map(([, segment]) => segment);
    const first = stored[0];
    if (!first) continue;
    out.push({
      message: wireMessage({
        index: first.index,
        phone: first.phone,
        date: first.date,
        unread: group.some((segment) => segment.unread),
        outgoing: first.outgoing,
        content: ordered.map((segment) => segment.text).join(""),
      }),
      parts: stored.map((segment) => segment.index),
    });
  }
  return out.sort((a, b) => a.message.index - b.message.index);
}

/** The counts of a listing, for a family whose interface has no count of its own. */
export function countListed(messages: ReadonlyArray<SmsWireMessage>, max: number, opts: { unread: boolean }): SmsCounters {
  const inbox = messages.filter((m) => m.direction === "in");
  return {
    // A family whose router keeps no usable read state reports none: FengSui's own count is the one shown
    localUnread: opts.unread ? inbox.filter((m) => m.isUnread).length : 0,
    localInbox: inbox.length,
    localOutbox: messages.length - inbox.length,
    localDraft: 0,
    localMax: max,
  };
}

/**
 * A send read back: what the router said of each recipient. Every one sent is a match, any failed a
 * mismatch, otherwise the router has not said.
 */
export function settleSmsSend(check: WriteCheck, outcomes: ReadonlyArray<DriverSmsSendOutcome>): void {
  if (outcomes.some((o) => o.state === "failed")) {
    check.readback = "mismatch";
    check.reason = "send_failed";
  } else if (outcomes.length === 0 || outcomes.some((o) => o.state === "unconfirmed")) {
    check.readback = "unknown";
    check.reason = "send_unconfirmed";
  } else {
    check.readback = "match";
    check.reason = null;
  }
}

/**
 * A change of `expected` messages read back from a count taken before and after: exactly that many
 * is a match, none a mismatch, anything else (or a count the router did not give) unknown.
 */
export function settleSmsCount(check: WriteCheck, before: number | null, after: number | null, expected: number): void {
  if (before === null || after === null) {
    check.readback = "unknown";
    check.reason = "unreadable";
    return;
  }
  const moved = before - after;
  if (moved === expected) {
    check.readback = "match";
    check.reason = null;
  } else {
    check.readback = moved === 0 ? "mismatch" : "unknown";
    check.reason = moved === 0 ? "no_change" : "unclear_change";
  }
}

/** A listing after a write, read back: the messages it named are gone (`gone`) or no longer unread. */
export function settleSmsListing(check: WriteCheck, after: ReadonlyArray<SmsWireMessage> | null, indices: ReadonlyArray<number>, want: "gone" | "read"): void {
  if (after === null) {
    check.readback = "unknown";
    check.reason = "unreadable";
    return;
  }
  const left = indices.filter((index) => after.some((m) => m.index === index && (want === "gone" || m.isUnread))).length;
  if (left === 0) {
    check.readback = "match";
    check.reason = null;
  } else {
    check.readback = left === indices.length ? "mismatch" : "unknown";
    check.reason = left === indices.length ? "no_change" : "unclear_change";
  }
}
