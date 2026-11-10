import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { GENERIC_READS, KNOWN_ROUTERS, MODULES, UNSUPPORTED_FEATURES, type UnsupportedFeature, baselineMark, brandMark, otherBrandsSection, supportMark, supportedDevicesSection } from "../src/device-catalog.ts";
import { DRIVER_FAMILIES, ROUTER_FAMILY_FACTS, ROUTER_FAMILY_LABELS } from "../src/router-family.ts";
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
      assert.equal(/huawei-lte-api|Salamek/i.test(text), false, `${file}: the guide credits other projects on "Other models and brands" only`);
    }
  });

  it("lists the other brands from what each driver implements, one row per brand, in both languages", () => {
    for (const [file, locale] of [
      ["docs/guide/zh/supported-devices.md", "zh-CN"],
      ["docs/guide/en/supported-devices.md", "en"],
    ] as const) {
      const text = fs.readFileSync(file, "utf8");
      const block = /<!-- brands:begin -->\n([\s\S]*?)\n<!-- brands:end -->/.exec(text)?.[1];
      assert.equal(block, otherBrandsSection(locale), `${file}: regenerate the brand table from otherBrandsSection("${locale}")`);
      assert.ok(text.includes('<a id="brands"></a>'), `${file}: the anchor other pages link to`);
    }
    const table = otherBrandsSection("en").split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Brand") && !line.startsWith("| :"));
    assert.equal(table.length, DRIVER_FAMILIES.length, "one row per brand with a driver");
    for (const family of DRIVER_FAMILIES) {
      const row = table.find((line) => line.startsWith(`| ${ROUTER_FAMILY_LABELS[family].en} |`));
      assert.ok(row, family);
      assert.ok(row.includes(`\`${ROUTER_FAMILY_FACTS[family].defaultAddress}\``), `${family}: its usual address`);
      assert.ok(row.endsWith(`[Report](https://github.com/cky008/cpe-dash/issues/new?template=device-report.yml&title=Device+report%3A+${family}) |`), `${family}: a report titled with the brand`);
      // What the driver implements may work; what FengSui has nothing for on the brand is unknown; nothing is ruled out
      assert.equal(brandMark(family, "telemetry"), "△");
      assert.equal(brandMark(family, "neighbors"), ROUTER_FAMILY_FACTS[family].reads.includes("neighbors") ? "△" : "?");
      for (const feature of ["bandLock", "cellLock", "reboot"] as const) assert.equal(brandMark(family, feature), "△", `${family} ${feature}`);
      for (const feature of ["topology", "smsRead", "smsWrite", "reconnect", "mobileData", "securitySwitches", "wifi", "antenna", "accessControl"] as const) assert.equal(brandMark(family, feature), "?", `${family} ${feature}`);
      assert.ok(!row.includes("×") && !row.includes("○"), `${family}: neither verified nor ruled out`);
    }
    assert.match(otherBrandsSection("zh-CN"), /「重启与重拨」是重启 \/ 重拨/);
    assert.equal(/huawei-lte-api|Salamek/i.test(otherBrandsSection("en") + otherBrandsSection("zh-CN")), false);
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

  it("marks a model nobody verified from the protocol: what it has and FengSui implements may work, what only the H168-383 is known for is unknown", () => {
    assert.deepEqual(GENERIC_READS, ["telemetry", "topology", "smsRead"]);
    // The legend names the experimental writes: a new one belongs in its sentence
    assert.deepEqual([...EXPERIMENTAL_FEATURES], ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"]);
    for (const feature of [...GENERIC_READS, ...EXPERIMENTAL_FEATURES, "securitySwitches", "wifi", "antenna", "accessControl"] as const) assert.equal(baselineMark(feature), "△", feature);
    for (const feature of ["neighbors", "cellLock"] as const) assert.equal(baselineMark(feature), "?", feature);
    assert.deepEqual(UNSUPPORTED_FEATURES, [], "nothing reported as not working yet");
    assert.deepEqual(marksOf(supportedDevicesSection("en"), "B535-232"), ["△", "?", "△", "△", "△", "?", "△", "△", "△", "△"]);
    const legend = supportedDevicesSection("zh-CN").split("\n## ")[0] ?? "";
    for (const mark of ["**○ 已验证**", "**△ 可能支持**", "**? 未知**", "**× 不支持**"]) assert.ok(legend.includes(mark), mark);
    assert.ok(legend.includes("协议里没有这项功能，或者有人在这个型号上实测过不能用（表里暂时还没有）"), legend);
    assert.ok(legend.includes("路由器开关和访问控制的改动，烽燧目前只在验证过的型号上开放"), "△ says what an owner can do today");
    assert.ok(legend.includes("「路由器开关」指安全开关、Wi-Fi 7 和天线"), legend);
    assert.equal(legend.includes("一格里有几个符号"), false, "no cell has two marks yet, so no word about them");
  });

  it("marks × only from a report, and lists a model only reported as not working", () => {
    const failed: UnsupportedFeature[] = [
      { model: "B535-232", feature: "accessControl", issue: 31 },
      { model: "B999-002", feature: "antenna", issue: 32 },
    ];
    assert.equal(supportMark("B535-232", "accessControl", [], failed), "×");
    assert.equal(supportMark(" B535-232 ", "accessControl", [], failed), "×", "surrounding spaces aside");
    assert.equal(supportMark("H168-383", "accessControl", [], [{ model: "H168-383", feature: "accessControl", issue: 1 }]), "○", "a verified model stays verified");
    const en = supportedDevicesSection("en", [], failed);
    assert.deepEqual(marksOf(en, "B535-232")?.slice(-1), ["×"]);
    assert.deepEqual(rows(en).find((cells) => cells[0] === "B999-002")?.slice(0, 2), ["B999-002", "—"]);
    assert.ok(marksOf(en, "B999-002")?.includes("△/△/×"), "router switches: the antenna reported failing");
    assert.equal(en.includes("(none in the table yet)"), false);
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
    assert.deepEqual(marksOf(zh, "B535-232"), ["○", "?", "△", "△/○", "○", "?", "△", "△", "△", "△"]);
    assert.ok(zh.includes("- 一格里有几个符号时，依次对应这一列包含的功能：「短信」是读取 / 发送与管理，「重启与重拨」是重启 / 重拨，「路由器开关」是安全开关 / Wi-Fi 7 / 天线。"), zh);
    const en = supportedDevicesSection("en", verified);
    assert.deepEqual(rows(en).find((cells) => cells[0] === "B999-001")?.slice(0, 2 + MODULES.length), ["B999-001", "—", "△", "?", "△", "△", "△", "?", "○/△", "△", "△", "△"]);
    assert.ok(en.includes("they follow the column's parts in order: SMS is reading / sending and managing; Reboot & redial is reboot / redial;"), en);
  });
});
