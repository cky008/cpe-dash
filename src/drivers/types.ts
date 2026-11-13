import type { ApnChoice, ApnRestore, ApnView, DataLimitSetting, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, SimSlotRef, UssdAnswer, UssdRequest } from "../cellular.ts";
import type { AntennaModeName } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import type { WcdmaSignal } from "../parsers.ts";
import type { DriverFamily } from "../router-family.ts";
import type { RouterStatusSnapshot, TemperatureSensor } from "../router-status.ts";
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
  /** The hottest temperature the router reports. */
  temperatureC: number | null;
  signalBars: number | null;
  /** Each temperature sensor the router names apart (`temperatureC` stays the hottest). */
  temperatures?: TemperatureSensor[];
  /** What the router reports of its battery, SIM card, radio, roaming and own load (the rest stays `null`). */
  status?: Partial<RouterStatusSnapshot>;
  /** The device's and the SIM card's identifiers, where the router names them (masked for API clients). */
  ids?: Partial<Record<"imei" | "imsi" | "msisdn" | "iccid", string | null>>;
  /** The 3G serving cell, when the router is on 3G. */
  wcdma?: WcdmaSignal | null;
  rrcConnected?: boolean | null;
  qci?: number | null;
  /** Uplink MIMO layers of the primary carrier. */
  ulMimoLayers?: number | null;
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

/** A lock on a channel alone: the router picks the cell on it. */
export type DriverFrequencyLockTarget = Omit<DriverCellLockTarget, "pci">;

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

/** A device the router lists as connected to it, as its own interface names it. */
export interface DriverHost {
  /** As the router writes it; checked and normalised when the snapshot is made. */
  mac: string;
  name: string | null;
  ipv4: string | null;
  ipv6: string[];
  /** `lan` wired, `wifi` (band not said), `wifi_2_4` / `wifi_5`; `null`: the router does not say. */
  link: "lan" | "wifi" | "wifi_2_4" | "wifi_5" | null;
  /** How long it has been connected, in seconds (`null`: not said). */
  connectedSec: number | null;
  /** How long its DHCP lease has left, in seconds (`null`: not said). */
  leaseSec: number | null;
  rssiDbm: number | null;
}

/** Waiting inside a write's session (injected so tests need not wait). */
export interface DriverWait {
  sleep: (ms: number) => Promise<void>;
}

/**
 * The router's cellular data connection, where its interface can switch it: each write is sent once,
 * names what it sent in `check.endpoints` and reads the result back where the router can say.
 */
export interface DriverDataLink {
  /** Whether mobile data is switched on; `null`: the router reports its connection only, no switch to read. */
  enabled(): Promise<boolean | null>;
  /**
   * Switch mobile data on or off. Switching it off waits (bounded) until the router reports the
   * connection down, so a connect sent right after it does not land in the middle of the disconnect.
   */
  set(enabled: boolean, check: WriteCheck, wait: DriverWait): Promise<void>;
  /** The router's own redial command; left out, a redial is off, then on (`DriverRouterSession`). */
  redial?(check: WriteCheck): Promise<void>;
}

/** What a router reports of its cellular settings; a part its interface has no read for is left out. */
export interface DriverCellularState {
  /** The network mode in use (`null`: read, but not one FengSui names). */
  networkMode?: NetworkMode | null;
  /** The modes this router can be set to, where it differs from the family's own list. */
  networkModes?: NetworkMode[];
  /** The SIM slots the router can switch between. */
  simSlots?: SimSlotRef[];
  /** The slot in use, as this read saw it (the poll reports it as well). */
  simSlot?: SimSlotRef | null;
  operator?: { selection: "auto" | "manual" | null; plmn: string | null } | null;
  apn?: ApnView | null;
  /** How the access point in use is switched back to (`null`: nothing FengSui could put back). */
  apnRestore?: ApnRestore | null;
  dataLimit?: { enabled: boolean | null; bytes: number | null; alertPercent: number | null } | null;
  /** Attempts the SIM card has left for its PIN, read right now (`null`: the router does not say). */
  pinAttemptsLeft?: number | null;
}

/**
 * The cellular settings of a router of a driver family, inside the session that hands it out. A write
 * the family's interface has no way to do is left out; one that is there is sent once, names what it
 * sent in `check.endpoints` (command names, never a value) and reads the result back where the
 * router can say.
 */
export interface DriverCellular {
  read(): Promise<DriverCellularState>;
  setNetworkMode?(mode: NetworkMode, check: WriteCheck): Promise<void>;
  setSimSlot?(slot: SimSlotRef, check: WriteCheck): Promise<void>;
  /** `true`: the cellular radio goes off (the router stays reachable on the LAN). */
  setAirplaneMode?(enabled: boolean, check: WriteCheck): Promise<void>;
  /** Whether data may be used while roaming. */
  setRoaming?(enabled: boolean, check: WriteCheck): Promise<void>;
  setApn?(choice: ApnChoice, check: WriteCheck, wait: DriverWait): Promise<void>;
  /** Switch back to the access point a change replaced. */
  restoreApn?(restore: ApnRestore, check: WriteCheck, wait: DriverWait): Promise<void>;
  /** Search for networks (up to a minute; many routers drop the connection meanwhile). */
  scanOperators?(check: WriteCheck, wait: DriverWait): Promise<OperatorChoice[]>;
  selectOperator?(selection: OperatorSelection, check: WriteCheck, wait: DriverWait): Promise<void>;
  /** Enter the card's PIN, once. A wrong PIN resolves `accepted: false`: nothing is sent again. */
  enterPin?(pin: string, check: WriteCheck): Promise<SimPinOutcome>;
  /** Turn "ask for the PIN at every start" on or off with the card's PIN, once. */
  setPinLock?(enabled: boolean, pin: string, check: WriteCheck): Promise<SimPinOutcome>;
  setDataLimit?(limit: DataLimitSetting, check: WriteCheck): Promise<void>;
  /** Clear the router's own traffic counters. */
  resetTraffic?(check: WriteCheck): Promise<void>;
  ussd?(request: UssdRequest, check: WriteCheck, wait: DriverWait): Promise<UssdAnswer>;
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
  /**
   * Lock several candidate cells of one RAT at once (the router picks among them), on a family whose
   * notes define it; a model or module of the family that cannot throws before sending anything.
   */
  setCellLocks?(targets: ReadonlyArray<DriverCellLockTarget>, check: WriteCheck): Promise<void>;
  /** Lock a channel without naming a cell, on a family whose notes define it. */
  setFrequencyLock?(target: DriverFrequencyLockTarget, check: WriteCheck): Promise<void>;
  /** Clear band and cell locks (and go back to the automatic network mode). */
  unlockAll(check: WriteCheck): Promise<void>;
  reboot(check: WriteCheck): Promise<void>;
  /** SMS, on a family whose notes define an SMS interface. */
  readonly sms?: DriverSms;
  /** The cellular data connection, on a family whose notes define a way to switch it. */
  readonly data?: DriverDataLink;
  /** The devices connected to the router, on a family whose notes define a device list. */
  hosts?(): Promise<DriverHost[]>;
  /** Switch the antenna (automatic, internal, external, both), on a family whose notes define it; resolves the code it wrote. */
  setAntennaMode?(mode: AntennaModeName, check: WriteCheck): Promise<number>;
  /** The cellular settings (network mode, SIM slot, PIN, airplane mode, roaming, APN, operator, data limit, USSD) the family's notes define. */
  readonly cellular?: DriverCellular;
}

/** A session as a family's protocol opens it: the client calls `logout` in `finally`. */
export interface DriverSessionHandle extends DriverSession {
  logout(): Promise<void>;
}
