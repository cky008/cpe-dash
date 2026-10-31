import net from "node:net";
import {
  type BandInput,
  H168_383_LTE_BANDS,
  type HuaweiNetworkModeCode,
  NETWORK_MODE_AUTO,
  bandsToHexMask,
  buildLteBandNetModeXml,
  buildLteCellLockXml,
  buildNrBandLockXml,
  buildNrCellLockXml,
  buildUnlockAllLocksXml,
  hexMaskToBands,
  parseBandNumber,
} from "./band-lock.ts";
import { CpeApiError, type EphemeralCpeSession } from "./cpe-client.ts";
import {
  type NeighborCellEntry,
  type RfSignalSnapshot,
  type TerminalAccessMedium,
  type TerminalHostEntry,
  type TopologySummary,
  formatBytesBinary,
  formatRateBitsPerSec,
  parseHostInfoJson,
  parseNeighborCellsXml,
  parseNumberWithUnit,
  parseRfSignalSnapshot,
  parseTrafficSnapshot,
  summarizeTopologyJson,
} from "./parsers.ts";
import { parseSmsCountersOrNull } from "./sms/codec.ts";
import type { SmsCounters } from "./sms/types.ts";
import { getXmlTag } from "./xml.ts";

export class CpeControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CpeControlValidationError";
  }
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
  temperatureCelsius: number | null;
  temperatureSupported: boolean;
}

export interface GlobalTelemetrySnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  device: DeviceIdentitySnapshot;
  rf: RfSignalSnapshot;
  bandConfig: BandConfigSnapshot;
  traffic: TrafficTelemetryDto;
  thermal: ThermalSnapshot;
  /** `GET /api/sms/sms-count` piggybacked on the telemetry session; `null` when SMS is disabled or unavailable. */
  sms: SmsCounters | null;
}

export interface NeighborScanSnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  lteNeighbors: NeighborCellEntry[];
  nrNeighbors: NeighborCellEntry[];
  totalCount: number;
}

export interface TerminalTopologySnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  hosts: TerminalHostEntry[];
  summary: TopologySummary;
  countsByMedium: Record<TerminalAccessMedium, number>;
}

export type AntennaModeName = "auto" | "internal" | "external";

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
  } | null;
}

export interface BandLockCommand {
  lteBands?: ReadonlyArray<BandInput> | "all";
  nrBands?: ReadonlyArray<BandInput> | "all";
  networkMode?: HuaweiNetworkModeCode;
}

export interface CellLockCommand {
  rat: "LTE" | "NR";
  band: BandInput;
  arfcn: number;
  pci?: number;
}

export interface SecurityUpdateCommand {
  upnpEnabled?: boolean;
  dmz?: {
    enabled: boolean;
    ipAddress?: string;
  };
  firewall?: Partial<FirewallSwitchState>;
}

/**
 * Read an endpoint whose absence the snapshot tolerates: a CPE error code (the router answered,
 * e.g. `100002` unsupported) degrades to `""`, but transport failures (timeout, reset) propagate,
 * because a broken session must never turn into a fabricated all-zero snapshot.
 */
async function optionalGet(session: EphemeralCpeSession, apiPath: string): Promise<string> {
  try {
    return await session.get(apiPath);
  } catch (err) {
    if (err instanceof CpeApiError) return "";
    throw err;
  }
}

/** Current value of a read-modify-write field; a missing tag aborts the change before any write. */
function requireTag(xml: string, tag: string, apiPath: string): string {
  const value = getXmlTag(xml, tag);
  if (value === null) {
    throw new Error(`Unexpected ${apiPath} response without <${tag}>; refusing to write guessed values`);
  }
  return value.trim();
}

function splitDnsList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function decodeAntennaCode(code: string | null | undefined): AntennaModeName {
  if (code === "1") return "internal";
  if (code === "2") return "external";
  return "auto";
}

function encodeAntennaCode(mode: AntennaModeName): number {
  if (mode === "internal") return 1;
  if (mode === "external") return 2;
  return 0;
}

/** Strictly parse `GET /api/wlan/wlandbho` (`{"MloEnable":bool,"DbhoEnable":bool}`). */
function parseWifi7DbhoJson(rawJson: string): { mloEnable: boolean; dbhoEnable: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = null;
  }
  const obj = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  const mlo = obj && "MloEnable" in obj ? obj.MloEnable : undefined;
  const dbho = obj && "DbhoEnable" in obj ? obj.DbhoEnable : undefined;
  if (typeof mlo !== "boolean" || typeof dbho !== "boolean") {
    throw new Error("Unexpected /api/wlan/wlandbho response (expected MloEnable/DbhoEnable booleans)");
  }
  return { mloEnable: mlo, dbhoEnable: dbho };
}

/**
 * Fetch a complete, JSON-serializable 5G/4G RF + 3CA + 256QAM MCS + MIMO + Dual-Stack WAN + Dual-Period Traffic
 * snapshot within a single ephemeral CPE session (~130–220ms). With `includeSmsCounters`, the SMS
 * counters ride along as one more parallel GET so SMS change detection costs no extra session.
 *
 * Core endpoints (signal, status, traffic and month statistics) must succeed; the others degrade
 * only on CPE error codes. Any transport failure fails the whole snapshot.
 */
export async function fetchGlobalTelemetry(
  session: EphemeralCpeSession,
  options: { includeSmsCounters?: boolean } = {}
): Promise<GlobalTelemetrySnapshot> {
  const [
    signalXml,
    secCellXml,
    riXml,
    cellInfoXml,
    plmnXml,
    netModeXml,
    deviceInfoXml,
    basicInfoXml,
    statusXml,
    trafficXml,
    monthXml,
    startDateXml,
    smsCountXml,
  ] = await Promise.all([
    session.get("/api/device/signal"),
    optionalGet(session, "/api/device/seccellinfo"),
    optionalGet(session, "/api/device/ri"),
    optionalGet(session, "/api/net/cell-info"),
    optionalGet(session, "/api/net/current-plmn"),
    optionalGet(session, "/api/net/net-mode"),
    optionalGet(session, "/api/device/information"),
    optionalGet(session, "/api/device/basic_information"),
    session.get("/api/monitoring/status"),
    session.get("/api/monitoring/traffic-statistics"),
    session.get("/api/monitoring/month_statistics"),
    optionalGet(session, "/api/monitoring/start_date"),
    options.includeSmsCounters ? optionalGet(session, "/api/sms/sms-count") : Promise.resolve(""),
  ]);

  const rf = parseRfSignalSnapshot({
    signalXml,
    secCellXml,
    riXml,
    cellInfoXml,
    plmnXml,
    redactIdentifiers: false,
  });

  const rawTraffic = parseTrafficSnapshot({ trafficXml, monthXml, startDateXml });
  const traffic: TrafficTelemetryDto = {
    downloadBytesPerSec: rawTraffic.downloadBytesPerSec,
    uploadBytesPerSec: rawTraffic.uploadBytesPerSec,
    downloadBps: rawTraffic.downloadBps,
    uploadBps: rawTraffic.uploadBps,
    downloadRateFormatted: formatRateBitsPerSec(rawTraffic.downloadBps),
    uploadRateFormatted: formatRateBitsPerSec(rawTraffic.uploadBps),
    todayUsedBytes: Number(rawTraffic.todayUsedBytes),
    todayUsedBytesStr: rawTraffic.todayUsedBytes.toString(10),
    todayUsedFormatted: formatBytesBinary(rawTraffic.todayUsedBytes),
    todayDurationSec: rawTraffic.todayDurationSec,
    monthDownloadBytes: Number(rawTraffic.monthDownloadBytes),
    monthDownloadBytesStr: rawTraffic.monthDownloadBytes.toString(10),
    monthUploadBytes: Number(rawTraffic.monthUploadBytes),
    monthUploadBytesStr: rawTraffic.monthUploadBytes.toString(10),
    monthTotalBytes: Number(rawTraffic.monthTotalBytes),
    monthTotalBytesStr: rawTraffic.monthTotalBytes.toString(10),
    monthTotalFormatted: formatBytesBinary(rawTraffic.monthTotalBytes),
    monthDurationSec: rawTraffic.monthDurationSec,
    monthLastClearDate: rawTraffic.monthLastClearDate,
    sessionConnectTimeSec: rawTraffic.sessionConnectTimeSec,
    sessionDownloadBytesStr: rawTraffic.sessionDownloadBytes.toString(10),
    sessionUploadBytesStr: rawTraffic.sessionUploadBytes.toString(10),
    totalUsedBytesStr: rawTraffic.totalUsedBytes.toString(10),
    totalConnectTimeSec: rawTraffic.totalConnectTimeSec,
    billingStartDay: rawTraffic.billingStartDay,
    dataLimitRaw: rawTraffic.dataLimitRaw,
    monthThresholdPercent: rawTraffic.monthThresholdPercent,
  };

  const lteBandHex = (getXmlTag(netModeXml, "LTEBand") ?? "").trim().toLowerCase();
  let activeLteBands: number[] = [];
  if (lteBandHex && /^[0-9a-f]+$/.test(lteBandHex)) {
    try {
      activeLteBands = hexMaskToBands(lteBandHex);
    } catch {
      activeLteBands = [];
    }
  }

  const deviceTag = (tag: string): string => (getXmlTag(deviceInfoXml, tag) ?? "").trim();
  const rawImei = deviceTag("Imei");
  const rawImsi = deviceTag("Imsi");
  const rawMsisdn = deviceTag("Msisdn");
  const rawMac = deviceTag("WanMacAddress") || deviceTag("MacAddress1");
  const rawWanV4 = (getXmlTag(deviceInfoXml, "WanIPAddress") ?? "").trim();
  const rawWanV6 = (getXmlTag(deviceInfoXml, "WanIPv6Address") ?? "").trim();

  // Honest thermal parsing: H168-383 4.4.0.1 retail HTTP API omits temperature tags; never fabricate values.
  const rawTemp =
    getXmlTag(deviceInfoXml, "temperature") ??
    getXmlTag(signalXml, "temperature") ??
    getXmlTag(statusXml, "temperature");
  const parsedTemp = parseNumberWithUnit(rawTemp);

  const nowMs = Date.now();
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    device: {
      deviceName:
        getXmlTag(deviceInfoXml, "DeviceName") ??
        getXmlTag(basicInfoXml, "devicename") ??
        "H168-383",
      marketingName: getXmlTag(basicInfoXml, "spreadname_en") ?? "HUAWEI 5G CPE Ultra 6",
      hardwareVersion: getXmlTag(deviceInfoXml, "HardwareVersion") ?? "",
      softwareVersion: getXmlTag(deviceInfoXml, "SoftwareVersion") ?? "",
      webUiVersion: getXmlTag(deviceInfoXml, "WebUIVersion") ?? "",
      uptimeSec: Number.parseInt(getXmlTag(deviceInfoXml, "uptime") ?? "0", 10) || 0,
      workMode: getXmlTag(deviceInfoXml, "workmode") ?? "",
      wanIpv4: rawWanV4,
      wanDnsV4: splitDnsList(getXmlTag(deviceInfoXml, "wan_dns_address")),
      wanIpv6: rawWanV6,
      wanDnsV6: splitDnsList(getXmlTag(deviceInfoXml, "wan_ipv6_dns_address")),
      connectionStatus: getXmlTag(statusXml, "ConnectionStatus") ?? "",
      signalIconBars: Number.parseInt(getXmlTag(statusXml, "SignalIcon") ?? "0", 10) || 0,
      simStatus: getXmlTag(statusXml, "SimStatus") ?? "",
      imei: rawImei,
      imsi: rawImsi,
      msisdn: rawMsisdn,
      macAddress: rawMac,
      sensitiveRedacted: false,
    },
    rf,
    bandConfig: {
      networkMode: getXmlTag(netModeXml, "NetworkMode") ?? NETWORK_MODE_AUTO,
      networkBandHex: getXmlTag(netModeXml, "NetworkBand") ?? "",
      lteBandHex,
      activeLteBands,
    },
    traffic,
    thermal: {
      temperatureCelsius: parsedTemp,
      temperatureSupported: parsedTemp !== null,
    },
    sms: parseSmsCountersOrNull(smsCountXml),
  };
}

/**
 * Scan surrounding 4G LTE and 5G NR candidate neighbor cells via `GET /api/device/nbrcellinfo`.
 */
export async function scanNeighborCells(
  session: EphemeralCpeSession
): Promise<NeighborScanSnapshot> {
  const xml = await session.get("/api/device/nbrcellinfo");
  const { lteNeighbors, nrNeighbors } = parseNeighborCellsXml(xml);
  const nowMs = Date.now();
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    lteNeighbors,
    nrNeighbors,
    totalCount: lteNeighbors.length + nrNeighbors.length,
  };
}

/**
 * Query LAN & Wi-Fi 7 terminal topology (`GET /api/system/HostInfo` + `GET /api/system/topology`).
 */
export async function fetchTerminalTopology(session: EphemeralCpeSession): Promise<TerminalTopologySnapshot> {
  const [hostInfoJson, topologyJson] = await Promise.all([
    session.get("/api/system/HostInfo"),
    optionalGet(session, "/api/system/topology"),
  ]);

  const hosts = parseHostInfoJson(hostInfoJson, { sanitize: false });
  const summary = summarizeTopologyJson(topologyJson);
  const countsByMedium: Record<TerminalAccessMedium, number> = {
    LAN_1000M: 0,
    LAN_100M: 0,
    LAN_OTHER: 0,
    WIFI_2_4G: 0,
    WIFI_5G: 0,
    WIFI_OTHER: 0,
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

/**
 * Query HAR-verified security switches (UPnP, DMZ, Firewall, NAT, Bridge), Wi-Fi 7 MLO/DBHO,
 * Antenna mode, and Mobile Data switch. All-or-nothing: the snapshot is made of booleans, so any
 * failed or malformed read fails the refresh instead of reporting a guessed switch state.
 */
export async function fetchRouterSettings(session: EphemeralCpeSession): Promise<RouterSettingsSnapshot> {
  const [
    upnpXml,
    dmzXml,
    firewallXml,
    natXml,
    bridgeXml,
    wlandbhoJson,
    antennaSetXml,
    antennaTypeXml,
    dataSwitchXml,
  ] = await Promise.all([
    session.get("/api/security/upnp"),
    session.get("/api/security/dmz"),
    session.get("/api/security/firewall-switch"),
    session.get("/api/security/nat"),
    session.get("/api/security/bridgemode"),
    session.get("/api/wlan/wlandbho"),
    session.get("/api/device/antenna_set_type"),
    session.get("/api/device/antenna_type"),
    session.get("/api/dialup/mobile-dataswitch"),
  ]);

  const firewall = readFirewallSwitches(firewallXml);
  const rawDmzIp = (getXmlTag(dmzXml, "DmzIPAddress") ?? "").trim();
  const antCode = requireTag(antennaSetXml, "antennasettype", "/api/device/antenna_set_type");
  const nowMs = Date.now();

  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    upnpEnabled: requireTag(upnpXml, "UpnpStatus", "/api/security/upnp") === "1",
    dmzEnabled: requireTag(dmzXml, "DmzStatus", "/api/security/dmz") === "1",
    dmzIpAddress: rawDmzIp,
    firewall,
    natType: Number.parseInt(requireTag(natXml, "NATType", "/api/security/nat"), 10) || 1,
    bridgeModeEnabled: requireTag(bridgeXml, "bridgemode", "/api/security/bridgemode") === "1",
    wifi7: parseWifi7DbhoJson(wlandbhoJson),
    antenna: {
      mode: decodeAntennaCode(antCode),
      rawCode: antCode,
      antenna1Inserted: getXmlTag(antennaTypeXml, "antenna1insertstatus") === "1",
      antenna2Inserted: getXmlTag(antennaTypeXml, "antenna2insertstatus") === "1",
    },
    mobileDataEnabled: requireTag(dataSwitchXml, "dataswitch", "/api/dialup/mobile-dataswitch") === "1",
  };
}

export function prepareBandLockPayloads(command: BandLockCommand): {
  netModeXml: string | null;
  nrXml: string | null;
  appliedLte: number[] | "all";
  appliedNr: number[];
} {
  if (command.lteBands === undefined && command.nrBands === undefined) {
    throw new CpeControlValidationError("At least one of lteBands or nrBands must be provided");
  }

  let netModeXml: string | null = null;
  let appliedLte: number[] | "all" = "all";
  if (command.lteBands !== undefined) {
    try {
      netModeXml = buildLteBandNetModeXml(
        command.lteBands,
        command.networkMode ?? NETWORK_MODE_AUTO
      );
      appliedLte =
        command.lteBands === "all"
          ? "all"
          : [...new Set(command.lteBands.map(parseBandNumber))].sort((a, b) => a - b);
    } catch (err) {
      throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  let nrXml: string | null = null;
  let appliedNr: number[] = [];
  if (command.nrBands !== undefined) {
    try {
      if (command.nrBands === "all") {
        nrXml = buildUnlockAllLocksXml();
        appliedNr = [];
      } else {
        nrXml = buildNrBandLockXml(command.nrBands);
        appliedNr = [...new Set(command.nrBands.map(parseBandNumber))].sort((a, b) => a - b);
      }
    } catch (err) {
      throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
    }
  }

  return { netModeXml, nrXml, appliedLte, appliedNr };
}

export function prepareCellLockPayload(command: CellLockCommand): {
  xml: string;
  bandNum: number;
} {
  if (command.rat !== "LTE" && command.rat !== "NR") {
    throw new CpeControlValidationError(
      `Unsupported RAT "${String(command.rat)}" (expected "LTE" or "NR")`
    );
  }
  try {
    const bandNum = parseBandNumber(command.band);
    const xml =
      command.rat === "LTE"
        ? buildLteCellLockXml({ band: bandNum, earfcn: command.arfcn, pci: command.pci })
        : buildNrCellLockXml({ band: bandNum, nrArfcn: command.arfcn, pci: command.pci });
    return { xml, bandNum };
  } catch (err) {
    throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
  }
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
  telemetry: GlobalTelemetrySnapshot | null
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
      const allSupported = H168_383_LTE_BANDS.every((b) => routerLteBands.includes(b));
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

/**
 * Lock 4G LTE (`POST /api/net/net-mode`) and/or 5G NR (`POST /api/net/lock-freq` `lock_mode=3`) bands.
 */
export async function applyBandLock(
  session: EphemeralCpeSession,
  command: BandLockCommand
): Promise<PersistedLockState> {
  const { netModeXml, nrXml, appliedLte, appliedNr } = prepareBandLockPayloads(command);

  if (netModeXml !== null) {
    await session.postRaw("/api/net/net-mode", netModeXml);
  }
  if (nrXml !== null) {
    await session.postRaw("/api/net/lock-freq", nrXml);
  }

  const isFullyUnlocked = appliedLte === "all" && appliedNr.length === 0;
  return {
    mode: isFullyUnlocked ? "unlocked" : "band_lock",
    updatedAtIso: new Date().toISOString(),
    lteBands: appliedLte,
    nrBands: appliedNr,
    cellLock: null,
  };
}

/**
 * Lock a specific 4G LTE or 5G NR physical cell (`PCI + ARFCN`, `lock_mode=2`) or carrier frequency (`lock_mode=1`).
 */
export async function applyCellLock(
  session: EphemeralCpeSession,
  command: CellLockCommand
): Promise<PersistedLockState> {
  const { xml, bandNum } = prepareCellLockPayload(command);

  await session.postRaw("/api/net/lock-freq", xml);

  return {
    mode: "cell_lock",
    updatedAtIso: new Date().toISOString(),
    lteBands: command.rat === "LTE" ? [bandNum] : "all",
    nrBands: command.rat === "NR" ? [bandNum] : [],
    cellLock: {
      rat: command.rat,
      band: bandNum,
      arfcn: command.arfcn,
      pci: command.pci ?? null,
    },
  };
}

/**
 * Clear all 4G/5G cell, frequency, and band locks (`lock_mode=0` + `LTEBand=7fffffffffffffff`).
 */
export async function unlockAllRfLocks(
  session: EphemeralCpeSession
): Promise<PersistedLockState> {
  await session.postRaw("/api/net/lock-freq", buildUnlockAllLocksXml());
  await session.postRaw("/api/net/net-mode", buildLteBandNetModeXml("all", NETWORK_MODE_AUTO));
  return {
    mode: "unlocked",
    updatedAtIso: new Date().toISOString(),
    lteBands: "all",
    nrBands: [],
    cellLock: null,
  };
}

/**
 * Trigger a remote router reboot (`POST /api/device/control` `<Control>1</Control>`).
 * Strictly enforces `confirm === true` to prevent accidental UI or AI-agent reboots.
 */
export async function rebootCpe(
  session: EphemeralCpeSession,
  params: { confirm: boolean }
): Promise<{ rebooting: true; requestedAtIso: string }> {
  if (params.confirm !== true) {
    throw new CpeControlValidationError(
      "Remote reboot rejected: explicit { confirm: true } is mandatory"
    );
  }
  await session.postXml("/api/device/control", { Control: 1 });
  return {
    rebooting: true,
    requestedAtIso: new Date().toISOString(),
  };
}

/**
 * Trigger a cellular WAN reconnect (`POST /api/net/reconnect` `<reconnect_action>1</reconnect_action>`).
 */
export async function triggerCellularReconnect(
  session: EphemeralCpeSession
): Promise<{ reconnecting: true; requestedAtIso: string }> {
  await session.postXml("/api/net/reconnect", { reconnect_action: 1 });
  return {
    reconnecting: true,
    requestedAtIso: new Date().toISOString(),
  };
}

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

function readFirewallSwitches(xml: string): FirewallSwitchState {
  const api = "/api/security/firewall-switch";
  return {
    mainSwitch: requireTag(xml, "FirewallMainSwitch", api) === "1",
    ipFilterSwitch: requireTag(xml, "FirewallIPFilterSwitch", api) === "1",
    wanPortPingSwitch: requireTag(xml, "FirewallWanPortPingSwitch", api) === "1",
    macFilterSwitch: requireTag(xml, "firewallmacfilterswitch", api) === "1",
    urlFilterSwitch: requireTag(xml, "firewallurlfilterswitch", api) === "1",
  };
}

/**
 * Update HAR-verified router security switches (UPnP, DMZ, and/or Firewall switches).
 * Every read the change depends on (current DMZ host, current firewall switches) happens and is
 * validated before the first write, so a failed read never leaves a partial or guessed change.
 */
export async function updateSecuritySettings(
  session: EphemeralCpeSession,
  command: SecurityUpdateCommand
): Promise<void> {
  validateSecurityUpdateCommand(command);

  let dmzPayload: { DmzStatus: number; DmzIPAddress: string } | null = null;
  if (command.dmz !== undefined) {
    const currentDmzXml = await session.get("/api/security/dmz");
    const targetIp = (command.dmz.ipAddress ?? requireTag(currentDmzXml, "DmzIPAddress", "/api/security/dmz")).trim();
    if ((command.dmz.enabled || targetIp !== "") && net.isIP(targetIp) !== 4) {
      throw new CpeControlValidationError(
        `Invalid DMZ host IPv4 address "${targetIp}"`
      );
    }
    dmzPayload = {
      DmzStatus: command.dmz.enabled ? 1 : 0,
      DmzIPAddress: targetIp,
    };
  }

  let firewallPayload: Record<string, number> | null = null;
  if (command.firewall !== undefined) {
    const current = readFirewallSwitches(await session.get("/api/security/firewall-switch"));
    const next = { ...current, ...Object.fromEntries(Object.entries(command.firewall).filter(([, v]) => v !== undefined)) };
    firewallPayload = {
      FirewallMainSwitch: next.mainSwitch ? 1 : 0,
      FirewallIPFilterSwitch: next.ipFilterSwitch ? 1 : 0,
      FirewallWanPortPingSwitch: next.wanPortPingSwitch ? 1 : 0,
      firewallmacfilterswitch: next.macFilterSwitch ? 1 : 0,
      firewallurlfilterswitch: next.urlFilterSwitch ? 1 : 0,
    };
  }

  if (command.upnpEnabled !== undefined) {
    await session.postXml("/api/security/upnp", {
      UpnpStatus: command.upnpEnabled ? 1 : 0,
    });
  }
  if (dmzPayload !== null) {
    await session.postXml("/api/security/dmz", dmzPayload);
  }
  if (firewallPayload !== null) {
    await session.postXml("/api/security/firewall-switch", firewallPayload);
  }
}

/**
 * Update Wi-Fi 7 (802.11be) MLO and Dual-Band Handover (`POST /api/wlan/wlandbho` JSON).
 */
export async function updateWifi7Mlo(
  session: EphemeralCpeSession,
  input: { mloEnable?: boolean; dbhoEnable?: boolean }
): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
  if (input.mloEnable === undefined && input.dbhoEnable === undefined) {
    throw new CpeControlValidationError("Specify mloEnable and/or dbhoEnable");
  }
  const current = parseWifi7DbhoJson(await session.get("/api/wlan/wlandbho"));
  const next = {
    MloEnable: input.mloEnable ?? current.mloEnable,
    DbhoEnable: input.dbhoEnable ?? current.dbhoEnable,
  };
  await session.postJson("/api/wlan/wlandbho", next);
  return {
    mloEnable: next.MloEnable,
    dbhoEnable: next.DbhoEnable,
  };
}

/**
 * Switch physical/internal antenna mode (`0=auto`, `1=internal`, `2=external`) via `POST /api/device/antenna_set_type`.
 */
export async function updateAntennaMode(
  session: EphemeralCpeSession,
  mode: AntennaModeName
): Promise<{ mode: AntennaModeName; rawCode: number }> {
  if (mode !== "auto" && mode !== "internal" && mode !== "external") {
    throw new CpeControlValidationError(`Invalid antenna mode "${String(mode)}"`);
  }
  const rawCode = encodeAntennaCode(mode);
  await session.postXml("/api/device/antenna_set_type", { antennasettype: rawCode });
  return { mode, rawCode };
}

/**
 * Toggle cellular mobile data master switch (`POST /api/dialup/mobile-dataswitch` `<dataswitch>0|1</dataswitch>`).
 */
export async function updateMobileDataSwitch(
  session: EphemeralCpeSession,
  enabled: boolean
): Promise<{ mobileDataEnabled: boolean }> {
  await session.postXml("/api/dialup/mobile-dataswitch", { dataswitch: enabled ? 1 : 0 });
  return { mobileDataEnabled: enabled };
}

export { bandsToHexMask, hexMaskToBands };
