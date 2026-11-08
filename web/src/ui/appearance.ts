import { contrastRatio, normalizeHex } from "../core/colors.ts";
import { type Locale, type MessageParams, interpolate } from "../core/i18n.ts";
import {
  ACCENTS,
  type AccentId,
  CUSTOM_THEME,
  type CustomTheme,
  DEFAULT_CUSTOM_THEMES,
  type Preferences,
  THEMES,
  THEME_META,
  type ThemeId,
  type ThemeScheme,
  isAccentId,
  isThemeId,
  savePreference,
  themeScheme,
} from "../core/prefs.ts";
import { type ThemeChoice, type ThemeSlot, chooseTheme, currentSlot, selectedTheme, setFollowSystem, switchCustomScheme, themeGroups } from "../core/theme-choice.ts";
import { ACCENT_NAMES, APPEARANCE_TEXT, type AppearanceTextKey, FAMILY_NAMES, THEME_NAMES } from "../i18n/appearance.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, modalBackdrop, mount } from "./dom.ts";
import { applyTheme, systemIsDark } from "./theme.ts";

/** Swatch colours (the light-scheme value of each accent; `default` shows a sampler of theme primaries). */
const ACCENT_SWATCH: Readonly<Record<Exclude<AccentId, "custom">, string>> = {
  default: "conic-gradient(from 45deg, oklch(55.5% 0.19 257) 0 90deg, oklch(58% 0.15 5) 90deg 180deg, oklch(53% 0.08 192) 180deg 270deg, oklch(56% 0.18 33) 270deg)",
  sky: "oklch(55.5% 0.19 257)",
  cinnabar: "oklch(55% 0.19 30)",
  sakura: "oklch(56% 0.16 358)",
  amber: "oklch(56% 0.14 55)",
  jade: "oklch(54% 0.11 168)",
  asagi: "oklch(52% 0.1 212)",
  indigo: "oklch(48% 0.16 268)",
  violet: "oklch(54% 0.18 300)",
  graphite: "oklch(40% 0.012 260)",
};

const MIN_CONTRAST = 4.5;
const CUSTOM_FIELDS = ["background", "text", "primary"] as const satisfies ReadonlyArray<keyof CustomTheme>;
type CustomField = (typeof CUSTOM_FIELDS)[number];

/** The appearance dialog (a lazy chunk); `theme.ts` keeps the page in sync with the preferences. */
export function mountAppearance(ctx: AppContext, switchLocale: (locale: Locale) => Promise<void>): { open(): void } {
  const dialog = byId<HTMLDialogElement>("appearanceDialog");
  const t = (key: AppearanceTextKey, params?: MessageParams): string => interpolate(APPEARANCE_TEXT[ctx.tr.locale][key], params);
  let slot: ThemeSlot = currentSlot(systemIsDark());

  const save = (changes: Partial<Preferences>): void => {
    Object.assign(ctx.prefs, changes);
    for (const key of Object.keys(changes) as Array<keyof Preferences>) savePreference(ctx.storage, key, ctx.prefs[key]);
  };
  const choice = (): ThemeChoice => ctx.prefs;
  /** Term help: every "?" mark follows `<html data-help>` at once, no re-render. */
  const helpToggle = (): HTMLInputElement => {
    const input = h("input", { class: "toggle toggle-sm toggle-primary", attrs: { type: "checkbox", "data-help-toggle": "" } });
    input.checked = ctx.prefs.showHelp;
    input.addEventListener("change", () => {
      save({ showHelp: input.checked });
      document.documentElement.dataset["help"] = input.checked ? "on" : "off";
    });
    return input;
  };
  const themeName = (id: ThemeId): string => THEME_NAMES[ctx.tr.locale][id];

  const themeCard = (id: ThemeId): HTMLElement => {
    const prefs = ctx.prefs;
    const badges = prefs.followSystem
      ? [prefs.dayTheme === id ? "sun" : null, prefs.nightTheme === id ? "moon" : null].filter((b): b is string => b !== null)
      : [];
    return h(
      "button",
      {
        class: `theme-card ${id === selectedTheme(choice(), slot) ? "is-selected" : ""}`,
        attrs: { type: "button", "aria-pressed": String(id === selectedTheme(choice(), slot)) },
        data: { themeOption: id },
      },
      h(
        "div",
        { class: "preview", attrs: { "data-theme": id, "data-scheme": themeScheme(id, prefs.customTheme) } },
        h(
          "div",
          { class: "w-[34%] bg-base-200 p-1.5 space-y-1" },
          h("div", { class: "h-1 w-3/4 rounded-full bg-primary" }),
          h("div", { class: "h-1 rounded-full bg-base-content/20" }),
          h("div", { class: "h-1 w-2/3 rounded-full bg-base-content/20" })
        ),
        h(
          "div",
          { class: "flex-1 bg-base-100 p-1.5 flex flex-col gap-1" },
          h("div", { class: "h-1.5 w-2/3 rounded-full bg-base-content/70" }),
          h("div", { class: "h-1 w-5/6 rounded-full bg-base-content/15" }),
          h("div", { class: "mt-auto self-end h-2.5 w-7 rounded-full bg-primary" })
        ),
        badges.length > 0 ? h("span", { class: "slot-badges" }, ...badges.map((b) => h("span", { class: "slot-badge" }, icon(b)))) : null
      ),
      h("span", { class: "theme-name" }, themeName(id)),
      h("span", { class: "theme-family" }, FAMILY_NAMES[ctx.tr.locale][THEME_META[id].family])
    );
  };

  const group = (label: string, ids: ReadonlyArray<ThemeId>): HTMLElement =>
    h("div", null, h("div", { class: "text-[0.6875rem] faint mb-2" }, label), h("div", { class: "grid grid-cols-3 sm:grid-cols-4 gap-x-3 gap-y-3.5" }, ...ids.map(themeCard)));

  const contrastNote = (custom: CustomTheme): string => {
    const ratio = contrastRatio(custom.background, custom.text);
    return ratio < MIN_CONTRAST ? t("contrast_low", { ratio: ratio.toFixed(1) }) : "";
  };

  const customEditor = (): HTMLElement => {
    const custom = ctx.prefs.customTheme;
    const label: Record<CustomField, AppearanceTextKey> = { background: "custom_background", text: "custom_text", primary: "custom_primary" };
    const schemes: ReadonlyArray<ThemeScheme> = ["light", "dark"];
    return h(
      "div",
      { class: "custom-editor mt-4 rounded-xl p-3.5 space-y-3" },
      h(
        "div",
        { class: "flex items-center justify-between gap-3" },
        h("span", { class: "text-sm font-medium" }, t("custom_title")),
        h(
          "div",
          { class: "join", attrs: { role: "group", "aria-label": t("custom_scheme") } },
          ...schemes.map((scheme) =>
            h(
              "button",
              { class: `btn btn-xs join-item ${custom.scheme === scheme ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" }, data: { customScheme: scheme } },
              icon(scheme === "light" ? "sun" : "moon"),
              t(scheme === "light" ? "scheme_light" : "scheme_dark")
            )
          )
        )
      ),
      h(
        "div",
        { class: "grid grid-cols-3 gap-2" },
        ...CUSTOM_FIELDS.map((field) =>
          h(
            "label",
            { class: "color-field" },
            h("input", { attrs: { type: "color", value: custom[field], "aria-label": t(label[field]) }, data: { customField: field } }),
            h("span", { class: "min-w-0" }, h("span", { class: "block text-xs" }, t(label[field])), h("span", { class: "block text-[0.6875rem] faint num", data: { hexOf: field } }, custom[field]))
          )
        )
      ),
      h("p", { class: "text-xs text-warning", data: { contrastNote: "1" } }, contrastNote(custom)),
      h(
        "div",
        { class: "flex items-center justify-between gap-3" },
        h("span", { class: "text-[0.6875rem] faint" }, t("custom_hint")),
        h("button", { class: "btn btn-ghost btn-xs shrink-0", attrs: { type: "button" }, data: { customReset: "1" } }, t("custom_reset"))
      )
    );
  };

  const accentSwatches = (): HTMLElement[] => {
    const current = ctx.prefs.accent;
    const presets = ACCENTS.filter((id): id is Exclude<AccentId, "custom"> => id !== "custom").map((id) =>
      h(
        "button",
        {
          class: `swatch ${id === current ? "is-selected" : ""}`,
          title: ACCENT_NAMES[ctx.tr.locale][id],
          attrs: { type: "button", "aria-label": ACCENT_NAMES[ctx.tr.locale][id] },
          data: { accentOption: id },
          style: `background:${ACCENT_SWATCH[id]}`,
        },
        id === current ? icon("check", "text-white text-sm") : null
      )
    );
    const picker = h(
      "label",
      { class: `swatch swatch-custom ${current === "custom" ? "is-selected" : ""}`, title: t("accent_pick"), data: { accentOption: "custom" } },
      h("input", { attrs: { type: "color", value: ctx.prefs.accentColor, "aria-label": t("accent_pick") }, data: { accentColor: "1" } })
    );
    return [...presets, picker];
  };

  const render = (): void => {
    const prefs = ctx.prefs;
    const groups = themeGroups();
    const editing = selectedTheme(choice(), slot);
    const modes: Array<[boolean, AppearanceTextKey]> = [
      [true, "mode_system"],
      [false, "mode_fixed"],
    ];
    const slots: Array<[ThemeSlot, string, AppearanceTextKey, ThemeId]> = [
      ["day", "sun", "slot_day", prefs.dayTheme],
      ["night", "moon", "slot_night", prefs.nightTheme],
    ];
    const languages: Array<[Locale, string]> = [
      ["zh-CN", "简体中文"],
      ["en", "English"],
    ];
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box sm:max-w-lg p-6 space-y-6" },
        h(
          "div",
          { class: "flex items-start justify-between" },
          h(
            "div",
            null,
            h("h3", { class: "text-lg font-bold serif" }, t("title")),
            h("p", { class: "text-xs muted mt-0.5" }, t("subtitle", { themes: THEMES.length - 1, accents: ACCENTS.length - 2 }))
          ),
          h("form", { attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": t("close") } }, icon("x", "text-base")))
        ),
        h(
          "section",
          { class: "space-y-4" },
          h(
            "div",
            { class: "flex flex-wrap items-center justify-between gap-2" },
            h("h4", { class: "fs-label" }, t("theme")),
            h(
              "div",
              { class: "join" },
              ...modes.map(([follow, key]) =>
                h("button", { class: `btn btn-xs join-item ${prefs.followSystem === follow ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" }, data: { followOption: follow ? "1" : "0" } }, t(key))
              )
            )
          ),
          prefs.followSystem
            ? h(
                "div",
                { class: "grid grid-cols-2 gap-2", attrs: { role: "tablist" } },
                ...slots.map(([id, glyph, key, theme]) =>
                  h(
                    "button",
                    { class: `slot-tab ${slot === id ? "is-active" : ""}`, attrs: { type: "button", role: "tab", "aria-selected": String(slot === id) }, data: { slotOption: id } },
                    icon(glyph, "text-base"),
                    h("span", { class: "min-w-0 text-left" }, h("span", { class: "block text-[0.6875rem] faint" }, t(key)), h("span", { class: "block text-sm font-medium truncate" }, themeName(theme)))
                  )
                )
              )
            : null,
          h("p", { class: "text-xs muted" }, prefs.followSystem ? t("hint_system", { slot: t(slot === "day" ? "slot_day" : "slot_night") }) : t("hint_fixed")),
          group(t("group_light"), groups.light),
          group(t("group_dark"), groups.dark),
          h("div", null, group(t("group_custom"), groups.custom), editing === CUSTOM_THEME ? customEditor() : null)
        ),
        h(
          "section",
          null,
          h(
            "div",
            { class: "flex items-baseline justify-between mb-3" },
            h("h4", { class: "fs-label" }, t("accent")),
            h("span", { class: "text-xs font-medium text-primary", data: { accentName: "1" } }, ACCENT_NAMES[ctx.tr.locale][prefs.accent])
          ),
          h("div", { class: "flex flex-wrap gap-3" }, ...accentSwatches()),
          h("p", { class: "text-[0.6875rem] faint mt-2.5" }, t("accent_hint"))
        ),
        h(
          "section",
          null,
          h("h4", { class: "fs-label mb-3" }, t("language")),
          h(
            "div",
            { class: "join w-full" },
            ...languages.map(([code, name]) =>
              h("button", { class: `btn btn-sm join-item flex-1 ${ctx.tr.locale === code ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" }, data: { localeOption: code } }, name)
            )
          )
        ),
        h(
          "section",
          null,
          h("h4", { class: "fs-label mb-3" }, t("help")),
          h("label", { class: "flex items-center justify-between gap-3 cursor-pointer" }, h("span", { class: "text-sm" }, t("help_toggle")), helpToggle()),
          h("p", { class: "text-xs muted mt-2" }, t("help_hint"))
        )
      ),
      modalBackdrop(ctx.t("common.close"))
    );
  };

  /** Mark the chosen accent in place: re-rendering would close an open colour picker. */
  const markAccent = (): void => {
    for (const el of dialog.querySelectorAll<HTMLElement>("[data-accent-option]")) {
      const selected = el.dataset["accentOption"] === ctx.prefs.accent;
      el.classList.toggle("is-selected", selected);
      if (el instanceof HTMLButtonElement) el.replaceChildren(...(selected ? [icon("check", "text-white text-sm")] : []));
    }
    const name = dialog.querySelector<HTMLElement>("[data-accent-name]");
    if (name) name.textContent = ACCENT_NAMES[ctx.tr.locale][ctx.prefs.accent];
  };

  const setCustomTheme = (custom: CustomTheme, animate: boolean): void => {
    save({ customTheme: custom });
    applyTheme(ctx.prefs, animate);
  };

  dialog.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    const theme = el?.closest<HTMLElement>("[data-theme-option]")?.dataset["themeOption"];
    const accent = el?.closest<HTMLElement>("[data-accent-option]")?.dataset["accentOption"];
    const follow = el?.closest<HTMLElement>("[data-follow-option]")?.dataset["followOption"];
    const slotOption = el?.closest<HTMLElement>("[data-slot-option]")?.dataset["slotOption"];
    const scheme = el?.closest<HTMLElement>("[data-custom-scheme]")?.dataset["customScheme"];
    const locale = el?.closest<HTMLElement>("[data-locale-option]")?.dataset["localeOption"];
    if (isThemeId(theme)) {
      save(chooseTheme(choice(), slot, theme));
      applyTheme(ctx.prefs, true);
      render();
    } else if (isAccentId(accent)) {
      save({ accent });
      applyTheme(ctx.prefs, true);
      // The custom swatch is a <label>: its colour picker opens on this click, so update in place
      if (accent === "custom") markAccent();
      else render();
    } else if (follow === "1" || follow === "0") {
      save(setFollowSystem(choice(), follow === "1", systemIsDark()));
      slot = currentSlot(systemIsDark());
      applyTheme(ctx.prefs, true);
      render();
    } else if (slotOption === "day" || slotOption === "night") {
      slot = slotOption;
      render();
    } else if (scheme === "light" || scheme === "dark") {
      setCustomTheme(switchCustomScheme(ctx.prefs.customTheme, scheme), true);
      render();
    } else if (el?.closest("[data-custom-reset]")) {
      setCustomTheme({ ...DEFAULT_CUSTOM_THEMES[ctx.prefs.customTheme.scheme] }, true);
      render();
    } else if (locale === "zh-CN" || locale === "en") {
      void switchLocale(locale);
    }
  });

  // Colour pickers fire `input` while dragging: update the page live without rebuilding the dialog
  dialog.addEventListener("input", (event) => {
    const el = event.target instanceof HTMLInputElement ? event.target : null;
    const value = normalizeHex(el?.value);
    if (!el || !value) return;
    const field = el.dataset["customField"];
    if (field === "background" || field === "text" || field === "primary") {
      setCustomTheme({ ...ctx.prefs.customTheme, [field]: value }, false);
      const hex = dialog.querySelector<HTMLElement>(`[data-hex-of="${field}"]`);
      if (hex) hex.textContent = value;
      const note = dialog.querySelector<HTMLElement>("[data-contrast-note]");
      if (note) note.textContent = contrastNote(ctx.prefs.customTheme);
    } else if (el.dataset["accentColor"]) {
      save({ accent: "custom", accentColor: value });
      applyTheme(ctx.prefs, false);
      markAccent();
    }
  });

  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });

  return {
    open: () => {
      slot = currentSlot(systemIsDark());
      render();
      dialog.showModal();
    },
  };
}
