/**
 * The part of Node's `Buffer` the daemon's code uses, on a `Uint8Array`: the live demo runs the
 * daemon's services in a page, and the demo bundle gets this one in place of Node's (scripts/build-web.ts
 * injects it as the global `Buffer`). Only the encodings and methods the bundled code calls are here;
 * test/demo-node.test.ts compares every one of them with Node's own, byte for byte.
 */

export type BufferEncoding = "utf8" | "utf-8" | "hex" | "base64" | "base64url" | "latin1" | "binary";

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Base64 digit of a character code (both alphabets, as Node reads them), or -1. */
const BASE64_VALUE = ((): Int8Array => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < 64; i++) {
    table[BASE64.charCodeAt(i)] = i;
    table[BASE64URL.charCodeAt(i)] = i;
  }
  return table;
})();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

function encodeString(text: string, encoding: BufferEncoding): Uint8Array {
  switch (encoding) {
    case "utf8":
    case "utf-8":
      return encoder.encode(text);
    case "latin1":
    case "binary": {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
    case "hex": {
      // As Node: pairs of hex digits up to the first pair that is not one
      const out = new Uint8Array(text.length >>> 1);
      let n = 0;
      for (; n < out.length; n++) {
        const high = hexValue(text.charCodeAt(2 * n));
        const low = hexValue(text.charCodeAt(2 * n + 1));
        if (high < 0 || low < 0) break;
        out[n] = (high << 4) | low;
      }
      return out.subarray(0, n);
    }
    case "base64":
    case "base64url": {
      // Either alphabet, padding optional, anything else (white space) skipped, as Node reads it
      const out = new Uint8Array(Math.ceil((text.length * 3) / 4));
      let bits = 0;
      let count = 0;
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 61) break;
        const value = code < 128 ? (BASE64_VALUE[code] ?? -1) : -1;
        if (value < 0) continue;
        bits = (bits << 6) | value;
        count += 6;
        if (count >= 8) {
          count -= 8;
          out[n++] = (bits >>> count) & 0xff;
        }
      }
      return out.subarray(0, n);
    }
  }
}

function decodeBytes(bytes: Uint8Array, encoding: BufferEncoding): string {
  switch (encoding) {
    case "utf8":
    case "utf-8":
      return decoder.decode(bytes);
    case "latin1":
    case "binary": {
      let out = "";
      for (let i = 0; i < bytes.length; i += 4096) out += String.fromCharCode(...bytes.subarray(i, i + 4096));
      return out;
    }
    case "hex": {
      let out = "";
      for (const byte of bytes) out += (byte < 16 ? "0" : "") + byte.toString(16);
      return out;
    }
    case "base64":
    case "base64url": {
      const alphabet = encoding === "base64" ? BASE64 : BASE64URL;
      let out = "";
      let i = 0;
      for (; i + 2 < bytes.length; i += 3) {
        const v = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
        out += alphabet[v >>> 18]! + alphabet[(v >>> 12) & 63]! + alphabet[(v >>> 6) & 63]! + alphabet[v & 63]!;
      }
      const rest = bytes.length - i;
      if (rest > 0) {
        const v = (bytes[i]! << 16) | (rest === 2 ? bytes[i + 1]! << 8 : 0);
        out += alphabet[v >>> 18]! + alphabet[(v >>> 12) & 63]!;
        out += rest === 2 ? alphabet[(v >>> 6) & 63]! : "";
        // base64url goes without padding, as Node writes it
        if (encoding === "base64") out += rest === 2 ? "=" : "==";
      }
      return out;
    }
  }
}

function toEncoding(value: unknown): BufferEncoding {
  const encoding = value === undefined ? "utf8" : String(value).toLowerCase();
  if (encoding === "utf8" || encoding === "utf-8" || encoding === "hex" || encoding === "base64" || encoding === "base64url" || encoding === "latin1" || encoding === "binary") return encoding;
  throw new TypeError(`Unknown encoding in the demo: ${encoding}`);
}

/** Bytes, read and written the ways the daemon's code does. */
class BufferBytes extends Uint8Array {
  // Node's signature: an encoding and a range; Uint8Array's own takes none
  override toString(encoding?: BufferEncoding, start = 0, end = this.length): string {
    return decodeBytes(this.subarray(start, end), toEncoding(encoding));
  }

  readUInt32LE(offset = 0): number {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset, true);
  }

  writeUInt32LE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset, value, true);
    return offset + 4;
  }

  writeUInt16BE(value: number, offset = 0): number {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint16(offset, value, false);
    return offset + 2;
  }

  equals(other: Uint8Array): boolean {
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) if (other[i] !== this[i]) return false;
    return true;
  }
}

function wrap(bytes: Uint8Array): BufferBytes {
  // A view of the same memory, as Node's own buffers are (the demo makes none on shared memory)
  return new BufferBytes(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
}

/** `Buffer.from`: a string in an encoding (utf8 when none), a copy of bytes or numbers, or a view of an `ArrayBuffer`. */
function from(value: string | ArrayLike<number> | ArrayBufferLike | ArrayBufferView | Iterable<number>, encoding?: BufferEncoding): BufferBytes {
  if (typeof value === "string") return wrap(encodeString(value, toEncoding(encoding)));
  if (value instanceof ArrayBuffer) return new BufferBytes(value);
  if (ArrayBuffer.isView(value)) return wrap(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  return wrap(Uint8Array.from(value as ArrayLike<number>));
}

function alloc(size: number, fill = 0): BufferBytes {
  return new BufferBytes(size).fill(fill);
}

function concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): BufferBytes {
  const length = totalLength ?? list.reduce((sum, part) => sum + part.length, 0);
  const out = new BufferBytes(length);
  let at = 0;
  for (const part of list) {
    if (at >= length) break;
    const take = part.subarray(0, length - at);
    out.set(take, at);
    at += take.length;
  }
  return out;
}

function byteLength(value: string | ArrayBufferView, encoding?: BufferEncoding): number {
  return typeof value === "string" ? encodeString(value, toEncoding(encoding)).length : value.byteLength;
}

function isBuffer(value: unknown): value is BufferBytes {
  return value instanceof BufferBytes;
}

/** What the bundled code calls on `Buffer` itself. */
interface BufferStatics {
  new (size: number): BufferBytes;
  readonly prototype: BufferBytes;
  from(value: string, encoding?: BufferEncoding): BufferBytes;
  from(value: ArrayLike<number> | ArrayBuffer | ArrayBufferView | Iterable<number>): BufferBytes;
  alloc(size: number, fill?: number): BufferBytes;
  concat(list: ReadonlyArray<Uint8Array>, totalLength?: number): BufferBytes;
  byteLength(value: string | ArrayBufferView, encoding?: BufferEncoding): number;
  isBuffer(value: unknown): value is BufferBytes;
}

/** The global `Buffer` of the demo bundle: `Uint8Array`'s own `from` is replaced by Node's. */
export const Buffer = Object.assign(BufferBytes, { from, alloc, concat, byteLength, isBuffer }) as unknown as BufferStatics;
export type Buffer = BufferBytes;
