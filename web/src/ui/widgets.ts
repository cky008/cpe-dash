import type { StatusLine } from "../core/status-view.ts";
import { type Child, h, icon } from "./dom.ts";

/** Shared building blocks: card heads, key/value rows, busy buttons and empty states. */

/**
 * Card title with right-aligned controls. On a narrow screen the controls wrap below the title as a
 * group instead of squeezing it, and no control breaks its own label across lines.
 */
export function cardHead(title: Child, ...trailing: Child[]): HTMLElement {
  return h(
    "div",
    { class: "fs-card-head" },
    h("h2", { class: "fs-card-title" }, title),
    h("div", { class: "ml-auto flex flex-wrap items-center justify-end gap-1.5 *:shrink-0 *:whitespace-nowrap" }, ...trailing)
  );
}

const TONE_CLASS: Readonly<Record<StatusLine["tone"], string>> = { ok: "text-success", warn: "text-warning", bad: "text-error", plain: "" };

/** A status value in the colour of its tone. */
export function toneSpan(line: StatusLine): HTMLElement {
  return h("span", { class: TONE_CLASS[line.tone] }, line.text);
}

export function kv(label: Child, value: Child, valueClass = "num text-right"): HTMLElement {
  return h("div", { class: "fs-kv" }, h("span", { class: "muted shrink-0" }, label), h("span", { class: `${valueClass} min-w-0 truncate` }, value));
}

/** Spinner-guarded async button action. */
export function runBusy(button: HTMLButtonElement, task: () => Promise<void>): void {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("btn-disabled");
  const spinner = h("span", { class: "loading loading-spinner loading-xs" });
  button.prepend(spinner);
  task().finally(() => {
    spinner.remove();
    button.disabled = false;
    button.classList.remove("btn-disabled");
  });
}

/** A section this model does not provide (multi-model phase 2), with the router's code when it gave one. */
export function unavailableState(t: (key: "dev.unavailable" | "dev.unavailable_code", params?: Record<string, string>) => string, iconName: string, code: string | null): HTMLElement {
  return emptyState(iconName, code ? t("dev.unavailable_code", { code }) : t("dev.unavailable"));
}

export function emptyState(iconName: string, title: string, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "flex flex-col items-center justify-center text-center gap-2 py-10 px-6 anim-fade" },
    icon(iconName, "text-3xl faint"),
    h("div", { class: "text-sm muted" }, title),
    hint ? h("div", { class: "text-xs faint max-w-sm" }, hint) : null
  );
}
