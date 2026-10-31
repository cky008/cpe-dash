import type { GlobalTelemetrySnapshot, NeighborCellEntry } from "../../../src/api-contract.ts";
import { checkCellLockInput, parseBandNumber } from "../../../src/rf-bounds.ts";
import { DASH, formatAgo, formatSigned } from "../core/format.ts";
import { bandLabel, gaugeFraction, qualityLevel } from "../core/rf.ts";
import type { CellLockPrefill } from "./cell-lock.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, perFrame, setText } from "./dom.ts";
import { meter, qualityClass } from "./gauge.ts";
import { cardHead, emptyState, runBusy } from "./widgets.ts";

type RatFilter = "all" | "LTE" | "NR";

function safeBand(band: string): number | null {
  try {
    return parseBandNumber(band);
  } catch {
    return null;
  }
}

/** `rat|arfcn|pci` keys of every serving carrier (PCC, CA components, secondary cells). */
function servingKeys(telemetry: GlobalTelemetrySnapshot | null): Set<string> {
  const keys = new Set<string>();
  if (!telemetry) return keys;
  const rf = telemetry.rf;
  const dl = /DL:\s*(\d+)/i.exec(rf.earfcnRaw)?.[1];
  if (dl && rf.pci !== null) keys.add(`LTE|${dl}|${rf.pci}`);
  for (const cell of [...rf.lteScc, ...rf.nrScc]) {
    if (cell.arfcn !== null && cell.pci !== null) keys.add(`${cell.rat}|${cell.arfcn}|${cell.pci}`);
  }
  return keys;
}

/** The cell-lock form is a lazy chunk: most visits never open it. */
function openCellLock(ctx: AppContext, prefill: CellLockPrefill | null): void {
  void import("./cell-lock.ts").then((m) => m.openCellLockDialog(ctx, prefill));
}

/** 4G / 5G neighbor table with RSRP gradient bars and a guarded "lock to this cell" per row. */
export function mountNeighbors(ctx: AppContext): void {
  const root = byId("neighborsCard");
  let filter: RatFilter = "all";
  let agoLabel: HTMLElement | null = null;

  const scan = (button: HTMLButtonElement): void =>
    runBusy(button, async () => {
      try {
        const res = await ctx.api.scanNeighbors();
        ctx.store.update({ neighbors: res.neighbors, scheduler: res.schedulerStatus }, ["neighbors", "scheduler"]);
      } catch (err) {
        ctx.toast(ctx.describeError(err), "error");
      }
    });

  const row = (cell: NeighborCellEntry, serving: boolean): HTMLElement => {
    const level = qualityLevel("rsrp", cell.rsrpDbm);
    const band = safeBand(cell.band);
    const lockable =
      band !== null && cell.arfcn !== null && checkCellLockInput({ rat: cell.rat, band, arfcn: cell.arfcn, pci: cell.pci }).ok;
    const lockBtn = h(
      "button",
      {
        class: "btn btn-ghost btn-xs rounded-md gap-1 text-warning",
        attrs: { type: "button" },
        title: lockable ? ctx.t("nb.lock") : ctx.t("nb.unsupported"),
      },
      icon("lock"),
      h("span", { class: "hidden lg:inline" }, ctx.t("nb.lock"))
    );
    lockBtn.disabled = !lockable;
    lockBtn.addEventListener("click", () => {
      if (band === null) return;
      openCellLock(ctx, { rat: cell.rat, band, arfcn: cell.arfcn, pci: cell.pci });
    });
    return h(
      "tr",
      { class: serving ? "is-serving" : "" },
      // The band label (N78 / B3) already names the RAT, so phones drop this column
      h("td", { class: "hidden sm:table-cell" }, h("span", { class: `fs-badge ${cell.rat === "NR" ? "text-primary" : ""}` }, cell.rat === "NR" ? "5G" : "4G")),
      h("td", { class: "num font-semibold" }, bandLabel(cell.rat, cell.band), serving ? h("span", { class: "fs-badge text-success ml-1.5" }, ctx.t("nb.serving")) : null),
      h("td", { class: "num" }, cell.arfcn ?? DASH),
      h("td", { class: "num" }, cell.pci ?? DASH),
      h(
        "td",
        { class: "sm:min-w-[9rem]" },
        h("div", { class: "flex items-center gap-2" }, h("span", { class: `num whitespace-nowrap sm:w-16 ${qualityClass(level)}` }, formatSigned(cell.rsrpDbm, "dBm")), h("div", { class: "flex-1 hidden sm:block" }, meter(gaugeFraction("rsrp", cell.rsrpDbm), "", true)))
      ),
      // Phones keep the columns needed to pick a cell; RAT, RSRQ and SINR appear from the sm breakpoint
      h("td", { class: "num hidden sm:table-cell" }, formatSigned(cell.rsrqDb, "dB", 1)),
      h("td", { class: `num hidden sm:table-cell ${qualityClass(qualityLevel("sinr", cell.sinrDb))}` }, formatSigned(cell.sinrDb, "dB")),
      h("td", { class: "text-right" }, lockBtn)
    );
  };

  const render = (): void => {
    const snapshot = ctx.store.state.neighbors;
    const serving = servingKeys(ctx.store.state.telemetry);
    const scanBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("radar"), ctx.t("nb.scan"));
    scanBtn.addEventListener("click", () => scan(scanBtn));
    const manualBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("lock"), ctx.t("nb.manual"));
    manualBtn.addEventListener("click", () => openCellLock(ctx, null));
    const filters = h(
      "div",
      { class: "join" },
      ...(["all", "LTE", "NR"] as const).map((f) => {
        const button = h("button", { class: `btn btn-xs join-item ${filter === f ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" } }, f === "all" ? ctx.t("nb.all") : f === "NR" ? "5G NR" : "4G LTE");
        button.addEventListener("click", () => {
          filter = f;
          render();
        });
        return button;
      })
    );
    agoLabel = h("span", { class: "text-[0.6875rem] faint hidden md:inline" });

    const cells = snapshot ? [...snapshot.nrNeighbors, ...snapshot.lteNeighbors].filter((c) => filter === "all" || c.rat === filter) : [];
    cells.sort((a, b) => (a.rat === b.rat ? (b.rsrpDbm ?? -999) - (a.rsrpDbm ?? -999) : a.rat === "NR" ? -1 : 1));

    const body = !snapshot
      ? emptyState("radar", ctx.t("nb.empty"), ctx.t("nb.waiting"))
      : cells.length === 0
        ? emptyState("radar", ctx.t("nb.empty"))
        : h(
            "div",
            { class: "overflow-x-auto max-h-[26rem] overflow-y-auto" },
            h(
              "table",
              { class: "fs-table" },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  ...(["nb.rat", "nb.band", "nb.arfcn", "nb.pci", "nb.rsrp", "nb.rsrq", "nb.sinr"] as const).map((k) =>
                    h("th", { class: k === "nb.rat" || k === "nb.rsrq" || k === "nb.sinr" ? "hidden sm:table-cell" : "" }, ctx.t(k))
                  ),
                  h("th", { class: "text-right" }, "")
                )
              ),
              h("tbody", null, ...cells.map((cell) => row(cell, serving.has(`${cell.rat}|${cell.arfcn}|${cell.pci}`))))
            )
          );

    mount(
      root,
      cardHead(ctx.t("nb.title"), agoLabel, snapshot ? h("span", { class: "text-[0.6875rem] faint" }, ctx.t("nb.count", { count: snapshot.totalCount })) : null, filters, manualBtn, scanBtn),
      h("div", { class: "fs-card-body pt-1" }, body)
    );
    updateAgo();
  };

  const updateAgo = (): void => {
    const captured = ctx.store.state.neighbors?.capturedAtMs;
    if (agoLabel && captured) setText(agoLabel, ctx.t("nb.updated", { ago: formatAgo(captured, ctx.now(), ctx.tr.locale) }));
  };

  ctx.store.subscribe(["neighbors", "telemetry"], perFrame(render));
  ctx.tr.onChange(render);
  ctx.onTick(updateAgo);
  render();
}
