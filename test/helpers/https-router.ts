import { CERTIFICATE_CHANGED } from "../../src/pinned-fetch.ts";
import { CertificateTrust, type RouterCertificate } from "../../src/router-trust.ts";

/**
 * A mock router put behind HTTPS with a certificate of its own, without any TLS: the request function
 * refuses, as the daemon's does, whenever the certificate the router "presents" is not the one
 * trusted for its origin, and the look at the certificate hands back what it presents. The TLS
 * itself is tested in pinned-fetch.test.ts.
 */
export function behindOwnCertificate(inner: typeof fetch, opts: { fingerprint: string; subject?: string; vouched?: boolean }) {
  const trust = new CertificateTrust();
  const presented = { fingerprint: opts.fingerprint };
  /** Every address whose certificate was looked at. */
  const peeks: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol === "https:") {
      const pinned = trust.fingerprintFor(url.origin);
      if (pinned === null && !opts.vouched) throw new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
      if (pinned !== null && pinned !== presented.fingerprint) throw new TypeError("fetch failed", { cause: Object.assign(new Error("another certificate"), { code: CERTIFICATE_CHANGED }) });
    }
    return inner(input, init);
  };
  const peekCertificate = async (url: string): Promise<RouterCertificate | null> => {
    peeks.push(url);
    if (!url.startsWith("https:")) return null;
    const name = opts.subject ?? "CN=OpenWrt";
    return { fingerprint256: presented.fingerprint, subject: name, issuer: name, validFrom: "2026-01-01T00:00:00.000Z", validTo: "2036-01-01T00:00:00.000Z", trusted: opts.vouched === true };
  };
  return { trust, presented, peeks, fetchImpl, peekCertificate };
}
