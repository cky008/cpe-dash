import { type CellularSettingsSnapshot, type NetworkMode, type OperatorChoice, type SimSlotRef, isApnName, pinAttemptAllowed, sameSimSlot } from "../../../src/cellular.ts";
import { CELLULAR_WRITE_FEATURES, type CellularWriteFeature, type DriverFamily } from "../../../src/router-family.ts";
import type { RouterStatusSnapshot } from "../../../src/router-status.ts";

/**
 * What the control drawer shows of the cellular settings (no DOM): which settings this router has,
 * what a PIN dialog may offer, and the checks on what was typed. The daemon checks every request
 * again; these only keep a request that cannot work from being sent.
 */

/** The cellular settings open on this router, in the order the drawer shows them. */
export function cellularOpen(open: ReadonlyArray<string>): CellularWriteFeature[] {
  return CELLULAR_WRITE_FEATURES.filter((feature) => open.includes(feature));
}

/** The dictionary key of a network mode's name. */
export const MODE_KEYS = {
  auto: "mode_auto",
  nr_sa: "mode_nr_sa",
  nr_nsa: "mode_nr_nsa",
  nr_lte: "mode_nr_lte",
  lte: "mode_lte",
  lte_wcdma: "mode_lte_wcdma",
  wcdma: "mode_wcdma",
  gsm: "mode_gsm",
} as const satisfies Record<NetworkMode, string>;

/** The modes to choose from: the router's own list, with the one in use first in line where it names it. */
export function modeChoices(cellular: CellularSettingsSnapshot | null): { current: NetworkMode | null; options: NetworkMode[] } {
  const mode = cellular?.networkMode ?? null;
  return { current: mode?.current ?? null, options: mode ? [...mode.options] : [] };
}

/** The slots to switch between, with the one in use marked (the poll's status knows it sooner than the settings read). */
export function slotChoices(cellular: CellularSettingsSnapshot | null, status: RouterStatusSnapshot | null): Array<{ slot: SimSlotRef; current: boolean }> {
  const current = status?.sim?.slot ?? null;
  return (cellular?.simSlots ?? []).map((slot) => ({ slot, current: sameSimSlot(slot, current) }));
}

/**
 * What the drawer may offer for the SIM PIN. `enter`: the card waits for its PIN; `lock`: the card
 * is ready and its PIN lock can be switched. Neither is offered unless the router reports more than
 * one attempt left: FengSui never sends the last one.
 */
export type PinOffer = { kind: "enter" | "lock"; attemptsLeft: number; lockEnabled: boolean | null } | { kind: "none"; reason: "unknown" | "last_attempt" | "none_left" | "puk" | "no_card" };

export function pinOffer(status: RouterStatusSnapshot | null): PinOffer {
  const sim = status?.sim ?? null;
  if (!sim || sim.state === null || sim.state === "absent" || sim.state === "error") return { kind: "none", reason: "no_card" };
  if (sim.state === "puk_required") return { kind: "none", reason: "puk" };
  const attempt = pinAttemptAllowed(sim.pinAttemptsLeft);
  if (!attempt.allowed) return { kind: "none", reason: attempt.reason };
  return { kind: sim.state === "pin_required" ? "enter" : "lock", attemptsLeft: attempt.attemptsLeft, lockEnabled: sim.pinLockEnabled };
}

/** A PIN as a card takes it: 4 to 8 digits. */
export function isPin(text: string): boolean {
  return /^\d{4,8}$/.test(text);
}

const UNIT_BYTES = { MB: 1024 ** 2, GB: 1024 ** 3 } as const;
export type LimitUnit = keyof typeof UNIT_BYTES;

/** A typed data limit in bytes (`null`: not a size the router can keep: 1 MB to 100 TB, whole megabytes). */
export function limitBytes(amount: string, unit: LimitUnit): number | null {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(amount.trim())) return null;
  const bytes = Math.round((Number(amount) * UNIT_BYTES[unit]) / UNIT_BYTES.MB) * UNIT_BYTES.MB;
  return bytes >= UNIT_BYTES.MB && bytes <= 100 * 1024 ** 4 ? bytes : null;
}

/** A size as the form shows it: whole gigabytes as GB, anything else in MB. */
export function limitFields(bytes: number | null): { amount: string; unit: LimitUnit } {
  if (bytes === null || bytes <= 0) return { amount: "", unit: "GB" };
  if (bytes % UNIT_BYTES.GB === 0) return { amount: String(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { amount: String(Math.round(bytes / UNIT_BYTES.MB)), unit: "MB" };
}

/** A warning share as typed: a whole number from 1 to 100, or empty to keep the router's own. */
export function alertPercent(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (!/^\d{1,3}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= 100 ? value : undefined;
}

/** What an access point form may send (`null`: the name is not one). User name and password only with an authentication chosen. */
export function apnForm(fields: { apn: string; auth: "none" | "pap" | "chap"; username: string; password: string }): "ok" | "apn" | "credentials" {
  if (!isApnName(fields.apn.trim())) return "apn";
  if (!/^[A-Za-z0-9@._+:#*!/-]{0,64}$/.test(fields.username) || !/^[A-Za-z0-9@._+:#*!/-]{0,64}$/.test(fields.password)) return "credentials";
  if (fields.auth === "none" && (fields.username !== "" || fields.password !== "")) return "credentials";
  return "ok";
}

/** A USSD code as a network takes one: digits, `*` and `#`. */
export function isUssdCode(text: string): boolean {
  return /^[0-9*#]{1,40}$/.test(text);
}

/** A scan row as one line: the operator's name (its own text) or its code, the technology, and whether the SIM may use it. */
export function operatorLine(row: OperatorChoice): { name: string; detail: string; selectable: boolean } {
  return { name: row.name ?? row.plmn, detail: [row.name ? row.plmn : null, row.rat].filter((part): part is string => part !== null).join(" · "), selectable: row.state !== "forbidden" };
}

/** ZTE's routers keep access points as profiles, and FengSui writes one of its own there; the confirmation says so. */
export function apnUsesProfile(family: DriverFamily | null): boolean {
  return family === "zte-goform" || family === "zte-zwrt";
}

/** A module behind OpenWrt takes an access point's name and address type only: no fields for a user name or password there. */
export function apnTakesCredentials(family: DriverFamily | null): boolean {
  return family !== "openwrt";
}
