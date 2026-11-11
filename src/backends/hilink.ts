import { type AccessControlSnapshot, fetchAccessControl } from "../access-control.ts";
import { validateGenericBandLock } from "../control-input.ts";
import {
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type GlobalTelemetrySnapshot,
  type NeighborScanSnapshot,
  type PersistedLockState,
  type RouterSettingsSnapshot,
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
  unlockAllRfLocks,
} from "../cpe-domain.ts";
import { gateRefuses } from "../device-access.ts";
import { type DeviceProbeResult, probeDevice } from "../device-profile.ts";
import { genericBandLock, genericReboot, readWanRepairBlockerTolerant } from "../generic-writes.ts";
import type {
  BandLockOutcome,
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
    return fetched ? { ...fetched, complete: request.mode === "full", readState: "router", abilities: { send: true, delete: "message" } } : null;
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
