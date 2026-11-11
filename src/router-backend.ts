import type { AccessControlSnapshot } from "./access-control.ts";
import type {
  BandLockCommand,
  CellLockCommand,
  GlobalTelemetrySnapshot,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  TerminalTopologySnapshot,
  WanRepairSkipReason,
} from "./cpe-domain.ts";
import type { DeviceProbeResult } from "./device-profile.ts";
import type { RouterFamily } from "./router-family.ts";
import type { ControlSummary, SchedulerPriority } from "./scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "./sms/protocol.ts";
import type { SmsFetchResult, SmsSendResult, SmsWireMessage } from "./sms/types.ts";

/**
 * What FengSui asks of a router, whatever its brand: one verb per thing the daemon reads or writes,
 * each a single scheduled session. The services above it (`CpeMonitor`, `CpeControlService`) speak
 * only this interface; which stack answers is decided here, once, by the connection's family:
 *
 * - `HilinkBackend` (`src/backends/hilink.ts`): Huawei's HiLink stack, the H168-383's verified
 *   request sequences and the generic writes of other HiLink models;
 * - `DriverBackend` (`src/backends/driver.ts`): every other family, through its driver in `src/drivers/`.
 *
 * Both hand back the same snapshot and lock-state shapes, so nothing above this file branches on
 * the brand. A verb a family has no implementation of resolves `null` (a read: nothing to show) or
 * is refused by the write gate (a write: nothing is sent). To give a family a capability another one
 * already has, implement the verb in that family's backend; to add a capability to all of them, add
 * the verb here and implement it where a family can do it.
 */
export interface RouterBackend {
  readonly family: RouterFamily;

  // ------------------------------------------------------------------ reads (`null`: skipped, yielded, or not on this router)

  /** Who the router is and what it can do: once at start, and when the console tests the connection. */
  identify(priority: SchedulerPriority): Promise<DeviceProbeResult | null>;
  /** The 5 s poll: signal, carriers, traffic, temperature (`smsCounters`: also the SMS counts, where the family has SMS). */
  readTelemetry(opts: ReadRequest & { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot | null>;
  readNeighbors(opts: ReadRequest): Promise<NeighborScanSnapshot | null>;
  readTopology(opts: ReadRequest): Promise<TerminalTopologySnapshot | null>;
  readSettings(opts: ReadRequest): Promise<RouterSettingsSnapshot | null>;
  readAccessControl(opts: ReadRequest): Promise<AccessControlSnapshot | null>;
  /**
   * The messages the router stores. The SMS counts ride on `readTelemetry`; this is the session a
   * sync opens when they moved. `null`: skipped, yielded, or no SMS on this router.
   */
  listSms(request: SmsListRequest): Promise<SmsListing | null>;
  /**
   * The unread count without a session, for the badge while a person is signed in to the router's
   * page. `null`: the family has no login-free count (nothing is sent).
   */
  peekSmsUnread(): Promise<SmsUnreadPeek | null>;

  // ------------------------------------------------------------------ writes (checked before queueing, gated, never replayed)

  /** Lock LTE / NR bands. `summary` commits the new lock state before the write is broadcast. */
  lockBands(command: BandLockCommand, ctx: LockContext, summary: LockSummary): Promise<BandLockOutcome>;
  lockCell(command: CellLockCommand, summary: LockSummary): Promise<LockOutcome>;
  /** Take every band and cell lock off. */
  unlockAll(summary: LockSummary): Promise<PersistedLockState>;
  /**
   * The automatic way back from a lock that cut the WAN: skipped when the lock was replaced meanwhile
   * or the WAN re-reads as up; otherwise the bands saved before a band lock on a router nobody
   * verified are written back (`restore`), or every lock is cleared. `summary` gets whether the
   * saved bands went back.
   */
  rollBackLocks(request: RollbackRequest, summary: (outcome: WanRepairOutcome, restored: boolean) => ControlSummary | null): Promise<WanRepairOutcome>;
  reboot(params: { confirm: boolean }, summary: ControlSummary): Promise<{ rebooting: true; requestedAtIso: string }>;
  /**
   * Send one message to the recipients of `prepared` (checked before any session is queued). Sent
   * once: after the router took it (`options.onAccepted`), nothing that goes wrong makes it a failed
   * send, so no caller sends it again.
   */
  sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, summary: (outcome: SmsSendOutcome) => ControlSummary): Promise<SmsSendOutcome>;
  /** Mark the messages at these storage indices read on the router; resolves how many it wrote (`0`: the family keeps no read state to write). */
  markSmsRead(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number>;
  /** Delete the messages at these storage indices from the router. */
  deleteSms(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number>;
}

export interface ReadRequest {
  ignoreCooldown?: boolean | undefined;
}

export interface SmsListRequest {
  /** `full`: every stored message; `incremental`: the newest (a family that lists everything at once answers with all of them). */
  mode: "incremental" | "full";
  /** How many of the newest inbox messages an incremental listing asks for. */
  recentCount: number;
  /** Where the router lists per conversation: whether the conversation of `latest` is fetched as well. */
  expandThread: (latest: SmsWireMessage) => boolean;
  priority: SchedulerPriority;
}

export interface SmsListing extends SmsFetchResult {
  /** Every message the router stores is in `messages`: what is missing from it is gone from the router. */
  complete: boolean;
  /**
   * Who keeps a message's read state. `router`: the router does, and FengSui follows it. `fengsui`:
   * the router's interface cannot mark a message read, or marks every one it lists, so the state
   * FengSui holds is the one that counts.
   */
  readState: "router" | "fengsui";
}

export interface SmsUnreadPeek {
  unreadMessages: number;
  storageFull: boolean;
}

export interface SmsSendOutcome {
  result: SmsSendResult;
  /** Per recipient, the router's own copies read back in the session (empty: none read). */
  readBack: ReadonlyMap<string, SmsWireMessage[]>;
  /**
   * The router keeps a copy of what it sends, so the next sync brings it. `false`: it keeps none, and
   * the copy FengSui holds is the only one.
   */
  routerKeepsSent: boolean;
}

/** What a band lock may need of the daemon's own records (read inside the write's session, never before it queues). */
export interface LockContext {
  /** The lock state FengSui last applied. */
  previousLock(): PersistedLockState;
  /** The latest poll. */
  cachedTelemetry(): GlobalTelemetrySnapshot | null;
}

/** Commits a lock state and words the write for the broadcast and the audit log. */
export type LockSummary = (state: PersistedLockState) => ControlSummary;

export interface LockOutcome {
  state: PersistedLockState;
  /**
   * The lock went out as an experimental write (a router nobody verified): whoever asked for it, it
   * is watched, and undone if the WAN stays down.
   */
  experimental: boolean;
}

export interface BandLockOutcome extends LockOutcome {
  /** The LTE band mask the router had right before the lock (`null`: none read), what that undo writes back. */
  savedLteMask: string | null;
}

export interface RollbackRequest {
  /** `updatedAtIso` of the lock the rollback is for. */
  lockUpdatedAtIso: string;
  /** The LTE mask to write back instead of clearing every lock. */
  restore?: { lteMask: string } | undefined;
  /** The lock state FengSui holds now (a lock queued before the rollback may have replaced the one it is for). */
  currentLock(): PersistedLockState;
}

/**
 * Result of an automatic WAN repair: written, or skipped for the reason read inside the session
 * (`lock_changed`: the lock to roll back was replaced while the rollback waited in the queue).
 */
export type WanRepairOutcome = { applied: true; lockState?: PersistedLockState } | { applied: false; skipped: WanRepairSkipReason | "lock_changed" };

/** The scheduler facts a backend is chosen by. */
interface FamilySource {
  isDriverMode(): boolean;
}

/**
 * The backend of the connection in use. The two are stateless views on the scheduler, so the
 * choice is made at each call: a connection saved with another brand is spoken to by the other one
 * from the next verb on.
 */
export function selectRouterBackend(scheduler: FamilySource, backends: { hilink: RouterBackend; driver: RouterBackend }): RouterBackend {
  return scheduler.isDriverMode() ? backends.driver : backends.hilink;
}
