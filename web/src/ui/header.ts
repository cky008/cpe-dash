import { readOnlyModel } from "../core/device-access-view.ts";
import { loadAlertsSeen, saveAlertsSeen } from "../core/prefs.ts";
import { unreadBadgeCount, unseenAlertCount } from "../core/store.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, icon } from "./dom.ts";

export type ViewName = "dashboard" | "sms";

/** Fired on `document` when the visible view changes (`detail` = view name). */
export const VIEW_EVENT = "fengsui:view";
/** Fired on `document` when the alerts panel has been opened (resets the unseen badge). */
export const ALERTS_SEEN_EVENT = "fengsui:alerts-seen";

type Tone = "ok" | "busy" | "warn" | "danger" | "none";

function setPill(pill: HTMLElement, tone: Tone, text: string, pulsing: boolean): void {
  if (tone === "none") pill.removeAttribute("data-tone");
  else pill.dataset["tone"] = tone;
  pill.querySelector(".fs-dot")?.classList.toggle("is-pulsing", pulsing);
  const label = pill.querySelector<HTMLElement>("[data-role=text]");
  if (label && label.textContent !== text) label.textContent = text;
}

export function mountHeader(ctx: AppContext): void {
  const views: Record<ViewName, HTMLElement> = { dashboard: byId("dashboardView"), sms: byId("smsView") };
  const navButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-view]")];

  const setView = (view: ViewName, pushHistory: boolean): void => {
    for (const [name, el] of Object.entries(views)) el.classList.toggle("hidden", name !== view);
    for (const button of navButtons) button.classList.toggle("is-active", button.dataset["view"] === view);
    if (pushHistory) history.replaceState(null, "", view === "sms" ? "#sms" : "#");
    document.dispatchEvent(new CustomEvent<ViewName>(VIEW_EVENT, { detail: view }));
  };
  for (const button of navButtons) {
    button.addEventListener("click", () => setView(button.dataset["view"] === "sms" ? "sms" : "dashboard", true));
  }
  window.addEventListener("hashchange", () => setView(location.hash === "#sms" ? "sms" : "dashboard", false));
  setView(location.hash === "#sms" ? "sms" : "dashboard", false);

  const sessionPill = byId("sessionPill");
  const renderSession = (): void => {
    const status = ctx.store.state.scheduler;
    const avoidance = ctx.store.state.avoidance;
    let tone: Tone = "none";
    let key: MessageKey = "session.unknown";
    let pulsing = false;
    if (status) {
      if (status.mode === "circuit_tripped") [tone, key] = ["danger", "session.breaker"];
      else if (status.mode === "standby_peer") [tone, key] = ["warn", "session.standby"];
      else if (status.mode === "yielding_browser" || avoidance?.active) [tone, key, pulsing] = ["warn", "session.yielding", true];
      else if (status.mode === "cpe_unreachable") [tone, key] = ["danger", "session.unreachable"];
      else if (status.mode === "polling") [tone, key, pulsing] = ["busy", "session.polling", true];
      else [tone, key] = ["ok", "session.idle"];
    }
    setPill(sessionPill, tone, ctx.t(key), pulsing);
    sessionPill.classList.toggle("fs-breathe", key === "session.yielding");
    sessionPill.title = status?.lastError ?? "";
  };

  // A model FengSui was not verified on: read-only, and one click away from its device page
  const readOnlyBadge = byId("readOnlyBadge");
  const controlsBtn = byId("controlsBtn");
  const renderReadOnly = (): void => {
    const model = readOnlyModel(ctx.store.state.scheduler);
    readOnlyBadge.classList.toggle("hidden", model === null);
    // On a phone the badge takes the controls button's place: there are no controls to offer
    controlsBtn.classList.toggle("hidden", model !== null);
    controlsBtn.classList.toggle("sm:inline-flex", model !== null);
    if (model === null) return;
    const text = readOnlyBadge.querySelector<HTMLElement>("[data-role=text]");
    if (text) text.textContent = ctx.t("dev.read_only_badge");
    readOnlyBadge.title = ctx.t("dev.read_only_title", { model });
    readOnlyBadge.setAttribute("aria-label", readOnlyBadge.title);
  };

  const ssePill = byId("ssePill");
  const renderSse = (): void => {
    const { state } = ctx.store.state.sse;
    if (state === "live") setPill(ssePill, "ok", ctx.t("sse.live"), true);
    else if (state === "connecting") setPill(ssePill, "busy", ctx.t("sse.connecting"), false);
    else if (state === "reconnecting") setPill(ssePill, "warn", ctx.t("sse.reconnecting"), false);
    else setPill(ssePill, "danger", ctx.t("sse.offline"), false);
  };

  const unreadBadge = byId("smsUnreadBadge");
  const renderUnread = (): void => {
    const count = unreadBadgeCount(ctx.store.state.sms);
    unreadBadge.textContent = count > 99 ? "99+" : String(count);
    unreadBadge.classList.toggle("hidden", count === 0 || !ctx.store.state.smsEnabled);
  };

  // Kept per browser: a reload must not show the alerts it already looked at as new
  let alertsSeenAt = loadAlertsSeen(ctx.storage);
  const alertsBadge = byId("alertsBadge");
  const renderAlerts = (): void => {
    const unseen = unseenAlertCount(ctx.store.state.alerts, alertsSeenAt);
    alertsBadge.textContent = unseen > 9 ? "9+" : String(unseen);
    alertsBadge.classList.toggle("hidden", unseen === 0);
  };
  document.addEventListener(ALERTS_SEEN_EVENT, () => {
    const newest = ctx.store.state.alerts.at(-1)?.tsIso;
    if (newest && newest > alertsSeenAt) {
      alertsSeenAt = newest;
      saveAlertsSeen(ctx.storage, newest);
    }
    renderAlerts();
  });

  const privacyBtn = byId("privacyBtn");
  const renderPrivacy = (): void => {
    const masked = ctx.privacy.globalMasked;
    privacyBtn.replaceChildren(icon(masked ? "eye-off" : "eye", "text-base"));
    privacyBtn.title = ctx.t(masked ? "nav.privacy_on" : "nav.privacy_off");
    privacyBtn.setAttribute("aria-label", privacyBtn.title);
    privacyBtn.classList.toggle("text-primary", !masked);
  };

  ctx.store.subscribe("scheduler", renderSession);
  ctx.store.subscribe("scheduler", renderReadOnly);
  ctx.store.subscribe("sse", renderSse);
  ctx.store.subscribe("sms", renderUnread);
  ctx.store.subscribe("alerts", renderAlerts);
  ctx.privacy.onChange(renderPrivacy);
  ctx.tr.onChange(() => {
    renderSession();
    renderReadOnly();
    renderSse();
    renderPrivacy();
  });
  renderSession();
  renderReadOnly();
  renderSse();
  renderUnread();
  renderAlerts();
  renderPrivacy();
}
