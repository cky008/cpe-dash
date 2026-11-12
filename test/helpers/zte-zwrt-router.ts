import crypto from "node:crypto";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { ucs2Hex } from "../../src/drivers/sms.ts";
import { zteZwrtProtocol, zwrtDecryptField, zwrtEncryptField, zwrtLoginPassword } from "../../src/drivers/zte-zwrt.ts";
import { LanRouterMock } from "./lan-router.ts";
import type { ZteSmsRow } from "./zte-goform-router.ts";

/**
 * A stand-in for a ZTE router on zWRT: the ubus login, readings and locks, and the `zwrt_wms` SMS
 * store behind the field encryption its web side does (an RSA key handed out, an AES key taken,
 * bodies and numbers as AES-256-GCM from then on). Placeholder values only.
 */

export const ZWRT_PASSWORD = "test-password";
export const ZWRT_SALT = "0F1E2D3C4B5A69788796A5B4C3D2E1F0";
export const ZWRT_SESSION = "8f3a00000000000000000000000000aa";

export interface ZwrtCall {
  session: string;
  object: string;
  method: string;
  args: Record<string, unknown>;
}

export interface ZwrtRouterOptions {
  login?: Record<string, unknown>;
  status?: number;
  /** `object.method` that answers with `status` (default 6, permission denied). */
  fail?: string;
  /** The messages the router starts with (`false`: a firmware without the SMS object). */
  sms?: ZteSmsRow[] | false;
  /** `false`: a firmware without the key exchange, whose fields are plain. */
  encryption?: boolean;
  /** The firmware writes sender numbers as UTF-16 hexadecimal. */
  hexNumbers?: boolean;
  sendStatus?: string;
  /** What `get_device_info` answers (default: a CPE's, the battery temperature only). */
  device?: Record<string, unknown>;
  /** What `get_sim_info` answers (`false`: the web role may not call it, so the router refuses it). */
  sim?: Record<string, unknown> | false;
}

// One key pair for every mock router of a test run: generating one takes a while
let keyPair: { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } | null = null;

function routerKeys(): { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject } {
  keyPair ??= crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return keyPair;
}

/** What the router's own RSA decryption yields: the PKCS #1 v1.5 padding taken off by hand (Node no longer does it). */
function openEnvelope(envelope: string): string | null {
  const block = crypto.privateDecrypt({ key: routerKeys().privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(envelope, "base64"));
  if (block[0] !== 0x00 || block[1] !== 0x02) return null;
  const end = block.indexOf(0x00, 2);
  return end < 10 ? null : block.subarray(end + 1).toString("ascii");
}

export function zwrtRouter(opts: ZwrtRouterOptions = {}) {
  const calls: ZwrtCall[] = [];
  const netinfo: Record<string, string> = {
    network_type: "SA",
    rmcc: "272",
    rmnc: "01",
    nr5g_action_band: "78",
    nr5g_action_channel: "650000",
    nr5g_pci: "142",
    nr5g_rsrp: "-80",
    lte_band_lock: "",
    nr5g_sa_band_lock: "",
    lock_nr_cell: "0,0,0",
    net_select: "WL_AND_5G",
  };
  const state = {
    sms: opts.sms === false || opts.sms === undefined ? [] : opts.sms.map((row) => ({ ...row })),
    smsStatus: {} as Record<string, string>,
    nextSmsId: 900,
    /** The AES key the session registered (`null`: none yet). */
    key: null as Buffer | null,
    /** What the router decrypted of the last send. */
    lastSend: null as { number: string; body: string } | null,
    /** The data call as `get_wwaniface` reads it (a write that leaves a setting out resets it, as a router may). */
    wwan: { enable: "1", connect_mode: "1", roam_enable: "1", connect_status: "ipv4_ipv6_connected" } as Record<string, string>,
  };
  const encrypting = opts.encryption !== false;
  const ids = (raw: unknown): number[] =>
    String(raw ?? "")
      .split(";")
      .filter(Boolean)
      .map((id) => Number.parseInt(id, 10));
  const seal = (plain: string): string => (state.key ? zwrtEncryptField(state.key, plain) : plain);
  const open = (field: unknown): string => {
    const text = String(field ?? "");
    return state.key ? (zwrtDecryptField(state.key, text) ?? "") : text;
  };
  const mock = new LanRouterMock((req) => {
    const body = JSON.parse(req.body) as { id: number; params: [string, string, string, Record<string, unknown>] };
    const [session, object, method, args] = body.params;
    calls.push({ session, object, method, args });
    const reply = (payload: Record<string, unknown> | null, status = 0) => ({ json: { jsonrpc: "2.0", id: body.id, result: payload === null ? [status] : [status, payload] } });
    if (opts.fail === `${object}.${method}`) return reply(null, opts.status ?? 6);
    if (method === "web_login_info") return reply({ zte_web_sault: ZWRT_SALT });
    if (method === "web_login") {
      if (opts.login) return reply(opts.login);
      return args["password"] === zwrtLoginPassword(ZWRT_PASSWORD, ZWRT_SALT) ? reply({ result: 0, ubus_rpc_session: ZWRT_SESSION }) : reply({ result: 1, login_fail_num: 4, login_fail_lock_lefttime: 0 });
    }
    if (session !== ZWRT_SESSION) return reply(null, 6);
    if (method === "web_logout") state.key = null;
    if (method === "web_crt_get") {
      if (!encrypting) return reply(null, 3);
      // PEM on one line, as the router hands it out
      const pem = routerKeys().publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
      return reply({ result: pem });
    }
    if (method === "web_http_enstr_set") {
      const hex = openEnvelope(String(args["web_enstr"] ?? ""));
      if (!encrypting || hex === null || !/^[0-9a-f]{64}$/.test(hex)) return reply(null, 2);
      state.key = Buffer.from(hex, "hex");
      return reply({ result: 0 });
    }
    if (object === "uci") {
      if (args["config"] === "zwrt_wms") return reply({ values: { zte_wms_number_encode: opts.hexNumbers ? "1" : "0" } });
      return reply({ values: { model_name: "MC8512", wa_inner_version: "BD_ZTEMC8512V1.0.0B05", hardware_version: "MC8512_HW1.0" } });
    }
    if (object === "zwrt_wms") {
      if (opts.sms === false) return { json: { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Object not found" } } };
      if (method === "zwrt_wms_get_wms_capacity") {
        const count = (tags: string[]): number => state.sms.filter((row) => tags.includes(row.tag)).length;
        return reply({ sms_nv_total: 100, sms_nv_rev_total: count(["0", "1"]), sms_nv_send_total: count(["2", "3"]), sms_nv_draftbox_total: count(["4"]), sms_dev_unread_num: count(["1"]), sms_sim_total: 50, sms_sim_rev_total: 0 });
      }
      if (method === "zte_libwms_get_sms_data") {
        const size = Number(args["data_per_page"] ?? 500);
        const page = Number(args["page"] ?? 0);
        const rows = [...state.sms].sort((a, b) => b.id - a.id).slice(page * size, page * size + size);
        return reply({
          messages: rows.map((row) => ({ id: row.id, number: seal(opts.hexNumbers ? ucs2Hex(row.number) : row.number), content: seal(row.content), tag: row.tag, date: row.date, draft_group_id: "", mem_store: "nv", received_all_concat_sms: "1" })),
        });
      }
      if (method === "zwrt_wms_get_cmd_status") {
        const result = state.smsStatus[String(args["sms_cmd"])];
        return reply(result === undefined ? {} : { sms_cmd: args["sms_cmd"], sms_cmd_status_result: Number(result) });
      }
      if (method === "zte_libwms_send_sms") {
        // Under a key the router takes ciphertext only: a plain field decrypts to nothing and is refused
        const number = open(args["number"]);
        const text = open(args["message_body"]);
        if (number === "" || text === "") return reply(null, 2);
        state.lastSend = { number, body: text };
        const status = opts.sendStatus ?? "3";
        state.smsStatus["4"] = status;
        if (status !== "2") state.sms.push({ id: state.nextSmsId++, number, content: text, tag: "2", date: String(args["sms_time"] ?? "").replace(/;/g, ",") });
        return reply({ result: 3 });
      }
      if (method === "zwrt_wms_modify_tag") {
        for (const row of state.sms) if (ids(args["id"]).includes(row.id) && row.tag === "1") row.tag = String(args["tag"]);
        return reply({ result: 3 });
      }
      if (method === "zwrt_wms_delete_sms") {
        const gone = ids(args["id"]);
        state.sms = state.sms.filter((row) => !gone.includes(row.id));
        state.smsStatus["6"] = "3";
        return reply({ result: 3 });
      }
      return reply(null, 3);
    }
    if (method === "nwinfo_get_netinfo") return reply(netinfo);
    if (method === "get_wwandst") return reply({ real_time: 3600, real_rx_bytes: 10485760, real_tx_bytes: 2048000, real_rx_speed: 1250000, real_tx_speed: 150000, month_rx_bytes: 53687091200, month_tx_bytes: 4294967296, month_time: 86400, ppp_status: state.wwan["connect_status"] });
    if (method === "get_wwaniface") return opts.fail === "get_wwaniface" ? reply(null, 3) : reply({ ...state.wwan });
    if (method === "set_wwaniface") {
      const on = String(args["enable"]) === "1";
      state.wwan = { enable: on ? "1" : "0", connect_mode: String(args["connect_mode"] ?? "0"), roam_enable: String(args["roam_enable"] ?? "0"), connect_status: on ? "ipv4_ipv6_connected" : "disconnected" };
      return reply({ result: 0 });
    }
    if (method === "get_device_info") return reply(opts.device ?? { bat_temperature: 36 });
    if (method === "get_sim_info") return opts.sim === false ? reply(null, 6) : reply(opts.sim ?? { current_sim_slot: "1", sim_states: "sim ready" });
    if (method === "get_sim_info_before") return reply({ current_sim_slot: "1" });
    if (method === "nwinfo_set_lte_ext_band") netinfo["lte_band_lock"] = String(args["lte_band"]);
    if (method === "nwinfo_set_nrbandlock") netinfo["nr5g_sa_band_lock"] = String(args["nr5g_band"]);
    if (method === "nwinfo_set_netselect") netinfo["net_select"] = String(args["net_select"]);
    if (method === "nwinfo_lock_nr_cell") netinfo["lock_nr_cell"] = `${String(args["lock_nr_pci"])},${String(args["lock_nr_earfcn"])},${String(args["lock_nr_cell_band"])}`;
    if (method === "nwinfo_reset_band_cell_setting") {
      netinfo["lte_band_lock"] = "";
      netinfo["nr5g_sa_band_lock"] = "";
      netinfo["lock_nr_cell"] = "0,0,0";
    }
    return reply({ result: 0 });
  });
  const client = new DriverCpeClient({ protocol: zteZwrtProtocol, cpeUrl: "http://192.168.0.1", cpePassword: ZWRT_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, calls, netinfo, client, state };
}
