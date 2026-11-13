import type { SchedulerStatusSnapshot } from "../../../src/api-contract.ts";
import { MAX_LOCK_CELLS, MAX_PCI, type CellLockCheck, type CellLockInput, H168_383_LTE_BANDS, H168_383_NR_BANDS, type RatName, arfcnRangeOf, checkCellLockInput } from "../../../src/rf-bounds.ts";
import { LTE_BANDS, NR_BANDS, lteBandInfo, nrBandInfo } from "../../../src/rf-math.ts";
import { type DriverFamily, ROUTER_FAMILY_FACTS, isDriverFamily } from "../../../src/router-family.ts";

/**
 * What the lock forms offer on the router the daemon watches, decided without the DOM. The verified
 * router's forms list its own bands and may lock a frequency without a PCI; a router of another
 * brand takes any band of the 3GPP tables (its driver checks the rest) and always locks one cell.
 * The daemon runs the same checks on its side: these only say so before anything is sent.
 */

/** The brand whose own driver reads and writes the router (`null`: the HiLink stack, or no status yet). */
export function driverFamilyOf(scheduler: SchedulerStatusSnapshot | null): DriverFamily | null {
  const family = scheduler?.device.family;
  return family !== undefined && isDriverFamily(family) ? family : null;
}

/** The brand's driver locks NR bands as well as LTE bands. */
export function locksNrBands(family: DriverFamily): boolean {
  return ROUTER_FAMILY_FACTS[family].nrBandLock;
}

const ALL_BANDS: Readonly<Record<RatName, ReadonlyArray<number>>> = { LTE: LTE_BANDS.map((b) => b.band), NR: NR_BANDS.map((b) => b.band) };

function channelRange(rat: RatName, band: number): readonly [number, number] | undefined {
  return rat === "LTE" ? lteBandInfo(band)?.dlEarfcn : nrBandInfo(band)?.dlArfcn;
}

/**
 * The daemon's cell-lock check for a router of a driver family: a 3GPP band, a channel in it, and a
 * PCI (`frequency`: the brand also locks a channel alone, so the PCI may be left out).
 */
function checkDriverCellLock(input: CellLockInput, frequency = false): CellLockCheck {
  const band = typeof input.band === "number" ? input.band : Number.NaN;
  const range = Number.isInteger(band) ? channelRange(input.rat, band) : undefined;
  if (!range) return { ok: false, field: "band", message: `${input.rat} band ${String(input.band)} is not a 3GPP band`, range: null };
  if (!Number.isInteger(input.arfcn) || input.arfcn < range[0] || input.arfcn > range[1]) {
    return { ok: false, field: "arfcn", message: `Channel ${input.arfcn} is outside the band (${range[0]}–${range[1]})`, range };
  }
  const max = MAX_PCI[input.rat];
  if (input.pci === null && frequency) return { ok: true, value: { rat: input.rat, band, arfcn: input.arfcn, pci: null } };
  if (input.pci === null || !Number.isInteger(input.pci) || input.pci < 0 || input.pci > max) {
    return { ok: false, field: "pci", message: `PCI must be 0–${max}`, range: [0, max] };
  }
  return { ok: true, value: { rat: input.rat, band, arfcn: input.arfcn, pci: input.pci } };
}

/** The cell-lock form of the router in use: its bands, each band's channel range, its check, and whether a PCI is a must. */
export interface CellLockForm {
  /** Another brand's driver writes the lock (the form names no model's own band list). */
  driver: boolean;
  /** A lock always names one cell: no "frequency only" choice. */
  pciRequired: boolean;
  /** How many cells one lock may name on this RAT (1: one cell at a time). */
  maxCells(rat: RatName): number;
  bands(rat: RatName): ReadonlyArray<number>;
  range(rat: RatName, band: number): readonly [number, number] | undefined;
  check(input: CellLockInput): CellLockCheck;
}

export function cellLockForm(scheduler: SchedulerStatusSnapshot | null): CellLockForm {
  const family = driverFamilyOf(scheduler);
  if (family !== null) {
    // A brand whose notes define a lock on the channel alone may leave the PCI out
    const frequency = ROUTER_FAMILY_FACTS[family].frequencyLock === true;
    // A brand some of whose routers lock several candidate cells of this RAT at once (the daemon refuses on one that cannot)
    const several = ROUTER_FAMILY_FACTS[family].multiCellLock ?? [];
    return {
      driver: true,
      pciRequired: !frequency,
      maxCells: (rat) => (several.includes(rat) ? MAX_LOCK_CELLS : 1),
      bands: (rat) => ALL_BANDS[rat],
      range: channelRange,
      check: (input) => checkDriverCellLock(input, frequency),
    };
  }
  return { driver: false, pciRequired: false, maxCells: () => 1, bands: (rat) => (rat === "LTE" ? H168_383_LTE_BANDS : H168_383_NR_BANDS), range: arfcnRangeOf, check: checkCellLockInput };
}

/**
 * Bands typed as text (`1, 3, 41`, `B1 B3`, `n78`, `all`): the band numbers in order, `"all"`,
 * `undefined` for an empty field (that RAT is left as the router has it), or `null` when something
 * in it is not a band of the 3GPP table.
 */
export function parseBandText(rat: RatName, text: string): number[] | "all" | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (trimmed.toLowerCase() === "all") return "all";
  const bands = new Set<number>();
  for (const part of trimmed.split(/[\s,，;；+]+/).slice(0, 128)) {
    if (part === "") continue;
    const match = /^(?:[bn])?(\d{1,3})$/i.exec(part);
    const band = match ? Number(match[1]) : Number.NaN;
    if (!ALL_BANDS[rat].includes(band)) return null;
    bands.add(band);
  }
  return bands.size > 0 ? [...bands].sort((a, b) => a - b) : null;
}

/** A lock's bands as the text the field shows (`""` for none named, `all` for every band). */
export function bandText(bands: ReadonlyArray<number> | "all" | null | undefined): string {
  if (bands === "all") return "all";
  return bands && bands.length > 0 ? bands.join(", ") : "";
}
