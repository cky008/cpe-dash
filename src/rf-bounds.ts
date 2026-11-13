/**
 * H168-383 band, ARFCN and PCI bounds for band and cell locks. This module imports nothing, so the
 * web dashboard bundles it and validates lock forms with exactly the rules the daemon enforces.
 */

export type BandInput = number | string;

export type RatName = "LTE" | "NR";

/**
 * LTE bands the H168-383 advertises in `GET /api/net/net-mode-list` (`<LTEBandList>`, mask
 * `40000007a0880800d5`). Locking LTE to any other band could leave the modem without an LTE anchor.
 */
export const H168_383_LTE_BANDS: ReadonlyArray<number> = [1, 3, 5, 7, 8, 20, 28, 32, 38, 40, 41, 42, 43, 71];

/** Downlink EARFCN range per H168-383 LTE band (3GPP TS 36.101, Table 5.7.3-1). */
export const LTE_DL_EARFCN_RANGES: Readonly<Record<number, readonly [number, number]>> = {
  1: [0, 599],
  3: [1200, 1949],
  5: [2400, 2649],
  7: [2750, 3449],
  8: [3450, 3799],
  20: [6150, 6449],
  28: [9210, 9659],
  32: [9920, 10359],
  38: [37750, 38249],
  40: [38650, 39649],
  41: [39650, 41589],
  42: [41590, 43589],
  43: [43590, 45589],
  71: [68586, 68935],
};

/**
 * NR bands of the H168-383 from Huawei's specification sheet (FDD n1/3/5/7/8/20/28/71/75, TDD
 * n38/40/41/77/78/79). The router does not advertise NR bands (`net-mode-list` only lists LTE), but
 * the same sheet's LTE list matches that router-advertised list exactly, and n78 is served on the
 * real device. The SUL bands n80-n84 are uplink-only and cannot be locked as downlink bands.
 */
export const H168_383_NR_BANDS: ReadonlyArray<number> = [1, 3, 5, 7, 8, 20, 28, 38, 40, 41, 71, 75, 77, 78, 79];

/** Downlink NR-ARFCN range per H168-383 NR band (3GPP TS 38.101-1, Table 5.4.2.3-1). */
export const NR_DL_ARFCN_RANGES: Readonly<Record<number, readonly [number, number]>> = {
  1: [422000, 434000],
  3: [361000, 376000],
  5: [173800, 178800],
  7: [524000, 538000],
  8: [185000, 192000],
  20: [158200, 164200],
  28: [151600, 160600],
  38: [514000, 524000],
  40: [460000, 480000],
  41: [499200, 537999],
  71: [123400, 130400],
  75: [286400, 303400],
  77: [620000, 680000],
  78: [620000, 653333],
  79: [693334, 733333],
};

/** Highest physical cell identity: 504 per LTE (TS 36.211 6.11), 1008 per NR (TS 38.211 7.4.2.1). */
/** The most cells one lock names (FengSui's own limit; Quectel modules document up to 20 LTE cells). */
export const MAX_LOCK_CELLS = 10;

export const MAX_PCI: Readonly<Record<RatName, number>> = { LTE: 503, NR: 1007 };

/**
 * Parse a numeric or string band identifier (`1`, `"B3"`, `"LTE BC71"`, `"N78"`) into 1..255.
 */
export function parseBandNumber(input: BandInput): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 1 || input > 255) {
      throw new Error(`Invalid band number: ${input} (expected integer 1..255)`);
    }
    return input;
  }
  const match = input.trim().match(/^(?:LTE\s*BC|BC|B|NR|N)?\s*(\d{1,3})$/i);
  if (!match?.[1]) {
    throw new Error(`Invalid band label "${input}"`);
  }
  const num = Number.parseInt(match[1], 10);
  if (!Number.isInteger(num) || num < 1 || num > 255) {
    throw new Error(`Invalid band number in "${input}" (expected 1..255)`);
  }
  return num;
}

/** Parse an LTE band and require it to be one the H168-383 supports. */
export function parseSupportedLteBand(input: BandInput): number {
  const band = parseBandNumber(input);
  if (!H168_383_LTE_BANDS.includes(band)) {
    throw new Error(
      `LTE band B${band} is not supported by the H168-383 (supported: ${H168_383_LTE_BANDS.map((b) => `B${b}`).join(", ")})`
    );
  }
  return band;
}

/** Parse an NR band and require it to be one the H168-383 supports. */
export function parseSupportedNrBand(input: BandInput): number {
  const band = parseBandNumber(input);
  if (!H168_383_NR_BANDS.includes(band)) {
    throw new Error(
      `NR band N${band} is not supported by the H168-383 (supported: ${H168_383_NR_BANDS.map((b) => `N${b}`).join(", ")})`
    );
  }
  return band;
}

/** Downlink ARFCN range of a supported band, or `undefined` for a band the H168-383 cannot lock. */
export function arfcnRangeOf(rat: RatName, band: number): readonly [number, number] | undefined {
  return rat === "LTE" ? LTE_DL_EARFCN_RANGES[band] : NR_DL_ARFCN_RANGES[band];
}

export function validateArfcnInBand(rat: RatName, band: number, arfcn: number): number {
  const range = arfcnRangeOf(rat, band);
  const label = rat === "LTE" ? `B${band} (3GPP DL EARFCN` : `N${band} (3GPP DL NR-ARFCN`;
  if (!Number.isInteger(arfcn) || range === undefined || arfcn < range[0] || arfcn > range[1]) {
    const bounds = range ? ` ${range[0]}..${range[1]})` : ")";
    throw new Error(`Invalid ARFCN ${arfcn} for ${label}${bounds}`);
  }
  return arfcn;
}

export function validatePci(rat: RatName, pci: number): number {
  if (!Number.isInteger(pci) || pci < 0 || pci > MAX_PCI[rat]) {
    throw new Error(`Invalid PCI "${pci}" for ${rat} (expected integer 0..${MAX_PCI[rat]})`);
  }
  return pci;
}

/**
 * Compute Huawei's lowercase hexadecimal BandMask from 1-indexed 3GPP band numbers:
 * `Mask = sum(1n << BigInt(band - 1))`.
 */
export function bandsToHexMask(bands: ReadonlyArray<BandInput>): string {
  if (bands.length === 0) return "0";
  let mask = 0n;
  for (const item of bands) {
    const band = parseBandNumber(item);
    mask |= 1n << BigInt(band - 1);
  }
  return mask.toString(16).toLowerCase();
}

/**
 * Decode a Huawei hexadecimal BandMask back into sorted ascending 3GPP band numbers (1..255).
 */
export function hexMaskToBands(hexMask: string): number[] {
  const clean = hexMask.trim().replace(/^0x/i, "");
  if (!clean || /^0+$/.test(clean)) return [];
  if (!/^[0-9a-fA-F]{1,64}$/.test(clean)) {
    throw new Error(`Invalid hexadecimal band mask "${hexMask}"`);
  }
  const mask = BigInt(`0x${clean}`);
  const out: number[] = [];
  for (let band = 1; band <= 255; band++) {
    if ((mask & (1n << BigInt(band - 1))) !== 0n) {
      out.push(band);
    }
  }
  return out;
}

export interface CellLockInput {
  rat: RatName;
  band: BandInput;
  arfcn: number;
  /** `null` locks the frequency (`lock_mode=1`) instead of one cell. */
  pci: number | null;
}

export type CellLockCheck =
  | { ok: true; value: { rat: RatName; band: number; arfcn: number; pci: number | null } }
  | { ok: false; field: "band" | "arfcn" | "pci"; message: string; range: readonly [number, number] | null };

/**
 * Non-throwing form of the daemon's cell-lock validation: reports the first invalid field with its
 * allowed range, so a form can show the bound next to the field before anything is sent.
 */
export function checkCellLockInput(input: CellLockInput): CellLockCheck {
  let band: number;
  try {
    band = input.rat === "LTE" ? parseSupportedLteBand(input.band) : parseSupportedNrBand(input.band);
  } catch (err) {
    return { ok: false, field: "band", message: err instanceof Error ? err.message : String(err), range: null };
  }
  try {
    validateArfcnInBand(input.rat, band, input.arfcn);
  } catch (err) {
    const range = arfcnRangeOf(input.rat, band) ?? null;
    return { ok: false, field: "arfcn", message: err instanceof Error ? err.message : String(err), range };
  }
  if (input.pci !== null) {
    try {
      validatePci(input.rat, input.pci);
    } catch (err) {
      return { ok: false, field: "pci", message: err instanceof Error ? err.message : String(err), range: [0, MAX_PCI[input.rat]] };
    }
  }
  return { ok: true, value: { rat: input.rat, band, arfcn: input.arfcn, pci: input.pci } };
}
