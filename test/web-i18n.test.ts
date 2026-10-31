import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
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
});
