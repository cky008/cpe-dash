import { DriverCpeClient } from "../../src/drivers/client.ts";
import { pinsuLoginFields, pinsuProtocol } from "../../src/drivers/pinsu.ts";
import { LanRouterMock } from "./lan-router.ts";

/** The password the Pinsu mock router takes. */
export const PINSU_PASSWORD = "test-password";

/** The address the Pinsu mock router answers on, as its page does. */
export const PINSU_URL = "http://192.168.0.1";

const PASSWORD = PINSU_PASSWORD;

/**
 * A Pinsu router's page interface (`/goform/*`, `/action/*`): the login with its handshake and
 * attempts, the readings, and the writes the driver makes, each stored and read back. Tests only.
 */
export function pinsuRouter(opts: { loginStatus?: string; login?: Record<string, unknown>; refuse?: string; noSync?: boolean } = {}) {
  const values: Record<string, string> = {
    mnet_sysmode: "lte",
    mnet_rsrp: "58",
    mnet_wnw_band: "1",
    mnet_wnw_pci: "211",
    mnet_band_lock_list: "lte:B1,B3,B5,B8,B38,B41;nr5g:N1,N28,N41,N78",
    mnet_band_lock_type: "unlock,unlock",
    mnet_band_lock_info: "",
    mnet_cell_lock_info: "",
    mnet_acqorder: "auto",
  };
  const actions: Array<{ path: string; body: Record<string, unknown> }> = [];
  const expected = pinsuLoginFields("admin", PASSWORD);
  let loggedIn = false;
  const mock = new LanRouterMock((req) => {
    const body = req.body === "" ? {} : (JSON.parse(req.body) as Record<string, unknown>);
    if (req.path === "/goform/sync") return opts.noSync ? { status: 404, text: "<html>Not Found</html>" } : { json: { retcode: "0" } };
    if (req.path === "/goform/get_login_info") return { json: { retcode: "0", loginStatus: opts.loginStatus ?? "0" } };
    if (req.path === "/goform/login") {
      if (opts.login) return { json: opts.login };
      if (body["username"] !== expected.username || body["password"] !== expected.password) return { json: { retcode: "201", remain_times: "4" } };
      loggedIn = true;
      return { json: { retcode: "0" }, setCookie: ["sid=pinsu; Path=/"] };
    }
    if (!loggedIn || req.headers["cookie"] !== "sid=pinsu") return { json: { retcode: "300" } };
    if (req.path === "/action/get_mgdb_params") {
      const out: Record<string, string> = { retcode: "0" };
      for (const key of body["keys"] as string[]) if (values[key] !== undefined) out[key] = values[key] ?? "";
      return { json: out };
    }
    actions.push({ path: req.path, body });
    if (req.path === `/action/${opts.refuse}`) return { json: { retcode: "5" } };
    if (req.path === "/action/logout") loggedIn = false;
    if (req.path === "/action/mnet_set_band_lock_switch") {
      values["mnet_band_lock_type"] = String(body["mnet_band_lock_type"]);
      values["mnet_band_lock_info"] = String(body["mnet_band_lock_info"]);
    }
    if (req.path === "/action/mnet_set_prefer_net_mode") values["mnet_acqorder"] = String(body["mnet_acqorder"]);
    if (req.path === "/action/mnet_set_celllock_switch") {
      const rat = body["mnet_cell_lock_rat"];
      if (rat === "3") values["mnet_cell_lock_info"] = `lte,${String(body["mnet_cell_lock_arfcn"])},${String(body["mnet_cell_lock_pci"])};nr5g,,,,`;
      if (rat === "4") values["mnet_cell_lock_info"] = `lte,,;nr5g,${String(body["mnet_cell_lock_arfcn"])},${String(body["mnet_cell_lock_pci"])},${String(body["mnet_cell_lock_band"])},${String(body["mnet_cell_lock_scs"])}`;
      if (rat === "13" || rat === "14") values["mnet_cell_lock_info"] = "lte,,;nr5g,,,,";
    }
    return { json: { retcode: "0" } };
  });
  const client = new DriverCpeClient({ protocol: pinsuProtocol, cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, values, actions, client };
}
