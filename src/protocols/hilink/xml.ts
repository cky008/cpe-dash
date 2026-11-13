import { huaweiXssDecode, huaweiXssEncode } from "./crypto.ts";
import { stripInvalidControlChars } from "../../text-sanitize.ts";
import type { ParsedXmlError } from "../../types.ts";

/**
 * Maximum XML payload size accepted by the parser (2 MiB) to defend against memory/ReDoS abuse.
 */
export const MAX_XML_BYTES = 2 * 1024 * 1024;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeXmlInput(xml: string, tag?: string): string {
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    throw new Error(`XML payload exceeds maximum allowed size (${MAX_XML_BYTES} bytes)`);
  }
  if (tag !== undefined && !/^[A-Za-z0-9_:-]+$/.test(tag)) {
    throw new Error(`Invalid XML tag name "${tag}"`);
  }
  return stripInvalidControlChars(xml);
}

function toAsciiLower(input: string): string {
  return input.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

/**
 * Linear O(N) case-insensitive tag scanner (immune to ReDoS catastrophic backtracking
 * and Unicode case-folding length shifts such as U+0130).
 * Extracts the decoded inner text of the first matching `<tag>...</tag>`.
 */
export function getXmlTag(xml: string, tag: string): string | null {
  if (!xml) return null;
  const clean = assertSafeXmlInput(xml, tag);
  const lower = toAsciiLower(clean);
  const tagLower = toAsciiLower(tag);
  const openNeedle = `<${tagLower}>`;
  const selfCloseNeedle = `<${tagLower}/>`;
  const closeNeedle = `</${tagLower}>`;

  const selfIdx = lower.indexOf(selfCloseNeedle);
  const openIdx = lower.indexOf(openNeedle);
  if (selfIdx >= 0 && (openIdx < 0 || selfIdx < openIdx)) {
    return "";
  }
  if (openIdx < 0) return null;
  const contentStart = openIdx + openNeedle.length;
  const closeIdx = lower.indexOf(closeNeedle, contentStart);
  if (closeIdx < 0) return null;
  return huaweiXssDecode(clean.slice(contentStart, closeIdx).trim());
}

/**
 * Linear O(N) extractor for the first `<tag>...</tag>` that keeps leading/trailing whitespace
 * (SMS bodies), normalizes CRLF to LF and decodes Huawei XSS entities. Returns `""` when absent.
 */
export function getXmlTextPreserve(xml: string, tag: string): string {
  if (!xml) return "";
  const clean = assertSafeXmlInput(xml, tag);
  const lower = toAsciiLower(clean);
  const tagLower = toAsciiLower(tag);
  const openNeedle = `<${tagLower}>`;
  const openIdx = lower.indexOf(openNeedle);
  if (openIdx < 0) return "";
  const contentStart = openIdx + openNeedle.length;
  const closeIdx = lower.indexOf(`</${tagLower}>`, contentStart);
  if (closeIdx < 0) return "";
  return huaweiXssDecode(clean.slice(contentStart, closeIdx)).replace(/\r\n/g, "\n");
}

/**
 * Linear O(N) case-insensitive repeater block extractor for `<tag>...</tag>` lists.
 */
export function getXmlBlocks(xml: string, tag: string): string[] {
  if (!xml) return [];
  const clean = assertSafeXmlInput(xml, tag);
  const lower = toAsciiLower(clean);
  const tagLower = toAsciiLower(tag);
  const openNeedle = `<${tagLower}>`;
  const closeNeedle = `</${tagLower}>`;

  const results: string[] = [];
  let cursor = 0;
  while (cursor < lower.length) {
    const openIdx = lower.indexOf(openNeedle, cursor);
    if (openIdx < 0) break;
    const contentStart = openIdx + openNeedle.length;
    const closeIdx = lower.indexOf(closeNeedle, contentStart);
    if (closeIdx < 0) break;
    results.push(clean.slice(contentStart, closeIdx));
    cursor = closeIdx + closeNeedle.length;
  }
  return results;
}

/**
 * Strictly linear O(N) leaf `<key>value</key>` extractor producing a prototype-free dictionary.
 * Rejects `__proto__`, `constructor`, and `prototype` keys to prevent prototype pollution.
 */
export function xmlToFlatRecord(xml: string): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!xml) return out;
  const clean = assertSafeXmlInput(xml);

  let cursor = 0;
  while (cursor < clean.length) {
    const lt = clean.indexOf("<", cursor);
    if (lt < 0) break;
    const gt = clean.indexOf(">", lt + 1);
    if (gt < 0) break;
    const rawTag = clean.slice(lt + 1, gt).trim();
    cursor = gt + 1;

    if (!rawTag || rawTag.startsWith("?") || rawTag.startsWith("!") || rawTag.startsWith("/")) {
      continue;
    }
    if (rawTag.endsWith("/")) {
      const emptyName = rawTag.slice(0, -1).trim().split(/\s+/)[0] ?? "";
      if (emptyName && /^[A-Za-z0-9_:-]+$/.test(emptyName) && !FORBIDDEN_KEYS.has(emptyName)) {
        out[emptyName] = "";
      }
      continue;
    }

    const tagName = rawTag.split(/\s+/)[0] ?? "";
    if (!tagName || !/^[A-Za-z0-9_:-]+$/.test(tagName) || FORBIDDEN_KEYS.has(tagName)) {
      continue;
    }
    const lowerTagName = toAsciiLower(tagName);
    if (lowerTagName === "response" || lowerTagName === "request" || lowerTagName === "error") {
      continue;
    }

    const nextLt = clean.indexOf("<", cursor);
    if (nextLt < 0) break;
    const closeNeedle = `</${tagName}>`;
    if (toAsciiLower(clean.slice(nextLt, nextLt + closeNeedle.length)) === toAsciiLower(closeNeedle)) {
      out[tagName] = huaweiXssDecode(clean.slice(cursor, nextLt).trim());
      cursor = nextLt + closeNeedle.length;
    } else {
      cursor = nextLt;
    }
  }
  return out;
}

/**
 * Check if a Huawei XML response has a root `<error><code>...</code>...</error>` envelope.
 */
export function parseXmlError(xml: string): ParsedXmlError | null {
  if (!xml) return null;
  const clean = assertSafeXmlInput(xml);
  let body = clean.trimStart();
  if (toAsciiLower(body.slice(0, 5)) === "<?xml") {
    const declEnd = body.indexOf("?>");
    if (declEnd < 0) return null;
    body = body.slice(declEnd + 2).trimStart();
  }
  if (toAsciiLower(body.slice(0, 7)) !== "<error>") return null;
  const errorBlock = getXmlBlocks(body, "error")[0];
  if (errorBlock === undefined) return null;
  const code = getXmlTag(errorBlock, "code");
  if (!code) return null;
  const message = getXmlTag(errorBlock, "message") ?? "";
  const remainRaw = getXmlTag(errorBlock, "remaincount");
  const waitRaw = getXmlTag(errorBlock, "waittime");
  return {
    code,
    message,
    remainCount: remainRaw !== null && remainRaw !== "" ? Number.parseInt(remainRaw, 10) : null,
    waitTime: waitRaw !== null && waitRaw !== "" ? Number.parseInt(waitRaw, 10) : null,
  };
}

const ESCAPED_ENTITY_RE = /^(?:[A-Za-z]{2,8}|#\d{1,7}|#x[0-9A-Fa-f]{1,6})$/;

/**
 * Text that is already entity-escaped for the wire and must be emitted verbatim by `jsonToXml`
 * (instead of being escaped a second time). The constructor rejects raw `<`/`>` and any `&`
 * that does not start a well-formed entity, so a value can never inject markup.
 */
export class PreEscapedXmlText {
  readonly value: string;

  constructor(escaped: string) {
    if (/[<>]/.test(escaped)) {
      throw new Error("Pre-escaped XML text must not contain raw markup characters");
    }
    let amp = escaped.indexOf("&");
    while (amp >= 0) {
      const semi = escaped.indexOf(";", amp + 1);
      if (semi < 0 || !ESCAPED_ENTITY_RE.test(escaped.slice(amp + 1, semi))) {
        throw new Error('Pre-escaped XML text contains a bare "&" that does not start an entity');
      }
      amp = escaped.indexOf("&", semi + 1);
    }
    this.value = escaped;
  }

  static fromEscaped(escaped: string): PreEscapedXmlText {
    return new PreEscapedXmlText(escaped);
  }

  /** Encode plain text with Huawei WebUI's `xss()` escaper, the verified `send-sms` wire format. */
  static fromHuaweiXss(text: string): PreEscapedXmlText {
    return new PreEscapedXmlText(huaweiXssEncode(text));
  }
}

/**
 * Convert a nested JS value into Huawei HiLink XML body (`jsonToXml`), escaping primitive values.
 */
export function jsonToXml(tag: string, value: unknown): string {
  if (FORBIDDEN_KEYS.has(tag) || !/^[A-Za-z0-9_:-]+$/.test(tag)) {
    throw new Error(`Invalid or unsafe XML tag "${tag}"`);
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `<${tag}>${escapeXmlBasic(String(value))}</${tag}>`;
  }
  if (value instanceof PreEscapedXmlText) {
    return `<${tag}>${value.value}</${tag}>`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => jsonToXml(tag, item)).join("");
  }
  if (typeof value === "object") {
    const inner = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !FORBIDDEN_KEYS.has(k))
      .map(([k, v]) => jsonToXml(k, v))
      .join("");
    return `<${tag}>${inner}</${tag}>`;
  }
  return "";
}

/**
 * Build a full `<?xml version="1.0" encoding="UTF-8"?><request>...</request>` document.
 */
export function buildXmlRequest(data: Record<string, unknown>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${jsonToXml("request", data)}`;
}

/**
 * Escape basic XML special characters (`&`, `<`, `>`, `"`, `'`).
 */
export function escapeXmlBasic(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return ch;
    }
  });
}

/**
 * Format a `Date` object as `yyyy-MM-dd HH:mm:ss` in local timezone, matching Huawei WebUI.
 */
export function formatHuaweiDate(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
