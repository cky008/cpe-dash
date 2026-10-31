import { getXmlTag, getXmlTextPreserve } from "../xml.ts";
import type { SmsCounters, SmsWireMessage } from "./types.ts";

export {
  MAX_SMS_SEGMENTS,
  SMS_TEXT_MODE_7BIT,
  SMS_TEXT_MODE_UCS2,
  detectSmsTextMode,
} from "./text-mode.ts";

/** OTP extraction only scans the head of a message so hostile sender text cannot burn CPU (ReDoS guard). */
const OTP_SCAN_LIMIT = 2048;

const OTP_CONTEXT_RE =
  /(验证码|校验码|动态码|确认码|随机码|认证码|登录码|提取码|verification|verify|passcode|security\s*code|auth(?:entication)?\s*code|one[-\s]*time|\botp\b|\bpin\b|\bcode\b)/i;

const OTP_DIRECT_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:验证码|校验码|动态码|确认码|随机码|认证码|登录码|passcode|otp|code)\s*(?:为|是|[:：]|is)?\s*([0-9]{4,8})(?![0-9])/i,
  /\b([0-9]{4,8})\s*(?:is your|为您的|是您的|为本次)/i,
];

/**
 * Extract a likely 4–8 digit one-time code for one-tap copying. Requires an OTP context word,
 * skips URLs, dates and clock times, and only scans the first 2 KiB of untrusted sender text.
 */
export function extractVerificationCode(content: string): string | null {
  if (!content) return null;
  const head = content.slice(0, OTP_SCAN_LIMIT);
  if (!OTP_CONTEXT_RE.test(head)) return null;

  for (const re of OTP_DIRECT_PATTERNS) {
    const match = head.match(re);
    if (match?.[1]) return match[1];
  }

  const sanitized = head
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b20[2-3][0-9][-/.][01]?[0-9][-/.][0-3]?[0-9]\b/g, " ")
    .replace(/\b[0-2]?[0-9]:[0-5][0-9](?::[0-5][0-9])?\b/g, " ");
  const candidate = sanitized.match(/(?<![0-9.+-])([0-9]{4,8})(?![0-9.%元GBMB])/);
  return candidate?.[1] ?? null;
}

function readCount(xml: string, tag: string, fallback: number): number {
  const parsed = Number.parseInt(getXmlTag(xml, tag) ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parse `GET /api/sms/sms-count`; returns `null` when the response carries no SMS counters. */
export function parseSmsCountersOrNull(xml: string): SmsCounters | null {
  if (!xml || getXmlTag(xml, "LocalInbox") === null) return null;
  return parseSmsCounters(xml);
}

export function parseSmsCounters(xml: string): SmsCounters {
  return {
    localUnread: readCount(xml, "LocalUnread", 0),
    localInbox: readCount(xml, "LocalInbox", 0),
    localOutbox: readCount(xml, "LocalOutbox", 0),
    localDraft: readCount(xml, "LocalDraft", 0),
    localMax: readCount(xml, "LocalMax", 500) || 500,
  };
}

/**
 * Parse one CPE `<Message>` (plain `sms-list`) or `<message>` (encrypted contact/phone lists) block.
 * `boxHint` is the box requested by the listing call; an explicit `<curbox>` or an outgoing
 * `<smstat>` (`3`/`4`) always wins.
 */
export function parseSmsMessageBlock(block: string, boxHint: "0" | "1" | null = null): SmsWireMessage {
  const smstat = getXmlTag(block, "smstat") || "1";
  const curbox = getXmlTag(block, "curbox") || boxHint || (smstat === "3" || smstat === "4" ? "1" : "0");
  const outgoing = curbox === "1" || smstat === "3" || smstat === "4";
  return {
    index: Number.parseInt(getXmlTag(block, "index") ?? "0", 10) || 0,
    phone: getXmlTag(block, "phone") ?? "",
    content: getXmlTextPreserve(block, "content"),
    date: getXmlTag(block, "date") ?? "",
    smstat,
    isUnread: smstat === "0" && !outgoing,
    direction: outgoing ? "out" : "in",
  };
}
