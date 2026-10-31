import type { Locale } from "../core/i18n.ts";
import { ACCENTS, type AccentId, THEMES, type ThemeId, effectiveTheme, isAccentId, isThemeId, savePreference } from "../core/prefs.ts";
import { applyTheme } from "./theme.ts";
import type { MessageKey } from "../i18n/zh-CN.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount } from "./dom.ts";

const THEME_LABELS: Readonly<Record<ThemeId, MessageKey>> = {
  "fengsui-suzhi": "ap.theme_suzhi",
  "fengsui-chenxi": "ap.theme_chenxi",
  "fengsui-jiye": "ap.theme_jiye",
  "fengsui-ziming": "ap.theme_ziming",
};

const ACCENT_LABELS: Readonly<Record<AccentId, MessageKey>> = {
  default: "ap.accent_default",
  cinnabar: "ap.accent_cinnabar",
  indigo: "ap.accent_indigo",
  jade: "ap.accent_jade",
  amber: "ap.accent_amber",
  violet: "ap.accent_violet",
  graphite: "ap.accent_graphite",
};

/** Swatch colours (the light-theme value of each accent; `default` shows a theme sampler). */
const ACCENT_SWATCH: Readonly<Record<AccentId, string>> = {
  default: "conic-gradient(from 45deg, oklch(47% 0.09 245) 0 120deg, oklch(57% 0.15 45) 120deg 240deg, oklch(72% 0.17 300) 240deg)",
  cinnabar: "oklch(55% 0.19 30)",
  indigo: "oklch(48% 0.16 268)",
  jade: "oklch(54% 0.11 168)",
  amber: "oklch(62% 0.15 58)",
  violet: "oklch(54% 0.18 300)",
  graphite: "oklch(40% 0.012 260)",
};

/** The appearance dialog (a lazy chunk); `theme.ts` keeps the page in sync with the preferences. */
export function mountAppearance(ctx: AppContext, switchLocale: (locale: Locale) => Promise<void>): { open(): void } {
  const dialog = byId<HTMLDialogElement>("appearanceDialog");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (animate: boolean): void => applyTheme(ctx.prefs, animate);

  const render = (): void => {
    const current = effectiveTheme(ctx.prefs, darkQuery.matches);
    const themeCards = THEMES.map((id) =>
      h(
        "button",
        { class: `theme-card ${id === current ? "is-selected" : ""}`, attrs: { type: "button" }, data: { themeOption: id } },
        h(
          "div",
          { class: "preview", attrs: { "data-theme": id } },
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
          )
        ),
        h("span", null, ctx.t(THEME_LABELS[id]))
      )
    );
    const swatches = ACCENTS.map((id) =>
      h(
        "button",
        {
          class: `swatch ${id === ctx.prefs.accent ? "is-selected" : ""}`,
          title: ctx.t(ACCENT_LABELS[id]),
          attrs: { type: "button", "aria-label": ctx.t(ACCENT_LABELS[id]) },
          data: { accentOption: id },
          style: `background:${ACCENT_SWATCH[id]}`,
        },
        id === ctx.prefs.accent ? icon("check", "text-white text-sm") : null
      )
    );
    const follow = h("input", { class: "toggle toggle-sm toggle-primary", attrs: { type: "checkbox" }, data: { followToggle: "1" } });
    follow.checked = ctx.prefs.followSystem;
    const languages: Array<[Locale, string]> = [
      ["zh-CN", "简体中文"],
      ["en", "English"],
    ];
    mount(
      dialog,
      h(
        "div",
        { class: "modal-box sm:max-w-md p-6 space-y-6" },
        h(
          "div",
          { class: "flex items-start justify-between" },
          h("div", null, h("h3", { class: "text-lg font-bold serif" }, ctx.t("ap.title")), h("p", { class: "text-xs muted mt-0.5" }, ctx.t("ap.subtitle"))),
          h("form", { attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "section",
          null,
          h("h4", { class: "fs-label mb-3" }, ctx.t("ap.theme")),
          h("div", { class: "grid grid-cols-4 gap-3" }, ...themeCards),
          h(
            "label",
            { class: "mt-4 flex items-center justify-between gap-3 text-sm cursor-pointer" },
            h("span", null, ctx.t("ap.follow"), h("span", { class: "block text-xs muted" }, ctx.t("ap.follow_hint"))),
            follow
          )
        ),
        h(
          "section",
          null,
          h("div", { class: "flex items-baseline justify-between mb-3" }, h("h4", { class: "fs-label" }, ctx.t("ap.accent")), h("span", { class: "text-xs font-medium text-primary" }, ctx.t(ACCENT_LABELS[ctx.prefs.accent]))),
          h("div", { class: "flex flex-wrap gap-3" }, ...swatches)
        ),
        h(
          "section",
          null,
          h("h4", { class: "fs-label mb-3" }, ctx.t("ap.language")),
          h(
            "div",
            { class: "join w-full" },
            ...languages.map(([code, name]) =>
              h("button", { class: `btn btn-sm join-item flex-1 ${ctx.tr.locale === code ? "btn-primary" : "btn-ghost"}`, attrs: { type: "button" }, data: { localeOption: code } }, name)
            )
          )
        )
      ),
      h("form", { class: "modal-backdrop", attrs: { method: "dialog" } }, h("button", null, "close"))
    );
  };

  dialog.addEventListener("click", (event) => {
    const el = event.target instanceof Element ? event.target : null;
    const theme = el?.closest<HTMLElement>("[data-theme-option]")?.dataset["themeOption"];
    const accent = el?.closest<HTMLElement>("[data-accent-option]")?.dataset["accentOption"];
    const locale = el?.closest<HTMLElement>("[data-locale-option]")?.dataset["localeOption"];
    if (isThemeId(theme)) {
      ctx.prefs.theme = theme;
      ctx.prefs.followSystem = false;
      savePreference(ctx.storage, "theme", ctx.prefs.theme);
      savePreference(ctx.storage, "followSystem", false);
      apply(true);
      render();
    } else if (isAccentId(accent)) {
      ctx.prefs.accent = accent;
      savePreference(ctx.storage, "accent", ctx.prefs.accent);
      apply(true);
      render();
    } else if (locale === "zh-CN" || locale === "en") {
      void switchLocale(locale);
    }
  });
  dialog.addEventListener("change", (event) => {
    const el = event.target instanceof HTMLInputElement ? event.target : null;
    if (!el?.dataset["followToggle"]) return;
    ctx.prefs.followSystem = el.checked;
    if (!el.checked) ctx.prefs.theme = effectiveTheme({ theme: ctx.prefs.theme, followSystem: true }, darkQuery.matches);
    savePreference(ctx.storage, "followSystem", ctx.prefs.followSystem);
    savePreference(ctx.storage, "theme", ctx.prefs.theme);
    apply(true);
    render();
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });

  return {
    open: () => {
      render();
      dialog.showModal();
    },
  };
}
