import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { VERIFIED_FIRMWARE, compatibilityTable } from "../src/firmware.ts";

/**
 * Multi-model phase 2.5: the READMEs and the "other routers" guide pages say FengSui is verified on the
 * H168-383 only, and the guide's compatibility tables are the one written from the verified list, so
 * they cannot drift from it.
 */

const DOCS = [
  {
    readme: "README.md",
    guide: "docs/guide/zh/other-routers.md",
    locale: "zh-CN",
    verified: "烽燧只在 H168-383（固件 4.4.0.1）上验证过",
    readOnly: "写操作默认锁定",
    credit: "感谢 [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
  },
  {
    readme: "README_EN.md",
    guide: "docs/guide/en/other-routers.md",
    locale: "en",
    verified: "FengSui is verified on the H168-383 (firmware 4.4.0.1) only",
    readOnly: "writes to them are locked by default",
    credit: "Thanks to [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
  },
] as const;

describe("compatibility claims in the READMEs and the guide", () => {
  it("carries the table written from the verified list in the guide, in both languages", () => {
    for (const { guide, locale } of DOCS) {
      const text = fs.readFileSync(guide, "utf8");
      const block = /<!-- compat:begin -->\n([\s\S]*?)\n<!-- compat:end -->/.exec(text)?.[1];
      assert.equal(block, compatibilityTable(locale), `${guide}: regenerate the table from compatibilityTable("${locale}")`);
      for (const entry of VERIFIED_FIRMWARE) assert.ok(block.includes(entry.model) && block.includes(entry.softwareVersion), `${guide}: ${entry.model}`);
    }
  });

  it("claims the H168-383 only, says other models are read-only, and keeps the credit", () => {
    for (const { readme, guide, verified, readOnly, credit } of DOCS) {
      const front = fs.readFileSync(readme, "utf8");
      for (const phrase of [verified, readOnly, credit]) assert.ok(front.includes(phrase), `${readme}: ${phrase}`);
      const text = fs.readFileSync(guide, "utf8");
      for (const phrase of [verified, readOnly, credit, "DEVICE_UNVERIFIED_READ_ONLY", "DEMO_SCENARIO=unverified", "VERIFIED_FEATURES"]) assert.ok(text.includes(phrase), `${guide}: ${phrase}`);
    }
  });
});
