/**
 * Zero-dependency locale manager for the dashboard. Dictionaries are typed TS objects, so a key
 * missing from either language fails `npm run typecheck`; switching locale notifies listeners and
 * never reloads the page.
 */

export type Locale = "zh-CN" | "en";

export const LOCALES: ReadonlyArray<Locale> = ["zh-CN", "en"];

export type MessageParams = Readonly<Record<string, string | number>>;

export function isLocale(value: unknown): value is Locale {
  return value === "zh-CN" || value === "en";
}

/**
 * Linear `{name}` substitution without regular expressions (no backtracking on long templates).
 * Unknown placeholders stay literal so a missing parameter is visible instead of silently empty.
 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  let out = "";
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf("{", cursor);
    if (open < 0) break;
    const close = template.indexOf("}", open + 1);
    if (close < 0) break;
    const name = template.slice(open + 1, close);
    out += template.slice(cursor, open);
    out += Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`;
    cursor = close + 1;
  }
  return out + template.slice(cursor);
}

/** A saved choice wins; otherwise any Chinese browser language picks zh-CN, everything else English. */
export function detectLocale(saved: string | null, browserLanguages: ReadonlyArray<string>): Locale {
  if (isLocale(saved)) return saved;
  for (const lang of browserLanguages) {
    const lower = lang.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

/**
 * Dictionaries load per locale (the dashboard fetches the inactive language only when switching),
 * so `setLocale` accepts only a locale whose dictionary was added.
 */
export class Translator<K extends string> {
  readonly #dicts = new Map<Locale, Readonly<Record<K, string>>>();
  readonly #listeners = new Set<(locale: Locale) => void>();
  #locale: Locale;

  constructor(locale: Locale, dict: Readonly<Record<K, string>>) {
    this.#dicts.set(locale, dict);
    this.#locale = locale;
  }

  get locale(): Locale {
    return this.#locale;
  }

  has(locale: Locale): boolean {
    return this.#dicts.has(locale);
  }

  add(locale: Locale, dict: Readonly<Record<K, string>>): void {
    this.#dicts.set(locale, dict);
  }

  t(key: K, params?: MessageParams): string {
    // A key read from markup (`data-i18n`) may be unknown at runtime: show it rather than throw
    const template: string | undefined = this.#dicts.get(this.#locale)?.[key];
    return interpolate(template ?? key, params);
  }

  /** Pick the payload field for the current locale (the daemon sends `messageZh` / `messageEn` pairs). */
  pick(zh: string, en: string): string {
    return this.#locale === "zh-CN" ? zh || en : en || zh;
  }

  /** Returns `true` when the locale changed (listeners run only then); unknown dictionaries are refused. */
  setLocale(locale: Locale): boolean {
    if (locale === this.#locale || !this.#dicts.has(locale)) return false;
    this.#locale = locale;
    for (const listener of [...this.#listeners]) listener(locale);
    return true;
  }

  onChange(listener: (locale: Locale) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
