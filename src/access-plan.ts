/**
 * Planning and validation for device access control on the H168-383: the Wi-Fi MAC filter
 * (blacklist / whitelist) and the parental-control "internet time" rules. This module imports
 * nothing, so the web dashboard bundles it and previews a change (who gets cut off, which rules
 * clash) with exactly the rules the daemon enforces before it writes to the router.
 *
 * Router model (firmware 4.4.0.1, `GET /api/wlan/multi-macfilter-settings-ex`): one router-wide
 * switch (`enable`) and policy (`wifimacfilterstatus`: 1 = whitelist, 2 = blacklist), with the two
 * lists stored separately. A write sends one list together with a status code (0 = off, 1 = write
 * the whitelist and enforce it, 2 = the same for the blacklist).
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

export interface ProtectedDevice {
  macAddress: string;
  /** `daemon-host`: the machine running FengSui; `requester`: the device that sent this request. */
  reason: "daemon-host" | "requester";
  /** Only Wi-Fi devices are affected by the Wi-Fi MAC filter (and must stay on a whitelist). */
  wireless: boolean;
}

export interface AccessGuard {
  protectedDevices: ReadonlyArray<ProtectedDevice>;
  /** Wi-Fi devices online right now, to report who a whitelist would disconnect. */
  onlineWifiMacs: ReadonlyArray<string>;
}

export type WifiAccessChange =
  | { kind: "block"; macAddress: string; name: string }
  | { kind: "unblock"; macAddress: string; name?: string }
  | { kind: "mode"; mode: WifiFilterMode; entries?: ReadonlyArray<MacFilterEntry> }
  | { kind: "entries"; add?: ReadonlyArray<MacFilterEntry>; remove?: ReadonlyArray<string> };

export interface WifiFilterWrite {
  /** `WifiMacFilterStatus` of the write: 0 = off (list kept), 1 = whitelist, 2 = blacklist. */
  status: "0" | "1" | "2";
  /** The complete list for that status (the router replaces the stored one). */
  entries: MacFilterEntry[];
}

export interface WifiFilterPlan {
  /** `null` when the router already is in the requested state (nothing to write). */
  write: WifiFilterWrite | null;
  /** State to verify after the write. */
  expected: { enabled: boolean; policy: WifiFilterPolicy };
  /** Other devices this change cuts off (stored blacklist entries, Wi-Fi devices left off a whitelist). */
  alsoBlocked: string[];
}

export type AccessPlanErrorCode =
  | "INVALID_MAC"
  | "PROTECTED_DEVICE"
  | "LIST_FULL"
  | "EMPTY_ALLOW_LIST"
  | "FILTER_OFF"
  | "INVALID_DAYS"
  | "NO_DAYS"
  | "INVALID_TIME"
  | "SAME_TIME"
  | "END_MIDNIGHT"
  | "TIME_CONFLICT"
  | "RULE_NOT_FOUND"
  | "RULES_FULL";

export class AccessPlanError extends Error {
  readonly code: AccessPlanErrorCode;
  constructor(code: AccessPlanErrorCode, message: string) {
    super(message);
    this.name = "AccessPlanError";
    this.code = code;
  }
}

/** Longest label written next to a MAC (the router UI shows device names of this length). */
export const MAX_DEVICE_NAME_LENGTH = 32;

/** Normalize to `AA:BB:CC:DD:EE:FF`; `null` for malformed, all-zero, broadcast or multicast MACs. */
export function normalizeMac(raw: string): string | null {
  const parts = raw.trim().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9A-Fa-f]{2}$/.test(p))) return null;
  const mac = parts.join(":").toUpperCase();
  const firstOctet = Number.parseInt(parts[0] ?? "", 16);
  if (mac === "00:00:00:00:00:00" || (firstOctet & 1) === 1) return null;
  return mac;
}

function requireMac(raw: string): string {
  const mac = normalizeMac(raw);
  if (!mac) throw new AccessPlanError("INVALID_MAC", `"${raw}" is not a unicast MAC address`);
  return mac;
}

/** Router-safe device label: control characters become spaces, whitespace collapses, length is capped. */
export function cleanDeviceName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME_LENGTH);
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

function normalizeEntries(entries: ReadonlyArray<MacFilterEntry>): MacFilterEntry[] {
  const out: MacFilterEntry[] = [];
  for (const entry of entries) {
    const macAddress = requireMac(entry.macAddress);
    if (!out.some((e) => e.macAddress === macAddress)) out.push({ macAddress, name: cleanDeviceName(entry.name) });
  }
  return out;
}

function assertCapacity(list: ReadonlyArray<MacFilterEntry>, state: WifiMacFilterState): void {
  if (list.length > state.maxEntries) {
    throw new AccessPlanError("LIST_FULL", `The Wi-Fi MAC filter list holds at most ${state.maxEntries} devices`);
  }
}

function protectedFor(guard: AccessGuard, mac: string): ProtectedDevice | undefined {
  return guard.protectedDevices.find((d) => normalizeMac(d.macAddress) === mac);
}

function protectedError(device: ProtectedDevice): AccessPlanError {
  return new AccessPlanError(
    "PROTECTED_DEVICE",
    device.reason === "daemon-host"
      ? `${device.macAddress} runs FengSui and cannot be cut off`
      : `${device.macAddress} is the device sending this request and cannot be cut off`
  );
}

/** A blacklist may not name a protected device. */
function assertDenyListSafe(list: ReadonlyArray<MacFilterEntry>, guard: AccessGuard): void {
  for (const entry of list) {
    const device = protectedFor(guard, entry.macAddress);
    if (device) throw protectedError(device);
  }
}

/** An enforced whitelist must be non-empty and keep every protected Wi-Fi device on it. */
function assertAllowListSafe(list: ReadonlyArray<MacFilterEntry>, guard: AccessGuard): void {
  if (list.length === 0) {
    throw new AccessPlanError("EMPTY_ALLOW_LIST", "An empty Wi-Fi whitelist would disconnect every Wi-Fi device");
  }
  for (const device of guard.protectedDevices) {
    const mac = normalizeMac(device.macAddress);
    if (device.wireless && mac && !list.some((e) => e.macAddress === mac)) throw protectedError(device);
  }
}

function blockedBy(state: WifiMacFilterState): Set<string> {
  if (!state.enabled) return new Set();
  if (state.policy === "deny") return new Set(state.denyList.map((e) => e.macAddress));
  return new Set();
}

/**
 * Plan one Wi-Fi access change against the router's current state. Throws `AccessPlanError` for
 * invalid input or anything that would cut off a protected device; returns `write: null` when the
 * router already is in the requested state.
 */
export function planWifiAccessChange(state: WifiMacFilterState, change: WifiAccessChange, guard: AccessGuard): WifiFilterPlan {
  const deny = (entries: MacFilterEntry[], extra: string[]): WifiFilterPlan => {
    assertCapacity(entries, state);
    assertDenyListSafe(entries, guard);
    return { write: { status: "2", entries }, expected: { enabled: true, policy: "deny" }, alsoBlocked: extra };
  };
  const allow = (entries: MacFilterEntry[]): WifiFilterPlan => {
    assertCapacity(entries, state);
    assertAllowListSafe(entries, guard);
    const kept = new Set(entries.map((e) => e.macAddress));
    const wasBlocked = state.enabled && state.policy === "allow" ? null : blockedBy(state);
    const dropped = guard.onlineWifiMacs
      .map((m) => normalizeMac(m))
      .filter((m): m is string => m !== null && !kept.has(m) && (wasBlocked === null ? false : !wasBlocked.has(m)));
    return { write: { status: "1", entries }, expected: { enabled: true, policy: "allow" }, alsoBlocked: dropped };
  };
  const unchanged: WifiFilterPlan = { write: null, expected: { enabled: state.enabled, policy: state.policy }, alsoBlocked: [] };

  switch (change.kind) {
    case "block": {
      const mac = requireMac(change.macAddress);
      const device = protectedFor(guard, mac);
      if (device) throw protectedError(device);
      if (state.enabled && state.policy === "allow") {
        if (!state.allowList.some((e) => e.macAddress === mac)) return unchanged;
        const rest = state.allowList.filter((e) => e.macAddress !== mac);
        if (rest.length === 0) {
          throw new AccessPlanError("EMPTY_ALLOW_LIST", "Removing the last whitelisted device would disconnect every Wi-Fi device");
        }
        return { ...allow(rest), alsoBlocked: [] };
      }
      if (state.enabled && state.denyList.some((e) => e.macAddress === mac)) return unchanged;
      const entries = normalizeEntries([...state.denyList, { macAddress: mac, name: change.name }]);
      const stale = state.enabled ? [] : state.denyList.map((e) => e.macAddress).filter((m) => m !== mac);
      return deny(entries, stale);
    }
    case "unblock": {
      const mac = requireMac(change.macAddress);
      if (!state.enabled) return unchanged;
      if (state.policy === "deny") {
        if (!state.denyList.some((e) => e.macAddress === mac)) return unchanged;
        return deny(state.denyList.filter((e) => e.macAddress !== mac), []);
      }
      if (state.allowList.some((e) => e.macAddress === mac)) return unchanged;
      return { ...allow(normalizeEntries([...state.allowList, { macAddress: mac, name: change.name ?? "" }])), alsoBlocked: [] };
    }
    case "mode": {
      if (change.mode === "off") {
        if (!state.enabled) return unchanged;
        const kept = state.policy === "deny" ? state.denyList : state.allowList;
        return { write: { status: "0", entries: [...kept] }, expected: { enabled: false, policy: state.policy }, alsoBlocked: [] };
      }
      if (change.mode === "deny") {
        const entries = normalizeEntries(change.entries ?? state.denyList);
        const before = blockedBy(state);
        return deny(entries, entries.map((e) => e.macAddress).filter((m) => !before.has(m)));
      }
      return allow(normalizeEntries(change.entries ?? state.allowList));
    }
    case "entries": {
      if (!state.enabled) {
        throw new AccessPlanError("FILTER_OFF", "Choose blacklist or whitelist mode before editing the list");
      }
      const removals = new Set((change.remove ?? []).map(requireMac));
      const current = state.policy === "deny" ? state.denyList : state.allowList;
      const entries = normalizeEntries([...current.filter((e) => !removals.has(e.macAddress)), ...(change.add ?? [])]);
      if (state.policy === "deny") {
        const before = new Set(current.map((e) => e.macAddress));
        return deny(entries, entries.map((e) => e.macAddress).filter((m) => !before.has(m)));
      }
      return { ...allow(entries), alsoBlocked: [] };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Internet time rules (`/api/timerule/timerule`): a device with enabled rules may only go online
// inside their windows ("允许上网时段"); outside every window the router cuts it off.
// ---------------------------------------------------------------------------------------------

export interface TimeRule {
  /** Router-assigned rule ID. */
  id: string;
  enabled: boolean;
  devices: Array<{ macAddress: string; name: string }>;
  /** Monday-first, `1` = active (`"1111111"` = every day). */
  weekMask: string;
  /** `HH:mm`; an end earlier than the start runs past midnight into the next day. */
  startTime: string;
  endTime: string;
}

export interface TimeRuleInput {
  macAddress: string;
  name: string;
  weekMask: string;
  startTime: string;
  endTime: string;
  enabled?: boolean;
}

export type NormalizedTimeRuleInput = Required<TimeRuleInput>;

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** `HH:mm` on the router UI's 15-minute grid, or `null`. */
function parseQuarterTime(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min % 15 !== 0) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/** Validate a rule the way the router UI does (days chosen, 15-minute steps, start != end, end != 00:00). */
export function normalizeTimeRuleInput(input: TimeRuleInput): NormalizedTimeRuleInput {
  const macAddress = requireMac(input.macAddress);
  if (!/^[01]{7}$/.test(input.weekMask)) throw new AccessPlanError("INVALID_DAYS", "weekMask must be 7 digits of 0/1, Monday first");
  if (input.weekMask === "0000000") throw new AccessPlanError("NO_DAYS", "Choose at least one day");
  const startTime = parseQuarterTime(input.startTime);
  const endTime = parseQuarterTime(input.endTime);
  if (!startTime || !endTime) throw new AccessPlanError("INVALID_TIME", "Times must be HH:mm in 15-minute steps");
  if (startTime === endTime) throw new AccessPlanError("SAME_TIME", "Start and end must differ");
  if (endTime === "00:00") throw new AccessPlanError("END_MIDNIGHT", "The router does not accept 00:00 as an end time");
  return { macAddress, name: cleanDeviceName(input.name), weekMask: input.weekMask, startTime, endTime, enabled: input.enabled !== false };
}

/** Week minute intervals `[start, end)` of a rule; windows past midnight spill into the next day. */
function weeklyWindows(rule: { weekMask: string; startTime: string; endTime: string }): Array<[number, number]> {
  const start = toMinutes(rule.startTime);
  const end = toMinutes(rule.endTime);
  const length = end > start ? end - start : MINUTES_PER_DAY - start + end;
  const out: Array<[number, number]> = [];
  for (let day = 0; day < 7; day++) {
    if (rule.weekMask[day] !== "1") continue;
    const from = day * MINUTES_PER_DAY + start;
    const to = from + length;
    if (to <= MINUTES_PER_WEEK) out.push([from, to]);
    else out.push([from, MINUTES_PER_WEEK], [0, to - MINUTES_PER_WEEK]);
  }
  return out;
}

function windowsOverlap(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.some(([s1, e1]) => b.some(([s2, e2]) => s1 < e2 && s2 < e1));
}

/** Rules of the same device whose windows overlap the candidate (`ignoreId`: the rule being edited). */
export function findTimeRuleConflicts(rules: ReadonlyArray<TimeRule>, candidate: TimeRuleInput, ignoreId?: string): TimeRule[] {
  const mac = normalizeMac(candidate.macAddress);
  if (!mac) return [];
  const mine = weeklyWindows(candidate);
  return rules.filter(
    (rule) =>
      rule.id !== ignoreId &&
      rule.devices.some((d) => normalizeMac(d.macAddress) === mac) &&
      windowsOverlap(mine, weeklyWindows(rule))
  );
}

export type TimeRuleChange =
  | { kind: "create"; rule: TimeRuleInput }
  | { kind: "update"; id: string; rule: TimeRuleInput }
  | { kind: "delete"; id: string };

/** One `TimeControlRule` write (`Action` create / update / delete) with the fields the router UI sends. */
export interface TimeRuleWrite extends Omit<TimeRule, "id"> {
  action: "create" | "update" | "delete";
  /** `""` for a new rule (the router assigns the ID). */
  id: string;
}

/**
 * Plan one time-rule change: validated input, no rule for a protected device (it would lose
 * internet access outside the window), room in the router's table and no overlap with another
 * rule of the same device.
 */
export function planTimeRuleChange(
  rules: ReadonlyArray<TimeRule>,
  maxRules: number,
  change: TimeRuleChange,
  guard: AccessGuard
): TimeRuleWrite {
  const existing = change.kind === "create" ? undefined : rules.find((r) => r.id === change.id);
  if (change.kind !== "create" && !existing) {
    throw new AccessPlanError("RULE_NOT_FOUND", `No internet time rule with ID "${change.id}"`);
  }
  if (change.kind === "delete" && existing) {
    return { action: "delete", ...existing };
  }
  if (change.kind === "delete") throw new AccessPlanError("RULE_NOT_FOUND", `No internet time rule with ID "${change.id}"`);

  const input = normalizeTimeRuleInput(change.rule);
  const device = protectedFor(guard, input.macAddress);
  if (device) throw protectedError(device);
  if (change.kind === "create" && rules.length >= maxRules) {
    throw new AccessPlanError("RULES_FULL", `The router holds at most ${maxRules} internet time rules`);
  }
  const clash = findTimeRuleConflicts(rules, input, existing?.id)[0];
  if (clash) {
    throw new AccessPlanError(
      "TIME_CONFLICT",
      `Overlaps rule ${clash.id} (${clash.weekMask} ${clash.startTime}-${clash.endTime}) for the same device`
    );
  }
  return {
    action: change.kind,
    id: existing?.id ?? "",
    enabled: input.enabled,
    devices: [{ macAddress: input.macAddress, name: input.name }],
    weekMask: input.weekMask,
    startTime: input.startTime,
    endTime: input.endTime,
  };
}
