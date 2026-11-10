import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countryFlag,
  ehtPuncturing,
  gnssSignal,
  gnssTrackingState,
  hexToBytes,
  parseElementBytes,
  parseElements,
  parseRsn,
  securityProtocol,
  summarizeWifi,
  wifiBandOf,
  wifiChannelOf,
} from "../src/wifi-ie.ts";

/** `[id][length][payload]`; an extension element puts its extension ID first. */
const el = (id: number, payload: ReadonlyArray<number>): number[] => [id, payload.length, ...payload];
const ext = (extId: number, payload: ReadonlyArray<number>): number[] => el(255, [extId, ...payload]);
const hex = (bytes: ReadonlyArray<number>): string => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

/** An RFC 7042 documentation MAC as the MLD address (AGENTS.md 铁律二). */
const MLD = [0x02, 0x00, 0x5e, 0x10, 0x00, 0x01];

const RSN_SAE_PSK = [1, 0, 0x00, 0x0f, 0xac, 0x04, 1, 0, 0x00, 0x0f, 0xac, 0x04, 2, 0, 0x00, 0x0f, 0xac, 0x08, 0x00, 0x0f, 0xac, 0x02, 0x80, 0x00];
const HE_CAP = [0, 0, 0, 0x04, 0, 0, 0x1c, 0x40, 0xc0, 0x80, 0x03, 0, 0, 0, 0, 0, 0, 0xaa, 0xff, 0xaa, 0xff];
const EHT_CAP = [0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0x44, 0x44, 0x44];
const EHT_OP_PUNCTURED = [0x03, 0x44, 0x44, 0x44, 0x44, 0x04, 31, 63, 0x03, 0x00];

const WIFI7_BEACON = [
  ...el(7, [0x49, 0x45, 0x49, 1, 13, 20]),
  ...el(11, [5, 0, 51, 0, 0]),
  ...el(32, [3]),
  ...el(35, [20, 0]),
  ...el(5, [0, 3, 0, 0]),
  ...el(48, RSN_SAE_PSK),
  ...el(54, [0x12, 0x34, 0x01]),
  ...el(70, [0x02, 0, 0, 0, 0]),
  ...el(127, [0, 0, 0x08]),
  ...ext(35, HE_CAP),
  ...ext(36, [0, 0, 0, 0x15, 0xfc, 0xff]),
  ...ext(39, [0x04, 0x0a]),
  ...ext(108, EHT_CAP),
  ...ext(106, EHT_OP_PUNCTURED),
  ...ext(107, [0x00, 0x00, 0x07, ...MLD]),
  ...el(221, [0x00, 0x50, 0xf2, 0x04, 0x10, 0x4a]),
  ...el(221, [0x00, 0x10, 0x18, 0x02, 0x00]),
];

const HT_CAP_2SS = [0x62, 0x00, 0x17, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const VHT_CAP = [0x20, 0x18, 0x08, 0x00, 0xfa, 0xff, 0, 0, 0xfa, 0xff, 0, 0];

describe("wifi-ie: element streams", () => {
  it("splits a TLV stream and keys extension elements by their extension ID", () => {
    const parsed = parseElementBytes(Uint8Array.from(WIFI7_BEACON));
    assert.equal(parsed.truncated, false);
    assert.deepEqual([...parsed.elements.keys()].slice(0, 3), ["07", "0B", "20"]);
    assert.deepEqual([...(parsed.elements.get("FF.6A") ?? [])], EHT_OP_PUNCTURED);
    assert.deepEqual(parsed.vendors, [
      { oui: "0050F2", type: 4 },
      { oui: "001018", type: 2 },
    ]);
  });

  it("flags a stream that ends inside an element and keeps the first copy of a repeated one", () => {
    const parsed = parseElementBytes(Uint8Array.from([...el(3, [6]), ...el(3, [11]), 45, 26, 1, 2]));
    assert.equal(parsed.truncated, true);
    assert.deepEqual([...(parsed.elements.get("03") ?? [])], [6]);
    assert.equal(parseElementBytes(Uint8Array.from([3])).truncated, true);
  });

  it("parses hex text with byte separators, and key-value pairs", () => {
    const stream = parseElements(hex(WIFI7_BEACON).replace(/(..)/g, "$1:").slice(0, -1));
    assert.ok(stream);
    assert.equal(stream.elements.size, 15);
    const pairs = parseElements("03:06; 2D:6200; FF.6A:0344444444040A0F0000 DD:0050F204");
    assert.ok(pairs);
    assert.deepEqual([...(pairs.elements.get("03") ?? [])], [6]);
    assert.equal(pairs.elements.get("FF.6A")?.length, 10);
    assert.deepEqual(pairs.vendors, [{ oui: "0050F2", type: 4 }]);
    assert.deepEqual(parseElements("   "), { elements: new Map(), vendors: [], truncated: false });
  });

  it("refuses text that is neither form", () => {
    assert.equal(parseElements("0G"), null);
    assert.equal(parseElements("abc"), null);
    assert.equal(parseElements("03:0;2D:62"), null);
    assert.equal(parseElements("FFF.6A:00"), null);
    assert.equal(parseElements("FF.6:00;03:06"), null);
    assert.equal(parseElements("123:00;03:06"), null);
    assert.equal(parseElements("ZZ:00;03:06"), null);
    assert.equal(parseElements("a".repeat(20000)), null);
  });

  it("converts hex digits and rejects stray characters", () => {
    assert.deepEqual([...(hexToBytes("de:AD be-EF") ?? [])], [0xde, 0xad, 0xbe, 0xef]);
    assert.equal(hexToBytes("dea"), null);
    assert.equal(hexToBytes("de,ad"), null);
    assert.equal(hexToBytes("f".repeat(9000))?.length, 4096);
  });
});

describe("wifi-ie: a Wi-Fi 7 beacon on 6 GHz", () => {
  const parsed = parseElementBytes(Uint8Array.from(WIFI7_BEACON));
  const summary = summarizeWifi(parsed, 5955);

  it("reads the generation, streams and widths", () => {
    assert.equal(summary.standard, "be");
    assert.equal(summary.spatialStreams, 4);
    assert.equal(summary.operatingWidthMhz, 320);
    assert.equal(summary.maxWidthMhz, 320);
    assert.equal(summary.primaryChannel, null);
  });

  it("reads the country, load, power and DTIM", () => {
    assert.deepEqual(summary.country, { code: "IE", flag: "🇮🇪", environment: "indoor" });
    assert.equal(summary.stationCount, 5);
    assert.equal(summary.channelUtilizationPct, 20);
    assert.equal(summary.txPowerDbm, 20);
    assert.equal(summary.powerConstraintDb, 3);
    assert.equal(summary.dtimCount, 0);
    assert.equal(summary.dtimPeriod, 3);
  });

  it("reads the HE colour, spatial reuse, puncturing and multi-link", () => {
    assert.equal(summary.bssColor, 21);
    assert.equal(summary.bssColorEnabled, true);
    assert.deepEqual(summary.spatialReuse, { obssPdAllowed: true, thresholdDbm: -72 });
    assert.deepEqual(summary.puncturing, { state: "active", bitmapHex: "0x0003", disabledSubchannels: [0, 1] });
    assert.deepEqual(summary.multiLink, { present: true, mldMac: "02:00:5E:10:00:01" });
  });

  it("reads beamforming, MU-MIMO, OFDMA, guard intervals and roaming", () => {
    assert.deepEqual(summary.beamforming, { suBeamformer: true, suBeamformee: true, muBeamformer: true });
    assert.equal(summary.heUplinkMuMimo, true);
    assert.equal(summary.heOfdmaRandomAccess, true);
    assert.deepEqual(summary.guardIntervals, ["0.8/1.6/3.2us (HE)", "0.8/1.6/3.2us (EHT)"]);
    assert.deepEqual(summary.roaming, { dot11k: true, dot11v: true, dot11r: true });
  });

  it("reads security, WPS and the chipset vendor", () => {
    assert.deepEqual(summary.security, { protocol: "WPA2/WPA3-Personal", akm: ["SAE", "PSK"], pairwise: ["CCMP-128"], group: "CCMP-128", wps: true });
    assert.deepEqual(summary.vendorOuis, ["0050F2", "001018"]);
    assert.equal(summary.chipsetVendor, "Broadcom");
  });
});

describe("wifi-ie: Wi-Fi 4/5 and legacy beacons", () => {
  it("reads a Wi-Fi 5 AP at 80 MHz", () => {
    const beacon = [...el(45, HT_CAP_2SS), ...el(61, [36, 0x05, 0, 0, 0]), ...el(191, VHT_CAP), ...el(192, [1, 42, 0, 0xfc, 0xff])];
    const summary = summarizeWifi(parseElementBytes(Uint8Array.from(beacon)), 5180);
    assert.equal(summary.standard, "ac");
    assert.equal(summary.spatialStreams, 2);
    assert.equal(summary.operatingWidthMhz, 80);
    assert.equal(summary.maxWidthMhz, 80);
    assert.equal(summary.primaryChannel, 36);
    assert.deepEqual(summary.beamforming, { suBeamformer: true, suBeamformee: true, muBeamformer: true });
    assert.deepEqual(summary.guardIntervals, ["0.4us (HT)", "0.4us (VHT)"]);
    assert.equal(summary.security.protocol, "Open");
    assert.equal(summary.puncturing.state, "unsupported");
    assert.equal(summary.chipsetVendor, null);
  });

  it("reads 160 MHz from the VHT operation in both encodings", () => {
    const viaCcfs1 = summarizeWifi(parseElementBytes(Uint8Array.from(el(192, [1, 42, 50, 0, 0]))), 5180);
    assert.equal(viaCcfs1.operatingWidthMhz, 160);
    const legacy = summarizeWifi(parseElementBytes(Uint8Array.from(el(192, [2, 50, 0, 0, 0]))), 5180);
    assert.equal(legacy.operatingWidthMhz, 160);
    const vht160 = summarizeWifi(parseElementBytes(Uint8Array.from(el(191, [0x04, 0, 0, 0, 0xfe, 0xff]))), 5180);
    assert.equal(vht160.maxWidthMhz, 160);
  });

  it("reads Wi-Fi 4 widths and the HE capability widths", () => {
    const noStaWidth = summarizeWifi(parseElementBytes(Uint8Array.from([...el(45, HT_CAP_2SS), ...el(61, [6, 0x01, 0, 0, 0])])), 2437);
    assert.equal(noStaWidth.standard, "n");
    assert.equal(noStaWidth.operatingWidthMhz, 20);
    assert.equal(noStaWidth.maxWidthMhz, 40);
    const he80 = summarizeWifi(parseElementBytes(Uint8Array.from(ext(35, [0, 0, 0, 0, 0, 0, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xfe, 0xff]))), 5180);
    assert.equal(he80.standard, "ax");
    assert.equal(he80.maxWidthMhz, 80);
    assert.equal(he80.spatialStreams, 1);
    const he40 = summarizeWifi(parseElementBytes(Uint8Array.from(ext(35, [0, 0, 0, 0, 0, 0, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))), 2412);
    assert.equal(he40.maxWidthMhz, 40);
  });

  it("falls back to a/g by band and names legacy security", () => {
    const g = summarizeWifi(parseElementBytes(Uint8Array.from([...el(3, [6]), ...el(221, [0x00, 0x50, 0xf2, 0x01, 0x01, 0x00])])), 2437);
    assert.equal(g.standard, "g");
    assert.equal(g.primaryChannel, 6);
    assert.equal(g.security.protocol, "WPA");
    const a = summarizeWifi(parseElementBytes(Uint8Array.from(el(68, [1, 0]))), 5745);
    assert.equal(a.standard, "a");
    assert.equal(a.security.protocol, "WAPI");
    assert.equal(a.spatialStreams, 1);
  });

  it("leaves BSS colouring off when disabled or zero, and spatial reuse without its offset", () => {
    const disabled = summarizeWifi(parseElementBytes(Uint8Array.from([...ext(36, [0, 0, 0, 0x95]), ...ext(39, [0x00])])), 5180);
    assert.equal(disabled.bssColor, 21);
    assert.equal(disabled.bssColorEnabled, false);
    assert.deepEqual(disabled.spatialReuse, { obssPdAllowed: true, thresholdDbm: -82 });
    const zero = summarizeWifi(parseElementBytes(Uint8Array.from([...ext(36, [0, 0, 0, 0x00]), ...ext(39, [0x02])])), 5180);
    assert.equal(zero.bssColorEnabled, false);
    assert.deepEqual(zero.spatialReuse, { obssPdAllowed: false, thresholdDbm: null });
  });

  it("ignores a country string that is not two letters, and a multi-link element of another type", () => {
    const summary = summarizeWifi(parseElementBytes(Uint8Array.from([...el(7, [0x31, 0x32, 0x20]), ...ext(107, [0x01, 0x00, 0x07, ...MLD])])), 5955);
    assert.equal(summary.country, null);
    assert.deepEqual(summary.multiLink, { present: true, mldMac: null });
    const outdoor = summarizeWifi(parseElementBytes(Uint8Array.from(el(7, [0x55, 0x53, 0x4f]))), 2412);
    assert.equal(outdoor.country?.environment, "outdoor");
    const any = summarizeWifi(parseElementBytes(Uint8Array.from(el(7, [0x55, 0x53, 0x20]))), 2412);
    assert.equal(any.country?.environment, "any");
  });
});

describe("wifi-ie: Wi-Fi 7 puncturing states", () => {
  const map = (entries: Array<[string, number[]]>): Map<string, Uint8Array> => new Map(entries.map(([k, v]) => [k, Uint8Array.from(v)]));

  it("tells unsupported, not operating, idle, malformed and full bandwidth apart", () => {
    assert.equal(ehtPuncturing(map([])).state, "unsupported");
    assert.equal(ehtPuncturing(map([["FF.6C", EHT_CAP]])).state, "not_operating");
    assert.equal(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", []]])).state, "not_operating");
    assert.equal(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", [0x01, 0, 0, 0, 0, 0x03, 0, 0]]])).state, "idle");
    assert.equal(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", [0x02, 0, 0, 0, 0, 0x03, 0, 0, 0, 0]]])).state, "malformed");
    assert.equal(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", [0x03, 0, 0, 0, 0, 0x03, 0, 0]]])).state, "malformed");
    assert.deepEqual(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", [0x03, 0, 0, 0, 0, 0x03, 0, 0, 0, 0]]])), { state: "full_bandwidth", bitmapHex: "0x0000", disabledSubchannels: [] });
    assert.deepEqual(ehtPuncturing(map([["FF.6C", EHT_CAP], ["FF.6A", [0x03, 0, 0, 0, 0, 0x04, 0, 0, 0x00, 0x80]]])), { state: "active", bitmapHex: "0x8000", disabledSubchannels: [15] });
  });
});

describe("wifi-ie: RSN suites", () => {
  it("parses the suites and labels the protocol", () => {
    assert.deepEqual(parseRsn(Uint8Array.from(RSN_SAE_PSK)), { group: "CCMP-128", pairwise: ["CCMP-128"], akm: ["SAE", "PSK"] });
    assert.deepEqual(parseRsn(Uint8Array.from([1, 0, 0x00, 0x0f, 0xac, 0x04, 1, 0, 0x00, 0x0f, 0xac, 0x04])), { group: "CCMP-128", pairwise: ["CCMP-128"], akm: [] });
    assert.deepEqual(parseRsn(Uint8Array.from([1, 0, 0x00, 0x0f, 0xac, 0x07, 0, 0, 1, 0, 0x00, 0x14, 0x72, 0x01]))?.akm, ["001472:1"]);
    assert.equal(parseRsn(Uint8Array.from([1, 0, 0x00, 0x0f, 0xac, 0x07, 0, 0]))?.group, "000FAC:7");
  });

  it("refuses a wrong version or a list longer than the element", () => {
    assert.equal(parseRsn(Uint8Array.from([2, 0, 0, 0x0f, 0xac, 4, 0, 0])), null);
    assert.equal(parseRsn(Uint8Array.from([1, 0, 0, 0x0f, 0xac, 4, 5, 0, 0, 0x0f, 0xac, 4])), null);
    assert.equal(parseRsn(Uint8Array.from([1, 0, 0, 0x0f, 0xac, 4, 0, 0, 3, 0, 0, 0x0f, 0xac, 2])), null);
    assert.equal(parseRsn(Uint8Array.from([1, 0, 0])), null);
  });

  it("names every protocol family", () => {
    assert.equal(securityProtocol(["802.1X-SuiteB-192"]), "WPA3-Enterprise-192");
    assert.equal(securityProtocol(["SAE"]), "WPA3-Personal");
    assert.equal(securityProtocol(["SAE-EXT-KEY", "FT-PSK"]), "WPA2/WPA3-Personal");
    assert.equal(securityProtocol(["OWE"]), "OWE");
    assert.equal(securityProtocol(["802.1X-SHA256"]), "WPA2-Enterprise");
    assert.equal(securityProtocol(["PSK-SHA256"]), "WPA2-Personal");
    assert.equal(securityProtocol(["001472:1"]), "RSN");
    assert.equal(securityProtocol([]), "Open");
  });
});

describe("wifi-ie: channels, countries and GNSS", () => {
  it("maps frequencies to bands and channels", () => {
    assert.equal(wifiBandOf(2437), "2.4GHz");
    assert.equal(wifiBandOf(5500), "5GHz");
    assert.equal(wifiBandOf(6115), "6GHz");
    assert.equal(wifiBandOf(7200), null);
    assert.equal(wifiChannelOf(2412), 1);
    assert.equal(wifiChannelOf(2484), 14);
    assert.equal(wifiChannelOf(5180), 36);
    assert.equal(wifiChannelOf(5955), 1);
    assert.equal(wifiChannelOf(5935), 2);
    assert.equal(wifiChannelOf(6115), 33);
    assert.equal(wifiChannelOf(2413), null);
    assert.equal(wifiChannelOf(5180.5), null);
    assert.equal(wifiChannelOf(900), null);
  });

  it("builds flags from two-letter codes only", () => {
    assert.equal(countryFlag("CN"), "🇨🇳");
    assert.equal(countryFlag("cn"), "");
    assert.equal(countryFlag("C"), "");
  });

  it("names GNSS signals per constellation", () => {
    assert.deepEqual(gnssSignal(1, 1575.42e6), { system: "GPS", signal: "L1" });
    assert.deepEqual(gnssSignal(1, 1176.45e6), { system: "GPS", signal: "L5" });
    assert.deepEqual(gnssSignal(3, 1602.5625e6), { system: "GLONASS", signal: "G1" });
    assert.deepEqual(gnssSignal(3, 1243.0e6), { system: "GLONASS", signal: "G2" });
    assert.deepEqual(gnssSignal(5, 1561.098e6), { system: "BeiDou", signal: "B1I" });
    assert.deepEqual(gnssSignal(5, 1575.42e6), { system: "BeiDou", signal: "B1C" });
    assert.deepEqual(gnssSignal(6, 1207.14e6), { system: "Galileo", signal: "E5b" });
    assert.deepEqual(gnssSignal(4, 1278.75e6), { system: "QZSS", signal: "L6" });
    assert.deepEqual(gnssSignal(7, 2492.028e6), { system: "NavIC", signal: "S" });
    assert.deepEqual(gnssSignal(2, 1575.42e6), { system: "SBAS", signal: "L1" });
    assert.equal(gnssSignal(8, 1575.42e6), null);
    assert.equal(gnssSignal(1, 1400e6), null);
    assert.equal(gnssSignal(1, Number.NaN), null);
  });

  it("decodes tracking state bits", () => {
    assert.deepEqual(gnssTrackingState(0x0f), ["code_lock", "bit_sync", "subframe_sync", "tow_decoded"]);
    assert.deepEqual(gnssTrackingState(0x09), ["code_lock", "tow_decoded"]);
    assert.deepEqual(gnssTrackingState(0), []);
    assert.deepEqual(gnssTrackingState(1.5), []);
  });
});
