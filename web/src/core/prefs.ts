import { type Locale, isLocale } from "./i18n.ts";

/**
 * Browser-local preferences (theme, accent, language, usage caps). Every read is validated, so a
 * hand-edited or stale localStorage entry falls back to defaults instead of breaking the shell.
 * Privacy reveal state is deliberately not persisted: every page load starts masked.
 */

export const THEMES = ["fengsui-suzhi", "fengsui-chenxi", "fengsui-jiye", "fengsui-ziming"] as const;
export type ThemeId = (typeof THEMES)[number];

/** Light and dark themes used when "follow system" is on. */
export const SYSTEM_THEMES: Readonly<{ light: ThemeId; dark: ThemeId }> = { light: "fengsui-suzhi", dark: "fengsui-jiye" };

export const DARK_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(["fengsui-jiye", "fengsui-ziming"]);

export const ACCENTS = ["default", "cinnabar", "indigo", "jade", "amber", "violet", "graphite"] as const;
export type AccentId = (typeof ACCENTS)[number];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as ReadonlyArray<string>).includes(value);
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && (ACCENTS as ReadonlyArray<string>).includes(value);
}

export interface Preferences {
  theme: ThemeId;
  accent: AccentId;
  followSystem: boolean;
  locale: Locale | null;
  /** Browser-local caps for the usage rings, in bytes (`null` = use the router's limit / none). */
  dailyCapBytes: number | null;
  monthlyCapBytes: number | null;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  theme: "fengsui-suzhi",
  accent: "default",
  followSystem: true,
  locale: null,
  dailyCapBytes: null,
  monthlyCapBytes: null,
};

/** Storage keys; shared with the pre-paint boot script so the first frame already has the theme. */
export const PREF_KEYS = {
  theme: "fengsui.theme",
  accent: "fengsui.accent",
  followSystem: "fengsui.followSystem",
  locale: "fengsui.locale",
  dailyCapBytes: "fengsui.dailyCapBytes",
  monthlyCapBytes: "fengsui.monthlyCapBytes",
} as const satisfies Record<keyof Preferences, string>;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function safeGet(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseCap(raw: string | null): number | null {
  if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
  const value = Number(raw);
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

export function loadPreferences(storage: KeyValueStorage): Preferences {
  const theme = safeGet(storage, PREF_KEYS.theme);
  const accent = safeGet(storage, PREF_KEYS.accent);
  const locale = safeGet(storage, PREF_KEYS.locale);
  return {
    theme: isThemeId(theme) ? theme : DEFAULT_PREFERENCES.theme,
    accent: isAccentId(accent) ? accent : DEFAULT_PREFERENCES.accent,
    followSystem: safeGet(storage, PREF_KEYS.followSystem) !== "0",
    locale: isLocale(locale) ? locale : null,
    dailyCapBytes: parseCap(safeGet(storage, PREF_KEYS.dailyCapBytes)),
    monthlyCapBytes: parseCap(safeGet(storage, PREF_KEYS.monthlyCapBytes)),
  };
}

/** Persist one field; storage failures (private mode, quota) only lose persistence, never the change. */
export function savePreference<K extends keyof Preferences>(storage: KeyValueStorage, key: K, value: Preferences[K]): void {
  const storageKey = PREF_KEYS[key];
  try {
    if (value === null) storage.removeItem(storageKey);
    else if (typeof value === "boolean") storage.setItem(storageKey, value ? "1" : "0");
    else storage.setItem(storageKey, String(value));
  } catch {
    // ignore: the in-memory preference still applies for this page
  }
}

/** The theme actually shown: the system light/dark pair when following the system. */
export function effectiveTheme(prefs: Pick<Preferences, "theme" | "followSystem">, systemDark: boolean): ThemeId {
  if (prefs.followSystem) return systemDark ? SYSTEM_THEMES.dark : SYSTEM_THEMES.light;
  return prefs.theme;
}
