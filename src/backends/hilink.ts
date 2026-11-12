import { type AccessControlSnapshot, type AccessRequestContext, type TimeRulesState, applyTimeRuleChange, applyWifiAccessChange, fetchAccessControl } from "../access-control.ts";
import type { TimeRuleChange, WifiAccessChange, WifiFilterPlan, WifiMacFilterState } from "../access-plan.ts";
import type { ApnRestore, CellularSettingsSnapshot, DataLimitSetting, LinkChange, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, SimSlotRef, UssdAnswer, UssdRequest } from "../cellular.ts";
import { validateGenericBandLock } from "../control-input.ts";
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
  applyBandLock,
  applyCellLock,
  fetchGlobalTelemetry,
  fetchRouterSettings,
  fetchTerminalTopology,
  mergeBandLockState,
  prepareBandLockPayloads,
  prepareCellLockPayload,
  readWanRepairBlocker,
  rebootCpe,
  scanNeighborCells,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
} from "../cpe-domain.ts";
import type { EphemeralCpeSession } from "../cpe-client.ts";
import { type ControlAction, gateRefuses } from "../device-access.ts";
import { type DeviceProbeResult, probeDevice } from "../device-profile.ts";
import {
  genericBandLock,
  genericCellularRead,
  genericMobileData,
  genericNetworkMode,
  genericReboot,
  genericReconnect,
  genericRoaming,
  genericScanOperators,
  genericSelectOperator,
  genericTrafficReset,
  genericUssd,
  readWanRepairBlockerTolerant,
} from "../generic-writes.ts";
import type {
  BandLockOutcome,
  LinkChangeOutcome,
  LockContext,
  LockOutcome,
  LockSummary,
  ReadRequest,
  RollbackRequest,
  RouterBackend,
  SmsListRequest,
  SmsListing,
  SmsSendOutcome,
  SmsUnreadPeek,
  WanRepairOutcome,
} from "../router-backend.ts";
import { CELLULAR_WRITE_FEATURES } from "../router-family.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority, WriteContext } from "../scheduler.ts";
import {
  type PreparedSmsSubmission,
  type SubmitSmsOptions,
  checkSmsNotifications,
  deleteSmsByIndex,
  fetchAllMessages,
  fetchPhoneThread,
  fetchRecentMessages,
  genericDeleteSms,
  genericMarkSmsRead,
  genericSendSms,
  markSmsRead,
  submitSms,
} from "../sms/protocol.ts";
import { validateGenericSmsContent } from "../sms/text-mode.ts";
import type { SmsWireMessage } from "../sms/types.ts";

/**
 * Huawei's HiLink stack as a `RouterBackend`: the H168-383's verified request sequences, and on
 * another HiLink model the tolerant reads and the generic writes the gate has open (`write.generic`,
 * appendix A.11 of the protocol spec). Each verb is one session of the HiLink client through the
 * scheduler's queue, avoidance, breaker and write gate.
 */
export class HilinkBackend implements RouterBackend {
  readonly family = "huawei" as const;
  readonly #scheduler: MutexSessionScheduler;

  constructor(scheduler: MutexSessionScheduler) {
    this.#scheduler = scheduler;
  }

  identify(priority: SchedulerPriority): Promise<DeviceProbeResult | null> {
    return this.#scheduler.executeRead((session) => probeDevice(session, { nowIso: new Date().toISOString(), origin: "startup" }), { priority });
  }

  readTelemetry(opts: ReadRequest & { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot | null> {
    const scheduler = this.#scheduler;
    return scheduler.executeRead(
      (session) =>
        scheduler.readSection("telemetry", () =>
          fetchGlobalTelemetry(session, {
            includeSmsCounters: opts.smsCounters,
            tolerant: scheduler.device.unverifiedModel,
            // A poll that fails on a router replaced by another model still tells it apart
            onFailedPollModel: (model, softwareVersion) => scheduler.noteRouterModel(model, softwareVersion),
          })
        ),
      { priority: "normal", ignoreCooldown: opts.ignoreCooldown }
    );
  }

  /** `GET /api/device/nbrcellinfo`. */
  readNeighbors(opts: ReadRequest): Promise<NeighborScanSnapshot | null> {
    return this.#scheduler.executeRead((session) => this.#scheduler.readSection("neighbors", () => scanNeighborCells(session)), { priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  /** `HostInfo` + `topology`. */
  readTopology(opts: ReadRequest): Promise<TerminalTopologySnapshot | null> {
    const scheduler = this.#scheduler;
    return scheduler.executeRead((session) => scheduler.readSection("topology", () => fetchTerminalTopology(session, { tolerant: scheduler.device.unverifiedModel })), {
      priority: "low",
      ignoreCooldown: opts.ignoreCooldown,
    });
  }

  readSettings(opts: ReadRequest): Promise<RouterSettingsSnapshot | null> {
    return this.#scheduler.executeRead((session) => this.#scheduler.readSection("settings", () => fetchRouterSettings(session)), { priority: "normal", ignoreCooldown: opts.ignoreCooldown });
  }

  /** The Wi-Fi MAC filter and the internet time rules (3 GETs). */
  readAccessControl(opts: ReadRequest): Promise<AccessControlSnapshot | null> {
    return this.#scheduler.executeRead((session) => this.#scheduler.readSection("accessControl", () => fetchAccessControl(session)), { priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  /**
   * Plain `sms-list`, or the encrypted per-contact listing where the router refuses it; a model
   * nobody verified that has neither reads as having no SMS.
   */
  async listSms(request: SmsListRequest): Promise<SmsListing | null> {
    const scheduler = this.#scheduler;
    const fetched = await scheduler.executeRead(
      (session) =>
        scheduler.readSection("sms", () => (request.mode === "full" ? fetchAllMessages(session) : fetchRecentMessages(session, { count: request.recentCount, expandThread: request.expandThread }))),
      { priority: request.priority }
    );
    return fetched ? { ...fetched, complete: request.mode === "full", readState: "router", abilities: { send: true, delete: "message", markRead: "router" } } : null;
  }

  /** `GET /api/monitoring/check-notifications`, which the router answers without a login. */
  async peekSmsUnread(): Promise<SmsUnreadPeek | null> {
    return await checkSmsNotifications(this.#scheduler);
  }

  async sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, summary: (outcome: SmsSendOutcome) => ControlSummary): Promise<SmsSendOutcome> {
    // A model nobody verified sends the plaintext way, which takes no emoji: refused before queueing
    // (a send the gate refuses anyway says so first)
    const device = this.#scheduler.device;
    if (device.generic && !gateRefuses(device.writeAccess("smsWrite"))) validateGenericSmsContent(prepared.content);
    return await this.#scheduler.executeControl(
      "sms_send",
      async (session, write): Promise<SmsSendOutcome> => {
        const back = new Map<string, SmsWireMessage[]>();
        // A model nobody verified: plaintext send-sms and send-status; the encrypted thread read-back is the H168-383's
        if (write.generic) return { result: await genericSendSms(session, write.check, prepared, options), readBack: back, routerKeepsSent: true };
        const result = await submitSms(session, prepared, options);
        if (result.ok) {
          for (const phone of prepared.phones) back.set(phone, await fetchPhoneThread(session, phone, 10).catch(() => []));
        }
        return { result, readBack: back, routerKeepsSent: true };
      },
      summary
    );
  }

  async markSmsRead(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    return await this.#scheduler.executeControl("sms_mark_read", (session, write) => (write.generic ? genericMarkSmsRead(session, write.check, indices) : markSmsRead(session, indices)), summary);
  }

  async deleteSms(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    return await this.#scheduler.executeControl("sms_delete", (session, write) => (write.generic ? genericDeleteSms(session, write.check, indices) : deleteSmsByIndex(session, indices)), summary);
  }

  async lockBands(command: BandLockCommand, ctx: LockContext, summary: LockSummary): Promise<BandLockOutcome> {
    // Checked before queueing against the router the gate goes by (a write it refuses says so first),
    // and again in the session
    const device = this.#scheduler.device;
    if (!device.generic) prepareBandLockPayloads(command);
    else if (!gateRefuses(device.writeAccess("bandLock"))) validateGenericBandLock(command, device.experimentalLteBands);
    let experimental = false;
    let savedLteMask: string | null = null;
    const state = await this.#scheduler.executeControl(
      "lock_band",
      async (session, write) => {
        // A model nobody verified: LTE only, through net-mode, never the H168-383's lock-freq
        if (write.generic) {
          experimental = true;
          const locked = await genericBandLock(session, write.check, validateGenericBandLock(command, write.lteBands), write.lteBands ?? []);
          savedLteMask = locked.before;
          return genericLockState(locked.bands);
        }
        // Read inside the queued session: a lock queued before this one may have just changed it
        const previous = ctx.previousLock();
        const telemetry = ctx.cachedTelemetry();
        const routerLteBands = telemetry?.bandConfig.lteBandHex ? telemetry.bandConfig.activeLteBands : null;
        return mergeBandLockState(previous, command, await applyBandLock(session, command), routerLteBands);
      },
      summary
    );
    return { state, experimental, savedLteMask };
  }

  /** The verified model's alone: no generic cell lock exists, so this one is never an experimental write. */
  async lockCell(command: CellLockCommand, summary: LockSummary): Promise<LockOutcome> {
    prepareCellLockPayload(command);
    const state = await this.#scheduler.executeControl(
      "lock_cell",
      (session, write) => {
        verifiedOnly(write, "lock_cell");
        return applyCellLock(session, command);
      },
      summary
    );
    return { state, experimental: false };
  }

  async unlockAll(summary: LockSummary): Promise<PersistedLockState> {
    return await this.#scheduler.executeControl(
      "unlock_rf_locks",
      async (session, write) => (write.generic ? genericLockState((await genericBandLock(session, write.check, "all", write.lteBands ?? [])).bands) : await unlockAllRfLocks(session)),
      summary
    );
  }

  async rollBackLocks(request: RollbackRequest, summary: (outcome: WanRepairOutcome, restored: boolean) => ControlSummary | null): Promise<WanRepairOutcome> {
    const { restore } = request;
    let restored = false;
    return await this.#scheduler.executeControl(
      "auto_unlock_rf_locks",
      async (session, write): Promise<WanRepairOutcome> => {
        // A lock queued before this rollback may have just replaced the one it was meant for
        if (request.currentLock().updatedAtIso !== request.lockUpdatedAtIso) return { applied: false, skipped: "lock_changed" };
        if (write.generic) {
          const skipped = await readWanRepairBlockerTolerant(session);
          if (skipped) return { applied: false, skipped };
          const locked = await genericBandLock(session, write.check, restore ? { savedMask: restore.lteMask } : "all", write.lteBands ?? []);
          restored = restore !== undefined;
          return { applied: true, lockState: genericLockState(locked.bands) };
        }
        const skipped = await readWanRepairBlocker(session);
        return skipped ? { applied: false, skipped } : { applied: true, lockState: await unlockAllRfLocks(session) };
      },
      (outcome) => summary(outcome, restored)
    );
  }

  async reboot(params: { confirm: boolean }, summary: ControlSummary): Promise<{ rebooting: true; requestedAtIso: string }> {
    return await this.#scheduler.executeControl(
      "reboot_cpe",
      async (session, write) => {
        if (!write.generic) return await rebootCpe(session, params);
        await genericReboot(session, write.check);
        return { rebooting: true as const, requestedAtIso: new Date().toISOString() };
      },
      summary
    );
  }

  async reconnect(summary: ControlSummary): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return await this.#scheduler.executeControl(
      "reconnect_cellular",
      async (session, write) => {
        if (!write.generic) return await triggerCellularReconnect(session);
        await genericReconnect(session, write.check);
        return { reconnecting: true as const, requestedAtIso: new Date().toISOString() };
      },
      summary
    );
  }

  /** `monitoring/status` and the mobile data switch decide; a model nobody verified may lack the switch. */
  async autoReconnect(summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    return await this.#scheduler.executeControl(
      "auto_reconnect_cellular",
      async (session, write): Promise<WanRepairOutcome> => {
        const skipped = write.generic ? await readWanRepairBlockerTolerant(session) : await readWanRepairBlocker(session);
        if (skipped) return { applied: false, skipped };
        if (write.generic) await genericReconnect(session, write.check);
        else await triggerCellularReconnect(session);
        return { applied: true };
      },
      summary
    );
  }

  async setMobileData(enabled: boolean, summary: ControlSummary): Promise<{ mobileDataEnabled: boolean }> {
    return await this.#scheduler.executeControl(
      "set_mobile_data",
      async (session, write) => (write.generic ? { mobileDataEnabled: await genericMobileData(session, write.check, enabled) } : await updateMobileDataSwitch(session, enabled)),
      summary
    );
  }

  async setSecuritySwitches(command: SecurityUpdateCommand, summary: ControlSummary): Promise<void> {
    await this.#scheduler.executeControl(
      "set_security_switches",
      (session, write) => {
        verifiedOnly(write, "set_security_switches");
        return updateSecuritySettings(session, command);
      },
      summary
    );
  }

  async setWifi7(input: { mloEnable?: boolean; dbhoEnable?: boolean }, summary: ControlSummary): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    return await this.#scheduler.executeControl(
      "set_wifi7_mlo",
      (session, write) => {
        verifiedOnly(write, "set_wifi7_mlo");
        return updateWifi7Mlo(session, input);
      },
      summary
    );
  }

  async setAntennaMode(mode: AntennaModeName, summary: ControlSummary): Promise<{ mode: AntennaModeName; rawCode: number }> {
    // The H168-383 was verified with three antenna modes; a fourth is never sent to it
    if (mode === "hybrid") throw new CpeControlValidationError('This router\'s antenna has no "hybrid" mode: choose auto, internal or external');
    return await this.#scheduler.executeControl(
      "set_antenna_mode",
      (session, write) => {
        verifiedOnly(write, "set_antenna_mode");
        return updateAntennaMode(session, mode);
      },
      summary
    );
  }

  async setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
    return await this.#scheduler.executeControl(
      "set_wifi_access",
      (session, write) => {
        verifiedOnly(write, "set_wifi_access");
        return applyWifiAccessChange(session, change, ctx);
      },
      summary
    );
  }

  async manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext, summary: () => ControlSummary): Promise<TimeRulesState> {
    return await this.#scheduler.executeControl(
      "manage_time_rule",
      (session, write) => {
        verifiedOnly(write, "manage_time_rule");
        return applyTimeRuleChange(session, change, ctx);
      },
      summary
    );
  }

  // ------------------------------------------------------------------ cellular settings
  //
  // They came after the H168-383 was verified: the gate keeps every one of them `not_implemented` on
  // it, so none of its requests changed. A HiLink model nobody verified gets the ones whose requests
  // the notes give (appendix A.12 of the protocol spec: the network mode, the operator, data roaming,
  // the traffic counters and USSD); the rest are refused by the gate on every model.

  /** Read on a model nobody verified only, and only where one of these settings is open there: the H168-383 is asked nothing. */
  async readCellular(opts: ReadRequest): Promise<CellularSettingsSnapshot | null> {
    const device = this.#scheduler.device;
    if (!device.generic || CELLULAR_WRITE_FEATURES.every((feature) => gateRefuses(device.writeAccess(feature)))) return null;
    const read = await this.#scheduler.executeRead((session) => genericCellularRead(session), { priority: "normal", ignoreCooldown: opts.ignoreCooldown });
    if (!read) return null;
    const nowMs = Date.now();
    return { capturedAtIso: new Date(nowMs).toISOString(), capturedAtMs: nowMs, ...read };
  }

  /** One of the generic cellular writes: never on a verified model (the gate refuses it there before any session). */
  #genericCellular<T>(action: ControlAction, run: (session: EphemeralCpeSession, write: WriteContext) => Promise<T>, summary: ControlSummary | ((value: T) => ControlSummary | null)): Promise<T> {
    return this.#scheduler.executeControl(
      action,
      (session, write) => {
        if (!write.generic) throw new CpeControlValidationError(`${action} has no implementation for this router; nothing was written`);
        return run(session, write);
      },
      summary
    );
  }

  /** A cellular write FengSui has no HiLink implementation of: the gate's refusal, nothing queued; in a session, nothing sent. */
  #unbuilt<T>(action: ControlAction): Promise<T> {
    return this.#scheduler.executeControl<T>(action, () => Promise.reject(new CpeControlValidationError(`${action} has no implementation for this router; nothing was written`)));
  }

  async setNetworkMode(mode: NetworkMode, summary: ControlSummary): Promise<LinkChangeOutcome<NetworkMode>> {
    return await this.#genericCellular(
      "set_network_mode",
      async (session, write) => {
        const previous = await genericNetworkMode(session, write.check, mode);
        return { previous: previous === mode ? null : previous };
      },
      summary
    );
  }

  async scanOperators(summary: (found: OperatorChoice[]) => ControlSummary): Promise<OperatorChoice[]> {
    return await this.#genericCellular("scan_operators", (session, write) => genericScanOperators(session, write.check), summary);
  }

  async selectOperator(selection: OperatorSelection, summary: ControlSummary): Promise<LinkChangeOutcome<OperatorSelection>> {
    return await this.#genericCellular("select_operator", async (session, write) => ({ previous: await genericSelectOperator(session, write.check, selection) }), summary);
  }

  setSimSlot(): Promise<LinkChangeOutcome<SimSlotRef>> {
    return this.#unbuilt("set_sim_slot");
  }

  setApn(): Promise<LinkChangeOutcome<ApnRestore>> {
    return this.#unbuilt("set_apn");
  }

  /** The way back from a mode or operator change the WAN did not survive; the SIM slot and the access point have no HiLink write. */
  async revertLinkChange(change: LinkChange, summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    if (change.kind === "sim_slot") return await this.#unbuilt("auto_restore_sim_slot");
    if (change.kind === "apn") return await this.#unbuilt("auto_restore_apn");
    return await this.#genericCellular(
      change.kind === "network_mode" ? "auto_restore_network_mode" : "auto_restore_operator",
      async (session, write): Promise<WanRepairOutcome> => {
        const skipped = await readWanRepairBlockerTolerant(session);
        if (skipped) return { applied: false, skipped };
        if (change.kind === "network_mode") await genericNetworkMode(session, write.check, change.previous);
        else await genericSelectOperator(session, write.check, change.previous);
        return { applied: true };
      },
      summary
    );
  }

  enterSimPin(): Promise<SimPinOutcome> {
    return this.#unbuilt("enter_sim_pin");
  }

  setSimPinLock(): Promise<SimPinOutcome> {
    return this.#unbuilt("set_sim_pin_lock");
  }

  setAirplaneMode(): Promise<{ airplaneMode: boolean }> {
    return this.#unbuilt("set_airplane_mode");
  }

  async setRoaming(enabled: boolean, summary: ControlSummary): Promise<{ dataRoaming: boolean }> {
    return await this.#genericCellular(
      "set_roaming",
      async (session, write) => {
        await genericRoaming(session, write.check, enabled);
        return { dataRoaming: enabled };
      },
      summary
    );
  }

  setDataLimit(): Promise<DataLimitSetting> {
    return this.#unbuilt("set_data_limit");
  }

  async resetTraffic(summary: ControlSummary): Promise<void> {
    await this.#genericCellular("reset_traffic", (session, write) => genericTrafficReset(session, write.check), summary);
  }

  async sendUssd(request: UssdRequest, summary: ControlSummary): Promise<UssdAnswer> {
    return await this.#genericCellular("send_ussd", (session, write) => genericUssd(session, write.check, request, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))), summary);
  }
}

/**
 * A write with no generic implementation never runs on a model nobody verified (the gate keeps it
 * `not_implemented`); should it get here anyway, it stops before sending the H168-383's request.
 */
export function verifiedOnly(write: WriteContext, action: string): void {
  if (write.generic) throw new CpeControlValidationError(`${action} has no implementation for a model FengSui was not verified on; nothing was written`);
}

/** The lock state after a generic band lock, or after every lock was taken off: LTE only (no NR band or cell lock on such a model). */
export function genericLockState(lteBands: number[] | "all"): PersistedLockState {
  return { mode: lteBands === "all" ? "unlocked" : "band_lock", updatedAtIso: new Date().toISOString(), lteBands, nrBands: [], cellLock: null };
}
