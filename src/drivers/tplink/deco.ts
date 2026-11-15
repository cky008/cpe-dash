import { CpeControlValidationError } from "../../control-error.ts";
import { SectionUnavailableError } from "../../cpe-domain.ts";
import type { WriteCheck } from "../../device-access.ts";
import { type DriverCell, type DriverNeighbour, emptyCell } from "../../protocols/readings.ts";
import { type LanHttp, parseJsonText } from "../../protocols/transport.ts";
import { counterOf, fieldOf, intOf, ipv4Of, isPlainObject, labelOf, nonNegativeOf, rsrpOf, rsrqOf, rssiOf, sinrOf, textOf } from "../../protocols/values.ts";
import type { SimState } from "../../router-status.ts";
import { CpeAnswerFormatError, CpeApiError } from "../../session-errors.ts";
import type { DriverCredentials } from "../client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, loginUnplaced, wrongPassword } from "../login.ts";
import { noteSent, settleRestart } from "../readback.ts";
import type { DriverHost, DriverIdentity, DriverLockState, DriverSessionHandle, DriverTelemetry } from "../types.ts";
import { TplinkEnvelope, rsaSign, usableKey } from "./crypto.ts";

/**
 * TP-Link's Deco line with a cellular modem (Deco X50-5G), on the interface its own page speaks: LuCI
 * forms under `/cgi-bin/luci/;stok=<token>/…?form=…`. The password is RSA encrypted with a key the
 * router hands out (`login?form=keys`), and every request body is AES encrypted and signed with a
 * second key and a running number (`login?form=auth`), the same wrapping as the Archer routers' with
 * PKCS #1 v1.5 blocks and shorter field names.
 *
 * What is on record is small: the modem's signal (RSRP, RSRQ, SNR, RSSI, no band or cell), its network
 * type, the SIM card's state, the data used, the devices on the mesh, and a restart. The page shows no
 * login-free sign of someone being signed in, so there is nothing to yield to before a login.
 */

const FAMILY = "tplink" as const;
const LOGIN = "/cgi-bin/luci/;stok=/login";
const STOK = /^[A-Za-z0-9]{8,128}$/;
/** The user name the page's hash is made with: the Deco page asks for a password only. */
const USERNAME = "admin";
const FORM = "application/x-www-form-urlencoded; charset=UTF-8";

type Json = Record<string, unknown>;

function resultOf(text: string, label: string): Json | null {
  if (!text.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonText(text, label);
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** A pair of hexadecimal numbers (a modulus and an exponent) as the router's forms hand out a key. */
function pairOf(value: unknown): { modulusHex: string; exponentHex: string } | null {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return null;
  const key = { kind: "rsa", modulusHex: value[0], exponentHex: value[1] } as const;
  return usableKey(key) ? { modulusHex: key.modulusHex, exponentHex: key.exponentHex } : null;
}

/** The key the password is encrypted with, as only a Deco hands it out (its answers sit under `result`). */
export async function decoPasswordKey(http: LanHttp): Promise<{ modulusHex: string; exponentHex: string } | null> {
  const res = await http.request({ method: "POST", path: LOGIN, query: [["form", "keys"], ["operation", "read"]] });
  if (res.status !== 200) return null;
  const answer = resultOf(res.text, "login keys");
  return intOf(fieldOf(answer, "error_code")) === 0 ? pairOf(fieldOf(fieldOf(answer, "result"), "password")) : null;
}

const NETWORK_TYPES: Readonly<Record<string, DriverTelemetry["mode"]>> = { lte: "LTE", lte_plus: "LTE", "5g_nr": "SA", "5g_sa": "SA", "5g_nsa": "NSA", wcdma: "WCDMA" };
const SIM_STATES: Readonly<Record<string, SimState>> = { ready: "ready", locked: "pin_required", absent: "absent", error: "error" };
const LINKS: Readonly<Record<string, DriverHost["link"]>> = { band2_4: "wifi_2_4", band5: "wifi_5", band6: "wifi" };

/** A count of bytes as the form writes it: a JSON number, or digits. */
function bytesOf(value: unknown): bigint | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value)) ? BigInt(Math.round(value)) : null;
  return counterOf(value);
}

/** A name the page stores as Base64 (a device's name), as text; what is not Base64 is kept as it is. */
function decodedName(value: unknown): string | null {
  const text = textOf(value);
  if (text === null) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return labelOf(text);
  return labelOf(Buffer.from(text, "base64").toString("utf8"));
}

/**
 * The modem's part of the internet form (`mobile_cpe`) and the mesh's main unit as one poll. The
 * interface names the signal without its band or cell, and one figure for the data used.
 */
export function parseDecoTelemetry(internet: Json | null, wanIp: string | null, master: Json | null): DriverTelemetry {
  const cpe = fieldOf(internet, "mobile_cpe");
  const mode = NETWORK_TYPES[textOf(fieldOf(cpe, "network_type")) ?? ""] ?? null;
  const rsrp = rsrpOf(fieldOf(cpe, "rsrp"));
  // A modem without a SIM card reports every reading as 0: none of them is one
  const cell: DriverCell = { ...emptyCell(), rsrpDbm: rsrp, rsrqDb: rsrp === null ? null : rsrqOf(fieldOf(cpe, "rsrq")), sinrDb: rsrp === null ? null : sinrOf(fieldOf(cpe, "snr")), rssiDbm: rsrp === null ? null : rssiOf(fieldOf(cpe, "rssi")) };
  const dial = textOf(fieldOf(cpe, "dial_status"));
  const strength = nonNegativeOf(fieldOf(cpe, "signal_strength"));
  const sim = textOf(fieldOf(cpe, "sim_status"));
  return {
    model: labelOf(fieldOf(master, "device_model")),
    softwareVersion: labelOf(fieldOf(master, "software_ver")),
    hardwareVersion: labelOf(fieldOf(master, "hardware_ver")),
    operatorName: null,
    plmn: null,
    mode,
    lte: rsrp !== null && (mode === "LTE" || mode === "NSA") ? cell : null,
    nr: rsrp !== null && mode === "SA" ? cell : null,
    carriers: [],
    wan: { connected: dial === null ? null : dial === "connected", ipv4: wanIp, ipv6: null, uptimeSec: null },
    traffic: isPlainObject(cpe)
      ? {
          downloadBytesPerSec: nonNegativeOf(fieldOf(cpe, "downlink_rate")),
          uploadBytesPerSec: nonNegativeOf(fieldOf(cpe, "uplink_rate")),
          totalDownloadBytes: null,
          totalUploadBytes: null,
          sessionDownloadBytes: null,
          sessionUploadBytes: null,
          sessionSeconds: null,
          monthDownloadBytes: null,
          monthUploadBytes: null,
          monthTotalBytes: bytesOf(fieldOf(cpe, "data_usage")),
          monthSeconds: null,
        }
      : null,
    temperatureC: null,
    // The page's strength is a percentage
    // Without a reading (no SIM card) the page's 0 % is no strength either
    signalBars: strength === null || strength > 100 || (rsrp === null && strength === 0) ? null : Math.round(strength / 20),
    status: { sim: { state: sim === null ? null : (SIM_STATES[sim] ?? null), pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null } },
  };
}

/** The devices the mesh lists as online, by the band or the cable each is on. */
export function parseDecoHosts(result: Json | null): DriverHost[] {
  const list = fieldOf(result, "client_list");
  if (!Array.isArray(list)) return [];
  const hosts: DriverHost[] = [];
  for (const entry of list.slice(0, 256)) {
    const mac = textOf(fieldOf(entry, "mac"));
    if (mac === null || fieldOf(entry, "online") !== true) continue;
    const wire = textOf(fieldOf(entry, "wire_type"));
    // Wired, the band the mesh names, Wi-Fi where it names none, and nothing where it does not say how
    const link = wire === "wired" ? "lan" : (LINKS[textOf(fieldOf(entry, "connection_type")) ?? ""] ?? (wire === null ? null : "wifi"));
    hosts.push({ mac: mac.replace(/-/g, ":"), name: decodedName(fieldOf(entry, "name")), ipv4: ipv4Of(fieldOf(entry, "ip")), ipv6: [], link, connectedSec: null, leaseSec: null, rssiDbm: null });
  }
  return hosts;
}

function notOnRecord(what: string): CpeControlValidationError {
  return new CpeControlValidationError(`This router's interface has no way on record to ${what}`);
}

class DecoSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #http: LanHttp;
  readonly #envelope: TplinkEnvelope;
  readonly #stok: string;
  #master: Json | null | undefined;
  #open = true;

  constructor(http: LanHttp, envelope: TplinkEnvelope, stok: string) {
    this.#http = http;
    this.#envelope = envelope;
    this.#stok = stok;
  }

  get open(): boolean {
    return this.#open;
  }

  /** One form of the page: the request encrypted and signed, the answer's `result` decrypted. */
  async #form(page: string, form: string, body: Json): Promise<Json> {
    if (!this.#open) throw new DriverSessionClosedError();
    const sealed = this.#envelope.seal(JSON.stringify(body), false);
    const res = await this.#http.request({
      method: "POST",
      path: `/cgi-bin/luci/;stok=${this.#stok}/admin/${page}`,
      query: [["form", form]],
      body: new URLSearchParams([["sign", sealed.sign], ["data", sealed.data]]).toString(),
      contentType: FORM,
    });
    if (res.status !== 200) throw new CpeApiError("session", `the router answered HTTP ${res.status}: the session is gone`);
    const outer = resultOf(res.text, `${page} ${form}`);
    const data = fieldOf(outer, "data");
    if (typeof data !== "string") throw new CpeAnswerFormatError(`${page} ${form}: no encrypted answer`);
    let inner: Json | null;
    try {
      inner = resultOf(this.#envelope.open(data), `${page} ${form}`);
    } catch {
      throw new CpeAnswerFormatError(`${page} ${form}: the answer could not be decrypted`);
    }
    const code = intOf(fieldOf(inner, "error_code"));
    if (code !== 0) throw new CpeApiError(String(code ?? "refused"), `the router refused ${page} ${form}`);
    const result = fieldOf(inner, "result");
    return isPlainObject(result) ? result : {};
  }

  /** The mesh's main unit (the one with the modem): the only unit where the mesh has one. */
  async #mainUnit(): Promise<Json | null> {
    if (this.#master !== undefined) return this.#master;
    const list = fieldOf(await this.#form("device", "device_list", { operation: "read" }).catch(() => null), "device_list");
    const units = Array.isArray(list) ? list.filter(isPlainObject) : [];
    this.#master = units.find((unit) => fieldOf(unit, "role") === "master") ?? (units.length === 1 ? (units[0] ?? null) : null);
    return this.#master;
  }

  async identify(): Promise<DriverIdentity> {
    const unit = await this.#mainUnit();
    return { model: labelOf(fieldOf(unit, "device_model")), softwareVersion: labelOf(fieldOf(unit, "software_ver")), hardwareVersion: labelOf(fieldOf(unit, "hardware_ver")), variant: "deco" };
  }

  async telemetry(): Promise<DriverTelemetry> {
    const internet = await this.#form("network", "internet", { operation: "read" });
    // The address is on another form: a firmware without it costs the poll only the address
    const wan = fieldOf(await this.#form("network", "wan_ipv4", { operation: "read" }).catch(() => null), "wan");
    const address = ipv4Of(fieldOf(fieldOf(wan, "mobile_cpe"), "ip")) ?? ipv4Of(fieldOf(fieldOf(wan, "ip_info"), "ip"));
    return parseDecoTelemetry(internet, address, await this.#mainUnit());
  }

  neighbours(): Promise<DriverNeighbour[]> {
    return Promise.reject(new SectionUnavailableError("Nearby cells", null));
  }

  lockState(): Promise<DriverLockState> {
    return Promise.resolve({ lteBands: null, nrBands: null, lteCell: null, nrCell: null, networkMode: null, supportedLte: null, supportedNr: null });
  }

  setBandLock(): Promise<void> {
    return Promise.reject(notOnRecord("lock bands"));
  }

  setCellLock(): Promise<void> {
    return Promise.reject(notOnRecord("lock a cell"));
  }

  unlockAll(): Promise<void> {
    return Promise.reject(notOnRecord("clear a lock"));
  }

  async hosts(): Promise<DriverHost[]> {
    return parseDecoHosts(await this.#form("client", "client_list", { operation: "read", params: { device_mac: "default" } }));
  }

  /** Restart the main unit, the one this session talks to: the page's restart takes the units by their MAC. */
  async reboot(check: WriteCheck): Promise<void> {
    const mac = textOf(fieldOf(await this.#mainUnit(), "mac"));
    if (mac === null) throw new CpeAnswerFormatError("device_list: the router named no main unit to restart");
    noteSent(check, FAMILY, "device.system.reboot");
    await this.#form("device", "system", { operation: "reboot", params: { mac_list: [{ mac }] } });
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    await this.#form("system", "logout", { operation: "logout" }).catch(() => undefined);
    this.#open = false;
  }
}

/**
 * Sign in to a Deco: the password encrypted with the key of `form=keys`, in a request wrapped with
 * the key and the running number of `form=auth`. The router answers inside the same wrapping: a
 * token (`stok`) for a password it took, an error code for one it refused.
 */
export async function decoLogin(http: LanHttp, credentials: DriverCredentials, passwordKey: { modulusHex: string; exponentHex: string }): Promise<DriverSessionHandle> {
  const auth = await http.request({ method: "POST", path: LOGIN, query: [["form", "auth"], ["operation", "read"]] });
  const answer = fieldOf(resultOf(auth.text, "login auth"), "result");
  const signKey = pairOf(fieldOf(answer, "key"));
  const seq = nonNegativeOf(fieldOf(answer, "seq"));
  if (auth.status !== 200 || signKey === null || seq === null) throw new DriverLoginMethodError("the router handed out no key for the login's signature");
  // One block is all the page encrypts: a password longer than the key leaves room for has no form
  if (Buffer.byteLength(credentials.password, "utf8") > passwordKey.modulusHex.length / 2 - 11) throw new DriverLoginMethodError("the page's login has no form for a password this long");
  const envelope = new TplinkEnvelope({ key: { kind: "rsa", ...signKey }, scheme: { cipher: "cbc", padding: "pkcs1" }, seq, username: USERNAME, password: credentials.password, names: { key: "k", iv: "i" } });
  const sealed = envelope.seal(JSON.stringify({ params: { password: rsaSign(credentials.password, passwordKey, "pkcs1") }, operation: "login" }), true);
  const res = await http.request({ method: "POST", path: LOGIN, query: [["form", "login"]], body: new URLSearchParams([["sign", sealed.sign], ["data", sealed.data]]).toString(), contentType: FORM });
  const data = fieldOf(resultOf(res.text, "login"), "data");
  let inner: Json | null = null;
  if (typeof data === "string") {
    try {
      inner = resultOf(envelope.open(data), "login");
    } catch {
      inner = null;
    }
  }
  // An answer FengSui cannot open says nothing about the password: it may have counted as an attempt
  if (res.status !== 200 || inner === null) throw loginUnplaced(`login answered HTTP ${res.status} in a form FengSui cannot read`);
  const stok = textOf(fieldOf(fieldOf(inner, "result"), "stok"));
  // The router read the request (it answered inside the session's wrapping) and opened no session: the password is what it judged
  if (intOf(fieldOf(inner, "error_code")) !== 0 || stok === null) throw wrongPassword("the router refused the password");
  if (!STOK.test(stok)) throw loginUnplaced("login answered a token FengSui cannot use");
  return new DecoSession(http, envelope, stok);
}
