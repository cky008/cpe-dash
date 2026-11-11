import type { WriteCheck } from "../device-access.ts";
import type { SmsConcatenation } from "../sms/pdu.ts";
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

/** ZTE's message time, `yy,MM,dd,HH,mm,ss,±zone` (commas or semicolons), as the mirror keeps it. */
export function zteSmsDate(raw: string): string {
  return dateOfParts(raw.split(/[,;]/));
}

/** The time a ZTE send carries: `yy;MM;dd;HH;mm;ss;±h`, local time and its offset in hours, as the router's page writes it. */
export function zteSmsTime(now: Date): string {
  const offsetHours = Math.trunc(-now.getTimezoneOffset() / 60);
  const zone = offsetHours > 0 ? `+${offsetHours}` : String(offsetHours);
  return [two(now.getFullYear() % 100), two(now.getMonth() + 1), two(now.getDate()), two(now.getHours()), two(now.getMinutes()), two(now.getSeconds()), zone].join(";");
}

/** ZTE's ids joined the way its page joins them: each followed by `;`. */
export function zteIdList(indices: ReadonlyArray<number>): string {
  return storedIndices(indices)
    .map((id) => `${id};`)
    .join("");
}

/** Storage handles as they may be written: whole, above zero, each once. */
export function storedIndices(indices: ReadonlyArray<number>): number[] {
  return [...new Set(indices.filter((n) => Number.isSafeInteger(n) && n > 0))];
}

/** One stored part of a message, as a listing of raw segments gives it. */
export interface SmsSegment {
  /** The handle of this part (above zero). */
  index: number;
  phone: string;
  date: string;
  unread: boolean;
  outgoing: boolean;
  text: string;
  concat: SmsConcatenation | null;
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

// --------------------------------------------------------------------------
// ZTE: the goform pages and the zWRT ubus object name the same store the same way
// --------------------------------------------------------------------------

/** ZTE's tags: `0` read, `1` unread, `2` sent, `3` not sent, `4` draft. */
const ZTE_TAG_UNREAD = "1";
const ZTE_TAG_SENT = "2";

function plainText(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/**
 * The rows of a ZTE listing (`messages`: `id`, `number`, `content`, `tag`, `date`) as stored
 * messages. `field` turns a number or a body as the router sent it into plain text (`null`: not
 * readable, the row is left out); bodies are UTF-16 hexadecimal underneath. Drafts and sends that
 * never went out are not messages; a long message is one row, joined by the router.
 */
export function parseZteSmsRows(rows: unknown, field: (raw: string, kind: "number" | "content") => string | null = (raw) => raw): SmsWireMessage[] {
  if (!Array.isArray(rows)) return [];
  const out: SmsWireMessage[] = [];
  for (const row of rows.slice(0, 2000)) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const id = Number.parseInt(plainText(record["id"]) ?? "", 10);
    const tag = plainText(record["tag"]) ?? "0";
    if (!Number.isSafeInteger(id) || id <= 0 || tag === "3" || tag === "4") continue;
    const number = field(plainText(record["number"]) ?? "", "number");
    const body = field(plainText(record["content"]) ?? "", "content");
    if (number === null || body === null) continue;
    out.push(
      wireMessage({
        index: id,
        phone: number.trim(),
        // A body that is not hexadecimal text is shown as the router sent it
        content: textOfUcs2Hex(body) ?? body,
        date: zteSmsDate(plainText(record["date"]) ?? ""),
        unread: tag === ZTE_TAG_UNREAD,
        outgoing: tag === ZTE_TAG_SENT,
      })
    );
  }
  return out;
}

function count(value: unknown): number | null {
  const text = plainText(value);
  if (text === null || !/^\d{1,6}$/.test(text.trim())) return null;
  return Number.parseInt(text.trim(), 10);
}

/**
 * The counts of the router's own store from ZTE's capacity fields (`sms_nv_*`: received, sent,
 * drafts, capacity) and its unread count. `null`: the answer names no store, so this firmware has no SMS.
 */
export function zteSmsCounters(capacity: Record<string, unknown>, unread: unknown): SmsCounters | null {
  const max = count(capacity["sms_nv_total"]);
  const inbox = count(capacity["sms_nv_rev_total"]);
  if (max === null || inbox === null) return null;
  return {
    localUnread: Math.min(inbox, count(unread) ?? count(capacity["sms_dev_unread_num"]) ?? 0),
    localInbox: inbox,
    localOutbox: count(capacity["sms_nv_send_total"]) ?? 0,
    localDraft: count(capacity["sms_nv_draftbox_total"]) ?? 0,
    localMax: max > 0 ? max : 100,
  };
}

/**
 * What ZTE's send and delete report through their status slot: `3` done, `2` failed, anything else
 * (an empty slot included) still under way.
 */
export function zteCommandStatus(answer: Record<string, unknown>): "done" | "failed" | "pending" {
  const result = plainText(answer["sms_cmd_status_result"]);
  return result === "3" ? "done" : result === "2" ? "failed" : "pending";
}

/** ZTE's status slots. */
export const ZTE_SMS_CMD_SEND = 4;
export const ZTE_SMS_CMD_DELETE = 6;

/**
 * Ask a status slot every `intervalMs` (a second, as the router's page does) until it says done or
 * failed, or `timeoutMs` passed. A read that fails ends the wait as undecided: the command was taken,
 * and is never sent again.
 */
export async function awaitZteCommand(
  read: () => Promise<Record<string, unknown>>,
  opts: { timeoutMs: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }
): Promise<"done" | "failed" | "pending"> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = Math.max(1, opts.intervalMs ?? 1000);
  const startedAt = now();
  const polls = Math.max(1, Math.ceil(opts.timeoutMs / intervalMs));
  for (let attempt = 0; attempt < polls && now() - startedAt < opts.timeoutMs; attempt++) {
    try {
      await sleep(intervalMs);
      const status = zteCommandStatus(await read());
      if (status !== "pending") return status;
    } catch {
      return "pending";
    }
  }
  return "pending";
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
