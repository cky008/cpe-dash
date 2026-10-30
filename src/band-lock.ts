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
 * Downlink NR-ARFCN range per FR1 band (3GPP TS 38.101-1, Table 5.4.2.3-1) for the bands deployed
 * in this CPE's market. The router does not advertise its NR band list, so this bounds requests to
 * real 3GPP bands; it is not a verified hardware capability list.
 */
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
  75: [286400, 303400],
  76: [285400, 286400],
  77: [620000, 680000],
  78: [620000, 653333],
  79: [693334, 733333],
};

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

/** Parse an NR band and require it to be in the 3GPP FR1 table above. */
export function parseKnownNrBand(input: BandInput): number {
  const band = parseBandNumber(input);
  if (NR_DL_ARFCN_RANGES[band] === undefined) {
    throw new Error(
      `N${band} is not a known 3GPP NR band for this CPE (known: ${Object.keys(NR_DL_ARFCN_RANGES).map((b) => `N${b}`).join(", ")})`
    );
  }
  return band;
}

function validateArfcnInBand(rat: "LTE" | "NR", band: number, arfcn: number): number {
  const range = rat === "LTE" ? LTE_DL_EARFCN_RANGES[band] : NR_DL_ARFCN_RANGES[band];
  const label = rat === "LTE" ? `B${band} (3GPP DL EARFCN` : `N${band} (3GPP DL NR-ARFCN`;
  if (!Number.isInteger(arfcn) || range === undefined || arfcn < range[0] || arfcn > range[1]) {
    const bounds = range ? ` ${range[0]}..${range[1]})` : ")";
    throw new Error(`Invalid ARFCN ${arfcn} for ${label}${bounds}`);
  }
  return arfcn;
}

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
    lteMask = bandsToHexMask(lteBands.map(parseSupportedLteBand));
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
  const uniqueSorted = [...new Set(nrBands.map(parseKnownNrBand))].sort((a, b) => a - b);
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
  const band = parseSupportedLteBand(params.band);
  const freq = validateArfcnInBand("LTE", band, params.earfcn);
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
  const band = parseKnownNrBand(params.band);
  const freq = validateArfcnInBand("NR", band, params.nrArfcn);
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
