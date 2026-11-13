import { splitAtCsv } from "./common.ts";
import type { NetworkMode } from "../../cellular.ts";
import type { TemperatureSensor } from "../../router-status.ts";
import { emptyCell } from "../../drivers/snapshot.ts";
import type {
  DriverCarrier,
  DriverCell,
  DriverNeighbour,
  DriverNetworkMode,
  DriverRat,
  DriverTraffic,
  ServingMode,
  SubcarrierSpacingKhz,
} from "../../drivers/types.ts";
import {
  arfcnOf,
  bandOf,
  identityOf,
  intOf,
  numberOf,
  pciOf,
  plmnOf,
  rsrpOf,
  rsrqOf,
  rssiOf,
  sinrOf,
  smallIntOf,
  temperatureOf,
  txPowerOf,
} from "../../drivers/values.ts";


/**
 * Quectel modules' own AT commands (RM500, RM520, RG500, RG520, RM551…): serving cell, carriers,
 * neighbours, per-antenna readings, temperatures, data counters, network mode. Parsers only: how a
 * command reaches the module is the router's (its driver's) business.
 */

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
export function quectelLteUplink(line: ReadonlyArray<string>, offset: number): Pick<DriverCell, "ulBandwidthMhz" | "puschTxDbm"> {
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
export function withCsi(cell: DriverCell | null, csi: ReturnType<typeof parseQuectelCsi>): DriverCell | null {
  if (!cell || !csi) return cell;
  return { ...cell, dlMcs: cell.dlMcs ?? csi.mcs, mimoLayers: cell.mimoLayers ?? csi.layers, cqi: cell.cqi ?? csi.cqi };
}

/** A QTEMP sensor name as the console may show it (a short token), and what it measures where the name says. */
export function qtempSensor(name: string, celsius: number): TemperatureSensor {
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

/** `mode_pref` and `nr5g_disable_mode` of each network mode (`disable: null`: left as it is). */
export const QUECTEL_MODES: Readonly<Record<DriverNetworkMode, { pref: string; disable: number | null }>> = {
  auto: { pref: "AUTO", disable: 0 },
  nr_sa: { pref: "NR5G", disable: 2 },
  nr_nsa: { pref: "LTE:NR5G", disable: 1 },
  lte: { pref: "LTE", disable: null },
};

/** `mode_pref` and `nr5g_disable_mode` of each mode the network mode setting writes: the four above, and 3G only (`WCDMA`, notes library B). */
export const QUECTEL_SELECTABLE: Readonly<Partial<Record<NetworkMode, { pref: string; disable: number | null }>>> = { ...QUECTEL_MODES, wcdma: { pref: "WCDMA", disable: null } };

export const QUECTEL_MODE_LIST: ReadonlyArray<NetworkMode> = ["auto", "nr_sa", "nr_nsa", "lte", "wcdma"];

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
export function quectelCounterOf(mode: ServingMode | null): { command: string; prefix: "+QGDCNT:" | "+QGDNRCNT:" } | null {
  if (mode === "LTE") return { command: "AT+QGDCNT?", prefix: "+QGDCNT:" };
  if (mode === "SA" || mode === "NSA") return { command: "AT+QGDNRCNT?", prefix: "+QGDNRCNT:" };
  return null;
}

/** Running totals of one counter, as FengSui derives rates from them (the module reports no rate). */
export function counterTraffic(counter: { sent: bigint; received: bigint }, source: string): DriverTraffic {
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
