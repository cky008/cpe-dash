import { type DeviceFeature, EXPERIMENTAL_FEATURES } from "./device-profile.ts";
import { deviceIssueUrl } from "./feedback.ts";
import { VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isVerifiedFeature, isVerifiedModel } from "./firmware.ts";
import type { SupportedLocale } from "./types.ts";

/**
 * The routers FengSui may work with, as the "Supported devices" guide page shows them
 * (docs/guide/{zh,en}/supported-devices.md, between `<!-- devices:begin -->` and `<!-- devices:end -->`;
 * test/device-catalog.test.ts keeps both identical to `supportedDevicesSection`): the verified
 * H168-383, and the Huawei HiLink routers another HiLink client was tested on, grouped as the "Tested
 * on" list of Salamek/huawei-lte-api groups them (README at df87e5f, 2026-08-13; facts only, none of
 * its code; the guide credits it once, on "Other Huawei models"). Each row gives one mark per console
 * module: verified, may work, unknown or not supported. A feature users verify (`VERIFIED_FEATURES`)
 * turns its mark into "verified".
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

/** Verified, may work (FengSui tries it where the router provides it), unknown, not supported. */
export type SupportMark = "○" | "△" | "?" | "×";

/** Features read rather than written: a user's verified read of one makes it verified. */
const READ_FEATURES: ReadonlySet<DeviceFeature> = new Set<DeviceFeature>(["telemetry", "neighbors", "topology", "smsRead"]);

/** What FengSui reads on any model, where the router provides it: the HiLink basics (docs/PHASE1_PROTOCOL_SPEC.md A.10). */
export const GENERIC_READS: ReadonlyArray<DeviceFeature> = ["telemetry", "topology", "smsRead"];

const MAY_WORK: ReadonlySet<DeviceFeature> = new Set<DeviceFeature>([...GENERIC_READS, ...EXPERIMENTAL_FEATURES]);

/**
 * A feature's mark on a model nobody verified: the generic reads and the experimental writes may work;
 * another read goes the H168-383's way, which the model may or may not answer; any other write has no
 * generic form, so FengSui never makes it there.
 */
export function baselineMark(feature: DeviceFeature): SupportMark {
  if (MAY_WORK.has(feature)) return "△";
  return READ_FEATURES.has(feature) ? "?" : "×";
}

/** A feature's mark on `model`: verified on a verified model or by a user's report, else its baseline. */
export function supportMark(model: string, feature: DeviceFeature, verifiedFeatures: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES): SupportMark {
  if (isVerifiedModel(model)) return "○";
  return isVerifiedFeature(model, feature, READ_FEATURES.has(feature) ? "read" : "write", verifiedFeatures) ? "○" : baselineMark(feature);
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
export function supportedDevicesSection(locale: SupportedLocale, verifiedFeatures: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES): string {
  const en = locale === "en";
  const routers: Array<{ brand: KnownRouter["brand"]; model: string; kind: RouterKind | null }> = [...KNOWN_ROUTERS];
  for (const model of [...VERIFIED_FIRMWARE.map((entry) => entry.model), ...verifiedFeatures.map((entry) => entry.model)]) {
    if (!routers.some((router) => router.model === model)) routers.push({ brand: "Huawei", model, kind: null });
  }
  let mixed = false;
  const row = (router: { model: string; kind: RouterKind | null }): string => {
    const kind = router.kind ? (en ? KIND_LABELS[router.kind].en : KIND_LABELS[router.kind].zh) : "—";
    const cells = MODULES.map((module) => {
      const marks = module.features.map((feature) => supportMark(router.model, feature, verifiedFeatures));
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
        "- **△ May work**: FengSui tries it on a model it was not verified on, and it works where the router provides it. Band lock (LTE only), sending and managing SMS, reboot, redial and mobile data are experimental writes there: locked until you turn each one on under Settings → Device.",
        `- **? Unknown**: FengSui reads it the ${verifiedModels}'s way; whether the router answers is not known.`,
        "- **× Not supported**: FengSui does not make these writes on a model it was not verified on.",
        `- "Router switches" are ${joinAll(switches?.en ?? [], true)}. A USB modem works only in HiLink mode, with its web interface.`,
        ...(mixed ? [`- Where a cell has more than one mark, they follow the column's parts in order: ${split.map((module) => `${module.en} is ${(module.parts?.en ?? []).join(" / ")}`).join("; ")}.`] : []),
      ]
    : [
        "表里的符号：",
        "",
        `- **○ 已验证**：有人在真机上确认过，并已写进代码（\`VERIFIED_FEATURES\`）。${verifiedModels} 的全部功能都验证过；它换了别的固件也照常工作，只发一次 \`FIRMWARE_UNVERIFIED\` 提醒。`,
        "- **△ 可能支持**：烽燧在没验证过的型号上会尝试，路由器提供就能用。其中锁频段（只锁 4G）、短信的发送与管理、重启、重拨和移动数据是实验性写入，默认锁定，要在「设置 → 设备」逐项同意后才会打开。",
        `- **? 未知**：烽燧按 ${verifiedModels} 的方式读取，要看路由器给不给。`,
        "- **× 不支持**：烽燧不在没验证过的型号上做这些写操作。",
        `- 「路由器开关」指${joinAll(switches?.zh ?? [], false)}。USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连。`,
        ...(mixed ? [`- 一格里有几个符号时，依次对应这一列包含的功能：${split.map((module) => `「${module.zh}」是${(module.parts?.zh ?? []).join(" / ")}`).join("，")}。`] : []),
      ];
  return [legend.join("\n"), ...sections].join("\n\n");
}
