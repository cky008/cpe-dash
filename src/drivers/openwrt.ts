import crypto from "node:crypto";
import { type ApnIpType, type NetworkMode, type OperatorChoice, type OperatorSelection, type SimPinOutcome, isPlmn } from "../cellular.ts";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../session-errors.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import { type WriteCheck, settleCheck } from "../device-access.ts";
import type { SimCardStatus, SystemStatus } from "../router-status.ts";
import { encodeSmsSubmit } from "../sms/pdu.ts";
import type { SmsCounters } from "../sms/types.ts";
import { atErrorCode, parseCmglPdus, parseCpms } from "../protocols/at/sms.ts";
import {
  type ModemBrand,
  modemBrandOf,
  isAtError,
  parseCfun,
  parseSimPin,
  atValueLine,
  PDP_TYPES,
  parseCgdcont,
  pinRefused,
  parseOperatorName,
  modelLineOf,
  operatorActOf,
  parseCops,
  parseCopsScan,
} from "../protocols/at/common.ts";
import {
  parseQuectelServingCell,
  parseQuectelCsi,
  withCsi,
  parseQuectelTempSensors,
  parseQuectelCaInfo,
  parseQuectelNeighbours,
  parseQuectelRsrp,
  QUECTEL_MODES,
  QUECTEL_SELECTABLE,
  QUECTEL_MODE_LIST,
  quectelModeOf,
  parseQuectelTemp,
  parseQuectelDataCounter,
  quectelCounterOf,
  counterTraffic,
  parseQuectelLteCellLock,
} from "../protocols/at/quectel.ts";
import {
  FIBOCOM_RAT_OF_MODE,
  FIBOCOM_MODE_OF_RAT,
  FIBOCOM_MODE_LIST,
  parseFibocomAct,
  parseFibocomCaInfo,
  parseFibocomCcInfo,
} from "../protocols/at/fibocom.ts";
import { bandsToList, checkCellLock, checkLockBands, listToBands } from "./bands.ts";
import { settleNothingToRead } from "./cellular.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, wrongPassword } from "./login.ts";
import { awaitConnection, noteSent, settleBandLock, settleCellLock, settleCellLocks, settleDataSwitch, settleRestart, settleUnlock } from "./readback.ts";
import { type AssembledSms, assembleSegments, settleSmsCount, storedIndices } from "./sms.ts";
import type { LanHttp } from "../protocols/transport.ts";
import { UBUS_ANONYMOUS_SESSION, UbusRpc } from "../protocols/ubus.ts";
import type {
  DriverBandLockTarget,
  DriverCellLockTarget,
  DriverCellular,
  DriverCellularState,
  DriverDataLink,
  DriverHost,
  DriverIdentity,
  DriverLockState,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
} from "./types.ts";
import type { CellLockState, DriverNeighbour, DriverNetworkMode } from "../protocols/readings.ts";
import { bandOf, fieldOf, iccidOf, imeiOf, imsiOf, intOf, isPlainObject, labelOf, nonNegativeOf, pciOf, temperatureOf, textOf } from "../protocols/values.ts";

/**
 * OpenWrt routers with Quectel (RM500, RM520, RG500, RG520, RM551...) or Fibocom (FM650, FM350,
 * FM160, FG370...) 5G/4G cellular modules:
 *
 * 1. OpenWrt ubus JSON-RPC 2.0 lifecycle over `POST /ubus`:
 *    - Anonymous token `"00000000000000000000000000000000"` calls `session.login` with username & password.
 *    - AT commands executed via ubus modem RPC (`gl-modem`, `modem_ctrl`, `QModem`, `at`, `modem`).
 *    - Single session released in `finally` via `session.destroy`.
 *
 * 2. Quectel modules:
 *    - Telemetry: `ATI`, `AT+QGMR`, `AT+QENG="servingcell"` (SA/NSA/LTE), `AT+QCAINFO`,
 *      `AT+QENG="neighbourcell"`, `AT+QRSRP`, `AT+QNWCFG`, `AT+QTEMP`.
 *    - LTE SINR formula: `SINR_dB = 2 * X - 20` for raw integer $X \in [0, 30]$.
 *    - Bandwidth & SCS lookup tables per 3GPP & Quectel AT specifications.
 *    - Controls: `AT+QNWPREFCFG` for mode and colon-delimited band locking,
 *      `AT+QNWLOCK="common/4g"` / `AT+QNWLOCK="common/5g"` for cell locking, and `AT+CFUN=1,1` for reboot.
 *
 * 3. Fibocom modules:
 *    - Telemetry: `ATI`, `AT+GMR` / `AT+CGMR`, `AT+GTCCINFO?` (serving & neighbours), `AT+MTSM=1`,
 *      `AT+GTCAINFO?` (secondary carriers: the notes name it; its answer layout is in
 *      docs/dev/sources.md §18.4).
 *    - Serving cell RSRP conversion: LTE `idx - 140` dBm; NR `idx - 156` dBm.
 *    - Controls: `AT+GTACT` band locking with `+100` for LTE and `+500` for NR,
 *      `AT+GTCELLLOCK` for 4G/5G cell locking, and `AT+CFUN=1,1` for reboot.
 *
 * 4. SMS, either make (3GPP TS 27.005): `AT+CPMS?` counts the storage the modem is set to, `AT+CMGF=0`
 *    then `AT+CMGL=4` lists it as PDUs (a long message as its parts, joined here), `AT+CMGD` deletes.
 *    Listing a message marks it read on the modem, so the read state is FengSui's to keep. Sending
 *    takes two steps on an AT port (`AT+CMGS`, then the PDU at the prompt), which an AT service that
 *    takes one command at a time cannot do: FengSui sends through QModem's `qmodem.send_raw_pdu`,
 *    where that is installed, and reads and deletes everywhere.
 */

const FAMILY = "openwrt" as const;
const UBUS_PATH = "/ubus";
export const OPENWRT_ANONYMOUS_SESSION = UBUS_ANONYMOUS_SESSION;

/** Extract string response from varied OpenWrt AT RPC wrapper responses. */
export function extractAtResponse(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n").trim();
  if (isPlainObject(raw)) {
    for (const key of ["response", "result", "stdout", "at_response", "data", "output", "at_cmd", "cmd_result"]) {
      const val = raw[key];
      if (typeof val === "string") return val.trim();
      if (Array.isArray(val)) return val.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n").trim();
    }
  }
  return "";
}

/**
 * `ubus call system info` (OpenWrt's procd, documented in OpenWrt's ubus `system` reference): `uptime`
 * in seconds and `memory` in bytes (`total`, `free`, `buffered`; newer releases also `available`).
 */
export function parseSystemInfo(answer: unknown): SystemStatus | null {
  if (!isPlainObject(answer)) return null;
  const uptime = nonNegativeOf(answer["uptime"]);
  const memory = isPlainObject(answer["memory"]) ? answer["memory"] : null;
  const total = memory ? nonNegativeOf(memory["total"]) : null;
  const available = memory ? (nonNegativeOf(memory["available"]) ?? sumOf(nonNegativeOf(memory["free"]), nonNegativeOf(memory["buffered"]), nonNegativeOf(memory["cached"]))) : null;
  const memoryPercent = total !== null && total > 0 && available !== null && available <= total ? Math.round(((total - available) * 100) / total) : null;
  return uptime === null && memoryPercent === null ? null : { uptimeSec: uptime, cpuPercent: null, memoryPercent };
}

function sumOf(...values: Array<number | null>): number | null {
  return values[0] === null ? null : values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

/** How long a search for networks or a registration may take the module (the modules' manuals give `AT+COPS` three minutes). */
const COPS_TIMEOUT_MS = 180_000;

interface UbusRpcCallTarget {
  object: string;
  method: string;
  cmdKey: string;
}

const MODEM_RPC_CANDIDATES: ReadonlyArray<UbusRpcCallTarget> = [
  { object: "gl-modem", method: "send_at", cmdKey: "cmd" },
  { object: "modem_ctrl", method: "at_cmd", cmdKey: "cmd" },
  { object: "QModem", method: "send_at", cmdKey: "cmd" },
  { object: "at", method: "send", cmdKey: "cmd" },
  { object: "modem", method: "at", cmdKey: "cmd" },
];

/** The SIM card and the identifiers, read once a minute per router (`SIM_READ_MAX_AGE_MS`). */
interface SimRead {
  sim: SimCardStatus | null;
  ids: NonNullable<DriverTelemetry["ids"]>;
}

const SIM_READ_MAX_AGE_MS = 60_000;
/** By the router's address (each session has a connection of its own); a few routers at most. */
const SIM_READS = new Map<string, { atMs: number; read: SimRead }>();

/** Forget the SIM reads kept (tests, and a router connection that changed). */
export function forgetOpenwrtSimReads(): void {
  SIM_READS.clear();
}

/**
 * OpenWrt's ubus (`POST /ubus`), plus the way an AT command reaches the module: the first of the
 * modem services that answers (`MODEM_RPC_CANDIDATES`), else QModem's own object. A ubus status 6 is
 * a refused password (the session token is not, or no longer, one).
 */
class OpenwrtUbusClient extends UbusRpc {
  #resolvedModemRpc: UbusRpcCallTarget | null = null;
  /** QModem's modem section and AT port (`undefined`: not looked for yet; `null`: no QModem here). */
  #qmodem: QmodemTarget | null | undefined = undefined;
  #atViaQmodem = false;

  constructor(http: LanHttp) {
    super(http, { path: UBUS_PATH, statusError: (status) => (status === 6 ? wrongPassword("permission denied (ubus status 6)") : null) });
  }

  /**
   * QModem's first modem with an AT port, from its UCI configuration (`uci get qmodem`): the section
   * its `qmodem` object is asked by, and the port its `send_at` wants named. `null` without QModem.
   */
  async qmodem(): Promise<QmodemTarget | null> {
    if (this.#qmodem !== undefined) return this.#qmodem;
    this.#qmodem = null;
    try {
      const values = fieldOf(await this.call("uci", "get", { config: "qmodem" }), "values");
      if (isPlainObject(values)) {
        for (const [section, options] of Object.entries(values)) {
          const port = isPlainObject(options) ? textOf(options["at_port"]) : null;
          if (port !== null && /^\/dev\/[A-Za-z0-9_./-]{1,48}$/.test(port) && /^[A-Za-z0-9_]{1,32}$/.test(section)) {
            this.#qmodem = { section, port };
            break;
          }
        }
      }
    } catch {
      // No QModem (or its configuration is not ours to read): the other AT services remain
    }
    return this.#qmodem;
  }

  async #qmodemAt(target: QmodemTarget, cmd: string, timeoutMs?: number): Promise<string> {
    return qmodemText(await this.call("qmodem", "send_at", { config_section: target.section, params: { at: cmd, port: target.port } }, timeoutMs));
  }

  /** Run an AT command through the resolved modem RPC target or probe candidates. `timeoutMs`: how long this one request may take (a search for networks takes minutes). */
  async execAt(cmd: string, timeoutMs?: number): Promise<string> {
    if (this.#atViaQmodem && this.#qmodem) return await this.#qmodemAt(this.#qmodem, cmd, timeoutMs);
    if (this.#resolvedModemRpc) {
      const res = await this.call(this.#resolvedModemRpc.object, this.#resolvedModemRpc.method, { [this.#resolvedModemRpc.cmdKey]: cmd }, timeoutMs);
      return extractAtResponse(res);
    }
    for (const target of MODEM_RPC_CANDIDATES) {
      try {
        const res = await this.call(target.object, target.method, { [target.cmdKey]: cmd }, timeoutMs);
        const text = extractAtResponse(res);
        if (text !== "" || cmd.startsWith("AT")) {
          this.#resolvedModemRpc = target;
          return text;
        }
      } catch {
        // try next candidate
      }
    }
    // QModem's own object, which wants the modem's section and port named
    const qmodem = await this.qmodem();
    if (qmodem) {
      const text = await this.#qmodemAt(qmodem, cmd, timeoutMs);
      this.#atViaQmodem = true;
      return text;
    }
    throw new CpeApiError("no-modem-rpc", "No known modem AT RPC service found on OpenWrt (tried gl-modem, modem_ctrl, QModem, at, modem, qmodem)");
  }
}

interface QmodemTarget {
  section: string;
  port: string;
}

/** What a QModem method answered from the modem: the `res` text of its `at_cfg` / `result` object (or of the answer itself). */
export function qmodemText(answer: unknown): string {
  for (const holder of [fieldOf(answer, "at_cfg"), fieldOf(answer, "result"), answer]) {
    const res = isPlainObject(holder) ? holder["res"] : undefined;
    if (typeof res === "string") return res.trim();
  }
  return "";
}

// --------------------------------------------------------------------------
// Session Implementation
// --------------------------------------------------------------------------

export class OpenwrtSession implements DriverSessionHandle {
  readonly family = FAMILY;
  readonly #ubus: OpenwrtUbusClient;
  #brand: ModemBrand = "quectel";
  #identity: DriverIdentity | null = null;
  #open = true;

  constructor(ubus: OpenwrtUbusClient) {
    this.#ubus = ubus;
  }

  get open(): boolean {
    return this.#open;
  }

  get brand(): ModemBrand {
    return this.#brand;
  }

  #guard(): void {
    if (!this.#open) throw new DriverSessionClosedError();
  }

  /**
   * Which make the module is, and its identity: `ATI` names it on most modules; `AT+CGMM` (the
   * model alone) when `ATI` does not; failing both, a Quectel-only query (`AT+QENG="servingcell"`)
   * that answers `ERROR` tells a Fibocom module apart from a Quectel one.
   */
  async initModem(): Promise<void> {
    const ati = await this.#ubus.execAt("ATI").catch(() => "");
    let brand = modemBrandOf(ati);
    let cgmm = "";
    if (brand === null) {
      cgmm = await this.#ubus.execAt("AT+CGMM").catch(() => "");
      brand = modemBrandOf(cgmm);
    }
    if (brand === null) {
      const probe = await this.#ubus.execAt('AT+QENG="servingcell"').catch(() => "");
      brand = isAtError(probe) ? "fibocom" : "quectel";
    }
    this.#brand = brand;
    // The model: what `AT+CGMM` named when it was asked (an `ATI` that names no make may not name the module either), else `ATI`'s line
    const model = (cgmm !== "" ? modelLineOf(cgmm) : null) ?? modelLineOf(ati);
    let gmr = "";
    if (this.#brand === "quectel") {
      gmr = await this.#ubus.execAt("AT+QGMR").catch(() => "");
    } else {
      gmr = await this.#ubus.execAt("AT+CGMR").catch(() => "");
    }
    const version = labelOf(gmr.split(/\r?\n/).find((l) => l.trim() && !l.toUpperCase().includes("OK")));
    this.#identity = {
      model: model ?? (this.#brand === "quectel" ? "Quectel 5G Module" : "Fibocom 5G Module"),
      softwareVersion: version,
      hardwareVersion: this.#brand,
    };
  }

  async identify(): Promise<DriverIdentity> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    return this.#identity!;
  }

  async telemetry(): Promise<DriverTelemetry> {
    this.#guard();
    if (!this.#identity) await this.initModem();

    if (this.#brand === "fibocom") return await this.#fibocomTelemetry();

    // Quectel Telemetry; a module that answers the Quectel serving-cell query with an error is a Fibocom one after all
    const servingRaw = await this.#ubus.execAt('AT+QENG="servingcell"').catch(() => "");
    if (isAtError(servingRaw)) {
      this.#brand = "fibocom";
      this.#identity = { ...this.#identity!, hardwareVersion: "fibocom" };
      return await this.#fibocomTelemetry();
    }
    const serving = parseQuectelServingCell(servingRaw);
    const caRaw = await this.#ubus.execAt("AT+QCAINFO").catch(() => "");
    const carriers = parseQuectelCaInfo(caRaw);
    const rsrpRaw = await this.#ubus.execAt("AT+QRSRP").catch(() => "");
    const rxChains = parseQuectelRsrp(rsrpRaw);
    if (rxChains && serving.lte) serving.lte.rxRsrpDbm = rxChains;
    if (rxChains && serving.nr) serving.nr.rxRsrpDbm = rxChains;

    const tempRaw = await this.#ubus.execAt("AT+QTEMP").catch(() => "");
    const temp = parseQuectelTemp(tempRaw);
    // The downlink's channel state, per serving cell the module has
    if (serving.lte) serving.lte = withCsi(serving.lte, parseQuectelCsi(await this.#ubus.execAt('AT+QNWCFG="lte_csi"').catch(() => ""), "lte_csi"));
    if (serving.nr) serving.nr = withCsi(serving.nr, parseQuectelCsi(await this.#ubus.execAt('AT+QNWCFG="nr5g_csi"').catch(() => ""), "nr5g_csi"));
    // The data counter of the mode the module is in (4G and 5G are counted apart)
    const counterCmd = quectelCounterOf(serving.mode);
    const counter = counterCmd ? parseQuectelDataCounter(await this.#ubus.execAt(counterCmd.command).catch(() => ""), counterCmd.prefix) : null;

    return {
      model: this.#identity!.model,
      softwareVersion: this.#identity!.softwareVersion,
      hardwareVersion: this.#identity!.hardwareVersion,
      operatorName: await this.#operatorName(),
      plmn: serving.plmn,
      mode: serving.mode,
      lte: serving.lte,
      nr: serving.nr,
      carriers,
      // QModem knows whether the data connection is up; without it, a serving cell is the best there is
      wan: { connected: (await this.#dataUp().catch((): boolean | null => null)) ?? serving.mode !== "NONE", ipv4: null, ipv6: null, uptimeSec: null },
      traffic: counter && counterCmd ? counterTraffic(counter, counterCmd.command) : null,
      temperatureC: temp,
      signalBars: null,
      temperatures: parseQuectelTempSensors(tempRaw),
      ...(await this.#routerStatus()),
    };
  }

  /**
   * What the router and the module say of themselves: the radio switch (`AT+CFUN?`) and the router's
   * uptime and memory (`system info`) on every poll; the SIM card and the identifiers once a minute
   * (they rarely change, and each is one more AT command).
   */
  async #routerStatus(): Promise<Pick<DriverTelemetry, "status" | "ids">> {
    const airplaneMode = parseCfun(await this.#ubus.execAt("AT+CFUN?").catch(() => ""));
    const system = parseSystemInfo(await this.#ubus.call("system", "info", {}).catch(() => null));
    const card = await this.#simRead();
    return { status: { airplaneMode, system, sim: card.sim }, ids: card.ids };
  }

  async #simRead(): Promise<SimRead> {
    const key = this.#ubus.http.baseUrl;
    const cached = SIM_READS.get(key);
    if (cached && Date.now() - cached.atMs < SIM_READ_MAX_AGE_MS) return cached.read;
    const quectel = this.#brand === "quectel";
    const cpin = await this.#ubus.execAt("AT+CPIN?").catch(() => "");
    const qpinc = quectel ? await this.#ubus.execAt('AT+QPINC="SC"').catch(() => "") : "";
    const pin = parseSimPin(cpin, qpinc);
    const read: SimRead = {
      sim: pin.state === null && pin.pinAttemptsLeft === null ? null : { ...pin, pinLockEnabled: null, slot: null },
      ids: {
        imei: imeiOf(atValueLine(await this.#ubus.execAt("AT+CGSN").catch(() => ""), "+CGSN:")),
        imsi: imsiOf(atValueLine(await this.#ubus.execAt("AT+CIMI").catch(() => ""), null)),
        iccid: quectel ? iccidOf(atValueLine(await this.#ubus.execAt("AT+QCCID").catch(() => ""), "+QCCID:")) : null,
      },
    };
    SIM_READS.delete(key);
    SIM_READS.set(key, { atMs: Date.now(), read });
    while (SIM_READS.size > 8) SIM_READS.delete(SIM_READS.keys().next().value ?? key);
    return read;
  }

  /** The registered operator's name (`AT+COPS?`, 3GPP TS 27.007); `null` when the module names none. */
  async #operatorName(): Promise<string | null> {
    return parseOperatorName(await this.#ubus.execAt("AT+COPS?").catch(() => ""));
  }

  async #fibocomTelemetry(): Promise<DriverTelemetry> {
    const ccInfoRaw = await this.#ubus.execAt("AT+GTCCINFO?").catch(() => "");
    const cc = parseFibocomCcInfo(ccInfoRaw);
    const carriers = cc.mode === "NONE" ? [] : parseFibocomCaInfo(await this.#ubus.execAt("AT+GTCAINFO?").catch(() => ""));
    const tempRaw = await this.#ubus.execAt("AT+MTSM=1").catch(() => "");
    const tempMatch = tempRaw.match(/(-?\d+(?:\.\d+)?)/);
    const temp = tempMatch ? temperatureOf(tempMatch[1]) : null;

    return {
      model: this.#identity!.model,
      softwareVersion: this.#identity!.softwareVersion,
      hardwareVersion: this.#identity!.hardwareVersion,
      operatorName: await this.#operatorName(),
      plmn: cc.plmn,
      mode: cc.mode,
      lte: cc.lte,
      nr: cc.nr,
      carriers,
      wan: { connected: (await this.#dataUp().catch((): boolean | null => null)) ?? cc.mode !== "NONE", ipv4: null, ipv6: null, uptimeSec: null },
      traffic: null,
      temperatureC: temp,
      signalBars: null,
      ...(await this.#routerStatus()),
    };
  }

  /**
   * Connected devices as LuCI's status page lists them: `luci-rpc` `getDHCPLeases` (LuCI's own rpcd
   * plugin): `dhcp_leases` with `macaddr`, `hostname`, `ipaddr` and `expires` (seconds left, `false`
   * for a lease that does not expire), and `dhcp6_leases` with `ip6addr` / `ip6addrs`, folded into the
   * same device by MAC. A lease does not say whether the device is wired or on Wi-Fi.
   */
  async hosts(): Promise<DriverHost[]> {
    this.#guard();
    let answer: unknown;
    try {
      answer = await this.#ubus.call("luci-rpc", "getDHCPLeases", {});
    } catch (err) {
      // No LuCI (or no lease list) on this router: nothing to read, not a broken session
      if (err instanceof CpeApiError) throw new SectionUnavailableError("The device list", null);
      throw err;
    }
    const v4 = fieldOf(answer, "dhcp_leases");
    const v6 = fieldOf(answer, "dhcp6_leases");
    if (!Array.isArray(v4) && !Array.isArray(v6)) throw new SectionUnavailableError("The device list", null);
    const hosts = new Map<string, DriverHost>();
    for (const lease of (Array.isArray(v4) ? v4 : []).filter(isPlainObject)) {
      const mac = textOf(lease["macaddr"]);
      if (mac === null) continue;
      const expires = lease["expires"];
      hosts.set(mac.toLowerCase(), { mac, name: labelOf(lease["hostname"]), ipv4: textOf(lease["ipaddr"]), ipv6: [], link: null, connectedSec: null, leaseSec: typeof expires === "number" ? expires : null, rssiDbm: null });
    }
    for (const lease of (Array.isArray(v6) ? v6 : []).filter(isPlainObject)) {
      const mac = textOf(lease["macaddr"]);
      if (mac === null) continue;
      const listed = lease["ip6addrs"];
      const addresses = [...(Array.isArray(listed) ? listed : []), lease["ip6addr"]].map((a) => textOf(a)).filter((a): a is string => a !== null);
      const host = hosts.get(mac.toLowerCase());
      if (host) host.ipv6 = [...new Set([...host.ipv6, ...addresses])];
      else hosts.set(mac.toLowerCase(), { mac, name: labelOf(lease["hostname"]), ipv4: null, ipv6: [...new Set(addresses)], link: null, connectedSec: null, leaseSec: null, rssiDbm: null });
    }
    return [...hosts.values()];
  }

  async neighbours(): Promise<DriverNeighbour[]> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    if (this.#brand === "fibocom") {
      const ccInfoRaw = await this.#ubus.execAt("AT+GTCCINFO?").catch(() => "");
      return parseFibocomCcInfo(ccInfoRaw).neighbours;
    }
    const neighRaw = await this.#ubus.execAt('AT+QENG="neighbourcell"').catch(() => "");
    return parseQuectelNeighbours(neighRaw);
  }

  async lockState(): Promise<DriverLockState> {
    this.#guard();
    if (!this.#identity) await this.initModem();

    if (this.#brand === "fibocom") {
      const gtact = await this.#ubus.execAt("AT+GTACT?").catch(() => "");
      const cell = await this.#ubus.execAt("AT+GTCELLLOCK?").catch(() => "");

      const act = parseFibocomAct(gtact);
      // An answer that names no lock setting is not "unlocked": what was not read stays unknown
      const answered = cell.includes("+GTCELLLOCK:");
      let lteCell: CellLockState | null = answered ? { locked: false } : null;
      let nrCell: CellLockState | null = answered ? { locked: false } : null;
      // Format: +GTCELLLOCK: 1,rat,is_nr,arfcn,pci[,scs] or +GTCELLLOCK: 0
      const lockMatch = cell.match(/\+GTCELLLOCK:\s*1,\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (lockMatch) {
        const isNr = lockMatch[2] === "1";
        const arfcn = intOf(lockMatch[3]);
        const pci = pciOf(lockMatch[4], isNr ? "NR" : "LTE");
        if (isNr) nrCell = { locked: true, arfcn, pci, band: null };
        else lteCell = { locked: true, arfcn, pci, band: null };
      }

      return {
        lteBands: act?.lte ?? null,
        nrBands: act?.nr ?? null,
        lteCell,
        nrCell,
        networkMode: act ? (FIBOCOM_MODE_OF_RAT[act.rat] ?? null) : null,
        supportedLte: null,
        supportedNr: null,
      };
    }

    // Quectel Lock State
    const caps = await this.#ubus.execAt('AT+QNWPREFCFG="ue_capability_band"').catch(() => "");
    const lteCaps = caps.match(/"lte_band",\s*([0-9:]+)/)?.[1];
    const nrCaps = caps.match(/"nr5g_band",\s*([0-9:]+)/)?.[1];
    const prefLte = await this.#ubus.execAt('AT+QNWPREFCFG="lte_band"').catch(() => "");
    const prefNr = await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_band"').catch(() => "");
    const prefMode = await this.#ubus.execAt('AT+QNWPREFCFG="mode_pref"').catch(() => "");
    const prefDisable = await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_disable_mode"').catch(() => "");
    const lock4g = await this.#ubus.execAt('AT+QNWLOCK="common/4g"').catch(() => "");
    const lock5g = await this.#ubus.execAt('AT+QNWLOCK="common/5g"').catch(() => "");

    const lteRaw = prefLte.match(/\+QNWPREFCFG:\s*"lte_band",\s*([0-9:]+)/)?.[1];
    const nrRaw = prefNr.match(/\+QNWPREFCFG:\s*"nr5g_band",\s*([0-9:]+)/)?.[1];
    // A setting the module did not answer for is unknown, never "every band"
    const lteBands = lteRaw ? (lteCaps && lteRaw === lteCaps ? "all" : listToBands(lteRaw.replace(/:/g, ","))) : null;
    const nrBands = nrRaw ? (nrCaps && nrRaw === nrCaps ? "all" : listToBands(nrRaw.replace(/:/g, ","))) : null;

    let networkMode: DriverNetworkMode | null = null;
    const modeUpper = prefMode.toUpperCase();
    const disableVal = intOf(prefDisable.match(/\+QNWPREFCFG:\s*"nr5g_disable_mode",\s*(\d+)/)?.[1]);
    if (modeUpper.includes("AUTO")) networkMode = "auto";
    else if (modeUpper.includes("LTE:NR5G")) networkMode = disableVal === 1 ? "nr_nsa" : "auto";
    else if (modeUpper.includes("NR5G")) networkMode = disableVal === 2 ? "nr_sa" : "auto";
    else if (modeUpper.includes("LTE")) networkMode = "lte";

    const lteCell: CellLockState | null = parseQuectelLteCellLock(lock4g);

    let nrCell: CellLockState | null = lock5g.includes("+QNWLOCK:") ? { locked: false } : null;
    const nrLockMatch = lock5g.match(/\+QNWLOCK:\s*"common\/5g",\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
    if (nrLockMatch) {
      nrCell = { locked: true, pci: pciOf(nrLockMatch[1], "NR"), arfcn: intOf(nrLockMatch[2]), band: bandOf(nrLockMatch[4]) };
    }

    return {
      lteBands,
      nrBands,
      lteCell,
      nrCell,
      networkMode,
      supportedLte: null,
      supportedNr: null,
    };
  }

  async setBandLock(target: DriverBandLockTarget, check: WriteCheck): Promise<void> {
    this.#guard();
    if (!this.#identity) await this.initModem();

    const lte = target.lte === "all" ? "all" : checkLockBands("LTE", target.lte, null);
    const nr = target.nr === null || target.nr === "all" ? target.nr : checkLockBands("NR", target.nr, null);

    if (this.#brand === "fibocom") {
      // One command carries the RAT selection and every band: what is not asked for goes back as reported
      const mode = target.networkMode;
      if (mode !== null && FIBOCOM_RAT_OF_MODE[mode] === undefined) {
        throw new CpeControlValidationError("This module's AT+GTACT is documented for automatic (4G + 5G) and 5G standalone only: leave the network mode out, or pick one of those");
      }
      const current = parseFibocomAct(await this.#ubus.execAt("AT+GTACT?").catch(() => ""));
      const nrBands = nr ?? current?.nr ?? "all";
      const bands: number[] = [];
      if (lte !== "all") for (const b of lte) bands.push(100 + b);
      if (nrBands !== "all") for (const b of nrBands) bands.push(500 + b);
      const rat = mode !== null ? FIBOCOM_RAT_OF_MODE[mode] : (current?.rat ?? FIBOCOM_RAT_OF_MODE.auto);
      const prefix = `${rat},${current?.preferRat ?? 6},${current?.preferBand ?? 2}`;
      const gtactCmd = bands.length > 0 ? `AT+GTACT=${prefix},${bands.join(",")}` : `AT+GTACT=${prefix}`;
      noteSent(check, FAMILY, "AT+GTACT");
      const answer = await this.#ubus.execAt(gtactCmd);
      if (isAtError(answer)) throw new CpeApiError("at-error", "AT+GTACT refused the band lock");
      settleBandLock(check, { lte, nr, networkMode: mode }, await this.lockState().catch(() => null));
      return;
    }

    // Quectel Band Lock. "all" is the module's own capability list, written back as it reports it
    const wantsAll = lte === "all" || nr === "all";
    const caps = wantsAll ? await this.#ubus.execAt('AT+QNWPREFCFG="ue_capability_band"').catch(() => "") : "";
    const lteList = lte === "all" ? (caps.match(/"lte_band",\s*([0-9:]+)/)?.[1] ?? null) : bandsToList(lte, ":");
    const nrList = nr === null ? null : nr === "all" ? (caps.match(/"nr5g_band",\s*([0-9:]+)/)?.[1] ?? null) : bandsToList(nr, ":");
    if ((lte === "all" && lteList === null) || (nr === "all" && nrList === null)) {
      throw new CpeAnswerFormatError("The module named no capability band list to unlock to: nothing was written");
    }
    const send = async (label: string, cmd: string): Promise<void> => {
      noteSent(check, FAMILY, label);
      if (isAtError(await this.#ubus.execAt(cmd))) throw new CpeApiError("at-error", `${label} refused`);
    };
    if (lteList !== null) await send("AT+QNWPREFCFG/lte_band", `AT+QNWPREFCFG="lte_band",${lteList}`);
    if (nrList !== null) {
      await send("AT+QNWPREFCFG/nr5g_band", `AT+QNWPREFCFG="nr5g_band",${nrList}`);
      await send("AT+QNWPREFCFG/nsa_nr5g_band", `AT+QNWPREFCFG="nsa_nr5g_band",${nrList}`);
    }
    if (target.networkMode !== null) {
      const mode = QUECTEL_MODES[target.networkMode];
      if (mode.disable !== null) await send("AT+QNWPREFCFG/nr5g_disable_mode", `AT+QNWPREFCFG="nr5g_disable_mode",${mode.disable}`);
      await send("AT+QNWPREFCFG/mode_pref", `AT+QNWPREFCFG="mode_pref",${mode.pref}`);
    }
    settleBandLock(check, { lte, nr, networkMode: target.networkMode }, await this.lockState().catch(() => null));
  }

  async setCellLock(target: DriverCellLockTarget, check: WriteCheck): Promise<void> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    const checked = checkCellLock(target);

    if (this.#brand === "fibocom") {
      noteSent(check, FAMILY, "AT+GTCELLLOCK");
      let cmd = "";
      if (checked.rat === "LTE") {
        cmd = `AT+GTCELLLOCK=1,0,0,${checked.arfcn},${checked.pci}`;
      } else {
        cmd = `AT+GTCELLLOCK=1,1,0,${checked.arfcn},${checked.pci},${checked.scsKhz ?? 30}`;
      }
      const answer = await this.#ubus.execAt(cmd);
      if (answer.includes("ERROR")) throw new CpeApiError("at-error", `GTCELLLOCK failed: ${answer}`);
      settleCellLock(check, checked, await this.lockState().catch(() => null));
      return;
    }

    // Quectel Cell Lock
    if (checked.rat === "LTE") {
      const cmd = `AT+QNWLOCK="common/4g",1,${checked.arfcn},${checked.pci}`;
      noteSent(check, FAMILY, "AT+QNWLOCK/4g");
      const answer = await this.#ubus.execAt(cmd);
      if (answer.includes("ERROR")) throw new CpeApiError("at-error", `QNWLOCK 4G failed: ${answer}`);
    } else {
      const scs = checked.scsKhz ?? 30;
      const cmd = `AT+QNWLOCK="common/5g",${checked.pci},${checked.arfcn},${scs},${checked.band}`;
      noteSent(check, FAMILY, "AT+QNWLOCK/5g");
      const answer = await this.#ubus.execAt(cmd);
      if (answer.includes("ERROR")) throw new CpeApiError("at-error", `QNWLOCK 5G failed: ${answer}`);
    }
    settleCellLock(check, checked, await this.lockState().catch(() => null));
  }

  /**
   * Several LTE cells at once: a Quectel module's `AT+QNWLOCK="common/4g",<n>,<freq>,<pci>,...` (the
   * module then picks among them). Its 5G lock and Fibocom's cell lock take one cell: refused here,
   * before anything is sent.
   */
  async setCellLocks(targets: ReadonlyArray<DriverCellLockTarget>, check: WriteCheck): Promise<void> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    const checked = targets.map((target) => checkCellLock(target));
    if (this.#brand !== "quectel") throw new CpeControlValidationError("This module locks one cell at a time");
    if (checked.some((cell) => cell.rat !== "LTE")) throw new CpeControlValidationError("This module locks one 5G cell at a time; several cells are 4G only");
    noteSent(check, FAMILY, "AT+QNWLOCK/4g");
    const answer = await this.#ubus.execAt(`AT+QNWLOCK="common/4g",${checked.length},${checked.map((cell) => `${cell.arfcn},${cell.pci}`).join(",")}`);
    if (answer.includes("ERROR")) throw new CpeApiError("at-error", "QNWLOCK 4G refused the cells");
    settleCellLocks(check, checked, await this.lockState().catch(() => null));
  }

  async unlockAll(check: WriteCheck): Promise<void> {
    this.#guard();
    if (!this.#identity) await this.initModem();

    if (this.#brand === "fibocom") {
      noteSent(check, FAMILY, "AT+GTCELLLOCK");
      await this.#ubus.execAt("AT+GTCELLLOCK=0").catch(() => "");
      noteSent(check, FAMILY, "AT+GTACT");
      await this.#ubus.execAt("AT+GTACT=17,6,2").catch(() => "");
      settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: false });
      return;
    }

    // Quectel Unlock All
    noteSent(check, FAMILY, "AT+QNWLOCK/4g");
    await this.#ubus.execAt('AT+QNWLOCK="common/4g",0').catch(() => "");
    noteSent(check, FAMILY, "AT+QNWLOCK/5g");
    await this.#ubus.execAt('AT+QNWLOCK="common/5g",0').catch(() => "");

    // Restore full bands from factory capability if available
    const caps = await this.#ubus.execAt('AT+QNWPREFCFG="ue_capability_band"').catch(() => "");
    const lteCaps = caps.match(/"lte_band",\s*([0-9:]+)/)?.[1];
    const nrCaps = caps.match(/"nr5g_band",\s*([0-9:]+)/)?.[1];
    if (lteCaps) await this.#ubus.execAt(`AT+QNWPREFCFG="lte_band",${lteCaps}`).catch(() => "");
    if (nrCaps) {
      await this.#ubus.execAt(`AT+QNWPREFCFG="nr5g_band",${nrCaps}`).catch(() => "");
      await this.#ubus.execAt(`AT+QNWPREFCFG="nsa_nr5g_band",${nrCaps}`).catch(() => "");
    }
    await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_disable_mode",0').catch(() => "");
    await this.#ubus.execAt('AT+QNWPREFCFG="mode_pref",AUTO').catch(() => "");

    settleUnlock(check, await this.lockState().catch(() => null), { nr: true, mode: true });
  }

  /** SMS through the modem's own commands; the read state is FengSui's (a listing marks every message read). */
  /**
   * QModem's dial controls for its first modem (its rpcd object `qmodem`, each call naming the modem's
   * `config_section`): `modem_dial`, `modem_hang` and `modem_redial` answer `result.status` `1` when
   * done; `dial_status` says whether its dial worker runs (`running`, the data switch), and
   * `get_connect_status` whether the data connection is up (`connection_status` `Yes` / `No`). QModem's
   * dial worker owns the connection, so taking the network interface down would not end it; a router
   * without QModem has no dial control on record and is refused in the session, nothing sent.
   */
  async #dial(method: "modem_dial" | "modem_hang" | "modem_redial", check: WriteCheck): Promise<void> {
    this.#guard();
    const section = (await this.#ubus.qmodem())?.section ?? null;
    if (section === null) throw new CpeControlValidationError("This OpenWrt router has no QModem, the one dial control on record for these routers; nothing was sent to it");
    noteSent(check, FAMILY, `qmodem.${method}`);
    const answer = await this.#ubus.call("qmodem", method, { config_section: section });
    if (textOf(fieldOf(fieldOf(answer, "result"), "status")) !== "1") throw new CpeApiError("dial-refused", `qmodem.${method} failed`);
  }

  /** Whether QModem's dial worker runs (`null`: no QModem, or it did not say). */
  async #dialRunning(): Promise<boolean | null> {
    this.#guard();
    const section = (await this.#ubus.qmodem())?.section ?? null;
    if (section === null) return null;
    const running = textOf(fieldOf(await this.#ubus.call("qmodem", "dial_status", { config_section: section }), "running"));
    return running === "true" ? true : running === "false" ? false : null;
  }

  /** Whether QModem reports the data connection up (`null`: no QModem, or it did not say). */
  async #dataUp(): Promise<boolean | null> {
    const section = (await this.#ubus.qmodem())?.section ?? null;
    if (section === null) return null;
    const status = textOf(fieldOf(await this.#ubus.call("qmodem", "get_connect_status", { config_section: section }), "connection_status"));
    return status === "Yes" ? true : status === "No" ? false : null;
  }

  readonly data: DriverDataLink = {
    enabled: () => this.#dialRunning(),
    set: async (enabled, check, wait) => {
      await this.#dial(enabled ? "modem_dial" : "modem_hang", check);
      if (!enabled) await awaitConnection(() => this.#dataUp(), false, wait);
      settleDataSwitch(check, enabled, await this.#dialRunning().catch((): boolean | null => null));
    },
    redial: (check) => this.#dial("modem_redial", check),
  };

  readonly sms: DriverSms = {
    keepsSent: false,
    list: async () => (await this.#smsAssembled()).map((entry) => entry.message),
    counters: () => this.#smsCounters(),
    send: (phone, content, check, options) => this.#smsSend(phone, content, check, options),
    // A send needs QModem's PDU sender: a router without it reads and deletes only
    canSend: async () => (await this.#ubus.qmodem()) !== null,
    delete: (indices, check) => this.#smsDelete(indices, check),
  };

  /** The storage's own count: parts, not messages, and always this one read, so two counts never differ by how they were taken. */
  async #smsCounters(): Promise<SmsCounters> {
    this.#guard();
    const storage = parseCpms(await this.#ubus.execAt("AT+CPMS?"));
    if (!storage) throw new SectionUnavailableError("SMS", null);
    return { localUnread: 0, localInbox: storage.used, localOutbox: 0, localDraft: 0, localMax: storage.total > 0 ? storage.total : 50 };
  }

  async #smsAssembled(): Promise<AssembledSms[]> {
    this.#guard();
    // PDU mode for this port, then every stored message
    const mode = await this.#ubus.execAt("AT+CMGF=0");
    if (isAtError(mode)) throw new SectionUnavailableError("SMS", null);
    const listed = await this.#ubus.execAt("AT+CMGL=4");
    if (isAtError(listed)) throw new CpeApiError(atErrorCode(listed) ?? "at-error", "AT+CMGL refused");
    return assembleSegments(parseCmglPdus(listed));
  }

  /** One PDU per part through QModem's `send_raw_pdu`: `+CMGS` in its answer is the modem's word that the part went out. */
  async #smsSend(phone: string, content: string, check: WriteCheck, options: DriverSmsSendOptions): Promise<DriverSmsSendOutcome> {
    this.#guard();
    const qmodem = await this.#ubus.qmodem();
    if (!qmodem) {
      throw new CpeControlValidationError(
        "This router's AT service takes one command at a time, and sending an SMS takes two steps on a modem's AT port. FengSui sends where QModem is installed (its send_raw_pdu); reading and deleting work here. Nothing was sent"
      );
    }
    const { pdus } = encodeSmsSubmit(phone, content, crypto.randomInt(256));
    noteSent(check, FAMILY, "qmodem.send_raw_pdu");
    let confirmed = true;
    for (const [i, pdu] of pdus.entries()) {
      const answer = qmodemText(await this.#ubus.call("qmodem", "send_raw_pdu", { config_section: qmodem.section, cmd: pdu }));
      if (isAtError(answer)) return { state: "failed", code: atErrorCode(answer) };
      if (i === 0) options.onAccepted();
      if (!/\+CMGS:/i.test(answer)) confirmed = false;
    }
    return { state: confirmed ? "sent" : "unconfirmed", code: null };
  }

  /** Every stored part of each message, by `AT+CMGD`; the storage's count before and after is the read-back. */
  async #smsDelete(indices: ReadonlyArray<number>, check: WriteCheck): Promise<void> {
    const wanted = storedIndices(indices);
    const stored = await this.#smsAssembled();
    const parts = wanted.flatMap((index) => stored.find((entry) => entry.message.index === index)?.parts ?? []);
    // Already gone from the modem: nothing to send
    if (parts.length === 0) return;
    const before = parseCpms(await this.#ubus.execAt("AT+CPMS?").catch(() => ""))?.used ?? null;
    noteSent(check, FAMILY, "AT+CMGD");
    for (const handle of parts) {
      const answer = await this.#ubus.execAt(`AT+CMGD=${handle - 1}`);
      if (isAtError(answer)) throw new CpeApiError(atErrorCode(answer) ?? "at-error", "AT+CMGD refused");
    }
    const after = parseCpms(await this.#ubus.execAt("AT+CPMS?").catch(() => ""))?.used ?? null;
    settleSmsCount(check, before, after, parts.length);
  }

  /**
   * The cellular settings the module's own commands define: the network mode (Quectel's `mode_pref`,
   * Fibocom's `AT+GTACT`), the radio switch (`AT+CFUN`, 3GPP TS 27.007 §8.2), the card's PIN
   * (`AT+CPIN`, `AT+CLCK="SC"`, §8.3 and §7.4), the access point of the first PDP context
   * (`AT+CGDCONT`, §10.1.1; no user name or password: the notes name no command for them) and the
   * operator (`AT+COPS`, §7.3).
   */
  readonly cellular: DriverCellular = {
    read: () => this.#cellularRead(),
    setNetworkMode: (mode, check) => this.#setNetworkMode(mode, check),
    setAirplaneMode: async (enabled, check) => {
      this.#guard();
      await this.#atWrite(check, "AT+CFUN", `AT+CFUN=${enabled ? 4 : 1}`);
      const after = parseCfun(await this.#ubus.execAt("AT+CFUN?").catch(() => ""));
      settleCheck(check, after === null ? null : after === enabled);
    },
    enterPin: (pin, check) => this.#pinWrite(check, "AT+CPIN", `AT+CPIN="${pin}"`, async () => parseSimPin(await this.#ubus.execAt("AT+CPIN?").catch(() => ""), "").state === "ready"),
    setPinLock: (enabled, pin, check) =>
      this.#pinWrite(check, "AT+CLCK", `AT+CLCK="SC",${enabled ? 1 : 0},"${pin}"`, async () => {
        const status = /\+CLCK:\s*([01])/.exec(await this.#ubus.execAt('AT+CLCK="SC",2').catch(() => ""))?.[1];
        return status === undefined ? null : (status === "1") === enabled;
      }),
    setApn: (choice, check) => this.#setApn(choice.mode === "auto" ? { apn: "", ipType: null } : choice, check),
    restoreApn: async (restore, check) => {
      if (restore.mode !== "context") throw new CpeControlValidationError("This router keeps one access point in its module: there is no profile to switch back to");
      await this.#setApn({ apn: restore.apn, ipType: restore.ipType }, check);
    },
    scanOperators: (check) => this.#scanOperators(check),
    selectOperator: (selection, check) => this.#selectOperator(selection, check),
  };

  /** `AT+COPS=?`: the module answers when it has searched every band it may use, which takes it minutes. */
  async #scanOperators(check: WriteCheck): Promise<OperatorChoice[]> {
    this.#guard();
    settleNothingToRead(check);
    noteSent(check, FAMILY, "AT+COPS/search");
    const answer = await this.#ubus.execAt("AT+COPS=?", COPS_TIMEOUT_MS);
    if (isAtError(answer)) throw new CpeApiError(atErrorCode(answer) ?? "at-error", "AT+COPS=? refused");
    // An interface to the module that stops waiting before the module is done hands back nothing
    if (!answer.includes("+COPS:")) throw new CpeApiError("timeout", "The module did not answer the search for networks in the time the router waits for it");
    return parseCopsScan(answer);
  }

  /**
   * `AT+COPS=0` hands the choice back to the module. `AT+COPS=1,2,"<code>"[,<technology>]` keeps it on
   * one operator; the module answers once it is registered, or with an error once it gave up, and it
   * stays in the mode it was told either way.
   */
  async #selectOperator(selection: OperatorSelection, check: WriteCheck): Promise<void> {
    this.#guard();
    if (selection.mode === "auto") {
      await this.#atWrite(check, "AT+COPS", "AT+COPS=0", COPS_TIMEOUT_MS);
    } else {
      const act = operatorActOf(selection.rat);
      noteSent(check, FAMILY, "AT+COPS");
      const answer = await this.#ubus.execAt(`AT+COPS=1,2,"${selection.plmn}"${act === null ? "" : `,${act}`}`, COPS_TIMEOUT_MS);
      // A registration the module gave up on is a write that did not take: recorded as such, and watched like one
      if (isAtError(answer)) return settleCheck(check, false);
    }
    const after = parseCops(await this.#ubus.execAt("AT+COPS?").catch(() => ""));
    settleCheck(check, after === null ? null : selection.mode === "auto" ? after.mode === 0 : after.mode === 1 || after.mode === 4);
  }

  /** One AT command of a write: named in the record before it is sent, and an `ERROR` is the module refusing it. */
  async #atWrite(check: WriteCheck, label: string, command: string, timeoutMs?: number): Promise<void> {
    noteSent(check, FAMILY, label);
    const answer = await this.#ubus.execAt(command, timeoutMs);
    if (isAtError(answer)) throw new CpeApiError(atErrorCode(answer) ?? "at-error", `${label} refused`);
  }

  async #cellularRead(): Promise<DriverCellularState> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    const quectel = this.#brand === "quectel";
    let networkMode: NetworkMode | null;
    if (quectel) {
      networkMode = quectelModeOf(await this.#ubus.execAt('AT+QNWPREFCFG="mode_pref"').catch(() => ""), await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_disable_mode"').catch(() => ""));
    } else {
      const act = parseFibocomAct(await this.#ubus.execAt("AT+GTACT?").catch(() => ""));
      networkMode = act ? (FIBOCOM_MODE_OF_RAT[act.rat] ?? null) : null;
    }
    // The attempts left are read now, not from the minute-old copy the poll keeps: a PIN is sent by them
    const attempts = quectel ? parseSimPin("", await this.#ubus.execAt('AT+QPINC="SC"').catch(() => "")).pinAttemptsLeft : null;
    const context = parseCgdcont(await this.#ubus.execAt("AT+CGDCONT?").catch(() => ""));
    const cops = parseCops(await this.#ubus.execAt("AT+COPS?").catch(() => ""));
    return {
      networkMode,
      // Modes 2 (deregistered) and 3 (a format change) say nothing of how the module chooses
      ...(cops && (cops.mode === 0 || cops.mode === 1 || cops.mode === 4) ? { operator: { selection: cops.mode === 0 ? ("auto" as const) : ("manual" as const), plmn: cops.mode !== 0 && cops.format === 2 && isPlmn(cops.operator) ? cops.operator : null } } : {}),
      networkModes: [...(quectel ? QUECTEL_MODE_LIST : FIBOCOM_MODE_LIST)],
      pinAttemptsLeft: attempts,
      apn: context ? { mode: context.apn === "" ? "auto" : "manual", apn: context.apn === "" ? null : context.apn, ipType: context.ipType, auth: null, hasUsername: null } : null,
      apnRestore: context ? { mode: "context", apn: context.apn, ipType: context.ipType } : null,
    };
  }

  async #setNetworkMode(mode: NetworkMode, check: WriteCheck): Promise<void> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    if (this.#brand === "fibocom") {
      const rat = FIBOCOM_RAT_OF_MODE[mode as DriverNetworkMode];
      if (rat === undefined) throw new CpeControlValidationError("This module's AT+GTACT is documented for automatic (4G + 5G) and 5G standalone only");
      // One command carries the mode and every locked band: the bands go back as the module reports them
      const current = parseFibocomAct(await this.#ubus.execAt("AT+GTACT?").catch(() => ""));
      if (!current) throw new CpeAnswerFormatError("The module did not report its AT+GTACT setting, which the mode is written together with: nothing was sent");
      const bands = [...(current.lte === "all" ? [] : current.lte.map((b) => 100 + b)), ...(current.nr === "all" ? [] : current.nr.map((b) => 500 + b))];
      await this.#atWrite(check, "AT+GTACT", `AT+GTACT=${[rat, current.preferRat, current.preferBand, ...bands].join(",")}`);
      const after = parseFibocomAct(await this.#ubus.execAt("AT+GTACT?").catch(() => ""));
      settleCheck(check, after === null ? null : after.rat === rat);
      return;
    }
    const target = QUECTEL_SELECTABLE[mode];
    if (target === undefined) throw new CpeControlValidationError(`This module has no "${mode}" network mode`);
    if (target.disable !== null) await this.#atWrite(check, "AT+QNWPREFCFG/nr5g_disable_mode", `AT+QNWPREFCFG="nr5g_disable_mode",${target.disable}`);
    await this.#atWrite(check, "AT+QNWPREFCFG/mode_pref", `AT+QNWPREFCFG="mode_pref",${target.pref}`);
    const after = quectelModeOf(await this.#ubus.execAt('AT+QNWPREFCFG="mode_pref"').catch(() => ""), await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_disable_mode"').catch(() => ""));
    // `LTE` leaves the 5G switch as it was, so only the mode's own word is compared there
    settleCheck(check, after === null && mode !== "lte" ? null : after === mode);
  }

  /**
   * One PIN command, sent once. `OK` is the card taking the PIN; an error is the card refusing it:
   * an outcome, not a failure, and nothing follows it. The attempts left are read where the module
   * reports them (Quectel).
   */
  async #pinWrite(check: WriteCheck, label: string, command: string, settled: () => Promise<boolean | null>): Promise<SimPinOutcome> {
    this.#guard();
    if (!this.#identity) await this.initModem();
    noteSent(check, FAMILY, label);
    const took = !pinRefused(await this.#ubus.execAt(command));
    if (took) settleCheck(check, await settled().catch(() => null));
    else settleNothingToRead(check);
    // What the poll remembers of the card is a minute old at most: forget it, the PIN changed it
    SIM_READS.delete(this.#ubus.http.baseUrl);
    const attemptsLeft = this.#brand === "quectel" ? parseSimPin("", await this.#ubus.execAt('AT+QPINC="SC"').catch(() => "")).pinAttemptsLeft : null;
    return { accepted: took, attemptsLeft };
  }

  /** The first PDP context's access point and type; a type left out keeps the one the module has. */
  async #setApn(target: { apn: string; ipType: ApnIpType | null; auth?: string; username?: string; password?: string }, check: WriteCheck): Promise<void> {
    this.#guard();
    if (target.auth !== undefined && (target.auth !== "none" || target.username !== "" || target.password !== "")) {
      throw new CpeControlValidationError("This router's module takes an access point name and type only: FengSui has no command on record for its user name and password");
    }
    const current = parseCgdcont(await this.#ubus.execAt("AT+CGDCONT?").catch(() => ""));
    const ipType = target.ipType ?? current?.ipType ?? "ipv4v6";
    await this.#atWrite(check, "AT+CGDCONT", `AT+CGDCONT=1,"${PDP_TYPES[ipType]}","${target.apn}"`);
    const after = parseCgdcont(await this.#ubus.execAt("AT+CGDCONT?").catch(() => ""));
    settleCheck(check, after === null ? null : after.apn === target.apn && after.ipType === ipType);
  }

  async reboot(check: WriteCheck): Promise<void> {
    this.#guard();
    noteSent(check, FAMILY, "AT+CFUN");
    await this.#ubus.execAt("AT+CFUN=1,1").catch(() => "");
    settleRestart(check);
    this.#open = false;
  }

  async logout(): Promise<void> {
    if (!this.#open) return;
    this.#open = false;
    try {
      await this.#ubus.call("session", "destroy", {});
    } catch {
      // Session destroy on OpenWrt
    }
  }
}

// --------------------------------------------------------------------------
// Protocol Definition
// --------------------------------------------------------------------------

export const openwrtProtocol: DriverProtocol = {
  family: FAMILY,

  async detect(http: LanHttp): Promise<boolean> {
    try {
      await new OpenwrtUbusClient(http).call("system", "board", {});
      return true;
    } catch (err) {
      // "Access denied" to an anonymous caller is ubus speaking; anything else is not a ubus endpoint
      return err instanceof CpeApiError;
    }
  },

  async precheck(http: LanHttp): Promise<DriverPrecheck | null> {
    try {
      const ubus = new OpenwrtUbusClient(http);
      // Attempt anonymous RPC call to verify OpenWrt ubus endpoint reachability
      await ubus.call("system", "board", {});
      return { occupied: false, locked: null };
    } catch {
      return null;
    }
  },

  async login(http: LanHttp, credentials: DriverCredentials): Promise<DriverSessionHandle> {
    const ubus = new OpenwrtUbusClient(http);
    let answer: unknown;
    try {
      answer = await ubus.call("session", "login", {
        username: credentials.username || "root",
        password: credentials.password,
        timeout: 60,
      });
    } catch (err) {
      if (err instanceof CpeApiError && (err.code === "ubus-6" || err.code.includes("permission"))) {
        throw wrongPassword("the router refused the password (ubus status 6)");
      }
      throw err;
    }

    if (!isPlainObject(answer)) throw new DriverLoginMethodError("OpenWrt session.login returned invalid payload");
    const sessionToken = textOf(answer["ubus_rpc_session"]);
    if (!sessionToken || sessionToken === OPENWRT_ANONYMOUS_SESSION) {
      throw wrongPassword("the router refused the password or returned no session token");
    }

    ubus.session = sessionToken;
    const session = new OpenwrtSession(ubus);
    await session.initModem().catch(() => undefined);
    return session;
  },
};
