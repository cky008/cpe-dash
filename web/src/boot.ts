import { detectLocale } from "./core/i18n.ts";
import { PREF_KEYS, effectiveTheme, isAccentId, isThemeId } from "./core/prefs.ts";

/*
 * Pre-paint bootstrap, loaded as a classic blocking script in <head> (CSP forbids inline scripts):
 * applies the saved theme, accent and language before the first frame so there is no flash.
 */
try {
  const read = (key: string): string | null => window.localStorage.getItem(key);
  const theme = read(PREF_KEYS.theme);
  const accent = read(PREF_KEYS.accent);
  const followSystem = read(PREF_KEYS.followSystem) !== "0";
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  root.dataset["theme"] = effectiveTheme({ theme: isThemeId(theme) ? theme : "fengsui-suzhi", followSystem }, systemDark);
  root.dataset["accent"] = isAccentId(accent) ? accent : "default";
  root.lang = detectLocale(read(PREF_KEYS.locale), navigator.languages ?? [navigator.language]);
} catch {
  // Storage blocked (private mode): the defaults in index.html apply
}
