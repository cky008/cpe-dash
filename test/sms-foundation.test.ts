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
