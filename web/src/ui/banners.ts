import { formatClock } from "../core/format.ts";
import type { AppContext } from "./context.ts";
import { type Child, byId, h, icon, mount } from "./dom.ts";

type BannerTone = "warn" | "danger" | "info";

const WRONG_PASSWORD_CODES = new Set(["108006", "108002", "108001"]);


function banner(tone: BannerTone, iconName: string, title: string, lines: ReadonlyArray<string>, action: Child = null, breathe = false): HTMLElement {
  return h(
    "div",
    { class: `fs-banner ${breathe ? "fs-breathe" : ""}`, data: { tone }, attrs: { role: tone === "danger" ? "alert" : "status" } },
    icon(iconName, `text-lg mt-0.5 ${tone === "danger" ? "text-error" : tone === "warn" ? "text-warning" : "text-info"}`),
    h("div", { class: "flex-1 min-w-0 space-y-0.5" }, h("div", { class: "font-semibold" }, title), ...lines.map((line) => h("div", { class: "muted" }, line))),
    action
  );
}

/**
 * Global state banners under the header, most severe first: breaker (423), lost SSE stream (503 /
 * restart), peer standby, human admin online (breathing amber), CPE unreachable, lock drift.
 */
export function mountBanners(ctx: AppContext, opts: { reconnectNow(): void; refreshStatus(): Promise<void> }): void {
  const area = byId("bannerArea");
  let resetting = false;

  const resetBreaker = (button: HTMLButtonElement): void => {
    if (resetting) return;
    resetting = true;
    button.disabled = true;
    ctx.api
      .resetBreaker()
      .then((res) => {
        ctx.store.update({ scheduler: res.status, avoidance: res.status.avoidance }, ["scheduler"]);
        ctx.toast(ctx.t("banner.breaker_reset_ok"), "success");
      })
      .catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"))
      .finally(() => {
        resetting = false;
        button.disabled = false;
        void opts.refreshStatus();
      });
  };

  const render = (): void => {
    const { scheduler, avoidance, sse, lockVerification } = ctx.store.state;
    const nodes: HTMLElement[] = [];
    const breaker = scheduler?.circuitBreaker;

    if (breaker?.tripped) {
      const code = breaker.code ?? "?";
      const lines: string[] = [];
      if (code === "108007") {
        lines.push(ctx.t("banner.breaker_locked", { wait: breaker.waitTime ?? "?" }), ctx.t("banner.breaker_fix_lock"));
      } else if (WRONG_PASSWORD_CODES.has(code)) {
        lines.push(ctx.t("banner.breaker_wrong_password", { remain: breaker.remainCount ?? "?" }), ctx.t("banner.breaker_fix_password"));
      } else if (code === "115002") {
        lines.push(ctx.t("banner.breaker_password_change"), ctx.t("banner.breaker_fix_password_change"));
      } else {
        if (breaker.reason) lines.push(breaker.reason);
        lines.push(ctx.t("banner.breaker_fix_password"));
      }
      if (breaker.trippedAtIso) lines.push(ctx.t("banner.since", { time: formatClock(Date.parse(breaker.trippedAtIso), true) }));
      // Only a lockout can be reset as it is; any other latch is cleared by a tested save in the settings
      const action = code !== "108007"
        ? h("button", { class: "btn btn-error btn-sm rounded-lg shrink-0 self-center", attrs: { type: "button" }, data: { action: "open-settings" } }, icon("settings"), ctx.t("banner.breaker_open_settings"))
        : h("button", { class: "btn btn-error btn-sm rounded-lg shrink-0 self-center", attrs: { type: "button" }, on: { click: (event) => resetBreaker(event.currentTarget as HTMLButtonElement) } }, icon("refresh"), ctx.t("banner.breaker_reset"));
      nodes.push(banner("danger", "shield", ctx.t("banner.breaker_title", { code }), lines, action));
    }

    if (sse.state === "reconnecting") {
      const seconds = sse.nextRetryAtMs ? Math.max(0, Math.ceil((sse.nextRetryAtMs - ctx.now()) / 1000)) : 0;
      const button = h("button", { class: "btn btn-ghost btn-sm rounded-lg shrink-0 self-center", attrs: { type: "button" } }, icon("refresh"), ctx.t("banner.reconnect_now"));
      button.addEventListener("click", () => opts.reconnectNow());
      nodes.push(banner("info", "activity", ctx.t("banner.reconnect_title"), [ctx.t("banner.reconnect_body", { attempt: Math.max(1, sse.attempt), seconds })], button));
    }

    if (scheduler?.peerStandby.active) {
      nodes.push(banner("warn", "network", ctx.t("banner.standby_title"), [ctx.t("banner.standby_body", { address: scheduler.peerStandby.peerAddress ?? "?" })]));
    }

    if (avoidance?.active) {
      const lines: string[] = [];
      if (avoidance.layer === 2) {
        const seconds = avoidance.cooldownUntilMs ? Math.max(0, Math.ceil((avoidance.cooldownUntilMs - ctx.now()) / 1000)) : 0;
        lines.push(ctx.t("banner.yield_l2", { code: avoidance.stateCode ?? "108003", seconds }));
      } else {
        lines.push(ctx.t("banner.yield_l1", { code: avoidance.stateCode ?? "0" }));
      }
      if (avoidance.sinceIso) lines.push(ctx.t("banner.since", { time: formatClock(Date.parse(avoidance.sinceIso), false) }));
      nodes.push(banner("warn", "user", ctx.t("banner.yield_title"), lines, null, true));
    }

    if (scheduler?.mode === "cpe_unreachable") {
      nodes.push(banner("warn", "alert", ctx.t("banner.unreachable_title"), [ctx.t("banner.unreachable_body", { error: scheduler.lastError ?? "?" })]));
    }

    if (lockVerification?.status === "drift") {
      nodes.push(banner("warn", "lock", ctx.t("banner.drift_title"), lockVerification.issues.slice(0, 3)));
    }

    mount(area, ...nodes);
  };

  ctx.store.subscribe(["scheduler", "sse", "locks"], render);
  ctx.tr.onChange(render);
  ctx.onTick(() => {
    const { sse, avoidance } = ctx.store.state;
    if (sse.state === "reconnecting" || (avoidance?.active && avoidance.layer === 2)) render();
  });
  render();
}
