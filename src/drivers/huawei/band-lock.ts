import {
  type BandInput,
  bandsToHexMask,
  parseSupportedLteBand,
  parseSupportedNrBand,
  validateArfcnInBand,
  validatePci,
} from "../../rf-bounds.ts";
import { buildXmlRequest } from "../../protocols/hilink/xml.ts";

export const HUAWEI_LTE_ALL_BANDS_MASK = "7fffffffffffffff";
export const HUAWEI_NETWORK_ALL_BANDS_MASK = "3fffffff";

export const NETWORK_MODE_AUTO = "00";
export const NETWORK_MODE_4G_ONLY = "03";
export const NETWORK_MODE_5G_ONLY = "08";

export type HuaweiNetworkModeCode =
  | typeof NETWORK_MODE_AUTO
  | typeof NETWORK_MODE_4G_ONLY
  | typeof NETWORK_MODE_5G_ONLY;

/**
 * The network mode a band lock writes along with the LTE mask on the H168-383: its `net-mode` takes a
 * write only with the mode's own field, `networkOption` with `00` (1 SA only, 0 NSA only, 2 SA and NSA)
 * or `LTEBandOption` with `03` (0 4G only, 2 TDD only, 1 FDD only); with it the lock keeps the mode
 * (both checked on the router, 2026-11-13). `DEFAULT_NET_MODE_KEEP`, 00 with networkOption 2, is the
 * request the H168-383 was verified with, byte for byte.
 */
export type NetModeKeep = { networkMode: "00"; networkOption: "0" | "1" | "2" } | { networkMode: "03"; lteBandOption: "0" | "1" | "2" };

export const DEFAULT_NET_MODE_KEEP: NetModeKeep = { networkMode: "00", networkOption: "2" };

export const LOCK_MODE_UNLOCK = 0;
export const LOCK_MODE_FREQ = 1;
export const LOCK_MODE_CELL = 2;
export const LOCK_MODE_BAND = 3;

export type HuaweiLockMode =
  | typeof LOCK_MODE_UNLOCK
  | typeof LOCK_MODE_FREQ
  | typeof LOCK_MODE_CELL
  | typeof LOCK_MODE_BAND;

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
 * Build XML payload for `POST /api/net/net-mode` to lock 4G LTE bands or restore all LTE bands.
 */
export function buildLteBandNetModeXml(
  lteBands: ReadonlyArray<BandInput> | "all",
  keep: NetModeKeep = DEFAULT_NET_MODE_KEEP
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
    NetworkMode: keep.networkMode,
    NetworkBand: HUAWEI_NETWORK_ALL_BANDS_MASK,
    LTEBand: lteMask,
    ...(keep.networkMode === "00" ? { networkOption: Number(keep.networkOption) } : { LTEBandOption: Number(keep.lteBandOption) }),
  });
}

/**
 * Build XML payload for `POST /api/net/lock-freq` (`lock_mode=3`) to lock 5G NR bands on H168-383.
 */
export function buildNrBandLockXml(nrBands: ReadonlyArray<BandInput>): string {
  if (nrBands.length === 0) {
    throw new Error("At least one 5G NR band is required");
  }
  const uniqueSorted = [...new Set(nrBands.map(parseSupportedNrBand))].sort((a, b) => a - b);
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
    freqInfo["pci"] = validatePci("LTE", params.pci!);
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
  const band = parseSupportedNrBand(params.band);
  const freq = validateArfcnInBand("NR", band, params.nrArfcn);
  const hasPci = params.pci !== undefined;
  const freqInfo: Record<string, number> = { band, freq };
  if (hasPci) {
    freqInfo["pci"] = validatePci("NR", params.pci!);
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
