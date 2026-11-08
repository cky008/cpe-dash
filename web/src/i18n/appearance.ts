import type { Locale } from "../core/i18n.ts";
import type { AccentId, ThemeFamily, ThemeId } from "../core/prefs.ts";

/**
 * Strings of the appearance dialog. They ship inside its lazy chunk (not the first-paint
 * dictionaries); the types force both languages to carry exactly the same keys.
 */
const zh = {
  title: "外观",
  subtitle: "{themes} 套主题 · {accents} 种强调色，也可以自己调",
  theme: "主题",
  mode_system: "跟随系统",
  mode_fixed: "固定主题",
  slot_day: "白天",
  slot_night: "夜间",
  hint_system: "系统为浅色时用白天主题，深色时用夜间主题。点下面的主题来设置{slot}主题。",
  hint_fixed: "不管系统明暗，始终使用选中的主题。",
  group_light: "浅色",
  group_dark: "深色",
  group_custom: "自己调",
  custom_title: "自定义主题",
  custom_scheme: "明暗",
  scheme_light: "浅色",
  scheme_dark: "深色",
  custom_background: "背景",
  custom_text: "文字",
  custom_primary: "主色",
  custom_reset: "恢复默认",
  custom_hint: "卡片、边框和次要文字会从这三种颜色自动调和。",
  contrast_low: "文字与背景的对比度只有 {ratio}:1，建议至少 4.5:1。",
  accent: "强调色",
  accent_hint: "强调色会替换主题自带的主色；选「随主题」就用回主题原色。",
  accent_pick: "选一个自己的强调色",
  language: "语言 / Language",
  help: "术语说明",
  help_toggle: "在专业名词旁显示 ?",
  help_hint: "鼠标移到 ? 上看一句话解释，点开看文档里的详细说明。熟悉之后可以关掉。",
  close: "关闭",
};

export type AppearanceTextKey = keyof typeof zh;

const en: Readonly<Record<AppearanceTextKey, string>> = {
  title: "Appearance",
  subtitle: "{themes} themes · {accents} accents, or your own",
  theme: "Theme",
  mode_system: "Follow system",
  mode_fixed: "Fixed",
  slot_day: "Day",
  slot_night: "Night",
  hint_system: "The day theme shows while the system is light, the night theme while it is dark. Pick a theme below to set the {slot} one.",
  hint_fixed: "Always use the chosen theme, whatever the system setting.",
  group_light: "Light",
  group_dark: "Dark",
  group_custom: "Your own",
  custom_title: "Custom theme",
  custom_scheme: "Side",
  scheme_light: "Light",
  scheme_dark: "Dark",
  custom_background: "Background",
  custom_text: "Text",
  custom_primary: "Primary",
  custom_reset: "Reset",
  custom_hint: "Cards, borders and secondary text are mixed from these three colours.",
  contrast_low: "Text on this background is only {ratio}:1; aim for at least 4.5:1.",
  accent: "Accent",
  accent_hint: "An accent replaces the theme's own primary colour; choose “Theme” to go back to it.",
  accent_pick: "Pick your own accent",
  language: "Language / 语言",
  help: "Term help",
  help_toggle: "Show ? next to technical terms",
  help_hint: "Hover over a ? for a one-line explanation; click it for the full guide. Turn it off once you know the terms.",
  close: "Close",
};

export const APPEARANCE_TEXT: Readonly<Record<Locale, Readonly<Record<AppearanceTextKey, string>>>> = { "zh-CN": zh, en };

export const THEME_NAMES: Readonly<Record<Locale, Readonly<Record<ThemeId, string>>>> = {
  "zh-CN": {
    "fengsui-sujian": "素笺",
    "fengsui-yuebai": "月白",
    "fengsui-tianqing": "天青",
    "fengsui-sakura": "樱",
    "fengsui-wakatake": "若竹",
    "fengsui-suzhi": "素纸",
    "fengsui-chenxi": "晨曦",
    "fengsui-sujian-ye": "素笺·夜",
    "fengsui-sumi": "墨",
    "fengsui-dailan": "黛蓝",
    "fengsui-konruri": "绀琉璃",
    "fengsui-yozakura": "夜樱",
    "fengsui-jiye": "极夜",
    "fengsui-ziming": "紫溟",
    "fengsui-custom": "自定义",
  },
  en: {
    "fengsui-sujian": "Sujian",
    "fengsui-yuebai": "Moon White",
    "fengsui-tianqing": "Celadon",
    "fengsui-sakura": "Sakura",
    "fengsui-wakatake": "Wakatake",
    "fengsui-suzhi": "Paper",
    "fengsui-chenxi": "Dawn",
    "fengsui-sujian-ye": "Sujian Night",
    "fengsui-sumi": "Sumi",
    "fengsui-dailan": "Indigo Ink",
    "fengsui-konruri": "Konruri",
    "fengsui-yozakura": "Yozakura",
    "fengsui-jiye": "Polar Night",
    "fengsui-ziming": "Violet Abyss",
    "fengsui-custom": "Custom",
  },
};

export const FAMILY_NAMES: Readonly<Record<Locale, Readonly<Record<ThemeFamily, string>>>> = {
  "zh-CN": { classic: "cpe-sms 原版", china: "中国传统色", japan: "日本传统色", fengsui: "烽燧", custom: "你的配色" },
  en: { classic: "from cpe-sms", china: "Chinese colours", japan: "Japanese colours", fengsui: "FengSui", custom: "Your colours" },
};

export const ACCENT_NAMES: Readonly<Record<Locale, Readonly<Record<AccentId, string>>>> = {
  "zh-CN": {
    default: "随主题",
    sky: "湖蓝",
    cinnabar: "朱砂",
    sakura: "樱",
    amber: "琥珀",
    jade: "松石",
    asagi: "浅葱",
    indigo: "群青",
    violet: "紫藤",
    graphite: "石墨",
    custom: "自定义",
  },
  en: {
    default: "Theme",
    sky: "Lake",
    cinnabar: "Cinnabar",
    sakura: "Sakura",
    amber: "Amber",
    jade: "Jade",
    asagi: "Asagi",
    indigo: "Ultramarine",
    violet: "Wisteria",
    graphite: "Graphite",
    custom: "Custom",
  },
};
