import crypto from "node:crypto";
import { type ApnIpType, type NetworkMode, type OperatorChoice, type OperatorSelection, type SimPinOutcome, isApnName, isPlmn } from "../cellular.ts";
import { CpeControlValidationError } from "../control-error.ts";
import { CpeAnswerFormatError, CpeApiError } from "../cpe-client.ts";
import { SectionUnavailableError } from "../cpe-domain.ts";
import type { WriteCheck } from "../device-access.ts";
import { type SimCardStatus, type SimState, type SystemStatus, type TemperatureSensor, countValue } from "../router-status.ts";
import { encodeSmsSubmit } from "../sms/pdu.ts";
import type { SmsCounters } from "../sms/types.ts";
import { atErrorCode, parseCmglPdus, parseCpms } from "./at-sms.ts";
import { bandsToList, checkCellLock, checkLockBands, listToBands } from "./bands.ts";
import { operatorActOf, parseCops, parseCopsScan, settleNothingToRead } from "./cellular.ts";
import type { DriverCredentials, DriverPrecheck, DriverProtocol } from "./client.ts";
import { DriverLoginMethodError, DriverSessionClosedError, wrongPassword } from "./login.ts";
import { awaitConnection, noteSent, settleBandLock, settleCellLock, settleDataSwitch, settleRestart, settleSetting, settleUnlock } from "./readback.ts";
import { type AssembledSms, assembleSegments, settleSmsCount, storedIndices } from "./sms.ts";
import { emptyCell } from "./snapshot.ts";
import type { LanHttp } from "./transport.ts";
import type {
  CellLockState,
  DriverBandLockTarget,
  DriverCarrier,
  DriverCell,
  DriverCellLockTarget,
  DriverCellular,
  DriverCellularState,
  DriverDataLink,
  DriverHost,
  DriverIdentity,
  DriverLockState,
  DriverNeighbour,
  DriverNetworkMode,
  DriverRat,
  DriverSessionHandle,
  DriverSms,
  DriverSmsSendOptions,
  DriverSmsSendOutcome,
  DriverTelemetry,
  DriverTraffic,
  ServingMode,
  SubcarrierSpacingKhz,
} from "./types.ts";
import {
  arfcnOf,
  bandOf,
  fieldOf,
  hexIntOf,
  iccidOf,
  identityOf,
  imeiOf,
  imsiOf,
  intOf,
  isPlainObject,
  labelOf,
  nonNegativeOf,
  numberOf,
  pciOf,
  plmnOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  textOf,
  txPowerOf,
} from "./values.ts";

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
export const OPENWRT_ANONYMOUS_SESSION = "00000000000000000000000000000000";

export type ModemBrand = "quectel" | "fibocom";

/** Quectel LTE DL/UL bandwidth code table (code -> MHz). */
export const QUECTEL_LTE_BANDWIDTH_MHZ: Readonly<Record<number, number>> = {
  0: 1.4,
  1: 3,
  2: 5,
  3: 10,
  4: 15,
  5: 20,
};

/** Quectel 5G NR DL bandwidth code table (code -> MHz). */
export const QUECTEL_NR_BANDWIDTH_MHZ: Readonly<Record<number, number>> = {
  0: 5,
  1: 10,
  2: 15,
  3: 20,
  4: 25,
  5: 30,
  6: 40,
  7: 50,
  8: 60,
  9: 80,
  10: 90,
  11: 100,
  12: 200,
  13: 400,
};

/** Quectel Subcarrier Spacing (SCS) code table (code -> kHz). */
export const QUECTEL_SCS_KHZ: Readonly<Record<number, SubcarrierSpacingKhz>> = {
  0: 15,
  1: 30,
  2: 60,
  3: 120,
  4: 240,
};

/** Quectel QCAINFO LTE Resource Block count table (RB -> MHz). */
export const QUECTEL_RB_TO_MHZ: Readonly<Record<number, number>> = {
  6: 1.4,
  15: 3,
  25: 5,
  50: 10,
  75: 15,
  100: 20,
};

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
 * The module's make from what `ATI` / `AT+CGMM` say, when they say: the maker's name, or a model
 * name of its series (Fibocom FM150 / FM160 / FM350 / FM650 / FG370...; Quectel RM5xx / RG5xx and
 * the EM / EG / EC / EP 4G series). `null` when neither names one (the session then probes).
 */
export function modemBrandOf(text: string): ModemBrand | null {
  // A series letter pair and three digits, whatever follows (`FM160-NA`, `RM520N-GL`, `EM120R-GL`)
  const upper = text.toUpperCase();
  if (upper.includes("FIBOCOM") || /\bF[MG]\d{3}/.test(upper)) return "fibocom";
  if (upper.includes("QUECTEL") || /\b(?:R[MG]|E[MGCP])\d{3}/.test(upper)) return "quectel";
  return null;
}

/** Identify whether the modem is Quectel or Fibocom from `ATI` or version query (Quectel when it says neither). */
export function detectModemBrand(atiText: string): ModemBrand {
  return modemBrandOf(atiText) ?? "quectel";
}

/** The answer to an AT command was an error (`ERROR`, `+CME ERROR: ...`, `+CMS ERROR: ...`): the command is not one of this module's. */
export function isAtError(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase())
    .some((line) => line === "ERROR" || line.startsWith("+CME ERROR") || line.startsWith("+CMS ERROR"));
}

/** Split a raw comma-separated AT line, stripping quotes and whitespace. */
export function splitAtCsv(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      parts.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current.trim());
  return parts;
}

/**
 * Convert Quectel LTE SINR raw index $X \in [0, 30]$ to true dB:
 * $\text{SINR}_{\text{dB}} = 2 \times X - 20$. Direct values outside 0..30 (or negative) stay untouched.
 */
export function quectelLteSinr(rawVal: unknown): number | null {
  const n = intOf(rawVal);
  if (n === null) return null;
  if (n >= 0 && n <= 30) return 2 * n - 20;
  return sinrOf(n);
}

// --------------------------------------------------------------------------
// Quectel AT Parsers
// --------------------------------------------------------------------------

export interface QuectelServingCellParsed {
  mode: "SA" | "NSA" | "LTE" | "NONE";
  plmn: string | null;
  lte: DriverCell | null;
  nr: DriverCell | null;
}

export function parseQuectelServingCell(text: string): QuectelServingCellParsed {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("+QENG:"));
  if (lines.length === 0) return { mode: "NONE", plmn: null, lte: null, nr: null };

  let saLine: string[] | null = null;
  let lteLine: string[] | null = null;
  let nsaNrLine: string[] | null = null;

  for (const rawLine of lines) {
    const content = rawLine.slice(7).trim(); // after "+QENG: "
    const fields = splitAtCsv(content);
    const tag = fields[0]?.toUpperCase();
    if (tag === "SERVINGCELL") {
      const subTag = fields[2]?.toUpperCase();
      if (subTag === "NR5G-SA") saLine = fields;
      else if (subTag === "LTE") lteLine = fields;
    } else if (tag === "LTE") {
      lteLine = fields;
    } else if (tag === "NR5G-NSA") {
      nsaNrLine = fields;
    }
  }

  // 1. 5G SA Mode
  if (saLine && saLine.length >= 15) {
    // fields: ["servingcell", state, "NR5G-SA", duplex, mcc, mnc, cellIdHex, pcid, tacHex, arfcn, band, bwCode, rsrp, rsrq, sinr, scs, srxlev]
    const mcc = saLine[4] ?? "";
    const mnc = saLine[5] ?? "";
    const plmn = plmnOf(mcc, mnc);
    const bwCode = intOf(saLine[11]);
    const bwMhz = bwCode !== null ? (QUECTEL_NR_BANDWIDTH_MHZ[bwCode] ?? null) : null;
    const nr: DriverCell = {
      ...emptyCell(),
      cellId: identityOf(saLine[6], 16),
      pci: pciOf(saLine[7], "NR"),
      tac: identityOf(saLine[8], 16),
      arfcn: arfcnOf(saLine[9], "NR"),
      band: bandOf(saLine[10]),
      bandwidthMhz: bwMhz,
      rsrpDbm: rsrpOf(saLine[12]),
      rsrqDb: rsrqOf(saLine[13]),
      sinrDb: sinrOf(saLine[14]),
    };
    return { mode: "SA", plmn, lte: null, nr };
  }

  // 2. 5G NSA Mode (EN-DC)
  if (lteLine && nsaNrLine) {
    const lteOffset = lteLine[0]?.toUpperCase() === "SERVINGCELL" ? 3 : 1;
    const mcc = lteLine[lteOffset + 1] ?? "";
    const mnc = lteLine[lteOffset + 2] ?? "";
    const plmn = plmnOf(mcc, mnc);
    const dlBwCode = intOf(lteLine[lteOffset + 8]);
    const lteBwMhz = dlBwCode !== null ? (QUECTEL_LTE_BANDWIDTH_MHZ[dlBwCode] ?? null) : null;
    const lte: DriverCell = {
      ...emptyCell(),
      cellId: identityOf(lteLine[lteOffset + 3], 16),
      pci: pciOf(lteLine[lteOffset + 4], "LTE"),
      arfcn: arfcnOf(lteLine[lteOffset + 5], "LTE"),
      band: bandOf(lteLine[lteOffset + 6]),
      bandwidthMhz: lteBwMhz,
      tac: identityOf(lteLine[lteOffset + 9], 16),
      rsrpDbm: rsrpOf(lteLine[lteOffset + 10]),
      rsrqDb: rsrqOf(lteLine[lteOffset + 11]),
      rssiDbm: rssiOf(lteLine[lteOffset + 12]),
      sinrDb: quectelLteSinr(lteLine[lteOffset + 13]),
      cqi: smallIntOf(lteLine[lteOffset + 14], 15),
      ...quectelLteUplink(lteLine, lteOffset),
    };

    // nsaNrLine: ["NR5G-NSA", mcc, mnc, pcid, rsrp, sinr, rsrq, arfcn, band, dlBwCode, scs]
    const nrDlBwCode = intOf(nsaNrLine[9]);
    const nrBwMhz = nrDlBwCode !== null ? (QUECTEL_NR_BANDWIDTH_MHZ[nrDlBwCode] ?? null) : null;
    const nr: DriverCell = {
      ...emptyCell(),
      pci: pciOf(nsaNrLine[3], "NR"),
      rsrpDbm: rsrpOf(nsaNrLine[4]),
      sinrDb: sinrOf(nsaNrLine[5]),
      rsrqDb: rsrqOf(nsaNrLine[6]),
      arfcn: arfcnOf(nsaNrLine[7], "NR"),
      band: bandOf(nsaNrLine[8]),
      bandwidthMhz: nrBwMhz,
    };
    return { mode: "NSA", plmn, lte, nr };
  }

  // 3. LTE Only Mode
  if (lteLine) {
    const lteOffset = lteLine[0]?.toUpperCase() === "SERVINGCELL" ? 3 : 1;
    const mcc = lteLine[lteOffset + 1] ?? "";
    const mnc = lteLine[lteOffset + 2] ?? "";
    const plmn = plmnOf(mcc, mnc);
    const dlBwCode = intOf(lteLine[lteOffset + 8]);
    const lteBwMhz = dlBwCode !== null ? (QUECTEL_LTE_BANDWIDTH_MHZ[dlBwCode] ?? null) : null;
    const lte: DriverCell = {
      ...emptyCell(),
      cellId: identityOf(lteLine[lteOffset + 3], 16),
      pci: pciOf(lteLine[lteOffset + 4], "LTE"),
      arfcn: arfcnOf(lteLine[lteOffset + 5], "LTE"),
      band: bandOf(lteLine[lteOffset + 6]),
      bandwidthMhz: lteBwMhz,
      tac: identityOf(lteLine[lteOffset + 9], 16),
      rsrpDbm: rsrpOf(lteLine[lteOffset + 10]),
      rsrqDb: rsrqOf(lteLine[lteOffset + 11]),
      rssiDbm: rssiOf(lteLine[lteOffset + 12]),
      sinrDb: quectelLteSinr(lteLine[lteOffset + 13]),
      cqi: smallIntOf(lteLine[lteOffset + 14], 15),
      ...quectelLteUplink(lteLine, lteOffset),
    };
    return { mode: "LTE", plmn, lte, nr: null };
  }

  return { mode: "NONE", plmn: null, lte: null, nr: null };
}

/**
 * The LTE line's uplink fields (notes library B §3.2, `+QENG: "LTE"`): `UL_bandwidth` (idx 8, the same
 * code as the downlink's) and `tx_power` (idx 16: tenths of a dBm when its magnitude is above 40).
 */
function quectelLteUplink(line: ReadonlyArray<string>, offset: number): Pick<DriverCell, "ulBandwidthMhz" | "puschTxDbm"> {
  const code = intOf(line[offset + 7]);
  const raw = numberOf(line[offset + 15]);
  return {
    ulBandwidthMhz: code !== null ? (QUECTEL_LTE_BANDWIDTH_MHZ[code] ?? null) : null,
    puschTxDbm: raw === null ? null : txPowerOf(Math.abs(raw) > 40 ? raw / 10 : raw),
  };
}

/**
 * `AT+QNWCFG="lte_csi"` / `"nr5g_csi"`: the channel state the module reports, `<mcs>,<ri>,<cqi>,<pmi>`
 * (notes library B §3.2, items 14–15): the MCS, the MIMO rank (layers) and the CQI of the downlink.
 */
export function parseQuectelCsi(text: string, kind: "lte_csi" | "nr5g_csi"): { mcs: number | null; layers: number | null; cqi: number | null } | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("+QNWCFG:")) continue;
    const fields = splitAtCsv(line.slice(8).trim());
    if (fields[0]?.toLowerCase() !== kind) continue;
    const csi = { mcs: smallIntOf(fields[1], 31), layers: smallIntOf(fields[2], 8), cqi: smallIntOf(fields[3], 15) };
    return csi.mcs === null && csi.layers === null && csi.cqi === null ? null : csi;
  }
  return null;
}

/** A cell with the CSI readings filled in where the serving-cell line left them empty. */
function withCsi(cell: DriverCell | null, csi: ReturnType<typeof parseQuectelCsi>): DriverCell | null {
  if (!cell || !csi) return cell;
  return { ...cell, dlMcs: cell.dlMcs ?? csi.mcs, mimoLayers: cell.mimoLayers ?? csi.layers, cqi: cell.cqi ?? csi.cqi };
}

/**
 * `AT+CFUN?` (3GPP TS 27.007 §8.2): `1` full functionality; `4` (transmit and receive off, the
 * "airplane mode") and `0` (minimum functionality) leave the radio off. `null` for anything else.
 */
export function parseCfun(text: string): boolean | null {
  const match = /\+CFUN:\s*(\d+)/.exec(text);
  if (!match?.[1]) return null;
  const fun = Number(match[1]);
  return fun === 1 ? false : fun === 0 || fun === 4 ? true : null;
}

/**
 * The SIM card through the module: `AT+CPIN?` (3GPP TS 27.007 §8.3: `READY`, `SIM PIN`, `SIM PUK`),
 * `AT+QPINC="SC"` on Quectel (its AT manual: `+QPINC: "SC",<PIN tries left>,<PUK tries left>`).
 */
export function parseSimPin(cpin: string, qpinc: string): Pick<SimCardStatus, "state" | "pinAttemptsLeft" | "pukAttemptsLeft"> {
  const code = /\+CPIN:\s*([A-Z0-9 -]+)/i.exec(cpin)?.[1]?.trim().toUpperCase() ?? null;
  const state: SimState | null =
    code === "READY" ? "ready" : code === "SIM PIN" ? "pin_required" : code === "SIM PUK" ? "puk_required" : /\+CME ERROR:\s*(10|13)\b/.test(cpin) ? (/\b10\b/.test(cpin) ? "absent" : "error") : null;
  const counts = /\+QPINC:\s*"SC"\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(qpinc);
  return { state, pinAttemptsLeft: countValue(counts?.[1], 10), pukAttemptsLeft: countValue(counts?.[2], 10) };
}

/** The first line of an AT answer that is only digits (`AT+CGSN`, `AT+CIMI`), else what follows its `+CGSN:` / `+QCCID:` prefix. */
export function atValueLine(text: string, prefix: string | null): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (prefix && line.toUpperCase().startsWith(prefix)) return line.slice(prefix.length).trim().replace(/^"|"$/g, "");
    if (/^\d{6,22}F?$/i.test(line)) return line;
  }
  return null;
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

/** A QTEMP sensor name as the console may show it (a short token), and what it measures where the name says. */
function qtempSensor(name: string, celsius: number): TemperatureSensor {
  const token = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  const kind: TemperatureSensor["kind"] = /(^|[-_])pa\d*([-_]|$)|pa-thermal/.test(token)
    ? "pa"
    : /modem|mdm|q6/.test(token)
      ? "modem"
      : /cpu|soc|apc/.test(token)
        ? "cpu"
        : /pmic|xo|board|sdr/.test(token)
          ? "board"
          : "other";
  return { kind, name: kind === "other" ? token || null : null, celsius };
}

/** Each named `+QTEMP:` sensor (`"<name>",<°C>`); a module that names none reports only the hottest. */
export function parseQuectelTempSensors(text: string): TemperatureSensor[] {
  const out: TemperatureSensor[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /\+QTEMP:\s*"([^"]{1,64})"\s*,\s*"?(-?\d+(?:\.\d+)?)/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const celsius = temperatureOf(match[2]);
    if (celsius !== null) out.push(qtempSensor(match[1], celsius));
  }
  return out.slice(0, 16);
}

export function parseQuectelCaInfo(text: string): DriverCarrier[] {
  const carriers: DriverCarrier[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("+QCAINFO:"));
  for (const rawLine of lines) {
    const content = rawLine.slice(9).trim(); // after "+QCAINFO: "
    const fields = splitAtCsv(content);
    if (fields.length < 5) continue;
    const type = fields[0]?.toUpperCase(); // "PCC" or "SCC"
    if (type !== "SCC") continue; // secondary carriers only
    const arfcnRaw = fields[1];
    const bwRaw = intOf(fields[2]);
    const bandRaw = fields[3] ?? "";
    const pciRaw = fields[5];
    const rsrpRaw = fields[6];
    const rsrqRaw = fields[7];
    const rssiRaw = fields[8];
    const sinrRaw = fields[9];

    const isNr = bandRaw.toUpperCase().includes("NR5G");
    const rat: DriverRat = isNr ? "NR" : "LTE";
    let bwMhz: number | null = null;
    if (bwRaw !== null) {
      if (isNr) bwMhz = QUECTEL_NR_BANDWIDTH_MHZ[bwRaw] ?? bwRaw;
      else bwMhz = QUECTEL_RB_TO_MHZ[bwRaw] ?? bwRaw;
    }

    carriers.push({
      rat,
      arfcn: arfcnOf(arfcnRaw, rat),
      band: bandOf(bandRaw),
      bandwidthMhz: bwMhz,
      pci: pciOf(pciRaw, rat),
      rsrpDbm: rsrpOf(rsrpRaw),
      rsrqDb: rsrqOf(rsrqRaw),
      rssiDbm: rssiOf(rssiRaw),
      sinrDb: isNr ? sinrOf(sinrRaw) : quectelLteSinr(sinrRaw),
    });
  }
  return carriers;
}

export function parseQuectelNeighbours(text: string): DriverNeighbour[] {
  const neighbours: DriverNeighbour[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("+QENG:"));
  for (const rawLine of lines) {
    const content = rawLine.slice(7).trim();
    const fields = splitAtCsv(content);
    const tag = fields[0]?.toLowerCase();
    if (!tag || !tag.includes("neighbourcell")) continue;
    const ratStr = (fields[1] ?? "").toUpperCase();
    const isNr = ratStr.includes("NR") || ratStr.includes("5G");
    const rat: DriverRat = isNr ? "NR" : "LTE";
    if (isNr) {
      // "+QENG: neighbourcell,NR5G,arfcn,pci,rsrp,rsrq,sinr"
      const arfcn = arfcnOf(fields[2], "NR");
      const pci = pciOf(fields[3], "NR");
      const rsrpDbm = rsrpOf(fields[4]);
      const rsrqDb = rsrqOf(fields[5]);
      const sinrDb = sinrOf(fields[6]);
      if (arfcn !== null || pci !== null) neighbours.push({ rat, arfcn, pci, band: null, rsrpDbm, rsrqDb, rssiDbm: null, sinrDb });
    } else {
      // "+QENG: neighbourcell intra,LTE,earfcn,pci,rsrp,rsrq,rssi,sinr"
      const arfcn = arfcnOf(fields[2], "LTE");
      const pci = pciOf(fields[3], "LTE");
      const rsrpDbm = rsrpOf(fields[4]);
      const rsrqDb = rsrqOf(fields[5]);
      const rssiDbm = rssiOf(fields[6]);
      const sinrDb = quectelLteSinr(fields[7]);
      if (arfcn !== null || pci !== null) neighbours.push({ rat, arfcn, pci, band: null, rsrpDbm, rsrqDb, rssiDbm, sinrDb });
    }
  }
  return neighbours;
}

export function parseQuectelRsrp(text: string): Array<number | null> | null {
  const match = text.match(/\+QRSRP:\s*(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
  if (!match) return null;
  const chains = [rsrpOf(match[1]), rsrpOf(match[2]), rsrpOf(match[3]), rsrpOf(match[4])];
  return chains.some((v) => v !== null) ? chains : null;
}

/** `AT+GTACT`'s RAT selection as the modes FengSui names (the two the command is documented for). */
const FIBOCOM_RAT_OF_MODE: Readonly<Partial<Record<DriverNetworkMode, number>>> = { auto: 17, nr_sa: 14 };
const FIBOCOM_MODE_OF_RAT: Readonly<Record<number, DriverNetworkMode>> = { 17: "auto", 14: "nr_sa" };

/** `mode_pref` and `nr5g_disable_mode` of each network mode (`disable: null`: left as it is). */
const QUECTEL_MODES: Readonly<Record<DriverNetworkMode, { pref: string; disable: number | null }>> = {
  auto: { pref: "AUTO", disable: 0 },
  nr_sa: { pref: "NR5G", disable: 2 },
  nr_nsa: { pref: "LTE:NR5G", disable: 1 },
  lte: { pref: "LTE", disable: null },
};

/** `mode_pref` and `nr5g_disable_mode` of each mode the network mode setting writes: the four above, and 3G only (`WCDMA`, notes library B). */
const QUECTEL_SELECTABLE: Readonly<Partial<Record<NetworkMode, { pref: string; disable: number | null }>>> = { ...QUECTEL_MODES, wcdma: { pref: "WCDMA", disable: null } };
const QUECTEL_MODE_LIST: ReadonlyArray<NetworkMode> = ["auto", "nr_sa", "nr_nsa", "lte", "wcdma"];
const FIBOCOM_MODE_LIST: ReadonlyArray<NetworkMode> = ["auto", "nr_sa"];

/**
 * The mode a Quectel module is set to: the exact `mode_pref` value, with `nr5g_disable_mode` telling
 * 5G standalone from 5G with a 4G anchor (`null`: a value the notes do not list).
 */
export function quectelModeOf(prefMode: string, prefDisable: string): NetworkMode | null {
  const pref = /\+QNWPREFCFG:\s*"mode_pref"\s*,\s*([A-Z0-9:]{1,32})/i.exec(prefMode)?.[1]?.toUpperCase();
  const disable = /\+QNWPREFCFG:\s*"nr5g_disable_mode"\s*,\s*(\d)/i.exec(prefDisable)?.[1];
  if (pref === "AUTO") return "auto";
  if (pref === "WCDMA") return "wcdma";
  if (pref === "LTE") return "lte";
  if (pref === "NR5G") return disable === "2" ? "nr_sa" : null;
  if (pref === "LTE:NR5G") return disable === "1" ? "nr_nsa" : null;
  return null;
}

const PDP_TYPES: Readonly<Record<ApnIpType, string>> = { ipv4: "IP", ipv6: "IPV6", ipv4v6: "IPV4V6" };

/**
 * `AT+CGDCONT?` (3GPP TS 27.007 §10.1.1): `+CGDCONT: <cid>,"<PDP_type>","<APN>",…`. The context `cid`
 * as the access point in use (an empty APN is the one the network assigns); `null` when it is not listed.
 */
export function parseCgdcont(text: string, cid = 1): { apn: string; ipType: ApnIpType } | null {
  for (const raw of text.slice(0, 4096).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith("+CGDCONT:")) continue;
    const fields = splitAtCsv(line.slice("+CGDCONT:".length));
    if (fields[0] !== String(cid)) continue;
    const type = (fields[1] ?? "").toUpperCase();
    const ipType = (Object.entries(PDP_TYPES) as Array<[ApnIpType, string]>).find(([, name]) => name === type)?.[0];
    const apn = fields[2] ?? "";
    return ipType === undefined || (apn !== "" && !isApnName(apn)) ? null : { apn, ipType };
  }
  return null;
}

/** `+CME ERROR: 16` / `12`: the card says the PIN is wrong (3GPP TS 27.007 §9.2), or wants its PUK. */
function pinRefused(answer: string): boolean {
  return isAtError(answer);
}

/**
 * `+GTACT: <rat>,<prefer_rat>,<prefer_band>[,<band>…]`: LTE bands as 100 + band, NR bands as 500 +
 * band; a RAT with no band listed has every band. `null` when the answer is not one.
 */
export function parseFibocomAct(raw: string): { rat: number; preferRat: number; preferBand: number; lte: number[] | "all"; nr: number[] | "all" } | null {
  const match = /\+GTACT:\s*([0-9]{1,3}(?:\s*,\s*[0-9]{1,4}){2,80})/.exec(raw.slice(0, 1024));
  if (!match?.[1]) return null;
  const nums = match[1].split(",").map((n) => Number.parseInt(n.trim(), 10));
  const [rat, preferRat, preferBand, ...bands] = nums;
  if (rat === undefined || preferRat === undefined || preferBand === undefined) return null;
  const lte = bands.filter((n) => n > 100 && n < 200).map((n) => n - 100);
  const nr = bands.filter((n) => n > 500 && n < 1000).map((n) => n - 500);
  return { rat, preferRat, preferBand, lte: lte.length > 0 ? lte : "all", nr: nr.length > 0 ? nr : "all" };
}

/** How long a search for networks or a registration may take the module (the modules' manuals give `AT+COPS` three minutes). */
const COPS_TIMEOUT_MS = 180_000;

const COPS_LINE = /\+COPS:\s*\d\s*,\s*([012])\s*,\s*"([^"\r\n]{1,64})"/;

/**
 * The operator of `AT+COPS?` (`+COPS: <mode>,<format>,"<oper>"[,<AcT>]`, 3GPP TS 27.007): the name in
 * the long or short alphanumeric format; `null` for the numeric format (a PLMN, not a name) or no
 * registration.
 */
export function parseOperatorName(raw: string): string | null {
  const match = COPS_LINE.exec(raw.slice(0, 512));
  if (!match || match[1] === "2") return null;
  return labelOf(match[2]);
}

export function parseQuectelTemp(text: string): number | null {
  const lines = text.split(/\r?\n/);
  const temps: number[] = [];
  for (const line of lines) {
    const match = line.match(/\+QTEMP:\s*(?:"[^"]+",)?(-?\d+(?:\.\d+)?)/);
    if (match && match[1]) {
      const t = temperatureOf(match[1]);
      if (t !== null) temps.push(t);
    }
  }
  if (temps.length === 0) return null;
  // Pick highest reasonable temperature reported among sensors
  return Math.max(...temps);
}

/**
 * A Quectel packet data counter (`+QGDCNT:` for 4G, `+QGDNRCNT:` for 5G): bytes sent, then bytes
 * received, as the module's AT manual orders them; `null` when the answer names no such line.
 */
export function parseQuectelDataCounter(text: string, prefix: "+QGDCNT:" | "+QGDNRCNT:"): { sent: bigint; received: bigint } | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(prefix)) continue;
    const [sent, received] = line.slice(prefix.length).split(",").map((part) => part.trim());
    if (sent === undefined || received === undefined || !/^\d{1,20}$/.test(sent) || !/^\d{1,20}$/.test(received)) return null;
    return { sent: BigInt(sent), received: BigInt(received) };
  }
  return null;
}

/** The counter a Quectel module keeps for the mode it is in: 4G alone counts on `QGDCNT`, anything with 5G on `QGDNRCNT`. */
function quectelCounterOf(mode: ServingMode | null): { command: string; prefix: "+QGDCNT:" | "+QGDNRCNT:" } | null {
  if (mode === "LTE") return { command: "AT+QGDCNT?", prefix: "+QGDCNT:" };
  if (mode === "SA" || mode === "NSA") return { command: "AT+QGDNRCNT?", prefix: "+QGDNRCNT:" };
  return null;
}

/** Running totals of one counter, as FengSui derives rates from them (the module reports no rate). */
function counterTraffic(counter: { sent: bigint; received: bigint }, source: string): DriverTraffic {
  return {
    downloadBytesPerSec: null,
    uploadBytesPerSec: null,
    totalDownloadBytes: counter.received,
    totalUploadBytes: counter.sent,
    sessionDownloadBytes: null,
    sessionUploadBytes: null,
    sessionSeconds: null,
    monthDownloadBytes: null,
    monthUploadBytes: null,
    monthTotalBytes: null,
    monthSeconds: null,
    counterSource: source,
  };
}

// --------------------------------------------------------------------------
// Fibocom AT Parsers
// --------------------------------------------------------------------------

/** LTE channel bandwidths in resource blocks, as Fibocom's carrier list writes them, and their width in MHz. */
const LTE_RB_MHZ: Readonly<Record<string, number>> = { "6": 1.4, "15": 3, "25": 5, "50": 10, "75": 15, "100": 20 };

/** A Fibocom band code: `100 + band` for LTE, `500 + band` (or `5000 + band`) for NR. */
function fibocomBandOf(code: string | undefined): { rat: DriverRat; band: number } | null {
  if (code === undefined || !/^\d{3,4}$/.test(code)) return null;
  const n = Number.parseInt(code, 10);
  const found: { rat: DriverRat; band: number } | null = n > 100 && n < 200 ? { rat: "LTE", band: n - 100 } : n >= 5000 ? { rat: "NR", band: n - 5000 } : n > 500 && n < 1000 ? { rat: "NR", band: n - 500 } : null;
  return found && bandOf(found.band) !== null ? found : null;
}

/**
 * The secondary carriers of `AT+GTCAINFO?`: one `SCC <n>:` line each, `state, ul_cfg, band, pci,
 * earfcn, dl_bw, ul_bw, dl_mimo, ul_mimo, dl_mod, ul_mod, rsrp`, and only those whose state is `2`
 * (activated). The `PCC:` line is the serving cell `AT+GTCCINFO?` already gave. An LTE carrier's
 * bandwidth is in resource blocks; an NR carrier's is coded differently from one firmware to the
 * next, so it is left out. The RSRP is in dBm.
 */
export function parseFibocomCaInfo(text: string): DriverCarrier[] {
  const carriers: DriverCarrier[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith("SCC")) continue;
    const colon = line.indexOf(":");
    if (colon < 0 || !/^SCC\s?\d{1,2}$/i.test(line.slice(0, colon).trim())) continue;
    const fields = line.slice(colon + 1).split(",").map((field) => field.trim());
    if (fields.length < 7 || fields[0] !== "2") continue;
    const band = fibocomBandOf(fields[2]);
    if (!band) continue;
    carriers.push({
      rat: band.rat,
      band: band.band,
      arfcn: arfcnOf(fields[4], band.rat),
      pci: pciOf(fields[3], band.rat),
      bandwidthMhz: band.rat === "LTE" ? (LTE_RB_MHZ[fields[5] ?? ""] ?? null) : null,
      rsrpDbm: fields.length >= 12 ? rsrpOf(fields.at(-1)) : null,
      rsrqDb: null,
      rssiDbm: null,
      sinrDb: null,
    });
  }
  return carriers;
}

export interface FibocomCcInfoParsed {
  mode: "SA" | "NSA" | "LTE" | "NONE";
  plmn: string | null;
  lte: DriverCell | null;
  nr: DriverCell | null;
  neighbours: DriverNeighbour[];
}

export function parseFibocomCcInfo(text: string): FibocomCcInfoParsed {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("+GTCCINFO:") || /^[12],\d+,/.test(l));
  let lte: DriverCell | null = null;
  let nr: DriverCell | null = null;
  const neighbours: DriverNeighbour[] = [];
  let plmn: string | null = null;

  for (const rawLine of lines) {
    const cleaned = rawLine.startsWith("+GTCCINFO:") ? rawLine.slice(10).trim() : rawLine;
    const fields = splitAtCsv(cleaned);
    if (fields.length < 8) continue;
    const isServing = fields[0] === "1";
    const ratType = fields[1]; // "4" = LTE, "9" = NR
    const isNr = ratType === "9";
    const rat: DriverRat = isNr ? "NR" : "LTE";

    const mcc = fields[2] ?? "";
    const mnc = fields[3] ?? "";
    if (isServing && plmn === null) plmn = plmnOf(mcc, mnc);

    const tac = identityOf(fields[4], 16);
    const cellId = identityOf(fields[5], 16);
    const arfcn = arfcnOf(hexIntOf(fields[6]) ?? fields[6], rat);
    const pci = pciOf(hexIntOf(fields[7]) ?? fields[7], rat);

    const rssi = rssiOf(fields[8]);
    const rsrq = rsrqOf(fields[9]);
    const rawRsrp = intOf(fields[10]);
    // LTE RSRP: idx - 140 dBm; NR RSRP: idx - 156 dBm
    const rsrpDbm = rawRsrp !== null ? rsrpOf(isNr ? rawRsrp - 156 : rawRsrp - 140) : null;
    const sinrDb = sinrOf(fields[11]);

    if (isServing) {
      const cell: DriverCell = {
        ...emptyCell(),
        cellId,
        tac,
        arfcn,
        pci,
        rssiDbm: rssi,
        rsrqDb: rsrq,
        rsrpDbm,
        sinrDb,
      };
      if (isNr) nr = cell;
      else lte = cell;
    } else {
      neighbours.push({
        rat,
        arfcn,
        pci,
        band: null,
        rsrpDbm,
        rsrqDb: rsrq,
        rssiDbm: rssi,
        sinrDb,
      });
    }
  }

  let mode: "SA" | "NSA" | "LTE" | "NONE" = "NONE";
  if (lte && nr) mode = "NSA";
  else if (nr) mode = "SA";
  else if (lte) mode = "LTE";

  return { mode, plmn, lte, nr, neighbours };
}

/** The first line of an `ATI` / `AT+CGMM` answer that names the module rather than its maker (or `OK`). */
function modelLineOf(text: string): string | null {
  return labelOf(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "" && line.toUpperCase() !== "OK" && !line.toUpperCase().includes("QUECTEL") && !line.toUpperCase().includes("FIBOCOM"))
  );
}

// --------------------------------------------------------------------------
// OpenWrt ubus JSON-RPC Helper
// --------------------------------------------------------------------------

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

class OpenwrtUbusClient {
  readonly #http: LanHttp;
  #id = 1;
  session = OPENWRT_ANONYMOUS_SESSION;
  #resolvedModemRpc: UbusRpcCallTarget | null = null;
  /** QModem's modem section and AT port (`undefined`: not looked for yet; `null`: no QModem here). */
  #qmodem: QmodemTarget | null | undefined = undefined;
  #atViaQmodem = false;

  constructor(http: LanHttp) {
    this.#http = http;
  }

  /** The router's connection (what per-router reads are kept by). */
  get http(): LanHttp {
    return this.#http;
  }

  async call(object: string, method: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const id = this.#id++;
    const answer = await this.#http.postJson(
      UBUS_PATH,
      {
        jsonrpc: "2.0",
        id,
        method: "call",
        params: [this.session, object, method, args],
      },
      timeoutMs === undefined ? {} : { timeoutMs }
    );
    if (!isPlainObject(answer)) throw new CpeAnswerFormatError(`${object}.${method}: invalid JSON-RPC response`);
    const error = fieldOf(answer, "error");
    if (isPlainObject(error)) {
      throw new CpeApiError(`rpc-${intOf(fieldOf(error, "code")) ?? "error"}`, `${object}.${method} failed: ${textOf(fieldOf(error, "message")) ?? "RPC error"}`);
    }
    const result = fieldOf(answer, "result");
    if (!Array.isArray(result) || typeof result[0] !== "number") {
      throw new CpeAnswerFormatError(`${object}.${method}: missing result array`);
    }
    const status = result[0];
    if (status !== 0) {
      if (status === 6) throw wrongPassword("permission denied (ubus status 6)");
      throw new CpeApiError(`ubus-${status}`, `${object}.${method} error status ${status}`);
    }
    return result[1];
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

    let lteCell: CellLockState | null = lock4g.includes("+QNWLOCK:") ? { locked: false } : null;
    const lteLockMatch = lock4g.match(/\+QNWLOCK:\s*"common\/4g",\s*1,\s*(\d+),\s*(\d+)/);
    if (lteLockMatch) {
      lteCell = { locked: true, arfcn: intOf(lteLockMatch[1]), pci: pciOf(lteLockMatch[2], "LTE"), band: null };
    }

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
      settleSetting(check, after === null ? null : after === enabled);
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
      if (isAtError(answer)) return settleSetting(check, false);
    }
    const after = parseCops(await this.#ubus.execAt("AT+COPS?").catch(() => ""));
    settleSetting(check, after === null ? null : selection.mode === "auto" ? after.mode === 0 : after.mode === 1 || after.mode === 4);
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
      settleSetting(check, after === null ? null : after.rat === rat);
      return;
    }
    const target = QUECTEL_SELECTABLE[mode];
    if (target === undefined) throw new CpeControlValidationError(`This module has no "${mode}" network mode`);
    if (target.disable !== null) await this.#atWrite(check, "AT+QNWPREFCFG/nr5g_disable_mode", `AT+QNWPREFCFG="nr5g_disable_mode",${target.disable}`);
    await this.#atWrite(check, "AT+QNWPREFCFG/mode_pref", `AT+QNWPREFCFG="mode_pref",${target.pref}`);
    const after = quectelModeOf(await this.#ubus.execAt('AT+QNWPREFCFG="mode_pref"').catch(() => ""), await this.#ubus.execAt('AT+QNWPREFCFG="nr5g_disable_mode"').catch(() => ""));
    // `LTE` leaves the 5G switch as it was, so only the mode's own word is compared there
    settleSetting(check, after === null && mode !== "lte" ? null : after === mode);
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
    if (took) settleSetting(check, await settled().catch(() => null));
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
    settleSetting(check, after === null ? null : after.apn === target.apn && after.ipType === ipType);
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
