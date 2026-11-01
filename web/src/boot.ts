import { detectLocale } from "./core/i18n.ts";
import { applyAppearance, loadPreferences, resolveAppearance } from "./core/prefs.ts";

/*
 * Pre-paint bootstrap, loaded as a classic blocking script in <head> (CSP forbids inline scripts):
 * applies the saved theme (day / night or fixed), accent, custom colours and language before the
 * first frame so there is no flash.
 */
try {
  const prefs = loadPreferences(window.localStorage);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const root = document.documentElement;
  applyAppearance(root, resolveAppearance(prefs, systemDark));
  root.lang = detectLocale(prefs.locale, navigator.languages ?? [navigator.language]);
} catch {
  // Storage blocked (private mode): the defaults in index.html apply
}
