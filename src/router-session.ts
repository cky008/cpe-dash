import type { AccessControlSnapshot, AccessRequestContext, TimeRulesState } from "./access-control.ts";
import type { TimeRuleChange, WifiAccessChange, WifiFilterPlan, WifiMacFilterState } from "./access-plan.ts";
import type {
  ApnChoice,
  ApnRestore,
  CellularSettingsSnapshot,
  DataLimitSetting,
  LinkChange,
  NetworkMode,
  OperatorChoice,
  OperatorSelection,
  SimPinOutcome,
  SimSlotRef,
  UssdAnswer,
  UssdRequest,
} from "./cellular.ts";
import type {
  AntennaModeName,
  BandLockCommand,
  CellLockCommand,
  GlobalTelemetrySnapshot,
  NeighborScanSnapshot,
  PersistedLockState,
  RouterSettingsSnapshot,
  SecurityUpdateCommand,
  TerminalTopologySnapshot,
} from "./cpe-domain.ts";
import type { DeviceAccess, ReadSection, WriteFeature } from "./device-access.ts";
import type { DeviceProbeResult, ProbeOrigin } from "./device-profile.ts";
import type { DiscoverySession } from "./endpoint-discovery.ts";
import type { BandLockOutcome, LinkChangeOutcome, LockContext, LockOutcome, RollbackRequest, SmsListRequest, SmsListing, SmsSendOutcome, SmsUnreadPeek, WanRepairOutcome } from "./router-backend.ts";
import type { RouterFamily } from "./router-family.ts";
import type { MutexSessionScheduler, WriteContext } from "./scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "./sms/protocol.ts";

/**
 * One logged-in session on the router, whatever its brand: what FengSui reads and writes inside it.
 * The backend (`src/router-backend.ts`) queues, gates, audits and records; a brand's session only
 * says what goes to the router. Each brand has one implementation: Huawei HiLink in
 * `src/drivers/huawei.ts`, every other brand through its driver in `src/drivers/adapter.ts`.
 *
 * A read the router has no answer for throws (`SectionUnavailableError`, or the router's own code),
 * and the backend records it as not on this model. A write is sent once and names what it sent in
 * `write.check`; one this router has no way to do throws before sending anything.
 */
export interface RouterSession {
  readonly family: RouterFamily;
  /** GETs for an agent's read-only endpoint discovery, where the brand's interface has them (`probe_router_endpoints`). */
  readonly discovery?: DiscoverySession;
  /** Who the router says it is (`null`: it did not say): a write confirms the model in its own session. */
  readModel(): Promise<{ model: string; softwareVersion: string | null; variant: string | null } | null>;
  identify(origin: ProbeOrigin): Promise<DeviceProbeResult>;
  readTelemetry(opts: { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot>;
  readNeighbors(): Promise<NeighborScanSnapshot>;
  readTopology(): Promise<TerminalTopologySnapshot>;
  readSettings(): Promise<RouterSettingsSnapshot>;
  readAccessControl(): Promise<AccessControlSnapshot>;
  listSms(request: SmsListRequest): Promise<SmsListing>;
  /** `null`: the router reports none of them. */
  readCellular(): Promise<CellularSettingsSnapshot | null>;

  lockBands(command: BandLockCommand, ctx: LockContext, write: WriteContext): Promise<BandLockOutcome>;
  lockCell(command: CellLockCommand, write: WriteContext): Promise<LockOutcome>;
  unlockAll(write: WriteContext): Promise<PersistedLockState>;
  /** `restored`: the saved bands were written back (rather than every lock cleared). */
  rollBackLocks(request: RollbackRequest, write: WriteContext): Promise<{ outcome: WanRepairOutcome; restored: boolean }>;
  reboot(params: { confirm: boolean }, write: WriteContext): Promise<{ rebooting: true; requestedAtIso: string }>;
  reconnect(write: WriteContext): Promise<{ reconnecting: true; requestedAtIso: string }>;
  autoReconnect(write: WriteContext): Promise<WanRepairOutcome>;
  setMobileData(enabled: boolean, write: WriteContext): Promise<{ mobileDataEnabled: boolean }>;
  setSecuritySwitches(command: SecurityUpdateCommand, write: WriteContext): Promise<void>;
  setWifi7(input: { mloEnable?: boolean; dbhoEnable?: boolean }, write: WriteContext): Promise<{ mloEnable: boolean; dbhoEnable: boolean }>;
  setAntennaMode(mode: AntennaModeName, write: WriteContext): Promise<{ mode: AntennaModeName; rawCode: number }>;
  setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext, write: WriteContext): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }>;
  manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext, write: WriteContext): Promise<TimeRulesState>;
  sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, write: WriteContext): Promise<SmsSendOutcome>;
  markSmsRead(indices: ReadonlyArray<number>, write: WriteContext): Promise<number>;
  deleteSms(indices: ReadonlyArray<number>, write: WriteContext): Promise<number>;

  setNetworkMode(mode: NetworkMode, write: WriteContext): Promise<LinkChangeOutcome<NetworkMode>>;
  scanOperators(write: WriteContext): Promise<OperatorChoice[]>;
  selectOperator(selection: OperatorSelection, write: WriteContext): Promise<LinkChangeOutcome<OperatorSelection>>;
  setSimSlot(slot: SimSlotRef, write: WriteContext): Promise<LinkChangeOutcome<SimSlotRef>>;
  setApn(choice: ApnChoice, write: WriteContext): Promise<LinkChangeOutcome<ApnRestore>>;
  revertLinkChange(change: LinkChange, write: WriteContext): Promise<WanRepairOutcome>;
  enterSimPin(pin: string, write: WriteContext): Promise<SimPinOutcome>;
  setSimPinLock(enabled: boolean, pin: string, write: WriteContext): Promise<SimPinOutcome>;
  setAirplaneMode(enabled: boolean, write: WriteContext): Promise<{ airplaneMode: boolean }>;
  setRoaming(enabled: boolean, write: WriteContext): Promise<{ dataRoaming: boolean }>;
  setDataLimit(limit: DataLimitSetting, write: WriteContext): Promise<DataLimitSetting>;
  resetTraffic(write: WriteContext): Promise<void>;
  sendUssd(request: UssdRequest, write: WriteContext): Promise<UssdAnswer>;
}

/** What a session of any brand is given by the daemon: what it knows of the router, and where it tells what it saw. */
export interface RouterSessionContext {
  readonly device: DeviceAccess;
  /** A read saw the router report its model (a poll on a replaced router still tells it apart). */
  noteRouterModel(model: string | null, softwareVersion: string | null): void;
  /** A part read inside another read (the SMS counts of a poll): recorded the way the backend records a read. */
  readSection<T>(section: ReadSection, read: () => Promise<T>): Promise<T | null>;
}

/** The reads that may need no session at all on a brand (nothing to ask its router). */
export type SessionlessRead = "topology" | "settings" | "accessControl" | "sms" | "cellular" | "endpoints";

/**
 * A router brand, before any session: what its interface has, what is checked before a write is
 * queued, and what it answers without a login. The session itself comes from its connection.
 */
export interface RouterDriver {
  readonly family: RouterFamily;
  /**
   * A model of this brand was verified (the H168-383): its writes follow the gate's verified state.
   * Every write on a brand without one is experimental (recorded with its read-back).
   */
  readonly hasVerifiedModel: boolean;
  /** Some form of the brand's interface has this write; none has it: refused before anything is queued. */
  writes(feature: WriteFeature): boolean;
  /** Whether a read is worth a session on this router (`false`: nothing to ask, no session). */
  reads(section: SessionlessRead, device: DeviceAccess): boolean;
  /** FengSui keeps the SMS read state itself: marking read writes nothing to the router. */
  readonly keepsSmsReadState: boolean;
  // Checks a write passes before it is queued (each throws `CpeControlValidationError`); left out: none
  checkBandLock?(command: BandLockCommand, device: DeviceAccess): void;
  checkCellLock?(command: CellLockCommand, device: DeviceAccess): void;
  checkSms?(prepared: PreparedSmsSubmission, device: DeviceAccess): void;
  checkAntennaMode?(mode: AntennaModeName): void;
  /** The unread count the router gives without a login (left out: it gives none). */
  peekSmsUnread?(scheduler: Pick<MutexSessionScheduler, "probePublic">): Promise<SmsUnreadPeek | null>;
}
