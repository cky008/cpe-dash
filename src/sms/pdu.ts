import { GSM_7BIT_ALPHABET } from "./text-mode.ts";

/**
 * SMS PDUs as 3GPP TS 23.040 defines them, for routers whose only SMS interface is the modem's own
 * (`AT+CMGL` lists PDUs, `AT+CMGS` takes one): the GSM 7-bit packing of TS 23.038, UCS-2, the user
 * data header that strings the parts of a long message together, addresses and timestamps.
 *
 * Decoding is tolerant (a PDU is whatever the network delivered: anything it cannot place throws
 * `SmsPduError` and the listing leaves that one message out); encoding is strict.
 */

export class SmsPduError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsPduError";
  }
}

const ESCAPE = 0x1b;

/** The extension table of TS 23.038 §6.2.1.1: the septet after an escape, and the character it stands for. */
const EXTENSION: ReadonlyArray<readonly [number, number]> = [
  [0x0a, 0x0c],
  [0x14, 0x5e],
  [0x28, 0x7b],
  [0x29, 0x7d],
  [0x2f, 0x5c],
  [0x3c, 0x5b],
  [0x3d, 0x7e],
  [0x3e, 0x5d],
  [0x40, 0x7c],
  [0x65, 0x20ac],
];

const SEPTET_OF = new Map<number, number>(GSM_7BIT_ALPHABET.map((unit, septet) => [unit, septet]));
const EXTENSION_OF = new Map<number, number>(EXTENSION.map(([septet, unit]) => [unit, septet]));
const EXTENSION_CHAR = new Map<number, number>(EXTENSION);

/**
 * The septets of `text` in the 7-bit alphabet, one group per character (two septets for a character
 * of the extension table, which a part boundary must not split); `null` when a character has none.
 */
export function gsm7Septets(text: string): number[][] | null {
  const out: number[][] = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const septet = unit === ESCAPE ? undefined : SEPTET_OF.get(unit);
    if (septet !== undefined) {
      out.push([septet]);
      continue;
    }
    const extended = EXTENSION_OF.get(unit);
    if (extended === undefined) return null;
    out.push([ESCAPE, extended]);
  }
  return out;
}

/** Text from septets; an escape without a known follower reads as a space, as the specification says. */
export function gsm7Text(septets: ReadonlyArray<number>): string {
  let out = "";
  for (let i = 0; i < septets.length; i++) {
    const septet = septets[i] ?? 0;
    if (septet === ESCAPE) {
      const next = septets[i + 1];
      const unit = next === undefined ? undefined : EXTENSION_CHAR.get(next);
      if (unit !== undefined) {
        out += String.fromCharCode(unit);
        i += 1;
      } else {
        out += " ";
      }
      continue;
    }
    out += String.fromCharCode(GSM_7BIT_ALPHABET[septet & 0x7f] ?? 0x20);
  }
  return out;
}

/** Pack septets into octets, least significant bits first, after `fillBits` bits of padding (TS 23.038 §6.1.2.1.1). */
export function packSeptets(septets: ReadonlyArray<number>, fillBits = 0): Buffer {
  const out = Buffer.alloc(Math.ceil((septets.length * 7 + fillBits) / 8));
  let bit = fillBits;
  for (const septet of septets) {
    const value = septet & 0x7f;
    const byte = bit >> 3;
    const shift = bit & 7;
    out[byte] = (out[byte] ?? 0) | ((value << shift) & 0xff);
    if (shift > 1) out[byte + 1] = (out[byte + 1] ?? 0) | (value >> (8 - shift));
    bit += 7;
  }
  return out;
}

/** `count` septets out of packed octets, skipping `fillBits` bits of padding first. */
export function unpackSeptets(octets: Uint8Array, count: number, fillBits = 0): number[] {
  const out: number[] = [];
  let bit = fillBits;
  for (let i = 0; i < count; i++) {
    const byte = bit >> 3;
    if (byte >= octets.length) break;
    const shift = bit & 7;
    const pair = (octets[byte] ?? 0) | ((octets[byte + 1] ?? 0) << 8);
    out.push((pair >> shift) & 0x7f);
    bit += 7;
  }
  return out;
}

const HEX = /^[0-9A-Fa-f]*$/;

function bytesOf(hex: string): Buffer {
  const clean = hex.trim();
  if (clean.length === 0 || clean.length % 2 !== 0 || !HEX.test(clean)) throw new SmsPduError("not a hexadecimal PDU");
  return Buffer.from(clean, "hex");
}

/** Semi-octets as digits (`F` is padding; `*`, `#`, `a`-`c` as TS 23.040 §9.1.2.3 names them). */
function semiOctets(octets: Uint8Array, digits: number): string {
  const symbols = "0123456789*#abc";
  let out = "";
  for (const octet of octets) {
    for (const nibble of [octet & 0x0f, octet >> 4]) {
      if (out.length >= digits) break;
      out += symbols[nibble] ?? "";
    }
  }
  return out;
}

/** Two decimal digits of a swapped BCD octet (`null`: not a decimal pair). */
function bcd(octet: number | undefined): number | null {
  if (octet === undefined) return null;
  const tens = octet & 0x0f;
  const ones = octet >> 4;
  return tens > 9 || ones > 9 ? null : tens * 10 + ones;
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * The service centre time stamp (TS 23.040 §9.2.3.11) as `yyyy-MM-dd HH:mm:ss`, the local time it
 * carries (its time zone octet is not applied, as the router's own page shows it). `""` when it is
 * not a date.
 */
export function decodeTimestamp(octets: Uint8Array): string {
  const [year, month, day, hour, minute, second] = [0, 1, 2, 3, 4, 5].map((i) => bcd(octets[i]));
  if (year === null || year === undefined || !month || !day || hour === null || hour === undefined || minute === null || minute === undefined || second === null || second === undefined) return "";
  if (month > 12 || day > 31 || hour > 23 || minute > 59 || second > 59) return "";
  return `20${two(year)}-${two(month)}-${two(day)} ${two(hour)}:${two(minute)}:${two(second)}`;
}

interface Address {
  text: string;
  /** Octets the address took in the PDU, its length and type octets included. */
  size: number;
}

/** An originating or destination address (TS 23.040 §9.1.2.5): digits, `+` when international, or an alphanumeric sender. */
function readAddress(bytes: Uint8Array, at: number): Address {
  const length = bytes[at];
  const type = bytes[at + 1];
  if (length === undefined || type === undefined) throw new SmsPduError("the PDU ends inside an address");
  const octets = Math.ceil(length / 2);
  const body = bytes.subarray(at + 2, at + 2 + octets);
  if (body.length < octets) throw new SmsPduError("the PDU ends inside an address");
  const ton = (type >> 4) & 0x07;
  if (ton === 0x05) {
    // Alphanumeric: the length counts useful semi-octets of 7-bit packed text
    return { text: gsm7Text(unpackSeptets(body, Math.floor((length * 4) / 7))).replace(/\s+$/, ""), size: 2 + octets };
  }
  const digits = semiOctets(body, length);
  return { text: ton === 0x01 ? `+${digits}` : digits, size: 2 + octets };
}

/** The parts of a long message as its user data header names them (TS 23.040 §9.2.3.24.1 / .8). */
export interface SmsConcatenation {
  reference: number;
  total: number;
  sequence: number;
}

function readHeader(header: Uint8Array): SmsConcatenation | null {
  let at = 0;
  let found: SmsConcatenation | null = null;
  while (at + 2 <= header.length) {
    const id = header[at] ?? 0;
    const length = header[at + 1] ?? 0;
    const element = header.subarray(at + 2, at + 2 + length);
    if (id === 0x00 && element.length === 3) found = { reference: element[0] ?? 0, total: element[1] ?? 0, sequence: element[2] ?? 0 };
    if (id === 0x08 && element.length === 4) found = { reference: ((element[0] ?? 0) << 8) | (element[1] ?? 0), total: element[2] ?? 0, sequence: element[3] ?? 0 };
    at += 2 + length;
  }
  return found && found.total > 0 && found.sequence > 0 && found.sequence <= found.total ? found : null;
}

type Alphabet = "gsm7" | "data" | "ucs2";

/** The alphabet a data coding scheme octet names (TS 23.038 §4). */
function alphabetOf(dcs: number): Alphabet {
  const group = dcs >> 4;
  if (group <= 0x07) return (["gsm7", "data", "ucs2", "gsm7"] as const)[(dcs >> 2) & 0x03] ?? "gsm7";
  if (group === 0x0e) return "ucs2";
  if (group === 0x0f) return dcs & 0x04 ? "data" : "gsm7";
  return "gsm7";
}

function readUserData(bytes: Uint8Array, at: number, dcs: number, hasHeader: boolean): { text: string; concat: SmsConcatenation | null } {
  const length = bytes[at];
  if (length === undefined) throw new SmsPduError("the PDU ends before its user data");
  const data = bytes.subarray(at + 1);
  const alphabet = alphabetOf(dcs);
  const headerOctets = hasHeader ? 1 + (data[0] ?? 0) : 0;
  if (headerOctets > data.length) throw new SmsPduError("the user data header runs past the PDU");
  const concat = hasHeader ? readHeader(data.subarray(1, headerOctets)) : null;
  if (alphabet === "gsm7") {
    // The header is padded to a septet boundary: its septets are counted in the length
    const headerSeptets = Math.ceil((headerOctets * 8) / 7);
    const fillBits = headerSeptets * 7 - headerOctets * 8;
    const septets = unpackSeptets(data.subarray(headerOctets), Math.max(0, length - headerSeptets), fillBits);
    return { text: gsm7Text(septets), concat };
  }
  const body = data.subarray(headerOctets, Math.min(data.length, length));
  if (alphabet === "ucs2") {
    let text = "";
    for (let i = 0; i + 1 < body.length; i += 2) text += String.fromCharCode(((body[i] ?? 0) << 8) | (body[i + 1] ?? 0));
    return { text, concat };
  }
  return { text: Buffer.from(body).toString("latin1"), concat };
}

export interface DecodedSmsPdu {
  /** `deliver`: a received message; `submit`: one the router stored to send. */
  kind: "deliver" | "submit";
  /** The other party: the sender of a delivery, the recipient of a submission. */
  address: string;
  /** `yyyy-MM-dd HH:mm:ss` of the service centre's time stamp; `""` on a submission, which has none. */
  date: string;
  text: string;
  /** Set on one part of a long message. */
  concat: SmsConcatenation | null;
}

/**
 * Decode a PDU as `AT+CMGL` / `AT+CMGR` print it: the service centre address, then an SMS-DELIVER or
 * an SMS-SUBMIT. Status reports and anything else throw `SmsPduError`.
 */
export function decodeSmsPdu(hex: string): DecodedSmsPdu {
  const bytes = bytesOf(hex);
  let at = 1 + (bytes[0] ?? 0);
  const first = bytes[at];
  if (first === undefined) throw new SmsPduError("the PDU holds a service centre address only");
  at += 1;
  const type = first & 0x03;
  const hasHeader = (first & 0x40) !== 0;
  if (type === 0x00) {
    const from = readAddress(bytes, at);
    at += from.size;
    const dcs = bytes[at + 1];
    if (dcs === undefined) throw new SmsPduError("the PDU ends before its coding scheme");
    const date = decodeTimestamp(bytes.subarray(at + 2, at + 9));
    return { kind: "deliver", address: from.text, date, ...readUserData(bytes, at + 9, dcs, hasHeader) };
  }
  if (type === 0x01) {
    const to = readAddress(bytes, at + 1);
    at += 1 + to.size;
    const dcs = bytes[at + 1];
    if (dcs === undefined) throw new SmsPduError("the PDU ends before its coding scheme");
    // The validity period: none, one octet (relative) or seven (enhanced, absolute)
    const validity = [0, 7, 1, 7][(first >> 3) & 0x03] ?? 0;
    return { kind: "submit", address: to.text, date: "", ...readUserData(bytes, at + 2 + validity, dcs, hasHeader) };
  }
  throw new SmsPduError("not an SMS-DELIVER or SMS-SUBMIT");
}

/** A destination address: the digits as swapped semi-octets, typed international after a `+`. */
function writeAddress(phone: string): Buffer {
  const international = phone.startsWith("+");
  const digits = international ? phone.slice(1) : phone;
  if (!/^[0-9]{1,20}$/.test(digits)) throw new SmsPduError("a recipient is digits, with at most a leading +");
  const padded = digits.length % 2 === 0 ? digits : `${digits}F`;
  const swapped = Buffer.alloc(padded.length / 2);
  for (let i = 0; i < swapped.length; i++) swapped[i] = Number.parseInt(`${padded[i * 2 + 1] ?? "F"}${padded[i * 2] ?? "0"}`, 16);
  return Buffer.concat([Buffer.from([digits.length, international ? 0x91 : 0x81]), swapped]);
}

/** Septets per part: 160 alone, 153 beside the 6-octet header (7 septets) of a long message. */
const GSM7_SINGLE = 160;
const GSM7_PART = 153;
/** UTF-16 code units per part: 70 alone, 67 beside the header. */
const UCS2_SINGLE = 70;
const UCS2_PART = 67;

/** Groups of units (each group stays in one part) cut into parts of at most `limit` units. */
function partsOf<T>(groups: ReadonlyArray<ReadonlyArray<T>>, limit: number): T[][] {
  const parts: T[][] = [[]];
  for (const group of groups) {
    let last = parts[parts.length - 1] ?? [];
    if (last.length + group.length > limit) {
      last = [];
      parts.push(last);
    }
    last.push(...group);
  }
  return parts;
}

/** UTF-16 code units of `text`, a surrogate pair as one group. */
function ucs2Groups(text: string): number[][] {
  const out: number[][] = [];
  for (const symbol of text) out.push(Array.from({ length: symbol.length }, (_, i) => symbol.charCodeAt(i)));
  return out;
}

export interface EncodedSmsSubmit {
  /** `7BIT` when every character is in the 7-bit alphabet, else `UCS2`. */
  encoding: "7BIT" | "UCS2";
  /**
   * One PDU per part, each with the empty service centre address (`00`: the modem's own) in front.
   * `AT+CMGS` wants the octet count without that first octet (`tpduLength`).
   */
  pdus: string[];
}

/** Octets of a PDU's transfer layer part, what `AT+CMGS=<n>` is told. */
export function tpduLength(pdu: string): number {
  return pdu.length / 2 - 1;
}

/**
 * SMS-SUBMIT PDUs for `text` to `phone`: one when it fits, else parts tied together by a
 * concatenation header with `reference` (0-255). No validity period and no status report are asked
 * for: the service centre's defaults apply.
 */
export function encodeSmsSubmit(phone: string, text: string, reference = 0): EncodedSmsSubmit {
  if (text.length === 0) throw new SmsPduError("a message needs text");
  const to = writeAddress(phone);
  const septets = gsm7Septets(text);
  const encoding = septets ? "7BIT" : "UCS2";
  const groups = septets ?? ucs2Groups(text);
  const units = groups.reduce((sum, group) => sum + group.length, 0);
  const single = septets ? GSM7_SINGLE : UCS2_SINGLE;
  const parts = units <= single ? [groups.flat()] : partsOf(groups, septets ? GSM7_PART : UCS2_PART);
  if (parts.length > 255) throw new SmsPduError("the message has too many parts");
  const pdus = parts.map((part, i) => {
    const header = parts.length > 1 ? Buffer.from([0x05, 0x00, 0x03, reference & 0xff, parts.length, i + 1]) : Buffer.alloc(0);
    let userData: Buffer;
    let length: number;
    if (septets) {
      const headerSeptets = Math.ceil((header.length * 8) / 7);
      const packed = packSeptets(part, headerSeptets * 7 - header.length * 8);
      userData = Buffer.concat([header, packed]);
      length = headerSeptets + part.length;
    } else {
      const body = Buffer.alloc(part.length * 2);
      part.forEach((unit, n) => body.writeUInt16BE(unit, n * 2));
      userData = Buffer.concat([header, body]);
      length = userData.length;
    }
    // SMS-SUBMIT, no validity period; the header flag when there is one. Message reference 0: the modem numbers it
    const first = 0x01 | (header.length > 0 ? 0x40 : 0x00);
    return Buffer.concat([Buffer.from([0x00, first, 0x00]), to, Buffer.from([0x00, septets ? 0x00 : 0x08, length]), userData])
      .toString("hex")
      .toUpperCase();
  });
  return { encoding, pdus };
}
