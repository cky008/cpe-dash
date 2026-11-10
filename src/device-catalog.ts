import { type DeviceFeature, EXPERIMENTAL_FEATURES } from "./device-profile.ts";
import { deviceIssueUrl } from "./feedback.ts";
import { FEATURE_LABELS, VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature } from "./firmware.ts";
import type { SupportedLocale } from "./types.ts";

/**
 * The routers FengSui may work with, as the "Supported devices" guide page lists them
 * (docs/guide/{zh,en}/supported-devices.md, between `<!-- devices:begin -->` and `<!-- devices:end -->`;
 * test/device-catalog.test.ts keeps both identical to `supportedDevicesSection`): the verified H168-383,
 * and the HiLink routers another HiLink client was tested on, grouped as the "Tested on" list of
 * Salamek/huawei-lte-api groups them (README at df87e5f, 2026-08-13; facts only, none of its code).
 * Nobody checked those with FengSui, so each row links to a device report for its model, and a feature
 * users verify (`VERIFIED_FEATURES`) moves from "may work" to "verified".
 */

/** How the reference list groups a router: 5G routers, 3G/LTE routers, 3G/LTE USB sticks in HiLink mode. */
export type RouterKind = "5g" | "lte" | "usb";

export interface KnownRouter {
  brand: "Huawei" | "SoyeaLink";
  model: string;
  kind: RouterKind;
}

export const KNOWN_ROUTERS: ReadonlyArray<KnownRouter> = [
  { brand: "Huawei", model: "H168-383", kind: "5g" },
  { brand: "Huawei", model: "H112-372", kind: "5g" },
  { brand: "Huawei", model: "H122-373", kind: "5g" },
  { brand: "Huawei", model: "H165-383", kind: "5g" },
  { brand: "Huawei", model: "B310s-22", kind: "lte" },
  { brand: "Huawei", model: "B311-221", kind: "lte" },
  { brand: "Huawei", model: "B315s-22", kind: "lte" },
  { brand: "Huawei", model: "B525s-23a", kind: "lte" },
  { brand: "Huawei", model: "B525s-65a", kind: "lte" },
  { brand: "Huawei", model: "B528s", kind: "lte" },
  { brand: "Huawei", model: "B535-232", kind: "lte" },
  { brand: "Huawei", model: "B612-233", kind: "lte" },
  { brand: "Huawei", model: "B628-265", kind: "lte" },
  { brand: "Huawei", model: "B715s-23c", kind: "lte" },
  { brand: "Huawei", model: "B818-263", kind: "lte" },
  { brand: "Huawei", model: "E5180s-22", kind: "lte" },
  { brand: "Huawei", model: "E5186s-22a", kind: "lte" },
  { brand: "Huawei", model: "E5573s-320", kind: "lte" },
  { brand: "Huawei", model: "E5576-320", kind: "lte" },
  { brand: "Huawei", model: "E5577Cs-321", kind: "lte" },
  { brand: "Huawei", model: "E8231", kind: "lte" },
  { brand: "Huawei", model: "E3131", kind: "usb" },
  { brand: "Huawei", model: "E3372", kind: "usb" },
  { brand: "Huawei", model: "E3531", kind: "usb" },
  { brand: "Huawei", model: "E5530As-2", kind: "usb" },
  { brand: "Huawei", model: "E8372h-608", kind: "usb" },
  { brand: "SoyeaLink", model: "B535-333", kind: "lte" },
];

/** Models the reference reports with a firmware its client cannot work with: FengSui most likely cannot connect either. */
export const INCOMPATIBLE_ROUTERS: ReadonlyArray<string> = ["B2368-22", "B593s-22"];

/** What FengSui reads on a model nobody verified, where the router provides it (neighbour cells, settings and access control are the H168-383's own). */
export const GENERIC_READS: ReadonlyArray<DeviceFeature> = ["telemetry", "topology", "smsRead"];

const BRANDS: ReadonlyArray<KnownRouter["brand"]> = ["Huawei", "SoyeaLink"];

const KIND_LABELS: Readonly<Record<RouterKind, { zh: string; en: string }>> = {
  "5g": { zh: "5G 路由器", en: "5G router" },
  lte: { zh: "3G / 4G 路由器", en: "3G / LTE router" },
  usb: { zh: "USB 上网卡（HiLink 模式）", en: "USB modem (HiLink mode)" },
};

/**
 * The page's table section: what each column means, one table per brand (the model, its kind, what is
 * verified on it, what may work, and where to report it), then the models known not to work. "May
 * work" names the reads and the experimental writes as groups; once users verify some of a model's
 * features, its row lists the rest. A model only users verified features of, or a verified model, gets
 * a row under Huawei even when the reference does not list it.
 */
export function supportedDevicesSection(locale: SupportedLocale, verifiedFeatures: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES): string {
  const en = locale === "en";
  const routers: Array<{ brand: KnownRouter["brand"]; model: string; kind: RouterKind | null }> = [...KNOWN_ROUTERS];
  for (const model of [...VERIFIED_FIRMWARE.map((entry) => entry.model), ...verifiedFeatures.map((entry) => entry.model)]) {
    if (!routers.some((router) => router.model === model)) routers.push({ brand: "Huawei", model, kind: null });
  }
  const label = (feature: DeviceFeature): string => (en ? FEATURE_LABELS[feature].en : FEATURE_LABELS[feature].zh);
  const list = (items: ReadonlyArray<string>): string => items.join(en ? ", " : "、");
  const both = (items: ReadonlyArray<string>): string => (items.length === 2 ? items.join(en ? " and " : " 和 ") : list(items));
  const groups = [
    { name: en ? "reads" : "读取", features: GENERIC_READS, access: "read" },
    { name: en ? "experimental writes" : "实验性写入", features: EXPERIMENTAL_FEATURES, access: "write" },
  ] as const;

  const row = (router: { model: string; kind: RouterKind | null }): string => {
    const kind = router.kind ? (en ? KIND_LABELS[router.kind].en : KIND_LABELS[router.kind].zh) : "—";
    const firmware = VERIFIED_FIRMWARE.find((entry) => entry.model === router.model);
    if (firmware) {
      // The version without its build code (the compatibility table on "Other Huawei models" has the full one)
      const version = firmware.softwareVersion.replace(/\(.*$/, "");
      return `| ${router.model} | ${kind} | ${en ? `✅ everything (firmware ${version})` : `✅ 全部功能（固件 ${version}）`} | — | — |`;
    }
    const checked = verifiedFeatures.filter((entry) => entry.model === router.model);
    const verified = checked.length > 0 ? `✅ ${list(checked.map((entry) => (en ? `${label(entry.feature)} (#${entry.issue})` : `${label(entry.feature)}（#${entry.issue}）`)))}` : "—";
    // A group nobody checked anything of goes by its name; once some of it is verified, the rest is spelt out
    const parts = groups.flatMap(({ name, features, access }) => {
      const rest = features.filter((feature) => !checked.some((entry) => entry.feature === feature && entry.access === access));
      if (rest.length === 0) return [];
      return [rest.length === features.length ? name : `${name}${en ? ": " : "："}${list(rest.map(label))}`];
    });
    const spelt = parts.some((part) => part.includes(en ? ": " : "："));
    const mayWork = parts.length === 0 ? "—" : parts.join(spelt ? (en ? "; " : "；") : en ? ", " : "、");
    const report = `[${en ? "Report how it works" : "提交实测报告"}](${deviceIssueUrl({ model: router.model, softwareVersion: null })})`;
    return `| ${router.model} | ${kind} | ${verified} | ${mayWork} | ${report} |`;
  };

  const verifiedModels = both([...new Set(VERIFIED_FIRMWARE.map((entry) => entry.model))]);
  const reads = list(GENERIC_READS.map(label));
  const writes = list(EXPERIMENTAL_FEATURES.map(label));
  const legend = en
    ? [
        "How to read the tables:",
        "",
        `- **Verified**: features someone confirmed on a real router and the maintainers added to the code (\`VERIFIED_FEATURES\`). Everything is verified on the ${verifiedModels}.`,
        `- **May work (not verified)**: what FengSui tries on a model it was not verified on. **Reads** are ${reads}, shown only where the router provides them. **Experimental writes** are ${writes}: locked until you turn each one on under Settings → Device after reading its risks (see [Other Huawei models](other-routers.md)). Nearby cells, router settings and access control use the ${verifiedModels}'s own endpoints and are not available on other models yet.`,
        "- **Report**: opens a new GitHub issue with the model already in its title.",
      ]
    : [
        "怎么看这些表格：",
        "",
        `- **已验证**：有人在真机上确认过、并已写进代码的功能（\`VERIFIED_FEATURES\`）。${verifiedModels} 的全部功能都验证过。`,
        `- **可能支持（未验证）**：烽燧在没验证过的型号上会尝试的功能。**读取**指${reads}，只显示路由器实际提供的；**实验性写入**指${writes}，默认锁定，要你在「设置 → 设备」逐项知情同意后才会打开（见[其他华为型号](other-routers.md)）。附近的基站、路由器设置和访问控制用的是 ${verifiedModels} 自己的接口，其他型号暂不支持。`,
        "- **实测反馈**：在 GitHub 打开一个新 issue，标题里已经写好型号。",
      ];
  const header = en
    ? ["| Model | Kind | Verified | May work (not verified) | Report |", "| :--- | :--- | :--- | :--- | :--- |"]
    : ["| 型号 | 类型 | 已验证 | 可能支持（未验证） | 实测反馈 |", "| :--- | :--- | :--- | :--- | :--- |"];
  const sections = BRANDS.map((brand) => {
    const title = brand === "Huawei" && !en ? "华为" : brand;
    return [`## ${title}`, "", ...header, ...routers.filter((router) => router.brand === brand).map(row)].join("\n");
  });
  const models = both(INCOMPATIBLE_ROUTERS);
  const incompatible = en
    ? `huawei-lte-api lists the firmware of the ${models} as incompatible, so FengSui most likely cannot connect to them either.`
    : `huawei-lte-api 注明 ${models} 的固件与它不兼容，烽燧很可能也连不上。`;
  return [legend.join("\n"), ...sections, incompatible].join("\n\n");
}
