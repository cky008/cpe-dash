import type { ConsoleSettingsResponse, DeviceProfileResponse, DeviceReport, EndpointState } from "../../../src/api-contract.ts";
import type { AuditEntry } from "../../../src/audit-log.ts";
import { TOKEN_LIFETIMES_DAYS } from "../../../src/console-policy.ts";
import type { PublicTokenRecord } from "../../../src/console-settings.ts";
import { DEVICE_FEATURES } from "../../../src/device-profile.ts";
import type { ConnectionTestResult } from "../../../src/scheduler.ts";
import { ApiError } from "../core/api.ts";
import { type NoticeTone, auditCaller, connectionNotice, daysLeft, needsLastAttempt, passwordProblem, tokenFlowText, tokenState } from "../core/console-view.ts";
import { FEATURE_KEYS, READ_STATE_KEYS, SECTION_KEYS, STATE_KEYS, WRITES_KEYS, bandText, detectedText, endpointText, loginText, readText, reportFileName, reportIssueLink, reportJson, verificationNotice } from "../core/device-view.ts";
import type { ConnectionInput } from "../core/endpoints.ts";
import { formatAgo } from "../core/format.ts";
import { type MessageParams, interpolate } from "../core/i18n.ts";
import { SETTINGS_TEXT, type SettingsTextKey } from "../i18n/settings.ts";
import { copyText } from "./clipboard.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount, show } from "./dom.ts";

export type SettingsTab = "router" | "device" | "login" | "tokens" | "telegram" | "security" | "audit";

const TABS: ReadonlyArray<{ id: SettingsTab; key: SettingsTextKey; icon: string }> = [
  { id: "router", key: "tab_router", icon: "tower" },
  { id: "device", key: "tab_device", icon: "cpu" },
  { id: "login", key: "tab_login", icon: "key" },
  { id: "tokens", key: "tab_tokens", icon: "bot" },
  { id: "telegram", key: "tab_telegram", icon: "send" },
  { id: "security", key: "tab_security", icon: "shield" },
  { id: "audit", key: "tab_audit", icon: "history" },
];
/** Every lifetime the daemon accepts, then "never expires". */
const LIFETIMES: ReadonlyArray<number | null> = [...TOKEN_LIFETIMES_DAYS, null];
const DEFAULT_LIFETIME_DAYS = 90;
/**
 * Tab labels follow the dialog's own width (a container query): the labelled row needs about 37rem
 * in English and 32rem in Chinese; below that the tabs show icons and the current tab's name.
 */
const TAB_LABEL_CLASS: Readonly<Record<"zh-CN" | "en", { label: string; heading: string }>> = {
  "zh-CN": { label: "hidden @[32rem]:inline", heading: "fs-label @[32rem]:hidden" },
  en: { label: "hidden @[37rem]:inline", heading: "fs-label @[37rem]:hidden" },
};
const DEFAULT_CPE_URL = "http://192.168.8.1";
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

/** The router form as typed: it survives re-renders, tab switches and failed tests. */
interface RouterDraft {
  url: string;
  username: string;
  password: string;
  lastAttempt: boolean;
}

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
  let draft: RouterDraft = { url: DEFAULT_CPE_URL, username: "admin", password: "", lastAttempt: false };
  let lastResult: ConnectionTestResult | null = null;
  let testing = false;
  let minted: string | null = null;
  let pairing: string | null = null;
  let tokens: PublicTokenRecord[] | null = null;
  let audit: AuditEntry[] | null = null;
  let device: DeviceProfileResponse | null = null;
  let report: DeviceReport | null = null;
  /** Counts finished connection tests and saves: a profile read that one of them may have outdated is read again. */
  let deviceEpoch = 0;
  const loading = new Set<"tokens" | "audit" | "device">();

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
    const body: ConnectionInput = {
      url: draft.url.trim(),
      username: draft.username.trim() || "admin",
      ...(draft.password ? { password: draft.password } : {}),
      ...(draft.lastAttempt ? { lastAttempt: true } : {}),
    };
    testing = true;
    render();
    try {
      if (save) {
        const res = await ctx.api.saveConnection(body);
        lastResult = res.result;
        summary = res.settings;
        draft = { url: res.settings.cpe?.url ?? draft.url, username: res.settings.cpe?.username ?? draft.username, password: "", lastAttempt: false };
        guided = false;
        ctx.toast(t("saved"), "success");
        // The save cleared the breaker: drop its banner now rather than at the next status poll
        void ctx.api
          .sessionStatus()
          .then(({ status }) => ctx.store.update({ scheduler: status, avoidance: status.avoidance }, ["scheduler"]))
          .catch(() => undefined);
      } else {
        lastResult = (await ctx.api.testConnection(body)).result;
      }
    } catch (err) {
      lastResult = refusedTest(err);
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
    const url = input("text", draft.url, "off", DEFAULT_CPE_URL);
    const user = input("text", draft.username, "username");
    const pass = input("password", draft.password, "new-password", stored?.passwordSet ? t("password_keep") : "");
    const test = button(t("test"), "", () => void runTest(false));
    const save = button(t("save"), "btn-primary", () => void runTest(true));
    const review = button(t("confirm_review"), "btn-primary", confirmReview, "check");
    test.disabled = testing;
    save.disabled = testing;
    // Confirming keeps the imported connection: offered only while the form still shows it
    const sync = (): void => {
      const untouched = stored !== null && draft.url.trim() === stored.url && draft.username.trim() === stored.username && draft.password === "";
      const confirmable = summary?.reviewPending === true && lastResult?.ok === true && untouched && !testing;
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
      const n = connectionNotice(lastResult, t);
      status = notice(t(n.key, n.params), n.tone);
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
      field(t("url"), url),
      h("div", { class: "grid grid-cols-1 sm:grid-cols-2 gap-3" }, field(t("username"), user), field(t("password"), pass)),
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
    return h("div", { class: "space-y-4" }, notice(t(verdict.key, verdict.params), verdict.tone), accessBlock(), h("p", { class: "muted" }, t("device_intro")), details, reportBlock());
  };

  /** Whether FengSui writes to this router, and per read section what it answered (schedulerStatus.device). */
  const accessBlock = (): HTMLElement | null => {
    const access = ctx.store.state.scheduler?.device;
    if (!access || access.writes === "unknown") return null;
    const locked = access.writes === "read_only";
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
      h("div", { class: `flex items-center gap-1.5 text-sm ${locked ? "text-warning" : ""}` }, icon(locked ? "lock" : "unlock"), t(WRITES_KEYS[access.writes])),
      h("ul", { class: "grid grid-cols-1 sm:grid-cols-2 gap-1.5" }, ...reads),
      locked ? h("p", { class: "text-xs faint" }, t("access_note")) : null
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
          h("span", { class: "fs-badge" }, token.scope === "full" ? t("scope_full") : t("scope_read")),
          token.imported ? h("span", { class: "fs-badge" }, t("imported")) : null
        ),
        h("div", { class: "text-[0.6875rem] faint num" }, `…${token.hint} · ${validity} · ${used}`)
      ),
      revoke
    );
  };

  const tokensTab = (): HTMLElement => {
    const name = input("text", "", "off", t("token_name"));
    name.maxLength = 64;
    const scope = h(
      "select",
      { class: "select select-sm rounded-lg", attrs: { "aria-label": t("scope_read") } },
      h("option", { attrs: { value: "read" } }, t("scope_read")),
      h("option", { attrs: { value: "full" } }, t("scope_full"))
    );
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
        .createToken({ name: name.value.trim(), scope: scope.value === "full" ? "full" : "read", lifetimeDays: lifetime.value === "never" ? null : Number(lifetime.value) })
        .then((res) => {
          minted = res.token;
          tokens = [...(tokens ?? []), res.record];
          ctx.toast(t("token_created"), "success");
          render();
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
      h("p", { class: "muted" }, t("tokens_intro")),
      shown
        ? h(
            "div",
            { class: "space-y-2" },
            notice(t("token_once"), "pending"),
            h("div", { class: "flex items-center gap-2" }, h("code", { class: "font-mono text-xs break-all flex-1 rounded-lg bg-base-200/70 p-2" }, shown), copyButton(shown))
          )
        : null,
      h("div", { class: "grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2" }, name, scope, lifetime, create),
      list
    );
  };

  // ---------------------------------------------------------------- telegram
  const telegramTab = (): HTMLElement => {
    if (!summary?.telegram.configured) return notice(t("telegram_off"));
    const command = pairing ? `/auth ${pairing}` : null;
    const create = button(
      t("pairing_create"),
      "btn-primary",
      () => {
        void ctx.api
          .pairingCode()
          .then((res) => {
            pairing = res.code;
            render();
          })
          .catch(fail);
      },
      "key"
    );
    const unlink = button(t("unlink_all"), "btn-ghost text-error", () => {
      void ctx
        .confirm({ title: t("unlink_title"), body: [t("unlink_body")], confirmLabel: t("unlink_all"), tone: "error" })
        .then(async (yes) => {
          if (!yes) return;
          const res = await ctx.api.unlinkTelegram();
          ctx.toast(t("unlinked", { count: res.unlinked }), "success");
        })
        .catch(fail);
    });
    return h(
      "div",
      { class: "space-y-3" },
      h("p", { class: "muted" }, t("telegram_intro")),
      command
        ? h(
            "div",
            { class: "rounded-xl bg-base-200/60 p-3 space-y-1" },
            h("div", { class: "text-xs muted" }, t("pairing_send")),
            h("div", { class: "flex items-center gap-2" }, h("code", { class: "font-mono text-lg tracking-wider flex-1" }, command), copyButton(command))
          )
        : null,
      h("div", { class: "flex flex-wrap gap-2 justify-between" }, create, unlink)
    );
  };

  // ---------------------------------------------------------------- security
  const saveSwitches = (body: { telegramReset?: boolean; metricsEnabled?: boolean | null }): void => {
    void ctx.api
      .consoleSwitches(body)
      .then((next) => {
        summary = next;
        ctx.toast(t("switch_saved"), "success");
      })
      .catch(fail)
      // A refused change puts the control back to the stored value
      .finally(render);
  };

  const securityTab = (): HTMLElement => {
    const s = summary;
    if (!s) return h("div");
    let reset: HTMLElement | null = null;
    if (s.telegram.configured) {
      const toggle = h("input", { class: "toggle toggle-sm toggle-primary mt-0.5", attrs: { type: "checkbox" } });
      toggle.checked = s.telegram.resetEnabled;
      toggle.addEventListener("change", () => saveSwitches({ telegramReset: toggle.checked }));
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
    metrics.addEventListener("change", () => saveSwitches({ metricsEnabled: metrics.value === "env" ? null : metrics.value === "on" }));
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
  const load = (what: "tokens" | "audit" | "device"): void => {
    if (loading.has(what)) return;
    loading.add(what);
    const epoch = deviceEpoch;
    const request =
      what === "tokens"
        ? ctx.api.tokens().then((res) => void (tokens = res.tokens))
        : what === "audit"
          ? ctx.api.audit(AUDIT_LIMIT).then((res) => void (audit = res.entries))
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
    else render();
  };

  const VIEWS: Readonly<Record<SettingsTab, () => HTMLElement>> = {
    router: routerTab,
    device: deviceTab,
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
        { class: "modal-box sm:max-w-2xl p-0 flex flex-col max-h-[90vh]" },
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
      h("form", { class: "modal-backdrop", attrs: { method: "dialog" } }, h("button", null, "close"))
    );
  };

  dialog.addEventListener("close", () => {
    // A minted token, a pairing code and a typed router password live only while the dialog is open
    minted = null;
    pairing = null;
    draft.password = "";
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
          draft = { url: s.cpe?.url ?? DEFAULT_CPE_URL, username: s.cpe?.username ?? "admin", password: "", lastAttempt: false };
          lastResult = null;
          tokens = null;
          audit = null;
          device = null;
          report = null;
          select(nextTab);
          if (!dialog.open) dialog.showModal();
          // An imported connection is tested at once; the user only has to confirm it
          if (isGuided && s.cpe) void runTest(false);
        })
        .catch(fail);
    },
  };
}
