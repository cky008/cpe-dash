import type { MacFilterEntry, TimeRuleChange, TimeRuleInput, WifiAccessChange } from "./access-plan.ts";
import type { BandInput } from "./rf-bounds.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { AntennaModeName, CellLockCandidate, CellLockCommand, FirewallSwitchState } from "./cpe-domain.ts";
import { MAX_LOCK_CELLS, parseBandNumber } from "./rf-bounds.ts";
import type { DriverCellLockTarget, DriverNetworkMode } from "./drivers/types.ts";
import type { RouterFamilyFacts } from "./router-family.ts";
import { TimeSeriesValidationError, type TimeSeriesPreset } from "./timeseries.ts";

/**
 * Input guards shared by the REST routes and the MCP tools, so both adapters apply one rule set
 * (and neither needs an `as` cast). Every guard throws `CpeControlValidationError` (or
 * `TimeSeriesValidationError`), which both adapters map to `VALIDATION_ERROR` before any session.
 * No Node built-ins: the static web demo validates its requests with the same guards.
 */

type Args = Readonly<Record<string, unknown>>;

const TIME_SERIES_PRESETS: ReadonlyArray<TimeSeriesPreset> = ["1h", "6h", "12h", "24h", "custom"];
const ANTENNA_MODES: ReadonlyArray<AntennaModeName> = ["auto", "internal", "external", "hybrid"];
/** Dotted-quad IPv4 without leading zeros (what `net.isIP(...) === 4` accepts). */
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const FIREWALL_KEYS: ReadonlySet<string> = new Set<keyof FirewallSwitchState>([
  "mainSwitch",
  "ipFilterSwitch",
  "wanPortPingSwitch",
  "macFilterSwitch",
  "urlFilterSwitch",
]);

export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

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
  if (typeof value !== "string" || !isIpv4(value.trim())) {
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
 * The LTE bands of an experimental band lock, checked before any session: LTE only (no NR band, no
 * cell lock: the generic net-mode write has neither) and only bands the router advertises in
 * `net/net-mode-list`, or `"all"` to unlock.
 */
export function validateGenericBandLock(
  command: { lteBands?: ReadonlyArray<BandInput> | "all"; nrBands?: ReadonlyArray<BandInput> | "all" },
  advertised: ReadonlyArray<number> | null
): number[] | "all" {
  if (command.nrBands !== undefined) {
    throw new CpeControlValidationError("On a model FengSui was not verified on, the experimental band lock covers LTE bands only: leave nrBands out");
  }
  if (command.lteBands === undefined) throw new CpeControlValidationError("Give lteBands (the experimental band lock covers LTE bands only)");
  if (!advertised || advertised.length === 0) {
    throw new CpeControlValidationError("This router advertises no LTE bands (net/net-mode-list), so a band lock could not be checked");
  }
  if (command.lteBands === "all") return "all";
  if (command.lteBands.length === 0) throw new CpeControlValidationError("At least one LTE band is required (or pass 'all' to unlock)");
  let bands: number[];
  try {
    bands = [...new Set(command.lteBands.map(parseBandNumber))].sort((a, b) => a - b);
  } catch (err) {
    throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
  }
  const outside = bands.filter((band) => !advertised.includes(band));
  if (outside.length > 0) {
    const label = (list: ReadonlyArray<number>): string => list.map((band) => `B${band}`).join(", ");
    throw new CpeControlValidationError(`${label(outside)} ${outside.length === 1 ? "is" : "are"} not among the LTE bands this router advertises (${label(advertised)})`);
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
  const more = readMoreCells(args["more"]);
  const rawPci = args["pci"];
  if (rawPci === undefined || (rawPci === null && opts.allowNullPci)) {
    if (more) throw new CpeControlValidationError('"pci" is required when "more" names further cells: a lock on several cells names each one');
    return { rat, band, arfcn };
  }
  if (typeof rawPci !== "number" || !Number.isFinite(rawPci)) {
    throw new CpeControlValidationError(
      opts.allowNullPci ? '"pci" must be a finite integer, null, or omitted' : '"pci" must be a finite integer or omitted'
    );
  }
  return more ? { rat, band, arfcn, pci: rawPci, more } : { rat, band, arfcn, pci: rawPci };
}

/** `more`: further candidate cells, `{ band, arfcn, pci }` each (`undefined`: none, also for an empty list). */
function readMoreCells(raw: unknown): CellLockCandidate[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new CpeControlValidationError('"more" must be a list of { band, arfcn, pci }');
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_LOCK_CELLS - 1) throw new CpeControlValidationError(`A lock names at most ${MAX_LOCK_CELLS} cells: "more" takes at most ${MAX_LOCK_CELLS - 1}`);
  return raw.map((cell: unknown, i): CellLockCandidate => {
    if (typeof cell !== "object" || cell === null || Array.isArray(cell)) throw new CpeControlValidationError(`"more[${i}]" must be { band, arfcn, pci }`);
    const { band, arfcn, pci } = cell as Record<string, unknown>;
    if (typeof band !== "string" && typeof band !== "number") throw new CpeControlValidationError(`"more[${i}].band" is required (e.g. "B3" or "N78")`);
    if (typeof arfcn !== "number" || !Number.isFinite(arfcn)) throw new CpeControlValidationError(`"more[${i}].arfcn" must be a finite integer`);
    if (typeof pci !== "number" || !Number.isFinite(pci)) throw new CpeControlValidationError(`"more[${i}].pci" must be a finite integer`);
    return { band, arfcn, pci };
  });
}

/** A router that locks one cell at a time: further cells are refused before anything is queued. */
export function assertOneCell(command: CellLockCommand): void {
  if (command.more && command.more.length > 0) throw new CpeControlValidationError('This router locks one cell at a time: leave out "more"');
}

export function isAntennaMode(value: unknown): value is AntennaModeName {
  return typeof value === "string" && (ANTENNA_MODES as ReadonlyArray<string>).includes(value);
}

export function readAntennaMode(value: unknown, key = "mode"): AntennaModeName {
  if (!isAntennaMode(value)) {
    throw new CpeControlValidationError(`"${key}" must be "auto", "internal", "external", or "hybrid"`);
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

function readString(args: Args, key: string, opts: { optional: true }): string | undefined;
function readString(args: Args, key: string, opts?: { optional?: false }): string;
function readString(args: Args, key: string, opts: { optional?: boolean } = {}): string | undefined {
  const value = args[key];
  if (value === undefined && opts.optional) return undefined;
  if (typeof value !== "string") throw new CpeControlValidationError(`"${key}" must be a string`);
  return value;
}

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown, key: string): Args {
  if (!isRecord(value)) throw new CpeControlValidationError(`"${key}" must be an object`);
  return value;
}

/** `[{ macAddress, name? }]`; MAC format and list rules are checked by src/access-plan.ts. */
export function readMacFilterEntries(args: Args, key: string): MacFilterEntry[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) {
    throw new CpeControlValidationError(`"${key}" must be an array of { macAddress, name } (at most 256)`);
  }
  return value.map((item, i) => {
    const entry = readRecord(item, `${key}[${i}]`);
    return { macAddress: readString(entry, "macAddress"), name: readString(entry, "name", { optional: true }) ?? "" };
  });
}

/** One Wi-Fi access change from `{ action: "block" | "unblock", macAddress, name? }`. */
export function readWifiDeviceAccess(args: Args): WifiAccessChange {
  const action = args["action"];
  if (action !== "block" && action !== "unblock") {
    throw new CpeControlValidationError('"action" must be "block" or "unblock"');
  }
  const macAddress = readString(args, "macAddress");
  const name = readString(args, "name", { optional: true }) ?? "";
  return action === "block" ? { kind: "block", macAddress, name } : { kind: "unblock", macAddress, name };
}

/** `{ mode, entries? }` switches the filter; otherwise `{ add?, remove? }` edits the active list. */
export function readWifiMacFilterChange(args: Args): WifiAccessChange {
  const mode = args["mode"];
  if (mode !== undefined) {
    if (mode !== "off" && mode !== "allow" && mode !== "deny") {
      throw new CpeControlValidationError('"mode" must be "off", "allow" or "deny"');
    }
    const entries = readMacFilterEntries(args, "entries");
    return entries === undefined ? { kind: "mode", mode } : { kind: "mode", mode, entries };
  }
  const add = readMacFilterEntries(args, "add") ?? [];
  const removeRaw = args["remove"] ?? [];
  if (!Array.isArray(removeRaw) || removeRaw.some((m) => typeof m !== "string")) {
    throw new CpeControlValidationError('"remove" must be an array of MAC addresses');
  }
  const remove = removeRaw.filter((m): m is string => typeof m === "string");
  if (add.length === 0 && remove.length === 0) {
    throw new CpeControlValidationError('Specify "mode", or "add" / "remove" entries');
  }
  return { kind: "entries", add, remove };
}

/** `{ action: "create" | "update" | "delete", id?, rule? }` for an internet time rule. */
export function readTimeRuleChange(args: Args): TimeRuleChange {
  const action = args["action"];
  if (action !== "create" && action !== "update" && action !== "delete") {
    throw new CpeControlValidationError('"action" must be "create", "update" or "delete"');
  }
  if (action === "delete") return { kind: "delete", id: readString(args, "id") };
  const raw = readRecord(args["rule"], "rule");
  const rule: TimeRuleInput = {
    macAddress: readString(raw, "macAddress"),
    name: readString(raw, "name", { optional: true }) ?? "",
    weekMask: readString(raw, "weekMask"),
    startTime: readString(raw, "startTime"),
    endTime: readString(raw, "endTime"),
    enabled: readOptionalBoolean(raw, "enabled") ?? true,
  };
  return action === "create" ? { kind: "create", rule } : { kind: "update", id: readString(args, "id"), rule };
}

export interface SecurityControlInput {
  upnpEnabled?: boolean;
  dmz?: { enabled: boolean; ipAddress?: string };
  firewall?: Partial<FirewallSwitchState>;
}

/** `POST /api/control/security`: `{ upnpEnabled?, dmz?: { enabled, ipAddress? }, firewall?: { <switch>: boolean } }`. */
export function readSecurityControl(args: Args): SecurityControlInput {
  const upnpEnabled = readOptionalBoolean(args, "upnpEnabled");

  let dmz: { enabled: boolean; ipAddress?: string } | undefined;
  const rawDmz = args["dmz"];
  if (rawDmz !== undefined) {
    if (!rawDmz || typeof rawDmz !== "object" || Array.isArray(rawDmz)) {
      throw new CpeControlValidationError('Field "dmz" must be an object');
    }
    const dmzObj = rawDmz as Record<string, unknown>;
    if (typeof dmzObj["enabled"] !== "boolean") {
      throw new CpeControlValidationError('Field "dmz.enabled" must be boolean');
    }
    let ipAddress: string | undefined;
    if (dmzObj["ipAddress"] !== undefined) {
      if (typeof dmzObj["ipAddress"] !== "string" || !isIpv4(dmzObj["ipAddress"].trim())) {
        throw new CpeControlValidationError('Field "dmz.ipAddress" must be a valid IPv4 address');
      }
      ipAddress = dmzObj["ipAddress"].trim();
    }
    dmz = { enabled: dmzObj["enabled"], ipAddress };
  }

  let firewall: Partial<FirewallSwitchState> | undefined;
  const rawFw = args["firewall"];
  if (rawFw !== undefined) {
    if (!rawFw || typeof rawFw !== "object" || Array.isArray(rawFw)) {
      throw new CpeControlValidationError('Field "firewall" must be an object');
    }
    const cleanFw = Object.create(null) as Partial<FirewallSwitchState>;
    for (const [k, v] of Object.entries(rawFw as Record<string, unknown>)) {
      if (!FIREWALL_KEYS.has(k)) {
        throw new CpeControlValidationError(`Unknown firewall switch key "${k}"`);
      }
      if (v !== undefined) {
        if (typeof v !== "boolean") {
          throw new CpeControlValidationError(`Firewall switch "${k}" must be boolean`);
        }
        cleanFw[k as keyof FirewallSwitchState] = v;
      }
    }
    firewall = cleanFw;
  }
  return { upnpEnabled, dmz, firewall };
}

/** A band lock as a driver family's session takes it; `null` for a RAT the command leaves as it is. */
export interface DriverBandLockRequest {
  lte: number[] | "all" | null;
  nr: number[] | "all" | null;
  networkMode: DriverNetworkMode | null;
}

/** More bands than any band table holds: a longer list is not a band lock. */
const MAX_LOCK_BANDS = 128;

/** The HiLink network-mode codes the REST / MCP band lock takes, as a driver family names the modes. */
const DRIVER_NETWORK_MODES: Readonly<Record<string, DriverNetworkMode>> = { "00": "auto", "03": "lte", "08": "nr_sa" };

function parseDriverBands(rat: "LTE" | "NR", bands: ReadonlyArray<BandInput> | "all"): number[] | "all" {
  if (bands === "all") return "all";
  if (!Array.isArray(bands)) throw new CpeControlValidationError(`${rat} bands must be a list of band numbers or 'all'`);
  if (bands.length > MAX_LOCK_BANDS) throw new CpeControlValidationError(`At most ${MAX_LOCK_BANDS} ${rat} bands can be named`);
  if (bands.length === 0) throw new CpeControlValidationError(`At least one ${rat} band is required (or pass 'all')`);
  try {
    return [...new Set(bands.map(parseBandNumber))].sort((a, b) => a - b);
  } catch (err) {
    throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The band lock a router of a driver family gets, checked before any session: the bands as numbers
 * (each driver checks them against the 3GPP tables and, where the router names them, its own), NR
 * bands only on a family that locks them, and a network mode only among the ones the family offers.
 */
export function readDriverBandLockTarget(
  command: { lteBands?: ReadonlyArray<BandInput> | "all"; nrBands?: ReadonlyArray<BandInput> | "all"; networkMode?: string },
  facts: Pick<RouterFamilyFacts, "nrBandLock" | "networkModes">
): DriverBandLockRequest {
  if (command.lteBands === undefined && command.nrBands === undefined) {
    throw new CpeControlValidationError("At least one of lteBands or nrBands must be provided");
  }
  if (command.nrBands !== undefined && !facts.nrBandLock) {
    throw new CpeControlValidationError("This router locks LTE bands only: leave nrBands out");
  }
  let networkMode: DriverNetworkMode | null = null;
  if (command.networkMode !== undefined) {
    const mode = Object.hasOwn(DRIVER_NETWORK_MODES, command.networkMode) ? DRIVER_NETWORK_MODES[command.networkMode] : undefined;
    if (mode === undefined) throw new CpeControlValidationError(`Invalid networkMode "${command.networkMode}" (expected 00 auto, 03 4G only or 08 5G only)`);
    if (!facts.networkModes.includes(mode)) throw new CpeControlValidationError(`This router offers no "${mode}" network mode (it offers ${facts.networkModes.join(", ")})`);
    networkMode = mode;
  }
  return {
    lte: command.lteBands === undefined ? null : parseDriverBands("LTE", command.lteBands),
    nr: command.nrBands === undefined ? null : parseDriverBands("NR", command.nrBands),
    networkMode,
  };
}

/**
 * The cell lock a router of a driver family gets: band, channel and PCI as numbers (the driver checks
 * the channel against the band's range). Without a PCI it is a lock on the channel alone (`pci: null`),
 * which only a family whose notes define one takes (`frequencyLock`).
 */
/**
 * Every cell a lock on several names (the first one and `more`), each checked like one: on a family
 * none of whose routers locks several cells of this RAT at once, refused before anything is queued.
 */
export function readDriverCellLockTargets(command: CellLockCommand, facts: Pick<RouterFamilyFacts, "frequencyLock" | "multiCellLock"> = {}): DriverCellLockTarget[] {
  if (!facts.multiCellLock?.includes(command.rat)) throw new CpeControlValidationError(`This router locks one ${command.rat === "NR" ? "5G" : "4G"} cell at a time: leave out "more"`);
  const cells = [command, ...(command.more ?? [])].map((cell) => readDriverCellLockTarget({ rat: command.rat, band: cell.band, arfcn: cell.arfcn, ...(cell.pci !== undefined ? { pci: cell.pci } : {}) }));
  const seen = new Set<string>();
  return cells.map((cell) => {
    if (cell.pci === null) throw new CpeControlValidationError("Each cell of a lock on several names its PCI");
    const key = `${cell.arfcn}/${cell.pci}`;
    if (seen.has(key)) throw new CpeControlValidationError(`The cell ${key} is named twice`);
    seen.add(key);
    return { ...cell, pci: cell.pci };
  });
}

export function readDriverCellLockTarget(command: CellLockCommand, facts: Pick<RouterFamilyFacts, "frequencyLock"> = {}): Omit<DriverCellLockTarget, "pci"> & { pci: number | null } {
  if (command.rat !== "LTE" && command.rat !== "NR") throw new CpeControlValidationError('rat must be "LTE" or "NR"');
  let band: number;
  try {
    band = parseBandNumber(command.band);
  } catch (err) {
    throw new CpeControlValidationError(err instanceof Error ? err.message : String(err));
  }
  if (!Number.isInteger(command.arfcn) || command.arfcn < 0) throw new CpeControlValidationError("arfcn must be a non-negative integer");
  if (command.pci === undefined || command.pci === null) {
    if (facts.frequencyLock !== true) throw new CpeControlValidationError("pci is required for a cell lock on this router (it locks one cell, not a frequency)");
    return { rat: command.rat, band, arfcn: command.arfcn, pci: null, scsKhz: null };
  }
  if (!Number.isInteger(command.pci) || command.pci < 0) throw new CpeControlValidationError("pci must be a non-negative integer");
  return { rat: command.rat, band, arfcn: command.arfcn, pci: command.pci, scsKhz: null };
}
