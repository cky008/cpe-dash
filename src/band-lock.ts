import { buildXmlRequest } from "./xml.ts";

export const HUAWEI_LTE_ALL_BANDS_MASK = "7fffffffffffffff";
export const HUAWEI_NETWORK_ALL_BANDS_MASK = "3fffffff";

export const NETWORK_MODE_AUTO = "00";
export const NETWORK_MODE_4G_ONLY = "03";
export const NETWORK_MODE_5G_ONLY = "08";

export type HuaweiNetworkModeCode =
  | typeof NETWORK_MODE_AUTO
  | typeof NETWORK_MODE_4G_ONLY
  | typeof NETWORK_MODE_5G_ONLY;

export const LOCK_MODE_UNLOCK = 0;
export const LOCK_MODE_FREQ = 1;
export const LOCK_MODE_CELL = 2;
export const LOCK_MODE_BAND = 3;

export type HuaweiLockMode =
  | typeof LOCK_MODE_UNLOCK
  | typeof LOCK_MODE_FREQ
  | typeof LOCK_MODE_CELL
  | typeof LOCK_MODE_BAND;

export type BandInput = number | string;

export interface LteCellLockParams {
  band: BandInput;
  earfcn: number;
  pci?: number;
}

export interface NrCellLockParams {
  band: BandInput;
  nrArfcn: number;
  pci?: number;
}

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

/**
 * Compute Huawei's lowercase hexadecimal BandMask from 1-indexed 3GPP band numbers:
 * `Mask = sum(1n << BigInt(band - 1))` (`CpeUtil::bandListToHex`).
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

function validateArfcn(arfcn: number): number {
  if (!Number.isInteger(arfcn) || arfcn < 1 || arfcn > 3_279_165) {
    throw new Error(`Invalid ARFCN "${arfcn}" (expected positive integer within 3GPP range)`);
  }
  return arfcn;
}

function validatePci(pci: number): number {
  if (!Number.isInteger(pci) || pci < 0 || pci > 1007) {
    throw new Error(`Invalid PCI "${pci}" (expected integer 0..1007)`);
  }
  return pci;
}

/**
 * Build XML payload for `POST /api/net/net-mode` to lock 4G LTE bands or restore all LTE bands.
 */
export function buildLteBandNetModeXml(
  lteBands: ReadonlyArray<BandInput> | "all",
  networkMode: HuaweiNetworkModeCode = NETWORK_MODE_AUTO
): string {
  let lteMask: string;
  if (lteBands === "all") {
    lteMask = HUAWEI_LTE_ALL_BANDS_MASK;
  } else {
    if (lteBands.length === 0) {
      throw new Error("At least one LTE band is required (or pass 'all' to unlock)");
    }
    lteMask = bandsToHexMask(lteBands);
  }
  return buildXmlRequest({
    NetworkMode: networkMode,
    NetworkBand: HUAWEI_NETWORK_ALL_BANDS_MASK,
    LTEBand: lteMask,
    networkOption: 2,
  });
}

/**
 * Build XML payload for `POST /api/net/lock-freq` (`lock_mode=3`) to lock 5G NR bands on H168-383.
 */
export function buildNrBandLockXml(nrBands: ReadonlyArray<BandInput>): string {
  if (nrBands.length === 0) {
    throw new Error("At least one 5G NR band is required");
  }
  const uniqueSorted = [...new Set(nrBands.map(parseBandNumber))].sort((a, b) => a - b);
  return buildXmlRequest({
    lte_info: {
      lock_mode: LOCK_MODE_UNLOCK,
      freq_infos: "",
      all_bands: "",
    },
    nr_info: {
      lock_mode: LOCK_MODE_BAND,
      freq_infos: {
        freq_info: uniqueSorted.map((band) => ({ band })),
      },
      all_bands: bandsToHexMask(uniqueSorted),
    },
  });
}

/**
 * Build XML payload for `POST /api/net/lock-freq` to lock a 4G LTE cell (`lock_mode=2`)
 * or frequency (`lock_mode=1` when `pci` is omitted).
 */
export function buildLteCellLockXml(params: LteCellLockParams): string {
  const band = parseBandNumber(params.band);
  const freq = validateArfcn(params.earfcn);
  const hasPci = params.pci !== undefined;
  const freqInfo: Record<string, number> = { band, freq };
  if (hasPci) {
    freqInfo["pci"] = validatePci(params.pci!);
  }

  return buildXmlRequest({
    lte_info: {
      lock_mode: hasPci ? LOCK_MODE_CELL : LOCK_MODE_FREQ,
      freq_infos: {
        freq_info: freqInfo,
      },
      all_bands: bandsToHexMask([band]),
    },
  });
}

/**
 * Build XML payload for `POST /api/net/lock-freq` to lock a 5G NR cell (`lock_mode=2`)
 * or NR-ARFCN frequency (`lock_mode=1` when `pci` is omitted).
 */
export function buildNrCellLockXml(params: NrCellLockParams): string {
  const band = parseBandNumber(params.band);
  const freq = validateArfcn(params.nrArfcn);
  const hasPci = params.pci !== undefined;
  const freqInfo: Record<string, number> = { band, freq };
  if (hasPci) {
    freqInfo["pci"] = validatePci(params.pci!);
  }

  return buildXmlRequest({
    lte_info: {
      lock_mode: LOCK_MODE_UNLOCK,
      freq_infos: "",
      all_bands: "",
    },
    nr_info: {
      lock_mode: hasPci ? LOCK_MODE_CELL : LOCK_MODE_FREQ,
      freq_infos: {
        freq_info: freqInfo,
      },
      all_bands: bandsToHexMask([band]),
    },
  });
}

/**
 * Build XML payload for `POST /api/net/lock-freq` (`lock_mode=0`) to clear all 4G & 5G cell/freq/NR-band locks.
 */
export function buildUnlockAllLocksXml(): string {
  return buildXmlRequest({
    lte_info: {
      lock_mode: LOCK_MODE_UNLOCK,
      freq_infos: "",
      all_bands: "",
    },
    nr_info: {
      lock_mode: LOCK_MODE_UNLOCK,
      freq_infos: "",
      all_bands: "",
    },
  });
}

/**
 * Decompose a 28-bit 3GPP E-UTRAN Cell Identifier (decimal or `0x` hex) into 20-bit eNodeB ID + 8-bit Sector ID.
 */
export function decomposeLteEci(eciRaw: string | number): {
  eci: number;
  eNodeBId: number;
  sectorId: number;
} {
  const text = String(eciRaw).trim();
  const isHex = /^0x[0-9a-fA-F]+$/.test(text);
  const isDec = /^\d+$/.test(text);
  if (!isHex && !isDec) {
    throw new Error(`Invalid 28-bit LTE ECI "${eciRaw}"`);
  }
  const eci = Number.parseInt(isHex ? text.slice(2) : text, isHex ? 16 : 10);
  if (!Number.isInteger(eci) || eci < 0 || eci > 0x0fffffff) {
    throw new Error(`Invalid 28-bit LTE ECI range "${eciRaw}"`);
  }
  return {
    eci,
    eNodeBId: eci >>> 8,
    sectorId: eci & 0xff,
  };
}

/**
 * Decompose a 36-bit 3GPP 5G NR Cell Identity (NCI) into gNodeB ID (22..32 bits) + Sector ID.
 */
export function decomposeNrNci(
  nciRaw: string | bigint,
  gNodeBBitLength = 24
): {
  nci: bigint;
  gNodeBId: bigint;
  sectorId: number;
} {
  if (!Number.isInteger(gNodeBBitLength) || gNodeBBitLength < 22 || gNodeBBitLength > 32) {
    throw new Error(`Invalid gNodeB bit length ${gNodeBBitLength} (3GPP TS 38.300 specifies 22..32)`);
  }
  const nci = typeof nciRaw === "bigint" ? nciRaw : BigInt(nciRaw.trim());
  if (nci < 0n || nci > (1n << 36n) - 1n) {
    throw new Error(`Invalid 36-bit NR NCI "${String(nciRaw)}"`);
  }
  const sectorBits = BigInt(36 - gNodeBBitLength);
  const sectorMask = (1n << sectorBits) - 1n;
  return {
    nci,
    gNodeBId: nci >> sectorBits,
    sectorId: Number(nci & sectorMask),
  };
}
