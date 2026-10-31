/**
 * One-time-code extraction, shared by the daemon's SMS mirror and the browser demo. Zero runtime
 * dependencies (no Node built-in), so the web bundle can import it.
 */

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
