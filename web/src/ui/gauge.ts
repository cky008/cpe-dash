import type { HelpTopicId } from "../core/help.ts";
import { DASH } from "../core/format.ts";
import { type QualityLevel, type SignalMetric, gaugeFraction, qualityLevel } from "../core/rf.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { h, svg } from "./dom.ts";
import { withHelp } from "./help.ts";

/** RF instruments: quality colours, 270° gauge rings and horizontal meters. */

export function qualityClass(level: QualityLevel | null): string {
  return level === null ? "q-none" : `q-${level}`;
}

const QUALITY_KEYS: Readonly<Record<QualityLevel, MessageKey>> = { 0: "rf.q0", 1: "rf.q1", 2: "rf.q2", 3: "rf.q3", 4: "rf.q4" };

export function qualityLabel(ctx: AppContext, level: QualityLevel | null): string {
  return level === null ? DASH : ctx.t(QUALITY_KEYS[level]);
}

const GAUGE_RADIUS = 42;
const GAUGE_SWEEP = 0.75;

/** 270° ring gauge: track + value arc coloured by the metric's quality level. */
export function gauge(ctx: AppContext, metric: SignalMetric, value: number | null, label: string, unit: string, sizeClass = "size-28", help?: HelpTopicId): HTMLElement {
  const circumference = 2 * Math.PI * GAUGE_RADIUS;
  const level = qualityLevel(metric, value);
  const arc = gaugeFraction(metric, value) * GAUGE_SWEEP * circumference;
  const ring = svg(
    "svg",
    { viewBox: "0 0 100 100", "aria-hidden": "true" },
    svg("circle", { class: "track", cx: 50, cy: 50, r: GAUGE_RADIUS, "stroke-width": 8, "stroke-dasharray": `${GAUGE_SWEEP * circumference} ${circumference}` }),
    svg("circle", {
      class: `value ${qualityClass(level)}`,
      cx: 50,
      cy: 50,
      r: GAUGE_RADIUS,
      "stroke-width": 8,
      stroke: "currentColor",
      "stroke-dasharray": `${arc} ${circumference}`,
    })
  );
  return h(
    "div",
    { class: "flex flex-col items-center gap-1", attrs: { role: "meter", "aria-label": label, "aria-valuenow": value === null ? "" : String(value) } },
    h(
      "div",
      { class: `fs-gauge ${sizeClass}` },
      ring,
      h(
        "div",
        { class: "readout" },
        h("span", { class: `num text-xl font-semibold ${qualityClass(level)}` }, value === null ? DASH : String(Math.round(value * 10) / 10)),
        h("span", { class: "text-[0.625rem] faint" }, unit)
      )
    ),
    h("div", { class: "text-xs font-semibold" }, help ? withHelp(ctx, label, help) : label),
    h("div", { class: `text-[0.6875rem] ${qualityClass(level)}` }, qualityLabel(ctx, level))
  );
}

/** Horizontal bar 0..1 (`toneClass` colours the fill via currentColor). */
export function meter(fraction: number, toneClass: string, gradient = false): HTMLElement {
  const pct = `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%`;
  const fill = h("span", { style: `width:${pct}${gradient ? `;--meter-full:${fraction > 0 ? (100 / fraction).toFixed(1) : "100"}%` : ""}` });
  return h("div", { class: `fs-meter ${toneClass} ${gradient ? "is-gradient" : ""}` }, fill);
}
