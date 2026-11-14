/**
 * The shapes of what a router's interface reports about the radio, in the one vocabulary every
 * driver and every protocol part reads into: a cell, a carrier, a neighbour, the traffic counters,
 * a cell lock as it is read back, the names of the network modes. A field the router does not
 * report is `null`, never a made-up zero. What a driver's session hands back as a whole (its
 * telemetry, its lock state, the session's contract) is in `src/drivers/types.ts`.
 */

export type DriverRat = "LTE" | "NR";

/** How the router is attached: 4G, 5G next to a 4G anchor (EN-DC), 5G standalone, 3G, or nothing. */
export type ServingMode = "LTE" | "NSA" | "SA" | "WCDMA" | "NONE";

export interface DriverCell {
  band: number | null;
  arfcn: number | null;
  pci: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  sinrDb: number | null;
  rssiDbm: number | null;
  bandwidthMhz: number | null;
  /** The cell identity as decimal digits (ECI / NCI), `null` when the router names none. */
  cellId: string | null;
  /** The tracking area code as decimal digits. */
  tac: string | null;
  cqi: number | null;
  mimoLayers: number | null;
  dlMcs: number | null;
  ulMcs: number | null;
  /** RSRP per receive antenna (up to four), when the router reports them. */
  rxRsrpDbm: Array<number | null> | null;
  /** The second codeword's CQI, where the router reports it. */
  cqi1?: number | null;
  ulBandwidthMhz?: number | null;
  /** Uplink transmit power on PUSCH / PUCCH, dBm. */
  puschTxDbm?: number | null;
  pucchTxDbm?: number | null;
  /** The LTE downlink transmission mode as the console shows it (`TM4`). */
  transmissionMode?: string | null;
}

/** A secondary carrier (carrier aggregation, or the NR leg's own aggregation). */
export interface DriverCarrier {
  rat: DriverRat;
  band: number | null;
  arfcn: number | null;
  pci: number | null;
  bandwidthMhz: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  rssiDbm: number | null;
  sinrDb: number | null;
}

/** Traffic counters; a router without one leaves it `null`. */
export interface DriverTraffic {
  downloadBytesPerSec: number | null;
  uploadBytesPerSec: number | null;
  /** Running byte counters a rate is derived from when the router reports no rate (`CounterRates`). */
  totalDownloadBytes: bigint | null;
  totalUploadBytes: bigint | null;
  sessionDownloadBytes: bigint | null;
  sessionUploadBytes: bigint | null;
  sessionSeconds: number | null;
  monthDownloadBytes: bigint | null;
  monthUploadBytes: bigint | null;
  /** Some routers count one monthly total only. */
  monthTotalBytes: bigint | null;
  monthSeconds: number | null;
  /**
   * Which of the router's counters the running totals come from, where it keeps more than one (a
   * module counts 4G and 5G apart): a rate is never taken across two of them.
   */
  counterSource?: string;
  /** Today's traffic, both ways, where the router counts it. */
  todayBytes?: bigint | null;
  /** The monthly data plan set on the router, and the share of it at which the router warns. */
  dataLimitBytes?: bigint | null;
  dataAlertPercent?: number | null;
}

export interface DriverNeighbour {
  rat: DriverRat;
  band: number | null;
  arfcn: number | null;
  pci: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  rssiDbm: number | null;
  sinrDb: number | null;
}

/** A cell lock as the router reads it back. */
export type CellLockState =
  | { locked: false }
  | {
      locked: true;
      arfcn: number | null;
      pci: number | null;
      band: number | null;
      /** Further cells the router reports locked with this one (a lock on several candidates). */
      others?: ReadonlyArray<{ arfcn: number | null; pci: number | null }>;
    };

/** The network modes a band lock may switch to (each family offers some, `ROUTER_FAMILY_FACTS`). */
export type DriverNetworkMode = "auto" | "lte" | "nr_sa" | "nr_nsa";

export type SubcarrierSpacingKhz = 15 | 30 | 60 | 120 | 240;

/** An empty cell, for drivers to fill in. */
export function emptyCell(): DriverCell {
  return { band: null, arfcn: null, pci: null, rsrpDbm: null, rsrqDb: null, sinrDb: null, rssiDbm: null, bandwidthMhz: null, cellId: null, tac: null, cqi: null, mimoLayers: null, dlMcs: null, ulMcs: null, rxRsrpDbm: null };
}
