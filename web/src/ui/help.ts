import { type HelpTopicId, HELP_TOPICS, helpLabel, helpUrl } from "../core/help.ts";
import type { AppContext } from "./context.ts";
import { type Child, h } from "./dom.ts";

/**
 * A small "?" after a technical term: hover or focus shows one line about it, a click opens the guide
 * where it is explained. Settings → Appearance hides every mark (`<html data-help="off">`).
 */
export function helpMark(ctx: AppContext, id: HelpTopicId): HTMLElement {
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
