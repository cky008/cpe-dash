import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CpeLoginMethodError, encodeLegacyPassword, planLogin, readScramChallenge, readSesTokInfo } from "../src/protocols/hilink/auth.ts";
import { computeScram } from "../src/protocols/hilink/crypto.ts";
import { isResponseDocument } from "../src/device-profile.ts";
import type { LoginMethodError } from "../src/session-errors.ts";

/**
 * The login-method decisions and encodings on their own. Known-answer vectors: inputs from the
 * reference project's tests, outputs computed independently (Python's hashlib and `shasum`), see
 * docs/dev/protocol.md appendix A.8.
 */

describe("login method plan", () => {
  it("probes SCRAM before any password and falls back only where the router's password_type allows", () => {
    assert.deepEqual(planLogin("4", { scramKnown: false }), { probeScram: true, legacy: { scheme: "sha256", passwordType: "4" } });
    assert.deepEqual(planLogin("0", { scramKnown: false }), { probeScram: false, legacy: { scheme: "base64", passwordType: "0" } });
    assert.deepEqual(planLogin("3", { scramKnown: false }), { probeScram: false, legacy: { scheme: "base64", passwordType: "3" } });
    for (const unknown of [null, "", "1", "2", "5", "04", " 4"]) {
      assert.deepEqual(planLogin(unknown, { scramKnown: false }), { probeScram: true, legacy: null }, `password_type ${String(unknown)}: no guessed legacy method`);
    }
    for (const any of [null, "0", "3", "4", "9"]) {
      assert.deepEqual(planLogin(any, { scramKnown: true }), { probeScram: true, legacy: null }, `a router known to use SCRAM never gets a legacy password (${String(any)})`);
    }
  });
});

describe("password encodings and SCRAM known answers", () => {
  it("encodes user/login passwords like appendix A.8", () => {
    assert.equal(encodeLegacyPassword("base64", "admin", "secret", "csrf-token"), "c2VjcmV0");
    assert.equal(
      encodeLegacyPassword("sha256", "admin", "secret", "csrf-token"),
      "ODNiZmIxMzRiYWJjNjJlMDY3ZGE2NGJmNWRmYjg4ODllNTFiNzJmOTU3NzViMjQ4YWNiZWEzNGU3MjM1OTU0ZQ=="
    );
    assert.notEqual(encodeLegacyPassword("sha256", "admin", "secret", "other-token"), encodeLegacyPassword("sha256", "admin", "secret", "csrf-token"), "the hash binds the token");
    assert.equal(encodeLegacyPassword("base64", "admin", "pässwörd", "t"), Buffer.from("pässwörd", "utf8").toString("base64"), "UTF-8, like the reference");
  });

  it("matches the SCRAM vector and differs from RFC 5802's argument order", () => {
    const scram = computeScram("s3cret", "6b1e6a6c3b0f4a2e9d8c7b6a5f4e3d2c1b0a99887766554433221100ffeeddcc", 100, "a".repeat(64), `${"a".repeat(64)}bcdef0123456789`);
    assert.equal(scram.clientProofHex, "ec838a9f3cdf1fe7712471926ee115da4701a9f3f0af64529d77eacc9bf6b08a");
    assert.equal(scram.expectedServerSig, "d667a5114dae06ef567123b1fe2436b95f62fd52b3427635548ad69917cb3537");
    assert.notEqual(scram.clientProofHex, "93553f268fba24d183e007680e604512bc3d987e2e868797eca3e63b57f4a7e4", "the device rejects the RFC order");
  });
});

describe("router answers", () => {
  it("reads a SCRAM challenge, tells a router answer without one from something else", () => {
    assert.deepEqual(readScramChallenge("<response><salt>0102</salt><iterations>100</iterations><servernonce>ab</servernonce><modeselected>1</modeselected></response>"), {
      salt: "0102",
      iterations: 100,
      serverNonce: "ab",
    });
    for (const notChallenge of ["<response/>", "<response>OK</response>", '<?xml version="1.0" encoding="UTF-8"?>\n<response><salt>01</salt><iterations>100</iterations></response>', "<response><salt></salt><iterations>1</iterations><servernonce>a</servernonce></response>"]) {
      assert.equal(readScramChallenge(notChallenge), null, notChallenge);
      assert.equal(isResponseDocument(notChallenge), true, notChallenge);
    }
    for (const foreign of ["", "OK", "<!DOCTYPE html><html><body>login</body></html>", "<html><response/></html>", "<responses/>", "<error><code>100002</code></error>", '{"response":{}}']) {
      assert.equal(isResponseDocument(foreign), false, foreign);
    }
  });

  it("reads SesTokInfo: the token, and the session cookie only when it is one", () => {
    assert.deepEqual(readSesTokInfo("<response><SesInfo>SessionID=abc123</SesInfo><TokInfo>tok-0001</TokInfo></response>"), {
      token: "tok-0001",
      sessionCookie: { name: "SessionID", value: "abc123" },
    });
    assert.deepEqual(readSesTokInfo("<response><TokInfo>tok-0001</TokInfo></response>"), { token: "tok-0001", sessionCookie: null });
    for (const odd of ["SessionID", "=abc", "Session ID=abc", "SessionID=a b", "SessionID=a;b", "x=\u0001"]) {
      assert.equal(readSesTokInfo(`<response><SesInfo>${odd}</SesInfo><TokInfo>t</TokInfo></response>`)?.sessionCookie ?? null, null, odd);
    }
    for (const missing of ["<response><SesInfo>SessionID=a</SesInfo></response>", "<response><TokInfo></TokInfo></response>", "<response><TokInfo>a b</TokInfo></response>", "<html/>"]) {
      assert.equal(readSesTokInfo(missing), null, missing);
    }
  });

  it("names why no password was sent", () => {
    const err = new CpeLoginMethodError("7", "100002");
    assert.equal(err.name, "CpeLoginMethodError");
    assert.deepEqual([err.passwordType, err.probeCode], ["7", "100002"]);
    assert.match(err.message, /password_type=7/);
    assert.match(err.message, /no password was sent/);
    assert.match(new CpeLoginMethodError(null, null).message, /password_type missing/);
    // What the scheduler reads of it, as of every brand's: the refusing code, and whether SCRAM was known before
    const known: LoginMethodError = new CpeLoginMethodError("4", "100003", { scramKnown: true });
    assert.deepEqual([err.refusalCode, err.refusesKnownMethod, known.refusalCode, known.refusesKnownMethod], ["100002", false, "100003", true]);
  });
});
