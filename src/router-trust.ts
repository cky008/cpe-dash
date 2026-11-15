/**
 * A router whose own page is HTTPS only usually presents a certificate it signed itself: no
 * certificate authority vouches for it, so the usual verification refuses the connection. Its owner
 * can tell FengSui to trust exactly that certificate: FengSui keeps its SHA-256 fingerprint with the
 * connection and from then on talks to the router only while it presents the same one. Zero
 * dependencies: the daemon, the console and the live demo share these shapes; the TLS itself is in
 * `src/pinned-fetch.ts`.
 */

/** What a router's certificate says of itself, for its owner to compare with the router's own page. Names and dates, never a key. */
export interface RouterCertificate {
  /** The SHA-256 of the certificate: 64 hexadecimal digits, upper case. */
  fingerprint256: string;
  subject: string | null;
  issuer: string | null;
  /** ISO 8601 (`null`: not readable). */
  validFrom: string | null;
  validTo: string | null;
  /** This machine's certificate authorities vouch for it, for this address: nothing to trust by hand. */
  trusted: boolean;
}

/** A fingerprint as FengSui keeps it (64 hexadecimal digits, upper case), from however it was typed or stored; `null`: not one. */
export function normalizeFingerprint(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const hex = value.replace(/[:\s]/g, "").toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex : null;
}

/** A fingerprint as a person compares it: pairs of digits joined by colons. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{2}/g) ?? []).join(":");
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The certificates the daemon trusts by fingerprint, by the router's origin: the one of the router in
 * use, and for the length of a connection test the one being tried. The request function asks it for
 * every HTTPS request (`fingerprintFor`); an origin it does not name gets the usual verification.
 */
export class CertificateTrust {
  #origin: string | null = null;
  #fingerprint: string | null = null;
  #trial: { origin: string; fingerprint: string | null } | null = null;

  /** The router in use: `fingerprint` is the certificate trusted for it (`null`, or an address that is not HTTPS: none). */
  use(url: string, fingerprint: string | null): void {
    const origin = originOf(url);
    this.#origin = origin !== null && fingerprint !== null ? origin : null;
    this.#fingerprint = this.#origin === null ? null : fingerprint;
  }

  /** The fingerprint a request to `origin` must meet (`null`: the usual verification). */
  fingerprintFor(origin: string): string | null {
    if (this.#trial !== null && this.#trial.origin === origin) return this.#trial.fingerprint;
    return this.#origin === origin ? this.#fingerprint : null;
  }

  /**
   * Run a connection test with the candidate's own trust: `fingerprint` for its address (`null`: the
   * usual verification, even where the router in use is trusted by fingerprint). Tests run one at a
   * time, between two sessions, so nothing else sees it.
   */
  async during<T>(url: string, fingerprint: string | null, run: () => Promise<T>): Promise<T> {
    const origin = originOf(url);
    if (origin === null) return await run();
    const before = this.#trial;
    this.#trial = { origin, fingerprint };
    try {
      return await run();
    } finally {
      this.#trial = before;
    }
  }
}
