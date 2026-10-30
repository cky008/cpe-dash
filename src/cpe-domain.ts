import net from "node:net";
import {
  type BandInput,
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
import type { EphemeralCpeSession } from "./cpe-client.ts";
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
import { sanitizeIpToken } from "./sanitize.ts";
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

function safeGet(session: EphemeralCpeSession, apiPath: string): Promise<string> {
  return session.get(apiPath).catch(() => "");
}

function splitDnsList(raw: string | null | undefined, redact: boolean): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((ip) => (redact ? sanitizeIpToken(ip) : ip));
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

function parseWifi7DbhoJson(rawJson: string): { mloEnable: boolean; dbhoEnable: boolean } {
  try {
    const obj = JSON.parse(rawJson) as Record<string, unknown>;
    return {
      mloEnable: Boolean(obj["MloEnable"]),
      dbhoEnable: Boolean(obj["DbhoEnable"]),
    };
  } catch {
    return { mloEnable: false, dbhoEnable: false };
  }
}

/**
 * Fetch a complete, JSON-serializable 5G/4G RF + 3CA + 256QAM MCS + MIMO + Dual-Stack WAN + Dual-Period Traffic
 * snapshot within a single ephemeral CPE session (~130–220ms). With `includeSmsCounters`, the SMS
 * counters ride along as one more parallel GET so SMS change detection costs no extra session.
 */
export async function fetchGlobalTelemetry(
  session: EphemeralCpeSession,
  options: { redactSensitive?: boolean; includeSmsCounters?: boolean } = {}
): Promise<GlobalTelemetrySnapshot> {
  const redact = options.redactSensitive !== false;

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
    safeGet(session, "/api/device/signal"),
    safeGet(session, "/api/device/seccellinfo"),
    safeGet(session, "/api/device/ri"),
    safeGet(session, "/api/net/cell-info"),
    safeGet(session, "/api/net/current-plmn"),
    safeGet(session, "/api/net/net-mode"),
    safeGet(session, "/api/device/information"),
    safeGet(session, "/api/device/basic_information"),
    safeGet(session, "/api/monitoring/status"),
    safeGet(session, "/api/monitoring/traffic-statistics"),
    safeGet(session, "/api/monitoring/month_statistics"),
    safeGet(session, "/api/monitoring/start_date"),
    options.includeSmsCounters ? safeGet(session, "/api/sms/sms-count") : Promise.resolve(""),
  ]);

  const rf = parseRfSignalSnapshot({
    signalXml,
    secCellXml,
    riXml,
    cellInfoXml,
    plmnXml,
    redactIdentifiers: redact,
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
      wanIpv4: redact && rawWanV4 ? sanitizeIpToken(rawWanV4) : rawWanV4,
      wanDnsV4: splitDnsList(getXmlTag(deviceInfoXml, "wan_dns_address"), redact),
      wanIpv6: redact && rawWanV6 ? sanitizeIpToken(rawWanV6) : rawWanV6,
      wanDnsV6: splitDnsList(getXmlTag(deviceInfoXml, "wan_ipv6_dns_address"), redact),
      connectionStatus: getXmlTag(statusXml, "ConnectionStatus") ?? "",
      signalIconBars: Number.parseInt(getXmlTag(statusXml, "SignalIcon") ?? "0", 10) || 0,
      simStatus: getXmlTag(statusXml, "SimStatus") ?? "",
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
export async function fetchTerminalTopology(
  session: EphemeralCpeSession,
  options: { sanitize?: boolean } = {}
): Promise<TerminalTopologySnapshot> {
  const [hostInfoJson, topologyJson] = await Promise.all([
    session.get("/api/system/HostInfo"),
    safeGet(session, "/api/system/topology"),
  ]);

  const hosts = parseHostInfoJson(hostInfoJson, { sanitize: options.sanitize !== false });
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
 * Antenna mode, and Mobile Data switch.
 */
export async function fetchRouterSettings(
  session: EphemeralCpeSession,
  options: { sanitize?: boolean } = {}
): Promise<RouterSettingsSnapshot> {
  const sanitize = options.sanitize !== false;
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
    safeGet(session, "/api/security/upnp"),
    safeGet(session, "/api/security/dmz"),
    safeGet(session, "/api/security/firewall-switch"),
    safeGet(session, "/api/security/nat"),
    safeGet(session, "/api/security/bridgemode"),
    safeGet(session, "/api/wlan/wlandbho"),
    safeGet(session, "/api/device/antenna_set_type"),
    safeGet(session, "/api/device/antenna_type"),
    safeGet(session, "/api/dialup/mobile-dataswitch"),
  ]);

  const rawDmzIp = (getXmlTag(dmzXml, "DmzIPAddress") ?? "").trim();
  const antCode = (getXmlTag(antennaSetXml, "antennasettype") ?? "0").trim();
  const nowMs = Date.now();

  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    upnpEnabled: getXmlTag(upnpXml, "UpnpStatus") === "1",
    dmzEnabled: getXmlTag(dmzXml, "DmzStatus") === "1",
    dmzIpAddress: sanitize && rawDmzIp ? sanitizeIpToken(rawDmzIp) : rawDmzIp,
    firewall: {
      mainSwitch: (getXmlTag(firewallXml, "FirewallMainSwitch") ?? "1") === "1",
      ipFilterSwitch: (getXmlTag(firewallXml, "FirewallIPFilterSwitch") ?? "1") === "1",
      wanPortPingSwitch: (getXmlTag(firewallXml, "FirewallWanPortPingSwitch") ?? "0") === "1",
      macFilterSwitch: (getXmlTag(firewallXml, "firewallmacfilterswitch") ?? "1") === "1",
      urlFilterSwitch: (getXmlTag(firewallXml, "firewallurlfilterswitch") ?? "1") === "1",
    },
    natType: Number.parseInt(getXmlTag(natXml, "NATType") ?? "1", 10) || 1,
    bridgeModeEnabled: getXmlTag(bridgeXml, "bridgemode") === "1",
    wifi7: parseWifi7DbhoJson(wlandbhoJson),
    antenna: {
      mode: decodeAntennaCode(antCode),
      rawCode: antCode,
      antenna1Inserted: getXmlTag(antennaTypeXml, "antenna1insertstatus") === "1",
      antenna2Inserted: getXmlTag(antennaTypeXml, "antenna2insertstatus") === "1",
    },
    mobileDataEnabled: (getXmlTag(dataSwitchXml, "dataswitch") ?? "1") === "1",
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

/**
 * Update HAR-verified router security switches (UPnP, DMZ, and/or Firewall switches).
 * The DMZ target is resolved and validated before the first write, so a missing host IP
 * never leaves UPnP applied on its own.
 */
export async function updateSecuritySettings(
  session: EphemeralCpeSession,
  command: SecurityUpdateCommand
): Promise<void> {
  validateSecurityUpdateCommand(command);

  let dmzPayload: { DmzStatus: number; DmzIPAddress: string } | null = null;
  if (command.dmz !== undefined) {
    const currentDmzXml = await safeGet(session, "/api/security/dmz");
    const targetIp = (command.dmz.ipAddress ?? getXmlTag(currentDmzXml, "DmzIPAddress") ?? "").trim();
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

  if (command.upnpEnabled !== undefined) {
    await session.postXml("/api/security/upnp", {
      UpnpStatus: command.upnpEnabled ? 1 : 0,
    });
  }

  if (dmzPayload !== null) {
    await session.postXml("/api/security/dmz", dmzPayload);
  }

  if (command.firewall !== undefined) {
    const currentFwXml = await safeGet(session, "/api/security/firewall-switch");
    const curMain = (getXmlTag(currentFwXml, "FirewallMainSwitch") ?? "1") === "1";
    const curIp = (getXmlTag(currentFwXml, "FirewallIPFilterSwitch") ?? "1") === "1";
    const curPing = (getXmlTag(currentFwXml, "FirewallWanPortPingSwitch") ?? "0") === "1";
    const curMac = (getXmlTag(currentFwXml, "firewallmacfilterswitch") ?? "1") === "1";
    const curUrl = (getXmlTag(currentFwXml, "firewallurlfilterswitch") ?? "1") === "1";

    await session.postXml("/api/security/firewall-switch", {
      FirewallMainSwitch: (command.firewall.mainSwitch ?? curMain) ? 1 : 0,
      FirewallIPFilterSwitch: (command.firewall.ipFilterSwitch ?? curIp) ? 1 : 0,
      FirewallWanPortPingSwitch: (command.firewall.wanPortPingSwitch ?? curPing) ? 1 : 0,
      firewallmacfilterswitch: (command.firewall.macFilterSwitch ?? curMac) ? 1 : 0,
      firewallurlfilterswitch: (command.firewall.urlFilterSwitch ?? curUrl) ? 1 : 0,
    });
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
  const currentRaw = await safeGet(session, "/api/wlan/wlandbho");
  const current = parseWifi7DbhoJson(currentRaw);
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
