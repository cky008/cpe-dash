import {
  type AccessControlSnapshot,
  type AccessRequestContext,
  applyTimeRuleChange,
  applyWifiAccessChange,
} from "./access-control.ts";
import type { TimeRuleChange, WifiAccessChange } from "./access-plan.ts";
import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type LockVerification,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type SecurityUpdateCommand,
  type WanRepairSkipReason,
  applyBandLock,
  applyCellLock,
  mergeBandLockState,
  prepareBandLockPayloads,
  prepareCellLockPayload,
  readWanRepairBlocker,
  rebootCpe,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
  validateSecurityUpdateCommand,
  verifyLockState,
} from "./cpe-domain.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import {
  genericBandLock,
  genericMobileData,
  genericReboot,
  genericReconnect,
  readWanRepairBlockerTolerant,
  validateGenericBandLock,
} from "./generic-writes.ts";
import { type I18nKey, t } from "./i18n.ts";
import { maskMacTail } from "./privacy-mask.ts";
import type { ControlSummary, MutexSessionScheduler, WriteContext } from "./scheduler.ts";
import type { EncryptedStateStore } from "./state-store.ts";

export interface AccessControlResult {
  /** The router's state after the change (`null` only if it could not be read back). */
  accessControl: AccessControlSnapshot | null;
  /** `false` when the router already was in the requested state and nothing was written. */
  changed: boolean;
  /** MACs of other devices this change cut off (stored blacklist entries, devices left off a whitelist). */
  alsoBlocked: string[];
}

/**
 * Result of an automatic WAN repair: written, or skipped for the reason read inside the session
 * (`lock_changed`: the lock to roll back was replaced while the rollback waited in the queue).
 */
export type WanRepairOutcome =
  | { applied: true; lockState?: PersistedLockState }
  | { applied: false; skipped: WanRepairSkipReason | "lock_changed" };

export interface CpeControlServiceOptions {
  scheduler: MutexSessionScheduler;
  monitor: CpeMonitor;
  stateStore: EncryptedStateStore;
}

/**
 * Write side of FengSui: RF locks, reboot/reconnect, router switches and device access control
 * (Wi-Fi MAC filter, internet time rules). Every command is validated
 * before it is queued (no session for bad input), runs as one `executeControl` session (never
 * replayed, refused with `409` while a human is logged in), and updates the persisted lock state or
 * the cached settings snapshot afterwards.
 */
export class CpeControlService {
  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly stateStore: EncryptedStateStore;

  constructor(options: CpeControlServiceOptions) {
    this.scheduler = options.scheduler;
    this.monitor = options.monitor;
    this.stateStore = options.stateStore;
  }

  /**
   * FengSui's most recently applied RF lock configuration. The H168-383 cannot read
   * `GET /api/net/lock-freq` back (`100003`), so this is a local record, not router truth.
   */
  getPersistedLockState(): PersistedLockState {
    return this.stateStore.getState().lockState;
  }

  /** Reconcile the persisted lock state with the latest cached telemetry (see `verifyLockState`). */
  getLockVerification(): LockVerification {
    // A model nobody verified unlocks to the bands it advertises, not the H168-383's
    const device = this.scheduler.device;
    const bands = device.generic ? (device.experimentalLteBands ?? []) : undefined;
    return verifyLockState(this.getPersistedLockState(), this.monitor.getCachedTelemetry(), bands);
  }

  async lockBands(command: BandLockCommand): Promise<PersistedLockState> {
    // Checked before queueing against the router the gate goes by (a write it refuses says so first),
    // and again in the session
    const device = this.scheduler.device;
    if (!device.generic) prepareBandLockPayloads(command);
    else if (device.writeAccess("bandLock") !== "read_only") validateGenericBandLock(command, device.experimentalLteBands);
    return await this.scheduler.executeControl(
      "lock_band",
      async (session, write) => {
        // A model nobody verified: LTE only, through net-mode, never the H168-383's lock-freq
        if (write.generic) return genericLockState(await genericBandLock(session, write.check, validateGenericBandLock(command, write.lteBands), write.lteBands ?? []));
        // Read inside the queued session: a lock queued before this one may have just changed it
        const previous = this.getPersistedLockState();
        const telemetry = this.monitor.getCachedTelemetry();
        const routerLteBands = telemetry?.bandConfig.lteBandHex ? telemetry.bandConfig.activeLteBands : null;
        return mergeBandLockState(previous, command, await applyBandLock(session, command), routerLteBands);
      },
      (state) => {
        const summaryText = `LTE=${JSON.stringify(state.lteBands)}, NR=${JSON.stringify(state.nrBands)}`;
        return this.#commitLockState(state, {
          zh: t("zh-CN", "controls.band_lock_applied", { summary: summaryText }),
          en: t("en", "controls.band_lock_applied", { summary: summaryText }),
        });
      }
    );
  }

  async lockCell(command: CellLockCommand): Promise<PersistedLockState> {
    prepareCellLockPayload(command);
    const params = { rat: command.rat, band: String(command.band), arfcn: command.arfcn };
    return await this.scheduler.executeControl(
      "lock_cell",
      (session, write) => {
        verifiedOnly(write, "lock_cell");
        return applyCellLock(session, command);
      },
      (state) =>
        this.#commitLockState(state, {
          zh: t("zh-CN", "controls.cell_lock_applied", params),
          en: t("en", "controls.cell_lock_applied", params),
        })
    );
  }

  async unlockAllLocks(): Promise<PersistedLockState> {
    return await this.scheduler.executeControl(
      "unlock_rf_locks",
      async (session, write) => (write.generic ? genericLockState(await genericBandLock(session, write.check, "all", write.lteBands ?? [])) : await unlockAllRfLocks(session)),
      (state) =>
        this.#commitLockState(state, {
          zh: t("zh-CN", "controls.unlock_all_applied"),
          en: t("en", "controls.unlock_all_applied"),
        })
    );
  }

  /**
   * Automatic lock rollback (`LOCK_ROLLBACK_AFTER_MIN`) of the lock applied at `lockUpdatedAtIso`:
   * clear every lock unless, inside the session, that lock turns out replaced, or the WAN re-reads as
   * back or mobile data as switched off. Broadcasts only when it wrote.
   */
  async rollBackLocks(lockUpdatedAtIso: string): Promise<WanRepairOutcome> {
    return await this.scheduler.executeControl(
      "auto_unlock_rf_locks",
      async (session, write): Promise<WanRepairOutcome> => {
        // A lock queued before this rollback may have just replaced the one it was meant for
        if (this.getPersistedLockState().updatedAtIso !== lockUpdatedAtIso) return { applied: false, skipped: "lock_changed" };
        if (write.generic) {
          const skipped = await readWanRepairBlockerTolerant(session);
          return skipped ? { applied: false, skipped } : { applied: true, lockState: genericLockState(await genericBandLock(session, write.check, "all", write.lteBands ?? [])) };
        }
        const skipped = await readWanRepairBlocker(session);
        return skipped ? { applied: false, skipped } : { applied: true, lockState: await unlockAllRfLocks(session) };
      },
      (outcome) =>
        outcome.applied && outcome.lockState
          ? this.#commitLockState(outcome.lockState, summaryOf("controls.auto_unlock_applied"))
          : null
    );
  }

  /** Automatic reconnect (`WAN_AUTO_RECONNECT_AFTER_MIN`), guarded like `rollBackLocks`. Never a reboot. */
  async reconnectWan(): Promise<WanRepairOutcome> {
    return await this.scheduler.executeControl(
      "auto_reconnect_cellular",
      async (session, write): Promise<WanRepairOutcome> => {
        const skipped = write.generic ? await readWanRepairBlockerTolerant(session) : await readWanRepairBlocker(session);
        if (skipped) return { applied: false, skipped };
        if (write.generic) await genericReconnect(session, write.check);
        else await triggerCellularReconnect(session);
        return { applied: true };
      },
      (outcome) => (outcome.applied ? summaryOf("controls.auto_reconnect_applied") : null)
    );
  }

  async rebootRouter(params: { confirm: boolean }): Promise<{ rebooting: true; requestedAtIso: string }> {
    if (params.confirm !== true) {
      throw new CpeControlValidationError(
        "Remote reboot rejected: explicit { confirm: true } is mandatory"
      );
    }
    return await this.scheduler.executeControl(
      "reboot_cpe",
      async (session, write) => {
        if (!write.generic) return await rebootCpe(session, params);
        await genericReboot(session, write.check);
        return { rebooting: true as const, requestedAtIso: new Date().toISOString() };
      },
      {
        zh: t("zh-CN", "controls.reboot_triggered"),
        en: t("en", "controls.reboot_triggered"),
      }
    );
  }

  async reconnectCellular(): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return await this.scheduler.executeControl(
      "reconnect_cellular",
      async (session, write) => {
        if (!write.generic) return await triggerCellularReconnect(session);
        await genericReconnect(session, write.check);
        return { reconnecting: true as const, requestedAtIso: new Date().toISOString() };
      },
      {
        zh: t("zh-CN", "controls.reconnect_triggered"),
        en: t("en", "controls.reconnect_triggered"),
      }
    );
  }

  /** Apply the switches, then re-read the full settings in a second read session (`null` if skipped). */
  async setSecuritySwitches(command: SecurityUpdateCommand): Promise<RouterSettingsSnapshot | null> {
    validateSecurityUpdateCommand(command);
    await this.scheduler.executeControl(
      "set_security_switches",
      (session, write) => {
        verifiedOnly(write, "set_security_switches");
        return updateSecuritySettings(session, command);
      },
      {
        zh: t("zh-CN", "controls.security_updated"),
        en: t("en", "controls.security_updated"),
      }
    );
    return await this.monitor.refreshSettings({ ignoreCooldown: true });
  }

  async setWifi7Settings(input: {
    mloEnable?: boolean;
    dbhoEnable?: boolean;
  }): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    if (input.mloEnable === undefined && input.dbhoEnable === undefined) {
      throw new CpeControlValidationError("Specify mloEnable and/or dbhoEnable");
    }
    const wifi7 = await this.scheduler.executeControl(
      "set_wifi7_mlo",
      (session, write) => {
        verifiedOnly(write, "set_wifi7_mlo");
        return updateWifi7Mlo(session, input);
      },
      {
        zh: t("zh-CN", "controls.wifi7_updated"),
        en: t("en", "controls.wifi7_updated"),
      }
    );
    this.monitor.patchCachedSettings(() => ({ wifi7: { ...wifi7 } }));
    return wifi7;
  }

  async setAntennaMode(mode: AntennaModeName): Promise<{ mode: AntennaModeName; rawCode: number }> {
    if (mode !== "auto" && mode !== "internal" && mode !== "external") {
      throw new CpeControlValidationError(`Invalid antenna mode "${String(mode)}"`);
    }
    const antenna = await this.scheduler.executeControl(
      "set_antenna_mode",
      (session, write) => {
        verifiedOnly(write, "set_antenna_mode");
        return updateAntennaMode(session, mode);
      },
      {
        zh: t("zh-CN", "controls.antenna_updated", { mode }),
        en: t("en", "controls.antenna_updated", { mode }),
      }
    );
    this.monitor.patchCachedSettings((current) => ({
      antenna: { ...current.antenna, mode: antenna.mode, rawCode: String(antenna.rawCode) },
    }));
    return antenna;
  }

  async setMobileData(enabled: boolean): Promise<{ mobileDataEnabled: boolean }> {
    const result = await this.scheduler.executeControl(
      "set_mobile_data",
      async (session, write) => (write.generic ? { mobileDataEnabled: await genericMobileData(session, write.check, enabled) } : await updateMobileDataSwitch(session, enabled)),
      {
        zh: t("zh-CN", "controls.mobile_data_updated"),
        en: t("en", "controls.mobile_data_updated"),
      }
    );
    this.monitor.patchCachedSettings(() => ({ mobileDataEnabled: result.mobileDataEnabled }));
    return result;
  }

  /**
   * Block / unblock a Wi-Fi device or change the Wi-Fi MAC filter's mode and list. The change is
   * planned against the router's live state inside the control session (so the daemon's host and
   * the requesting device are never cut off) and verified by reading it back.
   */
  async setWifiAccess(change: WifiAccessChange, ctx: AccessRequestContext & { confirm: boolean }): Promise<AccessControlResult> {
    requireAccessConfirmation(ctx.confirm);
    const result = await this.scheduler.executeControl(
      "set_wifi_access",
      (session, write) => {
        verifiedOnly(write, "set_wifi_access");
        return applyWifiAccessChange(session, change, ctx);
      },
      () => wifiAccessSummary(change)
    );
    return {
      accessControl: await this.#foldAccessControl({ wifiMacFilter: result.wifiMacFilter }),
      changed: result.plan.write !== null,
      alsoBlocked: result.plan.alsoBlocked,
    };
  }

  /** Create, update or delete an internet time rule ("allowed online window") for one device. */
  async manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext & { confirm: boolean }): Promise<AccessControlResult> {
    requireAccessConfirmation(ctx.confirm);
    const timeRules = await this.scheduler.executeControl(
      "manage_time_rule",
      (session, write) => {
        verifiedOnly(write, "manage_time_rule");
        return applyTimeRuleChange(session, change, ctx);
      },
      () => timeRuleSummary(change)
    );
    return { accessControl: await this.#foldAccessControl({ timeRules }), changed: true, alsoBlocked: [] };
  }

  async #foldAccessControl(patch: Partial<Pick<AccessControlSnapshot, "wifiMacFilter" | "timeRules">>): Promise<AccessControlSnapshot | null> {
    if (this.monitor.patchCachedAccessControl(patch)) return this.monitor.getCachedAccessControl();
    return await this.monitor.refreshAccessControl({ ignoreCooldown: true });
  }

  /** Persist the applied lock state before `control:applied` is broadcast with it. */
  #commitLockState(state: PersistedLockState, text: { zh: string; en: string }): ControlSummary {
    this.stateStore.update({ lockState: state });
    void this.stateStore.flushAsync().catch(() => undefined);
    return { ...text, lockState: state };
  }
}

/**
 * A write with no generic implementation never runs on a model nobody verified (the gate keeps it
 * `not_implemented`); should it get here anyway, it stops before sending the H168-383's request.
 */
function verifiedOnly(write: WriteContext, action: string): void {
  if (write.generic) throw new CpeControlValidationError(`${action} has no implementation for a model FengSui was not verified on; nothing was written`);
}

/** The lock state after a generic band lock: LTE only (no NR band or cell lock on such a model). */
function genericLockState(lteBands: number[] | "all"): PersistedLockState {
  return { mode: lteBands === "all" ? "unlocked" : "band_lock", updatedAtIso: new Date().toISOString(), lteBands, nrBands: [], cellLock: null };
}

function requireAccessConfirmation(confirm: boolean): void {
  if (confirm !== true) {
    throw new CpeControlValidationError("Access control changes require explicit { confirm: true }");
  }
}

function summaryOf(key: I18nKey, params: Record<string, string | number> = {}): ControlSummary {
  return { zh: t("zh-CN", key, params), en: t("en", key, params) };
}

/** Control summaries are broadcast and logged, so MACs keep only their vendor prefix. */
function wifiAccessSummary(change: WifiAccessChange): ControlSummary {
  switch (change.kind) {
    case "block":
      return summaryOf("controls.wifi_access_blocked", { mac: maskMacTail(change.macAddress) });
    case "unblock":
      return summaryOf("controls.wifi_access_unblocked", { mac: maskMacTail(change.macAddress) });
    case "mode":
      return summaryOf("controls.wifi_filter_mode", { mode: change.mode });
    case "entries":
      return summaryOf("controls.wifi_filter_entries", { count: (change.add?.length ?? 0) + (change.remove?.length ?? 0) });
  }
}

function timeRuleSummary(change: TimeRuleChange): ControlSummary {
  // The router's IDs are TR-069 paths (`InternetGatewayDevice.X_FireWall.TimeRule.3.`); show the number
  if (change.kind === "delete") return summaryOf("controls.time_rule_deleted", { detail: `#${/(\d+)\.?$/.exec(change.id)?.[1] ?? change.id}` });
  const r = change.rule;
  const detail = `${maskMacTail(r.macAddress)} ${r.weekMask} ${r.startTime}-${r.endTime}`;
  return summaryOf(change.kind === "create" ? "controls.time_rule_created" : "controls.time_rule_updated", { detail });
}
