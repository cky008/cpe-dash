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
  PIN_REFUSALS,
  type SimPinOutcome,
  type SimSlotRef,
  type UssdAnswer,
  type UssdRequest,
  pinAttemptAllowed,
  sameOperatorSelection,
  sameSimSlot,
} from "../cellular.ts";
import { type DriverBandLockRequest, readDriverBandLockTarget, readDriverCellLockTarget, readDriverCellLockTargets } from "../control-input.ts";
import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type GlobalTelemetrySnapshot,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  SectionUnavailableError,
  type TerminalTopologySnapshot,
} from "../cpe-domain.ts";
import type { DeviceAccess, WriteCheck } from "../device-access.ts";
import { CELLULAR_WRITE_FEATURES, type WriteFeature } from "../features.ts";
import type { DeviceProbeResult, ProbeOrigin } from "../device-profile.ts";
import type { BandLockOutcome, LinkChangeOutcome, LockContext, LockOutcome, RollbackRequest, SavedBandSetting, SmsListing, SmsSendOutcome, WanRepairOutcome } from "../router-backend.ts";
import { type DriverFamily, ROUTER_FAMILY_FACTS, familyWritesAnywhere, unnamedModel } from "../router-family.ts";
import type { RouterDriver, RouterSession, RouterSessionContext, SessionlessRead, TestedIdentity } from "../router-session.ts";
import type { WriteContext } from "../scheduler.ts";
import type { LanHttp } from "../protocols/transport.ts";
import { raceSignal } from "../session-client.ts";
import { CpeApiError } from "../session-errors.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "../sms/submission.ts";
import type { SmsCounters, SmsSendResult } from "../sms/types.ts";
import { bandsToHex, hexToBands } from "./bands.ts";
import { sessionTransport } from "./client.ts";
import { driverTopologySnapshot } from "./hosts.ts";
import { genericLockState } from "./huawei/driver.ts";
import { settleRestart } from "./readback.ts";
import { type CounterRates, driverDeviceProbe, driverNeighbourSnapshot, driverTelemetrySnapshot } from "./snapshot.ts";
import { settleSmsSend, storedIndices } from "./sms.ts";
import type { DriverBandLockTarget, DriverCellular, DriverCellularState, DriverIdentity, DriverLockState, DriverSession, DriverSmsSendOptions, DriverSmsSendOutcome, DriverWait } from "./types.ts";

/**
 * A router of a driver family (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt) as a `RouterSession`:
 * what every one of these brands does the same way around its driver's compact session
 * (`DriverSession`, `src/drivers/types.ts`): the snapshots in the shapes the HiLink stack produces,
 * redial by switching data off and on again where the router has no redial of its own, the band a
 * lock leaves out kept as the router reported it, a PIN only with more than one attempt left. SMS,
 * the data connection, the device list, the antenna and the cellular settings go to the optional
 * parts of the session (`sms`, `data`, `hosts`, `setAntennaMode`, `cellular`), where its interface has
 * them; what no driver implements (router settings, access control, the security switches, Wi-Fi 7)
 * the gate refuses before any session.
 */
export class DriverRouterSession implements RouterSession {
  readonly #session: DriverSession;
  readonly #ctx: RouterSessionContext;
  readonly #rates: CounterRates;
  /** The session's transport (`null`: a session no client opened, which nothing cuts short). */
  readonly #transport: LanHttp | null;
  /** How a write waits in its session for the router to follow: no longer than the session lasts. */
  readonly #wait: DriverWait;

  constructor(session: DriverSession, ctx: RouterSessionContext, rates: CounterRates) {
    this.#session = session;
    this.#ctx = ctx;
    this.#rates = rates;
    const transport = sessionTransport(session);
    this.#transport = transport;
    this.#wait = { sleep: (ms) => (transport ? transport.sleep(ms) : timerSleep(ms)) };
  }

  get family(): DriverFamily {
    return this.#session.family;
  }

  /** What the router says it is; a brand whose interface names no model goes by the name its facts give it. */
  async #identity(): Promise<DriverIdentity> {
    const identity = await this.#session.identify();
    return identity.model === null ? { ...identity, model: unnamedModel(this.family) } : identity;
  }

  async readModel(): Promise<{ model: string; softwareVersion: string | null; variant: string | null } | null> {
    const identity = await this.#identity();
    return identity.model ? { model: identity.model, softwareVersion: identity.softwareVersion, variant: identity.variant ?? null } : null;
  }

  async identify(origin: ProbeOrigin): Promise<DeviceProbeResult> {
    return driverDeviceProbe(await this.#identity(), { nowIso: new Date().toISOString(), origin });
  }

  /** One identification serves both: no HiLink endpoints to probe, no HiLink login to describe. */
  async testIdentity(): Promise<{ identified: TestedIdentity; probe: DeviceProbeResult }> {
    const identity = await this.#identity();
    return {
      identified: { model: identity.model, firmware: identity.softwareVersion, loginScheme: "unknown", tokenFlow: "unknown", ecc: false },
      probe: driverDeviceProbe(identity, { nowIso: new Date().toISOString(), origin: "connection-test" }),
    };
  }

  /**
   * The driver's reading, rates derived from its byte counters when it reports no rate, in the shapes
   * the HiLink stack produces, so the cache, the history, the alerts and the console need nothing per
   * family. The SMS counts ride on this session (no login of their own) and never cost the poll its readings.
   */
  async readTelemetry(opts: { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot> {
    const raw = await this.#session.telemetry();
    const nowMs = Date.now();
    const sms = opts.smsCounters && !this.#ctx.device.skips("sms") ? await this.#smsCounters() : null;
    return driverTelemetrySnapshot(this.#rates.apply(raw, nowMs), nowMs, sms);
  }

  /** The SMS counts of this session: `null` where the router has no SMS, or this read of them failed. */
  async #smsCounters(): Promise<SmsCounters | null> {
    const sms = this.#session.sms;
    if (!sms) return null;
    try {
      return await this.#ctx.readSection("sms", () => sms.counters());
    } catch {
      return null;
    }
  }

  async readNeighbors(): Promise<NeighborScanSnapshot> {
    return driverNeighbourSnapshot(await this.#session.neighbours(), Date.now());
  }

  async readTopology(): Promise<TerminalTopologySnapshot> {
    if (!this.#session.hosts) throw new SectionUnavailableError("The device list", null);
    return driverTopologySnapshot(await this.#session.hosts());
  }

  readSettings(): Promise<RouterSettingsSnapshot> {
    return Promise.reject(new SectionUnavailableError("The router settings", null));
  }

  readAccessControl(): Promise<AccessControlSnapshot> {
    return Promise.reject(new SectionUnavailableError("Access control", null));
  }

  /** The family's own listing: everything the router stores, in one session, with the counts and what it can do besides. */
  async listSms(): Promise<SmsListing> {
    const sms = this.#session.sms;
    if (!sms) throw new SectionUnavailableError("SMS", null);
    const messages = await sms.list();
    const counters = await sms.counters(messages);
    // What the interface has, and of that what this router offers (a send that needs a helper it may lack)
    const send = sms.send !== undefined && (sms.canSend ? await sms.canSend().catch(() => true) : true);
    const readState = ROUTER_FAMILY_FACTS[this.family].smsReadState ?? "router";
    return { counters, messages, via: "driver", complete: true, readState, abilities: { send, delete: sms.delete ? (sms.deleteScope ?? "message") : "none", markRead: readState } };
  }

  /** The modes on offer are the router's own list where it names one, else the family's. */
  async readCellular(): Promise<CellularSettingsSnapshot | null> {
    if (!this.#session.cellular) return null;
    const state = await this.#session.cellular.read();
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
   * One send per recipient, each once. A recipient the router refuses, or says the message did not
   * reach, is a failed one; once a send was taken, an error ends the session's sends (the recipients
   * not reached yet are failed, not tried again) instead of failing what went out. The recipient
   * whose own message the router took before the error is unconfirmed, never failed: sending it again
   * would send it twice.
   */
  async sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, write: WriteContext): Promise<SmsSendOutcome> {
    const sms = this.#session.sms;
    if (!sms?.send) throw noWrite("send a message");
    let accepted = false;
    /** The router took the message of the recipient being sent to right now. */
    let acceptedThis = false;
    // The wait for the router's word ends with the session: cut short, the sends still to come find a transport that sends nothing
    const cut = this.#transport?.cut ?? null;
    const sleep = options.sleep ?? timerSleep;
    const sendOptions: DriverSmsSendOptions = {
      statusTimeoutMs: options.statusTimeoutMs ?? 45_000,
      sleep: (ms) => (cut ? raceSignal(sleep(ms), cut) : sleep(ms)),
      onAccepted: () => {
        accepted = true;
        acceptedThis = true;
        options.onAccepted?.();
      },
    };
    const outcomes: DriverSmsSendOutcome[] = [];
    for (const phone of prepared.phones) {
      acceptedThis = false;
      try {
        outcomes.push(await sms.send(phone, prepared.content, write.check, sendOptions));
      } catch (err) {
        // Nothing went out yet: the caller is told what the router said
        if (!accepted) throw err;
        // Something did: this recipient's own message, if the router took it, is on its way; the ones after it are not reached
        if (acceptedThis) outcomes.push({ state: "unconfirmed", code: null });
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
  }

  async markSmsRead(indices: ReadonlyArray<number>, write: WriteContext): Promise<number> {
    const wanted = storedIndices(indices);
    const sms = this.#session.sms;
    if (!sms?.markRead) throw noWrite("mark a message read");
    if (wanted.length > 0) await sms.markRead(wanted, write.check);
    return wanted.length;
  }

  async deleteSms(indices: ReadonlyArray<number>, write: WriteContext): Promise<number> {
    const wanted = storedIndices(indices);
    const sms = this.#session.sms;
    if (!sms?.delete) throw noWrite("delete a message");
    if (wanted.length > 0) await sms.delete(wanted, write.check);
    return wanted.length;
  }

  #cellular(what: string): DriverCellular {
    if (!this.#session.cellular) throw noWrite(what);
    return this.#session.cellular;
  }

  async setNetworkMode(mode: NetworkMode, write: WriteContext): Promise<LinkChangeOutcome<NetworkMode>> {
    const cellular = this.#cellular("switch the network mode");
    if (!cellular.setNetworkMode) throw noWrite("switch the network mode");
    const before = await cellular.read().catch((): DriverCellularState => ({}));
    // The modes this router names, else the family's: a mode outside them is not sent
    const offered = before.networkModes ?? ROUTER_FAMILY_FACTS[this.family].selectableModes ?? [];
    if (!offered.includes(mode)) throw new CpeControlValidationError(`This router offers no "${mode}" network mode (it offers ${offered.join(", ") || "none"})`);
    await cellular.setNetworkMode(mode, write.check, this.#wait);
    const previous = before.networkMode ?? null;
    return { previous: previous === mode ? null : previous };
  }

  async scanOperators(write: WriteContext): Promise<OperatorChoice[]> {
    const cellular = this.#cellular("search for networks");
    if (!cellular.scanOperators) throw noWrite("search for networks");
    return await cellular.scanOperators(write.check, this.#wait);
  }

  async selectOperator(selection: OperatorSelection, write: WriteContext): Promise<LinkChangeOutcome<OperatorSelection>> {
    const cellular = this.#cellular("choose the operator");
    if (!cellular.selectOperator) throw noWrite("choose the operator");
    const before = (await cellular.read().catch((): DriverCellularState => ({}))).operator ?? null;
    await cellular.selectOperator(selection, write.check, this.#wait);
    // What it is put back to is how the router chose before: by itself, or the operator it was kept on
    const previous: OperatorSelection | null = before?.selection === "auto" ? { mode: "auto" } : before?.selection === "manual" && before.plmn !== null ? { mode: "manual", plmn: before.plmn, rat: null } : null;
    return { previous: previous !== null && sameOperatorSelection(previous, selection) ? null : previous };
  }

  async setSimSlot(slot: SimSlotRef, write: WriteContext): Promise<LinkChangeOutcome<SimSlotRef>> {
    const cellular = this.#cellular("switch the SIM slot");
    if (!cellular.setSimSlot) throw noWrite("switch the SIM slot");
    const before = await cellular.read().catch((): DriverCellularState => ({}));
    if (before.simSlots && !before.simSlots.some((offered) => sameSimSlot(offered, slot))) throw new CpeControlValidationError("This router has no such SIM slot");
    await cellular.setSimSlot(slot, write.check);
    const previous = before.simSlot ?? null;
    return { previous: sameSimSlot(previous, slot) ? null : previous };
  }

  async setApn(choice: ApnChoice, write: WriteContext): Promise<LinkChangeOutcome<ApnRestore>> {
    const cellular = this.#cellular("change the access point");
    if (!cellular.setApn) throw noWrite("change the access point");
    const before = await cellular.read().catch((): DriverCellularState => ({}));
    await cellular.setApn(choice, write.check, this.#wait);
    // Only an access point the router can be switched back to is worth watching the WAN for
    return { previous: cellular.restoreApn ? (before.apnRestore ?? null) : null };
  }

  /**
   * Put a setting back after a change the WAN did not survive. The session reads first: a WAN that is
   * up, a radio switched off or mobile data switched off on purpose leaves everything as it is.
   */
  async revertLinkChange(change: LinkChange, write: WriteContext): Promise<WanRepairOutcome> {
    const cellular = this.#cellular("put the setting back");
    const telemetry = await this.#session.telemetry().catch(() => null);
    if (telemetry?.wan.connected === true) return { applied: false, skipped: "wan_up" };
    if (telemetry?.status?.airplaneMode === true) return { applied: false, skipped: "airplane_mode" };
    if ((await this.#session.data?.enabled().catch((): boolean | null => null)) === false) return { applied: false, skipped: "mobile_data_off" };
    if (change.kind === "sim_slot") {
      if (!cellular.setSimSlot) throw noWrite("switch the SIM slot");
      await cellular.setSimSlot(change.previous, write.check);
    } else if (change.kind === "network_mode") {
      if (!cellular.setNetworkMode) throw noWrite("switch the network mode");
      await cellular.setNetworkMode(change.previous, write.check, this.#wait);
    } else if (change.kind === "operator") {
      if (!cellular.selectOperator) throw noWrite("choose the operator");
      await cellular.selectOperator(change.previous, write.check, this.#wait);
    } else {
      if (!cellular.restoreApn) throw noWrite("switch the access point back");
      await cellular.restoreApn(change.previous, write.check, this.#wait);
    }
    return { applied: true };
  }

  /**
   * A PIN write. The attempts the card has left are read in this session, right before: none
   * reported, or one left, and nothing is sent. Whatever the router answers, nothing is sent twice.
   */
  async #pin(what: string, run: (cellular: DriverCellular) => Promise<SimPinOutcome>): Promise<SimPinOutcome> {
    const cellular = this.#cellular(what);
    const before = await cellular.read();
    const attempts = pinAttemptAllowed(before.pinAttemptsLeft);
    if (!attempts.allowed) throw new CpeControlValidationError(PIN_REFUSALS[attempts.reason]);
    return await run(cellular);
  }

  enterSimPin(pin: string, write: WriteContext): Promise<SimPinOutcome> {
    return this.#pin("enter the SIM PIN", async (cellular) => {
      if (!cellular.enterPin) throw noWrite("enter the SIM PIN");
      return await cellular.enterPin(pin, write.check, this.#wait);
    });
  }

  setSimPinLock(enabled: boolean, pin: string, write: WriteContext): Promise<SimPinOutcome> {
    return this.#pin("change the SIM PIN lock", async (cellular) => {
      if (!cellular.setPinLock) throw noWrite("change the SIM PIN lock");
      return await cellular.setPinLock(enabled, pin, write.check, this.#wait);
    });
  }

  async setAirplaneMode(enabled: boolean, write: WriteContext): Promise<{ airplaneMode: boolean }> {
    const cellular = this.#cellular("switch airplane mode");
    if (!cellular.setAirplaneMode) throw noWrite("switch airplane mode");
    await cellular.setAirplaneMode(enabled, write.check);
    return { airplaneMode: enabled };
  }

  async setRoaming(enabled: boolean, write: WriteContext): Promise<{ dataRoaming: boolean }> {
    const cellular = this.#cellular("switch data roaming");
    if (!cellular.setRoaming) throw noWrite("switch data roaming");
    await cellular.setRoaming(enabled, write.check);
    return { dataRoaming: enabled };
  }

  async setDataLimit(limit: DataLimitSetting, write: WriteContext): Promise<DataLimitSetting> {
    const cellular = this.#cellular("set the data limit");
    if (!cellular.setDataLimit) throw noWrite("set the data limit");
    await cellular.setDataLimit(limit, write.check);
    return limit;
  }

  async resetTraffic(write: WriteContext): Promise<void> {
    const cellular = this.#cellular("clear the traffic counters");
    if (!cellular.resetTraffic) throw noWrite("clear the traffic counters");
    await cellular.resetTraffic(write.check);
  }

  async sendUssd(request: UssdRequest, write: WriteContext): Promise<UssdAnswer> {
    const cellular = this.#cellular("send a USSD code");
    if (!cellular.ussd) throw noWrite("send a USSD code");
    return await cellular.ussd(request, write.check, this.#wait);
  }

  /**
   * A RAT the command leaves out keeps the bands the router reports before the write; the band setting
   * read before it (`savedBandSetting`) is what the lock is put back to if the WAN stays down.
   */
  async lockBands(command: BandLockCommand, _ctx: LockContext, write: WriteContext): Promise<BandLockOutcome> {
    const target = readDriverBandLockTarget(command, ROUTER_FAMILY_FACTS[this.family]);
    const before = await this.#session.lockState().catch((): DriverLockState | null => null);
    // The bands a command leaves out are the router's to keep: unread, they would be overwritten with a guess
    // (a list of none is no reading either: written back, it would leave the router no LTE band at all)
    const lteRead = before?.lteBands ?? null;
    if (target.lte === null && (lteRead === null || (Array.isArray(lteRead) && lteRead.length === 0))) {
      throw new CpeControlValidationError("The router's current LTE bands could not be read, and locking NR bands alone would overwrite them: name lteBands as well (or 'all')");
    }
    const lte = target.lte ?? before?.lteBands ?? "all";
    const saved = savedBandSetting(target, before);
    await this.#session.setBandLock({ lte, nr: target.nr, networkMode: target.networkMode }, write.check);
    return { state: driverBandLockState({ ...target, lte }, before), experimental: true, saved };
  }

  /**
   * Band, channel and PCI, read back in the session; without a PCI, the channel alone where the
   * family's notes define that lock; with `more`, several candidate cells at once where they define that.
   */
  async lockCell(command: CellLockCommand, write: WriteContext): Promise<LockOutcome> {
    if (command.more && command.more.length > 0) {
      const targets = readDriverCellLockTargets(command, ROUTER_FAMILY_FACTS[this.family]);
      if (!this.#session.setCellLocks) throw noWrite("lock several cells at once");
      await this.#session.setCellLocks(targets, write.check);
      const [first, ...rest] = targets;
      if (!first) throw noWrite("lock no cell");
      const state: PersistedLockState = {
        mode: "cell_lock",
        updatedAtIso: new Date().toISOString(),
        lteBands: first.rat === "LTE" ? [...new Set(targets.map((t) => t.band))] : "all",
        nrBands: first.rat === "NR" ? [...new Set(targets.map((t) => t.band))] : [],
        cellLock: { rat: first.rat, band: first.band, arfcn: first.arfcn, pci: first.pci, more: rest.map(({ band, arfcn, pci }) => ({ band, arfcn, pci })) },
      };
      return { state, experimental: true };
    }
    const target = readDriverCellLockTarget(command, ROUTER_FAMILY_FACTS[this.family]);
    const { pci, ...channel } = target;
    if (pci !== null) await this.#session.setCellLock({ ...channel, pci }, write.check);
    else if (this.#session.setFrequencyLock) await this.#session.setFrequencyLock(channel, write.check);
    else throw noWrite("lock a channel without a PCI");
    const state: PersistedLockState = {
      mode: "cell_lock",
      updatedAtIso: new Date().toISOString(),
      lteBands: target.rat === "LTE" ? [target.band] : "all",
      nrBands: target.rat === "NR" ? [target.band] : [],
      cellLock: { rat: target.rat, band: target.band, arfcn: target.arfcn, pci: target.pci },
    };
    return { state, experimental: true };
  }

  async unlockAll(write: WriteContext): Promise<PersistedLockState> {
    await this.#session.unlockAll(write.check);
    return genericLockState("all");
  }

  /** The WAN's state is the driver's own reading. */
  async rollBackLocks(request: RollbackRequest, write: WriteContext): Promise<{ outcome: WanRepairOutcome; restored: boolean }> {
    const saved = request.restore ? bandLockOfSaved(request.restore) : null;
    const restoring = saved !== null;
    if (request.currentLock().updatedAtIso !== request.lockUpdatedAtIso) return { outcome: { applied: false, skipped: "lock_changed" }, restored: restoring };
    const telemetry = await this.#session.telemetry().catch(() => null);
    if (telemetry?.wan.connected === true) return { outcome: { applied: false, skipped: "wan_up" }, restored: restoring };
    if (saved) {
      try {
        await this.#session.setBandLock(saved, write.check);
        // A part the lock left alone was left alone again: on record as the router reports it now, not as every band
        const after = saved.nr === null ? await this.#session.lockState().catch((): DriverLockState | null => null) : null;
        return { outcome: { applied: true, lockState: driverBandLockState(saved, after) }, restored: true };
      } catch (err) {
        // A setting this router's own forms cannot write back, refused before it is sent: the documented way back instead
        if (!(err instanceof CpeControlValidationError)) throw err;
      }
    }
    await this.#session.unlockAll(write.check);
    return { outcome: { applied: true, lockState: genericLockState("all") }, restored: false };
  }

  /** A redial: the router's own command, else off and on again (connected again at the end in any case). */
  async reconnect(write: WriteContext): Promise<{ reconnecting: true; requestedAtIso: string }> {
    await redial(this.#session, write.check, this.#wait, this.#transport);
    return { reconnecting: true as const, requestedAtIso: new Date().toISOString() };
  }

  /**
   * Self-healing's redial: the WAN as the driver reads it in the session (up: nothing to do), then the
   * data switch where the router has one to read (off: someone switched it off on purpose). A session
   * that cannot read the WAN fails the repair rather than redial blind.
   */
  async autoReconnect(write: WriteContext): Promise<WanRepairOutcome> {
    if ((await this.#session.telemetry()).wan.connected === true) return { applied: false, skipped: "wan_up" };
    if ((await this.#session.data?.enabled().catch((): boolean | null => null)) === false) return { applied: false, skipped: "mobile_data_off" };
    await redial(this.#session, write.check, this.#wait, this.#transport);
    return { applied: true };
  }

  async setMobileData(enabled: boolean, write: WriteContext): Promise<{ mobileDataEnabled: boolean }> {
    if (!this.#session.data) throw noWrite("switch mobile data");
    await this.#session.data.set(enabled, write.check, this.#wait);
    return { mobileDataEnabled: enabled };
  }

  async setAntennaMode(mode: AntennaModeName, write: WriteContext): Promise<{ mode: AntennaModeName; rawCode: number }> {
    if (!this.#session.setAntennaMode) throw noWrite("switch the antenna");
    return { mode, rawCode: await this.#session.setAntennaMode(mode, write.check) };
  }

  async reboot(_params: { confirm: boolean }, write: WriteContext): Promise<{ rebooting: true; requestedAtIso: string }> {
    await this.#session.reboot(write.check);
    return { rebooting: true as const, requestedAtIso: new Date().toISOString() };
  }

  // No driver implements these: the gate refuses them before any session (should one get here, nothing is sent)

  setSecuritySwitches(): Promise<void> {
    return Promise.reject(noWrite("change the router's security switches"));
  }

  setWifi7(): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    return Promise.reject(noWrite("change the Wi-Fi 7 settings"));
  }

  setWifiAccess(): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
    return Promise.reject(noWrite("change the Wi-Fi MAC filter"));
  }

  manageTimeRule(): Promise<TimeRulesState> {
    return Promise.reject(noWrite("change an internet time rule"));
  }
}

/** A driver family, before any session: its facts in `ROUTER_FAMILY_FACTS` say what it reads and writes. */
export function driverFamilyDriver(family: DriverFamily): RouterDriver {
  const facts = ROUTER_FAMILY_FACTS[family];
  return {
    family,
    hasVerifiedModel: false,
    writes: (feature: WriteFeature) => familyWritesAnywhere(family, feature),
    reads(section: SessionlessRead, _device: DeviceAccess): boolean {
      if (section === "settings" || section === "accessControl" || section === "endpoints") return false;
      // A family whose notes define no device list, SMS interface or cellular setting gets no request for it
      if (section === "topology") return facts.reads.includes("topology");
      if (section === "sms") return facts.reads.includes("smsRead");
      return CELLULAR_WRITE_FEATURES.some((feature) => familyWritesAnywhere(family, feature));
    },
    keepsSmsReadState: facts.smsReadState === "fengsui",
    // Numbers, NR only where the family locks NR, a mode the family offers; checked again in the session
    checkBandLock(command: BandLockCommand) {
      readDriverBandLockTarget(command, facts);
    },
    checkCellLock(command: CellLockCommand) {
      if (command.more && command.more.length > 0) readDriverCellLockTargets(command, facts);
      else readDriverCellLockTarget(command, facts);
    },
  };
}

/** A write this router's form of the family's interface has no way to do (the gate's last line). */
function noWrite(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface gives FengSui no way to ${what}; nothing was sent to it`);
}

/** A wait on a timer alone (a session no client opened: nothing cuts it short). */
const timerSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A request sent once however often it is asked for; in a session a client opened, one the session owes the router. */
function owedOnce(transport: LanHttp | null, send: () => Promise<void>): () => Promise<void> {
  if (transport) return transport.owe(send);
  let sent: Promise<void> | null = null;
  return () => (sent ??= send());
}

/**
 * Redial with the router's own command, or switch data off and on again. The connect is sent in any
 * case, also when the disconnect failed, and also when the session is cut short between the two (its
 * deadline, a stop): then the session's end sends it before the logout (`LanHttp.owe`). A redial never
 * leaves the router disconnected on purpose. Each command goes out once; the polls that follow tell
 * whether a new connection came up.
 */
async function redial(session: DriverSession, check: WriteCheck, wait: DriverWait, transport: LanHttp | null): Promise<void> {
  const data = session.data;
  if (!data) throw noWrite("redial");
  if (data.redial) {
    await data.redial(check);
  } else {
    // Owed before the disconnect goes out: if the session is cut short in between, its end sends the connect
    const connect = owedOnce(transport, () => data.set(true, check, wait));
    try {
      await data.set(false, check, wait);
    } finally {
      await connect();
    }
  }
  settleRestart(check);
}

/**
 * What the rollback writes back after a band lock: the LTE bands read before it, and the NR bands and
 * the network mode where the lock changes them. `null` (every lock is taken off instead) when the LTE
 * bands were on every band or unread, or when a part the lock changes could not be read before it:
 * writing back half of the setting would leave the other half as the lock set it.
 */
function savedBandSetting(target: DriverBandLockRequest, before: DriverLockState | null): SavedBandSetting | null {
  if (!before || !Array.isArray(before.lteBands) || before.lteBands.length === 0) return null;
  const saved: SavedBandSetting = { lteMask: bandsToHex(before.lteBands) };
  if (target.nr !== null) {
    const nr = before.nrBands;
    if (nr === null || (Array.isArray(nr) && nr.length === 0)) return null;
    saved.nrMask = nr === "all" ? "all" : bandsToHex(nr);
  }
  if (target.networkMode !== null) {
    if (before.networkMode === null) return null;
    saved.networkMode = before.networkMode;
  }
  return saved;
}

/** A saved band setting as the lock that writes it back; `null` when a part of it reads as no bands (then every lock is taken off). */
function bandLockOfSaved(saved: SavedBandSetting): DriverBandLockTarget | null {
  const lte = hexToBands(saved.lteMask);
  if (lte === null || lte.length === 0) return null;
  let nr: number[] | "all" | null = null;
  if (saved.nrMask !== undefined) {
    nr = saved.nrMask === "all" ? "all" : hexToBands(saved.nrMask);
    if (nr === null || nr.length === 0) return null;
  }
  return { lte, nr, networkMode: saved.networkMode ?? null };
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
