import { DASH, formatBitRate, formatBytes, formatDuration, joinScaled } from "../core/format.ts";
import { savePreference } from "../core/prefs.ts";
import { type UsageLevel, parseByteSize, routerMonthlyCapBytes, usageLevel, usageRatio } from "../core/traffic.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount, perFrame, svg } from "./dom.ts";
import { cardHead } from "./widgets.ts";

const LEVEL_CLASS: Readonly<Record<UsageLevel, string>> = {
  none: "text-base-content/25",
  ok: "text-primary",
  warn: "text-warning",
  over: "text-error",
};

function usageRing(label: string, usedBytes: number, capBytes: number | null, capText: string): HTMLElement {
  const ratio = usageRatio(usedBytes, capBytes);
  const level = usageLevel(ratio);
  const r = 40;
  const c = 2 * Math.PI * r;
  const arc = ratio === null ? c : Math.min(1, ratio) * c;
  const used = formatBytes(usedBytes);
  return h(
    "div",
    { class: "flex flex-col items-center gap-1.5" },
    h(
      "div",
      { class: "fs-gauge size-32" },
      svg(
        "svg",
        { viewBox: "0 0 100 100", "aria-hidden": "true", style: "transform: rotate(-90deg)" },
        svg("circle", { class: "track", cx: 50, cy: 50, r, "stroke-width": 9 }),
        svg("circle", { class: `value ${LEVEL_CLASS[level]}`, cx: 50, cy: 50, r, "stroke-width": 9, stroke: "currentColor", "stroke-dasharray": `${arc} ${c}`, opacity: ratio === null ? "0.35" : "1" })
      ),
      h(
        "div",
        { class: "readout" },
        h("span", { class: "num text-lg font-semibold" }, used.value),
        h("span", { class: "text-[0.625rem] faint" }, used.unit),
        ratio === null ? null : h("span", { class: `num text-[0.6875rem] font-semibold ${LEVEL_CLASS[level]}` }, `${Math.round(ratio * 100)}%`)
      )
    ),
    h("div", { class: "text-sm font-semibold" }, label),
    h("div", { class: "text-[0.6875rem] faint" }, capText)
  );
}

/** Today / this-month usage rings against browser-local caps (router plan limit as fallback). */
export function mountTrafficCard(ctx: AppContext): void {
  const root = byId("trafficCard");
  const dialog = byId<HTMLDialogElement>("capsDialog");

  const openCaps = (): void => {
    const router = routerMonthlyCapBytes(ctx.store.state.telemetry?.traffic.dataLimitRaw ?? "");
    const daily = h("input", { class: "input input-sm w-full rounded-lg num", attrs: { type: "text", placeholder: ctx.t("traffic.caps_placeholder") } });
    const monthly = h("input", { class: "input input-sm w-full rounded-lg num", attrs: { type: "text", placeholder: ctx.t("traffic.caps_placeholder") } });
    daily.value = ctx.prefs.dailyCapBytes ? joinScaled(formatBytes(ctx.prefs.dailyCapBytes)).replace(" ", "").replace("iB", "B") : "";
    monthly.value = ctx.prefs.monthlyCapBytes ? joinScaled(formatBytes(ctx.prefs.monthlyCapBytes)).replace(" ", "").replace("iB", "B") : "";
    const error = h("div", { class: "text-xs text-error min-h-4" });
    const save = h("button", { class: "btn btn-primary btn-sm rounded-lg", attrs: { type: "submit" } }, ctx.t("common.save"));
    const form = h(
      "form",
      { class: "modal-box sm:max-w-sm space-y-4" },
      h("h3", { class: "text-lg font-bold serif" }, ctx.t("traffic.caps_title")),
      h("label", { class: "block space-y-1" }, h("span", { class: "fs-label" }, ctx.t("traffic.caps_daily")), daily),
      h("label", { class: "block space-y-1" }, h("span", { class: "fs-label" }, ctx.t("traffic.caps_monthly")), monthly),
      h("p", { class: "text-xs muted" }, ctx.t("traffic.caps_hint", { router: router ? joinScaled(formatBytes(router)) : ctx.t("traffic.caps_router_none") })),
      error,
      h(
        "div",
        { class: "modal-action mt-0" },
        h("button", { class: "btn btn-ghost btn-sm rounded-lg", attrs: { type: "button", value: "cancel" }, on: { click: () => dialog.close() } }, ctx.t("common.cancel")),
        save
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const parse = (input: HTMLInputElement): number | null | "invalid" => {
        const raw = input.value.trim();
        if (!raw) return null;
        return parseByteSize(raw) ?? "invalid";
      };
      const d = parse(daily);
      const m = parse(monthly);
      if (d === "invalid" || m === "invalid") {
        error.textContent = ctx.t("traffic.caps_invalid", { value: d === "invalid" ? daily.value : monthly.value });
        return;
      }
      ctx.prefs.dailyCapBytes = d;
      ctx.prefs.monthlyCapBytes = m;
      savePreference(ctx.storage, "dailyCapBytes", d);
      savePreference(ctx.storage, "monthlyCapBytes", m);
      dialog.close();
      render();
    });
    mount(dialog, form, modalBackdrop(ctx.t("common.close")));
    dialog.showModal();
    daily.focus();
  };

  const render = (): void => {
    const telemetry = ctx.store.state.telemetry;
    const traffic = telemetry?.traffic;
    // A model nobody verified may lack the counters (or the month statistics, which also hold today)
    const noRates = telemetry?.unavailable?.includes("traffic") === true;
    const noMonth = telemetry?.unavailable?.includes("month") === true;
    const last = ctx.store.state.live.at(-1);
    const dl = formatBitRate(last?.downloadBps ?? traffic?.downloadBps ?? 0);
    const ul = formatBitRate(last?.uploadBps ?? traffic?.uploadBps ?? 0);
    const rate = (value: { value: string; unit: string }, color: string): HTMLElement =>
      noRates
        ? h("div", { class: "num text-2xl font-semibold faint" }, DASH, h("span", { class: "block text-[0.6875rem] font-normal" }, ctx.t("dev.part_unavailable")))
        : h("div", { class: "num text-2xl font-semibold", style: `color: var(${color})` }, value.value, h("span", { class: "text-xs font-normal muted ml-1" }, value.unit));
    const routerCap = routerMonthlyCapBytes(traffic?.dataLimitRaw ?? "");
    const monthlyCap = ctx.prefs.monthlyCapBytes ?? routerCap;
    const dailyCap = ctx.prefs.dailyCapBytes;
    const capsBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("sliders"), ctx.t("traffic.set_caps"));
    capsBtn.addEventListener("click", openCaps);

    mount(
      root,
      cardHead(ctx.t("traffic.title"), capsBtn),
      h(
        "div",
        { class: "fs-card-body space-y-3" },
        h(
          "div",
          { class: "grid grid-cols-2 gap-2" },
          h(
            "div",
            { class: "rounded-xl p-2.5 bg-base-content/[0.03]" },
            h("div", { class: "flex items-center gap-1 text-xs muted" }, icon("arrow-down", "chart-dl"), ctx.t("traffic.rate_dl")),
            rate(dl, "--dl")
          ),
          h(
            "div",
            { class: "rounded-xl p-2.5 bg-base-content/[0.03]" },
            h("div", { class: "flex items-center gap-1 text-xs muted" }, icon("arrow-up"), ctx.t("traffic.rate_ul")),
            rate(ul, "--ul")
          )
        ),
        noMonth
          ? h("div", { class: "text-xs faint text-center py-4" }, `${ctx.t("traffic.today")} · ${ctx.t("traffic.month")}: ${ctx.t("dev.part_unavailable")}`)
          : h(
              "div",
              { class: "grid grid-cols-2 gap-2 justify-items-center" },
              usageRing(ctx.t("traffic.today"), traffic?.todayUsedBytes ?? 0, dailyCap, dailyCap ? ctx.t("traffic.cap", { cap: joinScaled(formatBytes(dailyCap)) }) : ctx.t("traffic.no_cap")),
              usageRing(ctx.t("traffic.month"), traffic?.monthTotalBytes ?? 0, monthlyCap, monthlyCap ? ctx.t("traffic.cap", { cap: joinScaled(formatBytes(monthlyCap)) }) : ctx.t("traffic.no_cap"))
            ),
        traffic && !noMonth
          ? h(
              "div",
              { class: "text-xs muted text-center space-y-0.5" },
              h("div", { class: "num" }, ctx.t("traffic.month_split", { dl: joinScaled(formatBytes(traffic.monthDownloadBytes)), ul: joinScaled(formatBytes(traffic.monthUploadBytes)) })),
              h(
                "div",
                null,
                traffic.billingStartDay ? ctx.t("traffic.billing_day", { day: traffic.billingStartDay }) : "",
                traffic.billingStartDay ? " · " : "",
                formatDuration(traffic.sessionConnectTimeSec, ctx.tr.locale)
              )
            )
          : h("div", { class: "text-xs faint text-center" }, DASH)
      )
    );
  };

  ctx.store.subscribe(["telemetry", "live"], perFrame(render));
  ctx.tr.onChange(render);
  render();
}
