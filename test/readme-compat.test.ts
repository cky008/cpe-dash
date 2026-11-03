import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { VERIFIED_FIRMWARE, compatibilityTable } from "../src/firmware.ts";

/**
 * Multi-model phase 2.5: both READMEs say FengSui is verified on the H168-383 only, and their
 * compatibility tables are the one written from the verified list, so they cannot drift from it.
 */

const READMES = [
  { file: "README.md", locale: "zh-CN", verified: "烽燧只在 H168-383（固件 4.4.0.1）上验证过", readOnly: "写操作全部锁定", credit: "感谢 [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)" },
  { file: "README_EN.md", locale: "en", verified: "FengSui is verified on the H168-383 (firmware 4.4.0.1) only", readOnly: "every write to them is locked", credit: "Thanks to [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)" },
] as const;

describe("README compatibility section", () => {
  it("carries the table written from the verified list, in both languages", () => {
    for (const { file, locale } of READMES) {
      const text = fs.readFileSync(file, "utf8");
      const block = /<!-- compat:begin -->\n([\s\S]*?)\n<!-- compat:end -->/.exec(text)?.[1];
      assert.equal(block, compatibilityTable(locale), `${file}: regenerate the table from compatibilityTable("${locale}")`);
      for (const entry of VERIFIED_FIRMWARE) assert.ok(block.includes(entry.model) && block.includes(entry.softwareVersion), `${file}: ${entry.model}`);
    }
  });

  it("claims the H168-383 only, says other models are read-only, and keeps the credit", () => {
    for (const { file, verified, readOnly, credit } of READMES) {
      const text = fs.readFileSync(file, "utf8");
      for (const phrase of [verified, readOnly, credit, "DEVICE_UNVERIFIED_READ_ONLY", "DEMO_SCENARIO=unverified", "VERIFIED_FEATURES"]) assert.ok(text.includes(phrase), `${file}: ${phrase}`);
    }
  });
});
