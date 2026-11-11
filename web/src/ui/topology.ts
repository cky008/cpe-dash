import type { TerminalAccessMedium, TerminalHostEntry } from "../../../src/api-contract.ts";
import { DASH, formatAgo, formatCountdown } from "../core/format.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, setText } from "./dom.ts";
import { sensitive } from "./sensitive.ts";
import { canWrite, unavailableSection } from "../core/device-access-view.ts";
import { cardHead, emptyState, runBusy, unavailableState } from "./widgets.ts";

/** `short` is the phone label: the row's icon already says wired, Wi-Fi or not known. */
const MEDIUM: Readonly<Record<TerminalAccessMedium, { key: MessageKey; short: string; kind: string; icon: string; wired: boolean }>> = {
  LAN_1000M: { key: "topo.lan_1000m", short: "1000M", kind: "lan", icon: "ethernet", wired: true },
  LAN_100M: { key: "topo.lan_100m", short: "100M", kind: "lan", icon: "ethernet", wired: true },
  LAN_OTHER: { key: "topo.lan_other", short: "LAN", kind: "lan", icon: "ethernet", wired: true },
  WIFI_5G: { key: "topo.wifi_5", short: "5G", kind: "wifi5", icon: "wifi", wired: false },
  WIFI_2_4G: { key: "topo.wifi_24", short: "2.4G", kind: "wifi24", icon: "wifi", wired: false },
  WIFI_OTHER: { key: "topo.wifi_other", short: "WiFi", kind: "wifi5", icon: "wifi", wired: false },
  // A DHCP lease: the router does not say how the device is connected
  UNKNOWN: { key: "topo.link_unknown", short: DASH, kind: "lan", icon: "network", wired: true },
};

/**
 * Client list with LAN 1000M / 2.4G / 5G badges, live lease countdowns and, for Wi-Fi clients, a
 * Block / Restore action (Wi-Fi MAC filter). That column, the access-control panel and every
 * confirmation come from ./access.ts, loaded right after the first paint with the access state.
 */
export function mountTopology(ctx: AppContext): void {
  const root = byId("topologyCard");
  let showOffline = false;
  let accessPanel: Promise<{ open(): void }> | null = null;
  let access: (typeof import("./access.ts"))["topologyAccess"] | null = null;
  const accessModule = () => import("./access.ts");
  let agoLabel: HTMLElement | null = null;
  /** Lease cells to tick each second, with their expiry instant. */
  let leaseCells: Array<{ el: HTMLElement; expiresAtMs: number }> = [];

  const refresh = (button: HTMLButtonElement): void =>
    runBusy(button, async () => {
      try {
        const res = await ctx.api.refreshTopology();
        ctx.store.update({ topology: res.topology, scheduler: res.schedulerStatus }, ["topology", "scheduler"]);
      } catch (err) {
        ctx.toast(ctx.describeError(err), "error");
      }
    });

  const hostRow = (host: TerminalHostEntry, capturedAtMs: number, locked: boolean): HTMLElement => {
    const medium = MEDIUM[host.medium];
    const blocked = access?.isBlocked(ctx, host) ?? false;
    const ipv6 = host.ipv6Addresses.find((a) => !a.toLowerCase().startsWith("fe80")) ?? host.ipv6Addresses[0] ?? "";
    let lease: HTMLElement;
    if (host.leaseTimeRemainingSec === null || host.leaseTimeRemainingSec <= 0) {
      lease = h("span", { class: "text-xs faint" }, host.addressSource.toUpperCase() === "STATIC" ? ctx.t("topo.static") : DASH);
    } else {
      lease = h("span", { class: "num text-xs" }, formatCountdown(host.leaseTimeRemainingSec));
      leaseCells.push({ el: lease, expiresAtMs: capturedAtMs + host.leaseTimeRemainingSec * 1000 });
    }
    return h(
      "tr",
      { class: host.active ? "" : "opacity-50" },
      h(
        "td",
        { class: "max-w-[14rem]" },
        h(
          "div",
          { class: "flex items-center gap-2 min-w-0" },
          icon(medium.icon, "muted shrink-0"),
          h(
            "div",
            { class: "min-w-0" },
            // DHCP / mDNS names are untrusted: text node only (contract §2.3)
            h("div", { class: "font-medium truncate" }, host.displayName || ctx.t("topo.unnamed")),
            h("div", { class: "text-[0.6875rem] faint" }, sensitive(ctx, "mac", host.macAddress, "topology")),
            // Phones hide the address column; the IPv4 stays visible under the name
            h("div", { class: "text-[0.6875rem] faint sm:hidden" }, sensitive(ctx, "ip", host.ipv4Address, "topology"))
          )
        )
      ),
      h(
        "td",
        null,
        h("span", { class: "fs-badge", data: { kind: medium.kind } }, icon(medium.icon), h("span", { class: "hidden sm:inline" }, ctx.t(medium.key)), h("span", { class: "sm:hidden" }, medium.short)),
        blocked && access ? access.badge(ctx) : host.active ? null : h("span", { class: "fs-badge ml-1" }, ctx.t("topo.offline"))
      ),
      h(
        "td",
        { class: "text-xs leading-tight hidden sm:table-cell" },
        h("div", null, sensitive(ctx, "ip", host.ipv4Address, "topology")),
        ipv6 ? h("div", { class: "faint" }, sensitive(ctx, "ip", ipv6, "topology")) : null
      ),
      h(
        "td",
        { class: "num text-xs hidden sm:table-cell" },
        host.negotiatedRateMbps ? `${host.negotiatedRateMbps} Mbps` : DASH,
        host.rssi !== null && !medium.wired ? h("div", { class: "faint" }, `RSSI ${host.rssi}`) : null
      ),
      h("td", { class: "text-right hidden sm:table-cell" }, lease),
      locked ? null : access ? access.cell(ctx, host) : h("td", { class: "text-right faint" }, DASH)
    );
  };

  const render = (): void => {
    const topology = ctx.store.state.topology;
    // A model nobody verified: no blocking (FengSui has no access control for it), maybe no device list, maybe Wi-Fi devices only
    const locked = !canWrite(ctx.store.state.scheduler, "accessControl");
    const missing = unavailableSection(ctx.store.state.scheduler, "topology");
    leaseCells = [];
    const refreshBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("refresh"), ctx.t("topo.refresh"));
    refreshBtn.addEventListener("click", () => refresh(refreshBtn));
    const accessBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("shield"), ctx.t("topo.access"));
    accessBtn.addEventListener("click", () =>
      runBusy(accessBtn, async () => {
        accessPanel ??= accessModule().then((m) => m.mountAccessPanel(ctx));
        (await accessPanel).open();
      })
    );
    const offlineToggle = h("input", { class: "toggle toggle-xs", attrs: { type: "checkbox" } });
    offlineToggle.checked = showOffline;
    offlineToggle.addEventListener("change", () => {
      showOffline = offlineToggle.checked;
      render();
    });
    agoLabel = h("span", { class: "text-[0.6875rem] faint hidden md:inline" });

    let body: HTMLElement;
    if (missing) {
      body = unavailableState(ctx.t, "network", missing.code);
    } else if (!topology) {
      body = emptyState("network", ctx.t("topo.empty"));
    } else {
      const hosts = topology.hosts
        // Blocked devices drop offline; keep them listed so they can be restored
        .filter((host) => showOffline || host.active || (access?.isBlocked(ctx, host) ?? false))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.medium.localeCompare(b.medium) || a.displayName.localeCompare(b.displayName));
      const wired = Object.entries(topology.countsByMedium).reduce((n, [m, c]) => n + (m.startsWith("LAN") ? c : 0), 0);
      const wireless = Object.entries(topology.countsByMedium).reduce((n, [m, c]) => n + (m.startsWith("WIFI") ? c : 0), 0);
      body = h(
        "div",
        { class: "space-y-2" },
        h("div", { class: "text-xs muted" }, ctx.t("topo.summary", { active: wired + wireless, eth: wired, wifi: wireless }), topology.source === "wlan/host-list" ? h("span", { class: "faint" }, ` · ${ctx.t("dev.wifi_only")}`) : null),
        hosts.length === 0
          ? emptyState("network", ctx.t("topo.empty"))
          : h(
              "div",
              { class: "overflow-x-auto max-h-[26rem] overflow-y-auto" },
              h(
                "table",
                { class: "fs-table" },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    ...(locked ? (["topo.device", "topo.link", "topo.address", "topo.rate", "topo.lease"] as const) : (["topo.device", "topo.link", "topo.address", "topo.rate", "topo.lease", "topo.action"] as const)).map((k, i) =>
                      h("th", { class: `${i >= 4 ? "text-right" : ""} ${i >= 2 && i <= 4 ? "hidden sm:table-cell" : ""}`.trim() }, ctx.t(k))
                    )
                  )
                ),
                h("tbody", null, ...hosts.map((host) => hostRow(host, topology.capturedAtMs, locked)))
              )
            )
      );
    }

    mount(
      root,
      cardHead(ctx.t("topo.title"), agoLabel, h("label", { class: "inline-flex items-center gap-1.5 text-xs muted cursor-pointer" }, offlineToggle, ctx.t("topo.show_offline")), locked ? null : accessBtn, refreshBtn),
      h("div", { class: "fs-card-body pt-1" }, body)
    );
    tick();
  };

  const tick = (): void => {
    const now = ctx.now();
    for (const cell of leaseCells) setText(cell.el, formatCountdown((cell.expiresAtMs - now) / 1000));
    const captured = ctx.store.state.topology?.capturedAtMs;
    if (agoLabel && captured) setText(agoLabel, ctx.t("topo.updated", { ago: formatAgo(captured, now, ctx.tr.locale) }));
  };

  ctx.store.subscribe(["topology", "accessControl", "scheduler"], render);
  void Promise.all([accessModule(), ctx.api.accessControl()])
    .then(([mod, res]) => {
      access = mod.topologyAccess;
      ctx.store.update({ accessControl: res.accessControl, accessGuard: res.guard }, ["accessControl"]);
    })
    .catch(() => undefined);
  ctx.privacy.onChange(render);
  ctx.tr.onChange(render);
  ctx.onTick(tick);
  render();
}
