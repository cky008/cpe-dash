import type { TimeRulesState } from "../../access-control.ts";
import { type MacFilterEntry, type TimeRule, type TimeRuleWrite, type WifiFilterWrite, type WifiMacFilterState, normalizeMac } from "../../access-plan.ts";
import { huaweiXssDecode } from "./crypto.ts";
import { PreEscapedXmlText, getXmlBlocks, getXmlTag } from "./xml.ts";

/**
 * The messages of HiLink's device access control (docs/dev/protocol.md): the Wi-Fi MAC filter
 * (`GET /api/wlan/multi-macfilter-settings-ex`, `POST .../multi-macfilter-settings`) and the internet
 * time rules (`GET` / `POST /api/timerule/timerule`). Parsing and building only; which of them are
 * read and written, and in which order, is the Huawei driver's (`src/drivers/huawei/access-control.ts`).
 */

export const WIFI_FILTER_READ = "/api/wlan/multi-macfilter-settings-ex";
export const WIFI_FILTER_WRITE = "/api/wlan/multi-macfilter-settings";
export const WIFI_FEATURES = "/api/wlan/wifi-feature-switch";
export const TIME_RULES = "/api/timerule/timerule";
/** The router UI's fallback when `wifimaxmacfilternum` is absent. */
const DEFAULT_MAX_WIFI_FILTER_ENTRIES = 10;
const SLOT_RE = /<(WifiMacFilterMac|wifihostname)(\d{1,3})>([^<]*)<\/\1\2>/g;

/** Entries of one `<wifimacwhitelist>` / `<wifimacblacklist>` container and its highest used slot + 1. */
function parseSlots(container: string): { entries: MacFilterEntry[]; slots: number } {
  const macs = new Map<number, string>();
  const names = new Map<number, string>();
  for (const m of container.matchAll(SLOT_RE)) {
    const slot = Number(m[2]);
    const value = m[3] ?? "";
    if (m[1] === "WifiMacFilterMac") macs.set(slot, value);
    else names.set(slot, value);
  }
  const entries: MacFilterEntry[] = [];
  let slots = 0;
  for (const slot of [...macs.keys()].sort((a, b) => a - b)) {
    const macAddress = normalizeMac(macs.get(slot) ?? "");
    if (!macAddress) continue;
    slots = Math.max(slots, slot + 1);
    if (!entries.some((e) => e.macAddress === macAddress)) {
      entries.push({ macAddress, name: huaweiXssDecode(names.get(slot) ?? "").trim() });
    }
  }
  return { entries, slots };
}

/**
 * Parse the Wi-Fi MAC filter (SSID 0, the list the router UI manages and enforces) and its slot
 * usage, so a shorter write can clear the slots it no longer uses.
 */
export function parseWifiMacFilter(exXml: string, featureXml: string): { state: WifiMacFilterState; slots: { allow: number; deny: number } } {
  const ssid0 = getXmlBlocks(exXml, "Ssid").find((block) => (getXmlTag(block, "Index") ?? "").trim() === "0") ?? "";
  const allow = parseSlots(getXmlBlocks(ssid0, "wifimacwhitelist")[0] ?? "");
  const deny = parseSlots(getXmlBlocks(ssid0, "wifimacblacklist")[0] ?? "");
  const max = Number.parseInt(getXmlTag(featureXml, "wifimaxmacfilternum") ?? "", 10);
  return {
    state: {
      enabled: (getXmlTag(exXml, "enable") ?? "") === "1",
      policy: (getXmlTag(exXml, "wifimacfilterstatus") ?? "") === "1" ? "allow" : "deny",
      allowList: allow.entries,
      denyList: deny.entries,
      maxEntries: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_WIFI_FILTER_ENTRIES,
    },
    slots: { allow: allow.slots, deny: deny.slots },
  };
}

/** Parse `/api/timerule/timerule`; an empty or failed read means the firmware lacks the feature. */
export function parseTimeRules(xml: string): TimeRulesState {
  const max = Number.parseInt(getXmlTag(xml, "TimeRuleMaxNum") ?? "", 10);
  if (!Number.isFinite(max)) return { supported: false, maxRules: 0, rules: [] };
  const rules: TimeRule[] = getXmlBlocks(xml, "TimeControlRule").map((block) => {
    // The H168-383 repeats the first MAC after </DevicesMACs>; only the container's list counts
    const macList = getXmlBlocks(block, "DevicesMACs")[0] ?? "";
    const macs = [...new Set(getXmlBlocks(macList, "DevicesMAC").map((m) => normalizeMac(m) ?? m.trim()))];
    const names = getXmlBlocks(block, "DevicesName").map((n) => huaweiXssDecode(n).trim());
    return {
      id: (getXmlTag(block, "ID") ?? "").trim(),
      enabled: (getXmlTag(block, "Enable") ?? "") === "1",
      devices: macs.map((macAddress, i) => ({ macAddress, name: names[i] ?? "" })),
      weekMask: (getXmlTag(block, "WeekEnable") ?? "").trim(),
      startTime: (getXmlTag(block, "StartTime") ?? "").trim(),
      endTime: (getXmlTag(block, "EndTime") ?? "").trim(),
    };
  });
  return { supported: true, maxRules: max, rules };
}

/** `POST /api/wlan/multi-macfilter-settings` body: SSID 0, the status, the list, and blanks for slots it frees. */
export function buildWifiMacFilterRequest(write: WifiFilterWrite, usedSlots: number): Record<string, unknown> {
  const ssid: Record<string, unknown> = { WifiMacFilterStatus: write.status, Index: 0 };
  for (let slot = 0; slot < Math.max(write.entries.length, usedSlots); slot++) {
    const entry = write.entries[slot];
    ssid[`WifiMacFilterMac${slot}`] = entry?.macAddress ?? "";
    ssid[`wifihostname${slot}`] = entry ? PreEscapedXmlText.fromHuaweiXss(entry.name) : "";
  }
  return { Ssids: { Ssid: ssid } };
}

/** `POST /api/timerule/timerule` body, field for field as the router UI sends it. */
export function buildTimeRuleRequest(write: TimeRuleWrite): Record<string, unknown> {
  return {
    TimeControlRules: {
      TimeControlRule: {
        Action: write.action,
        Enable: write.enabled ? 1 : 0,
        TimeMode: write.weekMask === "1111111" ? 0 : 1,
        ID: write.id,
        DevicesMACs: { DevicesMAC: write.devices.map((d) => d.macAddress) },
        DevicesNames: { DevicesName: write.devices.map((d) => PreEscapedXmlText.fromHuaweiXss(d.name)) },
        WeekEnable: write.weekMask,
        StartTime: write.startTime,
        EndTime: write.endTime,
      },
    },
  };
}
