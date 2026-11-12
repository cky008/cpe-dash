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
import { readApnChoice, readDataLimit, readNetworkMode, readOperatorSelection, readSimPin, readSimSlot, readUssdRequest } from "./cellular.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { CpeControlService } from "./cpe-controls.ts";

/**
 * The REST routes of the cellular settings (`POST /api/control/…`, the `control` permission): each
 * reads its body with the shared checks of `src/cellular.ts`, needs `confirm: true`, and is one call
 * of the control service. A PIN and a USSD code pass through here and are kept nowhere.
 */

type Body = Readonly<Record<string, unknown>>;

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

function readSwitch(body: Body): boolean {
  const enabled = body["enabled"];
  if (typeof enabled !== "boolean") throw new CpeControlValidationError('"enabled" must be a boolean');
  return enabled;
}

const ROUTES: Readonly<Record<string, (controls: CpeControlService, body: Body, opts: { confirm: boolean }) => Promise<CellularControlResponse>>> = {
  "/api/control/network-mode": async (controls, body, opts) => ({ ok: true, ...(await controls.setNetworkMode(readNetworkMode(body["mode"]), opts)) }) satisfies NetworkModeControlResponse,
  "/api/control/operator-scan": async (controls, _body, opts) => ({ ok: true, operators: await controls.scanOperators(opts) }) satisfies OperatorScanResponse,
  "/api/control/operator": async (controls, body, opts) => ({ ok: true, ...(await controls.selectOperator(readOperatorSelection(body), opts)) }) satisfies OperatorControlResponse,
  "/api/control/sim-slot": async (controls, body, opts) => ({ ok: true, ...(await controls.setSimSlot(readSimSlot(body), opts)) }) satisfies SimSlotControlResponse,
  "/api/control/sim-pin": async (controls, body, opts) => {
    const action = body["action"] ?? "enter";
    if (action !== "enter" && action !== "lock" && action !== "unlock") throw new CpeControlValidationError('"action" must be "enter", "lock" or "unlock"');
    const pin = readSimPin(body["pin"]);
    const outcome = action === "enter" ? await controls.enterSimPin(pin, opts) : await controls.setSimPinLock(action === "lock", pin, opts);
    return { ok: true, ...outcome } satisfies SimPinControlResponse;
  },
  "/api/control/airplane-mode": async (controls, body, opts) => ({ ok: true, ...(await controls.setAirplaneMode(readSwitch(body), opts)) }) satisfies AirplaneModeControlResponse,
  "/api/control/roaming": async (controls, body, opts) => ({ ok: true, ...(await controls.setRoaming(readSwitch(body), opts)) }) satisfies RoamingControlResponse,
  "/api/control/apn": async (controls, body, opts) => ({ ok: true, ...(await controls.setApn(readApnChoice(body), opts)) }) satisfies ApnControlResponse,
  "/api/control/data-limit": async (controls, body, opts) => ({ ok: true, ...(await controls.setDataLimit(readDataLimit(body), opts)) }) satisfies DataLimitControlResponse,
  "/api/control/traffic-reset": async (controls, _body, opts) => ({ ok: true, ...(await controls.resetTraffic(opts)) }) satisfies TrafficResetResponse,
  "/api/control/ussd": async (controls, body, opts) => ({ ok: true, ussd: await controls.sendUssd(readUssdRequest(body), opts) }) satisfies UssdResponse,
};

/** The paths of the cellular setting writes, in the order the reference lists them. */
export const CELLULAR_CONTROL_ROUTES: ReadonlyArray<string> = Object.keys(ROUTES);

/** Run a cellular setting write (`null`: not one of these routes). */
export async function cellularControl(controls: CpeControlService, pathname: string, body: Body): Promise<CellularControlResponse | null> {
  const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (!route) return null;
  return await route(controls, body, { confirm: body["confirm"] === true });
}
