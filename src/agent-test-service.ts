import {
  AGENT_TEST_SETTINGS,
  AGENT_TEST_TOOLS,
  AGENT_TEST_UNAVAILABLE_MESSAGE,
  type AgentTestPlan,
  type AgentTestRecord,
  type AgentTestSetting,
  type AgentTestSettingChange,
  type AgentTestStatus,
  type AgentTestStillOn,
  agentTestCovered,
  agentTestPassed,
  agentTestPermissions,
  agentTestPlan,
  agentTestReminderDueMs,
  agentTestStillOn,
  agentTestView,
  anyStillOn,
} from "./agent-test.ts";
import type { AuditLog } from "./audit-log.ts";
import { BEHAVIOUR_ENV, type BehaviourOverrides, type BehaviourValues, resolveBehaviour } from "./behaviour-settings.ts";
import { TOKEN_PERMISSIONS, type TokenPermission } from "./console-policy.ts";
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
  /** FengSui reads SMS (SMS_ENABLED): only then can SMS be part of the test. */
  smsEnabled?: boolean;
  /** The test changed console settings: hand the values in force to the running parts, as a change in Settings does. */
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
 * The AI agent test at one click, in the daemon: starting it sets what the plan lists (console
 * settings and what the agent's token needs; those of SMS when the owner keeps it in; the writes
 * themselves are on already), ending it puts back what it set that is still as it left it, and a check every minute
 * raises the `AGENT_TEST_STILL_ON` reminder (alert history, console, Telegram, webhook) when one is
 * due. Every start and end is audited; only a console session or a linked Telegram chat reads a reminder.
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
   * Set what the plan lists, for the model the owner saw (sent back by the console, so a test never
   * starts for another router), with SMS when `sms` is true and the router offers it, and give `tokenId` (one of the plan's
   * tokens) what the test needs. Starting again while a test is on adds what is missing and starts the
   * reminder clock again; with nothing to turn on, nothing changes.
   */
  begin(request: { model: unknown; tokenId?: unknown; sms?: unknown }): AgentTestStatus {
    const { settings, scheduler } = this.#opts;
    const plan = this.#plan();
    if (!plan.available) throw new AgentTestUnavailableError();
    const current = scheduler.device.current?.model;
    const shown = scheduler.device.snapshot().model;
    const typed = typeof request.model === "string" && request.model.length <= 256 ? request.model.trim().toLowerCase() : "";
    if (!current || !shown || shown === "?" || typed !== shown.toLowerCase()) {
      throw new CpeControlValidationError(`Start the test for the router's model (${shown ?? "?"})`);
    }
    if (request.sms !== undefined && typeof request.sms !== "boolean") throw new CpeControlValidationError('"sms" must be true or false');
    const sms = request.sms === true && plan.sms.available;
    let token: { id: string; name: string; added: TokenPermission[] } | null = null;
    if (request.tokenId !== undefined && request.tokenId !== null) {
      const choice = typeof request.tokenId === "string" ? plan.tokens.find((entry) => entry.id === request.tokenId) : undefined;
      if (!choice) throw new CpeControlValidationError("That token cannot be given what the test needs (it may have it already, have expired or been revoked)");
      const needed = agentTestPermissions(sms);
      token = { id: choice.id, name: choice.name, added: choice.missing.filter((permission) => needed.includes(permission)) };
    }

    const nowIso = new Date(this.#now()).toISOString();
    const overrides = settings.behaviourOverrides;
    const keys = [...plan.settings, ...(sms ? plan.sms.settings : [])];
    const changes = keys.map((key) => ({ key, before: overrides[key] ?? null }) as AgentTestSettingChange);
    if (changes.length > 0) {
      settings.setBehaviour(Object.fromEntries(keys.map((key) => [key, AGENT_TEST_SETTINGS[key]])) as BehaviourOverrides);
      this.#opts.onBehaviourChanged?.(this.#behaviour());
    }
    const tokens: Array<{ id: string; name: string; added: TokenPermission[] }> = [];
    const record = token && token.added.length > 0 ? settings.listTokens().find((entry) => entry.id === token.id) : undefined;
    if (token && record) {
      const added = token.added;
      settings.setTokenPermissions(record.id, TOKEN_PERMISSIONS.filter((permission) => added.includes(permission) || record.permissions.includes(permission)));
      this.#opts.onTokenChanged?.(record.id);
      tokens.push(token);
    }
    const before = settings.agentTest;
    if (changes.length + tokens.length === 0) {
      // Nothing new to turn on: only keeping SMS in a test that is on changes what counts for a pass
      if (before && sms && !before.sms) settings.setAgentTest({ ...before, sms: true });
      return this.status();
    }

    const replace = <T>(kept: ReadonlyArray<T>, added: ReadonlyArray<T>, same: (a: T, b: T) => boolean): T[] => [...kept.filter((a) => !added.some((b) => same(a, b))), ...added];
    // A token given more keeps what the test gave it before: ending takes all of it back
    const given = (before?.tokens ?? []).map((entry) => {
      const more = tokens.find((next) => next.id === entry.id);
      return more ? { ...entry, added: TOKEN_PERMISSIONS.filter((permission) => entry.added.includes(permission) || more.added.includes(permission)) } : entry;
    });
    settings.setAgentTest({
      model: shown,
      startedAtIso: before?.startedAtIso ?? nowIso,
      sms: (before?.sms ?? false) || sms,
      settings: replace(before?.settings ?? [], changes, (a, b) => a.key === b.key),
      tokens: [...given, ...tokens.filter((next) => !given.some((entry) => entry.id === next.id))],
      lastActivityAtIso: nowIso,
      remindedAtIso: null,
      reminderAlertId: null,
      acknowledgedAtIso: null,
    });
    const turnedOn = [
      ...changes.map(({ key }) => `${BEHAVIOUR_ENV[key]} ${String(AGENT_TEST_SETTINGS[key])}`),
      ...tokens.map(({ name, added }) => `token "${name}" + ${added.join(" + ")}`),
    ];
    this.#opts.audit?.record({ action: "agents.test", outcome: "applied", detail: `${before ? "more" : "start"} for ${shown}${sms ? " with SMS" : ""}: ${turnedOn.join(", ")}` });
    return this.status();
  }

  /** Put back what the test set that is still as it left it, and forget the test. The writes stay as they are: on by default, off where the owner turned one off. */
  end(): AgentTestStatus {
    const { settings } = this.#opts;
    const record = settings.agentTest;
    if (!record) return this.status();
    const on = this.#stillOn(record);
    const restored = record.settings.filter(({ key }) => on.settings.includes(key));
    if (restored.length > 0) {
      settings.setBehaviour(Object.fromEntries(restored.map(({ key, before }) => [key, before])) as BehaviourOverrides);
      this.#opts.onBehaviourChanged?.(this.#behaviour());
    }
    for (const { id, permissions } of on.tokens) {
      const token = settings.listTokens().find((entry) => entry.id === id);
      if (!token) continue;
      settings.setTokenPermissions(id, token.permissions.filter((permission) => !permissions.includes(permission)));
      this.#opts.onTokenChanged?.(id);
    }
    settings.setAgentTest(null);
    const putBack = [
      ...restored.map(({ key, before }) => `${BEHAVIOUR_ENV[key]} ${before === null ? "from .env" : String(before)}`),
      ...on.tokens.map(({ name, permissions }) => `token "${name}" - ${permissions.join(" - ")}`),
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
    const { scheduler, settings } = this.#opts;
    return agentTestPlan({
      device: scheduler.device.snapshot(),
      values: this.#behaviour(),
      smsReadable: this.#opts.smsEnabled === true && !scheduler.device.skips("sms"),
      tokens: settings
        .listTokens()
        .map((token) => ({ id: token.id, name: token.name, permissions: token.permissions, createdAtIso: token.createdAtIso, expiresAtIso: token.expiresAtIso, agentUsedAtMs: this.#agentUse.get(token.id) ?? null })),
      nowMs: this.#now(),
    });
  }

  #stillOn(record: AgentTestRecord): AgentTestStillOn {
    const { settings } = this.#opts;
    return agentTestStillOn(record, { overrides: settings.behaviourOverrides, tokens: settings.listTokens() });
  }

  /** Every covered write that is open now passed since the test started. */
  #passed(record: AgentTestRecord): boolean {
    const { device } = this.#opts.scheduler;
    return agentTestPassed(record, agentTestCovered(record, (feature) => device.writeState(feature) === "enabled"), this.#opts.scheduler.genericWrites);
  }

  #message(locale: SupportedLocale, record: AgentTestRecord, on: AgentTestStillOn): string {
    const text = (key: string, params?: Readonly<Record<string, string | number>>): string => t(locale, `agent_test.${key}` as I18nKey, params);
    const list = (items: ReadonlyArray<string>): string => items.join(text("list_separator"));
    const items = [
      ...on.settings.map((key: AgentTestSetting) => text(`setting_${key}`)),
      ...on.tokens.map(({ name, permissions }) => text("token", { name: sanitizeFreeText(name), permissions: list(permissions.map((permission) => text(`permission_${permission}`))) })),
    ];
    return t(locale, "alerts.agent_test_still_on", { model: record.model, items: items.join(text("item_separator")) });
  }
}
