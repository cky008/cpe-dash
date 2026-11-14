import type {
  AirplaneModeControlResponse,
  ApnControlResponse,
  DataLimitControlResponse,
  NetworkModeControlResponse,
  OperatorControlResponse,
  OperatorScanResponse,
  RoamingControlResponse,
  SimPinControlResponse,
  SimSlotControlResponse,
  TrafficResetResponse,
  UssdResponse,
} from "../../../src/api-contract.ts";
import { type CellularSettingsSnapshot, type OperatorChoice, PIN_REFUSALS, pinAttemptAllowed, sameSimSlot, simSlotLabel } from "../../../src/cellular.ts";
import { CpeControlValidationError } from "../../../src/control-error.ts";
import type { ControlAction } from "../../../src/features.ts";
import type { CellularOperation } from "../../../src/operations/cellular-settings.ts";
import type { OperationHandlers } from "../../../src/operations/registry.ts";
import type { RouterStatusSnapshot } from "../../../src/router-status.ts";
import type { WriteHint } from "./device.ts";

/**
 * The cellular settings of the demo routers (`src/http-cellular.ts` and the control service, in the
 * page): the routes and the checks on every body are the operation registry's, then the same gate and
 * the same answers. What a search finds, what
 * the operator answers a USSD code with and the SIM card's PIN are made up, and the demo routers the
 * daemon is compared with answer the same (`scripts/demo-router.ts`).
 */

/** What a search for networks finds around the demo household. */
export const DEMO_OPERATORS: ReadonlyArray<OperatorChoice> = [
  { plmn: "27201", name: "Carrier-Lab", rat: "4G", state: "current" },
  { plmn: "27202", name: "DemoNet", rat: "4G", state: "available" },
  { plmn: "27203", name: "OtherNet", rat: "3G", state: "forbidden" },
];

/** What the demo operator answers any USSD code with. */
export const DEMO_USSD_ANSWER = "Carrier-Lab: your balance is 12.50 EUR. 37.4 GB of data left this month.";

/** The demo SIM card's PIN (the placeholder the test fixtures use). */
export const DEMO_SIM_PIN = "1234";

type Text = { zh: string; en: string };

export interface DemoCellularHost {
  now(): number;
  text(key: string, params?: Readonly<Record<string, string | number>>): Text;
  /** The write gate alone: a write this router may not take is refused here, before anything else. */
  gate(action: ControlAction): void;
  /** The gate, the session, the write's record and its broadcast. */
  control(action: ControlAction, summary: Text, hint: WriteHint): Promise<void>;
  /** A read session. */
  session(): Promise<void>;
  status(): RouterStatusSnapshot | null;
  patchStatus(patch: (status: RouterStatusSnapshot) => RouterStatusSnapshot): void;
  /** Another brand's router, written through its driver (ZTE's goform pages in the demo). */
  driver: boolean;
}

function requireConfirm({ confirm }: { confirm: boolean }): void {
  if (!confirm) throw new CpeControlValidationError("Cellular setting changes require explicit { confirm: true }");
}

/** ZTE's page changes the operator and the access point with the connection down, and connects again. */
const offline = (...sent: string[]): string[] => ["DISCONNECT_NETWORK", ...sent, "CONNECT_NETWORK"];

export class DemoCellular {
  readonly #host: DemoCellularHost;
  #snapshot: CellularSettingsSnapshot | null;
  /** ZTE's routers register on a row of their last search only. */
  #searched = false;

  constructor(host: DemoCellularHost, seed: CellularSettingsSnapshot | null) {
    this.#host = host;
    this.#snapshot = seed;
  }

  /** The settings as last read (`GET /api/cellular`). */
  view(): CellularSettingsSnapshot | null {
    return this.#snapshot;
  }

  /** Read them now (`POST /api/cellular/refresh`). */
  async refresh(): Promise<CellularSettingsSnapshot | null> {
    await this.#host.session();
    return this.#stamp({});
  }

  #stamp(patch: Partial<CellularSettingsSnapshot>): CellularSettingsSnapshot | null {
    if (!this.#snapshot) return null;
    const nowMs = this.#host.now();
    this.#snapshot = { ...this.#snapshot, ...patch, capturedAtMs: nowMs, capturedAtIso: new Date(nowMs).toISOString() };
    return this.#snapshot;
  }

  /** The writes, one handler per cellular operation (its input checked by the registry's first check). */
  readonly writes: OperationHandlers<CellularOperation, { confirm: boolean }, object> = {
    networkMode: async (mode, call) => {
      requireConfirm(call);
      this.#host.gate("set_network_mode");
      const offered = this.#snapshot?.networkMode?.options ?? [];
      if (!offered.includes(mode)) throw new CpeControlValidationError(`This router offers no "${mode}" network mode (it offers ${offered.join(", ") || (this.#host.driver ? "none" : "none FengSui can read")})`);
      await this.#host.control("set_network_mode", this.#host.text("controls.network_mode_updated", { mode }), { sent: ["SET_BEARER_PREFERENCE"] });
      return { ok: true, networkMode: mode, cellular: this.#stamp({ networkMode: { current: mode, options: [...offered] } }) } satisfies NetworkModeControlResponse;
    },
    operatorScan: async (_input, call) => {
      requireConfirm(call);
      const operators = DEMO_OPERATORS.map((row) => ({ ...row }));
      await this.#host.control("scan_operators", this.#host.text("controls.operators_scanned", { count: operators.length }), { sent: offline("SCAN_NETWORK"), readback: "none" });
      this.#searched = true;
      return { ok: true, operators } satisfies OperatorScanResponse;
    },
    operatorSelect: async (operator, call) => {
      requireConfirm(call);
      this.#host.gate("select_operator");
      if (operator.mode === "manual" && this.#host.driver) {
        const row = this.#searched ? DEMO_OPERATORS.find((found) => found.plmn === operator.plmn && (operator.rat === null || found.rat === operator.rat)) : undefined;
        if (!row) throw new CpeControlValidationError("This router registers on an operator from its last search, and that search does not list this one: search for networks first");
      }
      const summary = operator.mode === "auto" ? this.#host.text("controls.operator_auto") : this.#host.text("controls.operator_selected", { plmn: operator.plmn });
      await this.#host.control("select_operator", summary, { sent: offline(operator.mode === "auto" ? "SET_BEARER_PREFERENCE" : "SET_NETWORK") });
      // The demo routers say how they choose, and the Huawei one which operator it was told to stay on
      const plmn = operator.mode === "manual" && !this.#host.driver ? operator.plmn : null;
      return { ok: true, operator, cellular: this.#stamp({ operator: { selection: operator.mode, plmn } }) } satisfies OperatorControlResponse;
    },
    simSlot: async (simSlot, call) => {
      requireConfirm(call);
      this.#host.gate("set_sim_slot");
      const offered = this.#snapshot?.simSlots ?? [];
      if (!offered.some((slot) => sameSimSlot(slot, simSlot))) throw new CpeControlValidationError("This router has no such SIM slot");
      const key = "controls.sim_slot_updated";
      await this.#host.control("set_sim_slot", { zh: this.#host.text(key, { slot: simSlotLabel("zh-CN", simSlot) }).zh, en: this.#host.text(key, { slot: simSlotLabel("en", simSlot) }).en }, { sent: ["SET_SIM_SLOT"] });
      this.#host.patchStatus((status) => ({ ...status, sim: status.sim ? { ...status.sim, slot: simSlot } : status.sim }));
      return { ok: true, simSlot, cellular: this.#stamp({}) } satisfies SimSlotControlResponse;
    },
    simPin: async ({ action, pin }, call) => {
      requireConfirm(call);
      const control: ControlAction = action === "enter" ? "enter_sim_pin" : "set_sim_pin_lock";
      this.#host.gate(control);
      // The attempts the card has left decide whether anything is sent at all
      const attempts = pinAttemptAllowed(this.#host.status()?.sim?.pinAttemptsLeft);
      if (!attempts.allowed) throw new CpeControlValidationError(PIN_REFUSALS[attempts.reason]);
      const accepted = pin === DEMO_SIM_PIN;
      const attemptsLeft = accepted ? 3 : attempts.attemptsLeft - 1;
      const key = !accepted ? "controls.sim_pin_refused" : action === "enter" ? "controls.sim_pin_accepted" : action === "lock" ? "controls.sim_pin_lock_on" : "controls.sim_pin_lock_off";
      await this.#host.control(control, this.#host.text(key), { sent: [action === "enter" ? "ENTER_PIN" : action === "lock" ? "ENABLE_PIN" : "DISABLE_PIN"], ...(accepted ? {} : { readback: "none" as const }) });
      this.#host.patchStatus((status) => ({
        ...status,
        sim: status.sim ? { ...status.sim, pinAttemptsLeft: attemptsLeft, ...(accepted && action !== "enter" ? { pinLockEnabled: action === "lock" } : {}), ...(accepted && action === "enter" ? { state: "ready" as const } : {}) } : status.sim,
      }));
      return { ok: true, accepted, attemptsLeft } satisfies SimPinControlResponse;
    },
    airplaneSwitch: async (airplaneMode, call) => {
      requireConfirm(call);
      await this.#host.control("set_airplane_mode", this.#host.text(airplaneMode ? "controls.airplane_on" : "controls.airplane_off"), {});
      this.#host.patchStatus((status) => ({ ...status, airplaneMode }));
      return { ok: true, airplaneMode } satisfies AirplaneModeControlResponse;
    },
    roaming: async (dataRoaming, call) => {
      requireConfirm(call);
      await this.#host.control("set_roaming", this.#host.text(dataRoaming ? "controls.roaming_on" : "controls.roaming_off"), { sent: ["SET_CONNECTION_MODE"] });
      this.#host.patchStatus((status) => ({ ...status, roaming: status.roaming ? { ...status.roaming, dataAllowed: dataRoaming } : status.roaming }));
      if (this.#snapshot && this.#snapshot.dataRoaming !== null) this.#stamp({ dataRoaming });
      return { ok: true, dataRoaming } satisfies RoamingControlResponse;
    },
    apn: async (choice, call) => {
      requireConfirm(call);
      await this.#host.control("set_apn", this.#host.text(choice.mode === "auto" ? "controls.apn_auto" : "controls.apn_updated"), { sent: offline("APN_PROC_EX") });
      const before = this.#snapshot?.apn ?? null;
      const apn = choice.mode === "manual" ? { mode: "manual" as const, apn: choice.apn, ipType: choice.ipType, auth: choice.auth, hasUsername: choice.username !== "" } : before ? { ...before, mode: "auto" as const } : null;
      return { ok: true, apnMode: choice.mode, cellular: this.#stamp({ apn }) } satisfies ApnControlResponse;
    },
    dataLimit: async (dataLimit, call) => {
      requireConfirm(call);
      await this.#host.control("set_data_limit", this.#host.text(dataLimit.enabled ? "controls.data_limit_on" : "controls.data_limit_off"), { sent: ["DATA_LIMIT_SETTING"] });
      const before = this.#snapshot?.dataLimit ?? null;
      const kept = { enabled: dataLimit.enabled, // A limit that is switched off reads without a size
        bytes: dataLimit.enabled ? dataLimit.bytes : null, alertPercent: dataLimit.enabled ? (dataLimit.alertPercent ?? before?.alertPercent ?? null) : (before?.alertPercent ?? null) };
      return { ok: true, dataLimit, cellular: this.#stamp({ dataLimit: kept }) } satisfies DataLimitControlResponse;
    },
    trafficReset: async (_input, call) => {
      requireConfirm(call);
      await this.#host.control("reset_traffic", this.#host.text("controls.traffic_reset"), { readback: "none" });
      return { ok: true, reset: true } satisfies TrafficResetResponse;
    },
    ussd: async (request, call) => {
      requireConfirm(call);
      await this.#host.control("send_ussd", this.#host.text(request.kind === "cancel" ? "controls.ussd_cancelled" : "controls.ussd_sent"), { sent: ["USSD_PROCESS"], readback: "none" });
      return { ok: true, ussd: request.kind === "cancel" ? { state: "cancelled", text: null, awaitsReply: false } : { state: "answered", text: DEMO_USSD_ANSWER, awaitsReply: false } } satisfies UssdResponse;
    },
  };
}
