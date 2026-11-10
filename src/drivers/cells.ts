import { earfcnToLteBand, lteBandInfo, nrArfcnToBand, nrBandInfo } from "../rf-math.ts";
import type { DriverCarrier, DriverNeighbour, DriverRat, ServingMode } from "./types.ts";
import { arfcnOf, bandOf, channelBandwidthOf, pciOf, rowsOf, rsrpOf, rsrqOf, rssiOf, sinrOf, textOf } from "./values.ts";

/**
 * Cell readings the router families share: how they name the serving mode, and carrier and
 * neighbour lists packed into `a,b;c,d` strings. A row is checked against the 3GPP tables
 * (`src/rf-math.ts`): a channel must lie in the band it claims, so a list whose layout a firmware
 * changed is read the way that fits, or dropped, never misread.
 */

/** A serving mode from the many ways routers name it (`SA`, `NR5G-SA`, `ENDC`, `LTE`, `NO_SERVICE`…). */
export function servingModeOf(value: unknown): ServingMode | null {
  const text = textOf(value)?.toUpperCase().replace(/[\s_]+/g, "-");
  if (!text) return null;
  if (/NO-?SERVICE|LIMITED|无服务|NOSERVICE|^NONE$|^NO-?SIGNAL$/.test(text)) return "NONE";
  if (/NSA|ENDC|EN-DC|LTE\+5G|LTE-AND-5G|LTE-NR/.test(text)) return "NSA";
  if (/^(?:NR5G-SA|NR-SA|5G-SA|SA|NR|NR5G|5G|NR5G-SA-ONLY)$/.test(text)) return "SA";
  if (/LTE|^4G$|FDD|TDD/.test(text)) return "LTE";
  if (/WCDMA|UMTS|HSPA|HSDPA|HSUPA|^HS|^3G$|^U$|TD-SCDMA/.test(text)) return "WCDMA";
  return null;
}

/** Whether `arfcn` is a downlink channel of `band` (LTE EARFCN or NR-ARFCN). */
export function channelInBand(rat: DriverRat, band: number | null, arfcn: number | null): boolean {
  if (band === null || arfcn === null) return false;
  const range = rat === "LTE" ? lteBandInfo(band)?.dlEarfcn : nrBandInfo(band)?.dlArfcn;
  return range !== undefined && arfcn >= range[0] && arfcn <= range[1];
}

/** The band of a channel the router names no band for. */
export function bandOfChannel(rat: DriverRat, arfcn: number | null): number | null {
  if (arfcn === null) return null;
  return rat === "LTE" ? earfcnToLteBand(arfcn) : nrArfcnToBand(arfcn);
}

/** A carrier from named parts; the band is taken from the channel when the router names none. */
export function carrierOf(
  rat: DriverRat,
  parts: { band?: unknown; arfcn?: unknown; pci?: unknown; bandwidth?: unknown; rsrp?: unknown; rsrq?: unknown; rssi?: unknown; sinr?: unknown },
  pciRadix: 10 | 16 | "auto" = "auto"
): DriverCarrier | null {
  const arfcn = arfcnOf(parts.arfcn, rat);
  const band = bandOf(parts.band) ?? bandOfChannel(rat, arfcn);
  if (band === null && arfcn === null) return null;
  // A channel outside the band it is listed with: the row is not what it seems
  if (band !== null && arfcn !== null && !channelInBand(rat, band, arfcn)) return null;
  return {
    rat,
    band,
    arfcn,
    pci: pciOf(parts.pci, rat, pciRadix),
    bandwidthMhz: channelBandwidthOf(parts.bandwidth, rat),
    rsrpDbm: rsrpOf(parts.rsrp),
    rsrqDb: rsrqOf(parts.rsrq),
    rssiDbm: rssiOf(parts.rssi),
    sinrDb: sinrOf(parts.sinr),
  };
}

/** A neighbour from named parts (band from the channel when missing). */
export function neighbourOf(
  rat: DriverRat,
  parts: { band?: unknown; arfcn?: unknown; pci?: unknown; rsrp?: unknown; rsrq?: unknown; rssi?: unknown; sinr?: unknown },
  pciRadix: 10 | 16 | "auto" = "auto"
): DriverNeighbour | null {
  const carrier = carrierOf(rat, parts, pciRadix);
  if (!carrier || (carrier.pci === null && carrier.rsrpDbm === null)) return null;
  return { rat, band: carrier.band, arfcn: carrier.arfcn, pci: carrier.pci, rsrpDbm: carrier.rsrpDbm, rsrqDb: carrier.rsrqDb, rssiDbm: carrier.rssiDbm, sinrDb: carrier.sinrDb };
}

/** The RAT of a channel number when the router does not say: EARFCNs stop where NR-ARFCNs in use start. */
export function ratOfChannel(arfcn: number | null): DriverRat | null {
  if (arfcn === null) return null;
  if (earfcnToLteBand(arfcn) !== null && arfcn < 262144) return "LTE";
  return nrArfcnToBand(arfcn) !== null ? "NR" : null;
}

/** `LTE` / `NR` from a RAT label (`4G`, `LTE`, `5G`, `NR5G`, `12`, `16`…), `null` otherwise. */
export function ratOf(value: unknown): DriverRat | null {
  const text = textOf(value)?.toUpperCase();
  if (!text) return null;
  if (/^(?:LTE|4G|E-?UTRA|12|EUTRAN)$/.test(text)) return "LTE";
  if (/^(?:NR|NR5G|5G|NR-?SA|NR-?NSA|16|SA|NSA)$/.test(text)) return "NR";
  return null;
}

/**
 * Carrier rows of a packed list read with the first of `layouts` whose rows all lie in their bands
 * (each layout names the field index of each part, `-1` for none). Rows that fit no layout are left out.
 */
export function carriersFromRows(
  rat: DriverRat,
  value: unknown,
  layouts: ReadonlyArray<Partial<Record<"band" | "arfcn" | "pci" | "bandwidth" | "rsrp" | "rsrq" | "rssi" | "sinr", number>>>,
  pciRadix: 10 | 16 | "auto" = "auto"
): DriverCarrier[] {
  const rows = rowsOf(value);
  if (rows.length === 0) return [];
  const read = (row: string[], layout: (typeof layouts)[number]): DriverCarrier | null => {
    const at = (key: keyof typeof layout): string | undefined => {
      const i = layout[key];
      return i === undefined || i < 0 ? undefined : row[i];
    };
    // A layout with a band must find one, and a bandwidth must be one 3GPP defines: otherwise a shifted row would pass
    if (layout.band !== undefined && bandOf(at("band")) === null) return null;
    const bandwidth = at("bandwidth");
    if (bandwidth !== undefined && bandwidth !== "" && channelBandwidthOf(bandwidth, rat) === null) return null;
    return carrierOf(rat, { band: at("band"), arfcn: at("arfcn"), pci: at("pci"), bandwidth: at("bandwidth"), rsrp: at("rsrp"), rsrq: at("rsrq"), rssi: at("rssi"), sinr: at("sinr") }, pciRadix);
  };
  for (const layout of layouts) {
    const carriers = rows.map((row) => read(row, layout));
    if (carriers.every((c) => c !== null && c.arfcn !== null)) return carriers.filter((c): c is DriverCarrier => c !== null);
  }
  // No layout fits every row: keep the rows the first layout reads with a channel in its band
  const first = layouts[0];
  return first ? rows.map((row) => read(row, first)).filter((c): c is DriverCarrier => c !== null && c.arfcn !== null && c.band !== null) : [];
}
