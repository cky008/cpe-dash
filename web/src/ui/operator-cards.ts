import { DASH } from "../core/format.ts";
import { accessMode, caSummary, carrierChips, signalBars } from "../core/rf.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount } from "./dom.ts";
import { cardHead, kv } from "./widgets.ts";

const SIM_KEYS: Readonly<Record<string, MessageKey>> = { "1": "op.sim_ready", "0": "op.sim_invalid", "255": "op.sim_absent" };

function signalBarsEl(level: number): HTMLElement {
  const heights = ["h-[30%]", "h-[52%]", "h-[76%]", "h-full"];
  return h(
    "span",
    { class: "inline-flex items-end gap-[2px] h-3.5", attrs: { "aria-label": `${level}/4` } },
    ...heights.map((height, i) => h("i", { class: `w-[3px] rounded-sm ${height} ${i < level ? "bg-base-content/75" : "bg-base-content/15"}` }))
  );
}

/** Operator & SIM card and the 3CA capsule (`PCC B1(20M) + SCC B3(20M) + 5G N78(100M)`). */
export function mountOperatorCards(ctx: AppContext): void {
  const operatorRoot = byId("operatorCard");
  const caRoot = byId("caCard");

  const render = (): void => {
    const telemetry = ctx.store.state.telemetry;
    const rf = telemetry?.rf;
    const device = telemetry?.device;
    const mode = rf ? accessMode(rf) : "NONE";
    const chips = rf ? carrierChips(rf) : [];
    mount(
      operatorRoot,
      cardHead(ctx.t("op.title"), rf ? signalBarsEl(signalBars(rf)) : null),
      h(
        "div",
        { class: "fs-card-body" },
        h(
          "div",
          { class: "flex items-baseline gap-2 mb-2" },
          h("span", { class: "text-xl font-bold truncate" }, rf?.operatorName || DASH),
          h("span", { class: "num text-xs faint" }, rf?.plmnNumeric ?? "")
        ),
        kv(ctx.t("op.mode"), h("span", { class: `fs-badge ${mode === "SA" || mode === "NSA" ? "text-primary" : ""}` }, ctx.t(`ca.mode_${mode}`)), "text-right"),
        kv(ctx.t("op.sim"), device ? ctx.t(SIM_KEYS[device.simStatus] ?? "common.unknown") : DASH, "text-right"),
        kv(
          ctx.t("op.connection"),
          device
            ? device.connectionStatus === "901"
              ? h("span", { class: "text-success" }, ctx.t("op.connected"))
              : h("span", { class: "text-warning" }, ctx.t("op.disconnected", { code: device.connectionStatus || "?" }))
            : DASH,
          "text-right"
        )
      )
    );

    const totalBw = rf?.totalAggregatedBandwidthMhz ?? 0;
    mount(
      caRoot,
      cardHead(ctx.t("ca.title"), icon("layers", "muted")),
      h(
        "div",
        { class: "fs-card-body space-y-3" },
        chips.length > 0
          ? h(
              "div",
              { class: "fs-ca", attrs: { "aria-label": caSummary(chips) } },
              ...chips.map((chip) => h("span", { class: "fs-ca-chip", data: { rat: chip.rat, role: chip.role }, title: `ARFCN ${chip.arfcn}` }, chip.label))
            )
          : h("div", { class: "text-sm muted" }, ctx.t("ca.none")),
        h(
          "div",
          { class: "flex items-center justify-between text-sm" },
          h("span", { class: "font-semibold" }, rf ? (rf.caActive && rf.caComponentCount > 1 ? ctx.t("ca.active", { count: rf.caComponentCount, bandwidth: totalBw }) : ctx.t("ca.single", { bandwidth: totalBw })) : DASH),
          h(
            "span",
            { class: "inline-flex items-center gap-1.5 text-xs font-semibold" },
            h("span", { class: `fs-dot ${mode === "SA" || mode === "NSA" ? "text-primary is-pulsing" : "faint"}` }),
            ctx.t(`ca.mode_${mode}`)
          )
        )
      )
    );
  };

  ctx.store.subscribe("telemetry", render);
  ctx.tr.onChange(render);
  render();
}
