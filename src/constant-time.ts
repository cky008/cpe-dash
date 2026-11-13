import crypto from "node:crypto";

/**
 * Constant-time string comparison via SHA-256 digest equality (immune to length side-channels).
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const hashA = crypto.createHash("sha256").update(a, "utf8").digest();
  const hashB = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(hashA, hashB) && a.length === b.length;
}
