import type { AgentSmsAccess, BehaviourValues } from "./behaviour-settings.ts";
import type { TokenPermission } from "./console-policy.ts";
import type { WriteAccess, WriteFeature, WriteFeatureState, WriteResultRecord } from "./device-access.ts";
import type { ExperimentalFeature } from "./device-profile.ts";

/**
 * Testing the router with an AI agent at one click (Settings → Device, on a model FengSui was not
 * verified on). Starting the test turns on everything it needs as one informed choice (SMS included
 * unless the owner leaves it out), and ending it puts back exactly what it turned on that is still as
 * it left it. While something it turned on stays on, the owner is reminded a few hours after the
 * test's last call, then daily, until a reminder is read or every write the test covers has read back
 * as a match. No dependencies: the daemon, the console and the online demo share these rules.
 */

/** The experimental writes the test covers: what an agent's tools can write (there is no mobile-data tool); SMS only while the owner keeps it in. */
export const AGENT_TEST_FEATURES = ["bandLock", "reconnect", "reboot", "smsWrite"] as const satisfies ReadonlyArray<ExperimentalFeature>;
export type AgentTestFeature = (typeof AGENT_TEST_FEATURES)[number];

/**
 * The console settings the test sets, and to what: agents may test this router and change it; for
 * SMS, agents read and write SMS and may send to a number they are given (the known-only rule would
 * refuse a number the router never texted).
 */
export const AGENT_TEST_SETTINGS = {
  agentExperimental: true,
  agentWrites: true,
  agentSms: "full",
  agentSmsSendPolicy: "any",
} as const satisfies Partial<BehaviourValues>;
export type AgentTestSetting = keyof typeof AGENT_TEST_SETTINGS;

const BASE_SETTINGS = ["agentExperimental", "agentWrites"] as const satisfies ReadonlyArray<AgentTestSetting>;
const SMS_SETTINGS = ["agentSms", "agentSmsSendPolicy"] as const satisfies ReadonlyArray<AgentTestSetting>;
const BASE_FEATURES = ["bandLock", "reconnect", "reboot"] as const satisfies ReadonlyArray<AgentTestFeature>;
/** What the agent's token needs: changing the router; with SMS also reading and writing SMS. */
const BASE_PERMISSIONS: ReadonlyArray<TokenPermission> = ["control"];
const SMS_PERMISSIONS: ReadonlyArray<TokenPermission> = ["sms-read", "sms-write"];

/** The first reminder: this long after the test's last call by an agent (or its start). */
export const AGENT_TEST_REMIND_AFTER_MS = 3 * 3_600_000;
/** Then once a day, until a reminder is read. */
export const AGENT_TEST_REMIND_EVERY_MS = 24 * 3_600_000;

/** Why the test cannot start on this router (`409 AGENT_TEST_UNAVAILABLE`). */
export const AGENT_TEST_UNAVAILABLE_MESSAGE = "This router has no experimental write for an AI agent to test (a model FengSui was verified on, or none identified yet)";

/** MCP tools whose calls mean the test is still going on: the report, the probe and the writes it covers. */
export const AGENT_TEST_TOOLS: ReadonlySet<string> = new Set([
  "get_device_report",
  "probe_router_endpoints",
  "set_experimental_write",
  "lock_band",
  "unlock_rf_locks",
  "reconnect_cellular",
  "reboot_cpe",
  "send_sms",
  "mark_sms_read",
  "delete_sms",
]);

/** A console setting the test set, and the console's value before (`null`: it followed `.env`). */
export type AgentTestSettingChange =
  | { key: "agentExperimental" | "agentWrites"; before: boolean | null }
  | { key: "agentSms"; before: AgentSmsAccess | null }
  | { key: "agentSmsSendPolicy"; before: "known" | "any" | null };

/** The test in progress, as the console keeps it (`settings.json`). */
export interface AgentTestRecord {
  /** The router's model the owner started the test for. */
  model: string;
  startedAtIso: string;
  /** The owner kept SMS in the test: its writes count towards a pass. */
  sms: boolean;
  settings: AgentTestSettingChange[];
  /** Experimental writes the test turned on, with each consent's time (one given again later is the owner's own). */
  features: Array<{ feature: AgentTestFeature; grantedAtIso: string }>;
  /** Tokens the test gave permissions, and which. */
  tokens: Array<{ id: string; name: string; added: TokenPermission[] }>;
  /** The test's last call by an agent (`AGENT_TEST_TOOLS`), or its latest start. */
  lastActivityAtIso: string;
  remindedAtIso: string | null;
  /** The alert of the last reminder: reading it in the console reads the reminder. */
  reminderAlertId: string | null;
  /** The owner read a reminder: none follows for this test. */
  acknowledgedAtIso: string | null;
}

/** A token the console can offer to give what the test needs. */
export interface AgentTestTokenChoice {
  id: string;
  name: string;
  /** What it lacks of what the test needs (`control`; with SMS also `sms-read` and `sms-write`). */
  missing: TokenPermission[];
  /** Its last call to FengSui's MCP endpoint since the daemon started (`null`: none seen). */
  agentUsedAtIso: string | null;
}

/** What starting the test would turn on now. */
export interface AgentTestPlan {
  /** The router is a model FengSui was not verified on, with a write the test covers on offer or on. */
  available: boolean;
  /** Console settings the test needs that are not set its way. */
  settings: AgentTestSetting[];
  /** Writes the test covers (besides SMS) that this router offers and that are still off. */
  features: AgentTestFeature[];
  sms: {
    /** SMS can be part of the test: FengSui and the router have SMS, and its experimental write is offered or on. */
    available: boolean;
    /** Console settings SMS testing needs that are not set its way. */
    settings: AgentTestSetting[];
    /** The experimental SMS write is still off. */
    feature: boolean;
    /** The agents' hourly SMS budget (the confirmation names it). */
    sendLimitPerHour: number;
  };
  /** Tokens lacking something the test needs, the one an agent used last first. */
  tokens: AgentTestTokenChoice[];
  /** The agent's token as far as FengSui can tell: the last one used on MCP, else the only one to choose from. */
  suggestedTokenId: string | null;
  /** The agent's token needs more than it has, and FengSui cannot see that it has it. */
  tokenNeeded: boolean;
}

/** The test in progress, as the console shows it. */
export interface AgentTestView {
  model: string;
  startedAtIso: string;
  sms: boolean;
  /** What the test turned on that is still as it left it: ending the test puts these back. */
  settings: AgentTestSetting[];
  features: AgentTestFeature[];
  tokens: Array<{ id: string; name: string; permissions: TokenPermission[] }>;
  lastActivityAtIso: string;
  remindedAtIso: string | null;
  acknowledged: boolean;
  /** Every write the test covers that is on was tried since the start, and each time read back as a match. */
  passed: boolean;
  /** When the next reminder goes out (`null`: none, because the writes passed, a reminder was read or nothing is left on). */
  remindAtIso: string | null;
}

/** `agentTest` of the console's experimental-writes answer. */
export interface AgentTestStatus {
  /** The test in progress, while something it turned on is still on. */
  current: AgentTestView | null;
  plan: AgentTestPlan;
}

export function noAgentTestPlan(): AgentTestPlan {
  return { available: false, settings: [], features: [], sms: { available: false, settings: [], feature: false, sendLimitPerHour: 0 }, tokens: [], suggestedTokenId: null, tokenNeeded: false };
}

/** The token permissions the test needs, with or without SMS. */
export function agentTestPermissions(sms: boolean): TokenPermission[] {
  return [...BASE_PERMISSIONS, ...(sms ? SMS_PERMISSIONS : [])];
}

/** A token as the plan needs it: what it may do, whether it still works, and its last MCP call (ms). */
export interface AgentTestTokenInfo {
  id: string;
  name: string;
  permissions: ReadonlyArray<TokenPermission>;
  createdAtIso: string;
  expiresAtIso: string | null;
  agentUsedAtMs: number | null;
}

const offered = (state: WriteFeatureState | undefined): boolean => state === "available" || state === "consented";

/**
 * What starting the test would turn on: on a model FengSui was not verified on with a write the test
 * covers, the settings not set its way, the covered writes on offer and not on (SMS apart, for the
 * owner to keep or leave out), and the tokens that lack what the test needs, the agent's first.
 */
export function agentTestPlan(input: {
  device: { writes: WriteAccess; features: Readonly<Record<WriteFeature, WriteFeatureState>> };
  values: Pick<BehaviourValues, AgentTestSetting | "agentSmsSendLimitPerHour">;
  /** FengSui reads SMS (SMS_ENABLED) and this router provides it. */
  smsReadable: boolean;
  tokens: ReadonlyArray<AgentTestTokenInfo>;
  nowMs: number;
}): AgentTestPlan {
  const { device, values } = input;
  const covered = BASE_FEATURES.filter((feature) => offered(device.features[feature]));
  const smsOffered = input.smsReadable && offered(device.features.smsWrite);
  if (device.writes !== "read_only" || (covered.length === 0 && !smsOffered)) return noAgentTestPlan();
  const unset = (keys: ReadonlyArray<AgentTestSetting>): AgentTestSetting[] => keys.filter((key) => values[key] !== AGENT_TEST_SETTINGS[key]);
  const needed = agentTestPermissions(smsOffered);
  const live = input.tokens.filter((token) => token.expiresAtIso === null || Date.parse(token.expiresAtIso) > input.nowMs);
  const missing = (token: AgentTestTokenInfo): TokenPermission[] => needed.filter((permission) => !token.permissions.includes(permission));
  let agent: AgentTestTokenInfo | null = null;
  for (const token of live) if (token.agentUsedAtMs !== null && (agent === null || token.agentUsedAtMs > (agent.agentUsedAtMs ?? 0))) agent = token;
  const candidates = live
    .filter((token) => missing(token).length > 0)
    .sort((a, b) => (b.agentUsedAtMs ?? -1) - (a.agentUsedAtMs ?? -1) || b.createdAtIso.localeCompare(a.createdAtIso));
  let suggested: string | null = null;
  if (agent !== null && missing(agent).length > 0) suggested = agent.id;
  else if (agent === null && candidates.length === 1) suggested = candidates[0]?.id ?? null;
  return {
    available: true,
    settings: unset(BASE_SETTINGS),
    features: covered.filter((feature) => device.features[feature] === "available"),
    sms: {
      available: smsOffered,
      settings: smsOffered ? unset(SMS_SETTINGS) : [],
      feature: smsOffered && device.features.smsWrite === "available",
      sendLimitPerHour: values.agentSmsSendLimitPerHour,
    },
    tokens: candidates.map((token) => ({
      id: token.id,
      name: token.name,
      missing: missing(token),
      agentUsedAtIso: token.agentUsedAtMs === null ? null : new Date(token.agentUsedAtMs).toISOString(),
    })),
    suggestedTokenId: suggested,
    tokenNeeded: candidates.length > 0 && !(agent !== null && missing(agent).length === 0),
  };
}

/** What the test turned on that is still as it left it. */
export interface AgentTestStillOn {
  settings: AgentTestSetting[];
  features: AgentTestFeature[];
  tokens: Array<{ id: string; name: string; permissions: TokenPermission[] }>;
}

export function agentTestStillOn(
  record: AgentTestRecord,
  now: {
    /** The console's own values (`null` or missing: it follows `.env`). */
    overrides: Readonly<Partial<Record<AgentTestSetting, unknown>>>;
    consents: ReadonlyArray<{ feature: string; grantedAtIso: string }>;
    tokens: ReadonlyArray<{ id: string; permissions: ReadonlyArray<TokenPermission> }>;
  }
): AgentTestStillOn {
  return {
    settings: record.settings.filter(({ key }) => now.overrides[key] === AGENT_TEST_SETTINGS[key]).map(({ key }) => key),
    features: record.features
      .filter(({ feature, grantedAtIso }) => now.consents.some((consent) => consent.feature === feature && consent.grantedAtIso === grantedAtIso))
      .map(({ feature }) => feature),
    tokens: record.tokens
      .map(({ id, name, added }) => {
        const has = now.tokens.find((token) => token.id === id)?.permissions ?? [];
        return { id, name, permissions: added.filter((permission) => has.includes(permission)) };
      })
      .filter((token) => token.permissions.length > 0),
  };
}

export function anyStillOn(on: AgentTestStillOn): boolean {
  return on.settings.length > 0 || on.features.length > 0 || on.tokens.length > 0;
}

/** The covered writes that count for a pass: those on now, SMS only when the owner kept it in the test. */
export function agentTestCovered(record: Pick<AgentTestRecord, "sms">, consented: (feature: AgentTestFeature) => boolean): AgentTestFeature[] {
  return AGENT_TEST_FEATURES.filter((feature) => consented(feature) && (feature !== "smsWrite" || record.sms));
}

/**
 * The report passed: each covered write that is on now was tried since the test started, and every
 * try reached the router and read back as a match (a redial or reboot still being checked has not).
 */
export function agentTestPassed(
  record: Pick<AgentTestRecord, "startedAtIso">,
  covered: ReadonlyArray<AgentTestFeature>,
  writes: ReadonlyArray<Pick<WriteResultRecord, "atIso" | "feature" | "outcome" | "readback">>
): boolean {
  if (covered.length === 0) return false;
  const sinceMs = Date.parse(record.startedAtIso);
  return covered.every((feature) => {
    const tries = writes.filter((write) => write.feature === feature && Date.parse(write.atIso) >= sinceMs);
    return tries.length > 0 && tries.every((write) => write.outcome === "applied" && write.readback === "match");
  });
}

/** When the next reminder is due (`null`: none, because a reminder was read, the writes passed or nothing is left on). */
export function agentTestReminderDueMs(record: AgentTestRecord, stillOn: boolean, passed: boolean): number | null {
  if (record.acknowledgedAtIso !== null || !stillOn || passed) return null;
  return record.remindedAtIso !== null ? Date.parse(record.remindedAtIso) + AGENT_TEST_REMIND_EVERY_MS : Date.parse(record.lastActivityAtIso) + AGENT_TEST_REMIND_AFTER_MS;
}

export function agentTestView(record: AgentTestRecord, on: AgentTestStillOn, passed: boolean): AgentTestView {
  const due = agentTestReminderDueMs(record, anyStillOn(on), passed);
  return {
    model: record.model,
    startedAtIso: record.startedAtIso,
    sms: record.sms,
    settings: [...on.settings],
    features: [...on.features],
    tokens: on.tokens.map((token) => ({ ...token, permissions: [...token.permissions] })),
    lastActivityAtIso: record.lastActivityAtIso,
    remindedAtIso: record.remindedAtIso,
    acknowledged: record.acknowledgedAtIso !== null,
    passed,
    remindAtIso: due === null ? null : new Date(due).toISOString(),
  };
}

const FEATURES: ReadonlySet<unknown> = new Set<unknown>(AGENT_TEST_FEATURES);
const PERMISSIONS: ReadonlySet<unknown> = new Set<unknown>([...BASE_PERMISSIONS, ...SMS_PERMISSIONS]);
const BEFORE: Readonly<Record<AgentTestSetting, ReadonlySet<unknown>>> = {
  agentExperimental: new Set([true, false, null]),
  agentWrites: new Set([true, false, null]),
  agentSms: new Set(["none", "read", "full", null]),
  agentSmsSendPolicy: new Set(["known", "any", null]),
};
const isText = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is string => isText(value, 64) && Number.isFinite(Date.parse(value));
const isTimeOrNull = (value: unknown): boolean => value === null || isTime(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored test this version can read; anything else is dropped, never half-honoured. */
export function isAgentTestRecord(value: unknown): value is AgentTestRecord {
  if (!isRecord(value)) return false;
  const { settings, features, tokens } = value;
  return (
    isText(value["model"]) &&
    isTime(value["startedAtIso"]) &&
    typeof value["sms"] === "boolean" &&
    Array.isArray(settings) &&
    settings.every((entry: unknown) => isRecord(entry) && Object.hasOwn(BEFORE, String(entry["key"])) && BEFORE[entry["key"] as AgentTestSetting].has(entry["before"])) &&
    Array.isArray(features) &&
    features.every((entry: unknown) => isRecord(entry) && FEATURES.has(entry["feature"]) && isTime(entry["grantedAtIso"])) &&
    Array.isArray(tokens) &&
    tokens.every(
      (entry: unknown) =>
        isRecord(entry) &&
        isText(entry["id"], 64) &&
        isText(entry["name"], 64) &&
        Array.isArray(entry["added"]) &&
        entry["added"].length > 0 &&
        entry["added"].every((permission: unknown) => PERMISSIONS.has(permission))
    ) &&
    isTime(value["lastActivityAtIso"]) &&
    isTimeOrNull(value["remindedAtIso"]) &&
    (value["reminderAlertId"] === null || isText(value["reminderAlertId"], 64)) &&
    isTimeOrNull(value["acknowledgedAtIso"])
  );
}

/** A deep copy (the store hands out copies). */
export function copyAgentTestRecord(record: AgentTestRecord): AgentTestRecord {
  return {
    ...record,
    settings: record.settings.map((entry) => ({ ...entry })),
    features: record.features.map((entry) => ({ ...entry })),
    tokens: record.tokens.map((entry) => ({ ...entry, added: [...entry.added] })),
  };
}
