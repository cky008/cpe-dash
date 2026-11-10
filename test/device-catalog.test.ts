import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { GENERIC_READS, KNOWN_ROUTERS, MODULES, baselineMark, supportMark, supportedDevicesSection } from "../src/device-catalog.ts";
import { DEVICE_FEATURES, EXPERIMENTAL_FEATURES } from "../src/device-profile.ts";
import { DEVICE_REPORT_TEMPLATE, ISSUE_NEW_URL } from "../src/feedback.ts";
import { VERIFIED_FIRMWARE, type VerifiedFeature } from "../src/firmware.ts";

/**
 * The "Supported devices" guide page: its legend and brand tables are the ones written from the device
 * list, in both languages, so the page cannot drift from the verified list or from what FengSui does on
 * a model nobody verified. Each module gets one mark per model; each other model links to a device
 * report for itself and nothing more; the page names no other project (the guide credits it once).
 */

const PAGES = [
  { file: "docs/guide/zh/supported-devices.md", locale: "zh-CN" },
  { file: "docs/guide/en/supported-devices.md", locale: "en" },
] as const;

/** The table rows (`| model | ... |`) of a section, header and separator left out. */
function rows(section: string): string[][] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| :---") && !/^\| (型号|Model) \|/.test(line))
    .map((line) => line.slice(2, -2).split(" | "));
}

/** A model's marks, one per module (the cells between its kind and its report link). */
function marksOf(section: string, model: string): string[] | undefined {
  return rows(section)
    .find((cells) => cells[0] === model)
    ?.slice(2, 2 + MODULES.length);
}

describe("the supported devices guide page", () => {
  it("carries the legend and brand tables written from the device list, in both languages, naming no other project", () => {
    for (const { file, locale } of PAGES) {
      const text = fs.readFileSync(file, "utf8");
      const block = /<!-- devices:begin -->\n([\s\S]*?)\n<!-- devices:end -->/.exec(text)?.[1];
      assert.equal(block, supportedDevicesSection(locale), `${file}: regenerate the tables from supportedDevicesSection("${locale}")`);
      assert.equal(/huawei-lte-api|Salamek/i.test(text), false, `${file}: the guide credits other projects on "Other Huawei models" only`);
    }
  });

  it("gives every feature of the console one column, and lists each router once under its brand", () => {
    assert.deepEqual(MODULES.flatMap((module) => module.features).sort(), [...DEVICE_FEATURES].sort(), "every feature in exactly one module");
    for (const module of MODULES) assert.equal(module.parts === undefined, module.features.length === 1, `${module.en}: a module of several features names them`);
    const models = KNOWN_ROUTERS.map((router) => router.model);
    assert.equal(new Set(models).size, models.length);
    for (const entry of VERIFIED_FIRMWARE) assert.ok(models.includes(entry.model), entry.model);
    const zh = supportedDevicesSection("zh-CN");
    const en = supportedDevicesSection("en");
    assert.deepEqual([...zh.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["华为", "SoyeaLink"]);
    assert.deepEqual([...en.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Huawei", "SoyeaLink"]);
    assert.deepEqual(rows(zh).map((cells) => cells[0]), models);
    assert.deepEqual(rows(en)[0], ["H168-383", "5G router", ...MODULES.map(() => "○"), "—"], "the verified model: everything verified, nothing to report");
  });

  it("marks what FengSui does on a model nobody verified: generic reads and experimental writes may work, other reads are unknown, other writes not supported", () => {
    assert.deepEqual(GENERIC_READS, ["telemetry", "topology", "smsRead"]);
    // The legend names the experimental writes: a new one belongs in its sentence
    assert.deepEqual([...EXPERIMENTAL_FEATURES], ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"]);
    for (const feature of [...GENERIC_READS, ...EXPERIMENTAL_FEATURES]) assert.equal(baselineMark(feature), "△", feature);
    assert.equal(baselineMark("neighbors"), "?");
    for (const feature of ["cellLock", "securitySwitches", "wifi", "antenna", "accessControl"] as const) assert.equal(baselineMark(feature), "×", feature);
    assert.deepEqual(marksOf(supportedDevicesSection("en"), "B535-232"), ["△", "?", "△", "△", "△", "×", "△", "△", "×", "×"]);
    const legend = supportedDevicesSection("zh-CN").split("\n## ")[0] ?? "";
    for (const mark of ["**○ 已验证**", "**△ 可能支持**", "**? 未知**", "**× 不支持**"]) assert.ok(legend.includes(mark), mark);
    assert.ok(legend.includes("「路由器开关」指安全开关、Wi-Fi 7 和天线"), legend);
    assert.equal(legend.includes("一格里有几个符号"), false, "no cell has two marks yet, so no word about them");
  });

  it("links every other model to a new device report titled with it, and to nothing else", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      for (const cells of rows(supportedDevicesSection(locale)).slice(1)) {
        const href = /\]\((https:[^)]+)\)$/.exec(cells.at(-1) ?? "")?.[1];
        assert.ok(href, `${cells[0]}: a report link`);
        const url = new URL(href);
        assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
        assert.deepEqual([...url.searchParams.keys()], ["template", "title"]);
        assert.deepEqual([url.searchParams.get("template"), url.searchParams.get("title")], [DEVICE_REPORT_TEMPLATE, `Device report: ${cells[0]}`]);
      }
    }
  });

  it("turns what users verified into ○, splits a module whose features now differ, and lists a model only users verified", () => {
    const verified: VerifiedFeature[] = [
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "bandLock", access: "write", issue: 12 },
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "telemetry", access: "read", issue: 12 },
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "smsWrite", access: "write", issue: 15 },
      // A read checked is not the write of the same feature
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "reboot", access: "read", issue: 16 },
      { model: "B999-001", softwareVersion: "1.0", feature: "reboot", access: "write", issue: 21 },
    ];
    assert.equal(supportMark("B535-232", "bandLock", verified), "○");
    assert.equal(supportMark("B535-232", "reboot", verified), "△");
    const zh = supportedDevicesSection("zh-CN", verified);
    assert.deepEqual(marksOf(zh, "B535-232"), ["○", "?", "△", "△/○", "○", "×", "△", "△", "×", "×"]);
    assert.ok(zh.includes("- 一格里有几个符号时，依次对应这一列包含的功能：「短信」是读取 / 发送与管理，「重启与重拨」是重启 / 重拨，「路由器开关」是安全开关 / Wi-Fi 7 / 天线。"), zh);
    const en = supportedDevicesSection("en", verified);
    assert.deepEqual(rows(en).find((cells) => cells[0] === "B999-001")?.slice(0, 2 + MODULES.length), ["B999-001", "—", "△", "?", "△", "△", "△", "×", "○/△", "△", "×", "×"]);
    assert.ok(en.includes("they follow the column's parts in order: SMS is reading / sending and managing; Reboot & redial is reboot / redial;"), en);
  });
});
