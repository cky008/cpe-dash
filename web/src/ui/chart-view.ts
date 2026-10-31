import { type BrushWindow, clampBrush } from "../core/time-range.ts";
import { type Point, areaPath, linearScale, monotonePath, nearestIndex, niceTicks, splitByGap, timeTicks } from "../core/chart.ts";
import { formatClock } from "../core/format.ts";
import { h, svg } from "./dom.ts";

/**
 * Reusable SVG time-series chart. The SVG is built once; updates only rewrite `d` attributes and
 * reuse the axis label pool, so a dashboard left open for weeks does not accumulate DOM nodes.
 * The plot stretches with `preserveAspectRatio="none"` while strokes keep their width
 * (`vector-effect: non-scaling-stroke`); text lives in HTML overlays so it never distorts.
 */

const VB_W = 1000;
const VB_H = 200;
const PAD_TOP = 10;
const PAD_BOTTOM = 6;

export interface Series<T> {
  key: string;
  label: string;
  /** `is-dl` / `is-ul` / … (colour via CSS). */
  cls: string;
  value: (item: T) => number | null;
  area?: boolean;
  peak?: boolean;
}

export interface ChartUpdate<T> {
  items: ReadonlyArray<T>;
  fromMs: number;
  toMs: number;
  series: ReadonlyArray<Series<T>>;
  /** Samples further apart than this are not joined (outages, yields). */
  maxGapMs: number;
  /** `true`: the axis starts at 0 (throughput); otherwise it fits the data (dBm). */
  zeroBased: boolean;
  formatY: (value: number) => string;
  formatTooltip: (item: T) => ReadonlyArray<[label: string, value: string, cls: string]>;
  emptyText: string;
}

/** The SVG nodes one series owns; reused frame to frame, removed together when the series goes away. */
interface SeriesPaths {
  line: SVGPathElement;
  area: SVGPathElement | null;
  gradient: SVGLinearGradientElement | null;
}

let chartSeq = 0;

export class TimeChart<T extends { tsMs: number }> {
  readonly el: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #grid: SVGGElement;
  readonly #plot: SVGGElement;
  readonly #defs: SVGDefsElement;
  readonly #crosshair: SVGLineElement;
  readonly #labels: HTMLElement;
  readonly #tooltip: HTMLElement;
  readonly #empty: HTMLElement;
  readonly #id = `chart${++chartSeq}`;
  readonly #paths = new Map<string, SeriesPaths>();
  #last: ChartUpdate<T> | null = null;
  #xs: number[] = [];

  readonly #axes: boolean;

  /** `interactive: false` draws a bare sparkline (no hover, no axis labels), e.g. the brush overview. */
  constructor(heightClass: string, interactive = true) {
    this.#axes = interactive;
    this.#defs = svg("defs");
    this.#grid = svg("g");
    this.#plot = svg("g");
    this.#crosshair = svg("line", { class: "crosshair", y1: 0, y2: VB_H, x1: -10, x2: -10, visibility: "hidden" });
    this.#svg = svg("svg", { viewBox: `0 0 ${VB_W} ${VB_H}`, preserveAspectRatio: "none", "aria-hidden": "true" }, this.#defs, this.#grid, this.#plot, this.#crosshair);
    this.#labels = h("div", { class: "absolute inset-0 pointer-events-none" });
    this.#tooltip = h("div", { class: "fs-tooltip hidden" });
    this.#empty = h("div", { class: "absolute inset-0 hidden flex items-center justify-center text-sm muted" });
    this.el = h("div", { class: `fs-chart ${heightClass}` });
    this.el.append(this.#svg, this.#labels, this.#empty, this.#tooltip);
    if (interactive) {
      this.el.addEventListener("pointermove", (event) => this.#hover(event));
      this.el.addEventListener("pointerleave", () => this.#hideHover());
    }
  }

  update(spec: ChartUpdate<T>): void {
    this.#last = spec;
    this.#xs = spec.items.map((item) => item.tsMs);
    const values: number[] = [];
    for (const item of spec.items) {
      for (const s of spec.series) {
        const v = s.value(item);
        if (v !== null && Number.isFinite(v)) values.push(v);
      }
    }
    const hasData = values.length > 0;
    this.#empty.textContent = spec.emptyText;
    this.#empty.classList.toggle("hidden", hasData);

    const lo = spec.zeroBased ? 0 : Math.min(...(hasData ? values : [0]));
    const hi = Math.max(...(hasData ? values : [1]));
    const { ticks, top } = niceTicks(lo, spec.zeroBased ? Math.max(hi, 0.001) : hi, 4);
    const bottom = spec.zeroBased ? 0 : (ticks[0] ?? lo);
    const x = linearScale(spec.fromMs, spec.toMs, 0, VB_W);
    const y = linearScale(bottom, top, VB_H - PAD_BOTTOM, PAD_TOP);

    this.#drawGrid(ticks.map((t) => ({ y: y(t), label: spec.formatY(t) })), timeTicks(spec.fromMs, spec.toMs, 6).map((t) => ({ x: x(t), label: formatClock(t, spec.toMs - spec.fromMs > 20 * 3_600_000) })));

    const live = new Set<string>();
    for (const s of spec.series) {
      live.add(s.key);
      const runs = splitByGap(
        spec.items.filter((item) => {
          const v = s.value(item);
          return v !== null && Number.isFinite(v);
        }),
        (item) => item.tsMs,
        spec.maxGapMs
      );
      const pointRuns: Point[][] = runs.map((run) => run.map((item) => ({ x: x(item.tsMs), y: y(s.value(item) ?? 0) })));
      const paths = this.#pathsFor(s);
      paths.line.setAttribute("d", pointRuns.map((pts) => monotonePath(pts)).join(""));
      paths.area?.setAttribute("d", pointRuns.map((pts) => areaPath(pts, y(bottom))).join(""));
    }
    for (const [key, paths] of this.#paths) {
      if (live.has(key)) continue;
      paths.line.remove();
      paths.area?.remove();
      paths.gradient?.remove(); // a series toggled back on creates it again under the same id
      this.#paths.delete(key);
    }
  }

  #pathsFor(s: Series<T>): SeriesPaths {
    const existing = this.#paths.get(s.key);
    if (existing) return existing;
    let area: SVGPathElement | null = null;
    let gradient: SVGLinearGradientElement | null = null;
    if (s.area) {
      const gradientId = `${this.#id}-${s.key}`;
      gradient = svg(
        "linearGradient",
        { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1, class: s.cls },
        svg("stop", { offset: "0%", "stop-color": "currentColor", "stop-opacity": 0.28 }),
        svg("stop", { offset: "100%", "stop-color": "currentColor", "stop-opacity": 0 })
      );
      this.#defs.appendChild(gradient);
      area = svg("path", { fill: `url(#${gradientId})`, stroke: "none" });
      this.#plot.appendChild(area);
    }
    const line = svg("path", { class: `line ${s.cls} ${s.peak ? "is-peak" : ""}` });
    this.#plot.appendChild(line);
    const entry = { line, area, gradient };
    this.#paths.set(s.key, entry);
    return entry;
  }

  #drawGrid(rows: ReadonlyArray<{ y: number; label: string }>, cols: ReadonlyArray<{ x: number; label: string }>): void {
    if (!this.#axes) return;
    this.#grid.replaceChildren(...rows.map((r) => svg("line", { class: "grid-line", x1: 0, x2: VB_W, y1: r.y, y2: r.y })));
    const labels: HTMLElement[] = [];
    for (const r of rows) {
      labels.push(h("span", { class: "fs-axis", style: `left:2px;top:calc(${(r.y / VB_H) * 100}% - 0.8rem)` }, r.label));
    }
    for (const c of cols) {
      if (c.x < 30 || c.x > VB_W - 30) continue;
      labels.push(h("span", { class: "fs-axis", style: `left:${(c.x / VB_W) * 100}%;bottom:-1.1rem;transform:translateX(-50%)` }, c.label));
    }
    this.#labels.replaceChildren(...labels);
  }

  #hover(event: PointerEvent): void {
    const spec = this.#last;
    if (!spec || spec.items.length === 0) return;
    const rect = this.el.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const ts = spec.fromMs + fraction * (spec.toMs - spec.fromMs);
    const index = nearestIndex(this.#xs, ts);
    const item = spec.items[index];
    if (!item) return;
    const vbX = ((item.tsMs - spec.fromMs) / (spec.toMs - spec.fromMs)) * VB_W;
    this.#crosshair.setAttribute("x1", String(vbX));
    this.#crosshair.setAttribute("x2", String(vbX));
    this.#crosshair.setAttribute("visibility", "visible");
    const rows = spec.formatTooltip(item).map(([label, value, cls]) =>
      h("div", { class: "flex items-center gap-2" }, h("span", { class: `size-2 rounded-full ${cls}`, style: "background: currentColor" }), h("span", { class: "opacity-70" }, label), h("span", { class: "num ml-auto pl-3" }, value))
    );
    this.#tooltip.replaceChildren(h("div", { class: "num opacity-70 mb-1" }, formatClock(item.tsMs, true)), ...rows);
    this.#tooltip.classList.remove("hidden");
    const px = (vbX / VB_W) * rect.width;
    const tipWidth = this.#tooltip.offsetWidth;
    const left = px + 12 + tipWidth > rect.width ? px - 12 - tipWidth : px + 12;
    this.#tooltip.style.left = `${Math.max(0, left)}px`;
    this.#tooltip.style.top = "4px";
  }

  #hideHover(): void {
    this.#crosshair.setAttribute("visibility", "hidden");
    this.#tooltip.classList.add("hidden");
  }
}

/**
 * Timeline brush over an overview strip. Drag the window to pan, its handles to resize, or click
 * the strip to centre the window there. Reports the window as 0..1 fractions.
 */
export class Brush {
  readonly el: HTMLElement;
  readonly #window: HTMLElement;
  readonly #onChange: (win: BrushWindow | null) => void;
  #win: BrushWindow | null = null;

  constructor(overview: HTMLElement, onChange: (win: BrushWindow | null) => void) {
    this.#onChange = onChange;
    this.#window = h("div", { class: "fs-brush hidden" }, h("span", { class: "handle is-left", data: { edge: "start" } }), h("span", { class: "handle is-right", data: { edge: "end" } }));
    this.el = h("div", { class: "relative" }, overview, this.#window);
    this.el.addEventListener("pointerdown", (event) => this.#start(event));
  }

  get window(): BrushWindow | null {
    return this.#win;
  }

  reset(): void {
    this.#win = null;
    this.#render();
  }

  #render(): void {
    this.#window.classList.toggle("hidden", this.#win === null);
    if (!this.#win) return;
    this.#window.style.left = `${this.#win.start * 100}%`;
    this.#window.style.width = `${(this.#win.end - this.#win.start) * 100}%`;
  }

  #start(event: PointerEvent): void {
    const rect = this.el.getBoundingClientRect();
    if (rect.width === 0) return;
    const at = (clientX: number): number => (clientX - rect.left) / rect.width;
    const origin = at(event.clientX);
    const target = event.target instanceof HTMLElement ? event.target : null;
    const edge = target?.dataset["edge"];
    const startWin = this.#win ?? { start: Math.max(0, origin - 0.1), end: Math.min(1, origin + 0.1) };
    const insideWindow = this.#win !== null && origin >= this.#win.start && origin <= this.#win.end;
    if (!edge && !insideWindow) {
      const width = startWin.end - startWin.start;
      this.#win = clampBrush({ start: origin - width / 2, end: origin + width / 2 }, 0.02);
      this.#render();
    }
    const base = this.#win ?? startWin;
    const pointerId = event.pointerId;
    this.el.setPointerCapture(pointerId);
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      const delta = at(e.clientX) - origin;
      if (edge === "start") this.#win = clampBrush({ start: Math.min(base.start + delta, base.end - 0.02), end: base.end }, 0.02);
      else if (edge === "end") this.#win = clampBrush({ start: base.start, end: Math.max(base.end + delta, base.start + 0.02) }, 0.02);
      else this.#win = clampBrush({ start: base.start + delta, end: base.end + delta }, 0.02);
      this.#render();
    };
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      // Detach first: releasing a capture the browser already dropped (cancel, lost capture) can throw
      this.el.removeEventListener("pointermove", move);
      this.el.removeEventListener("pointerup", up);
      this.el.removeEventListener("pointercancel", up);
      this.el.removeEventListener("lostpointercapture", up);
      if (this.el.hasPointerCapture(pointerId)) this.el.releasePointerCapture(pointerId);
      this.#onChange(this.#win);
    };
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.el.addEventListener("pointercancel", up);
    this.el.addEventListener("lostpointercapture", up);
  }
}
