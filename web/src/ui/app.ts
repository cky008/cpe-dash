import { ApiClient, ApiError } from "../core/api.ts";
import { createEndpoints } from "../core/endpoints.ts";
import { type Locale, Translator, detectLocale } from "../core/i18n.ts";
import { type KeyValueStorage, loadPreferences, savePreference } from "../core/prefs.ts";
import { PrivacyState, maskValue } from "../core/privacy.ts";
import { type SseEvent, SseClient } from "../core/sse.ts";
import { Store, mergeAlerts, reduceSseEvent } from "../core/store.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import { mountBanners } from "./banners.ts";
import type { AppContext } from "./context.ts";
import { byId } from "./dom.ts";
import { mountHeader } from "./header.ts";
import { mountHealthCard } from "./health-card.ts";
import { mountIdentityCards } from "./identity-cards.ts";
import { mountNeighbors } from "./neighbors.ts";
import { mountOperatorCards } from "./operator-cards.ts";
import { mountRfCard } from "./rf-card.ts";
import { applyI18n, confirmDialog, describeError, showToast } from "./services.ts";
import { applyTheme, watchSystemTheme } from "./theme.ts";
import { mountTopology } from "./topology.ts";
import { mountTrafficCard } from "./traffic-card.ts";

/** Scheduler status has no SSE frame of its own; this in-memory read costs the router nothing. */
const SESSION_STATUS_POLL_MS = 10_000;

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

export async function startApp(): Promise<void> {
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
  const api = createEndpoints(new ApiClient({ fetchImpl: (input, init) => window.fetch(input, init), onUnauthorized: () => handleUnauthorized() }));
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
  let appMounted = false;
  let sse: SseClient | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  const loginView = byId("loginView");
  const appView = byId("appView");

  const refreshSessionStatus = async (): Promise<void> => {
    try {
      const { status } = await api.sessionStatus();
      store.update({ scheduler: status, avoidance: status.avoidance }, ["scheduler"]);
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
        return;
      case "alert": {
        const alert = event.data;
        if (alert.code.startsWith("CIRCUIT_")) void refreshSessionStatus();
        if (alert.severity !== "info") ctx.toast(tr.pick(alert.messageZh, alert.messageEn), alert.severity === "critical" ? "error" : "warning");
        return;
      }
      case "control:applied":
        ctx.toast(tr.pick(event.data.summaryZh, event.data.summaryEn), "success");
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
      createEventSource: (url) => new EventSource(url, { withCredentials: true }),
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

  const showLogin = (expired: boolean): void => {
    sse?.stop();
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    appView.classList.add("hidden");
    loginView.classList.remove("hidden");
    const error = byId("loginError");
    error.textContent = expired ? tr.t("login.expired") : "";
    error.classList.toggle("hidden", !expired);
    byId<HTMLInputElement>("loginToken").focus();
  };

  const enterApp = (): void => {
    loginView.classList.add("hidden");
    appView.classList.remove("hidden");
    if (!appMounted) {
      appMounted = true;
      mountHeader(ctx);
      mountBanners(ctx, { reconnectNow: () => sse?.reconnectNow(), refreshStatus: refreshSessionStatus });
      mountOperatorCards(ctx);
      mountIdentityCards(ctx);
      mountRfCard(ctx);
      mountTrafficCard(ctx);
      mountHealthCard(ctx);
      mountNeighbors(ctx);
      mountTopology(ctx);
      applyI18n(tr);
      void api
        .health()
        .then((h) => {
          byId("versionLabel").textContent = `v${h.version} · H168-383`;
        })
        .catch(() => undefined);
    }
    startStreams();
    void loadSnapshots();
    if ("Notification" in window && Notification.permission === "default") {
      document.body.addEventListener("click", () => void Notification.requestPermission().catch(() => undefined), { once: true });
    }
  };

  handleUnauthorized = () => {
    if (!loginView.classList.contains("hidden")) return;
    showLogin(true);
  };

  byId<HTMLFormElement>("loginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = byId<HTMLInputElement>("loginToken");
    const button = byId<HTMLButtonElement>("loginSubmit");
    const error = byId("loginError");
    const token = input.value;
    if (!token) return;
    button.disabled = true;
    button.textContent = tr.t("login.submitting");
    error.classList.add("hidden");
    api
      .login(token)
      .then(() => {
        input.value = "";
        enterApp();
      })
      .catch((err: unknown) => {
        let message = tr.t("login.error_failed");
        if (err instanceof ApiError && err.kind === "rate_limited") {
          message = tr.t("login.error_rate_limited", { seconds: err.envelope?.retryAfterSec ?? 60 });
        } else if (err instanceof ApiError && (err.kind === "network" || err.kind === "timeout")) {
          message = tr.t("login.error_network");
        }
        error.textContent = message;
        error.classList.remove("hidden");
      })
      .finally(() => {
        button.disabled = false;
        button.textContent = tr.t("login.submit");
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
    .then((status) => (status.authenticated ? enterApp() : showLogin(false)))
    .catch(() => showLogin(false));
}
