import { splitAtCsv } from "./common.ts";
import type { NetworkMode } from "../../cellular.ts";
import { emptyCell } from "../../drivers/snapshot.ts";
import type { DriverCarrier, DriverCell, DriverNeighbour, DriverNetworkMode, DriverRat } from "../../drivers/types.ts";
import { arfcnOf, bandOf, hexIntOf, identityOf, intOf, pciOf, plmnOf, rsrpOf, rsrqOf, rssiOf, sinrOf } from "../../drivers/values.ts";


/**
 * Fibocom modules' own AT commands (FM650, FM350, FM160, FG370…): serving and neighbour cells, carriers,
 * network mode and band selection. Parsers only: how a command reaches the module is the driver's.
 */

/** `AT+GTACT`'s RAT selection as the modes FengSui names (the two the command is documented for). */
export const FIBOCOM_RAT_OF_MODE: Readonly<Partial<Record<DriverNetworkMode, number>>> = { auto: 17, nr_sa: 14 };

export const FIBOCOM_MODE_OF_RAT: Readonly<Record<number, DriverNetworkMode>> = { 17: "auto", 14: "nr_sa" };

export const FIBOCOM_MODE_LIST: ReadonlyArray<NetworkMode> = ["auto", "nr_sa"];

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

/** LTE channel bandwidths in resource blocks, as Fibocom's carrier list writes them, and their width in MHz. */
export const LTE_RB_MHZ: Readonly<Record<string, number>> = { "6": 1.4, "15": 3, "25": 5, "50": 10, "75": 15, "100": 20 };

/** A Fibocom band code: `100 + band` for LTE, `500 + band` (or `5000 + band`) for NR. */
export function fibocomBandOf(code: string | undefined): { rat: DriverRat; band: number } | null {
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
