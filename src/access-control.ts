import net from "node:net";
import { type AccessGuard, type ProtectedDevice, type TimeRule, type WifiMacFilterState, normalizeMac } from "./access-plan.ts";
import type { TerminalHostEntry } from "./cpe-domain.ts";

/**
 * Device access control, the part every brand shares: what a reading of it looks like, and which
 * devices a change must never cut off. How a router is asked and told is its driver's (the
 * H168-383: `src/drivers/huawei/access-control.ts`).
 */

export interface TimeRulesState {
  /** `false` when the firmware does not answer `/api/timerule/timerule`. */
  supported: boolean;
  /** `TimeRuleMaxNum` (16 on the H168-383). */
  maxRules: number;
  rules: TimeRule[];
}

export interface AccessControlSnapshot {
  capturedAtIso: string;
  capturedAtMs: number;
  wifiMacFilter: WifiMacFilterState;
  timeRules: TimeRulesState;
}

export interface AccessRequestContext {
  /** Client address of the HTTP request (exact, not the rate-limit bucket); `null` for MCP / internal callers. */
  requesterIp: string | null;
}

function isWireless(host: TerminalHostEntry): boolean {
  return host.medium === "WIFI_2_4G" || host.medium === "WIFI_5G" || host.medium === "WIFI_OTHER";
}

/**
 * One spelling per address: IPv4-mapped IPv6 as the IPv4 it carries, any other IPv6 in its canonical form (the URL
 * parser writes `2001:0DB8:0:0:0:0:0:20` and `2001:db8::20` alike), so the requester is found however either side
 * wrote it.
 */
function canonicalAddress(ip: string): string {
  const plain = ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (net.isIP(plain) !== 6) return plain;
  try {
    return new URL(`http://[${plain}]/`).hostname;
  } catch {
    return plain;
  }
}

function sameAddress(a: string, b: string): boolean {
  return canonicalAddress(a) === canonicalAddress(b);
}

/**
 * Devices a change must never cut off: the router marks the host that requested HostInfo
 * (`IsLocalDevice`), which for FengSui is the machine running the daemon; the request's client
 * address identifies the sender's device when it is a LAN host (not behind a proxy or Tailscale).
 */
export function accessGuardFromHosts(hosts: ReadonlyArray<TerminalHostEntry>, requesterIp: string | null): AccessGuard {
  const protectedDevices: ProtectedDevice[] = [];
  const add = (host: TerminalHostEntry | undefined, reason: ProtectedDevice["reason"]): void => {
    const macAddress = host ? normalizeMac(host.macAddress) : null;
    if (host && macAddress && !protectedDevices.some((d) => d.macAddress === macAddress)) {
      protectedDevices.push({ macAddress, reason, wireless: isWireless(host) });
    }
  };
  add(hosts.find((h) => h.isLocalDevice), "daemon-host");
  if (requesterIp && net.isIP(requesterIp.replace(/^::ffff:(?=\d)/i, "")) !== 0) {
    add(
      hosts.find((h) => sameAddress(h.ipv4Address, requesterIp) || h.ipv6Addresses.some((ip) => sameAddress(ip, requesterIp))),
      "requester"
    );
  }
  const onlineWifiMacs = hosts
    .filter((h) => h.active && isWireless(h))
    .map((h) => normalizeMac(h.macAddress))
    .filter((mac): mac is string => mac !== null);
  return { protectedDevices, onlineWifiMacs };
}
