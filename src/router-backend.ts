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
import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type GlobalTelemetrySnapshot,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type SecurityUpdateCommand,
  type TerminalTopologySnapshot,
  type WanRepairSkipReason,
} from "./cpe-domain.ts";
import { type ControlAction, CONTROL_FEATURES } from "./device-access.ts";
import type { DeviceProbeResult } from "./device-profile.ts";
import { type DiscoveredEndpoint, discoverEndpoints } from "./endpoint-discovery.ts";
import type { RouterFamily } from "./router-family.ts";
import type { RouterDriver, RouterSession, SessionlessRead } from "./router-session.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority, WriteContext } from "./scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "./sms/protocol.ts";
import type { SmsAbilities, SmsFetchResult, SmsSendResult, SmsWireMessage } from "./sms/types.ts";

/**
 * What FengSui asks of a router, whatever its brand: one verb per thing the daemon reads or writes,
 * each a single scheduled session. The services above it (`CpeMonitor`, `CpeControlService`,
 * `SmsService`) speak only this interface, and it has one implementation, `SessionBackend` below,
 * which knows no brand: it queues, gates, audits and records, and leaves what goes to the router to
 * the brand's `RouterSession` (`src/router-session.ts`) and what is checked before queueing to the
 * brand's `RouterDriver`.
 *
 * A verb a router has no implementation of resolves `null` (a read: nothing to show) or is refused by
 * the write gate (a write: nothing is sent). To give a brand a capability another one already has,
 * implement it in that brand's session; to add a capability, add the verb here and to
 * `RouterSession`, and implement it where a brand's interface can do it.
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
  /**
   * The cellular settings the console shows beside the poll's status: the network mode and the ones
   * on offer, the SIM slots, how the operator is chosen, the access point, the data limit. `null`:
   * skipped, yielded, or the router's interface has no read for any of them.
   */
  readCellular(opts: ReadRequest): Promise<CellularSettingsSnapshot | null>;
  /**
   * An agent's read-only look at endpoints FengSui does not read yet (`probe_router_endpoints`), one
   * GET each in one session. `null`: no session (someone on the router's page, the breaker, or a
   * router whose interface this discovery does not speak).
   */
  probeEndpoints(paths: ReadonlyArray<string>): Promise<DiscoveredEndpoint[] | null>;

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
  /** Redial the cellular connection (someone asked for it). */
  reconnect(summary: ControlSummary): Promise<{ reconnecting: true; requestedAtIso: string }>;
  /**
   * Self-healing's redial (`WAN_AUTO_RECONNECT_AFTER_MIN`): skipped when, inside the session, the WAN
   * re-reads as up or mobile data as switched off. Never a reboot.
   */
  autoReconnect(summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome>;
  setMobileData(enabled: boolean, summary: ControlSummary): Promise<{ mobileDataEnabled: boolean }>;
  /** UPnP, DMZ and the firewall switches (checked before queueing). */
  setSecuritySwitches(command: SecurityUpdateCommand, summary: ControlSummary): Promise<void>;
  setWifi7(input: { mloEnable?: boolean; dbhoEnable?: boolean }, summary: ControlSummary): Promise<{ mloEnable: boolean; dbhoEnable: boolean }>;
  setAntennaMode(mode: AntennaModeName, summary: ControlSummary): Promise<{ mode: AntennaModeName; rawCode: number }>;
  /**
   * Block or unblock a Wi-Fi device, or change the Wi-Fi MAC filter's mode and list: planned against
   * the router's state inside the session (the daemon's host and the requesting device are never cut
   * off) and read back.
   */
  setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }>;
  /** Create, update or delete an internet time rule for one device. */
  manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<TimeRulesState>;
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

  // ------------------------------------------------------------------ cellular settings (`src/cellular.ts`; each sent once, read back)

  /**
   * Switch the network mode. Like the three below it can take the router off the network by accident:
   * `previous` is the value read right before the write in its session (`null`: none read), what
   * `revertLinkChange` puts back if the WAN stays down.
   */
  setNetworkMode(mode: NetworkMode, summary: ControlSummary): Promise<LinkChangeOutcome<NetworkMode>>;
  /** Search for the networks in range (up to a minute; the connection may drop meanwhile). Their names are the operators' own text. */
  scanOperators(summary: (found: OperatorChoice[]) => ControlSummary): Promise<OperatorChoice[]>;
  /** Register with one operator's network, or hand the choice back to the router. */
  selectOperator(selection: OperatorSelection, summary: ControlSummary): Promise<LinkChangeOutcome<OperatorSelection>>;
  setSimSlot(slot: SimSlotRef, summary: ControlSummary): Promise<LinkChangeOutcome<SimSlotRef>>;
  setApn(choice: ApnChoice, summary: ControlSummary): Promise<LinkChangeOutcome<ApnRestore>>;
  /**
   * The way back from one of the four changes above when the WAN stayed down: skipped when the WAN
   * re-reads as up, or mobile data or the radio as switched off on purpose, inside the session.
   */
  revertLinkChange(change: LinkChange, summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome>;
  /**
   * Enter the SIM card's PIN, once: refused before anything is sent unless the router reports, in this
   * session, more than one attempt left. A PIN the card refuses resolves `accepted: false`.
   */
  enterSimPin(pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome>;
  /** Turn the card's "ask for the PIN at every start" on or off, under the same rule. */
  setSimPinLock(enabled: boolean, pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome>;
  /** `true` switches the cellular radio off. A deliberate disconnect, like mobile data off: never undone on its own. */
  setAirplaneMode(enabled: boolean, summary: ControlSummary): Promise<{ airplaneMode: boolean }>;
  /** Whether data may be used while roaming. */
  setRoaming(enabled: boolean, summary: ControlSummary): Promise<{ dataRoaming: boolean }>;
  /** The monthly data limit the router itself keeps. */
  setDataLimit(limit: DataLimitSetting, summary: ControlSummary): Promise<DataLimitSetting>;
  /** Clear the router's own traffic counters. */
  resetTraffic(summary: ControlSummary): Promise<void>;
  /** Send a USSD code, answer the network's question, or end the session. The answer is the operator's text. */
  sendUssd(request: UssdRequest, summary: ControlSummary): Promise<UssdAnswer>;
}

/** A change that may cut the WAN, with the value the setting had right before it. */
export interface LinkChangeOutcome<T> {
  /** Read in the write's own session before it wrote (`null`: the router did not say, so nothing can be put back). */
  previous: T | null;
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
  /** What this router's interface can do besides reading, learnt in the same session. */
  abilities: SmsAbilities;
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
 * (`lock_changed`: the lock to roll back was replaced while the rollback waited in the queue;
 * `airplane_mode`: the radio was switched off on purpose).
 */
export type WanRepairOutcome = { applied: true; lockState?: PersistedLockState } | { applied: false; skipped: WanRepairSkipReason | "lock_changed" | "airplane_mode" };

/** The write that puts each kind of link change back, filed under the setting's own feature. */
const LINK_REVERTS: Readonly<Record<LinkChange["kind"], ControlAction>> = {
  sim_slot: "auto_restore_sim_slot",
  network_mode: "auto_restore_network_mode",
  operator: "auto_restore_operator",
  apn: "auto_restore_apn",
};

/**
 * The one `RouterBackend`: each verb is one session through the scheduler's queue, avoidance, breaker
 * and write gate, on the connection in use (`scheduler.driver`, `scheduler.read`, `scheduler.control`).
 * Stateless: a connection saved with another brand is spoken to by that brand's session from the next
 * verb on.
 */
export class SessionBackend implements RouterBackend {
  readonly #scheduler: MutexSessionScheduler;

  constructor(scheduler: MutexSessionScheduler) {
    this.#scheduler = scheduler;
  }

  get family(): RouterFamily {
    return this.#scheduler.getFamily();
  }

  get #driver(): RouterDriver {
    return this.#scheduler.driver;
  }

  /** Whether a read is worth a session on this router. */
  #reads(section: SessionlessRead): boolean {
    return this.#driver.reads(section, this.#scheduler.device);
  }

  /** A write: refused before anything is queued where no form of the brand's interface has it. */
  #write<T>(action: ControlAction, run: (session: RouterSession, write: WriteContext) => Promise<T>, summary?: ControlSummary | ((value: T) => ControlSummary | null)): Promise<T> {
    if (!this.#driver.writes(CONTROL_FEATURES[action])) return this.#scheduler.refuse(action);
    return this.#scheduler.control(action, run, summary);
  }

  identify(priority: SchedulerPriority): Promise<DeviceProbeResult | null> {
    return this.#scheduler.read((session) => session.identify("startup"), { priority });
  }

  readTelemetry(opts: ReadRequest & { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot | null> {
    const scheduler = this.#scheduler;
    return scheduler.read((session) => scheduler.readSection("telemetry", () => session.readTelemetry({ smsCounters: opts.smsCounters })), { priority: "normal", ignoreCooldown: opts.ignoreCooldown });
  }

  readNeighbors(opts: ReadRequest): Promise<NeighborScanSnapshot | null> {
    const scheduler = this.#scheduler;
    return scheduler.read((session) => scheduler.readSection("neighbors", () => session.readNeighbors()), { priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  async readTopology(opts: ReadRequest): Promise<TerminalTopologySnapshot | null> {
    if (!this.#reads("topology")) return null;
    const scheduler = this.#scheduler;
    return await scheduler.read((session) => scheduler.readSection("topology", () => session.readTopology()), { priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  async readSettings(opts: ReadRequest): Promise<RouterSettingsSnapshot | null> {
    if (!this.#reads("settings")) return null;
    const scheduler = this.#scheduler;
    return await scheduler.read((session) => scheduler.readSection("settings", () => session.readSettings()), { priority: "normal", ignoreCooldown: opts.ignoreCooldown });
  }

  async readAccessControl(opts: ReadRequest): Promise<AccessControlSnapshot | null> {
    if (!this.#reads("accessControl")) return null;
    const scheduler = this.#scheduler;
    return await scheduler.read((session) => scheduler.readSection("accessControl", () => session.readAccessControl()), { priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  async listSms(request: SmsListRequest): Promise<SmsListing | null> {
    if (!this.#reads("sms")) return null;
    const scheduler = this.#scheduler;
    return await scheduler.read((session) => scheduler.readSection("sms", () => session.listSms(request)), { priority: request.priority });
  }

  async peekSmsUnread(): Promise<SmsUnreadPeek | null> {
    return this.#driver.peekSmsUnread ? await this.#driver.peekSmsUnread(this.#scheduler) : null;
  }

  async readCellular(opts: ReadRequest): Promise<CellularSettingsSnapshot | null> {
    if (!this.#reads("cellular")) return null;
    return (await this.#scheduler.read((session) => session.readCellular(), { priority: "normal", ignoreCooldown: opts.ignoreCooldown })) ?? null;
  }

  async probeEndpoints(paths: ReadonlyArray<string>): Promise<DiscoveredEndpoint[] | null> {
    if (!this.#reads("endpoints")) return null;
    return await discoverEndpoints(paths, (probe) =>
      this.#scheduler.read((session) => {
        if (!session.discovery) throw new CpeControlValidationError("This router's interface has no endpoint discovery");
        return probe(session.discovery);
      }, { priority: "low" })
    );
  }

  lockBands(command: BandLockCommand, ctx: LockContext, summary: LockSummary): Promise<BandLockOutcome> {
    // Checked before queueing against the router the gate goes by (a write it refuses says so first), and again in the session
    this.#driver.checkBandLock?.(command, this.#scheduler.device);
    return this.#write("lock_band", (session, write) => session.lockBands(command, ctx, write), (outcome) => summary(outcome.state));
  }

  lockCell(command: CellLockCommand, summary: LockSummary): Promise<LockOutcome> {
    this.#driver.checkCellLock?.(command, this.#scheduler.device);
    return this.#write("lock_cell", (session, write) => session.lockCell(command, write), (outcome) => summary(outcome.state));
  }

  unlockAll(summary: LockSummary): Promise<PersistedLockState> {
    return this.#write("unlock_rf_locks", (session, write) => session.unlockAll(write), summary);
  }

  async rollBackLocks(request: RollbackRequest, summary: (outcome: WanRepairOutcome, restored: boolean) => ControlSummary | null): Promise<WanRepairOutcome> {
    const done = await this.#write("auto_unlock_rf_locks", (session, write) => session.rollBackLocks(request, write), (result) => summary(result.outcome, result.restored));
    return done.outcome;
  }

  reboot(params: { confirm: boolean }, summary: ControlSummary): Promise<{ rebooting: true; requestedAtIso: string }> {
    return this.#write("reboot_cpe", (session, write) => session.reboot(params, write), summary);
  }

  reconnect(summary: ControlSummary): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return this.#write("reconnect_cellular", (session, write) => session.reconnect(write), summary);
  }

  autoReconnect(summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    return this.#write("auto_reconnect_cellular", (session, write) => session.autoReconnect(write), summary);
  }

  setMobileData(enabled: boolean, summary: ControlSummary): Promise<{ mobileDataEnabled: boolean }> {
    return this.#write("set_mobile_data", (session, write) => session.setMobileData(enabled, write), summary);
  }

  setSecuritySwitches(command: SecurityUpdateCommand, summary: ControlSummary): Promise<void> {
    return this.#write("set_security_switches", (session, write) => session.setSecuritySwitches(command, write), summary);
  }

  setWifi7(input: { mloEnable?: boolean; dbhoEnable?: boolean }, summary: ControlSummary): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    return this.#write("set_wifi7_mlo", (session, write) => session.setWifi7(input, write), summary);
  }

  setAntennaMode(mode: AntennaModeName, summary: ControlSummary): Promise<{ mode: AntennaModeName; rawCode: number }> {
    this.#driver.checkAntennaMode?.(mode);
    return this.#write("set_antenna_mode", (session, write) => session.setAntennaMode(mode, write), summary);
  }

  setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
    return this.#write("set_wifi_access", (session, write) => session.setWifiAccess(change, ctx, write), summary);
  }

  manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<TimeRulesState> {
    return this.#write("manage_time_rule", (session, write) => session.manageTimeRule(change, ctx, write), summary);
  }

  sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, summary: (outcome: SmsSendOutcome) => ControlSummary): Promise<SmsSendOutcome> {
    this.#driver.checkSms?.(prepared, this.#scheduler.device);
    return this.#write("sms_send", (session, write) => session.sendSms(prepared, options, write), summary);
  }

  /** Where FengSui keeps the read state itself there is nothing to write, and no session. */
  async markSmsRead(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    if (this.#driver.keepsSmsReadState) return 0;
    return await this.#write("sms_mark_read", (session, write) => session.markSmsRead(indices, write), summary);
  }

  deleteSms(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    return this.#write("sms_delete", (session, write) => session.deleteSms(indices, write), summary);
  }

  setNetworkMode(mode: NetworkMode, summary: ControlSummary): Promise<LinkChangeOutcome<NetworkMode>> {
    return this.#write("set_network_mode", (session, write) => session.setNetworkMode(mode, write), summary);
  }

  scanOperators(summary: (found: OperatorChoice[]) => ControlSummary): Promise<OperatorChoice[]> {
    return this.#write("scan_operators", (session, write) => session.scanOperators(write), summary);
  }

  selectOperator(selection: OperatorSelection, summary: ControlSummary): Promise<LinkChangeOutcome<OperatorSelection>> {
    return this.#write("select_operator", (session, write) => session.selectOperator(selection, write), summary);
  }

  setSimSlot(slot: SimSlotRef, summary: ControlSummary): Promise<LinkChangeOutcome<SimSlotRef>> {
    return this.#write("set_sim_slot", (session, write) => session.setSimSlot(slot, write), summary);
  }

  setApn(choice: ApnChoice, summary: ControlSummary): Promise<LinkChangeOutcome<ApnRestore>> {
    return this.#write("set_apn", (session, write) => session.setApn(choice, write), summary);
  }

  revertLinkChange(change: LinkChange, summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    return this.#write(LINK_REVERTS[change.kind], (session, write) => session.revertLinkChange(change, write), summary);
  }

  enterSimPin(pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome> {
    return this.#write("enter_sim_pin", (session, write) => session.enterSimPin(pin, write), summary);
  }

  setSimPinLock(enabled: boolean, pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome> {
    return this.#write("set_sim_pin_lock", (session, write) => session.setSimPinLock(enabled, pin, write), summary);
  }

  setAirplaneMode(enabled: boolean, summary: ControlSummary): Promise<{ airplaneMode: boolean }> {
    return this.#write("set_airplane_mode", (session, write) => session.setAirplaneMode(enabled, write), summary);
  }

  setRoaming(enabled: boolean, summary: ControlSummary): Promise<{ dataRoaming: boolean }> {
    return this.#write("set_roaming", (session, write) => session.setRoaming(enabled, write), summary);
  }

  setDataLimit(limit: DataLimitSetting, summary: ControlSummary): Promise<DataLimitSetting> {
    return this.#write("set_data_limit", (session, write) => session.setDataLimit(limit, write), summary);
  }

  resetTraffic(summary: ControlSummary): Promise<void> {
    return this.#write("reset_traffic", (session, write) => session.resetTraffic(write), summary);
  }

  sendUssd(request: UssdRequest, summary: ControlSummary): Promise<UssdAnswer> {
    return this.#write("send_ussd", (session, write) => session.sendUssd(request, write), summary);
  }
}
