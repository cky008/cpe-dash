import type { CountryDialInfo, ResolvedRecipient, SenderInfo } from "./types.ts";

/**
 * International dial codes with flag emoji, bilingual names and the national trunk-`0` rule
 * used when converting local numbers to E.164.
 */
export const COUNTRY_DIAL_CODES: readonly CountryDialInfo[] = [
  { code: "+353", iso: "IE", flag: "🇮🇪", nameZh: "爱尔兰", nameEn: "Ireland", dropTrunkZero: true },
  { code: "+86", iso: "CN", flag: "🇨🇳", nameZh: "中国大陆", nameEn: "China", dropTrunkZero: false },
  { code: "+44", iso: "GB", flag: "🇬🇧", nameZh: "英国", nameEn: "United Kingdom", dropTrunkZero: true },
  { code: "+852", iso: "HK", flag: "🇭🇰", nameZh: "中国香港", nameEn: "Hong Kong", dropTrunkZero: false },
  { code: "+853", iso: "MO", flag: "🇲🇴", nameZh: "中国澳门", nameEn: "Macau", dropTrunkZero: false },
  { code: "+886", iso: "TW", flag: "🇹🇼", nameZh: "中国台湾", nameEn: "Taiwan", dropTrunkZero: true },
  { code: "+1", iso: "US", flag: "🇺🇸", nameZh: "美国/加拿大", nameEn: "US / Canada", dropTrunkZero: false },
  { code: "+49", iso: "DE", flag: "🇩🇪", nameZh: "德国", nameEn: "Germany", dropTrunkZero: true },
  { code: "+33", iso: "FR", flag: "🇫🇷", nameZh: "法国", nameEn: "France", dropTrunkZero: true },
  { code: "+34", iso: "ES", flag: "🇪🇸", nameZh: "西班牙", nameEn: "Spain", dropTrunkZero: false },
  { code: "+39", iso: "IT", flag: "🇮🇹", nameZh: "意大利", nameEn: "Italy", dropTrunkZero: false },
  { code: "+31", iso: "NL", flag: "🇳🇱", nameZh: "荷兰", nameEn: "Netherlands", dropTrunkZero: true },
  { code: "+32", iso: "BE", flag: "🇧🇪", nameZh: "比利时", nameEn: "Belgium", dropTrunkZero: true },
  { code: "+41", iso: "CH", flag: "🇨🇭", nameZh: "瑞士", nameEn: "Switzerland", dropTrunkZero: true },
  { code: "+43", iso: "AT", flag: "🇦🇹", nameZh: "奥地利", nameEn: "Austria", dropTrunkZero: true },
  { code: "+351", iso: "PT", flag: "🇵🇹", nameZh: "葡萄牙", nameEn: "Portugal", dropTrunkZero: false },
  { code: "+352", iso: "LU", flag: "🇱🇺", nameZh: "卢森堡", nameEn: "Luxembourg", dropTrunkZero: false },
  { code: "+358", iso: "FI", flag: "🇫🇮", nameZh: "芬兰", nameEn: "Finland", dropTrunkZero: true },
  { code: "+45", iso: "DK", flag: "🇩🇰", nameZh: "丹麦", nameEn: "Denmark", dropTrunkZero: false },
  { code: "+46", iso: "SE", flag: "🇸🇪", nameZh: "瑞典", nameEn: "Sweden", dropTrunkZero: true },
  { code: "+47", iso: "NO", flag: "🇳🇴", nameZh: "挪威", nameEn: "Norway", dropTrunkZero: false },
  { code: "+48", iso: "PL", flag: "🇵🇱", nameZh: "波兰", nameEn: "Poland", dropTrunkZero: false },
  { code: "+420", iso: "CZ", flag: "🇨🇿", nameZh: "捷克", nameEn: "Czechia", dropTrunkZero: false },
  { code: "+30", iso: "GR", flag: "🇬🇷", nameZh: "希腊", nameEn: "Greece", dropTrunkZero: false },
  { code: "+36", iso: "HU", flag: "🇭🇺", nameZh: "匈牙利", nameEn: "Hungary", dropTrunkZero: true },
  { code: "+40", iso: "RO", flag: "🇷🇴", nameZh: "罗马尼亚", nameEn: "Romania", dropTrunkZero: true },
  { code: "+380", iso: "UA", flag: "🇺🇦", nameZh: "乌克兰", nameEn: "Ukraine", dropTrunkZero: true },
  { code: "+7", iso: "RU", flag: "🇷🇺", nameZh: "俄罗斯/哈萨克", nameEn: "Russia / KZ", dropTrunkZero: true },
  { code: "+90", iso: "TR", flag: "🇹🇷", nameZh: "土耳其", nameEn: "Turkey", dropTrunkZero: true },
  { code: "+971", iso: "AE", flag: "🇦🇪", nameZh: "阿联酋", nameEn: "UAE", dropTrunkZero: true },
  { code: "+972", iso: "IL", flag: "🇮🇱", nameZh: "以色列", nameEn: "Israel", dropTrunkZero: true },
  { code: "+966", iso: "SA", flag: "🇸🇦", nameZh: "沙特", nameEn: "Saudi Arabia", dropTrunkZero: true },
  { code: "+81", iso: "JP", flag: "🇯🇵", nameZh: "日本", nameEn: "Japan", dropTrunkZero: true },
  { code: "+82", iso: "KR", flag: "🇰🇷", nameZh: "韩国", nameEn: "South Korea", dropTrunkZero: true },
  { code: "+65", iso: "SG", flag: "🇸🇬", nameZh: "新加坡", nameEn: "Singapore", dropTrunkZero: false },
  { code: "+60", iso: "MY", flag: "🇲🇾", nameZh: "马来西亚", nameEn: "Malaysia", dropTrunkZero: true },
  { code: "+66", iso: "TH", flag: "🇹🇭", nameZh: "泰国", nameEn: "Thailand", dropTrunkZero: true },
  { code: "+84", iso: "VN", flag: "🇻🇳", nameZh: "越南", nameEn: "Vietnam", dropTrunkZero: true },
  { code: "+62", iso: "ID", flag: "🇮🇩", nameZh: "印尼", nameEn: "Indonesia", dropTrunkZero: true },
  { code: "+63", iso: "PH", flag: "🇵🇭", nameZh: "菲律宾", nameEn: "Philippines", dropTrunkZero: true },
  { code: "+91", iso: "IN", flag: "🇮🇳", nameZh: "印度", nameEn: "India", dropTrunkZero: true },
  { code: "+61", iso: "AU", flag: "🇦🇺", nameZh: "澳大利亚", nameEn: "Australia", dropTrunkZero: true },
  { code: "+64", iso: "NZ", flag: "🇳🇿", nameZh: "新西兰", nameEn: "New Zealand", dropTrunkZero: true },
  { code: "+55", iso: "BR", flag: "🇧🇷", nameZh: "巴西", nameEn: "Brazil", dropTrunkZero: true },
  { code: "+52", iso: "MX", flag: "🇲🇽", nameZh: "墨西哥", nameEn: "Mexico", dropTrunkZero: false },
  { code: "+54", iso: "AR", flag: "🇦🇷", nameZh: "阿根廷", nameEn: "Argentina", dropTrunkZero: true },
  { code: "+27", iso: "ZA", flag: "🇿🇦", nameZh: "南非", nameEn: "South Africa", dropTrunkZero: true },
  { code: "+20", iso: "EG", flag: "🇪🇬", nameZh: "埃及", nameEn: "Egypt", dropTrunkZero: true },
  { code: "+234", iso: "NG", flag: "🇳🇬", nameZh: "尼日利亚", nameEn: "Nigeria", dropTrunkZero: true },
  { code: "+356", iso: "MT", flag: "🇲🇹", nameZh: "马耳他", nameEn: "Malta", dropTrunkZero: false },
  { code: "+357", iso: "CY", flag: "🇨🇾", nameZh: "塞浦路斯", nameEn: "Cyprus", dropTrunkZero: false },
  { code: "+370", iso: "LT", flag: "🇱🇹", nameZh: "立陶宛", nameEn: "Lithuania", dropTrunkZero: true },
  { code: "+371", iso: "LV", flag: "🇱🇻", nameZh: "拉脱维亚", nameEn: "Latvia", dropTrunkZero: false },
  { code: "+372", iso: "EE", flag: "🇪🇪", nameZh: "爱沙尼亚", nameEn: "Estonia", dropTrunkZero: false },
];

const SORTED_BY_CODE_LEN = [...COUNTRY_DIAL_CODES].sort((a, b) => b.code.length - a.code.length);
const BY_CODE_MAP = new Map<string, CountryDialInfo>(COUNTRY_DIAL_CODES.map((c) => [c.code, c]));
const ALPHA_SENDER_RE = /[A-Za-z一-龥]/;

/**
 * National formats that `dropTrunkZero` cannot express (each country's national numbering plan):
 * - `trunk`: the prefix dialled before a national number when it is not "0": 8 in Russia and Kazakhstan, removed
 *   only in front of the 10-digit national number (area codes such as 812 begin with 8 too), and 06 in Hungary;
 * - `nationalMax`: the longest national number where one can begin with the country's own digits (Italian mobiles
 *   39x, Polish numbers 48x, Kazakh numbers 7xx, Indian mobiles 91xx); only a longer number reads as one typed with
 *   the code but no `+`.
 */
const NATIONAL_FORMATS: Readonly<Record<string, { trunk?: string; trunkBefore?: number; nationalMax?: number }>> = {
  "+7": { trunk: "8", trunkBefore: 10, nationalMax: 10 },
  "+36": { trunk: "06" },
  "+39": { nationalMax: 10 },
  "+48": { nationalMax: 9 },
  "+91": { nationalMax: 10 },
};

/**
 * `digits` (a number typed without `+` or `00`) as a national number of the country `code`, trunk prefix removed;
 * `null` when it already begins with the country code (a number pasted without its `+`).
 */
function nationalNumber(digits: string, code: string, dropTrunkZero: boolean): string | null {
  const format = Object.hasOwn(NATIONAL_FORMATS, code) ? NATIONAL_FORMATS[code] : undefined;
  const bareCode = code.slice(1);
  if (digits.startsWith(bareCode) && digits.length > (format?.nationalMax ?? bareCode.length + 6)) return null;
  const trunk = format?.trunk ?? (dropTrunkZero ? "0" : "");
  const fits = format?.trunkBefore === undefined || digits.length === trunk.length + format.trunkBefore;
  return trunk && fits && digits.startsWith(trunk) ? digits.slice(trunk.length) : digits;
}

export function getCountryByDialCode(dialCode: string): CountryDialInfo | null {
  const normalized = dialCode.startsWith("+") ? dialCode : `+${dialCode}`;
  return BY_CODE_MAP.get(normalized) ?? null;
}

/**
 * Mobile country codes (ITU-T E.212, the first three IMSI digits) of the countries in the dial table, to the
 * country's dial code. Canada (302) shares +1 with the United States, Kazakhstan (401) +7 with Russia.
 */
const MCC_DIAL_CODES: Readonly<Record<string, string>> = {
  "272": "+353", "460": "+86", "461": "+86", "234": "+44", "235": "+44", "454": "+852", "455": "+853", "466": "+886",
  "310": "+1", "311": "+1", "312": "+1", "313": "+1", "314": "+1", "315": "+1", "316": "+1", "302": "+1",
  "262": "+49", "208": "+33", "214": "+34", "222": "+39", "204": "+31", "206": "+32", "228": "+41", "232": "+43",
  "268": "+351", "270": "+352", "244": "+358", "238": "+45", "240": "+46", "242": "+47", "260": "+48", "230": "+420",
  "202": "+30", "216": "+36", "226": "+40", "255": "+380", "250": "+7", "401": "+7", "286": "+90", "424": "+971", "430": "+971",
  "431": "+971", "425": "+972", "420": "+966", "440": "+81", "441": "+81", "450": "+82", "525": "+65", "502": "+60",
  "520": "+66", "452": "+84", "510": "+62", "515": "+63", "404": "+91", "405": "+91", "406": "+91", "505": "+61",
  "530": "+64", "724": "+55", "334": "+52", "722": "+54", "655": "+27", "602": "+20", "621": "+234", "278": "+356",
  "280": "+357", "246": "+370", "247": "+371", "248": "+372",
};

/**
 * The SIM's country dial code from its IMSI (e.g. `272…` -> `+353`), or `null` for a missing, masked or unknown
 * one. FengSui uses it as the default country when `DEFAULT_COUNTRY_CODE` is left empty.
 */
export function dialCodeFromImsi(imsi: string): string | null {
  const digits = imsi.trim();
  if (!/^\d{6,15}$/.test(digits)) return null;
  return Object.hasOwn(MCC_DIAL_CODES, digits.slice(0, 3)) ? (MCC_DIAL_CODES[digits.slice(0, 3)] ?? null) : null;
}

export function matchCountryFromE164(e164: string): CountryDialInfo | null {
  if (!e164.startsWith("+")) return null;
  for (const entry of SORTED_BY_CODE_LEN) {
    if (e164.startsWith(entry.code) && e164.length > entry.code.length) {
      return entry;
    }
  }
  return null;
}

/**
 * Detect a sender brand from `【Brand】` / `[Brand]` wrappers or a leading `Brand:` prefix.
 */
export function extractBrandSignature(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const leading = trimmed.match(/^(?:【([^】]{1,20})】|\[([^\]]{2,20})\])/);
  if (leading) {
    return (leading[1] ?? leading[2] ?? "").trim() || null;
  }
  const trailing = trimmed.match(/【([^】]{1,20})】\s*$/);
  if (trailing?.[1]) return trailing[1].trim();
  const colonPrefix = trimmed.match(/^([A-Z][A-Za-z0-9 .&-]{1,18}):\s+/);
  return colonPrefix?.[1]?.trim() ?? null;
}

export function cleanPhoneFormatting(raw: string): string {
  return raw.trim().replace(/[\s\-(). ​-‍‪-‮]/g, "");
}

function senderFromCountry(
  type: SenderInfo["type"],
  raw: string,
  e164: string,
  country: CountryDialInfo,
  brandHint: string | null,
  displayNumber = e164
): SenderInfo {
  return {
    type,
    raw,
    e164,
    dialable: true,
    flag: country.flag,
    countryCode: country.code,
    countryZh: country.nameZh,
    countryEn: country.nameEn,
    countryIso: country.iso,
    brandHint,
    displayNumber,
  };
}

/**
 * Classify a sender as a brand ID, Chinese 106 gateway, short code, international or national
 * number (normalized to E.164 using `defaultCountryCode`).
 */
export function parseSenderInfo(rawPhone: string, smsContent: string, defaultCountryCode: string): SenderInfo {
  const raw = rawPhone.trim();
  const brandHint = extractBrandSignature(smsContent);

  if (!raw) {
    return {
      type: "unknown",
      raw: "",
      e164: null,
      dialable: false,
      flag: "❓",
      countryCode: null,
      countryZh: "未知来源",
      countryEn: "Unknown sender",
      countryIso: null,
      brandHint,
      displayNumber: "—",
    };
  }

  if (ALPHA_SENDER_RE.test(raw)) {
    return {
      type: "alphanumeric",
      raw,
      e164: null,
      dialable: false,
      flag: "🏢",
      countryCode: null,
      countryZh: "品牌/机构服务号",
      countryEn: "Brand / service sender",
      countryIso: null,
      brandHint: brandHint ?? raw,
      displayNumber: raw,
    };
  }

  const cleaned = cleanPhoneFormatting(raw);

  if (/^106\d{5,17}$/.test(cleaned)) {
    return {
      type: "gateway",
      raw,
      e164: cleaned,
      dialable: true,
      flag: "🇨🇳",
      countryCode: "+86",
      countryZh: "中国服务通道 (106)",
      countryEn: "China service gateway (106)",
      countryIso: "CN",
      brandHint,
      displayNumber: cleaned,
    };
  }

  if (/^\d{1,6}$/.test(cleaned)) {
    return {
      type: "shortcode",
      raw,
      e164: cleaned,
      dialable: true,
      flag: "📟",
      countryCode: null,
      countryZh: "运营商/服务短号",
      countryEn: "Carrier / service short code",
      countryIso: null,
      brandHint,
      displayNumber: cleaned,
    };
  }

  // Well-known international mobiles reported without "+" (CN 1[3-9]x, GB 7x, HK 4-9x)
  if (/^(?:861[3-9]\d{9}|447\d{9}|852[4-9]\d{7})$/.test(cleaned)) {
    const e164 = `+${cleaned}`;
    const country = matchCountryFromE164(e164);
    if (country) return senderFromCountry("international", raw, e164, country, brandHint);
  }

  if (cleaned.startsWith("+") || cleaned.startsWith("00")) {
    const e164 = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;
    if (/^\+\d{6,18}$/.test(e164)) {
      const country = matchCountryFromE164(e164);
      if (country) return senderFromCountry("international", raw, e164, country, brandHint);
      return {
        type: "international",
        raw,
        e164,
        dialable: true,
        flag: "🌐",
        countryCode: null,
        countryZh: "国际号码",
        countryEn: "International number",
        countryIso: null,
        brandHint,
        displayNumber: e164,
      };
    }
  }

  const defCountry = getCountryByDialCode(defaultCountryCode);
  if (/^\d{7,15}$/.test(cleaned) && defCountry) {
    const national = nationalNumber(cleaned, defCountry.code, defCountry.dropTrunkZero);
    if (national === null) {
      return senderFromCountry("international", raw, `+${cleaned}`, defCountry, brandHint);
    }
    const e164 = `${defCountry.code}${national}`;
    return senderFromCountry("national", raw, e164, defCountry, brandHint, `${e164} (${cleaned})`);
  }

  const dialable = /^\+?\d{3,20}$/.test(cleaned);
  return {
    type: "other",
    raw,
    e164: dialable ? cleaned : null,
    dialable,
    flag: "📱",
    countryCode: null,
    countryZh: "未知归属",
    countryEn: "Unknown origin",
    countryIso: null,
    brandHint,
    displayNumber: raw,
  };
}

/**
 * Normalize a user-typed recipient (`0830000001`, `+44…`, `0044…`, short code) to the number
 * submitted to `send-sms`, using `selectedCountryCode` for national numbers.
 */
export function resolveRecipientPhone(rawInput: string, selectedCountryCode: string): ResolvedRecipient {
  const cleaned = cleanPhoneFormatting(rawInput);
  if (!cleaned) {
    return { ok: false, error: "Recipient number is empty" };
  }
  if (!/^\+?\d{3,20}$/.test(cleaned)) {
    return {
      ok: false,
      error: "Invalid recipient: use a local number (e.g. 0830000001) or a full +country number",
    };
  }

  if (!cleaned.startsWith("+") && !cleaned.startsWith("00") && /^\d{3,6}$/.test(cleaned)) {
    return {
      ok: true,
      phone: cleaned,
      flag: "📟",
      countryCode: null,
      countryZh: "短号服务",
      countryEn: "Short code",
      isShortCode: true,
    };
  }

  if (cleaned.startsWith("+") || cleaned.startsWith("00")) {
    const e164 = cleaned.startsWith("00") ? `+${cleaned.slice(2)}` : cleaned;
    if (!/^\+\d{7,18}$/.test(e164)) {
      return { ok: false, error: `Invalid international number length (${e164})` };
    }
    const country = matchCountryFromE164(e164);
    return {
      ok: true,
      phone: e164,
      flag: country?.flag ?? "🌐",
      countryCode: country?.code ?? null,
      countryZh: country?.nameZh ?? "国际号码",
      countryEn: country?.nameEn ?? "International number",
      isShortCode: false,
    };
  }

  // No default country yet (none in .env and none read from the SIM): never guess where a local number goes
  if (!selectedCountryCode.replace("+", "")) {
    return { ok: false, error: "No default country is known: type the number with its country code (e.g. +44…) or choose a country" };
  }
  const country = getCountryByDialCode(selectedCountryCode);
  const code = country?.code ?? (selectedCountryCode.startsWith("+") ? selectedCountryCode : `+${selectedCountryCode}`);
  const national = nationalNumber(cleaned, code, country?.dropTrunkZero ?? true) ?? cleaned.slice(code.length - 1);
  const e164 = `${code}${national}`;
  if (!/^\+\d{7,18}$/.test(e164)) {
    return { ok: false, error: `Combined number has an invalid length (${e164})` };
  }
  return {
    ok: true,
    phone: e164,
    flag: country?.flag ?? "🌐",
    countryCode: code,
    countryZh: country?.nameZh ?? code,
    countryEn: country?.nameEn ?? code,
    isShortCode: false,
  };
}

/**
 * Thread grouping key: E.164 for dialable numbers, `alpha:<lowercase>` for brand senders.
 */
export function canonicalThreadKey(rawPhone: string, defaultCountryCode: string): string {
  const raw = rawPhone.trim();
  if (!raw) return "unknown";
  if (ALPHA_SENDER_RE.test(raw)) return `alpha:${raw.toLowerCase()}`;
  return parseSenderInfo(raw, "", defaultCountryCode).e164 ?? cleanPhoneFormatting(raw);
}

/**
 * All keys a number may be stored under (raw, E.164, bare digits, last-9-digit tail) for
 * contact matching across national / international spellings.
 */
export function buildPhoneLookupKeys(rawPhone: string, defaultCountryCode: string): string[] {
  const raw = rawPhone.trim();
  if (!raw) return [];
  if (ALPHA_SENDER_RE.test(raw)) return [`alpha:${raw.toLowerCase()}`];

  const keys = new Set<string>();
  const cleaned = cleanPhoneFormatting(raw);
  if (cleaned) keys.add(cleaned);
  const e164 = parseSenderInfo(raw, "", defaultCountryCode).e164;
  const digits = (e164 ?? cleaned).replace(/\D/g, "");
  if (e164) {
    keys.add(e164);
    keys.add(digits);
  }
  if (digits.length >= 9) keys.add(`tail9:${digits.slice(-9)}`);
  return [...keys];
}
