import { DASH } from "../core/format.ts";
import { type SensitiveKind, displayValue } from "../core/privacy.ts";
import type { AppContext } from "./context.ts";
import { h, icon } from "./dom.ts";

/** Privacy-aware rendering of identifiers (IMEI, IMSI, numbers, IPs, MACs, cell fingerprints). */

/** A sensitive value, masked while its privacy scope is. */
export function sensitive(ctx: AppContext, kind: SensitiveKind, value: string, scope: string): HTMLElement {
  if (!value) return h("span", { class: "faint" }, DASH);
  return h("span", { class: "num select-all" }, displayValue(kind, value, ctx.privacy.isMasked(scope)));
}

/** Eye button that flips one privacy scope (the header button flips all of them). */
export function revealButton(ctx: AppContext, scope: string): HTMLButtonElement {
  const masked = ctx.privacy.isMasked(scope);
  const button = h(
    "button",
    {
      class: `btn btn-ghost btn-xs btn-square rounded-md ${masked ? "" : "text-primary"}`,
      title: ctx.t(masked ? "id.reveal" : "id.mask"),
      attrs: { type: "button", "aria-pressed": String(!masked), "aria-label": ctx.t(masked ? "id.reveal" : "id.mask") },
    },
    icon(masked ? "eye-off" : "eye", "text-sm")
  );
  button.addEventListener("click", () => ctx.privacy.toggleScope(scope));
  return button;
}
