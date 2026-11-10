import { CpeControlValidationError } from "../control-error.ts";
import { LTE_BANDS, NR_BANDS, lteBandInfo, nrBandInfo } from "../rf-math.ts";
import type { DriverCellLockTarget, DriverRat, SubcarrierSpacingKhz } from "./types.ts";

/**
 * Band lists in the formats the router families use: a 1-indexed bit mask (band `b` is bit `b − 1`,
 * as hexadecimal with or without `0x`, in either case) or a list (`"1,3,8"`, `"B1,B3"`, `"N41:N78"`).
 * Plus the checks a driver write runs before anything is sent: every band, channel and cell must
 * exist in the 3GPP tables (`src/rf-math.ts`).
 */

/** Highest band any family names (NR FR2 goes up to n262). */
const MAX_BAND = 262;

export function bandsToMask(bands: ReadonlyArray<number>): bigint {
  let mask = 0n;
  for (const band of bands) {
    if (!Number.isInteger(band) || band < 1 || band > MAX_BAND) throw new CpeControlValidationError(`Invalid band ${band}`);
    mask |= 1n << BigInt(band - 1);
  }
  return mask;
}

export function maskToBands(mask: bigint): number[] {
  const out: number[] = [];
  for (let band = 1; band <= MAX_BAND; band++) {
    if ((mask >> BigInt(band - 1)) & 1n) out.push(band);
  }
  return out;
}

/** The mask as hexadecimal: no leading zeros, `""` for no band unless `zero` says otherwise. */
export function bandsToHex(bands: ReadonlyArray<number>, opts: { prefix?: "0x" | ""; upper?: boolean; zero?: string } = {}): string {
  const mask = bandsToMask(bands);
  if (mask === 0n) return opts.zero ?? "";
  const hex = mask.toString(16);
  return `${opts.prefix ?? ""}${opts.upper ? hex.toUpperCase() : hex}`;
}

/** A hexadecimal mask (`"85"`, `"0x85"`, `"0XA3E2"`) to sorted bands; `null` when it is not one. */
export function hexToBands(value: string | null): number[] | null {
  if (value === null) return null;
  const clean = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,72}$/.test(clean)) return null;
  return maskToBands(BigInt(`0x${clean}`));
}

/** A list of bands with or without `B` / `N` prefixes, split on `,` `:` `;` or spaces; `null` when an item is not a band. */
export function listToBands(value: string | null): number[] | null {
  if (value === null) return null;
  const items = value.slice(0, 4096).split(/[,:;\s]+/).filter((item) => item !== "");
  const out = new Set<number>();
  for (const item of items) {
    const match = /^[BbNn]?(\d{1,3})$/.exec(item);
    const band = match?.[1] ? Number.parseInt(match[1], 10) : Number.NaN;
    if (!Number.isInteger(band) || band < 1 || band > MAX_BAND) return null;
    out.add(band);
  }
  return [...out].sort((a, b) => a - b);
}

export function bandsToList(bands: ReadonlyArray<number>, separator: string, prefix = ""): string {
  return [...bands].sort((a, b) => a - b).map((band) => `${prefix}${band}`).join(separator);
}

/** Every LTE band of the 3GPP table, and every NR band (FR1 and FR2). */
export const ALL_LTE_BANDS: ReadonlyArray<number> = LTE_BANDS.map((b) => b.band);
export const ALL_NR_BANDS: ReadonlyArray<number> = NR_BANDS.map((b) => b.band);

/**
 * Bands a driver band lock may send for `rat`: each one known to 3GPP and, when the router named
 * the bands it supports, one of those (a band it cannot use would leave the modem without signal).
 */
export function checkLockBands(rat: DriverRat, bands: ReadonlyArray<number>, supported: ReadonlyArray<number> | null): number[] {
  if (bands.length === 0) throw new CpeControlValidationError(`Choose at least one ${rat} band`);
  const known = rat === "LTE" ? ALL_LTE_BANDS : ALL_NR_BANDS;
  const out = new Set<number>();
  for (const band of bands) {
    if (!Number.isInteger(band) || !known.includes(band)) throw new CpeControlValidationError(`${rat} band ${band} is not a 3GPP band`);
    if (supported && supported.length > 0 && !supported.includes(band)) {
      throw new CpeControlValidationError(`${rat} band ${band} is not one this router supports (${supported.join(", ")})`);
    }
    out.add(band);
  }
  return [...out].sort((a, b) => a - b);
}

const SPACINGS: ReadonlyArray<SubcarrierSpacingKhz> = [15, 30, 60, 120, 240];

export function isSubcarrierSpacing(value: unknown): value is SubcarrierSpacingKhz {
  return typeof value === "number" && (SPACINGS as ReadonlyArray<number>).includes(value);
}

/**
 * The spacing an NR cell lock sends when the caller gave none: 15 kHz on FDD bands, 30 kHz on TDD
 * bands below 6 GHz (the SSB spacing those deployments use), 120 kHz in FR2.
 */
export function defaultSpacing(band: number): SubcarrierSpacingKhz {
  const info = nrBandInfo(band);
  if (info?.range === "FR2") return 120;
  return info?.duplex === "TDD" ? 30 : 15;
}

/** A cell lock a driver may send: band, channel in that band's downlink range, PCI, spacing. */
export function checkCellLock(target: DriverCellLockTarget): DriverCellLockTarget {
  const { rat, band, arfcn, pci } = target;
  const range = rat === "LTE" ? lteBandInfo(band)?.dlEarfcn : nrBandInfo(band)?.dlArfcn;
  if (!Number.isInteger(band) || !range) throw new CpeControlValidationError(`${rat} band ${band} is not a 3GPP band`);
  if (!Number.isInteger(arfcn) || arfcn < range[0] || arfcn > range[1]) {
    throw new CpeControlValidationError(`Channel ${arfcn} is outside ${rat === "LTE" ? "B" : "n"}${band} (${range[0]}–${range[1]})`);
  }
  const maxPci = rat === "LTE" ? 503 : 1007;
  if (!Number.isInteger(pci) || pci < 0 || pci > maxPci) throw new CpeControlValidationError(`PCI ${pci} is outside 0–${maxPci}`);
  if (rat === "LTE") return { rat, band, arfcn, pci, scsKhz: null };
  const scsKhz = target.scsKhz ?? defaultSpacing(band);
  if (!isSubcarrierSpacing(scsKhz)) throw new CpeControlValidationError(`Subcarrier spacing ${String(target.scsKhz)} kHz is not one of 15, 30, 60, 120, 240`);
  return { rat, band, arfcn, pci, scsKhz };
}
