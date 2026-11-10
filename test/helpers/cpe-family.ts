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
  /** `spreadname_en` of `device/basic_information`; `null` leaves the tag out. Default `HUAWEI 5G CPE Lab`. */
  marketingName?: string | null;
  /** Extra GETs needing a login (feature switches, optional interfaces); unlisted ones answer `100002`. */
  endpoints?: Readonly<Record<string, string | { cpeError: string }>>;
  /** A wrong password's answer says how many attempts are left. Default `true`. */
  reportRemainCount?: boolean;
  /** `ConnectionStatus` of `monitoring/status` (default `901`, connected); `setConnectionStatus` changes it. */
  connectionStatus?: string;
  /**
   * A plaintext SMS store (`GET sms/sms-count`, `POST sms/sms-list`, the HiLink listing of appendix
   * A.10); without it both answer `100002`. Listing is a read: it never counts as a write.
   */
  sms?: ReadonlyArray<FamilySms>;
  /**
   * Model the generic writes of appendix A.11 (net-mode, mobile data, redial, reboot, plaintext SMS
   * send / set-read / delete) strictly: a body in any other form answers `100005`, an unmodelled
   * POST `100002`. Without it every POST is accepted and only recorded, as before.
   */
  writes?: FamilyWrites;
}

/** How the family models the generic writes (see `CpeFamilyOptions.writes`). */
export interface FamilyWrites {
  /** The router answers OK but changes nothing (a firmware that ignores the request). */
  ignore?: boolean;
  /** POST paths the router refuses with this error code. */
  errors?: Readonly<Record<string, string>>;
  /**
   * What `sms/send-status` reports once a send settles; `never` keeps reporting it pending, `silent`
   * names no recipient at all (a firmware whose status has other fields), `partial` lists only the
   * first recipient as delivered. Default `sent`.
   */
  smsOutcome?: "sent" | "failed" | "never" | "silent" | "partial";
}

export interface FamilySms {
  index: number;
  phone: string;
  content: string;
  date: string;
  /** `0` unread, `1` read, `3` sent. */
  smstat: string;
  box: 1 | 2;
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
  const sms: FamilySms[] | null = opts.sms ? opts.sms.map((m) => ({ ...m })) : null;
  const firmware = opts.firmware ?? "10.0.2.1(H195SP3C983)";
  const marketingName = opts.marketingName === undefined ? "HUAWEI 5G CPE Lab" : opts.marketingName;
  const basicInformation = `<response><devicename>${model}</devicename>${marketingName === null ? "" : `<spreadname_en>${marketingName}</spreadname_en>`}</response>`;
  let adminSession: AdminSession | null = null;
  let humanCrossIp = false;
  let failedLogins = 0;
  let locked = false;
  /** Every cookie session the router knows (pre-login and admin) with its valid tokens. */
  const sessions = new Map<string, Set<string>>();
  const pendingChallenges = new Map<string, { firstNonce: string; serverNonce: string }>();

  // The settings the generic writes change (`writes`), seeded from the router's own answers
  const seeded = typeof opts.endpoints?.["/api/net/net-mode"] === "string" ? (opts.endpoints["/api/net/net-mode"] as string) : "";
  const netMode = {
    NetworkMode: getXmlTag(seeded, "NetworkMode") ?? "00",
    NetworkBand: getXmlTag(seeded, "NetworkBand") ?? "3FFFFFFF",
    LTEBand: getXmlTag(seeded, "LTEBand") ?? "800800C5",
  };
  let dataSwitch = "1";
  let connectionStatus = opts.connectionStatus ?? "901";
  let sending: { phones: string[]; polls: number } | null = null;
  let nextSmsIndex = 50_000;

  const stats = {
    /** Generic writes the router acted on (`writes`): `reconnect` and `reboot` count, the rest change state. */
    reconnects: 0,
    reboots: 0,
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
      const status = `<response><ConnectionStatus>${connectionStatus}</ConnectionStatus><SignalIcon>4</SignalIcon><SimStatus>1</SimStatus></response>`;
      // The webserver/token family hands out the cookie here; the SesTokInfo family only in SesTokInfo
      if (headers.get("update-cookie") && opts.tokenFlow === "token") return reply(status, { setSid: newSession(), tokens: "none" });
      return reply(status);
    }
    if (method === "GET" && p === "/api/device/basic_information" && opts.basicInformationPublic !== false) {
      return reply(basicInformation);
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

    if (method === "GET" && p === "/api/sms/sms-count") {
      if (!sms) return xmlError("100002");
      const inbox = sms.filter((m) => m.box === 1);
      return reply(
        `<response><LocalUnread>${inbox.filter((m) => m.smstat === "0").length}</LocalUnread><LocalInbox>${inbox.length}</LocalInbox><LocalOutbox>${sms.length - inbox.length}</LocalOutbox><LocalDraft>0</LocalDraft><LocalDeleted>0</LocalDeleted><SimUnread>0</SimUnread><LocalMax>500</LocalMax></response>`
      );
    }
    if (method === "POST" && p === "/api/sms/sms-list") {
      if (!sms) return respond("<error><code>100002</code><message></message></error>");
      const box = getXmlTag(plainBody, "BoxType") === "2" ? 2 : 1;
      const page = Number(getXmlTag(plainBody, "PageIndex") ?? "1");
      const count = Number(getXmlTag(plainBody, "ReadCount") ?? "20");
      const items = sms.filter((m) => m.box === box).sort((a, b) => b.index - a.index).slice((page - 1) * count, page * count);
      const xml = items.map((m) => `<Message><Smstat>${m.smstat}</Smstat><Index>${m.index}</Index><Phone>${m.phone}</Phone><Content>${m.content}</Content><Date>${m.date}</Date></Message>`).join("");
      return respond(`<response><Count>${items.length}</Count><Messages>${xml}</Messages></response>`);
    }
    if (opts.writes && method === "GET" && p === "/api/net/net-mode") {
      return reply(`<response><NetworkMode>${netMode.NetworkMode}</NetworkMode><NetworkBand>${netMode.NetworkBand}</NetworkBand><LTEBand>${netMode.LTEBand}</LTEBand></response>`);
    }
    if (opts.writes && method === "GET" && p === "/api/dialup/mobile-dataswitch") {
      return reply(`<response><dataswitch>${dataSwitch}</dataswitch></response>`);
    }
    if (opts.writes && method === "GET" && p === "/api/sms/send-status") {
      const outcome = opts.writes.smsOutcome ?? "sent";
      // A status with none of the fields FengSui reads: nothing pending, nothing delivered, nothing failed
      if (outcome === "silent") return reply("<response><TotalCount>1</TotalCount></response>");
      const pending = sending !== null && (sending.polls++ === 0 || outcome === "never");
      const phones = sending?.phones.join(",") ?? "";
      if (pending) return reply(`<response><Phone>${phones}</Phone><SucPhone></SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`);
      const delivered = outcome === "partial" ? (sending?.phones[0] ?? "") : phones;
      return reply(
        outcome === "failed"
          ? `<response><Phone></Phone><SucPhone></SucPhone><FailPhone>${phones}</FailPhone><SendFailCode>113018</SendFailCode></response>`
          : `<response><Phone></Phone><SucPhone>${delivered}</SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`
      );
    }
    if (method === "GET") {
      if (p === "/api/device/information") {
        return reply(`<response><DeviceName>${model}</DeviceName><SoftwareVersion>${firmware}</SoftwareVersion><WebUIVersion>WEBUI 10.0.2.1</WebUIVersion><Imei>860000000000000</Imei><WanIPAddress>203.0.113.10</WanIPAddress></response>`);
      }
      if (p === "/api/device/basic_information") {
        return reply(basicInformation);
      }
      const extra = opts.endpoints?.[p];
      if (typeof extra === "string") return reply(extra);
      if (extra) return xmlError(extra.cpeError);
      return xmlError("100002");
    }
    stats.writes.push({ path: p, body: plainBody });
    if (!opts.writes) return respond("<response>OK</response>");
    return modelledWrite(p, plainBody.replace(/^<\?xml[^>]*\?>/, ""), opts.writes, xmlError, () => reply("<response>OK</response>"));
  };

  /** A generic write in exactly the form appendix A.11 gives, else `100005`; an unmodelled one `100002`. */
  const modelledWrite = (p: string, body: string, writes: FamilyWrites, xmlError: (code: string) => Response, ok: () => Response): Response => {
    const refused = writes.errors?.[p];
    if (refused) return xmlError(refused);
    const act = (change: () => void): Response => {
      if (!writes.ignore) change();
      return ok();
    };
    if (p === "/api/net/net-mode") {
      const m = /^<request><NetworkMode>(\d{2,8})<\/NetworkMode><NetworkBand>([0-9A-Fa-f]{1,16})<\/NetworkBand><LTEBand>([0-9a-f]{1,32})<\/LTEBand><\/request>$/.exec(body);
      if (!m) return xmlError("100005");
      return act(() => Object.assign(netMode, { NetworkMode: m[1], NetworkBand: m[2], LTEBand: m[3] }));
    }
    if (p === "/api/dialup/mobile-dataswitch") {
      const m = /^<request><dataswitch>([01])<\/dataswitch><\/request>$/.exec(body);
      if (!m) return xmlError("100005");
      return act(() => (dataSwitch = m[1] ?? dataSwitch));
    }
    if (p === "/api/net/reconnect") {
      if (body !== "<request><ReconnectAction>1</ReconnectAction></request>") return xmlError("100005");
      return act(() => (stats.reconnects += 1));
    }
    if (p === "/api/device/control") {
      // 2 resets the router to factory settings, 3 backs its settings up, 4 powers it off: never anything but 1
      if (body !== "<request><Control>1</Control></request>") return xmlError("100005");
      return act(() => (stats.reboots += 1));
    }
    if (p === "/api/sms/send-sms") {
      const m =
        /^<request><Index>-1<\/Index><Phones>((?:<Phone>[^<]+<\/Phone>)+)<\/Phones><Sca><\/Sca><Content>([^<]*)<\/Content><Length>(\d+)<\/Length><Reserved>([01])<\/Reserved><Date>(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)<\/Date><\/request>$/.exec(body);
      const content = (m?.[2] ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
      if (!m || Number(m[3]) !== [...content].length) return xmlError("100005");
      const phones = [...(m[1] ?? "").matchAll(/<Phone>([^<]+)<\/Phone>/g)].map((x) => x[1] ?? "");
      return act(() => {
        sending = { phones, polls: 0 };
        for (const phone of phones) sms?.push({ index: nextSmsIndex++, phone, content, date: m[5] ?? "", smstat: "3", box: 2 });
      });
    }
    if (p === "/api/sms/set-read" || p === "/api/sms/delete-sms") {
      const m = /^<request><Index>(\d+)<\/Index><\/request>$/.exec(body);
      if (!m || !sms) return xmlError(m ? "100002" : "100005");
      const index = Number(m[1]);
      return act(() => {
        const at = sms.findIndex((message) => message.index === index);
        if (at < 0) return;
        if (p === "/api/sms/delete-sms") sms.splice(at, 1);
        else if (sms[at]?.smstat === "0") sms[at] = { ...(sms[at] as FamilySms), smstat: "1" };
      });
    }
    return xmlError("100002");
  };

  return {
    fetchImpl,
    password,
    username,
    stats,
    /** The live plaintext SMS store (`null` without `sms`): push to it to deliver a message. */
    smsStore: sms,
    /** The settings the modelled generic writes change (`writes`). */
    settings: { netMode, mobileData: (): string => dataSwitch },
    setConnectionStatus: (code: string): void => {
      connectionStatus = code;
    },
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
