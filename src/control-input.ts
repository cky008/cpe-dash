import net from "node:net";
import type { BandInput } from "./band-lock.ts";
import { type AntennaModeName, type CellLockCommand, CpeControlValidationError } from "./cpe-domain.ts";
import { TimeSeriesValidationError, type TimeSeriesPreset } from "./timeseries.ts";

/**
 * Input guards shared by the REST routes and the MCP tools, so both adapters apply one rule set
 * (and neither needs an `as` cast). Every guard throws `CpeControlValidationError` (or
 * `TimeSeriesValidationError`), which both adapters map to `VALIDATION_ERROR` before any session.
 */

type Args = Readonly<Record<string, unknown>>;

const TIME_SERIES_PRESETS: ReadonlyArray<TimeSeriesPreset> = ["1h", "6h", "12h", "24h", "custom"];
const ANTENNA_MODES: ReadonlyArray<AntennaModeName> = ["auto", "internal", "external"];

export function readOptionalBoolean(args: Args, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CpeControlValidationError(`"${key}" must be a boolean`);
  }
  return value;
}

export function readOptionalIpv4(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || net.isIP(value.trim()) !== 4) {
    throw new CpeControlValidationError(`"${key}" must be a valid IPv4 address`);
  }
  return value.trim();
}

/** `"all"` or a list of band labels / numbers (`["B1", 3]`); band support is checked downstream. */
export function readBandSelection(args: Args, key: string): ReadonlyArray<BandInput> | "all" | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (value === "all") return "all";
  if (!Array.isArray(value)) {
    throw new CpeControlValidationError(`"${key}" must be an array of bands (e.g. ["B1","B3"]) or "all"`);
  }
  const bands: BandInput[] = [];
  for (const item of value) {
    if (typeof item !== "string" && typeof item !== "number") {
      throw new CpeControlValidationError(`Invalid band entry in "${key}"`);
    }
    bands.push(item);
  }
  return bands;
}

/**
 * `{ rat, band, arfcn, pci? }`. An omitted `pci` means a frequency lock; `allowNullPci` also accepts
 * an explicit `null` for that (REST), anything else must be a finite number and is never dropped.
 */
export function readCellLockCommand(args: Args, opts: { allowNullPci: boolean }): CellLockCommand {
  const rat = args["rat"];
  if (rat !== "LTE" && rat !== "NR") {
    throw new CpeControlValidationError('"rat" must be "LTE" or "NR"');
  }
  const band = args["band"];
  if (typeof band !== "string" && typeof band !== "number") {
    throw new CpeControlValidationError('"band" is required (e.g. "B3" or "N78")');
  }
  const arfcn = args["arfcn"];
  if (typeof arfcn !== "number" || !Number.isFinite(arfcn)) {
    throw new CpeControlValidationError('"arfcn" must be a finite integer');
  }
  const rawPci = args["pci"];
  if (rawPci === undefined || (rawPci === null && opts.allowNullPci)) {
    return { rat, band, arfcn };
  }
  if (typeof rawPci !== "number" || !Number.isFinite(rawPci)) {
    throw new CpeControlValidationError(
      opts.allowNullPci ? '"pci" must be a finite integer, null, or omitted' : '"pci" must be a finite integer or omitted'
    );
  }
  return { rat, band, arfcn, pci: rawPci };
}

export function isAntennaMode(value: unknown): value is AntennaModeName {
  return typeof value === "string" && (ANTENNA_MODES as ReadonlyArray<string>).includes(value);
}

export function readAntennaMode(value: unknown, key = "mode"): AntennaModeName {
  if (!isAntennaMode(value)) {
    throw new CpeControlValidationError(`"${key}" must be "auto", "internal", or "external"`);
  }
  return value;
}

/** Omitted -> `"1h"`; anything else must be one of the supported presets. */
export function readTimeSeriesPreset(value: unknown): TimeSeriesPreset {
  if (value === undefined) return "1h";
  const preset = TIME_SERIES_PRESETS.find((p) => p === value);
  if (preset === undefined) {
    throw new TimeSeriesValidationError(`Unsupported time-series preset "${String(value)}"`);
  }
  return preset;
}
