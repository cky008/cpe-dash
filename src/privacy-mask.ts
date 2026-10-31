/**
 * Partial masks for personal identifiers. Dependency-free: the daemon applies them when
 * REDACT_SENSITIVE_IN_API is on, and the web dashboard applies the same rules in its privacy mode,
 * so a value looks identical whichever side masked it. Each mask keeps only a non-personal prefix
 * (IMEI reporting body, IMSI MCC+MNC, MAC vendor OUI, phone country prefix).
 */

/** IMEI digits kept visible (`866709*********`): type-allocation prefix only, never the serial. */
export const IMEI_VISIBLE_DIGITS = 6;
/** IMSI digits kept visible: MCC + 2-digit MNC (the operator), never the subscriber number. */
export const IMSI_VISIBLE_DIGITS = 5;

/**
 * Mask a personal phone number for logs and status summaries (`+353*******01`). Alphanumeric
 * sender IDs and short codes (< 7 digits) are service identifiers, not personal data, and stay readable.
 */
export function maskPhoneNumber(raw: string): string {
  const clean = raw.trim();
  if (!clean) return "";
  if (/[A-Za-z一-龥]/.test(clean)) return clean;
  const compact = clean.replace(/[^\d+]/g, "");
  if (compact.replace(/\D/g, "").length < 7) return compact;
  const keepHead = compact.startsWith("+") ? 4 : 3;
  return `${compact.slice(0, keepHead)}${"*".repeat(compact.length - keepHead - 2)}${compact.slice(-2)}`;
}

/** Keep the first `keep` digits of an equipment or subscriber identity and star the rest. */
export function maskIdentityDigits(raw: string, keep: number): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= keep) return "*".repeat(digits.length);
  return `${digits.slice(0, keep)}${"*".repeat(digits.length - keep)}`;
}

/** Keep a MAC address's vendor OUI (`02:00:5E:**:**:**`). */
export function maskMacTail(raw: string): string {
  const clean = raw.trim();
  if (!clean) return "";
  const octets = clean.split(/[:-]/);
  if (octets.length !== 6 || octets.some((o) => !/^[0-9a-fA-F]{2}$/.test(o))) return "**:**:**:**:**:**";
  return `${octets.slice(0, 3).join(":").toUpperCase()}:**:**:**`;
}

/**
 * Keep an address's network head: two IPv4 octets (`198.51.*.*`) or two IPv6 groups (`2001:db8:****`).
 * Huawei's semicolon-separated address lists are masked item by item.
 */
export function maskIpAddress(raw: string): string {
  const clean = raw.trim();
  if (!clean) return "";
  if (clean.includes(";")) {
    return clean
      .split(";")
      .map((part) => maskIpAddress(part))
      .join(";");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(clean)) {
    const [a, b] = clean.split(".");
    return `${a}.${b}.*.*`;
  }
  if (clean.includes(":") && /^[0-9a-fA-F:.]+$/.test(clean)) {
    // Only groups before a `::` are positional; never reveal anything after the compression
    const head = (clean.split("::")[0] ?? "").split(":").filter(Boolean).slice(0, 2);
    return head.length > 0 ? `${head.join(":")}:****` : "****";
  }
  return "****";
}
