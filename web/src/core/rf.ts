import type { GlobalTelemetrySnapshot } from "../../../src/api-contract.ts";

/**
 * Pure RF helpers: signal quality grading, gauge geometry, carrier-aggregation chips and the
 * access mode (SA / NSA) derived from which RAT reports a serving-cell RSRP.
 */

type Rf = GlobalTelemetrySnapshot["rf"];
type McsList = Rf["lteDlMcs"];

export type SignalMetric = "rsrp" | "rsrq" | "sinr";

/** 0 = unusable … 4 = excellent. */
export type QualityLevel = 0 | 1 | 2 | 3 | 4;

interface MetricScale {
  min: number;
  max: number;
  /** Lower bounds of levels 1..4. */
  thresholds: readonly [number, number, number, number];
}

/** Common field-engineering bands (3GPP reporting ranges as the gauge span). */
export const METRIC_SCALES: Readonly<Record<SignalMetric, MetricScale>> = {
  rsrp: { min: -140, max: -44, thresholds: [-110, -100, -90, -80] },
  rsrq: { min: -20, max: -3, thresholds: [-19.5, -15, -12, -10] },
  sinr: { min: -10, max: 30, thresholds: [0, 5, 13, 20] },
};

export function qualityLevel(metric: SignalMetric, value: number | null | undefined): QualityLevel | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const [t1, t2, t3, t4] = METRIC_SCALES[metric].thresholds;
  if (value >= t4) return 4;
  if (value >= t3) return 3;
  if (value >= t2) return 2;
  if (value >= t1) return 1;
  return 0;
}

/** Position of a reading on its gauge, clamped to 0..1. */
export function gaugeFraction(metric: SignalMetric, value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  const { min, max } = METRIC_SCALES[metric];
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** Uplink transmit power on a 0..1 bar between -40 dBm and 26 dBm (power class 2 ceiling). */
export function txPowerFraction(dbm: number | null | undefined): number {
  if (dbm === null || dbm === undefined || !Number.isFinite(dbm)) return 0;
  return Math.min(1, Math.max(0, (dbm + 40) / 66));
}

export type AccessMode = "SA" | "NSA" | "LTE" | "NONE";

/** NR without an LTE anchor is SA; both RATs serving is EN-DC (NSA). */
export function accessMode(rf: Pick<Rf, "lteRsrpDbm" | "nrRsrpDbm">): AccessMode {
  const lte = rf.lteRsrpDbm !== null;
  const nr = rf.nrRsrpDbm !== null;
  if (nr && !lte) return "SA";
  if (nr && lte) return "NSA";
  if (lte) return "LTE";
  return "NONE";
}

/** `B3` / `N78` from either a bare number (`"3"`) or an already prefixed label. */
export function bandLabel(rat: "LTE" | "NR", band: string | number): string {
  const text = String(band).trim();
  if (/^\d+$/.test(text)) return `${rat === "LTE" ? "B" : "N"}${text}`;
  return text.toUpperCase().replace(/^NR\s*/, "N");
}

export interface CarrierChip {
  role: "PCC" | "SCC";
  rat: "LTE" | "NR";
  band: string;
  bandwidthMhz: number;
  arfcn: number;
  /** `PCC B1(20M)`, `SCC B3(20M)`, `5G N78(100M)` (an NR primary in SA: `PCC 5G N78(100M)`). */
  label: string;
}

/** Carrier chips in banner order: the first carrier is the primary cell. */
export function carrierChips(rf: Pick<Rf, "caCarriers">): CarrierChip[] {
  return rf.caCarriers.map((carrier, index) => {
    const role = index === 0 ? "PCC" : "SCC";
    const band = bandLabel(carrier.rat, carrier.band);
    const body = `${band}(${carrier.bandwidthMhz}M)`;
    const label = carrier.rat === "NR" ? `${role === "PCC" ? "PCC " : ""}5G ${body}` : `${role} ${body}`;
    return { role, rat: carrier.rat, band, bandwidthMhz: carrier.bandwidthMhz, arfcn: carrier.arfcn, label };
  });
}

export function caSummary(chips: ReadonlyArray<CarrierChip>): string {
  return chips.map((c) => c.label).join(" + ");
}

const MODULATION_ORDER = ["BPSK", "QPSK", "16QAM", "64QAM", "256QAM", "1024QAM"];

/** Highest modulation among the codewords (`256QAM`), or `null` when none is reported. */
export function bestModulation(list: McsList): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const entry of list) {
    const mod = entry.modulation?.toUpperCase() ?? null;
    if (!mod) continue;
    const rank = MODULATION_ORDER.indexOf(mod);
    if (rank > bestRank) {
      best = mod;
      bestRank = rank;
    }
  }
  return best;
}

/** Signal bars 0..4 from the primary RSRP (NR first, like the router's own indicator). */
export function signalBars(rf: Pick<Rf, "lteRsrpDbm" | "nrRsrpDbm">): number {
  const level = qualityLevel("rsrp", rf.nrRsrpDbm ?? rf.lteRsrpDbm);
  return level ?? 0;
}
