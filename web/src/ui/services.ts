import { ApiError, type ApiErrorKind } from "../core/api.ts";
import type { Translator } from "../core/i18n.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { ConfirmOptions, ToastTone } from "./context.ts";
import { byId, h, icon } from "./dom.ts";

const TOAST_ICONS: Readonly<Record<ToastTone, [string, string]>> = {
  info: ["info", "text-info"],
  success: ["check", "text-success"],
  warning: ["alert", "text-warning"],
  error: ["x", "text-error"],
};

/** Transient notice at the top; at most four stay on screen. */
export function showToast(message: string, tone: ToastTone = "info", durationMs = 3600): void {
  const container = byId("toasts");
  const [name, color] = TOAST_ICONS[tone];
  const item = h("div", { class: "toast-item" }, icon(name, `text-base ${color}`), h("span", null, message));
  container.appendChild(item);
  while (container.childElementCount > 4) container.firstElementChild?.remove();
  setTimeout(() => {
    item.classList.add("is-leaving");
    setTimeout(() => item.remove(), 260);
  }, durationMs);
}

/**
 * Promise-based confirmation on the static `#confirmDialog`. With `typeToConfirm` the confirm
 * button stays disabled until the word is typed (二次防误触 for reboot-class actions).
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const dialog = byId<HTMLDialogElement>("confirmDialog");
  const ok = byId<HTMLButtonElement>("confirmOk");
  const cancel = byId<HTMLButtonElement>("confirmCancel");
  const typeRow = byId("confirmTypeRow");
  const typeInput = byId<HTMLInputElement>("confirmTypeInput");
  const checkRow = byId("confirmCheckRow");
  const checkInput = byId<HTMLInputElement>("confirmCheckInput");
  byId("confirmTitle").textContent = options.title;
  byId("confirmBody").replaceChildren(...options.body.map((line) => h("p", null, line)));
  ok.textContent = options.confirmLabel;
  ok.className = `btn btn-sm rounded-lg ${options.tone === "error" ? "btn-error" : options.tone === "warning" ? "btn-warning" : "btn-primary"}`;
  const check = options.check;
  checkRow.classList.toggle("hidden", !check);
  byId("confirmCheckLabel").textContent = check?.label ?? "";
  checkInput.checked = check?.checked ?? false;
  const word = options.typeToConfirm;
  typeRow.classList.toggle("hidden", !word);
  typeInput.value = "";
  ok.disabled = Boolean(word);
  if (word) byId("confirmTypeLabel").textContent = word;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      typeInput.removeEventListener("input", onType);
      checkInput.removeEventListener("change", onCheck);
      dialog.removeEventListener("close", onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onOk = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onClose = (): void => finish(false);
    const onType = (): void => {
      ok.disabled = typeInput.value.trim().toLowerCase() !== (word ?? "").toLowerCase();
    };
    const onCheck = (): void => check?.onChange(checkInput.checked);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    typeInput.addEventListener("input", onType);
    checkInput.addEventListener("change", onCheck);
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    (word ? typeInput : cancel).focus();
  });
}

const ERROR_KEYS: Readonly<Record<ApiErrorKind, MessageKey>> = {
  unauthorized: "err.unauthorized",
  rate_limited: "err.rate_limited",
  csrf: "err.csrf",
  validation: "err.validation",
  yielded: "err.yielded",
  peer_standby: "err.peer_standby",
  breaker: "err.breaker",
  unavailable: "err.unavailable",
  upstream: "err.upstream",
  sms_send_failed: "err.upstream",
  sms_disabled: "err.sms_disabled",
  not_found: "err.not_found",
  network: "err.network",
  timeout: "err.timeout",
  unknown: "err.unknown",
};

export function describeError(tr: Translator<MessageKey>, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "yielded" && error.envelope) {
      return tr.pick(error.envelope.message, error.envelope.messageEn ?? "");
    }
    return tr.t(ERROR_KEYS[error.kind], { message: error.message });
  }
  return tr.t("err.unknown", { message: error instanceof Error ? error.message : String(error) });
}

/** Apply `data-i18n*` attributes under `root` (static labels in index.html and templates). */
export function applyI18n(tr: Translator<MessageKey>, root: ParentNode = document): void {
  const has = (key: string | undefined): key is MessageKey => key !== undefined && key.length > 0;
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset["i18n"];
    if (has(key)) el.textContent = tr.t(key);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = el.dataset["i18nPlaceholder"];
    if (has(key)) el.placeholder = tr.t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = el.dataset["i18nTitle"];
    if (has(key)) el.title = tr.t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = el.dataset["i18nAria"];
    if (has(key)) el.setAttribute("aria-label", tr.t(key));
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-locale-label]")) {
    el.textContent = tr.locale === "zh-CN" ? "EN" : "中";
  }
  document.documentElement.lang = tr.locale;
  document.title = tr.t("app.title");
}
