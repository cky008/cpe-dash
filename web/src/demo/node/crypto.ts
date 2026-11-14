import { Buffer, type BufferEncoding } from "./buffer.ts";

/**
 * The part of `node:crypto` the daemon's code and the mock routers use, synchronous as Node's is,
 * for the live demo only (scripts/build-web.ts puts it in place of `node:crypto` in the demo bundle).
 * WebCrypto is asynchronous and has neither MD5 nor scrypt, so the algorithms are written out here:
 * SHA-256, MD5, HMAC, PBKDF2, HKDF, AES-256-GCM and scrypt, with randomness from `crypto.getRandomValues`.
 * test/demo-node.test.ts checks each against Node's own. RSA (only the logins of ZTE's zWRT pages and
 * FiberHome use it, and neither is in the demo) is not here.
 */

type Bytes = Uint8Array;
type Input = string | ArrayBufferView;

function bytesOf(data: Input, encoding?: BufferEncoding): Bytes {
  if (typeof data === "string") return Buffer.from(data, encoding ?? "utf8");
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function notInDemo(what: string): never {
  throw new Error(`${what} is not available in the demo`);
}

// ── Hashes ────────────────────────────────────────────────────────────────────

interface HashCore {
  readonly blockSize: number;
  update(data: Bytes): void;
  digest(): Bytes;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** A hash over 64-byte blocks with the usual length padding; the subclass compresses a block. */
abstract class BlockHash implements HashCore {
  readonly blockSize = 64;
  readonly #block = new Uint8Array(64);
  #filled = 0;
  #length = 0;
  protected abstract readonly bigEndian: boolean;
  protected abstract compress(block: Bytes): void;
  protected abstract state(): Bytes;

  update(data: Bytes): void {
    this.#length += data.length;
    let at = 0;
    while (at < data.length) {
      const take = Math.min(64 - this.#filled, data.length - at);
      this.#block.set(data.subarray(at, at + take), this.#filled);
      this.#filled += take;
      at += take;
      if (this.#filled === 64) {
        this.compress(this.#block);
        this.#filled = 0;
      }
    }
  }

  digest(): Bytes {
    const bits = this.#length * 8;
    const padLength = this.#filled < 56 ? 56 - this.#filled : 120 - this.#filled;
    const tail = new Uint8Array(padLength + 8);
    tail[0] = 0x80;
    const view = new DataView(tail.buffer);
    const high = Math.floor(bits / 2 ** 32);
    const low = bits >>> 0;
    if (this.bigEndian) {
      view.setUint32(padLength, high, false);
      view.setUint32(padLength + 4, low, false);
    } else {
      view.setUint32(padLength, low, true);
      view.setUint32(padLength + 4, high, true);
    }
    this.update(tail);
    return this.state();
  }
}

class Sha256 extends BlockHash {
  protected readonly bigEndian = true;
  readonly #h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  readonly #w = new Uint32Array(64);

  protected compress(block: Bytes): void {
    const w = this.#w;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    const h = this.#h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + SHA256_K[i]! + w[i]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + k;
  }

  protected state(): Bytes {
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) view.setUint32(i * 4, this.#h[i]!, false);
    return out;
  }
}

const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
/** RFC 1321's table: the integer part of 2^32 × |sin(i + 1)|. */
const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
  0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
  0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

class Md5 extends BlockHash {
  protected readonly bigEndian = false;
  readonly #h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  readonly #m = new Uint32Array(16);

  protected compress(block: Bytes): void {
    const m = this.#m;
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(i * 4, true);
    const h = this.#h;
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i]! + m[g]!) | 0;
      const s = MD5_S[i]!;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
  }

  protected state(): Bytes {
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) view.setUint32(i * 4, this.#h[i]!, true);
    return out;
  }
}

function hashCore(algorithm: string): HashCore {
  const name = algorithm.toLowerCase();
  if (name === "sha256") return new Sha256();
  if (name === "md5") return new Md5();
  return notInDemo(`The ${algorithm} hash`);
}

class Hmac implements HashCore {
  readonly blockSize = 64;
  readonly #inner: HashCore;
  readonly #outer: HashCore;

  constructor(algorithm: string, key: Bytes) {
    this.#inner = hashCore(algorithm);
    this.#outer = hashCore(algorithm);
    let k = key.length > 64 ? ((): Bytes => {
      const h = hashCore(algorithm);
      h.update(key);
      return h.digest();
    })() : key;
    const padded = new Uint8Array(64);
    padded.set(k);
    k = padded;
    this.#inner.update(k.map((byte) => byte ^ 0x36));
    this.#outer.update(k.map((byte) => byte ^ 0x5c));
  }

  update(data: Bytes): void {
    this.#inner.update(data);
  }

  digest(): Bytes {
    this.#outer.update(this.#inner.digest());
    return this.#outer.digest();
  }
}

/** What `createHash` and `createHmac` hand back: chained updates, one digest. */
export class Hash {
  readonly #core: HashCore;

  constructor(core: HashCore) {
    this.#core = core;
  }

  update(data: Input, encoding?: BufferEncoding): this {
    this.#core.update(bytesOf(data, encoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: BufferEncoding): string;
  digest(encoding?: BufferEncoding): Buffer | string {
    const out = Buffer.from(this.#core.digest());
    return encoding === undefined ? out : out.toString(encoding);
  }
}

export function createHash(algorithm: string): Hash {
  return new Hash(hashCore(algorithm));
}

export function createHmac(algorithm: string, key: Input): Hash {
  return new Hash(new Hmac(algorithm, bytesOf(key)));
}

function hmac(algorithm: string, key: Bytes, data: Bytes): Bytes {
  const mac = new Hmac(algorithm, key);
  mac.update(data);
  return mac.digest();
}

export function pbkdf2Sync(password: Input, salt: Input, iterations: number, keylen: number, digest: string): Buffer {
  if (digest.toLowerCase() !== "sha256") notInDemo(`PBKDF2 with ${digest}`);
  const key = bytesOf(password);
  const saltBytes = bytesOf(salt);
  const out = new Uint8Array(keylen);
  const block = new Uint8Array(saltBytes.length + 4);
  block.set(saltBytes);
  for (let index = 1, at = 0; at < keylen; index++, at += 32) {
    new DataView(block.buffer).setUint32(saltBytes.length, index, false);
    let u = hmac(digest, key, block);
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmac(digest, key, u);
      for (let j = 0; j < t.length; j++) t[j] = t[j]! ^ u[j]!;
    }
    out.set(t.subarray(0, Math.min(32, keylen - at)), at);
  }
  return Buffer.from(out);
}

// ── AES-256-GCM ───────────────────────────────────────────────────────────────

const SBOX = ((): Uint8Array => {
  const box = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    // p walks the multiplicative group by 3, q by its inverse; the S-box is q's affine transform
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >>> 7)) ^ ((q << 2) | (q >>> 6)) ^ ((q << 3) | (q >>> 5)) ^ ((q << 4) | (q >>> 4));
    box[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  box[0] = 0x63;
  return box;
})();

function xtime(b: number): number {
  return ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;
}

class Aes {
  readonly #roundKeys: Uint8Array;
  readonly #rounds: number;

  constructor(key: Bytes) {
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) throw new RangeError("Invalid key length");
    const nk = key.length / 4;
    this.#rounds = nk + 6;
    const words = 4 * (this.#rounds + 1);
    const w = new Uint8Array(words * 4);
    w.set(key);
    let rcon = 1;
    for (let i = nk; i < words; i++) {
      let t0 = w[(i - 1) * 4]!, t1 = w[(i - 1) * 4 + 1]!, t2 = w[(i - 1) * 4 + 2]!, t3 = w[(i - 1) * 4 + 3]!;
      if (i % nk === 0) {
        [t0, t1, t2, t3] = [SBOX[t1]! ^ rcon, SBOX[t2]!, SBOX[t3]!, SBOX[t0]!];
        rcon = xtime(rcon);
      } else if (nk > 6 && i % nk === 4) {
        [t0, t1, t2, t3] = [SBOX[t0]!, SBOX[t1]!, SBOX[t2]!, SBOX[t3]!];
      }
      w[i * 4] = w[(i - nk) * 4]! ^ t0;
      w[i * 4 + 1] = w[(i - nk) * 4 + 1]! ^ t1;
      w[i * 4 + 2] = w[(i - nk) * 4 + 2]! ^ t2;
      w[i * 4 + 3] = w[(i - nk) * 4 + 3]! ^ t3;
    }
    this.#roundKeys = w;
  }

  encryptBlock(input: Bytes): Bytes {
    const s = input.slice(0, 16);
    const rk = this.#roundKeys;
    for (let i = 0; i < 16; i++) s[i] = s[i]! ^ rk[i]!;
    const t = new Uint8Array(16);
    for (let round = 1; round <= this.#rounds; round++) {
      // SubBytes and ShiftRows
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[((c + r) % 4) * 4 + r]!]!;
      if (round < this.#rounds) {
        // MixColumns
        for (let c = 0; c < 4; c++) {
          const a0 = t[c * 4]!, a1 = t[c * 4 + 1]!, a2 = t[c * 4 + 2]!, a3 = t[c * 4 + 3]!;
          const all = a0 ^ a1 ^ a2 ^ a3;
          s[c * 4] = a0 ^ all ^ xtime(a0 ^ a1);
          s[c * 4 + 1] = a1 ^ all ^ xtime(a1 ^ a2);
          s[c * 4 + 2] = a2 ^ all ^ xtime(a2 ^ a3);
          s[c * 4 + 3] = a3 ^ all ^ xtime(a3 ^ a0);
        }
      } else {
        s.set(t);
      }
      for (let i = 0; i < 16; i++) s[i] = s[i]! ^ rk[round * 16 + i]!;
    }
    return s;
  }
}

/** Multiply `x` by `h` in GCM's GF(2^128) (both 16 bytes, big-endian bit order), into `x`. */
function gfMultiply(x: Uint8Array, h: Uint8Array): void {
  const z = new Uint8Array(16);
  const v = h.slice();
  for (let i = 0; i < 128; i++) {
    if ((x[i >>> 3]! >>> (7 - (i & 7))) & 1) for (let j = 0; j < 16; j++) z[j] = z[j]! ^ v[j]!;
    const lsb = v[15]! & 1;
    for (let j = 15; j > 0; j--) v[j] = (v[j]! >>> 1) | ((v[j - 1]! & 1) << 7);
    v[0] = v[0]! >>> 1;
    if (lsb) v[0] = v[0]! ^ 0xe1;
  }
  x.set(z);
}

/** GHASH over `parts`, each zero-padded to whole blocks, then one block of two 64-bit bit lengths. */
function ghash(h: Uint8Array, parts: ReadonlyArray<Bytes>, lengths: readonly [number, number]): Uint8Array {
  const y = new Uint8Array(16);
  const absorb = (bytes: Bytes): void => {
    for (let at = 0; at < bytes.length; at += 16) {
      const block = bytes.subarray(at, at + 16);
      for (let j = 0; j < block.length; j++) y[j] = y[j]! ^ block[j]!;
      gfMultiply(y, h);
    }
  };
  for (const part of parts) absorb(part);
  const tail = new Uint8Array(16);
  const view = new DataView(tail.buffer);
  view.setUint32(0, Math.floor((lengths[0] * 8) / 2 ** 32), false);
  view.setUint32(4, (lengths[0] * 8) >>> 0, false);
  view.setUint32(8, Math.floor((lengths[1] * 8) / 2 ** 32), false);
  view.setUint32(12, (lengths[1] * 8) >>> 0, false);
  absorb(tail);
  return y;
}

/** `createCipheriv` / `createDecipheriv` for `aes-256-gcm`: the output of each update, then `final`. */
export class GcmCipher {
  readonly #aes: Aes;
  readonly #h: Uint8Array;
  readonly #j0: Uint8Array;
  readonly #decrypt: boolean;
  #aad: Bytes = new Uint8Array(0);
  /** What GHASH covers: the ciphertext (the output when encrypting, the input when decrypting). */
  readonly #ciphertext: Bytes[] = [];
  #tag: Bytes | null = null;
  #done = false;

  constructor(key: Bytes, iv: Bytes, decrypt: boolean) {
    this.#aes = new Aes(key);
    this.#decrypt = decrypt;
    this.#h = this.#aes.encryptBlock(new Uint8Array(16));
    if (iv.length === 12) {
      this.#j0 = new Uint8Array(16);
      this.#j0.set(iv);
      this.#j0[15] = 1;
    } else {
      // NIST SP 800-38D: J0 = GHASH(IV ‖ 0^(s+64) ‖ [len(IV)]64)
      this.#j0 = ghash(this.#h, [iv], [0, iv.length]);
    }
  }

  setAAD(aad: ArrayBufferView): this {
    this.#aad = bytesOf(aad).slice();
    return this;
  }

  setAuthTag(tag: ArrayBufferView): this {
    this.#tag = bytesOf(tag).slice();
    return this;
  }

  getAuthTag(): Buffer {
    if (this.#decrypt || this.#tag === null) throw new Error("Invalid state for operation getAuthTag");
    return Buffer.from(this.#tag);
  }

  update(data: Input): Buffer {
    const input = bytesOf(data);
    const out = new Uint8Array(input.length);
    // Counter blocks run on across updates: a keystream byte position is the byte's position overall
    const offset = this.#ciphertext.reduce((sum, part) => sum + part.length, 0);
    let stream = offset % 16 === 0 ? null : this.#keystream(Math.floor(offset / 16));
    for (let i = 0; i < input.length; i++) {
      const position = offset + i;
      if (position % 16 === 0) stream = this.#keystream(position / 16);
      out[i] = input[i]! ^ stream![position % 16]!;
    }
    this.#ciphertext.push(this.#decrypt ? input.slice() : out);
    return Buffer.from(out);
  }

  final(): Buffer {
    if (this.#done) throw new Error("Unsupported state");
    this.#done = true;
    const ciphertext = Buffer.concat(this.#ciphertext);
    const s = ghash(this.#h, [this.#aad, ciphertext], [this.#aad.length, ciphertext.length]);
    const mask = this.#aes.encryptBlock(this.#j0);
    const tag = s.map((byte, i) => byte ^ mask[i]!);
    if (this.#decrypt) {
      const given = this.#tag;
      let diff = given === null || given.length !== 16 ? 1 : 0;
      for (let i = 0; i < 16; i++) diff |= tag[i]! ^ (given?.[i] ?? 0);
      if (diff !== 0) throw new Error("Unsupported state or unable to authenticate data");
    } else {
      this.#tag = tag;
    }
    return Buffer.alloc(0);
  }

  /** The keystream block for counter block `index` (0 = the first after J0). */
  #keystream(index: number): Uint8Array {
    const counter = this.#j0.slice();
    const view = new DataView(counter.buffer);
    view.setUint32(12, (view.getUint32(12, false) + 1 + index) >>> 0, false);
    return this.#aes.encryptBlock(counter);
  }
}

function gcm(algorithm: string, key: Input, iv: Input, decrypt: boolean): GcmCipher {
  if (algorithm.toLowerCase() !== "aes-256-gcm") notInDemo(`The ${algorithm} cipher`);
  const keyBytes = bytesOf(key);
  if (keyBytes.length !== 32) throw new RangeError("Invalid key length");
  return new GcmCipher(keyBytes, bytesOf(iv), decrypt);
}

export function createCipheriv(algorithm: string, key: Input, iv: Input): GcmCipher {
  return gcm(algorithm, key, iv, false);
}

export function createDecipheriv(algorithm: string, key: Input, iv: Input): GcmCipher {
  return gcm(algorithm, key, iv, true);
}

// ── scrypt (the console password) ─────────────────────────────────────────────

export interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxmem?: number;
}

function salsa208(b: Uint32Array, x: Uint32Array): void {
  x.set(b);
  const rotl = (v: number, n: number): number => (v << n) | (v >>> (32 - n));
  for (let i = 0; i < 8; i += 2) {
    x[4] = x[4]! ^ rotl(x[0]! + x[12]!, 7); x[8] = x[8]! ^ rotl(x[4]! + x[0]!, 9);
    x[12] = x[12]! ^ rotl(x[8]! + x[4]!, 13); x[0] = x[0]! ^ rotl(x[12]! + x[8]!, 18);
    x[9] = x[9]! ^ rotl(x[5]! + x[1]!, 7); x[13] = x[13]! ^ rotl(x[9]! + x[5]!, 9);
    x[1] = x[1]! ^ rotl(x[13]! + x[9]!, 13); x[5] = x[5]! ^ rotl(x[1]! + x[13]!, 18);
    x[14] = x[14]! ^ rotl(x[10]! + x[6]!, 7); x[2] = x[2]! ^ rotl(x[14]! + x[10]!, 9);
    x[6] = x[6]! ^ rotl(x[2]! + x[14]!, 13); x[10] = x[10]! ^ rotl(x[6]! + x[2]!, 18);
    x[3] = x[3]! ^ rotl(x[15]! + x[11]!, 7); x[7] = x[7]! ^ rotl(x[3]! + x[15]!, 9);
    x[11] = x[11]! ^ rotl(x[7]! + x[3]!, 13); x[15] = x[15]! ^ rotl(x[11]! + x[7]!, 18);
    x[1] = x[1]! ^ rotl(x[0]! + x[3]!, 7); x[2] = x[2]! ^ rotl(x[1]! + x[0]!, 9);
    x[3] = x[3]! ^ rotl(x[2]! + x[1]!, 13); x[0] = x[0]! ^ rotl(x[3]! + x[2]!, 18);
    x[6] = x[6]! ^ rotl(x[5]! + x[4]!, 7); x[7] = x[7]! ^ rotl(x[6]! + x[5]!, 9);
    x[4] = x[4]! ^ rotl(x[7]! + x[6]!, 13); x[5] = x[5]! ^ rotl(x[4]! + x[7]!, 18);
    x[11] = x[11]! ^ rotl(x[10]! + x[9]!, 7); x[8] = x[8]! ^ rotl(x[11]! + x[10]!, 9);
    x[9] = x[9]! ^ rotl(x[8]! + x[11]!, 13); x[10] = x[10]! ^ rotl(x[9]! + x[8]!, 18);
    x[12] = x[12]! ^ rotl(x[15]! + x[14]!, 7); x[13] = x[13]! ^ rotl(x[12]! + x[15]!, 9);
    x[14] = x[14]! ^ rotl(x[13]! + x[12]!, 13); x[15] = x[15]! ^ rotl(x[14]! + x[13]!, 18);
  }
  for (let i = 0; i < 16; i++) b[i] = (b[i]! + x[i]!) | 0;
}

function blockMix(b: Uint32Array, y: Uint32Array, r: number, x: Uint32Array, t: Uint32Array): void {
  t.set(b.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let j = 0; j < 16; j++) t[j] = t[j]! ^ b[i * 16 + j]!;
    salsa208(t, x);
    // Even blocks to the first half, odd to the second
    y.set(t, ((i >>> 1) + (i & 1) * r) * 16);
  }
}

function roMix(block: Uint32Array, n: number, r: number): void {
  const words = 32 * r;
  const v = new Uint32Array(words * n);
  const y = new Uint32Array(words);
  const x = new Uint32Array(16);
  const t = new Uint32Array(16);
  for (let i = 0; i < n; i++) {
    v.set(block, i * words);
    blockMix(block, y, r, x, t);
    block.set(y);
  }
  for (let i = 0; i < n; i++) {
    const j = block[(2 * r - 1) * 16]! & (n - 1);
    for (let k = 0; k < words; k++) block[k] = block[k]! ^ v[j * words + k]!;
    blockMix(block, y, r, x, t);
    block.set(y);
  }
}

export function scryptSync(password: Input, salt: Input, keylen: number, options: ScryptOptions = {}): Buffer {
  const n = options.N ?? options.cost ?? 16384;
  const r = options.r ?? options.blockSize ?? 8;
  const p = options.p ?? options.parallelization ?? 1;
  if (n < 2 || (n & (n - 1)) !== 0) throw new RangeError("Invalid scrypt cost: N must be a power of two above 1");
  const b = pbkdf2Sync(password, salt, 1, p * 128 * r, "sha256");
  const words = new Uint32Array(32 * r);
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < p; i++) {
    for (let k = 0; k < words.length; k++) words[k] = view.getUint32(i * 128 * r + k * 4, true);
    roMix(words, n, r);
    for (let k = 0; k < words.length; k++) view.setUint32(i * 128 * r + k * 4, words[k]!, true);
  }
  return pbkdf2Sync(password, b, 1, keylen, "sha256");
}

export function scrypt(password: Input, salt: Input, keylen: number, options: ScryptOptions, callback: (err: Error | null, key: Buffer) => void): void {
  // Asynchronous as Node's is (the caller awaits a callback), on the page's own thread
  setTimeout(() => {
    let key: Buffer;
    try {
      key = scryptSync(password, salt, keylen, options);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)), Buffer.alloc(0));
      return;
    }
    callback(null, key);
  }, 0);
}

// ── Randomness and comparison ─────────────────────────────────────────────────

export function randomBytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let at = 0; at < size; at += 65_536) globalThis.crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65_536)));
  return out;
}

/** A v4 UUID from `getRandomValues` (a page opened from a file has no `crypto.randomUUID`). */
export function randomUUID(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = b.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An integer in `[min, max)` with no bias, as Node's `randomInt([min,] max)`. */
export function randomInt(minOrMax: number, maybeMax?: number): number {
  const min = maybeMax === undefined ? 0 : minOrMax;
  const max = maybeMax === undefined ? minOrMax : maybeMax;
  const range = max - min;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || range <= 0 || range > 2 ** 32) throw new RangeError("Invalid randomInt range");
  const limit = 2 ** 32 - (2 ** 32 % range);
  const word = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(word);
    if (word[0]! < limit) return min + (word[0]! % range);
  }
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = bytesOf(a);
  const y = bytesOf(b);
  if (x.length !== y.length) throw new RangeError("Input buffers must have the same byte length");
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export const constants = { RSA_PKCS1_PADDING: 1, RSA_PKCS1_OAEP_PADDING: 4 } as const;

export function createPublicKey(): never {
  return notInDemo("RSA");
}

export function createPrivateKey(): never {
  return notInDemo("RSA");
}

export function publicEncrypt(): never {
  return notInDemo("RSA");
}

export function privateDecrypt(): never {
  return notInDemo("RSA");
}

/** RFC 5869 HKDF over HMAC-SHA256 (the stores' per-write subkey); an `ArrayBuffer`, as Node's. */
export function hkdfSync(digest: string, ikm: Input, salt: Input, info: Input, keylen: number): ArrayBuffer {
  if (digest.toLowerCase() !== "sha256") notInDemo(`HKDF with ${digest}`);
  const prk = hmac(digest, bytesOf(salt), bytesOf(ikm));
  const infoBytes = bytesOf(info);
  const out = new Uint8Array(keylen);
  let previous: Bytes = new Uint8Array(0);
  for (let i = 1, at = 0; at < keylen; i++, at += 32) {
    const block = new Uint8Array(previous.length + infoBytes.length + 1);
    block.set(previous);
    block.set(infoBytes, previous.length);
    block[block.length - 1] = i;
    previous = hmac(digest, prk, block);
    out.set(previous.subarray(0, Math.min(32, keylen - at)), at);
  }
  return out.buffer;
}

export default {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  pbkdf2Sync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt,
  scryptSync,
  timingSafeEqual,
};
