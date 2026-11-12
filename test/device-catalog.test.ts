import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import {
  CATALOG_SECTIONS,
  DEVICE_CATALOG,
  MODEL_FACTS,
  MODULES,
  UNSUPPORTED_FEATURES,
  type UnsupportedFeature,
  ZTE_DEVELOPER_OPTION_MODELS,
  catalogMatches,
  deviceSupportRow,
  displayName,
  familyImplements,
  findCatalogModel,
  primaryFamily,
  supportMark,
  supportedDevicesSection,
} from "../src/device-catalog.ts";
import { DEVICE_FEATURES } from "../src/device-profile.ts";
import { zteBranch } from "../src/drivers/zte-goform.ts";
import { DEVICE_REPORT_TEMPLATE, ISSUE_NEW_URL } from "../src/feedback.ts";
import { VERIFIED_FIRMWARE, type VerifiedFeature } from "../src/firmware.ts";
import { DETECTION_ORDER, DRIVER_FAMILIES, type DriverFamily, ROUTER_FAMILY_FACTS, STATUS_READ_FEATURES, type StatusReadFeature, isCellularWriteFeature, isRouterFamily } from "../src/router-family.ts";

/**
 * The "Supported devices" guide page: one row per model the interface notes record, by brand, each
 * console module marked from what FengSui implements for the model's interface, what is particular to
 * the model and what someone verified on a real router. The page is the generated text in both
 * languages; each model links to a device report for itself and nothing more; the page names no other
 * project (the guide credits it once).
 */

/**
 * The columns up to Battery: the features FengSui had before the cellular settings. The ones after it
 * (SIM card, airplane mode, network mode and operator, data settings, USSD) are asserted per brand below.
 */
const LEGACY = 11;

/** The driver families whose SMS interface is on record, and implemented. */
const SMS_FAMILIES: ReadonlyArray<string> = ["zte-goform", "zte-zwrt", "openwrt", "tozed", "fiberhome"];
/** What each brand's driver writes today (its own form of the interface). */
const DRIVER_WRITES: Readonly<Record<DriverFamily, ReadonlyArray<string>>> = {
  "zte-goform": ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "operatorSelect", "simSlot", "simPin", "roaming", "apn", "dataLimit", "ussd"],
  "zte-zwrt": ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "operatorSelect", "simSlot", "simPin", "roaming", "apn", "dataLimit"],
  pinsu: ["bandLock", "cellLock", "reboot", "networkMode"],
  tozed: ["bandLock", "cellLock", "reboot", "smsWrite", "networkMode"],
  fiberhome: ["bandLock", "cellLock", "reboot", "smsWrite", "networkMode", "airplaneSwitch"],
  nradio: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "antenna", "networkMode"],
  openwrt: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "airplaneSwitch", "simPin", "apn"],
};

const PAGES = [
  { file: "docs/guide/zh/supported-devices.md", locale: "zh-CN" },
  { file: "docs/guide/en/supported-devices.md", locale: "en" },
] as const;

/** A section's rows (`| model | form | … |`), header and separator left out, cells trimmed. */
function rows(text: string, section?: string): string[][] {
  const scope = section ? (text.split(`<a id="brand-${section}"></a>`)[1]?.split('<a id="brand-')[0] ?? "") : text;
  return scope
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| :---") && !/^\| (型号|Model) \|/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
}

/** A model's marks, one per module (the columns after model, form and, where shown, interface). */
function marksOf(text: string, section: string, model: string): string[] | undefined {
  const row = rows(text, section).find((cells) => cells[0] === model);
  return row?.slice(row.length - 1 - MODULES.length, row.length - 1);
}

const sameName = (name: string): string => name.toUpperCase().replace(/\s+/g, " ").trim();

/**
 * The model names in docs/dev/device-notes.md's tables: the bold name of each row, brackets (descriptions,
 * marketing names) and code spans aside, split at " / ", each model code with the word that names a variant.
 */
function referenceModels(): string[] {
  const names: string[] = [];
  for (const line of fs.readFileSync("docs/dev/device-notes.md", "utf8").split("\n")) {
    const bold = /^\| \*\*(.+?)\*\*/.exec(line)?.[1];
    if (!bold) continue;
    for (const piece of bold.replace(/`/g, "").replace(/\([^)]*\)/g, " ").split(" / ")) {
      for (const m of piece.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9.+-]*\d[A-Za-z0-9.+-]*)(\s(?:Pro|Max|Ultra|Air|Plus))?/g)) names.push(`${m[1]}${m[2] ?? ""}`);
    }
  }
  return names;
}

describe("the supported devices guide page", () => {
  it("is the text written from the catalog, in both languages, naming no other project", () => {
    for (const { file, locale } of PAGES) {
      const text = fs.readFileSync(file, "utf8");
      const block = /<!-- devices:begin -->\n([\s\S]*?)\n<!-- devices:end -->/.exec(text)?.[1];
      assert.equal(block, supportedDevicesSection(locale), `${file}: regenerate the tables from supportedDevicesSection("${locale}")`);
      assert.equal(/huawei-lte-api|Salamek/i.test(text), false, `${file}: the guide credits other projects on the acknowledgments page only`);
      assert.equal(text.includes("<!-- brands:begin -->"), false, `${file}: one table per brand section, not one row per brand`);
      assert.ok(text.includes('<a id="brands"></a>'), `${file}: the anchor other pages link to`);
      for (const section of CATALOG_SECTIONS) assert.ok(text.includes(`<a id="brand-${section.id}"></a>`), `${file}: the console links to brand-${section.id}`);
      assert.doesNotMatch(text, /[○×]/, `${file}: the old marks are gone`);
    }
  });

  it("lists every model docs/dev/device-notes.md names, each once, under a known section and interface", () => {
    const missing = referenceModels().filter((name) => !DEVICE_CATALOG.some((entry) => [entry.model, displayName(entry), entry.code ?? "", ...(entry.aliases ?? [])].some((known) => sameName(known) === sameName(name) || sameName(known).endsWith(` ${sameName(name)}`))));
    assert.deepEqual(missing, [], "add these to DEVICE_CATALOG");
    assert.ok(referenceModels().length > 150, "the reference's tables were read");
    const shown = DEVICE_CATALOG.map(displayName);
    assert.equal(new Set(shown).size, shown.length, "every model once");
    const sections = new Set(CATALOG_SECTIONS.map((section) => section.id));
    for (const entry of DEVICE_CATALOG) {
      assert.ok(sections.has(entry.section), displayName(entry));
      assert.ok(entry.families.every(isRouterFamily), displayName(entry));
      // What a report title, the console and the issue form may carry
      assert.match(displayName(entry), /^[A-Za-z0-9 ._()+-]{1,64}$/, displayName(entry));
    }
    for (const section of CATALOG_SECTIONS) assert.ok(DEVICE_CATALOG.some((entry) => entry.section === section.id), `${section.id}: has models`);
    for (const entry of VERIFIED_FIRMWARE) assert.ok(DEVICE_CATALOG.some((e) => catalogMatches(e, entry.model)), entry.model);
    // D-Link and TP-Link: listed for reports, nothing implemented yet
    for (const entry of DEVICE_CATALOG.filter((e) => e.section === "dlink" || e.section === "tplink")) assert.deepEqual(entry.families, [], displayName(entry));
  });

  it("gives every feature of the console one column", () => {
    assert.deepEqual(MODULES.flatMap((module) => module.features).sort(), [...DEVICE_FEATURES].sort(), "every feature in exactly one module");
    for (const module of MODULES) assert.equal(module.parts === undefined, module.features.length === 1, `${module.en}: a module of several features names them`);
  });

  it("marks the verified model ✓ throughout, and another HiLink model from what FengSui does on it", () => {
    const en = supportedDevicesSection("en");
    // The status reads and the cellular settings came later: the reads follow the facts (an indoor CPE
    // has no battery), the writes are not done on it, the rest is verified
    const later = MODULES.map((module) => module.features.every((feature) => STATUS_READ_FEATURES.includes(feature as StatusReadFeature) || isCellularWriteFeature(feature)));
    assert.deepEqual(later.filter(Boolean).length, 6);
    assert.deepEqual(rows(en, "huawei")[0], ["H168-383", "Indoor CPE", ...MODULES.map((module, i) => (!later[i] ? "✓" : module.features.includes("battery") ? "—" : "")), ""], "the verified model: everything verified, nothing to report");
    // Generic reads and writes ?, band lock and nearby cells △ (their conditions under the table), what
    // FengSui writes on the verified model only stays empty
    assert.deepEqual(marksOf(en, "huawei", "B535-232")?.slice(0, LEGACY), ["?", "△", "?", "?", "△", "", "?", "?", "", "", "—"]);
    // The cellular settings on a HiLink model: the mode and the operator, roaming and the traffic counters (no APN or limit), USSD
    assert.deepEqual(marksOf(en, "huawei", "B535-232")?.slice(LEGACY), ["", "", "?", "△", "?"]);
    assert.match(en, /- △ Data settings: data roaming and clearing the traffic counters only; FengSui does not do the access point \(APN\) and the data limit here yet/);
    assert.deepEqual(marksOf(en, "soyealink", "B535-333"), marksOf(en, "huawei", "B535-232"), "another maker on the same interface marks the same");
    const notes = en.split('<a id="brand-huawei"></a>')[1]?.split('<a id="brand-brovi"></a>')[0] ?? "";
    assert.match(notes, /- △ Band lock: locks 4G \(LTE\) bands only; FengSui locks 5G bands on a verified model only \(every model but the H168-383\)\./);
    assert.match(notes, /- A USB modem connects only in HiLink mode, with its web interface \(E8231, E8372h-153/);
  });

  it("marks another brand's model from what its interface implements: ? where FengSui does it, empty where it does nothing yet", () => {
    for (const family of DRIVER_FAMILIES) {
      const entry = DEVICE_CATALOG.find((e) => primaryFamily(e) === family && !MODEL_FACTS.some((f) => f.family === family && f.models?.some((name) => catalogMatches(e, name))));
      assert.ok(entry, family);
      for (const feature of DEVICE_FEATURES) {
        const mark = supportMark(family, displayName(entry), feature);
        // The family's own form of its interface: a fact of another form does not apply
        const conditions = MODEL_FACTS.filter((fact) => fact.family === family && !fact.models && !fact.forms && (fact.variant ?? null) === null && fact.features.includes(feature));
        // A form without the hardware (a CPE's battery) is —
        const absent = MODEL_FACTS.some((fact) => fact.family === family && fact.effect === "absent" && fact.forms?.includes(entry.form) === true && fact.features.includes(feature));
        const expected = absent ? "—" : !familyImplements(family, feature) ? "" : conditions.length > 0 ? "△" : "?";
        assert.equal(mark, expected, `${family} ${feature}`);
      }
      // Each brand's writes are its own list: a write one driver gains later changes that brand's rows alone
      const sms = SMS_FAMILIES.includes(family);
      assert.deepEqual([...ROUTER_FAMILY_FACTS[family].writes], DRIVER_WRITES[family], `${family}: what its driver writes today`);
      assert.equal(familyImplements(family, "smsRead"), sms, `${family}: SMS where its interface is on record`);
    }
    assert.equal(familyImplements("huawei", "smsRead"), true);
    // Done in part: reboot without redial is △, and the note says which part
    const zh = supportedDevicesSection("zh-CN");
    assert.equal(marksOf(zh, "pinsu", "R200C")?.[6], "△");
    assert.match(zh, /- △ 「重启与重拨」：只有重启，重拨烽燧在这里还没有做（这一节的全部型号）。/);
    // Never — for "not done yet": only where the hardware is missing (a battery), and nothing is reported as not working
    const battery = 2 + MODULES.findIndex((module) => module.features.includes("battery"));
    for (const cells of rows(supportedDevicesSection("en"))) {
      const offset = cells.length - MODULES.length - 3;
      cells.forEach((cell, i) => assert.ok(cell !== "—" || i === battery + offset, `${cells[0]}: — outside the Battery column`));
    }
    assert.deepEqual(UNSUPPORTED_FEATURES, []);
    // Nothing implemented: the whole row stays empty
    assert.deepEqual(marksOf(supportedDevicesSection("en"), "dlink", "D-Link DWR-2000M"), MODULES.map(() => ""));
  });

  it("writes what is particular to a model as a fact, and the generator turns each into △ and a note under its brand's table", () => {
    const zh = supportedDevicesSection("zh-CN");
    const en = supportedDevicesSection("en");
    // Each fact names models the catalog has on its interface
    for (const fact of MODEL_FACTS) {
      for (const name of fact.models ?? []) assert.ok(DEVICE_CATALOG.some((e) => e.families.includes(fact.family) && catalogMatches(e, name)), `${fact.family}: ${name}`);
      // A form of the interface the family has
      if (typeof fact.variant === "string") assert.ok(ROUTER_FAMILY_FACTS[fact.family].variants?.[fact.variant], `${fact.family}: ${fact.variant}`);
      assert.ok(fact.zh && fact.en);
    }
    // ZTE: the goform models that open their developer options are the driver's branches 2 and 3
    for (const name of ZTE_DEVELOPER_OPTION_MODELS.filter((n) => !n.startsWith("F50") && n !== "MF79U")) assert.ok([2, 3].includes(zteBranch({ hardwareVersion: "", modelName: name })), name);
    assert.deepEqual([marksOf(zh, "zte", "MC8020")?.[4], marksOf(zh, "zte", "MC8020")?.[5], marksOf(zh, "zte", "MC801A")?.[4]], ["△", "△", "?"]);
    assert.match(zh, /- △ 「锁频段」、「锁小区」：锁定前，烽燧会先用同一个管理密码打开路由器的开发者选项，并在这次写入的记录里写明（MC888 Ultra、MC888 Pro、MC888、MC888S、MC8020、MC8830、F50 Pro、F50 和 MF79U）。/);
    // zWRT locks 5G cells only; NRadio's 5G bands hang on the module; OpenWrt reboots the module; Fibocom's modes
    assert.equal(marksOf(en, "zte", "U60 Pro (MU5250)")?.[5], "△");
    assert.match(en, /- △ Cell lock: locks 5G cells only, not 4G cells \(U60 Pro \(MU5250\), G5 Ultra \(MC8530\)/);
    assert.equal(marksOf(en, "nradio", "C8-668GL")?.[4], "△");
    assert.deepEqual([marksOf(en, "openwrt", "Quectel RM520N-GL")?.[4], marksOf(en, "openwrt", "Fibocom FM350-GL")?.[4], marksOf(en, "openwrt", "Quectel RM520N-GL")?.[6]], ["?", "△", "△"]);
    assert.match(en, /- △ Reboot & redial: "Reboot" restarts the cellular module, not the whole router \(every model in this table\)\./);
    // A note that changes no mark: Tozed's encrypted builds
    assert.match(zh, /- 有些运营商定制固件给接口加了一层加密，烽燧连不上这样的固件（除 ZLT T10D MAX 外的全部型号）。/);
    // A ZLT router on ZTE's chip platform sits in its maker's section and connects through ZTE's interface
    assert.equal(findCatalogModel("zte-goform", "ZLT T10D MAX")?.section, "tozed");
    assert.equal(findCatalogModel("tozed", "ZLT T10D MAX"), null);
    assert.deepEqual(marksOf(zh, "tozed", "ZLT T10D MAX")?.slice(3, 6), ["?", "△", "△"]);
    assert.match(zh, /- △ 「锁频段」、「锁小区」：这类 4G 固件的接口资料里没有锁频段和锁小区的指令，[^\n]*（ZLT T10D MAX）。/);
    // One the notes put on two interfaces names both, and connects through the one detection finds first
    assert.deepEqual(findCatalogModel("tozed", "ZLT M30S")?.families, ["tozed", "zte-goform"]);
    assert.equal(findCatalogModel("zte-goform", "ZLT M30S")?.model, "ZLT M30S");
    // The legend: four marks and the empty cell, nothing more than the table needs
    const legend = zh.split("\n<a id=")[0] ?? "";
    for (const mark of ["**✓ 已验证**", "**? 等待回报**", "**△ 部分支持或有条件**", "**— 不支持**", "空白：烽燧还没有做"]) assert.ok(legend.includes(mark), mark);
    assert.ok(legend.includes("路由器或它的接口没有这项功能（比如室内 CPE 没有电池），或者有人实测过不能用"), legend);
    // A cell whose parts differ shows both marks, and the legend then says how to read them
    assert.equal(marksOf(zh, "openwrt", "Quectel RM520N-GL")?.[3], "?/△");
    assert.match(zh, /- △ 「短信」：发送短信要路由器装有 QModem；没有装的固件上，烽燧能读取和删除短信，不能发送（这一节的全部型号）。/);
    assert.ok(legend.includes("一格里有几个符号时，依次对应这一列包含的功能：「短信」是读取 / 发送与管理"), legend);
    assert.ok(legend.includes("「接口」一列有两套时，自动识别选第一套"), legend);
  });

  it("marks a model speaking another form of its brand's interface by what that form has, and gives it that form's facts alone", () => {
    const en = supportedDevicesSection("en");
    // The Pro series: signal (△: the key on record), SMS read ? and marking read △; what its notes lack stays empty
    assert.deepEqual(marksOf(en, "fiberhome", "LG6851F"), ["△", "", "", "?/△", "", "", "", "", "", "", "", "", "", "", "", ""]);
    assert.deepEqual(marksOf(en, "fiberhome", "LG6121F")?.slice(0, LEGACY), ["?", "?", "", "△", "?", "?", "△", "", "", "", ""]);
    const pro = ROUTER_FAMILY_FACTS.fiberhome.variants?.["pro"];
    assert.ok(pro);
    for (const feature of DEVICE_FEATURES) {
      const implemented: boolean =
        (pro.writes as ReadonlyArray<string>).includes(feature) ||
        (feature === "telemetry" && pro.reads.includes("telemetry")) ||
        (feature === "smsRead" && pro.reads.includes("sms")) ||
        (pro.reads as ReadonlyArray<string>).includes(feature);
      assert.equal(supportMark("fiberhome", "LG6851F", feature) !== "", implemented, feature);
    }
    assert.equal(supportMark("fiberhome", "LG6121F", "bandLock"), "?");
    // The first series' SMS conditions name every model but the Pro one; a model the list lacks still gets them
    assert.match(en, /deletes a whole conversation at a time \(every model but the LG6851F\)/);
    assert.equal(supportMark("fiberhome", "LG9999", "smsWrite"), "△");
    const row = deviceSupportRow("fiberhome", "LG6851F");
    assert.ok(row.notes.some((n) => n.en.startsWith("FiberHome's Pro series")));
    assert.ok(!row.notes.some((n) => n.en.includes("whole conversation")));
    // The row of the router in use follows the form its driver reported, listed or not
    assert.deepEqual(deviceSupportRow("fiberhome", "LG9999", { variant: "pro" }).modules.map((m) => m.mark), ["△", "", "", "?/△", "", "", "", "", "", "", "", "", "", "", "", ""]);
    assert.equal(deviceSupportRow("fiberhome", "LG6851F", { variant: null }).modules[4]?.mark, "?", "its driver found the family's own form");
    assert.equal(deviceSupportRow("fiberhome", "LG6121F", { variant: "elsewhere" }).modules[4]?.mark, "?", "a form the family does not have");
  });

  it("names both interfaces of a ZTE model that has two, connects through the one detection picks, and marks the other when it is chosen", () => {
    const u60 = DEVICE_CATALOG.find((e) => e.code === "MU5250");
    assert.ok(u60);
    assert.equal(primaryFamily(u60), "zte-zwrt");
    assert.equal(DETECTION_ORDER.indexOf("zte-zwrt") < DETECTION_ORDER.indexOf("zte-goform"), true);
    const row = rows(supportedDevicesSection("en"), "zte").find((cells) => cells[0] === "U60 Pro (MU5250)");
    assert.deepEqual(row?.slice(1, 3), ["Mobile router", "zWRT · goform"]);
    assert.deepEqual(rows(supportedDevicesSection("en"), "zte").find((cells) => cells[0] === "MC801A")?.slice(1, 3), ["Indoor CPE", "goform"]);
    // Chosen by hand, the goform interface locks 4G cells too
    assert.equal(supportMark("zte-zwrt", "U60 Pro (MU5250)", "cellLock"), "△");
    assert.equal(supportMark("zte-goform", "U60 Pro (MU5250)", "cellLock"), "?");
    // A section of one interface has no Interface column
    assert.ok(!supportedDevicesSection("en").split('<a id="brand-pinsu"></a>')[1]?.split("\n").find((line) => line.startsWith("| Model"))?.includes("Interface"));
  });

  it("links every model nobody verified to a new device report titled with it, and to nothing else", () => {
    for (const locale of ["zh-CN", "en"] as const) {
      const all = rows(supportedDevicesSection(locale));
      assert.equal(all.length, DEVICE_CATALOG.length);
      for (const cells of all.filter((c) => c[0] !== "H168-383")) {
        const href = /\]\((https:[^)]+)\)$/.exec(cells.at(-1) ?? "")?.[1];
        assert.ok(href, `${cells[0]}: a report link`);
        const url = new URL(href);
        assert.equal(`${url.origin}${url.pathname}`, ISSUE_NEW_URL);
        assert.deepEqual([...url.searchParams.keys()], ["template", "title"]);
        assert.deepEqual([url.searchParams.get("template"), url.searchParams.get("title")], [DEVICE_REPORT_TEMPLATE, `Device report: ${cells[0]}`]);
      }
    }
  });

  it("marks — only from a report, and gives a model only a report names a row under its brand", () => {
    const failed: UnsupportedFeature[] = [
      { family: "huawei", model: "B535-232", feature: "mobileData", issue: 31 },
      { family: "zte-goform", model: "MC999", feature: "cellLock", issue: 32 },
    ];
    assert.equal(supportMark("huawei", "B535-232", "mobileData", [], failed), "—");
    assert.equal(supportMark("tozed", "B535-232", "mobileData", [], failed), "", "another brand's router of that name is another router");
    assert.equal(supportMark("zte-goform", "B535-232", "mobileData", [], failed), "?", "and marked from its own brand's facts");
    const en = supportedDevicesSection("en", [], failed);
    assert.equal(marksOf(en, "huawei", "B535-232")?.[7], "—");
    assert.deepEqual(rows(en, "zte").find((cells) => cells[0] === "MC999")?.slice(0, 3), ["MC999", "", "goform"]);
    assert.equal(marksOf(en, "zte", "MC999")?.[5], "—");
    assert.equal(en.includes("(none in the table yet)"), false);
  });

  it("turns a registered report into ✓ for the brand and model it names, and splits a module whose features now differ", () => {
    const verified: VerifiedFeature[] = [
      { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "smsWrite", access: "write", issue: 15 },
      { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "bandLock", access: "write", issue: 12 },
      // A read checked is not the write of the same feature
      { family: "huawei", model: "B535-232", softwareVersion: "11.0.1.2(H7SP2C00)", feature: "reboot", access: "read", issue: 16 },
      // The router's own name for the model finds its row
      { family: "zte-zwrt", model: "MU5250", softwareVersion: "BD_ZTE_MU5250V1.0.0B05", feature: "cellLock", access: "write", issue: 41 },
      { family: "huawei", model: "B999-001", softwareVersion: "1.0", feature: "reboot", access: "write", issue: 21 },
    ];
    const zh = supportedDevicesSection("zh-CN", verified);
    assert.deepEqual(marksOf(zh, "huawei", "B535-232")?.slice(0, LEGACY), ["?", "△", "?", "?/✓", "✓", "", "?", "?", "", "", "—"]);
    assert.ok(zh.includes("- 一格里有几个符号时，依次对应这一列包含的功能：「短信」是读取 / 发送与管理，「重启与重拨」是重启 / 重拨，「路由器开关」是安全开关 / Wi-Fi 7 / 天线，「SIM 卡」是状态 / 切换卡槽 / PIN，"), zh);
    assert.equal(marksOf(zh, "zte", "U60 Pro (MU5250)")?.[5], "✓");
    assert.equal(marksOf(zh, "zte", "G5 Ultra (MC8530)")?.[5], "△", "only the model reported");
    assert.deepEqual(rows(supportedDevicesSection("en", verified), "huawei").find((cells) => cells[0] === "B999-001")?.slice(0, 2 + LEGACY), ["B999-001", "", "?", "△", "?", "?", "△", "", "✓/?", "?", "", "", "?"]);
    assert.equal(supportedDevicesSection("en"), supportedDevicesSection("en", []));
  });
});

describe("the row of the router the console shows", () => {
  it("finds the model by the name the router reports, on its interface, and carries its marks and notes", () => {
    const row = deviceSupportRow("zte-zwrt", "MU5250");
    assert.deepEqual([row.model, row.section, row.family], ["U60 Pro (MU5250)", "zte", "zte-zwrt"]);
    assert.deepEqual(
      row.modules.map((m) => m.mark).slice(0, LEGACY),
      ["?", "", "", "?", "?", "△", "?", "?", "", "", "?"]
    );
    assert.deepEqual(row.modules[5], { zh: "锁小区", en: "Cell lock", mark: "△" });
    assert.deepEqual(
      row.notes.map((n) => n.en).filter((note) => /^Cell lock|^SMS is read/.test(note)),
      ["Cell lock: locks 5G cells only, not 4G cells", "SMS is read from and written to the router's own storage; messages kept on the SIM card are not shown"]
    );
    assert.equal(findCatalogModel("zte-zwrt", " u60 pro ")?.code, "MU5250", "case and spaces aside");
    assert.equal(findCatalogModel("huawei", "MU5250"), null, "only on an interface the model has");
    assert.deepEqual(deviceSupportRow("huawei", "H168-383").modules.map((m) => m.mark), MODULES.map((module) => (module.features.includes("battery") ? "—" : module.features.some((f) => STATUS_READ_FEATURES.includes(f as StatusReadFeature) || isCellularWriteFeature(f)) ? "" : "✓")));
    // Its one note: the battery it does not have
    assert.deepEqual(deviceSupportRow("huawei", "H168-383").notes, [{ zh: "电池：只有随身路由器有电池", en: "Battery: only a mobile router has a battery" }]);
  });

  it("gives a model the list lacks its brand's defaults and its brand's section", () => {
    const row = deviceSupportRow("tozed", "ZLT X999");
    assert.deepEqual([row.model, row.section], [null, "tozed"]);
    assert.deepEqual(
      row.modules.map((m) => m.mark).slice(0, LEGACY),
      ["?", "?", "", "?/△", "?", "?", "△", "", "", "", ""]
    );
    assert.ok(row.notes.some((n) => n.zh.startsWith("有些运营商定制固件")), "what the list says of every model of the brand");
    assert.ok(row.notes.some((n) => n.zh.startsWith("短信：能发送短信；")), "and what its SMS interface cannot do");
    assert.equal(deviceSupportRow("openwrt", null).section, "openwrt");
    assert.equal(deviceSupportRow("openwrt", "Quectel 5G Module").model, null);
  });

  it("shows ✓ where a report was registered for this router", () => {
    const verified: VerifiedFeature[] = [{ family: "zte-zwrt", model: "MU5250", softwareVersion: "BD_ZTE_MU5250V1.0.0B05", feature: "cellLock", access: "write", issue: 41 }];
    const row = deviceSupportRow("zte-zwrt", "MU5250", { verified });
    assert.equal(row.modules[5]?.mark, "✓");
    assert.ok(!row.notes.some((n) => n.en.startsWith("Cell lock")), "a verified cell needs no condition");
  });
});
