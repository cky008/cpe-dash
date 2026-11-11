import { agentTestPermissions } from "../../../src/agent-test.ts";
import type { AgentTestPlan, AgentTestSetting, AgentTestView } from "../../../src/api-contract.ts";
import type { TokenPermission } from "../../../src/console-policy.ts";
import type { SettingsTextKey } from "../i18n/settings.ts";
import { formatAgo, formatClock } from "./format.ts";
import type { Locale } from "./i18n.ts";

/**
 * What the Device tab says about the AI agent test at one click, decided without the DOM: whether
 * copying the prompt first asks to set things (the agent switches and the token's permissions; the
 * writes themselves are on already), the confirmation's lines and its SMS option, and how the test
 * in progress reads (what ending it puts back, and when a reminder comes).
 */

type Text = (key: SettingsTextKey, params?: Record<string, string | number>) => string;

const SETTING_KEYS: Readonly<Record<AgentTestSetting, SettingsTextKey>> = {
  agentExperimental: "agent_exp",
  agentWrites: "agent_writes",
  agentSms: "agent_item_sms_access",
  agentSmsSendPolicy: "agent_item_send_any",
};

const PERMISSION_KEYS: Readonly<Record<TokenPermission, SettingsTextKey>> = {
  control: "agent_perm_control",
  "sms-read": "agent_perm_sms_read",
  "sms-write": "agent_perm_sms_write",
  access: "agent_perm_access",
};

/** The token the console offers first: the one FengSui takes for the agent's, else none (`""`). */
export function defaultAgentToken(plan: AgentTestPlan): string {
  return plan.tokenNeeded ? (plan.suggestedTokenId ?? "") : "";
}

/** What the chosen token would be given (`""` or a token the plan does not offer: nothing). */
export function tokenGets(plan: AgentTestPlan, tokenId: string, sms: boolean): TokenPermission[] {
  const needed = agentTestPermissions(sms);
  return plan.tokens.find((token) => token.id === tokenId)?.missing.filter((permission) => needed.includes(permission)) ?? [];
}

/** Copying the prompt sets something first (and so asks): a setting, or what the chosen token needs. */
export function startTurnsOn(plan: AgentTestPlan, tokenId: string, sms: boolean): boolean {
  if (!plan.available) return false;
  const smsParts = sms && plan.sms.available && plan.sms.settings.length > 0;
  return plan.settings.length > 0 || smsParts || tokenGets(plan, tokenId, sms && plan.sms.available).length > 0;
}

function permissionList(permissions: ReadonlyArray<TokenPermission>, t: Text): string {
  return permissions.map((permission) => t(PERMISSION_KEYS[permission])).join(t("agent_list_separator"));
}

/**
 * The confirmation before the test starts: what it turns on without SMS (SMS is the checkbox below
 * it), the risk, how it ends, and the agent's reconnect.
 */
export function agentStartBody(plan: AgentTestPlan, tokenId: string, t: Text): string[] {
  const token = plan.tokens.find((entry) => entry.id === tokenId) ?? null;
  const routerPermission = token !== null && tokenGets(plan, tokenId, false).length > 0;
  const items = [
    ...plan.settings.map((key) => t(SETTING_KEYS[key])),
    ...(token && routerPermission ? [t("agent_item_token", { name: token.name })] : []),
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

/** The SMS option under the confirmation (`null`: SMS cannot be part of the test here). */
export function smsOption(plan: AgentTestPlan, t: Text): string | null {
  if (!plan.available || !plan.sms.available) return null;
  // What the test does after its message and your reply, as this router's SMS interface allows
  const read = t(plan.sms.markRead === "fengsui" ? "agent_sms_read_fengsui" : "agent_sms_read_router");
  const remove = t(plan.sms.delete === "conversation" ? "agent_sms_delete_conversation" : plan.sms.delete === "none" ? "agent_sms_delete_none" : "agent_sms_delete_message");
  const joiner = /[\u3400-\u9fff]/.test(read) ? "，" : " ";
  return t("agent_sms_check", { limit: plan.sms.sendLimitPerHour, steps: `${read}${joiner}${remove}` });
}

/** How the test in progress reads: when it started and what ending it puts back, then the reminder. */
export function agentTestStatus(view: AgentTestView, nowMs: number, locale: Locale, t: Text): string[] {
  const items = [
    ...view.settings.map((key) => t(SETTING_KEYS[key])),
    ...view.tokens.map((token) => t("agent_item_token_perms", { name: token.name, permissions: permissionList(token.permissions, t) })),
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
