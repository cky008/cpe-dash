import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { Translator, detectLocale, interpolate, isLocale } from "../web/src/core/i18n.ts";
import { en } from "../web/src/i18n/en.ts";
import { zhCN } from "../web/src/i18n/zh-CN.ts";

describe("web core: i18n", () => {
  it("interpolates linearly and leaves unknown placeholders visible", () => {
    assert.equal(interpolate("{a} + {b} = {c}", { a: 1, b: "2" }), "1 + 2 = {c}");
    assert.equal(interpolate("no params"), "no params");
    assert.equal(interpolate("open {never", { never: 1 }), "open {never");
    assert.equal(interpolate("{x}{x}", { x: "y" }), "yy");
    assert.equal(interpolate("{__proto__}", { a: 1 }), "{__proto__}");
  });

  it("detects the locale from a saved choice, then the browser languages", () => {
    assert.equal(detectLocale("en", ["zh-CN"]), "en");
    assert.equal(detectLocale(null, ["zh-TW", "en"]), "zh-CN");
    assert.equal(detectLocale("fr", ["en-GB"]), "en");
    assert.equal(detectLocale(null, ["de-DE"]), "en");
    assert.equal(isLocale("zh-CN"), true);
    assert.equal(isLocale("zh"), false);
  });

  it("translates, picks bilingual payload fields and notifies only on real changes", () => {
    const tr = new Translator<"hi">("zh-CN", { hi: "你好 {name}" });
    assert.equal(tr.t("hi", { name: "烽燧" }), "你好 烽燧");
    assert.equal(tr.pick("中文", "English"), "中文");
    assert.equal(tr.pick("", "English"), "English");
    const seen: string[] = [];
    const off = tr.onChange((l) => seen.push(l));
    assert.equal(tr.setLocale("zh-CN"), false);
    assert.equal(tr.setLocale("en"), false, "no English dictionary yet");
    assert.equal(tr.has("en"), false);
    tr.add("en", { hi: "Hi {name}" });
    assert.equal(tr.setLocale("en"), true);
    assert.equal(tr.t("hi", { name: "FengSui" }), "Hi FengSui");
    assert.equal(tr.pick("中文", ""), "中文");
    off();
    tr.setLocale("zh-CN");
    assert.deepEqual(seen, ["en"]);
    assert.equal(tr.locale, "zh-CN");
  });
});

describe("web core: dictionaries", () => {
  it("defines the same non-empty keys in both languages with the same placeholders", () => {
    const zhKeys = Object.keys(zhCN).sort();
    assert.deepEqual(Object.keys(en).sort(), zhKeys);
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    for (const key of zhKeys) {
      const zh = zhCN[key as keyof typeof zhCN];
      const english = en[key as keyof typeof zhCN];
      assert.ok(zh.trim() && english.trim(), `empty translation for ${key}`);
      assert.deepEqual(placeholders(english), placeholders(zh), `placeholder mismatch in ${key}`);
    }
  });

  it("keeps the dictionaries free of markup (they are rendered as text nodes)", () => {
    for (const file of ["web/src/i18n/zh-CN.ts", "web/src/i18n/en.ts"]) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), /<\/?[a-z][a-z0-9]*[\s>]/i, file);
    }
  });

  it("keeps no entry the code never shows, in the console's dictionaries or the daemon's", () => {
    const sources = (dir: string): string[] =>
      fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => path.join(dir, f));
    const code = [...sources("web/src"), ...sources("src"), ...sources("scripts")]
      .filter((file) => !file.startsWith(path.join("web", "src", "i18n")))
      .map((file) => fs.readFileSync(file, "utf8"))
      .concat(fs.readFileSync("web/index.html", "utf8"))
      .join("\n");
    // A key built at run time (`fail_${reason}`, `alerts.${severity}`) counts by the prefix it is built from
    const built = [...code.matchAll(/[`"']([A-Za-z0-9_.]{2,}[._])\$\{/g)].map((m) => m[1] ?? "");
    const named = (key: string): boolean => code.includes(`"${key}"`) || code.includes(`'${key}'`) || code.includes(`\`${key}\``) || built.some((prefix) => key.startsWith(prefix));
    const consoleKeys = fs
      .readdirSync("web/src/i18n")
      .flatMap((file) => [...fs.readFileSync(path.join("web/src/i18n", file), "utf8").matchAll(/^ {2}"?([A-Za-z0-9_.]+)"?: [`"']/gm)].map((m) => `${file}: ${m[1] ?? ""}`));
    const flat = (node: unknown, prefix = ""): string[] =>
      typeof node === "object" && node !== null ? Object.entries(node).flatMap(([key, value]) => flat(value, `${prefix}${key}.`)) : [prefix.slice(0, -1)];
    const daemonKeys = flat(JSON.parse(fs.readFileSync("locales/en.json", "utf8"))).map((key) => `locales/en.json: ${key}`);
    assert.ok(consoleKeys.length > 1000 && daemonKeys.length > 100, "the dictionaries were read");
    assert.deepEqual([...consoleKeys, ...daemonKeys].filter((entry) => !named(entry.slice(entry.indexOf(": ") + 2))), []);
  });
});
