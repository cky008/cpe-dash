import {
  AGENT_TEST_SETTINGS,
  AGENT_TEST_UNAVAILABLE_MESSAGE,
  type AgentTestPlan,
  type AgentTestRecord,
  type AgentTestSettingChange,
  type AgentTestStatus,
  type AgentTestStillOn,
  agentTestCovered,
  agentTestPassed,
  agentTestPermissions,
  agentTestPlan,
  agentTestStillOn,
  agentTestView,
  anyStillOn,
} from "../../../src/agent-test.ts";
import type { AgentTestResponse, DeviceReportResponse, ExperimentalWritesResponse } from "../../../src/api-contract.ts";
import { BEHAVIOUR_ENV, type BehaviourOverrides } from "../../../src/behaviour-settings.ts";
import { TOKEN_PERMISSIONS, type TokenPermission } from "../../../src/console-policy.ts";
import type { DisabledWrite } from "../../../src/console-settings.ts";
import { CpeControlValidationError } from "../../../src/control-error.ts";
import { CONTROL_FEATURES, type ControlAction, DeviceAccess, type DeviceAccessSnapshot, READ_SECTIONS, type WriteFeature, type WriteResultRecord, gateRefuses, modelLabel } from "../../../src/device-access.ts";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature, buildDeviceReport } from "../../../src/device-profile.ts";
import { switchExperimentalWrite } from "../../../src/experimental-switch.ts";
import { verifiedModelsLabel } from "../../../src/firmware.ts";
import { type DemoConsole, DemoRefusal } from "./console.ts";
import type { DemoSeed } from "./seed.ts";

type Body = Readonly<Record<string, unknown>>;
type Text = (key: string, params?: Readonly<Record<string, string | number>>) => { zh: string; en: string };

/** Where each generic write posts (docs/PHASE1_PROTOCOL_SPEC.md A.11), as the daemon records it. */
const GENERIC_ENDPOINTS: Partial<Readonly<Record<ControlAction, string>>> = {
  lock_band: "/api/net/net-mode",
  unlock_rf_locks: "/api/net/net-mode",
  reboot_cpe: "/api/device/control",
  reconnect_cellular: "/api/net/reconnect",
  set_mobile_data: "/api/dialup/mobile-dataswitch",
  sms_send: "/api/sms/send-sms",
  sms_mark_read: "/api/sms/set-read",
  sms_delete: "/api/sms/delete-sms",
};
/** The write results a device report keeps (the daemon's `MAX_GENERIC_WRITES`). */
const MAX_WRITES = 20;

export interface DemoDeviceOptions {
  /** Already rebased onto the visitor's clock. */
  seed: DemoSeed;
  now: () => number;
  console: DemoConsole;
  /** The daemon's messages from the seed's catalog. */
  text: Text;
}

/**
 * The demo router as FengSui's write gate sees it, with the daemon's own rules (src/device-access.ts,
 * src/experimental-switch.ts, src/agent-test.ts). On the verified H168-383 every write is open. On a
 * model FengSui was not verified on (`?router=other`), the writes FengSui implements for it are open
 * as experimental writes, each read back and kept for the device report, until the visitor turns one
 * off in Settings → Device; the rest are refused. The one-click AI agent test sets the agent
 * switches and the token's permissions and puts them back.
 */
export class DemoDevice {
  readonly #now: () => number;
  readonly #console: DemoConsole;
  readonly #text: Text;
  readonly #seed: DemoSeed;
  readonly #access = new DeviceAccess();
  readonly #startedAtIso: string;
  #disabled: DisabledWrite[] = [];
  #writes: WriteResultRecord[] = [];
  #agentTest: AgentTestRecord | null = null;

  constructor(opts: DemoDeviceOptions) {
    this.#now = opts.now;
    this.#console = opts.console;
    this.#text = opts.text;
    this.#seed = opts.seed;
    this.#startedAtIso = new Date(this.#now()).toISOString();
    // The identification the daemon made when the seed was taken (an older seed: the telemetry's model)
    const telemetry = opts.seed.telemetry.telemetry;
    const profile = opts.seed.device?.profile.profile ?? null;
    this.#access.see(profile?.identity.model ?? telemetry?.device.deviceName, profile?.identity.softwareVersion ?? telemetry?.device.softwareVersion);
    if (profile) {
      // A served profile marks each write the probe found evidence for as supported by the probe
      const evidence = Object.fromEntries(EXPERIMENTAL_FEATURES.map((feature) => [feature, profile.capabilities.features[feature]?.source === "probe"]));
      this.#access.noteEvidence(profile.identity.model, evidence as Record<ExperimentalFeature, boolean>, profile.capabilities.lteBands);
    }
    const reads = opts.seed.telemetry.schedulerStatus.device.reads;
    for (const section of READ_SECTIONS) {
      const read = reads[section];
      if (read.state === "available") this.#access.noteRead(section, { available: true });
      else if (read.state === "unavailable") this.#access.noteRead(section, { available: false, code: read.code });
    }
  }

  snapshot(): DeviceAccessSnapshot {
    return this.#access.snapshot();
  }

  /** A model nobody verified: what it may write goes the generic (experimental) way. */
  get generic(): boolean {
    return this.#access.generic;
  }

  /** LTE bands an experimental band lock may use (what the router advertised). */
  get lteBands(): number[] | null {
    return this.#access.experimentalLteBands;
  }

  writeAccess(feature: WriteFeature): ReturnType<DeviceAccess["writeAccess"]> {
    return this.#access.writeAccess(feature);
  }

  /**
   * The daemon's write gate: a write this router may not take is refused before any session (`409`,
   * audited), as turned off (`DEVICE_WRITE_DISABLED`) or as one FengSui has nothing for here.
   */
  gate(action: ControlAction): void {
    const current = this.#access.current;
    const feature = CONTROL_FEATURES[action];
    const access = this.#access.actionAccess(action);
    if (!current || !gateRefuses(access)) return;
    const model = modelLabel(current.model);
    const disabled = access === "disabled";
    const text = this.#text(disabled ? "controls.device_write_disabled" : "controls.device_read_only", { model, verified: verifiedModelsLabel() });
    this.#console.record(action, "refused", text.en);
    throw new DemoRefusal(409, { ok: false, errorCode: disabled ? "DEVICE_WRITE_DISABLED" : "DEVICE_UNVERIFIED_READ_ONLY", message: text.en, messageZh: text.zh, model, feature });
  }

  /**
   * An experimental write the demo router took, kept like the daemon keeps it (the last 20): read back
   * as a match, a redial or reboot pending until the router is back. `null` for a write with no
   * generic form (the gate never lets one through).
   */
  noteWrite(action: ControlAction): WriteResultRecord | null {
    const endpoint = GENERIC_ENDPOINTS[action];
    if (!endpoint) return null;
    const feature = CONTROL_FEATURES[action];
    const record: WriteResultRecord = {
      id: globalThis.crypto.randomUUID(),
      atIso: new Date(this.#now()).toISOString(),
      action,
      feature,
      model: modelLabel(this.#access.current?.model ?? "?"),
      endpoints: [endpoint],
      outcome: "applied",
      code: null,
      readback: feature === "reboot" || feature === "reconnect" ? "pending" : "match",
      reason: null,
    };
    this.#writes = [...this.#writes, record].slice(-MAX_WRITES);
    return record;
  }

  /** What the daemon appends to an experimental write's summary. */
  readbackSuffix(record: WriteResultRecord): { zh: string; en: string } {
    return this.#text(record.readback === "pending" ? "controls.experimental_pending" : "controls.experimental_match");
  }

  /** The router is back after a redial or reboot: a write waiting for that reads back as a match. */
  settleRestarts(): void {
    this.#writes = this.#writes.map((record) => (record.readback === "pending" ? { ...record, readback: "match" } : record));
  }

  // ── The writes turned off (the daemon's ConsoleSettings, in memory) ────────

  get disabledWrites(): DisabledWrite[] {
    return this.#disabled.map((entry) => ({ ...entry }));
  }

  disableWrite(model: string, feature: WriteFeature): boolean {
    if (this.#disabled.some((entry) => entry.model === model && entry.feature === feature)) return false;
    this.#disabled = [...this.#disabled, { model, feature, disabledAtIso: new Date(this.#now()).toISOString() }];
    return true;
  }

  enableWrite(model: string, feature: string): boolean {
    const before = this.#disabled.length;
    this.#disabled = this.#disabled.filter((entry) => !(entry.model === model && entry.feature === feature));
    return this.#disabled.length !== before;
  }

  /** `GET /api/console/experimental`. */
  view(): ExperimentalWritesResponse {
    return {
      ok: true,
      device: this.#access.snapshot(),
      disabled: this.disabledWrites,
      writes: this.#writes.map((record) => ({ ...record, endpoints: [...record.endpoints] })),
      agentTest: this.#agentTestStatus(),
    };
  }

  /** `POST /api/console/experimental`, answered and audited as the daemon does. */
  setExperimental(body: Body): ExperimentalWritesResponse {
    const result = switchExperimentalWrite(this, this.#access, { feature: body["feature"], enabled: body["enabled"] });
    if (result.ok) {
      this.#console.record("settings.experimental", "applied", result.detail);
      return this.view();
    }
    if (result.detail) this.#console.record("settings.experimental", "refused", result.detail);
    if (result.errorCode === "EXPERIMENTAL_UNAVAILABLE") {
      throw new DemoRefusal(409, { ok: false, errorCode: "EXPERIMENTAL_UNAVAILABLE", message: result.message, state: result.state });
    }
    throw new CpeControlValidationError(result.message);
  }

  // ── The AI agent test at one click (the daemon's AgentTestService) ─────────

  /** `POST /api/console/agent-test`. The demo raises no reminder, so reading one changes nothing. */
  agentTest(body: Body): AgentTestResponse {
    const action = body["action"];
    if (action !== "start" && action !== "end" && action !== "ack") throw new CpeControlValidationError('"action" must be "start", "end" or "ack"');
    if (action === "start") {
      this.#beginAgentTest({ model: body["model"], tokenId: body["tokenId"], sms: body["sms"] });
    } else if (action === "end") {
      this.#endAgentTest();
    } else {
      const alertId = body["alertId"];
      if (alertId !== undefined && (typeof alertId !== "string" || alertId.length > 64)) throw new CpeControlValidationError('"alertId" must be the reminder\'s alert ID');
    }
    return { ...this.view(), settings: this.#console.summary() };
  }

  #beginAgentTest(request: { model: unknown; tokenId: unknown; sms: unknown }): void {
    const plan = this.#plan();
    if (!plan.available) throw new DemoRefusal(409, { ok: false, errorCode: "AGENT_TEST_UNAVAILABLE", message: AGENT_TEST_UNAVAILABLE_MESSAGE });
    const current = this.#access.current?.model;
    const shown = this.#access.snapshot().model;
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
    const overrides = this.#console.behaviourOverrides;
    const keys = [...plan.settings, ...(sms ? plan.sms.settings : [])];
    const changes = keys.map((key) => ({ key, before: overrides[key] ?? null }) as AgentTestSettingChange);
    if (changes.length > 0) this.#console.setBehaviour(Object.fromEntries(keys.map((key) => [key, AGENT_TEST_SETTINGS[key]])) as BehaviourOverrides);
    const tokens: Array<{ id: string; name: string; added: TokenPermission[] }> = [];
    const record = token && token.added.length > 0 ? this.#console.listTokens().find((entry) => entry.id === token.id) : undefined;
    if (token && record) {
      const added = token.added;
      this.#console.setTokenPermissions(record.id, TOKEN_PERMISSIONS.filter((permission) => added.includes(permission) || record.permissions.includes(permission)));
      tokens.push(token);
    }
    const before = this.#agentTest;
    if (changes.length + tokens.length === 0) {
      // Nothing new to turn on: only keeping SMS in a test that is on changes what counts for a pass
      if (before && sms && !before.sms) this.#agentTest = { ...before, sms: true };
      return;
    }

    const replace = <T>(kept: ReadonlyArray<T>, added: ReadonlyArray<T>, same: (a: T, b: T) => boolean): T[] => [...kept.filter((a) => !added.some((b) => same(a, b))), ...added];
    // A token given more keeps what the test gave it before: ending takes all of it back
    const given = (before?.tokens ?? []).map((entry) => {
      const more = tokens.find((next) => next.id === entry.id);
      return more ? { ...entry, added: TOKEN_PERMISSIONS.filter((permission) => entry.added.includes(permission) || more.added.includes(permission)) } : entry;
    });
    this.#agentTest = {
      model: shown,
      startedAtIso: before?.startedAtIso ?? nowIso,
      sms: (before?.sms ?? false) || sms,
      settings: replace(before?.settings ?? [], changes, (a, b) => a.key === b.key),
      tokens: [...given, ...tokens.filter((next) => !given.some((entry) => entry.id === next.id))],
      lastActivityAtIso: nowIso,
      remindedAtIso: null,
      reminderAlertId: null,
      acknowledgedAtIso: null,
    };
    const turnedOn = [
      ...changes.map(({ key }) => `${BEHAVIOUR_ENV[key]} ${String(AGENT_TEST_SETTINGS[key])}`),
      ...tokens.map(({ name, added }) => `token "${name}" + ${added.join(" + ")}`),
    ];
    this.#console.record("agents.test", "applied", `${before ? "more" : "start"} for ${shown}${sms ? " with SMS" : ""}: ${turnedOn.join(", ")}`);
  }

  /** Put back what the test set that is still as it left it, and forget the test. */
  #endAgentTest(): void {
    const record = this.#agentTest;
    if (!record) return;
    const on = this.#stillOn(record);
    const restored = record.settings.filter(({ key }) => on.settings.includes(key));
    if (restored.length > 0) this.#console.setBehaviour(Object.fromEntries(restored.map(({ key, before }) => [key, before])) as BehaviourOverrides);
    for (const { id, permissions } of on.tokens) {
      const token = this.#console.listTokens().find((entry) => entry.id === id);
      if (token) this.#console.setTokenPermissions(id, token.permissions.filter((permission) => !permissions.includes(permission)));
    }
    this.#agentTest = null;
    const putBack = [
      ...restored.map(({ key, before }) => `${BEHAVIOUR_ENV[key]} ${before === null ? "from .env" : String(before)}`),
      ...on.tokens.map(({ name, permissions }) => `token "${name}" - ${permissions.join(" - ")}`),
    ];
    this.#console.record("agents.test", "applied", `end: ${putBack.length > 0 ? putBack.join(", ") : "nothing left to put back"}`);
  }

  /** The test in progress and what starting it would turn on; one with nothing left on ends, as the daemon's minute check ends it. */
  #agentTestStatus(): AgentTestStatus {
    const record = this.#agentTest;
    const on = record ? this.#stillOn(record) : null;
    if (record && on && !anyStillOn(on)) {
      this.#agentTest = null;
      this.#console.record("agents.test", "applied", "ended: nothing it turned on is still on", { channel: "system" });
    }
    return { current: this.#agentTest && on ? agentTestView(this.#agentTest, on, this.#passed(this.#agentTest)) : null, plan: this.#plan() };
  }

  #plan(): AgentTestPlan {
    return agentTestPlan({
      device: this.#access.snapshot(),
      values: this.#console.behaviourValues,
      smsReadable: !this.#access.skips("sms"),
      tokens: this.#console.agentTokens(),
      nowMs: this.#now(),
    });
  }

  #stillOn(record: AgentTestRecord): AgentTestStillOn {
    return agentTestStillOn(record, { overrides: this.#console.behaviourOverrides, tokens: this.#console.listTokens() });
  }

  #passed(record: AgentTestRecord): boolean {
    return agentTestPassed(record, agentTestCovered(record, (feature) => this.#access.writeState(feature) === "enabled"), this.#writes);
  }

  // ── The device report ─────────────────────────────────────────────────────

  /** `GET /api/console/device-report`: the seed's report with the write gate and the write results as they are now. */
  report(fengsuiVersion: string): DeviceReportResponse {
    const generatedAtIso = new Date(this.#now()).toISOString();
    const seeded = this.#seed.device?.report.report;
    if (!seeded) {
      const report = buildDeviceReport({ probe: null, apiErrors: { sinceIso: this.#startedAtIso, entries: [] }, fengsuiVersion, generatedAtIso });
      return { ok: true, report };
    }
    const { writes, reads, features } = this.#access.snapshot();
    return {
      ok: true,
      report: {
        ...seeded,
        generatedAtIso,
        access: seeded.access ? { writes, reads, features } : null,
        writes: this.#writes.map(({ id: _id, ...record }) => ({ ...record, endpoints: [...record.endpoints] })),
      },
    };
  }
}
