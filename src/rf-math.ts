/**
 * 3GPP radio arithmetic every router family shares: the operating band tables (LTE: TS 36.101
 * Table 5.7.3-1; NR: TS 38.101-1 Table 5.4.2.3-1 and TS 38.101-2 Table 5.4.2.3-1), channel number ↔
 * carrier frequency (TS 36.101 §5.7.3, TS 38.104 §5.4.2.1), the NR synchronization raster (TS 38.104
 * §5.4.3.1), physical cell identity groups (TS 36.211 §6.11, TS 38.211 §7.4.2.1), the transmission
 * bandwidth configurations (TS 36.101 Table 5.6-1, TS 38.101-1/-2 Table 5.3.2-1) and the approximate
 * peak data rate of TS 38.306 §4.1.2.
 *
 * Imports nothing, so the daemon, the web console and the static demo compute the same numbers.
 */

export type Duplex = "FDD" | "TDD" | "SDL";

export interface LteBandInfo {
  band: number;
  duplex: Duplex;
  /** Lowest downlink carrier frequency F_DL_low (MHz). */
  dlLowMhz: number;
  /** N_Offs-DL: the EARFCN of `dlLowMhz`. */
  dlOffset: number;
  /** Downlink EARFCN range (inclusive). */
  dlEarfcn: readonly [number, number];
}

const lte = (band: number, duplex: Duplex, dlLowMhz: number, dlOffset: number, dlMax: number): LteBandInfo => ({
  band,
  duplex,
  dlLowMhz,
  dlOffset,
  dlEarfcn: [dlOffset, dlMax],
});

/** Every E-UTRA operating band with a downlink (TS 36.101 Table 5.7.3-1). */
export const LTE_BANDS: ReadonlyArray<LteBandInfo> = [
  lte(1, "FDD", 2110, 0, 599),
  lte(2, "FDD", 1930, 600, 1199),
  lte(3, "FDD", 1805, 1200, 1949),
  lte(4, "FDD", 2110, 1950, 2399),
  lte(5, "FDD", 869, 2400, 2649),
  lte(6, "FDD", 875, 2650, 2749),
  lte(7, "FDD", 2620, 2750, 3449),
  lte(8, "FDD", 925, 3450, 3799),
  lte(9, "FDD", 1844.9, 3800, 4149),
  lte(10, "FDD", 2110, 4150, 4749),
  lte(11, "FDD", 1475.9, 4750, 4949),
  lte(12, "FDD", 729, 5010, 5179),
  lte(13, "FDD", 746, 5180, 5279),
  lte(14, "FDD", 758, 5280, 5379),
  lte(17, "FDD", 734, 5730, 5849),
  lte(18, "FDD", 860, 5850, 5999),
  lte(19, "FDD", 875, 6000, 6149),
  lte(20, "FDD", 791, 6150, 6449),
  lte(21, "FDD", 1495.9, 6450, 6599),
  lte(22, "FDD", 3510, 6600, 7399),
  lte(23, "FDD", 2180, 7500, 7699),
  lte(24, "FDD", 1525, 7700, 8039),
  lte(25, "FDD", 1930, 8040, 8689),
  lte(26, "FDD", 859, 8690, 9039),
  lte(27, "FDD", 852, 9040, 9209),
  lte(28, "FDD", 758, 9210, 9659),
  lte(29, "SDL", 717, 9660, 9769),
  lte(30, "FDD", 2350, 9770, 9869),
  lte(31, "FDD", 462.5, 9870, 9919),
  lte(32, "SDL", 1452, 9920, 10359),
  lte(33, "TDD", 1900, 36000, 36199),
  lte(34, "TDD", 2010, 36200, 36349),
  lte(35, "TDD", 1850, 36350, 36949),
  lte(36, "TDD", 1930, 36950, 37549),
  lte(37, "TDD", 1910, 37550, 37749),
  lte(38, "TDD", 2570, 37750, 38249),
  lte(39, "TDD", 1880, 38250, 38649),
  lte(40, "TDD", 2300, 38650, 39649),
  lte(41, "TDD", 2496, 39650, 41589),
  lte(42, "TDD", 3400, 41590, 43589),
  lte(43, "TDD", 3600, 43590, 45589),
  lte(44, "TDD", 703, 45590, 46589),
  lte(45, "TDD", 1447, 46590, 46789),
  lte(46, "TDD", 5150, 46790, 54539),
  lte(47, "TDD", 5855, 54540, 55239),
  lte(48, "TDD", 3550, 55240, 56739),
  lte(49, "TDD", 3550, 56740, 58239),
  lte(50, "TDD", 1432, 58240, 59089),
  lte(51, "TDD", 1427, 59090, 59139),
  lte(52, "TDD", 3300, 59140, 60139),
  lte(53, "TDD", 2483.5, 60140, 60254),
  lte(65, "FDD", 2110, 65536, 66435),
  lte(66, "FDD", 2110, 66436, 67335),
  lte(67, "SDL", 738, 67336, 67535),
  lte(68, "FDD", 753, 67536, 67835),
  lte(69, "SDL", 2570, 67836, 68335),
  lte(70, "FDD", 1995, 68336, 68585),
  lte(71, "FDD", 617, 68586, 68935),
  lte(72, "FDD", 461, 68936, 68985),
  lte(73, "FDD", 460, 68986, 69035),
  lte(74, "FDD", 1475, 69036, 69465),
  lte(75, "SDL", 1432, 69466, 70315),
  lte(76, "SDL", 1427, 70316, 70365),
  lte(85, "FDD", 728, 70366, 70545),
  lte(87, "FDD", 420, 70546, 70595),
  lte(88, "FDD", 422, 70596, 70645),
];

export interface NrBandInfo {
  band: number;
  duplex: Duplex;
  /** FR1 (410–7125 MHz) or FR2 (24.25–71 GHz). */
  range: "FR1" | "FR2";
  /** Downlink NR-ARFCN range (inclusive). */
  dlArfcn: readonly [number, number];
}

const nr = (band: number, duplex: Duplex, min: number, max: number): NrBandInfo => ({
  band,
  duplex,
  range: band >= 257 ? "FR2" : "FR1",
  dlArfcn: [min, max],
});

/** NR operating bands with a downlink (TS 38.101-1 / 38.101-2 Table 5.4.2.3-1). */
export const NR_BANDS: ReadonlyArray<NrBandInfo> = [
  nr(1, "FDD", 422000, 434000),
  nr(2, "FDD", 386000, 398000),
  nr(3, "FDD", 361000, 376000),
  nr(5, "FDD", 173800, 178800),
  nr(7, "FDD", 524000, 538000),
  nr(8, "FDD", 185000, 192000),
  nr(12, "FDD", 145800, 149200),
  nr(13, "FDD", 149200, 151200),
  nr(14, "FDD", 151600, 153600),
  nr(18, "FDD", 172000, 175000),
  nr(20, "FDD", 158200, 164200),
  nr(24, "FDD", 305000, 311800),
  nr(25, "FDD", 386000, 399000),
  nr(26, "FDD", 171800, 178800),
  nr(28, "FDD", 151600, 160600),
  nr(29, "SDL", 143400, 145600),
  nr(30, "FDD", 470000, 472000),
  nr(34, "TDD", 402000, 405000),
  nr(38, "TDD", 514000, 524000),
  nr(39, "TDD", 376000, 384000),
  nr(40, "TDD", 460000, 480000),
  nr(41, "TDD", 499200, 537999),
  nr(46, "TDD", 743334, 795000),
  nr(47, "TDD", 790334, 795000),
  nr(48, "TDD", 636667, 646666),
  nr(50, "TDD", 286400, 303400),
  nr(51, "TDD", 285400, 286400),
  nr(53, "TDD", 496700, 499000),
  nr(54, "TDD", 334000, 335000),
  nr(65, "FDD", 422000, 440000),
  nr(66, "FDD", 422000, 440000),
  nr(67, "SDL", 147600, 151600),
  nr(70, "FDD", 399000, 404000),
  nr(71, "FDD", 123400, 130400),
  nr(74, "FDD", 295000, 303600),
  nr(75, "SDL", 286400, 303400),
  nr(76, "SDL", 285400, 286400),
  nr(77, "TDD", 620000, 680000),
  nr(78, "TDD", 620000, 653333),
  nr(79, "TDD", 693334, 733333),
  nr(85, "FDD", 145600, 149200),
  nr(90, "TDD", 499200, 538000),
  nr(91, "FDD", 285400, 286400),
  nr(92, "FDD", 286400, 303400),
  nr(93, "FDD", 285400, 286400),
  nr(94, "FDD", 286400, 303400),
  nr(96, "TDD", 795000, 875000),
  nr(100, "FDD", 183880, 185000),
  nr(101, "TDD", 380000, 382000),
  nr(102, "TDD", 795000, 828333),
  nr(104, "TDD", 828334, 875000),
  nr(105, "FDD", 122400, 130400),
  nr(106, "FDD", 187000, 188000),
  nr(257, "TDD", 2054166, 2104165),
  nr(258, "TDD", 2016667, 2070832),
  nr(259, "TDD", 2270833, 2337499),
  nr(260, "TDD", 2229166, 2279165),
  nr(261, "TDD", 2070833, 2084999),
  nr(262, "TDD", 2399166, 2415832),
];

/**
 * Which band an NR-ARFCN shared by several bands is reported as: the band deployed more widely first
 * (n78 inside n77, n41 before n90, n1 before n65/n66, n28 before n14), then table order.
 */
const NR_BAND_PREFERENCE: ReadonlyArray<number> = [78, 41, 28, 1, 3, 79, 77, 5, 8, 7, 20, 38, 40, 39, 34, 2, 25, 66, 65, 71, 12, 13, 14, 18, 26, 50, 51];

const LTE_BY_NUMBER: ReadonlyMap<number, LteBandInfo> = new Map(LTE_BANDS.map((info) => [info.band, info]));
const NR_BY_NUMBER: ReadonlyMap<number, NrBandInfo> = new Map(NR_BANDS.map((info) => [info.band, info]));

/** Highest EARFCN (18 bits, TS 36.331 `ARFCN-ValueEUTRA-r9`) and NR-ARFCN (TS 38.104 Table 5.4.2.1-1). */
export const MAX_EARFCN = 262143;
export const MAX_NR_ARFCN = 3279165;

export function lteBandInfo(band: number): LteBandInfo | undefined {
  return LTE_BY_NUMBER.get(band);
}

export function nrBandInfo(band: number): NrBandInfo | undefined {
  return NR_BY_NUMBER.get(band);
}

function isNonNegativeInteger(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

/** The LTE band of a downlink EARFCN (EARFCN ranges never overlap), `null` when none has it. */
export function earfcnToLteBand(earfcn: number): number | null {
  if (!isNonNegativeInteger(earfcn, MAX_EARFCN)) return null;
  for (const info of LTE_BANDS) {
    if (earfcn >= info.dlEarfcn[0] && earfcn <= info.dlEarfcn[1]) return info.band;
  }
  return null;
}

/** Downlink carrier frequency (MHz) of an EARFCN: F_DL = F_DL_low + 0.1 (N_DL − N_Offs-DL). */
export function earfcnToFrequencyMhz(earfcn: number): number | null {
  const band = earfcnToLteBand(earfcn);
  if (band === null) return null;
  const info = LTE_BY_NUMBER.get(band);
  if (!info) return null;
  return roundMhz(info.dlLowMhz + 0.1 * (earfcn - info.dlOffset));
}

/** Every NR band whose downlink raster contains `arfcn`, preferred band first. */
export function nrBandsForArfcn(arfcn: number): number[] {
  if (!isNonNegativeInteger(arfcn, MAX_NR_ARFCN)) return [];
  const hits = NR_BANDS.filter((info) => arfcn >= info.dlArfcn[0] && arfcn <= info.dlArfcn[1]).map((info) => info.band);
  const rank = (band: number): number => {
    const index = NR_BAND_PREFERENCE.indexOf(band);
    return index === -1 ? NR_BAND_PREFERENCE.length : index;
  };
  return hits.sort((a, b) => rank(a) - rank(b) || a - b);
}

/** The NR band an NR-ARFCN is most likely on (see `nrBandsForArfcn`), `null` when none has it. */
export function nrArfcnToBand(arfcn: number): number | null {
  return nrBandsForArfcn(arfcn)[0] ?? null;
}

/** Carrier frequency (MHz) of an NR-ARFCN on the global frequency raster (TS 38.104 §5.4.2.1). */
export function nrArfcnToFrequencyMhz(arfcn: number): number | null {
  if (!isNonNegativeInteger(arfcn, MAX_NR_ARFCN)) return null;
  if (arfcn < 600000) return roundMhz(0.005 * arfcn);
  if (arfcn <= 2016666) return roundMhz(3000 + 0.015 * (arfcn - 600000));
  return roundMhz(24250.08 + 0.06 * (arfcn - 2016667));
}

/** The NR-ARFCN of a carrier frequency (MHz), rounded to the nearest raster point; `null` outside 0–100 GHz. */
export function frequencyMhzToNrArfcn(mhz: number): number | null {
  if (!Number.isFinite(mhz) || mhz < 0 || mhz > 100000) return null;
  if (mhz < 3000) return Math.round(mhz / 0.005);
  if (mhz < 24250.08) return 600000 + Math.round((mhz - 3000) / 0.015);
  return 2016667 + Math.round((mhz - 24250.08) / 0.06);
}

/**
 * SS block reference frequency (MHz) of a GSCN (TS 38.104 Table 5.4.3.1-1): below 3 GHz
 * `N × 1.2 MHz + M × 50 kHz` (GSCN = 3N + (M − 3)/2, M ∈ {1, 3, 5}), up to 24.25 GHz
 * `3000 MHz + N × 1.44 MHz` (GSCN = 7499 + N), above `24250.08 MHz + N × 17.28 MHz` (GSCN = 22256 + N).
 */
export function gscnToFrequencyMhz(gscn: number): number | null {
  if (!Number.isInteger(gscn) || gscn < 2 || gscn > 26639) return null;
  if (gscn <= 7498) {
    const n = Math.floor((gscn + 1) / 3);
    const m = 2 * (gscn - 3 * n) + 3;
    if (n < 1 || n > 2499 || (m !== 1 && m !== 3 && m !== 5)) return null;
    return roundMhz(n * 1.2 + m * 0.05);
  }
  if (gscn <= 22255) return roundMhz(3000 + (gscn - 7499) * 1.44);
  return roundMhz(24250.08 + (gscn - 22256) * 17.28);
}

/** The GSCN nearest to an SS block frequency (MHz), the inverse of `gscnToFrequencyMhz`. */
export function frequencyMhzToGscn(mhz: number): number | null {
  if (!Number.isFinite(mhz) || mhz <= 0 || mhz > 100000) return null;
  if (mhz < 3000) {
    let best: { gscn: number; error: number } | null = null;
    const n = Math.round(mhz / 1.2);
    for (const candidateN of [n - 1, n, n + 1]) {
      if (candidateN < 1 || candidateN > 2499) continue;
      for (const m of [1, 3, 5]) {
        const error = Math.abs(candidateN * 1.2 + m * 0.05 - mhz);
        if (best === null || error < best.error) best = { gscn: 3 * candidateN + (m - 3) / 2, error };
      }
    }
    return best?.gscn ?? null;
  }
  if (mhz < 24250.08) return 7499 + Math.round((mhz - 3000) / 1.44);
  return 22256 + Math.round((mhz - 24250.08) / 17.28);
}

/** Megahertz to a kilohertz grid (no binary-fraction noise such as 2110.0000000002). */
function roundMhz(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface PciGroups {
  pci: number;
  /** N_ID(1): the SSS group (LTE 0–167, NR 0–335). */
  sssGroup: number;
  /** N_ID(2): the PSS index; equal values on neighbours are the "mod 3" interference pattern. */
  pssIndex: 0 | 1 | 2;
}

/** PCI = 3 N_ID(1) + N_ID(2); `null` outside LTE 0–503 / NR 0–1007. */
export function decomposePci(rat: "LTE" | "NR", pci: number): PciGroups | null {
  const max = rat === "LTE" ? 503 : 1007;
  if (!isNonNegativeInteger(pci, max)) return null;
  return { pci, sssGroup: Math.floor(pci / 3), pssIndex: (pci % 3) as 0 | 1 | 2 };
}

/** LTE resource blocks per channel bandwidth (TS 36.101 Table 5.6-1). */
export const LTE_RESOURCE_BLOCKS: Readonly<Record<string, number>> = { "1.4": 6, "3": 15, "5": 25, "10": 50, "15": 75, "20": 100 };

type ResourceBlockTable = Readonly<Record<number, Readonly<Record<number, number>>>>;

/** NR maximum transmission bandwidth N_RB in FR1 per subcarrier spacing (kHz) and channel bandwidth (MHz), TS 38.101-1 Table 5.3.2-1. */
export const NR_RESOURCE_BLOCKS_FR1: ResourceBlockTable = {
  15: { 5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 35: 188, 40: 216, 45: 242, 50: 270 },
  30: { 5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 35: 92, 40: 106, 45: 119, 50: 133, 60: 162, 70: 189, 80: 217, 90: 245, 100: 273 },
  60: { 10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 35: 44, 40: 51, 45: 58, 50: 65, 60: 79, 70: 93, 80: 107, 90: 121, 100: 135 },
};

/** The same in FR2, TS 38.101-2 Table 5.3.2-1. */
export const NR_RESOURCE_BLOCKS_FR2: ResourceBlockTable = {
  60: { 50: 66, 100: 132, 200: 264 },
  120: { 50: 32, 100: 66, 200: 132, 400: 264 },
};

/** Bits per symbol of a modulation name, `null` for one this table does not know. */
export function modulationOrder(modulation: string): number | null {
  const key = modulation.trim().toUpperCase();
  const table: Readonly<Record<string, number>> = { BPSK: 1, QPSK: 2, "16QAM": 4, "64QAM": 6, "256QAM": 8, "1024QAM": 10 };
  return Object.hasOwn(table, key) ? (table[key] ?? null) : null;
}

export interface CarrierRateInput {
  rat: "LTE" | "NR";
  bandwidthMhz: number;
  /** MIMO layers (1–8). */
  layers: number;
  /** Bits per symbol: 2 QPSK, 4 16QAM, 6 64QAM, 8 256QAM, 10 1024QAM. */
  modulationBits: number;
  /** NR only: subcarrier spacing in kHz (15, 30, 60, 120); LTE is always 15. */
  scsKhz?: number;
  /** NR only: frequency range, which sets the overhead (default from the spacing: 120 kHz → FR2). */
  range?: "FR1" | "FR2";
  direction?: "DL" | "UL";
  /** TS 38.306 scaling factor f (1, 0.8, 0.75 or 0.4; default 1). */
  scaling?: number;
}

/** R_max of TS 38.306 §4.1.2 (948/1024). */
const R_MAX = 948 / 1024;
/** LTE control region, reference signals and synchronization take about a quarter of the resource elements. */
const LTE_OVERHEAD = 0.25;

/**
 * Peak data rate of one carrier in Mbit/s. NR follows TS 38.306 §4.1.2:
 * `layers × Qm × f × Rmax × (N_PRB × 12) / Ts(μ) × (1 − OH)`, Ts(μ) = 10⁻³ / (14 × 2^μ), OH 0.14 / 0.18
 * (FR1 / FR2 downlink) and 0.08 / 0.10 (uplink). LTE uses the same resource-element count with a 25 %
 * overhead instead of the transport block tables of TS 36.213, an estimate within a few percent of the
 * category peak rates. `null` for a bandwidth or spacing without a resource-block entry.
 */
export function carrierPeakRateMbps(input: CarrierRateInput): number | null {
  if (!Number.isInteger(input.layers) || input.layers < 1 || input.layers > 8) return null;
  if (!Number.isInteger(input.modulationBits) || input.modulationBits < 1 || input.modulationBits > 10) return null;
  const scaling = input.scaling ?? 1;
  if (![1, 0.8, 0.75, 0.4].includes(scaling)) return null;
  const uplink = input.direction === "UL";
  if (input.rat === "LTE") {
    const rb = LTE_RESOURCE_BLOCKS[String(input.bandwidthMhz)];
    if (rb === undefined) return null;
    const resourceElementsPerSecond = rb * 12 * 14 * 1000;
    return round1(input.layers * input.modulationBits * scaling * resourceElementsPerSecond * (1 - LTE_OVERHEAD) * 1e-6);
  }
  const scs = input.scsKhz ?? 30;
  const fr2 = (input.range ?? (scs >= 120 ? "FR2" : "FR1")) === "FR2";
  const rb = (fr2 ? NR_RESOURCE_BLOCKS_FR2 : NR_RESOURCE_BLOCKS_FR1)[scs]?.[input.bandwidthMhz];
  if (rb === undefined) return null;
  const mu = Math.log2(scs / 15);
  const symbolSeconds = 1e-3 / (14 * 2 ** mu);
  const overhead = uplink ? (fr2 ? 0.1 : 0.08) : fr2 ? 0.18 : 0.14;
  return round1(1e-6 * input.layers * input.modulationBits * scaling * R_MAX * ((rb * 12) / symbolSeconds) * (1 - overhead));
}

/** Sum of the carriers' peak rates (CA / EN-DC), `null` when one of them cannot be computed. */
export function aggregatePeakRateMbps(carriers: ReadonlyArray<CarrierRateInput>): number | null {
  let total = 0;
  for (const carrier of carriers) {
    const rate = carrierPeakRateMbps(carrier);
    if (rate === null) return null;
    total += rate;
  }
  return round1(total);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export type SignalGrade = "excellent" | "good" | "fair" | "poor" | "very_poor";

/** Field-engineering grades: RSRP ≥ −80 / −90 / −100 / −115 dBm, SINR ≥ 20 / 13 / 5 / 0 dB, RSRQ ≥ −7 / −10 / −15 / −19 dB. */
export function signalGrade(metric: "rsrp" | "sinr" | "rsrq", value: number | null): SignalGrade | null {
  if (value === null || !Number.isFinite(value)) return null;
  const thresholds: Readonly<Record<"rsrp" | "sinr" | "rsrq", readonly [number, number, number, number]>> = {
    rsrp: [-80, -90, -100, -115],
    sinr: [20, 13, 5, 0],
    rsrq: [-7, -10, -15, -19],
  };
  const [excellent, good, fair, poor] = thresholds[metric];
  if (value >= excellent) return "excellent";
  if (value >= good) return "good";
  if (value >= fair) return "fair";
  if (value >= poor) return "poor";
  return "very_poor";
}
