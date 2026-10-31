import type { TerminalAccessMedium, TerminalHostEntry } from "../../../src/api-contract.ts";
import { DASH, formatAgo, formatCountdown } from "../core/format.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, setText } from "./dom.ts";
import { sensitive } from "./sensitive.ts";
import { cardHead, emptyState, runBusy } from "./widgets.ts";

const MEDIUM: Readonly<Record<TerminalAccessMedium, { key: MessageKey; kind: string; icon: string; wired: boolean }>> = {
  LAN_1000M: { key: "topo.lan_1000m", kind: "lan", icon: "ethernet", wired: true },
  LAN_100M: { key: "topo.lan_100m", kind: "lan", icon: "ethernet", wired: true },
  LAN_OTHER: { key: "topo.lan_other", kind: "lan", icon: "ethernet", wired: true },
  WIFI_5G: { key: "topo.wifi_5", kind: "wifi5", icon: "wifi", wired: false },
  WIFI_2_4G: { key: "topo.wifi_24", kind: "wifi24", icon: "wifi", wired: false },
  WIFI_OTHER: { key: "topo.wifi_other", kind: "wifi5", icon: "wifi", wired: false },
};

/** Client list with LAN 1000M / 2.4G / 5G badges and live lease countdowns. */
export function mountTopology(ctx: AppContext): void {
  const root = byId("topologyCard");
  let showOffline = false;
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

  const hostRow = (host: TerminalHostEntry, capturedAtMs: number): HTMLElement => {
    const medium = MEDIUM[host.medium];
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
          icon(medium.wired ? "ethernet" : "wifi", "muted shrink-0"),
          h(
            "div",
            { class: "min-w-0" },
            // DHCP / mDNS names are untrusted: text node only (contract §2.3)
            h("div", { class: "font-medium truncate" }, host.displayName || ctx.t("topo.unnamed")),
            h("div", { class: "text-[0.6875rem] faint" }, sensitive(ctx, "mac", host.macAddress, "topology"))
          )
        )
      ),
      h("td", null, h("span", { class: "fs-badge", data: { kind: medium.kind } }, icon(medium.icon), ctx.t(medium.key)), host.active ? null : h("span", { class: "fs-badge ml-1" }, ctx.t("topo.offline"))),
      h(
        "td",
        { class: "text-xs leading-tight" },
        h("div", null, sensitive(ctx, "ip", host.ipv4Address, "topology")),
        ipv6 ? h("div", { class: "faint" }, sensitive(ctx, "ip", ipv6, "topology")) : null
      ),
      h(
        "td",
        { class: "num text-xs" },
        host.negotiatedRateMbps ? `${host.negotiatedRateMbps} Mbps` : DASH,
        host.rssi !== null && !medium.wired ? h("div", { class: "faint" }, `RSSI ${host.rssi}`) : null
      ),
      h("td", { class: "text-right" }, lease)
    );
  };

  const render = (): void => {
    const topology = ctx.store.state.topology;
    leaseCells = [];
    const refreshBtn = h("button", { class: "btn btn-ghost btn-xs rounded-lg gap-1", attrs: { type: "button" } }, icon("refresh"), ctx.t("topo.refresh"));
    refreshBtn.addEventListener("click", () => refresh(refreshBtn));
    const offlineToggle = h("input", { class: "toggle toggle-xs", attrs: { type: "checkbox" } });
    offlineToggle.checked = showOffline;
    offlineToggle.addEventListener("change", () => {
      showOffline = offlineToggle.checked;
      render();
    });
    agoLabel = h("span", { class: "text-[0.6875rem] faint hidden md:inline" });

    let body: HTMLElement;
    if (!topology) {
      body = emptyState("network", ctx.t("topo.empty"));
    } else {
      const hosts = topology.hosts
        .filter((host) => showOffline || host.active)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.medium.localeCompare(b.medium) || a.displayName.localeCompare(b.displayName));
      const wired = Object.entries(topology.countsByMedium).reduce((n, [m, c]) => n + (m.startsWith("LAN") ? c : 0), 0);
      const wireless = Object.entries(topology.countsByMedium).reduce((n, [m, c]) => n + (m.startsWith("WIFI") ? c : 0), 0);
      body = h(
        "div",
        { class: "space-y-2" },
        h("div", { class: "text-xs muted" }, ctx.t("topo.summary", { active: wired + wireless, eth: wired, wifi: wireless })),
        hosts.length === 0
          ? emptyState("network", ctx.t("topo.empty"))
          : h(
              "div",
              { class: "overflow-x-auto max-h-[26rem] overflow-y-auto" },
              h(
                "table",
                { class: "fs-table" },
                h("thead", null, h("tr", null, ...(["topo.device", "topo.link", "topo.address", "topo.rate", "topo.lease"] as const).map((k, i) => h("th", { class: i === 4 ? "text-right" : "" }, ctx.t(k))))),
                h("tbody", null, ...hosts.map((host) => hostRow(host, topology.capturedAtMs)))
              )
            )
      );
    }

    mount(
      root,
      cardHead(ctx.t("topo.title"), agoLabel, h("label", { class: "inline-flex items-center gap-1.5 text-xs muted cursor-pointer" }, offlineToggle, ctx.t("topo.show_offline")), refreshBtn),
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

  ctx.store.subscribe("topology", render);
  ctx.privacy.onChange(render);
  ctx.tr.onChange(render);
  ctx.onTick(tick);
  render();
}
