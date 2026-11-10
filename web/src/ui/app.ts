import { ApiClient, ApiError } from "../core/api.ts";
import { RECOVERY_COMMANDS, passwordProblem } from "../core/console-view.ts";
import { versionLabel } from "../core/device-access-view.ts";
import { createEndpoints } from "../core/endpoints.ts";
import { type Locale, Translator, detectLocale } from "../core/i18n.ts";
import { type KeyValueStorage, loadPreferences, savePreference } from "../core/prefs.ts";
import { PrivacyState, maskValue } from "../core/privacy.ts";
import { type EventSourceLike, type SseEvent, SseClient } from "../core/sse.ts";
import { Store, mergeAlerts, reduceSseEvent } from "../core/store.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import { mountBanners } from "./banners.ts";
import { mountCharts } from "./charts.ts";
import type { AppContext } from "./context.ts";
import { byId, show } from "./dom.ts";
import { VIEW_EVENT, type ViewName, mountHeader } from "./header.ts";
import { mountHealthCard } from "./health-card.ts";
import { mountIdentityCards } from "./identity-cards.ts";
import { mountNeighbors } from "./neighbors.ts";
import { mountOperatorCards } from "./operator-cards.ts";
import { mountRfCard } from "./rf-card.ts";
import { applyI18n, confirmDialog, describeError, showToast } from "./services.ts";
import type { SettingsTab } from "./settings.ts";
import { applyTheme, watchSystemTheme } from "./theme.ts";
import { mountTopology } from "./topology.ts";
import { mountTrafficCard } from "./traffic-card.ts";

/** Scheduler status has no SSE frame of its own; this in-memory read costs the router nothing. */
const SESSION_STATUS_POLL_MS = 10_000;

/** Sign in; choose the console password with the setup code; or reset it with a reset code. */
type LoginMode = "login" | "setup" | "reset";

const LOGIN_KEYS: Readonly<Record<LoginMode, { note: MessageKey | null; code: MessageKey; password: MessageKey; submit: MessageKey; error: MessageKey }>> = {
  login: { note: null, code: "login.setup_code", password: "login.placeholder", submit: "login.submit", error: "login.error_failed" },
  setup: { note: "login.setup_note", code: "login.setup_code", password: "login.new_password", submit: "login.setup_submit", error: "login.error_setup_code" },
  reset: { note: "login.reset_note", code: "login.reset_code", password: "login.new_password", submit: "login.reset_submit", error: "login.error_reset_code" },
};

function browserStorage(): KeyValueStorage {
  try {
    const probe = "fengsui.probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    };
  }
}

/** Each language is its own chunk; only the active one loads with the page. */
const DICTIONARIES: Readonly<Record<Locale, () => Promise<Readonly<Record<MessageKey, string>>>>> = {
  "zh-CN": () => import("../i18n/zh-CN.ts").then((m) => m.zhCN),
  en: () => import("../i18n/en.ts").then((m) => m.en),
};

/** Alerts after which what self-healing will do next has changed. */
const SELF_HEAL_ALERTS: ReadonlySet<string> = new Set(["LOCK_ROLLED_BACK", "LOCK_ROLLBACK_FAILED", "WAN_AUTO_RECONNECT", "WAN_RECONNECT_EXHAUSTED", "SELF_HEAL_READ_ONLY"]);

/** How the console reaches its daemon: the page's own origin, or the static demo's in-page backend. */
export interface AppTransport {
  fetchImpl: typeof fetch;
  createEventSource: (url: string) => EventSourceLike;
  /** Set by the static demo, whose backend lives in the page. */
  demo?: boolean;
}

const BROWSER_TRANSPORT: AppTransport = {
  fetchImpl: (input, init) => window.fetch(input, init),
  createEventSource: (url) => new EventSource(url, { withCredentials: true }),
};

export async function startApp(transport: AppTransport = BROWSER_TRANSPORT): Promise<void> {
  const storage = browserStorage();
  const prefs = loadPreferences(storage);
  const initialLocale = detectLocale(prefs.locale, navigator.languages ?? [navigator.language]);
  const tr = new Translator<MessageKey>(initialLocale, await DICTIONARIES[initialLocale]());
  const switchLocale = async (locale: Locale): Promise<void> => {
    if (!tr.has(locale)) tr.add(locale, await DICTIONARIES[locale]());
    tr.setLocale(locale);
  };
  const store = new Store();
  const privacy = new PrivacyState(true);
  let handleUnauthorized = (): void => undefined;
  const api = createEndpoints(new ApiClient({ fetchImpl: transport.fetchImpl, onUnauthorized: () => handleUnauthorized() }));
  const tickers = new Set<() => void>();
  setInterval(() => {
    if (document.hidden) return;
    for (const listener of [...tickers]) listener();
  }, 1000);

  const ctx: AppContext = {
    tr,
    t: (key, params) => tr.t(key, params),
    store,
    api,
    privacy,
    prefs,
    storage,
    toast: (message, tone) => showToast(message, tone),
    confirm: (options) => confirmDialog(options),
    describeError: (error) => describeError(tr, error),
    now: () => Date.now(),
    demo: transport.demo === true,
    onTick: (listener) => {
      tickers.add(listener);
      return () => tickers.delete(listener);
    },
  };

  applyI18n(tr);
  tr.onChange((locale) => {
    savePreference(storage, "locale", locale);
    prefs.locale = locale;
    applyI18n(tr);
  });
  applyTheme(prefs, false);
  watchSystemTheme(prefs);

  // Dialogs and drawers are lazy chunks, loaded on first use
  let appearanceLoading: Promise<{ open(): void }> | null = null;
  let alertsLoading: Promise<{ open(): void }> | null = null;
  const openAlerts = (): void => {
    alertsLoading ??= import("./alerts.ts").then((m) => m.mountAlerts(ctx));
    void alertsLoading.then((panel) => panel.open());
  };
  let controlsLoading: Promise<{ open(): void }> | null = null;
  let mcpGuideLoading: Promise<{ open(): void }> | null = null;
  let settingsLoading: Promise<{ open(tab?: SettingsTab, guided?: boolean): void }> | null = null;
  const openSettings = (tab?: SettingsTab, guided = false): void => {
    settingsLoading ??= import("./settings.ts").then((m) => m.mountSettings(ctx));
    void settingsLoading.then((dialog) => dialog.open(tab, guided));
  };
  let appMounted = false;
  let sse: SseClient | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const loginView = byId("loginView");
  const appView = byId("appView");

  const refreshSessionStatus = async (): Promise<void> => {
    try {
      const { status, selfHeal } = await api.sessionStatus();
      store.update({ scheduler: status, avoidance: status.avoidance, selfHeal }, ["scheduler"]);
    } catch {
      // The SSE banner already reports an unreachable daemon
    }
  };

  /** Snapshots `hello` does not carry (contract §3.1): fetched at start and after every reconnect. */
  let snapshotsInFlight: Promise<void> | null = null;
  const loadSnapshots = (): Promise<void> => {
    snapshotsInFlight ??= fetchSnapshots().finally(() => {
      snapshotsInFlight = null;
    });
    return snapshotsInFlight;
  };
  const fetchSnapshots = async (): Promise<void> => {
    const results = await Promise.allSettled([api.telemetry(), api.neighbors(), api.topology(), api.settings(), api.alerts()]);
    const [telemetry, neighbors, topology, settings, alerts] = results;
    if (telemetry.status === "fulfilled") {
      const v = telemetry.value;
      store.update(
        {
          scheduler: v.schedulerStatus,
          avoidance: v.schedulerStatus.avoidance,
          telemetry: v.telemetry ?? store.state.telemetry,
          lockState: v.lockState,
          lockVerification: v.lockVerification,
          alerts: mergeAlerts(store.state.alerts, v.recentAlerts),
        },
        ["scheduler", "telemetry", "locks", "alerts"]
      );
    }
    if (neighbors.status === "fulfilled") store.update({ neighbors: neighbors.value.neighbors }, ["neighbors"]);
    if (topology.status === "fulfilled") store.update({ topology: topology.value.topology }, ["topology"]);
    if (settings.status === "fulfilled") {
      store.update({ settings: settings.value.settings, lockVerification: settings.value.lockVerification }, ["settings", "locks"]);
    }
    if (alerts.status === "fulfilled") store.update({ alerts: mergeAlerts(store.state.alerts, alerts.value.alerts) }, ["alerts"]);
  };

  const notifySideEffects = (event: SseEvent): void => {
    switch (event.name) {
      case "hello":
        void loadSnapshots();
        // `hello` carries the scheduler but not what self-healing will do next
        void refreshSessionStatus();
        return;
      case "alert": {
        const alert = event.data;
        if (alert.code.startsWith("CIRCUIT_") || SELF_HEAL_ALERTS.has(alert.code)) void refreshSessionStatus();
        if (alert.severity !== "info") ctx.toast(tr.pick(alert.messageZh, alert.messageEn), alert.severity === "critical" ? "error" : "warning");
        // The AI agent test's reminder also reaches a console left in a background tab; a click opens the alerts, which reads it
        if (alert.code === "AGENT_TEST_STILL_ON" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
          const notice = new Notification(tr.t("toast.agent_test_still_on"), { body: tr.pick(alert.messageZh, alert.messageEn), tag: alert.id });
          notice.addEventListener("click", () => {
            window.focus();
            notice.close();
            openAlerts();
          });
        }
        return;
      }
      case "control:applied":
        // An experimental write whose read-back differs is a warning, not a success
        ctx.toast(tr.pick(event.data.summaryZh, event.data.summaryEn), event.data.check?.readback === "mismatch" ? "warning" : "success");
        // A lock opens (an unlock closes) self-healing's window: show it without waiting for the next poll
        if (event.data.lockState) void refreshSessionStatus();
        return;
      case "session:avoidance":
        if (!event.data.active && event.data.stateCode === "-1") ctx.toast(tr.pick(event.data.messageZh, event.data.messageEn), "info");
        return;
      case "sms:new": {
        const msg = event.data;
        const masked = privacy.isMasked("sms");
        const number = msg.sender.displayNumber || msg.phone;
        const who = msg.contact?.name ?? (masked ? maskValue("phone", number) : number);
        const code = msg.verificationCode;
        ctx.toast(code && !masked ? tr.t("toast.new_sms_otp", { who, code }) : tr.t("toast.new_sms", { who }), "info");
        if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
          // Privacy mode keeps message text (and codes) out of OS notification centres
          const body = masked ? "" : msg.content.slice(0, 180);
          new Notification(tr.t("toast.new_sms", { who }), { body, tag: msg.uid });
        }
        return;
      }
      default:
        return;
    }
  };

  const startStreams = (): void => {
    sse?.stop();
    sse = new SseClient({
      url: "/api/events",
      createEventSource: transport.createEventSource,
      onEvent: (event) => {
        store.apply(reduceSseEvent(store.state, event));
        notifySideEffects(event);
      },
      onStatus: (status) => {
        store.update({ sse: status }, ["sse"]);
        // The auth probe answers 200 { authenticated: false }, so the API client's 401 hook never fires here
        if (status.state === "unauthorized") handleUnauthorized();
      },
      isAuthenticated: async () => (await api.authStatus()).authenticated,
    });
    sse.start();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (!document.hidden) void refreshSessionStatus();
    }, SESSION_STATUS_POLL_MS);
  };

  let loginMode: LoginMode = "login";
  /** The keys go into data-i18n attributes, so a language switch relabels the current mode. */
  const setLoginMode = (mode: LoginMode): void => {
    loginMode = mode;
    const keys = LOGIN_KEYS[mode];
    const relabel = (el: HTMLElement, key: MessageKey, attribute: "i18n" | "i18nPlaceholder"): void => {
      el.dataset[attribute] = key;
      if (attribute === "i18n") el.textContent = tr.t(key);
      else (el as HTMLInputElement).placeholder = tr.t(key);
    };
    if (keys.note) relabel(byId("loginModeText"), keys.note, "i18n");
    byId("loginModeCommand").textContent = mode === "login" ? "" : RECOVERY_COMMANDS[mode];
    show(byId("loginModeNote"), keys.note !== null);
    show(byId("loginCodeRow"), mode !== "login");
    show(byId("loginConfirmRow"), mode !== "login");
    relabel(byId("loginCode"), keys.code, "i18nPlaceholder");
    const password = byId<HTMLInputElement>("loginToken");
    relabel(password, keys.password, "i18nPlaceholder");
    password.autocomplete = mode === "login" ? "current-password" : "new-password";
    relabel(byId("loginSubmit"), keys.submit, "i18n");
    const toggle = byId("loginModeToggle");
    relabel(toggle, mode === "reset" ? "login.back" : "login.forgot", "i18n");
    show(toggle, mode !== "setup");
    byId("loginError").classList.add("hidden");
    (mode === "login" ? password : byId<HTMLInputElement>("loginCode")).focus();
  };
  byId("loginModeToggle").addEventListener("click", () => setLoginMode(loginMode === "reset" ? "login" : "reset"));

  const showLogin = (expired: boolean, setupRequired = false): void => {
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) dialog.close();
    sse?.stop();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
    setLoginMode(setupRequired ? "setup" : "login");
    const error = byId("loginError");
    error.textContent = expired ? tr.t("login.expired") : "";
    error.classList.toggle("hidden", !expired);
  };

  /** First run or an upgrade from .env: lead into the router settings until they are confirmed. */
  const guideSetup = (): void => {
    void api
      .consoleSettings()
      .then((settings) => {
        if (!settings.cpe || settings.reviewPending) openSettings("router", true);
      })
      .catch(() => undefined);
  };

  const enterApp = (): void => {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    if (!appMounted) {
      appMounted = true;
      // The SMS centre is a lazy chunk, loaded the first time its view is shown
      let smsLoading: Promise<void> | null = null;
      document.addEventListener(VIEW_EVENT, (event) => {
        if ((event as CustomEvent<ViewName>).detail !== "sms" || smsLoading) return;
        smsLoading = import("./sms/index.ts").then((m) => m.mountSms(ctx, true));
      });
      mountHeader(ctx);
      mountBanners(ctx, { reconnectNow: () => sse?.reconnectNow(), refreshStatus: refreshSessionStatus });
      mountOperatorCards(ctx);
      mountIdentityCards(ctx);
      mountRfCard(ctx);
      mountTrafficCard(ctx);
      mountHealthCard(ctx);
      mountCharts(ctx);
      mountNeighbors(ctx);
      mountTopology(ctx);
      applyI18n(tr);
      // The version with the model the daemon goes by (the router may be another model than the H168-383)
      let version: string | null = null;
      const renderVersion = (): void => {
        if (version !== null) byId("versionLabel").textContent = versionLabel(version, store.state.scheduler);
      };
      store.subscribe("scheduler", renderVersion);
      void api
        .health()
        .then((h) => {
          version = h.version;
          renderVersion();
        })
        .catch(() => undefined);
      // Once per page, not per sign-in: a re-login submitted with Enter would stack another listener
      if ("Notification" in window && Notification.permission === "default") {
        document.body.addEventListener("click", () => void Notification.requestPermission().catch(() => undefined), { once: true });
      }
    }
    startStreams();
    void loadSnapshots();
    guideSetup();
  };

  handleUnauthorized = () => {
    if (!loginView.classList.contains("hidden")) return;
    showLogin(true);
  };

  byId<HTMLFormElement>("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId<HTMLInputElement>("loginToken");
    const codeInput = byId<HTMLInputElement>("loginCode");
    const confirmInput = byId<HTMLInputElement>("loginConfirm");
    const button = byId<HTMLButtonElement>("loginSubmit");
    const error = byId("loginError");
    const showError = (message: string): void => {
      error.textContent = message;
      error.classList.remove("hidden");
    };
    const password = input.value;
    const code = codeInput.value.trim();
    const mode = loginMode;
    if (!password || (mode !== "login" && !code)) return;
    if (mode !== "login") {
      const problem = passwordProblem(password, confirmInput.value);
      if (problem) {
        showError(tr.t(problem === "short" ? "login.error_short" : "login.error_mismatch"));
        return;
      }
    }
    button.disabled = true;
    button.textContent = tr.t("login.submitting");
    error.classList.add("hidden");
    const request = mode === "login" ? api.login(password) : mode === "setup" ? api.setupLogin(code, password) : api.resetLogin(code, password);
    request
      .then(() => {
        input.value = "";
        codeInput.value = "";
        confirmInput.value = "";
        setLoginMode("login");
        enterApp();
      })
      .catch((err: unknown) => {
        let message = tr.t(LOGIN_KEYS[mode].error);
        if (err instanceof ApiError && err.kind === "rate_limited") {
          message = tr.t("login.error_rate_limited", { seconds: err.envelope?.retryAfterSec ?? 60 });
        } else if (err instanceof ApiError && (err.kind === "network" || err.kind === "timeout")) {
          message = tr.t("login.error_network");
        } else if (err instanceof ApiError && err.kind === "validation") {
          message = tr.t("login.error_short");
        } else if (err instanceof ApiError && err.envelope?.errorCode === "ALREADY_SET_UP") {
          setLoginMode("login");
          message = tr.t("login.error_set_up");
        }
        showError(message);
      })
      .finally(() => {
        button.disabled = false;
        button.textContent = tr.t(LOGIN_KEYS[loginMode].submit);
      });
  });

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
    switch (target?.dataset["action"]) {
      case "toggle-locale":
        void switchLocale(tr.locale === "zh-CN" ? "en" : "zh-CN");
        return;
      case "open-appearance":
        appearanceLoading ??= import("./appearance.ts").then((m) => m.mountAppearance(ctx, switchLocale));
        void appearanceLoading.then((dialog) => dialog.open());
        return;
      case "open-alerts":
        openAlerts();
        return;
      case "open-controls":
        controlsLoading ??= import("./controls.ts").then((m) => m.mountControls(ctx));
        void controlsLoading.then((controls) => controls.open());
        return;
      case "open-mcp-guide":
        mcpGuideLoading ??= import("./mcp-guide.ts").then((m) => m.mountMcpGuide(ctx));
        void mcpGuideLoading.then((guide) => guide.open());
        return;
      case "open-settings":
        openSettings();
        return;
      case "open-device":
        openSettings("device");
        return;
      case "toggle-privacy":
        privacy.setGlobal(!privacy.globalMasked);
        return;
      case "logout":
        void api
          .logout()
          .catch(() => undefined)
          .finally(() => window.location.reload());
        return;
      default:
        return;
    }
  });

  window.addEventListener("online", () => sse?.reconnectNow());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      sse?.reconnectNow();
      void refreshSessionStatus();
    }
  });

  api
    .authStatus()
    .then((status) => (status.authenticated ? enterApp() : showLogin(false, status.setupRequired)))
    .catch(() => showLogin(false));
}
