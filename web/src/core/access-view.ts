import { type AccessGuard, type ProtectedDevice, normalizeMac } from "../../../src/access-plan.ts";
import type { AccessGuardInfo, TerminalHostEntry, TimeRule } from "../../../src/api-contract.ts";
import type { Locale } from "./i18n.ts";

/** Formatting and grouping for the access-control panel (no DOM; covered by the web core tests). */

/** `00:00` … `23:45`: the router UI only offers quarter hours. */
export const QUARTER_TIMES: ReadonlyArray<string> = Array.from({ length: 96 }, (_, i) => {
  const minutes = i * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});

const DAY_NAMES: Readonly<Record<Locale, ReadonlyArray<string>>> = {
  "zh-CN": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};

export function dayNames(locale: Locale): ReadonlyArray<string> {
  return DAY_NAMES[locale];
}

/** `1111111` → every day, `1111100` → weekdays, `0000011` → weekends, else the listed days. */
export function formatWeekMask(mask: string, locale: Locale): string {
  const zh = locale === "zh-CN";
  if (mask === "1111111") return zh ? "每天" : "Every day";
  if (mask === "1111100") return zh ? "周一至周五" : "Mon–Fri";
  if (mask === "0000011") return zh ? "周末" : "Weekends";
  const names = DAY_NAMES[locale].filter((_, i) => mask[i] === "1");
  return names.join(zh ? "、" : ", ");
}

/** An end at or before the start means the window runs past midnight. */
export function isOvernight(start: string, end: string): boolean {
  return end <= start;
}

/** Rules per device MAC, earliest window first. */
export function rulesByDevice(rules: ReadonlyArray<TimeRule>): Map<string, TimeRule[]> {
  const groups = new Map<string, TimeRule[]>();
  for (const rule of rules) {
    const mac = normalizeMac(rule.devices[0]?.macAddress ?? "") ?? rule.devices[0]?.macAddress ?? "";
    groups.set(mac, [...(groups.get(mac) ?? []), rule]);
  }
  for (const list of groups.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return groups;
}

function isWifiHost(host: TerminalHostEntry): boolean {
  return host.medium.startsWith("WIFI");
}

/** The guard the planner previews with: the daemon's view of protected devices, Wi-Fi flags from the topology. */
export function previewGuard(info: AccessGuardInfo | null, hosts: ReadonlyArray<TerminalHostEntry>): AccessGuard {
  const protectedDevices: ProtectedDevice[] = [];
  const add = (mac: string | null, reason: ProtectedDevice["reason"]): void => {
    const macAddress = mac ? normalizeMac(mac) : null;
    if (!macAddress || protectedDevices.some((d) => d.macAddress === macAddress)) return;
    const host = hosts.find((h) => normalizeMac(h.macAddress) === macAddress);
    protectedDevices.push({ macAddress, reason, wireless: host ? isWifiHost(host) : false });
  };
  add(info?.daemonHostMac ?? null, "daemon-host");
  add(info?.requesterMac ?? null, "requester");
  const onlineWifiMacs = hosts
    .filter((h) => h.active && isWifiHost(h))
    .map((h) => normalizeMac(h.macAddress))
    .filter((mac): mac is string => mac !== null);
  return { protectedDevices, onlineWifiMacs };
}
