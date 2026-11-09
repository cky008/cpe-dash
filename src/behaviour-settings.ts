import { CpeControlValidationError } from "./control-error.ts";

/**
 * Settings the web console can set over `.env`: the AI agents' master switches, self-healing, alerts
 * and SMS behaviour. Each is either set in the console or `null`, which follows `.env`, so nothing
 * changes on an upgrade until the owner changes it. No dependencies: the daemon, the console and the
 * online demo validate and show them with the same rules (ranges as `src/config.ts` reads `.env`).
 */

export type AgentSmsAccess = "none" | "read" | "full";
export type AlertSeverityFloor = "info" | "warning" | "critical";

export interface BehaviourValues {
  /** MCP tools that change the router (master switch). */
  agentWrites: boolean;
  /** MCP access-control writes, on top of `agentWrites`. */
  agentAccessControl: boolean;
  agentSms: AgentSmsAccess;
  agentSmsSendPolicy: "known" | "any";
  agentSmsSendLimitPerHour: number;
  /** Mask identifiers in what tokens (REST, SSE, MCP) receive. */
  redactApi: boolean;
  /** `0`: off. */
  lockRollbackAfterMin: number;
  /** `0`: off. */
  wanReconnectAfterMin: number;
  alertsEnabled: boolean;
  alertNotifyMinSeverity: AlertSeverityFloor;
  alertRsrpThresholdDbm: number;
  alertSinrThresholdDb: number;
  smsAutoMarkRead: boolean;
  /** `+353` and the like; `""` takes the country from the SIM. */
  defaultCountryCode: string;
}

export type BehaviourKey = keyof BehaviourValues;
export type BehaviourOverrides = { [K in BehaviourKey]?: BehaviourValues[K] | null };

/** The `.env` key each setting falls back to. */
export const BEHAVIOUR_ENV: Readonly<Record<BehaviourKey, string>> = {
  agentWrites: "MCP_ALLOW_MUTATIONS",
  agentAccessControl: "MCP_ALLOW_ACCESS_CONTROL",
  agentSms: "MCP_SMS_ACCESS",
  agentSmsSendPolicy: "MCP_SMS_SEND_POLICY",
  agentSmsSendLimitPerHour: "MCP_SMS_SEND_LIMIT_PER_HOUR",
  redactApi: "REDACT_SENSITIVE_IN_API",
  lockRollbackAfterMin: "LOCK_ROLLBACK_AFTER_MIN",
  wanReconnectAfterMin: "WAN_AUTO_RECONNECT_AFTER_MIN",
  alertsEnabled: "ALERTS_ENABLED",
  alertNotifyMinSeverity: "ALERT_NOTIFY_MIN_SEVERITY",
  alertRsrpThresholdDbm: "ALERT_RSRP_THRESHOLD_DBM",
  alertSinrThresholdDb: "ALERT_SINR_THRESHOLD_DB",
  smsAutoMarkRead: "SMS_AUTO_MARK_READ",
  defaultCountryCode: "DEFAULT_COUNTRY_CODE",
};

const KEYS = Object.keys(BEHAVIOUR_ENV) as BehaviourKey[];

/** What an empty `.env` gives (the defaults of `src/config.ts`). */
export const DEFAULT_BEHAVIOUR: Readonly<BehaviourValues> = {
  agentWrites: false,
  agentAccessControl: false,
  agentSms: "read",
  agentSmsSendPolicy: "known",
  agentSmsSendLimitPerHour: 10,
  redactApi: true,
  lockRollbackAfterMin: 0,
  wanReconnectAfterMin: 0,
  alertsEnabled: true,
  alertNotifyMinSeverity: "warning",
  alertRsrpThresholdDbm: -110,
  alertSinrThresholdDb: 0,
  smsAutoMarkRead: false,
  defaultCountryCode: "",
};

export const SMS_SEND_LIMIT_MAX = 1000;
export const LOCK_ROLLBACK_MIN = { min: 3, max: 1440 } as const;
export const WAN_RECONNECT_MIN = { min: 1, max: 1440 } as const;
/** 3GPP TS 36.133 reports RSRP from -140 to -44 dBm. */
export const RSRP_THRESHOLD = { min: -140, max: -44 } as const;
export const SINR_THRESHOLD = { min: -20, max: 40 } as const;

/** What `.env` says, from the parsed config (minutes rather than the config's milliseconds). */
export function behaviourFromConfig(config: {
  mcpAllowMutations: boolean;
  mcpAllowAccessControl: boolean;
  mcpSmsAccess: AgentSmsAccess;
  mcpSmsSendPolicy: "known" | "any";
  mcpSmsSendLimitPerHour: number;
  redactSensitiveInApi: boolean;
  lockRollbackAfterMs: number;
  wanReconnectAfterMs: number;
  alertsEnabled: boolean;
  alertNotifyMinSeverity: AlertSeverityFloor;
  alertRsrpThresholdDbm: number;
  alertSinrThresholdDb: number;
  smsAutoMarkRead: boolean;
  defaultCountryCode: string;
}): BehaviourValues {
  return {
    agentWrites: config.mcpAllowMutations,
    agentAccessControl: config.mcpAllowAccessControl,
    agentSms: config.mcpSmsAccess,
    agentSmsSendPolicy: config.mcpSmsSendPolicy,
    agentSmsSendLimitPerHour: config.mcpSmsSendLimitPerHour,
    redactApi: config.redactSensitiveInApi,
    lockRollbackAfterMin: Math.round(config.lockRollbackAfterMs / 60_000),
    wanReconnectAfterMin: Math.round(config.wanReconnectAfterMs / 60_000),
    alertsEnabled: config.alertsEnabled,
    alertNotifyMinSeverity: config.alertNotifyMinSeverity,
    alertRsrpThresholdDbm: config.alertRsrpThresholdDbm,
    alertSinrThresholdDb: config.alertSinrThresholdDb,
    smsAutoMarkRead: config.smsAutoMarkRead,
    defaultCountryCode: config.defaultCountryCode,
  };
}

/** The values in force: the console's where it set one, `.env`'s elsewhere. */
export function resolveBehaviour(env: BehaviourValues, overrides: BehaviourOverrides): BehaviourValues {
  const resolved = { ...env } as Record<BehaviourKey, unknown>;
  for (const key of KEYS) {
    const value = overrides[key];
    if (value !== undefined && value !== null) resolved[key] = value;
  }
  return resolved as unknown as BehaviourValues;
}

export interface BehaviourEntry<V> {
  value: V;
  source: "console" | "env";
  envValue: V;
}

export type BehaviourReport = { [K in BehaviourKey]: BehaviourEntry<BehaviourValues[K]> };

/** Each value in force, who set it and what `.env` says (for the console's settings page). */
export function describeBehaviour(env: BehaviourValues, overrides: BehaviourOverrides): BehaviourReport {
  const report = {} as Record<BehaviourKey, BehaviourEntry<unknown>>;
  for (const key of KEYS) {
    const value = overrides[key];
    const set = value !== undefined && value !== null;
    report[key] = { value: set ? value : env[key], source: set ? "console" : "env", envValue: env[key] };
  }
  return report as unknown as BehaviourReport;
}

function readBoolean(key: string, raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new CpeControlValidationError(`"${key}" must be true, false or null (follow .env)`);
  return raw;
}

function readChoice<T extends string>(key: string, raw: unknown, allowed: ReadonlyArray<T>): T {
  if (typeof raw !== "string" || !(allowed as ReadonlyArray<string>).includes(raw)) {
    throw new CpeControlValidationError(`"${key}" must be one of ${allowed.map((v) => `"${v}"`).join(", ")} or null (follow .env)`);
  }
  return raw as T;
}

function readInteger(key: string, raw: unknown, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new CpeControlValidationError(`"${key}" must be a whole number from ${min} to ${max}, or null (follow .env)`);
  }
  return raw;
}

/** `0` turns it off; otherwise the window in minutes. */
function readMinutesOrOff(key: string, raw: unknown, range: { min: number; max: number }): number {
  if (raw === 0) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < range.min || raw > range.max) {
    throw new CpeControlValidationError(`"${key}" must be 0 (off) or a whole number of minutes from ${range.min} to ${range.max}, or null (follow .env)`);
  }
  return raw;
}

function readCountryCode(raw: unknown): string {
  if (raw === "") return "";
  if (typeof raw !== "string" || !/^\+?\d{1,4}$/.test(raw.trim())) {
    throw new CpeControlValidationError('"defaultCountryCode" must be a country calling code such as "+353", "" (from the SIM) or null (follow .env)');
  }
  return `+${raw.trim().replace(/^\+/, "")}`;
}

function readValue(key: BehaviourKey, raw: unknown): BehaviourValues[BehaviourKey] {
  switch (key) {
    case "agentWrites":
    case "agentAccessControl":
    case "redactApi":
    case "alertsEnabled":
    case "smsAutoMarkRead":
      return readBoolean(key, raw);
    case "agentSms":
      return readChoice(key, raw, ["none", "read", "full"] as const);
    case "agentSmsSendPolicy":
      return readChoice(key, raw, ["known", "any"] as const);
    case "agentSmsSendLimitPerHour":
      return readInteger(key, raw, 0, SMS_SEND_LIMIT_MAX);
    case "lockRollbackAfterMin":
      return readMinutesOrOff(key, raw, LOCK_ROLLBACK_MIN);
    case "wanReconnectAfterMin":
      return readMinutesOrOff(key, raw, WAN_RECONNECT_MIN);
    case "alertNotifyMinSeverity":
      return readChoice(key, raw, ["info", "warning", "critical"] as const);
    case "alertRsrpThresholdDbm":
      return readInteger(key, raw, RSRP_THRESHOLD.min, RSRP_THRESHOLD.max);
    case "alertSinrThresholdDb":
      return readInteger(key, raw, SINR_THRESHOLD.min, SINR_THRESHOLD.max);
    case "defaultCountryCode":
      return readCountryCode(raw);
  }
}

/** A change from the console: each named setting gets a valid value, or `null` to follow `.env` again. */
export function readBehaviourPatch(body: Readonly<Record<string, unknown>>): BehaviourOverrides {
  const patch: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!(KEYS as ReadonlyArray<string>).includes(key)) throw new CpeControlValidationError(`Unknown setting "${key}"`);
    patch[key] = raw === null ? null : readValue(key as BehaviourKey, raw);
  }
  if (Object.keys(patch).length === 0) throw new CpeControlValidationError("Nothing to change");
  return patch as BehaviourOverrides;
}

/** The stored overrides this version understands; anything else is dropped, never half-honoured. */
export function sanitizeBehaviourOverrides(stored: unknown): BehaviourOverrides {
  if (typeof stored !== "object" || stored === null) return {};
  const kept: Record<string, unknown> = {};
  for (const key of KEYS) {
    const raw = (stored as Record<string, unknown>)[key];
    if (raw === undefined || raw === null) continue;
    try {
      kept[key] = readValue(key, raw);
    } catch {
      // A value this version cannot honour follows .env instead
    }
  }
  return kept as BehaviourOverrides;
}
