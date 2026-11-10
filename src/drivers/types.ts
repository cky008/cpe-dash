import type { WriteCheck } from "../device-access.ts";
import type { DriverFamily } from "../router-family.ts";

/**
 * What every driver of a non-Huawei router family hands back, in one shape: FengSui turns it into
 * the same snapshots the HiLink stack produces (`src/drivers/snapshot.ts`), so the console, the
 * alerts, the history and the MCP tools need nothing per family. A field the router does not report
 * is `null`, never a made-up zero.
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
}

export interface DriverIdentity {
  model: string | null;
  softwareVersion: string | null;
  hardwareVersion: string | null;
}

export interface DriverTelemetry extends DriverIdentity {
  operatorName: string | null;
  /** MCC + MNC digits. */
  plmn: string | null;
  mode: ServingMode | null;
  /** The LTE serving cell (or the 4G anchor of EN-DC). */
  lte: DriverCell | null;
  /** The NR serving cell (SA) or the NR leg of EN-DC. */
  nr: DriverCell | null;
  carriers: DriverCarrier[];
  wan: { connected: boolean | null; ipv4: string | null; ipv6: string | null; uptimeSec: number | null };
  /** `null`: the router has no traffic counters FengSui reads. */
  traffic: DriverTraffic | null;
  temperatureC: number | null;
  signalBars: number | null;
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
export type CellLockState = { locked: false } | { locked: true; arfcn: number | null; pci: number | null; band: number | null };

/** The network modes a band lock may switch to (each family offers some, `ROUTER_FAMILY_FACTS`). */
export type DriverNetworkMode = "auto" | "lte" | "nr_sa" | "nr_nsa";

/** Locks and mode as the router reads them back; `null` where it did not say. */
export interface DriverLockState {
  /** `all`: no band lock (every band the router supports). */
  lteBands: number[] | "all" | null;
  nrBands: number[] | "all" | null;
  lteCell: CellLockState | null;
  nrCell: CellLockState | null;
  networkMode: DriverNetworkMode | null;
  /** Bands the router offers, when it names them. */
  supportedLte: number[] | null;
  supportedNr: number[] | null;
}

export interface DriverBandLockTarget {
  lte: number[] | "all";
  /** `null`: leave the NR bands as they are. */
  nr: number[] | "all" | null;
  /** `null`: leave the network mode as it is. */
  networkMode: DriverNetworkMode | null;
}

export type SubcarrierSpacingKhz = 15 | 30 | 60 | 120 | 240;

export interface DriverCellLockTarget {
  rat: DriverRat;
  band: number;
  arfcn: number;
  pci: number;
  /** NR only: the subcarrier spacing some routers need (`null` on LTE). */
  scsKhz: SubcarrierSpacingKhz | null;
}

/**
 * One logged-in session on a router of a driver family. Every request goes out inside it; the
 * client logs out in `finally`. A write names what it sent in `check.endpoints` (command names,
 * never values) before it sends it.
 */
export interface DriverSession {
  readonly family: DriverFamily;
  /** `false` once the session is over: nothing goes out any more. */
  readonly open: boolean;
  identify(): Promise<DriverIdentity>;
  telemetry(): Promise<DriverTelemetry>;
  /** Nearby cells; a family without a documented read throws `SectionUnavailableError`. */
  neighbours(): Promise<DriverNeighbour[]>;
  lockState(): Promise<DriverLockState>;
  setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void>;
  setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void>;
  /** Clear band and cell locks (and go back to the automatic network mode). */
  unlockAll(check: WriteCheck): Promise<void>;
  reboot(check: WriteCheck): Promise<void>;
}

/** A session as a family's protocol opens it: the client calls `logout` in `finally`. */
export interface DriverSessionHandle extends DriverSession {
  logout(): Promise<void>;
}
