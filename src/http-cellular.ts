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
} from "./api-contract.ts";
import type { CpeControlService } from "./cpe-controls.ts";
import type { CellularOperation } from "./operations/cellular-settings.ts";
import type { OperationHandlers } from "./operations/registry.ts";

/**
 * The REST handlers of the cellular settings (`POST /api/control/…`, the `control` permission). The
 * routes, their input checks and `confirm` come from the operation registry; each handler is one call
 * of the control service. A PIN and a USSD code pass through here and are kept nowhere.
 */

export type CellularControlResponse =
  | NetworkModeControlResponse
  | OperatorScanResponse
  | OperatorControlResponse
  | SimSlotControlResponse
  | SimPinControlResponse
  | AirplaneModeControlResponse
  | RoamingControlResponse
  | ApnControlResponse
  | DataLimitControlResponse
  | TrafficResetResponse
  | UssdResponse;

export function cellularRestHandlers(controls: CpeControlService): OperationHandlers<CellularOperation, { confirm: boolean }, CellularControlResponse> {
  return {
    networkMode: async (mode, { confirm }) => ({ ok: true, ...(await controls.setNetworkMode(mode, { confirm })) }) satisfies NetworkModeControlResponse,
    operatorScan: async (_input, { confirm }) => ({ ok: true, operators: await controls.scanOperators({ confirm }) }) satisfies OperatorScanResponse,
    operatorSelect: async (choice, { confirm }) => ({ ok: true, ...(await controls.selectOperator(choice, { confirm })) }) satisfies OperatorControlResponse,
    simSlot: async (slot, { confirm }) => ({ ok: true, ...(await controls.setSimSlot(slot, { confirm })) }) satisfies SimSlotControlResponse,
    simPin: async ({ action, pin }, { confirm }) =>
      ({ ok: true, ...(action === "enter" ? await controls.enterSimPin(pin, { confirm }) : await controls.setSimPinLock(action === "lock", pin, { confirm })) }) satisfies SimPinControlResponse,
    airplaneSwitch: async (enabled, { confirm }) => ({ ok: true, ...(await controls.setAirplaneMode(enabled, { confirm })) }) satisfies AirplaneModeControlResponse,
    roaming: async (enabled, { confirm }) => ({ ok: true, ...(await controls.setRoaming(enabled, { confirm })) }) satisfies RoamingControlResponse,
    apn: async (choice, { confirm }) => ({ ok: true, ...(await controls.setApn(choice, { confirm })) }) satisfies ApnControlResponse,
    dataLimit: async (limit, { confirm }) => ({ ok: true, ...(await controls.setDataLimit(limit, { confirm })) }) satisfies DataLimitControlResponse,
    trafficReset: async (_input, { confirm }) => ({ ok: true, ...(await controls.resetTraffic({ confirm })) }) satisfies TrafficResetResponse,
    ussd: async (request, { confirm }) => ({ ok: true, ussd: await controls.sendUssd(request, { confirm }) }) satisfies UssdResponse,
  };
}
