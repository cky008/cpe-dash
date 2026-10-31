/**
 * Wi-Fi MAC filter state and the two checks every view needs (is this device blocked, what MAC is
 * this). Imports nothing: the dashboard's first paint bundles only this, while the planner
 * (src/access-plan.ts) loads with the access-control panel.
 *
 * Router model (firmware 4.4.0.1, `GET /api/wlan/multi-macfilter-settings-ex`): one router-wide
 * switch (`enable`) and policy (`wifimacfilterstatus`: 1 = whitelist, 2 = blacklist), with the two
 * lists stored separately.
 */

export type WifiFilterPolicy = "allow" | "deny";
export type WifiFilterMode = "off" | WifiFilterPolicy;

export interface MacFilterEntry {
  /** Upper-case, colon-separated unicast MAC. */
  macAddress: string;
  /** Label stored next to the MAC on the router (its hostname). */
  name: string;
}

export interface WifiMacFilterState {
  /** Router-wide switch; while `false` the stored lists block nobody. */
  enabled: boolean;
  /** List the router enforces while enabled. */
  policy: WifiFilterPolicy;
  allowList: MacFilterEntry[];
  denyList: MacFilterEntry[];
  /** `wifimaxmacfilternum` (64 on the H168-383) per list. */
  maxEntries: number;
}

/** Normalize to `AA:BB:CC:DD:EE:FF`; `null` for malformed, all-zero, broadcast or multicast MACs. */
export function normalizeMac(raw: string): string | null {
  const parts = raw.trim().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9A-Fa-f]{2}$/.test(p))) return null;
  const mac = parts.join(":").toUpperCase();
  const firstOctet = Number.parseInt(parts[0] ?? "", 16);
  if (mac === "00:00:00:00:00:00" || (firstOctet & 1) === 1) return null;
  return mac;
}

export function wifiFilterMode(state: WifiMacFilterState): WifiFilterMode {
  return state.enabled ? state.policy : "off";
}

/** Whether the Wi-Fi MAC filter keeps this device off Wi-Fi right now. */
export function isDeviceBlocked(state: WifiMacFilterState, macAddress: string): boolean {
  const mac = normalizeMac(macAddress);
  if (!state.enabled || !mac) return false;
  const listed = (list: ReadonlyArray<MacFilterEntry>): boolean => list.some((e) => e.macAddress === mac);
  return state.policy === "deny" ? listed(state.denyList) : !listed(state.allowList);
}
