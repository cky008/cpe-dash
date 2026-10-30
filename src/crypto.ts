import crypto from "node:crypto";
import type { EccSessionKeys, ScramProof } from "./types.ts";

/**
 * Curve25519 prime 2^255 - 19 and Montgomery constant (486662 - 2) / 4 = 121665.
 *
 * Protocol note for Huawei 5G CPE Ultra 6 (H168-383, FW 4.4.0.1):
 * Huawei's WebUI uses `indutny/elliptic` `new elliptic.ec("curve25519")` rather than RFC 7748 X25519:
 *   1. Scalars and u-coordinates are serialized in BIG-ENDIAN hex.
 *   2. Private scalars are NOT RFC 7748 clamped.
 *   3. `BN.toString("hex")` strips leading zero nibbles if the MSB is `< 0x10`, so we generate
 *      ephemeral keys whose public and shared secrets are guaranteed 64-char hex strings.
 */
const CURVE25519_P = (1n << 255n) - 19n;
const CURVE25519_A24 = 121665n;

function modP(a: bigint): bigint {
  const r = a % CURVE25519_P;
  return r >= 0n ? r : r + CURVE25519_P;
}

function modPowP(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = modP(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % CURVE25519_P;
    b = (b * b) % CURVE25519_P;
    e >>= 1n;
  }
  return result;
}

/**
 * Unclamped Montgomery ladder scalar multiplication on Curve25519.
 */
export function curve25519Mul(scalar: bigint, uCoord: bigint): bigint {
  if (scalar <= 0n) return 0n;
  const x1 = modP(uCoord);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0n;

  const bitLength = scalar.toString(2).length;
  for (let t = bitLength - 1; t >= 0; t--) {
    const kt = (scalar >> BigInt(t)) & 1n;
    swap ^= kt;
    if (swap) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = kt;

    const a = modP(x2 + z2);
    const aa = modP(a * a);
    const b = modP(x2 - z2);
    const bb = modP(b * b);
    const e = modP(aa - bb);
    const c = modP(x3 + z3);
    const d = modP(x3 - z3);
    const da = modP(d * a);
    const cb = modP(c * b);
    const sum = modP(da + cb);
    const diff = modP(da - cb);

    x3 = modP(sum * sum);
    z3 = modP(x1 * modP(diff * diff));
    x2 = modP(aa * bb);
    z2 = modP(e * modP(aa + modP(CURVE25519_A24 * e)));
  }

  if (swap) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }
  if (z2 === 0n) return 0n;
  return modP(x2 * modPowP(z2, CURVE25519_P - 2n));
}

/**
 * Generate an ephemeral Curve25519 client keypair and derive the 32-byte AES-256-GCM
 * shared secret against the CPE's `ecc_server_pubkey`.
 */
export function generateEccSession(serverPubHex: string): EccSessionKeys {
  if (!serverPubHex || !/^[0-9a-fA-F]{1,64}$/.test(serverPubHex)) {
    throw new Error("Invalid CPE ECC server public key");
  }
  const serverU = BigInt(`0x${serverPubHex}`);
  if (serverU <= 1n) {
    throw new Error("Rejected weak CPE ECC server public key");
  }

  for (let attempt = 0; attempt < 64; attempt++) {
    const privBytes = crypto.randomBytes(32);
    privBytes[0] = (privBytes[0]! & 0x0f) | 0x08;
    const priv = BigInt(`0x${privBytes.toString("hex")}`);
    const clientPub = curve25519Mul(priv, 9n);
    const shared = curve25519Mul(priv, serverU);
    const clientPubHex = clientPub.toString(16);
    const shareKeyHex = shared.toString(16);

    if (clientPubHex.length === 64 && shareKeyHex.length === 64) {
      return {
        clientPubHex,
        shareKeyHex,
        privateHex: priv.toString(16),
      };
    }
  }
  throw new Error("Failed to generate 64-hex Curve25519 session key");
}

/**
 * Compute Huawei's SCRAM-SHA256 client proof and expected server signature.
 * Note: Huawei WebUI passes `authMessage` as the HMAC key and `storedKey`/`serverKey` as the message.
 */
export function computeScram(
  password: string,
  saltHex: string,
  iterations: number,
  firstNonce: string,
  serverNonce: string
): ScramProof {
  if (!/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
    throw new Error("Invalid SCRAM salt hex");
  }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 1_000_000) {
    throw new Error("Invalid SCRAM iteration count");
  }
  const pwdBytes = Buffer.from(password, "latin1");
  const saltBytes = Buffer.from(saltHex, "hex");
  const saltedPwd = crypto.pbkdf2Sync(pwdBytes, saltBytes, iterations, 32, "sha256");

  const clientKey = crypto
    .createHmac("sha256", Buffer.from("Client Key", "utf8"))
    .update(saltedPwd)
    .digest();
  const serverKey = crypto
    .createHmac("sha256", Buffer.from("Server Key", "utf8"))
    .update(saltedPwd)
    .digest();
  const storedKey = crypto.createHash("sha256").update(clientKey).digest();

  const authMessage = Buffer.from(`${firstNonce},${serverNonce},${serverNonce}`, "utf8");
  const clientSignature = crypto.createHmac("sha256", authMessage).update(storedKey).digest();

  const clientProof = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    clientProof[i] = clientKey[i]! ^ clientSignature[i]!;
  }

  const expectedServerSig = crypto
    .createHmac("sha256", authMessage)
    .update(serverKey)
    .digest("hex");

  return {
    clientProofHex: clientProof.toString("hex"),
    expectedServerSig,
    serverKey,
  };
}

/**
 * Verify `ecc_pubkey_signature` returned by `authentication_login` against `serverKey`
 * in constant time to prevent MITM substitution of the ECDH public key.
 */
export function verifyPubkeySignature(
  pubkeyHex: string,
  serverKeyBytes: Buffer,
  expectedSignatureHex: string
): boolean {
  if (!pubkeyHex || !expectedSignatureHex || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) {
    return false;
  }
  const paddedPub = pubkeyHex.length % 2 === 0 ? pubkeyHex : `0${pubkeyHex}`;
  const computed = crypto
    .createHmac("sha256", serverKeyBytes)
    .update(Buffer.from(paddedPub, "hex"))
    .digest("hex");
  return timingSafeEqualString(computed, expectedSignatureHex.toLowerCase());
}

/**
 * Constant-time string comparison via SHA-256 digest equality (immune to length side-channels).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB) && a.length === b.length;
}

/**
 * Encrypt UTF-8 XML payload using H168-383 AES-256-GCM wire format:
 * `[8-hex uint32_le(utf8_byte_len)] + [24-hex 12B IV] + [32-hex 16B GCM Tag] + [Ciphertext Hex]`
 * with `AAD = 16 zero bytes`.
 */
export function aesGcmEncrypt(
  plainText: string,
  shareKeyHex: string,
  ivBytes: Buffer = crypto.randomBytes(12)
): string {
  if (!plainText) return "";
  const key = Buffer.from(shareKeyHex, "hex");
  const utf8 = Buffer.from(plainText, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(utf8.length, 0);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, ivBytes);
  cipher.setAAD(Buffer.alloc(16, 0));
  const encrypted = Buffer.concat([cipher.update(utf8), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return (
    lenBuf.toString("hex") +
    ivBytes.toString("hex") +
    authTag.toString("hex") +
    encrypted.toString("hex")
  );
}

/**
 * Decrypt H168-383 AES-256-GCM hex payload back into UTF-8 XML starting at `<response>` or `<error>`.
 */
export function aesGcmDecrypt(hexPayload: string, shareKeyHex: string): string {
  const cleanHex = (hexPayload || "").trim();
  if (cleanHex.length < 64 || cleanHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(cleanHex)) {
    throw new Error(`Invalid AES-GCM hex payload (len=${cleanHex.length})`);
  }
  const key = Buffer.from(shareKeyHex, "hex");
  const expectedByteLen = Buffer.from(cleanHex.slice(0, 8), "hex").readUInt32LE(0);
  const iv = Buffer.from(cleanHex.slice(8, 32), "hex");
  const authTag = Buffer.from(cleanHex.slice(32, 64), "hex");
  const ciphertext = Buffer.from(cleanHex.slice(64), "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.alloc(16, 0));
  decipher.setAuthTag(authTag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const sliced =
    expectedByteLen > 0 && expectedByteLen <= plainBuf.length
      ? plainBuf.subarray(0, expectedByteLen)
      : plainBuf;
  const decoded = sliced.toString("utf8");

  const respIdx = decoded.indexOf("<response>");
  if (respIdx >= 0) return decoded.slice(respIdx);
  const errIdx = decoded.indexOf("<error>");
  if (errIdx >= 0) return decoded.slice(errIdx);
  return decoded;
}

const XSS_ENCODE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "'": "&#39;",
  '"': "&quot;",
  "<": "&lt;",
  ">": "&gt;",
  "/": "&#x2F;",
  "(": "&#40;",
  ")": "&#41;",
};

const XSS_DECODE_MAP: Readonly<Record<string, string>> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&#39;": "'",
  "&quot;": '"',
  "&#x2F;": "/",
  "&#x2f;": "/",
  "&#40;": "(",
  "&#41;": ")",
  "&apos;": "'",
};

/**
 * Encode text with Huawei WebUI's exact `xss()` escaping (`main_crypto.js`).
 */
export function huaweiXssEncode(input: string | number): string {
  if (typeof input === "number") return String(input);
  return input.replace(/[&'"<>/()]/g, (ch) => XSS_ENCODE_MAP[ch] ?? ch);
}

/**
 * Decode Huawei XML/XSS entities back to plain text.
 */
export function huaweiXssDecode(input: string): string {
  if (!input) return "";
  return input.replace(
    /(&lt;|&gt;|&amp;|&#39;|&quot;|&#x2F;|&#x2f;|&#40;|&#41;|&apos;|&#(\d{1,7});|&#x([0-9a-fA-F]{1,6});)/g,
    (full: string, _entity: string, dec?: string, hex?: string) => {
      if (XSS_DECODE_MAP[full]) return XSS_DECODE_MAP[full]!;
      if (dec) {
        const cp = Number.parseInt(dec, 10);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
      }
      if (hex) {
        const cp = Number.parseInt(hex, 16);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : full;
      }
      return full;
    }
  );
}

/**
 * Strip invalid ASCII control chars except `\t`, `\n`, `\r`.
 */
export function stripInvalidControlChars(text: string): string {
  if (!text) return "";
  return text.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, "");
}
