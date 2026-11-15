import crypto from "node:crypto";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { tplinkProtocol } from "../../src/drivers/tplink/driver.ts";
import { type LanReply, type LanRequestRecord, LanRouterMock } from "./lan-router.ts";

/**
 * A stand-in for a TP-Link cellular router's own web interface, in either of its two forms (the MR
 * series' text frames, the EX and NX series' JSON) and each generation of its encryption. It does
 * what the router does with what FengSui sends: decrypts the signature with its private key, takes
 * the session's AES key out of the login's, checks the hash and the running number, decrypts the
 * payload and answers encrypted. Every identifier is a reserved placeholder; nothing here talks to a
 * real router.
 *
 * The stand-in's RSA key is 2048 bits (a real router's is 512): the driver cuts its signature by the
 * length of the key it is handed, so the same code runs, and no weak key is made for a test.
 */

export const TPLINK_PASSWORD = "test-password";
/**
 * The hash of the user name and that password the page puts into every signature, written out per
 * user name: MD5, and SHA-256 on the generation with a curve point. The stand-in compares, it does
 * not hash.
 */
export const TPLINK_HASHES: Readonly<Record<"md5" | "sha256", Readonly<Record<string, string>>>> = {
  md5: { admin: "b0370c4e2d6cea863a49bc58d861d53d", user: "3364f550dca53aa7fcab7ae20ed59ad1", owner: "986767c40dedba70e367b24a014dd855" },
  sha256: { admin: "2319d07fe567e78896a73865b347f3d2d63e9fde0fa0845e73221e2a5cb9ca59" },
};
export const TPLINK_URL = "http://192.168.1.1";

const RSA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_JWK = RSA.publicKey.export({ format: "jwk" }) as { n: string; e: string };
const MODULUS_HEX = Buffer.from(RSA_JWK.n, "base64url").toString("hex").toUpperCase();
const EXPONENT_HEX = Buffer.from(RSA_JWK.e, "base64url").toString("hex").toUpperCase().padStart(6, "0");
const SEQ = 266_656_725;

export interface TplinkSmsEntry {
  index: number;
  from?: string;
  to?: string;
  content: string;
  time: string;
  unread?: boolean;
}

export interface TplinkRouterOptions {
  form?: "mr" | "ex";
  cipher?: "cbc" | "gcm";
  padding?: "none" | "oaep";
  /** The newer MR firmware: a point on P-224 instead of an RSA key. */
  ecc?: boolean;
  /** What `/js/tpEncrypt.js` answers (left out: a script that names what `cipher` and `padding` say). */
  script?: LanReply;
  /** Someone is signed in to the router's page. */
  busy?: boolean;
  /** The login page shows a lock, for this many seconds. */
  forbidSec?: number;
  /** What a login with the right password answers instead of opening a session (the plain text, before encryption). */
  loginAnswer?: string;
  /** A wrong password is answered like a right one, only without a session (some MR firmware). */
  silentRefusal?: boolean;
  /** Objects this firmware lacks. */
  missing?: ReadonlyArray<string>;
  /** An object whose writes the router refuses. */
  refuse?: string;
  ussdAnswer?: string | null;
  /** What `sendResult` reads after a send (1 sent, 3 not done yet). */
  sendResult?: number;
  inbox?: TplinkSmsEntry[];
  outbox?: TplinkSmsEntry[];
  /** The user name the page's login takes (left out: the form's own). */
  username?: string;
  /** `networkType` of the LTE link (left out: 4G+ on the MR series, 5G on the other form). */
  networkType?: string;
  /** What `/js/oid_str.js` says this firmware was built with (left out: a cell lock, no antenna switch, one list of access points). */
  buildFlags?: string;
  /** Start values of the cellular settings, the cell lock, the band selection and the SIM lock. */
  settings?: Record<string, string>;
  cellLock?: Record<string, string>;
  bandSearch?: Record<string, string>;
  simLock?: Record<string, string>;
  dataPlan?: Record<string, string>;
  /** How many times the search for networks is asked before it is done (left out: once); `null`: it fails. */
  searchPolls?: number | null;
  /** The router refuses a wrong PIN with an error of its own instead of only counting it. */
  pinError?: boolean;
  /**
   * The access point profiles (left out: one of the router's own, in the form's own fields). Where the
   * page keeps tables (`INCLUDE_LTE_MULTI_APN=1` in `buildFlags`), each names its `tableIndex`.
   */
  profiles?: Array<Record<string, string>>;
  /** Where the page keeps tables: the counts and the table in use (`DEV2_LTE_PROF_STAT`; left out: the operator's one table, in use). */
  profStat?: Record<string, string>;
  /** The router takes a new profile and does not list it. */
  dropsNewProfile?: boolean;
}

/** The PIN of the stand-in's SIM card. */
export const TPLINK_PIN = "1234";

interface Session {
  key: Buffer;
  iv: Buffer;
  cookie: string;
  token: string;
}

export function tplinkRouter(opts: TplinkRouterOptions = {}) {
  const form = opts.form ?? "mr";
  const cipher = opts.ecc ? "cbc" : (opts.cipher ?? "cbc");
  const padding = opts.padding ?? "none";
  const username = opts.username ?? (form === "mr" ? "admin" : "user");
  const ecdh = crypto.createECDH("secp224r1");
  ecdh.generateKeys();
  const expectedHash = TPLINK_HASHES[opts.ecc ? "sha256" : "md5"][username] ?? "";
  const tabled = form === "ex" && (opts.buildFlags ?? "").includes("INCLUDE_LTE_MULTI_APN=1");
  const ownProfile: Record<string, string> =
    form === "mr"
      ? { profileID: "0", profileName: "Three", pdpType: "2", ipv4ApnType: "0", ipv4Apn: "internet", ipv4Username: "", ipv4Password: "", ipv4AuthType: "0", ipv6ApnType: "0", ipv6Apn: "internet", ipv6Username: "", ipv6Password: "", ipv6AuthType: "0" }
      : { profileID: "0", profileName: "Three", pdpType: "2", apnType: "0", apn: "internet", username: "", password: "", authType: "0", ...(tabled ? { tableIndex: "0", serviceType: "Internet" } : {}) };
  const state = {
    session: null as Session | null,
    authTimes: 0,
    inbox: opts.inbox ?? [
      { index: 0, from: "+353830000001", content: "Hello\nworld", time: "2026-10-10 04:07:40", unread: true },
      { index: 1, from: "DemoBank", content: "Balance ready", time: "2026-10-11 09:30:00", unread: false },
    ],
    outbox: opts.outbox ?? [{ index: 0, to: "+353830000002", content: "On my way", time: "2026-10-11 10:00:00" }],
    inboxPage: 1,
    outboxPage: 1,
    ussdPending: false,
    ussdCancelled: 0,
    rebooted: false,
    loggedOut: 0,
    /** The cellular settings (`…LTE_WAN_CFG`). */
    settings: {
      dataSwitchStatusBackup: "1",
      roamingEnabled: "0",
      antennaType: "0",
      ...(form === "mr"
        ? { networkPreferredMode: "3", networkSelectionMode: "0", networkSelectionMCC: "0", networkSelectionMNC: "0", networkSelectionISP: "", bandSelectSwitch: "0", bandSelectedMaskL: "0", bandSelectedMaskH: "0", activeProfile: "0", defaultProfile: "1" }
        : { networkPreferredModeSelected: "5G Preferred", networkPreferredModeOptionList: "5G Preferred,5G/4G,5G NSA/4G,5G SA Only,4G Preferred,4G Only,3G Only", activeProfile: "0", defaultProfile: "1" }),
      ...opts.settings,
    } as Record<string, string>,
    /** The MR series' cell lock: unlocked, it names the serving cell. */
    cellLock: { rfInfoCellIDLock: "0", rfInfoCellID: "134217758", rfInfoEARFCN: "300", rfInfoPCI: "211", ...opts.cellLock } as Record<string, string>,
    bandSearch: { supportBandList: "W1;B1;B3;B7;B20;N1;N28;N78S;N78N;", selectedBand: "", selectedMode: "1", ...opts.bandSearch } as Record<string, string>,
    lteCellLock: { lteCelllockEnable: "0", pci: "-1", EARFCN: "-1", band: "0" } as Record<string, string>,
    nrCellLock: { nrCelllockEnable: "0", pci: "-1", NRARFCN: "-1", band: "0", scs: "0" } as Record<string, string>,
    simLock: { pinState: "3", remainPinUnlockTime: "3", remainPukUnlockTime: "10", autoUnlockPin: "0", ...opts.simLock } as Record<string, string>,
    dataPlan: { totalStatistics: "2948105728.0", curRxSpeed: "125000", curTxSpeed: "25000", enableDataLimit: "0", limitation: "0", warningPercent: "90", enablePaymentDay: "1", paymentDay: "5", ...opts.dataPlan } as Record<string, string>,
    /** The access point profiles: the router's own for the SIM card first (`defaultProfile` of them; where the page keeps tables, the operator's tables first). */
    profiles: (opts.profiles ?? [ownProfile]) as Array<Record<string, string>>,
    /** Where the page keeps tables: how many profiles and tables are the operator's, how many tables the owner made, and which one the router dials with. */
    profStat: { ispCount: "1", ispTableCount: "1", usrTableCount: "0", usrWhich: "255", ispWhich: "0", ...opts.profStat } as Record<string, string>,
    /** How often a profile form was opened (`profileAction` 4). */
    profileLoads: 0,
    /** The search for networks: how often it was asked since it started (`null`: none running). */
    searchAsked: null as number | null,
    searchDone: false,
    networkSearch: { selectedMode: "1", selectedOperator: "" } as Record<string, string>,
  };
  const OPERATORS = [
    { ispName: "Three", mcc: "272", mnc: "1", itemStat: "2" },
    { ispName: "DemoNet", mcc: "272", mnc: "2", itemStat: "1" },
    { ispName: "Barred", mcc: "272", mnc: "3", itemStat: "3" },
  ];
  const OPERATOR_LIST = "Three,27201,2;DemoNet,27202,1;Barred,27203,3;";
  /** Whether the search has answered by now: each ask counts. */
  const searched = (): boolean => {
    if (state.searchAsked === null) return state.searchDone;
    state.searchAsked += 1;
    if (opts.searchPolls !== null && state.searchAsked >= (opts.searchPolls ?? 1)) {
      state.searchAsked = null;
      state.searchDone = true;
    }
    return state.searchDone;
  };
  /** The actions the router took after the login, as `operation oid` (and what a write set). */
  const actions: Array<{ operation: string; oid: string; stack: string; attrs: Record<string, string> }> = [];
  /** What each login attempt carried, decrypted: the signature's fields and the credentials. */
  const logins: Array<{ sign: Record<string, string>; username: string; password: string }> = [];

  // ── What the router does with a signature and a payload ──────────────────

  const openSign = (sign: string): string | null => {
    try {
      if (opts.ecc) {
        const sealed = JSON.parse(sign) as { iv: string; ct: string; tag: string; hmac: string };
        const shared = ecdh.computeSecret(Buffer.from(`04${sealed.tag}`, "hex"));
        const kem = crypto.createHash("sha256").update(shared).digest().subarray(0, 16);
        const decipher = crypto.createDecipheriv("aes-128-cbc", kem, Buffer.from(sealed.iv, "hex"));
        return `${Buffer.concat([decipher.update(Buffer.from(sealed.ct, "hex")), decipher.final()]).toString("utf8")}&hmac=${sealed.hmac}`;
      }
      const size = MODULUS_HEX.length;
      let out = "";
      for (let at = 0; at < sign.length; at += size) {
        const block = Buffer.from(sign.slice(at, at + size), "hex");
        const plain =
          padding === "oaep"
            ? crypto.privateDecrypt({ key: RSA.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, block)
            : crypto.privateDecrypt({ key: RSA.privateKey, padding: crypto.constants.RSA_NO_PADDING }, block);
        out += plain.toString("utf8").replace(/\0+$/, "");
      }
      return out;
    } catch {
      return null;
    }
  };

  const decrypt = (session: Pick<Session, "key" | "iv">, data: string, tag: string | null): string | null => {
    try {
      if (cipher === "gcm") {
        if (tag === null) return null;
        const decipher = crypto.createDecipheriv("aes-128-gcm", session.key, session.iv);
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
      }
      const decipher = crypto.createDecipheriv("aes-128-cbc", session.key, session.iv);
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  };

  const encrypt = (session: Pick<Session, "key" | "iv">, plain: string): string => {
    if (cipher === "gcm") {
      const c = crypto.createCipheriv("aes-128-gcm", session.key, session.iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
      return `${data}${c.getAuthTag().toString("base64")}`;
    }
    const c = crypto.createCipheriv("aes-128-cbc", session.key, session.iv);
    return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  };

  const fieldsOf = (text: string): Record<string, string> => Object.fromEntries(text.split("&").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

  /** A login's signature and payload: the session it asks for, or `null` when the router cannot read it. */
  const readLogin = (sign: string, data: string, tag: string | null): { session: Pick<Session, "key" | "iv">; fields: Record<string, string>; plain: string } | null => {
    const text = openSign(sign);
    if (text === null) return null;
    const fields = fieldsOf(text);
    const raw = (value: string | undefined): Buffer => (cipher === "gcm" ? Buffer.from(value ?? "", "base64") : Buffer.from(value ?? "", "utf8"));
    const session = { key: raw(fields["key"]), iv: raw(fields["iv"]) };
    if (session.key.length !== 16 || session.iv.length !== (cipher === "gcm" ? 12 : 16)) return null;
    const plain = decrypt(session, data, tag);
    return plain === null ? null : { session, fields, plain };
  };

  const checkLogin = (fields: Record<string, string>, data: string, user: string, password: string): string => {
    logins.push({ sign: fields, username: user, password });
    if (fields["h"] !== expectedHash || fields["s"] !== String(SEQ + data.length) || user !== username || password !== TPLINK_PASSWORD) {
      state.authTimes += 1;
      if (opts.silentRefusal) return "$.ret=0;\n";
      return `$.ret=71233;\nvar currAuthTimes=${state.authTimes};\nvar currForbidTime=${state.authTimes >= 5 ? 7200 : 0};\n`;
    }
    return opts.loginAnswer ?? "ok";
  };

  // ── The data model ─────────────────────────────────────────────────────────

  const lteStack = form === "mr" ? "2,1,0,0,0,0" : "1,0,0,0,0,0";
  const instanceOf = (oid: string, stack: string): Record<string, string> | Array<Record<string, string>> | null | "missing" => {
    const name = oid.replace(/^DEV2_/, "");
    if (opts.missing?.includes(name)) return "missing";
    if (name === "DEV_INFO" || oid === "IGD_DEV_INFO") return { modelName: form === "mr" ? "Archer MR600" : "Archer NX200", hardwareVersion: "Archer v2.0", softwareVersion: "1.3.0 0.9.1 v0001.0 Build 250101" };
    if (name === "LTE_LINK_CFG" || oid === "WAN_LTE_LINK_CFG") {
      const up = state.settings["dataSwitchStatusBackup"] === "1";
      return stack === lteStack ? { enable: "1", connectStatus: up ? "4" : "0", networkType: opts.networkType ?? (form === "mr" ? "7" : "8"), roamingStatus: "0", simStatus: state.simLock["pinState"] === "1" ? "4" : state.simLock["pinState"] === "2" ? "5" : "3" } : null;
    }
    if (name === "XTP_LTE_INTF_CFG" || oid === "WAN_LTE_INTF_CFG") return { ...state.dataPlan };
    if (name === "LTE_NET_STATUS") {
      // On the MR series: band 3 with band 1 next to it, by the modem's numbers for them
      return { smsUnreadCount: String(state.inbox.filter((m) => m.unread).length), sigLevel: "4", regStat: "1", rfInfoBand: String(122 | (120 << 8)), rfInfoRsrp: "-95", rfInfoRsrq: "-11", rfInfoSnr: "140", rfInfoRssi: "-65", ussdStatus: "0", smsSendResult: "0" };
    }
    if (name === "LTE_WAN_CFG") return stack === lteStack ? { ...state.settings } : null;
    if (name === "LTE_SIMLOCK") return stack === lteStack ? { ...state.simLock } : null;
    if (oid === "LTE_CELL_LOCK") return { ...state.cellLock };
    if (oid === (form === "mr" ? "LTE_PROFILE" : "DEV2_LTE_PROFILE")) return state.profiles.map((profile, i) => ({ stack: `${i + 1},0,0,0,0,0`, ...profile }));
    if (oid === "DEV2_LTE_BAND_SEARCH") return { ...state.bandSearch };
    if (oid === "DEV2_LTE_4G_CELL_LOCK") return { ...state.lteCellLock };
    if (oid === "DEV2_LTE_5G_CELL_LOCK") return { ...state.nrCellLock };
    if (oid === "DEV2_LTE_NETWORK_SEARCH") {
      const failed = opts.searchPolls === null && state.searchAsked !== null;
      const done = searched();
      return { ...state.networkSearch, status: failed ? "3" : done ? "2" : state.searchAsked === null ? "0" : "1", operatorList: done ? OPERATOR_LIST : "", setStatus: "0" };
    }
    if (oid === "LTE_NET_SEL") return { itemNum: searched() ? String(OPERATORS.length) : "0" };
    if (oid === "LTE_NET_SEL_LIST") return state.searchDone ? OPERATORS.map((entry, i) => ({ stack: `${i + 1},0,0,0,0,0`, ...entry })) : [];
    if (name === "LTE_PROF_STAT") return { spn: "Three", ispName: "Three", ...(tabled ? state.profStat : {}) };
    if (name === "LTE_SERVING_CELL_INFO") {
      return [
        { stack: "1,0,0,0,0,0", networkType: "3", cellConnectionStatus: "1", band: "1", ARFCN: "300", PCI: "211", cid: "134217758", TAC: "10001", RSRP: "-95", RSRQ: "-11", SNR: "110", RSSI: "-65", upBandWidth: "15000", downBandWidth: "20000", CQI: "12", RI: "2" },
        { stack: "2,0,0,0,0,0", networkType: "3", cellConnectionStatus: "1", band: "3", ARFCN: "1850", PCI: "142", RSRP: "-99", RSRQ: "-12", SNR: "90", RSSI: "268435455", downBandWidth: "15000" },
        { stack: "3,0,0,0,0,0", networkType: "8", cellConnectionStatus: "1", band: "78", ARFCN: "650000", PCI: "142", SSRSRP: "-88", SSRSRQ: "-10", SSSINR: "185", RSRP: "268435455", downBandWidth: "100000" },
        { stack: "4,0,0,0,0,0", networkType: "8", cellConnectionStatus: "0", band: "1", ARFCN: "428000", PCI: "5" },
      ];
    }
    if (oid === "WAN_IP_CONN") return [{ stack: "1,1,1,0,0,0", enable: "0", externalIPAddress: "0.0.0.0", connectionStatus: "Unconfigured" }, { stack: "2,1,1,0,0,0", enable: "1", externalIPAddress: "198.51.100.42", connectionStatus: "Connected" }];
    if (name === "ADT_WAN") return [{ stack: "1,0,0,0,0,0", enable: "1", connIPv4Address: "198.51.100.42", connStatusV4: "Connected" }];
    if (name === "HOST_ENTRY" || oid === "LAN_HOST_ENTRY") {
      const mac = form === "mr" ? "MACAddress" : "physAddress";
      const type = form === "mr" ? "X_TP_ConnType" : "X_TP_LanConnType";
      return [
        { stack: "1,0,0,0,0,0", [mac]: "02:00:5E:10:00:01", IPAddress: "192.168.1.100", hostName: "phone", [type]: "3", active: "1", leaseTimeRemaining: "3600" },
        { stack: "2,0,0,0,0,0", [mac]: "02:00:5E:10:00:02", IPAddress: "192.168.1.2", hostName: "nas", [type]: "0", active: "1", leaseTimeRemaining: "0" },
        { stack: "3,0,0,0,0,0", [mac]: "00:00:5E:00:53:01", IPAddress: "192.168.1.101", hostName: "gone", [type]: "1", active: "0", leaseTimeRemaining: "0" },
      ];
    }
    if (name === "LTE_SMS_RECVMSGBOX") return { totalNumber: String(state.inbox.length) };
    if (name === "LTE_SMS_SENDMSGBOX") return form === "mr" ? { totalNumber: String(state.outbox.length) } : "missing";
    const page = <T>(list: T[], number: number): T[] => list.slice((number - 1) * 8, number * 8);
    if (name === "LTE_SMS_RECVMSGENTRY") {
      return page(state.inbox, state.inboxPage).map((m, i) => ({ stack: `${i + 1},0,0,0,0,0`, index: String(m.index), from: m.from ?? "", content: m.content, receivedTime: m.time, unread: m.unread ? "1" : "0" }));
    }
    if (name === "LTE_SMS_SENDMSGENTRY") return form === "mr" ? page(state.outbox, state.outboxPage).map((m, i) => ({ stack: `${i + 1},0,0,0,0,0`, index: String(m.index), to: m.to ?? "", content: m.content, sendTime: m.time })) : "missing";
    if (name === "LTE_SMS_SENDNEWMSG") return { sendResult: String(opts.sendResult ?? 1) };
    if (name === "LTE_USSD") {
      const answered = state.ussdPending && typeof opts.ussdAnswer === "string";
      // An answer that ends with a question mark leaves the session open for a reply
      return { sessionStatus: answered && opts.ussdAnswer?.endsWith("?") ? "1" : "0", sendResult: "1", response: answered ? (opts.ussdAnswer ?? "") : "", ussdStatus: !state.ussdPending ? "0" : opts.ussdAnswer === null ? "2" : opts.ussdAnswer === undefined ? "0" : "1" };
    }
    return "missing";
  };

  /** Run one action against the model. `error`: the router's code for a refusal. */
  const run = (operation: string, oid: string, stack: string, attrs: Record<string, string>): { error: number; result: Record<string, string> | Array<Record<string, string>> | null } => {
    actions.push({ operation, oid, stack, attrs });
    const name = oid.replace(/^DEV2_/, "");
    if (operation === "cgi") {
      if (oid === "/cgi/logout") {
        state.session = null;
        state.loggedOut += 1;
      }
      return { error: 0, result: null };
    }
    if (opts.refuse === name && operation !== "get" && operation !== "list" && operation !== "getSub") return { error: 71013, result: null };
    if (operation === "run") {
      if (oid === "ACT_REBOOT") state.rebooted = true;
      return { error: oid === "ACT_REBOOT" ? 0 : 9000, result: null };
    }
    if (operation === "set" || operation === "del") {
      const position = Number(stack.split(",")[0]) - 1;
      if (name === "LTE_SMS_RECVMSGBOX") state.inboxPage = Number(attrs["PageNumber"] ?? attrs["pageNumber"] ?? "1");
      else if (name === "LTE_SMS_SENDMSGBOX") state.outboxPage = Number(attrs["PageNumber"] ?? "1");
      else if (name === "LTE_SMS_RECVMSGENTRY" || name === "LTE_SMS_SENDMSGENTRY") {
        const box = name === "LTE_SMS_RECVMSGENTRY" ? "inbox" : "outbox";
        const at = ((box === "inbox" ? state.inboxPage : state.outboxPage) - 1) * 8 + position;
        const entry = state[box][at];
        if (!entry) return { error: 9805, result: null };
        if (operation === "del") state[box] = state[box].filter((m) => m !== entry);
        else if (attrs["unread"] === "0") entry.unread = false;
      } else if (name === "LTE_SMS_SENDNEWMSG") {
        if (attrs["index"] !== "1") return { error: 9003, result: null };
        state.outbox = [{ index: state.outbox.length, to: attrs["to"] ?? "", content: attrs["textContent"] ?? "", time: "2026-10-12 08:00:00" }, ...state.outbox];
      } else if (name === "LTE_USSD") {
        state.ussdPending = attrs["action"] === "1";
        if (attrs["action"] === "2") state.ussdCancelled += 1;
      } else if (name === "LTE_WAN_CFG") {
        const { profileAction, ...rest } = attrs;
        const { profileID, activeProfile, ...fields } = rest;
        if (tabled && profileAction !== undefined && profileAction !== "0") {
          // The page with tables: 4 opens it, 2 adds a profile to a table, 1 saves one, 5 has the router dial with a table, 3 deletes a profile
          const { profileIndex, ...values } = fields;
          const at = (profile: Record<string, string>): boolean => profile["tableIndex"] === profileIndex && profile["profileID"] === profileID;
          const operatorTables = Number(state.profStat["ispTableCount"]);
          if (profileAction === "4") state.profileLoads += 1;
          else if (profileAction === "2") {
            if (profileIndex === undefined || Number(profileIndex) < operatorTables || state.profiles.some(at)) return { error: 9805, result: null };
            if (!state.profiles.some((profile) => profile["tableIndex"] === profileIndex)) state.profStat["usrTableCount"] = String(Number(state.profStat["usrTableCount"]) + 1);
            if (!opts.dropsNewProfile) state.profiles.push({ tableIndex: profileIndex, profileID: profileID ?? "", ...values });
          } else if (profileAction === "1") {
            const profile = state.profiles.find(at);
            if (!profile || Number(profileIndex) < operatorTables) return { error: 9805, result: null };
            Object.assign(profile, values);
          } else if (profileAction === "5") {
            const table = Number(profileIndex);
            if (!state.profiles.some((profile) => profile["tableIndex"] === profileIndex)) return { error: 9805, result: null };
            Object.assign(state.profStat, table < operatorTables ? { ispWhich: String(table), usrWhich: "255" } : { usrWhich: String(table - operatorTables) });
          } else if (profileAction === "3") state.profiles = state.profiles.filter((profile) => !at(profile));
          return { error: 0, result: null };
        }
        // The profile forms of the page without tables: 4 opens one, 2 creates a profile, 1 saves one and puts it in use, 3 deletes one
        if (profileAction === "4") state.profileLoads += 1;
        else if (profileAction === "2") {
          if (!opts.dropsNewProfile) state.profiles.push({ profileID: String(state.profiles.length), pdpType: "0", ...fields });
        } else if (profileAction === "1") {
          const profile = state.profiles[Number(profileID)];
          if (!profile || profile["profileID"] !== profileID) return { error: 9805, result: null };
          Object.assign(profile, fields);
          state.settings["activeProfile"] = activeProfile ?? state.settings["activeProfile"] ?? "0";
        } else if (profileAction === "3") state.profiles = state.profiles.filter((profile) => profile["profileID"] !== profileID);
        else Object.assign(state.settings, rest);
      } else if (oid === "LTE_CELL_LOCK") Object.assign(state.cellLock, attrs);
      else if (oid === "DEV2_LTE_BAND_SEARCH") Object.assign(state.bandSearch, attrs["selectedMode"] === "1" ? { selectedMode: "1", selectedBand: "" } : attrs);
      else if (oid === "DEV2_LTE_4G_CELL_LOCK") Object.assign(state.lteCellLock, attrs);
      else if (oid === "DEV2_LTE_5G_CELL_LOCK") Object.assign(state.nrCellLock, attrs);
      else if (oid === "DEV2_LTE_NETWORK_SEARCH" || oid === "LTE_NET_SEL") {
        if (attrs["action"] === "1" || attrs["searchAction"] === "1") {
          state.searchAsked = 0;
          state.searchDone = false;
        } else Object.assign(state.networkSearch, attrs);
      } else if (oid === "LTE_NET_SEL_LIST") Object.assign(state.networkSearch, { chosen: stack, ...attrs });
      else if (name === "LTE_SIMLOCK") {
        const right = attrs["pin"] === TPLINK_PIN;
        if (!right) {
          state.simLock["remainPinUnlockTime"] = String(Math.max(0, Number(state.simLock["remainPinUnlockTime"]) - 1));
          if (opts.pinError) return { error: 71040, result: null };
        } else {
          state.simLock["remainPinUnlockTime"] = "3";
          state.simLock["pinState"] = attrs["simAction"] === "2" ? "3" : "2";
          if (attrs["autoUnlockPin"] !== undefined) state.simLock["autoUnlockPin"] = attrs["autoUnlockPin"];
        }
      } else if (name === "XTP_LTE_INTF_CFG" || oid === "WAN_LTE_INTF_CFG") {
        const { adjustStatistics, ...rest } = attrs;
        Object.assign(state.dataPlan, rest);
        if (adjustStatistics !== undefined && adjustStatistics !== "-1") state.dataPlan["totalStatistics"] = `${adjustStatistics}.0`;
      } else return { error: 9000, result: null };
      return { error: 0, result: null };
    }
    const found = instanceOf(oid, stack);
    if (found === "missing") return { error: 9804, result: null };
    return { error: 0, result: found };
  };

  // ── Requests ───────────────────────────────────────────────────────────────

  const NOT_FOUND: LanReply = { status: 404, text: "<html><body>404 Not Found</body></html>" };
  const lines = (body: string): Record<string, string> => Object.fromEntries(body.split("\r\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  const signedIn = (req: LanRequestRecord): Session | null => {
    const session = state.session;
    if (session === null) return null;
    const cookies = (req.headers["cookie"] ?? "").split("; ");
    return cookies.includes(`JSESSIONID=${session.cookie}`) && (form === "ex" || cookies.includes("loginErrorShow=1")) ? session : null;
  };
  const openSession = (asked: Pick<Session, "key" | "iv">): { session: Session; setCookie: string[] } => {
    const session = { ...asked, cookie: `c${logins.length}0ffee5e55104`, token: `t0ken${logins.length}abcdef0123` };
    state.session = session;
    return { session, setCookie: [`JSESSIONID=${session.cookie}; Path=/; HttpOnly`] };
  };

  const command = (req: LanRequestRecord): LanReply => {
    const body = lines(req.body);
    const session = signedIn(req);
    // The EX and NX series: the login is the first action, before any session
    if (session === null && form === "ex") {
      const login = readLogin(body["sign"] ?? "", body["data"] ?? "", body["tag"] ?? null);
      if (login === null) return { status: 500, text: "" };
      const action = JSON.parse(login.plain) as { oid: string; operation: string; data: Record<string, string> };
      if (action.oid !== "/cgi/login" || action.operation !== "cgi") return { status: 500, text: "" };
      const text = checkLogin(login.fields, body["data"] ?? "", Buffer.from(action.data["UserName"] ?? "", "base64").toString("utf8"), Buffer.from(action.data["Passwd"] ?? "", "base64").toString("utf8"));
      if (text !== "ok") return { text: encrypt(login.session, text) };
      const opened = openSession(login.session);
      return { text: encrypt(login.session, "$.ret=0;\n"), setCookie: opened.setCookie };
    }
    if (session === null || req.headers["tokenid"] !== session.token) return { status: 500, text: "<html><title>500 Internal Server Error</title></html>" };
    const fields = fieldsOf(openSign(body["sign"] ?? "") ?? "");
    if (fields["h"] !== expectedHash || fields["s"] !== String(SEQ + (body["data"] ?? "").length) || fields["key"] !== undefined) return { status: 500, text: "" };
    const plain = decrypt(session, body["data"] ?? "", body["tag"] ?? null);
    if (plain === null) return { status: 500, text: "" };
    if (opts.ecc && fields["hmac"] !== crypto.createHmac("sha256", session.key).update(plain, "utf8").digest("hex")) return { status: 500, text: "" };
    if (form === "ex") {
      const action = JSON.parse(plain) as { oid: string; operation: string; data: Record<string, string>; isuseractive?: boolean };
      const operation = { go: "get", so: "set", ao: "add", do: "del", gl: "list", gs: "getSub", op: "run", cgi: "cgi" }[action.operation] ?? action.operation;
      const { stack = "", pstack: _pstack, ...attrs } = action.data;
      const done = run(operation, action.oid, stack, attrs);
      if (operation === "cgi") return { text: "" };
      return { text: encrypt(session, JSON.stringify(done.error === 0 ? { success: true, errorcode: 0, ...(done.result === null ? {} : { data: done.result }) } : { success: false, errorcode: done.error })) };
    }
    // The MR series: one frame, several numbered actions
    const [types = "", ...rest] = plain.split("\r\n");
    const codes = types.split("&");
    let index = -1;
    const blocks: Array<{ oid: string; stack: string; attrs: Record<string, string> }> = [];
    for (const line of rest) {
      const header = /^\[([^#\]]+)#([\d,]+)#[\d,]+\](\d+),(\d+)$/.exec(line);
      if (header) {
        index = Number(header[3]);
        blocks[index] = { oid: header[1] ?? "", stack: header[2] ?? "", attrs: {} };
      } else if (line !== "" && index >= 0) {
        const eq = line.indexOf("=");
        const block = blocks[index];
        if (block) block.attrs[eq < 0 ? line : line.slice(0, eq)] = eq < 0 ? "" : line.slice(eq + 1).replace(/\u0012/g, "\n").replace(/\u0011/g, "\r");
      }
    }
    let out = "";
    let error = 0;
    blocks.forEach((block, i) => {
      const operation = { "1": "get", "2": "set", "3": "add", "4": "del", "5": "list", "6": "getSub", "7": "run", "8": "cgi" }[codes[i] ?? ""] ?? "";
      const done = run(operation, block.oid, block.stack, block.attrs);
      if (done.error !== 0) error = done.error;
      if (operation === "cgi") out += `[cgi]${i}\n$.ret=0;\n`;
      const wanted = Object.keys(block.attrs);
      for (const one of done.result === null ? [] : Array.isArray(done.result) ? done.result : [{ stack: block.stack, ...done.result }]) {
        const { stack, ...attrs } = one;
        out += `[${stack}]${i}\n`;
        for (const [key, value] of Object.entries(attrs)) if (wanted.length === 0 || wanted.includes(key)) out += `${key}=${value.replace(/\r/g, "\u0011").replace(/\n/g, "\u0012")}\n`;
      }
    });
    return { text: encrypt(session, `${out}[error]${error}\n`) };
  };

  const scriptText = `/* tpEncrypt */ var cipher = ${cipher === "gcm" ? "sjcl.mode.gcm" : "CryptoJS.mode.CBC"}; var rsaEncrypt = ${padding === "oaep" ? "$.rsa.encryptOAEP" : "$.rsa.encrypt"};`;
  const keyAnswer = (): LanReply =>
    opts.ecc
      ? { json: { eccPubKey_X_HEX: ecdh.getPublicKey().subarray(1, 29).toString("hex"), eccPubKey_Y_HEX: ecdh.getPublicKey().subarray(29).toString("hex"), userSetting: 1, seq: String(SEQ), ret: 0 } }
      : { text: `[cgi]0\nvar ee="${EXPONENT_HEX}";\nvar nn="${MODULUS_HEX}";\nvar seq="${SEQ}";\n$.ret=0;\n[error]0\n` };

  const mock = new LanRouterMock((req) => {
    if (req.method === "GET" && req.path === "/") {
      const session = signedIn(req);
      if (session) return { text: `<html><head><script type="text/javascript">var token="${session.token}";</script></head><body></body></html>` };
      return { text: `<html><body><script type="text/javascript">var authTimes=${state.authTimes};var forbidFlag=${opts.forbidSec ? 1 : 0};var forbidTime=${opts.forbidSec ?? 0};</script></body></html>` };
    }
    if (req.method === "GET" && req.path === "/js/tpEncrypt.js") return opts.script ?? { text: scriptText };
    if (req.method === "GET" && req.path === "/js/oid_str.js") return { text: opts.buildFlags ?? "var INCLUDE_LTEWAN=1,INCLUDE_LTE_SEARCH_BAND=1,INCLUDE_LTE_CELL_LOCK=1,INCLUDE_LTE_ANTENNA_TYPE=0,INCLUDE_USSD=1;" };
    if (req.method !== "POST") return NOT_FOUND;
    if (req.path === (form === "mr" ? "/cgi/getParm" : "/cgi/getGDPRParm")) return keyAnswer();
    if (req.path === "/cgi/getBusy") return { text: `var isLogined=${opts.busy ? 1 : 0};\nvar isBusy=0;\n` };
    if (req.path === "/cgi/login" && form === "mr") {
      const data = req.query.get("data") ?? "";
      const login = readLogin(req.query.get("sign") ?? "", data, null);
      if (login === null || req.query.get("Action") !== "1" || req.query.get("LoginStatus") !== "0") return { text: "$.ret=71234;\n" };
      const [user = "", password = ""] = login.plain.split("\n");
      const text = checkLogin(login.fields, data, user, password);
      if (text !== "ok") return { text, setCookie: ["JSESSIONID=deleted; Path=/"] };
      return { text: "$.ret=0;\n", setCookie: openSession(login.session).setCookie };
    }
    if (req.path === "/cgi_gdpr" && (form === "mr" ? req.query.size === 0 : req.query.has("9"))) return command(req);
    return NOT_FOUND;
  });
  const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, client, state, actions, logins, modulusHex: MODULUS_HEX, exponentHex: EXPONENT_HEX, seq: SEQ, privateKey: RSA.privateKey };
}
