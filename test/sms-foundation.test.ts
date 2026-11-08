import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maskPhoneNumber } from "../src/sanitize.ts";
import {
  MAX_SMS_SEGMENTS,
  SMS_TEXT_MODE_7BIT,
  SMS_TEXT_MODE_UCS2,
  detectSmsTextMode,
  extractVerificationCode,
  parseSmsMessageBlock,
} from "../src/sms/codec.ts";
import {
  COUNTRY_DIAL_CODES,
  buildPhoneLookupKeys,
  canonicalThreadKey,
  cleanPhoneFormatting,
  dialCodeFromImsi,
  extractBrandSignature,
  getCountryByDialCode,
  matchCountryFromE164,
  parseSenderInfo,
  resolveRecipientPhone,
} from "../src/sms/phone.ts";
import { PreEscapedXmlText, buildXmlRequest, getXmlTextPreserve } from "../src/xml.ts";

describe("Pre-escaped XML wire text & whitespace-preserving extraction", () => {
  it("emits Huawei xss()-encoded text verbatim so send-sms bytes match the verified WebUI encoder", () => {
    const content = PreEscapedXmlText.fromHuaweiXss(`Tom & Jerry's "deal" <50% off> (a/b)`);
    assert.equal(
      content.value,
      "Tom &amp; Jerry&#39;s &quot;deal&quot; &lt;50% off&gt; &#40;a&#x2F;b&#41;"
    );
    const xml = buildXmlRequest({ Content: content, Length: content.value.length, Phone: "A&B" });
    // Pre-escaped text is NOT escaped twice, plain strings still get basic escaping
    assert.match(xml, /<Content>Tom &amp; Jerry&#39;s &quot;deal&quot; &lt;50% off&gt; &#40;a&#x2F;b&#41;<\/Content>/);
    assert.match(xml, /<Phone>A&amp;B<\/Phone>/);
    assert.doesNotMatch(xml, /&amp;amp;|&amp;#/);
  });

  it("refuses raw markup or bare ampersands so pre-escaped values can never inject XML", () => {
    assert.throws(() => PreEscapedXmlText.fromEscaped("<b>hi</b>"), /raw markup/);
    assert.throws(() => PreEscapedXmlText.fromEscaped("fish & chips"), /bare "&"/);
    assert.throws(() => PreEscapedXmlText.fromEscaped("&amp"), /bare "&"/);
    assert.equal(PreEscapedXmlText.fromEscaped("caf&#233; &#x2F; &lt;ok&gt;").value, "caf&#233; &#x2F; &lt;ok&gt;");
  });

  it("extracts message bodies without trimming, normalizes CRLF and decodes entities", () => {
    const block = "<content>  Line 1\r\nLine 2 &lt;b&gt; &#40;x&#41;  </content><index>1</index>";
    assert.equal(getXmlTextPreserve(block, "content"), "  Line 1\nLine 2 <b> (x)  ");
    assert.equal(getXmlTextPreserve(block.toUpperCase().replace("&LT;B&GT;", ""), "content").startsWith("  LINE 1"), true);
    assert.equal(getXmlTextPreserve("<index>1</index>", "content"), "");
    assert.equal(getXmlTextPreserve("<content/>", "content"), "");
    assert.equal(getXmlTextPreserve("", "content"), "");
    assert.equal(getXmlTextPreserve("<content>unterminated", "content"), "");
  });
});

describe("SMS codec: GSM-7 / UCS-2 segmentation, OTP extraction and message blocks", () => {
  it("counts GSM-7 septets (extension chars twice) and segments at 160/153", () => {
    const hello = detectSmsTextMode("Hello");
    assert.deepEqual(hello, { textMode: SMS_TEXT_MODE_7BIT, encoding: "7BIT", segments: 1, charUnits: 5 });
    assert.equal(detectSmsTextMode("Price 5€").charUnits, 9);
    assert.equal(detectSmsTextMode("a".repeat(160)).segments, 1);
    assert.equal(detectSmsTextMode("a".repeat(161)).segments, 2);
    assert.equal(detectSmsTextMode("a".repeat(306)).segments, 2);
    assert.equal(detectSmsTextMode("a".repeat(307)).segments, 3);
    // Invalid control characters are stripped before counting
    assert.equal(detectSmsTextMode("ab\u0001c").charUnits, 3);
  });

  it("switches to UCS-2 for non-GSM characters and segments at 70/67", () => {
    const zh = detectSmsTextMode("你好");
    assert.deepEqual(zh, { textMode: SMS_TEXT_MODE_UCS2, encoding: "UCS2", segments: 1, charUnits: 2 });
    assert.equal(detectSmsTextMode("好".repeat(70)).segments, 1);
    assert.equal(detectSmsTextMode("好".repeat(71)).segments, 2);
    assert.equal(detectSmsTextMode("好".repeat(134)).segments, 2);
    assert.equal(detectSmsTextMode("好".repeat(135)).segments, 3);
    assert.equal(MAX_SMS_SEGMENTS, 4);
  });

  it("extracts 4-8 digit verification codes only when OTP context words are present", () => {
    assert.equal(extractVerificationCode("【中国移动】验证码 654321，5分钟内有效"), "654321");
    assert.equal(extractVerificationCode("Your verification code is 482913."), "482913");
    assert.equal(extractVerificationCode("123456 is your Revolut code"), "123456");
    assert.equal(extractVerificationCode("Your code: see https://example.com/12345678 or use code 4821"), "4821");
    assert.equal(extractVerificationCode("Security code for 2026-10-30 at 18:30 → 77113"), "77113");
    assert.equal(extractVerificationCode("Meet at 2026-10-30 18:30, room 4521"), null);
    assert.equal(extractVerificationCode(""), null);
  });

  it("bounds OTP regex work on oversized untrusted sender text (ReDoS guard)", () => {
    const hostile = `code ${" ".repeat(200_000)}x`;
    const started = performance.now();
    assert.equal(extractVerificationCode(hostile), null);
    assert.ok(performance.now() - started < 500);
    // A code beyond the scan window is ignored rather than scanned
    assert.equal(extractVerificationCode(`${"a".repeat(5_000)} verification code 99887766`), null);
  });

  it("parses inbox/outbox blocks with box inference, whitespace-preserving content and entity decoding", () => {
    const inbox = parseSmsMessageBlock(
      "<Smstat>0</Smstat><Index>40002</Index><Phone>+353830000001</Phone><Content>  Hi\r\nthere &lt;3 </Content><Date>2026-10-30 12:00:00</Date><Smstype>1</Smstype>",
      "0"
    );
    assert.deepEqual(inbox, {
      index: 40002,
      phone: "+353830000001",
      content: "  Hi\nthere <3 ",
      date: "2026-10-30 12:00:00",
      smstat: "0",
      isUnread: true,
      direction: "in",
    });

    // Outgoing status wins even when <curbox/> is present but empty
    const sent = parseSmsMessageBlock(
      "<index>40010</index><phone>+353830000002</phone><content>On my way</content><date>2026-10-30 12:05:00</date><smstat>3</smstat><curbox/>"
    );
    assert.equal(sent.direction, "out");
    assert.equal(sent.isUnread, false);

    // Box hint from the listing call decides direction when no <curbox> tag is returned
    const outboxDefault = parseSmsMessageBlock("<Index>7</Index><Smstat>1</Smstat>", "1");
    assert.equal(outboxDefault.direction, "out");
    const explicitInbox = parseSmsMessageBlock("<Index>8</Index><Smstat>0</Smstat><curbox>0</curbox>", "1");
    assert.equal(explicitInbox.direction, "in");
    assert.equal(explicitInbox.isUnread, true);

    const empty = parseSmsMessageBlock("");
    assert.equal(empty.index, 0);
    assert.equal(empty.direction, "in");
    assert.equal(empty.isUnread, false);
  });
});

describe("Phone directory, sender classification, recipient resolution and thread keys", () => {
  it("names the SIM's country dial code from its IMSI (the default country when .env sets none)", () => {
    // Placeholder IMSIs built from a country's MCC (no 15-digit literal: the secret scan treats those as real)
    const imsi = (mcc: string): string => `${mcc}${"0".repeat(12)}`;
    assert.equal(dialCodeFromImsi("272010000000000"), "+353");
    assert.equal(dialCodeFromImsi(imsi("460")), "+86");
    assert.equal(dialCodeFromImsi(imsi("234")), "+44");
    assert.equal(dialCodeFromImsi(imsi("310")), "+1");
    assert.equal(dialCodeFromImsi(imsi("302")), "+1", "Canada shares +1");
    assert.equal(dialCodeFromImsi(imsi("454")), "+852");
    // Unknown, test-network, masked or missing IMSIs give no guess
    for (const value of [imsi("001"), imsi("999"), "272*****", "", "abc", "27"]) assert.equal(dialCodeFromImsi(value), null, value);
    // Every guess is a country the dial table knows, so flags and national formats follow
    for (const mcc of ["272", "460", "461", "234", "235", "454", "455", "466", "310", "302", "262", "208", "214", "222", "204", "206", "228", "232", "268", "270", "244", "238", "240", "242", "260", "230", "202", "216", "226", "255", "250", "286", "424", "425", "420", "440", "441", "450", "525", "502", "520", "452", "510", "515", "404", "405", "505", "530", "724", "334", "722", "655", "602", "621", "278", "280", "246", "247", "248"]) {
      const code = dialCodeFromImsi(imsi(mcc));
      assert.ok(code && getCountryByDialCode(code), mcc);
    }
  });

  it("refuses a number without + while no default country is known, instead of guessing one", () => {
    const refused = resolveRecipientPhone("0830000001", "");
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /country code/i);
    assert.equal(resolveRecipientPhone("+353830000001", "").ok, true);
    assert.equal(resolveRecipientPhone("00353830000001", "").ok, true);
    assert.equal(resolveRecipientPhone("50000", "").ok, true, "short codes need no country");
    assert.equal(parseSenderInfo("0830000001", "", "").e164, "0830000001", "a national sender stays as it came");
  });

  it("completes national numbers in each country's own format: trunk prefixes other than 0, national numbers that begin with the country's digits", () => {
    // Built at run time: full international numbers outside the reserved test ranges never appear as literals
    const intl = (code: string, national: string): string => `+${code}${national}`;
    const to = (input: string, country: string): string => {
      const r = resolveRecipientPhone(input, country);
      return r.ok ? r.phone : `refused: ${r.error}`;
    };
    // No trunk prefix, so a national number may begin with the country's digits (Italian mobiles 39x, Radom 48x)
    assert.equal(to("3900000001", "+39"), intl("39", "3900000001"));
    assert.equal(to("393900000001", "+39"), intl("39", "3900000001"), "typed with the country code but without +");
    assert.equal(to("480000001", "+48"), intl("48", "480000001"));
    assert.equal(to("48480000001", "+48"), intl("48", "480000001"));
    // Russia and Kazakhstan dial 8 before the 10-digit national number (Kazakh numbers begin with 7); Hungary dials 06
    assert.equal(to("89000000001", "+7"), intl("7", "9000000001"));
    assert.equal(to("9000000001", "+7"), intl("7", "9000000001"));
    assert.equal(to("8120000001", "+7"), intl("7", "8120000001"), "10 digits beginning with 8: an area code, not the trunk");
    assert.equal(to("7010000001", "+7"), intl("7", "7010000001"), "a Kazakh national number");
    assert.equal(to("77010000001", "+7"), intl("7", "7010000001"));
    assert.equal(to("06300000001", "+36"), intl("36", "300000001"));
    assert.equal(to("300000001", "+36"), intl("36", "300000001"));
    // Unchanged elsewhere
    assert.equal(to("0830000001", "+353"), "+353830000001");
    assert.equal(to("12025550123", "+1"), intl("1", "2025550123"));
    assert.equal(to("2025550123", "+1"), intl("1", "2025550123"));
    assert.equal(to("4790000001", "+47"), intl("47", "90000001"), "Norway's 8-digit numbers: 10 digits beginning with 47 carry the code");
    // Senders that arrive in national format follow the same rules
    assert.equal(parseSenderInfo("3900000001", "", "+39").e164, intl("39", "3900000001"));
    assert.equal(parseSenderInfo("89000000001", "", "+7").e164, intl("7", "9000000001"));
    assert.equal(parseSenderInfo("06300000001", "", "+36").e164, intl("36", "300000001"));
    assert.equal(parseSenderInfo("353830000001", "", "+353").e164, "+353830000001");
  });

  it("exposes a 54-country dial table with bilingual names and longest-prefix E.164 matching", () => {
    assert.equal(COUNTRY_DIAL_CODES.length, 54);
    assert.ok(COUNTRY_DIAL_CODES.every((c) => c.nameZh && c.nameEn && c.code.startsWith("+")));
    assert.equal(getCountryByDialCode("353")?.iso, "IE");
    assert.equal(getCountryByDialCode("+999"), null);
    assert.equal(matchCountryFromE164("+353830000001")?.iso, "IE");
    assert.equal(matchCountryFromE164("+35212345678")?.iso, "LU");
    assert.equal(matchCountryFromE164("353830000001"), null);
    assert.equal(matchCountryFromE164("+353"), null);
  });

  it("classifies alphanumeric, gateway, short-code, international, national and unknown senders", () => {
    const brand = parseSenderInfo("Three", "Welcome to Three 5G");
    assert.equal(brand.type, "alphanumeric");
    assert.equal(brand.dialable, false);
    assert.equal(brand.brandHint, "Three");
    assert.equal(brand.countryEn, "Brand / service sender");

    const gateway = parseSenderInfo("1069000000001", "【示例银行】您的验证码 123456");
    assert.equal(gateway.type, "gateway");
    assert.equal(gateway.countryCode, "+86");
    assert.equal(gateway.brandHint, "示例银行");

    const shortcode = parseSenderInfo("50000");
    assert.equal(shortcode.type, "shortcode");
    assert.equal(shortcode.dialable, true);

    const intl = parseSenderInfo("+447700900123");
    assert.equal(intl.type, "international");
    assert.equal(intl.countryIso, "GB");
    assert.equal(intl.countryEn, "United Kingdom");

    const doubleZero = parseSenderInfo("00447700900123");
    assert.equal(doubleZero.e164, "+447700900123");

    const unknownCountry = parseSenderInfo("+999123456789");
    assert.equal(unknownCountry.flag, "🌐");
    assert.equal(unknownCountry.countryEn, "International number");

    const cnMobile = parseSenderInfo("8613000000000");
    assert.equal(cnMobile.e164, "+8613000000000");

    const national = parseSenderInfo("0830000001", "", "+353");
    assert.equal(national.type, "national");
    assert.equal(national.e164, "+353830000001");
    assert.equal(national.displayNumber, "+353830000001 (0830000001)");

    const withCode = parseSenderInfo("353830000001", "", "+353");
    assert.equal(withCode.type, "international");
    assert.equal(withCode.e164, "+353830000001");

    const empty = parseSenderInfo("");
    assert.equal(empty.type, "unknown");
    assert.equal(empty.countryEn, "Unknown sender");

    const other = parseSenderInfo("12-34", "", "+999");
    assert.equal(other.type, "shortcode");
    const weird = parseSenderInfo("#123*");
    assert.equal(weird.type, "other");
    assert.equal(weird.dialable, false);
  });

  it("detects bracketed and colon-prefixed brand signatures in message bodies", () => {
    assert.equal(extractBrandSignature("【示例银行】您的验证码 1234"), "示例银行");
    assert.equal(extractBrandSignature("[DemoBank] code 1234"), "DemoBank");
    assert.equal(extractBrandSignature("您的包裹已签收【示例快递】"), "示例快递");
    assert.equal(extractBrandSignature("DemoBank: your code is 1234"), "DemoBank");
    assert.equal(extractBrandSignature("plain text"), null);
    assert.equal(extractBrandSignature(""), null);
  });

  it("resolves recipients to E.164 with trunk-zero rules, short codes and explicit errors", () => {
    assert.deepEqual(resolveRecipientPhone("083 000 0001", "+353"), {
      ok: true,
      phone: "+353830000001",
      flag: "🇮🇪",
      countryCode: "+353",
      countryZh: "爱尔兰",
      countryEn: "Ireland",
      isShortCode: false,
    });
    assert.equal((resolveRecipientPhone("0044 7700 900123") as { phone: string }).phone, "+447700900123");
    assert.equal((resolveRecipientPhone("353830000001", "+353") as { phone: string }).phone, "+353830000001");
    assert.equal((resolveRecipientPhone("13000000000", "+86") as { phone: string }).phone, "+8613000000000");
    assert.equal((resolveRecipientPhone("50000") as { isShortCode: boolean }).isShortCode, true);
    assert.equal(resolveRecipientPhone("", "+353").ok, false);
    assert.equal(resolveRecipientPhone("not a number").ok, false);
    assert.equal(resolveRecipientPhone("+12").ok, false);
    assert.equal(resolveRecipientPhone("1234567", "+999").ok, true);
    assert.equal(cleanPhoneFormatting(" +353 (83) 000-0001 "), "+353830000001");
  });

  it("derives stable thread keys and lookup keys across national / international spellings", () => {
    assert.equal(canonicalThreadKey("0830000001", "+353"), "+353830000001");
    assert.equal(canonicalThreadKey("+353830000001", "+353"), "+353830000001");
    assert.equal(canonicalThreadKey("Three"), "alpha:three");
    assert.equal(canonicalThreadKey(""), "unknown");

    const keys = buildPhoneLookupKeys("0830000001", "+353");
    assert.ok(keys.includes("+353830000001"));
    assert.ok(keys.includes("tail9:830000001"));
    assert.deepEqual(buildPhoneLookupKeys("Three"), ["alpha:three"]);
    assert.deepEqual(buildPhoneLookupKeys(""), []);
    assert.ok(buildPhoneLookupKeys("#1234567890").includes("tail9:234567890"));
  });

  it("masks personal numbers for logs while keeping brand senders and short codes readable", () => {
    assert.equal(maskPhoneNumber("+353830000001"), "+353*******01");
    assert.equal(maskPhoneNumber("0830000001"), "083*****01");
    assert.equal(maskPhoneNumber("Three"), "Three");
    assert.equal(maskPhoneNumber("50000"), "50000");
    assert.equal(maskPhoneNumber("  "), "");
  });
});
