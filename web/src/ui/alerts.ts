import type { ChannelDeliveryStats } from "../../../src/api-contract.ts";
import { formatAgo } from "../core/format.ts";
import { latestAgentTestReminder, mergeAlerts } from "../core/store.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount } from "./dom.ts";
import { ALERTS_SEEN_EVENT } from "./header.ts";
import { emptyState } from "./widgets.ts";

const SEVERITY = {
  info: { cls: "text-info", icon: "info" },
  warning: { cls: "text-warning", icon: "alert" },
  critical: { cls: "text-error", icon: "shield" },
} as const;

/** Recent alerts (SSE `alert` + `GET /api/alerts`) and per-channel delivery statistics. */
export function mountAlerts(ctx: AppContext): { open(): void } {
  const dialog = byId<HTMLDialogElement>("alertsDialog");
  let channels: Record<string, ChannelDeliveryStats> | null = null;
  /** AI agent test reminders this page has already marked read. */
  const readReminders = new Set<string>();

  /** The list shows the AI agent test's latest reminder: it is read, so no more come for that test. */
  const readAgentTestReminder = (): void => {
    const reminder = latestAgentTestReminder(ctx.store.state.alerts);
    if (!reminder || readReminders.has(reminder.id)) return;
    readReminders.add(reminder.id);
    void ctx.api.agentTest({ action: "ack", alertId: reminder.id }).catch(() => undefined);
  };

  const render = (): void => {
    const alerts = [...ctx.store.state.alerts].reverse();
    const now = ctx.now();
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box sm:max-w-lg p-0 flex flex-col max-h-[85vh]" },
        h(
          "div",
          { class: "flex items-center gap-2 px-5 pt-5 pb-3" },
          icon("bell", "text-primary text-lg"),
          h("h3", { class: "text-lg font-bold serif" }, ctx.t("alerts.title")),
          h("form", { class: "ml-auto", attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "div",
          { class: "flex-1 overflow-y-auto px-3 pb-2" },
          alerts.length === 0
            ? emptyState("bell", ctx.t("alerts.empty"))
            : h(
                "ul",
                { class: "space-y-1" },
                ...alerts.map((alert) => {
                  const sev = SEVERITY[alert.severity];
                  return h(
                    "li",
                    { class: "flex gap-3 rounded-xl px-3 py-2 hover:bg-base-content/[0.03]" },
                    icon(sev.icon, `${sev.cls} mt-0.5 shrink-0`),
                    h(
                      "div",
                      { class: "min-w-0 flex-1" },
                      h("div", { class: "text-sm" }, ctx.tr.pick(alert.messageZh, alert.messageEn)),
                      h(
                        "div",
                        { class: "text-[0.6875rem] faint num" },
                        `${ctx.t(`alerts.${alert.severity}`)} · ${alert.code} · ${formatAgo(Date.parse(alert.tsIso), now, ctx.tr.locale)}`
                      )
                    )
                  );
                })
              )
        ),
        h(
          "div",
          { class: "px-5 py-3 border-t border-base-content/[0.06] text-xs space-y-1" },
          h("div", { class: "fs-label" }, ctx.t("alerts.channels")),
          channels === null
            ? h("div", { class: "faint" }, ctx.t("alerts.none_configured"))
            : h(
                "div",
                { class: "space-y-0.5" },
                ...Object.entries(channels).map(([name, stats]) =>
                  h(
                    "div",
                    { class: "flex justify-between gap-3" },
                    h("span", { class: "font-semibold" }, name),
                    h("span", { class: "num muted" }, ctx.t("alerts.channel_stats", { ok: stats.delivered, failed: stats.failed })),
                    stats.lastError ? h("span", { class: "text-error truncate max-w-[12rem]", title: stats.lastError }, stats.lastError) : null
                  )
                )
              )
        )
      ),
      modalBackdrop(ctx.t("common.close"))
    );
  };

  const open = (): void => {
    render();
    dialog.showModal();
    document.dispatchEvent(new CustomEvent(ALERTS_SEEN_EVENT));
    readAgentTestReminder();
    void ctx.api
      .alerts()
      .then((res) => {
        channels = res.notifications;
        ctx.store.update({ alerts: mergeAlerts(ctx.store.state.alerts, res.alerts) }, ["alerts"]);
        if (dialog.open) render();
      })
      .catch(() => undefined);
  };
  ctx.store.subscribe("alerts", () => {
    if (dialog.open) {
      render();
      document.dispatchEvent(new CustomEvent(ALERTS_SEEN_EVENT));
      readAgentTestReminder();
    }
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });
  return { open };
}
