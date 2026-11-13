import type { AccessControlSnapshot, AccessRequestContext, TimeRulesState } from "../../access-control.ts";
import type { TimeRuleChange, WifiAccessChange, WifiFilterPlan, WifiMacFilterState } from "../../access-plan.ts";
import type { ApnRestore, CellularSettingsSnapshot, DataLimitSetting, LinkChange, NetworkMode, OperatorChoice, OperatorSelection, SimPinOutcome, SimSlotRef, UssdAnswer, UssdRequest } from "../../cellular.ts";
import { assertOneCell, validateGenericBandLock } from "../../control-input.ts";
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
} from "../../cpe-domain.ts";
import { type DeviceAccess, type WriteFeature, gateRefuses } from "../../device-access.ts";
import { type DeviceProbeResult, type ProbeOrigin, probeDevice } from "../../device-profile.ts";
import type { EphemeralCpeSession } from "../../protocols/hilink/client.ts";
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
} from "../../protocols/hilink/generic-writes.ts";
import { getXmlTag } from "../../protocols/hilink/xml.ts";
import type { BandLockOutcome, LinkChangeOutcome, LockContext, LockOutcome, RollbackRequest, SmsListRequest, SmsListing, SmsSendOutcome, SmsUnreadPeek, WanRepairOutcome } from "../../router-backend.ts";
import { CELLULAR_WRITE_FEATURES } from "../../router-family.ts";
import type { RouterDriver, RouterSession, RouterSessionContext, SessionlessRead, TestedIdentity } from "../../router-session.ts";
import type { MutexSessionScheduler, WriteContext } from "../../scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "../../sms/submission.ts";
import { validateGenericSmsContent } from "../../sms/text-mode.ts";
import type { SmsWireMessage } from "../../sms/types.ts";
import { applyTimeRuleChange, applyWifiAccessChange, fetchAccessControl } from "./access-control.ts";
import type { NetModeKeep } from "./band-lock.ts";
import {
  applyBandLock,
  applyCellLock,
  fetchGlobalTelemetry,
  fetchRouterSettings,
  fetchTerminalTopology,
  mergeBandLockState,
  netModeKeepOf,
  prepareBandLockPayloads,
  prepareCellLockPayload,
  readRouterModel,
  readWanRepairBlocker,
  rebootCpe,
  scanNeighborCells,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
} from "./requests.ts";
import { checkSmsNotifications, deleteSmsByIndex, fetchAllMessages, fetchPhoneThread, fetchRecentMessages, genericDeleteSms, genericMarkSmsRead, genericSendSms, markSmsRead, submitSms } from "./sms.ts";

/**
 * Huawei HiLink as a brand driver: the H168-383's verified request sequences, and on another HiLink
 * model the tolerant reads and the generic writes the gate has open (`write.generic`, appendix A.11
 * and A.12 of the protocol notes). The session is `EphemeralCpeSession`
 * (`src/protocols/hilink/client.ts`). The requests themselves are beside this file: the H168-383's
 * verified sequences in `requests.ts`, `access-control.ts` and `sms.ts` (its lock payloads in
 * `band-lock.ts`); the generic ones are the protocol's, `src/protocols/hilink/generic-writes.ts`.
 *
 * The cellular settings came after the H168-383 was verified: a model nobody verified gets the ones
 * whose requests the notes give (network mode, operator, data roaming, traffic counters, USSD), and the
 * H168-383 the ones checked on it in person and filed in `VERIFIED_FEATURES` (the gate keeps the rest
 * `not_implemented` there). Both send the same requests (`generic-writes.ts`), which go by what the
 * router reports (a 5G router's two-field network mode). None of the H168-383's own requests changed;
 * its band lock writes the mode the latest poll saw along, byte for byte the verified request in the
 * default one (`NetModeKeep`).
 */
export class HilinkRouterSession implements RouterSession {
  readonly family = "huawei" as const;
  readonly #session: EphemeralCpeSession;
  readonly #ctx: RouterSessionContext;

  constructor(session: EphemeralCpeSession, ctx: RouterSessionContext) {
    this.#session = session;
    this.#ctx = ctx;
  }

  /** The HiLink session itself (its GETs serve an agent's read-only endpoint discovery). */
  get hilink(): EphemeralCpeSession {
    return this.#session;
  }

  get discovery(): EphemeralCpeSession {
    return this.#session;
  }

  async readModel(): Promise<{ model: string; softwareVersion: string | null; variant: string | null } | null> {
    const reported = await readRouterModel(this.#session);
    return reported ? { ...reported, variant: null } : null;
  }

  identify(origin: ProbeOrigin): Promise<DeviceProbeResult> {
    return probeDevice(this.#session, { nowIso: new Date().toISOString(), origin });
  }

  async testIdentity(): Promise<{ identified: TestedIdentity; probe: DeviceProbeResult }> {
    const xml = await this.#session.get("/api/device/information");
    const identified: TestedIdentity = {
      model: getXmlTag(xml, "DeviceName") ?? null,
      firmware: getXmlTag(xml, "SoftwareVersion") ?? null,
      loginScheme: this.#session.loginScheme ?? "unknown",
      tokenFlow: this.#session.tokenFlow ?? "unknown",
      ecc: this.#session.eccVerified,
    };
    return { identified, probe: await this.identify("connection-test") };
  }

  readTelemetry(opts: { smsCounters: boolean }): Promise<GlobalTelemetrySnapshot> {
    return fetchGlobalTelemetry(this.#session, {
      includeSmsCounters: opts.smsCounters,
      tolerant: this.#ctx.device.unverifiedModel,
      // A poll that fails on a router replaced by another model still tells it apart
      onFailedPollModel: (model, softwareVersion) => this.#ctx.noteRouterModel(model, softwareVersion),
    });
  }

  /** `GET /api/device/nbrcellinfo`. */
  readNeighbors(): Promise<NeighborScanSnapshot> {
    return scanNeighborCells(this.#session);
  }

  /** `HostInfo` + `topology`. */
  readTopology(): Promise<TerminalTopologySnapshot> {
    return fetchTerminalTopology(this.#session, { tolerant: this.#ctx.device.unverifiedModel });
  }

  readSettings(): Promise<RouterSettingsSnapshot> {
    return fetchRouterSettings(this.#session);
  }

  /** The Wi-Fi MAC filter and the internet time rules (3 GETs). */
  readAccessControl(): Promise<AccessControlSnapshot> {
    return fetchAccessControl(this.#session);
  }

  /**
   * Plain `sms-list`, or the encrypted per-contact listing where the router refuses it; a model
   * nobody verified that has neither reads as having no SMS.
   */
  async listSms(request: SmsListRequest): Promise<SmsListing> {
    const fetched = request.mode === "full" ? await fetchAllMessages(this.#session) : await fetchRecentMessages(this.#session, { count: request.recentCount, expandThread: request.expandThread });
    return { ...fetched, complete: request.mode === "full", readState: "router", abilities: { send: true, delete: "message", markRead: "router" } };
  }

  /** Read on a model nobody verified only (`huaweiDriver.reads("cellular")`): the H168-383 is asked nothing. */
  async readCellular(): Promise<CellularSettingsSnapshot> {
    const read = await genericCellularRead(this.#session);
    const nowMs = Date.now();
    return { capturedAtIso: new Date(nowMs).toISOString(), capturedAtMs: nowMs, ...read };
  }

  async sendSms(prepared: PreparedSmsSubmission, options: SubmitSmsOptions, write: WriteContext): Promise<SmsSendOutcome> {
    const back = new Map<string, SmsWireMessage[]>();
    // A model nobody verified: plaintext send-sms and send-status; the encrypted thread read-back is the H168-383's
    if (write.generic) return { result: await genericSendSms(this.#session, write.check, prepared, options), readBack: back, routerKeepsSent: true };
    const result = await submitSms(this.#session, prepared, options);
    if (result.ok) {
      for (const phone of prepared.phones) back.set(phone, await fetchPhoneThread(this.#session, phone, 10).catch(() => []));
    }
    return { result, readBack: back, routerKeepsSent: true };
  }

  markSmsRead(indices: ReadonlyArray<number>, write: WriteContext): Promise<number> {
    return write.generic ? genericMarkSmsRead(this.#session, write.check, indices) : markSmsRead(this.#session, indices);
  }

  deleteSms(indices: ReadonlyArray<number>, write: WriteContext): Promise<number> {
    return write.generic ? genericDeleteSms(this.#session, write.check, indices) : deleteSmsByIndex(this.#session, indices);
  }

  async lockBands(command: BandLockCommand, ctx: LockContext, write: WriteContext): Promise<BandLockOutcome> {
    // A model nobody verified: LTE only, through net-mode, never the H168-383's lock-freq
    if (write.generic) {
      const locked = await genericBandLock(this.#session, write.check, validateGenericBandLock(command, write.lteBands), write.lteBands ?? []);
      return { state: genericLockState(locked.bands), experimental: true, savedLteMask: locked.before };
    }
    // Read inside the queued session: a lock queued before this one may have just changed it
    const previous = ctx.previousLock();
    const telemetry = ctx.cachedTelemetry();
    const routerLteBands = telemetry?.bandConfig.lteBandHex ? telemetry.bandConfig.activeLteBands : null;
    const keep = netModeKeepOf(telemetry?.bandConfig);
    // 4G only: a 5G band lock would do nothing (the router's own page leaves the 5G part out then)
    if (keep.networkMode === "03" && Array.isArray(command.nrBands)) {
      throw new CpeControlValidationError("The router is set to a 4G-only network mode: a 5G band lock would do nothing. Switch the network mode back first; nothing was written");
    }
    return { state: mergeBandLockState(previous, command, await applyBandLock(this.#session, command, keep), routerLteBands), experimental: false, savedLteMask: null };
  }

  /** The verified model's alone: no generic cell lock exists, so this one is never an experimental write. */
  async lockCell(command: CellLockCommand, write: WriteContext): Promise<LockOutcome> {
    assertOneCell(command);
    verifiedOnly(write, "lock_cell");
    return { state: await applyCellLock(this.#session, command), experimental: false };
  }

  async unlockAll(write: WriteContext): Promise<PersistedLockState> {
    return write.generic ? genericLockState((await genericBandLock(this.#session, write.check, "all", write.lteBands ?? [])).bands) : await unlockAllRfLocks(this.#session, this.#modeKeep());
  }

  async rollBackLocks(request: RollbackRequest, write: WriteContext): Promise<{ outcome: WanRepairOutcome; restored: boolean }> {
    // A lock queued before this rollback may have just replaced the one it was meant for
    if (request.currentLock().updatedAtIso !== request.lockUpdatedAtIso) return { outcome: { applied: false, skipped: "lock_changed" }, restored: false };
    const { restore } = request;
    if (write.generic) {
      const skipped = await readWanRepairBlockerTolerant(this.#session);
      if (skipped) return { outcome: { applied: false, skipped }, restored: false };
      const locked = await genericBandLock(this.#session, write.check, restore ? { savedMask: restore.lteMask } : "all", write.lteBands ?? []);
      return { outcome: { applied: true, lockState: genericLockState(locked.bands) }, restored: restore !== undefined };
    }
    const skipped = await readWanRepairBlocker(this.#session);
    return { outcome: skipped ? { applied: false, skipped } : { applied: true, lockState: await unlockAllRfLocks(this.#session, this.#modeKeep()) }, restored: false };
  }

  /** The network mode the latest poll saw, for the H168-383's band lock to write along. */
  #modeKeep(): NetModeKeep {
    return netModeKeepOf(this.#ctx.latestTelemetry()?.bandConfig);
  }

  async reboot(params: { confirm: boolean }, write: WriteContext): Promise<{ rebooting: true; requestedAtIso: string }> {
    if (!write.generic) return await rebootCpe(this.#session, params);
    await genericReboot(this.#session, write.check);
    return { rebooting: true as const, requestedAtIso: new Date().toISOString() };
  }

  async reconnect(write: WriteContext): Promise<{ reconnecting: true; requestedAtIso: string }> {
    if (!write.generic) return await triggerCellularReconnect(this.#session);
    await genericReconnect(this.#session, write.check);
    return { reconnecting: true as const, requestedAtIso: new Date().toISOString() };
  }

  /** `monitoring/status` and the mobile data switch decide; a model nobody verified may lack the switch. */
  async autoReconnect(write: WriteContext): Promise<WanRepairOutcome> {
    const skipped = write.generic ? await readWanRepairBlockerTolerant(this.#session) : await readWanRepairBlocker(this.#session);
    if (skipped) return { applied: false, skipped };
    if (write.generic) await genericReconnect(this.#session, write.check);
    else await triggerCellularReconnect(this.#session);
    return { applied: true };
  }

  async setMobileData(enabled: boolean, write: WriteContext): Promise<{ mobileDataEnabled: boolean }> {
    return write.generic ? { mobileDataEnabled: await genericMobileData(this.#session, write.check, enabled) } : await updateMobileDataSwitch(this.#session, enabled);
  }

  async setSecuritySwitches(command: SecurityUpdateCommand, write: WriteContext): Promise<void> {
    verifiedOnly(write, "set_security_switches");
    await updateSecuritySettings(this.#session, command);
  }

  setWifi7(input: { mloEnable?: boolean; dbhoEnable?: boolean }, write: WriteContext): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    verifiedOnly(write, "set_wifi7_mlo");
    return updateWifi7Mlo(this.#session, input);
  }

  setAntennaMode(mode: AntennaModeName, write: WriteContext): Promise<{ mode: AntennaModeName; rawCode: number }> {
    verifiedOnly(write, "set_antenna_mode");
    return updateAntennaMode(this.#session, mode);
  }

  setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext, write: WriteContext): Promise<{ wifiMacFilter: WifiMacFilterState; plan: WifiFilterPlan }> {
    verifiedOnly(write, "set_wifi_access");
    return applyWifiAccessChange(this.#session, change, ctx);
  }

  manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext, write: WriteContext): Promise<TimeRulesState> {
    verifiedOnly(write, "manage_time_rule");
    return applyTimeRuleChange(this.#session, change, ctx);
  }

  // The cellular settings: on a model nobody verified, and on the H168-383 where VERIFIED_FEATURES opened them (the gate decides)

  async setNetworkMode(mode: NetworkMode, write: WriteContext): Promise<LinkChangeOutcome<NetworkMode>> {
    const previous = await genericNetworkMode(this.#session, write.check, mode);
    return { previous: previous === mode ? null : previous };
  }

  scanOperators(write: WriteContext): Promise<OperatorChoice[]> {
    return genericScanOperators(this.#session, write.check);
  }

  async selectOperator(selection: OperatorSelection, write: WriteContext): Promise<LinkChangeOutcome<OperatorSelection>> {
    return { previous: await genericSelectOperator(this.#session, write.check, selection) };
  }

  /** The way back from a mode or operator change the WAN did not survive (the only two HiLink has of the four). */
  async revertLinkChange(change: LinkChange, write: WriteContext): Promise<WanRepairOutcome> {
    if (change.kind === "sim_slot" || change.kind === "apn") throw unbuilt(change.kind === "sim_slot" ? "auto_restore_sim_slot" : "auto_restore_apn");
    const skipped = write.generic ? await readWanRepairBlockerTolerant(this.#session) : await readWanRepairBlocker(this.#session);
    if (skipped) return { applied: false, skipped };
    if (change.kind === "network_mode") await genericNetworkMode(this.#session, write.check, change.previous);
    else await genericSelectOperator(this.#session, write.check, change.previous);
    return { applied: true };
  }

  async setRoaming(enabled: boolean, write: WriteContext): Promise<{ dataRoaming: boolean }> {
    await genericRoaming(this.#session, write.check, enabled);
    return { dataRoaming: enabled };
  }

  async resetTraffic(write: WriteContext): Promise<void> {
    await genericTrafficReset(this.#session, write.check);
  }

  sendUssd(request: UssdRequest, write: WriteContext): Promise<UssdAnswer> {
    genericOnly(write, "send_ussd");
    return genericUssd(this.#session, write.check, request, (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  // The gate refuses these before any session (no HiLink implementation): should one get here, nothing is sent

  setSimSlot(): Promise<LinkChangeOutcome<SimSlotRef>> {
    return Promise.reject(unbuilt("set_sim_slot"));
  }

  setApn(): Promise<LinkChangeOutcome<ApnRestore>> {
    return Promise.reject(unbuilt("set_apn"));
  }

  enterSimPin(): Promise<SimPinOutcome> {
    return Promise.reject(unbuilt("enter_sim_pin"));
  }

  setSimPinLock(): Promise<SimPinOutcome> {
    return Promise.reject(unbuilt("set_sim_pin_lock"));
  }

  setAirplaneMode(): Promise<{ airplaneMode: boolean }> {
    return Promise.reject(unbuilt("set_airplane_mode"));
  }

  setDataLimit(): Promise<DataLimitSetting> {
    return Promise.reject(unbuilt("set_data_limit"));
  }
}

/** The HiLink session inside a session of a HiLink connection (tests and the HiLink tools reach its requests this way). */
export function hilinkSessionOf(session: RouterSession): EphemeralCpeSession {
  if (!(session instanceof HilinkRouterSession)) throw new TypeError(`a ${session.family} session is not a HiLink session`);
  return session.hilink;
}

/** The HiLink writes FengSui has no request for on any Huawei model (the gate keeps them `not_implemented`). */
const HILINK_UNBUILT: ReadonlySet<WriteFeature> = new Set<WriteFeature>(["simSlot", "apn", "simPin", "airplaneSwitch", "dataLimit"]);

/** Huawei HiLink, before any session. */
export const huaweiDriver: RouterDriver = {
  family: "huawei",
  hasVerifiedModel: true,
  writes: (feature) => !HILINK_UNBUILT.has(feature),
  reads(section: SessionlessRead, device: DeviceAccess): boolean {
    // The cellular settings are read only where one of them is open (on the H168-383: one filed in VERIFIED_FEATURES)
    if (section === "cellular") return CELLULAR_WRITE_FEATURES.some((feature) => !gateRefuses(device.writeAccess(feature)));
    return true;
  },
  keepsSmsReadState: false,
  checkBandLock(command, device) {
    // Checked against the router the gate goes by (a write it refuses says so first), and again in the session
    if (!device.generic) prepareBandLockPayloads(command);
    else if (!gateRefuses(device.writeAccess("bandLock"))) validateGenericBandLock(command, device.experimentalLteBands);
  },
  checkCellLock(command) {
    assertOneCell(command);
    prepareCellLockPayload(command);
  },
  checkSms(prepared, device) {
    // A model nobody verified sends the plaintext way, which takes no emoji (a send the gate refuses says so first)
    if (device.generic && !gateRefuses(device.writeAccess("smsWrite"))) validateGenericSmsContent(prepared.content);
  },
  checkAntennaMode(mode) {
    // The H168-383 was verified with three antenna modes; a fourth is never sent to it
    if (mode === "hybrid") throw new CpeControlValidationError('This router\'s antenna has no "hybrid" mode: choose auto, internal or external');
  },
  /** `GET /api/monitoring/check-notifications`, which the router answers without a login. */
  peekSmsUnread(scheduler: Pick<MutexSessionScheduler, "probePublic">): Promise<SmsUnreadPeek> {
    return checkSmsNotifications(scheduler);
  },
};

/**
 * A write with no generic implementation never runs on a model nobody verified (the gate keeps it
 * `not_implemented`); should it get here anyway, it stops before sending the H168-383's request.
 */
export function verifiedOnly(write: WriteContext, action: string): void {
  if (write.generic) throw new CpeControlValidationError(`${action} has no implementation for a model FengSui was not verified on; nothing was written`);
}

/** A generic write nobody checked on the verified model (USSD): never there (the gate refuses it before any session). */
function genericOnly(write: WriteContext, action: string): void {
  if (!write.generic) throw unbuilt(action);
}

function unbuilt(action: string): CpeControlValidationError {
  return new CpeControlValidationError(`${action} has no implementation for this router; nothing was written`);
}

/** The lock state after a generic band lock, or after every lock was taken off: LTE only (no NR band or cell lock on such a model). */
export function genericLockState(lteBands: number[] | "all"): PersistedLockState {
  return { mode: lteBands === "all" ? "unlocked" : "band_lock", updatedAtIso: new Date().toISOString(), lteBands, nrBands: [], cellLock: null };
}
