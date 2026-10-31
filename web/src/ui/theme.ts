import { type Preferences, effectiveTheme } from "../core/prefs.ts";

const darkQuery = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

/** Put the preferred theme and accent on `<html>` (boot.ts did the same before first paint). */
export function applyTheme(prefs: Pick<Preferences, "theme" | "accent" | "followSystem">, animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    setTimeout(() => root.classList.remove("theme-transition"), 380);
  }
  root.dataset["theme"] = effectiveTheme(prefs, darkQuery().matches);
  root.dataset["accent"] = prefs.accent;
}

/** Follow the system light / dark switch while "follow system" is on. */
export function watchSystemTheme(prefs: Pick<Preferences, "theme" | "accent" | "followSystem">): void {
  darkQuery().addEventListener("change", () => {
    if (prefs.followSystem) applyTheme(prefs, true);
  });
}
