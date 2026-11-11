import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SmsPduError, decodeSmsPdu, decodeTimestamp, encodeSmsSubmit, gsm7Septets, gsm7Text, packSeptets, tpduLength, unpackSeptets } from "../src/sms/pdu.ts";
import { GSM_7BIT_ALPHABET, detectSmsTextMode } from "../src/sms/text-mode.ts";

/**
 * 3GPP TS 23.040 PDUs: the codec the modem-level SMS interface (AT+CMGL / AT+CMGS) needs. Numbers are
 * the reserved test ranges only; nothing here comes from a real message.
 */

const PHONE = "+353830000001";

/** An SMS-DELIVER with the service centre address in front, as a modem stores it. */
function deliver(opts: { from: string; firstOctet?: string; dcs: string; stamp?: string; length: string; data: string }): string {
  return `0791538303000010${opts.firstOctet ?? "04"}${opts.from}00${opts.dcs}${opts.stamp ?? "62110121436500"}${opts.length}${opts.data}`;
}

/** `+353830000000` as an originating address. */
const FROM = "0C91538303000000";

describe("SMS PDU: the 7-bit alphabet", () => {
  it("is the default alphabet of TS 23.038, one character per septet", () => {
    assert.equal(GSM_7BIT_ALPHABET.length, 128);
    assert.equal(new Set(GSM_7BIT_ALPHABET).size, 128);
    assert.equal(String.fromCharCode(GSM_7BIT_ALPHABET[0] ?? 0), "@");
    assert.equal(String.fromCharCode(GSM_7BIT_ALPHABET[0x11] ?? 0), "_");
    assert.equal(String.fromCharCode(GSM_7BIT_ALPHABET[0x41] ?? 0), "A");
    assert.equal(String.fromCharCode(GSM_7BIT_ALPHABET[0x7f] ?? 0), "à");
  });

  it("packs septets least significant bits first and unpacks them again", () => {
    const septets = (gsm7Septets("hellohello") ?? []).flat();
    assert.equal(packSeptets(septets).toString("hex").toUpperCase(), "E8329BFD4697D9EC37");
    assert.deepEqual(unpackSeptets(Buffer.from("E8329BFD4697D9EC37", "hex"), 10), septets);
    assert.equal(gsm7Text(unpackSeptets(Buffer.from("C8F71D14969741F977FD07", "hex"), 12)), "How are you?");
  });

  it("writes a character of the extension table as an escape pair, and reads it back", () => {
    assert.deepEqual(gsm7Septets("€"), [[0x1b, 0x65]]);
    assert.deepEqual(gsm7Septets("[a]"), [[0x1b, 0x3c], [0x61], [0x1b, 0x3e]]);
    assert.equal(gsm7Text([0x1b, 0x65, 0x1b, 0x28, 0x1b, 0x29]), "€{}");
    // An escape nothing follows, or one before a septet the table does not name, reads as a space
    assert.equal(gsm7Text([0x41, 0x1b]), "A ");
    assert.equal(gsm7Text([0x1b, 0x41]), " A");
  });

  it("has no septets for text outside the alphabet, nor for a bare escape", () => {
    assert.equal(gsm7Septets("你好"), null);
    assert.equal(gsm7Septets("ok \u{1F600}"), null);
    assert.equal(gsm7Septets("\u001b"), null);
  });

  it("skips the fill bits that pad a user data header to a septet boundary", () => {
    const septets = (gsm7Septets("abc") ?? []).flat();
    const packed = packSeptets(septets, 1);
    assert.equal(packed[0], (0x61 << 1) & 0xff);
    assert.deepEqual(unpackSeptets(packed, 3, 1), septets);
    // Asked for more septets than the octets hold: what is there, no more
    assert.deepEqual(unpackSeptets(Buffer.from("41", "hex"), 5), [0x41, 0x00].slice(0, 2));
  });
});

describe("SMS PDU: decoding what a modem lists", () => {
  it("reads a received 7-bit message: sender, the centre's local time, text", () => {
    const pdu = decodeSmsPdu(deliver({ from: FROM, dcs: "00", length: "0C", data: "C8F71D14969741F977FD07" }));
    assert.deepEqual(pdu, { kind: "deliver", address: "+353830000000", date: "2026-11-10 12:34:56", text: "How are you?", concat: null });
  });

  it("reads Chinese (UCS-2) and a surrogate pair", () => {
    const pdu = decodeSmsPdu(deliver({ from: FROM, dcs: "08", length: "08", data: "4F60597DD83DDE00" }));
    assert.equal(pdu.text, "你好\u{1F600}");
  });

  it("reads a national number without a plus, and an alphanumeric sender", () => {
    // 10010 as a national number: five digits, padded with F
    const national = decodeSmsPdu(deliver({ from: "05810110F0", dcs: "00", length: "01", data: "41" }));
    assert.deepEqual([national.address, national.text], ["10010", "A"]);
    // "Three": five septets in five semi-octet pairs (length 0x09 semi-octets), type 0xD0
    const packed = packSeptets((gsm7Septets("Three") ?? []).flat()).toString("hex").toUpperCase();
    assert.equal(decodeSmsPdu(deliver({ from: `09D0${packed}`, dcs: "00", length: "01", data: "41" })).address, "Three");
  });

  it("names the part of a long message from its header (8-bit and 16-bit references)", () => {
    // UDHI set; header 05 00 03 2A 02 01, then one fill bit and "ab"
    const body = Buffer.concat([Buffer.from("0500032A0201", "hex"), packSeptets([0x61, 0x62], 1)]).toString("hex").toUpperCase();
    const first = decodeSmsPdu(deliver({ from: FROM, firstOctet: "44", dcs: "00", length: "09", data: body }));
    assert.deepEqual(first.concat, { reference: 0x2a, total: 2, sequence: 1 });
    assert.equal(first.text, "ab");
    const wide = decodeSmsPdu(deliver({ from: FROM, firstOctet: "44", dcs: "08", length: "0B", data: "060804012C03024F60597D".slice(0, 22) }));
    assert.deepEqual(wide.concat, { reference: 0x012c, total: 3, sequence: 2 });
    assert.equal(wide.text, "你好");
  });

  it("ignores a header that names no part, or an impossible one", () => {
    // A port-addressing element only
    const ports = decodeSmsPdu(deliver({ from: FROM, firstOctet: "44", dcs: "08", length: "09", data: "06050400000000" + "4F60" }));
    assert.equal(ports.concat, null);
    assert.equal(ports.text, "你");
    // Part 3 of 2
    assert.equal(decodeSmsPdu(deliver({ from: FROM, firstOctet: "44", dcs: "08", length: "08", data: "0500030702034F60" })).concat, null);
  });

  it("reads 8-bit data as Latin-1 and the message-class coding groups", () => {
    assert.equal(decodeSmsPdu(deliver({ from: FROM, dcs: "04", length: "02", data: "4869" })).text, "Hi");
    assert.equal(decodeSmsPdu(deliver({ from: FROM, dcs: "F4", length: "02", data: "4869" })).text, "Hi");
    assert.equal(decodeSmsPdu(deliver({ from: FROM, dcs: "F0", length: "01", data: "41" })).text, "A");
    assert.equal(decodeSmsPdu(deliver({ from: FROM, dcs: "E0", length: "02", data: "4F60" })).text, "你");
    assert.equal(decodeSmsPdu(deliver({ from: FROM, dcs: "C0", length: "01", data: "41" })).text, "A");
  });

  it("reads a stored submission: the recipient, no date, the text after its validity period", () => {
    const { pdus } = encodeSmsSubmit(PHONE, "hello");
    assert.deepEqual(decodeSmsPdu(pdus[0] ?? ""), { kind: "submit", address: PHONE, date: "", text: "hello", concat: null });
    // With a relative validity period (first octet 0x11, one octet 0xAA after the coding scheme)
    const withValidity = "001100" + "0C91538303000010" + "0000AA" + "05" + "E8329BFD06";
    assert.equal(decodeSmsPdu(withValidity).text, "hello");
  });

  it("refuses what is not a message it can read", () => {
    for (const bad of ["", "0", "zz", "07915383030000", "0791538303000010", "0006", deliver({ from: "0C91", dcs: "00", length: "01", data: "41" }).slice(0, 24), "000400"]) {
      assert.throws(() => decodeSmsPdu(bad), SmsPduError, bad);
    }
    // A status report
    assert.throws(() => decodeSmsPdu("00060C9153830300000062110121436500621101214365000000"), /SMS-DELIVER or SMS-SUBMIT/);
    // A header longer than the PDU
    assert.throws(() => decodeSmsPdu(deliver({ from: FROM, firstOctet: "44", dcs: "08", length: "04", data: "0A00" })), /header runs past/);
  });

  it("gives no date for a time stamp that is not one", () => {
    assert.equal(decodeTimestamp(Buffer.from("62110121436500", "hex")), "2026-11-10 12:34:56");
    assert.equal(decodeTimestamp(Buffer.from("62310121436500", "hex")), "");
    assert.equal(decodeTimestamp(Buffer.from("6211", "hex")), "");
    assert.equal(decodeTimestamp(Buffer.from("FF110121436500", "hex")), "");
  });
});

describe("SMS PDU: encoding a submission", () => {
  it("writes one PDU for a short 7-bit text, with the modem's own service centre", () => {
    const { encoding, pdus } = encodeSmsSubmit(PHONE, "hellohello");
    assert.equal(encoding, "7BIT");
    assert.deepEqual(pdus, ["000100" + "0C91538303000010" + "0000" + "0A" + "E8329BFD4697D9EC37"]);
    // Every octet but the service centre's: what AT+CMGS is told
    assert.equal(tpduLength(pdus[0] ?? ""), 22);
  });

  it("writes Chinese as UCS-2 and a national number without the international type", () => {
    const { encoding, pdus } = encodeSmsSubmit("10010", "你好");
    assert.equal(encoding, "UCS2");
    assert.deepEqual(pdus, ["000100" + "05810110F0" + "0008" + "04" + "4F60597D"]);
  });

  it("cuts a long 7-bit text into parts of 153 septets tied by one reference", () => {
    const text = "a".repeat(160) + "b";
    const { pdus } = encodeSmsSubmit(PHONE, text, 0x2a);
    assert.equal(pdus.length, 2);
    const parts = pdus.map((pdu) => decodeSmsPdu(pdu));
    assert.deepEqual(parts.map((p) => p.concat), [{ reference: 0x2a, total: 2, sequence: 1 }, { reference: 0x2a, total: 2, sequence: 2 }]);
    assert.equal(parts.map((p) => p.text).join(""), text);
    assert.equal(parts[0]?.text.length, 153);
    // 160 septets still fit one part
    assert.equal(encodeSmsSubmit(PHONE, "a".repeat(160)).pdus.length, 1);
  });

  it("never splits an escape pair or a surrogate pair across parts", () => {
    const euro = "a".repeat(152) + "€" + "b".repeat(10);
    const sevenBit = encodeSmsSubmit(PHONE, euro).pdus.map((pdu) => decodeSmsPdu(pdu).text);
    assert.equal(sevenBit.join(""), euro);
    assert.equal(sevenBit[0], "a".repeat(152));
    const emoji = "好".repeat(66) + "\u{1F600}" + "好".repeat(5);
    const ucs2 = encodeSmsSubmit(PHONE, emoji).pdus.map((pdu) => decodeSmsPdu(pdu).text);
    assert.equal(ucs2.join(""), emoji);
    assert.equal(ucs2[0], "好".repeat(66));
    assert.equal(encodeSmsSubmit(PHONE, "好".repeat(70)).pdus.length, 1);
    assert.equal(encodeSmsSubmit(PHONE, "好".repeat(71)).pdus.length, 2);
  });

  it("agrees with the composer's count on the encoding and the parts", () => {
    for (const text of ["hello", "a".repeat(161), "你好", "好".repeat(140), "{[€]}", "x".repeat(306)]) {
      const mode = detectSmsTextMode(text);
      const encoded = encodeSmsSubmit(PHONE, text);
      assert.equal(encoded.encoding, mode.encoding, text.slice(0, 8));
      assert.equal(encoded.pdus.length, mode.segments, text.slice(0, 8));
    }
  });

  it("refuses an empty text, a recipient that is not a number, and a text of too many parts", () => {
    assert.throws(() => encodeSmsSubmit(PHONE, ""), SmsPduError);
    assert.throws(() => encodeSmsSubmit("DemoBank", "hi"), /digits/);
    assert.throws(() => encodeSmsSubmit("+", "hi"), /digits/);
    assert.throws(() => encodeSmsSubmit(PHONE, "a".repeat(153 * 256)), /too many parts/);
  });
});
