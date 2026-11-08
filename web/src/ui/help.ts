import { type HelpTopicId, HELP_TOPICS, helpLabel, helpUrl } from "../core/help.ts";
import type { AppContext } from "./context.ts";
import { type Child, h } from "./dom.ts";

/**
 * A small "?" after a technical term: hover or focus shows one line about it, a click opens the guide
 * where it is explained. Settings → Appearance hides every mark (`<html data-help="off">`).
 *
 * The line is one floating element placed in script: a CSS bubble anchored to the mark was cut off
 * wherever a card clips its content (a "?" near a card's left edge) and sat behind modal drawers.
 */

const EDGE_PX = 8;
const GAP_PX = 8;
let tip: HTMLElement | null = null;
/** The mark whose line is shown: the only one that points at the tip (`aria-describedby`). */
let shownFor: HTMLElement | null = null;
let installed = false;

function tipElement(): HTMLElement {
  if (!tip) {
    tip = h("div", { class: "fs-help-tip", attrs: { role: "tooltip", id: "fsHelpTip" } });
    tip.hidden = true;
  }
  return tip;
}

function show(mark: HTMLElement): void {
  const text = mark.dataset["tip"];
  if (!text) return;
  const el = tipElement();
  // A modal drawer is in the top layer: the tip has to live inside it to be seen above it
  const host = mark.closest("dialog[open]") ?? document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = text;
  el.style.left = "0px";
  el.style.top = "0px";
  el.hidden = false;
  const anchor = mark.getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, EDGE_PX), window.innerWidth - width - EDGE_PX);
  // Above the mark when it fits, otherwise below it
  const above = anchor.top - height - GAP_PX;
  const top = above >= EDGE_PX ? above : Math.min(anchor.bottom + GAP_PX, window.innerHeight - height - EDGE_PX);
  el.style.left = `${Math.max(EDGE_PX, left)}px`;
  el.style.top = `${Math.max(EDGE_PX, top)}px`;
  if (shownFor !== mark) shownFor?.removeAttribute("aria-describedby");
  mark.setAttribute("aria-describedby", "fsHelpTip");
  shownFor = mark;
}

function hide(): void {
  if (tip) tip.hidden = true;
  shownFor?.removeAttribute("aria-describedby");
  shownFor = null;
}

function markOf(target: EventTarget | null): HTMLElement | null {
  const mark = target instanceof Element ? target.closest(".fs-help") : null;
  return mark instanceof HTMLElement ? mark : null;
}

/** Listen once, on the document: marks come and go with every re-render. */
function install(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("mouseover", (event) => {
    const mark = markOf(event.target);
    if (mark) show(mark);
    // A re-render removed the mark under the pointer, and a removed node sends no mouseout
    else if (shownFor && !shownFor.isConnected) hide();
  });
  document.addEventListener("mouseout", (event) => {
    if (markOf(event.target)) hide();
  });
  document.addEventListener("focusin", (event) => {
    const mark = markOf(event.target);
    if (mark) show(mark);
    else hide();
  });
  document.addEventListener("focusout", (event) => {
    if (markOf(event.target)) hide();
  });
  // Escape dismisses the line without moving the pointer or the focus; in a drawer, the first Escape only does that
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !tip || tip.hidden) return;
    event.preventDefault();
    hide();
  });
  window.addEventListener("scroll", hide, true);
  window.addEventListener("resize", hide);
}

export function helpMark(ctx: AppContext, id: HelpTopicId): HTMLElement {
  install();
  const locale = ctx.tr.locale;
  return h(
    "a",
    {
      class: "fs-help",
      attrs: {
        href: helpUrl(id, locale),
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": helpLabel(id, locale),
        "data-tip": HELP_TOPICS[id].tip[locale],
      },
    },
    "?"
  );
}

/** `label` followed by its "?" mark, kept on one line. */
export function withHelp(ctx: AppContext, label: Child, id: HelpTopicId): HTMLElement {
  return h("span", { class: "inline-flex items-center gap-1" }, label, helpMark(ctx, id));
}
