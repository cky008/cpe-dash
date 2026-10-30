import {
  type AntennaModeName,
  type BandLockCommand,
  type CellLockCommand,
  CpeControlValidationError,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type SecurityUpdateCommand,
  applyBandLock,
  applyCellLock,
  prepareBandLockPayloads,
  prepareCellLockPayload,
  rebootCpe,
  triggerCellularReconnect,
  unlockAllRfLocks,
  updateAntennaMode,
  updateMobileDataSwitch,
  updateSecuritySettings,
  updateWifi7Mlo,
  validateSecurityUpdateCommand,
} from "./cpe-domain.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { t } from "./i18n.ts";
import type { ControlSummary, MutexSessionScheduler } from "./scheduler.ts";
import type { EncryptedStateStore } from "./state-store.ts";

export interface CpeControlServiceOptions {
  scheduler: MutexSessionScheduler;
  monitor: CpeMonitor;
  stateStore: EncryptedStateStore;
}

/**
 * Write side of FengSui: RF locks, reboot/reconnect and router switches. Every command is validated
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

  async lockBands(command: BandLockCommand): Promise<PersistedLockState> {
    prepareBandLockPayloads(command);
    return await this.scheduler.executeControl(
      "lock_band",
      (session) => applyBandLock(session, command),
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
      (session) => applyCellLock(session, command),
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
      (session) => unlockAllRfLocks(session),
      (state) =>
        this.#commitLockState(state, {
          zh: t("zh-CN", "controls.unlock_all_applied"),
          en: t("en", "controls.unlock_all_applied"),
        })
    );
  }

  async rebootRouter(params: { confirm: boolean }): Promise<{ rebooting: true; requestedAtIso: string }> {
    if (params.confirm !== true) {
      throw new CpeControlValidationError(
        "Remote reboot rejected: explicit { confirm: true } is mandatory"
      );
    }
    return await this.scheduler.executeControl("reboot_cpe", (session) => rebootCpe(session, params), {
      zh: t("zh-CN", "controls.reboot_triggered"),
      en: t("en", "controls.reboot_triggered"),
    });
  }

  async reconnectCellular(): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return await this.scheduler.executeControl(
      "reconnect_cellular",
      (session) => triggerCellularReconnect(session),
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
      (session) => updateSecuritySettings(session, command),
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
      (session) => updateWifi7Mlo(session, input),
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
      (session) => updateAntennaMode(session, mode),
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
      (session) => updateMobileDataSwitch(session, enabled),
      {
        zh: t("zh-CN", "controls.mobile_data_updated"),
        en: t("en", "controls.mobile_data_updated"),
      }
    );
    this.monitor.patchCachedSettings(() => ({ mobileDataEnabled: result.mobileDataEnabled }));
    return result;
  }

  /** Persist the applied lock state before `control:applied` is broadcast with it. */
  #commitLockState(state: PersistedLockState, text: { zh: string; en: string }): ControlSummary {
    this.stateStore.update({ lockState: state });
    void this.stateStore.flushAsync().catch(() => undefined);
    return { ...text, lockState: state };
  }
}
