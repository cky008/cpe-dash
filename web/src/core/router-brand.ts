import type { ConsoleSettingsResponse } from "../../../src/api-contract.ts";
import type { DeviceFeature } from "../../../src/features.ts";
import { FAMILY_AUTO, ROUTER_FAMILIES, ROUTER_FAMILY_FACTS, ROUTER_FAMILY_LABELS, type RouterFamily, type RouterFamilyChoice, familyFeatures, isDriverFamily, routerFamilyOf } from "../../../src/router-family.ts";
import { formatFingerprint } from "../../../src/router-trust.ts";
import type { ConnectionTestResult } from "../../../src/scheduler.ts";
import type { ConnectionInput } from "./endpoints.ts";
import type { Locale } from "./i18n.ts";

/**
 * The router's brand in Settings → Router, decided without the DOM: the choices (FengSui telling the
 * brand itself comes first), what changes in the form when the brand does, and what the form sends.
 */

/** The router form as typed: it survives re-renders, tab switches and failed tests. */
export interface RouterDraft {
  brand: RouterFamilyChoice;
  url: string;
  username: string;
  password: string;
  lastAttempt: boolean;
  /** The certificate its owner chose to trust in this form (`null`: none chosen; the stored one still counts for the stored address). */
  certFingerprint: string | null;
}

type StoredConnection = NonNullable<ConsoleSettingsResponse["cpe"]>;

/** The address a brand's routers usually have (the verified router's while the brand is not known). */
export function usualAddress(brand: RouterFamilyChoice): string {
  return `http://${ROUTER_FAMILY_FACTS[brand === FAMILY_AUTO ? "huawei" : brand].defaultAddress}`;
}

function usualUsername(brand: RouterFamilyChoice): string {
  return brand === FAMILY_AUTO ? "" : ROUTER_FAMILY_FACTS[brand].defaultUsername;
}

/** The brand's name as the console shows it. */
export function brandLabel(family: RouterFamily, locale: Locale): string {
  return ROUTER_FAMILY_LABELS[family][locale];
}

/** The brand field's choices: detection first, then every brand in the order the daemon lists them. */
export function brandOptions(locale: Locale, autoLabel: string): Array<{ value: RouterFamilyChoice; label: string }> {
  return [{ value: FAMILY_AUTO, label: autoLabel }, ...ROUTER_FAMILIES.map((family) => ({ value: family, label: brandLabel(family, locale) }))];
}

/** A brand the field can hold (what a `<select>` hands back is text). */
export function brandOf(value: string): RouterFamilyChoice {
  return value === FAMILY_AUTO ? FAMILY_AUTO : routerFamilyOf(value);
}

/** The form for the stored connection, or a first one: the brand left to FengSui, the verified router's usual address. */
export function draftOf(stored: ConsoleSettingsResponse["cpe"]): RouterDraft {
  if (!stored) return { brand: FAMILY_AUTO, url: usualAddress(FAMILY_AUTO), username: "", password: "", lastAttempt: false, certFingerprint: null };
  return { brand: routerFamilyOf(stored.family), url: stored.url, username: stored.username, password: "", lastAttempt: false, certFingerprint: null };
}

/**
 * The form after its brand changed: an address or a user name still at the old brand's usual value
 * follows the new brand; anything typed stays. The password stays as well (it is the owner's).
 */
export function switchBrand(draft: RouterDraft, next: RouterFamilyChoice): RouterDraft {
  const url = draft.url.trim();
  const username = draft.username.trim();
  return {
    ...draft,
    brand: next,
    url: url === "" || url === usualAddress(draft.brand) ? usualAddress(next) : draft.url,
    username: username === "" || username === usualUsername(draft.brand) ? usualUsername(next) : draft.username,
    lastAttempt: false,
    // Another brand is another router: a certificate is trusted for one router
    certFingerprint: null,
  };
}

/** The brand's own page asks for a user name (ZTE's asks for a password only; unknown brands may). */
export function asksUsername(brand: RouterFamilyChoice): boolean {
  return brand === FAMILY_AUTO || ROUTER_FAMILY_FACTS[brand].defaultUsername !== "";
}

/**
 * What a test or save sends. A user name left empty is left out, so the daemon uses the stored one
 * for the stored brand or the brand's usual one (what detection needs: the brand is not known yet);
 * a brand that signs in with a password only sends none.
 */
export function connectionBody(draft: RouterDraft): ConnectionInput {
  const username = draft.username.trim();
  return {
    url: draft.url.trim(),
    family: draft.brand,
    ...(!asksUsername(draft.brand) ? { username: "" } : username ? { username } : {}),
    ...(draft.password ? { password: draft.password } : {}),
    ...(draft.lastAttempt ? { lastAttempt: true } : {}),
    ...(draft.certFingerprint ? { certFingerprint: draft.certFingerprint } : {}),
  };
}

/** A certificate for the owner to compare with the router's own page: its fingerprint in pairs, its name, how long it is valid. */
export interface CertificateOffer {
  fingerprint256: string;
  shown: string;
  subject: string | null;
  validTo: string | null;
}

/**
 * The certificate a failed test hands back for its owner to trust: the router's HTTPS page presents
 * one nothing vouches for, or another one than the one trusted before. `null`: nothing to decide.
 */
export function certificateOffer(result: ConnectionTestResult | null): CertificateOffer | null {
  if (!result || result.ok || (result.reason !== "untrusted_certificate" && result.reason !== "certificate_changed") || !result.certificate) return null;
  const { fingerprint256, subject, validTo } = result.certificate;
  return { fingerprint256, shown: formatFingerprint(fingerprint256), subject, validTo: validTo === null ? null : validTo.slice(0, 10) };
}

/** The form still shows the stored connection, nothing typed: what a review confirms as it is. */
export function showsStored(draft: RouterDraft, stored: ConsoleSettingsResponse["cpe"]): stored is StoredConnection {
  return stored !== null && draft.brand === routerFamilyOf(stored.family) && draft.url.trim() === stored.url && draft.username.trim() === stored.username && draft.password === "";
}

/**
 * What to say under the brand field: how detection works, or, for a brand FengSui was never run on,
 * what FengSui reads and changes there, taken from the brand's facts (its own form of the interface;
 * a model that speaks another form may do less, which Settings → Device shows once connected).
 * Nothing for the brand of the verified router.
 */
export function brandNote(brand: RouterFamilyChoice): { key: "brand_auto_hint" } | { key: "brand_note"; reads: DeviceFeature[]; writes: DeviceFeature[] } | null {
  if (brand === FAMILY_AUTO) return { key: "brand_auto_hint" };
  if (!isDriverFamily(brand)) return null;
  const features = familyFeatures(brand);
  const named = (access: "read" | "write"): DeviceFeature[] => features.filter((entry) => entry.access === access).map((entry) => entry.feature);
  return { key: "brand_note", reads: named("read"), writes: named("write") };
}
