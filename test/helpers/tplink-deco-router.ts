import crypto from "node:crypto";
import { DriverCpeClient } from "../../src/drivers/client.ts";
import { tplinkProtocol } from "../../src/drivers/tplink/driver.ts";
import { type LanReply, type LanRequestRecord, LanRouterMock } from "./lan-router.ts";
import { TPLINK_HASHES, TPLINK_PASSWORD, TPLINK_URL } from "./tplink-router.ts";

/**
 * A stand-in for a TP-Link Deco with a cellular modem (LuCI forms under `;stok=`). Like the router,
 * it decrypts the password with one private key and the request's signature with another, takes the
 * session's AES key out of the login's signature, and answers inside that wrapping. Both of its keys
 * are 2048 bits (the driver cuts its blocks by the key it is handed). Reserved placeholders only.
 */

const PASSWORD_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SIGN_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SEQ = 723_456_789;

function pair(key: crypto.KeyObject): [string, string] {
  const jwk = key.export({ format: "jwk" }) as { n: string; e: string };
  return [Buffer.from(jwk.n, "base64url").toString("hex").toUpperCase(), Buffer.from(jwk.e, "base64url").toString("hex")];
}

function openBlocks(key: crypto.KeyObject, hex: string): string | null {
  try {
    let out = "";
    for (let at = 0; at < hex.length; at += 512) {
      // PKCS #1 v1.5 by hand: Node no longer decrypts it with a private key
      const raw = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(hex.slice(at, at + 512), "hex"));
      const end = raw.indexOf(0, 2);
      if (raw[0] !== 0 || raw[1] !== 2 || end < 10) return null;
      out += raw.subarray(end + 1).toString("utf8");
    }
    return out;
  } catch {
    return null;
  }
}

export interface DecoRouterOptions {
  /** No modem readings: a unit without a SIM card. */
  noSim?: boolean;
  /** Forms this firmware lacks. */
  missing?: ReadonlyArray<string>;
  /** What the login answers inside its wrapping instead of a token. */
  loginResult?: Record<string, unknown>;
  /** The login answers something that is not the page's wrapping. */
  loginAnswer?: LanReply;
  networkType?: string;
}

export function decoRouter(opts: DecoRouterOptions = {}) {
  const state = { session: null as { key: Buffer; iv: Buffer; stok: string; cookie: string } | null, rebooted: [] as string[], loggedOut: 0 };
  /** Every form asked after the login: `page form` and the decrypted body. */
  const forms: Array<{ form: string; body: Record<string, unknown> }> = [];
  const logins: Array<{ fields: Record<string, string>; password: string | null }> = [];
  const fieldsOf = (text: string): Record<string, string> => Object.fromEntries(text.split("&").map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const aes = (session: { key: Buffer; iv: Buffer }, plain: string): string => {
    const c = crypto.createCipheriv("aes-128-cbc", session.key, session.iv);
    return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64");
  };
  const unaes = (session: { key: Buffer; iv: Buffer }, data: string): string | null => {
    try {
      const d = crypto.createDecipheriv("aes-128-cbc", session.key, session.iv);
      return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  };
  const wrapped = (session: { key: Buffer; iv: Buffer }, inner: unknown): LanReply => ({ json: { data: aes(session, JSON.stringify(inner)) } });

  const cpe = opts.noSim
    ? { signal_strength: 0, rsrp: 0, snr: 0, rssi: 0, rsrq: 0, sim_status: "absent", dial_status: "disconnected", profile_name: "", data_usage: 0, downlink_rate: 0, uplink_rate: 0 }
    : { sim_number: "", signal_strength: 60, rsrp: -91, snr: 7.2, rssi: -83, rsrq: -9, sim_status: "ready", dial_status: "connected", profile_name: "RGVtbyBJbnRlcm5ldA==", data_usage: 12_948_105_728, inet_status: "online", downlink_rate: 5680, uplink_rate: 1080, network_type: opts.networkType ?? "lte_plus" };

  const answerForm = (name: string, body: Record<string, unknown>): unknown => {
    if (opts.missing?.includes(name)) return { error_code: -40210 };
    if (name === "network internet") return { error_code: 0, result: { mobile_cpe: cpe } };
    if (name === "network wan_ipv4") return { error_code: 0, result: { wan: { dial_type: "mobile", mobile_cpe: { ip: "198.51.100.42", gateway: "198.51.100.41" } }, lan: { ip_info: { ip: "192.168.68.1" } } } };
    if (name === "device device_list") {
      return { error_code: 0, result: { device_list: [{ mac: "02-00-5E-10-00-0A", role: "master", device_model: "X50-5G", hardware_ver: "1.0", software_ver: "1.2.3 Build 20260101" }, { mac: "02-00-5E-10-00-0B", role: "slave", device_model: "X50", hardware_ver: "1.0", software_ver: "1.2.3" }] } };
    }
    if (name === "client client_list") {
      return {
        error_code: 0,
        result: {
          client_list: [
            { mac: "02-00-5E-10-00-01", ip: "192.168.68.100", name: "cGhvbmU=", online: true, wire_type: "wireless", connection_type: "band5", interface: "main" },
            { mac: "02-00-5E-10-00-02", ip: "192.168.68.2", name: "nas", online: true, wire_type: "wired" },
            { mac: "00-00-5E-00-53-01", ip: "192.168.68.101", name: "Z29uZQ==", online: false, wire_type: "wireless", connection_type: "band2_4" },
            { mac: "02-00-5E-10-00-03", online: true, wire_type: "wireless", connection_type: "band6" },
          ],
        },
      };
    }
    if (name === "device system" && body["operation"] === "reboot") {
      state.rebooted = ((body["params"] as { mac_list: Array<{ mac: string }> }).mac_list ?? []).map((unit) => unit.mac);
      return { error_code: 0, result: {} };
    }
    if (name === "system logout") {
      state.loggedOut += 1;
      return { error_code: 0 };
    }
    return { error_code: -40210 };
  };

  const mock = new LanRouterMock((req: LanRequestRecord) => {
    if (req.method !== "POST") return { status: 404, text: "" };
    const form = req.query.get("form") ?? "";
    if (req.path === "/cgi-bin/luci/;stok=/login") {
      if (form === "keys" && req.query.get("operation") === "read") return { json: { result: { password: pair(PASSWORD_KEY.publicKey), username: "" }, error_code: 0 } };
      if (form === "auth" && req.query.get("operation") === "read") return { json: { result: { key: pair(SIGN_KEY.publicKey), seq: SEQ }, error_code: 0 } };
      if (form === "login") {
        const body = new URLSearchParams(req.body);
        const fields = fieldsOf(openBlocks(SIGN_KEY.privateKey, body.get("sign") ?? "") ?? "");
        const session = { key: Buffer.from(fields["k"] ?? "", "utf8"), iv: Buffer.from(fields["i"] ?? "", "utf8") };
        const plain = session.key.length === 16 && session.iv.length === 16 ? unaes(session, body.get("data") ?? "") : null;
        const request = plain === null ? null : (JSON.parse(plain) as { operation: string; params: { password: string } });
        const password = request === null ? null : openBlocks(PASSWORD_KEY.privateKey, request.params.password);
        logins.push({ fields, password });
        if (opts.loginAnswer) return opts.loginAnswer;
        if (request === null) return { status: 403, text: "" };
        if (opts.loginResult) return wrapped(session, opts.loginResult);
        if (request.operation !== "login" || password !== TPLINK_PASSWORD || fields["h"] !== TPLINK_HASHES.md5["admin"] || fields["s"] !== String(SEQ + (body.get("data") ?? "").length)) {
          return wrapped(session, { error_code: -5002, result: { failureCount: 1, attemptsAllowed: 9 } });
        }
        state.session = { ...session, stok: "5t0k0123456789abcdef", cookie: "deco5e55104" };
        return { ...wrapped(session, { error_code: 0, result: { stok: state.session.stok } }), setCookie: [`sysauth=${state.session.cookie}; path=/cgi-bin/luci; HttpOnly`] };
      }
      return { status: 404, text: "" };
    }
    const session = state.session;
    const match = /^\/cgi-bin\/luci\/;stok=([A-Za-z0-9]+)\/admin\/([a-z]+)$/.exec(req.path);
    if (!match || session === null || match[1] !== session.stok || req.headers["cookie"] !== `sysauth=${session.cookie}`) return { status: 403, text: "" };
    const body = new URLSearchParams(req.body);
    const fields = fieldsOf(openBlocks(SIGN_KEY.privateKey, body.get("sign") ?? "") ?? "");
    const plain = unaes(session, body.get("data") ?? "");
    if (plain === null || fields["k"] !== undefined || fields["h"] !== TPLINK_HASHES.md5["admin"] || fields["s"] !== String(SEQ + (body.get("data") ?? "").length)) return { status: 403, text: "" };
    const request = JSON.parse(plain) as Record<string, unknown>;
    const name = `${match[2]} ${form}`;
    forms.push({ form: name, body: request });
    const answer = answerForm(name, request);
    if (name === "system logout") state.session = null;
    return wrapped(session, answer);
  });
  const client = new DriverCpeClient({ protocol: tplinkProtocol, cpeUrl: TPLINK_URL, cpePassword: TPLINK_PASSWORD, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, client, state, forms, logins, passwordKey: pair(PASSWORD_KEY.publicKey), signKey: pair(SIGN_KEY.publicKey), seq: SEQ };
}
