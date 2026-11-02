import crypto from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt, computeScram, curve25519Mul } from "../../src/crypto.ts";
import { getXmlTag } from "../../src/xml.ts";

/**
 * Strict mock routers for the Huawei models FengSui has NOT verified, built from the facts in
 * docs/PHASE1_PROTOCOL_SPEC.md appendix A (none of them checked on a real device). One factory, four
 * login methods and two token flows; the H168-383 itself stays modelled by `strict-cpe.ts`, the only
 * verified behaviour.
 *
 * What every variant enforces, like the firmware the facts describe:
 * - One admin slot: a login while any admin session is active gets `108003`.
 * - Session-bound CSRF tokens on every POST (`125001` otherwise); single-use unless `rotateTokens` is off.
 * - Authenticated endpoints need the active admin session's cookie (`100003`).
 * - Every password submission (`authentication_login` or `user/login`) counts: a wrong one answers
 *   `108006` with the attempts left, the third `108007`, and logins stay locked.
 * - The SCRAM challenge carries no password: refusing it never costs an attempt.
 *
 * All identifiers are RFC/test placeholders.
 */

export type FamilyLogin = "scram" | "scram-ecc" | "sha256" | "base64";
export type FamilyTokenFlow = "token" | "sestokinfo";
/** How a router without SCRAM answers `challenge_login`. */
export type ScramProbeAnswer = "100002" | "100003" | "not-a-challenge";

export const FAMILY_LOGINS: ReadonlyArray<FamilyLogin> = ["scram", "scram-ecc", "sha256", "base64"];
export const FAMILY_TOKEN_FLOWS: ReadonlyArray<FamilyTokenFlow> = ["token", "sestokinfo"];

export interface CpeFamilyOptions {
  login: FamilyLogin;
  tokenFlow: FamilyTokenFlow;
  password?: string;
  username?: string;
  /** `password_type` in `state-login`; `null` leaves the tag out. Default `0` for base64, `4` otherwise. */
  passwordType?: string | null;
  /** Default `100002`. */
  scramProbe?: ScramProbeAnswer;
  /** A refused SCRAM probe still carries a fresh token in its answer. Default `false`. */
  probeRotatesToken?: boolean;
  /** POST answers carry the next token; when off, tokens stay valid for the session and none come back. Default `true`. */
  rotateTokens?: boolean;
  /** `device/basic_information` answers without a login. Default `true`. */
  basicInformationPublic?: boolean;
  model?: string;
  firmware?: string;
  /** Extra GETs needing a login (feature switches, optional interfaces); unlisted ones answer `100002`. */
  endpoints?: Readonly<Record<string, string | { cpeError: string }>>;
  /** A wrong password's answer says how many attempts are left. Default `true`. */
  reportRemainCount?: boolean;
}

const SALT_HEX = "cd".repeat(32);
const ITERATIONS = 100;
const SERVER_ECC_PRIV = BigInt("0x0b223344556677889900aabbccddeeff00112233445566778899aabbccddeef3");
const SERVER_ECC_PUB = curve25519Mul(SERVER_ECC_PRIV, 9n).toString(16).padStart(64, "0");

const sha256Hex = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const base64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** `Password` of `user/login`, written from the appendix A.4 formula (not from any other code). */
export function familyLegacyPassword(login: "sha256" | "base64", username: string, password: string, token: string): string {
  return login === "sha256" ? base64(sha256Hex(`${username}${base64(sha256Hex(password))}${token}`)) : base64(password);
}

/** Install a global `fetch` that throws, so a test proves it never reaches a network; returns the undo. */
export function blockNetwork(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`network access attempted in a test: ${String(input)}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

interface AdminSession {
  sid: string;
  owner: "fengsui" | "human";
}

export function createCpeFamily(opts: CpeFamilyOptions) {
  const password = opts.password ?? "family_mock_password";
  const username = opts.username ?? "admin";
  const scram = opts.login === "scram" || opts.login === "scram-ecc";
  const passwordType = opts.passwordType === undefined ? (opts.login === "base64" ? "0" : "4") : opts.passwordType;
  const rotateTokens = opts.rotateTokens ?? true;
  const model = opts.model ?? "H122-373";
  const firmware = opts.firmware ?? "10.0.2.1(H195SP3C983)";
  let adminSession: AdminSession | null = null;
  let humanCrossIp = false;
  let failedLogins = 0;
  let locked = false;
  /** Every cookie session the router knows (pre-login and admin) with its valid tokens. */
  const sessions = new Map<string, Set<string>>();
  const pendingChallenges = new Map<string, { firstNonce: string; serverNonce: string }>();

  const stats = {
    requests: [] as Array<{ path: string; method: string }>,
    /** `challenge_login` calls: username and a nonce, never a password. */
    scramProbes: 0,
    /** `authentication_login` and `user/login` calls: each one carries the password in some form. */
    passwordSubmissions: 0,
    logins: 0,
    logouts: 0,
    overlapLoginAttempts: 0,
    tokenRejections: 0,
    staleSessionRequests: 0,
    writes: [] as Array<{ path: string; body: string }>,
  };

  const newSession = (): string => {
    const sid = crypto.randomBytes(12).toString("hex");
    sessions.set(sid, new Set());
    return sid;
  };
  const issueToken = (sid: string): string => {
    const token = crypto.randomBytes(16).toString("hex");
    sessions.get(sid)?.add(token);
    return token;
  };
  const fail = (): { code: string; extra: string } => {
    failedLogins += 1;
    if (failedLogins >= 3) {
      locked = true;
      return { code: "108007", extra: "<waittime>600</waittime>" };
    }
    return { code: "108006", extra: opts.reportRemainCount === false ? "" : `<remaincount>${3 - failedLogins}</remaincount>` };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    stats.requests.push({ path: p, method });

    const cookieSid = /(?:^|;\s*)SessionID=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1] ?? null;
    const knownSid = cookieSid !== null && sessions.has(cookieSid) ? cookieSid : null;
    /** `tokens`: `pair` (a login), `one` (an ordinary POST answer) or `none`. */
    const reply = (payload: string, extra: { setSid?: string; tokens?: "pair" | "one" | "none" } = {}): Response => {
      const h = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (extra.setSid) h.set("Set-Cookie", `SessionID=${extra.setSid}; Path=/; HttpOnly`);
      const tokenSid = extra.setSid ?? knownSid;
      const kind = extra.tokens ?? (method === "POST" && rotateTokens ? "one" : "none");
      if (tokenSid && kind === "pair") {
        h.set("__RequestVerificationTokenone", issueToken(tokenSid));
        h.set("__RequestVerificationTokentwo", issueToken(tokenSid));
      } else if (tokenSid && kind === "one") {
        h.set("__RequestVerificationToken", issueToken(tokenSid));
      }
      return new Response(payload, { status: 200, headers: h });
    };
    const xmlError = (code: string, extraTags = "", tokens: "one" | "none" = "none"): Response =>
      reply(`<error><code>${code}</code><message></message>${extraTags}</error>`, { tokens });

    // ── Login-free ───────────────────────────────────────────────────────────
    if (method === "GET" && p === "/api/user/state-login") {
      const visible = adminSession !== null && !(adminSession.owner === "human" && humanCrossIp);
      const type = passwordType === null ? "" : `<password_type>${passwordType}</password_type>`;
      return reply(
        `<response><State>${visible ? "0" : "-1"}</State><lockstatus>${locked ? 1 : 0}</lockstatus><remainwaittime>${locked ? 600 : 0}</remainwaittime>${type}<firstlogin>0</firstlogin></response>`
      );
    }
    if (method === "GET" && p === "/api/monitoring/status") {
      const status = "<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>4</SignalIcon><SimStatus>1</SimStatus></response>";
      // The webserver/token family hands out the cookie here; the SesTokInfo family only in SesTokInfo
      if (headers.get("update-cookie") && opts.tokenFlow === "token") return reply(status, { setSid: newSession(), tokens: "none" });
      return reply(status);
    }
    if (method === "GET" && p === "/api/device/basic_information" && opts.basicInformationPublic !== false) {
      return reply(`<response><devicename>${model}</devicename><spreadname_en>HUAWEI 5G CPE Lab</spreadname_en></response>`);
    }
    if (method === "GET" && p === "/api/webserver/token") {
      if (opts.tokenFlow !== "token") return xmlError("100002");
      if (!knownSid) return xmlError("100003");
      return reply(`<response><token>${issueToken(knownSid)}</token></response>`);
    }
    if (method === "GET" && p === "/api/webserver/SesTokInfo") {
      if (opts.tokenFlow !== "sestokinfo") return xmlError("100002");
      const sid = knownSid ?? newSession();
      return reply(`<response><SesInfo>SessionID=${sid}</SesInfo><TokInfo>${issueToken(sid)}</TokInfo></response>`);
    }

    // ── Every POST needs a token of its own cookie session ──────────────────
    if (method === "POST") {
      const token = headers.get("__requestverificationtoken") ?? "";
      const pool = knownSid ? sessions.get(knownSid) : undefined;
      if (!pool?.has(token)) {
        stats.tokenRejections += 1;
        return xmlError("125001");
      }
      if (rotateTokens) pool.delete(token);
    }

    if (p === "/api/user/challenge_login") {
      stats.scramProbes += 1;
      if (locked) return xmlError("108007", "<waittime>600</waittime>");
      if (!scram) {
        const rotate = opts.probeRotatesToken === true ? "one" : "none";
        const answer = opts.scramProbe ?? "100002";
        return answer === "not-a-challenge" ? reply("<response>OK</response>", { tokens: rotate }) : xmlError(answer, "", rotate);
      }
      if (adminSession !== null) {
        if (adminSession.owner === "fengsui") stats.overlapLoginAttempts += 1;
        return xmlError("108003");
      }
      const firstNonce = getXmlTag(body, "firstnonce") ?? "";
      const serverNonce = `${firstNonce}${crypto.randomBytes(32).toString("hex")}`;
      pendingChallenges.set(knownSid ?? "", { firstNonce, serverNonce });
      return reply(`<response><salt>${SALT_HEX}</salt><iterations>${ITERATIONS}</iterations><servernonce>${serverNonce}</servernonce><modeselected>1</modeselected></response>`, { tokens: "pair" });
    }
    if (p === "/api/user/authentication_login") {
      stats.passwordSubmissions += 1;
      if (!scram) return xmlError("100002");
      const challenge = pendingChallenges.get(knownSid ?? "");
      pendingChallenges.delete(knownSid ?? "");
      const expected = challenge ? computeScram(password, SALT_HEX, ITERATIONS, challenge.firstNonce, challenge.serverNonce) : null;
      if (!expected || (getXmlTag(body, "clientproof") ?? "").toLowerCase() !== expected.clientProofHex) {
        const { code, extra } = fail();
        return xmlError(code, extra);
      }
      if (adminSession !== null) {
        if (adminSession.owner === "fengsui") stats.overlapLoginAttempts += 1;
        return xmlError("108003");
      }
      failedLogins = 0;
      const sid = newSession();
      adminSession = { sid, owner: "fengsui" };
      stats.logins += 1;
      const ecc =
        opts.login === "scram-ecc"
          ? `<ecc_server_pubkey>${SERVER_ECC_PUB}</ecc_server_pubkey><ecc_pubkey_signature>${crypto.createHmac("sha256", expected.serverKey).update(Buffer.from(SERVER_ECC_PUB, "hex")).digest("hex")}</ecc_pubkey_signature>`
          : "";
      return reply(`<response><serversignature>${expected.expectedServerSig}</serversignature>${ecc}</response>`, { setSid: sid, tokens: rotateTokens ? "pair" : "none" });
    }
    if (p === "/api/user/login") {
      stats.passwordSubmissions += 1;
      if (locked) return xmlError("108007", "<waittime>600</waittime>");
      const token = headers.get("__requestverificationtoken") ?? "";
      const sentType = getXmlTag(body, "password_type");
      const legacy = opts.login === "sha256" || opts.login === "base64" ? opts.login : null;
      const wantType = legacy === "sha256" ? "4" : passwordType === "3" ? "3" : "0";
      // SCRAM-only firmware refuses the legacy hash as a wrong password (appendix A.4) and counts it
      const right =
        legacy !== null &&
        getXmlTag(body, "Username") === username &&
        sentType === wantType &&
        getXmlTag(body, "Password") === familyLegacyPassword(legacy, username, password, token);
      if (!right) {
        const { code, extra } = fail();
        return xmlError(code, extra);
      }
      if (adminSession !== null) {
        if (adminSession.owner === "fengsui") stats.overlapLoginAttempts += 1;
        return xmlError("108003");
      }
      failedLogins = 0;
      const sid = newSession();
      adminSession = { sid, owner: "fengsui" };
      stats.logins += 1;
      return reply("<response>OK</response>", { setSid: sid, tokens: rotateTokens ? "pair" : "none" });
    }

    // ── Everything below needs the active admin session ─────────────────────
    if (adminSession === null || adminSession.owner !== "fengsui" || adminSession.sid !== cookieSid) {
      stats.staleSessionRequests += 1;
      return xmlError("100003");
    }
    if (p === "/api/user/logout") {
      sessions.delete(adminSession.sid);
      adminSession = null;
      stats.logouts += 1;
      return reply("<response>OK</response>");
    }

    const encType = url.searchParams.get("enc-type");
    const clientPub = url.searchParams.get("ecc-client-pubkey");
    const shareKeyHex = clientPub ? curve25519Mul(SERVER_ECC_PRIV, BigInt(`0x${clientPub}`)).toString(16) : "";
    const plainBody = encType === "2" || encType === "3" ? aesGcmDecrypt(body, shareKeyHex) : body;
    const respond = (xml: string): Response => reply(encType === "1" || encType === "3" ? aesGcmEncrypt(xml, shareKeyHex) : xml);

    if (method === "GET") {
      if (p === "/api/device/information") {
        return reply(`<response><DeviceName>${model}</DeviceName><SoftwareVersion>${firmware}</SoftwareVersion><WebUIVersion>WEBUI 10.0.2.1</WebUIVersion><Imei>860000000000000</Imei><WanIPAddress>203.0.113.10</WanIPAddress></response>`);
      }
      if (p === "/api/device/basic_information") {
        return reply(`<response><devicename>${model}</devicename><spreadname_en>HUAWEI 5G CPE Lab</spreadname_en></response>`);
      }
      const extra = opts.endpoints?.[p];
      if (typeof extra === "string") return reply(extra);
      if (extra) return xmlError(extra.cpeError);
      return xmlError("100002");
    }
    stats.writes.push({ path: p, body: plainBody });
    return respond("<response>OK</response>");
  };

  return {
    fetchImpl,
    password,
    username,
    stats,
    serverEccPublicKeyHex: SERVER_ECC_PUB,
    isSlotTaken: (): boolean => adminSession !== null,
    isLocked: (): boolean => locked,
    failedLogins: (): number => failedLogins,
    human: {
      /** Browser on the same LAN IP: `state-login` shows `State=0`. */
      loginSameIp(): void {
        adminSession = { sid: "human-browser", owner: "human" };
        humanCrossIp = false;
      },
      /** Browser on another LAN IP: `state-login` still shows `-1`, logins get `108003`. */
      loginCrossIp(): void {
        adminSession = { sid: "human-browser", owner: "human" };
        humanCrossIp = true;
      },
      logout(): void {
        if (adminSession?.owner === "human") adminSession = null;
        humanCrossIp = false;
      },
    },
    count: (path: string, method?: string): number => stats.requests.filter((r) => r.path === path && (method === undefined || r.method === method)).length,
  };
}

export type CpeFamily = ReturnType<typeof createCpeFamily>;
