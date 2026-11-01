import { type CustomTheme, DEFAULT_CUSTOM_THEMES, type Preferences, THEMES, THEME_META, type ThemeId, type ThemeScheme, effectiveTheme } from "./prefs.ts";

/**
 * What the appearance dialog's controls change, as pure functions over the preferences: the picker
 * edits the day or night theme while following the system and the fixed theme otherwise.
 */

export type ThemeSlot = "day" | "night";
export type ThemeChoice = Pick<Preferences, "theme" | "dayTheme" | "nightTheme" | "followSystem">;

/** Palettes grouped as the picker lists them; built-in order follows `THEMES`. */
export function themeGroups(): { light: ThemeId[]; dark: ThemeId[]; custom: ThemeId[] } {
  return {
    light: THEMES.filter((id) => THEME_META[id].scheme === "light"),
    dark: THEMES.filter((id) => THEME_META[id].scheme === "dark"),
    custom: THEMES.filter((id) => THEME_META[id].scheme === null),
  };
}

/** The theme a click in the picker would replace. */
export function selectedTheme(prefs: ThemeChoice, slot: ThemeSlot): ThemeId {
  if (!prefs.followSystem) return prefs.theme;
  return slot === "day" ? prefs.dayTheme : prefs.nightTheme;
}

/** The preference a picked theme lands in. */
export function chooseTheme(prefs: ThemeChoice, slot: ThemeSlot, id: ThemeId): Partial<ThemeChoice> {
  if (!prefs.followSystem) return { theme: id };
  return slot === "day" ? { dayTheme: id } : { nightTheme: id };
}

/**
 * Turning "follow system" off keeps whatever is on screen as the fixed theme, so the page does not
 * jump; turning it on returns to the saved day / night pair.
 */
export function setFollowSystem(prefs: ThemeChoice, follow: boolean, systemDark: boolean): Partial<ThemeChoice> {
  if (follow) return { followSystem: true };
  return { followSystem: false, theme: effectiveTheme(prefs, systemDark) };
}

/** The slot to edit first: the one the system shows right now. */
export function currentSlot(systemDark: boolean): ThemeSlot {
  return systemDark ? "night" : "day";
}

/**
 * Flip the custom theme's side. Untouched defaults move to the other side's defaults; colours the
 * user picked are kept.
 */
export function switchCustomScheme(custom: CustomTheme, scheme: ThemeScheme): CustomTheme {
  if (custom.scheme === scheme) return custom;
  const old = DEFAULT_CUSTOM_THEMES[custom.scheme];
  const untouched = custom.background === old.background && custom.text === old.text && custom.primary === old.primary;
  return untouched ? { ...DEFAULT_CUSTOM_THEMES[scheme] } : { ...custom, scheme };
}
