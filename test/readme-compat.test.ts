import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

/**
 * Multi-model phase 2.5: the READMEs and the "other routers" guide pages say FengSui is verified on the
 * H168-383 only. The per-model table lives on "Supported devices" alone (test/device-catalog.test.ts),
 * written from the verified list, so no page can drift from it.
 */

const DOCS = [
  {
    readme: "README.md",
    guide: "docs/guide/zh/other-routers.md",
    verified: "烽燧只在 H168-383（固件 4.4.0.1）上验证过",
    readOnly: "写操作默认锁定",
    credit: "感谢 [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
  },
  {
    readme: "README_EN.md",
    guide: "docs/guide/en/other-routers.md",
    verified: "FengSui is verified on the H168-383 (firmware 4.4.0.1) only",
    readOnly: "writes to them are locked by default",
    credit: "Thanks to [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)",
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

  it("claims the H168-383 only, says other models are read-only, and keeps the credit", () => {
    for (const { readme, guide, verified, readOnly, credit } of DOCS) {
      const front = fs.readFileSync(readme, "utf8");
      for (const phrase of [verified, readOnly, credit]) assert.ok(front.includes(phrase), `${readme}: ${phrase}`);
      const text = fs.readFileSync(guide, "utf8");
      for (const phrase of [verified, readOnly, credit, "DEVICE_UNVERIFIED_READ_ONLY", "DEMO_SCENARIO=unverified", "VERIFIED_FEATURES"]) assert.ok(text.includes(phrase), `${guide}: ${phrase}`);
    }
  });
});
