import type { DeviceFeature } from "./device-profile.ts";
import { deviceIssueUrl } from "./feedback.ts";
import { VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isVerifiedFeature, isVerifiedModel } from "./firmware.ts";
import { DRIVER_FAMILIES, type DriverFamily, ROUTER_FAMILY_FACTS, ROUTER_FAMILY_LABELS } from "./router-family.ts";
import type { SupportedLocale } from "./types.ts";

/**
 * The routers FengSui may work with, as the "Supported devices" guide page shows them
 * (docs/guide/{zh,en}/supported-devices.md, between `<!-- devices:begin -->` and `<!-- devices:end -->`;
 * test/device-catalog.test.ts keeps both identical to `supportedDevicesSection`): the verified
 * H168-383, and the Huawei HiLink routers another HiLink client was tested on, grouped as the "Tested
 * on" list of Salamek/huawei-lte-api groups them (README at df87e5f, 2026-08-13; facts only, none of
 * its code; the guide credits it once, on "Other models and brands"). Each row gives one mark per console
 * module: verified, may work, unknown or not supported. A feature users verify (`VERIFIED_FEATURES`)
 * turns its mark into "verified", one a report shows failing (`UNSUPPORTED_FEATURES`) into "not supported".
 * The brands FengSui has a driver for get a table of their own, one row per brand, between
 * `<!-- brands:begin -->` and `<!-- brands:end -->` (`otherBrandsSection`).
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

/** Verified, may work (the protocol has it and FengSui implements it), unknown, not supported. */
export type SupportMark = "○" | "△" | "?" | "×";

/** Features read rather than written: a user's verified read of one makes it verified. */
const READ_FEATURES: ReadonlySet<DeviceFeature> = new Set<DeviceFeature>(["telemetry", "neighbors", "topology", "smsRead"]);

/** What FengSui reads on any model, where the router provides it: the HiLink basics (docs/PHASE1_PROTOCOL_SPEC.md A.10). */
export const GENERIC_READS: ReadonlyArray<DeviceFeature> = ["telemetry", "topology", "smsRead"];

/**
 * Features FengSui knows only the H168-383's endpoints for, with no protocol facts for other models
 * (A.10: no `device/nbrcellinfo`; A.11: no `net/lock-freq`): whether another model has them is unknown.
 */
const H168_ONLY: ReadonlySet<DeviceFeature> = new Set<DeviceFeature>(["neighbors", "cellLock"]);

/**
 * A feature a report showed not working on a model, or one its protocol rules out: marked × (the
 * table's only source of "not supported"). Added like a verified feature, naming the issue. Empty
 * until the first report.
 */
export interface UnsupportedFeature {
  model: string;
  feature: DeviceFeature;
  /** The cky008/cpe-dash issue that reported it. */
  issue: number;
}

export const UNSUPPORTED_FEATURES: ReadonlyArray<UnsupportedFeature> = [];

/**
 * A feature's mark on a model nobody verified, before any report: may work where the protocol has the
 * feature and FengSui implements it (the generic reads and experimental writes, and the security
 * switches, antenna and access control the protocol also covers, which FengSui writes on verified
 * models only for now); unknown where only the H168-383's way is known.
 */
export function baselineMark(feature: DeviceFeature): SupportMark {
  return H168_ONLY.has(feature) ? "?" : "△";
}

/** A feature's mark on `model`: verified on a verified model or by a report, not supported by a report, else its baseline. */
export function supportMark(
  model: string,
  feature: DeviceFeature,
  verifiedFeatures: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES,
  unsupported: ReadonlyArray<UnsupportedFeature> = UNSUPPORTED_FEATURES
): SupportMark {
  if (isVerifiedModel(model)) return "○";
  if (isVerifiedFeature("huawei", model, feature, READ_FEATURES.has(feature) ? "read" : "write", verifiedFeatures)) return "○";
  if (unsupported.some((entry) => entry.model === model.trim() && entry.feature === feature)) return "×";
  return baselineMark(feature);
}

interface Module {
  zh: string;
  en: string;
  features: ReadonlyArray<DeviceFeature>;
  /** How the legend names each feature of a module of more than one. */
  parts?: { zh: ReadonlyArray<string>; en: ReadonlyArray<string> };
}

/** The table's columns: the console's modules, each with the features it covers (every feature once). */
export const MODULES: ReadonlyArray<Module> = [
  { zh: "信号与流量", en: "Signal & traffic", features: ["telemetry"] },
  { zh: "附近的基站", en: "Nearby cells", features: ["neighbors"] },
  { zh: "已连接设备", en: "Connected devices", features: ["topology"] },
  { zh: "短信", en: "SMS", features: ["smsRead", "smsWrite"], parts: { zh: ["读取", "发送与管理"], en: ["reading", "sending and managing"] } },
  { zh: "锁频段", en: "Band lock", features: ["bandLock"] },
  { zh: "锁小区", en: "Cell lock", features: ["cellLock"] },
  { zh: "重启与重拨", en: "Reboot & redial", features: ["reboot", "reconnect"], parts: { zh: ["重启", "重拨"], en: ["reboot", "redial"] } },
  { zh: "移动数据", en: "Mobile data", features: ["mobileData"] },
  {
    zh: "路由器开关",
    en: "Router switches",
    features: ["securitySwitches", "wifi", "antenna"],
    parts: { zh: ["安全开关", "Wi-Fi 7", "天线"], en: ["the security switches", "Wi-Fi 7", "the antenna"] },
  },
  { zh: "访问控制", en: "Access control", features: ["accessControl"] },
];

const BRANDS: ReadonlyArray<KnownRouter["brand"]> = ["Huawei", "SoyeaLink"];

const KIND_LABELS: Readonly<Record<RouterKind, { zh: string; en: string }>> = {
  "5g": { zh: "5G 路由器", en: "5G router" },
  lte: { zh: "3G/4G 路由器", en: "3G/LTE router" },
  usb: { zh: "USB 上网卡", en: "USB modem" },
};

/** `a, b and c` / `a、b和c` (a space between 和 and a Latin word, as the Chinese guide writes it). */
function joinAll(items: ReadonlyArray<string>, en: boolean): string {
  if (items.length < 2) return items.join("");
  const head = items.slice(0, -1).join(en ? ", " : "、");
  const last = items.at(-1) ?? "";
  if (en) return `${head} and ${last}`;
  return `${head}${/[ -~]$/.test(head) ? " " : ""}和${/^[ -~]/.test(last) ? " " : ""}${last}`;
}

/**
 * The page's table section: what the marks mean, then one table per brand (the model, its kind, a mark
 * per module, and where to report it). A module's cell shows one mark, or its features' marks in
 * order ("○/△") when they differ. A verified model, or one only users verified features of, gets a row
 * under Huawei even when the reference does not list it.
 */
export function supportedDevicesSection(
  locale: SupportedLocale,
  verifiedFeatures: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES,
  unsupported: ReadonlyArray<UnsupportedFeature> = UNSUPPORTED_FEATURES
): string {
  const en = locale === "en";
  const routers: Array<{ brand: KnownRouter["brand"]; model: string; kind: RouterKind | null }> = [...KNOWN_ROUTERS];
  for (const model of [...VERIFIED_FIRMWARE.map((entry) => entry.model), ...verifiedFeatures.map((entry) => entry.model), ...unsupported.map((entry) => entry.model)]) {
    if (!routers.some((router) => router.model === model)) routers.push({ brand: "Huawei", model, kind: null });
  }
  let mixed = false;
  let anyUnsupported = false;
  const row = (router: { model: string; kind: RouterKind | null }): string => {
    const kind = router.kind ? (en ? KIND_LABELS[router.kind].en : KIND_LABELS[router.kind].zh) : "—";
    const cells = MODULES.map((module) => {
      const marks = module.features.map((feature) => supportMark(router.model, feature, verifiedFeatures, unsupported));
      if (marks.includes("×")) anyUnsupported = true;
      if (new Set(marks).size === 1) return marks[0] ?? "?";
      mixed = true;
      return marks.join("/");
    });
    const report = isVerifiedModel(router.model) ? "—" : `[${en ? "Report" : "提交报告"}](${deviceIssueUrl({ model: router.model, softwareVersion: null })})`;
    return `| ${router.model} | ${kind} | ${cells.join(" | ")} | ${report} |`;
  };
  const header = [
    `| ${en ? "Model" : "型号"} | ${en ? "Kind" : "类型"} | ${MODULES.map((module) => (en ? module.en : module.zh)).join(" | ")} | ${en ? "Your results" : "实测反馈"} |`,
    `| :--- | :--- | ${MODULES.map(() => ":---:").join(" | ")} | :--- |`,
  ];
  const sections = BRANDS.map((brand) => {
    const title = brand === "Huawei" && !en ? "华为" : brand;
    return [`## ${title}`, "", ...header, ...routers.filter((router) => router.brand === brand).map(row)].join("\n");
  });

  const verifiedModels = joinAll([...new Set(VERIFIED_FIRMWARE.map((entry) => entry.model))], en);
  const switches = MODULES.find((module) => module.features.includes("securitySwitches"))?.parts;
  const split = MODULES.filter((module) => module.features.length > 1);
  const legend = en
    ? [
        "What the marks mean:",
        "",
        `- **○ Verified**: someone confirmed it on a real router, and it is in the code (\`VERIFIED_FEATURES\`). Everything is verified on the ${verifiedModels}, which also works as usual on another firmware build and warns once with \`FIRMWARE_UNVERIFIED\`.`,
        "- **△ May work**: the protocol has the feature and FengSui implements it, but nobody has checked it on this model yet. Band lock (LTE only), sending and managing SMS, reboot, redial and mobile data are available there by default as experimental writes, each sent once and read back, and you can turn each one off under Settings → Device; changes to the router switches and access control are offered on verified models only for now.",
        `- **? Unknown**: FengSui knows only the ${verifiedModels}'s endpoints for it, and the protocol notes say nothing about other models; whether it works depends on the router.`,
        `- **× Not supported**: the protocol does not have the feature, or someone tested it on this model and it did not work${anyUnsupported ? "" : " (none in the table yet)"}.`,
        `- "Router switches" are ${joinAll(switches?.en ?? [], true)}, where the router has them (Wi-Fi 7, for one, takes a Wi-Fi 7 router). A USB modem works only in HiLink mode, with its web interface.`,
        ...(mixed ? [`- Where a cell has more than one mark, they follow the column's parts in order: ${split.map((module) => `${module.en} is ${(module.parts?.en ?? []).join(" / ")}`).join("; ")}.`] : []),
      ]
    : [
        "表里的符号：",
        "",
        `- **○ 已验证**：有人在真机上确认过，并已写进代码（\`VERIFIED_FEATURES\`）。${verifiedModels} 的全部功能都验证过；它换了别的固件也照常工作，只发一次 \`FIRMWARE_UNVERIFIED\` 提醒。`,
        "- **△ 可能支持**：协议里有这项功能，烽燧也已经实现，只是还没人在这个型号上验证过。其中锁频段（只锁 4G）、短信的发送与管理、重启、重拨和移动数据，在这些型号上作为实验性写入默认可用：每次只发一次，写后回读核对，可以在「设置 → 设备」逐项关闭；路由器开关和访问控制的改动，烽燧目前只在验证过的型号上开放。",
        `- **? 未知**：烽燧只知道 ${verifiedModels} 的接口，协议资料里没有其他型号的做法，能不能用要看路由器。`,
        `- **× 不支持**：协议里没有这项功能，或者有人在这个型号上实测过不能用${anyUnsupported ? "" : "（表里暂时还没有）"}。`,
        `- 「路由器开关」指${joinAll(switches?.zh ?? [], false)}，路由器本身有这些功能才谈得上（比如 Wi-Fi 7 要路由器支持 Wi-Fi 7）。USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连。`,
        ...(mixed ? [`- 一格里有几个符号时，依次对应这一列包含的功能：${split.map((module) => `「${module.zh}」是${(module.parts?.zh ?? []).join(" / ")}`).join("，")}。`] : []),
      ];
  return [legend.join("\n"), ...sections].join("\n\n");
}

/**
 * A feature's mark on a router of a driver family (every brand but Huawei's): may work where the
 * family's driver implements it from the brand's interface notes (nobody verified it on a real
 * router), unknown where FengSui has nothing for the brand yet. Never ×: nothing was ruled out.
 */
export function brandMark(family: DriverFamily, feature: DeviceFeature): SupportMark {
  if (feature === "telemetry") return "△";
  if (feature === "neighbors" || feature === "topology") return (ROUTER_FAMILY_FACTS[family].reads as ReadonlyArray<string>).includes(feature) ? "△" : "?";
  return (ROUTER_FAMILY_FACTS[family].writes as ReadonlyArray<string>).includes(feature) ? "△" : "?";
}

/**
 * The page's section on the other brands: one row per brand FengSui has a driver for, with the
 * address its routers usually have, a mark per module and where to report a real router. The marks
 * come from what each driver implements (`ROUTER_FAMILY_FACTS`, per brand).
 */
export function otherBrandsSection(locale: SupportedLocale): string {
  const en = locale === "en";
  let mixed = false;
  const rows = DRIVER_FAMILIES.map((family) => {
    const cells = MODULES.map((module) => {
      const marks = module.features.map((feature) => brandMark(family, feature));
      if (new Set(marks).size === 1) return marks[0] ?? "?";
      mixed = true;
      return marks.join("/");
    });
    const label = ROUTER_FAMILY_LABELS[family];
    // The issue is titled with the brand's short name in FengSui (a model goes into the form itself)
    const report = `[${en ? "Report" : "提交报告"}](${deviceIssueUrl({ model: family, softwareVersion: null })})`;
    return `| ${en ? label.en : label["zh-CN"]} | \`${ROUTER_FAMILY_FACTS[family].defaultAddress}\` | ${cells.join(" | ")} | ${report} |`;
  });
  const header = [
    `| ${en ? "Brand" : "品牌"} | ${en ? "Usual address" : "常见地址"} | ${MODULES.map((module) => (en ? module.en : module.zh)).join(" | ")} | ${en ? "Your results" : "实测反馈"} |`,
    `| :--- | :--- | ${MODULES.map(() => ":---:").join(" | ")} | :--- |`,
  ];
  const split = MODULES.filter((module) => module.features.length > 1 && new Set(module.features.map((feature) => brandMark(DRIVER_FAMILIES[0] ?? "openwrt", feature))).size > 1);
  const legend = en
    ? [
        "What the marks mean here:",
        "",
        "- **△ May work**: FengSui implements it from the brand's interface notes, and nobody has checked it on a real router yet. Band lock, cell lock and reboot are experimental writes: available by default, each sent once and read back, and you can turn each one off under Settings → Device.",
        "- **? Unknown**: FengSui has nothing for this brand here yet, so that part of the console stays empty.",
        ...(mixed ? [`- Where a cell has more than one mark, they follow the column's parts in order: ${split.map((module) => `${module.en} is ${(module.parts?.en ?? []).join(" / ")}`).join("; ")}.`] : []),
      ]
    : [
        "这张表里的符号：",
        "",
        "- **△ 可能支持**：烽燧按这个品牌的接口资料实现了，还没有人在真机上验证过。锁频段、锁小区和重启是实验性写入：默认可用，每次只发一次，写后回读核对，可以在「设置 → 设备」逐项关闭。",
        "- **? 未知**：烽燧在这个品牌上还没有这一项，控制台里对应的部分是空的。",
        ...(mixed ? [`- 一格里有几个符号时，依次对应这一列包含的功能：${split.map((module) => `「${module.zh}」是${(module.parts?.zh ?? []).join(" / ")}`).join("，")}。`] : []),
      ];
  return [legend.join("\n"), [...header, ...rows].join("\n")].join("\n\n");
}
