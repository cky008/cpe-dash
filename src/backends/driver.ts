import type { AccessControlSnapshot, TimeRulesState } from "../access-control.ts";
import type { WifiFilterPlan, WifiMacFilterState } from "../access-plan.ts";
import {
  type ApnChoice,
  type ApnRestore,
  type CellularSettingsSnapshot,
  type DataLimitSetting,
  type LinkChange,
  type NetworkMode,
  type OperatorChoice,
  type OperatorSelection,
  type SimPinOutcome,
  type SimSlotRef,
  type UssdAnswer,
  type UssdRequest,
  pinAttemptAllowed,
  sameOperatorSelection,
  sameSimSlot, PIN_REFUSALS } from "../cellular.ts";
import { type DriverBandLockRequest, readDriverBandLockTarget, readDriverCellLockTarget } from "../control-input.ts";
import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type GlobalTelemetrySnapshot,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type TerminalTopologySnapshot,
} from "../cpe-domain.ts";
import { CpeApiError } from "../cpe-client.ts";
import type { DeviceProbeResult } from "../device-profile.ts";
import { bandsToHex, hexToBands } from "../drivers/bands.ts";
import { settleRestart } from "../drivers/readback.ts";
import { settleSmsSend, storedIndices } from "../drivers/sms.ts";
import type { DriverCellular, DriverCellularState, DriverLockState, DriverSession, DriverSmsSendOptions, DriverSmsSendOutcome, DriverWait } from "../drivers/types.ts";
import type { ControlAction, WriteCheck } from "../device-access.ts";
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
import { type DriverFamily, type FamilyWriteFeature, ROUTER_FAMILY_FACTS } from "../router-family.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority, WriteContext } from "../scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "../sms/protocol.ts";
import type { SmsSendResult } from "../sms/types.ts";
import { genericLockState } from "./hilink.ts";

/**
 * A router of a driver family (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt) as a `RouterBackend`:
 * each verb is one session of the family's driver (`src/drivers/`) through the scheduler's queue,
 * avoidance, breaker and write gate. Its writes are experimental on every model (on by default, each
 * can be turned off, read back in the same session). SMS, the data connection, the device list and the
 * antenna and the cellular settings go to the optional parts of the family's session (`sms`, `data`,
 * `hosts`, `setAntennaMode`, `cellular`), where its interface has them. What no driver implements (router settings, access control, the
 * security switches, Wi-Fi 7) has nothing to read here, and the gate refuses its writes before any
 * session.
 */
export class DriverBackend implements RouterBackend {
  readonly #scheduler: MutexSessionScheduler;

  constructor(scheduler: MutexSessionScheduler) {
    this.#scheduler = scheduler;
  }

  /** The family of the connection in use (the scheduler swaps the driver with the connection). */
  get family(): DriverFamily {
    const family = this.#scheduler.getFamily();
    if (family === "huawei") throw new TypeError("The driver backend was asked for on a HiLink connection");
    return family;
  }

  identify(priority: SchedulerPriority): Promise<DeviceProbeResult | null> {
    return this.#scheduler.executeDriverIdentify({ priority });
  }

  readTelemetry(opts: ReadRequest & { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot | null> {
    return this.#scheduler.executeDriverTelemetryRead({ priority: "normal", ignoreCooldown: opts.ignoreCooldown, smsCounters: opts.smsCounters });
  }

  readNeighbors(opts: ReadRequest): Promise<NeighborScanSnapshot | null> {
    return this.#scheduler.executeDriverNeighbourRead({ priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  /** The devices the router lists, where the family's notes define a device list (the others read none). */
  readTopology(opts: ReadRequest): Promise<TerminalTopologySnapshot | null> {
    if (!(ROUTER_FAMILY_FACTS[this.family].reads as ReadonlyArray<string>).includes("topology")) return Promise.resolve(null);
    return this.#scheduler.executeDriverTopologyRead({ priority: "low", ignoreCooldown: opts.ignoreCooldown });
  }

  readSettings(): Promise<RouterSettingsSnapshot | null> {
    return Promise.resolve(null);
  }

  readAccessControl(): Promise<AccessControlSnapshot | null> {
    return Promise.resolve(null);
  }

  /**
   * The family's own listing: everything the router stores, in one session. A family whose notes
   * define no SMS interface has nothing to list, and gets no request.
   */
  async listSms(request: SmsListRequest): Promise<SmsListing | null> {
    const facts = ROUTER_FAMILY_FACTS[this.family];
    if (!(facts.reads as ReadonlyArray<string>).includes("sms")) return null;
    const listed = await this.#scheduler.executeDriverSmsList({ priority: request.priority });
    // `abilities` comes from the session: what the family's interface has, and what this router offers of it
    const readState = facts.smsReadState ?? "router";
    return listed ? { ...listed, via: "driver", complete: true, readState, abilities: { ...listed.abilities, markRead: readState } } : null;
  }

  /** No family answers an unread count without a login. */
  peekSmsUnread(): Promise<SmsUnreadPeek | null> {
    return Promise.resolve(null);
  }

  /**
   * One send per recipient, each once, in one session. A recipient the router refuses, or says the
   * message did not reach, is a failed one; once a send was taken, an error ends the session's sends
   * (the recipients not reached yet are failed, not tried again) instead of failing what went out.
   */
  async sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, summary: (outcome: SmsSendOutcome) => ControlSummary): Promise<SmsSendOutcome> {
    return await this.#scheduler.executeDriverControl(
      "sms_send",
      async (session, write): Promise<SmsSendOutcome> => {
        const sms = session.sms;
        if (!sms?.send) throw noSmsWrite("send a message");
        let accepted = false;
        const sendOptions: DriverSmsSendOptions = {
          statusTimeoutMs: options.statusTimeoutMs ?? 45_000,
          sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
          onAccepted: () => {
            accepted = true;
            options.onAccepted?.();
          },
        };
        const outcomes: DriverSmsSendOutcome[] = [];
        for (const phone of prepared.phones) {
          try {
            outcomes.push(await sms.send(phone, prepared.content, write.check, sendOptions));
          } catch (err) {
            // Nothing went out yet: the caller is told what the router said
            if (!accepted) throw err;
            // Something did: this recipient and the ones after it are not reached, and nothing is sent again
            while (outcomes.length < prepared.phones.length) outcomes.push({ state: "failed", code: err instanceof CpeApiError ? err.code : null });
            break;
          }
        }
        settleSmsSend(write.check, outcomes);
        const failedPhones = prepared.phones.filter((_, i) => outcomes[i]?.state === "failed");
        const result: SmsSendResult = {
          submitted: true,
          encoding: prepared.mode.encoding,
          segments: prepared.mode.segments,
          ok: failedPhones.length === 0,
          timedOutWaitingStatus: failedPhones.length === 0 && outcomes.some((o) => o.state === "unconfirmed"),
          sentPhones: prepared.phones.filter((_, i) => outcomes[i]?.state !== "failed"),
          failedPhones,
          failCode: outcomes.find((o) => o.state === "failed")?.code ?? null,
        };
        return { result, readBack: new Map(), routerKeepsSent: sms.keepsSent };
      },
      summary
    );
  }

  /** Where FengSui keeps the read state itself there is nothing to write, and no session. */
  async markSmsRead(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    if (ROUTER_FAMILY_FACTS[this.family].smsReadState === "fengsui") return 0;
    const wanted = storedIndices(indices);
    return await this.#scheduler.executeDriverControl(
      "sms_mark_read",
      async (session, write) => {
        const sms = session.sms;
        if (!sms?.markRead) throw noSmsWrite("mark a message read");
        if (wanted.length > 0) await sms.markRead(wanted, write.check);
        return wanted.length;
      },
      summary
    );
  }

  async deleteSms(indices: ReadonlyArray<number>, summary: (count: number) => ControlSummary): Promise<number> {
    const wanted = storedIndices(indices);
    return await this.#scheduler.executeDriverControl(
      "sms_delete",
      async (session, write) => {
        const sms = session.sms;
        if (!sms?.delete) throw noSmsWrite("delete a message");
        if (wanted.length > 0) await sms.delete(wanted, write.check);
        return wanted.length;
      },
      summary
    );
  }

  // ------------------------------------------------------------------ cellular settings (the session's `cellular` part)

  /**
   * What the router reports of its cellular settings, in one session. The modes on offer are the
   * router's own list where it names one, else the family's. `null`: the family writes none of them
   * and reads none (no session).
   */
  async readCellular(opts: ReadRequest): Promise<CellularSettingsSnapshot | null> {
    if (!CELLULAR_FEATURES.some((feature) => this.#writesAnywhere(feature))) return null;
    const state = await this.#scheduler.executeDriverCellularRead({ priority: "normal", ignoreCooldown: opts.ignoreCooldown });
    if (!state) return null;
    const nowMs = Date.now();
    const modes = state.networkModes ?? [...(ROUTER_FAMILY_FACTS[this.family].selectableModes ?? [])];
    return {
      capturedAtIso: new Date(nowMs).toISOString(),
      capturedAtMs: nowMs,
      networkMode: state.networkMode !== undefined || modes.length > 0 ? { current: state.networkMode ?? null, options: modes } : null,
      simSlots: state.simSlots ?? null,
      operator: state.operator ?? null,
      apn: state.apn ?? null,
      dataLimit: state.dataLimit ?? null,
      // The drivers read the roaming switch in the poll (`status.roaming`)
      dataRoaming: null,
    };
  }

  /**
   * One cellular write: refused before anything is queued where no form of the family's interface has
   * it, and in the session (nothing sent) where this router's form lacks it.
   */
  async #cellular<T>(
    feature: FamilyWriteFeature,
    action: ControlAction,
    what: string,
    run: (cellular: DriverCellular, write: WriteContext, session: DriverSession) => Promise<T>,
    summary: ControlSummary | ((value: T) => ControlSummary | null)
  ): Promise<T> {
    if (!this.#writesAnywhere(feature)) return await this.#scheduler.refuseDriverWrite(action);
    return await this.#scheduler.executeDriverControl(
      action,
      async (session, write) => {
        if (!session.cellular) throw noWrite(what);
        return await run(session.cellular, write, session);
      },
      summary
    );
  }

  async setNetworkMode(mode: NetworkMode, summary: ControlSummary): Promise<LinkChangeOutcome<NetworkMode>> {
    return await this.#cellular(
      "networkMode",
      "set_network_mode",
      "switch the network mode",
      async (cellular, write) => {
        if (!cellular.setNetworkMode) throw noWrite("switch the network mode");
        const before = await cellular.read().catch((): DriverCellularState => ({}));
        // The modes this router names, else the family's: a mode outside them is not sent
        const offered = before.networkModes ?? ROUTER_FAMILY_FACTS[this.family].selectableModes ?? [];
        if (!offered.includes(mode)) throw new CpeControlValidationError(`This router offers no "${mode}" network mode (it offers ${offered.join(", ") || "none"})`);
        await cellular.setNetworkMode(mode, write.check);
        const previous = before.networkMode ?? null;
        return { previous: previous === mode ? null : previous };
      },
      summary
    );
  }

  async scanOperators(summary: (found: OperatorChoice[]) => ControlSummary): Promise<OperatorChoice[]> {
    return await this.#cellular(
      "operatorSelect",
      "scan_operators",
      "search for networks",
      async (cellular, write) => {
        if (!cellular.scanOperators) throw noWrite("search for networks");
        return await cellular.scanOperators(write.check, SESSION_WAIT);
      },
      summary
    );
  }

  async selectOperator(selection: OperatorSelection, summary: ControlSummary): Promise<LinkChangeOutcome<OperatorSelection>> {
    return await this.#cellular(
      "operatorSelect",
      "select_operator",
      "choose the operator",
      async (cellular, write) => {
        if (!cellular.selectOperator) throw noWrite("choose the operator");
        const before = (await cellular.read().catch((): DriverCellularState => ({}))).operator ?? null;
        await cellular.selectOperator(selection, write.check, SESSION_WAIT);
        // What it is put back to is how the router chose before: by itself, or the operator it was kept on
        const previous: OperatorSelection | null = before?.selection === "auto" ? { mode: "auto" } : before?.selection === "manual" && before.plmn !== null ? { mode: "manual", plmn: before.plmn, rat: null } : null;
        return { previous: previous !== null && sameOperatorSelection(previous, selection) ? null : previous };
      },
      summary
    );
  }

  async setSimSlot(slot: SimSlotRef, summary: ControlSummary): Promise<LinkChangeOutcome<SimSlotRef>> {
    return await this.#cellular(
      "simSlot",
      "set_sim_slot",
      "switch the SIM slot",
      async (cellular, write) => {
        if (!cellular.setSimSlot) throw noWrite("switch the SIM slot");
        const before = await cellular.read().catch((): DriverCellularState => ({}));
        if (before.simSlots && !before.simSlots.some((offered) => sameSimSlot(offered, slot))) throw new CpeControlValidationError("This router has no such SIM slot");
        await cellular.setSimSlot(slot, write.check);
        const previous = before.simSlot ?? null;
        return { previous: sameSimSlot(previous, slot) ? null : previous };
      },
      summary
    );
  }

  async setApn(choice: ApnChoice, summary: ControlSummary): Promise<LinkChangeOutcome<ApnRestore>> {
    return await this.#cellular(
      "apn",
      "set_apn",
      "change the access point",
      async (cellular, write) => {
        if (!cellular.setApn) throw noWrite("change the access point");
        const before = await cellular.read().catch((): DriverCellularState => ({}));
        await cellular.setApn(choice, write.check, SESSION_WAIT);
        // Only an access point the router can be switched back to is worth watching the WAN for
        return { previous: cellular.restoreApn ? (before.apnRestore ?? null) : null };
      },
      summary
    );
  }

  /**
   * Put a setting back after a change the WAN did not survive. The session reads first: a WAN that is
   * up, a radio switched off or mobile data switched off on purpose leaves everything as it is.
   */
  async revertLinkChange(change: LinkChange, summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    const { feature, action } = LINK_REVERTS[change.kind];
    return await this.#cellular(
      feature,
      action,
      "put the setting back",
      async (cellular, write, session): Promise<WanRepairOutcome> => {
        const telemetry = await session.telemetry().catch(() => null);
        if (telemetry?.wan.connected === true) return { applied: false, skipped: "wan_up" };
        if (telemetry?.status?.airplaneMode === true) return { applied: false, skipped: "airplane_mode" };
        if ((await session.data?.enabled().catch((): boolean | null => null)) === false) return { applied: false, skipped: "mobile_data_off" };
        if (change.kind === "sim_slot") {
          if (!cellular.setSimSlot) throw noWrite("switch the SIM slot");
          await cellular.setSimSlot(change.previous, write.check);
        } else if (change.kind === "network_mode") {
          if (!cellular.setNetworkMode) throw noWrite("switch the network mode");
          await cellular.setNetworkMode(change.previous, write.check);
        } else if (change.kind === "operator") {
          if (!cellular.selectOperator) throw noWrite("choose the operator");
          await cellular.selectOperator(change.previous, write.check, SESSION_WAIT);
        } else {
          if (!cellular.restoreApn) throw noWrite("switch the access point back");
          await cellular.restoreApn(change.previous, write.check, SESSION_WAIT);
        }
        return { applied: true };
      },
      summary
    );
  }

  /**
   * A PIN write. The attempts the card has left are read in this session, right before: none
   * reported, or one left, and nothing is sent. Whatever the router answers, nothing is sent twice.
   */
  async #pin(action: ControlAction, what: string, run: (cellular: DriverCellular, write: WriteContext) => Promise<SimPinOutcome>, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome> {
    return await this.#cellular(
      "simPin",
      action,
      what,
      async (cellular, write) => {
        const before = await cellular.read();
        const attempts = pinAttemptAllowed(before.pinAttemptsLeft);
        if (!attempts.allowed) throw new CpeControlValidationError(PIN_REFUSALS[attempts.reason]);
        return await run(cellular, write);
      },
      summary
    );
  }

  async enterSimPin(pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome> {
    return await this.#pin(
      "enter_sim_pin",
      "enter the SIM PIN",
      async (cellular, write) => {
        if (!cellular.enterPin) throw noWrite("enter the SIM PIN");
        return await cellular.enterPin(pin, write.check);
      },
      summary
    );
  }

  async setSimPinLock(enabled: boolean, pin: string, summary: (outcome: SimPinOutcome) => ControlSummary): Promise<SimPinOutcome> {
    return await this.#pin(
      "set_sim_pin_lock",
      "change the SIM PIN lock",
      async (cellular, write) => {
        if (!cellular.setPinLock) throw noWrite("change the SIM PIN lock");
        return await cellular.setPinLock(enabled, pin, write.check);
      },
      summary
    );
  }

  async setAirplaneMode(enabled: boolean, summary: ControlSummary): Promise<{ airplaneMode: boolean }> {
    return await this.#cellular(
      "airplaneSwitch",
      "set_airplane_mode",
      "switch airplane mode",
      async (cellular, write) => {
        if (!cellular.setAirplaneMode) throw noWrite("switch airplane mode");
        await cellular.setAirplaneMode(enabled, write.check);
        return { airplaneMode: enabled };
      },
      summary
    );
  }

  async setRoaming(enabled: boolean, summary: ControlSummary): Promise<{ dataRoaming: boolean }> {
    return await this.#cellular(
      "roaming",
      "set_roaming",
      "switch data roaming",
      async (cellular, write) => {
        if (!cellular.setRoaming) throw noWrite("switch data roaming");
        await cellular.setRoaming(enabled, write.check);
        return { dataRoaming: enabled };
      },
      summary
    );
  }

  async setDataLimit(limit: DataLimitSetting, summary: ControlSummary): Promise<DataLimitSetting> {
    return await this.#cellular(
      "dataLimit",
      "set_data_limit",
      "set the data limit",
      async (cellular, write) => {
        if (!cellular.setDataLimit) throw noWrite("set the data limit");
        await cellular.setDataLimit(limit, write.check);
        return limit;
      },
      summary
    );
  }

  async resetTraffic(summary: ControlSummary): Promise<void> {
    await this.#cellular(
      "trafficReset",
      "reset_traffic",
      "clear the traffic counters",
      async (cellular, write) => {
        if (!cellular.resetTraffic) throw noWrite("clear the traffic counters");
        await cellular.resetTraffic(write.check);
      },
      summary
    );
  }

  async sendUssd(request: UssdRequest, summary: ControlSummary): Promise<UssdAnswer> {
    return await this.#cellular(
      "ussd",
      "send_ussd",
      "send a USSD code",
      async (cellular, write) => {
        if (!cellular.ussd) throw noWrite("send a USSD code");
        return await cellular.ussd(request, write.check, SESSION_WAIT);
      },
      summary
    );
  }

  /**
   * A RAT the command leaves out keeps the bands the router reports before the write; the LTE bands
   * read before it are what the lock is put back to if the WAN stays down.
   */
  async lockBands(command: BandLockCommand, _ctx: LockContext, summary: LockSummary): Promise<BandLockOutcome> {
    // Checked before queueing: numbers, NR only where the family locks NR, a mode the family offers
    const target = readDriverBandLockTarget(command, ROUTER_FAMILY_FACTS[this.family]);
    let savedLteMask: string | null = null;
    const state = await this.#scheduler.executeDriverControl(
      "lock_band",
      async (session, write) => {
        const before = await session.lockState().catch((): DriverLockState | null => null);
        // The bands a command leaves out are the router's to keep: unread, they would be overwritten with a guess
        if (target.lte === null && (before?.lteBands ?? null) === null) {
          throw new CpeControlValidationError("The router's current LTE bands could not be read, and locking NR bands alone would overwrite them: name lteBands as well (or 'all')");
        }
        const lte = target.lte ?? before?.lteBands ?? "all";
        savedLteMask = Array.isArray(before?.lteBands) ? bandsToHex(before.lteBands) : null;
        await session.setBandLock({ lte, nr: target.nr, networkMode: target.networkMode }, write.check);
        return driverBandLockState({ ...target, lte }, before);
      },
      summary
    );
    return { state, experimental: true, savedLteMask };
  }

  /** Band, channel and PCI, read back in the session; without a PCI, the channel alone where the family's notes define that lock. */
  async lockCell(command: CellLockCommand, summary: LockSummary): Promise<LockOutcome> {
    const target = readDriverCellLockTarget(command, ROUTER_FAMILY_FACTS[this.family]);
    const state = await this.#scheduler.executeDriverControl(
      "lock_cell",
      async (session, write): Promise<PersistedLockState> => {
        const { pci, ...channel } = target;
        if (pci !== null) await session.setCellLock({ ...channel, pci }, write.check);
        else if (session.setFrequencyLock) await session.setFrequencyLock(channel, write.check);
        else throw noWrite("lock a channel without a PCI");
        return {
          mode: "cell_lock",
          updatedAtIso: new Date().toISOString(),
          lteBands: target.rat === "LTE" ? [target.band] : "all",
          nrBands: target.rat === "NR" ? [target.band] : [],
          cellLock: { rat: target.rat, band: target.band, arfcn: target.arfcn, pci: target.pci },
        };
      },
      summary
    );
    return { state, experimental: true };
  }

  async unlockAll(summary: LockSummary): Promise<PersistedLockState> {
    return await this.#scheduler.executeDriverControl(
      "unlock_rf_locks",
      async (session, write) => {
        await session.unlockAll(write.check);
        return genericLockState("all");
      },
      summary
    );
  }

  /** The WAN's state is the driver's own reading (no driver has a mobile-data switch to read). */
  async rollBackLocks(request: RollbackRequest, summary: (outcome: WanRepairOutcome, restored: boolean) => ControlSummary | null): Promise<WanRepairOutcome> {
    const savedBands = request.restore ? hexToBands(request.restore.lteMask) : null;
    const restoring = savedBands !== null && savedBands.length > 0;
    return await this.#scheduler.executeDriverControl(
      "auto_unlock_rf_locks",
      async (session: DriverSession, write): Promise<WanRepairOutcome> => {
        if (request.currentLock().updatedAtIso !== request.lockUpdatedAtIso) return { applied: false, skipped: "lock_changed" };
        const telemetry = await session.telemetry().catch(() => null);
        if (telemetry?.wan.connected === true) return { applied: false, skipped: "wan_up" };
        if (restoring) {
          await session.setBandLock({ lte: savedBands, nr: null, networkMode: null }, write.check);
          return { applied: true, lockState: driverBandLockState({ lte: savedBands, nr: null, networkMode: null }, null) };
        }
        await session.unlockAll(write.check);
        return { applied: true, lockState: genericLockState("all") };
      },
      (outcome) => summary(outcome, restoring)
    );
  }

  /** A redial: the router's own command, else off and on again (connected again at the end in any case). */
  async reconnect(summary: ControlSummary): Promise<{ reconnecting: true; requestedAtIso: string }> {
    if (!this.#writesAnywhere("reconnect")) return await this.#scheduler.refuseDriverWrite("reconnect_cellular");
    return await this.#scheduler.executeDriverControl(
      "reconnect_cellular",
      async (session, write) => {
        await redial(session, write.check);
        return { reconnecting: true as const, requestedAtIso: new Date().toISOString() };
      },
      summary
    );
  }

  /**
   * Self-healing's redial: the WAN as the driver reads it in the session (up: nothing to do), then the
   * data switch where the router has one to read (off: someone switched it off on purpose). A session
   * that cannot read the WAN fails the repair rather than redial blind.
   */
  async autoReconnect(summary: (outcome: WanRepairOutcome) => ControlSummary | null): Promise<WanRepairOutcome> {
    if (!this.#writesAnywhere("reconnect")) return await this.#scheduler.refuseDriverWrite("auto_reconnect_cellular");
    return await this.#scheduler.executeDriverControl(
      "auto_reconnect_cellular",
      async (session, write): Promise<WanRepairOutcome> => {
        if ((await session.telemetry()).wan.connected === true) return { applied: false, skipped: "wan_up" };
        if ((await session.data?.enabled().catch((): boolean | null => null)) === false) return { applied: false, skipped: "mobile_data_off" };
        await redial(session, write.check);
        return { applied: true };
      },
      summary
    );
  }

  async setMobileData(enabled: boolean, summary: ControlSummary): Promise<{ mobileDataEnabled: boolean }> {
    if (!this.#writesAnywhere("mobileData")) return await this.#scheduler.refuseDriverWrite("set_mobile_data");
    return await this.#scheduler.executeDriverControl(
      "set_mobile_data",
      async (session, write) => {
        if (!session.data) throw noWrite("switch mobile data");
        await session.data.set(enabled, write.check, SESSION_WAIT);
        return { mobileDataEnabled: enabled };
      },
      summary
    );
  }

  /**
   * Some form of the family's interface has this write: the gate decides for the router in use. None
   * has it: refused before anything is queued, as `executeControl` refuses it.
   */
  #writesAnywhere(feature: FamilyWriteFeature): boolean {
    const facts = ROUTER_FAMILY_FACTS[this.family];
    return facts.writes.includes(feature) || Object.values(facts.variants ?? {}).some((form) => form.writes.includes(feature));
  }

  // ------------------------------------------------------------------ writes no driver implements yet (the gate's refusal, nothing queued)

  setSecuritySwitches(): Promise<void> {
    return this.#scheduler.refuseDriverWrite("set_security_switches");
  }

  setWifi7(): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    return this.#scheduler.refuseDriverWrite("set_wifi7_mlo");
  }

  async setAntennaMode(mode: AntennaModeName, summary: ControlSummary): Promise<{ mode: AntennaModeName; rawCode: number }> {
    if (!this.#writesAnywhere("antenna")) return await this.#scheduler.refuseDriverWrite("set_antenna_mode");
    return await this.#scheduler.executeDriverControl(
      "set_antenna_mode",
      async (session, write) => {
        if (!session.setAntennaMode) throw noWrite("switch the antenna");
        return { mode, rawCode: await session.setAntennaMode(mode, write.check) };
      },
      summary
    );
  }

  setWifiAccess(): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
    return this.#scheduler.refuseDriverWrite("set_wifi_access");
  }

  manageTimeRule(): Promise<TimeRulesState> {
    return this.#scheduler.refuseDriverWrite("manage_time_rule");
  }

  async reboot(_params: { confirm: boolean }, summary: ControlSummary): Promise<{ rebooting: true; requestedAtIso: string }> {
    return await this.#scheduler.executeDriverControl(
      "reboot_cpe",
      async (session, write) => {
        await session.reboot(write.check);
        return { rebooting: true as const, requestedAtIso: new Date().toISOString() };
      },
      summary
    );
  }
}

/** The cellular settings a driver family may write (`ROUTER_FAMILY_FACTS[family].writes` names the ones it does). */
const CELLULAR_FEATURES: ReadonlyArray<FamilyWriteFeature> = ["networkMode", "operatorSelect", "simSlot", "simPin", "airplaneSwitch", "roaming", "apn", "dataLimit", "trafficReset", "ussd"];

/** The write that puts each kind of change back, filed under the setting's own feature. */
const LINK_REVERTS: Readonly<Record<LinkChange["kind"], { feature: FamilyWriteFeature; action: ControlAction }>> = {
  sim_slot: { feature: "simSlot", action: "auto_restore_sim_slot" },
  network_mode: { feature: "networkMode", action: "auto_restore_network_mode" },
  operator: { feature: "operatorSelect", action: "auto_restore_operator" },
  apn: { feature: "apn", action: "auto_restore_apn" },
};

export { PIN_REFUSALS };

/** A write the family's interface has no way to do (the gate let SMS writes through for the ones it has). */
function noSmsWrite(what: string): CpeControlValidationError {
  return noWrite(what);
}

/** A write this router's form of the family's interface has no way to do (the gate's last line). */
function noWrite(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface gives FengSui no way to ${what}; nothing was sent to it`);
}

/** How long a write may wait in its session for the router to follow (a disconnect before the connect). */
const SESSION_WAIT: DriverWait = { sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };

/**
 * Redial with the router's own command, or switch data off and on again. The connect is sent in any
 * case, also when the disconnect failed: a redial never leaves the router disconnected on purpose.
 * Each command goes out once; the polls that follow tell whether a new connection came up.
 */
async function redial(session: DriverSession, check: WriteCheck): Promise<void> {
  const data = session.data;
  if (!data) throw noWrite("redial");
  if (data.redial) {
    await data.redial(check);
  } else {
    try {
      await data.set(false, check, SESSION_WAIT);
    } finally {
      await data.set(true, check, SESSION_WAIT);
    }
  }
  settleRestart(check);
}

/**
 * The lock state after a driver band lock: the LTE bands it set, the NR bands it set or (left out)
 * the ones the router reported before it; `unlocked` only when neither RAT keeps a band list.
 */
function driverBandLockState(target: DriverBandLockRequest & { lte: number[] | "all" }, before: DriverLockState | null): PersistedLockState {
  const nr = target.nr ?? before?.nrBands ?? "all";
  const nrBands = nr === "all" ? [] : [...nr];
  return {
    mode: target.lte === "all" && nrBands.length === 0 ? "unlocked" : "band_lock",
    updatedAtIso: new Date().toISOString(),
    lteBands: target.lte === "all" ? "all" : [...target.lte],
    nrBands,
    cellLock: null,
  };
}
