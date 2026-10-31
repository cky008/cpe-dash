import net from "node:net";
import {
  type AccessGuard,
  AccessPlanError,
  type MacFilterEntry,
  type ProtectedDevice,
  type TimeRule,
  type TimeRuleChange,
  type TimeRuleWrite,
  type WifiAccessChange,
  type WifiFilterPlan,
  type WifiFilterWrite,
  type WifiMacFilterState,
  normalizeMac,
  planTimeRuleChange,
  planWifiAccessChange,
} from "./access-plan.ts";
import { CpeApiError, type EphemeralCpeSession } from "./cpe-client.ts";
import { CpeControlValidationError } from "./cpe-domain.ts";
import { huaweiXssDecode } from "./crypto.ts";
import { type TerminalHostEntry, parseHostInfoJson } from "./parsers.ts";
import { PreEscapedXmlText, getXmlBlocks, getXmlTag } from "./xml.ts";

/**
 * Device access control on the H168-383, built on the router's own features (firmware 4.4.0.1,
 * verified against a WebInspector capture and a read-only session; see docs/PHASE1_PROTOCOL_SPEC.md):
 *
 * - Wi-Fi MAC filter: `GET /api/wlan/multi-macfilter-settings-ex` / `POST .../multi-macfilter-settings`.
 *   Writes name SSID `Index` 0 like the router's "Device management" page does.
 * - Internet time rules (parental control): `GET` / `POST /api/timerule/timerule`.
 *
 * Every write is read-modify-write inside one session: read the hosts (to know which device runs
 * FengSui and which device sent the request), read the current state, plan the change with
 * src/access-plan.ts, write, and read back to verify the router applied it.
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

const WIFI_FILTER_READ = "/api/wlan/multi-macfilter-settings-ex";
const WIFI_FILTER_WRITE = "/api/wlan/multi-macfilter-settings";
const WIFI_FEATURES = "/api/wlan/wifi-feature-switch";
const TIME_RULES = "/api/timerule/timerule";
/** The router UI's fallback when `wifimaxmacfilternum` is absent. */
const DEFAULT_MAX_WIFI_FILTER_ENTRIES = 10;
const SLOT_RE = /<(WifiMacFilterMac|wifihostname)(\d{1,3})>([^<]*)<\/\1\2>/g;

async function optionalGet(session: EphemeralCpeSession, apiPath: string): Promise<string> {
  try {
    return await session.get(apiPath);
  } catch (err) {
    if (err instanceof CpeApiError) return "";
    throw err;
  }
}

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
    const macs = getXmlBlocks(block, "DevicesMAC").map((m) => normalizeMac(m) ?? m.trim());
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

function isWireless(host: TerminalHostEntry): boolean {
  return host.medium === "WIFI_2_4G" || host.medium === "WIFI_5G" || host.medium === "WIFI_OTHER";
}

function sameAddress(a: string, b: string): boolean {
  const strip = (ip: string): string => ip.trim().toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  return strip(a) === strip(b);
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

async function readGuard(session: EphemeralCpeSession, ctx: AccessRequestContext): Promise<AccessGuard> {
  return accessGuardFromHosts(parseHostInfoJson(await session.get("/api/system/HostInfo"), { sanitize: false }), ctx.requesterIp);
}

function asValidationError(err: unknown): unknown {
  return err instanceof AccessPlanError ? new CpeControlValidationError(err.message) : err;
}

/** Read the Wi-Fi MAC filter and the internet time rules in one session (3 GETs). */
export async function fetchAccessControl(session: EphemeralCpeSession): Promise<AccessControlSnapshot> {
  const [exXml, featureXml, timeXml] = await Promise.all([
    session.get(WIFI_FILTER_READ),
    optionalGet(session, WIFI_FEATURES),
    optionalGet(session, TIME_RULES),
  ]);
  const nowMs = Date.now();
  return {
    capturedAtIso: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    wifiMacFilter: parseWifiMacFilter(exXml, featureXml).state,
    timeRules: parseTimeRules(timeXml),
  };
}

/**
 * Apply one Wi-Fi access change: plan it against the live state and hosts, write SSID 0, and verify
 * the router now reports the planned switch, policy and list. `plan.write === null` means nothing
 * needed to change and nothing was written.
 */
export async function applyWifiAccessChange(
  session: EphemeralCpeSession,
  change: WifiAccessChange,
  ctx: AccessRequestContext
): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
  const guard = await readGuard(session, ctx);
  const [exXml, featureXml] = await Promise.all([session.get(WIFI_FILTER_READ), optionalGet(session, WIFI_FEATURES)]);
  const current = parseWifiMacFilter(exXml, featureXml);
  let plan: WifiFilterPlan;
  try {
    plan = planWifiAccessChange(current.state, change, guard);
  } catch (err) {
    throw asValidationError(err);
  }
  if (!plan.write) return { wifiMacFilter: current.state, plan };

  const listPolicy = plan.write.status === "1" || (plan.write.status === "0" && current.state.policy === "allow") ? "allow" : "deny";
  await session.postXml(WIFI_FILTER_WRITE, buildWifiMacFilterRequest(plan.write, current.slots[listPolicy]));

  const after = parseWifiMacFilter(await session.get(WIFI_FILTER_READ), featureXml).state;
  const list = listPolicy === "allow" ? after.allowList : after.denyList;
  const applied =
    after.enabled === plan.expected.enabled &&
    (!after.enabled || after.policy === plan.expected.policy) &&
    list.map((e) => e.macAddress).join(",") === plan.write.entries.map((e) => e.macAddress).join(",");
  if (!applied) {
    throw new Error("The router acknowledged the Wi-Fi MAC filter change but did not apply it (read-back differs)");
  }
  return { wifiMacFilter: after, plan };
}

function sameRule(rule: TimeRule, write: TimeRuleWrite): boolean {
  return (
    rule.enabled === write.enabled &&
    rule.weekMask === write.weekMask &&
    rule.startTime === write.startTime &&
    rule.endTime === write.endTime &&
    rule.devices.map((d) => d.macAddress).join(",") === write.devices.map((d) => d.macAddress).join(",")
  );
}

/** Create, update or delete one internet time rule and verify the router's table afterwards. */
export async function applyTimeRuleChange(
  session: EphemeralCpeSession,
  change: TimeRuleChange,
  ctx: AccessRequestContext
): Promise<TimeRulesState> {
  const guard = await readGuard(session, ctx);
  const current = parseTimeRules(await session.get(TIME_RULES));
  if (!current.supported) throw new CpeControlValidationError("This firmware does not offer internet time rules");
  let write: TimeRuleWrite;
  try {
    write = planTimeRuleChange(current.rules, current.maxRules, change, guard);
  } catch (err) {
    throw asValidationError(err);
  }
  await session.postXml(TIME_RULES, buildTimeRuleRequest(write));

  const after = parseTimeRules(await session.get(TIME_RULES));
  const known = new Set(current.rules.map((r) => r.id));
  const applied =
    write.action === "delete"
      ? !after.rules.some((r) => r.id === write.id)
      : write.action === "update"
        ? after.rules.some((r) => r.id === write.id && sameRule(r, write))
        : after.rules.some((r) => !known.has(r.id) && sameRule(r, write));
  if (!applied) {
    throw new Error(`The router acknowledged the internet time rule ${write.action} but did not apply it (read-back differs)`);
  }
  return after;
}
