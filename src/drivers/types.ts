import type { WriteCheck } from "../device-access.ts";
import type { DriverFamily } from "../router-family.ts";
import type { SmsCounters, SmsWireMessage } from "../sms/types.ts";

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
  /**
   * The form of the family's interface the router speaks, where the family has more than one; left
   * out: the family's own. The gate goes by it where `ROUTER_FAMILY_FACTS[family].variants` records
   * its facts; another one is only said in the device report.
   */
  variant?: string;
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

/** How one send to one recipient ended. */
export interface DriverSmsSendOutcome {
  /**
   * `sent`: the router says it went out; `failed`: the router refused it or says it did not go out;
   * `unconfirmed`: the router took it and has not said (never sent again).
   */
  state: "sent" | "failed" | "unconfirmed";
  /** The router's code for a failure, when it gives one that may be kept. */
  code: string | null;
}

export interface DriverSmsSendOptions {
  /** How long the router is asked whether the message went out. */
  statusTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Called once the router took the message: from then on it is on its way. */
  onAccepted: () => void;
}

/**
 * SMS on a router of a driver family, inside the session that hands it out. A message is the same
 * `SmsWireMessage` the HiLink stack produces: `index` is the handle the router's own interface names
 * it by (always above zero), `date` is `yyyy-MM-dd HH:mm:ss`, `smstat` is `0` unread, `1` read, `3`
 * sent. A write the family's interface has no way to do is left out; one that is there is sent once
 * and names what it sent in `check.endpoints`.
 */
export interface DriverSms {
  /** Every message the router stores, long ones already joined. */
  list(): Promise<SmsWireMessage[]>;
  /** The counts the 5 s poll carries; `listed` spares a family that counts by listing a second listing. */
  counters(listed?: ReadonlyArray<SmsWireMessage>): Promise<SmsCounters>;
  /**
   * Whether this router offers the send the family's interface has (`send` needs a helper this
   * router may lack). Left out: it does wherever `send` is there. Asked in a listing's session.
   */
  canSend?(): Promise<boolean>;
  /** What one delete takes: a message (the default) or the whole conversation it is in. */
  readonly deleteScope?: "message" | "conversation";
  /** Send `content` to one recipient (already checked: a dialable number, text within the segment limit). */
  send?(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome>;
  markRead?(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void>;
  delete?(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void>;
  /** `false`: the router keeps no copy of what it sends. */
  readonly keepsSent: boolean;
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
  /** SMS, on a family whose notes define an SMS interface. */
  readonly sms?: DriverSms;
}

/** A session as a family's protocol opens it: the client calls `logout` in `finally`. */
export interface DriverSessionHandle extends DriverSession {
  logout(): Promise<void>;
}
