import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { GENERIC_READS, INCOMPATIBLE_ROUTERS, KNOWN_ROUTERS, supportedDevicesSection } from "../src/device-catalog.ts";
import { EXPERIMENTAL_FEATURES } from "../src/device-profile.ts";
import { DEVICE_REPORT_TEMPLATE, ISSUE_NEW_URL } from "../src/feedback.ts";
import { VERIFIED_FIRMWARE, type VerifiedFeature } from "../src/firmware.ts";

/**
 * The "Supported devices" guide page: its brand tables are the ones written from the device list, in
 * both languages, so the page cannot drift from the verified list or from what FengSui offers on a
 * model nobody verified; each other model links to a device report for itself and nothing more.
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

describe("the supported devices guide page", () => {
  it("carries the brand tables written from the device list, in both languages", () => {
    for (const { file, locale } of PAGES) {
      const text = fs.readFileSync(file, "utf8");
      const block = /<!-- devices:begin -->\n([\s\S]*?)\n<!-- devices:end -->/.exec(text)?.[1];
      assert.equal(block, supportedDevicesSection(locale), `${file}: regenerate the tables from supportedDevicesSection("${locale}")`);
    }
  });

  it("lists each router once under its brand, the verified one first with its firmware", () => {
    const models = KNOWN_ROUTERS.map((router) => router.model);
    assert.equal(new Set(models).size, models.length);
    for (const entry of VERIFIED_FIRMWARE) assert.ok(models.includes(entry.model), entry.model);
    const zh = supportedDevicesSection("zh-CN");
    const en = supportedDevicesSection("en");
    assert.deepEqual([...zh.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["华为", "SoyeaLink"]);
    assert.deepEqual([...en.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ["Huawei", "SoyeaLink"]);
    assert.deepEqual(rows(zh).map((cells) => cells[0]), models);
    const [first] = rows(en);
    assert.deepEqual(first, ["H168-383", "5G router", "✅ everything (firmware 4.4.0.1)", "—", "—"]);
    for (const model of INCOMPATIBLE_ROUTERS) assert.ok(zh.includes(model) && en.includes(model) && !models.includes(model), model);
  });

  it("links every other model to a new device report titled with it, and to nothing else", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      for (const cells of rows(supportedDevicesSection(locale)).slice(1)) {
        const href = /\]\((https:[^)]+)\)$/.exec(cells[4] ?? "")?.[1];
        assert.ok(href, `${cells[0]}: a report link`);
        const url = new URL(href);
        assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
        assert.deepEqual([...url.searchParams.keys()], ["template", "title"]);
        assert.deepEqual([url.searchParams.get("template"), url.searchParams.get("title")], [DEVICE_REPORT_TEMPLATE, `Device report: ${cells[0]}`]);
      }
    }
  });

  it("offers on other models the generic reads and every experimental write, minus what users verified", () => {
    assert.deepEqual(GENERIC_READS, ["telemetry", "topology", "smsRead"]);
    const plain = rows(supportedDevicesSection("en")).find((cells) => cells[0] === "B535-232");
    assert.deepEqual(plain?.slice(1, 4), ["3G / LTE router", "—", "reads, experimental writes"]);
    // The legend spells the two groups out, from the same lists
    const legend = supportedDevicesSection("en").split("\n## ")[0] ?? "";
    assert.ok(legend.includes("**Reads** are signal and traffic, connected devices, reading SMS"), legend);
    assert.ok(legend.includes("**Experimental writes** are LTE band lock, reboot, redial, mobile data switch, sending and managing SMS"), legend);
    assert.ok(supportedDevicesSection("zh-CN").includes("**实验性写入**指锁 4G 频段、重启、重拨、移动数据开关、发送与管理短信"));

    const verified: VerifiedFeature[] = [
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "bandLock", access: "write", issue: 12 },
      { model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "telemetry", access: "read", issue: 12 },
      { model: "B999-001", softwareVersion: "1.0", feature: "reboot", access: "write", issue: 21 },
    ];
    const zh = rows(supportedDevicesSection("zh-CN", verified));
    assert.deepEqual(zh.find((cells) => cells[0] === "B535-232")?.slice(2, 4), [
      "✅ 锁 4G 频段（#12）、信号与流量（#12）",
      "读取：已连接设备、读取短信；实验性写入：重启、重拨、移动数据开关、发送与管理短信",
    ]);
    // A model only users verified, missing from the reference list, still gets its row (under Huawei, of no known kind)
    const extra = rows(supportedDevicesSection("en", verified)).find((cells) => cells[0] === "B999-001");
    assert.deepEqual(extra?.slice(1, 4), ["—", "✅ reboot (#21)", "reads; experimental writes: LTE band lock, redial, mobile data switch, sending and managing SMS"]);
    const readsOnly: VerifiedFeature[] = GENERIC_READS.map((feature) => ({ model: "E3131", softwareVersion: "21.1", feature, access: "read" as const, issue: 22 }));
    assert.equal(rows(supportedDevicesSection("zh-CN", readsOnly)).find((cells) => cells[0] === "E3131")?.[3], "实验性写入");
    const all: VerifiedFeature[] = [...GENERIC_READS.map((feature) => ({ feature, access: "read" as const })), ...EXPERIMENTAL_FEATURES.map((feature) => ({ feature, access: "write" as const }))].map(
      (entry) => ({ ...entry, model: "E3372", softwareVersion: "22.200", issue: 30 })
    );
    assert.equal(rows(supportedDevicesSection("en", all)).find((cells) => cells[0] === "E3372")?.[3], "—", "nothing left that may work but nobody checked");
  });
});
