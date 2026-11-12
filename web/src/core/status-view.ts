import type { GlobalTelemetrySnapshot } from "../../../src/api-contract.ts";
import { type BatteryStatus, type RoamingStatus, type SimCardStatus, type SimState, type SystemStatus, type TemperatureSensor, type WifiStatus, simIsLocked } from "../../../src/router-status.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import { formatDuration } from "./format.ts";
import type { Locale } from "./i18n.ts";

/**
 * How the console words what a router says of itself (`telemetry.status`, src/router-status.ts):
 * the battery, the SIM card, airplane mode, roaming, the router's own load and its sensors. No DOM;
 * a row is shown only where the router reports its part (`null` everywhere else).
 */

type Text = (key: MessageKey, params?: Record<string, string | number>) => string;

/** `ok` / `warn` / `bad`: the colour a value is shown in. */
export type Tone = "ok" | "warn" | "bad" | "plain";

export interface StatusLine {
  text: string;
  tone: Tone;
}

const SIM_STATE_KEYS: Readonly<Record<SimState, MessageKey>> = {
  ready: "status.sim_ready",
  absent: "status.sim_absent",
  pin_required: "status.sim_pin_required",
  puk_required: "status.sim_puk_required",
  error: "status.sim_error",
};

/** The SIM card's state, or `null` where the router names none (the HiLink status code is shown then). */
export function simStateLine(sim: SimCardStatus | null, t: Text): StatusLine | null {
  if (!sim?.state) return null;
  const locked = simIsLocked(sim) === true;
  return { text: t(SIM_STATE_KEYS[sim.state]), tone: sim.state === "ready" ? "ok" : locked || sim.state === "error" ? "bad" : "warn" };
}

/** The slot in use: the card tray, or the built-in card (numbered when there is more than one). */
export function simSlotText(sim: SimCardStatus | null, t: Text): string | null {
  const slot = sim?.slot;
  if (!slot) return null;
  if (slot.kind === "physical") return t("status.slot_physical");
  return slot.index > 1 ? t("status.slot_embedded_n", { index: slot.index }) : t("status.slot_embedded");
}

/**
 * Whether the card asks for its PIN at start, and the tries it has left (`PIN 3 · PUK 10`): shown
 * where the router reports either. Fewer than three PIN tries left is a warning, none a lock.
 */
export function simPinLine(sim: SimCardStatus | null, t: Text): StatusLine | null {
  if (!sim || (sim.pinLockEnabled === null && sim.pinAttemptsLeft === null && sim.pukAttemptsLeft === null)) return null;
  const parts: string[] = [];
  if (sim.pinLockEnabled !== null) parts.push(t(sim.pinLockEnabled ? "status.pin_on" : "status.pin_off"));
  const tries: string[] = [];
  if (sim.pinAttemptsLeft !== null) tries.push(`PIN ${sim.pinAttemptsLeft}`);
  if (sim.pukAttemptsLeft !== null) tries.push(`PUK ${sim.pukAttemptsLeft}`);
  if (tries.length > 0) parts.push(t("status.tries_left", { tries: tries.join(" · ") }));
  const pin = sim.pinAttemptsLeft;
  return { text: parts.join(" · "), tone: pin === 0 ? "bad" : pin !== null && pin < 3 ? "warn" : "plain" };
}

/** Roaming, and the router's own switch for data while roaming. */
export function roamingLine(roaming: RoamingStatus | null, t: Text): StatusLine | null {
  if (!roaming) return null;
  const parts: string[] = [];
  if (roaming.active !== null) parts.push(t(roaming.active ? "status.roaming_on" : "status.roaming_off"));
  if (roaming.dataAllowed !== null) parts.push(t(roaming.dataAllowed ? "status.roaming_data_on" : "status.roaming_data_off"));
  return parts.length > 0 ? { text: parts.join(" · "), tone: roaming.active === true ? "warn" : "plain" } : null;
}

/** Airplane mode: on is a warning (the router has no mobile connection), off plain. */
export function airplaneLine(airplaneMode: boolean | null, t: Text): StatusLine | null {
  if (airplaneMode === null) return null;
  return airplaneMode ? { text: t("status.airplane_on"), tone: "bad" } : { text: t("status.airplane_off"), tone: "plain" };
}

/**
 * The battery in one line (`64% · charging · full in 1 h 32 min · 36 °C`): its charge (low at 20 % or
 * less, critical at 10 %), whether it charges, the router's estimate and its temperature.
 */
export function batteryLine(battery: BatteryStatus | null, t: Text, locale: Locale): StatusLine | null {
  if (!battery || battery.percent === null) return null;
  const parts = [`${battery.percent}%`];
  if (battery.charging !== null) parts.push(t(battery.charging ? "status.charging" : "status.on_battery"));
  if (battery.charging === true && battery.minutesToFull !== null && battery.minutesToFull > 0) parts.push(t("status.full_in", { time: formatDuration(battery.minutesToFull * 60, locale) }));
  if (battery.charging !== true && battery.minutesToEmpty !== null && battery.minutesToEmpty > 0) parts.push(t("status.empty_in", { time: formatDuration(battery.minutesToEmpty * 60, locale) }));
  if (battery.temperatureC !== null) parts.push(`${battery.temperatureC.toFixed(0)} °C`);
  const low = battery.charging !== true && battery.percent <= 20;
  return { text: parts.join(" · "), tone: low ? (battery.percent <= 10 ? "bad" : "warn") : "ok" };
}

/** The router's own CPU and memory use (`CPU 12% · memory 40%`). */
export function loadText(system: SystemStatus | null, t: Text): string | null {
  if (!system || (system.cpuPercent === null && system.memoryPercent === null)) return null;
  const parts: string[] = [];
  if (system.cpuPercent !== null) parts.push(t("status.cpu", { percent: system.cpuPercent }));
  if (system.memoryPercent !== null) parts.push(t("status.memory", { percent: system.memoryPercent }));
  return parts.join(" · ");
}

/** The Wi-Fi switch and the guest network, where the router reports them. */
export function wifiText(wifi: WifiStatus | null, t: Text): string | null {
  if (!wifi || (wifi.enabled === null && wifi.guestEnabled === null)) return null;
  const parts: string[] = [];
  if (wifi.enabled !== null) parts.push(t(wifi.enabled ? "status.wifi_on" : "status.wifi_off"));
  if (wifi.guestEnabled !== null) parts.push(t(wifi.guestEnabled ? "status.guest_on" : "status.guest_off"));
  return parts.join(" · ");
}

const SENSOR_KEYS: Readonly<Record<Exclude<TemperatureSensor["kind"], "other">, MessageKey>> = {
  modem: "status.sensor_modem",
  modem_4g: "status.sensor_modem_4g",
  modem_5g: "status.sensor_modem_5g",
  pa: "status.sensor_pa",
  wifi: "status.sensor_wifi",
  battery: "status.sensor_battery",
  cpu: "status.sensor_cpu",
  board: "status.sensor_board",
};

/** Each sensor the router names apart (`4G modem 46 · PA 44 °C`), or `null` for one value or none. */
export function sensorsText(sensors: ReadonlyArray<TemperatureSensor>, t: Text): string | null {
  if (sensors.length < 2) return null;
  const parts = sensors.slice(0, 8).map((s) => `${s.kind === "other" ? (s.name ?? t("status.sensor_other")) : t(SENSOR_KEYS[s.kind])} ${s.celsius.toFixed(0)}`);
  return `${parts.join(" · ")} °C`;
}

/**
 * The router's own uptime: `null` where it reports none (an uptime of the router's own is not the
 * connection's), else the reading plus the time since the poll.
 */
export function routerUptimeSec(telemetry: Pick<GlobalTelemetrySnapshot, "device" | "capturedAtMs" | "unavailable"> | null, nowMs: number): number | null {
  if (!telemetry || telemetry.unavailable?.includes("uptime")) return null;
  return telemetry.device.uptimeSec + Math.max(0, Math.floor((nowMs - telemetry.capturedAtMs) / 1000));
}
