import { DASH } from "../core/format.ts";
import { displayValue } from "../core/privacy.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount } from "./dom.ts";
import { revealButton, sensitive } from "./sensitive.ts";
import { cardHead, kv } from "./widgets.ts";

/**
 * Device identity (IMEI / IMSI / own number) and network identity (WAN IPv4 / IPv6, DNS, MAC),
 * masked by default with a per-card reveal button; values the daemon already redacted say so.
 */
export function mountIdentityCards(ctx: AppContext): void {
  const identityRoot = byId("identityCard");
  const networkRoot = byId("networkCard");

  const render = (): void => {
    const device = ctx.store.state.telemetry?.device;
    const idRedacted = device?.sensitiveRedacted ?? false;
    mount(
      identityRoot,
      cardHead(
        ctx.t("id.title"),
        idRedacted ? h("span", { class: "fs-badge", data: { kind: "redacted" }, title: ctx.t("id.server_redacted_hint") }, icon("lock"), ctx.t("id.server_redacted")) : null,
        idRedacted ? null : revealButton(ctx, "identity")
      ),
      h(
        "div",
        { class: "fs-card-body" },
        kv(ctx.t("id.model"), device?.marketingName || device?.deviceName || DASH, "text-right"),
        kv(ctx.t("id.firmware"), device?.softwareVersion || DASH),
        kv(ctx.t("id.imei"), sensitive(ctx, "imei", device?.imei ?? "", "identity", idRedacted)),
        kv(ctx.t("id.imsi"), sensitive(ctx, "imsi", device?.imsi ?? "", "identity", idRedacted)),
        kv(ctx.t("id.msisdn"), device && !device.msisdn ? h("span", { class: "faint" }, ctx.t("id.msisdn_empty")) : sensitive(ctx, "phone", device?.msisdn ?? "", "identity", idRedacted))
      )
    );

    const dnsServers = device ? [...device.wanDnsV4, ...device.wanDnsV6] : [];
    const dnsMasked = ctx.privacy.isMasked("network") && !idRedacted;
    mount(
      networkRoot,
      cardHead(
        ctx.t("net.title"),
        idRedacted ? h("span", { class: "fs-badge", data: { kind: "redacted" }, title: ctx.t("id.server_redacted_hint") }, icon("lock"), ctx.t("id.server_redacted")) : null,
        idRedacted ? null : revealButton(ctx, "network")
      ),
      h(
        "div",
        { class: "fs-card-body" },
        kv(ctx.t("net.wan_ipv4"), sensitive(ctx, "ip", device?.wanIpv4 ?? "", "network", idRedacted)),
        kv(ctx.t("net.wan_ipv6"), sensitive(ctx, "ip", device?.wanIpv6 ?? "", "network", idRedacted)),
        kv(ctx.t("net.dns"), dnsServers.length > 0 ? dnsServers.map((ip) => displayValue("ip", ip, dnsMasked)).join(" · ") : DASH),
        kv(ctx.t("net.mac"), sensitive(ctx, "mac", device?.macAddress ?? "", "network", idRedacted))
      )
    );
  };

  ctx.store.subscribe("telemetry", render);
  ctx.privacy.onChange(render);
  ctx.tr.onChange(render);
  render();
}
