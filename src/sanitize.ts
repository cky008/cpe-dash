import net from "node:net";
import { isPrivateOrLanIpv4, isPrivateOrLanIpv6 } from "./config.ts";
import type { DeviceReport } from "./device-profile.ts";
import type { FieldFormatObservation } from "./types.ts";

export { maskPhoneNumber } from "./privacy-mask.ts";

const TAG_PLACEHOLDERS: Readonly<Record<string, string>> = {
  imei: "860000000000000",
  imeisvn: "01",
  imsi: "272010000000000",
  iccid: "8935301000000000000",
  eid: "89000000000000000000000000000000",
  msisdn: "+353830000000",
  phone: "+353830000000",
  scacode: "+353830000000",
  sca: "+353830000000",
  serialnumber: "SN00000000000000",
  sn: "SN00000000000000",
  macaddress: "00:00:5E:00:53:01",
  macaddress1: "00:00:5E:00:53:01",
  macaddress2: "00:00:5E:00:53:02",
  wanmacaddress: "00:00:5E:00:53:10",
  lanmacaddress: "00:00:5E:00:53:11",
  bssid: "00:00:5E:00:53:20",
  nr_bssid: "00:00:5E:00:53:21",
  associateddevicemacaddress: "00:00:5E:00:53:30",
  parentmacaddress: "00:00:5E:00:53:31",
  tac: "10001",
  nrtac: "10001",
  nr_tac: "10001",
  lac: "1001",
  rac: "01",
  cell_id: "134217758",
  cellid: "134217758",
  nrcellid: "17179869191",
  nr_cellid: "17179869191",
  enodeb_id: "0524288",
  enodebid: "0524288",
  gnodeb_id: "4194305",
  gnodebid: "4194305",
  cgi: "27201-134217758",
  nrcgi: "27201-17179869191",
  wanipaddress: "198.51.100.42",
  externalipaddress: "198.51.100.42",
  primarydns: "198.51.100.53",
  secondarydns: "203.0.113.53",
  wanipv6address: "2001:db8::42",
  primaryipv6dns: "2001:db8::53",
  secondaryipv6dns: "2001:db8::54",
  ssid: "FengSui_Lab_WiFi",
  wifissid: "FengSui_Lab_WiFi",
  guestssid: "FengSui_Guest_WiFi",
  hostname: "lan-client-01",
  actualname: "lan-client-01",
  wpapsk: "<REDACTED_SECRET>",
  wifiwepkey1: "<REDACTED_SECRET>",
  password: "<REDACTED_SECRET>",
  currentpassword: "<REDACTED_SECRET>",
  newpassword: "<REDACTED_SECRET>",
  presharedkey: "<REDACTED_SECRET>",
  sharedkey: "<REDACTED_SECRET>",
  pppusername: "apn-user",
  ppppassword: "<REDACTED_SECRET>",
  apnname: "internet.example",
  salt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  firstnonce: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  servernonce: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  finalnonce: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  clientproof: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  serversignature: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  ecc_server_pubkey: "08112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  ecc_pubkey_signature: "99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa",
  token: "0000000000000000000000000000000011111111111111111111111111111111",
};

const SAFE_ROUTER_MODELS = new Set(["H168-383", "H158-381", "H155-381", "H155-382", "B818-263"]);

/**
 * Inspect structural format metadata of a field value without exposing raw sensitive characters.
 */
export function inspectFieldFormat(tag: string, rawValue: string | null | undefined): FieldFormatObservation {
  const val = (rawValue ?? "").trim();
  if (!val) {
    return { tag, present: false, byteLength: 0, encodingHint: "empty" };
  }
  let encodingHint: FieldFormatObservation["encodingHint"] = "text";
  if (/^-?\d+$/.test(val)) {
    encodingHint = "decimal";
  } else if (/^0x[0-9a-fA-F]+$/.test(val)) {
    encodingHint = "prefixed-hex";
  } else if (/^[0-9a-fA-F]+$/.test(val)) {
    encodingHint = "hex";
  } else if (/^(?:B|N|n)\d+/i.test(val)) {
    encodingHint = "band-label";
  } else if (/^-?\d+(?:\.\d+)?\s*(?:dBm|dB|MHz|kHz|Mbps|kbps|B|KB|MB|GB|%)/i.test(val)) {
    encodingHint = "unit-value";
  }
  return {
    tag,
    present: true,
    byteLength: Buffer.byteLength(val, "utf8"),
    encodingHint,
  };
}

/**
 * Mask a MAC address deterministically to RFC 7042 documentation range (`00:00:5E:00:53:xx`).
 */
export function maskMacAddress(mac: string, index = 1): string {
  if (!mac.trim()) return "";
  const suffix = (index & 0xff).toString(16).toUpperCase().padStart(2, "0");
  return `00:00:5E:00:53:${suffix}`;
}

/**
 * Sanitize an arbitrary IPv4/IPv6 string:
 * - Preserves `192.168.8.x` LAN addresses and `127.0.0.1` / `::1` / `fe80::` link-local prefix.
 * - Replaces public IPv4 or Tailscale CGNAT (`100.64.0.0/10`) with RFC 5737 `198.51.100.42`.
 * - Replaces global unicast IPv6 with RFC 3849 `2001:db8::42`.
 */
export function sanitizeIpToken(raw: string): string {
  const clean = raw.trim();
  if (!clean) return clean;
  // Handle semicolon-separated IPv6 lists from Huawei host-list (e.g. "fe80::1;2a02:xxxx::1")
  if (clean.includes(";")) {
    return clean
      .split(";")
      .map((part) => (part.trim() ? sanitizeIpToken(part) : ""))
      .join(";");
  }
  const ipOnly = clean.split("/")[0]?.trim() ?? clean;
  const cidrSuffix = clean.includes("/") ? `/${clean.split("/")[1]}` : "";
  const ver = net.isIP(ipOnly);
  if (ver === 4) {
    if (ipOnly.startsWith("192.168.8.") || ipOnly === "127.0.0.1" || ipOnly === "0.0.0.0" || ipOnly.startsWith("255.")) {
      return clean;
    }
    if (ipOnly.startsWith("198.51.100.") || ipOnly.startsWith("203.0.113.") || ipOnly.startsWith("192.0.2.")) {
      return clean;
    }
    if (isPrivateOrLanIpv4(ipOnly) && !ipOnly.startsWith("100.")) {
      return `192.168.8.${ipOnly.split(".")[3] ?? "100"}${cidrSuffix}`;
    }
    return `198.51.100.42${cidrSuffix}`;
  }
  if (ver === 6) {
    const lower = ipOnly.toLowerCase();
    if (lower === "::1" || lower === "::" || lower.startsWith("2001:db8:")) {
      return clean;
    }
    if (isPrivateOrLanIpv6(lower) && lower.startsWith("fe80:")) {
      return `fe80::1${cidrSuffix}`;
    }
    return `2001:db8::42${cidrSuffix}`;
  }
  return clean;
}

/**
 * Scrub free-form text (headers, URLs, or unknown XML values) of MACs, public IPs, IMEI/IMSI/ICCID, and secrets.
 */
export function sanitizeFreeText(input: string, extraSecrets: ReadonlyArray<string> = []): string {
  if (!input) return input;
  let out = input;
  for (const sec of extraSecrets) {
    if (sec && sec.length >= 4) {
      out = out.split(sec).join("<REDACTED_ENV_SECRET>");
    }
  }
  // Redact ecc-client-pubkey query values
  out = out.replace(/ecc-client-pubkey=[0-9a-fA-F]{16,128}/gi, "ecc-client-pubkey=<REDACTED_ECC_PUBKEY>");
  // Redact MAC addresses (excluding already-masked 00:00:5E:00:53:xx)
  let macCounter = 1;
  out = out.replace(/\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, (match) => {
    if (/^00:00:5E:00:53:[0-9A-Fa-f]{2}$/i.test(match)) return match.toUpperCase();
    return maskMacAddress(match, macCounter++);
  });
  // Redact 19-20 digit ICCIDs and 15-digit IMEI/IMSI numbers
  out = out.replace(/\b89\d{17,18}\b/g, "8935301000000000000");
  out = out.replace(/\b\d{15}\b/g, "860000000000000");
  // Redact IPv4 addresses via sanitizeIpToken
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/g, (m) => sanitizeIpToken(m));
  return out;
}

/**
 * Sanitize an XML document by replacing all sensitive tag contents (IMEI, IMSI, MAC, WAN IP,
 * TAC, CellID, gNodeB ID, SSID, nonces, tokens, client hostnames) with RFC-compliant placeholders
 * while preserving tag hierarchy, empty-vs-populated semantics, and RF physics metrics.
 */
export function sanitizeXml(xml: string, extraSecrets: ReadonlyArray<string> = []): string {
  if (!xml) return xml;
  let scrubbed = xml;
  for (const sec of extraSecrets) {
    if (sec && sec.length >= 4) {
      scrubbed = scrubbed.split(sec).join("<REDACTED_ENV_SECRET>");
    }
  }

  let hostSeq = 1;
  let macSeq = 1;

  scrubbed = scrubbed.replace(
    /<([A-Za-z0-9_:-]+)>([^<]*)<\/\1>/g,
    (full, rawTag: string, rawVal: string) => {
      const val = rawVal.trim();
      if (!val) return full;
      const lowerTag = rawTag.toLowerCase();

      if (lowerTag === "devicename") {
        if (SAFE_ROUTER_MODELS.has(val) || /^H\d{3}-\d{3}$/i.test(val)) {
          return `<${rawTag}>${val}</${rawTag}>`;
        }
        const alias = `lan-client-${String(hostSeq++).padStart(2, "0")}`;
        return `<${rawTag}>${alias}</${rawTag}>`;
      }

      if (lowerTag === "hostname" || lowerTag === "actualname") {
        const alias = `lan-client-${String(hostSeq++).padStart(2, "0")}`;
        return `<${rawTag}>${alias}</${rawTag}>`;
      }

      if (lowerTag.includes("mac") || lowerTag.endsWith("bssid")) {
        return `<${rawTag}>${maskMacAddress(val, macSeq++)}</${rawTag}>`;
      }

      if (
        lowerTag.includes("ipaddress") ||
        lowerTag.includes("ipv6") ||
        lowerTag.includes("dns") ||
        lowerTag.endsWith("ip")
      ) {
        return `<${rawTag}>${sanitizeIpToken(val)}</${rawTag}>`;
      }

      const directPlaceholder = TAG_PLACEHOLDERS[lowerTag];
      if (directPlaceholder !== undefined) {
        return `<${rawTag}>${directPlaceholder}</${rawTag}>`;
      }

      if (
        lowerTag.includes("tac") ||
        lowerTag.includes("cellid") ||
        lowerTag.includes("cell_id") ||
        lowerTag.includes("nodeb")
      ) {
        return `<${rawTag}>${lowerTag.includes("tac") ? "10001" : "134217758"}</${rawTag}>`;
      }

      if (
        lowerTag.includes("password") ||
        lowerTag.includes("psk") ||
        lowerTag.includes("secret")
      ) {
        return `<${rawTag}>&lt;REDACTED_SECRET&gt;</${rawTag}>`;
      }

      return `<${rawTag}>${sanitizeFreeText(rawVal, extraSecrets)}</${rawTag}>`;
    }
  );

  return sanitizeFreeText(scrubbed, extraSecrets);
}

/**
 * Sanitize a JSON response string (such as `/api/system/HostInfo` or `/api/system/topology`)
 * by masking MAC addresses, hostnames/aliases, Wi-Fi SSIDs/keys, and non-LAN IP addresses.
 */
export function sanitizeJsonPayload(
  rawJson: string,
  extraSecrets: ReadonlyArray<string> = []
): string {
  const trimmed = rawJson.trim();
  if (!trimmed) return rawJson;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return sanitizeFreeText(rawJson, extraSecrets);
  }

  let macSeq = 1;
  let hostSeq = 1;

  const scrubNode = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => scrubNode(item));
    }
    if (node && typeof node === "object") {
      const out = Object.create(null) as Record<string, unknown>;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lk = k.toLowerCase();
        if (typeof v === "string" && v.trim()) {
          if (lk.includes("mac") || lk.endsWith("bssid") || lk === "id" && /([0-9a-f]{2}:){5}[0-9a-f]{2}/i.test(v)) {
            out[k] = maskMacAddress(v, macSeq++);
            continue;
          }
          if (lk === "hostname" || lk === "actualname" || lk === "devicename") {
            out[k] = SAFE_ROUTER_MODELS.has(v) ? v : `lan-client-${String(hostSeq++).padStart(2, "0")}`;
            continue;
          }
          if (lk.includes("ipaddress") || lk.includes("ipv6") || lk.includes("dns") || lk === "ip") {
            out[k] = sanitizeIpToken(v);
            continue;
          }
          if (lk.includes("ssid")) {
            out[k] = "FengSui_Lab_WiFi";
            continue;
          }
          if (lk.includes("password") || lk.includes("psk") || lk.includes("secret") || lk.includes("key")) {
            out[k] = "<REDACTED_SECRET>";
            continue;
          }
          if (lk.includes("serial") || lk === "sn") {
            out[k] = "SN00000000000000";
            continue;
          }
          out[k] = sanitizeFreeText(v, extraSecrets);
        } else {
          out[k] = scrubNode(v);
        }
      }
      return out;
    }
    return node;
  };

  return JSON.stringify(scrubNode(parsed));
}

const REPORT_MAC = /(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}/;
/** IMEI, IMSI, ICCID and dialled numbers: no report value has ten digits in a row. */
const REPORT_DIGIT_RUN = /\d{10,}/;
const REPORT_PHONE = /\+\d{6,}/;
const REPORT_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
/** Report keys whose values come from the router's allowlist: versions there may look like `4.4.0.1`. */
const REPORT_ALLOWLISTED_KEYS: ReadonlySet<string> = new Set(["model", "marketingName", "softwareVersion", "webUiVersion", "passwordType", "value"]);

/** A MAC, an IP address, a long digit run or a phone number anywhere in `text`. */
function looksLikeIdentifier(text: string, versionsAllowed: boolean): boolean {
  if (REPORT_MAC.test(text) || REPORT_DIGIT_RUN.test(text) || REPORT_PHONE.test(text)) return true;
  if (!versionsAllowed && REPORT_IPV4.test(text)) return true;
  // IPv6: a hex run with `::`, or eight colon-separated groups (a time such as 08:00:00 has three)
  return text.split(/[^0-9A-Fa-f:]+/).some((token) => (token.includes("::") ? /[0-9A-Fa-f]/.test(token) : token.split(":").length >= 8));
}

/**
 * Second pass over a device report, which is built from structure and the allowlist only. A string
 * that still looks like an identifier becomes `<redacted>`. Allowlisted values (model, versions,
 * `password_type`, switch numbers) may hold a dotted version like `4.4.0.1`; every other string may
 * not even look like an IPv4 address.
 */
export function sanitizeDeviceReport(report: DeviceReport): DeviceReport {
  const walk = (node: unknown, key: string): unknown => {
    if (typeof node === "string") return looksLikeIdentifier(node, REPORT_ALLOWLISTED_KEYS.has(key)) ? "<redacted>" : node;
    if (Array.isArray(node)) return node.map((item) => walk(item, key));
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k !== "__proto__" && k !== "constructor" && k !== "prototype") out[k] = walk(v, k);
      }
      return out;
    }
    return node;
  };
  return walk(report, "") as DeviceReport;
}
