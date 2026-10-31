import type { MacFilterEntry, TimeRuleChange, TimeRuleInput, WifiAccessChange } from "./access-plan.ts";
import type { BandInput } from "./band-lock.ts";
import { CpeControlValidationError } from "./control-error.ts";
import type { AntennaModeName, CellLockCommand, FirewallSwitchState } from "./cpe-domain.ts";
import { TimeSeriesValidationError, type TimeSeriesPreset } from "./timeseries.ts";

/**
 * Input guards shared by the REST routes and the MCP tools, so both adapters apply one rule set
 * (and neither needs an `as` cast). Every guard throws `CpeControlValidationError` (or
 * `TimeSeriesValidationError`), which both adapters map to `VALIDATION_ERROR` before any session.
 * No Node built-ins: the static web demo validates its requests with the same guards.
 */

type Args = Readonly<Record<string, unknown>>;

const TIME_SERIES_PRESETS: ReadonlyArray<TimeSeriesPreset> = ["1h", "6h", "12h", "24h", "custom"];
const ANTENNA_MODES: ReadonlyArray<AntennaModeName> = ["auto", "internal", "external"];
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
