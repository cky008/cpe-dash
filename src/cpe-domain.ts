import net from "node:net";
import { CpeControlValidationError } from "./control-error.ts";
import { type BandInput, H168_383_LTE_BANDS, parseBandNumber } from "./rf-bounds.ts";
import type { RouterStatusSnapshot, TemperatureSensor } from "./router-status.ts";
import { CpeAnswerFormatError, CpeApiError, CpeEncryptionUnavailableError } from "./session-errors.ts";
import type { SmsCounters } from "./sms/types.ts";

export { CpeControlValidationError } from "./control-error.ts";

/**
 * What a router is to FengSui, whatever its brand: the shapes its readings are turned into (telemetry,
 * RF and carriers, neighbour cells, connected devices, router settings), the lock commands and the
 * lock state, and what is judged from them alone (whether a lock still holds, whether a cell was seen,
 * whether a read failed because this model has no such thing). Nothing here sends a request: a
 * brand's requests are its driver's (`src/drivers/`).
 */

export interface CaBannerComponent {
  bandwidthMhz: number;
  arfcn: number;
  band: string;
  rat: "LTE" | "NR";
}

export interface McsCodewordMetric {
  label: string;
  index: number;
  modulation: string | null;
}

export interface TxPowerMetrics {
  puschDbm: number | null;
  pucchDbm: number | null;
  srsDbm: number | null;
  prachDbm: number | null;
}

export interface SecondaryCellEntry {
  rat: "LTE" | "NR";
  arfcn: number | null;
  band: string;
  bandwidthMhz: number | null;
  pci: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  rssiDbm: number | null;
  sinrDb: number | null;
}

export interface NeighborCellEntry {
  rat: "LTE" | "NR";
  arfcn: number | null;
  band: string;
  pci: number | null;
  rsrpDbm: number | null;
  rsrqDb: number | null;
  rssiDbm: number | null;
  sinrDb: number | null;
}

export interface CellIdentityVerification {
  hasCellIdDecimal: boolean;
  hasCellInfoHex: boolean;
  eciDecimalMatchesHex: boolean | null;
  tacDecimalMatchesHex: boolean | null;
  eNodeBDerivationMatchesTag: boolean | null;
  sectorIdBitWidthOk: boolean | null;
}

/** A 3G (WCDMA) serving cell's readings (3GPP TS 25.215): RSCP, Ec/Io and the primary scrambling code. */
export interface WcdmaSignal {
  rscpDbm: number | null;
  ecioDb: number | null;
  psc: number | null;
}

export interface RfSignalSnapshot {
  operatorName: string;
  plmnNumeric: string;
  ratCode: string;
  caBannerRaw: string;
  caCarriers: CaBannerComponent[];
  caActive: boolean;
  caComponentCount: number;
  totalAggregatedBandwidthMhz: number;
  pccBand: string;
  pci: number | null;
  earfcnRaw: string;
  nrArfcnRaw: string;
  lteUlBandwidthMhz: number | null;
  lteDlBandwidthMhz: number | null;
  nrUlBandwidthMhz: number | null;
  nrDlBandwidthMhz: number | null;
  lteRsrpDbm: number | null;
  lteRsrqDb: number | null;
  lteRssiDbm: number | null;
  lteSinrDb: number | null;
  nrRsrpDbm: number | null;
  nrRsrqDb: number | null;
  nrSinrDb: number | null;
  transmissionMode: string;
  lteMimoRank: number | null;
  nrMimoRank: number | null;
  lteCqi0: number | null;
  lteCqi1: number | null;
  nrCqi0: number | null;
  nrCqi1: number | null;
  lteUlMcs: McsCodewordMetric[];
  lteDlMcs: McsCodewordMetric[];
  nrUlMcs: McsCodewordMetric[];
  nrDlMcs: McsCodewordMetric[];
  lteTxPower: TxPowerMetrics;
  nrTxPower: TxPowerMetrics;
  lteScc: SecondaryCellEntry[];
  nrScc: SecondaryCellEntry[];
  cellIdDisplay: string;
  eNodeBDisplay: string;
  tacDisplay: string;
  identityVerification: CellIdentityVerification;
  /** The 3G serving cell, when the router is on 3G and reports it (`null` otherwise). */
  wcdma: WcdmaSignal | null;
  /** The radio connection is active (RRC connected) rather than idle; `null`: not reported. */
  rrcConnected: boolean | null;
  /** The QoS class (QCI / 5QI) of the default bearer, where the router reports it. */
  qci: number | null;
  /** Uplink MIMO layers of the primary carrier, where the router reports them. */
  ulMimoLayers: number | null;
}

export type TerminalAccessMedium =
  | "LAN_1000M"
  | "LAN_100M"
  | "LAN_OTHER"
  | "WIFI_2_4G"
  | "WIFI_5G"
  | "WIFI_OTHER"
  /** The router lists the device without saying whether it is wired or on Wi-Fi (a DHCP lease). */
  | "UNKNOWN";

export interface TerminalHostEntry {
  macAddress: string;
  displayName: string;
  active: boolean;
  interfaceType: string;
  layer2Interface: string;
  frequency: string;
  medium: TerminalAccessMedium;
  negotiatedRateMbps: number | null;
  rssi: number | null;
  ipv4Address: string;
  ipv6Addresses: string[];
  ipv6Active: boolean;
  addressSource: string;
  leaseTimeRemainingSec: number | null;
  associatedTimeSec: number | null;
  /** `IsLocalDevice`: the router's mark for the client that requested HostInfo (FengSui's host). */
  isLocalDevice: boolean;
}

export interface TopologySummary {
  topLevelNodes: number;
  totalActiveNodes: number;
  meshChildNodes: number;
  ethernetNodes: number;
  wirelessNodes: number;
}

export interface DeviceIdentitySnapshot {
  deviceName: string;
  marketingName: string;
  hardwareVersion: string;
  softwareVersion: string;
  webUiVersion: string;
  uptimeSec: number;
  workMode: string;
  wanIpv4: string;
  wanDnsV4: string[];
  wanIpv6: string;
  wanDnsV6: string[];
  connectionStatus: string;
  signalIconBars: number;
  simStatus: string;
  /** `<Imei>` of `/api/device/information`; `""` when the firmware omits it. */
  imei: string;
  /** `<Imsi>`; `""` when absent. */
  imsi: string;
  /** The SIM's own number (`<Msisdn>`); most SIMs leave it empty. */
  msisdn: string;
  /** `<WanMacAddress>`, else `<MacAddress1>`; `""` when absent. */
  macAddress: string;
  /** The SIM card's ICCID (`<Iccid>`); `""` when the router names none. */
  iccid: string;
  /**
   * `true` only on the copies REDACT_SENSITIVE_IN_API hands to Bearer API / SSE clients and MCP
   * (src/redact.ts), where the identifiers above, the WAN addresses and DNS servers are masked.
   * The daemon's own snapshot, and what the web console receives, always carry the plain values.
   */
  sensitiveRedacted: boolean;
}

export interface BandConfigSnapshot {
  networkMode: string;
  networkBandHex: string;
  lteBandHex: string;
  activeLteBands: number[];
  /**
   * The field a 5G HiLink router's `net-mode` names its mode by, as it reported them (the H168-383:
   * `networkOption` with `00`, `LTEBandOption` with `03`); left out where it reports none. The band
   * lock writes the mode along with them (`NetModeKeep`).
   */
  networkOption?: string;
  lteBandOption?: string;
}

export interface TrafficTelemetryDto {
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
  downloadBps: number;
  uploadBps: number;
  downloadRateFormatted: string;
  uploadRateFormatted: string;
  todayUsedBytes: number;
  todayUsedBytesStr: string;
  todayUsedFormatted: string;
  todayDurationSec: number;
  monthDownloadBytes: number;
  monthDownloadBytesStr: string;
  monthUploadBytes: number;
  monthUploadBytesStr: string;
  monthTotalBytes: number;
  monthTotalBytesStr: string;
  monthTotalFormatted: string;
  monthDurationSec: number;
  monthLastClearDate: string;
  sessionConnectTimeSec: number;
  sessionDownloadBytesStr: string;
  sessionUploadBytesStr: string;
  totalUsedBytesStr: string;
  totalConnectTimeSec: number;
  billingStartDay: number | null;
  dataLimitRaw: string;
  monthThresholdPercent: number | null;
}

export interface ThermalSnapshot {
  /** The hottest sensor the router reports. */
  temperatureCelsius: number | null;
  temperatureSupported: boolean;
  /** Each sensor the router names apart (empty: it reports one value, or none). */
  sensors: TemperatureSensor[];
}

/**
 * Parts of a telemetry poll that a model nobody verified may lack (`unavailable`). `uptime`: the router
 * reports no uptime of its own (some other brands), so `device.uptimeSec` holds no reading.
 */
export type TelemetryPart = "signal" | "status" | "traffic" | "month" | "uptime";
export interface GlobalTelemetrySnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  /**
   * Only on a model nobody verified (read the tolerant way): the parts this poll's router answered
   * with an error code. Their fields hold no data then (zeros, empty), so show them as not
   * available, never as measured. Absent on the H168-383, which must answer every part.
   */
  unavailable?: TelemetryPart[];
  device: DeviceIdentitySnapshot;
  rf: RfSignalSnapshot;
  bandConfig: BandConfigSnapshot;
  traffic: TrafficTelemetryDto;
  thermal: ThermalSnapshot;
  /** `GET /api/sms/sms-count` piggybacked on the telemetry session; `null` when SMS is disabled or unavailable. */
  sms: SmsCounters | null;
  /** Battery, SIM card, airplane mode, roaming, the router's own load (`src/router-status.ts`); `null`: it reports none of it. */
  status: RouterStatusSnapshot | null;
}

export interface NeighborScanSnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  lteNeighbors: NeighborCellEntry[];
  nrNeighbors: NeighborCellEntry[];
  totalCount: number;
}

/** Where a model nobody verified listed its devices when `system/HostInfo` gave nothing (appendix A.10). */
export type HostListSource = "lan/HostInfo" | "wlan/host-list";

export interface TerminalTopologySnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  /** Only when the list came from another endpoint than the H168-383's; `wlan/host-list` holds Wi-Fi clients only. */
  source?: HostListSource;
  hosts: TerminalHostEntry[];
  summary: TopologySummary;
  countsByMedium: Record<TerminalAccessMedium, number>;
}

/** `hybrid` (internal and external together) is a mode of some other brands' routers; the H168-383 has the first three. */
export type AntennaModeName = "auto" | "internal" | "external" | "hybrid";

export interface FirewallSwitchState {
  mainSwitch: boolean;
  ipFilterSwitch: boolean;
  wanPortPingSwitch: boolean;
  macFilterSwitch: boolean;
  urlFilterSwitch: boolean;
}

export interface RouterSettingsSnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  upnpEnabled: boolean;
  dmzEnabled: boolean;
  dmzIpAddress: string;
  firewall: FirewallSwitchState;
  natType: number;
  bridgeModeEnabled: boolean;
  wifi7: {
    mloEnable: boolean;
    dbhoEnable: boolean;
  };
  antenna: {
    mode: AntennaModeName;
    rawCode: string;
    antenna1Inserted: boolean;
    antenna2Inserted: boolean;
  };
  mobileDataEnabled: boolean;
}

export interface PersistedLockState {
  mode: "unlocked" | "band_lock" | "cell_lock";
  updatedAtIso: string;
  lteBands: number[] | "all";
  nrBands: number[];
  cellLock: {
    rat: "LTE" | "NR";
    band: number;
    arfcn: number;
    pci: number | null;
    /** Further candidate cells locked with it (same RAT), on a router that locks several at once. */
    more?: Array<{ band: number; arfcn: number; pci: number }>;
  } | null;
}

export interface BandLockCommand {
  lteBands?: ReadonlyArray<BandInput> | "all";
  nrBands?: ReadonlyArray<BandInput> | "all";
  /**
   * The mode a driver brand switches to along with the lock (REST and MCP never send it). A Huawei
   * band lock keeps the mode the router is in instead (`NetModeKeep`).
   */
  networkMode?: "00" | "03" | "08";
}

export interface CellLockCommand {
  rat: "LTE" | "NR";
  band: BandInput;
  arfcn: number;
  pci?: number;
  /**
   * Further candidate cells of the same RAT, each with its PCI: the router picks among them. Only a
   * router whose interface locks several cells at once takes them; every other one refuses them before
   * anything is queued.
   */
  more?: ReadonlyArray<CellLockCandidate>;
}

/** One more cell a lock may name. */
export interface CellLockCandidate {
  band: BandInput;
  arfcn: number;
  pci: number;
}

export interface SecurityUpdateCommand {
  upnpEnabled?: boolean;
  dmz?: {
    enabled: boolean;
    ipAddress?: string;
  };
  firewall?: Partial<FirewallSwitchState>;
}

/** A read section this router does not provide (a tolerant read on a model nobody verified). */
export class SectionUnavailableError extends Error {
  /** The router's error code; `null` when it answered something FengSui could not read. */
  readonly code: string | null;

  constructor(what: string, code: string | null) {
    super(`${what} is not available on this router${code ? ` (${code})` : ""}`);
    this.name = "SectionUnavailableError";
    this.code = code;
  }
}

/** Error codes that say an endpoint is not there for FengSui (as in the identification probe). */
export const NOT_HERE_CODES: ReadonlySet<string> = new Set(["100002", "100003"]);

/**
 * Whether a tolerant read failed because this model does not provide the section: the router's code
 * (`null`: an answer FengSui's parser refused, or no encrypted channel), or `undefined` for anything
 * that may pass (transport, deadline, session, another code), which fails the session as before.
 */
export function sectionUnavailableCode(err: unknown): string | null | undefined {
  if (err instanceof SectionUnavailableError) return err.code;
  if (err instanceof CpeApiError) return NOT_HERE_CODES.has(err.code) ? err.code : undefined;
  if (err instanceof CpeAnswerFormatError || err instanceof CpeEncryptionUnavailableError) return null;
  return undefined;
}

export function topologySnapshot(hosts: TerminalHostEntry[], summary: TopologySummary): TerminalTopologySnapshot {
  const countsByMedium: Record<TerminalAccessMedium, number> = {
    LAN_1000M: 0,
    LAN_100M: 0,
    LAN_OTHER: 0,
    WIFI_2_4G: 0,
    WIFI_5G: 0,
    WIFI_OTHER: 0,
    UNKNOWN: 0,
  };
  for (const h of hosts) {
    if (h.active) {
      countsByMedium[h.medium] += 1;
    }
  }

  const nowMs = Date.now();
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    hosts,
    summary,
    countsByMedium,
  };
}

interface ObservedCell {
  rat: "LTE" | "NR";
  band: number | null;
  arfcn: number | null;
  pci: number | null;
}

function bandOrNull(label: string): number | null {
  try {
    return parseBandNumber(label);
  } catch {
    return null;
  }
}

/**
 * Whether a cell (PCI given) or frequency (no PCI) lock targets something the modem has actually
 * reported: the serving cell, an aggregated carrier, a secondary cell or an entry of the latest
 * neighbour scan. Lets agent-facing adapters refuse locks onto invented PCI/ARFCN combinations.
 */
export function isObservedCellTarget(
  command: CellLockCommand,
  telemetry: GlobalTelemetrySnapshot | null,
  neighbors: NeighborScanSnapshot | null
): boolean {
  const band = bandOrNull(String(command.band));
  const observed: ObservedCell[] = [];
  if (telemetry) {
    const rf = telemetry.rf;
    // The CA banner lists the primary cell first, which covers firmware that omits <earfcn>
    const dlEarfcn = /DL:(\d+)/.exec(rf.earfcnRaw)?.[1];
    const pccCarrier = rf.caCarriers.find((carrier) => carrier.rat === "LTE");
    observed.push({
      rat: "LTE",
      band: bandOrNull(rf.pccBand),
      arfcn: dlEarfcn ? Number(dlEarfcn) : (pccCarrier?.arfcn ?? null),
      pci: rf.pci,
    });
    for (const carrier of rf.caCarriers) {
      observed.push({ rat: carrier.rat, band: bandOrNull(carrier.band), arfcn: carrier.arfcn, pci: null });
    }
    for (const scc of [...rf.lteScc, ...rf.nrScc]) {
      observed.push({ rat: scc.rat, band: bandOrNull(scc.band), arfcn: scc.arfcn, pci: scc.pci });
    }
  }
  for (const cell of [...(neighbors?.lteNeighbors ?? []), ...(neighbors?.nrNeighbors ?? [])]) {
    observed.push({ rat: cell.rat, band: bandOrNull(cell.band), arfcn: cell.arfcn, pci: cell.pci });
  }
  return observed.some(
    (cell) =>
      cell.rat === command.rat &&
      cell.band === band &&
      cell.arfcn === command.arfcn &&
      (command.pci === undefined || cell.pci === command.pci)
  );
}

/** A lock applied less than this long before a snapshot may still be settling (modem re-attach). */
export const LOCK_SETTLE_MS = 90_000;

export interface LockVerification {
  /**
   * `consistent`: the router matches the lock FengSui applied; `drift`: it does not (changed in the
   * WebUI, dropped by the modem, or never taken); `settling`: mismatch within `LOCK_SETTLE_MS` of
   * applying it; `unknown`: no telemetry, or no observation decides a locked component.
   */
  status: "consistent" | "drift" | "settling" | "unknown";
  /** `capturedAtIso` of the telemetry snapshot that was checked. */
  checkedAtIso: string | null;
  /** LTE bands the router reports enabled (`GET /api/net/net-mode`), its only lock read-back. */
  routerLteBands: number[] | null;
  /** English, one entry per mismatch. */
  issues: string[];
}

function bandList(prefix: "B" | "N", bands: ReadonlyArray<number>): string {
  return bands.map((b) => `${prefix}${b}`).join(", ");
}

function describeCell(prefix: "B" | "N", band: number | null, arfcn: number | null, pci: number | null): string {
  return `${prefix}${band ?? "?"}/${arfcn ?? "?"}${pci !== null ? `/PCI ${pci}` : ""}`;
}

/**
 * Reconcile FengSui's persisted lock state with a telemetry snapshot. `GET /api/net/lock-freq` is
 * not readable on the H168-383 (`100003`), so only the LTE band mask (`/api/net/net-mode`) is a true
 * read-back; NR band locks and cell locks are checked against the carriers the modem serves on.
 */
export function verifyLockState(
  lockState: PersistedLockState,
  telemetry: GlobalTelemetrySnapshot | null,
  /** The bands an unlock enables on this model: the H168-383's, or what another model advertises (phase 3). */
  supportedLteBands: ReadonlyArray<number> = H168_383_LTE_BANDS
): LockVerification {
  if (!telemetry) {
    return { status: "unknown", checkedAtIso: null, routerLteBands: null, issues: [] };
  }
  const rf = telemetry.rf;
  const routerLteBands = telemetry.bandConfig.lteBandHex ? [...telemetry.bandConfig.activeLteBands] : null;
  const issues: string[] = [];
  let undecided = false;

  const dlEarfcn = /DL:(\d+)/.exec(rf.earfcnRaw)?.[1];
  const pcc = {
    band: bandOrNull(rf.pccBand),
    arfcn: dlEarfcn ? Number(dlEarfcn) : (rf.caCarriers.find((c) => c.rat === "LTE")?.arfcn ?? null),
    pci: rf.pci,
  };
  const lteCarrierBands = [
    ...new Set(
      [pcc.band, ...rf.caCarriers.filter((c) => c.rat === "LTE").map((c) => bandOrNull(c.band)), ...rf.lteScc.map((c) => bandOrNull(c.band))].filter(
        (b): b is number => b !== null
      )
    ),
  ].sort((a, b) => a - b);
  const nrCarriers = [
    ...rf.caCarriers.filter((c) => c.rat === "NR").map((c) => ({ band: bandOrNull(c.band), arfcn: c.arfcn, pci: null as number | null })),
    ...rf.nrScc.map((c) => ({ band: bandOrNull(c.band), arfcn: c.arfcn, pci: c.pci })),
  ];

  // Cell locks go through lock-freq and leave the net-mode LTE mask untouched
  if (lockState.mode !== "cell_lock") {
    if (!routerLteBands) {
      undecided = true;
    } else if (lockState.lteBands === "all") {
      const allSupported = supportedLteBands.every((b) => routerLteBands.includes(b));
      const autoMask = Array.from({ length: 63 }, (_, i) => i + 1).every((b) => routerLteBands.includes(b));
      if (!allSupported && !autoMask) {
        issues.push(`LTE is not unlocked: the router enables only ${bandList("B", routerLteBands)}`);
      }
    } else {
      const expected = [...lockState.lteBands].sort((a, b) => a - b);
      if (expected.join() !== routerLteBands.join()) {
        issues.push(`LTE bands on the router (${bandList("B", routerLteBands)}) differ from the applied lock (${bandList("B", expected)})`);
      }
    }
  }

  if (lockState.mode === "band_lock" && lockState.lteBands !== "all") {
    const allowed = lockState.lteBands;
    for (const band of lteCarrierBands.filter((b) => !allowed.includes(b))) {
      issues.push(`serving LTE carrier B${band} is outside the locked LTE bands (${bandList("B", allowed)})`);
    }
  }

  if (lockState.mode === "band_lock" && lockState.nrBands.length > 0) {
    const servedNr = [...new Set(nrCarriers.map((c) => c.band).filter((b): b is number => b !== null))];
    if (servedNr.length === 0) undecided = true;
    for (const band of servedNr.filter((b) => !lockState.nrBands.includes(b))) {
      issues.push(`NR carrier N${band} is outside the locked NR bands (${bandList("N", lockState.nrBands)})`);
    }
  }

  const target = lockState.mode === "cell_lock" ? lockState.cellLock : null;
  if (target?.rat === "LTE") {
    if (pcc.band === null || pcc.arfcn === null) {
      undecided = true;
    } else if (pcc.band !== target.band || pcc.arfcn !== target.arfcn || (target.pci !== null && pcc.pci !== target.pci)) {
      issues.push(
        `serving LTE cell ${describeCell("B", pcc.band, pcc.arfcn, target.pci !== null ? pcc.pci : null)} is not the locked cell ${describeCell("B", target.band, target.arfcn, target.pci)}`
      );
    }
  } else if (target?.rat === "NR") {
    if (nrCarriers.length === 0) {
      undecided = true;
    } else if (!nrCarriers.some((c) => c.band === target.band && c.arfcn === target.arfcn && (target.pci === null || c.pci === target.pci))) {
      issues.push(`no serving NR carrier matches the locked cell ${describeCell("N", target.band, target.arfcn, target.pci)}`);
    }
  }

  // A snapshot taken before, or shortly after, the lock was applied cannot contradict it yet
  const sinceLockMs = telemetry.capturedAtMs - Date.parse(lockState.updatedAtIso);
  const settling = Number.isFinite(sinceLockMs) && sinceLockMs < LOCK_SETTLE_MS;
  const status: LockVerification["status"] =
    issues.length > 0 ? (settling ? "settling" : "drift") : undecided ? "unknown" : "consistent";
  return { status, checkedAtIso: telemetry.capturedAtIso, routerLteBands, issues };
}

/** Why an automatic WAN repair (lock rollback, reconnect) wrote nothing. */
export type WanRepairSkipReason = "wan_up" | "mobile_data_off";

/**
 * Validate a security switch command without touching the CPE (run before queueing a session).
 */
export function validateSecurityUpdateCommand(command: SecurityUpdateCommand): void {
  if (
    command.upnpEnabled === undefined &&
    command.dmz === undefined &&
    command.firewall === undefined
  ) {
    throw new CpeControlValidationError("No security setting changes specified");
  }
  if (
    command.dmz?.ipAddress !== undefined &&
    command.dmz.ipAddress.trim() !== "" &&
    net.isIP(command.dmz.ipAddress.trim()) !== 4
  ) {
    throw new CpeControlValidationError(
      `Invalid DMZ host IPv4 address "${command.dmz.ipAddress.trim()}"`
    );
  }
}
