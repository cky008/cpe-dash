import { LTE_DL_EARFCN_RANGES, NR_DL_ARFCN_RANGES } from "../../../src/rf-bounds.ts";

/**
 * The cells around the demo household and which of them a router serves from under a lock: the demo
 * routers (./worlds.ts) answer the daemon with this, so a band or cell lock moves the serving cells as
 * a real router would, and FengSui's own check of the lock (src/cpe-domain.ts `verifyLockState`) finds
 * them where the lock put them. Placeholder cells only (AGENTS.md 铁律二): the primary LTE cell B1 /
 * EARFCN 300, the secondary B3 / 1850, NR N78 / 650000, PCI 211 and 142, and a few weaker neighbours.
 */

export interface DemoCell {
  band: number;
  arfcn: number;
  pci: number;
  /** How much weaker (negative) or stronger this cell is than the household's usual primary one, in dB. */
  offsetDb: number;
}

/** What a router is locked to on one radio: every band, some bands, or one cell (`pci: null`: a channel). */
export type RatLock = { kind: "all" } | { kind: "bands"; bands: ReadonlyArray<number> } | { kind: "cell"; band: number; arfcn: number; pci: number | null };

export interface Serving {
  lte: DemoCell;
  /** The secondary LTE carriers (the household's B1 + B3 pair). */
  lteScc: DemoCell[];
  /** `null`: no 5G cell under this lock (or a router without 5G). */
  nr: DemoCell | null;
}

/** Strongest first. */
export const HOUSEHOLD_LTE: ReadonlyArray<DemoCell> = [
  { band: 1, arfcn: 300, pci: 211, offsetDb: 0 },
  { band: 3, arfcn: 1850, pci: 142, offsetDb: 3 },
  { band: 20, arfcn: 6300, pci: 133, offsetDb: -14 },
  { band: 7, arfcn: 3050, pci: 288, offsetDb: -21 },
];
export const HOUSEHOLD_NR: ReadonlyArray<DemoCell> = [
  { band: 78, arfcn: 650000, pci: 211, offsetDb: 0 },
  { band: 78, arfcn: 636666, pci: 88, offsetDb: -9 },
];
/** The carriers the household's primary cell aggregates with. */
const CA_BANDS: ReadonlySet<number> = new Set([1, 3]);
export const UNLOCKED: RatLock = { kind: "all" };

/** A cell on a band no household cell uses: the middle of the band, weak, as a lock far from home finds. */
function farCell(rat: "LTE" | "NR", band: number, arfcn?: number, pci?: number | null): DemoCell {
  const range = (rat === "LTE" ? LTE_DL_EARFCN_RANGES : NR_DL_ARFCN_RANGES)[band];
  return { band, arfcn: arfcn ?? (range ? Math.round((range[0] + range[1]) / 2) : 0), pci: pci ?? 211, offsetDb: -18 };
}

function cellFor(rat: "LTE" | "NR", lock: Extract<RatLock, { kind: "cell" }>): DemoCell {
  const cells = rat === "LTE" ? HOUSEHOLD_LTE : HOUSEHOLD_NR;
  return cells.find((cell) => cell.arfcn === lock.arfcn && (lock.pci === null || cell.pci === lock.pci)) ?? farCell(rat, lock.band, lock.arfcn, lock.pci);
}

/** The cells a router serves from under `lte` and `nr` (`nr: null`: a router without 5G). */
export function servingFor(lte: RatLock, nr: RatLock | null): Serving {
  let pcc: DemoCell;
  let scc: DemoCell[] = [];
  if (lte.kind === "cell") {
    pcc = cellFor("LTE", lte);
  } else {
    const allowed = lte.kind === "all" ? HOUSEHOLD_LTE : HOUSEHOLD_LTE.filter((cell) => lte.bands.includes(cell.band));
    pcc = allowed[0] ?? farCell("LTE", lte.kind === "bands" ? (lte.bands[0] ?? 1) : 1);
    if (CA_BANDS.has(pcc.band)) scc = allowed.filter((cell) => cell.band !== pcc.band && CA_BANDS.has(cell.band)).slice(0, 1);
  }
  let nrCell: DemoCell | null = null;
  if (nr !== null) {
    if (nr.kind === "cell") nrCell = cellFor("NR", nr);
    else if (nr.kind === "all") nrCell = HOUSEHOLD_NR[0] ?? null;
    else nrCell = HOUSEHOLD_NR.find((cell) => nr.bands.includes(cell.band)) ?? (nr.bands[0] === undefined ? null : farCell("NR", nr.bands[0]));
  }
  return { lte: pcc, lteScc: scc, nr: nrCell };
}

/** `dBm` text with one decimal at most, as routers write it. */
export function dbm(value: number): string {
  return String(Math.round(value * 10) / 10);
}
