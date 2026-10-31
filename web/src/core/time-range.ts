import type { TimeSeriesPreset } from "../../../src/api-contract.ts";

/** History presets and custom ranges, validated with the daemon's `GET /api/timeseries` rules. */

export type FixedPreset = Exclude<TimeSeriesPreset, "custom">;

export const FIXED_PRESETS: ReadonlyArray<FixedPreset> = ["1h", "6h", "12h", "24h"];

export const PRESET_SPAN_MS: Readonly<Record<FixedPreset, number>> = {
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "12h": 12 * 3_600_000,
  "24h": 24 * 3_600_000,
};

/** Default `HISTORY_RETENTION_HOURS` (168 h): older data is gone from the rings. */
export const DEFAULT_RETENTION_MS = 168 * 3_600_000;

/** Shortest range worth a query (two 5 s samples). */
export const MIN_RANGE_MS = 60_000;

export type RangeCheck =
  | { ok: true; fromMs: number; toMs: number }
  | { ok: false; reason: "invalid" | "order" | "too_short" | "future" | "too_old" };

/**
 * The daemon clips a custom range to retention and to `now + 5 s`; checking first lets the form
 * explain the problem instead of plotting an empty chart.
 */
export function checkCustomRange(fromMs: number | null, toMs: number | null, nowMs: number, retentionMs = DEFAULT_RETENTION_MS): RangeCheck {
  if (fromMs === null || toMs === null || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return { ok: false, reason: "invalid" };
  if (toMs <= fromMs) return { ok: false, reason: "order" };
  if (fromMs > nowMs) return { ok: false, reason: "future" };
  if (toMs < nowMs - retentionMs) return { ok: false, reason: "too_old" };
  const clippedFrom = Math.max(fromMs, nowMs - retentionMs);
  const clippedTo = Math.min(toMs, nowMs);
  if (clippedTo - clippedFrom < MIN_RANGE_MS) return { ok: false, reason: "too_short" };
  return { ok: true, fromMs: clippedFrom, toMs: clippedTo };
}

export interface BrushWindow {
  /** Left edge, 0..1 of the overview width. */
  start: number;
  /** Right edge, 0..1. */
  end: number;
}

/** Keep a brush inside 0..1 and at least `minWidth` wide, preserving the moved edge where possible. */
export function clampBrush(win: BrushWindow, minWidth: number): BrushWindow {
  const width = Math.min(1, Math.max(minWidth, win.end - win.start));
  let start = Math.min(Math.max(0, win.start), 1 - width);
  if (!Number.isFinite(start)) start = 0;
  return { start, end: start + width };
}

export function brushToRange(win: BrushWindow, fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  const span = toMs - fromMs;
  return { fromMs: Math.round(fromMs + win.start * span), toMs: Math.round(fromMs + win.end * span) };
}

/** Query string for `GET /api/timeseries` (strict decimal integers, as the daemon requires). */
export function timeseriesQuery(
  preset: TimeSeriesPreset,
  range: { fromMs: number; toMs: number } | null,
  maxPoints: number
): string {
  const params = new URLSearchParams({ preset, maxPoints: String(Math.min(1440, Math.max(1, Math.round(maxPoints)))) });
  if (preset === "custom" && range) {
    params.set("fromMs", String(Math.round(range.fromMs)));
    params.set("toMs", String(Math.round(range.toMs)));
  }
  return params.toString();
}
