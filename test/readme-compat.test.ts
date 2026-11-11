import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

/**
 * The READMEs and the "other routers" guide pages say FengSui is verified on the H168-383 only so
 * far, and that on other routers the writes it implements are on by default and can be turned off
 * (never that those routers are read-only). The per-model table lives on "Supported devices" alone
 * (test/device-catalog.test.ts), written from the verified list, so no page can drift from it.
 */

const DOCS = [
  {
    readme: "README.md",
    guide: "docs/guide/zh/other-routers.md",
    verified: "烽燧目前仅在 H168-383（固件 4.4.0.1）上验证过",
    writes: "它们默认开着，你可以",
    gone: /写操作默认锁定|只以只读方式工作|逐项打开实验性写入|输入路由器型号/,
    credit: "感谢 [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
    credits: "docs/guide/zh/acknowledgments.md",
    dir: "zh",
    site: "https://fengsui.iocky.com/",
  },
  {
    readme: "README_EN.md",
    guide: "docs/guide/en/other-routers.md",
    verified: "So far FengSui is verified on the H168-383 (firmware 4.4.0.1) only",
    writes: "they are on by default, and you can turn each one off",
    gone: /locked by default|run read-only|What read-only means|type the router model/i,
    credit: "Thanks to [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
    credits: "docs/guide/en/acknowledgments.md",
    dir: "en",
    site: "https://fengsui.iocky.com/en/",
  },
] as const;

describe("compatibility claims in the READMEs and the guide", () => {
  it("leaves the per-model table to Supported devices: the guide's other routers page links to it and lists no models", () => {
    for (const { guide } of DOCS) {
      const text = fs.readFileSync(guide, "utf8");
      assert.ok(text.includes("(supported-devices.md)"), `${guide}: links to Supported devices`);
      assert.equal(/<!-- (compat|devices):begin -->/.test(text), false, `${guide}: no table of its own`);
    }
  });

  it("claims the H168-383 only, says the writes FengSui implements are on by default elsewhere, and keeps the credit", () => {
    for (const { readme, guide, verified, writes, gone, credit, credits, site } of DOCS) {
      const front = fs.readFileSync(readme, "utf8");
      for (const phrase of [verified, writes, `(${site}docs/acknowledgments/)`]) assert.ok(front.includes(phrase), `${readme}: ${phrase}`);
      assert.equal(gone.test(front), false, `${readme}: no longer says other routers are read-only`);
      // Every credit is on the acknowledgments page, and nowhere else: the README and the other routers page link to it
      assert.ok(fs.readFileSync(credits, "utf8").includes(credit), `${credits}: ${credit}`);
      for (const file of [readme, guide]) assert.equal(/(感谢|Thanks to) \[[^\]]+\]\(https?:/.test(fs.readFileSync(file, "utf8")), false, `${file}: credits belong on the acknowledgments page`);
      const text = fs.readFileSync(guide, "utf8");
      assert.ok(text.includes("(acknowledgments.md)"), `${guide}: links to the acknowledgments page`);
      for (const phrase of [verified, writes, "DEVICE_UNVERIFIED_READ_ONLY", "DEVICE_WRITE_DISABLED", "WRITE_READBACK_MISMATCH", "DEMO_SCENARIO=unverified", "VERIFIED_FEATURES"]) {
        assert.ok(text.includes(phrase), `${guide}: ${phrase}`);
      }
      assert.equal(gone.test(text), false, `${guide}: no longer says other routers are read-only`);
      // Where to turn a write off, and what protects a lock, have anchors other pages can link to
      for (const anchor of ["writes", "safeguards", "turn-off", "report", "ai", "brand"]) assert.ok(text.includes(`<a id="${anchor}"></a>`), `${guide}: #${anchor}`);
    }
  });

  it("sends readers to the documentation site, naming every guide page there, and to docs/dev for the developer notes", () => {
    for (const { readme, dir, site } of DOCS) {
      const front = fs.readFileSync(readme, "utf8");
      const slugs = fs.readdirSync(`docs/guide/${dir}`).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
      assert.ok(slugs.length >= 20, `${dir}: found ${slugs.length} pages`);
      const missing = slugs.filter((slug) => !front.includes(`(${site}docs/${slug}/)`));
      assert.deepEqual(missing, [], `${readme}: link these pages on the documentation site`);
      assert.doesNotMatch(front, /\]\(docs\/guide\//, `${readme}: the guide is read on the documentation site, not as Markdown sources`);
      for (const note of ["docs/dev/README.md", "docs/dev/protocol.md", "docs/dev/architecture.md", "docs/dev/audits.md", "docs/dev/sources.md", "docs/dev/api.md", "docs/dev/device-notes.md", "docs/dev/brand.md"]) {
        assert.ok(front.includes(`](${note})`), `${readme}: ${note}`);
        assert.ok(fs.existsSync(note), note);
      }
    }
  });
});
