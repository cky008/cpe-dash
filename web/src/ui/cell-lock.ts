import {
  H168_383_LTE_BANDS,
  H168_383_NR_BANDS,
  MAX_PCI,
  type RatName,
  arfcnRangeOf,
  checkCellLockInput,
} from "../../../src/rf-bounds.ts";
import { bandLabel } from "../core/rf.ts";
import { lockRollbackNote } from "../core/self-heal-view.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount } from "./dom.ts";
import { helpMark } from "./help.ts";

export interface CellLockPrefill {
  rat: RatName;
  band: number;
  arfcn: number | null;
  pci: number | null;
}

/**
 * Cell / frequency lock form. Every field is checked with `checkCellLockInput` from
 * src/rf-bounds.ts — the very function behind the daemon's own validation — so the form shows the
 * exact bound (LTE PCI 0–503, NR PCI 0–1007, the band's 3GPP downlink ARFCN range) before sending.
 */
export function openCellLockDialog(ctx: AppContext, prefill: CellLockPrefill | null): void {
  const dialog = byId<HTMLDialogElement>("cellLockDialog");
  let rat: RatName = prefill?.rat ?? "NR";

  const ratSelect = h("select", { class: "select select-sm rounded-lg w-full" }, h("option", { attrs: { value: "LTE" } }, "LTE"), h("option", { attrs: { value: "NR" } }, "NR (5G)"));
  const bandSelect = h("select", { class: "select select-sm rounded-lg w-full num" });
  const arfcnInput = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { type: "number", inputmode: "numeric", min: "0", step: "1" } });
  const pciInput = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { type: "number", inputmode: "numeric", min: "0", step: "1" } });
  const freqOnly = h("input", { class: "checkbox checkbox-sm", attrs: { type: "checkbox" } });
  const arfcnHint = h("p", { class: "text-[0.6875rem] faint mt-1" });
  const pciHint = h("p", { class: "text-[0.6875rem] faint mt-1" });
  const bandHint = h("p", { class: "text-[0.6875rem] faint mt-1" });
  const formError = h("div", { class: "text-sm text-error min-h-5", attrs: { role: "alert" } });
  const submit = h("button", { class: "btn btn-warning btn-sm rounded-lg gap-1.5", attrs: { type: "submit" } }, icon("lock"), ctx.t("cl.confirm"));
  // Whether a lock that cuts the WAN is rolled back on its own, said before it is applied
  const rollback = lockRollbackNote(ctx.store.state.selfHeal, ctx.t);

  const fillBands = (selected: number | null): void => {
    const bands = rat === "LTE" ? H168_383_LTE_BANDS : H168_383_NR_BANDS;
    mount(bandSelect, ...bands.map((b) => h("option", { attrs: { value: String(b) } }, bandLabel(rat, b))));
    bandSelect.value = String(selected !== null && bands.includes(selected) ? selected : (bands[0] ?? ""));
    bandHint.textContent = ctx.t("cl.band_hint", { bands: bands.map((b) => bandLabel(rat, b)).join(" ") });
  };

  const validate = (): ReturnType<typeof checkCellLockInput> => {
    const band = Number(bandSelect.value);
    const range = arfcnRangeOf(rat, band);
    arfcnHint.textContent = range ? ctx.t("cl.arfcn_hint", { band: bandLabel(rat, band), min: range[0], max: range[1] }) : "";
    pciHint.textContent = ctx.t("cl.pci_hint", { rat, max: MAX_PCI[rat] });
    pciInput.max = String(MAX_PCI[rat]);
    pciInput.disabled = freqOnly.checked;
    const check = checkCellLockInput({
      rat,
      band,
      arfcn: arfcnInput.value.trim() === "" ? Number.NaN : Number(arfcnInput.value),
      pci: freqOnly.checked ? null : pciInput.value.trim() === "" ? Number.NaN : Number(pciInput.value),
    });
    for (const [el, field] of [
      [arfcnInput, "arfcn"],
      [pciInput, "pci"],
    ] as const) {
      el.classList.toggle("input-error", !check.ok && check.field === field && el.value.trim() !== "");
    }
    if (check.ok) formError.textContent = "";
    else if (check.field === "band") formError.textContent = ctx.t("cl.err_band");
    else if (check.field === "arfcn" && arfcnInput.value.trim() !== "") formError.textContent = ctx.t("cl.err_arfcn", { min: check.range?.[0] ?? 0, max: check.range?.[1] ?? 0 });
    else if (check.field === "pci" && pciInput.value.trim() !== "") formError.textContent = ctx.t("cl.err_pci", { max: MAX_PCI[rat] });
    else formError.textContent = "";
    submit.disabled = !check.ok;
    return check;
  };

  ratSelect.addEventListener("change", () => {
    rat = ratSelect.value === "LTE" ? "LTE" : "NR";
    fillBands(null);
    validate();
  });
  for (const el of [bandSelect, arfcnInput, pciInput, freqOnly]) {
    el.addEventListener("input", () => validate());
    el.addEventListener("change", () => validate());
  }

  const form = h(
    "form",
    { class: "modal-box sm:max-w-md space-y-3" },
    h("h3", { class: "text-lg font-bold serif flex items-center gap-2" }, icon("lock", "text-warning"), ctx.t("cl.title"), helpMark(ctx, "lock-cell")),
    h(
      "div",
      { class: "grid grid-cols-2 gap-3" },
      h("label", { class: "block" }, h("span", { class: "fs-label" }, ctx.t("cl.rat")), ratSelect),
      h("label", { class: "block" }, h("span", { class: "fs-label" }, ctx.t("cl.band")), bandSelect)
    ),
    bandHint,
    h("label", { class: "block" }, h("span", { class: "fs-label" }, ctx.t("cl.arfcn")), arfcnInput, arfcnHint),
    h("label", { class: "block" }, h("span", { class: "fs-label" }, ctx.t("cl.pci")), pciInput, pciHint),
    h("label", { class: "flex items-center gap-2 text-sm cursor-pointer" }, freqOnly, ctx.t("cl.freq_only")),
    h(
      "div",
      { class: "fs-notice", data: { tone: "pending" } },
      icon("alert", "text-warning mt-0.5"),
      h("span", null, ctx.t("cl.warning"), rollback ? h("span", { class: "block mt-1" }, rollback) : null)
    ),
    formError,
    h(
      "div",
      { class: "modal-action mt-0" },
      h("button", { class: "btn btn-ghost btn-sm rounded-lg", attrs: { type: "button" }, on: { click: () => dialog.close() } }, ctx.t("common.cancel")),
      submit
    )
  );

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const check = validate();
    if (!check.ok) return;
    submit.disabled = true;
    ctx.api
      .cellLock({ rat: check.value.rat, band: check.value.band, arfcn: check.value.arfcn, pci: check.value.pci })
      .then((res) => {
        ctx.store.update({ lockState: res.lockState }, ["locks"]);
        ctx.toast(ctx.t("cl.applied"), "success");
        dialog.close();
      })
      .catch((err: unknown) => {
        formError.textContent = ctx.describeError(err);
        submit.disabled = false;
      });
  });

  ratSelect.value = rat;
  fillBands(prefill?.band ?? null);
  arfcnInput.value = prefill?.arfcn === null || prefill?.arfcn === undefined ? "" : String(prefill.arfcn);
  pciInput.value = prefill?.pci === null || prefill?.pci === undefined ? "" : String(prefill.pci);
  freqOnly.checked = prefill !== null && prefill.pci === null;
  mount(dialog, form, modalBackdrop(ctx.t("common.close")));
  validate();
  dialog.showModal();
}
