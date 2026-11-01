import { type Preferences, applyAppearance, resolveAppearance } from "../core/prefs.ts";

const darkQuery = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

type ThemePrefs = Pick<Preferences, "theme" | "dayTheme" | "nightTheme" | "followSystem" | "accent" | "accentColor" | "customTheme">;

/** Put the preferred theme, accent and custom colours on `<html>` (boot.ts did the same before first paint). */
export function applyTheme(prefs: ThemePrefs, animate: boolean): void {
  const root = document.documentElement;
  if (animate) {
    root.classList.add("theme-transition");
    setTimeout(() => root.classList.remove("theme-transition"), 380);
  }
  applyAppearance(root, resolveAppearance(prefs, darkQuery().matches));
}

export function systemIsDark(): boolean {
  return darkQuery().matches;
}

/** Switch between the day and night themes with the system while "follow system" is on. */
export function watchSystemTheme(prefs: ThemePrefs, onChange?: () => void): void {
  darkQuery().addEventListener("change", () => {
    if (!prefs.followSystem) return;
    applyTheme(prefs, true);
    onChange?.();
  });
}
