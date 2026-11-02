import crypto from "node:crypto";
import { isResponseDocument } from "./device-profile.ts";
import { getXmlTag } from "./xml.ts";

/**
 * How FengSui logs in to a Huawei router, decided before any password goes out (CONTEXT §7.3,
 * docs/PHASE1_PROTOCOL_SPEC.md appendix A.8–A.9). SCRAM is the H168-383's method; legacy
 * `user/login` with `password_type` 4 (SHA-256) or 0 / 3 (base64) comes from facts about other models
 * that no real device has confirmed yet. Each session submits the password once, with one method.
 */

export type LegacyScheme = "sha256" | "base64";

export interface LoginPlan {
  /** Send the SCRAM challenge first: username and a nonce, no password, no attempt spent. */
  probeScram: boolean;
  /** The `user/login` method for when SCRAM is not used; `null` means no password goes out without SCRAM. */
  legacy: { scheme: LegacyScheme; passwordType: "0" | "3" | "4" } | null;
}

/**
 * The plan for the `password_type` that `state-login` reported (`null` when it named none).
 * `scramKnown`: this router has logged in with SCRAM before, so a refused challenge is a fault, never
 * a reason to try a legacy method (a SCRAM-only router counts the legacy hash as a wrong password).
 */
export function planLogin(passwordType: string | null, opts: { scramKnown: boolean }): LoginPlan {
  if (opts.scramKnown) return { probeScram: true, legacy: null };
  if (passwordType === "4") return { probeScram: true, legacy: { scheme: "sha256", passwordType: "4" } };
  if (passwordType === "0" || passwordType === "3") return { probeScram: false, legacy: { scheme: "base64", passwordType } };
  return { probeScram: true, legacy: null };
}

/**
 * Answers to a legacy `user/login` that refuse it before the password is checked (system, token and
 * session errors, someone else logged in, too frequent): the next session may try again. Any other
 * code from a model nobody verified might have counted as a wrong attempt, so it latches the breaker.
 */
export const LEGACY_LOGIN_RETRY_SAFE_CODES: ReadonlySet<string> = new Set([
  "100002",
  "100003",
  "100004",
  "100005",
  "108003",
  "108005",
  "108009",
  "108010",
  "125001",
  "125002",
  "125003",
]);

/**
 * The breaker's code when a legacy `user/login` answer carried no error code and no `OK` (a page, an
 * empty, cut-off or oversized body): the router has the password and FengSui cannot tell what it made of it.
 */
export const LOGIN_UNCONFIRMED_CODE = "unconfirmed";

/** Error codes of a SCRAM challenge that mean "no SCRAM here" (appendix A.8); any other code is a login error. */
export const SCRAM_PROBE_FALLBACK_CODES: ReadonlySet<string> = new Set(["100002", "100003"]);

const sha256Hex = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** The `Password` field of `user/login`, bound to the token this very request carries (SHA-256). */
export function encodeLegacyPassword(scheme: LegacyScheme, username: string, password: string, token: string): string {
  if (scheme === "base64") return base64(password);
  return base64(sha256Hex(`${username}${base64(sha256Hex(password))}${token}`));
}

export interface ScramChallenge {
  salt: string;
  iterations: number;
  serverNonce: string;
}

/** The challenge in a `challenge_login` answer, or `null` when the answer has none of it complete. */
export function readScramChallenge(xml: string): ScramChallenge | null {
  const salt = getXmlTag(xml, "salt");
  const iterations = getXmlTag(xml, "iterations");
  const serverNonce = getXmlTag(xml, "servernonce");
  if (!salt || !iterations || !serverNonce) return null;
  return { salt, iterations: Number.parseInt(iterations, 10), serverNonce };
}

/** A router answer to the challenge that is not a challenge (`<response/>`, `<response>OK</response>`): no SCRAM. */
export function isNonChallengeAnswer(xml: string): boolean {
  return isResponseDocument(xml) && readScramChallenge(xml) === null;
}

const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const COOKIE_VALUE = /^[A-Za-z0-9!#$%&'()*+./:<=>?@[\]^_`{|}~-]{1,512}$/;
const TOKEN = /^[\x21-\x7e]{1,512}$/;

/**
 * `GET /api/webserver/SesTokInfo`: the token (`TokInfo`, used whole) and, when `SesInfo` is a plain
 * `name=value` cookie, the session cookie it names. `null` without a usable token.
 */
export function readSesTokInfo(xml: string): { token: string; sessionCookie: { name: string; value: string } | null } | null {
  const token = getXmlTag(xml, "TokInfo");
  if (!token || !TOKEN.test(token)) return null;
  const ses = getXmlTag(xml, "SesInfo") ?? "";
  const eq = ses.indexOf("=");
  const name = ses.slice(0, eq);
  const value = ses.slice(eq + 1);
  const sessionCookie = eq > 0 && COOKIE_NAME.test(name) && COOKIE_VALUE.test(value) ? { name, value } : null;
  return { token, sessionCookie };
}

/**
 * The router's login method is not one FengSui can tell without guessing: its `password_type` is
 * missing or unknown and it refused the SCRAM challenge, or (`scramKnown`) it logged in with SCRAM
 * before and now refuses the challenge the way an older model does. Nothing carrying the password
 * was sent: a SCRAM router counts a legacy hash as a wrong attempt.
 */
export class CpeLoginMethodError extends Error {
  readonly passwordType: string | null;
  /** The code that refused the SCRAM challenge; `null` when it answered with something else. */
  readonly probeCode: string | null;
  /** This router logged in with SCRAM before, so no legacy login was tried (`CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM`). */
  readonly scramKnown: boolean;

  constructor(passwordType: string | null, probeCode: string | null, opts: { scramKnown?: boolean } = {}) {
    const refused = `SCRAM challenge refused${probeCode ? ` with ${probeCode}` : ""}`;
    const type = passwordType === null ? "password_type missing" : `password_type=${passwordType}`;
    super(
      opts.scramKnown === true
        ? `Router logged in with SCRAM before (${refused}); no password was sent. Another model? See CPE_ALLOW_LEGACY_LOGIN_AFTER_SCRAM`
        : `Unsupported router login method (${type}, ${refused}): no password was sent`
    );
    this.name = "CpeLoginMethodError";
    this.passwordType = passwordType;
    this.probeCode = probeCode;
    this.scramKnown = opts.scramKnown === true;
  }
}
