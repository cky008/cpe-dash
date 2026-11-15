import crypto from "node:crypto";
import type { ApnAuthMode, ApnView, NetworkMode } from "../../cellular.ts";
import { type DriverCell, emptyCell } from "../../protocols/readings.ts";
import { arfcnOf, counterOf, fieldOf, iccidOf, identityOf, imeiOf, imsiOf, intOf, ipv4Of, ipv6Of, isPlainObject, labelOf, msisdnOf, nonNegativeOf, plmnCodeOf, rsrpOf, rsrqOf, rssiOf, sinrOf, smallIntOf, textOf } from "../../protocols/values.ts";
import type { SmsWireMessage } from "../../sms/types.ts";
import { lteBandOfIndex } from "../bands.ts";
import { bandOfChannel, servingModeOf } from "../cells.ts";
import { dateOfParts, wireMessage } from "../sms.ts";
import { cellHasData } from "../snapshot.ts";
import type { DriverHost, DriverTelemetry } from "../types.ts";

/**
 * What D-Link's DWR 4G routers (DWR-960, DWR-961) answer on `data.ria`, read into FengSui's shapes.
 * Nothing here sends a request: the session that does is in `./driver.ts`.
 */

// ── Login ────────────────────────────────────────────────────────────────────

/**
 * A password as the newer login page (`login.html`) writes it before sending: every character
 * becomes four digits, its decimal code with the last digit replaced by that digit's own character
 * code (`H`, 72, is `0750`; `z`, 122, is `1250`). `null`: a character the page's function has no
 * form for (a code of four digits or more).
 */
export function dlinkEncodedPassword(password: string): string | null {
  let out = "";
  for (let i = 0; i < password.length; i += 1) {
    const digits = String(password.charCodeAt(i));
    if (digits.length > 3) return null;
    const last = String(digits.charCodeAt(digits.length - 1));
    out += `${digits.slice(0, -1).padStart(2, "0")}${last}`;
  }
  return out;
}

// ── Signal ───────────────────────────────────────────────────────────────────

/** The LTE band behind the number the router names it by (`bm_currentBand`): the modem's own number for it (`null`: not an LTE band). */
export function dlinkBandOf(code: unknown): number | null {
  const n = intOf(code);
  return n === null ? null : lteBandOfIndex(n);
}

function recordOf(value: unknown, key: string): Record<string, unknown> | null {
  const inner = fieldOf(value, key);
  return isPlainObject(inner) ? inner : null;
}

/** `1` (or `true`) as the router writes a flag; `null` when it wrote nothing readable. */
function flagOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const n = intOf(value);
  return n === null ? null : n === 1;
}

/**
 * One poll in FengSui's shape: `up_5s` (the connection, the SIM card, the uptime), and where the
 * router answered them `get_networkserviceinfo` (the serving cell), `nw_usage` (the traffic of the
 * billing period) and `about_sys` (what the router is). The interface names no PCI.
 */
export function parseDlinkTelemetry(
  status: Record<string, unknown>,
  service: Record<string, unknown> | null,
  usage: Record<string, unknown> | null,
  about: Record<string, unknown> | null
): DriverTelemetry {
  const modem = recordOf(recordOf(status, "signal"), "modem");
  const v = (key: string): unknown => fieldOf(service, key);
  const serviceName = textOf(v("service_type")) ?? textOf(fieldOf(modem, "service"));
  // 2G has no name among FengSui's serving modes: it stays unnamed rather than count as no service
  const mode = servingModeOf(serviceName) ?? (serviceName !== null && /NO SIM/i.test(serviceName) ? "NONE" : null);
  const arfcn = arfcnOf(v("earfcn"), "LTE", { zeroIsNone: true });
  const cell: DriverCell = {
    ...emptyCell(),
    band: dlinkBandOf(v("bm_currentBand")) ?? bandOfChannel("LTE", arfcn),
    arfcn,
    rsrpDbm: rsrpOf(v("rsrp")),
    rsrqDb: rsrqOf(v("rsrq")),
    sinrDb: sinrOf(v("sinr")),
    // The strength the status names in dBm is the received power, never an RSRP
    rssiDbm: rssiOf(v("rssi")) ?? rssiOf(fieldOf(modem, "strength")),
    cellId: identityOf(v("cell_id"), 10),
    tac: identityOf(v("tac"), 10),
  };
  const ipv4 = recordOf(status, "ipv4");
  const ipv6 = recordOf(status, "ipv6");
  const connected = [ipv4, ipv6].map((ip) => textOf(fieldOf(ip, "status")));
  const operator = labelOf(v("oper_name")) ?? labelOf(fieldOf(modem, "op_name"));
  const down = counterOf(fieldOf(usage, "rx"));
  const up = counterOf(fieldOf(usage, "tx"));
  const level = smallIntOf(fieldOf(modem, "level"), 5);
  const sim = flagOf(fieldOf(recordOf(status, "sim_status"), "status"));
  return {
    model: labelOf(fieldOf(about, "model_name")),
    softwareVersion: labelOf(fieldOf(about, "fw_ver")),
    hardwareVersion: labelOf(fieldOf(about, "hw_ver")),
    operatorName: operator !== null && /^NO SIM$/i.test(operator) ? null : operator,
    plmn: plmnCodeOf(v("PLMN")),
    mode,
    // A firmware that names the received power alone still has a 4G cell to show
    lte: mode === "LTE" && (cellHasData(cell) || cell.rssiDbm !== null) ? cell : null,
    nr: null,
    carriers: [],
    wan: {
      connected: connected.every((state) => state === null) ? null : connected.includes("Connected"),
      ipv4: ipv4Of(fieldOf(ipv4, "ip")),
      ipv6: ipv6Of(fieldOf(ipv6, "ip")),
      uptimeSec: null,
    },
    traffic:
      usage === null
        ? null
        : {
            downloadBytesPerSec: null,
            uploadBytesPerSec: null,
            // The period's counters only grow until the router starts a new period: the polls take the rate from them
            totalDownloadBytes: down,
            totalUploadBytes: up,
            sessionDownloadBytes: null,
            sessionUploadBytes: null,
            sessionSeconds: null,
            monthDownloadBytes: down,
            monthUploadBytes: up,
            monthTotalBytes: null,
            monthSeconds: null,
          },
    temperatureC: null,
    signalBars: level,
    status: {
      sim: { state: sim === null ? null : sim ? "ready" : "absent", pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null },
      roaming: { active: flagOf(v("roaming")) ?? flagOf(fieldOf(modem, "roaming")), dataAllowed: null },
      system: { uptimeSec: nonNegativeOf(fieldOf(status, "system_uptime")), cpuPercent: null, memoryPercent: null },
    },
    ids: { imei: imeiOf(fieldOf(about, "imei")), imsi: imsiOf(fieldOf(about, "imsi")), iccid: iccidOf(fieldOf(about, "iccid")), msisdn: msisdnOf(fieldOf(about, "my_number")) },
  };
}

/** Whether `up_5s` reports the mobile connection up (`null`: it said nothing of it). */
export function dlinkConnected(status: Record<string, unknown>): boolean | null {
  const states = ["ipv4", "ipv6"].map((key) => textOf(fieldOf(recordOf(status, key), "status")));
  return states.every((state) => state === null) ? null : states.includes("Connected");
}

// ── Connected devices ────────────────────────────────────────────────────────

const HOST_LISTS: ReadonlyArray<readonly [string, DriverHost["link"]]> = [
  ["WiFi_2.4G_clilist", "wifi_2_4"],
  ["WiFi_5G_clilist", "wifi_5"],
  ["lan_clilist", "lan"],
];

/** `get_client_list`: one list per band and one for the cable, each entry a name, an address and a MAC. */
export function parseDlinkHosts(answer: Record<string, unknown>): DriverHost[] {
  const hosts: DriverHost[] = [];
  for (const [key, link] of HOST_LISTS) {
    const list = fieldOf(answer, key);
    if (!Array.isArray(list)) continue;
    for (const entry of list.slice(0, 256)) {
      const mac = textOf(fieldOf(entry, "mac"));
      if (mac === null) continue;
      hosts.push({ mac, name: labelOf(fieldOf(entry, "hname")), ipv4: ipv4Of(fieldOf(entry, "ip")), ipv6: [], link, connectedSec: null, leaseSec: nonNegativeOf(fieldOf(entry, "leasetm")), rssiDbm: null });
    }
  }
  return hosts;
}

// ── SMS ──────────────────────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Text the router escaped for its own page (`&amp;`, `&#39;`, `&#x2F;`) as plain text. */
export function dlinkPlainText(escaped: string): string {
  return escaped.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,6}));/g, (whole: string, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}

/**
 * The number FengSui names a message by: the router names it by a tag, which is used as it is when
 * it is a number, and otherwise stands behind a number made from it (the same tag always gives the
 * same number, so a later write finds the message again by listing).
 */
export function dlinkSmsHandle(tag: string): number {
  if (/^[1-9]\d{0,14}$/.test(tag)) return Number(tag);
  return (crypto.createHash("sha256").update(tag, "utf8").digest().readUInt32BE(0) & 0x7fffffff) || 1;
}

/** The longest text read of one message before the page's escapes are undone (a long message of the most parts fits). */
const MAX_SMS_CHARS = 40_000;

export interface DlinkSms {
  /** The router's own name for the message: what marking it read or deleting it sends. */
  tag: string;
  message: SmsWireMessage;
}

/**
 * The inbox (`sms_action`, `cont=inbox`): `total` messages under `M1`, `M2`…, each a sender, a time
 * (`yy/MM/dd HH:mm:ss`), the text escaped for the page, a tag and whether it was read.
 */
export function parseDlinkInbox(answer: Record<string, unknown>): DlinkSms[] {
  const total = Math.min(smallIntOf(fieldOf(answer, "total"), 10_000) ?? 0, 1000);
  const out: DlinkSms[] = [];
  for (let i = 1; i <= total; i += 1) {
    const entry = fieldOf(answer, `M${i}`);
    const tag = textOf(fieldOf(entry, "tag"));
    if (!isPlainObject(entry) || tag === null) continue;
    const text = fieldOf(entry, "msg");
    out.push({
      tag,
      message: wireMessage({
        index: dlinkSmsHandle(tag),
        phone: textOf(fieldOf(entry, "phone")) ?? "",
        date: dateOfParts((textOf(fieldOf(entry, "date")) ?? "").split(/[/\s:.-]+/)),
        unread: flagOf(fieldOf(entry, "read")) === false,
        outgoing: false,
        content: typeof text === "string" ? dlinkPlainText(text.slice(0, MAX_SMS_CHARS)) : "",
      }),
    });
  }
  return out;
}

// ── Network mode and access point ────────────────────────────────────────────

/** The network type the router prefers (`netpref_value`), by the names its page gives the choices. */
const NETWORK_PREFERENCES: Readonly<Partial<Record<NetworkMode, string>>> = { auto: "0", lte: "6", wcdma: "7", gsm: "8" };

export const DLINK_NETWORK_MODES: ReadonlyArray<NetworkMode> = ["auto", "lte", "wcdma", "gsm"];

export function dlinkPreferenceOf(mode: NetworkMode): string | null {
  return NETWORK_PREFERENCES[mode] ?? null;
}

/** How the router writes the way an access point signs in (`3`: it chooses). */
const AUTH_CODES: Readonly<Record<ApnAuthMode, string>> = { none: "0", pap: "1", chap: "2" };

export function dlinkAuthCode(auth: ApnAuthMode): string {
  return AUTH_CODES[auth];
}

/** The settings `get_apn_cfg` reports: the preferred network type, whether the router dials by itself, and the access point in use. */
export interface DlinkApnSettings {
  networkMode: NetworkMode | null;
  /** The router connects by itself (`false`: someone has to press connect). */
  autoConnect: boolean | null;
  /** The access point as the router keeps it; `password` never leaves the session it was read in. */
  profile: { manual: boolean | null; apn: string; username: string; password: string; auth: string; pdpType: string } | null;
}

export function parseDlinkApn(answer: Record<string, unknown>): DlinkApnSettings {
  const apn = recordOf(answer, "apn");
  const common = recordOf(apn, "COMMON");
  const profile = recordOf(apn, "APN_0");
  const preference = textOf(fieldOf(common, "netpref_value"));
  const type = intOf(fieldOf(profile, "type"));
  const raw = (key: string): string => {
    const value = fieldOf(profile, key);
    return typeof value === "string" ? value.slice(0, 128) : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  };
  return {
    networkMode: (Object.entries(NETWORK_PREFERENCES) as Array<[NetworkMode, string]>).find(([, code]) => code === preference)?.[0] ?? null,
    autoConnect: flagOf(fieldOf(common, "auto_conx")),
    profile: profile === null ? null : { manual: type === null ? null : type === 1, apn: raw("apn"), username: raw("uname"), password: raw("passwd"), auth: raw("auth"), pdpType: raw("pdp_type") },
  };
}

/** The access point in use as FengSui shows it (the router's number for the IP type has no name on record). */
export function dlinkApnView(settings: DlinkApnSettings): ApnView | null {
  const profile = settings.profile;
  if (profile === null) return null;
  const auth = (Object.entries(AUTH_CODES) as Array<[ApnAuthMode, string]>).find(([, code]) => code === profile.auth)?.[0] ?? null;
  return { mode: profile.manual === null ? null : profile.manual ? "manual" : "auto", apn: labelOf(profile.apn, 100), ipType: null, auth, hasUsername: profile.username !== "" };
}
