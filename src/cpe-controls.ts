import type { AccessControlSnapshot, AccessRequestContext } from "./access-control.ts";
import type { TimeRuleChange, WifiAccessChange } from "./access-plan.ts";
import type {
  ApnChoice,
  CellularSettingsSnapshot,
  DataLimitSetting,
  LinkChange,
  LinkChangeKind,
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
  type LockVerification,
  type PersistedLockState,
  type RouterSettingsSnapshot,
  type SecurityUpdateCommand,
  validateSecurityUpdateCommand,
  verifyLockState,
} from "./cpe-domain.ts";
import type { CpeMonitor } from "./cpe-monitor.ts";
import { routerBackendOf } from "./backends/index.ts";
import type { RouterBackend, WanRepairOutcome } from "./router-backend.ts";
import { type I18nKey, t } from "./i18n.ts";
import { maskMacTail } from "./privacy-mask.ts";
import type { ControlSummary, MutexSessionScheduler } from "./scheduler.ts";
import type { EncryptedStateStore } from "./state-store.ts";

export interface AccessControlResult {
  /** The router's state after the change (`null` only if it could not be read back). */
  accessControl: AccessControlSnapshot | null;
  /** `false` when the router already was in the requested state and nothing was written. */
  changed: boolean;
  /** MACs of other devices this change cut off (stored blacklist entries, devices left off a whitelist). */
  alsoBlocked: string[];
}

export type { WanRepairOutcome } from "./router-backend.ts";

export interface CpeControlServiceOptions {
  scheduler: MutexSessionScheduler;
  monitor: CpeMonitor;
  stateStore: EncryptedStateStore;
}

/**
 * Write side of FengSui: RF locks, reboot/reconnect, router switches, device access control
 * (Wi-Fi MAC filter, internet time rules) and the cellular settings. Every command is validated
 * before it is queued (no session for bad input), runs as one `executeControl` session (never
 * replayed, refused with `409` while a human is logged in), and updates the persisted lock state or
 * the cached settings snapshot afterwards. Every write goes through the backend of the router's
 * family (`RouterBackend`), so nothing here names a brand or opens a session: a write a family has no
 * implementation of is refused by the gate, with nothing sent.
 */
/**
 * A band or cell lock on a router nobody verified, which can cut the WAN (see
 * `WanSelfHeal.guardExperimentalLock`): the lock, and for a band lock the LTE mask the router had
 * right before it (`null`: none to read, or a cell lock, which has no setting to go back to).
 */
export interface ExperimentalLockChange {
  lock: PersistedLockState;
  savedLteMask: string | null;
}

/**
 * A change that can take the router off the network by accident (SIM slot, network mode, operator
 * selection, access point), after it applied: what it is put back to (`change: null`: the router did
 * not say what it had before, so nothing can be put back) and when it was made.
 */
export interface LinkChangeNotice {
  kind: LinkChangeKind;
  change: LinkChange | null;
  appliedAtMs: number;
}

export class CpeControlService {
  /**
   * A cellular setting whose change can cut the WAN was changed, by whoever asked: self-healing
   * watches the WAN and puts the setting back if it stays down.
   */
  onLinkChange: ((notice: LinkChangeNotice) => void) | null = null;

  /**
   * A band or cell lock on a router nobody verified, after it applied, whoever asked for it (the
   * console, a token, an AI agent, Telegram): self-healing watches it, and if the WAN stays down
   * writes the saved bands back or takes the locks off.
   */
  onExperimentalLock: ((change: ExperimentalLockChange) => void) | null = null;

  readonly scheduler: MutexSessionScheduler;
  readonly monitor: CpeMonitor;
  readonly stateStore: EncryptedStateStore;

  /** The backend of the router's family: every write both stacks have goes through it. */
  readonly #backend: () => RouterBackend;

  constructor(options: CpeControlServiceOptions) {
    this.scheduler = options.scheduler;
    this.monitor = options.monitor;
    this.stateStore = options.stateStore;
    this.#backend = routerBackendOf(options.scheduler);
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
    const { state, experimental, savedLteMask } = await this.#backend().lockBands(
      command,
      { previousLock: () => this.getPersistedLockState(), cachedTelemetry: () => this.monitor.getCachedTelemetry() },
      (state) => {
        const summaryText = `LTE=${JSON.stringify(state.lteBands)}, NR=${JSON.stringify(state.nrBands)}`;
        return this.#commitLockState(state, {
          zh: t("zh-CN", "controls.band_lock_applied", { summary: summaryText }),
          en: t("en", "controls.band_lock_applied", { summary: summaryText }),
        });
      }
    );
    // A lock on a router nobody verified is watched, and undone if the WAN stays down
    if (experimental) this.onExperimentalLock?.({ lock: state, savedLteMask });
    return state;
  }

  async lockCell(command: CellLockCommand): Promise<PersistedLockState> {
    const { state, experimental } = await this.#backend().lockCell(command, (state) => {
      const params = { rat: state.cellLock?.rat ?? command.rat, band: String(state.cellLock?.band ?? command.band), arfcn: state.cellLock?.arfcn ?? command.arfcn };
      return this.#commitLockState(state, {
        zh: t("zh-CN", "controls.cell_lock_applied", params),
        en: t("en", "controls.cell_lock_applied", params),
      });
    });
    // Watched like a band lock; a cell lock has nothing to write back, so its way back is the unlock
    if (experimental) this.onExperimentalLock?.({ lock: state, savedLteMask: null });
    return state;
  }

  async unlockAllLocks(): Promise<PersistedLockState> {
    return await this.#backend().unlockAll((state) =>
      this.#commitLockState(state, {
        zh: t("zh-CN", "controls.unlock_all_applied"),
        en: t("en", "controls.unlock_all_applied"),
      })
    );
  }

  /**
   * Automatic lock rollback (`LOCK_ROLLBACK_AFTER_MIN`) of the lock applied at `lockUpdatedAtIso`:
   * clear every lock unless, inside the session, that lock turns out replaced, or the WAN re-reads as
   * back (on the HiLink stack also: mobile data as switched off). After a band lock on a router
   * nobody verified, `restore` writes back the LTE mask the router had before it instead.
   * Broadcasts only when it wrote.
   */
  async rollBackLocks(lockUpdatedAtIso: string, restore?: { lteMask: string }): Promise<WanRepairOutcome> {
    return await this.#backend().rollBackLocks({ lockUpdatedAtIso, restore, currentLock: () => this.getPersistedLockState() }, (outcome, restored) =>
      outcome.applied && outcome.lockState ? this.#commitLockState(outcome.lockState, summaryOf(restored ? "controls.auto_restore_applied" : "controls.auto_unlock_applied")) : null
    );
  }

  /** Automatic reconnect (`WAN_AUTO_RECONNECT_AFTER_MIN`), guarded like `rollBackLocks`. Never a reboot. */
  async reconnectWan(): Promise<WanRepairOutcome> {
    return await this.#backend().autoReconnect((outcome) => (outcome.applied ? summaryOf("controls.auto_reconnect_applied") : null));
  }

  async rebootRouter(params: { confirm: boolean }): Promise<{ rebooting: true; requestedAtIso: string }> {
    if (params.confirm !== true) {
      throw new CpeControlValidationError(
        "Remote reboot rejected: explicit { confirm: true } is mandatory"
      );
    }
    return await this.#backend().reboot(params, summaryOf("controls.reboot_triggered"));
  }

  async reconnectCellular(): Promise<{ reconnecting: true; requestedAtIso: string }> {
    return await this.#backend().reconnect(summaryOf("controls.reconnect_triggered"));
  }

  /** Apply the switches, then re-read the full settings in a second read session (`null` if skipped). */
  async setSecuritySwitches(command: SecurityUpdateCommand): Promise<RouterSettingsSnapshot | null> {
    validateSecurityUpdateCommand(command);
    await this.#backend().setSecuritySwitches(command, summaryOf("controls.security_updated"));
    return await this.monitor.refreshSettings({ ignoreCooldown: true });
  }

  async setWifi7Settings(input: {
    mloEnable?: boolean;
    dbhoEnable?: boolean;
  }): Promise<{ mloEnable: boolean; dbhoEnable: boolean }> {
    if (input.mloEnable === undefined && input.dbhoEnable === undefined) {
      throw new CpeControlValidationError("Specify mloEnable and/or dbhoEnable");
    }
    const wifi7 = await this.#backend().setWifi7(input, summaryOf("controls.wifi7_updated"));
    this.monitor.patchCachedSettings(() => ({ wifi7: { ...wifi7 } }));
    return wifi7;
  }

  async setAntennaMode(mode: AntennaModeName): Promise<{ mode: AntennaModeName; rawCode: number }> {
    if (mode !== "auto" && mode !== "internal" && mode !== "external" && mode !== "hybrid") {
      throw new CpeControlValidationError(`Invalid antenna mode "${String(mode)}"`);
    }
    const antenna = await this.#backend().setAntennaMode(mode, summaryOf("controls.antenna_updated", { mode }));
    this.monitor.patchCachedSettings((current) => ({
      antenna: { ...current.antenna, mode: antenna.mode, rawCode: String(antenna.rawCode) },
    }));
    return antenna;
  }

  async setMobileData(enabled: boolean): Promise<{ mobileDataEnabled: boolean }> {
    const result = await this.#backend().setMobileData(enabled, summaryOf("controls.mobile_data_updated"));
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
    const result = await this.#backend().setWifiAccess(change, ctx, () => wifiAccessSummary(change));
    return {
      accessControl: await this.#foldAccessControl({ wifiMacFilter: result.wifiMacFilter }),
      changed: result.plan.write !== null,
      alsoBlocked: result.plan.alsoBlocked,
    };
  }

  /** Create, update or delete an internet time rule ("allowed online window") for one device. */
  async manageTimeRule(change: TimeRuleChange, ctx: AccessRequestContext & { confirm: boolean }): Promise<AccessControlResult> {
    requireAccessConfirmation(ctx.confirm);
    const timeRules = await this.#backend().manageTimeRule(change, ctx, () => timeRuleSummary(change));
    return { accessControl: await this.#foldAccessControl({ timeRules }), changed: true, alsoBlocked: [] };
  }

  // ------------------------------------------------------------------ cellular settings (`src/cellular.ts`)

  /** The cellular settings as the router reports them now (one read session; `null`: skipped, or none on this router). */
  async readCellular(): Promise<CellularSettingsSnapshot | null> {
    return await this.monitor.refreshCellular({ ignoreCooldown: true });
  }

  /** The settings after a write, read in a session of their own; a read that fails says nothing about the write. */
  async #cellularAfter(): Promise<CellularSettingsSnapshot | null> {
    return await this.monitor.refreshCellular({ ignoreCooldown: true }).catch(() => null);
  }

  #noteLinkChange(change: LinkChange | null, kind: LinkChangeKind): void {
    this.onLinkChange?.({ kind, change, appliedAtMs: Date.now() });
  }

  async setNetworkMode(mode: NetworkMode, opts: { confirm: boolean }): Promise<{ networkMode: NetworkMode; cellular: CellularSettingsSnapshot | null }> {
    requireCellularConfirmation(opts.confirm);
    const { previous } = await this.#backend().setNetworkMode(mode, summaryOf("controls.network_mode_updated", { mode }));
    this.#noteLinkChange(previous === null ? null : { kind: "network_mode", previous }, "network_mode");
    return { networkMode: mode, cellular: await this.#cellularAfter() };
  }

  /** Search for networks in range: up to a minute, and many routers drop the connection meanwhile. */
  async scanOperators(opts: { confirm: boolean }): Promise<OperatorChoice[]> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().scanOperators((found) => summaryOf("controls.operators_scanned", { count: found.length }));
  }

  async selectOperator(selection: OperatorSelection, opts: { confirm: boolean }): Promise<{ operator: OperatorSelection; cellular: CellularSettingsSnapshot | null }> {
    requireCellularConfirmation(opts.confirm);
    const summary = selection.mode === "auto" ? summaryOf("controls.operator_auto") : summaryOf("controls.operator_selected", { plmn: selection.plmn });
    const { previous } = await this.#backend().selectOperator(selection, summary);
    // Handing the choice back to the router is the safe state: nothing to put back from there
    if (selection.mode === "manual") this.#noteLinkChange(previous === null ? null : { kind: "operator", previous }, "operator");
    return { operator: selection, cellular: await this.#cellularAfter() };
  }

  async setSimSlot(slot: SimSlotRef, opts: { confirm: boolean }): Promise<{ simSlot: SimSlotRef; cellular: CellularSettingsSnapshot | null }> {
    requireCellularConfirmation(opts.confirm);
    const { previous } = await this.#backend().setSimSlot(slot, { zh: t("zh-CN", "controls.sim_slot_updated", { slot: slotLabel("zh-CN", slot) }), en: t("en", "controls.sim_slot_updated", { slot: slotLabel("en", slot) }) });
    this.#noteLinkChange(previous === null ? null : { kind: "sim_slot", previous }, "sim_slot");
    return { simSlot: slot, cellular: await this.#cellularAfter() };
  }

  /** The summary names no access point: an APN can name a company's private network. */
  async setApn(choice: ApnChoice, opts: { confirm: boolean }): Promise<{ apnMode: ApnChoice["mode"]; cellular: CellularSettingsSnapshot | null }> {
    requireCellularConfirmation(opts.confirm);
    const { previous } = await this.#backend().setApn(choice, summaryOf(choice.mode === "auto" ? "controls.apn_auto" : "controls.apn_updated"));
    this.#noteLinkChange(previous === null ? null : { kind: "apn", previous }, "apn");
    return { apnMode: choice.mode, cellular: await this.#cellularAfter() };
  }

  /** Self-healing's way back from one of the changes above (`WanSelfHeal.guardLinkChange`). Broadcasts only when it wrote. */
  async revertLinkChange(change: LinkChange): Promise<WanRepairOutcome> {
    return await this.#backend().revertLinkChange(change, (outcome) =>
      outcome.applied
        ? { zh: t("zh-CN", "controls.link_restored", { setting: t("zh-CN", LINK_SETTING_KEYS[change.kind]) }), en: t("en", "controls.link_restored", { setting: t("en", LINK_SETTING_KEYS[change.kind]) }) }
        : null
    );
  }

  /** Enter the SIM card's PIN, once. The PIN goes to the router and nowhere else. */
  async enterSimPin(pin: string, opts: { confirm: boolean }): Promise<SimPinOutcome> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().enterSimPin(pin, (outcome) => summaryOf(outcome.accepted ? "controls.sim_pin_accepted" : "controls.sim_pin_refused"));
  }

  async setSimPinLock(enabled: boolean, pin: string, opts: { confirm: boolean }): Promise<SimPinOutcome> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().setSimPinLock(enabled, pin, (outcome) => summaryOf(!outcome.accepted ? "controls.sim_pin_refused" : enabled ? "controls.sim_pin_lock_on" : "controls.sim_pin_lock_off"));
  }

  /** Airplane mode is a deliberate disconnect, like mobile data off: nothing undoes it but its owner. */
  async setAirplaneMode(enabled: boolean, opts: { confirm: boolean }): Promise<{ airplaneMode: boolean }> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().setAirplaneMode(enabled, summaryOf(enabled ? "controls.airplane_on" : "controls.airplane_off"));
  }

  async setRoaming(enabled: boolean, opts: { confirm: boolean }): Promise<{ dataRoaming: boolean }> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().setRoaming(enabled, summaryOf(enabled ? "controls.roaming_on" : "controls.roaming_off"));
  }

  async setDataLimit(limit: DataLimitSetting, opts: { confirm: boolean }): Promise<{ dataLimit: DataLimitSetting; cellular: CellularSettingsSnapshot | null }> {
    requireCellularConfirmation(opts.confirm);
    const dataLimit = await this.#backend().setDataLimit(limit, summaryOf(limit.enabled ? "controls.data_limit_on" : "controls.data_limit_off"));
    return { dataLimit, cellular: await this.#cellularAfter() };
  }

  async resetTraffic(opts: { confirm: boolean }): Promise<{ reset: true }> {
    requireCellularConfirmation(opts.confirm);
    await this.#backend().resetTraffic(summaryOf("controls.traffic_reset"));
    return { reset: true };
  }

  /** The code and the answer stay out of the summary: one is typed by a person, the other written by an operator. */
  async sendUssd(request: UssdRequest, opts: { confirm: boolean }): Promise<UssdAnswer> {
    requireCellularConfirmation(opts.confirm);
    return await this.#backend().sendUssd(request, summaryOf(request.kind === "cancel" ? "controls.ussd_cancelled" : "controls.ussd_sent"));
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

function requireAccessConfirmation(confirm: boolean): void {
  if (confirm !== true) {
    throw new CpeControlValidationError("Access control changes require explicit { confirm: true }");
  }
}

function requireCellularConfirmation(confirm: boolean): void {
  if (confirm !== true) {
    throw new CpeControlValidationError("Cellular setting changes require explicit { confirm: true }");
  }
}

/** How a summary names the setting a change is put back to. */
const LINK_SETTING_KEYS: Readonly<Record<LinkChangeKind, I18nKey>> = {
  sim_slot: "controls.link_sim_slot",
  network_mode: "controls.link_network_mode",
  operator: "controls.link_operator",
  apn: "controls.link_apn",
};

/** A link change's setting as a sentence names it. */
export function linkSettingName(locale: "zh-CN" | "en", kind: LinkChangeKind): string {
  return t(locale, LINK_SETTING_KEYS[kind]);
}

/** A SIM slot as a summary names it. */
function slotLabel(locale: "zh-CN" | "en", slot: SimSlotRef): string {
  if (slot.kind === "physical") return locale === "en" ? (slot.index > 1 ? `card ${slot.index}` : "the card in the tray") : slot.index > 1 ? `实体卡 ${slot.index}` : "实体卡";
  return locale === "en" ? `built-in card ${slot.index}` : `内置卡 ${slot.index}`;
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

/** The number at the end of a path such as `…TimeRule.3.` (one trailing dot allowed), or `null`; one pass, no backtracking. */
export function trailingNumber(id: string): string | null {
  const body = id.endsWith(".") ? id.slice(0, -1) : id;
  let start = body.length;
  while (start > 0 && body.charCodeAt(start - 1) >= 48 && body.charCodeAt(start - 1) <= 57) start -= 1;
  return start < body.length ? body.slice(start) : null;
}

function timeRuleSummary(change: TimeRuleChange): ControlSummary {
  // The router's IDs are TR-069 paths (`InternetGatewayDevice.X_FireWall.TimeRule.3.`); show the number
  if (change.kind === "delete") return summaryOf("controls.time_rule_deleted", { detail: `#${trailingNumber(change.id) ?? change.id}` });
  const r = change.rule;
  const detail = `${maskMacTail(r.macAddress)} ${r.weekMask} ${r.startTime}-${r.endTime}`;
  return summaryOf(change.kind === "create" ? "controls.time_rule_created" : "controls.time_rule_updated", { detail });
}
