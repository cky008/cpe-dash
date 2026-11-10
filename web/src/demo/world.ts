import type { GlobalTelemetrySnapshot, SpeedTickPayload } from "../../../src/api-contract.ts";
import type { SecondaryCellEntry } from "../../../src/parsers.ts";
import type { TimeSeriesRingBuffer, TimeSeriesSampleInput } from "../../../src/timeseries.ts";
import { formatBytesBinary, formatRateBitsPerSec } from "../../../src/units.ts";

/**
 * The demo household's rhythm: a daily usage curve (quiet nights, a lunch bump, a busy evening),
 * download bursts, and radio values that drift around the captured snapshot and sag a little under
 * load. The same function fills the 24 h history and drives the live 5 s ticks, so they join up.
 */

export const TICK_MS = 5_000;
const HISTORY_MS = 24 * 60 * 60_000;

/** The NR values: `null` on a router that has no 5G (an LTE-only model), so none is ever invented. */
interface NrSignal {
  rsrpDbm: number;
  rsrqDb: number;
  sinrDb: number;
}

export interface SignalBase {
  lteRsrpDbm: number;
  lteRsrqDb: number;
  lteSinrDb: number;
  lteRssiDbm: number;
  nr: NrSignal | null;
  temperatureCelsius: number;
  /** The router reports its uptime; one that does not (an LTE-only model may not) keeps 0, so none is invented. */
  uptime: boolean;
}

export interface WorldSample {
  tsMs: number;
  downloadBytesPerSec: number;
  uploadBytesPerSec: number;
  lteRsrpDbm: number;
  lteRsrqDb: number;
  lteSinrDb: number;
  lteRssiDbm: number;
  nrRsrpDbm: number | null;
  nrRsrqDb: number | null;
  nrSinrDb: number | null;
  temperatureCelsius: number;
}

export function signalBase(t: GlobalTelemetrySnapshot): SignalBase {
  const rf = t.rf;
  const hasNr = rf.nrRsrpDbm !== null || rf.nrSinrDb !== null || rf.nrScc.length > 0;
  return {
    lteRsrpDbm: rf.lteRsrpDbm ?? -88,
    lteRsrqDb: rf.lteRsrqDb ?? -8,
    lteSinrDb: rf.lteSinrDb ?? 13,
    lteRssiDbm: rf.lteRssiDbm ?? -70,
    nr: hasNr ? { rsrpDbm: rf.nrRsrpDbm ?? -95, rsrqDb: rf.nrRsrqDb ?? -10.5, sinrDb: rf.nrSinrDb ?? 9 } : null,
    temperatureCelsius: t.thermal.temperatureCelsius ?? 46,
    uptime: t.device.uptimeSec > 0,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const bell = (x: number, centre: number, width: number): number => Math.exp(-(((x - centre) / width) ** 2));

/** Deterministic 0…1 per integer (a 32-bit mix), so history and live ticks agree on any instant. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4_294_967_296;
}

/** Smooth value noise with one random level per `periodMs`. */
function valueNoise(tsMs: number, periodMs: number, salt: number): number {
  const t = tsMs / periodMs;
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return hash01(i * 31 + salt) * (1 - s) + hash01((i + 1) * 31 + salt) * s;
}

/** 0.15 (small hours) … ~1.1 (evening peak), from the browser's local hour. */
export function activityAt(tsMs: number): number {
  const d = new Date(tsMs);
  const hour = d.getHours() + d.getMinutes() / 60;
  return 0.15 + 0.85 * bell(hour, 21, 2.6) + 0.35 * bell(hour, 13, 2) + 0.2 * bell(hour, 8, 1.2);
}

export function worldSample(tsMs: number, base: SignalBase, random: () => number): WorldSample {
  const activity = activityAt(tsMs);
  const noise = (spread: number): number => (random() - 0.5) * spread;
  // Browsing comes in short bursts; a stream or a download holds for minutes
  const browsing = Math.max(0, valueNoise(tsMs, 75_000, 1) - 0.55) / 0.45;
  const session = Math.max(0, valueNoise(tsMs, 540_000, 2) - 0.6) / 0.4;
  const burst = browsing * 5_500_000 + session * 9_000_000;
  const down = Math.round(activity * (300_000 + burst) * (0.85 + random() * 0.3));
  const up = Math.round(down * (0.08 + random() * 0.06) + 45_000);
  // Slow drift (weather, neighbours' load) plus a dip while the cell is busy
  const drift = Math.sin(tsMs / 5_400_000) * 2 + Math.sin(tsMs / 1_300_000) * 1;
  const load = activity - 0.5;
  return {
    tsMs,
    downloadBytesPerSec: down,
    uploadBytesPerSec: up,
    lteRsrpDbm: round1(base.lteRsrpDbm + drift + noise(1.6)),
    lteRsrqDb: round1(base.lteRsrqDb - load * 1.5 + noise(0.8)),
    lteSinrDb: round1(base.lteSinrDb + drift * 0.6 - load * 3 + noise(2)),
    lteRssiDbm: round1(base.lteRssiDbm + drift + noise(1.2)),
    nrRsrpDbm: base.nr ? round1(base.nr.rsrpDbm + drift * 1.3 + noise(2.2)) : null,
    nrRsrqDb: base.nr ? round1(base.nr.rsrqDb - load * 1.5 + noise(0.8)) : null,
    nrSinrDb: base.nr ? round1(base.nr.sinrDb + drift * 0.8 - load * 4 + noise(2.6)) : null,
    temperatureCelsius: round1(base.temperatureCelsius - 2 + activity * 5 + noise(0.4)),
  };
}

export function seriesInput(s: WorldSample): TimeSeriesSampleInput {
  return {
    tsMs: s.tsMs,
    downloadBps: s.downloadBytesPerSec * 8,
    uploadBps: s.uploadBytesPerSec * 8,
    lteRsrpDbm: s.lteRsrpDbm,
    lteSinrDb: s.lteSinrDb,
    nrRsrpDbm: s.nrRsrpDbm,
    nrSinrDb: s.nrSinrDb,
    temperatureCelsius: s.temperatureCelsius,
  };
}

/** Fill the ring buffer with the last 24 h, one sample per poll, as if the daemon had run all day. */
export function backfillHistory(series: TimeSeriesRingBuffer, base: SignalBase, nowMs: number, random: () => number): void {
  const start = Math.floor((nowMs - HISTORY_MS) / TICK_MS) * TICK_MS;
  for (let ts = start; ts < nowMs - TICK_MS; ts += TICK_MS) {
    series.push(seriesInput(worldSample(ts, base, random)), ts);
  }
}

function shiftScc(cells: ReadonlyArray<SecondaryCellEntry>, rsrpDelta: number, sinrDelta: number): SecondaryCellEntry[] {
  return cells.map((c) => ({
    ...c,
    rsrpDbm: c.rsrpDbm === null ? null : round1(c.rsrpDbm + rsrpDelta),
    sinrDb: c.sinrDb === null ? null : round1(c.sinrDb + sinrDelta),
  }));
}

/**
 * The next telemetry snapshot: radio values from `sample` (secondary cells keep their offset to the
 * primary), traffic counters advanced by `elapsedSec` of the sampled rates, clocks moved on.
 */
export function advanceTelemetry(
  prev: GlobalTelemetrySnapshot,
  sample: WorldSample,
  base: SignalBase,
  elapsedSec: number
): GlobalTelemetrySnapshot {
  const tr = prev.traffic;
  const down = sample.downloadBytesPerSec;
  const up = sample.uploadBytesPerSec;
  const todayUsed = tr.todayUsedBytes + Math.round((down + up) * elapsedSec);
  const monthDown = tr.monthDownloadBytes + Math.round(down * elapsedSec);
  const monthUp = tr.monthUploadBytes + Math.round(up * elapsedSec);
  const grow = (raw: string, by: number): string => String(Math.round(Number(raw) + by));
  return {
    ...prev,
    capturedAtIso: new Date(sample.tsMs).toISOString(),
    capturedAtMs: sample.tsMs,
    device: { ...prev.device, uptimeSec: base.uptime ? prev.device.uptimeSec + elapsedSec : prev.device.uptimeSec },
    rf: {
      ...prev.rf,
      lteRsrpDbm: sample.lteRsrpDbm,
      lteRsrqDb: sample.lteRsrqDb,
      lteSinrDb: sample.lteSinrDb,
      lteRssiDbm: sample.lteRssiDbm,
      nrRsrpDbm: sample.nrRsrpDbm,
      nrRsrqDb: sample.nrRsrqDb,
      nrSinrDb: sample.nrSinrDb,
      lteScc: shiftScc(prev.rf.lteScc, sample.lteRsrpDbm - (prev.rf.lteRsrpDbm ?? base.lteRsrpDbm), sample.lteSinrDb - (prev.rf.lteSinrDb ?? base.lteSinrDb)),
      nrScc:
        sample.nrRsrpDbm === null || sample.nrSinrDb === null || !base.nr
          ? prev.rf.nrScc
          : shiftScc(prev.rf.nrScc, sample.nrRsrpDbm - (prev.rf.nrRsrpDbm ?? base.nr.rsrpDbm), sample.nrSinrDb - (prev.rf.nrSinrDb ?? base.nr.sinrDb)),
    },
    traffic: {
      ...tr,
      downloadBytesPerSec: down,
      uploadBytesPerSec: up,
      downloadBps: down * 8,
      uploadBps: up * 8,
      downloadRateFormatted: formatRateBitsPerSec(down * 8),
      uploadRateFormatted: formatRateBitsPerSec(up * 8),
      todayUsedBytes: todayUsed,
      todayUsedBytesStr: String(todayUsed),
      todayUsedFormatted: formatBytesBinary(todayUsed),
      todayDurationSec: tr.todayDurationSec + elapsedSec,
      monthDownloadBytes: monthDown,
      monthDownloadBytesStr: String(monthDown),
      monthUploadBytes: monthUp,
      monthUploadBytesStr: String(monthUp),
      monthTotalBytes: monthDown + monthUp,
      monthTotalBytesStr: String(monthDown + monthUp),
      monthTotalFormatted: formatBytesBinary(monthDown + monthUp),
      monthDurationSec: tr.monthDurationSec + elapsedSec,
      sessionConnectTimeSec: tr.sessionConnectTimeSec + elapsedSec,
      sessionDownloadBytesStr: grow(tr.sessionDownloadBytesStr, down * elapsedSec),
      sessionUploadBytesStr: grow(tr.sessionUploadBytesStr, up * elapsedSec),
      totalUsedBytesStr: grow(tr.totalUsedBytesStr, (down + up) * elapsedSec),
      totalConnectTimeSec: tr.totalConnectTimeSec + elapsedSec,
    },
    thermal: prev.thermal.temperatureSupported ? { ...prev.thermal, temperatureCelsius: sample.temperatureCelsius } : prev.thermal,
  };
}

export function speedTick(t: GlobalTelemetrySnapshot): SpeedTickPayload {
  return {
    tsMs: t.capturedAtMs,
    tsIso: t.capturedAtIso,
    downloadBps: t.traffic.downloadBps,
    uploadBps: t.traffic.uploadBps,
    downloadRateFormatted: t.traffic.downloadRateFormatted,
    uploadRateFormatted: t.traffic.uploadRateFormatted,
  };
}
