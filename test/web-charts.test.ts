import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  areaPath,
  linearScale,
  monotonePath,
  nearestIndex,
  niceStep,
  niceTicks,
  splitByGap,
  timeTicks,
} from "../web/src/core/chart.ts";
import { brushToRange, checkCustomRange, clampBrush, timeseriesQuery } from "../web/src/core/time-range.ts";

describe("web core: chart geometry", () => {
  it("scales, rounds steps and builds covering ticks", () => {
    const s = linearScale(0, 10, 100, 0);
    assert.equal(s(5), 50);
    assert.equal(linearScale(3, 3, 0, 10)(99), 5);
    assert.equal(niceStep(0.37), 0.5);
    assert.equal(niceStep(23), 25);
    assert.equal(niceStep(70), 100);
    assert.equal(niceStep(-1), 1);
    const { ticks, top } = niceTicks(0, 93, 4);
    assert.deepEqual(ticks, [0, 25, 50, 75, 100]);
    assert.equal(top, 100);
    assert.equal(niceTicks(0, 0).top, 1);
  });

  it("aligns time ticks to local clock steps", () => {
    const from = Date.UTC(2026, 9, 31, 10, 7);
    const ticks = timeTicks(from, from + 3_600_000, 6, 0);
    assert.equal(ticks.length, 6);
    assert.equal(ticks[0], Date.UTC(2026, 9, 31, 10, 10));
    assert.equal((ticks[1] ?? 0) - (ticks[0] ?? 0), 10 * 60_000);
    assert.deepEqual(timeTicks(10, 10), []);
    assert.ok(timeTicks(0, 400 * 86_400_000, 6, 0).length > 6);
  });

  it("splits series at gaps and draws monotone curves that never overshoot", () => {
    const runs = splitByGap([0, 10, 20, 100, 110], (x) => x, 30);
    assert.deepEqual(runs, [[0, 10, 20], [100, 110]]);
    assert.deepEqual(splitByGap([], (x: number) => x, 1), []);
    assert.equal(monotonePath([]), "");
    assert.equal(monotonePath([{ x: 1, y: 2 }]), "M1,2h0.01");
    const pts = [
      { x: 0, y: 100 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 50 },
      { x: 40, y: 50 },
    ];
    const d = monotonePath(pts);
    const ys = [...d.matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    assert.ok(ys.every((y) => y >= 0 && y <= 100), d);
    assert.match(areaPath(pts, 100), /L40,100L0,100Z$/);
    // A sharp knee forces the Fritsch–Carlson tangent clamp; the curve must still stay inside its data range
    const knee = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 100 },
      { x: 3, y: 101 },
    ];
    const kneeYs = [...monotonePath(knee).matchAll(/-?\d+(?:\.\d+)?,(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
    assert.ok(kneeYs.every((y) => y >= 0 && y <= 101), monotonePath(knee));
    assert.equal(areaPath([], 0), "");
    assert.equal(nearestIndex([0, 10, 20], 14), 1);
    assert.equal(nearestIndex([0, 10, 20], 16), 2);
    assert.equal(nearestIndex([0, 10, 20], 99), 2);
    assert.equal(nearestIndex([], 1), -1);
  });
});

describe("web core: history ranges", () => {
  it("checks custom ranges like the daemon clips them", () => {
    const now = 1_000_000_000_000;
    const hour = 3_600_000;
    assert.deepEqual(checkCustomRange(now - hour, now, now), { ok: true, fromMs: now - hour, toMs: now });
    assert.deepEqual(checkCustomRange(now - 200 * hour, now + hour, now), { ok: true, fromMs: now - 168 * hour, toMs: now });
    assert.deepEqual(checkCustomRange(null, now, now), { ok: false, reason: "invalid" });
    assert.deepEqual(checkCustomRange(now, now - 1, now), { ok: false, reason: "order" });
    assert.deepEqual(checkCustomRange(now + 1, now + hour, now), { ok: false, reason: "future" });
    assert.deepEqual(checkCustomRange(now - 300 * hour, now - 200 * hour, now), { ok: false, reason: "too_old" });
    assert.deepEqual(checkCustomRange(now - 10_000, now, now), { ok: false, reason: "too_short" });
  });

  it("keeps the brush in bounds and builds strict integer queries", () => {
    assert.deepEqual(clampBrush({ start: -0.2, end: 0.3 }, 0.05), { start: 0, end: 0.5 });
    assert.deepEqual(clampBrush({ start: 0.9, end: 1.3 }, 0.05), { start: 0.6, end: 1 });
    assert.deepEqual(clampBrush({ start: 0.5, end: 0.5 }, 0.1), { start: 0.5, end: 0.6 });
    assert.deepEqual(brushToRange({ start: 0.25, end: 0.75 }, 0, 4000), { fromMs: 1000, toMs: 3000 });
    assert.equal(timeseriesQuery("6h", null, 360), "preset=6h&maxPoints=360");
    assert.equal(timeseriesQuery("custom", { fromMs: 1.4, toMs: 9.6 }, 5000), "preset=custom&maxPoints=1440&fromMs=1&toMs=10");
  });
});
