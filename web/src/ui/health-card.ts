import type { LockVerification, PersistedLockState } from "../../../src/api-contract.ts";
import { DASH, formatDuration } from "../core/format.ts";
import { bandLabel } from "../core/rf.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, perFrame, setText } from "./dom.ts";
import { cardHead, kv } from "./widgets.ts";

const VERIFY_KEYS: Readonly<Record<LockVerification["status"], MessageKey>> = {
  consistent: "health.verify_consistent",
  drift: "health.verify_drift",
  settling: "health.verify_settling",
  unknown: "health.verify_unknown",
};

/** One-line description of the persisted lock (`B1+B3 · N78`, `NR N78 / 650000 / PCI 211`). */
export function describeLock(ctx: AppContext, lock: PersistedLockState | null): string {
  if (!lock || lock.mode === "unlocked") return ctx.t("health.lock_unlocked");
  if (lock.mode === "cell_lock" && lock.cellLock) {
    const c = lock.cellLock;
    const kind = ctx.t(c.pci === null ? "health.lock_freq" : "health.lock_cell");
    return `${kind} · ${bandLabel(c.rat, c.band)} / ${c.arfcn}${c.pci === null ? "" : ` / PCI ${c.pci}`}`;
  }
  const lte = lock.lteBands === "all" ? "LTE all" : lock.lteBands.map((b) => bandLabel("LTE", b)).join("+");
  const nr = lock.nrBands.length > 0 ? lock.nrBands.map((b) => bandLabel("NR", b)).join("+") : "";
  return `${ctx.t("health.lock_band")} · ${[lte, nr].filter(Boolean).join(" · ")}`;
}

/** Runtime & health: honest N/A for the temperature the firmware does not expose. */
export function mountHealthCard(ctx: AppContext): void {
  const root = byId("healthCard");
  let uptimeEl: HTMLElement | null = null;

  const uptimeNow = (): number | null => {
    const telemetry = ctx.store.state.telemetry;
    if (!telemetry) return null;
    return telemetry.device.uptimeSec + Math.max(0, Math.floor((ctx.now() - telemetry.capturedAtMs) / 1000));
  };

  const render = (): void => {
    const { telemetry, scheduler, topology, lockState, lockVerification } = ctx.store.state;
    const thermal = telemetry?.thermal;
    const temperature =
      thermal?.temperatureSupported && thermal.temperatureCelsius !== null
        ? h("span", { class: `num font-semibold ${thermal.temperatureCelsius >= 70 ? "text-error" : thermal.temperatureCelsius >= 55 ? "text-warning" : "text-success"}` }, `${thermal.temperatureCelsius.toFixed(1)} °C`)
        : h("span", { class: "text-xs faint", title: ctx.t("health.temp_na") }, ctx.t("health.temp_na"));
    const uptime = uptimeNow();
    uptimeEl = h("span", { class: "num" }, uptime === null ? DASH : formatDuration(uptime, ctx.tr.locale));
    // countsByMedium counts active HostInfo clients; summary.* describes the mesh tree only
    const active = topology ? Object.values(topology.countsByMedium).reduce((n, c) => n + c, 0) : undefined;
    const verify = lockVerification ? ctx.t(VERIFY_KEYS[lockVerification.status]) : "";
    const verifyTone = lockVerification?.status === "drift" ? "text-warning" : lockVerification?.status === "consistent" ? "text-success" : "faint";

    mount(
      root,
      cardHead(ctx.t("health.title"), icon("cpu", "muted")),
      h(
        "div",
        { class: "fs-card-body" },
        kv(ctx.t("health.temperature"), temperature, "text-right"),
        kv(ctx.t("health.uptime"), uptimeEl),
        kv(ctx.t("health.clients"), active === undefined ? DASH : ctx.t("health.clients_value", { active })),
        kv(ctx.t("health.conntrack"), h("span", { class: "text-xs faint" }, ctx.t("health.conntrack_na")), "text-right"),
        kv(ctx.t("health.hold"), scheduler?.lastSessionHoldMs != null ? `${scheduler.lastSessionHoldMs} ms` : DASH),
        kv(ctx.t("health.sessions"), scheduler ? String(scheduler.totalSessionsCompleted) : DASH),
        kv(ctx.t("health.yields"), scheduler ? String(scheduler.browserYieldCount) : DASH),
        kv(ctx.t("health.queue"), scheduler ? String(scheduler.queueDepth) : DASH),
        kv(
          ctx.t("health.lock"),
          h("span", { class: "inline-flex flex-col items-end" }, h("span", { class: "text-xs" }, describeLock(ctx, lockState)), verify ? h("span", { class: `text-[0.6875rem] ${verifyTone}` }, verify) : null),
          "text-right"
        )
      )
    );
  };

  ctx.store.subscribe(["telemetry", "scheduler", "topology", "locks"], perFrame(render));
  ctx.tr.onChange(render);
  ctx.onTick(() => {
    const uptime = uptimeNow();
    if (uptimeEl && uptime !== null) setText(uptimeEl, formatDuration(uptime, ctx.tr.locale));
  });
  render();
}
