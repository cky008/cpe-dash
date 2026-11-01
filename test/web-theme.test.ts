import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { DARK_TEXT, LIGHT_TEXT, contrastRatio, normalizeHex, readableOn, relativeLuminance } from "../web/src/core/colors.ts";
import {
  ACCENTS,
  DEFAULT_CUSTOM_THEMES,
  DEFAULT_PREFERENCES,
  type KeyValueStorage,
  PREF_KEYS,
  THEMES,
  THEME_META,
  type ThemeId,
  applyAppearance,
  loadPreferences,
  parseCustomTheme,
  resolveAppearance,
  savePreference,
  themeScheme,
} from "../web/src/core/prefs.ts";
import { chooseTheme, currentSlot, selectedTheme, setFollowSystem, switchCustomScheme, themeGroups } from "../web/src/core/theme-choice.ts";

class MemoryStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

// ── OKLCH → WCAG luminance (Björn Ottosson's OKLab matrices), for the stylesheet checks ──

function oklchLuminance(css: string): number {
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css.trim());
  if (!m) throw new Error(`not an opaque oklch() colour: ${css}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const r = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const g = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const bl = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s);
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}

function oklchContrast(a: string, b: string): number {
  const la = oklchLuminance(a);
  const lb = oklchLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const CSS = fs.readFileSync("web/styles.css", "utf8");

/** Custom properties of the first rule whose selector is exactly `selector`. */
function ruleVars(selector: string): Map<string, string> {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `web/styles.css has no rule for ${selector}`);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("\n}", start));
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    if (m[1] && m[2]) vars.set(m[1], m[2].trim());
  }
  return vars;
}

const PALETTE_VARS = [
  "color-base-100",
  "color-base-200",
  "color-base-300",
  "color-base-content",
  "color-primary",
  "color-primary-content",
  "color-secondary",
  "color-secondary-content",
  "color-accent",
  "color-accent-content",
  "color-neutral",
  "color-neutral-content",
  "surface",
  "surface-solid",
  "hairline",
  "grid-line",
] as const;

const BUILT_IN = THEMES.filter((id): id is Exclude<ThemeId, "fengsui-custom"> => id !== "fengsui-custom");

describe("web core: theme colours", () => {
  it("accepts only #rrggbb and measures WCAG contrast", () => {
    assert.equal(normalizeHex("#2F6FE0"), "#2f6fe0");
    assert.equal(normalizeHex(" 2f6fe0 "), "#2f6fe0");
    for (const bad of ["#fff", "red", "#2f6fe0ff", "", 42, null]) assert.equal(normalizeHex(bad), null);
    assert.equal(relativeLuminance("#ffffff"), 1);
    assert.equal(relativeLuminance("#000000"), 0);
    assert.equal(relativeLuminance("not a colour"), 0);
    assert.equal(contrastRatio("#000000", "#ffffff"), 21);
    assert.equal(Math.round(contrastRatio("#777777", "#ffffff") * 100) / 100, 4.48);
    assert.equal(readableOn("#2f6fe0"), LIGHT_TEXT);
    assert.equal(readableOn("#f6d365"), DARK_TEXT);
  });
});

describe("web core: theme preferences", () => {
  it("keeps separate day, night and fixed themes, the custom theme and the custom accent", () => {
    const storage = new MemoryStorage();
    savePreference(storage, "dayTheme", "fengsui-yuebai");
    savePreference(storage, "nightTheme", "fengsui-konruri");
    savePreference(storage, "accent", "custom");
    savePreference(storage, "accentColor", "#c25b7a");
    savePreference(storage, "customTheme", { scheme: "dark", background: "#101820", text: "#f2f2f2", primary: "#33a6b8" });
    assert.equal(storage.data.get(PREF_KEYS.customTheme), '{"scheme":"dark","background":"#101820","text":"#f2f2f2","primary":"#33a6b8"}');
    const prefs = loadPreferences(storage);
    assert.equal(prefs.dayTheme, "fengsui-yuebai");
    assert.equal(prefs.nightTheme, "fengsui-konruri");
    assert.equal(prefs.accent, "custom");
    assert.equal(prefs.accentColor, "#c25b7a");
    assert.deepEqual(prefs.customTheme, { scheme: "dark", background: "#101820", text: "#f2f2f2", primary: "#33a6b8" });

    storage.data.set(PREF_KEYS.nightTheme, "fengsui-neon");
    storage.data.set(PREF_KEYS.accentColor, "magenta");
    assert.equal(loadPreferences(storage).nightTheme, DEFAULT_PREFERENCES.nightTheme);
    assert.equal(loadPreferences(storage).accentColor, DEFAULT_PREFERENCES.accentColor);
  });

  it("repairs a damaged custom theme field by field", () => {
    assert.deepEqual(parseCustomTheme(null), DEFAULT_CUSTOM_THEMES.light);
    assert.deepEqual(parseCustomTheme("{not json"), DEFAULT_CUSTOM_THEMES.light);
    assert.deepEqual(parseCustomTheme("[1,2]"), DEFAULT_CUSTOM_THEMES.light);
    assert.deepEqual(parseCustomTheme(`"${"x".repeat(600)}"`), DEFAULT_CUSTOM_THEMES.light);
    assert.deepEqual(parseCustomTheme('{"scheme":"dark","background":"#000000","text":"url(x)"}'), {
      scheme: "dark",
      background: "#000000",
      text: DEFAULT_CUSTOM_THEMES.dark.text,
      primary: DEFAULT_CUSTOM_THEMES.dark.primary,
    });
    assert.equal(parseCustomTheme('{"scheme":"sepia"}').scheme, "light");
  });

  it("resolves what <html> carries, including the custom theme's side and readable button text", () => {
    const prefs = {
      ...DEFAULT_PREFERENCES,
      nightTheme: "fengsui-custom",
      accent: "custom",
      accentColor: "#f6d365",
      customTheme: { scheme: "dark", background: "#101820", text: "#f2f2f2", primary: "#33a6b8" },
    } as const;
    const day = resolveAppearance(prefs, false);
    assert.deepEqual([day.theme, day.scheme, day.accent], ["fengsui-sujian", "light", "custom"]);
    const night = resolveAppearance(prefs, true);
    assert.deepEqual([night.theme, night.scheme], ["fengsui-custom", "dark"]);
    assert.equal(night.vars["--custom-bg"], "#101820");
    assert.equal(night.vars["--custom-primary-content"], DARK_TEXT);
    assert.equal(night.vars["--accent-custom-content"], DARK_TEXT);

    const props = new Map<string, string>();
    const target = { dataset: {} as Record<string, string | undefined>, style: { setProperty: (k: string, v: string) => void props.set(k, v) } };
    applyAppearance(target, night);
    assert.deepEqual(target.dataset, { theme: "fengsui-custom", scheme: "dark", accent: "custom" });
    assert.equal(props.get("--accent-custom"), "#f6d365");
    assert.equal(props.size, 6);
    assert.equal(themeScheme("fengsui-jiye", { scheme: "light" }), "dark");
  });
});

describe("web core: theme picker choices", () => {
  it("groups seven light and seven dark palettes plus the custom one", () => {
    const groups = themeGroups();
    assert.equal(groups.light.length, 7);
    assert.equal(groups.dark.length, 7);
    assert.deepEqual(groups.custom, ["fengsui-custom"]);
    assert.equal(groups.light[0], "fengsui-sujian");
    assert.equal(groups.dark[0], "fengsui-sujian-ye");
  });

  it("edits the day or night theme while following the system, the fixed theme otherwise", () => {
    const follow = { theme: "fengsui-suzhi", dayTheme: "fengsui-sujian", nightTheme: "fengsui-sujian-ye", followSystem: true } as const;
    assert.equal(currentSlot(true), "night");
    assert.equal(currentSlot(false), "day");
    assert.equal(selectedTheme(follow, "day"), "fengsui-sujian");
    assert.equal(selectedTheme(follow, "night"), "fengsui-sujian-ye");
    assert.deepEqual(chooseTheme(follow, "day", "fengsui-sakura"), { dayTheme: "fengsui-sakura" });
    assert.deepEqual(chooseTheme(follow, "night", "fengsui-sumi"), { nightTheme: "fengsui-sumi" });
    const fixed = { ...follow, followSystem: false };
    assert.equal(selectedTheme(fixed, "night"), "fengsui-suzhi");
    assert.deepEqual(chooseTheme(fixed, "night", "fengsui-dailan"), { theme: "fengsui-dailan" });
    // Leaving "follow system" keeps what is on screen
    assert.deepEqual(setFollowSystem(follow, false, true), { followSystem: false, theme: "fengsui-sujian-ye" });
    assert.deepEqual(setFollowSystem(fixed, true, true), { followSystem: true });
  });

  it("moves an untouched custom theme to the other side's defaults and keeps picked colours", () => {
    const light = { ...DEFAULT_CUSTOM_THEMES.light };
    assert.equal(switchCustomScheme(light, "light"), light);
    assert.deepEqual(switchCustomScheme(light, "dark"), DEFAULT_CUSTOM_THEMES.dark);
    const picked = { ...light, primary: "#c25b7a" };
    assert.deepEqual(switchCustomScheme(picked, "dark"), { ...picked, scheme: "dark" });
  });
});

describe("web/styles.css palettes", () => {
  it("defines every theme the registry lists, and no other", () => {
    const defined = [...CSS.matchAll(/^\[data-theme="(fengsui-[a-z-]+)"\] \{/gm)].map((m) => m[1]);
    assert.deepEqual([...new Set(defined)].sort(), [...THEMES].sort());
  });

  it("gives each built-in palette every variable, on the side the registry says", () => {
    for (const id of BUILT_IN) {
      const vars = ruleVars(`[data-theme="${id}"]`);
      for (const name of PALETTE_VARS) assert.ok(vars.has(name), `${id} lacks --${name}`);
      const base = oklchLuminance(vars.get("color-base-100") ?? "");
      if (THEME_META[id].scheme === "light") assert.ok(base > 0.75, `${id} is listed light but its base is dark`);
      else assert.ok(base < 0.06, `${id} is listed dark but its base is light`);
    }
  });

  it("keeps text, buttons and badges readable in every built-in palette (WCAG)", () => {
    for (const id of BUILT_IN) {
      const vars = ruleVars(`[data-theme="${id}"]`);
      const get = (name: string): string => vars.get(name) ?? "";
      const page = vars.get("page-bg") ?? get("color-base-100");
      assert.ok(oklchContrast(get("color-base-content"), get("color-base-100")) >= 7, `${id}: body text on cards`);
      assert.ok(oklchContrast(get("color-base-content"), page) >= 7, `${id}: body text on the page`);
      for (const pair of ["primary", "secondary", "accent", "neutral"]) {
        const ratio = oklchContrast(get(`color-${pair}`), get(`color-${pair}-content`));
        assert.ok(ratio >= 4.5, `${id}: ${pair} button text ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it("gives every preset accent a light and a dark tint with readable text", () => {
    for (const accent of ACCENTS.filter((a) => a !== "default" && a !== "custom")) {
      for (const selector of [`:root[data-accent="${accent}"]`, `:root[data-accent="${accent}"][data-scheme="dark"]`]) {
        const vars = ruleVars(selector);
        const ratio = oklchContrast(vars.get("color-primary") ?? "", vars.get("color-primary-content") ?? "");
        assert.ok(ratio >= 4.5, `${selector}: ${ratio.toFixed(2)}:1`);
      }
    }
    assert.ok(ruleVars(':root[data-accent="custom"]').has("color-primary"));
  });
});
