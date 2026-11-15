import { type DriverCarrier, type DriverCell, emptyCell } from "../../protocols/readings.ts";
import { arfcnOf, bandOf, counterOf, identityOf, intOf, ipv4Of, labelOf, nonNegativeOf, numberOf, pciOf, rsrpOf, rsrqOf, rssiOf, sinrOf, smallIntOf, textOf } from "../../protocols/values.ts";
import type { SimState } from "../../router-status.ts";
import type { SmsWireMessage } from "../../sms/types.ts";
import { dateOfParts, wireMessage } from "../sms.ts";
import { cellHasData } from "../snapshot.ts";
import type { DriverHost, DriverTelemetry } from "../types.ts";
import { instance, instances, type TplinkResult } from "./frames.ts";

/**
 * What a TP-Link cellular router's data model answers, read into FengSui's shapes. The two forms of
 * the interface name the same things: the MR series `LTE_NET_STATUS`, the EX and NX series
 * `DEV2_LTE_NET_STATUS`, with the same attributes. Nothing here sends a request.
 */

/** `networkType` as the router's page names it. */
const NETWORK_TYPES: Readonly<Record<number, DriverTelemetry["mode"]>> = { 0: "NONE", 2: "WCDMA", 3: "LTE", 7: "LTE", 8: "SA" };

/**
 * `simStatus` as the page's texts name it: 1 no card, 2 a card error, 3 ready, 4 locked (the card
 * wants its PIN), 5 unlocked, 6 the PIN is blocked (it wants the PUK), 7 locked for good. 0 says
 * "no card or a card error", which is neither.
 */
const SIM_STATES: Readonly<Record<number, SimState>> = { 1: "absent", 2: "error", 3: "ready", 4: "pin_required", 5: "ready", 6: "puk_required", 7: "error" };

/** The router's "no value" for a cell reading. */
const NO_VALUE = "268435455";

function reading(value: string | undefined): string | null {
  const text = textOf(value);
  return text === null || text === NO_VALUE ? null : text;
}

/** A signal-to-noise ratio the router writes in tenths of a decibel (`110` is 11.0 dB). */
function tenthsOf(value: string | undefined): number | null {
  const n = numberOf(reading(value));
  return n === null ? null : sinrOf(n / 10);
}

/** A byte count the router writes with a decimal point (`2948105728.0`): its whole bytes. */
function bytesOf(value: string | undefined): bigint | null {
  const text = textOf(value);
  return text === null || !/^\d{1,18}(?:\.\d{1,6})?$/.test(text) ? null : counterOf(text.split(".")[0]);
}

/** A bandwidth the router writes in kHz, as MHz. */
function megahertzOf(value: string | undefined): number | null {
  const n = nonNegativeOf(reading(value));
  return n === null || n === 0 || n > 400_000 ? null : n / 1000;
}

/** One entry of the serving cell list (`DEV2_LTE_SERVING_CELL_INFO`) as a cell; NR entries carry their signal as SS-RSRP. */
function servingCell(entry: Record<string, string>, rat: "LTE" | "NR"): DriverCell {
  return {
    ...emptyCell(),
    band: bandOf(reading(entry["band"])),
    arfcn: arfcnOf(reading(entry["ARFCN"]), rat, { zeroIsNone: true }),
    pci: pciOf(reading(entry["PCI"]), rat),
    rsrpDbm: rsrpOf(reading(entry["RSRP"])) ?? rsrpOf(reading(entry["SSRSRP"])),
    rsrqDb: rsrqOf(reading(entry["RSRQ"])) ?? rsrqOf(reading(entry["SSRSRQ"])),
    sinrDb: tenthsOf(entry["SNR"]) ?? tenthsOf(entry["SSSINR"]),
    rssiDbm: rssiOf(reading(entry["RSSI"])),
    bandwidthMhz: megahertzOf(entry["downBandWidth"]),
    ulBandwidthMhz: megahertzOf(entry["upBandWidth"]),
    cellId: identityOf(reading(entry["cid"]), 10),
    tac: identityOf(reading(entry["TAC"]), 10),
    cqi: smallIntOf(reading(entry["CQI"]), 15),
    mimoLayers: smallIntOf(reading(entry["RI"]), 8),
  };
}

function carrierOfCell(rat: "LTE" | "NR", cell: DriverCell): DriverCarrier {
  return { rat, band: cell.band, arfcn: cell.arfcn, pci: cell.pci, bandwidthMhz: cell.bandwidthMhz, rsrpDbm: cell.rsrpDbm, rsrqDb: cell.rsrqDb, rssiDbm: cell.rssiDbm, sinrDb: cell.sinrDb };
}

export interface TplinkReadings {
  /** `IGD_DEV_INFO` / `DEV2_DEV_INFO`. */
  info: TplinkResult;
  /** The LTE link (`…LTE_LINK_CFG`): network type, SIM status, roaming. */
  link: TplinkResult;
  /** The LTE interface (`…LTE_INTF_CFG`): the traffic total and the rates. */
  intf: TplinkResult;
  /** `…LTE_NET_STATUS`: the signal. */
  net: TplinkResult;
  /** `…LTE_PROF_STAT`: the operator. */
  prof: TplinkResult;
  /** The serving cells, where the router lists them (the EX and NX series). */
  cells: TplinkResult;
  /** The WAN connections (`WAN_IP_CONN` / `DEV2_ADT_WAN`). */
  wan: TplinkResult;
}

function flag(value: string | undefined): boolean | null {
  const n = intOf(value);
  return n === null ? null : n === 1;
}

/**
 * One poll in FengSui's shape. The serving cells are named one by one on the EX and NX series (the
 * first connected 4G and 5G entries are the cells, the others carriers next to them); the MR series
 * reports the signal of the serving cell alone, without its band or channel.
 */
export function parseTplinkTelemetry(read: TplinkReadings): DriverTelemetry {
  const info = instance(read.info);
  const link = instance(read.link);
  const intf = instance(read.intf);
  const net = instance(read.net);
  const prof = instance(read.prof);
  const type = intOf(link?.["networkType"]);
  const connected = instances(read.cells).filter((entry) => entry["cellConnectionStatus"] === "1");
  const lteCells = connected.filter((entry) => ["3", "7"].includes(entry["networkType"] ?? "")).map((entry) => servingCell(entry, "LTE"));
  const nrCells = connected.filter((entry) => entry["networkType"] === "8").map((entry) => servingCell(entry, "NR"));
  // The status' own signal, for a router that lists no cells
  const summary: DriverCell = { ...emptyCell(), rsrpDbm: rsrpOf(net?.["rfInfoRsrp"]), rsrqDb: rsrqOf(net?.["rfInfoRsrq"]), sinrDb: tenthsOf(net?.["rfInfoSnr"]) };
  let mode = type === null ? null : (NETWORK_TYPES[type] ?? null);
  // 5G next to a connected 4G cell is the NR leg of EN-DC
  if (mode === "SA" && lteCells.length > 0) mode = "NSA";
  const lte = lteCells[0] ?? (mode === "LTE" && cellHasData(summary) ? summary : null);
  const nr = nrCells[0] ?? (mode === "SA" && cellHasData(summary) ? summary : null);
  const wan = instances(read.wan).filter((entry) => entry["enable"] !== "0");
  const up = wan.find((entry) => (entry["connectionStatus"] ?? entry["connStatusV4"]) === "Connected");
  const sim = intOf(link?.["simStatus"]);
  return {
    model: labelOf(info?.["modelName"]),
    softwareVersion: labelOf(info?.["softwareVersion"]),
    hardwareVersion: labelOf(info?.["hardwareVersion"]),
    operatorName: labelOf(prof?.["ispName"]) ?? labelOf(prof?.["spn"]),
    plmn: null,
    mode,
    lte: mode === "SA" ? null : lte,
    nr: mode === "LTE" ? null : nr,
    carriers: [...lteCells.slice(1).map((cell) => carrierOfCell("LTE", cell)), ...nrCells.slice(1).map((cell) => carrierOfCell("NR", cell))],
    wan: {
      connected: wan.length === 0 ? null : up !== undefined,
      ipv4: ipv4Of(up?.["externalIPAddress"] ?? up?.["connIPv4Address"]),
      ipv6: null,
      uptimeSec: null,
    },
    traffic:
      intf === null
        ? null
        : {
            downloadBytesPerSec: nonNegativeOf(intf["curRxSpeed"]),
            uploadBytesPerSec: nonNegativeOf(intf["curTxSpeed"]),
            totalDownloadBytes: null,
            totalUploadBytes: null,
            sessionDownloadBytes: null,
            sessionUploadBytes: null,
            sessionSeconds: null,
            monthDownloadBytes: null,
            monthUploadBytes: null,
            // The one total the router counts against its data plan, both ways together
            monthTotalBytes: bytesOf(intf["totalStatistics"]),
            monthSeconds: null,
          },
    temperatureC: null,
    signalBars: smallIntOf(net?.["sigLevel"], 5),
    status: {
      sim: { state: sim === null ? null : (SIM_STATES[sim] ?? null), pinLockEnabled: null, pinAttemptsLeft: null, pukAttemptsLeft: null, slot: null },
      roaming: { active: flag(link?.["roamingStatus"]), dataAllowed: null },
    },
  };
}

// ── Connected devices ────────────────────────────────────────────────────────

/** How a device is connected, by the page's number for it (the same on both forms up to 5 GHz). */
const LINKS: Readonly<Record<string, DriverHost["link"]>> = { "0": "lan", "1": "wifi_2_4", "2": "wifi_2_4", "3": "wifi_5", "4": "wifi_5" };

/** The host table (`LAN_HOST_ENTRY` / `DEV2_HOST_ENTRY`): the devices that are there now. */
export function parseTplinkHosts(result: TplinkResult): DriverHost[] {
  const hosts: DriverHost[] = [];
  for (const entry of instances(result).slice(0, 256)) {
    const mac = textOf(entry["MACAddress"] ?? entry["physAddress"]);
    if (mac === null || entry["active"] === "0") continue;
    const type = entry["X_TP_ConnType"] ?? entry["X_TP_LanConnType"] ?? "";
    hosts.push({
      mac,
      name: labelOf(entry["hostName"]),
      ipv4: ipv4Of(entry["IPAddress"]),
      ipv6: [],
      link: LINKS[type] ?? (/^\d+$/.test(type) ? "wifi" : null),
      connectedSec: null,
      leaseSec: nonNegativeOf(entry["leaseTimeRemaining"]),
      rssiDbm: null,
    });
  }
  return hosts;
}

// ── SMS ──────────────────────────────────────────────────────────────────────

/** Sent messages get handles of their own range: each box numbers its messages from the start. */
export const TPLINK_SENT_BASE = 1_000_000;

export interface TplinkSms {
  /** The page of its box the message was listed on, and its instance there: what a write names it by. */
  page: number;
  stack: string;
  message: SmsWireMessage;
}

/**
 * One page of a box (`…SMS_RECVMSGENTRY`, `…SMS_SENDMSGENTRY`): the router's own index of each
 * message, who it is from or to, the text and the time (`yyyy-MM-dd HH:mm:ss`).
 */
export function parseTplinkSmsPage(result: TplinkResult, page: number, box: "in" | "out"): TplinkSms[] {
  const out: TplinkSms[] = [];
  for (const entry of instances(result).slice(0, 64)) {
    const index = intOf(entry["index"]);
    const stack = entry["stack"];
    if (index === null || index < 0 || stack === undefined) continue;
    out.push({
      page,
      stack,
      message: wireMessage({
        // Above zero, and apart from the other box's
        index: index + 1 + (box === "out" ? TPLINK_SENT_BASE : 0),
        phone: entry[box === "in" ? "from" : "to"] ?? "",
        date: dateOfParts((entry[box === "in" ? "receivedTime" : "sendTime"] ?? "").split(/[-/.:\sT]+/)),
        unread: box === "in" && entry["unread"] === "1",
        outgoing: box === "out",
        content: entry["content"] ?? "",
      }),
    });
  }
  return out;
}
