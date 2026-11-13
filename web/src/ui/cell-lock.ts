import { MAX_PCI, type RatName } from "../../../src/rf-bounds.ts";
import { cellLockForm } from "../core/lock-form.ts";
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
 * Cell / frequency lock form. Every field is checked the way the daemon checks it for the router in
 * use (`cellLockForm`), so the form shows the exact bound (LTE PCI 0–503, NR PCI 0–1007, the band's
 * 3GPP downlink ARFCN range) before sending. The verified router lists its own bands and may lock a
 * frequency alone; a router of another brand takes any 3GPP band and names a cell, and where its
 * brand locks several candidate cells at once the form takes more of them (`maxCells`).
 */
export function openCellLockDialog(ctx: AppContext, prefill: CellLockPrefill | null): void {
  const dialog = byId<HTMLDialogElement>("cellLockDialog");
  const lockForm = cellLockForm(ctx.store.state.scheduler);
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

  // Further candidate cells, on a router that locks several of this RAT at once (the router picks among them)
  const moreRows: Array<{ band: HTMLSelectElement; arfcn: HTMLInputElement; pci: HTMLInputElement; row: HTMLElement }> = [];
  const moreList = h("div", { class: "space-y-2" });
  const moreHint = h("p", { class: "text-[0.6875rem] faint" });
  const moreAdd = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("plus"), ctx.t("cl.more_add"));
  const moreBox = h("div", { class: "space-y-2" }, h("span", { class: "fs-label" }, ctx.t("cl.more_title")), moreHint, moreList, moreAdd);
  const syncMore = (): void => {
    const max = lockForm.maxCells(rat);
    moreBox.hidden = max <= 1;
    moreHint.textContent = ctx.t("cl.more_hint", { max });
    moreAdd.disabled = moreRows.length >= max - 1;
  };
  const addMoreRow = (): void => {
    const band = h("select", { class: "select select-sm rounded-lg w-full num", attrs: { "aria-label": ctx.t("cl.band") } });
    mount(band, ...lockForm.bands(rat).map((b) => h("option", { attrs: { value: String(b) } }, bandLabel(rat, b))));
    band.value = bandSelect.value;
    const arfcn = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { type: "number", inputmode: "numeric", min: "0", step: "1", "aria-label": ctx.t("cl.arfcn") } });
    const pci = h("input", { class: "input input-sm rounded-lg w-full num", attrs: { type: "number", inputmode: "numeric", min: "0", step: "1", "aria-label": ctx.t("cl.pci") } });
    const entry = { band, arfcn, pci, row: h("div") };
    const remove = h("button", { class: "btn btn-ghost btn-xs btn-square rounded-lg", attrs: { type: "button", "aria-label": ctx.t("cl.more_remove"), title: ctx.t("cl.more_remove") } }, icon("x"));
    remove.addEventListener("click", () => {
      moreRows.splice(moreRows.indexOf(entry), 1);
      entry.row.remove();
      syncMore();
      validate();
    });
    entry.row = h("div", { class: "grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center" }, band, arfcn, pci, remove);
    for (const el of [band, arfcn, pci]) {
      el.addEventListener("input", () => validate());
      el.addEventListener("change", () => validate());
    }
    moreRows.push(entry);
    moreList.append(entry.row);
    syncMore();
    validate();
    arfcn.focus();
  };
  moreAdd.addEventListener("click", () => addMoreRow());
  /** The candidate cells as the daemon takes them, or what is wrong with the first that is not right. */
  const readMore = (first: { arfcn: number; pci: number | null }): { ok: true; cells: Array<{ band: number; arfcn: number; pci: number }> } | { ok: false; message: string } => {
    const seen = new Set<string>([`${first.arfcn}/${first.pci}`]);
    const cells: Array<{ band: number; arfcn: number; pci: number }> = [];
    for (const [i, entry] of moreRows.entries()) {
      const check = lockForm.check({ rat, band: Number(entry.band.value), arfcn: entry.arfcn.value.trim() === "" ? Number.NaN : Number(entry.arfcn.value), pci: entry.pci.value.trim() === "" ? Number.NaN : Number(entry.pci.value) });
      const n = i + 2;
      if (!check.ok) {
        const reason = check.field === "arfcn" ? ctx.t("cl.err_arfcn", { min: check.range?.[0] ?? 0, max: check.range?.[1] ?? 0 }) : check.field === "pci" ? ctx.t("cl.err_pci", { max: MAX_PCI[rat] }) : ctx.t("cl.err_band");
        return { ok: false, message: ctx.t("cl.err_more", { n, reason }) };
      }
      if (check.value.pci === null) return { ok: false, message: ctx.t("cl.err_more", { n, reason: ctx.t("cl.err_pci", { max: MAX_PCI[rat] }) }) };
      const key = `${check.value.arfcn}/${check.value.pci}`;
      if (seen.has(key)) return { ok: false, message: ctx.t("cl.err_more", { n, reason: ctx.t("cl.err_dup") }) };
      seen.add(key);
      cells.push({ band: check.value.band, arfcn: check.value.arfcn, pci: check.value.pci });
    }
    return { ok: true, cells };
  };

  const fillBands = (selected: number | null): void => {
    const bands = lockForm.bands(rat);
    mount(bandSelect, ...bands.map((b) => h("option", { attrs: { value: String(b) } }, bandLabel(rat, b))));
    bandSelect.value = String(selected !== null && bands.includes(selected) ? selected : (bands[0] ?? ""));
    // The verified router's own bands are few enough to name; another brand gets the whole 3GPP table
    bandHint.textContent = lockForm.driver ? ctx.t("cl.band_hint_any") : ctx.t("cl.band_hint", { bands: bands.map((b) => bandLabel(rat, b)).join(" ") });
  };

  const validate = (): ReturnType<typeof lockForm.check> => {
    const band = Number(bandSelect.value);
    const range = lockForm.range(rat, band);
    arfcnHint.textContent = range ? ctx.t("cl.arfcn_hint", { band: bandLabel(rat, band), min: range[0], max: range[1] }) : "";
    pciHint.textContent = ctx.t("cl.pci_hint", { rat, max: MAX_PCI[rat] });
    pciInput.max = String(MAX_PCI[rat]);
    pciInput.disabled = freqOnly.checked;
    const check = lockForm.check({
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
    const more = check.ok && moreRows.length > 0 ? readMore(check.value) : null;
    if (check.ok && more && !more.ok) {
      formError.textContent = more.message;
      submit.disabled = true;
      return check;
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
    // Candidate cells are of one network: another one starts the list again
    for (const entry of moreRows.splice(0)) entry.row.remove();
    syncMore();
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
    lockForm.pciRequired ? null : h("label", { class: "flex items-center gap-2 text-sm cursor-pointer" }, freqOnly, ctx.t("cl.freq_only")),
    moreBox,
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
    const more = moreRows.length > 0 ? readMore(check.value) : null;
    if (more && !more.ok) return;
    submit.disabled = true;
    ctx.api
      .cellLock({ rat: check.value.rat, band: check.value.band, arfcn: check.value.arfcn, pci: check.value.pci, ...(more?.ok && more.cells.length > 0 ? { more: more.cells } : {}) })
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
  syncMore();
  validate();
  dialog.showModal();
}
