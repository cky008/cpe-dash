/**
 * What a router says about itself besides the signal: its battery, the SIM card it uses, whether its
 * cellular radio is off (airplane mode), roaming, its own load and uptime, a firmware update it knows
 * of, and its Wi-Fi switch. Every brand's backend fills the same shape (`GlobalTelemetrySnapshot.status`,
 * read in the 5 s poll's session); a field the router does not report is `null`, never a made-up value,
 * and a part it reports nothing of is `null` as a whole.
 *
 * Zero dependencies: the daemon, the web console and the live demo share these types and rules.
 */

export interface BatteryStatus {
  /** Charge, 0–100. */
  percent: number | null;
  /** The router says it is charging (a charger is connected). */
  charging: boolean | null;
  temperatureC: number | null;
  /** Minutes until full while charging, as the router estimates it. */
  minutesToFull: number | null;
  /** Minutes until empty on battery, as the router estimates it. */
  minutesToEmpty: number | null;
}

/**
 * `ready`: the card is usable; `absent`: no card (or one the router cannot read); `pin_required` /
 * `puk_required`: the card is locked until its PIN (or, after too many wrong PINs, its PUK) is entered;
 * `error`: the router reports the card as broken or refused.
 */
export type SimState = "ready" | "absent" | "pin_required" | "puk_required" | "error";

export interface SimCardStatus {
  state: SimState | null;
  /** The card asks for its PIN at every start. */
  pinLockEnabled: boolean | null;
  /** Wrong PINs the card still accepts before it wants the PUK. */
  pinAttemptsLeft: number | null;
  /** Wrong PUKs the card still accepts before it is blocked for good. */
  pukAttemptsLeft: number | null;
  /** The slot in use: a card in a tray (`physical`) or one built in (`embedded`, eSIM), numbered as the router counts. */
  slot: { kind: "physical" | "embedded"; index: number } | null;
}

export interface RoamingStatus {
  /** Registered on a network abroad (or another operator's), as the router reports it. */
  active: boolean | null;
  /** The router's own switch: data may be used while roaming. */
  dataAllowed: boolean | null;
}

export interface SystemStatus {
  /** Seconds since the router started. */
  uptimeSec: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export interface WifiStatus {
  enabled: boolean | null;
  /** The second (guest) network. */
  guestEnabled: boolean | null;
}

export interface RouterStatusSnapshot {
  battery: BatteryStatus | null;
  sim: SimCardStatus | null;
  /** `true`: the cellular radio is off (airplane mode); the router stays reachable on the LAN. */
  airplaneMode: boolean | null;
  roaming: RoamingStatus | null;
  system: SystemStatus | null;
  /** `available`: the router knows of a firmware update; `none`: it says there is none. */
  firmwareUpdate: "available" | "none" | null;
  wifi: WifiStatus | null;
}

/** What a temperature is measured on, where the router names it. */
export type TemperatureSensorKind = "modem" | "modem_4g" | "modem_5g" | "pa" | "wifi" | "battery" | "cpu" | "board" | "other";

export interface TemperatureSensor {
  kind: TemperatureSensorKind;
  /** The router's own name for a sensor of kind `other` (a short token, cleaned), else `null`. */
  name: string | null;
  celsius: number;
}

/** A status that says nothing at all (every part `null`). */
export function emptyRouterStatus(): RouterStatusSnapshot {
  return { battery: null, sim: null, airplaneMode: null, roaming: null, system: null, firmwareUpdate: null, wifi: null };
}

/** `null` for a part every field of which is `null`, so "reports nothing" is one value. */
export function partOrNull<T extends object>(part: T): T | null {
  return Object.values(part).some((value) => value !== null) ? part : null;
}

/** Whether the status holds anything (a router that reports none of it gets no `status`). */
export function hasRouterStatus(status: RouterStatusSnapshot): boolean {
  return Object.values(status).some((value) => value !== null);
}

/** A percentage as the router writes it ("85", "85%", 85); `null` outside 0–100. */
export function percentValue(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/\s*%$/, "") : "";
  if (!/^\d{1,3}(?:\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return n >= 0 && n <= 100 ? Math.round(n) : null;
}

/** A small count (attempts left), `null` when absent or implausible. */
export function countValue(value: unknown, max = 99): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** Default `ALERT_BATTERY_LOW_PERCENT`: below this charge, on battery, the battery alert fires. */
export const DEFAULT_BATTERY_LOW_PERCENT = 20;

/** The battery is low: on battery (not charging) at or below `thresholdPercent` (`0`: never). */
export function batteryIsLow(battery: BatteryStatus | null, thresholdPercent: number): boolean | null {
  if (thresholdPercent <= 0 || !battery || battery.percent === null) return null;
  if (battery.charging === true) return false;
  return battery.percent <= thresholdPercent;
}

/** The card is locked until a code is entered (`null`: unknown). */
export function simIsLocked(sim: SimCardStatus | null): boolean | null {
  if (!sim || sim.state === null) return null;
  return sim.state === "pin_required" || sim.state === "puk_required";
}
