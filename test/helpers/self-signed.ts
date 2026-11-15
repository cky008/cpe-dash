import crypto from "node:crypto";

/**
 * A certificate signed with its own key, made when a test asks for one: what a router's HTTPS page
 * presents. Built here from its ASN.1 parts (X.509 v1 fields under a v3 header, ECDSA on P-256) so
 * that no key ever sits in the repository; the key pair lives for the test alone.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const length = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const arc of rest) {
    const digits = [arc & 0x7f];
    for (let left = arc >> 7; left > 0; left >>= 7) digits.unshift((left & 0x7f) | 0x80);
    bytes.push(...digits);
  }
  return der(0x06, Buffer.from(bytes));
}

function integer(bytes: Buffer): Buffer {
  return der(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

/** `YYMMDDHHMMSSZ`. */
function utcTime(date: Date): Buffer {
  return der(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`, "ascii"));
}

export interface SelfSigned {
  /** PEM, for a TLS server. */
  cert: string;
  key: string;
  /** The SHA-256 of the certificate: 64 hexadecimal digits, upper case. */
  fingerprint256: string;
}

export function selfSignedCertificate(commonName = "router.example", opts: { notBefore?: Date; notAfter?: Date } = {}): SelfSigned {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const name = sequence(der(0x31, sequence(oid("2.5.4.3"), der(0x0c, Buffer.from(commonName, "utf8")))));
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(8)),
    ecdsaWithSha256,
    name,
    sequence(utcTime(opts.notBefore ?? new Date(Date.now() - 86_400_000)), utcTime(opts.notAfter ?? new Date(Date.now() + 365 * 86_400_000))),
    name,
    publicKey.export({ type: "spki", format: "der" })
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").match(/.{1,64}/g) ?? [];
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    fingerprint256: crypto.createHash("sha256").update(certificate).digest("hex").toUpperCase(),
  };
}
