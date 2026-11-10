import {
  AGENT_TEST_FEATURES,
  AGENT_TEST_TOOLS,
  AGENT_TEST_UNAVAILABLE_MESSAGE,
  type AgentTestFeature,
  type AgentTestPlan,
  type AgentTestRecord,
  type AgentTestStatus,
  type AgentTestStillOn,
  type AgentTestSwitch,
  agentTestPassed,
  agentTestPlan,
  agentTestReminderDueMs,
  agentTestStillOn,
  agentTestView,
  anyStillOn,
} from "./agent-test.ts";
import type { AuditLog } from "./audit-log.ts";
import { BEHAVIOUR_ENV, type BehaviourOverrides, type BehaviourValues, resolveBehaviour } from "./behaviour-settings.ts";
import { TOKEN_PERMISSIONS } from "./console-policy.ts";
import type { ConsoleSettings } from "./console-settings.ts";
import { CpeControlValidationError } from "./control-error.ts";
import { type I18nKey, t } from "./i18n.ts";
import { sanitizeFreeText } from "./sanitize.ts";
import type { MutexSessionScheduler } from "./scheduler.ts";
import type { SupportedLocale } from "./types.ts";

/** This router has nothing for an agent's test to write: a verified model, none identified yet, or no covered write on offer. */
export class AgentTestUnavailableError extends Error {
  constructor() {
    super(AGENT_TEST_UNAVAILABLE_MESSAGE);
    this.name = "AgentTestUnavailableError";
  }
}

export interface AgentTestServiceOptions {
  settings: ConsoleSettings;
  scheduler: MutexSessionScheduler;
  audit: AuditLog | null;
  /** What `.env` says for the behaviour settings (it can be reloaded, hence a function). */
  behaviourFromEnv: () => BehaviourValues;
  /** The test changed console switches: hand the values in force to the running parts, as a change in Settings does. */
  onBehaviourChanged?: (values: BehaviourValues) => void;
  /** The test changed what a token may do: its event streams reconnect under the new permissions. */
  onTokenChanged?: (tokenId: string) => void;
  now?: () => number;
  /** How often the reminder is checked (default a minute; the reminder is hours away). */
  checkEveryMs?: number;
}

/** A stored activity time moves at most this often (the reminder is hours away). */
const ACTIVITY_SAVE_MS = 60_000;

/**
 * The AI agent test at one click, in the daemon: starting it turns on what the plan lists (console
 * switches, the covered experimental writes, the router permission for the agent's token), ending it
 * puts back what it turned on that is still as it left it, and a check every minute raises the
 * `AGENT_TEST_STILL_ON` reminder (alert history, console, Telegram, webhook) when one is due. Every
 * start and end is audited; only a console session or a linked Telegram chat reads a reminder.
 */
export class AgentTestService {
  readonly #opts: AgentTestServiceOptions;
  readonly #now: () => number;
  /** Each token's last call to the MCP endpoint in this run (ms): the agent's token is the latest. */
  readonly #agentUse = new Map<string, number>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: AgentTestServiceOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.check(), this.#opts.checkEveryMs ?? 60_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** A token called the MCP endpoint (the agent's token is the one that called last). */
  noteAgentCall(tokenId: string): void {
    this.#agentUse.set(tokenId, this.#now());
  }

  /** An MCP tool was called: one of the test's moves the first reminder back. */
  noteToolCall(toolName: string): void {
    if (!AGENT_TEST_TOOLS.has(toolName)) return;
    const record = this.#opts.settings.agentTest;
    const nowMs = this.#now();
    if (!record || nowMs - Date.parse(record.lastActivityAtIso) < ACTIVITY_SAVE_MS) return;
    this.#opts.settings.setAgentTest({ ...record, lastActivityAtIso: new Date(nowMs).toISOString() });
  }

  status(): AgentTestStatus {
    const record = this.#opts.settings.agentTest;
    const on = record ? this.#stillOn(record) : null;
    return { current: record && on && anyStillOn(on) ? agentTestView(record, on, this.#passed(record)) : null, plan: this.#plan() };
  }

  /**
   * Turn on what the plan lists, for the model the owner saw (typed back by the console, as a consent
   * is), and `tokenId` (one of the plan's tokens) may change the router. Starting again while a test
   * is on adds what is missing and starts the reminder clock again; with nothing to turn on, nothing
   * changes.
   */
  begin(request: { model: unknown; tokenId?: unknown }): AgentTestStatus {
    const { settings, scheduler } = this.#opts;
    const plan = this.#plan();
    if (!plan.available) throw new AgentTestUnavailableError();
    const current = scheduler.device.current?.model;
    const shown = scheduler.device.snapshot().model;
    const typed = typeof request.model === "string" && request.model.length <= 256 ? request.model.trim().toLowerCase() : "";
    if (!current || !shown || shown === "?" || typed !== shown.toLowerCase()) {
      throw new CpeControlValidationError(`Start the test for the router's model (${shown ?? "?"})`);
    }
    let token: { id: string; name: string } | null = null;
    if (request.tokenId !== undefined && request.tokenId !== null) {
      const choice = typeof request.tokenId === "string" ? plan.tokens.find((entry) => entry.id === request.tokenId) : undefined;
      if (!choice) throw new CpeControlValidationError("That token cannot be allowed to change the router for the test (it may already be allowed, have expired or been revoked)");
      token = { id: choice.id, name: choice.name };
    }

    const nowIso = new Date(this.#now()).toISOString();
    const overrides = settings.behaviourOverrides;
    const switches = plan.switches.map((key) => ({ key, before: overrides[key] ?? null }));
    if (switches.length > 0) {
      settings.setBehaviour(Object.fromEntries(switches.map(({ key }) => [key, true])) as BehaviourOverrides);
      this.#opts.onBehaviourChanged?.(this.#behaviour());
    }
    const features = plan.features.map((feature) => ({ feature, grantedAtIso: settings.grantExperimental(current, feature).grantedAtIso }));
    if (features.length > 0) scheduler.device.setConsents(settings.experimentalConsents);
    const tokens: Array<{ id: string; name: string }> = [];
    const record = token ? settings.listTokens().find((entry) => entry.id === token.id) : undefined;
    if (token && record) {
      settings.setTokenPermissions(record.id, TOKEN_PERMISSIONS.filter((permission) => permission === "control" || record.permissions.includes(permission)));
      this.#opts.onTokenChanged?.(record.id);
      tokens.push(token);
    }
    if (switches.length + features.length + tokens.length === 0) return this.status();

    const before = settings.agentTest;
    const replace = <T>(kept: ReadonlyArray<T>, added: ReadonlyArray<T>, same: (a: T, b: T) => boolean): T[] => [...kept.filter((a) => !added.some((b) => same(a, b))), ...added];
    settings.setAgentTest({
      model: shown,
      startedAtIso: before?.startedAtIso ?? nowIso,
      switches: replace(before?.switches ?? [], switches, (a, b) => a.key === b.key),
      features: replace(before?.features ?? [], features, (a, b) => a.feature === b.feature),
      tokens: replace(before?.tokens ?? [], tokens, (a, b) => a.id === b.id),
      lastActivityAtIso: nowIso,
      remindedAtIso: null,
      reminderAlertId: null,
      acknowledgedAtIso: null,
    });
    const turnedOn = [
      ...switches.map(({ key }) => `${BEHAVIOUR_ENV[key]} on`),
      ...features.map(({ feature }) => `${feature} on`),
      ...tokens.map(({ name }) => `token "${name}" + control`),
    ];
    this.#opts.audit?.record({ action: "agents.test", outcome: "applied", detail: `${before ? "more" : "start"} for ${shown}: ${turnedOn.join(", ")}` });
    return this.status();
  }

  /** Put back what the test turned on that is still as it left it, and forget the test. */
  end(): AgentTestStatus {
    const { settings, scheduler } = this.#opts;
    const record = settings.agentTest;
    if (!record) return this.status();
    const on = this.#stillOn(record);
    const patch: Record<string, boolean | null> = {};
    for (const { key, before } of record.switches) if (on.switches.includes(key)) patch[key] = before;
    if (Object.keys(patch).length > 0) {
      settings.setBehaviour(patch as BehaviourOverrides);
      this.#opts.onBehaviourChanged?.(this.#behaviour());
    }
    for (const feature of on.features) settings.revokeExperimental(feature);
    if (on.features.length > 0) scheduler.device.setConsents(settings.experimentalConsents);
    for (const { id } of on.tokens) {
      const token = settings.listTokens().find((entry) => entry.id === id);
      if (!token) continue;
      settings.setTokenPermissions(id, token.permissions.filter((permission) => permission !== "control"));
      this.#opts.onTokenChanged?.(id);
    }
    settings.setAgentTest(null);
    const putBack = [
      ...record.switches.filter(({ key }) => on.switches.includes(key)).map(({ key, before }) => `${BEHAVIOUR_ENV[key]} ${before === null ? "from .env" : String(before)}`),
      ...on.features.map((feature) => `${feature} off`),
      ...on.tokens.map(({ name }) => `token "${name}" - control`),
    ];
    this.#opts.audit?.record({ action: "agents.test", outcome: "applied", detail: `end: ${putBack.length > 0 ? putBack.join(", ") : "nothing left to put back"}` });
    return this.status();
  }

  /**
   * The owner read a reminder (the console's alerts showed `alertId`, or a Telegram chat chose "Got
   * it"): no more for this test. `false` when no reminder of this test is waiting to be read.
   */
  acknowledge(alertId: string | null = null): boolean {
    const { settings } = this.#opts;
    const record = settings.agentTest;
    if (!record || record.remindedAtIso === null || record.acknowledgedAtIso !== null) return false;
    if (alertId !== null && alertId !== record.reminderAlertId) return false;
    settings.setAgentTest({ ...record, acknowledgedAtIso: new Date(this.#now()).toISOString() });
    this.#opts.audit?.record({ action: "agents.test", outcome: "applied", detail: "reminder read" });
    return true;
  }

  /** Remind when one is due; a test with nothing left on ends by itself. */
  check(): void {
    const { settings, scheduler } = this.#opts;
    const record = settings.agentTest;
    if (!record) return;
    const on = this.#stillOn(record);
    if (!anyStillOn(on)) {
      settings.setAgentTest(null);
      this.#opts.audit?.record({ action: "agents.test", outcome: "applied", detail: "ended: nothing it turned on is still on", actor: { channel: "system" } });
      return;
    }
    const due = agentTestReminderDueMs(record, true, this.#passed(record));
    const nowMs = this.#now();
    if (due === null || nowMs < due) return;
    const alert = scheduler.raiseAlert({ severity: "warning", code: "AGENT_TEST_STILL_ON", messageZh: this.#message("zh-CN", record, on), messageEn: this.#message("en", record, on) });
    settings.setAgentTest({ ...record, remindedAtIso: new Date(nowMs).toISOString(), reminderAlertId: alert.id });
  }

  #behaviour(): BehaviourValues {
    return resolveBehaviour(this.#opts.behaviourFromEnv(), this.#opts.settings.behaviourOverrides);
  }

  #plan(): AgentTestPlan {
    const values = this.#behaviour();
    return agentTestPlan({
      device: this.#opts.scheduler.device.snapshot(),
      switches: { agentExperimental: values.agentExperimental, agentWrites: values.agentWrites },
      tokens: this.#opts.settings
        .listTokens()
        .map((token) => ({ id: token.id, name: token.name, permissions: token.permissions, createdAtIso: token.createdAtIso, expiresAtIso: token.expiresAtIso, agentUsedAtMs: this.#agentUse.get(token.id) ?? null })),
      nowMs: this.#now(),
    });
  }

  #stillOn(record: AgentTestRecord): AgentTestStillOn {
    const { settings } = this.#opts;
    return agentTestStillOn(record, { overrides: settings.behaviourOverrides, consents: settings.experimentalConsents, tokens: settings.listTokens() });
  }

  /** Every covered write that is on now passed since the test started. */
  #passed(record: AgentTestRecord): boolean {
    const { device } = this.#opts.scheduler;
    const consented = AGENT_TEST_FEATURES.filter((feature) => device.writeState(feature) === "consented");
    return agentTestPassed(record, consented, this.#opts.scheduler.genericWrites);
  }

  #message(locale: SupportedLocale, record: AgentTestRecord, on: AgentTestStillOn): string {
    const label = (switchKey: AgentTestSwitch): string => t(locale, `agent_test.switch_${switchKey}` as I18nKey);
    const feature = (name: AgentTestFeature): string => t(locale, `agent_test.feature_${name}` as I18nKey);
    const items = [
      ...on.switches.map(label),
      ...(on.features.length > 0 ? [t(locale, "agent_test.features", { features: on.features.map(feature).join(t(locale, "agent_test.list_separator")) })] : []),
      ...on.tokens.map(({ name }) => t(locale, "agent_test.token", { name: sanitizeFreeText(name) })),
    ];
    return t(locale, "alerts.agent_test_still_on", { model: record.model, items: items.join(t(locale, "agent_test.item_separator")) });
  }
}
