/**
 * Chart geometry: scales, "nice" ticks, gap splitting and monotone cubic Bézier paths
 * (Fritsch–Carlson), which stay smooth without overshooting below zero between samples.
 */

export interface Point {
  x: number;
  y: number;
}

export type Scale = (value: number) => number;

export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / span;
  return (value) => r0 + (value - d0) * k;
}

/** Round a raw step up to 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceStep(rawStep: number): number {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const base = 10 ** exponent;
  const fraction = rawStep / base;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * base;
}

/** Ticks from 0 (or `min`) up to a rounded maximum that covers `max`. */
export function niceTicks(min: number, max: number, maxTicks = 4): { ticks: number[]; top: number } {
  const lo = Math.min(min, max);
  // A flat series still gets a full axis above it
  const hi = Math.max(min, max) > lo ? Math.max(min, max) : lo + (Math.abs(lo) || 1);
  const step = niceStep((hi - lo) / Math.max(1, maxTicks));
  const start = Math.floor(lo / step) * step;
  const top = Math.max(start + step, Math.ceil(hi / step) * step);
  const ticks: number[] = [];
  for (let v = start; v <= top + step / 1e6; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, top };
}

const TIME_STEPS_MS = [
  60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000,
  6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000,
];

/** Clock-aligned (local time) ticks inside `[fromMs, toMs]`. */
export function timeTicks(fromMs: number, toMs: number, maxTicks = 6, tzOffsetMs = new Date(fromMs).getTimezoneOffset() * 60_000): number[] {
  if (!(toMs > fromMs)) return [];
  const span = toMs - fromMs;
  const step = TIME_STEPS_MS.find((s) => span / s <= maxTicks) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1] ?? 86_400_000;
  const first = Math.ceil((fromMs - tzOffsetMs) / step) * step + tzOffsetMs;
  const ticks: number[] = [];
  for (let t = first; t <= toMs; t += step) ticks.push(t);
  return ticks;
}

/** Split a series wherever consecutive samples are more than `maxGap` apart (no line across outages). */
export function splitByGap<T>(items: ReadonlyArray<T>, getX: (item: T) => number, maxGap: number): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  let lastX = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const x = getX(item);
    if (current.length > 0 && x - lastX > maxGap) {
      runs.push(current);
      current = [];
    }
    current.push(item);
    lastX = x;
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0";
}

/** Tangents for a monotone cubic through points with strictly increasing x. */
function monotoneTangents(points: ReadonlyArray<Point>): number[] {
  const n = points.length;
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const dx = b.x - a.x;
    secants.push(dx === 0 ? 0 : (b.y - a.y) / dx);
  }
  const tangents: number[] = new Array<number>(n).fill(0);
  tangents[0] = secants[0] ?? 0;
  tangents[n - 1] = secants[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const left = secants[i - 1] ?? 0;
    const right = secants[i] ?? 0;
    tangents[i] = left * right <= 0 ? 0 : (left + right) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    const d = secants[i] ?? 0;
    if (d === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const a = (tangents[i] ?? 0) / d;
    const b = (tangents[i + 1] ?? 0) / d;
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      tangents[i] = t * a * d;
      tangents[i + 1] = t * b * d;
    }
  }
  return tangents;
}

/** SVG path (`M … C …`) of a monotone cubic through the points; a single point draws a dot-length segment. */
export function monotonePath(points: ReadonlyArray<Point>): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M${fmt(first.x)},${fmt(first.y)}h0.01`;
  const tangents = monotoneTangents(points);
  let d = `M${fmt(first.x)},${fmt(first.y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const h = (b.x - a.x) / 3;
    const c1x = a.x + h;
    const c1y = a.y + (tangents[i] ?? 0) * h;
    const c2x = b.x - h;
    const c2y = b.y - (tangents[i + 1] ?? 0) * h;
    d += `C${fmt(c1x)},${fmt(c1y)},${fmt(c2x)},${fmt(c2y)},${fmt(b.x)},${fmt(b.y)}`;
  }
  return d;
}

/** The monotone line closed down to `baselineY`, for gradient area fills. */
export function areaPath(points: ReadonlyArray<Point>, baselineY: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return "";
  return `${monotonePath(points)}L${fmt(last.x)},${fmt(baselineY)}L${fmt(first.x)},${fmt(baselineY)}Z`;
}

/** Index of the item whose x is nearest to `x` (items sorted by x); -1 when empty. */
export function nearestIndex(xs: ReadonlyArray<number>, x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs((xs[lo - 1] ?? 0) - x) <= Math.abs((xs[lo] ?? 0) - x)) return lo - 1;
  return lo;
}
