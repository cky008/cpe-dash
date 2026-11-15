import crypto from "node:crypto";

/**
 * How a TP-Link router's own page wraps what it sends (`tpEncrypt.js`): every payload is AES
 * encrypted with a key the page makes up for the session, and travels with a "signature" that is the
 * session's parameters encrypted for the router. The login's signature hands the router the AES key
 * and the IV; every later one carries a hash of the user name and password and a running number.
 *
 * Three generations are on record, and a router speaks one of them:
 * - AES-128-CBC, the signature encrypted with the router's RSA key without padding (the original);
 * - AES-128-GCM (the tag sent beside the data, the key and nonce Base64 in the signature), the
 *   signature RSA without padding or, on some firmware, RSA-OAEP with SHA-1;
 * - AES-128-CBC with the signature sealed by ECIES on NIST P-224 (the router hands out a curve point
 *   instead of an RSA key), a SHA-256 hash, and an HMAC-SHA256 of the payload next to it.
 *
 * These are the router's algorithms, not a choice of FengSui's: the RSA key is 512 bits and the
 * hash of the credentials is MD5 because that is what its page computes. Which generation applies
 * is settled before a login (`./driver.ts`), never by trying one after another.
 */

/** The key a router hands out before a login: an RSA modulus and exponent, or a point on P-224. */
export type TplinkPublicKey = { kind: "rsa"; modulusHex: string; exponentHex: string } | { kind: "ecc"; xHex: string; yHex: string };

export interface TplinkScheme {
  /** The cipher of the payloads. */
  cipher: "cbc" | "gcm";
  /** How an RSA signature block is padded (an ECC key has its own sealing). */
  padding: "none" | "oaep";
}

export const RSA_HEX = /^[0-9A-Fa-f]{64,1024}$/;
const P224_HEX = /^[0-9A-Fa-f]{56}$/;
const OAEP_SHA1_OVERHEAD = 42;

/** Whether a key is one the page's code could use: an RSA modulus of whole bytes, or both coordinates of a P-224 point. */
export function usableKey(key: TplinkPublicKey): boolean {
  if (key.kind === "ecc") return P224_HEX.test(key.xHex) && P224_HEX.test(key.yHex);
  return RSA_HEX.test(key.modulusHex) && key.modulusHex.length % 2 === 0 && /^[0-9A-Fa-f]{1,16}$/.test(key.exponentHex);
}

function base64url(hex: string): string {
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex").toString("base64url");
}

/**
 * A signature string encrypted for the router's RSA key the way its page does it: cut into blocks,
 * each encrypted on its own and written as hexadecimal of the modulus' length. Without padding a
 * block is as long as the modulus and its last one is filled with zero bytes; with OAEP it is as long
 * as OAEP leaves room for.
 */
export function rsaSign(text: string, key: { modulusHex: string; exponentHex: string }, padding: TplinkScheme["padding"]): string {
  const size = key.modulusHex.length / 2;
  const step = padding === "oaep" ? size - OAEP_SHA1_OVERHEAD : size;
  if (step < 1) throw new TypeError("the router's RSA key is too short for its own signature");
  const publicKey = crypto.createPublicKey({ key: { kty: "RSA", n: base64url(key.modulusHex), e: base64url(key.exponentHex) }, format: "jwk" });
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  for (let at = 0; at < bytes.length; at += step) {
    const part = bytes.subarray(at, at + step);
    const block = padding === "oaep" ? part : Buffer.concat([part, Buffer.alloc(step - part.length)]);
    const sealed = crypto.publicEncrypt({ key: publicKey, padding: padding === "oaep" ? crypto.constants.RSA_PKCS1_OAEP_PADDING : crypto.constants.RSA_NO_PADDING, ...(padding === "oaep" ? { oaepHash: "sha1" } : {}) }, block);
    out += sealed.toString("hex").padStart(size * 2, "0");
  }
  return out;
}

/**
 * A signature string sealed for the router's P-224 point (ECIES as its page's library does it): a
 * one-time key pair, the shared point's X hashed with SHA-256 into an AES-128 key, the string
 * AES-CBC encrypted under a random IV. The router gets the IV, the ciphertext and the one-time
 * public point (`tag`), all hexadecimal.
 */
export function eccSeal(text: string, key: { xHex: string; yHex: string }): { iv: string; ct: string; tag: string } {
  const ecdh = crypto.createECDH("secp224r1");
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(Buffer.from(`04${key.xHex}${key.yHex}`, "hex"));
  const kem = crypto.createHash("sha256").update(shared).digest().subarray(0, 16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", kem, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  // The uncompressed point without its leading 04: X then Y
  return { iv: iv.toString("hex"), ct: ct.toString("hex"), tag: ecdh.getPublicKey().subarray(1).toString("hex") };
}

/** `count` decimal digits from the system's random source: the page's keys are text, 16 characters of it. */
function digits(count: number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) out += String(crypto.randomInt(10));
  return out;
}

export interface TplinkSealed {
  sign: string;
  data: string;
  /** The GCM tag (Base64), where the cipher has one. */
  tag: string | null;
}

export interface TplinkEnvelopeOptions {
  key: TplinkPublicKey;
  scheme: TplinkScheme;
  /** The number the router handed out with its key: every signature carries it plus the payload's length. */
  seq: number;
  username: string;
  password: string;
  /** The session's AES key and IV as text (tests fix them; left out, they are random digits). */
  aes?: { key: string; iv: string };
}

/**
 * One session's wrapping: the AES key and IV made up for it, and the signature each payload travels
 * with. Nothing here sends a request.
 */
export class TplinkEnvelope {
  readonly #key: TplinkPublicKey;
  readonly #scheme: TplinkScheme;
  readonly #seq: number;
  readonly #hash: string;
  readonly #aesKey: string;
  readonly #aesIv: string;

  constructor(options: TplinkEnvelopeOptions) {
    if (!usableKey(options.key)) throw new TypeError("the router's key is not one its page could use");
    this.#key = options.key;
    // A curve point comes with the CBC cipher: that generation never took up GCM
    this.#scheme = options.key.kind === "ecc" ? { cipher: "cbc", padding: "none" } : options.scheme;
    this.#seq = options.seq;
    // The page hashes the user name and password together: MD5, or SHA-256 on the generation with a curve point
    this.#hash = crypto
      .createHash(options.key.kind === "ecc" ? "sha256" : "md5")
      .update(`${options.username}${options.password}`, "utf8")
      .digest("hex");
    this.#aesKey = options.aes?.key ?? digits(16);
    this.#aesIv = options.aes?.iv ?? digits(this.#scheme.cipher === "gcm" ? 12 : 16);
    if (this.#aesKey.length !== 16 || this.#aesIv.length !== (this.#scheme.cipher === "gcm" ? 12 : 16)) throw new TypeError("the session key has the wrong length");
  }

  get cipher(): TplinkScheme["cipher"] {
    return this.#scheme.cipher;
  }

  #encrypt(plain: string): { data: string; tag: string | null } {
    if (this.#scheme.cipher === "gcm") {
      const cipher = crypto.createCipheriv("aes-128-gcm", Buffer.from(this.#aesKey, "utf8"), Buffer.from(this.#aesIv, "utf8"));
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64");
      return { data, tag: cipher.getAuthTag().toString("base64") };
    }
    const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(this.#aesKey, "utf8"), Buffer.from(this.#aesIv, "utf8"));
    return { data: Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]).toString("base64"), tag: null };
  }

  /**
   * A payload ready to send. `login`: the signature also hands the router this session's AES key and
   * IV (Base64 where the cipher is GCM).
   */
  seal(plain: string, login: boolean): TplinkSealed {
    const { data, tag } = this.#encrypt(plain);
    const gcm = this.#scheme.cipher === "gcm";
    const field = (text: string): string => (gcm ? Buffer.from(text, "utf8").toString("base64") : text);
    const text = `${login ? `key=${field(this.#aesKey)}&iv=${field(this.#aesIv)}&` : ""}h=${this.#hash}&s=${this.#seq + data.length}`;
    if (this.#key.kind === "rsa") return { sign: rsaSign(text, this.#key, this.#scheme.padding), data, tag };
    const hmac = crypto.createHmac("sha256", Buffer.from(this.#aesKey, "utf8")).update(plain, "utf8").digest("hex");
    return { sign: JSON.stringify({ ...eccSeal(text, this.#key), hmac }), data, tag };
  }

  /** The request body the router's page posts: `sign`, `data` and, with GCM, `tag`, one per line. */
  body(sealed: TplinkSealed): string {
    return `sign=${sealed.sign}\r\ndata=${sealed.data}\r\n${sealed.tag === null ? "" : `tag=${sealed.tag}\r\n`}`;
  }

  /** An answer's text: Base64 of the ciphertext, with GCM followed by the tag's 24 characters. */
  open(answer: string): string {
    const text = answer.trim();
    if (this.#scheme.cipher === "gcm") {
      if (text.length < 24) throw new TypeError("the answer is shorter than its tag");
      const decipher = crypto.createDecipheriv("aes-128-gcm", Buffer.from(this.#aesKey, "utf8"), Buffer.from(this.#aesIv, "utf8"));
      decipher.setAuthTag(Buffer.from(text.slice(-24), "base64"));
      return Buffer.concat([decipher.update(Buffer.from(text.slice(0, -24), "base64")), decipher.final()]).toString("utf8");
    }
    const decipher = crypto.createDecipheriv("aes-128-cbc", Buffer.from(this.#aesKey, "utf8"), Buffer.from(this.#aesIv, "utf8"));
    return Buffer.concat([decipher.update(Buffer.from(text, "base64")), decipher.final()]).toString("utf8");
  }
}
