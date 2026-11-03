import type { DeviceFeature } from "./device-profile.ts";
import { type DeviceVerification, deviceVerification, isVerifiedModel } from "./firmware.ts";

/**
 * What FengSui may do with the router it talks to (multi-model support, phase 2): whether it may
 * write, and which read sections this model provides. Zero dependencies: the daemon, the web
 * console and the static demo share it.
 *
 * Writes go by the router's model alone. A verified model (`VERIFIED_FIRMWARE`) writes, also on a
 * firmware nobody checked (ADR-007 only warns); any other model is read-only (phase 3 adds
 * per-feature consent). The gate trusts only a model seen in this run: an identification, a poll
 * (which reads `device/information` anyway) or the write's own session. What an earlier run stored
 * may be stale (the router was swapped while the daemon was down), so it refuses at once when it
 * names an unverified model, and otherwise the write reads the model inside its own session first.
 * Losing sight of the router (unreachable, another connection saved, or a spell of sending it nothing:
 * a reset breaker, the end of a peer standby) asks for that again.
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

/** The parts of a router FengSui reads, each in a session of its own (the poll, the sweeps, settings, SMS). */
export const READ_SECTIONS = ["telemetry", "neighbors", "topology", "settings", "accessControl", "sms"] as const;
export type ReadSection = (typeof READ_SECTIONS)[number];

/**
 * `verified`: a verified model, read the verified way; `available`: this model answered it;
 * `unavailable`: it answered without it (`100002` / `100003`, or an answer FengSui cannot read), so it
 * is not on this model; `unknown`: not read yet.
 */
export type ReadState = "verified" | "available" | "unavailable" | "unknown";

export interface ReadCapability {
  state: ReadState;
  /** The router's error code when `unavailable` (`null`: an answer FengSui could not read). */
  code: string | null;
}

/** What a model answered per read section, kept with the identification (`state.json`). */
export interface ReadRecord {
  model: string;
  reads: Partial<Record<ReadSection, ReadCapability>>;
}

/** `scheduler.device` as adapters read it (`SchedulerStatusSnapshot.device`). */
export interface DeviceAccessSnapshot {
  /** The model the gate goes by (seen in this run, else stored by an earlier one); `null` before any identification, `?` for one that is not plain text. */
  model: string | null;
  verification: DeviceVerification;
  /** This run has seen the model; until then a write first reads it in its own session. */
  confirmed: boolean;
  writes: WriteAccess;
  /** Per read section: a verified model reads all of them; another model only what it answered. */
  reads: Record<ReadSection, ReadCapability>;
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

const READ_STATES: ReadonlySet<unknown> = new Set<ReadState>(["available", "unavailable"]);
const SECTIONS: ReadonlySet<unknown> = new Set<unknown>(READ_SECTIONS);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored record this version can read (anything else counts as nothing read yet). */
export function isReadRecord(value: unknown): value is ReadRecord {
  if (!isRecord(value) || typeof value["model"] !== "string" || !isRecord(value["reads"])) return false;
  return Object.entries(value["reads"]).every(
    ([section, capability]) =>
      SECTIONS.has(section) &&
      isRecord(capability) &&
      READ_STATES.has(capability["state"]) &&
      (capability["code"] === null || (typeof capability["code"] === "string" && /^\d{4,8}$/.test(capability["code"])))
  );
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
  /** What the current model answered per read section (only kept for a model nobody verified). */
  #reads: ReadRecord | null = null;
  /** Reads that worked before any model was known (the start-up sweep): adopted by the model identified next. */
  #pending: Partial<Record<ReadSection, ReadCapability>> = {};

  /** The model of the stored identification (state.json at start, or one this run just recorded). */
  remember(model: string | null | undefined, softwareVersion: string | null | undefined): void {
    this.#stored = sighting(model, softwareVersion) ?? this.#stored;
    this.#adoptPending();
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
    this.#adoptPending();
    return this.#stored !== null && this.#stored.model !== next.model;
  }

  /** A model is known now: what worked before counts for it (a model nobody verified), or is dropped. */
  #adoptPending(): void {
    const current = this.current;
    if (!current || Object.keys(this.#pending).length === 0) return;
    if (this.unverifiedModel) {
      const known = this.#reads?.model === current.model ? this.#reads.reads : {};
      this.#reads = { model: current.model, reads: { ...this.#pending, ...known } };
    }
    this.#pending = {};
  }

  /** Lost sight of the router (unreachable, another connection, nothing sent for a while): its model is confirmed again before the next write. */
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

  /**
   * What a model nobody verified answered for a read section: `null` when it provided it, its error
   * code (or `null` too, with `available: false`) when not. Returns `true` when that changed what is
   * known; nothing is kept for a verified or an unidentified router.
   */
  noteRead(section: ReadSection, outcome: { available: true } | { available: false; code: string | null }): boolean {
    const current = this.current;
    // Before any model is known only a read that worked is kept, for the model identified next
    if (!current) {
      if (outcome.available) this.#pending[section] = { state: "available", code: null };
      return false;
    }
    if (!this.unverifiedModel) return false;
    if (this.#reads?.model !== current.model) this.#reads = { model: current.model, reads: {} };
    const next: ReadCapability = outcome.available ? { state: "available", code: null } : { state: "unavailable", code: outcome.code };
    const before = this.#reads.reads[section];
    this.#reads.reads[section] = next;
    return before?.state !== next.state || before.code !== next.code;
  }

  readState(section: ReadSection): ReadCapability {
    const current = this.current;
    if (!current) return { state: "unknown", code: null };
    if (!this.unverifiedModel) return { state: "verified", code: null };
    const known = this.#reads?.model === current.model ? this.#reads.reads[section] : undefined;
    return known ? { ...known } : { state: "unknown", code: null };
  }

  /** The background sweeps leave out a section this model does not provide; a read someone asks for still tries. */
  skips(section: ReadSection): boolean {
    return this.readState(section).state === "unavailable";
  }

  /** What to store with the identification (`null`: nothing learnt). */
  get readRecord(): ReadRecord | null {
    return this.#reads ? { model: this.#reads.model, reads: { ...this.#reads.reads } } : null;
  }

  /** The record an earlier run stored; it only counts while the model is the same. */
  restoreReads(record: unknown): void {
    this.#reads = isReadRecord(record) ? { model: record.model, reads: { ...record.reads } } : null;
  }

  snapshot(): DeviceAccessSnapshot {
    const current = this.current;
    return {
      model: current ? modelLabel(current.model) : null,
      verification: deviceVerification(current?.model ?? null, current?.softwareVersion ?? null),
      confirmed: this.confirmed,
      writes: this.writes,
      reads: Object.fromEntries(READ_SECTIONS.map((section) => [section, this.readState(section)])) as Record<ReadSection, ReadCapability>,
    };
  }
}
