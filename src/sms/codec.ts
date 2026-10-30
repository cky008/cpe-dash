import { stripInvalidControlChars } from "../crypto.ts";
import { getXmlTag, getXmlTextPreserve } from "../xml.ts";
import type { SmsTextModeCode, SmsTextModeInfo, SmsWireMessage } from "./types.ts";

/** Huawei `<Reserved>` text modes (`smsSendPage.vue`). */
export const SMS_TEXT_MODE_UCS2: SmsTextModeCode = 0;
export const SMS_TEXT_MODE_7BIT: SmsTextModeCode = 1;

/** H168-383 concatenates at most 4 segments per `send-sms` submission. */
export const MAX_SMS_SEGMENTS = 4;

/** OTP extraction only scans the head of a message so hostile sender text cannot burn CPU (ReDoS guard). */
const OTP_SCAN_LIMIT = 2048;

const GSM_7BIT_DEFAULT_TABLE = new Set<number>([
  64, 163, 36, 165, 232, 233, 249, 236, 242, 199, 10, 216, 248, 13, 197, 229,
  916, 95, 934, 915, 923, 937, 928, 936, 931, 920, 926, 27, 198, 230, 223, 201,
  32, 33, 34, 35, 164, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 161, 65, 66, 67, 68, 69,
  70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88,
  89, 90, 196, 214, 209, 220, 167, 191, 97, 98, 99, 100, 101, 102, 103, 104,
  105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
  120, 121, 122, 228, 246, 241, 252, 224,
]);

/** Characters that need the GSM-7 escape (`ESC + char`) and therefore cost two septets. */
const GSM_7BIT_EXT_TABLE = new Set<number>([10, 94, 32, 123, 125, 92, 91, 126, 93, 124, 8364]);

/**
 * Determine the Huawei `<Reserved>` text mode and segment count for an outgoing message
 * (GSM-7: 160 / 153 septets per segment; UCS-2: 70 / 67 code units per segment).
 */
export function detectSmsTextMode(content: string): SmsTextModeInfo {
  const clean = stripInvalidControlChars(content);
  let septets = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    if (GSM_7BIT_DEFAULT_TABLE.has(code)) {
      septets += 1;
    } else if (GSM_7BIT_EXT_TABLE.has(code)) {
      septets += 2;
    } else {
      const units = clean.length;
      return {
        textMode: SMS_TEXT_MODE_UCS2,
        encoding: "UCS2",
        segments: units <= 70 ? 1 : Math.ceil(units / 67),
        charUnits: units,
      };
    }
  }
  return {
    textMode: SMS_TEXT_MODE_7BIT,
    encoding: "7BIT",
    segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    charUnits: septets,
  };
}

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
