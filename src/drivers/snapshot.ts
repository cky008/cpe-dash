import type { GlobalTelemetrySnapshot, NeighborScanSnapshot, TelemetryPart, TrafficTelemetryDto } from "../cpe-domain.ts";
import type { DeviceProbeResult, ProbeOrigin } from "../device-profile.ts";
import type { CaBannerComponent, NeighborCellEntry, RfSignalSnapshot, SecondaryCellEntry } from "../parsers.ts";
import { formatBytesBinary, formatRateBitsPerSec } from "../units.ts";
import type { DriverCarrier, DriverCell, DriverIdentity, DriverNeighbour, DriverTelemetry } from "./types.ts";

/**
 * A driver family's readings in the snapshot shapes the HiLink stack produces, laid out the way
 * the H168-383 lays them out: the primary carrier first, the NR leg of EN-DC as the first NR
 * secondary cell, `DL:<channel>` for the LTE channel, band labels `B3` / `N78`. What the router did
 * not report stays empty or `null`, and parts it has no counters for are listed in `unavailable`.
 */

/** HiLink's connection codes, which the snapshot's consumers read (`901` connected, `902` not). */
const CONNECTED = "901";
const DISCONNECTED = "902";

function label(rat: "LTE" | "NR", band: number | null): string {
  return band === null ? "--" : `${rat === "LTE" ? "B" : "N"}${band}`;
}

function component(rat: "LTE" | "NR", cell: Pick<DriverCell, "band" | "arfcn" | "bandwidthMhz">): CaBannerComponent | null {
  if (cell.band === null || cell.arfcn === null || cell.bandwidthMhz === null) return null;
  return { rat, band: label(rat, cell.band), arfcn: cell.arfcn, bandwidthMhz: cell.bandwidthMhz };
}

function secondary(rat: "LTE" | "NR", cell: Omit<DriverCarrier, "rat">): SecondaryCellEntry {
  return {
    rat,
    arfcn: cell.arfcn,
    band: label(rat, cell.band),
    bandwidthMhz: cell.bandwidthMhz,
    pci: cell.pci,
    rsrpDbm: cell.rsrpDbm,
    rsrqDb: cell.rsrqDb,
    rssiDbm: cell.rssiDbm,
    sinrDb: cell.sinrDb,
  };
}

function mcs(label: string, index: number | null): Array<{ label: string; index: number; modulation: string | null }> {
  return index === null ? [] : [{ label, index, modulation: null }];
}

const NO_TX_POWER = { puschDbm: null, pucchDbm: null, srsDbm: null, prachDbm: null };

/** The eNodeB / gNodeB of a cell identity (28-bit ECI: 20 + 8 bits; NR NCI: 24 + 12 bits). */
function nodeOf(cellId: string | null, rat: "LTE" | "NR"): string {
  if (cellId === null || !/^\d{1,11}$/.test(cellId)) return "";
  const id = BigInt(cellId);
  return (rat === "LTE" ? id >> 8n : id >> 12n).toString(10);
}

export function driverRfSnapshot(t: DriverTelemetry): RfSignalSnapshot {
  const sa = t.mode === "SA" || (t.nr !== null && t.lte === null);
  const lte = sa ? null : t.lte;
  const nr = t.nr;
  const primary = sa ? nr : lte;
  const primaryRat = sa ? "NR" : "LTE";
  const lteScc: SecondaryCellEntry[] = [];
  const nrScc: SecondaryCellEntry[] = [];
  // EN-DC: the NR leg is the first NR secondary cell, as the H168-383 reports it
  if (!sa && nr !== null) nrScc.push(secondary("NR", nr));
  for (const carrier of t.carriers) (carrier.rat === "LTE" ? lteScc : nrScc).push(secondary(carrier.rat, carrier));

  const components: CaBannerComponent[] = [];
  const pcc = primary ? component(primaryRat, primary) : null;
  if (pcc) {
    components.push(pcc);
    for (const carrier of t.carriers.filter((c) => c.rat === "LTE")) {
      const c = component("LTE", carrier);
      if (c) components.push(c);
    }
    if (!sa && nr !== null) {
      const c = component("NR", nr);
      if (c) components.push(c);
    }
    for (const carrier of t.carriers.filter((c) => c.rat === "NR")) {
      const c = component("NR", carrier);
      if (c) components.push(c);
    }
  }
  const sccCount = lteScc.length + nrScc.length;
  const componentCount = components.length > 0 ? components.length : primary ? 1 + sccCount : 0;
  const totalBandwidth =
    components.length > 0
      ? components.reduce((sum, c) => sum + c.bandwidthMhz, 0)
      : (primary?.bandwidthMhz ?? 0) + [...lteScc, ...nrScc].reduce((sum, c) => sum + (c.bandwidthMhz ?? 0), 0);
  const servingId = primary?.cellId ?? null;

  return {
    operatorName: t.operatorName ?? "",
    plmnNumeric: t.plmn ?? "",
    ratCode: t.mode ?? "",
    caBannerRaw: components.map((c) => `${c.bandwidthMhz}MHz@${c.arfcn}(${c.band})`).join(" + "),
    caCarriers: components,
    caActive: componentCount > 1,
    caComponentCount: componentCount,
    totalAggregatedBandwidthMhz: totalBandwidth,
    pccBand: primary?.band !== null && primary?.band !== undefined ? label(primaryRat, primary.band) : "",
    pci: primary?.pci ?? null,
    earfcnRaw: lte?.arfcn !== null && lte?.arfcn !== undefined ? `DL:${lte.arfcn}` : "",
    nrArfcnRaw: nr?.arfcn !== null && nr?.arfcn !== undefined ? String(nr.arfcn) : "",
    lteUlBandwidthMhz: null,
    lteDlBandwidthMhz: lte?.bandwidthMhz ?? null,
    nrUlBandwidthMhz: null,
    nrDlBandwidthMhz: nr?.bandwidthMhz ?? null,
    lteRsrpDbm: lte?.rsrpDbm ?? null,
    lteRsrqDb: lte?.rsrqDb ?? null,
    lteRssiDbm: lte?.rssiDbm ?? null,
    lteSinrDb: lte?.sinrDb ?? null,
    nrRsrpDbm: nr?.rsrpDbm ?? null,
    nrRsrqDb: nr?.rsrqDb ?? null,
    nrSinrDb: nr?.sinrDb ?? null,
    transmissionMode: "",
    lteMimoRank: lte?.mimoLayers ?? null,
    nrMimoRank: nr?.mimoLayers ?? null,
    lteCqi0: lte?.cqi ?? null,
    lteCqi1: null,
    nrCqi0: nr?.cqi ?? null,
    nrCqi1: null,
    lteUlMcs: mcs("mcsUpCarrier1", lte?.ulMcs ?? null),
    lteDlMcs: mcs("mcsDownCarrier1Code0", lte?.dlMcs ?? null),
    nrUlMcs: mcs("NRmcsUpCarrier1", nr?.ulMcs ?? null),
    nrDlMcs: mcs("NRmcsDownCarrier1Code0", nr?.dlMcs ?? null),
    lteTxPower: { ...NO_TX_POWER },
    nrTxPower: { ...NO_TX_POWER },
    lteScc,
    nrScc,
    cellIdDisplay: servingId ?? "",
    eNodeBDisplay: nodeOf(servingId, primaryRat),
    tacDisplay: primary?.tac ?? "",
    identityVerification: {
      hasCellIdDecimal: servingId !== null,
      hasCellInfoHex: false,
      eciDecimalMatchesHex: null,
      tacDecimalMatchesHex: null,
      eNodeBDerivationMatchesTag: null,
      sectorIdBitWidthOk: servingId !== null && primaryRat === "LTE" ? BigInt(servingId) <= 0x0fffffffn : null,
    },
  };
}

function trafficDto(t: DriverTelemetry): TrafficTelemetryDto {
  const traffic = t.traffic;
  const down = traffic?.downloadBytesPerSec ?? 0;
  const up = traffic?.uploadBytesPerSec ?? 0;
  const monthDown = traffic?.monthDownloadBytes ?? 0n;
  const monthUp = traffic?.monthUploadBytes ?? 0n;
  const monthTotal = traffic?.monthTotalBytes ?? monthDown + monthUp;
  const sessionDown = traffic?.sessionDownloadBytes ?? 0n;
  const sessionUp = traffic?.sessionUploadBytes ?? 0n;
  return {
    downloadBytesPerSec: down,
    uploadBytesPerSec: up,
    downloadBps: down * 8,
    uploadBps: up * 8,
    downloadRateFormatted: formatRateBitsPerSec(down * 8),
    uploadRateFormatted: formatRateBitsPerSec(up * 8),
    todayUsedBytes: 0,
    todayUsedBytesStr: "0",
    todayUsedFormatted: formatBytesBinary(0),
    todayDurationSec: 0,
    monthDownloadBytes: Number(monthDown),
    monthDownloadBytesStr: monthDown.toString(10),
    monthUploadBytes: Number(monthUp),
    monthUploadBytesStr: monthUp.toString(10),
    monthTotalBytes: Number(monthTotal),
    monthTotalBytesStr: monthTotal.toString(10),
    monthTotalFormatted: formatBytesBinary(monthTotal),
    monthDurationSec: traffic?.monthSeconds ?? 0,
    monthLastClearDate: "",
    sessionConnectTimeSec: traffic?.sessionSeconds ?? t.wan.uptimeSec ?? 0,
    sessionDownloadBytesStr: sessionDown.toString(10),
    sessionUploadBytesStr: sessionUp.toString(10),
    totalUsedBytesStr: (sessionDown + sessionUp).toString(10),
    totalConnectTimeSec: 0,
    billingStartDay: null,
    dataLimitRaw: "",
    monthThresholdPercent: null,
  };
}

/** What this poll's router did not report, so the console shows it as not available rather than zero. */
function unavailableParts(t: DriverTelemetry): TelemetryPart[] {
  const out: TelemetryPart[] = [];
  if (t.mode === null && t.lte === null && t.nr === null) out.push("signal");
  if (t.wan.connected === null) out.push("status");
  if (t.traffic === null || (t.traffic.downloadBytesPerSec === null && t.traffic.uploadBytesPerSec === null)) out.push("traffic");
  if (t.traffic === null || (t.traffic.monthDownloadBytes === null && t.traffic.monthUploadBytes === null && t.traffic.monthTotalBytes === null)) out.push("month");
  return out;
}

export function driverTelemetrySnapshot(t: DriverTelemetry, nowMs: number = Date.now()): GlobalTelemetrySnapshot {
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    unavailable: unavailableParts(t),
    device: {
      deviceName: t.model ?? "",
      marketingName: "",
      hardwareVersion: t.hardwareVersion ?? "",
      softwareVersion: t.softwareVersion ?? "",
      webUiVersion: "",
      uptimeSec: 0,
      workMode: "",
      wanIpv4: t.wan.ipv4 ?? "",
      wanDnsV4: [],
      wanIpv6: t.wan.ipv6 ?? "",
      wanDnsV6: [],
      connectionStatus: t.wan.connected === null ? "" : t.wan.connected ? CONNECTED : DISCONNECTED,
      signalIconBars: t.signalBars ?? 0,
      simStatus: "",
      imei: "",
      imsi: "",
      msisdn: "",
      macAddress: "",
      sensitiveRedacted: false,
    },
    rf: driverRfSnapshot(t),
    bandConfig: { networkMode: "", networkBandHex: "", lteBandHex: "", activeLteBands: [] },
    traffic: trafficDto(t),
    thermal: { temperatureCelsius: t.temperatureC, temperatureSupported: t.temperatureC !== null },
    sms: null,
  };
}

function neighbourEntry(n: DriverNeighbour): NeighborCellEntry {
  return { rat: n.rat, arfcn: n.arfcn, band: label(n.rat, n.band), pci: n.pci, rsrpDbm: n.rsrpDbm, rsrqDb: n.rsrqDb, rssiDbm: n.rssiDbm, sinrDb: n.sinrDb };
}

export function driverNeighbourSnapshot(list: ReadonlyArray<DriverNeighbour>, nowMs: number = Date.now()): NeighborScanSnapshot {
  const lteNeighbors = list.filter((n) => n.rat === "LTE").map(neighbourEntry);
  const nrNeighbors = list.filter((n) => n.rat === "NR").map(neighbourEntry);
  return { capturedAtIso: new Date(nowMs).toISOString(), capturedAtMs: nowMs, lteNeighbors, nrNeighbors, totalCount: lteNeighbors.length + nrNeighbors.length };
}

/**
 * Rates from running byte counters, for routers that report counters but no rate: the difference
 * to the previous poll over the time between them. The first poll, a counter that went backwards
 * (a redial reset it) or a gap over ten minutes gives no rate rather than a wrong one.
 */
export class CounterRates {
  #last: { atMs: number; down: bigint; up: bigint } | null = null;

  apply(t: DriverTelemetry, nowMs: number): DriverTelemetry {
    const traffic = t.traffic;
    if (!traffic || traffic.totalDownloadBytes === null || traffic.totalUploadBytes === null) return t;
    const previous = this.#last;
    this.#last = { atMs: nowMs, down: traffic.totalDownloadBytes, up: traffic.totalUploadBytes };
    if (traffic.downloadBytesPerSec !== null || traffic.uploadBytesPerSec !== null || previous === null) return t;
    const elapsedMs = nowMs - previous.atMs;
    const down = traffic.totalDownloadBytes - previous.down;
    const up = traffic.totalUploadBytes - previous.up;
    if (elapsedMs <= 0 || elapsedMs > 600_000 || down < 0n || up < 0n) return t;
    const perSec = (bytes: bigint): number => Math.round((Number(bytes) * 1000) / elapsedMs);
    return { ...t, traffic: { ...traffic, downloadBytesPerSec: perSec(down), uploadBytesPerSec: perSec(up) } };
  }

  reset(): void {
    this.#last = null;
  }
}

/** An empty cell, for drivers to fill in. */
export function emptyCell(): DriverCell {
  return { band: null, arfcn: null, pci: null, rsrpDbm: null, rsrqDb: null, sinrDb: null, rssiDbm: null, bandwidthMhz: null, cellId: null, tac: null, cqi: null, mimoLayers: null, dlMcs: null, ulMcs: null, rxRsrpDbm: null };
}

/** Whether a cell carries anything (a band, a channel or a reading). */
export function cellHasData(cell: DriverCell): boolean {
  return cell.band !== null || cell.arfcn !== null || cell.pci !== null || cell.rsrpDbm !== null || cell.sinrDb !== null;
}

/**
 * A driver family's identification in the shape the HiLink probe produces (`DeviceProbeResult`), so
 * the device report, the console and the write gate keep one record of who the router is: the model
 * and firmware the driver read, no HiLink endpoints (none were probed) and no login scheme (the
 * family's own login is not one of HiLink's).
 */
export function driverDeviceProbe(identity: DriverIdentity, opts: { nowIso: string; origin: ProbeOrigin }): DeviceProbeResult {
  return {
    identity: {
      model: identity.model,
      marketingName: null,
      softwareVersion: identity.softwareVersion,
      webUiVersion: null,
      passwordType: null,
      loginScheme: "unknown",
      ecc: false,
      tokenFlow: "unknown",
      detectedAtIso: opts.nowIso,
    },
    endpoints: [],
    lteBands: null,
    probedAtIso: opts.nowIso,
    origin: opts.origin,
    observations: [],
  };
}
