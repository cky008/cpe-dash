import net from "node:net";
import {
  type BandConfigSnapshot,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type FirewallSwitchState,
  type GlobalTelemetrySnapshot,
  type HostListSource,
  NOT_HERE_CODES,
  type AntennaModeName,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  SectionUnavailableError,
  type SecurityUpdateCommand,
  type TelemetryPart,
  type TerminalHostEntry,
  type TerminalTopologySnapshot,
  type TrafficTelemetryDto,
  type WanRepairSkipReason,
  topologySnapshot,
  validateSecurityUpdateCommand,
} from "../../cpe-domain.ts";
import type { EphemeralCpeSession } from "../../protocols/hilink/client.ts";
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
} from "../../protocols/hilink/parsers.ts";
import { parseSmsCountersOrNull } from "../../protocols/hilink/sms.ts";
import { getXmlTag } from "../../protocols/hilink/xml.ts";
import { H168_383_LTE_BANDS, hexMaskToBands, parseBandNumber } from "../../rf-bounds.ts";
import { type BatteryStatus, type RouterStatusSnapshot, emptyRouterStatus, percentValue } from "../../router-status.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import { formatBytesBinary, formatRateBitsPerSec } from "../../units.ts";
import {
  DEFAULT_NET_MODE_KEEP,
  NETWORK_MODE_AUTO,
  type NetModeKeep,
  buildLteBandNetModeXml,
  buildLteCellLockXml,
  buildNrBandLockXml,
  buildNrCellLockXml,
  buildUnlockAllLocksXml,
} from "./band-lock.ts";

/**
 * The requests FengSui sends to a Huawei HiLink router for its reads and for the H168-383's verified
 * writes: which endpoints, in which order, and what is made of the answers. Everything here was
 * verified on the H168-383 (firmware 4.4.0.1) and must reach it unchanged, byte for byte; a model
 * nobody verified is read with the same requests the tolerant way (`tolerant`), and written through
 * the generic requests of `src/protocols/hilink/generic-writes.ts` instead.
 */

/** The HiLink poll's core parts (a poll that has none of them failed). */
const TELEMETRY_PARTS: ReadonlyArray<TelemetryPart> = ["signal", "status", "traffic", "month"];

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
