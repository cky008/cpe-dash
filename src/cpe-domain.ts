import net from "node:net";
import {
  DEFAULT_NET_MODE_KEEP,
  type HuaweiNetworkModeCode,
  NETWORK_MODE_AUTO,
  type NetModeKeep,
  buildLteBandNetModeXml,
  buildLteCellLockXml,
  buildNrBandLockXml,
  buildNrCellLockXml,
  buildUnlockAllLocksXml,
} from "./band-lock.ts";
import { type BandInput, H168_383_LTE_BANDS, hexMaskToBands, parseBandNumber } from "./rf-bounds.ts";
import type { EphemeralCpeSession } from "./cpe-client.ts";
import { CpeAnswerFormatError, CpeApiError, CpeEncryptionUnavailableError } from "./session-errors.ts";
import {
  parseHostInfoJson,
  parseHostInfoJsonList,
  parseHostListXml,
  parseNeighborCellsXml,
  parseNumberWithUnit,
  parseRfSignalSnapshot,
  parseSecondaryCellsXml,
  parseTrafficSnapshot,
  summarizeTopologyJson,
} from "./parsers.ts";
import { formatBytesBinary, formatRateBitsPerSec } from "./units.ts";
import { type BatteryStatus, type RouterStatusSnapshot, type TemperatureSensor, emptyRouterStatus, percentValue } from "./router-status.ts";
import { parseSmsCountersOrNull } from "./sms/codec.ts";
import type { SmsCounters } from "./sms/types.ts";
import { getXmlTag } from "./xml.ts";
import { CpeControlValidationError } from "./control-error.ts";

export { CpeControlValidationError } from "./control-error.ts";

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
/** The HiLink poll's core parts (a poll that has none of them failed). */
const TELEMETRY_PARTS: ReadonlyArray<TelemetryPart> = ["signal", "status", "traffic", "month"];

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
  networkMode?: HuaweiNetworkModeCode;
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
    throw new CpeAnswerFormatError(`Unexpected ${apiPath} response without <${tag}>; refusing to write guessed values`);
  }
  return value.trim();
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
const NOT_HERE_CODES: ReadonlySet<string> = new Set(["100002", "100003"]);

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
    throw new CpeAnswerFormatError("Unexpected /api/wlan/wlandbho response (expected MloEnable/DbhoEnable booleans)");
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
  options: {
    includeSmsCounters?: boolean;
    tolerant?: boolean;
    /** A poll that fails still names the model that answered it (say, a router replaced by one the strict reads do not fit). */
    onFailedPollModel?: (model: string, softwareVersion: string | null) => void;
  } = {}
): Promise<GlobalTelemetrySnapshot> {
  // `tolerant` (a model nobody verified): a core part the router answers with an error code is left
  // out and listed in `unavailable`, so one odd endpoint never costs the rest of the poll
  const missing = new Set<TelemetryPart>();
  const part = async (name: TelemetryPart, apiPath: string): Promise<string> => {
    if (!options.tolerant) return await session.get(apiPath);
    try {
      return await session.get(apiPath);
    } catch (err) {
      if (!(err instanceof CpeApiError)) throw err;
      missing.add(name);
      return "";
    }
  };
  // The two answers that name the model, kept apart (in place: every GET still goes out in this order)
  const naming: Array<Promise<string>> = [];
  const names = (answer: Promise<string>): Promise<string> => {
    naming.push(answer);
    return answer;
  };
  const reads = Promise.all([
    part("signal", "/api/device/signal"),
    optionalGet(session, "/api/device/seccellinfo"),
    optionalGet(session, "/api/device/ri"),
    optionalGet(session, "/api/net/cell-info"),
    optionalGet(session, "/api/net/current-plmn"),
    optionalGet(session, "/api/net/net-mode"),
    names(optionalGet(session, "/api/device/information")),
    names(optionalGet(session, "/api/device/basic_information")),
    part("status", "/api/monitoring/status"),
    part("traffic", "/api/monitoring/traffic-statistics"),
    part("month", "/api/monitoring/month_statistics"),
    optionalGet(session, "/api/monitoring/start_date"),
    options.includeSmsCounters ? optionalGet(session, "/api/sms/sms-count") : Promise.resolve(""),
  ]);
  let answers: Awaited<typeof reads>;
  try {
    answers = await reads;
  } catch (err) {
    // Whatever failed, the router may have named its model: wait for those two answers (nothing more is sent)
    if (options.onFailedPollModel) {
      const [info = "", basic = ""] = await Promise.all(naming.map((answer) => answer.catch(() => "")));
      const named = routerModelIn(info, basic);
      if (named) options.onFailedPollModel(named.model, named.softwareVersion);
    }
    throw err;
  }
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
  ] = answers;

  const unavailable = TELEMETRY_PARTS.filter((name) => missing.has(name));
  if (unavailable.length === TELEMETRY_PARTS.length) throw new SectionUnavailableError("Telemetry", null);

  // A model nobody verified whose `seccellinfo` lists no secondary carrier may list them in
  // `net/ca-scell-info` (one more GET, on such a model only: the H168-383 is asked nothing new)
  const sccListed = parseSecondaryCellsXml(secCellXml);
  const caScellXml = options.tolerant && sccListed.lteScc.length === 0 && sccListed.nrScc.length === 0 ? await optionalGet(session, "/api/net/ca-scell-info") : "";

  const rf = parseRfSignalSnapshot({
    signalXml,
    secCellXml,
    caScellXml,
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
      // What the router reports, or "" (the write gate goes by it, so a model is never assumed)
      deviceName: (getXmlTag(deviceInfoXml, "DeviceName") ?? getXmlTag(basicInfoXml, "devicename") ?? "").trim(),
      marketingName: (getXmlTag(basicInfoXml, "spreadname_en") ?? "").trim(),
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
      iccid: deviceTag("Iccid"),
      sensitiveRedacted: false,
    },
    rf,
    bandConfig: {
      networkMode: getXmlTag(netModeXml, "NetworkMode") ?? NETWORK_MODE_AUTO,
      networkBandHex: getXmlTag(netModeXml, "NetworkBand") ?? "",
      lteBandHex,
      activeLteBands,
      ...modeFieldsOf(netModeXml),
    },
    traffic,
    thermal: {
      temperatureCelsius: parsedTemp,
      temperatureSupported: parsedTemp !== null,
      sensors: [],
    },
    sms: parseSmsCountersOrNull(smsCountXml),
    status: hilinkRouterStatus(statusXml),
    ...(options.tolerant ? { unavailable } : {}),
  };
}

/** `networkOption` and `LTEBandOption` of a `net-mode` answer, where it reports them (`BandConfigSnapshot`). */
function modeFieldsOf(netModeXml: string | null): { networkOption?: string; lteBandOption?: string } {
  const option = netModeXml === null ? "" : (getXmlTag(netModeXml, "networkOption")?.trim() ?? "");
  const bandOption = netModeXml === null ? "" : (getXmlTag(netModeXml, "LTEBandOption")?.trim() ?? "");
  return { ...(/^\d{1,2}$/.test(option) ? { networkOption: option } : {}), ...(/^\d{1,2}$/.test(bandOption) ? { lteBandOption: bandOption } : {}) };
}

/**
 * The mode the latest poll saw, for a band lock to write along (`NetModeKeep`): `00` with its
 * `networkOption`, `03` with its `LTEBandOption`; `DEFAULT_NET_MODE_KEEP` when it saw no mode it can
 * name (no poll yet, another code, a field missing), the verified request.
 */
export function netModeKeepOf(bandConfig: BandConfigSnapshot | null | undefined): NetModeKeep {
  const field = (value: string | undefined): "0" | "1" | "2" | null => (value === "0" || value === "1" || value === "2" ? value : null);
  const option = field(bandConfig?.networkOption);
  const bandOption = field(bandConfig?.lteBandOption);
  if (bandConfig?.networkMode === "00" && option !== null) return { networkMode: "00", networkOption: option };
  if (bandConfig?.networkMode === "03" && bandOption !== null) return { networkMode: "03", lteBandOption: bandOption };
  return DEFAULT_NET_MODE_KEEP;
}

/**
 * The battery of a HiLink mobile router, in the `monitoring/status` answer the poll reads anyway
 * (protocol notes A 3.3: `<BatteryStatus>` `1` charging, `0` not; `<BatteryLevel>` a percentage, or
 * `1`–`4` bars on older firmware, worth 25 % each). A router without a battery leaves them empty; a
 * level of `0` says nothing either way and is left out, so a CPE that answers zeros shows no battery.
 */
export function hilinkRouterStatus(statusXml: string): RouterStatusSnapshot | null {
  const tag = (name: string): string => (getXmlTag(statusXml, name) ?? "").trim();
  const level = percentValue(tag("BatteryLevel"));
  const charge = level === null || level === 0 ? null : level <= 4 ? level * 25 : level;
  if (charge === null) return null;
  const status = tag("BatteryStatus");
  const battery: BatteryStatus = { percent: charge, charging: status === "1" ? true : status === "0" ? false : null, temperatureC: null, minutesToFull: null, minutesToEmpty: null };
  return { ...emptyRouterStatus(), battery };
}

/**
 * The model and firmware the router reports (`device/information`, else the model of
 * `device/basic_information`), for a write that must know which router it talks to before it writes
 * anything; `null` when neither names a model. Router error codes are tolerated, a broken session is not.
 */
export async function readRouterModel(session: EphemeralCpeSession): Promise<{ model: string; softwareVersion: string | null } | null> {
  const info = await optionalGet(session, "/api/device/information");
  return routerModelIn(info, "") ?? routerModelIn("", await optionalGet(session, "/api/device/basic_information"));
}

/** The model and firmware `device/information` names, else the model `device/basic_information` names. */
function routerModelIn(infoXml: string, basicXml: string): { model: string; softwareVersion: string | null } | null {
  const model = getXmlTag(infoXml, "DeviceName")?.trim();
  if (model) return { model, softwareVersion: getXmlTag(infoXml, "SoftwareVersion")?.trim() || null };
  const basic = getXmlTag(basicXml, "devicename")?.trim();
  return basic ? { model: basic, softwareVersion: null } : null;
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
export async function fetchTerminalTopology(session: EphemeralCpeSession, options: { tolerant?: boolean } = {}): Promise<TerminalTopologySnapshot> {
  if (options.tolerant) return await fetchHostListTolerant(session);
  const [hostInfoJson, topologyJson] = await Promise.all([
    session.get("/api/system/HostInfo"),
    optionalGet(session, "/api/system/topology"),
  ]);
  return topologySnapshot(parseHostInfoJson(hostInfoJson, { sanitize: false }), summarizeTopologyJson(topologyJson));
}

/**
 * The device list on a model nobody verified (appendix A.10): the H168-383's `system/HostInfo` JSON,
 * else the HiLink XML lists `lan/HostInfo` (wired and Wi-Fi) and `wlan/host-list` (Wi-Fi only), the
 * first one the router answers with a list FengSui reads. None: `SectionUnavailableError`.
 */
async function fetchHostListTolerant(session: EphemeralCpeSession): Promise<TerminalTopologySnapshot> {
  const sources: ReadonlyArray<{ path: string; source: HostListSource | null; parse: (body: string) => TerminalHostEntry[] | null }> = [
    { path: "/api/system/HostInfo", source: null, parse: parseHostInfoJsonList },
    { path: "/api/lan/HostInfo", source: "lan/HostInfo", parse: (body) => parseHostListXml(body, { wifiOnly: false }) },
    { path: "/api/wlan/host-list", source: "wlan/host-list", parse: (body) => parseHostListXml(body, { wifiOnly: true }) },
  ];
  let code: string | null = null;
  // A list that came back unreadable says more about this model than an endpoint it lacks
  let unreadable = false;
  for (const { path, source, parse } of sources) {
    let body: string;
    try {
      body = await session.get(path);
    } catch (err) {
      // Only an endpoint this model lacks moves on; any other code (busy, say) fails the read, as for every section (A.10)
      if (!(err instanceof CpeApiError) || !NOT_HERE_CODES.has(err.code)) throw err;
      code = err.code;
      continue;
    }
    const hosts = parse(body);
    if (hosts === null) {
      unreadable = true;
      continue;
    }
    if (source !== null) return { ...topologySnapshot(hosts, summarizeTopologyJson("")), source };
    return topologySnapshot(hosts, summarizeTopologyJson(await optionalGet(session, "/api/system/topology")));
  }
  throw new SectionUnavailableError("The device list", unreadable ? null : code);
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

export function prepareBandLockPayloads(command: BandLockCommand, keep: NetModeKeep = DEFAULT_NET_MODE_KEEP): {
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
      netModeXml = buildLteBandNetModeXml(command.lteBands, keep);
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

/**
 * Lock 4G LTE (`POST /api/net/net-mode`) and/or 5G NR (`POST /api/net/lock-freq` `lock_mode=3`) bands.
 */
export async function applyBandLock(
  session: EphemeralCpeSession,
  command: BandLockCommand,
  keep: NetModeKeep = DEFAULT_NET_MODE_KEEP
): Promise<PersistedLockState> {
  const { netModeXml, nrXml, appliedLte, appliedNr } = prepareBandLockPayloads(command, keep);

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

/** The router's LTE mask as a lock value: every supported band (or the auto mask) reads as `"all"`. */
function lteLockOf(routerLteBands: ReadonlyArray<number> | null): number[] | "all" {
  if (!routerLteBands || H168_383_LTE_BANDS.every((band) => routerLteBands.includes(band))) return "all";
  const supported = routerLteBands.filter((band) => H168_383_LTE_BANDS.includes(band));
  return supported.length > 0 ? supported : "all";
}

/**
 * The lock state after a band lock. `applied` records only what the command wrote, but the router
 * keeps whatever it did not touch: `POST /api/net/net-mode` (the LTE mask) is sent only with
 * `lteBands`, and `POST /api/net/lock-freq` (NR bands and any cell or frequency lock) only with
 * `nrBands`. A RAT the command left out therefore keeps its earlier lock. `routerLteBands` (the mask
 * telemetry reads back) stands in for the LTE mask when the previous state was a cell lock.
 */
export function mergeBandLockState(
  previous: PersistedLockState,
  command: Pick<BandLockCommand, "lteBands" | "nrBands">,
  applied: PersistedLockState,
  routerLteBands: ReadonlyArray<number> | null
): PersistedLockState {
  const lockFreqWritten = command.nrBands !== undefined;
  // lock-freq still holds the cell or frequency lock; only the LTE mask moved
  if (!lockFreqWritten && previous.mode === "cell_lock") return { ...previous, updatedAtIso: applied.updatedAtIso };
  const lteBands =
    command.lteBands !== undefined ? applied.lteBands : previous.mode === "cell_lock" ? lteLockOf(routerLteBands) : previous.lteBands;
  const nrBands = lockFreqWritten ? applied.nrBands : previous.mode === "band_lock" ? previous.nrBands : [];
  return {
    mode: lteBands === "all" && nrBands.length === 0 ? "unlocked" : "band_lock",
    updatedAtIso: applied.updatedAtIso,
    lteBands,
    nrBands,
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
  session: EphemeralCpeSession,
  keep: NetModeKeep = DEFAULT_NET_MODE_KEEP
): Promise<PersistedLockState> {
  await session.postRaw("/api/net/lock-freq", buildUnlockAllLocksXml());
  await session.postRaw("/api/net/net-mode", buildLteBandNetModeXml("all", keep));
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

/** Why an automatic WAN repair (lock rollback, reconnect) wrote nothing. */
export type WanRepairSkipReason = "wan_up" | "mobile_data_off";

/**
 * Re-read the WAN inside the control session before an automatic repair writes: the decision was
 * taken on telemetry up to one poll old, and switching mobile data off on purpose must never be
 * undone. Unreadable values do not block (the repair only restores the default state).
 */
export async function readWanRepairBlocker(session: EphemeralCpeSession): Promise<WanRepairSkipReason | null> {
  if (getXmlTag(await session.get("/api/monitoring/status"), "ConnectionStatus") === "901") return "wan_up";
  if (getXmlTag(await session.get("/api/dialup/mobile-dataswitch"), "dataswitch") === "0") return "mobile_data_off";
  return null;
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
