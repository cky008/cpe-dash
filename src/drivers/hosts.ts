import { normalizeMac } from "../access-state.ts";
import { type TerminalTopologySnapshot, topologySnapshot } from "../cpe-domain.ts";
import type { TerminalAccessMedium, TerminalHostEntry } from "../cpe-domain.ts";
import { sanitizeFreeText } from "../sanitize.ts";
import { stripInvalidControlChars } from "../text-sanitize.ts";
import type { DriverHost } from "./types.ts";
import { ipv4Of, ipv6Of } from "./values.ts";

/**
 * Connected devices of a router of a driver family in the shape the HiLink stack hands the console:
 * each MAC checked and written the one way (a device the router lists twice, wired and on Wi-Fi or in
 * two lists, is one device, the first listing kept), names and addresses bounded. A router that lists
 * a device without saying how it is connected (a DHCP lease) gives it the `UNKNOWN` link, never a
 * guessed one. Names come from the devices themselves: untrusted text, shown as text only.
 */

const MAX_HOSTS = 256;
const MAX_NAME = 64;

const MEDIUM: Readonly<Record<NonNullable<DriverHost["link"]>, TerminalAccessMedium>> = { lan: "LAN_OTHER", wifi: "WIFI_OTHER", wifi_2_4: "WIFI_2_4G", wifi_5: "WIFI_5G" };

function nameOf(raw: string | null): string {
  // The same cleaning as a HiLink host name: no control characters, nothing that looks like a secret
  const name = raw === null ? "" : sanitizeFreeText(stripInvalidControlChars(raw.slice(0, 4 * MAX_NAME))).trim().slice(0, MAX_NAME);
  return name === "*" ? "" : name;
}

function entryOf(host: DriverHost, mac: string): TerminalHostEntry {
  const medium = host.link === null ? "UNKNOWN" : MEDIUM[host.link];
  const ipv6 = host.ipv6.map((address) => ipv6Of(address)).filter((address): address is string => address !== null).slice(0, 8);
  const wifi = medium === "WIFI_2_4G" || medium === "WIFI_5G" || medium === "WIFI_OTHER";
  return {
    macAddress: mac,
    displayName: nameOf(host.name),
    active: true,
    interfaceType: host.link === null ? "" : wifi ? "Wireless" : "Ethernet",
    layer2Interface: "",
    frequency: medium === "WIFI_2_4G" ? "2.4GHz" : medium === "WIFI_5G" ? "5GHz" : "",
    medium,
    negotiatedRateMbps: null,
    rssi: wifi && host.rssiDbm !== null && host.rssiDbm < 0 && host.rssiDbm > -120 ? Math.round(host.rssiDbm) : null,
    ipv4Address: ipv4Of(host.ipv4) ?? "",
    ipv6Addresses: ipv6,
    ipv6Active: ipv6.length > 0,
    addressSource: host.leaseSec !== null ? "DHCP" : "",
    leaseTimeRemainingSec: host.leaseSec !== null && host.leaseSec >= 0 ? Math.round(host.leaseSec) : null,
    associatedTimeSec: host.connectedSec !== null && host.connectedSec >= 0 ? Math.round(host.connectedSec) : null,
    isLocalDevice: false,
  };
}

/** The topology snapshot of the devices a driver listed (every one of them counts as connected). */
export function driverTopologySnapshot(hosts: ReadonlyArray<DriverHost>): TerminalTopologySnapshot {
  const seen = new Set<string>();
  const entries: TerminalHostEntry[] = [];
  for (const host of hosts) {
    const mac = normalizeMac(host.mac);
    if (mac === null || seen.has(mac)) continue;
    seen.add(mac);
    entries.push(entryOf(host, mac));
    if (entries.length >= MAX_HOSTS) break;
  }
  const wired = entries.filter((e) => e.medium.startsWith("LAN_")).length;
  const wireless = entries.filter((e) => e.medium.startsWith("WIFI_")).length;
  return topologySnapshot(entries, { topLevelNodes: entries.length, totalActiveNodes: entries.length, meshChildNodes: 0, ethernetNodes: wired, wirelessNodes: wireless });
}
