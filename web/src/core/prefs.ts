import { normalizeHex, readableOn } from "./colors.ts";
import { type Locale, isLocale } from "./i18n.ts";

/**
 * Browser-local preferences (theme, accent, language, usage caps) and when the alerts were last
 * looked at. Every read is validated, so a
 * hand-edited or stale localStorage entry falls back to defaults instead of breaking the shell.
 * Privacy reveal state is deliberately not persisted: every page load starts masked.
 */

/** Every palette in web/styles.css, light ones first; `fengsui-custom` is built from the user's colours. */
export const THEMES = [
  "fengsui-sujian",
  "fengsui-yuebai",
  "fengsui-tianqing",
  "fengsui-sakura",
  "fengsui-wakatake",
  "fengsui-suzhi",
  "fengsui-chenxi",
  "fengsui-sujian-ye",
  "fengsui-sumi",
  "fengsui-dailan",
  "fengsui-konruri",
  "fengsui-yozakura",
  "fengsui-jiye",
  "fengsui-ziming",
  "fengsui-custom",
] as const;
export type ThemeId = (typeof THEMES)[number];
export type ThemeScheme = "light" | "dark";
/** Where a palette's colours come from (shown under its name in the picker). */
export type ThemeFamily = "classic" | "china" | "japan" | "fengsui" | "custom";

export const CUSTOM_THEME = "fengsui-custom" satisfies ThemeId;

/** `scheme: null` for the custom theme, whose light / dark side the user picks. */
export const THEME_META: Readonly<Record<ThemeId, { scheme: ThemeScheme | null; family: ThemeFamily }>> = {
  "fengsui-sujian": { scheme: "light", family: "classic" },
  "fengsui-yuebai": { scheme: "light", family: "china" },
  "fengsui-tianqing": { scheme: "light", family: "china" },
  "fengsui-sakura": { scheme: "light", family: "japan" },
  "fengsui-wakatake": { scheme: "light", family: "japan" },
  "fengsui-suzhi": { scheme: "light", family: "fengsui" },
  "fengsui-chenxi": { scheme: "light", family: "fengsui" },
  "fengsui-sujian-ye": { scheme: "dark", family: "classic" },
  "fengsui-sumi": { scheme: "dark", family: "japan" },
  "fengsui-dailan": { scheme: "dark", family: "china" },
  "fengsui-konruri": { scheme: "dark", family: "japan" },
  "fengsui-yozakura": { scheme: "dark", family: "japan" },
  "fengsui-jiye": { scheme: "dark", family: "fengsui" },
  "fengsui-ziming": { scheme: "dark", family: "fengsui" },
  "fengsui-custom": { scheme: null, family: "custom" },
};

export const ACCENTS = ["default", "sky", "cinnabar", "sakura", "amber", "jade", "asagi", "indigo", "violet", "graphite", "custom"] as const;
export type AccentId = (typeof ACCENTS)[number];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as ReadonlyArray<string>).includes(value);
}

export function isAccentId(value: unknown): value is AccentId {
  return typeof value === "string" && (ACCENTS as ReadonlyArray<string>).includes(value);
}

/** The custom theme: three `#rrggbb` colours and which side (light / dark) the rest is mixed for. */
export interface CustomTheme {
  scheme: ThemeScheme;
  background: string;
  text: string;
  primary: string;
}

export const DEFAULT_CUSTOM_THEMES: Readonly<Record<ThemeScheme, Readonly<CustomTheme>>> = {
  light: { scheme: "light", background: "#f6f7f9", text: "#1d2128", primary: "#2f6fe0" },
  dark: { scheme: "dark", background: "#1b1d22", text: "#e8eaee", primary: "#5b9cf5" },
};

export interface Preferences {
  /** The theme shown when not following the system. */
  theme: ThemeId;
  /** Themes used while following the system's light / dark setting. */
  dayTheme: ThemeId;
  nightTheme: ThemeId;
  followSystem: boolean;
  accent: AccentId;
  /** `#rrggbb` of the `custom` accent. */
  accentColor: string;
  customTheme: CustomTheme;
  locale: Locale | null;
  /** Browser-local caps for the usage rings, in bytes (`null` = use the router's limit / none). */
  dailyCapBytes: number | null;
  monthlyCapBytes: number | null;
}

export const DEFAULT_PREFERENCES: Readonly<Preferences> = {
  theme: "fengsui-sujian",
  dayTheme: "fengsui-sujian",
  nightTheme: "fengsui-sujian-ye",
  followSystem: true,
  accent: "default",
  accentColor: "#2f6fe0",
  customTheme: DEFAULT_CUSTOM_THEMES.light,
  locale: null,
  dailyCapBytes: null,
  monthlyCapBytes: null,
};

/** Storage keys; shared with the pre-paint boot script so the first frame already has the theme. */
export const PREF_KEYS = {
  theme: "fengsui.theme",
  dayTheme: "fengsui.dayTheme",
  nightTheme: "fengsui.nightTheme",
  followSystem: "fengsui.followSystem",
  accent: "fengsui.accent",
  accentColor: "fengsui.accentColor",
  customTheme: "fengsui.customTheme",
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

/** A stored custom theme, or the light default when it is missing, malformed or partly invalid. */
export function parseCustomTheme(raw: string | null): CustomTheme {
  if (raw === null || raw.length > 512) return { ...DEFAULT_CUSTOM_THEMES.light };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CUSTOM_THEMES.light };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_CUSTOM_THEMES.light };
  const record = parsed as Record<string, unknown>;
  const scheme: ThemeScheme = record["scheme"] === "dark" ? "dark" : "light";
  const fallback = DEFAULT_CUSTOM_THEMES[scheme];
  return {
    scheme,
    background: normalizeHex(record["background"]) ?? fallback.background,
    text: normalizeHex(record["text"]) ?? fallback.text,
    primary: normalizeHex(record["primary"]) ?? fallback.primary,
  };
}

function themeOr(raw: string | null, fallback: ThemeId): ThemeId {
  return isThemeId(raw) ? raw : fallback;
}

export function loadPreferences(storage: KeyValueStorage): Preferences {
  const accent = safeGet(storage, PREF_KEYS.accent);
  const locale = safeGet(storage, PREF_KEYS.locale);
  return {
    theme: themeOr(safeGet(storage, PREF_KEYS.theme), DEFAULT_PREFERENCES.theme),
    dayTheme: themeOr(safeGet(storage, PREF_KEYS.dayTheme), DEFAULT_PREFERENCES.dayTheme),
    nightTheme: themeOr(safeGet(storage, PREF_KEYS.nightTheme), DEFAULT_PREFERENCES.nightTheme),
    followSystem: safeGet(storage, PREF_KEYS.followSystem) !== "0",
    accent: isAccentId(accent) ? accent : DEFAULT_PREFERENCES.accent,
    accentColor: normalizeHex(safeGet(storage, PREF_KEYS.accentColor)) ?? DEFAULT_PREFERENCES.accentColor,
    customTheme: parseCustomTheme(safeGet(storage, PREF_KEYS.customTheme)),
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
    else if (typeof value === "object") storage.setItem(storageKey, JSON.stringify(value));
    else storage.setItem(storageKey, String(value));
  } catch {
    // ignore: the in-memory preference still applies for this page
  }
}

/**
 * When this browser last opened the alerts panel: the time of the newest alert it showed then. The
 * daemon keeps the last 100 alerts, so without it every page load would count the old ones as new.
 */
export const ALERTS_SEEN_KEY = "fengsui.alertsSeenAt";
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** `""` until the panel was opened in this browser (or when storage is blocked). */
export function loadAlertsSeen(storage: KeyValueStorage): string {
  const raw = safeGet(storage, ALERTS_SEEN_KEY);
  return raw !== null && ISO_TIME.test(raw) ? raw : "";
}

export function saveAlertsSeen(storage: KeyValueStorage, tsIso: string): void {
  try {
    storage.setItem(ALERTS_SEEN_KEY, tsIso);
  } catch {
    // ignore: the badge still clears for this page
  }
}

type ThemeChoice = Pick<Preferences, "theme" | "dayTheme" | "nightTheme" | "followSystem">;

/** The theme actually shown: the day / night pick when following the system, else the fixed one. */
export function effectiveTheme(prefs: ThemeChoice, systemDark: boolean): ThemeId {
  if (prefs.followSystem) return systemDark ? prefs.nightTheme : prefs.dayTheme;
  return prefs.theme;
}

export function themeScheme(theme: ThemeId, custom: Pick<CustomTheme, "scheme">): ThemeScheme {
  return THEME_META[theme].scheme ?? custom.scheme;
}

/** What `<html>` carries: palette, its light / dark side, accent, and the user colours as CSS properties. */
export interface Appearance {
  theme: ThemeId;
  scheme: ThemeScheme;
  accent: AccentId;
  vars: Readonly<Record<string, string>>;
}

export function resolveAppearance(prefs: ThemeChoice & Pick<Preferences, "accent" | "accentColor" | "customTheme">, systemDark: boolean): Appearance {
  const theme = effectiveTheme(prefs, systemDark);
  const custom = prefs.customTheme;
  return {
    theme,
    scheme: themeScheme(theme, custom),
    accent: prefs.accent,
    vars: {
      "--custom-bg": custom.background,
      "--custom-ink": custom.text,
      "--custom-primary": custom.primary,
      "--custom-primary-content": readableOn(custom.primary),
      "--accent-custom": prefs.accentColor,
      "--accent-custom-content": readableOn(prefs.accentColor),
    },
  };
}

/** The slice of an element `applyAppearance` writes (the real `<html>`, or a test double). */
export interface AppearanceTarget {
  dataset: Record<string, string | undefined>;
  style: { setProperty(name: string, value: string): void };
}

export function applyAppearance(target: AppearanceTarget, look: Appearance): void {
  target.dataset["theme"] = look.theme;
  target.dataset["scheme"] = look.scheme;
  target.dataset["accent"] = look.accent;
  for (const [name, value] of Object.entries(look.vars)) target.style.setProperty(name, value);
}
