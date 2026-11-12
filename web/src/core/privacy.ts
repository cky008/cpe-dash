import {
  ICCID_VISIBLE_DIGITS,
  IMEI_VISIBLE_DIGITS,
  IMSI_VISIBLE_DIGITS,
  maskIdentityDigits,
  maskIpAddress,
  maskMacTail,
  maskPhoneNumber,
} from "../../../src/privacy-mask.ts";

/**
 * Display-side privacy mode (anti-screenshot). It uses the daemon's own masks (src/privacy-mask.ts),
 * so a value masked in the browser reads exactly like the REDACT_SENSITIVE_IN_API copies that Bearer
 * API and MCP clients receive; the web console itself always gets the plain values to reveal.
 */

export type SensitiveKind = "imei" | "imsi" | "iccid" | "phone" | "mac" | "ip" | "cell" | "otp";

export function maskValue(kind: SensitiveKind, value: string): string {
  const clean = value.trim();
  if (!clean) return "";
  switch (kind) {
    case "imei":
      return maskIdentityDigits(clean, IMEI_VISIBLE_DIGITS);
    case "imsi":
      return maskIdentityDigits(clean, IMSI_VISIBLE_DIGITS);
    case "iccid":
      return maskIdentityDigits(clean, ICCID_VISIBLE_DIGITS);
    case "phone":
      return maskPhoneNumber(clean);
    case "mac":
      return maskMacTail(clean);
    case "ip":
      return maskIpAddress(clean);
    case "cell":
      // Location fingerprints (TAC, Cell ID, eNodeB): no part of them is anonymous
      return "*".repeat(Math.min(Math.max(clean.length, 4), 10));
    case "otp":
      return "•".repeat(Math.min(Math.max(clean.length, 4), 8));
  }
}

/** Value to show: masked when `masked`, otherwise as received. */
export function displayValue(kind: SensitiveKind, value: string, masked: boolean): string {
  return masked ? maskValue(kind, value) : value;
}

/** Hide every occurrence of a verification code inside a message body. */
export function maskCodeInText(text: string, code: string | null): string {
  if (!code || code.length < 3) return text;
  return text.split(code).join("•".repeat(code.length));
}

/**
 * Per-card overrides on top of one global mode: the header switch sets everything, and a card's
 * eye button flips only that card until the global mode changes again.
 */
export class PrivacyState {
  #globalMasked: boolean;
  readonly #overrides = new Map<string, boolean>();
  readonly #listeners = new Set<() => void>();

  constructor(globalMasked = true) {
    this.#globalMasked = globalMasked;
  }

  get globalMasked(): boolean {
    return this.#globalMasked;
  }

  isMasked(scope: string): boolean {
    return this.#overrides.get(scope) ?? this.#globalMasked;
  }

  setGlobal(masked: boolean): void {
    this.#globalMasked = masked;
    this.#overrides.clear();
    this.#notify();
  }

  toggleScope(scope: string): void {
    this.#overrides.set(scope, !this.isMasked(scope));
    this.#notify();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
