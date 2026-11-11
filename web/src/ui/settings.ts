import type {
  AgentTestResponse,
  ConsoleSettingsResponse,
  DeviceProfileResponse,
  DeviceReport,
  EndpointState,
  ExperimentalWritesResponse,
  PairingCodeResponse,
  TelegramChatRecord,
  WriteFeature,
} from "../../../src/api-contract.ts";
import type { AuditEntry } from "../../../src/audit-log.ts";
import {
  type BehaviourKey,
  type BehaviourOverrides,
  type BehaviourValues,
  LOCK_ROLLBACK_MIN,
  RSRP_THRESHOLD,
  SINR_THRESHOLD,
  SMS_SEND_LIMIT_MAX,
  SMS_TRASH_DAYS,
  WAN_RECONNECT_MIN,
} from "../../../src/behaviour-settings.ts";
import { TOKEN_LIFETIMES_DAYS, TOKEN_PERMISSIONS, type TokenPermission } from "../../../src/console-policy.ts";
import type { PublicTokenRecord } from "../../../src/console-settings.ts";
import { DEVICE_FEATURES } from "../../../src/device-profile.ts";
import { deviceIssueUrl } from "../../../src/feedback.ts";
import { FAMILY_AUTO, type RouterFamily, routerFamilyOf } from "../../../src/router-family.ts";
import type { ConnectionTestResult } from "../../../src/scheduler.ts";
import { agentStartBody, agentTestStatus, defaultAgentToken, reminderWaiting, smsOption, startTurnsOn } from "../core/agent-test-view.ts";
import { ApiError } from "../core/api.ts";
import {
  type NoticeTone,
  type TestedConnection,
  auditCaller,
  chatIdText,
  connectionNotice,
  daysLeft,
  needsLastAttempt,
  passwordProblem,
  telegramChatDetails,
  tokenFlowText,
  tokenState,
} from "../core/console-view.ts";
import { experimentalOffer, experimentalWrites, hasSwitch, readbackTone, reportVerified } from "../core/device-access-view.ts";
import {
  FEATURE_KEYS,
  READBACK_KEYS,
  READ_STATE_KEYS,
  SECTION_KEYS,
  STATE_KEYS,
  WRITE_STATE_KEYS,
  bandText,
  detectedText,
  endpointText,
  loginText,
  readText,
  reportFileName,
  reportIssueLink,
  reportJson,
  supportCells,
  supportDocsUrl,
  supportMarkText,
  supportNotes,
  switchScope,
  verificationNotice,
  writeResultDetail,
  writesText,
} from "../core/device-view.ts";
import { type RouterDraft, asksUsername, brandLabel, brandNote, brandOf, brandOptions, connectionBody, draftOf, showsStored, switchBrand, usualAddress } from "../core/router-brand.ts";
import { formatAgo } from "../core/format.ts";
import { type MessageParams, interpolate } from "../core/i18n.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../i18n/settings.ts";
import { copyText } from "./clipboard.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount, show } from "./dom.ts";

export type SettingsTab = "router" | "device" | "general" | "login" | "tokens" | "telegram" | "security" | "audit";

const TABS: ReadonlyArray<{ id: SettingsTab; key: SettingsTextKey; icon: string }> = [
  { id: "router", key: "tab_router", icon: "tower" },
  { id: "device", key: "tab_device", icon: "cpu" },
  { id: "general", key: "tab_general", icon: "sliders" },
  { id: "login", key: "tab_login", icon: "key" },
  { id: "tokens", key: "tab_tokens", icon: "bot" },
  { id: "telegram", key: "tab_telegram", icon: "send" },
  { id: "security", key: "tab_security", icon: "shield" },
  { id: "audit", key: "tab_audit", icon: "history" },
];
/** Every lifetime the daemon accepts, then "never expires". */
const LIFETIMES: ReadonlyArray<number | null> = [...TOKEN_LIFETIMES_DAYS, null];
/** A write its owner can turn on: a generic HiLink write, or one another brand's driver implements. */
const DEFAULT_LIFETIME_DAYS = 90;
/** A new token reads SMS too unless unticked (what a read-only token did before permissions). */
const DEFAULT_PERMISSIONS: ReadonlyArray<TokenPermission> = ["sms-read"];
const PERMISSION_TEXT: Readonly<Record<TokenPermission, { label: SettingsTextKey; badge: SettingsTextKey }>> = {
  "sms-read": { label: "perm_sms_read", badge: "badge_sms_read" },
  control: { label: "perm_control", badge: "badge_control" },
  access: { label: "perm_access", badge: "badge_access" },
  "sms-write": { label: "perm_sms_write", badge: "badge_sms_write" },
};
type NumberSetting = "lockRollbackAfterMin" | "wanReconnectAfterMin" | "alertRsrpThresholdDbm" | "alertSinrThresholdDb" | "agentSmsSendLimitPerHour" | "smsTrashDays";
/**
 * Tab labels follow the dialog's own width (a container query): the labelled row needs about 46rem
 * in English and 40rem in Chinese; below that the tabs show icons and the current tab's name.
 */
const TAB_LABEL_CLASS: Readonly<Record<"zh-CN" | "en", { label: string; heading: string }>> = {
  "zh-CN": { label: "hidden @[40rem]:inline", heading: "fs-label @[40rem]:hidden" },
  en: { label: "hidden @[46rem]:inline", heading: "fs-label @[46rem]:hidden" },
};
const AUDIT_LIMIT = 200;
const NOTICE_ICON: Readonly<Record<NoticeTone, readonly [string, string]>> = {
  info: ["info", "text-info"],
  pending: ["alert", "text-warning"],
  success: ["check", "text-success"],
  danger: ["alert", "text-error"],
};
const ENDPOINT_STATE_CLASS: Readonly<Record<EndpointState, string>> = {
  supported: "text-success",
  unsupported: "faint",
  restricted: "text-warning",
  unknown: "faint",
};
const OUTCOME: Readonly<Record<AuditEntry["outcome"], readonly [SettingsTextKey, string]>> = {
  applied: ["outcome_applied", "text-success"],
  refused: ["outcome_refused", "text-warning"],
  failed: ["outcome_failed", "text-error"],
};

/** A refused save carries the failed test in its envelope. */
function refusedTest(err: unknown): ConnectionTestResult | null {
  return err instanceof ApiError ? (err.envelope?.connectionTest ?? null) : null;
}

/**
 * Settings: the router connection (tested before it is saved), the identified device and its report,
 * the console password, tokens, Telegram linking, the security switches and the audit log.
 * `open("router", true)` is the guided first run: a fresh install fills in the router; an upgrade
 * tests what `.env` imported and asks for a confirmation.
 */
export function mountSettings(ctx: AppContext): { open(tab?: SettingsTab, guided?: boolean): void } {
  const dialog = byId<HTMLDialogElement>("settingsDialog");
  const t = (key: SettingsTextKey, params?: MessageParams): string => interpolate(SETTINGS_TEXT[ctx.tr.locale][key], params);
  let tab: SettingsTab = "router";
  let guided = false;
  let summary: ConsoleSettingsResponse | null = null;
  let draft: RouterDraft = draftOf(null);
  let lastResult: ConnectionTestResult | null = null;
  /** What the last test ran against, and whether FengSui told the brand itself (said with the result). */
  let lastTested: (TestedConnection & { detected: boolean }) | null = null;
  let testing = false;
  let pairingInFlight = false;
  let savingSwitches = false;
  let savingBehaviour = false;
  /** The new token's permissions, and the token whose permissions are being edited (with the edit so far). */
  let draftPermissions: TokenPermission[] = [...DEFAULT_PERMISSIONS];
  let editing: { id: string; permissions: TokenPermission[] } | null = null;
  let minted: string | null = null;
  let pairing: PairingCodeResponse | null = null;
  let tokens: PublicTokenRecord[] | null = null;
  /** The chats the bot reaches (read again each time the Telegram tab opens). */
  let chats: TelegramChatRecord[] | null = null;
  let audit: AuditEntry[] | null = null;
  let device: DeviceProfileResponse | null = null;
  let report: DeviceReport | null = null;
  /** The experimental writes and their recent results (read again each time the Device tab opens). */
  let experimental: ExperimentalWritesResponse | null = null;
  const switching = new Set<WriteFeature>();
  /**
   * The token chosen for the agent's test (`null`: the plan's suggestion; `""`: none), whether SMS stays
   * in it (the owner's last answer in this dialog; in by default), and a start or end on its way.
   */
  let agentToken: string | null = null;
  let agentSms = true;
  let agentBusy = false;
  /** Counts finished connection tests and saves: a profile read that one of them may have outdated is read again. */
  let deviceEpoch = 0;
  const loading = new Set<"tokens" | "audit" | "device" | "chats">();

  const fail = (err: unknown): void => {
    const code = err instanceof ApiError ? err.envelope?.errorCode : undefined;
    ctx.toast(code === "WRONG_PASSWORD" ? t("wrong_current") : ctx.describeError(err), "error");
  };
  const notice = (text: string, tone: NoticeTone = "info"): HTMLElement => {
    const [name, cls] = NOTICE_ICON[tone];
    return h(
      "div",
      { class: "fs-notice", data: { tone }, attrs: { role: tone === "danger" ? "alert" : "status" } },
      icon(name, `${cls} mt-0.5 shrink-0`),
      h("span", { class: "text-xs leading-relaxed" }, text)
    );
  };
  const input = (type: "text" | "password", value: string, autocomplete: string, placeholder = ""): HTMLInputElement => {
    const el = h("input", { class: "input input-sm rounded-lg w-full", attrs: { type, autocomplete, spellcheck: "false", ...(placeholder ? { placeholder } : {}) } });
    el.value = value;
    return el;
  };
  const field = (label: string, control: HTMLElement): HTMLElement => h("label", { class: "block space-y-1" }, h("span", { class: "fs-label" }, label), control);
  const button = (label: string, cls: string, onClick: () => void, iconName?: string): HTMLButtonElement =>
    h("button", { class: `btn btn-sm rounded-lg ${cls}`.trim(), attrs: { type: "button" }, on: { click: onClick } }, iconName ? icon(iconName) : null, label);
  const copyButton = (text: string): HTMLButtonElement =>
    button(t("copy"), "btn-ghost", () => void copyText(dialog, text).then((ok) => ctx.toast(ctx.t(ok ? "toast.copied" : "toast.copy_failed"), ok ? "success" : "warning")), "copy");
  const spinner = (): HTMLElement => h("span", { class: "loading loading-dots loading-sm text-base-content/50", attrs: { role: "status", "aria-label": t("loading") } });

  // ---------------------------------------------------------------- router
  const runTest = async (save: boolean): Promise<void> => {
    if (testing) return;
    const body = connectionBody(draft);
    const asked = draft.brand;
    const address = draft.url;
    /** The brand the test ran as: once FengSui has told it, the form shows it (and the next test skips the detection). */
    const tested = (family: RouterFamily | undefined): void => {
      lastTested = { family: family ?? (asked === FAMILY_AUTO ? "huawei" : asked), address, detected: asked === FAMILY_AUTO && family !== undefined };
      if (asked === FAMILY_AUTO && family !== undefined && draft.brand === FAMILY_AUTO) draft = switchBrand(draft, family);
    };
    testing = true;
    render();
    try {
      if (save) {
        const res = await ctx.api.saveConnection(body);
        lastResult = res.result;
        summary = res.settings;
        tested(routerFamilyOf(res.settings.cpe?.family));
        draft = draftOf(res.settings.cpe);
        guided = false;
        ctx.toast(t("saved"), "success");
        // The save cleared the breaker: drop its banner now rather than at the next status poll
        void ctx.api
          .sessionStatus()
          .then(({ status }) => ctx.store.update({ scheduler: status, avoidance: status.avoidance }, ["scheduler"]))
          .catch(() => undefined);
      } else {
        const res = await ctx.api.testConnection(body);
        lastResult = res.result;
        tested(res.family);
      }
    } catch (err) {
      lastResult = refusedTest(err);
      tested(undefined);
      if (!lastResult) fail(err);
    } finally {
      testing = false;
      draft.lastAttempt = false;
      // A test or save of the router in use identifies it again: the Device tab reads it afresh,
      // at once when it is the tab on screen
      deviceEpoch += 1;
      device = null;
      report = null;
      if (tab === "device") load("device");
      else render();
    }
  };

  const confirmReview = (): void => {
    void ctx.api
      .confirmReview()
      .then((next) => {
        summary = next;
        guided = false;
        ctx.toast(t("reviewed"), "success");
        // The password imported from .env comes next
        select(next.login.fromEnv ? "login" : tab);
      })
      .catch(fail);
  };

  const routerTab = (): HTMLElement => {
    const stored = summary?.cpe ?? null;
    const brand = h("select", { class: "select select-sm rounded-lg w-full", attrs: { "aria-label": t("brand") }, data: { field: "brand" } });
    for (const option of brandOptions(ctx.tr.locale, t("brand_auto"))) {
      const el = h("option", { attrs: { value: option.value } }, option.label);
      el.selected = option.value === draft.brand;
      brand.append(el);
    }
    brand.disabled = testing;
    // Another brand is another router: its usual address and user take the place of the old brand's, and the old result goes
    brand.addEventListener("change", () => {
      draft = switchBrand(draft, brandOf(brand.value));
      lastResult = null;
      lastTested = null;
      render();
    });
    const note = brandNote(draft.brand);
    const url = input("text", draft.url, "off", usualAddress(draft.brand));
    const user = input("text", draft.username, "username", draft.brand === FAMILY_AUTO ? t("username_default") : "");
    const pass = input("password", draft.password, "new-password", stored?.passwordSet ? t("password_keep") : "");
    const test = button(t("test"), "", () => void runTest(false));
    const save = button(t("save"), "btn-primary", () => void runTest(true));
    const review = button(t("confirm_review"), "btn-primary", confirmReview, "check");
    test.disabled = testing;
    save.disabled = testing;
    // Confirming keeps the imported connection: offered only while the form still shows it
    const sync = (): void => {
      // The stored password is used for the stored address only: another one needs it typed
      pass.placeholder = stored?.passwordSet && draft.url.trim() === stored.url ? t("password_keep") : "";
      const confirmable = summary?.reviewPending === true && lastResult?.ok === true && showsStored(draft, stored) && !testing;
      show(review, confirmable);
      show(save, !confirmable);
    };
    url.addEventListener("input", () => ((draft.url = url.value), sync()));
    user.addEventListener("input", () => ((draft.username = user.value), sync()));
    pass.addEventListener("input", () => ((draft.password = pass.value), sync()));
    sync();

    let status: HTMLElement | null = null;
    if (testing) status = notice(t("testing"));
    else if (lastResult) {
      const n = connectionNotice(lastResult, t, lastTested ?? undefined);
      // A brand FengSui told itself is named first: the owner did not choose it
      const told = lastTested?.detected ? `${t("brand_detected", { brand: brandLabel(lastTested.family, ctx.tr.locale) })} ` : "";
      status = notice(told + t(n.key, n.params), n.tone);
    }
    let lastAttempt: HTMLElement | null = null;
    if (!testing && needsLastAttempt(lastResult)) {
      const box = h("input", { class: "checkbox checkbox-sm checkbox-warning mt-0.5", attrs: { type: "checkbox" } });
      box.checked = draft.lastAttempt;
      box.addEventListener("change", () => (draft.lastAttempt = box.checked));
      lastAttempt = h("label", { class: "flex items-start gap-2 text-xs cursor-pointer" }, box, h("span", null, t("last_attempt")));
    }
    return h(
      "div",
      { class: "space-y-3" },
      field(t("brand"), brand),
      note ? h("p", { class: "text-xs faint leading-relaxed", data: { note: note.key } }, note.key === "brand_note" ? t("brand_note", { reads: t(note.reads) }) : t(note.key)) : null,
      field(t("url"), url),
      // A brand whose own page asks for a password only shows no user field
      asksUsername(draft.brand) ? h("div", { class: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, field(t("username"), user), field(t("password"), pass)) : field(t("password"), pass),
      status,
      lastAttempt,
      h("div", { class: "flex flex-wrap gap-2 justify-end" }, test, save, review)
    );
  };

  // ---------------------------------------------------------------- device
  const downloadText = (name: string, text: string): void => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = h("a", { class: "hidden", attrs: { href: url, download: name } });
    dialog.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const reportBlock = (): HTMLElement => {
    const create = button(
      t("report_create"),
      report ? "btn-ghost" : "btn-primary",
      () => {
        create.disabled = true;
        void ctx.api
          .deviceReport()
          .then((res) => {
            report = res.report;
            ctx.toast(t("report_created"), "success");
          })
          .catch(fail)
          .finally(render);
      },
      "shield"
    );
    let ready: HTMLElement | null = null;
    if (report) {
      const name = reportFileName(report);
      const json = reportJson(report);
      // A new issue with the title and the form only: the owner pastes or attaches the report there
      const issueUrl = reportIssueLink(report, ctx.demo);
      const fileIt = issueUrl
        ? h(
            "div",
            { class: "flex flex-wrap items-center gap-2 justify-end" },
            h("span", { class: "text-xs faint sm:flex-1" }, t("report_issue_hint")),
            h("a", { class: "btn btn-sm btn-primary rounded-lg gap-1.5", attrs: { href: issueUrl, target: "_blank", rel: "noopener noreferrer" } }, icon("github"), t("report_open_issue"))
          )
        : h("p", { class: "text-xs text-warning" }, t("report_demo_note"));
      ready = h(
        "div",
        { class: "space-y-2" },
        h("div", { class: "text-xs muted" }, t("report_preview")),
        // Text only, never markup (the report is the router's data)
        h("pre", { class: "font-mono text-[0.6875rem] leading-snug max-h-64 overflow-auto rounded-lg bg-base-200/70 p-2 whitespace-pre-wrap break-all" }, json),
        h(
          "div",
          { class: "flex flex-wrap items-center gap-2" },
          h("code", { class: "font-mono text-[0.6875rem] break-all w-full sm:w-auto sm:flex-1 rounded-lg bg-base-200/70 p-2" }, name),
          button(t("report_download"), "btn-ghost", () => downloadText(name, json), "arrow-down"),
          copyButton(json)
        ),
        fileIt
      );
    }
    return h(
      "div",
      { class: "space-y-2" },
      h("div", { class: "fs-label" }, t("report_title")),
      h("p", { class: "text-xs muted" }, t("report_intro")),
      h("p", { class: "text-xs muted" }, t("report_steps")),
      notice(t("report_notice")),
      ready,
      h("div", { class: "flex justify-end" }, create)
    );
  };

  /**
   * This router's row of the Supported devices table, as the daemon worked it out (the table itself stays
   * on the documentation site): a mark per console module, what the △ and — cells hang on, and a link to
   * the brand's section. A model the table lacks shows the brand's defaults and asks for a report.
   */
  const supportBlock = (): HTMLElement | null => {
    const row = device?.support ?? null;
    if (!row) return null;
    const locale = ctx.tr.locale;
    const cells = supportCells(row, locale).map(({ label, mark }) =>
      h(
        "li",
        { class: "flex items-center gap-1.5 rounded-lg bg-base-200/40 px-2 py-1 text-xs", data: { mark: mark || "none" }, attrs: { title: supportMarkText(mark, t) } },
        h("span", { class: "truncate" }, label),
        h("span", { class: "ml-auto font-semibold", attrs: { "aria-hidden": "true" } }, mark),
        h("span", { class: "sr-only" }, supportMarkText(mark, t))
      )
    );
    const notes = supportNotes(row, locale);
    const issueUrl = row.model === null && !ctx.demo ? deviceIssueUrl(device?.profile?.identity ?? null) : null;
    return h(
      "div",
      { class: "space-y-2", data: { support: row.section } },
      h("div", { class: "fs-label" }, t("support_title")),
      h("p", { class: "text-xs muted" }, row.model === null ? t("support_unlisted") : t("support_row", { model: row.model })),
      h("ul", { class: "grid grid-cols-2 sm:grid-cols-3 gap-1.5" }, ...cells),
      notes.length > 0 ? h("ul", { class: "list-disc pl-4 text-xs faint space-y-0.5" }, ...notes.map((note) => h("li", null, note))) : null,
      h("p", { class: "text-[0.6875rem] faint" }, t("support_legend")),
      h(
        "div",
        { class: "flex flex-wrap gap-2 justify-end" },
        issueUrl ? h("a", { class: "btn btn-sm btn-ghost rounded-lg gap-1.5", attrs: { href: issueUrl, target: "_blank", rel: "noopener noreferrer" } }, icon("github"), t("support_report")) : null,
        h("a", { class: "btn btn-sm btn-ghost rounded-lg gap-1.5", attrs: { href: supportDocsUrl(row, locale), target: "_blank", rel: "noopener noreferrer" } }, icon("info"), t("support_docs"))
      )
    );
  };

  const deviceTab = (): HTMLElement => {
    if (device === null) return loading.has("device") ? spinner() : h("div");
    const profile = device.profile;
    const verdict = verificationNotice(profile, device.verifiedFirmware);
    let details: HTMLElement | null = null;
    if (profile) {
      const id = profile.identity;
      const row = (label: string, value: string | null): HTMLElement =>
        h("div", { class: "flex flex-col sm:flex-row sm:items-baseline gap-x-3 py-1.5" }, h("dt", { class: "fs-label sm:w-28 shrink-0" }, label), h("dd", { class: "break-words" }, value ?? "—"));
      const features = DEVICE_FEATURES.map((feature) => {
        const capability = profile.capabilities.features[feature];
        const supported = capability.state === "supported";
        return h(
          "li",
          { class: "flex items-center gap-1.5 rounded-lg bg-base-200/40 px-2 py-1 text-xs" },
          icon(supported ? "check" : "info", supported ? "text-success" : "text-base-content/40"),
          h("span", { class: "truncate" }, t(FEATURE_KEYS[feature])),
          h("span", { class: "ml-auto faint" }, capability.source === "verified" ? t("source_verified") : t(STATE_KEYS[capability.state]))
        );
      });
      const endpoints = profile.capabilities.endpoints.map((endpoint) =>
        h(
          "li",
          { class: "flex flex-wrap items-baseline gap-x-2 py-1" },
          h("code", { class: "font-mono text-[0.6875rem] break-all flex-1" }, `GET ${endpoint.path}`),
          h("span", { class: `text-xs ${ENDPOINT_STATE_CLASS[endpoint.state]}` }, endpointText(endpoint, t))
        )
      );
      details = h(
        "div",
        { class: "space-y-4" },
        h(
          "dl",
          { class: "divide-y divide-base-content/[0.06]" },
          row(t("device_model"), id.marketingName ? `${id.model ?? "?"} · ${id.marketingName}` : id.model),
          row(t("device_firmware"), id.softwareVersion),
          row(t("device_webui"), id.webUiVersion),
          row(t("device_login"), loginText(id, t)),
          row(t("device_token_flow"), tokenFlowText(id.tokenFlow, t)),
          row(t("device_encryption"), t(id.ecc ? "ecc_on" : "ecc_off")),
          row(t("device_bands"), bandText(profile.capabilities.lteBands)),
          row(t("device_detected"), detectedText(profile, ctx.now(), ctx.tr.locale, t))
        ),
        // The verified model's tested features; another model shows what it answered instead (accessBlock)
        profile.verification === "verified" || profile.verification === "new-firmware"
          ? h("div", { class: "space-y-1.5" }, h("div", { class: "fs-label" }, t("features_title")), h("ul", { class: "grid grid-cols-2 sm:grid-cols-3 gap-1.5" }, ...features), h("p", { class: "text-xs faint" }, t("features_note")))
          : null,
        h("div", { class: "space-y-1" }, h("div", { class: "fs-label" }, t("endpoints_title")), h("ul", { class: "divide-y divide-base-content/[0.06]" }, ...endpoints), h("p", { class: "text-xs faint" }, t("endpoints_note")))
      );
    }
    return h("div", { class: "space-y-4" }, notice(t(verdict.key, verdict.params), verdict.tone), supportBlock(), accessBlock(), experimentalBlock(), agentBlock(), h("p", { class: "muted" }, t("device_intro")), details, reportBlock());
  };

  const loadExperimental = (): void => {
    void ctx.api
      .experimental()
      .then((res) => {
        experimental = res;
        if (tab === "device") render();
      })
      .catch(() => undefined);
  };

  /**
   * Turn one experimental write off, or back on (both at once: the writes FengSui implements for the
   * router are on by default). The daemon decides; its answer updates the gate's view everywhere in
   * the console.
   */
  const switchExperimental = async (feature: WriteFeature, input: HTMLInputElement): Promise<void> => {
    const on = input.checked;
    const label = t(FEATURE_KEYS[feature]);
    switching.add(feature);
    render();
    try {
      const res = await ctx.api.setExperimental({ feature, enabled: on });
      experimental = res;
      const scheduler = ctx.store.state.scheduler;
      if (scheduler) ctx.store.update({ scheduler: { ...scheduler, device: res.device } }, ["scheduler"]);
      ctx.toast(t(on ? "exp_on_done" : "exp_off_done", { feature: label }), "success");
    } catch (err) {
      fail(err);
    } finally {
      switching.delete(feature);
      render();
    }
  };

  /** A model nobody verified: each write with its state, a switch where FengSui implements it (on by default), and the recent results. */
  const experimentalBlock = (): HTMLElement | null => {
    const scheduler = ctx.store.state.scheduler;
    const offer = experimentalOffer(scheduler);
    if (offer.length === 0) return null;
    const model = scheduler?.device.model ?? "?";
    const rows = offer.map(({ feature, state }) => {
      const label = t(FEATURE_KEYS[feature]);
      let control: HTMLElement | null = null;
      let scope: string | null = null;
      if (hasSwitch(scheduler, feature)) {
        const input = h("input", { class: "toggle toggle-sm toggle-warning", attrs: { type: "checkbox", "aria-label": t("exp_switch", { feature: label }) } });
        input.checked = state !== "disabled";
        input.disabled = switching.has(feature);
        input.addEventListener("change", () => void switchExperimental(feature, input));
        control = input;
        scope = switchScope(feature, t);
      }
      return h(
        "li",
        { class: "flex items-center gap-3 py-1.5", data: { feature, state } },
        h(
          "span",
          { class: "flex-1 min-w-0 text-sm" },
          label,
          h("span", { class: `block text-[0.6875rem] ${state === "enabled" ? "text-warning" : "faint"}` }, t(WRITE_STATE_KEYS[state])),
          scope ? h("span", { class: "block text-[0.6875rem] faint" }, scope) : null
        ),
        control
      );
    });
    const results = [...(experimental?.writes ?? [])].reverse().slice(0, 10);
    const TONE: Readonly<Record<ReturnType<typeof readbackTone>, string>> = { success: "text-success", warning: "text-warning", error: "text-error", info: "faint" };
    const resultRows = results.map((result) =>
      h(
        "li",
        { class: "py-1.5 space-y-0.5" },
        h(
          "div",
          { class: "flex flex-wrap items-baseline gap-x-2" },
          h("span", { class: "text-sm" }, t(FEATURE_KEYS[result.feature])),
          h("code", { class: "font-mono text-[0.6875rem] faint" }, result.action),
          h("span", { class: `ml-auto text-xs ${TONE[readbackTone(result)]}` }, t(READBACK_KEYS[result.readback]))
        ),
        h("div", { class: "text-[0.6875rem] faint break-all" }, writeResultDetail(result, ctx.now(), ctx.tr.locale, t))
      )
    );
    return h(
      "div",
      { class: "space-y-2" },
      h("div", { class: "fs-label" }, t("exp_title")),
      reportVerified(scheduler) ? notice(t("exp_intro_verified", { model }), "success") : notice(t("exp_intro", { model }), "pending"),
      h("ul", { class: "divide-y divide-base-content/[0.06]" }, ...rows),
      h("div", { class: "fs-label pt-2" }, t("exp_results_title")),
      resultRows.length > 0 ? h("ul", { class: "divide-y divide-base-content/[0.06]" }, ...resultRows) : h("p", { class: "text-xs faint" }, t("exp_results_empty")),
      h("p", { class: "text-xs faint" }, t("exp_results_note"))
    );
  };

  /** The test's answer: the experimental writes, the gate's view everywhere in the console, and the settings it changed. */
  const applyAgentTest = (res: AgentTestResponse): void => {
    experimental = res;
    summary = res.settings;
    // A token's permissions may have changed: the Tokens tab reads them again
    tokens = null;
    const scheduler = ctx.store.state.scheduler;
    if (scheduler) ctx.store.update({ scheduler: { ...scheduler, device: res.device } }, ["scheduler"]);
  };

  /**
   * Copy the test prompt. When that sets something (an agent switch, what the agent's token needs),
   * one confirmation lists it all first, with SMS as an option kept by default; the confirming click
   * also copies, before the request.
   */
  const startAgentTest = async (prompt: string): Promise<void> => {
    const plan = experimental?.agentTest.plan;
    if (!plan || agentBusy) return;
    const tokenId = agentToken ?? defaultAgentToken(plan);
    let sms = agentSms && plan.sms.available;
    if (!startTurnsOn(plan, tokenId, sms)) {
      const ok = await copyText(dialog, prompt);
      ctx.toast(ctx.t(ok ? "toast.copied" : "toast.copy_failed"), ok ? "success" : "warning");
      return;
    }
    const model = ctx.store.state.scheduler?.device.model?.trim() || "?";
    const smsLabel = smsOption(plan, t);
    const yes = await ctx.confirm({
      title: t("agent_start_title", { model }),
      body: agentStartBody(plan, tokenId, t),
      confirmLabel: t("agent_start_confirm"),
      tone: "warning",
      ...(smsLabel ? { check: { label: smsLabel, checked: sms, onChange: (checked: boolean) => (sms = checked) } } : {}),
    });
    if (!yes) return;
    if (smsLabel) agentSms = sms;
    const copied = await copyText(dialog, prompt);
    agentBusy = true;
    render();
    try {
      applyAgentTest(await ctx.api.agentTest({ action: "start", model, tokenId: tokenId || null, sms }));
      agentToken = null;
      ctx.toast(t(copied ? "agent_started" : "agent_started_copy_failed"), "warning");
    } catch (err) {
      fail(err);
    } finally {
      agentBusy = false;
      render();
    }
  };

  /** End the test (put back what it turned on) or read its reminder. */
  const agentTestAction = (action: "end" | "ack"): void => {
    if (agentBusy) return;
    agentBusy = true;
    render();
    void ctx.api
      .agentTest({ action })
      .then((res) => {
        applyAgentTest(res);
        ctx.toast(t(action === "end" ? "agent_ended" : "agent_acked"), "success");
      })
      .catch(fail)
      .finally(() => {
        agentBusy = false;
        render();
      });
  };

  /**
   * Agents testing this router: on a model nobody verified, the prompt with the one-click start (what
   * it turns on, then the test in progress with its reminder and the way back); on every model the
   * switch that lets agents probe the router.
   */
  const agentBlock = (): HTMLElement => {
    const status = experimental?.agentTest ?? null;
    const plan = status?.plan ?? null;
    const current = status?.current ?? null;
    const model = ctx.store.state.scheduler?.device.model ?? "?";
    const identity = device?.profile?.identity ?? null;
    const prompt = t("agent_test_prompt", { model, issueUrl: deviceIssueUrl(identity ? { model: identity.model, softwareVersion: identity.softwareVersion } : { model, softwareVersion: null }) });
    let test: HTMLElement | null = null;
    if (plan?.available || current) {
      const tokenId = plan ? (agentToken ?? defaultAgentToken(plan)) : "";
      let picker: HTMLElement | null = null;
      if (plan?.available && plan.tokenNeeded) {
        const select = h(
          "select",
          { class: "select select-sm rounded-lg w-full sm:w-auto", attrs: { "aria-label": t("agent_token_label") }, data: { agentTest: "token" } },
          ...plan.tokens.map((token) =>
            h(
              "option",
              { attrs: { value: token.id } },
              token.agentUsedAtIso ? t("agent_token_used", { name: token.name, when: formatAgo(Date.parse(token.agentUsedAtIso), ctx.now(), ctx.tr.locale) }) : token.name
            )
          ),
          h("option", { attrs: { value: "" } }, t("agent_token_none"))
        );
        select.value = tokenId;
        select.disabled = agentBusy;
        select.addEventListener("change", () => {
          agentToken = select.value;
          render();
        });
        picker = settingBlock(t("agent_token_label"), select, h("p", { class: "text-xs muted" }, t("agent_token_note")));
      }
      const buttons: HTMLButtonElement[] = [];
      if (reminderWaiting(current)) buttons.push(button(t("agent_ack"), "btn-ghost", () => agentTestAction("ack"), "check"));
      if (current) buttons.push(button(t("agent_end"), "btn-ghost text-warning", () => agentTestAction("end"), "x"));
      if (plan?.available) {
        const turnsOn = startTurnsOn(plan, tokenId, agentSms);
        buttons.push(button(t(turnsOn ? "agent_start" : "agent_copy"), turnsOn ? "btn-primary" : "", () => void startAgentTest(prompt), "copy"));
      }
      for (const control of buttons) control.disabled = agentBusy;
      test = h(
        "div",
        { class: "space-y-2", data: { agentTest: "prompt" } },
        h("div", { class: "fs-label" }, t("agent_test_title")),
        h("p", { class: "text-xs muted" }, t("agent_test_note")),
        current ? h("div", { data: { agentTest: "status" } }, notice(agentTestStatus(current, ctx.now(), ctx.tr.locale, t).join(" "), current.passed ? "success" : "pending")) : null,
        picker,
        plan?.available ? h("pre", { class: "font-mono text-[0.6875rem] whitespace-pre-wrap break-words rounded-lg bg-base-200/70 p-2 max-h-48 overflow-y-auto" }, prompt) : null,
        h("div", { class: "flex flex-wrap gap-2 justify-end" }, ...buttons)
      );
    }
    return h("div", { class: "space-y-2", data: { agentTest: "section" } }, h("div", { class: "fs-label" }, t("agent_section")), test, choiceRow("agentExperimental", t("agent_exp"), t("agent_exp_note"), onOff()));
  };

  /** Whether FengSui writes to this router, and per read section what it answered (schedulerStatus.device). */
  const accessBlock = (): HTMLElement | null => {
    const access = ctx.store.state.scheduler?.device;
    if (!access || access.writes === "unknown") return null;
    const unverified = access.writes === "experimental";
    const open = experimentalWrites(ctx.store.state.scheduler);
    const reads = (Object.keys(SECTION_KEYS) as Array<keyof typeof SECTION_KEYS>).map((section) => {
      const read = access.reads[section];
      const good = read.state === "verified" || read.state === "available";
      return h(
        "li",
        { class: "flex items-center gap-1.5 rounded-lg bg-base-200/40 px-2 py-1 text-xs" },
        icon(good ? "check" : read.state === "unavailable" ? "x" : "info", good ? "text-success" : "text-base-content/40"),
        h("span", { class: "whitespace-nowrap" }, t(SECTION_KEYS[section])),
        h("span", { class: `ml-auto text-right ${read.state === "unavailable" ? "text-warning" : "faint"}`, title: t(READ_STATE_KEYS[read.state]) }, readText(read, t))
      );
    });
    return h(
      "div",
      { class: "space-y-1.5" },
      h("div", { class: "fs-label" }, t("access_title")),
      h(
        "div",
        { class: `flex items-center gap-1.5 text-sm ${unverified ? "text-warning" : ""}`, data: { role: "writes" } },
        icon(!unverified ? "unlock" : open.length > 0 ? "alert" : "lock"),
        writesText(access.writes, open.length, t, reportVerified(ctx.store.state.scheduler))
      ),
      h("ul", { class: "grid grid-cols-1 sm:grid-cols-2 gap-1.5" }, ...reads),
      unverified ? h("p", { class: "text-xs faint" }, t("access_note")) : null
    );
  };

  // ---------------------------------------------------------------- console password
  const loginTab = (): HTMLElement => {
    const current = input("password", "", "current-password");
    const next = input("password", "", "new-password");
    const repeat = input("password", "", "new-password");
    const submit = h("button", { class: "btn btn-sm btn-primary rounded-lg", attrs: { type: "submit" } }, t("change_password"));
    const changedAt = summary?.login.changedAtIso;
    const form = h(
      "form",
      { class: "space-y-3", attrs: { novalidate: "" } },
      summary?.login.fromEnv ? notice(t("guide_login_env"), "pending") : null,
      field(t("current_password"), current),
      field(t("new_password"), next),
      field(t("repeat_password"), repeat),
      h(
        "div",
        { class: "flex items-center justify-between gap-2" },
        h("span", { class: "text-xs faint" }, changedAt ? t("password_changed_at", { when: formatAgo(Date.parse(changedAt), ctx.now(), ctx.tr.locale) }) : ""),
        submit
      )
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const problem = passwordProblem(next.value, repeat.value);
      if (problem) {
        ctx.toast(t(problem === "short" ? "password_short" : "password_mismatch"), "warning");
        return;
      }
      submit.disabled = true;
      void ctx.api
        .changePassword(current.value, next.value)
        .then((updated) => {
          summary = updated;
          ctx.toast(t("password_changed"), "success");
          render();
        })
        .catch(fail)
        .finally(() => (submit.disabled = false));
    });
    return form;
  };

  // ---------------------------------------------------------------- tokens
  const tokenRow = (token: PublicTokenRecord, now: number): HTMLElement => {
    const expired = tokenState(token, now) === "expired";
    const days = daysLeft(token, now);
    const revoke = button(t("revoke"), "btn-ghost btn-xs text-error", () => {
      void ctx
        .confirm({ title: t("revoke_title", { name: token.name }), body: [t("revoke_body")], confirmLabel: t("revoke"), tone: "error" })
        .then(async (yes) => {
          if (!yes) return;
          await ctx.api.revokeToken(token.id);
          tokens = tokens?.filter((x) => x.id !== token.id) ?? null;
          ctx.toast(t("revoked"), "success");
          render();
        })
        .catch(fail);
    });
    const validity = expired ? t("expired") : days === null ? t("never_expires") : t("expires_in", { days });
    const used = token.lastUsedAtIso ? t("last_used", { when: formatAgo(Date.parse(token.lastUsedAtIso), now, ctx.tr.locale) }) : t("never_used");
    return h(
      "li",
      { class: `flex items-center gap-3 rounded-xl px-3 py-2 bg-base-200/40${expired ? " opacity-60" : ""}` },
      h(
        "div",
        { class: "min-w-0 flex-1 space-y-0.5" },
        h(
          "div",
          { class: "flex flex-wrap items-center gap-1.5" },
          h("span", { class: "font-semibold truncate" }, token.name),
          ...(token.permissions.length === 0
            ? [h("span", { class: "fs-badge" }, t("badge_data_only"))]
            : token.permissions.map((permission) => h("span", { class: "fs-badge", data: { permission } }, t(PERMISSION_TEXT[permission].badge)))),
          token.imported ? h("span", { class: "fs-badge" }, t("imported")) : null,
          token.telegramExposedAtIso ? h("span", { class: "fs-badge", data: { kind: "warn" } }, t("telegram_exposed")) : null
        ),
        h("div", { class: "text-[0.6875rem] faint num" }, `…${token.hint} · ${validity} · ${used}`),
        editing?.id === token.id ? permissionEditor(token) : null
      ),
      editing?.id === token.id
        ? null
        : button(t("edit_permissions"), "btn-ghost btn-xs", () => {
            editing = { id: token.id, permissions: [...token.permissions] };
            render();
          }),
      revoke
    );
  };

  /** Checkboxes for what a token may do besides reading; `current` reads the latest choice, `set` stores it. */
  const permissionChecks = (current: () => TokenPermission[], set: (next: TokenPermission[]) => void): HTMLElement =>
    h(
      "div",
      { class: "grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5" },
      ...TOKEN_PERMISSIONS.map((permission) => {
        const box = h("input", { class: "checkbox checkbox-xs checkbox-primary mt-0.5", attrs: { type: "checkbox" }, data: { permission } });
        box.checked = current().includes(permission);
        box.addEventListener("change", () => {
          const chosen = current();
          set(TOKEN_PERMISSIONS.filter((p) => (p === permission ? box.checked : chosen.includes(p))));
        });
        return h("label", { class: "flex items-start gap-2 cursor-pointer" }, box, h("span", { class: "text-xs" }, t(PERMISSION_TEXT[permission].label)));
      })
    );

  const permissionEditor = (token: PublicTokenRecord): HTMLElement => {
    const save = button(t("save_permissions"), "btn-primary btn-xs", () => {
      const next = editing?.permissions ?? token.permissions;
      save.disabled = true;
      void ctx.api
        .setTokenPermissions(token.id, next)
        .then((res) => {
          tokens = tokens?.map((x) => (x.id === token.id ? res.record : x)) ?? null;
          editing = null;
          ctx.toast(t("permissions_saved"), "success");
        })
        .catch(fail)
        .finally(() => render());
    });
    const cancel = button(t("cancel_edit"), "btn-ghost btn-xs", () => {
      editing = null;
      render();
    });
    return h(
      "div",
      { class: "pt-2 space-y-2", data: { editing: token.id } },
      permissionChecks(
        () => editing?.permissions ?? token.permissions,
        (next) => {
          if (editing) editing.permissions = next;
        }
      ),
      h("div", { class: "flex gap-2" }, save, cancel)
    );
  };

  const tokensTab = (): HTMLElement => {
    const name = input("text", "", "off", t("token_name"));
    name.maxLength = 64;
    name.setAttribute("aria-label", t("token_name"));
    const lifetime = h(
      "select",
      { class: "select select-sm rounded-lg", attrs: { "aria-label": t("lifetime") } },
      ...LIFETIMES.map((days) =>
        h("option", { attrs: { value: days === null ? "never" : String(days) } }, days === null ? t("lifetime_never") : days === 1 ? t("lifetime_one_day") : t("lifetime_days", { days }))
      )
    );
    lifetime.value = String(DEFAULT_LIFETIME_DAYS);
    const create = button(t("create_token"), "btn-primary", () => {
      if (!name.value.trim()) {
        ctx.toast(t("token_name_required"), "warning");
        name.focus();
        return;
      }
      create.disabled = true;
      void ctx.api
        .createToken({ name: name.value.trim(), permissions: [...draftPermissions], lifetimeDays: lifetime.value === "never" ? null : Number(lifetime.value) })
        .then((res) => {
          minted = res.token;
          tokens = [...(tokens ?? []), res.record];
          draftPermissions = [...DEFAULT_PERMISSIONS];
          ctx.toast(t("token_created"), "success");
          // Closed meanwhile: shown at the next open, never written into the hidden dialog
          if (dialog.open) render();
        })
        .catch(fail)
        .finally(() => (create.disabled = false));
    });
    const now = ctx.now();
    const shown = minted;
    let list: HTMLElement | null = null;
    if (tokens === null) list = loading.has("tokens") ? spinner() : null;
    else if (tokens.length === 0) list = h("p", { class: "faint" }, t("no_tokens"));
    else list = h("ul", { class: "space-y-1.5" }, ...tokens.map((token) => tokenRow(token, now)));
    return h(
      "div",
      { class: "space-y-3" },
      agentSection(),
      h("p", { class: "muted" }, t("tokens_intro")),
      shown
        ? h(
            "div",
            { class: "space-y-2" },
            notice(t("token_once"), "pending"),
            h("div", { class: "flex items-center gap-2" }, h("code", { class: "font-mono text-xs break-all flex-1 rounded-lg bg-base-200/70 p-2" }, shown), copyButton(shown))
          )
        : null,
      h("div", { class: "grid grid-cols-1 sm:grid-cols-[1fr_auto_auto] gap-2" }, name, lifetime, create),
      h(
        "div",
        { class: "space-y-1.5", data: { newToken: "permissions" } },
        h("div", { class: "text-xs muted" }, t("perm_title")),
        permissionChecks(
          () => draftPermissions,
          (next) => {
            draftPermissions = next;
          }
        )
      ),
      list
    );
  };

  // ---------------------------------------------------------------- telegram
  const chatRow = (chat: TelegramChatRecord, now: number, masked: boolean): HTMLElement => {
    const kind = t(chat.kind === "group" ? "chat_group" : "chat_private");
    const id = chatIdText(chat.chatId, masked);
    // A chat only .env authorizes is removed there, not here
    const unlink =
      chat.linkedWith === null
        ? null
        : button(t("unlink_one"), "btn-ghost btn-xs text-error", () => {
            void ctx
              .confirm({ title: t("unlink_one_title"), body: [`${kind} ${id}`, t("unlink_one_body")], confirmLabel: t("unlink_one"), tone: "error" })
              .then(async (yes) => {
                if (!yes) return;
                chats = (await ctx.api.unlinkTelegramChat(chat.chatId)).chats;
                ctx.toast(t(chat.fromEnv ? "unlinked_one_env" : "unlinked_one"), "success");
                render();
              })
              .catch(fail);
          });
    unlink?.setAttribute("aria-label", `${t("unlink_one")} ${kind} ${id}`);
    const linkedAt = chat.linkedAtIso ? [t("chat_linked_at", { when: formatAgo(Date.parse(chat.linkedAtIso), now, ctx.tr.locale) })] : [];
    return h(
      "li",
      { class: "flex items-center gap-3 rounded-xl px-3 py-2 bg-base-200/40" },
      icon(chat.kind === "group" ? "contacts" : "user", "text-base-content/50 shrink-0"),
      h(
        "div",
        { class: "min-w-0 flex-1 space-y-0.5" },
        h(
          "div",
          { class: "flex flex-wrap items-center gap-1.5" },
          h("span", { class: "font-semibold" }, kind),
          h("span", { class: "font-mono text-xs num" }, id),
          chat.fromEnv ? h("span", { class: "fs-badge" }, ".env") : null
        ),
        h("div", { class: "text-[0.6875rem] faint break-words" }, [...telegramChatDetails(chat, masked, t), ...linkedAt].join(" · "))
      ),
      unlink
    );
  };

  const telegramTab = (): HTMLElement => {
    if (!summary?.telegram.configured) return notice(t("telegram_off"));
    const issue = async (group: boolean): Promise<void> => {
      if (pairingInFlight) return;
      pairingInFlight = true;
      create.disabled = true;
      createGroup.disabled = true;
      try {
        pairing = await ctx.api.pairingCode(group);
      } catch (err) {
        fail(err);
      } finally {
        pairingInFlight = false;
        create.disabled = false;
        createGroup.disabled = false;
        if (dialog.open) render();
      }
    };
    const create = button(t("pairing_create"), "btn-primary", () => void issue(false), "key");
    // Everyone in the group reads what the bot posts there, so a group code is asked for on purpose
    const createGroup = button(t("pairing_group_create"), "btn-ghost", () => {
      if (pairingInFlight) return;
      void ctx
        .confirm({ title: t("pairing_group_title"), body: [t("pairing_group_body"), t("pairing_group_owner"), t("pairing_group_admin")], confirmLabel: t("pairing_group_create"), tone: "warning" })
        .then((yes) => (yes ? issue(true) : undefined))
        .catch(fail);
    }, "contacts");
    create.disabled = pairingInFlight;
    createGroup.disabled = pairingInFlight;
    const unlink = button(t("unlink_all"), "btn-ghost btn-sm text-error", () => {
      void ctx
        .confirm({ title: t("unlink_title"), body: [t("unlink_body")], confirmLabel: t("unlink_all"), tone: "error" })
        .then(async (yes) => {
          if (!yes) return;
          const res = await ctx.api.unlinkTelegram();
          ctx.toast(t("unlinked", { count: res.unlinked }), "success");
          load("chats");
        })
        .catch(fail);
    });
    const refresh = button(t("chats_refresh"), "btn-ghost btn-xs", () => load("chats"), "refresh");
    const now = ctx.now();
    const masked = ctx.privacy.isMasked("telegram");
    let list: HTMLElement | null = null;
    if (chats === null) list = loading.has("chats") ? spinner() : null;
    else if (chats.length === 0) list = h("p", { class: "text-xs faint" }, t("chats_empty"));
    else list = h("ul", { class: "space-y-1.5" }, ...chats.map((chat) => chatRow(chat, now, masked)));
    return h(
      "div",
      { class: "space-y-3" },
      h("p", { class: "muted" }, t("telegram_intro")),
      pairing
        ? h(
            "div",
            { class: "rounded-xl bg-base-200/60 p-3 space-y-1" },
            h("div", { class: "text-xs muted" }, t(pairing.group ? "pairing_group_send" : "pairing_send")),
            h("div", { class: "flex items-center gap-2" }, h("code", { class: "font-mono text-lg tracking-wider flex-1 break-all" }, pairing.command), copyButton(pairing.command))
          )
        : null,
      h("div", { class: "flex flex-wrap gap-2" }, create, createGroup),
      h(
        "section",
        { class: "space-y-2 pt-2", attrs: { "aria-label": t("chats_title") } },
        h("div", { class: "flex items-center justify-between gap-2" }, h("div", { class: "fs-label" }, t("chats_title")), refresh),
        list,
        // Nothing to unlink: no "unlink all" either
        chats?.some((chat) => chat.linkedWith !== null) ? h("div", { class: "flex justify-end" }, unlink) : null
      )
    );
  };

  // ---------------------------------------------------------------- behaviour (general, AI agents)
  const saveBehaviour = (body: BehaviourOverrides): void => {
    if (savingBehaviour) return;
    savingBehaviour = true;
    void ctx.api
      .consoleBehaviour(body)
      .then((next) => {
        summary = next;
        ctx.toast(t("switch_saved"), "success");
      })
      // A refused change puts the control back to the stored value
      .catch(fail)
      .finally(() => {
        savingBehaviour = false;
        render();
      });
  };

  const settingBlock = (label: string, control: HTMLElement, ...notes: Array<HTMLElement | null>): HTMLElement =>
    h("div", { class: "space-y-1.5" }, h("div", { class: "fs-label" }, label), control, ...notes);

  /** A setting picked from a list, the first entry following `.env` (as the metrics switch does). */
  const choiceRow = <K extends BehaviourKey>(key: K, label: string, note: string | null, options: ReadonlyArray<readonly [BehaviourValues[K], string]>): HTMLElement | null => {
    const entry = summary?.behaviour[key];
    if (!entry) return null;
    const nameOf = (value: unknown): string => options.find(([option]) => option === value)?.[1] ?? String(value);
    const select = h(
      "select",
      { class: "select select-sm rounded-lg w-full sm:w-auto", attrs: { "aria-label": label }, data: { setting: key } },
      h("option", { attrs: { value: "env" } }, t("follow_env", { value: nameOf(entry.envValue) })),
      ...options.map(([, text], index) => h("option", { attrs: { value: String(index) } }, text))
    );
    select.value = entry.source === "env" ? "env" : String(options.findIndex(([option]) => option === entry.value));
    select.disabled = savingBehaviour;
    select.addEventListener("change", () => {
      select.disabled = true;
      const picked = select.value === "env" ? null : (options[Number(select.value)]?.[0] ?? null);
      saveBehaviour({ [key]: picked } as BehaviourOverrides);
    });
    return settingBlock(label, select, note ? h("p", { class: "text-xs muted" }, note) : null);
  };

  /** Where a typed value comes from, with the way back to `.env`. */
  const sourceLine = (key: BehaviourKey, shown: string): HTMLElement => {
    const entry = summary?.behaviour[key];
    return entry?.source === "console"
      ? h("p", { class: "text-xs faint" }, t("set_here"), " · ", button(t("back_to_env"), "btn-link btn-xs px-0 h-auto min-h-0", () => saveBehaviour({ [key]: null } as BehaviourOverrides)))
      : h("p", { class: "text-xs faint" }, t("from_env", { value: shown }));
  };

  /** A whole number (minutes, a threshold, a limit), saved when it changes; `off` accepts 0 for off. */
  const numberRow = (key: NumberSetting, label: string, note: string, range: { min: number; max: number }, unit: string, off = false): HTMLElement | null => {
    const entry = summary?.behaviour[key];
    if (!entry) return null;
    const box = h("input", { class: "input input-sm rounded-lg w-28 num", attrs: { type: "number", step: "1", min: String(off ? 0 : range.min), max: String(range.max), "aria-label": label }, data: { setting: key } });
    box.value = String(entry.value);
    box.disabled = savingBehaviour;
    box.addEventListener("change", () => {
      const value = Number(box.value);
      if (box.value.trim() === "" || value === entry.value) {
        box.value = String(entry.value);
        return;
      }
      if (!Number.isInteger(value) || !((off && value === 0) || (value >= range.min && value <= range.max))) {
        ctx.toast(t(off ? "number_range_off" : "number_range", { min: range.min, max: range.max }), "warning");
        box.value = String(entry.value);
        return;
      }
      box.disabled = true;
      saveBehaviour({ [key]: value } as BehaviourOverrides);
    });
    const envShown = off && entry.envValue === 0 ? t("off") : `${entry.envValue} ${unit}`;
    return settingBlock(label, h("div", { class: "flex items-center gap-2" }, box, h("span", { class: "text-xs muted" }, unit)), h("p", { class: "text-xs muted" }, note), sourceLine(key, envShown));
  };

  const countryRow = (): HTMLElement | null => {
    const entry = summary?.behaviour.defaultCountryCode;
    if (!entry) return null;
    const box = input("text", entry.value, "off", t("country_placeholder"));
    box.classList.replace("w-full", "w-28");
    box.setAttribute("aria-label", t("country_code"));
    box.dataset["setting"] = "defaultCountryCode";
    box.disabled = savingBehaviour;
    box.addEventListener("change", () => {
      const raw = box.value.trim();
      if (raw === entry.value) return;
      if (raw !== "" && !/^\+?\d{1,4}$/.test(raw)) {
        ctx.toast(t("country_invalid"), "warning");
        box.value = entry.value;
        return;
      }
      box.disabled = true;
      saveBehaviour({ defaultCountryCode: raw });
    });
    return settingBlock(t("country_code"), box, h("p", { class: "text-xs muted" }, t("country_code_note")), sourceLine("defaultCountryCode", entry.envValue || t("country_placeholder")));
  };

  const group = (title: string, ...rows: Array<HTMLElement | null>): HTMLElement =>
    h("section", { class: "space-y-3 rounded-xl bg-base-200/40 p-3" }, h("h5", { class: "font-semibold" }, title), ...rows);

  const onOff = (): ReadonlyArray<readonly [boolean, string]> => [
    [true, t("on")],
    [false, t("off")],
  ];

  const generalTab = (): HTMLElement => {
    if (!summary) return spinner();
    return h(
      "div",
      { class: "space-y-4" },
      h("p", { class: "muted" }, t("general_intro")),
      group(
        t("sec_self_heal"),
        numberRow("lockRollbackAfterMin", t("lock_rollback"), t("lock_rollback_note"), LOCK_ROLLBACK_MIN, t("unit_min"), true),
        numberRow("wanReconnectAfterMin", t("wan_redial"), t("wan_redial_note"), WAN_RECONNECT_MIN, t("unit_min"), true)
      ),
      group(
        t("sec_alerts"),
        choiceRow("alertsEnabled", t("alerts_enabled"), t("alerts_enabled_note"), onOff()),
        choiceRow("alertNotifyMinSeverity", t("alert_floor"), t("alert_floor_note"), [
          ["info", t("sev_info")],
          ["warning", t("sev_warning")],
          ["critical", t("sev_critical")],
        ]),
        numberRow("alertRsrpThresholdDbm", t("rsrp_threshold"), t("rsrp_threshold_note"), RSRP_THRESHOLD, "dBm"),
        numberRow("alertSinrThresholdDb", t("sinr_threshold"), t("sinr_threshold_note"), SINR_THRESHOLD, "dB")
      ),
      group(
        t("sec_sms"),
        choiceRow("smsAutoMarkRead", t("sms_auto_read"), t("sms_auto_read_note"), onOff()),
        numberRow("smsTrashDays", t("sms_trash_days"), t("sms_trash_days_note"), { min: 1, max: SMS_TRASH_DAYS.max }, t("unit_days"), true),
        countryRow()
      )
    );
  };

  /** The AI agents' master switches, above the tokens they use. */
  const agentSection = (): HTMLElement | null => {
    if (!summary) return null;
    return group(
      t("sec_agents"),
      h("p", { class: "text-xs muted" }, t("agents_intro")),
      choiceRow("agentWrites", t("agent_writes"), t("agent_writes_note"), onOff()),
      choiceRow("agentAccessControl", t("agent_access"), t("agent_access_note"), onOff()),
      choiceRow("agentSms", t("agent_sms"), t("agent_sms_note"), [
        ["none", t("agent_sms_none")],
        ["read", t("agent_sms_read")],
        ["full", t("agent_sms_full")],
      ]),
      choiceRow("agentSmsSendPolicy", t("agent_send_policy"), t("agent_send_policy_note"), [
        ["known", t("policy_known")],
        ["any", t("policy_any")],
      ]),
      numberRow("agentSmsSendLimitPerHour", t("agent_send_limit"), t("agent_send_limit_note"), { min: 0, max: SMS_SEND_LIMIT_MAX }, t("unit_per_hour")),
      choiceRow("redactApi", t("redact_api"), t("redact_api_note"), onOff())
    );
  };

  // ---------------------------------------------------------------- security
  const saveSwitches = (body: { telegramReset?: boolean; metricsEnabled?: boolean | null }): void => {
    if (savingSwitches) return;
    savingSwitches = true;
    void ctx.api
      .consoleSwitches(body)
      .then((next) => {
        summary = next;
        ctx.toast(t("switch_saved"), "success");
      })
      .catch(fail)
      // A refused change puts the control back to the stored value
      .finally(() => {
        savingSwitches = false;
        render();
      });
  };

  const securityTab = (): HTMLElement => {
    const s = summary;
    if (!s) return h("div");
    let reset: HTMLElement | null = null;
    let toggle: HTMLInputElement | null = null;
    if (s.telegram.configured) {
      toggle = h("input", { class: "toggle toggle-sm toggle-primary mt-0.5", attrs: { type: "checkbox" } });
      toggle.checked = s.telegram.resetEnabled;
      toggle.disabled = savingSwitches;
      reset = h(
        "label",
        { class: "flex items-start gap-3 cursor-pointer" },
        toggle,
        h("span", { class: "space-y-1" }, h("span", { class: "block" }, t("telegram_reset")), h("span", { class: "block text-xs muted" }, t("telegram_reset_note")))
      );
    }
    const metrics = h(
      "select",
      { class: "select select-sm rounded-lg w-full sm:w-auto", attrs: { "aria-label": t("metrics") } },
      h("option", { attrs: { value: "env" } }, t("metrics_env", { state: t(s.metrics.envEnabled ? "metrics_on" : "metrics_off") })),
      h("option", { attrs: { value: "on" } }, t("metrics_on")),
      h("option", { attrs: { value: "off" } }, t("metrics_off"))
    );
    metrics.value = s.metrics.source === "env" ? "env" : s.metrics.enabled ? "on" : "off";
    metrics.disabled = savingSwitches;
    const disableControls = (): void => {
      if (toggle) toggle.disabled = true;
      metrics.disabled = true;
    };
    if (toggle) {
      toggle.addEventListener("change", () => {
        disableControls();
        saveSwitches({ telegramReset: toggle.checked });
      });
    }
    metrics.addEventListener("change", () => {
      disableControls();
      saveSwitches({ metricsEnabled: metrics.value === "env" ? null : metrics.value === "on" });
    });
    return h(
      "div",
      { class: "space-y-5" },
      reset,
      h(
        "div",
        { class: "space-y-1.5" },
        h("div", { class: "fs-label" }, t("metrics")),
        metrics,
        h("p", { class: "text-xs muted" }, t("metrics_note", { url: `${window.location.origin}/metrics` }))
      )
    );
  };

  // ---------------------------------------------------------------- audit
  const auditTab = (): HTMLElement => {
    const names = { web: t("ch_web"), token: t("ch_token"), mcp: t("ch_mcp"), telegram: t("ch_telegram"), "self-heal": t("ch_self_heal"), system: t("ch_system") } as const;
    const refresh = button(
      t("audit_refresh"),
      "btn-ghost btn-xs",
      () => {
        audit = null;
        load("audit");
      },
      "refresh"
    );
    const now = ctx.now();
    let list: HTMLElement | null = null;
    if (audit === null) list = loading.has("audit") ? spinner() : null;
    else if (audit.length === 0) list = h("p", { class: "faint" }, t("audit_empty"));
    else {
      list = h(
        "ul",
        { class: "divide-y divide-base-content/[0.06]" },
        ...audit.map((entry) => {
          const [key, cls] = OUTCOME[entry.outcome];
          return h(
            "li",
            { class: "py-2 space-y-0.5" },
            h(
              "div",
              { class: "flex flex-wrap items-baseline gap-x-2" },
              h("span", { class: `text-xs font-semibold ${cls}` }, t(key)),
              h("span", { class: "font-mono text-xs" }, entry.action),
              h("span", { class: "text-xs muted" }, auditCaller(entry, names)),
              h("span", { class: "ml-auto text-[0.6875rem] faint num", title: entry.tsIso }, formatAgo(Date.parse(entry.tsIso), now, ctx.tr.locale))
            ),
            entry.detail ? h("div", { class: "text-[0.6875rem] faint break-words" }, entry.detail) : null
          );
        })
      );
    }
    return h("div", { class: "space-y-3" }, h("div", { class: "flex items-start justify-between gap-3" }, h("p", { class: "muted" }, t("audit_intro")), refresh), list);
  };

  // ---------------------------------------------------------------- frame
  const load = (what: "tokens" | "audit" | "device" | "chats"): void => {
    if (loading.has(what)) return;
    loading.add(what);
    const epoch = deviceEpoch;
    const request =
      what === "tokens"
        ? ctx.api.tokens().then((res) => void (tokens = res.tokens))
        : what === "audit"
          ? ctx.api.audit(AUDIT_LIMIT).then((res) => void (audit = res.entries))
          : what === "chats"
            ? ctx.api.telegramChats().then((res) => void (chats = res.chats))
            : ctx.api.deviceProfile().then((res) => void (device = res));
    void request.catch(fail).finally(() => {
      loading.delete(what);
      // A test or save ended while the profile was on its way: what came back may predate it
      if (what === "device" && epoch !== deviceEpoch) {
        device = null;
        if (tab === "device") return load("device");
      }
      render();
    });
    render();
  };

  const select = (next: SettingsTab): void => {
    tab = next;
    if (next === "tokens" && tokens === null) load("tokens");
    else if (next === "audit" && audit === null) load("audit");
    else if (next === "device" && device === null) load("device");
    // A chat may have sent /auth since the tab was last open: read the list each time
    else if (next === "telegram" && summary?.telegram.configured === true) load("chats");
    else render();
    // The experimental writes and their results change with every write: read them each time
    if (next === "device") loadExperimental();
  };

  const VIEWS: Readonly<Record<SettingsTab, () => HTMLElement>> = {
    router: routerTab,
    device: deviceTab,
    general: generalTab,
    login: loginTab,
    tokens: tokensTab,
    telegram: telegramTab,
    security: securityTab,
    audit: auditTab,
  };

  const render = (): void => {
    const labels = TAB_LABEL_CLASS[ctx.tr.locale];
    const nav = h(
      "nav",
      { class: "fs-seg fs-settings-nav w-full sm:w-auto justify-between", attrs: { "aria-label": t("title") } },
      ...TABS.map((entry) =>
        h(
          "button",
          { class: entry.id === tab ? "is-active" : "", title: t(entry.key), attrs: { type: "button", "aria-label": t(entry.key) }, on: { click: () => select(entry.id) } },
          icon(entry.icon),
          h("span", { class: labels.label }, t(entry.key))
        )
      )
    );
    const current = TABS.find((entry) => entry.id === tab);
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box sm:max-w-3xl p-0 flex flex-col max-h-[90vh]" },
        h(
          "div",
          { class: "flex items-center gap-2 px-5 pt-5 pb-3" },
          icon("settings", "text-primary text-lg"),
          h("h3", { class: "text-lg font-bold serif" }, t("title")),
          h("form", { class: "ml-auto", attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "div",
          { class: "@container flex-1 overflow-y-auto px-5 pb-5 space-y-4 text-sm" },
          guided ? notice(summary?.cpe ? t("guide_review") : t("guide_fresh")) : null,
          nav,
          current ? h("h4", { class: labels.heading }, t(current.key)) : null,
          VIEWS[tab]()
        )
      ),
      modalBackdrop(ctx.t("common.close"))
    );
  };

  dialog.addEventListener("close", () => {
    // A minted token, a pairing code and a typed router password live only while the dialog is open
    minted = null;
    pairing = null;
    pairingInFlight = false;
    savingSwitches = false;
    savingBehaviour = false;
    agentToken = null;
    agentSms = true;
    agentBusy = false;
    editing = null;
    draftPermissions = [...DEFAULT_PERMISSIONS];
    draft.password = "";
    // Off the page too, not only off the screen: the closed dialog keeps its last content otherwise
    render();
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });

  return {
    open: (nextTab = "router", isGuided = false) => {
      void ctx.api
        .consoleSettings()
        .then((s) => {
          summary = s;
          guided = isGuided;
          draft = draftOf(s.cpe);
          lastResult = null;
          lastTested = null;
          tokens = null;
          chats = null;
          audit = null;
          device = null;
          report = null;
          experimental = null;
          select(nextTab);
          if (!dialog.open) dialog.showModal();
          // An imported connection is tested at once; the user only has to confirm it
          if (isGuided && s.cpe) void runTest(false);
        })
        .catch(fail);
    },
  };
}
