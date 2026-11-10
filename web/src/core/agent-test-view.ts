import type { AgentTestFeature, AgentTestPlan, AgentTestSwitch, AgentTestView } from "../../../src/api-contract.ts";
import type { SettingsTextKey } from "../i18n/settings.ts";
import { FEATURE_KEYS } from "./device-view.ts";
import { formatAgo, formatClock } from "./format.ts";
import type { Locale } from "./i18n.ts";

/**
 * What the Device tab says about the AI agent test at one click, decided without the DOM: whether
 * copying the prompt first asks to turn things on, the confirmation's lines, and how the test in
 * progress reads (what ending it puts back, and when a reminder comes).
 */

type Text = (key: SettingsTextKey, params?: Record<string, string | number>) => string;

const SWITCH_KEYS: Readonly<Record<AgentTestSwitch, SettingsTextKey>> = {
  agentExperimental: "agent_exp",
  agentWrites: "agent_writes",
};

/** The token the console offers first: the one FengSui takes for the agent's, else none (`""`). */
export function defaultAgentToken(plan: AgentTestPlan): string {
  return plan.tokenNeeded ? (plan.suggestedTokenId ?? "") : "";
}

/** Copying the prompt turns something on first (and so asks): a switch, a write, or the chosen token. */
export function startTurnsOn(plan: AgentTestPlan, tokenId: string): boolean {
  return plan.available && (plan.switches.length > 0 || plan.features.length > 0 || plan.tokens.some((token) => token.id === tokenId));
}

function featureList(features: ReadonlyArray<AgentTestFeature>, t: Text): string {
  return features.map((feature) => t(FEATURE_KEYS[feature])).join(t("agent_list_separator"));
}

/** The confirmation before the test starts: what it turns on, the risk, how it ends, and the agent's reconnect. */
export function agentStartBody(plan: AgentTestPlan, tokenId: string, t: Text): string[] {
  const token = plan.tokens.find((entry) => entry.id === tokenId) ?? null;
  const items = [
    ...plan.switches.map((key) => t(SWITCH_KEYS[key])),
    ...(plan.features.length > 0 ? [t("agent_item_features", { features: featureList(plan.features, t) })] : []),
    ...(token ? [t("agent_item_token", { name: token.name })] : []),
  ];
  return [
    t("agent_start_intro"),
    ...items.map((item) => `· ${item}`),
    ...(token === null && plan.tokenNeeded ? [t("agent_no_token")] : []),
    t("agent_start_risk"),
    t("agent_start_end"),
    t("agent_start_reconnect"),
  ];
}

/** How the test in progress reads: when it started and what ending it puts back, then the reminder. */
export function agentTestStatus(view: AgentTestView, nowMs: number, locale: Locale, t: Text): string[] {
  const items = [
    ...view.switches.map((key) => t(SWITCH_KEYS[key])),
    ...(view.features.length > 0 ? [featureList(view.features, t)] : []),
    ...view.tokens.map((token) => t("agent_item_token_short", { name: token.name })),
  ];
  const lines = [t("agent_status_on", { when: formatAgo(Date.parse(view.startedAtIso), nowMs, locale), items: items.join(t("agent_item_separator")) })];
  if (view.passed) lines.push(t("agent_status_passed"));
  else if (view.acknowledged) lines.push(t("agent_status_read"));
  else if (view.remindAtIso) {
    const atMs = Date.parse(view.remindAtIso);
    const at = formatClock(atMs, new Date(atMs).toDateString() !== new Date(nowMs).toDateString());
    lines.push(t(view.remindedAtIso ? "agent_status_reminded" : "agent_status_remind", { at }));
  }
  return lines;
}

/** A reminder is out and not read yet: the console offers "Got it". */
export function reminderWaiting(view: AgentTestView | null): boolean {
  return view !== null && view.remindedAtIso !== null && !view.acknowledged && !view.passed;
}
