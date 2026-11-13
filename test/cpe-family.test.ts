import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { computeScram } from "../src/protocols/hilink/crypto.ts";
import { getXmlTag } from "../src/protocols/hilink/xml.ts";
import { type CpeFamilyOptions, FAMILY_LOGINS, FAMILY_TOKEN_FLOWS, blockNetwork, createCpeFamily, familyLegacyPassword } from "./helpers/cpe-family.ts";

/**
 * The mock router family itself, driven with hand-built requests (not FengSui's client): the login
 * tests can only trust what they assert if the mock is as strict as the facts it models.
 */

const BASE = "http://192.168.8.1";

/** A bare HTTP conversation with one mock: cookies and the token pool kept by hand. */
function wire(opts: CpeFamilyOptions) {
  const cpe = createCpeFamily(opts);
  let cookie = "";
  const tokens: string[] = [];
  const send = async (method: "GET" | "POST", p: string, body = "", extra: Record<string, string> = {}): Promise<{ text: string; headers: Headers }> => {
    const headers: Record<string, string> = { ...extra };
    if (cookie) headers["Cookie"] = cookie;
    const res = await cpe.fetchImpl(`${BASE}${p}`, { method, headers, body: method === "POST" ? body : undefined });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0] ?? "";
    // Like FengSui's client, a login answer replaces the whole token pool
    if (p.startsWith("/api/user/") && p !== "/api/user/state-login") tokens.length = 0;
    for (const name of ["__requestverificationtokenone", "__requestverificationtokentwo", "__requestverificationtoken"]) {
      const value = res.headers.get(name);
      if (value) tokens.push(value);
    }
    return { text: await res.text(), headers: res.headers };
  };
  /** The token flow's first token, and the session cookie it comes with. */
  const bootstrap = async (): Promise<void> => {
    await send("GET", "/api/monitoring/status", "", { "Update-Cookie": "UpdateCookie" });
    if (opts.tokenFlow === "token") {
      const token = getXmlTag((await send("GET", "/api/webserver/token")).text, "token");
      if (token) tokens.push(token);
    } else {
      const info = (await send("GET", "/api/webserver/SesTokInfo")).text;
      cookie = getXmlTag(info, "SesInfo") ?? "";
      tokens.push(getXmlTag(info, "TokInfo") ?? "");
    }
  };
  const post = (p: string, body: string, token = tokens.shift() ?? "") => send("POST", p, body, { __RequestVerificationToken: token });
  /** One password submission the way the mock's own method wants it. */
  const submit = async (pw: string): Promise<string> => {
    if (opts.login === "sha256" || opts.login === "base64") {
      const token = tokens.shift() ?? "";
      const type = opts.login === "sha256" ? "4" : "0";
      return (await post("/api/user/login", `<request><Username>admin</Username><Password>${familyLegacyPassword(opts.login, "admin", pw, token)}</Password><password_type>${type}</password_type></request>`, token)).text;
    }
    const firstNonce = crypto.randomBytes(32).toString("hex");
    const challenge = (await post("/api/user/challenge_login", `<request><username>admin</username><firstnonce>${firstNonce}</firstnonce><mode>1</mode></request>`)).text;
    const serverNonce = getXmlTag(challenge, "servernonce") ?? "";
    const proof = computeScram(pw, getXmlTag(challenge, "salt") ?? "", Number(getXmlTag(challenge, "iterations")), firstNonce, serverNonce).clientProofHex;
    return (await post("/api/user/authentication_login", `<request><clientproof>${proof}</clientproof><finalnonce>${serverNonce}</finalnonce></request>`)).text;
  };
  return { cpe, send, post, bootstrap, submit, tokens };
}

const code = (xml: string): string | null => getXmlTag(xml, "code");

describe("mock router family", () => {
  let restoreNetwork: () => void = () => undefined;
  before(() => {
    restoreNetwork = blockNetwork();
  });
  after(() => restoreNetwork());

  it("logs in every method and token flow, serves one read and logs out", async () => {
    for (const login of FAMILY_LOGINS) {
      for (const tokenFlow of FAMILY_TOKEN_FLOWS) {
        const label = `${login} × ${tokenFlow}`;
        const w = wire({ login, tokenFlow });
        await w.bootstrap();
        const answer = await w.submit(w.cpe.password);
        assert.equal(code(answer), null, `${label}: ${answer}`);
        assert.ok(w.cpe.isSlotTaken(), label);
        assert.equal(getXmlTag((await w.send("GET", "/api/device/information")).text, "DeviceName"), "H122-373", label);
        assert.equal(code((await w.post("/api/user/logout", "<request><Logout>1</Logout></request>")).text), null, label);
        assert.deepEqual([w.cpe.isSlotTaken(), w.cpe.stats.logins, w.cpe.stats.logouts, w.cpe.stats.passwordSubmissions], [false, 1, 1, 1], label);
        assert.equal(answer.includes("ecc_server_pubkey"), login === "scram-ecc", `${label}: ECC only on scram-ecc`);
      }
    }
  });

  it("counts wrong passwords and locks at the third; the SCRAM probe never counts", async () => {
    for (const login of FAMILY_LOGINS) {
      const w = wire({ login, tokenFlow: "token" });
      // Each attempt as a session of its own: a refused login hands out no token
      const attempt = async (pw: string): Promise<string> => {
        await w.bootstrap();
        return await w.submit(pw);
      };
      assert.deepEqual([code(await attempt("wrong one")), getXmlTag(await attempt("wrong two"), "remaincount")], ["108006", "1"], login);
      assert.equal(code(await attempt("wrong three")), "108007", login);
      assert.equal(w.cpe.isLocked(), true, login);
      assert.equal(getXmlTag((await w.send("GET", "/api/user/state-login")).text, "lockstatus"), "1", login);
      assert.equal(w.cpe.stats.passwordSubmissions, 3, login);
    }
    for (const scramProbe of ["100002", "100003", "not-a-challenge"] as const) {
      const w = wire({ login: "sha256", tokenFlow: "token", scramProbe });
      await w.bootstrap();
      const answer = (await w.post("/api/user/challenge_login", "<request><username>admin</username><firstnonce>00</firstnonce><mode>1</mode></request>")).text;
      assert.equal(code(answer), scramProbe === "not-a-challenge" ? null : scramProbe);
      assert.deepEqual([w.cpe.failedLogins(), w.cpe.stats.scramProbes, w.cpe.stats.passwordSubmissions], [0, 1, 0], scramProbe);
    }
  });

  it("rejects POSTs without a valid single-use token, reads without the admin session, and a second login", async () => {
    const w = wire({ login: "sha256", tokenFlow: "sestokinfo" });
    await w.bootstrap();
    const token = w.tokens[0] ?? "";
    assert.equal(code((await w.post("/api/net/reconnect", "<request/>", "not-a-token")).text), "125001");
    assert.equal(code((await w.send("GET", "/api/device/information")).text), "100003", "no admin session yet");
    assert.equal(code(await w.submit(w.cpe.password)), null);
    assert.equal(code((await w.post("/api/net/reconnect", "<request/>", token)).text), "125001", "a token is used up once spent");
    assert.equal(w.cpe.stats.tokenRejections, 2);

    const busy = wire({ login: "sha256", tokenFlow: "token" });
    busy.cpe.human.loginCrossIp();
    await busy.bootstrap();
    assert.equal(getXmlTag((await busy.send("GET", "/api/user/state-login")).text, "State"), "-1", "a browser on another IP stays invisible");
    assert.equal(code(await busy.submit(busy.cpe.password)), "108003", "one admin slot");
    busy.cpe.human.logout();
    busy.cpe.human.loginSameIp();
    assert.equal(getXmlTag((await busy.send("GET", "/api/user/state-login")).text, "State"), "0");
  });

  it("models the token flows, password_type and the optional endpoints", async () => {
    const token = createCpeFamily({ login: "scram", tokenFlow: "token" });
    assert.equal(code(await (await token.fetchImpl(`${BASE}/api/webserver/SesTokInfo`)).text()), "100002");
    const ses = createCpeFamily({ login: "base64", tokenFlow: "sestokinfo", passwordType: null, basicInformationPublic: false });
    assert.equal(code(await (await ses.fetchImpl(`${BASE}/api/webserver/token`)).text()), "100002");
    const info = await (await ses.fetchImpl(`${BASE}/api/webserver/SesTokInfo`)).text();
    assert.match(getXmlTag(info, "SesInfo") ?? "", /^SessionID=[0-9a-f]{24}$/);
    assert.equal(getXmlTag(await (await ses.fetchImpl(`${BASE}/api/user/state-login`)).text(), "password_type"), null);
    assert.equal(code(await (await ses.fetchImpl(`${BASE}/api/device/basic_information`)).text()), "100003");
    assert.equal(getXmlTag(await (await token.fetchImpl(`${BASE}/api/device/basic_information`)).text(), "devicename"), "H122-373");

    const w = wire({ login: "base64", tokenFlow: "token", rotateTokens: false, endpoints: { "/api/device/device-feature-switch": "<response><x>1</x></response>", "/api/system/devcapacity": { cpeError: "100003" } } });
    await w.bootstrap();
    const reusable = w.tokens[0] ?? "";
    assert.equal(code(await w.submit(w.cpe.password)), null);
    assert.equal(w.tokens.length, 0, "no token comes back when the router does not rotate them");
    const fresh = getXmlTag((await w.send("GET", "/api/webserver/token")).text, "token") ?? "";
    assert.equal(code((await w.post("/api/net/reconnect", "<request/>", fresh)).text), null);
    assert.equal(code((await w.post("/api/net/reconnect", "<request/>", fresh)).text), null, "and the same token stays valid");
    assert.equal(code((await w.post("/api/net/reconnect", "<request/>", reusable)).text), "125001", "tokens of the pre-login session do not carry over");
    assert.equal(getXmlTag((await w.send("GET", "/api/device/device-feature-switch")).text, "x"), "1");
    assert.equal(code((await w.send("GET", "/api/system/devcapacity")).text), "100003");
    assert.equal(code((await w.send("GET", "/api/global/module-switch")).text), "100002");
  });
});
