import { DASH } from "../core/format.ts";
import { type SensitiveKind, displayValue, isServerRedacted } from "../core/privacy.ts";
import type { AppContext } from "./context.ts";
import { h, icon } from "./dom.ts";

/** Privacy-aware rendering of identifiers (IMEI, IMSI, numbers, IPs, MACs, cell fingerprints). */

/** A sensitive value: masked per privacy scope, or a "redacted by server" badge for placeholders. */
export function sensitive(ctx: AppContext, kind: SensitiveKind, value: string, scope: string, serverRedacted = false): HTMLElement {
  if (!value) return h("span", { class: "faint" }, DASH);
  if (isServerRedacted(value)) {
    return h("span", { class: "fs-badge", data: { kind: "redacted" }, title: ctx.t("id.server_redacted_hint") }, icon("lock"), ctx.t("id.server_redacted"));
  }
  const shown = displayValue(kind, value, ctx.privacy.isMasked(scope) && !serverRedacted);
  return h("span", { class: "num select-all", title: serverRedacted ? ctx.t("id.server_redacted_hint") : "" }, shown);
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
