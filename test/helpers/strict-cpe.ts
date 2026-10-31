import crypto from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt, computeScram, curve25519Mul, huaweiXssDecode } from "../../src/crypto.ts";
import { getXmlBlocks, getXmlTag } from "../../src/xml.ts";

/**
 * Strict H168-383 router model for contract tests. Unlike the feature mocks it enforces the rules
 * the real firmware enforces and that FengSui must never violate:
 *
 * - ONE admin slot: a login while any admin session is active (ours or a human's) gets `108003`.
 * - Session-bound, single-use CSRF tokens: a POST with an unknown or already used token gets `125001`.
 * - Authenticated endpoints reject requests whose `SessionID` is not the active admin session (`100003`).
 * - Three wrong passwords lock the account (`108006` with `remaincount` 2, 1, then `108007`).
 * - A human can log in from the same LAN IP (`state-login` shows `State=0`) or from another IP
 *   (firmware 4.4.0.1 still shows `State=-1`, but `challenge_login` answers `108003`).
 *
 * Every violation is counted in `stats`, so tests can assert they stayed at zero under contention.
 * All identifiers are RFC/test placeholders (RFC 5737 / RFC 7042 / reserved SMS ranges).
 */

/**
 * `transport`: connection failure without a socket cause; `stale-socket`: the router closed a reused
 * keep-alive connection (undici `UND_ERR_SOCKET: other side closed`, seen on the real H168-383).
 */
export type StrictFault = "transport" | "stale-socket" | "timeout" | { cpeError: string } | { body: string };

export interface StrictCpeOptions {
  password?: string;
  /** Per-request latency in ms (number or generator) so concurrent work really interleaves. */
  latencyMs?: number | (() => number);
  /** Return a fault for a request (path without query, method); `undefined` serves it normally. */
  fault?: (path: string, method: string) => StrictFault | undefined;
}

interface AdminSession {
  sid: string;
  owner: "fengsui" | "human";
}

const SALT_HEX = "ab".repeat(32);
const SERVER_ECC_PRIV = BigInt("0x0a112233445566778899aabbccddeeff00112233445566778899aabbccddeef1");
const SERVER_ECC_PUB = curve25519Mul(SERVER_ECC_PRIV, 9n).toString(16).padStart(64, "0");

const TELEMETRY_XML: Readonly<Record<string, string>> = {
  "/api/device/signal":
    "<response><pci>357</pci><cell_id>134217758</cell_id><rsrq>-5.5dB</rsrq><rsrp>-87dBm</rsrp><rssi>-72dBm</rssi><sinr>13dB</sinr><mode>7</mode><ulbandwidth>20MHz</ulbandwidth><dlbandwidth>20MHz</dlbandwidth><txpower>PPusch:12dBm PPucch:-9dBm PSrs:0dBm PPrach:-3dBm</txpower><ul_mcs>mcsUpCarrier1:27@256QAM</ul_mcs><dl_mcs>mcsDownCarrier1Code0:20@256QAM</dl_mcs><earfcn>DL:100 UL:18100</earfcn><tac>10001</tac><band>20MHz@100(B1) + 20MHz@1700(B3) + 100MHz@647424(N78)</band><plmn>27201</plmn><transmode>TM[4]</transmode><enodeb_id>0524288</enodeb_id><nrearfcn>647424</nrearfcn><nrsinr>8dB</nrsinr><nrrsrp>-95dBm</nrrsrp><nrrsrq>-10.0dB</nrrsrq><nrdlbandwidth>100MHz</nrdlbandwidth><nrulbandwidth>100MHz</nrulbandwidth><nrrank>1</nrrank></response>",
  "/api/device/seccellinfo":
    "<response><lteseccell_list>1700,B3,20MHz,25,-84dBm,-6dB,-70dBm,14dB;</lteseccell_list><nrseccell_list>647424,N78,100MHz,357,-95dBm,-10dB,-72dBm,8dB;</nrseccell_list></response>",
  "/api/device/ri": "<response><ri>2</ri></response>",
  "/api/net/cell-info": "<response><cellinfo>0800001E</cellinfo><lac>2711</lac></response>",
  "/api/net/current-plmn":
    "<response><State>0</State><FullName>Carrier-Lab</FullName><ShortName>CARRIER</ShortName><Numeric>27201</Numeric><Rat>7</Rat></response>",
  "/api/net/net-mode":
    "<response><NetworkMode>00</NetworkMode><NetworkBand>2000004680380</NetworkBand><LTEBand>40000007A0880800D5</LTEBand><networkOption>2</networkOption></response>",
  "/api/device/information":
    "<response><DeviceName>H168-383</DeviceName><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion><uptime>86400</uptime><WanIPAddress>198.51.100.42</WanIPAddress><WanIPv6Address>2001:db8::42</WanIPv6Address><workmode>LTE</workmode></response>",
  "/api/device/basic_information":
    "<response><devicename>H168-383</devicename><spreadname_en>HUAWEI 5G CPE Ultra 6</spreadname_en></response>",
  "/api/monitoring/traffic-statistics":
    "<response><CurrentConnectTime>346909</CurrentConnectTime><CurrentUpload>80240562176</CurrentUpload><CurrentDownload>191780421632</CurrentDownload><CurrentDownloadRate>14722</CurrentDownloadRate><CurrentUploadRate>6897</CurrentUploadRate><TotalUpload>2418923415594</TotalUpload><TotalDownload>5541561494560</TotalDownload><TotalConnectTime>12193610</TotalConnectTime></response>",
  "/api/monitoring/month_statistics":
    "<response><CurrentMonthDownload>1160491161608</CurrentMonthDownload><CurrentMonthUpload>587430687669</CurrentMonthUpload><MonthDuration>2511543</MonthDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime><CurrentDayUsed>11888746002</CurrentDayUsed><CurrentDayDuration>13250</CurrentDayDuration></response>",
  "/api/monitoring/start_date":
    "<response><StartDay>1</StartDay><DataLimit>0MB</DataLimit><MonthThreshold>90</MonthThreshold></response>",
  "/api/device/nbrcellinfo":
    "<response><nbrcell_ltelist>1700,B3,357,-87dBm,-10dB,-69dBm,--;100,B1,25,-96dBm,-12dB,-70dBm,--;</nbrcell_ltelist><nbrcell_nrlist>647424,N78,357,-95dBm,-10dB,-72dBm,8dB;</nbrcell_nrlist></response>",
  "/api/system/topology": "[]",
  "/api/security/upnp": "<response><UpnpStatus>1</UpnpStatus></response>",
  "/api/security/nat": "<response><NATType>1</NATType></response>",
  "/api/security/bridgemode": "<response><bridgemode>0</bridgemode></response>",
  "/api/device/antenna_set_type": "<response><antennasettype>0</antennasettype></response>",
  "/api/device/antenna_type": "<response><antenna1insertstatus>0</antenna1insertstatus><antenna2insertstatus>0</antenna2insertstatus></response>",
  "/api/dialup/mobile-dataswitch": "<response><dataswitch>1</dataswitch></response>",
};

const HOST_INFO_JSON = JSON.stringify([
  {
    MACAddress: "00:00:5E:00:53:01",
    HostName: "lan-client-01",
    IPAddress: "192.168.8.10",
    Active: true,
    InterfaceType: "Ethernet",
    Layer2Interface: "LAN1",
    EthernetSpeed: 1000,
    AddressSource: "STATIC",
  },
]);

/** Login-free endpoints (no cookie or token needed). */
const PUBLIC_PATHS = new Set(["/api/user/state-login", "/api/monitoring/check-notifications"]);

export function createStrictCpe(opts: StrictCpeOptions = {}) {
  const password = opts.password ?? "strict_mock_password";
  let adminSession: AdminSession | null = null;
  let humanCrossIp = false;
  let failedLogins = 0;
  let locked = false;
  const issuedTokens = new Map<string, Set<string>>();
  const pendingChallenges = new Map<string, string>();
  const inbox: Array<{ index: number; phone: string; content: string; date: string; smstat: string }> = [];
  const outbox: Array<{ index: number; phone: string; content: string; date: string; smstat: string }> = [];
  let nextSmsIndex = 40001;
  let pendingSendPolls = 0;
  const router = {
    firewall: { main: 1, ipFilter: 1, wanPing: 0, macFilter: 0, urlFilter: 0 },
    wifi: { MloEnable: true, DbhoEnable: true },
    dmz: { status: 0, ip: "" },
    /**
     * Wi-Fi MAC filter as firmware 4.4.0.1 keeps it: one router-wide switch and policy, and per SSID
     * (Index 0-12) a whitelist and a blacklist of numbered slots. A write names one SSID and a status:
     * 0 turns the filter off, 1 / 2 enforce the whitelist / blacklist and replace the slots it sends.
     */
    macFilter: {
      enable: "0" as "0" | "1",
      status: "2" as "1" | "2",
      maxEntries: 64,
      ssids: Array.from({ length: 13 }, () => ({ allow: [] as string[][], deny: [] as string[][] })),
    },
    /** Parental-control "internet time" rules (`/api/timerule/timerule`). */
    timeRules: {
      max: 16,
      nextId: 1,
      rules: [] as Array<{ ID: string; Enable: string; TimeMode: string; WeekEnable: string; StartTime: string; EndTime: string; macs: string[]; names: string[] }>,
    },
  };

  const macFilterSlots = (slots: string[][]): string =>
    slots
      .filter((slot) => slot[0])
      .map((slot, i) => `<wifihostname${i}>${slot[1] ?? ""}</wifihostname${i}><WifiMacFilterMac${i}>${slot[0]}</WifiMacFilterMac${i}>`)
      .join("");
  const macFilterXml = (): string =>
    `<response><Ssids>${router.macFilter.ssids
      .map((ssid, index) => `<Ssid><wifimacwhitelist>${macFilterSlots(ssid.allow)}</wifimacwhitelist><Index>${index}</Index><wifimacblacklist>${macFilterSlots(ssid.deny)}</wifimacblacklist></Ssid>`)
      .join("")}</Ssids><wifimacfilterstatus>${router.macFilter.status}</wifimacfilterstatus><enable>${router.macFilter.enable}</enable></response>`;
  const timeRulesXml = (): string =>
    `<response><TimeControlRules>${router.timeRules.rules
      .map(
        (r) =>
          `<TimeControlRule><ID>${r.ID}</ID><Enable>${r.Enable}</Enable><TimeMode>${r.TimeMode}</TimeMode><WeekEnable>${r.WeekEnable}</WeekEnable><StartTime>${r.StartTime}</StartTime><EndTime>${r.EndTime}</EndTime><DevicesMACs>${r.macs.map((m) => `<DevicesMAC>${m}</DevicesMAC>`).join("")}</DevicesMACs><DevicesNames>${r.names.map((n) => `<DevicesName>${n}</DevicesName>`).join("")}</DevicesNames></TimeControlRule>`
      )
      .join("")}</TimeControlRules><TimeRuleMaxNum>${router.timeRules.max}</TimeRuleMaxNum></response>`;

  const stats = {
    requests: [] as Array<{ path: string; method: string }>,
    stateLoginChecks: 0,
    challengeCalls: 0,
    authCalls: 0,
    logins: 0,
    logouts: 0,
    /** A FengSui login attempted while another admin session (ours or a human's) was active. */
    overlapLoginAttempts: 0,
    /** A POST with a missing, foreign or replayed CSRF token. */
    tokenRejections: 0,
    /** An authenticated request carrying a SessionID that is not the active admin session. */
    staleSessionRequests: 0,
    writes: [] as Array<{ path: string; body: string }>,
  };

  const latency = (): number => (typeof opts.latencyMs === "function" ? opts.latencyMs() : (opts.latencyMs ?? 0));
  const issueToken = (sid: string): string => {
    const token = crypto.randomBytes(16).toString("hex");
    let set = issuedTokens.get(sid);
    if (!set) {
      set = new Set();
      issuedTokens.set(sid, set);
    }
    set.add(token);
    return token;
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const p = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const signal = init?.signal ?? undefined;
    stats.requests.push({ path: p, method });

    const delay = latency();
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        });
      });
    }

    const fault = opts.fault?.(p, method);
    if (fault === "transport") throw new TypeError("fetch failed (connect ECONNRESET 192.168.8.1:80)");
    if (fault === "stale-socket") {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    }
    if (fault === "timeout") {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = (): void => reject(signal?.reason ?? new DOMException("timed out", "TimeoutError"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      });
    }

    const cookieSid = /(?:^|;\s*)SessionID=([^;]+)/.exec(headers.get("cookie") ?? "")?.[1] ?? null;
    const reply = (payload: string, extra: { sid?: string; tokens?: "one" | "pair" | "none"; status?: number } = {}): Response => {
      const h = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (extra.sid) h.set("Set-Cookie", `SessionID=${extra.sid}; Path=/; HttpOnly`);
      const tokenSid = extra.sid ?? cookieSid;
      if (tokenSid && extra.tokens === "pair") {
        h.set("__RequestVerificationTokenone", issueToken(tokenSid));
        h.set("__RequestVerificationTokentwo", issueToken(tokenSid));
      } else if (tokenSid && extra.tokens !== "none" && method === "POST") {
        h.set("__RequestVerificationToken", issueToken(tokenSid));
      }
      return new Response(payload, { status: extra.status ?? 200, headers: h });
    };
    const xmlError = (code: string, extraTags = ""): Response => reply(`<error><code>${code}</code><message></message>${extraTags}</error>`);
    if (fault !== undefined && typeof fault === "object" && "cpeError" in fault) return xmlError(fault.cpeError);
    if (fault !== undefined && typeof fault === "object" && "body" in fault) return reply(fault.body);

    if (p === "/api/user/state-login") {
      stats.stateLoginChecks += 1;
      const visible = adminSession !== null && !(adminSession.owner === "human" && humanCrossIp);
      return reply(
        `<response><lockstatus>${locked ? 1 : 0}</lockstatus><remainwaittime>${locked ? 600 : 0}</remainwaittime><State>${visible ? "0" : "-1"}</State><password_type>4</password_type><firstlogin>0</firstlogin></response>`,
        { tokens: "none" }
      );
    }
    if (p === "/api/monitoring/check-notifications") {
      const unread = inbox.filter((m) => m.smstat === "0").length;
      return reply(`<response><UnreadMessage>${unread}</UnreadMessage><SmsStorageFull>0</SmsStorageFull></response>`, { tokens: "none" });
    }

    // Pre-auth session bootstrap: `GET /api/monitoring/status` with Update-Cookie issues a SessionID
    if (p === "/api/monitoring/status" && headers.get("update-cookie")) {
      return reply("<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>4</SignalIcon><SimStatus>1</SimStatus></response>", {
        sid: crypto.randomBytes(12).toString("hex"),
        tokens: "none",
      });
    }
    if (p === "/api/webserver/token") {
      if (!cookieSid) return xmlError("100003");
      return reply(`<response><token>${"0".repeat(32)}${issueToken(cookieSid)}</token></response>`, { tokens: "none" });
    }

    if (method === "POST") {
      const token = headers.get("__requestverificationtoken") ?? "";
      const pool = cookieSid ? issuedTokens.get(cookieSid) : undefined;
      if (!pool?.has(token)) {
        stats.tokenRejections += 1;
        return xmlError("125001");
      }
      pool.delete(token);
    }

    if (p === "/api/user/challenge_login") {
      stats.challengeCalls += 1;
      if (locked) return xmlError("108007", "<waittime>600</waittime>");
      if (adminSession !== null) {
        if (adminSession.owner === "fengsui") stats.overlapLoginAttempts += 1;
        return xmlError("108003");
      }
      const firstNonce = getXmlTag(body, "firstnonce") ?? "";
      const serverNonce = `${firstNonce}${crypto.randomBytes(32).toString("hex")}`;
      pendingChallenges.set(cookieSid ?? "", serverNonce);
      return reply(
        `<response><salt>${SALT_HEX}</salt><iterations>1000</iterations><servernonce>${serverNonce}</servernonce></response>`,
        { tokens: "pair" }
      );
    }
    if (p === "/api/user/authentication_login") {
      stats.authCalls += 1;
      const serverNonce = pendingChallenges.get(cookieSid ?? "") ?? "";
      pendingChallenges.delete(cookieSid ?? "");
      const firstNonce = serverNonce.slice(0, 64);
      const scram = computeScram(password, SALT_HEX, 1000, firstNonce, serverNonce);
      if ((getXmlTag(body, "clientproof") ?? "").toLowerCase() !== scram.clientProofHex) {
        failedLogins += 1;
        if (failedLogins >= 3) {
          locked = true;
          return xmlError("108007", "<waittime>600</waittime>");
        }
        return xmlError("108006", `<remaincount>${3 - failedLogins}</remaincount>`);
      }
      if (adminSession !== null) {
        if (adminSession.owner === "fengsui") stats.overlapLoginAttempts += 1;
        return xmlError("108003");
      }
      failedLogins = 0;
      // Like the firmware, a successful login rotates the SessionID; tokens bind to the new one
      const sid = crypto.randomBytes(12).toString("hex");
      adminSession = { sid, owner: "fengsui" };
      stats.logins += 1;
      const eccSig = crypto.createHmac("sha256", scram.serverKey).update(Buffer.from(SERVER_ECC_PUB, "hex")).digest("hex");
      return reply(
        `<response><serversignature>${scram.expectedServerSig}</serversignature><ecc_server_pubkey>${SERVER_ECC_PUB}</ecc_server_pubkey><ecc_pubkey_signature>${eccSig}</ecc_pubkey_signature></response>`,
        { sid, tokens: "pair" }
      );
    }

    // Everything below needs the active admin session
    if (!PUBLIC_PATHS.has(p) && (adminSession === null || adminSession.owner !== "fengsui" || adminSession.sid !== cookieSid)) {
      stats.staleSessionRequests += 1;
      return xmlError("100003");
    }

    if (p === "/api/user/logout") {
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
      if (p === "/api/webserver/publickey") return reply(`<response><ecc_server_pubkey>${SERVER_ECC_PUB}</ecc_server_pubkey></response>`);
      if (p === "/api/monitoring/status") {
        return reply("<response><ConnectionStatus>901</ConnectionStatus><SignalIcon>4</SignalIcon><SimStatus>1</SimStatus></response>");
      }
      if (p === "/api/system/HostInfo") return reply(HOST_INFO_JSON);
      if (p === "/api/security/firewall-switch") {
        const f = router.firewall;
        return reply(
          `<response><FirewallMainSwitch>${f.main}</FirewallMainSwitch><FirewallIPFilterSwitch>${f.ipFilter}</FirewallIPFilterSwitch><FirewallWanPortPingSwitch>${f.wanPing}</FirewallWanPortPingSwitch><firewallmacfilterswitch>${f.macFilter}</firewallmacfilterswitch><firewallurlfilterswitch>${f.urlFilter}</firewallurlfilterswitch></response>`
        );
      }
      if (p === "/api/security/dmz") {
        return reply(`<response><DmzStatus>${router.dmz.status}</DmzStatus><DmzIPAddress>${router.dmz.ip}</DmzIPAddress></response>`);
      }
      if (p === "/api/wlan/wlandbho") return reply(JSON.stringify(router.wifi));
      if (p === "/api/wlan/multi-macfilter-settings-ex") return reply(macFilterXml());
      if (p === "/api/wlan/wifi-feature-switch") {
        return reply(`<response><wifimaxmacfilternum>${router.macFilter.maxEntries}</wifimaxmacfilternum><wifimacfilterextendenable>1</wifimacfilterextendenable></response>`);
      }
      if (p === "/api/timerule/timerule") return reply(timeRulesXml());
      if (p === "/api/sms/sms-count") {
        const unread = inbox.filter((m) => m.smstat === "0").length;
        return reply(
          `<response><LocalUnread>${unread}</LocalUnread><LocalInbox>${inbox.length}</LocalInbox><LocalOutbox>${outbox.length}</LocalOutbox><LocalDraft>0</LocalDraft><LocalMax>500</LocalMax></response>`
        );
      }
      const fixed = TELEMETRY_XML[p];
      if (fixed !== undefined) return reply(fixed);
      return xmlError("100002");
    }

    // POST
    stats.writes.push({ path: p, body: plainBody });
    if (p === "/api/sms/sms-list") {
      const box = getXmlTag(plainBody, "BoxType") === "2" ? outbox : inbox;
      const page = Number(getXmlTag(plainBody, "PageIndex") ?? "1");
      const count = Number(getXmlTag(plainBody, "ReadCount") ?? "20");
      const items = [...box].sort((a, b) => b.index - a.index).slice((page - 1) * count, page * count);
      const xml = items
        .map((m) => `<Message><Smstat>${m.smstat}</Smstat><Index>${m.index}</Index><Phone>${m.phone}</Phone><Content>${m.content}</Content><Date>${m.date}</Date></Message>`)
        .join("");
      return reply(`<response><Count>${items.length}</Count><Messages>${xml}</Messages></response>`);
    }
    if (p === "/api/security/firewall-switch") {
      router.firewall = {
        main: Number(getXmlTag(plainBody, "FirewallMainSwitch")),
        ipFilter: Number(getXmlTag(plainBody, "FirewallIPFilterSwitch")),
        wanPing: Number(getXmlTag(plainBody, "FirewallWanPortPingSwitch")),
        macFilter: Number(getXmlTag(plainBody, "firewallmacfilterswitch")),
        urlFilter: Number(getXmlTag(plainBody, "firewallurlfilterswitch")),
      };
      return reply("<response>OK</response>");
    }
    if (p === "/api/security/dmz") {
      router.dmz = { status: Number(getXmlTag(plainBody, "DmzStatus")), ip: getXmlTag(plainBody, "DmzIPAddress") ?? "" };
      return reply("<response>OK</response>");
    }
    if (p === "/api/wlan/multi-macfilter-settings") {
      for (const block of getXmlBlocks(plainBody, "Ssid")) {
        const ssid = router.macFilter.ssids[Number(getXmlTag(block, "Index"))];
        const status = getXmlTag(block, "WifiMacFilterStatus");
        if (!ssid || (status !== "0" && status !== "1" && status !== "2")) return xmlError("100006");
        if (status === "0") {
          router.macFilter.enable = "0";
        } else {
          router.macFilter.enable = "1";
          router.macFilter.status = status;
        }
        const list = (status === "0" ? router.macFilter.status : status) === "1" ? ssid.allow : ssid.deny;
        // Names stay exactly as sent (Huawei-xss encoded), like the router echoes them back
        const names = new Map([...block.matchAll(/<wifihostname(\d{1,3})>([^<]*)<\/wifihostname\1>/g)].map((m) => [m[1], m[2] ?? ""]));
        for (const m of block.matchAll(/<WifiMacFilterMac(\d{1,3})>([^<]*)<\/WifiMacFilterMac\1>/g)) {
          const slot = Number(m[1]);
          if (slot >= router.macFilter.maxEntries) return xmlError("100006");
          list[slot] = [m[2] ?? "", names.get(m[1] ?? "") ?? ""];
        }
        const kept = list.filter((slot) => slot[0]);
        list.length = 0;
        list.push(...kept);
      }
      return reply("<response>OK</response>");
    }
    if (p === "/api/timerule/timerule") {
      const r = getXmlBlocks(plainBody, "TimeControlRule")[0] ?? "";
      const action = getXmlTag(r, "Action");
      const fields = {
        Enable: getXmlTag(r, "Enable") ?? "1",
        TimeMode: getXmlTag(r, "TimeMode") ?? "0",
        WeekEnable: getXmlTag(r, "WeekEnable") ?? "",
        StartTime: getXmlTag(r, "StartTime") ?? "",
        EndTime: getXmlTag(r, "EndTime") ?? "",
        macs: getXmlBlocks(r, "DevicesMAC"),
        names: getXmlBlocks(r, "DevicesName"),
      };
      const id = getXmlTag(r, "ID") ?? "";
      const at = router.timeRules.rules.findIndex((rule) => rule.ID === id);
      if (action === "create") {
        if (router.timeRules.rules.length >= router.timeRules.max) return xmlError("100006");
        router.timeRules.rules.push({ ID: String(router.timeRules.nextId++), ...fields });
      } else if (action === "update" && at >= 0) {
        router.timeRules.rules[at] = { ID: id, ...fields };
      } else if (action === "delete" && at >= 0) {
        router.timeRules.rules.splice(at, 1);
      } else {
        return xmlError("100006");
      }
      return reply("<response>OK</response>");
    }
    if (p === "/api/wlan/wlandbho") {
      const parsed = JSON.parse(plainBody) as { MloEnable?: unknown; DbhoEnable?: unknown };
      router.wifi = { MloEnable: parsed.MloEnable === true, DbhoEnable: parsed.DbhoEnable === true };
      return reply("<response>OK</response>");
    }
    if (p === "/api/sms/send-sms") {
      const date = getXmlTag(plainBody, "Date") ?? "";
      const content = huaweiXssDecode(getXmlTag(plainBody, "Content") ?? "");
      for (const phone of getXmlBlocks(plainBody, "Phone")) {
        outbox.push({ index: nextSmsIndex++, phone, content, date, smstat: "3" });
      }
      pendingSendPolls = 1;
      return respond("<response>OK</response>");
    }
    if (p === "/api/sms/send-status") {
      const still = pendingSendPolls > 0;
      pendingSendPolls = Math.max(0, pendingSendPolls - 1);
      const last = outbox.at(-1)?.phone ?? "";
      return respond(
        still
          ? `<response><Phone>${last}</Phone><SucPhone></SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`
          : `<response><Phone></Phone><SucPhone>${last}</SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`
      );
    }
    if (p === "/api/sms/sms-count-contact") {
      const phone = huaweiXssDecode(getXmlTag(plainBody, "phone") ?? "");
      return respond(`<response><count>${[...inbox, ...outbox].filter((m) => m.phone === phone).length}</count></response>`);
    }
    if (p === "/api/sms/sms-list-phone") {
      const phone = getXmlTag(plainBody, "phone") ?? "";
      const items = [...inbox.map((m) => ({ ...m, curbox: 0 })), ...outbox.map((m) => ({ ...m, curbox: 1 }))]
        .filter((m) => m.phone === phone)
        .sort((a, b) => b.index - a.index);
      const xml = items
        .map((m) => `<message><smstat>${m.smstat}</smstat><index>${m.index}</index><phone>${m.phone}</phone><content>${m.content}</content><date>${m.date}</date><curbox>${m.curbox}</curbox></message>`)
        .join("");
      return respond(`<response><count>${items.length}</count><messages>${xml}</messages></response>`);
    }
    return reply("<response>OK</response>");
  };

  return {
    fetchImpl,
    password,
    stats,
    router,
    inbox,
    outbox,
    serverEccPublicKeyHex: SERVER_ECC_PUB,
    /** `true` while any admin session (ours or a human's) holds the single slot. */
    isSlotTaken: () => adminSession !== null,
    isLocked: () => locked,
    failedLogins: () => failedLogins,
    pushIncoming(msg: { phone: string; content: string; date: string }): void {
      inbox.push({ index: nextSmsIndex++, smstat: "0", ...msg });
    },
    human: {
      /** Browser on the same LAN IP: `state-login` shows `State=0` (Layer 1). */
      loginSameIp(): void {
        adminSession = { sid: "human-browser", owner: "human" };
        humanCrossIp = false;
      },
      /** Browser on another LAN IP: `state-login` still shows `-1`, logins get `108003` (Layer 2). */
      loginCrossIp(): void {
        adminSession = { sid: "human-browser", owner: "human" };
        humanCrossIp = true;
      },
      logout(): void {
        if (adminSession?.owner === "human") adminSession = null;
        humanCrossIp = false;
      },
    },
    /** Whether the Wi-Fi MAC filter keeps this MAC off Wi-Fi (the router enforces SSID 0's lists). */
    isWifiBlocked(mac: string): boolean {
      const f = router.macFilter;
      if (f.enable !== "1") return false;
      const listed = (f.status === "1" ? f.ssids[0]?.allow : f.ssids[0]?.deny)?.some((slot) => slot[0]?.toUpperCase() === mac.toUpperCase()) ?? false;
      return f.status === "2" ? listed : !listed;
    },
    count: (path: string, method?: string): number =>
      stats.requests.filter((r) => r.path === path && (method === undefined || r.method === method)).length,
  };
}

export type StrictCpe = ReturnType<typeof createStrictCpe>;
