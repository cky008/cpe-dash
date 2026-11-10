/**
 * IEEE 802.11 information elements (beacons and probe responses) and GNSS carriers, for routers that
 * report a Wi-Fi scan or satellite measurements. Field positions follow IEEE 802.11-2020 §9.4.2 and
 * IEEE 802.11ax-2021 / 802.11be: element IDs, extension element IDs (element 255, the first payload
 * byte), the HT / VHT / HE / EHT capability and operation layouts, RSN suites (§9.4.2.24) and the
 * country string. GNSS carriers follow the constellations' interface documents (GPS IS-GPS-200/705,
 * GLONASS ICD, Galileo OS SIS ICD, BeiDou ICD, QZSS IS-QZSS, NavIC SPS ICD).
 *
 * Imports nothing; every parser bounds its input and never throws on a malformed element.
 */

/** Longest IE blob parsed (a beacon body fits in 2304 bytes, IEEE 802.11 MMPDU limit). */
export const MAX_IE_BYTES = 4096;

export interface VendorElement {
  /** OUI as six upper-case hex digits (`0050F2`). */
  oui: string;
  /** The first byte after the OUI (vendor type), `null` when absent. */
  type: number | null;
}

export interface ParsedElements {
  /** Element payloads by key: `"0B"` for element 11, `"FF.6A"` for extension 106 (extension ID stripped). */
  elements: Map<string, Uint8Array>;
  vendors: VendorElement[];
  /** The blob ended inside an element (the rest was ignored). */
  truncated: boolean;
}

function hexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function isHexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** Hex text to bytes, ignoring separators (`:`, spaces, dashes); `null` for an odd digit count or a non-hex character. */
export function hexToBytes(text: string): Uint8Array | null {
  const digits: number[] = [];
  for (let i = 0; i < text.length && digits.length < MAX_IE_BYTES * 2; i++) {
    const code = text.charCodeAt(i);
    if (isHexDigit(code)) digits.push(code);
    else if (code !== 0x3a && code !== 0x20 && code !== 0x2d && code !== 0x09) return null;
  }
  if (digits.length % 2 !== 0) return null;
  const out = new Uint8Array(Math.min(digits.length / 2, MAX_IE_BYTES));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(String.fromCharCode(digits[2 * i] ?? 48, digits[2 * i + 1] ?? 48), 16);
  }
  return out;
}

function addElement(result: ParsedElements, id: number, payload: Uint8Array): void {
  if (id === 221) {
    if (payload.length >= 3) {
      result.vendors.push({ oui: `${hexByte(payload[0] ?? 0)}${hexByte(payload[1] ?? 0)}${hexByte(payload[2] ?? 0)}`, type: payload.length >= 4 ? (payload[3] ?? null) : null });
    }
    return;
  }
  if (id === 255) {
    if (payload.length >= 1) result.elements.set(`FF.${hexByte(payload[0] ?? 0)}`, payload.subarray(1));
    return;
  }
  // The first copy of an element counts (a beacon carries each once)
  const key = hexByte(id);
  if (!result.elements.has(key)) result.elements.set(key, payload);
}

/** Split a raw TLV byte stream (`[ID][Length][Payload]…`). */
export function parseElementBytes(bytes: Uint8Array): ParsedElements {
  const result: ParsedElements = { elements: new Map(), vendors: [], truncated: false };
  const data = bytes.subarray(0, MAX_IE_BYTES);
  let offset = 0;
  while (offset + 2 <= data.length) {
    const id = data[offset] ?? 0;
    const length = data[offset + 1] ?? 0;
    offset += 2;
    if (offset + length > data.length) {
      result.truncated = true;
      break;
    }
    addElement(result, id, data.subarray(offset, offset + length));
    offset += length;
  }
  if (offset < data.length && !result.truncated) result.truncated = true;
  return result;
}

/**
 * Parse IEs given either as one hex TLV stream or as `KEY:HEX` pairs separated by `;` or spaces, where
 * KEY is the element ID in hex (`2D`), `FF.<ext>` for an extension element (`FF.6A`, payload without the
 * extension ID) or `DD` for a vendor element. `null` when the text is neither.
 */
export function parseElements(text: string): ParsedElements | null {
  const trimmed = text.trim();
  if (trimmed === "") return { elements: new Map(), vendors: [], truncated: false };
  if (trimmed.length > MAX_IE_BYTES * 3) return null;
  const tokens = trimmed.split(/[;\s]+/).filter((token) => token !== "");
  // Key-value pairs carry exactly one colon each; anything else is one hex stream (colons as byte separators)
  const pairs = tokens.every((token) => {
    const colon = token.indexOf(":");
    return colon > 0 && colon === token.lastIndexOf(":");
  });
  if (!pairs) {
    const bytes = hexToBytes(trimmed);
    return bytes ? parseElementBytes(bytes) : null;
  }
  const result: ParsedElements = { elements: new Map(), vendors: [], truncated: false };
  for (const token of tokens) {
    const colon = token.indexOf(":");
    const key = token.slice(0, colon).toUpperCase();
    const payload = hexToBytes(token.slice(colon + 1));
    if (!payload) return null;
    if (key.startsWith("FF.")) {
      const ext = Number.parseInt(key.slice(3), 16);
      if (!Number.isInteger(ext) || key.length !== 5) return null;
      result.elements.set(`FF.${hexByte(ext)}`, payload);
      continue;
    }
    const id = Number.parseInt(key, 16);
    if (!Number.isInteger(id) || id < 0 || id > 254 || key.length > 2) return null;
    addElement(result, id, payload);
  }
  return result;
}

export type WifiBand = "2.4GHz" | "5GHz" | "6GHz";
export type WifiStandard = "be" | "ax" | "ac" | "n" | "a" | "g";

/** The Wi-Fi band of a centre frequency (MHz), `null` outside 2.4 / 5 / 6 GHz. */
export function wifiBandOf(freqMhz: number): WifiBand | null {
  if (freqMhz >= 2400 && freqMhz <= 2500) return "2.4GHz";
  if (freqMhz >= 4900 && freqMhz <= 5900) return "5GHz";
  if (freqMhz >= 5925 && freqMhz <= 7125) return "6GHz";
  return null;
}

/** IEEE channel number of a 20 MHz centre frequency (MHz); `null` when it is not on a channel. */
export function wifiChannelOf(freqMhz: number): number | null {
  if (!Number.isInteger(freqMhz)) return null;
  if (freqMhz === 2484) return 14;
  if (freqMhz >= 2412 && freqMhz <= 2472 && (freqMhz - 2407) % 5 === 0) return (freqMhz - 2407) / 5;
  if (freqMhz === 5935) return 2;
  if (freqMhz >= 5955 && freqMhz <= 7115 && (freqMhz - 5950) % 5 === 0) return (freqMhz - 5950) / 5;
  if (freqMhz >= 4910 && freqMhz <= 5895 && (freqMhz - 5000) % 5 === 0) return (freqMhz - 5000) / 5;
  return null;
}

/** `🇮🇪` for `IE`; `""` unless two letters A–Z. */
export function countryFlag(code: string): string {
  if (code.length !== 2) return "";
  const a = code.charCodeAt(0);
  const b = code.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "";
  return String.fromCodePoint(0x1f1e6 + (a - 65), 0x1f1e6 + (b - 65));
}

export type PuncturingState = "unsupported" | "not_operating" | "full_bandwidth" | "idle" | "active" | "malformed";

export interface WifiSummary {
  standard: WifiStandard;
  /** Spatial streams the AP receives at most (from the EHT, HE, VHT or HT capabilities). */
  spatialStreams: number;
  /** Width the AP operates at now (MHz), from the EHT / VHT / HT operation elements. */
  operatingWidthMhz: 20 | 40 | 80 | 160 | 320;
  /** Widest channel its capabilities allow (MHz). */
  maxWidthMhz: 20 | 40 | 80 | 160 | 320;
  /** Primary channel from the HT operation or DS parameter set, `null` when neither is present. */
  primaryChannel: number | null;
  country: { code: string; flag: string; environment: "indoor" | "outdoor" | "any" } | null;
  /** QBSS load: associated stations and channel utilization (%). */
  stationCount: number | null;
  channelUtilizationPct: number | null;
  /** TPC report: transmit power (dBm) and local power constraint (dB). */
  txPowerDbm: number | null;
  powerConstraintDb: number | null;
  dtimCount: number | null;
  dtimPeriod: number | null;
  /** HE operation: the BSS colour (1–63) and whether colouring is on. */
  bssColor: number | null;
  bssColorEnabled: boolean;
  /** HE spatial reuse: OBSS PD allowed and its threshold (−82 dBm plus the advertised offset). */
  spatialReuse: { obssPdAllowed: boolean; thresholdDbm: number | null } | null;
  puncturing: { state: PuncturingState; bitmapHex: string | null; disabledSubchannels: number[] };
  /** Wi-Fi 7 multi-link: element present, and the MLD MAC address of a basic Multi-Link element. */
  multiLink: { present: boolean; mldMac: string | null };
  beamforming: { suBeamformer: boolean; suBeamformee: boolean; muBeamformer: boolean };
  /** HE: uplink MU-MIMO (full or partial bandwidth) and OFDMA random access. */
  heUplinkMuMimo: boolean;
  heOfdmaRandomAccess: boolean;
  guardIntervals: string[];
  roaming: { dot11k: boolean; dot11v: boolean; dot11r: boolean };
  security: { protocol: string; akm: string[]; pairwise: string[]; group: string | null; wps: boolean };
  vendorOuis: string[];
  /** Wi-Fi chipset maker guessed from the vendor OUIs, `null` when none is known. */
  chipsetVendor: string | null;
}

/** OUIs whose vendor elements name the Wi-Fi chipset maker (IEEE registry assignments). */
const CHIPSET_OUIS: Readonly<Record<string, string>> = {
  "001018": "Broadcom",
  "00904C": "Broadcom",
  "00037F": "Qualcomm Atheros",
  "001374": "Qualcomm Atheros",
  "8CFDF0": "Qualcomm",
  "000CE7": "MediaTek",
  "000C43": "MediaTek (Ralink)",
  "0017A5": "MediaTek (Ralink)",
  "00E04C": "Realtek",
  "001735": "Intel",
  "001DE0": "Intel",
  "8C8D28": "Intel",
  "00E0FC": "Huawei (HiSilicon)",
  "4846FB": "Huawei (HiSilicon)",
  "A4933F": "Huawei (HiSilicon)",
  "005043": "Marvell",
  "002686": "Quantenna",
  "001C51": "Celeno",
};

const CIPHERS: Readonly<Record<number, string>> = {
  1: "WEP-40",
  2: "TKIP",
  4: "CCMP-128",
  5: "WEP-104",
  6: "BIP-CMAC-128",
  8: "GCMP-128",
  9: "GCMP-256",
  10: "CCMP-256",
  11: "BIP-GMAC-128",
  12: "BIP-GMAC-256",
  13: "BIP-CMAC-256",
};

const AKMS: Readonly<Record<number, string>> = {
  1: "802.1X",
  2: "PSK",
  3: "FT-802.1X",
  4: "FT-PSK",
  5: "802.1X-SHA256",
  6: "PSK-SHA256",
  8: "SAE",
  9: "FT-SAE",
  11: "802.1X-SuiteB",
  12: "802.1X-SuiteB-192",
  13: "FT-802.1X-SHA384",
  14: "FILS-SHA256",
  15: "FILS-SHA384",
  18: "OWE",
  19: "FT-PSK-SHA384",
  20: "PSK-SHA384",
  24: "SAE-EXT-KEY",
  25: "FT-SAE-EXT-KEY",
};

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function suite(bytes: Uint8Array, offset: number, names: Readonly<Record<number, string>>): string {
  const oui = `${hexByte(bytes[offset] ?? 0)}${hexByte(bytes[offset + 1] ?? 0)}${hexByte(bytes[offset + 2] ?? 0)}`;
  const type = bytes[offset + 3] ?? 0;
  if (oui === "000FAC") return names[type] ?? `000FAC:${type}`;
  return `${oui}:${type}`;
}

/** RSN element (§9.4.2.24): group and pairwise ciphers and AKM suites; `null` when it is cut short. */
export function parseRsn(payload: Uint8Array): { group: string; pairwise: string[]; akm: string[] } | null {
  if (payload.length < 8 || u16le(payload, 0) !== 1) return null;
  const group = suite(payload, 2, CIPHERS);
  let offset = 6;
  const pairwiseCount = u16le(payload, offset);
  offset += 2;
  if (pairwiseCount > 16 || offset + pairwiseCount * 4 > payload.length) return null;
  const pairwise: string[] = [];
  for (let i = 0; i < pairwiseCount; i++, offset += 4) pairwise.push(suite(payload, offset, CIPHERS));
  if (offset + 2 > payload.length) return { group, pairwise, akm: [] };
  const akmCount = u16le(payload, offset);
  offset += 2;
  if (akmCount > 16 || offset + akmCount * 4 > payload.length) return null;
  const akm: string[] = [];
  for (let i = 0; i < akmCount; i++, offset += 4) akm.push(suite(payload, offset, AKMS));
  return { group, pairwise, akm };
}

/** The security label of an AKM list (personal / enterprise, WPA2 / WPA3 / OWE). */
export function securityProtocol(akm: ReadonlyArray<string>): string {
  const has = (...names: string[]): boolean => names.some((name) => akm.includes(name));
  const sae = has("SAE", "FT-SAE", "SAE-EXT-KEY", "FT-SAE-EXT-KEY");
  const psk = has("PSK", "FT-PSK", "PSK-SHA256", "PSK-SHA384", "FT-PSK-SHA384");
  if (has("802.1X-SuiteB-192")) return "WPA3-Enterprise-192";
  if (sae && psk) return "WPA2/WPA3-Personal";
  if (sae) return "WPA3-Personal";
  if (has("OWE")) return "OWE";
  if (has("802.1X", "FT-802.1X", "802.1X-SHA256", "802.1X-SuiteB", "FT-802.1X-SHA384")) return "WPA2-Enterprise";
  if (psk) return "WPA2-Personal";
  return akm.length > 0 ? "RSN" : "Open";
}

/** Rx streams of a 2-bit-per-stream MCS map (VHT, HE): the highest stream whose code is not 3. */
function streamsFromMcsMap(map: number): number {
  let streams = 0;
  for (let i = 0; i < 8; i++) if (((map >> (i * 2)) & 0x03) !== 0x03) streams = i + 1;
  return streams;
}

function widthOf(code: number): 20 | 40 | 80 | 160 | 320 | null {
  return code === 0 ? 20 : code === 1 ? 40 : code === 2 ? 80 : code === 3 ? 160 : code === 4 ? 320 : null;
}

function widest(a: 20 | 40 | 80 | 160 | 320, b: 20 | 40 | 80 | 160 | 320): 20 | 40 | 80 | 160 | 320 {
  return a >= b ? a : b;
}

function macOf(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + 6), hexByte).join(":");
}

/**
 * Wi-Fi 7 preamble puncturing (EHT Operation, ext 106): params byte B0 = EHT Operation Information
 * present, B1 = Disabled Subchannel Bitmap present; the bitmap (16 bits, LSB = lowest 20 MHz
 * subchannel) follows Basic EHT-MCS/NSS (4 bytes) and Control / CCFS0 / CCFS1 (3 bytes), at bytes 8–9.
 */
export function ehtPuncturing(elements: ReadonlyMap<string, Uint8Array>): WifiSummary["puncturing"] {
  const none = (state: PuncturingState): WifiSummary["puncturing"] => ({ state, bitmapHex: null, disabledSubchannels: [] });
  if (!elements.has("FF.6C")) return none("unsupported");
  const op = elements.get("FF.6A");
  if (!op || op.length < 1) return none("not_operating");
  const params = op[0] ?? 0;
  if ((params & 0x02) === 0) return none("idle");
  if ((params & 0x01) === 0 || op.length < 10) return none("malformed");
  const bitmap = u16le(op, 8);
  const bitmapHex = `0x${bitmap.toString(16).toUpperCase().padStart(4, "0")}`;
  if (bitmap === 0) return { state: "full_bandwidth", bitmapHex, disabledSubchannels: [] };
  const disabledSubchannels: number[] = [];
  for (let k = 0; k < 16; k++) if (((bitmap >> k) & 1) === 1) disabledSubchannels.push(k);
  return { state: "active", bitmapHex, disabledSubchannels };
}

/** Summarize a beacon's elements; `freqMhz` (centre of the primary 20 MHz) tells 2.4 / 5 / 6 GHz apart. */
export function summarizeWifi(parsed: ParsedElements, freqMhz: number): WifiSummary {
  const el = parsed.elements;
  const ht = el.get("2D");
  const htOp = el.get("3D");
  const vht = el.get("BF");
  const vhtOp = el.get("C0");
  const he = el.get("FF.23");
  const heOp = el.get("FF.24");
  const eht = el.get("FF.6C");
  const ehtOp = el.get("FF.6A");
  const band = wifiBandOf(freqMhz);

  const standard: WifiStandard = eht || ehtOp ? "be" : he || heOp ? "ax" : vht || vhtOp ? "ac" : ht || htOp ? "n" : band === "2.4GHz" ? "g" : "a";

  let streams = 0;
  if (eht && eht.length >= 14) {
    for (let i = 11; i <= 13; i++) {
      const byte = eht[i] ?? 0;
      for (const nibble of [byte & 0x0f, (byte >> 4) & 0x0f]) if (nibble <= 8 && nibble > streams) streams = nibble;
    }
  }
  if (he && he.length >= 19) streams = Math.max(streams, streamsFromMcsMap(u16le(he, 17)));
  if (vht && vht.length >= 6) streams = Math.max(streams, streamsFromMcsMap(u16le(vht, 4)));
  if (ht && ht.length >= 7) for (let k = 0; k < 4; k++) if ((ht[3 + k] ?? 0) !== 0) streams = Math.max(streams, k + 1);

  // Operating width: EHT operation information, then VHT operation, then HT operation
  let operating: 20 | 40 | 80 | 160 | 320 = 20;
  if (htOp && htOp.length >= 2 && ((htOp[1] ?? 0) & 0x03) !== 0 && ((htOp[1] ?? 0) & 0x04) !== 0) operating = 40;
  if (vhtOp && vhtOp.length >= 3) {
    const width = vhtOp[0] ?? 0;
    const ccfs0 = vhtOp[1] ?? 0;
    const ccfs1 = vhtOp[2] ?? 0;
    if (width === 2 || width === 3 || (width === 1 && ccfs1 !== 0 && Math.abs(ccfs1 - ccfs0) >= 8)) operating = widest(operating, 160);
    else if (width === 1) operating = widest(operating, 80);
  }
  if (ehtOp && ehtOp.length >= 6 && ((ehtOp[0] ?? 0) & 0x01) !== 0) {
    const width = widthOf((ehtOp[5] ?? 0) & 0x07);
    if (width) operating = width;
  }

  // Widest supported: EHT 320 MHz in 6 GHz, HE PHY channel width set, VHT channel width set, HT 40 MHz
  let maxWidth: 20 | 40 | 80 | 160 | 320 = operating;
  if (ht && ht.length >= 2 && ((ht[0] ?? 0) & 0x02) !== 0) maxWidth = widest(maxWidth, 40);
  if (vht && vht.length >= 1) maxWidth = widest(maxWidth, ((vht[0] ?? 0) >> 2) & 0x03 ? 160 : 80);
  if (he && he.length >= 7) {
    const set = he[6] ?? 0;
    if (set & 0x18) maxWidth = widest(maxWidth, 160);
    else if (set & 0x04) maxWidth = widest(maxWidth, 80);
    else if (set & 0x02) maxWidth = widest(maxWidth, 40);
  }
  if (eht && eht.length >= 3 && band === "6GHz" && ((eht[2] ?? 0) & 0x02) !== 0) maxWidth = widest(maxWidth, 320);

  const ds = el.get("03");
  const primaryChannel = htOp && htOp.length >= 1 ? (htOp[0] ?? null) : ds && ds.length >= 1 ? (ds[0] ?? null) : null;

  const countryEl = el.get("07");
  let country: WifiSummary["country"] = null;
  if (countryEl && countryEl.length >= 3) {
    const code = String.fromCharCode(countryEl[0] ?? 0, countryEl[1] ?? 0);
    if (/^[A-Z]{2}$/.test(code)) {
      const env = countryEl[2] ?? 0;
      country = { code, flag: countryFlag(code), environment: env === 0x49 ? "indoor" : env === 0x4f ? "outdoor" : "any" };
    }
  }

  const load = el.get("0B");
  const tpc = el.get("23");
  const constraint = el.get("20");
  const tim = el.get("05");

  let bssColor: number | null = null;
  let bssColorEnabled = false;
  if (heOp && heOp.length >= 4) {
    const info = heOp[3] ?? 0;
    bssColor = info & 0x3f;
    bssColorEnabled = (info & 0x80) === 0 && bssColor !== 0;
  }

  const srp = el.get("FF.27");
  let spatialReuse: WifiSummary["spatialReuse"] = null;
  if (srp && srp.length >= 1) {
    const control = srp[0] ?? 0;
    const allowed = (control & 0x02) === 0;
    const offsetPresent = (control & 0x04) !== 0 && srp.length >= 2;
    spatialReuse = { obssPdAllowed: allowed, thresholdDbm: allowed ? -82 + (offsetPresent ? (srp[1] ?? 0) : 0) : null };
  }

  const mle = el.get("FF.6B");
  const multiLink = { present: mle !== undefined, mldMac: mle && mle.length >= 9 && ((mle[0] ?? 0) & 0x07) === 0 ? macOf(mle, 3) : null };

  const beamforming = {
    suBeamformer: Boolean((vht && vht.length >= 4 && ((vht[1] ?? 0) & 0x08) !== 0) || (he && he.length >= 11 && ((he[9] ?? 0) & 0x80) !== 0)),
    suBeamformee: Boolean((vht && vht.length >= 4 && ((vht[1] ?? 0) & 0x10) !== 0) || (he && he.length >= 11 && ((he[10] ?? 0) & 0x01) !== 0)),
    muBeamformer: Boolean((vht && vht.length >= 4 && ((vht[2] ?? 0) & 0x08) !== 0) || (he && he.length >= 11 && ((he[10] ?? 0) & 0x02) !== 0)),
  };

  const guardIntervals: string[] = [];
  if (ht && ht.length >= 1 && ((ht[0] ?? 0) & 0x60) !== 0) guardIntervals.push("0.4us (HT)");
  if (vht && vht.length >= 1 && ((vht[0] ?? 0) & 0x60) !== 0) guardIntervals.push("0.4us (VHT)");
  if (he) guardIntervals.push("0.8/1.6/3.2us (HE)");
  if (eht) guardIntervals.push("0.8/1.6/3.2us (EHT)");

  const rm = el.get("46");
  const ext = el.get("7F");
  const roaming = {
    dot11k: Boolean(rm && rm.length >= 1 && ((rm[0] ?? 0) & 0x02) !== 0),
    dot11v: Boolean(ext && ext.length >= 3 && ((ext[2] ?? 0) & 0x08) !== 0),
    dot11r: (el.get("36")?.length ?? 0) >= 3,
  };

  const rsn = el.get("30") ? parseRsn(el.get("30") ?? new Uint8Array()) : null;
  const wpa = parsed.vendors.some((v) => v.oui === "0050F2" && v.type === 1);
  const wps = parsed.vendors.some((v) => v.oui === "0050F2" && v.type === 4);
  const protocol = rsn ? securityProtocol(rsn.akm) : el.has("44") ? "WAPI" : wpa ? "WPA" : "Open";
  const security = { protocol, akm: rsn?.akm ?? [], pairwise: rsn?.pairwise ?? [], group: rsn?.group ?? null, wps };

  const vendorOuis = [...new Set(parsed.vendors.map((v) => v.oui))];
  const chipsetVendor = vendorOuis.map((oui) => CHIPSET_OUIS[oui]).find((name) => name !== undefined) ?? null;

  return {
    standard,
    spatialStreams: Math.max(1, streams),
    operatingWidthMhz: operating,
    maxWidthMhz: maxWidth,
    primaryChannel,
    country,
    stationCount: load && load.length >= 3 ? u16le(load, 0) : null,
    channelUtilizationPct: load && load.length >= 3 ? Math.round(((load[2] ?? 0) * 100) / 255) : null,
    txPowerDbm: tpc && tpc.length >= 1 ? ((tpc[0] ?? 0) << 24) >> 24 : null,
    powerConstraintDb: constraint && constraint.length >= 1 ? (constraint[0] ?? null) : null,
    dtimCount: tim && tim.length >= 2 ? (tim[0] ?? null) : null,
    dtimPeriod: tim && tim.length >= 2 ? (tim[1] ?? null) : null,
    bssColor,
    bssColorEnabled,
    spatialReuse,
    puncturing: ehtPuncturing(el),
    multiLink,
    beamforming,
    heUplinkMuMimo: Boolean(he && he.length >= 9 && ((he[8] ?? 0) & 0xc0) !== 0),
    heOfdmaRandomAccess: Boolean(he && he.length >= 4 && ((he[3] ?? 0) & 0x04) !== 0),
    guardIntervals,
    roaming,
    security,
    vendorOuis,
    chipsetVendor,
  };
}

export type GnssSystem = "GPS" | "SBAS" | "GLONASS" | "QZSS" | "BeiDou" | "Galileo" | "NavIC";

/** Constellation numbers as Android's `GnssStatus` reports them (1 GPS … 7 IRNSS/NavIC). */
const GNSS_SYSTEMS: Readonly<Record<number, GnssSystem>> = { 1: "GPS", 2: "SBAS", 3: "GLONASS", 4: "QZSS", 5: "BeiDou", 6: "Galileo", 7: "NavIC" };

/** Carrier centre frequencies (MHz) per system and signal; GLONASS G1/G2 are FDMA ranges (k = −7…+6). */
const GNSS_SIGNALS: Readonly<Record<GnssSystem, ReadonlyArray<{ label: string; mhz: number; halfWidthMhz?: number }>>> = {
  GPS: [
    { label: "L1", mhz: 1575.42 },
    { label: "L2", mhz: 1227.6 },
    { label: "L5", mhz: 1176.45 },
  ],
  SBAS: [
    { label: "L1", mhz: 1575.42 },
    { label: "L5", mhz: 1176.45 },
  ],
  GLONASS: [
    { label: "G1", mhz: 1602.0, halfWidthMhz: 6 },
    { label: "G2", mhz: 1246.0, halfWidthMhz: 5 },
    { label: "G3", mhz: 1202.025 },
  ],
  QZSS: [
    { label: "L1", mhz: 1575.42 },
    { label: "L2", mhz: 1227.6 },
    { label: "L5", mhz: 1176.45 },
    { label: "L6", mhz: 1278.75 },
  ],
  BeiDou: [
    { label: "B1I", mhz: 1561.098 },
    { label: "B1C", mhz: 1575.42 },
    { label: "B2a", mhz: 1176.45 },
    { label: "B2b", mhz: 1207.14 },
    { label: "B3I", mhz: 1268.52 },
  ],
  Galileo: [
    { label: "E1", mhz: 1575.42 },
    { label: "E5a", mhz: 1176.45 },
    { label: "E5b", mhz: 1207.14 },
    { label: "E6", mhz: 1278.75 },
  ],
  NavIC: [
    { label: "L5", mhz: 1176.45 },
    { label: "S", mhz: 2492.028, halfWidthMhz: 10 },
  ],
};

/** The system and signal of a satellite measurement (constellation number, carrier in Hz); `null` when unknown. */
export function gnssSignal(constellation: number, carrierHz: number): { system: GnssSystem; signal: string } | null {
  const system = GNSS_SYSTEMS[constellation];
  if (!system || !Number.isFinite(carrierHz)) return null;
  const mhz = carrierHz / 1e6;
  let best: { label: string; distance: number } | null = null;
  for (const signal of GNSS_SIGNALS[system]) {
    const distance = Math.abs(mhz - signal.mhz);
    if (distance <= (signal.halfWidthMhz ?? 5) && (best === null || distance < best.distance)) best = { label: signal.label, distance };
  }
  return best ? { system, signal: best.label } : null;
}

/** Tracking state bits of a GNSS measurement (Android `GnssMeasurement`): code lock, bit sync, subframe sync, TOW decoded. */
export function gnssTrackingState(state: number): string[] {
  if (!Number.isInteger(state) || state <= 0) return [];
  const names: Array<[number, string]> = [
    [0x01, "code_lock"],
    [0x02, "bit_sync"],
    [0x04, "subframe_sync"],
    [0x08, "tow_decoded"],
  ];
  return names.filter(([bit]) => (state & bit) !== 0).map(([, name]) => name);
}
