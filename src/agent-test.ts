import type { BehaviourKey } from "./behaviour-settings.ts";
import type { TokenPermission } from "./console-policy.ts";
import type { WriteAccess, WriteFeature, WriteFeatureState, WriteResultRecord } from "./device-access.ts";
import type { ExperimentalFeature } from "./device-profile.ts";

/**
 * Testing the router with an AI agent at one click (Settings → Device, on a model FengSui was not
 * verified on). Starting the test turns on everything it needs as one informed choice, and ending it
 * puts back exactly what it turned on that is still as it left it. While something it turned on stays
 * on, the owner is reminded a few hours after the test's last call, then daily, until a reminder is
 * read or every write the test covers has read back as a match. No dependencies: the daemon, the
 * console and the online demo share these rules.
 */

/** The experimental writes the test covers: what an agent's tools can write (there is no mobile-data tool), short of SMS, which sends real messages. */
export const AGENT_TEST_FEATURES = ["bandLock", "reconnect", "reboot"] as const satisfies ReadonlyArray<ExperimentalFeature>;
export type AgentTestFeature = (typeof AGENT_TEST_FEATURES)[number];

/** The console switches the test needs: agents may test this router, and may change it. */
export const AGENT_TEST_SWITCHES = ["agentExperimental", "agentWrites"] as const satisfies ReadonlyArray<BehaviourKey>;
export type AgentTestSwitch = (typeof AGENT_TEST_SWITCHES)[number];

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
]);

/** The test in progress, as the console keeps it (`settings.json`). */
export interface AgentTestRecord {
  /** The router's model the owner started the test for. */
  model: string;
  startedAtIso: string;
  /** Console switches the test turned on, with the console's value before (`null`: it followed `.env`). */
  switches: Array<{ key: AgentTestSwitch; before: boolean | null }>;
  /** Experimental writes the test turned on, with each consent's time (one given again later is the owner's own). */
  features: Array<{ feature: AgentTestFeature; grantedAtIso: string }>;
  /** Tokens the test allowed to change the router. */
  tokens: Array<{ id: string; name: string }>;
  /** The test's last call by an agent (`AGENT_TEST_TOOLS`), or its latest start. */
  lastActivityAtIso: string;
  remindedAtIso: string | null;
  /** The alert of the last reminder: reading it in the console reads the reminder. */
  reminderAlertId: string | null;
  /** The owner read a reminder: none follows for this test. */
  acknowledgedAtIso: string | null;
}

/** A token the console can offer to let change the router for the test. */
export interface AgentTestTokenChoice {
  id: string;
  name: string;
  /** Its last call to FengSui's MCP endpoint since the daemon started (`null`: none seen). */
  agentUsedAtIso: string | null;
}

/** What starting the test would turn on now. */
export interface AgentTestPlan {
  /** The router is a model FengSui was not verified on, with a write the test covers on offer or on. */
  available: boolean;
  /** Console switches the test needs that are off. */
  switches: AgentTestSwitch[];
  /** Writes the test covers that this router offers and that are still off. */
  features: AgentTestFeature[];
  /** Tokens that may not change the router yet, the one an agent used last first. */
  tokens: AgentTestTokenChoice[];
  /** The agent's token as far as FengSui can tell: the last one used on MCP, else the only one to choose from. */
  suggestedTokenId: string | null;
  /** The test's writes need the agent's token to be allowed to change the router, and FengSui cannot see that it is. */
  tokenNeeded: boolean;
}

/** The test in progress, as the console shows it. */
export interface AgentTestView {
  model: string;
  startedAtIso: string;
  /** What the test turned on that is still as it left it: ending the test puts these back. */
  switches: AgentTestSwitch[];
  features: AgentTestFeature[];
  tokens: Array<{ id: string; name: string }>;
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
  return { available: false, switches: [], features: [], tokens: [], suggestedTokenId: null, tokenNeeded: false };
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

/**
 * What starting the test would turn on: on a model FengSui was not verified on with a write the test
 * covers, the switches that are off, the covered writes on offer and not on, and the tokens that could
 * be allowed to change the router, the agent's first.
 */
export function agentTestPlan(input: {
  device: { writes: WriteAccess; features: Readonly<Record<WriteFeature, WriteFeatureState>> };
  switches: Readonly<Record<AgentTestSwitch, boolean>>;
  tokens: ReadonlyArray<AgentTestTokenInfo>;
  nowMs: number;
}): AgentTestPlan {
  const { device } = input;
  const covered = AGENT_TEST_FEATURES.filter((feature) => device.features[feature] === "available" || device.features[feature] === "consented");
  if (device.writes !== "read_only" || covered.length === 0) return noAgentTestPlan();
  const live = input.tokens.filter((token) => token.expiresAtIso === null || Date.parse(token.expiresAtIso) > input.nowMs);
  const mayChange = (token: AgentTestTokenInfo): boolean => token.permissions.includes("control");
  let agent: AgentTestTokenInfo | null = null;
  for (const token of live) if (token.agentUsedAtMs !== null && (agent === null || token.agentUsedAtMs > (agent.agentUsedAtMs ?? 0))) agent = token;
  const candidates = live
    .filter((token) => !mayChange(token))
    .sort((a, b) => (b.agentUsedAtMs ?? -1) - (a.agentUsedAtMs ?? -1) || b.createdAtIso.localeCompare(a.createdAtIso));
  let suggested: string | null = null;
  if (agent !== null && !mayChange(agent)) suggested = agent.id;
  else if (agent === null && candidates.length === 1) suggested = candidates[0]?.id ?? null;
  return {
    available: true,
    switches: AGENT_TEST_SWITCHES.filter((key) => !input.switches[key]),
    features: covered.filter((feature) => device.features[feature] === "available"),
    tokens: candidates.map((token) => ({ id: token.id, name: token.name, agentUsedAtIso: token.agentUsedAtMs === null ? null : new Date(token.agentUsedAtMs).toISOString() })),
    suggestedTokenId: suggested,
    tokenNeeded: candidates.length > 0 && !(agent !== null && mayChange(agent)),
  };
}

/** What the test turned on that is still as it left it. */
export interface AgentTestStillOn {
  switches: AgentTestSwitch[];
  features: AgentTestFeature[];
  tokens: Array<{ id: string; name: string }>;
}

export function agentTestStillOn(
  record: AgentTestRecord,
  now: {
    /** The console's own values (`null` or missing: it follows `.env`). */
    overrides: Readonly<Partial<Record<AgentTestSwitch, boolean | null>>>;
    consents: ReadonlyArray<{ feature: string; grantedAtIso: string }>;
    tokens: ReadonlyArray<{ id: string; permissions: ReadonlyArray<TokenPermission> }>;
  }
): AgentTestStillOn {
  return {
    switches: record.switches.filter(({ key }) => now.overrides[key] === true).map(({ key }) => key),
    features: record.features
      .filter(({ feature, grantedAtIso }) => now.consents.some((consent) => consent.feature === feature && consent.grantedAtIso === grantedAtIso))
      .map(({ feature }) => feature),
    tokens: record.tokens.filter(({ id }) => now.tokens.some((token) => token.id === id && token.permissions.includes("control"))).map((token) => ({ ...token })),
  };
}

export function anyStillOn(on: AgentTestStillOn): boolean {
  return on.switches.length > 0 || on.features.length > 0 || on.tokens.length > 0;
}

/**
 * The report passed: each covered write that is on now was tried since the test started, and every
 * try reached the router and read back as a match (a redial or reboot still being checked has not).
 */
export function agentTestPassed(
  record: Pick<AgentTestRecord, "startedAtIso">,
  consented: ReadonlyArray<AgentTestFeature>,
  writes: ReadonlyArray<Pick<WriteResultRecord, "atIso" | "feature" | "outcome" | "readback">>
): boolean {
  if (consented.length === 0) return false;
  const sinceMs = Date.parse(record.startedAtIso);
  return consented.every((feature) => {
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
    switches: [...on.switches],
    features: [...on.features],
    tokens: on.tokens.map((token) => ({ ...token })),
    lastActivityAtIso: record.lastActivityAtIso,
    remindedAtIso: record.remindedAtIso,
    acknowledged: record.acknowledgedAtIso !== null,
    passed,
    remindAtIso: due === null ? null : new Date(due).toISOString(),
  };
}

const FEATURES: ReadonlySet<unknown> = new Set<unknown>(AGENT_TEST_FEATURES);
const SWITCHES: ReadonlySet<unknown> = new Set<unknown>(AGENT_TEST_SWITCHES);
const isText = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const isTime = (value: unknown): value is string => isText(value, 64) && Number.isFinite(Date.parse(value));
const isTimeOrNull = (value: unknown): boolean => value === null || isTime(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored test this version can read; anything else is dropped, never half-honoured. */
export function isAgentTestRecord(value: unknown): value is AgentTestRecord {
  if (!isRecord(value)) return false;
  const { switches, features, tokens } = value;
  return (
    isText(value["model"]) &&
    isTime(value["startedAtIso"]) &&
    Array.isArray(switches) &&
    switches.every((entry: unknown) => isRecord(entry) && SWITCHES.has(entry["key"]) && (entry["before"] === null || typeof entry["before"] === "boolean")) &&
    Array.isArray(features) &&
    features.every((entry: unknown) => isRecord(entry) && FEATURES.has(entry["feature"]) && isTime(entry["grantedAtIso"])) &&
    Array.isArray(tokens) &&
    tokens.every((entry: unknown) => isRecord(entry) && isText(entry["id"], 64) && isText(entry["name"], 64)) &&
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
    switches: record.switches.map((entry) => ({ ...entry })),
    features: record.features.map((entry) => ({ ...entry })),
    tokens: record.tokens.map((entry) => ({ ...entry })),
  };
}
