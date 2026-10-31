import type { GlobalTelemetrySnapshot } from "../../../src/api-contract.ts";
import { DASH, formatAgo, formatSigned } from "../core/format.ts";
import { accessMode, bandLabel, bestModulation, carrierChips, qualityLevel, txPowerFraction } from "../core/rf.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, setText } from "./dom.ts";
import { gauge, meter, qualityClass } from "./gauge.ts";
import { revealButton, sensitive } from "./sensitive.ts";
import { cardHead, emptyState, kv, runBusy } from "./widgets.ts";

type Rf = GlobalTelemetrySnapshot["rf"];
type McsList = Rf["lteDlMcs"];
type TxPower = Rf["lteTxPower"];

function mcsText(list: McsList): string {
  return list
    .filter((m) => m.index > 0 || m.modulation)
    .map((m) => `${m.index}${m.modulation ? `@${m.modulation}` : ""}`)
    .join(" / ");
}

function modulationRow(label: string, list: McsList): HTMLElement {
  const best = bestModulation(list);
  return kv(
    label,
    h(
      "span",
      { class: "inline-flex items-center gap-1.5" },
      best ? h("span", { class: `fs-badge ${best === "256QAM" || best === "1024QAM" ? "text-success" : ""}` }, best) : h("span", { class: "faint" }, DASH),
      mcsText(list) ? h("span", { class: "num text-[0.6875rem] faint" }, `MCS ${mcsText(list)}`) : null
    ),
    "text-right"
  );
}

function txRows(power: TxPower): HTMLElement {
  const row = (name: string, dbm: number | null): HTMLElement =>
    h(
      "div",
      { class: "grid grid-cols-[3.75rem_1fr_3.5rem] items-center gap-2 text-xs" },
      h("span", { class: "muted" }, name),
      meter(txPowerFraction(dbm), dbm !== null && dbm >= 20 ? "q-1" : "q-3"),
      h("span", { class: "num text-right" }, formatSigned(dbm, "dBm"))
    );
  return h("div", { class: "space-y-1.5 pt-2" }, row("PUSCH", power.puschDbm), row("PUCCH", power.pucchDbm));
}

function bandwidth(dl: number | null, ul: number | null): string {
  if (dl === null && ul === null) return DASH;
  return `${dl ?? DASH} / ${ul ?? DASH} MHz`;
}

/** 5G panorama: NR and LTE legs side by side, each with gauges, link parameters and UE power. */
export function mountRfCard(ctx: AppContext): void {
  const root = byId("rfCard");
  let agoLabel: HTMLElement | null = null;

  const refresh = (button: HTMLButtonElement): void =>
    runBusy(button, async () => {
      const before = ctx.store.state.telemetry?.capturedAtMs ?? 0;
      try {
        const res = await ctx.api.refreshTelemetry();
        ctx.store.update({ scheduler: res.schedulerStatus, avoidance: res.schedulerStatus.avoidance, telemetry: res.telemetry ?? ctx.store.state.telemetry }, ["scheduler", "telemetry"]);
        const fresh = (res.telemetry?.capturedAtMs ?? 0) > before;
        ctx.toast(fresh ? ctx.t("toast.refreshed") : ctx.t("toast.refresh_skipped", { reason: res.schedulerStatus.mode }), fresh ? "success" : "warning");
      } catch (err) {
        ctx.toast(ctx.describeError(err), "error");
      }
    });

  const render = (): void => {
    const telemetry = ctx.store.state.telemetry;
    const refreshBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("refresh"), ctx.t("rf.refresh"));
    refreshBtn.addEventListener("click", () => refresh(refreshBtn));
    agoLabel = h("span", { class: "text-[0.6875rem] faint hidden sm:inline" });

    if (!telemetry) {
      mount(root, cardHead(ctx.t("rf.title"), agoLabel, refreshBtn), emptyState("tower", ctx.t("rf.waiting")));
      return;
    }
    const rf = telemetry.rf;
    const mode = accessMode(rf);
    const chips = carrierChips(rf);
    const nrBands = chips.filter((c) => c.rat === "NR").map((c) => c.band);
    const lteBands = chips.filter((c) => c.rat === "LTE").map((c) => c.band);
    const nrPci = mode === "SA" ? rf.pci : (rf.nrScc[0]?.pci ?? null);

    const nrPanel = h(
      "section",
      { class: "rounded-xl border border-base-content/[0.06] p-3 space-y-2" },
      h(
        "header",
        { class: "flex items-center gap-2" },
        h("span", { class: "fs-badge text-primary" }, ctx.t("rf.nr")),
        h("span", { class: "num text-sm font-semibold" }, nrBands.join(" + ") || DASH),
        h("span", { class: "ml-auto num text-xs muted" }, bandwidth(rf.nrDlBandwidthMhz, rf.nrUlBandwidthMhz))
      ),
      mode === "SA" || mode === "NSA"
        ? h(
            "div",
            { class: "space-y-2" },
            h(
              "div",
              { class: "grid grid-cols-3 gap-1 justify-items-center" },
              gauge(ctx, "rsrp", rf.nrRsrpDbm, ctx.t("rf.rsrp"), "dBm"),
              gauge(ctx, "rsrq", rf.nrRsrqDb, ctx.t("rf.rsrq"), "dB"),
              gauge(ctx, "sinr", rf.nrSinrDb, ctx.t("rf.sinr"), "dB")
            ),
            kv(ctx.t("rf.pci"), nrPci === null ? DASH : String(nrPci)),
            kv(ctx.t("rf.arfcn"), rf.nrArfcnRaw || DASH),
            kv(ctx.t("rf.mimo"), rf.nrMimoRank === null ? DASH : ctx.t("rf.mimo_value", { rank: rf.nrMimoRank })),
            kv(ctx.t("rf.cqi"), [rf.nrCqi0, rf.nrCqi1].filter((v) => v !== null).join(" / ") || DASH),
            modulationRow(ctx.t("rf.mod_ul"), rf.nrUlMcs),
            modulationRow(ctx.t("rf.mod_dl"), rf.nrDlMcs),
            h("div", { class: "fs-label pt-1" }, ctx.t("rf.txpower")),
            txRows(rf.nrTxPower)
          )
        : h("p", { class: "text-sm muted py-6 text-center" }, ctx.t("rf.no_nr"))
    );

    const ltePanel = h(
      "section",
      { class: "rounded-xl border border-base-content/[0.06] p-3 space-y-2" },
      h(
        "header",
        { class: "flex items-center gap-2" },
        h("span", { class: "fs-badge" }, mode === "NSA" ? ctx.t("rf.lte_anchor") : ctx.t("rf.lte")),
        h("span", { class: "num text-sm font-semibold" }, lteBands.join(" + ") || (rf.pccBand ? bandLabel("LTE", rf.pccBand) : DASH)),
        h("span", { class: "ml-auto num text-xs muted" }, bandwidth(rf.lteDlBandwidthMhz, rf.lteUlBandwidthMhz))
      ),
      mode === "SA" || mode === "NONE"
        ? h("p", { class: "text-sm muted py-6 text-center" }, ctx.t("rf.no_lte"))
        : h(
            "div",
            { class: "space-y-2" },
            h(
              "div",
              { class: "grid grid-cols-3 gap-1 justify-items-center" },
              gauge(ctx, "rsrp", rf.lteRsrpDbm, ctx.t("rf.rsrp"), "dBm"),
              gauge(ctx, "rsrq", rf.lteRsrqDb, ctx.t("rf.rsrq"), "dB"),
              gauge(ctx, "sinr", rf.lteSinrDb, ctx.t("rf.sinr"), "dB")
            ),
            kv(ctx.t("rf.pci"), rf.pci === null ? DASH : String(rf.pci)),
            kv(ctx.t("rf.arfcn"), rf.earfcnRaw ? rf.earfcnRaw.replace(":", " ").replace(" UL:", " · UL ") : DASH),
            kv(ctx.t("rf.rssi"), formatSigned(rf.lteRssiDbm, "dBm")),
            kv(ctx.t("rf.mimo"), `${rf.lteMimoRank === null ? DASH : ctx.t("rf.mimo_value", { rank: rf.lteMimoRank })} · ${rf.transmissionMode || DASH}`),
            kv(ctx.t("rf.cqi"), [rf.lteCqi0, rf.lteCqi1].filter((v) => v !== null).join(" / ") || DASH),
            modulationRow(ctx.t("rf.mod_ul"), rf.lteUlMcs),
            modulationRow(ctx.t("rf.mod_dl"), rf.lteDlMcs),
            h("div", { class: "fs-label pt-1" }, ctx.t("rf.txpower")),
            txRows(rf.lteTxPower)
          )
    );

    const scc = [...rf.lteScc, ...rf.nrScc];
    const sccRow =
      scc.length > 0
        ? h(
            "div",
            { class: "pt-1" },
            h("div", { class: "fs-label mb-1.5" }, ctx.t("rf.scc")),
            h(
              "div",
              { class: "flex flex-wrap gap-1.5" },
              ...scc.map((cell) => {
                const level = qualityLevel("rsrp", cell.rsrpDbm);
                return h(
                  "span",
                  { class: "fs-ca-chip", data: { rat: cell.rat } },
                  `${bandLabel(cell.rat, cell.band)} · ${cell.arfcn ?? DASH} · PCI ${cell.pci ?? DASH}`,
                  h("span", { class: `${qualityClass(level)}` }, formatSigned(cell.rsrpDbm, "dBm"))
                );
              })
            )
          )
        : null;

    const identity = h(
      "div",
      { class: "grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-x-4 items-center border-t border-dashed border-base-content/10 pt-2" },
      kv(ctx.t("rf.tac"), sensitive(ctx, "cell", rf.tacDisplay, "cell")),
      kv(ctx.t("rf.cell_id"), sensitive(ctx, "cell", rf.cellIdDisplay, "cell")),
      kv(ctx.t("rf.enodeb"), sensitive(ctx, "cell", rf.eNodeBDisplay, "cell")),
      h("div", { class: "justify-self-end" }, revealButton(ctx, "cell"))
    );

    mount(
      root,
      cardHead(
        ctx.t("rf.title"),
        h(
          "span",
          { class: "inline-flex items-center gap-1.5 text-xs font-semibold" },
          h("span", { class: `fs-dot ${mode === "SA" || mode === "NSA" ? "text-primary is-pulsing" : "faint"}` }),
          ctx.t(`ca.mode_${mode}`)
        ),
        agoLabel,
        refreshBtn
      ),
      h("div", { class: "fs-card-body space-y-3" }, h("div", { class: "grid grid-cols-1 md:grid-cols-2 gap-3" }, nrPanel, ltePanel), identity, sccRow)
    );
    updateAgo();
  };

  const updateAgo = (): void => {
    const captured = ctx.store.state.telemetry?.capturedAtMs;
    if (agoLabel && captured) setText(agoLabel, ctx.t("rf.updated", { ago: formatAgo(captured, ctx.now(), ctx.tr.locale) }));
  };

  ctx.store.subscribe("telemetry", render);
  ctx.privacy.onChange(render);
  ctx.tr.onChange(render);
  ctx.onTick(updateAgo);
  render();
}
