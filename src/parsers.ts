import { decomposeLteEci } from "./band-lock.ts";
import { maskMacAddress, sanitizeFreeText, sanitizeIpToken } from "./sanitize.ts";
import { isResponseDocument } from "./device-profile.ts";
import { getXmlBlocks, getXmlTag } from "./xml.ts";

export { formatBytesBinary, formatRateBitsPerSec } from "./units.ts";

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

export interface TrafficSnapshot {
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
  downloadBps: number;
  uploadBps: number;
  todayUsedBytes: bigint;
  todayDurationSec: number;
  monthDownloadBytes: bigint;
  monthUploadBytes: bigint;
  monthTotalBytes: bigint;
  monthDurationSec: number;
  monthLastClearDate: string;
  sessionConnectTimeSec: number;
  sessionDownloadBytes: bigint;
  sessionUploadBytes: bigint;
  totalDownloadBytes: bigint;
  totalUploadBytes: bigint;
  totalUsedBytes: bigint;
  totalConnectTimeSec: number;
  billingStartDay: number | null;
  dataLimitRaw: string;
  monthThresholdPercent: number | null;
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

const MAX_FIELD_LEN = 4096;
const MAX_JSON_LEN = 512 * 1024;

/**
 * Extract a finite leading numeric scalar from unit-suffixed strings (`"-88dBm"`, `"100MHz"`, `"--"`).
 */
export function parseNumberWithUnit(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.slice(0, 64).trim();
  if (!trimmed || trimmed === "--") return null;
  const match = trimmed.match(/^[+-]?\d+(?:\.\d+)?/);
  if (!match?.[0]) return null;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIntOrNull(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.slice(0, 32).trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBigIntZero(raw: string | null | undefined): bigint {
  if (!raw) return 0n;
  const trimmed = raw.slice(0, 40).trim();
  if (!/^\d+$/.test(trimmed)) return 0n;
  return BigInt(trimmed);
}

/**
 * Parse H168-383 carrier aggregation banner (`"20MHz@300(B1) + 20MHz@1850(B3) + 100MHz@650000(N78)"`).
 */
export function parseCaBandBanner(banner: string | null | undefined): CaBannerComponent[] {
  if (!banner) return [];
  const bounded = banner.slice(0, MAX_FIELD_LEN).trim();
  if (!bounded) return [];
  const parts = bounded.split("+");
  const out: CaBannerComponent[] = [];
  for (const rawPart of parts) {
    const part = rawPart.trim();
    const match = part.match(/^(\d+(?:\.\d+)?)MHz@(\d+)\(([BNbn]\d{1,3})\)$/);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const band = match[3].toUpperCase();
    out.push({
      bandwidthMhz: Number.parseFloat(match[1]),
      arfcn: Number.parseInt(match[2], 10),
      band,
      rat: band.startsWith("N") ? "NR" : "LTE",
    });
  }
  return out;
}

/**
 * Parse MCS codeword tokens (`"mcsUpCarrier1:27@256QAM"`, `"NRmcsDownCarrier1Code0:10@16QAM NRmcsDownCarrier1Code1:0"`).
 */
export function parseMcsEntries(raw: string | null | undefined): McsCodewordMetric[] {
  if (!raw) return [];
  const bounded = raw.slice(0, MAX_FIELD_LEN).trim();
  if (!bounded) return [];
  const tokens = bounded.split(/\s+/);
  const out: McsCodewordMetric[] = [];
  for (const token of tokens) {
    const colonIdx = token.indexOf(":");
    if (colonIdx <= 0) continue;
    const label = token.slice(0, colonIdx);
    const rest = token.slice(colonIdx + 1);
    const atIdx = rest.indexOf("@");
    const indexStr = atIdx >= 0 ? rest.slice(0, atIdx) : rest;
    const modulation = atIdx >= 0 && rest.slice(atIdx + 1) ? rest.slice(atIdx + 1) : null;
    const index = parseIntOrNull(indexStr);
    if (index === null) continue;
    out.push({ label, index, modulation });
  }
  return out;
}

/**
 * Parse Huawei `<txpower>` / `<nrtxpower>` string (`"PPusch:12dBm PPucch:-9dBm PSrs:0dBm PPrach:-3dBm"`).
 */
export function parseTxPowerMetrics(raw: string | null | undefined): TxPowerMetrics {
  const result: TxPowerMetrics = {
    puschDbm: null,
    pucchDbm: null,
    srsDbm: null,
    prachDbm: null,
  };
  if (!raw) return result;
  const bounded = raw.slice(0, MAX_FIELD_LEN).trim();
  if (!bounded) return result;
  for (const token of bounded.split(/\s+/)) {
    const colonIdx = token.indexOf(":");
    if (colonIdx <= 0) continue;
    const key = token.slice(0, colonIdx).toLowerCase();
    const val = parseNumberWithUnit(token.slice(colonIdx + 1));
    if (key === "ppusch") result.puschDbm = val;
    else if (key === "ppucch") result.pucchDbm = val;
    else if (key === "psrs") result.srsDbm = val;
    else if (key === "pprach") result.prachDbm = val;
  }
  return result;
}

function parseSccCsvRows(csv: string | null | undefined, rat: "LTE" | "NR"): SecondaryCellEntry[] {
  if (!csv) return [];
  const bounded = csv.slice(0, MAX_FIELD_LEN).trim();
  if (!bounded) return [];
  const out: SecondaryCellEntry[] = [];
  for (const rawRow of bounded.split(";")) {
    const row = rawRow.trim();
    if (!row) continue;
    const cols = row.split(",");
    if (cols.length < 8) continue;
    out.push({
      rat,
      arfcn: parseIntOrNull(cols[0]),
      band: (cols[1] ?? "").trim() || "--",
      bandwidthMhz: parseNumberWithUnit(cols[2]),
      pci: parseIntOrNull(cols[3]),
      rsrpDbm: parseNumberWithUnit(cols[4]),
      rsrqDb: parseNumberWithUnit(cols[5]),
      rssiDbm: parseNumberWithUnit(cols[6]),
      sinrDb: parseNumberWithUnit(cols[7]),
    });
  }
  return out;
}

/**
 * `GET /api/net/ca-scell-info` (some HiLink models instead of `device/seccellinfo`): one `<scell>` per
 * LTE secondary carrier, with its band number, channel, bandwidth, PCI and readings (protocol notes,
 * library B). Read only on a model nobody verified whose `seccellinfo` lists none.
 */
export function parseCaScellInfoXml(xml: string): SecondaryCellEntry[] {
  return getXmlBlocks(xml.slice(0, MAX_FIELD_LEN), "scell")
    .slice(0, 8)
    .map((block): SecondaryCellEntry => {
      const band = parseIntOrNull(getXmlTag(block, "scell_band"));
      return {
        rat: "LTE",
        arfcn: parseIntOrNull(getXmlTag(block, "scell_earfcn")),
        band: band === null ? "--" : `B${band}`,
        bandwidthMhz: parseNumberWithUnit(getXmlTag(block, "scell_dl_bw")),
        pci: parseIntOrNull(getXmlTag(block, "scell_pci")),
        rsrpDbm: parseNumberWithUnit(getXmlTag(block, "scell_rsrp")),
        rsrqDb: parseNumberWithUnit(getXmlTag(block, "scell_rsrq")),
        rssiDbm: parseNumberWithUnit(getXmlTag(block, "scell_rssi")),
        sinrDb: parseNumberWithUnit(getXmlTag(block, "scell_sinr")),
      };
    });
}

/**
 * Parse `GET /api/device/seccellinfo` 8-column CSV lists (`earfcn,band,bandwidth,pci,rsrp,rsrq,rssi,sinr;`).
 */
export function parseSecondaryCellsXml(xml: string): {
  lteScc: SecondaryCellEntry[];
  nrScc: SecondaryCellEntry[];
} {
  return {
    lteScc: parseSccCsvRows(getXmlTag(xml, "lteseccell_list"), "LTE"),
    nrScc: parseSccCsvRows(getXmlTag(xml, "nrseccell_list"), "NR"),
  };
}

function parseNbrCsvRows(csv: string | null | undefined, rat: "LTE" | "NR"): NeighborCellEntry[] {
  if (!csv) return [];
  const bounded = csv.slice(0, MAX_FIELD_LEN * 4).trim();
  if (!bounded) return [];
  const out: NeighborCellEntry[] = [];
  for (const rawRow of bounded.split(";")) {
    const row = rawRow.trim();
    if (!row) continue;
    const cols = row.split(",");
    if (cols.length < 7) continue;
    out.push({
      rat,
      arfcn: parseIntOrNull(cols[0]),
      band: (cols[1] ?? "").trim() || "--",
      pci: parseIntOrNull(cols[2]),
      rsrpDbm: parseNumberWithUnit(cols[3]),
      rsrqDb: parseNumberWithUnit(cols[4]),
      rssiDbm: parseNumberWithUnit(cols[5]),
      sinrDb: parseNumberWithUnit(cols[6]),
    });
  }
  return out;
}

/**
 * Parse `GET /api/device/nbrcellinfo` 7-column CSV lists (`earfcn,band,pci,rsrp,rsrq,rssi,sinr;`).
 */
export function parseNeighborCellsXml(xml: string): {
  lteNeighbors: NeighborCellEntry[];
  nrNeighbors: NeighborCellEntry[];
} {
  return {
    lteNeighbors: parseNbrCsvRows(getXmlTag(xml, "nbrcell_ltelist"), "LTE"),
    nrNeighbors: parseNbrCsvRows(getXmlTag(xml, "nbrcell_nrlist"), "NR"),
  };
}

/**
 * Parse a unified RF + 3CA + MIMO + MCS + TxPower snapshot while verifying hex/decimal
 * mathematical equivalence and optionally redacting raw location-sensitive identifiers.
 */
export function parseRfSignalSnapshot(params: {
  signalXml: string;
  secCellXml?: string;
  /** `net/ca-scell-info`, used when `secCellXml` lists no secondary carrier. */
  caScellXml?: string;
  riXml?: string;
  cellInfoXml?: string;
  plmnXml?: string;
  redactIdentifiers?: boolean;
}): RfSignalSnapshot {
  const { signalXml, secCellXml = "", riXml = "", cellInfoXml = "", plmnXml = "" } = params;
  const redact = params.redactIdentifiers !== false;

  const caBannerRaw = getXmlTag(signalXml, "band") ?? "";
  const caCarriers = parseCaBandBanner(caBannerRaw);
  const listed = parseSecondaryCellsXml(secCellXml);
  const fromCaScell = listed.lteScc.length === 0 && listed.nrScc.length === 0 && params.caScellXml ? parseCaScellInfoXml(params.caScellXml) : [];
  const lteScc = fromCaScell.length > 0 ? fromCaScell : listed.lteScc;
  const { nrScc } = listed;

  const pccDlBw = parseNumberWithUnit(getXmlTag(signalXml, "dlbandwidth"));
  const fallbackCount = 1 + lteScc.length + nrScc.length;
  const caComponentCount = caCarriers.length > 0 ? caCarriers.length : fallbackCount;

  const totalAggregatedBandwidthMhz =
    caCarriers.length > 0
      ? caCarriers.reduce((acc, c) => acc + c.bandwidthMhz, 0)
      : (pccDlBw ?? 0) +
        lteScc.reduce((acc, s) => acc + (s.bandwidthMhz ?? 0), 0) +
        nrScc.reduce((acc, s) => acc + (s.bandwidthMhz ?? 0), 0);

  const cellIdDecRaw = (getXmlTag(signalXml, "cell_id") ?? "").trim();
  const eNodeBRaw = (getXmlTag(signalXml, "enodeb_id") ?? "").trim();
  const tacDecRaw = (getXmlTag(signalXml, "tac") ?? "").trim();
  const cellInfoHexRaw = (getXmlTag(cellInfoXml, "cellinfo") ?? "").trim();
  const lacHexRaw = (getXmlTag(cellInfoXml, "lac") ?? "").trim();

  let eciDecimalMatchesHex: boolean | null = null;
  let eNodeBDerivationMatchesTag: boolean | null = null;
  let sectorIdBitWidthOk: boolean | null = null;

  if (/^\d+$/.test(cellIdDecRaw)) {
    const cellIdNum = Number.parseInt(cellIdDecRaw, 10);
    if (cellIdNum >= 0 && cellIdNum <= 0x0fffffff) {
      const decomposed = decomposeLteEci(cellIdNum);
      sectorIdBitWidthOk = decomposed.sectorId >= 0 && decomposed.sectorId <= 255;
      if (/^\d+$/.test(eNodeBRaw)) {
        eNodeBDerivationMatchesTag = decomposed.eNodeBId === Number.parseInt(eNodeBRaw, 10);
      }
      if (/^[0-9a-fA-F]{1,8}$/.test(cellInfoHexRaw)) {
        eciDecimalMatchesHex = cellIdNum === Number.parseInt(cellInfoHexRaw, 16);
      }
    }
  }

  let tacDecimalMatchesHex: boolean | null = null;
  if (/^\d+$/.test(tacDecRaw) && /^[0-9a-fA-F]{1,8}$/.test(lacHexRaw)) {
    tacDecimalMatchesHex = Number.parseInt(tacDecRaw, 10) === Number.parseInt(lacHexRaw, 16);
  }

  return {
    operatorName: getXmlTag(plmnXml, "FullName") ?? getXmlTag(plmnXml, "ShortName") ?? "",
    plmnNumeric: getXmlTag(plmnXml, "Numeric") ?? getXmlTag(signalXml, "plmn") ?? "",
    ratCode: getXmlTag(plmnXml, "Rat") ?? getXmlTag(signalXml, "mode") ?? "",
    caBannerRaw,
    caCarriers,
    caActive: caComponentCount > 1,
    caComponentCount,
    totalAggregatedBandwidthMhz,
    pccBand: getXmlTag(signalXml, "bandInfo") ?? caCarriers[0]?.band ?? "",
    pci: parseIntOrNull(getXmlTag(signalXml, "pci")),
    earfcnRaw: getXmlTag(signalXml, "earfcn") ?? "",
    nrArfcnRaw: getXmlTag(signalXml, "nrearfcn") ?? "",
    lteUlBandwidthMhz: parseNumberWithUnit(getXmlTag(signalXml, "ulbandwidth")),
    lteDlBandwidthMhz: pccDlBw,
    nrUlBandwidthMhz: parseNumberWithUnit(getXmlTag(signalXml, "nrulbandwidth")),
    nrDlBandwidthMhz: parseNumberWithUnit(getXmlTag(signalXml, "nrdlbandwidth")),
    lteRsrpDbm: parseNumberWithUnit(getXmlTag(signalXml, "rsrp")),
    lteRsrqDb: parseNumberWithUnit(getXmlTag(signalXml, "rsrq")),
    lteRssiDbm: parseNumberWithUnit(getXmlTag(signalXml, "rssi")),
    lteSinrDb: parseNumberWithUnit(getXmlTag(signalXml, "sinr")),
    nrRsrpDbm: parseNumberWithUnit(getXmlTag(signalXml, "nrrsrp")) ?? nrScc[0]?.rsrpDbm ?? null,
    nrRsrqDb: parseNumberWithUnit(getXmlTag(signalXml, "nrrsrq")) ?? nrScc[0]?.rsrqDb ?? null,
    nrSinrDb: parseNumberWithUnit(getXmlTag(signalXml, "nrsinr")) ?? nrScc[0]?.sinrDb ?? null,
    transmissionMode: getXmlTag(signalXml, "transmode") ?? "",
    lteMimoRank: parseIntOrNull(getXmlTag(riXml, "ri")),
    nrMimoRank: parseIntOrNull(getXmlTag(signalXml, "nrrank")),
    lteCqi0: parseIntOrNull(getXmlTag(signalXml, "cqi0")),
    lteCqi1: parseIntOrNull(getXmlTag(signalXml, "cqi1")),
    nrCqi0: parseIntOrNull(getXmlTag(signalXml, "nrcqi0")),
    nrCqi1: parseIntOrNull(getXmlTag(signalXml, "nrcqi1")),
    lteUlMcs: parseMcsEntries(getXmlTag(signalXml, "ul_mcs")),
    lteDlMcs: parseMcsEntries(getXmlTag(signalXml, "dl_mcs")),
    nrUlMcs: parseMcsEntries(getXmlTag(signalXml, "nrulmcs")),
    nrDlMcs: parseMcsEntries(getXmlTag(signalXml, "nrdlmcs")),
    lteTxPower: parseTxPowerMetrics(getXmlTag(signalXml, "txpower")),
    nrTxPower: parseTxPowerMetrics(getXmlTag(signalXml, "nrtxpower")),
    lteScc,
    nrScc,
    cellIdDisplay: redact ? (cellIdDecRaw ? "<REDACTED:134217758>" : "") : cellIdDecRaw,
    eNodeBDisplay: redact ? (eNodeBRaw ? "<REDACTED:0524288>" : "") : eNodeBRaw,
    tacDisplay: redact ? (tacDecRaw ? "<REDACTED:10001>" : "") : tacDecRaw,
    identityVerification: {
      hasCellIdDecimal: Boolean(cellIdDecRaw),
      hasCellInfoHex: Boolean(cellInfoHexRaw),
      eciDecimalMatchesHex,
      tacDecimalMatchesHex,
      eNodeBDerivationMatchesTag,
      sectorIdBitWidthOk,
    },
    wcdma: wcdmaSignal(signalXml),
    rrcConnected: null,
    qci: null,
    ulMimoLayers: null,
  };
}

/**
 * The 3G serving cell of `device/signal` (`<rscp>` dBm, `<ecio>` dB, `<sc>` the scrambling code): only
 * when the router reports an RSCP or Ec/Io in range, so a 4G or 5G answer with empty tags gives `null`.
 */
export function wcdmaSignal(signalXml: string): WcdmaSignal | null {
  const rscp = parseNumberWithUnit(getXmlTag(signalXml, "rscp"));
  const ecio = parseNumberWithUnit(getXmlTag(signalXml, "ecio"));
  const rscpDbm = rscp !== null && rscp < 0 && rscp >= -140 ? rscp : null;
  const ecioDb = ecio !== null && ecio <= 0 && ecio >= -30 ? ecio : null;
  if (rscpDbm === null && ecioDb === null) return null;
  const sc = parseIntOrNull(getXmlTag(signalXml, "sc"));
  return { rscpDbm, ecioDb, psc: sc !== null && sc >= 0 && sc <= 511 ? sc : null };
}

/**
 * Parse H168-383 dual-period traffic statistics (`traffic-statistics` + `month_statistics` + `start_date`).
 */
export function parseTrafficSnapshot(params: {
  trafficXml: string;
  monthXml: string;
  startDateXml?: string;
}): TrafficSnapshot {
  const { trafficXml, monthXml, startDateXml = "" } = params;
  const dlRateBytes = parseIntOrNull(getXmlTag(trafficXml, "CurrentDownloadRate")) ?? 0;
  const ulRateBytes = parseIntOrNull(getXmlTag(trafficXml, "CurrentUploadRate")) ?? 0;

  const monthDownloadBytes = parseBigIntZero(getXmlTag(monthXml, "CurrentMonthDownload"));
  const monthUploadBytes = parseBigIntZero(getXmlTag(monthXml, "CurrentMonthUpload"));
  const monthTotalBytes = monthDownloadBytes + monthUploadBytes;

  const totalDownloadBytes = parseBigIntZero(getXmlTag(trafficXml, "TotalDownload"));
  const totalUploadBytes = parseBigIntZero(getXmlTag(trafficXml, "TotalUpload"));
  const rawTotalSum = totalDownloadBytes + totalUploadBytes;

  return {
    downloadBytesPerSec: dlRateBytes,
    uploadBytesPerSec: ulRateBytes,
    downloadBps: dlRateBytes * 8,
    uploadBps: ulRateBytes * 8,
    todayUsedBytes: parseBigIntZero(getXmlTag(monthXml, "CurrentDayUsed")),
    todayDurationSec: parseIntOrNull(getXmlTag(monthXml, "CurrentDayDuration")) ?? 0,
    monthDownloadBytes,
    monthUploadBytes,
    monthTotalBytes,
    monthDurationSec: parseIntOrNull(getXmlTag(monthXml, "MonthDuration")) ?? 0,
    monthLastClearDate: getXmlTag(monthXml, "MonthLastClearTime") ?? "",
    sessionConnectTimeSec: parseIntOrNull(getXmlTag(trafficXml, "CurrentConnectTime")) ?? 0,
    sessionDownloadBytes: parseBigIntZero(getXmlTag(trafficXml, "CurrentDownload")),
    sessionUploadBytes: parseBigIntZero(getXmlTag(trafficXml, "CurrentUpload")),
    totalDownloadBytes,
    totalUploadBytes,
    totalUsedBytes: rawTotalSum >= monthTotalBytes ? rawTotalSum : monthTotalBytes,
    totalConnectTimeSec: parseIntOrNull(getXmlTag(trafficXml, "TotalConnectTime")) ?? 0,
    billingStartDay: parseIntOrNull(getXmlTag(startDateXml, "StartDay")),
    dataLimitRaw: getXmlTag(startDateXml, "DataLimit") ?? "",
    monthThresholdPercent: parseIntOrNull(getXmlTag(startDateXml, "MonthThreshold")),
  };
}

function classifyAccessMedium(
  interfaceType: string,
  ethernetSpeed: number | null,
  phyType: number | null,
  frequency: string
): TerminalAccessMedium {
  if (interfaceType.toLowerCase() === "ethernet") {
    const speed = ethernetSpeed && ethernetSpeed > 0 ? ethernetSpeed : phyType ?? 0;
    if (speed >= 1000) return "LAN_1000M";
    if (speed === 100) return "LAN_100M";
    return "LAN_OTHER";
  }
  const freqLower = frequency.toLowerCase();
  if (freqLower.startsWith("5ghz")) return "WIFI_5G";
  if (freqLower.startsWith("2.4ghz")) return "WIFI_2_4G";
  return "WIFI_OTHER";
}

function asString(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  return typeof val === "string" ? val.trim() : "";
}

function asNumberOrNull(obj: Record<string, unknown>, key: string): number | null {
  const val = obj[key];
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") return parseIntOrNull(val);
  return null;
}

function asBool(obj: Record<string, unknown>, key: string): boolean {
  const val = obj[key];
  return val === true || val === 1 || val === "1" || val === "true";
}

/**
 * Parse `GET /api/system/HostInfo` JSON array into typed terminal records with medium classification
 * and automatic MAC / hostname / IPv6 sanitization.
 */
export function parseHostInfoJson(
  rawJson: string,
  options: { sanitize?: boolean } = {}
): TerminalHostEntry[] {
  if (!rawJson || rawJson.length > MAX_JSON_LEN) return [];
  const sanitize = options.sanitize !== false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: TerminalHostEntry[] = [];
  let seq = 1;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    out.push(hostFromRecord(item as Record<string, unknown>, seq++, sanitize));
  }
  return out;
}

/** One host of a list, from the field names of the H168-383's `system/HostInfo`. */
function hostFromRecord(rec: Record<string, unknown>, idx: number, sanitize: boolean): TerminalHostEntry {
  const rawMac = asString(rec, "MACAddress");
  const rawActual = asString(rec, "ActualName");
  const rawHost = asString(rec, "HostName");
  const interfaceType = asString(rec, "InterfaceType");
  const layer2Interface = asString(rec, "Layer2Interface");
  const frequency = asString(rec, "Frequency");
  const ethernetSpeed = asNumberOrNull(rec, "EthernetSpeed");
  const phyType = asNumberOrNull(rec, "PhyType");
  const wifiRate = asNumberOrNull(rec, "rate");
  const rssi = asNumberOrNull(rec, "rssi");

  const medium = classifyAccessMedium(interfaceType, ethernetSpeed, phyType, frequency);
  const negotiatedRateMbps =
    interfaceType.toLowerCase() === "ethernet"
      ? (ethernetSpeed && ethernetSpeed > 0 ? ethernetSpeed : phyType)
      : (wifiRate && wifiRate > 0 ? wifiRate : null);

  const rawIpv4 = asString(rec, "IPAddress");
  const rawIpv6 = asString(rec, "IPv6Address");
  const ipv6Parts = rawIpv6
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((ip) => (sanitize ? sanitizeIpToken(ip) : ip));

  const displayName = sanitize
    ? `lan-client-${String(idx).padStart(2, "0")}`
    : sanitizeFreeText(rawActual || rawHost || `client-${idx}`);

  return {
    macAddress: sanitize ? maskMacAddress(rawMac || "00:00:5E:00:53:01", idx) : rawMac,
    displayName,
    active: asBool(rec, "Active"),
    interfaceType,
    layer2Interface,
    frequency,
    medium,
    negotiatedRateMbps,
    rssi: interfaceType.toLowerCase() === "wireless" ? rssi : null,
    ipv4Address: sanitize ? sanitizeIpToken(rawIpv4) : rawIpv4,
    ipv6Addresses: ipv6Parts,
    ipv6Active: asBool(rec, "V6Active"),
    addressSource: asString(rec, "AddressSource"),
    leaseTimeRemainingSec: asNumberOrNull(rec, "LeaseTime"),
    associatedTimeSec: asNumberOrNull(rec, "AssociatedTime"),
    isLocalDevice: asBool(rec, "IsLocalDevice"),
  };
}

/** `system/HostInfo` on a model nobody verified: `null` unless the answer is a JSON list. */
export function parseHostInfoJsonList(rawJson: string): TerminalHostEntry[] | null {
  if (!rawJson || rawJson.length > MAX_JSON_LEN) return null;
  try {
    if (!Array.isArray(JSON.parse(rawJson))) return null;
  } catch {
    return null;
  }
  return parseHostInfoJson(rawJson, { sanitize: false });
}

/** Host fields read from the XML lists, by their `system/HostInfo` names (tags match whatever their case). */
const HOST_XML_FIELDS = ["MACAddress", "IPAddress", "IPv6Address", "HostName", "ActualName", "Active", "InterfaceType", "Frequency", "LeaseTime", "AssociatedTime", "AddressSource"] as const;

/**
 * The XML device lists of other HiLink models (`lan/HostInfo`, `wlan/host-list`, appendix A.10):
 * `<Hosts><Host>…</Host></Hosts>`, possibly one `<Host>` or none. The field names inside a host are
 * not documented; FengSui reads the `system/HostInfo` names whatever their case (our inference, not
 * verified on a device). `wifiOnly` lists associated Wi-Fi clients, so they count as active Wi-Fi.
 * A host without a MAC address is left out; `null` when the answer is no list, or holds hosts none
 * of which reads (never shown as "no devices").
 */
export function parseHostListXml(xml: string, opts: { wifiOnly: boolean }): TerminalHostEntry[] | null {
  if (!xml || !isResponseDocument(xml)) return null;
  const blocks = getXmlBlocks(xml, "Host");
  const hosts: TerminalHostEntry[] = [];
  for (const block of blocks) {
    const rec: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of HOST_XML_FIELDS) {
      const value = getXmlTag(block, field);
      if (value !== null) rec[field] = value;
    }
    if (opts.wifiOnly) {
      rec["InterfaceType"] ??= "Wireless";
      rec["Active"] ??= "1";
    }
    if (typeof rec["MACAddress"] !== "string" || rec["MACAddress"] === "") continue;
    hosts.push(hostFromRecord(rec, hosts.length + 1, false));
  }
  return blocks.length > 0 && hosts.length === 0 ? null : hosts;
}

/**
 * Summarize `GET /api/system/topology` hierarchical JSON tree with bounded recursion depth.
 */
export function summarizeTopologyJson(rawJson: string): TopologySummary {
  const summary: TopologySummary = {
    topLevelNodes: 0,
    totalActiveNodes: 0,
    meshChildNodes: 0,
    ethernetNodes: 0,
    wirelessNodes: 0,
  };
  if (!rawJson || rawJson.length > MAX_JSON_LEN) return summary;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return summary;
  }
  if (!Array.isArray(parsed)) return summary;

  summary.topLevelNodes = parsed.length;

  const visit = (nodes: ReadonlyArray<unknown>, depth: number): void => {
    if (depth > 8) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const rec = node as Record<string, unknown>;
      if (asBool(rec, "Active")) {
        summary.totalActiveNodes++;
      }
      if (depth > 0) {
        summary.meshChildNodes++;
      }
      const accessType = asString(rec, "AccessType").toLowerCase();
      if (accessType === "ethernet") summary.ethernetNodes++;
      else if (accessType === "wireless") summary.wirelessNodes++;

      const children = rec["ConnectedDevices"];
      if (Array.isArray(children) && children.length > 0) {
        visit(children, depth + 1);
      }
    }
  };

  visit(parsed, 0);
  return summary;
}
