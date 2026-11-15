import { AGENT_TEST_ASK_FIRST, AGENT_TEST_READ_TOOLS, AGENT_TEST_WRITE_TOOLS, agentTestPermissions } from "../../../src/agent-test.ts";
import type { AgentTestPlan, AgentTestSetting, AgentTestView } from "../../../src/api-contract.ts";
import type { TokenPermission } from "../../../src/console-policy.ts";
import type { WriteFeatureState } from "../../../src/device-access.ts";
import { AGENT_TEST_FEATURES, type AgentTestFeature, CELLULAR_WRITE_FEATURES, type DeviceFeature, type ReadSection, type WriteFeature, featureRead } from "../../../src/features.ts";
import { ROUTER_FAMILY_FACTS, type RouterFamily, familyFeatures } from "../../../src/router-family.ts";
import type { SettingsTextKey } from "../i18n/settings.ts";
import { featureKey } from "./device-view.ts";
import { formatAgo, formatClock } from "./format.ts";
import type { Locale } from "./i18n.ts";
import { brandLabel } from "./router-brand.ts";

/**
 * What the Device tab says about the AI agent test at one click, decided without the DOM: the prompt
 * for the router in use, whether copying it first asks to set things (the agent switches and the
 * token's permissions; the writes themselves are on already), the confirmation's lines and its SMS
 * option, and how the test in progress reads (what ending it puts back, and when a reminder comes).
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

// ── The prompt ────────────────────────────────────────────────────────────────

/** What the test's prompt is built from: the router in use, as the console knows it. */
export interface AgentPromptRouter {
  family: RouterFamily;
  /** The form of its brand's interface it speaks (`null`: the brand's own). */
  variant: string | null;
  model: string;
  firmware: string | null;
  /** Per read section, what it answered (`unavailable`: the router turned out not to have it). */
  reads: Readonly<Record<ReadSection, { state: string }>>;
  features: Readonly<Record<WriteFeature, WriteFeatureState>>;
  sms: Pick<AgentTestPlan["sms"], "available" | "markRead" | "delete">;
  issueUrl: string;
}

/** What the prompt asks of an agent on this router, before any wording (the tests check it brand by brand). */
export interface AgentPromptPlan {
  /** The read tools to call, in order. */
  reads: string[];
  /** The covered writes open on this router, in the registry's order (SMS only where the test can send). */
  writes: AgentTestFeature[];
  /** Covered writes its owner turned off: skipped, and said so. */
  disabled: AgentTestFeature[];
  /** The write tools those use. */
  writeTools: string[];
  /** The writes among them that wait for the owner's yes. */
  askFirst: AgentTestFeature[];
  /** A 5G band lock is tested as well. */
  nrBand: boolean;
  /** The router has access control: the prompt names its writes as no part of the test. */
  accessControl: boolean;
  /** A Huawei HiLink router: the endpoints are probed; on another brand, the device report is gone through instead. */
  probe: boolean;
  /** The report's table: a row per feature FengSui implements for this router, in the registry's order. */
  rows: Array<{ feature: DeviceFeature; access: "read" | "write" }>;
}

const OPEN: ReadonlySet<WriteFeatureState> = new Set<WriteFeatureState>(["enabled", "verified"]);
const ABSENT: ReadonlySet<WriteFeatureState> = new Set<WriteFeatureState>(["not_implemented", "unsupported"]);

export function agentPromptPlan(router: AgentPromptRouter): AgentPromptPlan {
  const has = (section: ReadSection): boolean => router.reads[section]?.state !== "unavailable";
  const writes = AGENT_TEST_FEATURES.filter((feature) => OPEN.has(router.features[feature]) && (feature !== "smsWrite" || router.sms.available));
  const cellular = CELLULAR_WRITE_FEATURES.some((feature) => !ABSENT.has(router.features[feature]));
  return {
    reads: AGENT_TEST_READ_TOOLS.filter(({ section }) => section === null || (section === "cellular" ? cellular : has(section))).map(({ tool }) => tool),
    writes,
    disabled: AGENT_TEST_FEATURES.filter((feature) => router.features[feature] === "disabled"),
    // The unlock undoes a cell lock as well as a band lock; a router that cannot delete SMS gets no delete
    writeTools: AGENT_TEST_WRITE_TOOLS.filter(
      ({ tool, features }) => (features.some((feature) => writes.includes(feature)) || (tool === "unlock_rf_locks" && writes.includes("cellLock"))) && !(tool === "delete_sms" && router.sms.delete === "none")
    ).map(({ tool }) => tool),
    askFirst: writes.filter((feature) => AGENT_TEST_ASK_FIRST.has(feature)),
    // A Huawei router nobody verified gets the 4G band lock its interface notes give; FengSui locks its 5G bands on a verified model only
    nrBand: writes.includes("bandLock") && ROUTER_FAMILY_FACTS[router.family].nrBandLock && router.family !== "huawei",
    accessControl: has("accessControl"),
    probe: router.family === "huawei",
    rows: familyFeatures(router.family, router.variant).filter(({ feature, access }) => {
      if (access === "write") return !ABSENT.has(router.features[feature as WriteFeature]);
      const read = featureRead(feature as Exclude<DeviceFeature, WriteFeature>);
      return read === "status" || has(read);
    }),
  };
}

/** Each covered write's line under "Write tests" (a write without its two lines fails the typecheck here). */
const WRITE_LINES: Readonly<Record<AgentTestFeature, SettingsTextKey>> = {
  smsWrite: "agent_prompt_write_smsWrite",
  bandLock: "agent_prompt_write_bandLock",
  cellLock: "agent_prompt_write_cellLock",
  reboot: "agent_prompt_write_reboot",
  reconnect: "agent_prompt_write_reconnect",
  mobileData: "agent_prompt_write_mobileData",
  securitySwitches: "agent_prompt_write_securitySwitches",
  wifi: "agent_prompt_write_wifi",
  antenna: "agent_prompt_write_antenna",
  simSlot: "agent_prompt_write_simSlot",
  airplaneSwitch: "agent_prompt_write_airplaneSwitch",
  networkMode: "agent_prompt_write_networkMode",
  operatorSelect: "agent_prompt_write_operatorSelect",
  roaming: "agent_prompt_write_roaming",
  apn: "agent_prompt_write_apn",
  dataLimit: "agent_prompt_write_dataLimit",
  trafficReset: "agent_prompt_write_trafficReset",
  ussd: "agent_prompt_write_ussd",
};

/**
 * The prompt for this router: what it is and what the test is for, the safety rules, the steps (only
 * the reads it has and the writes open on it, each with what to watch for), and how to write the report
 * so that its results can be registered and its failures fixed.
 */
export function agentTestPrompt(router: AgentPromptRouter, locale: Locale, t: Text): string {
  const plan = agentPromptPlan(router);
  const list = (items: ReadonlyArray<string>): string => items.join(t("agent_list_separator"));
  const names = (features: ReadonlyArray<AgentTestFeature>): string => list(features.map((feature) => t(featureKey(feature))));
  // A sentence that follows another in the same line: Chinese runs on, English after a space
  const then = (first: string, next: string): string => `${first}${locale === "zh-CN" ? "" : " "}${next}`;
  // The SMS test waits for a reply from the owner's phone: it comes last
  const lastSms = (features: ReadonlyArray<AgentTestFeature>): AgentTestFeature[] => [...features.filter((feature) => feature !== "smsWrite"), ...features.filter((feature) => feature === "smsWrite")];
  const lines = [t("agent_prompt_intro", { brand: brandLabel(router.family, locale), model: router.model, firmware: router.firmware ?? t("agent_prompt_firmware_unknown") }), "", t("agent_prompt_rules")];
  lines.push(t("agent_prompt_rule_tools"), t("agent_prompt_rule_order"), t("agent_prompt_rule_back"));
  if (plan.askFirst.length > 0) lines.push(t("agent_prompt_rule_ask", { items: names(lastSms(plan.askFirst)) }));
  lines.push(t("agent_prompt_rule_pin"));
  if (plan.accessControl) lines.push(t("agent_prompt_rule_access"));
  lines.push(t("agent_prompt_rule_readback"), t("agent_prompt_rule_refused"), t("agent_prompt_rule_privacy"), "", t("agent_prompt_steps"));
  let n = 0;
  const step = (key: SettingsTextKey, params: Record<string, string | number> = {}): string => t(key, { n: ++n, ...params });
  const prepare = step("agent_prompt_step_prepare", { tools: list(plan.writeTools) });
  // Left out of the test, SMS shows no tools to the agent, its status read included
  lines.push(plan.reads.includes("get_sms_status") ? then(prepare, t("agent_prompt_step_prepare_sms")) : prepare);
  lines.push(step("agent_prompt_step_reads", { tools: list(plan.reads) }), step("agent_prompt_step_writes"));
  for (const feature of lastSms(plan.writes)) {
    if (feature === "bandLock") lines.push(plan.nrBand ? then(t(WRITE_LINES.bandLock), t("agent_prompt_write_bandLock_nr")) : t(WRITE_LINES.bandLock));
    else if (feature === "smsWrite") {
      const read = router.sms.markRead === "fengsui" ? "agent_prompt_sms_read_fengsui" : "agent_prompt_sms_read_router";
      const remove = router.sms.delete === "conversation" ? "agent_prompt_sms_delete_conversation" : router.sms.delete === "none" ? "agent_prompt_sms_delete_none" : "agent_prompt_sms_delete_message";
      const tools = AGENT_TEST_WRITE_TOOLS.filter(({ tool, features }) => features.includes("smsWrite") && plan.writeTools.includes(tool)).map(({ tool }) => tool);
      lines.push(t(WRITE_LINES.smsWrite, { tools: list(tools), read: t(read), remove: t(remove) }));
    } else lines.push(t(WRITE_LINES[feature]));
  }
  if (plan.disabled.length > 0) lines.push(t("agent_prompt_disabled", { items: names(plan.disabled) }));
  lines.push(step("agent_prompt_step_page"), step(plan.probe ? "agent_prompt_step_probe" : "agent_prompt_step_report_check"), step("agent_prompt_step_finish"), step("agent_prompt_step_report", { issueUrl: router.issueUrl }));
  const rows = list(plan.rows.map(({ feature, access }) => t(access === "read" ? "agent_prompt_row_read" : "agent_prompt_row_write", { feature })));
  lines.push("", t("agent_prompt_format"), t("agent_prompt_format_router"), t("agent_prompt_format_table", { rows }), t("agent_prompt_format_fix"), t("agent_prompt_format_rest"));
  return lines.join("\n");
}
