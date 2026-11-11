import { type DeviceFeature, type DeviceProbeResult, type ExperimentalFeature, experimentalEvidence } from "./device-profile.ts";
import { type DeviceVerification, VERIFIED_FEATURES, type VerifiedFeature, deviceVerification, isVerifiedFeature, isVerifiedModel } from "./firmware.ts";
import { type RouterFamily, familyCapabilities, isDriverFamily, routerVariant } from "./router-family.ts";

/**
 * What FengSui may do with the router it talks to: whether it may write, and which read sections
 * this model provides. Zero dependencies: the daemon, the web console and the static demo share it.
 *
 * Writes go by the router's model. A verified model (`VERIFIED_FIRMWARE`) writes, also on a
 * firmware nobody checked (ADR-007 only warns). On any other model a write FengSui implements for
 * the router is open by default, as an experimental write (sent once, read back), and its owner can
 * turn it off for that model; a write FengSui has no implementation of there is refused. "Implements"
 * means the family's own list (`ROUTER_FAMILY_FACTS`): what a driver family's driver sends, and on a
 * HiLink model the generic writes, each only where the identification probe found what it reads
 * back. A write someone verified on a model of any brand (`VERIFIED_FEATURES`) is `verified` and needs
 * no such evidence.
 *
 * The gate trusts only a model seen in this run: an identification, a poll (which reads
 * `device/information` anyway) or the write's own session. What an earlier run stored may be stale
 * (the router was swapped while the daemon was down), so a write it would refuse for the stored
 * model is refused at once, and otherwise the write reads the model inside its own session first.
 * Losing sight of the router (unreachable, another connection saved, or a spell of sending it
 * nothing: a reset breaker, the end of a peer standby, the quiet window after someone signed in to
 * the router's page from another device) asks for that again.
 */

/** Every router write the scheduler runs, and the feature it belongs to (a write is turned off per feature). */
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

/** The writes that take locks off (filed under the band lock; see `DeviceAccess.actionAccess`). */
const UNLOCK_ACTIONS: ReadonlySet<ControlAction> = new Set<ControlAction>(["unlock_rf_locks", "auto_unlock_rf_locks"]);

/** The features a router write belongs to, in the order the console lists them. */
export const WRITE_FEATURES = [
  "bandLock",
  "cellLock",
  "reboot",
  "reconnect",
  "mobileData",
  "securitySwitches",
  "wifi",
  "antenna",
  "accessControl",
  "smsWrite",
] as const satisfies ReadonlyArray<(typeof CONTROL_FEATURES)[ControlAction]>;

export type WriteFeature = (typeof WRITE_FEATURES)[number];

/**
 * What a write feature is on the router the gate goes by:
 * - `verified`: a verified model, or a write users verified on this model (`VERIFIED_FEATURES`): open;
 * - `enabled`: a write FengSui implements for this router, which nobody verified on a real one: open
 *   by default, sent as an experimental write;
 * - `disabled`: such a write (or one users verified on this model) its owner turned off: refused;
 * - `unsupported`: FengSui implements it for the family, but the probe did not find what it needs: refused;
 * - `not_implemented`: FengSui has no implementation of it for this router: refused;
 * - `unknown`: no model identified yet (a write reads it in its own session first).
 */
export type WriteFeatureState = "verified" | "enabled" | "disabled" | "unsupported" | "not_implemented" | "unknown";

/**
 * What the gate does with a write of this feature: open (`allowed`, or `experimental` on a router
 * nobody verified), refused (`disabled`: its owner turned it off; `unavailable`: nothing implemented
 * for this router), or `unknown` (no model yet).
 */
export type FeatureWriteAccess = "allowed" | "experimental" | "disabled" | "unavailable" | "unknown";

/** The gate refuses a write of this access. */
export function gateRefuses(access: FeatureWriteAccess): access is "disabled" | "unavailable" {
  return access === "disabled" || access === "unavailable";
}

/** One write its owner turned off on one model (kept by the console, `settings.json`). */
export interface DisabledWriteRef {
  model: string;
  feature: string;
}

/**
 * What reading a generic write back showed (multi-model phase 3): `match`, `mismatch`, `unknown`
 * (the read-back could not tell), `pending` (a redial or reboot, checked by the next polls) or
 * `none` (nothing was written to check).
 */
export type ReadbackOutcome = "match" | "mismatch" | "unknown" | "pending" | "none";

/**
 * Why a read-back is not a match, from a fixed set so a result never carries a value: `differs` (the
 * router reports another value than written), `unreadable` (the read-back failed or named nothing),
 * `send_failed` / `send_unconfirmed` (send-status lists the recipient as failed / never settled),
 * `no_change` / `unclear_change` (the SMS counts did not move / moved by another amount), `no_restart`
 * (a redial or reboot the polls show did not happen), `no_evidence` (no poll could tell in time).
 */
export type ReadbackReason = "differs" | "unreadable" | "send_failed" | "send_unconfirmed" | "no_change" | "unclear_change" | "no_restart" | "no_evidence";

/** What a generic write did: the endpoints it posted to and what reading them back showed (no value). */
export interface WriteCheck {
  endpoints: string[];
  readback: ReadbackOutcome;
  reason: ReadbackReason | null;
}

/**
 * One generic write on a model nobody verified, as FengSui keeps it for the device report (the last
 * 20, `state.json`): the endpoints, the router's code and the read-back, never a value it wrote.
 */
export interface WriteResultRecord {
  id: string;
  atIso: string;
  action: ControlAction;
  feature: WriteFeature;
  /** The router's model as it may be shown (`?` when it is not plain text). */
  model: string;
  endpoints: string[];
  /** `applied`: the router took the write; `failed`: it refused it (`code`) or the session broke. */
  outcome: "applied" | "failed";
  code: string | null;
  readback: ReadbackOutcome;
  reason: ReadbackReason | null;
}

const READBACKS: ReadonlySet<unknown> = new Set<ReadbackOutcome>(["match", "mismatch", "unknown", "pending", "none"]);
const REASONS: ReadonlySet<unknown> = new Set<ReadbackReason>(["differs", "unreadable", "send_failed", "send_unconfirmed", "no_change", "unclear_change", "no_restart", "no_evidence"]);
const ENDPOINT_PATH = /^(\/api\/[a-z0-9_/-]{1,64}|[a-z0-9_-]+:[A-Za-z0-9_.-][A-Za-z0-9_.+=/-]{0,63})$/;

/** A stored write result this version can read (anything else is dropped). */
export function isWriteResultRecord(value: unknown): value is WriteResultRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["atIso"] === "string" &&
    typeof r["action"] === "string" &&
    Object.hasOwn(CONTROL_FEATURES, r["action"]) &&
    r["feature"] === CONTROL_FEATURES[r["action"] as ControlAction] &&
    typeof r["model"] === "string" &&
    Array.isArray(r["endpoints"]) &&
    r["endpoints"].every((e: unknown) => typeof e === "string" && ENDPOINT_PATH.test(e)) &&
    (r["outcome"] === "applied" || r["outcome"] === "failed") &&
    (r["code"] === null || (typeof r["code"] === "string" && /^\d{4,8}$/.test(r["code"]))) &&
    READBACKS.has(r["readback"]) &&
    (r["reason"] === null || REASONS.has(r["reason"]))
  );
}

/**
 * `allowed`: a verified model; `experimental`: every other model, whose writes are experimental and
 * go by `features` (open where FengSui implements them, unless turned off); `unknown`: no model
 * identified yet.
 */
export type WriteAccess = "allowed" | "experimental" | "unknown";

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
  /** The brand the connection was saved with (Settings → Router): which stack reads and writes this router. */
  family: RouterFamily;
  /** The model the gate goes by (seen in this run, else stored by an earlier one); `null` before any identification, `?` for one that is not plain text. */
  model: string | null;
  verification: DeviceVerification;
  /** This run has seen the model; until then a write first reads it in its own session. */
  confirmed: boolean;
  writes: WriteAccess;
  /** Per read section: a verified model reads all of them; another model only what it answered. */
  reads: Record<ReadSection, ReadCapability>;
  /** Per write feature, what it is on this router (on a model nobody verified: on by default, off where its owner turned it off). */
  features: Record<WriteFeature, WriteFeatureState>;
  /** LTE bands an experimental band lock may use (what `net/net-mode-list` advertised); `null` on a verified model or none. */
  lteBands: number[] | null;
}

/** What the identification probe of a model nobody verified showed of the generic writes. */
interface ProbeCapability {
  model: string;
  evidence: Record<ExperimentalFeature, boolean>;
  lteBands: number[] | null;
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
  readonly #verifiedFeatures: ReadonlyArray<VerifiedFeature>;
  /** The latest identification probe's evidence (only counts while its model is the current one). */
  #capability: ProbeCapability | null = null;
  /** The writes the owner turned off, as the console keeps them (only the current model's count). */
  #disabled: ReadonlyArray<DisabledWriteRef> = [];
  /** The family of the router connection (Settings → Router): what it reads and may write goes by it. */
  #family: RouterFamily = "huawei";
  /** The form of its brand's interface the router's driver reported, for the model it reported it with (`name: null`: the brand's own). */
  #variant: { model: string; name: string | null } | null = null;

  constructor(options: { verifiedFeatures?: ReadonlyArray<VerifiedFeature>; family?: RouterFamily } = {}) {
    this.#verifiedFeatures = options.verifiedFeatures ?? VERIFIED_FEATURES;
    this.#family = options.family ?? "huawei";
  }

  get family(): RouterFamily {
    return this.#family;
  }

  /** The connection was switched to a router of another family (the scheduler keeps this in step). */
  setFamily(family: RouterFamily): void {
    this.#family = family;
  }

  /** The router is of a driver family: its driver, not the HiLink stack, reads and writes it. */
  get driverFamily(): boolean {
    return isDriverFamily(this.#family);
  }

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
    return isVerifiedModel(current.model) ? "allowed" : "experimental";
  }

  /** A known model nobody verified: FengSui reads it the tolerant way, and what it writes there is experimental. */
  get unverifiedModel(): boolean {
    return this.writes === "experimental";
  }

  /**
   * Reports settled every feature FengSui implements for this model on its brand (`isReportVerifiedModel`):
   * the console and the alerts call it verified; it is still written the way its brand is (`generic`).
   */
  get reportVerified(): boolean {
    const current = this.current;
    return current !== null && deviceVerification(current.model, current.softwareVersion, this.#family, this.#verifiedFeatures, this.variant) === "report-verified";
  }

  /** A known model nobody verified: whatever it may write goes through the generic (HiLink) implementation. */
  get generic(): boolean {
    return this.unverifiedModel;
  }

  /** What the identification probe found (start, catch-up, a console test of this router); a probe naming no model changes nothing. */
  noteProbe(probe: DeviceProbeResult | null | undefined): void {
    if (!probe) return;
    this.noteEvidence(probe.identity.model, experimentalEvidence(probe), probe.lteBands);
    this.noteVariant(probe.identity.model, probe.identity.variant ?? null);
  }

  /**
   * The form of its brand's interface the router's driver found it speaking (`null`: the brand's own),
   * for the model it reported with it: what it reads and may write goes by it. No model, no change.
   */
  noteVariant(model: string | null | undefined, variant: string | null): void {
    const name = sighting(model, null)?.model;
    if (name) this.#variant = { model: name, name: variant };
  }

  /**
   * The form of its brand's interface the router speaks (`null`: the brand's own): the one its driver
   * reported for the current model, else the one the model is on record with.
   */
  get variant(): string | null {
    const current = this.current;
    if (!current) return null;
    return routerVariant(this.#family, this.#variant?.model === current.model ? this.#variant.name : undefined, current.model);
  }

  /**
   * What a probe of `model` showed of the generic writes, and the LTE bands it advertised (the online
   * demo hands over the identification its seed carries this way); no model, no change.
   */
  noteEvidence(model: string | null | undefined, evidence: Readonly<Record<ExperimentalFeature, boolean>>, lteBands: ReadonlyArray<number> | null): void {
    const name = sighting(model, null)?.model;
    if (!name) return;
    this.#capability = { model: name, evidence: { ...evidence }, lteBands: lteBands ? [...lteBands] : null };
  }

  /**
   * The writes the owner turned off (the console's store hands them over at start and after every
   * change). Each names its model: one made for another model says nothing about this router.
   */
  setDisabledWrites(disabled: ReadonlyArray<DisabledWriteRef>): void {
    this.#disabled = disabled.map(({ model, feature }) => ({ model, feature }));
  }

  writeState(feature: WriteFeature): WriteFeatureState {
    const current = this.current;
    if (!current) return "unknown";
    if (isVerifiedModel(current.model)) return "verified";
    // A model nobody verified writes only what FengSui implements for its family (in the form of the
    // interface it speaks): a driver's writes, or on a HiLink model the generic ones (a write without
    // one stays the verified model's alone)
    if (!(familyCapabilities(this.#family, this.variant).writes as ReadonlyArray<string>).includes(feature)) return "not_implemented";
    // A HiLink model shows in the identification probe what a generic write reads back; one users verified
    // (on a router of any brand: VERIFIED_FEATURES) needs no such sign
    const usersVerified = isVerifiedFeature(this.#family, current.model, feature, "write", this.#verifiedFeatures);
    if (!isDriverFamily(this.#family) && !usersVerified) {
      const capability = this.#capability?.model === current.model ? this.#capability : null;
      if (capability?.evidence[feature as ExperimentalFeature] !== true) return "unsupported";
    }
    // Open by default; its owner's "off" for this model wins, over a write users verified too
    if (this.#disabled.some((d) => d.model === current.model && d.feature === feature)) return "disabled";
    return usersVerified ? "verified" : "enabled";
  }

  /**
   * Whether the gate lets a write through. A write goes by its feature, with one exception: taking a
   * lock off is open to whoever may put one on. Where the band lock is off or not on this router but
   * the cell lock is open, an unlock is not refused for the band lock's sake: a lock nobody may undo
   * is worse than either write. With both closed it is refused, as turned off when either lock was.
   */
  actionAccess(action: ControlAction): FeatureWriteAccess {
    const access = this.writeAccess(CONTROL_FEATURES[action]);
    if (!gateRefuses(access) || !UNLOCK_ACTIONS.has(action)) return access;
    // A model is known here (the band lock was refused for it), so the cell lock's answer is one too
    const cell = this.writeAccess("cellLock");
    if (!gateRefuses(cell)) return cell;
    return access === "disabled" || cell === "disabled" ? "disabled" : "unavailable";
  }

  writeAccess(feature: WriteFeature): FeatureWriteAccess {
    const state = this.writeState(feature);
    if (state === "unknown") return "unknown";
    if (state === "verified") return "allowed";
    if (state === "enabled") return "experimental";
    return state === "disabled" ? "disabled" : "unavailable";
  }

  /** LTE bands a generic band lock may use on the current model (`null`: a verified model, or none advertised). */
  get experimentalLteBands(): number[] | null {
    const current = this.current;
    if (!current || !this.unverifiedModel || this.#capability?.model !== current.model) return null;
    return this.#capability.lteBands ? [...this.#capability.lteBands] : null;
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
    // A driver family reads the sections it documents (in the form of the interface the router speaks); the others are not on it
    if (isDriverFamily(this.#family) && !(familyCapabilities(this.#family, this.variant).reads as ReadonlyArray<string>).includes(section)) {
      return { state: "unavailable", code: null };
    }
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
      family: this.#family,
      model: current ? modelLabel(current.model) : null,
      verification: deviceVerification(current?.model ?? null, current?.softwareVersion ?? null, this.#family, this.#verifiedFeatures, this.variant),
      confirmed: this.confirmed,
      writes: this.writes,
      reads: Object.fromEntries(READ_SECTIONS.map((section) => [section, this.readState(section)])) as Record<ReadSection, ReadCapability>,
      features: Object.fromEntries(WRITE_FEATURES.map((feature) => [feature, this.writeState(feature)])) as Record<WriteFeature, WriteFeatureState>,
      lteBands: this.experimentalLteBands,
    };
  }
}
