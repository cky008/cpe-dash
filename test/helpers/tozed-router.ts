import { bandsToHex } from "../../src/drivers/bands.ts";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { TOZED_LOGIN_SESSION, tozedLoginPassword, tozedProtocol } from "../../src/drivers/tozed.ts";
import { LanRouterMock } from "./lan-router.ts";

/** The password the Tozed mock router takes. */
export const TOZED_PASSWORD = "test-password";

/** The address the Tozed mock router answers on. */
export const TOZED_URL = "http://192.168.0.1";

const PASSWORD = TOZED_PASSWORD;

/**
 * A Tozed router's `http.cgi` interface: the one-time login token, the session id every call
 * carries, the readings, and the writes (each with a fresh write token), stored and read back. Tests only.
 */
export function tozedRouter(opts: { login?: Record<string, unknown>; token?: string | null; refuse?: number; refuseGet?: number; writeToken?: false } = {}) {
  const token = opts.token === undefined ? "a1b2c3d4e5f60718293a4b5c6d7e8f90" : opts.token;
  const sid = "7c9e1a00000000000000000000000000000000000000000000000000000000ff";
  const state: Record<string, Record<string, unknown>> = {
    161: { band_4g_switch: "0", band_5g_switch: "0", all_band_4g: bandsToHex([1, 3, 5, 7, 8, 20, 38, 40, 41]), all_band_5g: bandsToHex([1, 3, 28, 41, 78, 79]), band_4g_mask: "", band_5g_mask: "" },
    160: { lte_lock_sw: "0", lte_lock_freq: "", lte_lock_pci: "", nr_lock_sw: "0", nr_lock_freq: "", nr_lock_pci: "" },
    218: { networkMode: "131", mode5g: "1" },
    // The connection, as the router's own pages poll it (`network_status` 1: connected)
    113: { network_status: "1" },
  };
  const posts: Array<Record<string, unknown>> = [];
  let writeTokens = 0;
  const mock = new LanRouterMock((req) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    const cmd = body["cmd"];
    if (cmd === 232) return { json: { success: true, cmd, ...(token === null ? {} : { token }) } };
    if (cmd === 100) {
      if (opts.login) return { json: opts.login };
      return body["sessionId"] === TOZED_LOGIN_SESSION && body["passwd"] === tozedLoginPassword(token ?? "", PASSWORD) ? { json: { success: true, cmd, sessionId: sid } } : { json: { success: false, cmd, res: "login_fail", login_times: "1" } };
    }
    if (body["sessionId"] !== sid) return { json: { success: false, cmd } };
    if (body["method"] === "GET") {
      // A firmware without this read
      if (cmd === opts.refuseGet) return { json: { success: false, cmd } };
      if (cmd === 205) return { json: { success: true, cmd, network_type_str: "5G(SA)", currentband_5g: "78", RSRP_5G: "-79", PCI_5G: "142", FREQ_5G: "650000", CELL_ID_5G: "1000", bandwidth_5g: "100MHz", RSRP: "-", flow_dl: "1548.62", flow_ul: "312.45", mon_total_flow: "48920.18", signal_lvl: "5", network_operator: "27201" } };
      if (cmd === 207) return { json: { success: true, cmd, board_type: "VN007+", real_fwversion: "2.10.22", "apcpu0-thmzone": "54200" } };
      if (cmd === 282) return { json: { success: true, cmd, lte_info: "1850,142,-85,-9,-58;", nr_info: "650000,142,-79,-10,24;bad" } };
      // The token every write carries: a fresh one each time it is asked for
      if (cmd === 233) return opts.writeToken === false ? { json: { success: false, cmd } } : { json: { success: true, cmd, token: `w${++writeTokens}` } };
      return { json: { success: true, cmd, ...state[String(cmd)] } };
    }
    posts.push(body);
    // A write without the token handed out last is not this page's
    if (opts.writeToken !== false && cmd !== 101 && body["token"] !== `w${writeTokens}`) return { json: { success: false, cmd, message: "token" } };
    if (cmd === opts.refuse) return { json: { success: false, cmd } };
    if (cmd === 161) {
      state[161] = { ...state[161], band_4g_switch: body["band4gRadio"], band_5g_switch: body["band5gRadio"], band_4g_mask: body["lock4gBand"], band_5g_mask: body["lock5gBand"] };
    }
    if (cmd === 160 && body["subcmd"] === 0) state[160] = { ...state[160], lte_lock_sw: body["lte_lock_sw"], lte_lock_freq: body["lte_lock_freq"], lte_lock_pci: body["lte_lock_pci"] };
    if (cmd === 160 && body["subcmd"] === 1) state[160] = { ...state[160], nr_lock_sw: body["nr_lock_sw"], nr_lock_freq: body["nr_lock_freq"], nr_lock_pci: body["nr_lock_pci"] };
    if (cmd === 218) state[218] = { networkMode: body["networkMode"], mode5g: body["mode5g"] };
    return { json: { success: true, cmd } };
  });
  const client = new DriverCpeClient({ protocol: tozedProtocol, cpeUrl: "http://192.168.0.1", cpeUsername: "admin", cpePassword: PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, posts, client };
}
