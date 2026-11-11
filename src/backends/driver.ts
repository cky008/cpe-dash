import type { AccessControlSnapshot } from "../access-control.ts";
import { type DriverBandLockRequest, readDriverBandLockTarget, readDriverCellLockTarget } from "../control-input.ts";
import {
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
import { settleSmsSend, storedIndices } from "../drivers/sms.ts";
import type { DriverLockState, DriverSession, DriverSmsSendOptions, DriverSmsSendOutcome } from "../drivers/types.ts";
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
import { type DriverFamily, ROUTER_FAMILY_FACTS } from "../router-family.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority } from "../scheduler.ts";
import type { PreparedSmsSubmission, SubmitSmsOptions } from "../sms/protocol.ts";
import type { SmsSendResult } from "../sms/types.ts";
import { genericLockState } from "./hilink.ts";

/**
 * A router of a driver family (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt) as a `RouterBackend`:
 * each verb is one session of the family's driver (`src/drivers/`) through the scheduler's queue,
 * avoidance, breaker and write gate. Its writes are experimental on every model (on by default, each
 * can be turned off, read back in the same session). What no driver implements yet (connected devices, router
 * settings, access control) has nothing to read here; the gate refuses the writes that go with it. SMS
 * goes to the SMS methods of the family's session, where its interface has them.
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

  readTopology(): Promise<TerminalTopologySnapshot | null> {
    return Promise.resolve(null);
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

  /** Band, channel and PCI, read back in the session. */
  async lockCell(command: CellLockCommand, summary: LockSummary): Promise<LockOutcome> {
    const target = readDriverCellLockTarget(command);
    const state = await this.#scheduler.executeDriverControl(
      "lock_cell",
      async (session, write): Promise<PersistedLockState> => {
        await session.setCellLock(target, write.check);
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

/** A write the family's interface has no way to do (the gate let SMS writes through for the ones it has). */
function noSmsWrite(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface gives FengSui no way to ${what}; nothing was sent to it`);
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
