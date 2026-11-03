import type { DeviceFeature } from "./device-profile.ts";
import { type DeviceVerification, deviceVerification, isVerifiedModel } from "./firmware.ts";

/**
 * What FengSui may do with the router it talks to (multi-model support, phase 2): whether it may
 * write. Zero dependencies: the daemon, the web console and the static demo share it.
 *
 * Writes go by the router's model alone. A verified model (`VERIFIED_FIRMWARE`) writes, also on a
 * firmware nobody checked (ADR-007 only warns); any other model is read-only (phase 3 adds
 * per-feature consent). The gate trusts only a model seen in this run: an identification, a poll
 * (which reads `device/information` anyway) or the write's own session. What an earlier run stored
 * may be stale (the router was swapped while the daemon was down), so it refuses at once when it
 * names an unverified model, and otherwise the write reads the model inside its own session first.
 * Losing sight of the router (unreachable, another connection saved) asks for that again.
 */

/** Every router write the scheduler runs, and the feature it belongs to (phase 3 asks consent per feature). */
export const CONTROL_FEATURES = {
  lock_band: "bandLock",
  lock_cell: "cellLock",
  unlock_rf_locks: "bandLock",
  auto_unlock_rf_locks: "bandLock",
  reboot_cpe: "reboot",
  reconnect_cellular: "reconnect",
  auto_reconnect_cellular: "reconnect",
  set_security_switches: "securitySwitches",
  set_wifi7_mlo: "wifi",
  set_antenna_mode: "antenna",
  set_mobile_data: "mobileData",
  set_wifi_access: "accessControl",
  manage_time_rule: "accessControl",
  sms_send: "smsWrite",
  sms_mark_read: "smsWrite",
  sms_delete: "smsWrite",
} as const satisfies Readonly<Record<string, DeviceFeature>>;

export type ControlAction = keyof typeof CONTROL_FEATURES;

/** `allowed`: a verified model; `read_only`: every other model; `unknown`: no model identified yet. */
export type WriteAccess = "allowed" | "read_only" | "unknown";

/** `scheduler.device` as adapters read it (`SchedulerStatusSnapshot.device`). */
export interface DeviceAccessSnapshot {
  /** The model the gate goes by (seen in this run, else stored by an earlier one); `null` before any identification, `?` for one that is not plain text. */
  model: string | null;
  verification: DeviceVerification;
  /** This run has seen the model; until then a write first reads it in its own session. */
  confirmed: boolean;
  writes: WriteAccess;
}

interface Sighting {
  model: string;
  softwareVersion: string | null;
}

const PLAIN_TEXT = /^[A-Za-z0-9 ._()+-]{1,64}$/;

/** Router text as it may be shown: whitespace collapsed, kept only when all of it is plain (else `?`). */
export function modelLabel(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  return PLAIN_TEXT.test(text) ? text : "?";
}

function sighting(model: string | null | undefined, softwareVersion: string | null | undefined): Sighting | null {
  const name = (model ?? "").replace(/\s+/g, " ").trim().slice(0, 256);
  if (!name) return null;
  const version = (softwareVersion ?? "").trim().slice(0, 256);
  return { model: name, softwareVersion: version || null };
}

export class DeviceAccess {
  /** The identification an earlier run stored, or the last one this run recorded. */
  #stored: Sighting | null = null;
  /** The model this run saw the router report; `null` until then, and again after losing sight of it. */
  #seen: Sighting | null = null;

  /** The model of the stored identification (state.json at start, or one this run just recorded). */
  remember(model: string | null | undefined, softwareVersion: string | null | undefined): void {
    this.#stored = sighting(model, softwareVersion) ?? this.#stored;
  }

  /**
   * The router reported `model` in this run (an identification, a poll, a write's own read). Returns
   * `true` when that contradicts the stored identification: the router was replaced, so it is owed
   * a new identification. Without a model the call changes nothing.
   */
  see(model: string | null | undefined, softwareVersion: string | null | undefined): boolean {
    const next = sighting(model, softwareVersion);
    if (!next) return false;
    this.#seen = next;
    return this.#stored !== null && this.#stored.model !== next.model;
  }

  /** Lost sight of the router (unreachable, another connection): its model is confirmed again before the next write. */
  forget(): void {
    this.#stored = this.#seen ?? this.#stored;
    this.#seen = null;
  }

  /** The model the gate goes by. */
  get current(): Sighting | null {
    return this.#seen ?? this.#stored;
  }

  get confirmed(): boolean {
    return this.#seen !== null;
  }

  get writes(): WriteAccess {
    const current = this.current;
    if (!current) return "unknown";
    return isVerifiedModel(current.model) ? "allowed" : "read_only";
  }

  /** A known model nobody verified: FengSui reads it the tolerant way and writes nothing. */
  get unverifiedModel(): boolean {
    return this.writes === "read_only";
  }

  snapshot(): DeviceAccessSnapshot {
    const current = this.current;
    return {
      model: current ? modelLabel(current.model) : null,
      verification: deviceVerification(current?.model ?? null, current?.softwareVersion ?? null),
      confirmed: this.confirmed,
      writes: this.writes,
    };
  }
}
