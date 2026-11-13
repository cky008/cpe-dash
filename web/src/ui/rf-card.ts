import type { GlobalTelemetrySnapshot } from "../../../src/api-contract.ts";
import { DASH, formatAgo, formatSigned } from "../core/format.ts";
import { accessMode, bandLabel, bestModulation, carrierChips, qualityLevel, txPowerFraction } from "../core/rf.ts";
import type { AppContext } from "./context.ts";
import { type Child, byId, h, icon, mount, setText } from "./dom.ts";
import { gauge, meter, qualityClass } from "./gauge.ts";
import { revealButton, sensitive } from "./sensitive.ts";
import { helpMark, withHelp } from "./help.ts";
import { cardHead, emptyState, kv, runBusy, unavailableState } from "./widgets.ts";

type Rf = GlobalTelemetrySnapshot["rf"];
type McsList = Rf["lteDlMcs"];
type TxPower = Rf["lteTxPower"];

function mcsText(list: McsList): string {
  return list
    .filter((m) => m.index > 0 || m.modulation)
    .map((m) => `${m.index}${m.modulation ? `@${m.modulation}` : ""}`)
    .join(" / ");
}

function modulationRow(label: Child, list: McsList): HTMLElement {
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
  // SRS and PRACH where the router reports them (a HiLink router's `<txpower>` / `<nrtxpower>` does)
  return h(
    "div",
    { class: "space-y-1.5 pt-2" },
    row("PUSCH", power.puschDbm),
    row("PUCCH", power.pucchDbm),
    power.srsDbm !== null ? row("SRS", power.srsDbm) : null,
    power.prachDbm !== null ? row("PRACH", power.prachDbm) : null
  );
}

/** Downlink layers, and the uplink's where the router reports them (`DL 4 layers · UL 2 layers`). */
function mimoText(ctx: AppContext, dl: number | null, ul: number | null): string {
  const parts = [dl === null ? DASH : ctx.t("rf.mimo_value", { rank: dl })];
  if (ul !== null) parts.push(ctx.t("rf.mimo_value_ul", { rank: ul }));
  return parts.join(" · ");
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
    // A model nobody verified that answers no signal reading: nothing to draw, rather than an empty radio
    if (telemetry.unavailable?.includes("signal")) {
      mount(root, cardHead(ctx.t("rf.title"), agoLabel, refreshBtn), unavailableState(ctx.t, "tower", null));
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
        h("span", { class: "ml-auto num text-xs muted inline-flex items-center gap-1" }, bandwidth(rf.nrDlBandwidthMhz, rf.nrUlBandwidthMhz), helpMark(ctx, "bandwidth"))
      ),
      mode === "SA" || mode === "NSA"
        ? h(
            "div",
            { class: "space-y-2" },
            h(
              "div",
              { class: "grid grid-cols-3 gap-1 justify-items-center" },
              gauge(ctx, "rsrp", rf.nrRsrpDbm, ctx.t("rf.rsrp"), "dBm", undefined, "rsrp"),
              gauge(ctx, "rsrq", rf.nrRsrqDb, ctx.t("rf.rsrq"), "dB", undefined, "rsrq"),
              gauge(ctx, "sinr", rf.nrSinrDb, ctx.t("rf.sinr"), "dB", undefined, "sinr")
            ),
            kv(withHelp(ctx, ctx.t("rf.pci"), "pci"), nrPci === null ? DASH : String(nrPci)),
            kv(withHelp(ctx, ctx.t("rf.arfcn"), "arfcn"), rf.nrArfcnRaw || DASH),
            kv(withHelp(ctx, ctx.t("rf.mimo"), "mimo"), mimoText(ctx, rf.nrMimoRank, mode === "SA" ? rf.ulMimoLayers : null)),
            kv(withHelp(ctx, ctx.t("rf.cqi"), "cqi"), [rf.nrCqi0, rf.nrCqi1].filter((v) => v !== null).join(" / ") || DASH),
            modulationRow(withHelp(ctx, ctx.t("rf.mod_ul"), "mcs"), rf.nrUlMcs),
            modulationRow(withHelp(ctx, ctx.t("rf.mod_dl"), "mcs"), rf.nrDlMcs),
            h("div", { class: "fs-label pt-1" }, withHelp(ctx, ctx.t("rf.txpower"), "tx-power")),
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
        mode === "NSA" ? helpMark(ctx, "anchor") : null,
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
              gauge(ctx, "rsrp", rf.lteRsrpDbm, ctx.t("rf.rsrp"), "dBm", undefined, "rsrp"),
              gauge(ctx, "rsrq", rf.lteRsrqDb, ctx.t("rf.rsrq"), "dB", undefined, "rsrq"),
              gauge(ctx, "sinr", rf.lteSinrDb, ctx.t("rf.sinr"), "dB", undefined, "sinr")
            ),
            kv(withHelp(ctx, ctx.t("rf.pci"), "pci"), rf.pci === null ? DASH : String(rf.pci)),
            kv(withHelp(ctx, ctx.t("rf.arfcn"), "arfcn"), rf.earfcnRaw ? rf.earfcnRaw.replace(":", " ").replace(" UL:", " · UL ") : DASH),
            kv(withHelp(ctx, ctx.t("rf.rssi"), "rssi"), formatSigned(rf.lteRssiDbm, "dBm")),
            kv(withHelp(ctx, ctx.t("rf.mimo"), "mimo"), `${mimoText(ctx, rf.lteMimoRank, rf.ulMimoLayers)} · ${rf.transmissionMode || DASH}`),
            kv(withHelp(ctx, ctx.t("rf.cqi"), "cqi"), [rf.lteCqi0, rf.lteCqi1].filter((v) => v !== null).join(" / ") || DASH),
            modulationRow(withHelp(ctx, ctx.t("rf.mod_ul"), "mcs"), rf.lteUlMcs),
            modulationRow(withHelp(ctx, ctx.t("rf.mod_dl"), "mcs"), rf.lteDlMcs),
            h("div", { class: "fs-label pt-1" }, withHelp(ctx, ctx.t("rf.txpower"), "tx-power")),
            txRows(rf.lteTxPower)
          )
    );

    // The link as a whole (RRC, QoS class) and a 3G serving cell, where the router reports them
    const link =
      rf.rrcConnected !== null || rf.qci !== null
        ? h(
            "div",
            { class: "grid grid-cols-1 sm:grid-cols-2 gap-x-4" },
            rf.rrcConnected !== null ? kv(withHelp(ctx, ctx.t("rf.rrc"), "rrc"), ctx.t(rf.rrcConnected ? "rf.rrc_connected" : "rf.rrc_idle"), "text-right") : null,
            rf.qci !== null ? kv(withHelp(ctx, ctx.t("rf.qci"), "qci"), String(rf.qci)) : null
          )
        : null;
    const wcdma = rf.wcdma
      ? h(
          "section",
          { class: "rounded-xl border border-base-content/[0.06] p-3", data: { rat: "wcdma" } },
          h("header", { class: "flex items-center gap-2 mb-1" }, h("span", { class: "fs-badge" }, ctx.t("rf.wcdma")), helpMark(ctx, "wcdma")),
          h(
            "div",
            { class: "grid grid-cols-1 sm:grid-cols-3 gap-x-4" },
            kv(ctx.t("rf.rscp"), formatSigned(rf.wcdma.rscpDbm, "dBm")),
            kv(ctx.t("rf.ecio"), formatSigned(rf.wcdma.ecioDb, "dB")),
            kv(ctx.t("rf.psc"), rf.wcdma.psc === null ? DASH : String(rf.wcdma.psc))
          )
        )
      : null;

    const scc = [...rf.lteScc, ...rf.nrScc];
    const sccRow =
      scc.length > 0
        ? h(
            "div",
            { class: "pt-1" },
            h("div", { class: "fs-label mb-1.5" }, withHelp(ctx, ctx.t("rf.scc"), "pcc-scc")),
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
      kv(withHelp(ctx, ctx.t("rf.tac"), "cell-id"), sensitive(ctx, "cell", rf.tacDisplay, "cell")),
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
      h("div", { class: "fs-card-body space-y-3" }, h("div", { class: "grid grid-cols-1 md:grid-cols-2 gap-3" }, nrPanel, ltePanel), wcdma, link, identity, sccRow)
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
