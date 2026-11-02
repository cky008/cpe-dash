import type { Endpoints } from "../core/endpoints.ts";
import type { MessageParams, Translator } from "../core/i18n.ts";
import type { KeyValueStorage, Preferences } from "../core/prefs.ts";
import type { PrivacyState } from "../core/privacy.ts";
import type { Store } from "../core/store.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ConfirmOptions {
  title: string;
  body: ReadonlyArray<string>;
  confirmLabel: string;
  tone?: "primary" | "warning" | "error";
  /** Second safeguard for destructive actions: the user must type this word. */
  typeToConfirm?: string;
}

/** Services every view receives; views never reach for globals. */
export interface AppContext {
  tr: Translator<MessageKey>;
  t(key: MessageKey, params?: MessageParams): string;
  store: Store;
  api: Endpoints;
  privacy: PrivacyState;
  prefs: Preferences;
  storage: KeyValueStorage;
  toast(message: string, tone?: ToastTone): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** Localized description of any thrown value (ApiError kinds first). */
  describeError(error: unknown): string;
  now(): number;
  /** The static GitHub Pages demo (in-page backend, no daemon). */
  demo: boolean;
  /** One shared 1 s ticker (relative times, countdowns); skipped while the tab is hidden. */
  onTick(listener: () => void): () => void;
}
