export type TimeSeriesPreset = "1h" | "6h" | "12h" | "24h" | "custom";

export interface TimeSeriesSampleInput {
  tsMs: number;
  downloadBps: number;
  uploadBps: number;
  lteRsrpDbm: number | null;
  lteSinrDb: number | null;
  nrRsrpDbm: number | null;
  nrSinrDb: number | null;
  temperatureCelsius: number | null;
}

export interface ChannelAccumulator {
  sum: number;
  count: number;
  min: number;
  max: number;
}

export interface TimeSeriesSlotRecord {
  epochMs: number;
  sampleCount: number;
  dl: ChannelAccumulator;
  ul: ChannelAccumulator;
  lteRsrp: ChannelAccumulator;
  lteSinr: ChannelAccumulator;
  nrRsrp: ChannelAccumulator;
  nrSinr: ChannelAccumulator;
  temp: ChannelAccumulator;
}

export interface TimeSeriesBucketPoint {
  tsMs: number;
  tsIso: string;
  sampleCount: number;
  dlAvgBps: number;
  dlPeakBps: number;
  ulAvgBps: number;
  ulPeakBps: number;
  lteRsrpAvgDbm: number | null;
  lteRsrpMinDbm: number | null;
  lteSinrAvgDb: number | null;
  nrRsrpAvgDbm: number | null;
  nrRsrpMinDbm: number | null;
  nrSinrAvgDb: number | null;
  temperatureAvgCelsius: number | null;
  temperatureMaxCelsius: number | null;
}

export interface TimeSeriesQueryParams {
  preset?: TimeSeriesPreset;
  fromMs?: number;
  toMs?: number;
  bucketMs?: number;
  maxPoints?: number;
  nowMs?: number;
}

export interface TimeSeriesQueryResult {
  preset: TimeSeriesPreset;
  fromMs: number;
  toMs: number;
  bucketMs: number;
  points: TimeSeriesBucketPoint[];
}

export interface SerializedTimeSeriesSnapshot {
  schemaVersion: 1;
  savedAtMs: number;
  lastClosedMinuteMs: number;
  fineSlots: TimeSeriesSlotRecord[];
  coarseSlots: TimeSeriesSlotRecord[];
}

export const FINE_STEP_MS = 5_000;
export const FINE_CAPACITY = 2_161; // 3 hours + 1 guard slot
export const COARSE_STEP_MS = 60_000;
export const DEFAULT_COARSE_CAPACITY = 10_081; // 7 days (168h) + 1 guard slot
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const CLOCK_STEP_CONFIRM_SAMPLES = 3;

const PRESET_CONFIG: Readonly<
  Record<Exclude<TimeSeriesPreset, "custom">, { spanMs: number; defaultBucketMs: number }>
> = {
  "1h": { spanMs: 60 * 60_000, defaultBucketMs: 10_000 },
  "6h": { spanMs: 6 * 60 * 60_000, defaultBucketMs: 60_000 },
  "12h": { spanMs: 12 * 60 * 60_000, defaultBucketMs: 120_000 },
  "24h": { spanMs: 24 * 60 * 60_000, defaultBucketMs: 300_000 },
};

function emptyAccumulator(): ChannelAccumulator {
  return {
    sum: 0,
    count: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };
}

function cloneAccumulator(acc: ChannelAccumulator): ChannelAccumulator {
  if (acc.count === 0) return emptyAccumulator();
  return {
    sum: acc.sum,
    count: acc.count,
    min: acc.min,
    max: acc.max,
  };
}

function addScalar(acc: ChannelAccumulator, val: number | null): void {
  if (val === null || !Number.isFinite(val)) return;
  acc.sum += val;
  acc.count += 1;
  if (val < acc.min) acc.min = val;
  if (val > acc.max) acc.max = val;
}

function mergeAccumulator(target: ChannelAccumulator, src: ChannelAccumulator): void {
  if (src.count <= 0) return;
  target.sum += src.sum;
  target.count += src.count;
  if (src.min < target.min) target.min = src.min;
  if (src.max > target.max) target.max = src.max;
}

function createEmptySlot(epochMs: number): TimeSeriesSlotRecord {
  return {
    epochMs,
    sampleCount: 0,
    dl: emptyAccumulator(),
    ul: emptyAccumulator(),
    lteRsrp: emptyAccumulator(),
    lteSinr: emptyAccumulator(),
    nrRsrp: emptyAccumulator(),
    nrSinr: emptyAccumulator(),
    temp: emptyAccumulator(),
  };
}

function cloneSlot(slot: TimeSeriesSlotRecord): TimeSeriesSlotRecord {
  return {
    epochMs: slot.epochMs,
    sampleCount: slot.sampleCount,
    dl: cloneAccumulator(slot.dl),
    ul: cloneAccumulator(slot.ul),
    lteRsrp: cloneAccumulator(slot.lteRsrp),
    lteSinr: cloneAccumulator(slot.lteSinr),
    nrRsrp: cloneAccumulator(slot.nrRsrp),
    nrSinr: cloneAccumulator(slot.nrSinr),
    temp: cloneAccumulator(slot.temp),
  };
}

function mergeSlotInto(target: TimeSeriesSlotRecord, src: TimeSeriesSlotRecord): void {
  if (src.sampleCount <= 0) return;
  target.sampleCount += src.sampleCount;
  mergeAccumulator(target.dl, src.dl);
  mergeAccumulator(target.ul, src.ul);
  mergeAccumulator(target.lteRsrp, src.lteRsrp);
  mergeAccumulator(target.lteSinr, src.lteSinr);
  mergeAccumulator(target.nrRsrp, src.nrRsrp);
  mergeAccumulator(target.nrSinr, src.nrSinr);
  mergeAccumulator(target.temp, src.temp);
}

function roundMetric(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

function slotToBucketPoint(slot: TimeSeriesSlotRecord): TimeSeriesBucketPoint {
  return {
    tsMs: slot.epochMs,
    tsIso: new Date(slot.epochMs).toISOString(),
    sampleCount: slot.sampleCount,
    dlAvgBps: slot.dl.count > 0 ? Math.round(slot.dl.sum / slot.dl.count) : 0,
    dlPeakBps: slot.dl.count > 0 ? Math.round(slot.dl.max) : 0,
    ulAvgBps: slot.ul.count > 0 ? Math.round(slot.ul.sum / slot.ul.count) : 0,
    ulPeakBps: slot.ul.count > 0 ? Math.round(slot.ul.max) : 0,
    lteRsrpAvgDbm:
      slot.lteRsrp.count > 0 ? roundMetric(slot.lteRsrp.sum / slot.lteRsrp.count) : null,
    lteRsrpMinDbm: slot.lteRsrp.count > 0 ? roundMetric(slot.lteRsrp.min) : null,
    lteSinrAvgDb:
      slot.lteSinr.count > 0 ? roundMetric(slot.lteSinr.sum / slot.lteSinr.count) : null,
    nrRsrpAvgDbm:
      slot.nrRsrp.count > 0 ? roundMetric(slot.nrRsrp.sum / slot.nrRsrp.count) : null,
    nrRsrpMinDbm: slot.nrRsrp.count > 0 ? roundMetric(slot.nrRsrp.min) : null,
    nrSinrAvgDb: slot.nrSinr.count > 0 ? roundMetric(slot.nrSinr.sum / slot.nrSinr.count) : null,
    temperatureAvgCelsius:
      slot.temp.count > 0 ? roundMetric(slot.temp.sum / slot.temp.count) : null,
    temperatureMaxCelsius: slot.temp.count > 0 ? roundMetric(slot.temp.max) : null,
  };
}

export class TimeSeriesValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeSeriesValidationError";
  }
}

/**
 * Dual-Tier Fixed-Memory Circular Ring Buffer:
 * - Tier 1 (`fineRing`): `5s` slots covering `3h` (`2,161` slots).
 * - Tier 2 (`coarseRing`): `60s` roll-up slots covering up to `7d` (`10,081` slots by default).
 * - Maintains per-channel `{sum, count, min, max}` so `null` NR/temperature channels never skew averages.
 * - Joins Tier 2 + Tier 1 seamlessly at a deterministic seam without gaps or double-counting.
 */
export class TimeSeriesRingBuffer {
  readonly fineCapacity: number;
  readonly coarseCapacity: number;
  #fineSlots: Array<TimeSeriesSlotRecord | null>;
  #coarseSlots: Array<TimeSeriesSlotRecord | null>;
  #openMinute: TimeSeriesSlotRecord | null;
  #lastClosedMinuteMs: number;
  #lastAcceptedTsMs: number;
  #backwardRejects: number;

  constructor(opts: { retentionHours?: number } = {}) {
    const retentionHours = Math.max(1, Math.min(24 * 30, opts.retentionHours ?? 168));
    this.fineCapacity = FINE_CAPACITY;
    this.coarseCapacity = retentionHours * 60 + 1;
    this.#fineSlots = Array.from({ length: this.fineCapacity }, () => null);
    this.#coarseSlots = Array.from({ length: this.coarseCapacity }, () => null);
    this.#openMinute = null;
    this.#lastClosedMinuteMs = 0;
    this.#lastAcceptedTsMs = 0;
    this.#backwardRejects = 0;
  }

  #dropSlotsNewerThan(cutoffMs: number): void {
    const keep = (s: TimeSeriesSlotRecord | null): TimeSeriesSlotRecord | null =>
      s && s.epochMs > cutoffMs ? null : s;
    this.#fineSlots = this.#fineSlots.map(keep);
    this.#coarseSlots = this.#coarseSlots.map(keep);
    if (this.#openMinute && this.#openMinute.epochMs > cutoffMs) {
      this.#openMinute = null;
    }
    if (this.#lastClosedMinuteMs > cutoffMs) {
      this.#lastClosedMinuteMs = 0;
    }
  }

  #fineIndex(epochMs: number): number {
    const stepIndex = Math.floor(epochMs / FINE_STEP_MS);
    return ((stepIndex % this.fineCapacity) + this.fineCapacity) % this.fineCapacity;
  }

  #coarseIndex(epochMs: number): number {
    const stepIndex = Math.floor(epochMs / COARSE_STEP_MS);
    return ((stepIndex % this.coarseCapacity) + this.coarseCapacity) % this.coarseCapacity;
  }

  #sealOpenMinute(): void {
    if (!this.#openMinute || this.#openMinute.sampleCount === 0) return;
    const idx = this.#coarseIndex(this.#openMinute.epochMs);
    const existing = this.#coarseSlots[idx];
    if (existing && existing.epochMs === this.#openMinute.epochMs) {
      mergeSlotInto(existing, this.#openMinute);
    } else {
      this.#coarseSlots[idx] = cloneSlot(this.#openMinute);
    }
    const closedEnd = this.#openMinute.epochMs + COARSE_STEP_MS;
    if (closedEnd > this.#lastClosedMinuteMs) {
      this.#lastClosedMinuteMs = closedEnd;
    }
    this.#openMinute = null;
  }

  /**
   * Append a telemetry sample in O(1) time.
   */
  push(sample: TimeSeriesSampleInput, wallNowMs = Date.now()): boolean {
    if (!Number.isFinite(sample.tsMs) || sample.tsMs <= 0) {
      return false;
    }
    if (sample.tsMs > wallNowMs + MAX_FUTURE_SKEW_MS) {
      return false;
    }
    if (this.#lastAcceptedTsMs > 0 && sample.tsMs < this.#lastAcceptedTsMs - COARSE_STEP_MS) {
      // Drop stray out-of-order late samples; rebase if clock stepped backwards sustainably (>= 3 polls)
      this.#backwardRejects += 1;
      if (this.#backwardRejects < CLOCK_STEP_CONFIRM_SAMPLES) {
        return false;
      }
      this.#dropSlotsNewerThan(sample.tsMs + COARSE_STEP_MS);
      this.#lastAcceptedTsMs = sample.tsMs;
    }
    this.#backwardRejects = 0;
    if (sample.tsMs > this.#lastAcceptedTsMs) {
      this.#lastAcceptedTsMs = sample.tsMs;
    }

    const fineEpoch = Math.floor(sample.tsMs / FINE_STEP_MS) * FINE_STEP_MS;
    const fIdx = this.#fineIndex(fineEpoch);
    let fSlot = this.#fineSlots[fIdx];
    if (!fSlot || fSlot.epochMs !== fineEpoch) {
      fSlot = createEmptySlot(fineEpoch);
      this.#fineSlots[fIdx] = fSlot;
    }

    fSlot.sampleCount += 1;
    addScalar(fSlot.dl, Math.max(0, sample.downloadBps));
    addScalar(fSlot.ul, Math.max(0, sample.uploadBps));
    addScalar(fSlot.lteRsrp, sample.lteRsrpDbm);
    addScalar(fSlot.lteSinr, sample.lteSinrDb);
    addScalar(fSlot.nrRsrp, sample.nrRsrpDbm);
    addScalar(fSlot.nrSinr, sample.nrSinrDb);
    addScalar(fSlot.temp, sample.temperatureCelsius);

    const minuteEpoch = Math.floor(sample.tsMs / COARSE_STEP_MS) * COARSE_STEP_MS;
    if (this.#openMinute && this.#openMinute.epochMs !== minuteEpoch) {
      if (minuteEpoch > this.#openMinute.epochMs) {
        this.#sealOpenMinute();
      } else {
        // Same-minute or slightly earlier within 60s tolerance -> merge directly into coarse ring
        const cIdx = this.#coarseIndex(minuteEpoch);
        let cSlot = this.#coarseSlots[cIdx];
        if (!cSlot || cSlot.epochMs !== minuteEpoch) {
          cSlot = createEmptySlot(minuteEpoch);
          this.#coarseSlots[cIdx] = cSlot;
        }
        cSlot.sampleCount += 1;
        addScalar(cSlot.dl, Math.max(0, sample.downloadBps));
        addScalar(cSlot.ul, Math.max(0, sample.uploadBps));
        addScalar(cSlot.lteRsrp, sample.lteRsrpDbm);
        addScalar(cSlot.lteSinr, sample.lteSinrDb);
        addScalar(cSlot.nrRsrp, sample.nrRsrpDbm);
        addScalar(cSlot.nrSinr, sample.nrSinrDb);
        addScalar(cSlot.temp, sample.temperatureCelsius);
        return true;
      }
    }

    if (!this.#openMinute) {
      this.#openMinute = createEmptySlot(minuteEpoch);
    }
    this.#openMinute.sampleCount += 1;
    addScalar(this.#openMinute.dl, Math.max(0, sample.downloadBps));
    addScalar(this.#openMinute.ul, Math.max(0, sample.uploadBps));
    addScalar(this.#openMinute.lteRsrp, sample.lteRsrpDbm);
    addScalar(this.#openMinute.lteSinr, sample.lteSinrDb);
    addScalar(this.#openMinute.nrRsrp, sample.nrRsrpDbm);
    addScalar(this.#openMinute.nrSinr, sample.nrSinrDb);
    addScalar(this.#openMinute.temp, sample.temperatureCelsius);

    return true;
  }

  /**
   * Query multi-resolution aggregated points for `1h / 6h / 12h / 24h` presets or `custom` `[fromMs, toMs]`.
   */
  query(params: TimeSeriesQueryParams = {}): TimeSeriesQueryResult {
    const preset: TimeSeriesPreset = params.preset ?? "1h";
    if (!["1h", "6h", "12h", "24h", "custom"].includes(preset)) {
      throw new TimeSeriesValidationError(`Unsupported time-series preset "${String(preset)}"`);
    }

    const nowMs = params.nowMs ?? (this.#lastAcceptedTsMs > 0 ? Math.max(Date.now(), this.#lastAcceptedTsMs) : Date.now());
    if (!Number.isFinite(nowMs) || nowMs <= 0) {
      throw new TimeSeriesValidationError("Invalid reference timestamp nowMs");
    }

    const maxRetentionSpanMs = (this.coarseCapacity - 1) * COARSE_STEP_MS;
    const minAllowedFromMs = nowMs - maxRetentionSpanMs;

    let fromMs: number;
    let toMs: number;
    let requestedBucketMs: number;

    if (preset === "custom") {
      if (
        params.fromMs === undefined ||
        params.toMs === undefined ||
        !Number.isFinite(params.fromMs) ||
        !Number.isFinite(params.toMs)
      ) {
        throw new TimeSeriesValidationError(
          "Custom time-series query requires finite integer fromMs and toMs"
        );
      }
      fromMs = Math.max(minAllowedFromMs, Math.trunc(params.fromMs));
      toMs = Math.min(nowMs + FINE_STEP_MS, Math.trunc(params.toMs));
      if (fromMs >= toMs) {
        throw new TimeSeriesValidationError("fromMs must be strictly less than toMs");
      }
      requestedBucketMs =
        params.bucketMs !== undefined && Number.isFinite(params.bucketMs) && params.bucketMs > 0
          ? Math.trunc(params.bucketMs)
          : 0;
    } else {
      const cfg = PRESET_CONFIG[preset];
      toMs = nowMs;
      fromMs = nowMs - cfg.spanMs;
      requestedBucketMs =
        params.bucketMs !== undefined && Number.isFinite(params.bucketMs) && params.bucketMs > 0
          ? Math.trunc(params.bucketMs)
          : cfg.defaultBucketMs;
    }

    const maxPoints =
      params.maxPoints !== undefined && Number.isFinite(params.maxPoints)
        ? Math.max(1, Math.min(1440, Math.trunc(params.maxPoints)))
        : 360;

    const spanMs = Math.max(FINE_STEP_MS, toMs - fromMs);
    const minBucketForCap = Math.ceil(spanMs / maxPoints);

    // Find oldest valid fine slot within the last 3h window
    const fineHorizonMs = nowMs - (this.fineCapacity - 1) * FINE_STEP_MS;
    let oldestFineMs = Number.POSITIVE_INFINITY;
    for (const slot of this.#fineSlots) {
      if (slot && slot.sampleCount > 0 && slot.epochMs >= fineHorizonMs) {
        if (slot.epochMs < oldestFineMs) {
          oldestFineMs = slot.epochMs;
        }
      }
    }

    // Determine whether the requested window is purely covered by fine slots
    const fullyInFine = oldestFineMs <= fromMs;
    const baseStepMs = fullyInFine ? FINE_STEP_MS : spanMs <= 3 * 60 * 60_000 && requestedBucketMs < COARSE_STEP_MS ? FINE_STEP_MS : COARSE_STEP_MS;
    const rawBucketMs = Math.max(requestedBucketMs, minBucketForCap, baseStepMs);
    const bucketMs = Math.ceil(rawBucketMs / baseStepMs) * baseStepMs;

    // Single-pass unified join:
    // Use `coarseRing` for slots `< seamMs` and `fineRing` for slots `>= seamMs`
    // where `seamMs` aligns to minute boundaries so no minute is split or double-counted!
    const seamMs = Number.isFinite(oldestFineMs)
      ? Math.ceil(oldestFineMs / COARSE_STEP_MS) * COARSE_STEP_MS
      : Number.POSITIVE_INFINITY;

    const bucketMap = new Map<number, TimeSeriesSlotRecord>();
    const addSourceSlot = (slot: TimeSeriesSlotRecord): void => {
      if (slot.sampleCount <= 0) return;
      if (slot.epochMs < fromMs || slot.epochMs > toMs) return;
      const alignedBucketTs = Math.floor(slot.epochMs / bucketMs) * bucketMs;
      let target = bucketMap.get(alignedBucketTs);
      if (!target) {
        target = createEmptySlot(alignedBucketTs);
        bucketMap.set(alignedBucketTs, target);
      }
      mergeSlotInto(target, slot);
    };

    if (fromMs < seamMs) {
      const coarseHorizonMs = nowMs - maxRetentionSpanMs;
      for (const slot of this.#coarseSlots) {
        if (
          slot &&
          slot.sampleCount > 0 &&
          slot.epochMs >= coarseHorizonMs &&
          slot.epochMs < seamMs
        ) {
          addSourceSlot(slot);
        }
      }
      if (
        this.#openMinute &&
        this.#openMinute.sampleCount > 0 &&
        this.#openMinute.epochMs < seamMs
      ) {
        addSourceSlot(this.#openMinute);
      }
    }

    for (const slot of this.#fineSlots) {
      if (
        slot &&
        slot.sampleCount > 0 &&
        slot.epochMs >= fineHorizonMs &&
        slot.epochMs >= (fromMs > seamMs - COARSE_STEP_MS ? fromMs : seamMs)
      ) {
        addSourceSlot(slot);
      }
    }

    const sortedEpochs = [...bucketMap.keys()].sort((a, b) => a - b);
    const points = sortedEpochs
      .slice(-maxPoints)
      .map((epoch) => slotToBucketPoint(bucketMap.get(epoch)!));

    return {
      preset,
      fromMs,
      toMs,
      bucketMs,
      points,
    };
  }

  /**
   * Export non-empty slots into a schema-versioned snapshot safe for encrypted persistence.
   */
  toSnapshot(nowMs = Date.now()): SerializedTimeSeriesSnapshot {
    const fineHorizonMs = nowMs - (this.fineCapacity - 1) * FINE_STEP_MS;
    const coarseHorizonMs = nowMs - (this.coarseCapacity - 1) * COARSE_STEP_MS;

    const fineSlots = this.#fineSlots
      .filter((s): s is TimeSeriesSlotRecord => Boolean(s && s.sampleCount > 0 && s.epochMs >= fineHorizonMs))
      .map(cloneSlot)
      .sort((a, b) => a.epochMs - b.epochMs);

    const coarseList: TimeSeriesSlotRecord[] = [];
    for (const s of this.#coarseSlots) {
      if (s && s.sampleCount > 0 && s.epochMs >= coarseHorizonMs) {
        coarseList.push(cloneSlot(s));
      }
    }
    if (this.#openMinute && this.#openMinute.sampleCount > 0) {
      const idx = coarseList.findIndex((c) => c.epochMs === this.#openMinute!.epochMs);
      if (idx >= 0) {
        mergeSlotInto(coarseList[idx]!, this.#openMinute);
      } else {
        coarseList.push(cloneSlot(this.#openMinute));
      }
    }
    coarseList.sort((a, b) => a.epochMs - b.epochMs);

    return {
      schemaVersion: 1,
      savedAtMs: nowMs,
      lastClosedMinuteMs: this.#lastClosedMinuteMs,
      fineSlots,
      coarseSlots: coarseList,
    };
  }

  /**
   * Hydrate ring buffers from a saved snapshot, validating finite numeric bounds to prevent NaN/null corruption.
   */
  restoreSnapshot(snapshot: SerializedTimeSeriesSnapshot | null | undefined): void {
    if (!snapshot || snapshot.schemaVersion !== 1) return;

    const sanitizeAcc = (raw: ChannelAccumulator | undefined): ChannelAccumulator => {
      if (
        !raw ||
        !Number.isFinite(raw.count) ||
        raw.count <= 0 ||
        !Number.isFinite(raw.sum) ||
        !Number.isFinite(raw.min) ||
        !Number.isFinite(raw.max)
      ) {
        return emptyAccumulator();
      }
      return {
        sum: raw.sum,
        count: Math.trunc(raw.count),
        min: raw.min,
        max: raw.max,
      };
    };

    const sanitizeSlot = (s: TimeSeriesSlotRecord): TimeSeriesSlotRecord | null => {
      if (!s || !Number.isFinite(s.epochMs) || s.epochMs <= 0 || !Number.isFinite(s.sampleCount) || s.sampleCount <= 0) {
        return null;
      }
      return {
        epochMs: Math.trunc(s.epochMs),
        sampleCount: Math.trunc(s.sampleCount),
        dl: sanitizeAcc(s.dl),
        ul: sanitizeAcc(s.ul),
        lteRsrp: sanitizeAcc(s.lteRsrp),
        lteSinr: sanitizeAcc(s.lteSinr),
        nrRsrp: sanitizeAcc(s.nrRsrp),
        nrSinr: sanitizeAcc(s.nrSinr),
        temp: sanitizeAcc(s.temp),
      };
    };

    const maxRestoreEpochMs = Date.now() + MAX_FUTURE_SKEW_MS;

    if (Array.isArray(snapshot.coarseSlots)) {
      for (const rawSlot of snapshot.coarseSlots) {
        const clean = sanitizeSlot(rawSlot);
        if (!clean || clean.epochMs > maxRestoreEpochMs) continue;
        const cEpoch = Math.floor(clean.epochMs / COARSE_STEP_MS) * COARSE_STEP_MS;
        clean.epochMs = cEpoch;
        this.#coarseSlots[this.#coarseIndex(cEpoch)] = clean;
        if (cEpoch > this.#lastAcceptedTsMs) this.#lastAcceptedTsMs = cEpoch;
      }
    }

    if (Array.isArray(snapshot.fineSlots)) {
      for (const rawSlot of snapshot.fineSlots) {
        const clean = sanitizeSlot(rawSlot);
        if (!clean || clean.epochMs > maxRestoreEpochMs) continue;
        const fEpoch = Math.floor(clean.epochMs / FINE_STEP_MS) * FINE_STEP_MS;
        clean.epochMs = fEpoch;
        this.#fineSlots[this.#fineIndex(fEpoch)] = clean;
        if (fEpoch > this.#lastAcceptedTsMs) this.#lastAcceptedTsMs = fEpoch;
      }
    }

    if (Number.isFinite(snapshot.lastClosedMinuteMs) && snapshot.lastClosedMinuteMs > 0) {
      this.#lastClosedMinuteMs = Math.trunc(snapshot.lastClosedMinuteMs);
    }
  }
}
