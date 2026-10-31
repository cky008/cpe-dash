import type { TimeSeriesBucketPoint, TimeSeriesPreset } from "../../../src/api-contract.ts";
import { DASH, formatBitRate, formatClock, formatSigned, joinScaled, parseDateTimeLocalValue, toDateTimeLocalValue, toMbps } from "../core/format.ts";
import { type LiveSample, seedLive } from "../core/store.ts";
import { type BrushWindow, FIXED_PRESETS, brushToRange, checkCustomRange, timeseriesQuery } from "../core/time-range.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { Brush, type Series, TimeChart } from "./chart-view.ts";
import { byId, debounce, h, icon, mount, setText } from "./dom.ts";
import { cardHead } from "./widgets.ts";

const LIVE_WINDOW_MS = 15 * 60_000;
const HISTORY_REFRESH_MS = 60_000;

type Metric = "throughput" | "signal";

const RANGE_ERRORS: Readonly<Record<"invalid" | "order" | "future" | "too_old" | "too_short", MessageKey>> = {
  invalid: "chart.range_invalid",
  order: "chart.range_order",
  future: "chart.range_future",
  too_old: "chart.range_too_old",
  too_short: "chart.range_too_short",
};

function mbpsLabel(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100);
}

function bucketLabel(ms: number): string {
  return ms >= 3_600_000 ? `${ms / 3_600_000}h` : ms >= 60_000 ? `${ms / 60_000}m` : `${ms / 1000}s`;
}

/** Live 15-minute throughput from SSE `speed` frames plus the multi-scale history with zoom. */
export function mountCharts(ctx: AppContext): void {
  const root = byId("chartsCard");
  const liveChart = new TimeChart<LiveSample>("h-44 mt-1 mb-5");
  const historyChart = new TimeChart<TimeSeriesBucketPoint>("h-56 mt-1 mb-5");
  const overview = new TimeChart<TimeSeriesBucketPoint>("h-12", false);

  let preset: TimeSeriesPreset = "1h";
  let custom: { fromMs: number; toMs: number } | null = null;
  let metric: Metric = "throughput";
  let base: { fromMs: number; toMs: number; points: TimeSeriesBucketPoint[]; bucketMs: number } | null = null;
  let zoomed: { fromMs: number; toMs: number; points: TimeSeriesBucketPoint[]; bucketMs: number } | null = null;
  let requestSeq = 0;

  const liveNow = h("div", { class: "flex items-center gap-4 text-sm" });
  const statusLine = h("div", { class: "text-[0.6875rem] faint num" });
  const rangeError = h("div", { class: "text-xs text-error" });
  const fromInput = h("input", { class: "input input-xs rounded-md num", attrs: { type: "datetime-local" } });
  const toInput = h("input", { class: "input input-xs rounded-md num", attrs: { type: "datetime-local" } });
  const customRow = h("form", { class: "hidden flex flex-wrap items-center gap-2 text-xs" });
  const presetBar = h("div", { class: "join" });
  const metricBar = h("div", { class: "join" });
  const resetZoom = h("button", { class: "btn btn-ghost btn-xs rounded-md hidden", attrs: { type: "button" } });
  const brush = new Brush(overview.el, (win) => onBrush(win));

  const throughputSeries = (peaks: boolean): ReadonlyArray<Series<TimeSeriesBucketPoint>> => [
    { key: "dl", label: ctx.t("chart.download"), cls: "is-dl", value: (p) => toMbps(p.dlAvgBps), area: true },
    { key: "ul", label: ctx.t("chart.upload"), cls: "is-ul", value: (p) => toMbps(p.ulAvgBps), area: true },
    ...(peaks
      ? [
          { key: "dlPeak", label: `${ctx.t("chart.download")} ${ctx.t("chart.peak")}`, cls: "is-dl", value: (p: TimeSeriesBucketPoint) => toMbps(p.dlPeakBps), peak: true },
          { key: "ulPeak", label: `${ctx.t("chart.upload")} ${ctx.t("chart.peak")}`, cls: "is-ul", value: (p: TimeSeriesBucketPoint) => toMbps(p.ulPeakBps), peak: true },
        ]
      : []),
  ];
  const signalSeries = (): ReadonlyArray<Series<TimeSeriesBucketPoint>> => [
    { key: "nrRsrp", label: ctx.t("chart.nr_rsrp"), cls: "is-dl", value: (p) => p.nrRsrpAvgDbm },
    { key: "lteRsrp", label: ctx.t("chart.lte_rsrp"), cls: "is-ul", value: (p) => p.lteRsrpAvgDbm },
  ];

  const historyTooltip = (p: TimeSeriesBucketPoint): ReadonlyArray<[string, string, string]> =>
    metric === "throughput"
      ? [
          [ctx.t("chart.download"), `${joinScaled(formatBitRate(p.dlAvgBps))} · ${ctx.t("chart.peak")} ${joinScaled(formatBitRate(p.dlPeakBps))}`, "is-dl"],
          [ctx.t("chart.upload"), `${joinScaled(formatBitRate(p.ulAvgBps))} · ${ctx.t("chart.peak")} ${joinScaled(formatBitRate(p.ulPeakBps))}`, "is-ul"],
        ]
      : [
          [ctx.t("chart.nr_rsrp"), formatSigned(p.nrRsrpAvgDbm, "dBm", 1), "is-dl"],
          [ctx.t("chart.nr_sinr"), formatSigned(p.nrSinrAvgDb, "dB", 1), "is-dl"],
          [ctx.t("chart.lte_rsrp"), formatSigned(p.lteRsrpAvgDbm, "dBm", 1), "is-ul"],
          [ctx.t("chart.lte_sinr"), formatSigned(p.lteSinrAvgDb, "dB", 1), "is-ul"],
        ];

  const drawHistory = (): void => {
    const shown = zoomed ?? base;
    if (!shown) return;
    historyChart.update({
      items: shown.points,
      fromMs: shown.fromMs,
      toMs: shown.toMs,
      series: metric === "throughput" ? throughputSeries(true) : signalSeries(),
      maxGapMs: shown.bucketMs * 2.5,
      zeroBased: metric === "throughput",
      formatY: metric === "throughput" ? (v) => `${mbpsLabel(v)}${v === 0 ? "" : " Mbps"}` : (v) => `${v} dBm`,
      formatTooltip: historyTooltip,
      emptyText: ctx.t("chart.empty"),
    });
    if (base) {
      overview.update({
        items: base.points,
        fromMs: base.fromMs,
        toMs: base.toMs,
        series: throughputSeries(false).slice(0, 1),
        maxGapMs: base.bucketMs * 2.5,
        zeroBased: true,
        formatY: () => "",
        formatTooltip: () => [],
        emptyText: "",
      });
    }
    const zoomText = zoomed ? ctx.t("chart.zoomed", { from: formatClock(zoomed.fromMs, true), to: formatClock(zoomed.toMs, true) }) : ctx.t("chart.brush_hint");
    setText(statusLine, `${ctx.t("chart.bucket", { bucket: bucketLabel(shown.bucketMs) })} · ${zoomText}`);
    resetZoom.classList.toggle("hidden", zoomed === null);
  };

  const maxPoints = (): number => Math.min(1440, Math.max(120, Math.round(historyChart.el.clientWidth / 2) || 360));

  const loadBase = async (): Promise<void> => {
    const seq = ++requestSeq;
    try {
      const res = await ctx.api.timeseries(timeseriesQuery(preset, custom, maxPoints()));
      if (seq !== requestSeq) return;
      base = { fromMs: res.fromMs, toMs: res.toMs, points: res.points, bucketMs: res.bucketMs };
      if (brush.window) await loadZoom(brush.window);
      else zoomed = null;
      drawHistory();
    } catch (err) {
      if (seq === requestSeq) setText(statusLine, ctx.describeError(err));
    }
  };

  const loadZoom = async (win: BrushWindow): Promise<void> => {
    if (!base) return;
    const range = brushToRange(win, base.fromMs, base.toMs);
    const seq = ++requestSeq;
    try {
      const res = await ctx.api.timeseries(timeseriesQuery("custom", range, maxPoints()));
      if (seq !== requestSeq) return;
      zoomed = { fromMs: res.fromMs, toMs: res.toMs, points: res.points, bucketMs: res.bucketMs };
      drawHistory();
    } catch (err) {
      if (seq === requestSeq) setText(statusLine, ctx.describeError(err));
    }
  };

  const zoomLater = debounce((win: BrushWindow) => void loadZoom(win), 250);
  const onBrush = (win: BrushWindow | null): void => {
    if (!win || win.end - win.start >= 0.999) {
      brush.reset();
      zoomed = null;
      drawHistory();
      return;
    }
    zoomLater(win);
  };

  const drawLive = (): void => {
    const samples = ctx.store.state.live;
    const last = samples.at(-1);
    const toMs = last?.tsMs ?? ctx.now();
    const fromMs = toMs - LIVE_WINDOW_MS;
    liveChart.update({
      items: samples.filter((s) => s.tsMs >= fromMs),
      fromMs,
      toMs,
      series: [
        { key: "dl", label: ctx.t("chart.download"), cls: "is-dl", value: (s) => toMbps(s.downloadBps), area: true },
        { key: "ul", label: ctx.t("chart.upload"), cls: "is-ul", value: (s) => toMbps(s.uploadBps), area: true },
      ],
      maxGapMs: 20_000,
      zeroBased: true,
      formatY: (v) => `${mbpsLabel(v)}${v === 0 ? "" : " Mbps"}`,
      formatTooltip: (s) => [
        [ctx.t("chart.download"), joinScaled(formatBitRate(s.downloadBps)), "is-dl"],
        [ctx.t("chart.upload"), joinScaled(formatBitRate(s.uploadBps)), "is-ul"],
      ],
      emptyText: ctx.t("chart.waiting_live"),
    });
    const dl = formatBitRate(last?.downloadBps ?? 0);
    const ul = formatBitRate(last?.uploadBps ?? 0);
    mount(
      liveNow,
      h("span", { class: "inline-flex items-baseline gap-1 fs-chart" }, h("span", { class: "size-2 rounded-full is-dl self-center", style: "background: currentColor" }), ctx.t("chart.download"), h("b", { class: "num is-dl" }, last ? dl.value : DASH), h("span", { class: "text-xs faint" }, dl.unit)),
      h("span", { class: "inline-flex items-baseline gap-1 fs-chart" }, h("span", { class: "size-2 rounded-full is-ul self-center", style: "background: currentColor" }), ctx.t("chart.upload"), h("b", { class: "num is-ul" }, last ? ul.value : DASH), h("span", { class: "text-xs faint" }, ul.unit))
    );
  };

  const renderControls = (): void => {
    mount(
      presetBar,
      ...[...FIXED_PRESETS, "custom" as const].map((p) => {
        const button = h("button", { class: `btn btn-xs join-item ${p === preset ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" } }, p === "custom" ? ctx.t("chart.custom") : p);
        button.addEventListener("click", () => {
          preset = p;
          customRow.classList.toggle("hidden", p !== "custom");
          brush.reset();
          zoomed = null;
          renderControls();
          if (p !== "custom") void loadBase();
          else if (!custom) {
            const now = ctx.now();
            fromInput.value = toDateTimeLocalValue(now - 3 * 3_600_000);
            toInput.value = toDateTimeLocalValue(now);
          }
        });
        return button;
      })
    );
    mount(
      metricBar,
      ...(["throughput", "signal"] as const).map((m) => {
        const button = h("button", { class: `btn btn-xs join-item ${m === metric ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" } }, ctx.t(m === "throughput" ? "chart.metric_throughput" : "chart.metric_signal"));
        button.addEventListener("click", () => {
          metric = m;
          renderControls();
          drawHistory();
        });
        return button;
      })
    );
    mount(
      customRow,
      h("label", { class: "inline-flex items-center gap-1" }, ctx.t("chart.from"), fromInput),
      h("label", { class: "inline-flex items-center gap-1" }, ctx.t("chart.to"), toInput),
      h("button", { class: "btn btn-primary btn-xs rounded-md", attrs: { type: "submit" } }, ctx.t("chart.apply")),
      rangeError
    );
    resetZoom.replaceChildren(icon("refresh"), ctx.t("chart.reset_zoom"));
  };

  customRow.addEventListener("submit", (event) => {
    event.preventDefault();
    const check = checkCustomRange(parseDateTimeLocalValue(fromInput.value), parseDateTimeLocalValue(toInput.value), ctx.now());
    if (!check.ok) {
      rangeError.textContent = ctx.t(RANGE_ERRORS[check.reason]);
      return;
    }
    rangeError.textContent = "";
    custom = { fromMs: check.fromMs, toMs: check.toMs };
    brush.reset();
    zoomed = null;
    void loadBase();
  });
  resetZoom.addEventListener("click", () => onBrush(null));

  const render = (): void => {
    renderControls();
    mount(
      root,
      cardHead(ctx.t("chart.live_title"), liveNow),
      h("div", { class: "px-4 sm:px-5" }, liveChart.el),
      h(
        "div",
        { class: "fs-card-head flex-wrap gap-y-2 border-t border-dashed border-base-content/10 mt-1" },
        h("h2", { class: "fs-card-title" }, ctx.t("chart.history_title")),
        h("div", { class: "ml-auto flex flex-wrap items-center gap-2" }, metricBar, presetBar, resetZoom)
      ),
      h("div", { class: "px-4 sm:px-5 space-y-2 pb-4" }, customRow, historyChart.el, h("div", { class: "pt-4 rounded-lg" }, h("div", { class: "rounded-lg bg-base-content/[0.03]" }, brush.el)), statusLine)
    );
    drawLive();
    drawHistory();
  };

  // The live ring only grows from SSE frames: start it from the daemon's 5 s tier instead of blank
  const seedLiveChart = async (): Promise<void> => {
    const toMs = ctx.now();
    try {
      const res = await ctx.api.timeseries(timeseriesQuery("custom", { fromMs: toMs - LIVE_WINDOW_MS, toMs }, LIVE_WINDOW_MS / 5_000));
      ctx.store.update({ live: seedLive(ctx.store.state.live, res.points, res.bucketMs) }, ["live"]);
    } catch {
      // Nothing lost: the chart keeps filling from the stream
    }
  };

  ctx.store.subscribe("live", drawLive);
  ctx.tr.onChange(render);
  setInterval(() => {
    // offsetParent is null while the dashboard is not displayed (SMS view, or signed out after expiry)
    if (!document.hidden && root.offsetParent !== null && preset !== "custom" && brush.window === null) void loadBase();
  }, HISTORY_REFRESH_MS);
  render();
  void loadBase();
  void seedLiveChart();
}
