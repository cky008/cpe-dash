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
import type { DeviceProbeResult } from "../device-profile.ts";
import { bandsToHex, hexToBands } from "../drivers/bands.ts";
import type { DriverLockState, DriverSession } from "../drivers/types.ts";
import type { BandLockOutcome, LockContext, LockOutcome, LockSummary, ReadRequest, RollbackRequest, RouterBackend, WanRepairOutcome } from "../router-backend.ts";
import { type DriverFamily, ROUTER_FAMILY_FACTS } from "../router-family.ts";
import type { ControlSummary, MutexSessionScheduler, SchedulerPriority } from "../scheduler.ts";
import { genericLockState } from "./hilink.ts";

/**
 * A router of a driver family (ZTE, Pinsu, Tozed, FiberHome, NRadio, OpenWrt) as a `RouterBackend`:
 * each verb is one session of the family's driver (`src/drivers/`) through the scheduler's queue,
 * avoidance, breaker and write gate. Its writes are experimental on every model (turned on per
 * feature, read back in the same session). What no driver implements yet (connected devices, router
 * settings, access control) has nothing to read here; the gate refuses the writes that go with it.
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

  readTelemetry(opts: ReadRequest): Promise<GlobalTelemetrySnapshot | null> {
    return this.#scheduler.executeDriverTelemetryRead({ priority: "normal", ignoreCooldown: opts.ignoreCooldown });
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
