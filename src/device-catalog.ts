import { deviceIssueUrl } from "./feedback.ts";
import { UNSUPPORTED_FEATURES, type UnsupportedFeature, VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isReportVerifiedModel, isVerifiedModel, reportVerifiedModels } from "./firmware.ts";
import { type DeviceFeature, FEATURE_COLUMNS, type FeatureColumn, featureAccess, isCellularWriteFeature, isStatusReadFeature } from "./features.ts";
import { DETECTION_ORDER, ROUTER_FAMILY_FACTS, ROUTER_FAMILY_LABELS, type RouterFamily, familyImplements, routerVariant } from "./router-family.ts";
import type { SupportedLocale } from "./types.ts";

/**
 * Every router model FengSui's interface notes record, by brand, and what FengSui does on each: the one
 * list of models (the "Supported devices" guide page is written from it, between `<!-- devices:begin -->`
 * and `<!-- devices:end -->` in docs/guide/{zh,en}/supported-devices.md; test/device-catalog.test.ts keeps
 * the pages identical to `supportedDevicesSection`, and every model of docs/dev/device-notes.md in the list).
 *
 * A cell's mark comes from three layers, in this order: what FengSui implements for the interface the
 * model connects through (the brand's facts, `ROUTER_FAMILY_FACTS`); what is particular to the model
 * (`MODEL_FACTS`: a condition makes the cell △, an absence —); and what someone verified on a real router
 * (`VERIFIED_FEATURES` makes it ✓, `UNSUPPORTED_FEATURES` —). A cell FengSui has nothing for stays empty.
 * The daemon gives the console the row of the router it talks to (`deviceSupportRow`); the table itself
 * stays on the documentation site.
 *
 * The Huawei HiLink models of the "Tested on" list of Salamek/huawei-lte-api (README at df87e5f,
 * 2026-08-13) are in the list too (facts only, none of its code; the guide credits it once, on "Other
 * models and brands").
 */

/** ✓ verified, ? implemented and on by default (waiting for a report), △ partial or conditional, — not available; `""`: FengSui has nothing for it yet. */
export type SupportMark = "✓" | "?" | "△" | "—" | "";

/**
 * How the model is built: an indoor or outdoor CPE, a mobile router (the only kind with a battery), a USB
 * modem, a cellular module (in an OpenWrt router) or an industrial gateway.
 */
export type DeviceForm = "indoor" | "outdoor" | "mobile" | "usb" | "module" | "gateway";

/** A section of the page: one brand, or several sold on one interface. */
export interface CatalogSection {
  id: "huawei" | "brovi" | "td-tech" | "soyealink" | "zte" | "pinsu" | "tozed" | "fiberhome" | "nradio" | "openwrt" | "reference" | "dlink" | "tplink";
  zh: string;
  en: string;
  /** What the notes say of the models FengSui has no implementation for: the whole brand, or the rows of it left empty. */
  about?: { zh: string; en: string };
}

export type CatalogSectionId = CatalogSection["id"];

export const CATALOG_SECTIONS: ReadonlyArray<CatalogSection> = [
  { id: "huawei", zh: "华为", en: "Huawei" },
  { id: "brovi", zh: "博纬（华为智选）", en: "Brovi" },
  { id: "td-tech", zh: "鼎桥", en: "TD Tech" },
  { id: "soyealink", zh: "源 Link", en: "SoyeaLink" },
  { id: "zte", zh: "中兴", en: "ZTE" },
  { id: "pinsu", zh: "品速", en: "Pinsu" },
  { id: "tozed", zh: "通则康威 / ZLT（含联通 VN007）", en: "Tozed / ZLT (also China Unicom VN007)" },
  { id: "fiberhome", zh: "烽火", en: "FiberHome" },
  { id: "nradio", zh: "鲲鹏无限（NRadio）", en: "NRadio" },
  { id: "openwrt", zh: "OpenWrt + 移远 / 广和通模组", en: "OpenWrt with a Quectel or Fibocom module" },
  { id: "reference", zh: "展锐 / 高通公版方案", en: "UNISOC and Qualcomm reference designs" },
  {
    id: "dlink",
    zh: "D-Link",
    en: "D-Link",
    about: {
      zh: "资料记载这几款用 OpenWrt 的 LuCI 接口，公开资料里找不到它们读取信号的接口，烽燧还没有实现；其中 DWR-2000M 的管理页只走 HTTPS，它的蜂窝模组接口对管理账号是关着的",
      en: "The notes say these use OpenWrt's LuCI interface, and no public record names how they report the signal, so FengSui has no implementation for them yet; the DWR-2000M's page is HTTPS only, and its cellular module's interface is closed to the admin account",
    },
  },
  {
    id: "tplink",
    zh: "TP-Link",
    en: "TP-Link",
    about: {
      zh: "这两款是 TP-Link 国内版的管理页，公开资料里找不到它读取蜂窝信号的接口，烽燧还没有实现",
      en: "These two have the page of TP-Link's China models, and no public record names how it reports the cellular signal, so FengSui has no implementation for them yet",
    },
  },
];

/** The section a model only known from a report goes under: the brand of the interface it connected through. */
const FAMILY_SECTION: Readonly<Record<RouterFamily, CatalogSectionId>> = {
  huawei: "huawei",
  "zte-goform": "zte",
  "zte-zwrt": "zte",
  pinsu: "pinsu",
  tozed: "tozed",
  fiberhome: "fiberhome",
  nradio: "nradio",
  dlink: "dlink",
  tplink: "tplink",
  openwrt: "openwrt",
};

export interface CatalogModel {
  section: CatalogSectionId;
  /** Who makes it, shown before the model where a section lists several makers. */
  maker?: string;
  model: string;
  /** What the router reports itself as when that differs from the name it is sold under (shown in brackets). */
  code?: string;
  /** Other names the router may report: recognised, not shown. */
  aliases?: ReadonlyArray<string>;
  /** The interfaces its notes name (none: FengSui has no implementation for it). Brand detection picks the first in `DETECTION_ORDER`. */
  families: ReadonlyArray<RouterFamily>;
  form: DeviceForm;
}

type Spec = [model: string, form: DeviceForm, extra?: Partial<Pick<CatalogModel, "maker" | "code" | "aliases" | "families">>];

function models(section: CatalogSectionId, families: ReadonlyArray<RouterFamily>, list: ReadonlyArray<Spec>): CatalogModel[] {
  return list.map(([model, form, extra]) => ({ section, model, form, families, ...extra }));
}

const ZTE_BOTH: ReadonlyArray<RouterFamily> = ["zte-zwrt", "zte-goform"];
const FIBOCOM = { maker: "Fibocom" } as const;
const QUECTEL = { maker: "Quectel" } as const;

/** The models, by section, as the interface notes (cpe-specs, cpe-protocal) and docs/dev/device-notes.md list them. */
export const DEVICE_CATALOG: ReadonlyArray<CatalogModel> = [
  ...models("huawei", ["huawei"], [
    ["H168-383", "indoor"],
    ["H165-383", "indoor"],
    ["H158-381", "indoor"],
    ["H155-381", "indoor"],
    ["H155-382", "indoor"],
    ["H155-383", "indoor"],
    ["H153-381", "indoor"],
    ["H138-380", "indoor"],
    ["H122-373", "indoor"],
    ["H112-373", "indoor"],
    ["H112-372", "indoor"],
    ["H112-370", "indoor"],
    ["H352-381", "outdoor"],
    ["H312-371", "outdoor"],
    ["N5368X", "outdoor"],
    ["B818-263", "indoor"],
    ["B818-260", "indoor"],
    ["B715s-23c", "indoor"],
    ["B628-265", "indoor"],
    ["B628-350", "indoor"],
    ["B618s-22d", "indoor"],
    ["B618s-65d", "indoor"],
    ["B612-233", "indoor"],
    ["B612s-25d", "indoor"],
    ["B535-836", "indoor"],
    ["B535-232", "indoor"],
    ["B528s-23a", "indoor", { aliases: ["B528s"] }],
    ["B525s-23a", "indoor"],
    ["B525s-65a", "indoor"],
    ["B316-855", "indoor"],
    ["B315s-22", "indoor"],
    ["B315s-936", "indoor"],
    ["B311-221", "indoor"],
    ["B311-521", "indoor"],
    ["B311As-853", "indoor"],
    ["B311B-853", "indoor"],
    ["B310s-22", "indoor"],
    ["B310s-927", "indoor"],
    ["B310As-852", "indoor"],
    ["E5180s-22", "indoor"],
    ["E5186s-22a", "indoor"],
    ["E6888-982", "mobile"],
    ["E6878-370", "mobile"],
    ["E6878-870", "mobile"],
    ["E5885Ls-93a", "mobile"],
    ["E5785-320", "mobile"],
    ["E5785Lh-22c", "mobile"],
    ["E5577Cs-321", "mobile"],
    ["E5576-320", "mobile"],
    ["E5576-855", "mobile"],
    ["E5573s-320", "mobile"],
    ["E8231", "usb"],
    ["E8372h-153", "usb"],
    ["E8372h-320", "usb"],
    ["E8372h-608", "usb"],
    ["E3372", "usb"],
    ["E3372h-153", "usb"],
    ["E3131", "usb"],
    ["E3531", "usb"],
    ["E5530As-2", "usb"],
  ]),
  ...models("brovi", ["huawei"], [
    ["H155-380", "indoor"],
    ["H151-370", "indoor"],
  ]),
  ...models("td-tech", ["huawei"], [
    ["MT5710-CN", "gateway"],
    ["MH5000-31", "gateway"],
    ["MH5000-82M", "gateway"],
    ["MT5700M-CN", "module"],
  ]),
  ...models("soyealink", ["huawei"], [
    ["B535-333", "indoor"],
    ["B535-932", "indoor"],
    ["B628-540", "indoor"],
    ["SLT869-A51", "indoor", { aliases: ["SLT869"] }],
    ["SRT873", "indoor"],
  ]),
  ...models("zte", ["zte-goform"], [
    ["U60 Pro", "mobile", { code: "MU5250", families: ZTE_BOTH }],
    ["G5 Ultra", "indoor", { code: "MC8530", families: ZTE_BOTH }],
    ["G5 Ultra", "indoor", { code: "MC8531", families: ZTE_BOTH }],
    ["G5 Pro", "indoor", { code: "MC8512", families: ZTE_BOTH }],
    ["G5TS", "indoor", { code: "MC8520", aliases: ["G5 TS"], families: ZTE_BOTH }],
    ["G5F", "indoor", { families: ZTE_BOTH }],
    ["MC888D", "indoor", { families: ZTE_BOTH }],
    ["U50 Pro", "mobile", { code: "MU5120", families: ZTE_BOTH }],
    ["MC8510", "indoor"],
    ["G5C", "indoor"],
    ["G5B", "indoor"],
    ["MC888 Ultra", "indoor"],
    ["MC888 Pro", "indoor"],
    ["MC888", "indoor"],
    ["MC888S", "indoor"],
    ["MC8020", "indoor"],
    ["MC801A", "indoor"],
    ["MC801A1", "indoor"],
    ["MC801", "indoor"],
    ["MC889 Pro", "outdoor"],
    ["MC889A Pro", "outdoor"],
    ["MC889", "outdoor"],
    ["MC7010", "outdoor"],
    ["MC7010D", "outdoor"],
    ["MC8830", "gateway"],
    ["MU5001", "mobile"],
    ["MU5001A", "mobile"],
    ["MU5001U", "mobile"],
    ["MU5002", "mobile"],
    ["MU510", "mobile"],
    ["U50", "mobile"],
    ["U50S", "mobile"],
    ["U30 Air", "mobile"],
    ["U10S Pro", "mobile"],
    ["F50 Pro", "mobile"],
    ["F50", "mobile"],
    ["MF971R", "mobile"],
    ["MF935", "mobile"],
    ["MF920U", "mobile"],
    ["MF79U", "usb"],
    ["MF297D", "indoor"],
    ["MF289F", "indoor"],
    ["MF286", "indoor"],
    ["MF286A", "indoor"],
    ["MF286C", "indoor"],
    ["MF286D", "indoor"],
    ["MF286R", "indoor"],
    ["MF283+", "indoor"],
    ["MF283U", "indoor"],
    ["MF253S", "indoor"],
  ]),
  ...models("pinsu", ["pinsu"], [
    ["R200C", "indoor"],
    ["R200", "indoor"],
    ["R200P", "indoor"],
    ["R100", "indoor"],
    ["PS-R500", "indoor"],
    ["PS-R600", "indoor"],
    ["U200", "mobile"],
    ["M1", "mobile"],
    ["M200", "mobile"],
    ["M200 Pro", "mobile"],
    ["PS-M50", "mobile"],
    ["F10", "mobile"],
  ]),
  ...models("tozed", ["tozed"], [
    ["VN007", "indoor"],
    ["VN007+", "indoor"],
    ["VN009", "indoor"],
    ["ZLT X20", "indoor"],
    ["ZLT X21", "indoor"],
    ["ZLT X21G", "indoor"],
    ["ZLT X25", "indoor"],
    ["ZLT X28", "indoor"],
    ["ZLT X28 Pro", "indoor"],
    ["ZLT X30", "indoor"],
    ["ZLT X100", "indoor"],
    ["ZLT X300M", "indoor"],
    ["LT500", "indoor"],
    ["ZLT S10", "indoor"],
    ["ZLT S10G", "indoor"],
    ["ZLT S12 Pro", "indoor"],
    ["ZLT S20", "indoor"],
    ["ZLT S25", "indoor"],
    ["ZLT S50", "indoor"],
    ["ZLT X11", "outdoor"],
    ["ZLT P11", "outdoor"],
    ["ZLT P28", "outdoor"],
    ["ZLT T30", "outdoor"],
    ["ZLT T20", "gateway"],
    ["MP510", "gateway"],
    // One note has the M30S on the http.cgi interface, a field report on ZTE's (its reqproc spelling): both are named
    ["ZLT M30S", "mobile", { families: ["tozed", "zte-goform"] }],
    ["ZLT M60", "mobile"],
    // A ZXIC-platform 4G router: ZTE's interface in its reqproc spelling, not http.cgi
    ["ZLT T10D MAX", "indoor", { families: ["zte-goform"] }],
  ]),
  ...models("fiberhome", ["fiberhome"], [
    ["LG6121F", "indoor"],
    ["LG6151M", "indoor"],
    ["LG6121", "indoor"],
    ["LG522", "indoor"],
    // The Pro series: the same calls under `/fh_api/`, another key (ROUTER_FAMILY_FACTS.fiberhome.variants)
    ["LG6851F", "indoor"],
  ]),
  ...models("nradio", ["nradio"], [
    ["C8-668GL", "indoor"],
    ["C8-660", "indoor"],
    ["C8-620", "indoor"],
    ["C8-520", "indoor"],
    ["C8-500", "indoor"],
    ["C5800-500", "indoor"],
    ["C2000 Ultra", "indoor"],
    ["C2000 Max", "indoor"],
    ["C2000 Pro", "indoor"],
    ["C2000", "indoor"],
    ["C3000", "gateway"],
    ["C5000", "gateway"],
    ["C5200", "gateway"],
    ["C9100", "outdoor"],
  ]),
  ...models("openwrt", ["openwrt"], [
    ["RM551E-GL", "module", QUECTEL],
    ["RM530N-GL", "module", QUECTEL],
    ["RM520N-GL", "module", QUECTEL],
    ["RM520N-CN", "module", QUECTEL],
    ["RM521F-GL", "module", QUECTEL],
    ["RM510Q-GL", "module", QUECTEL],
    ["RM505Q-AE", "module", QUECTEL],
    ["RM502Q-AE", "module", QUECTEL],
    ["RM502Q-GL", "module", QUECTEL],
    ["RM500Q-GL", "module", QUECTEL],
    ["RM500Q-AE", "module", QUECTEL],
    ["RM500U-CN", "module", QUECTEL],
    ["RG650E", "module", QUECTEL],
    ["RG650V", "module", QUECTEL],
    ["RG520N-EU", "module", QUECTEL],
    ["RG520N-EB", "module", QUECTEL],
    ["RG520N-CN", "module", QUECTEL],
    ["RG502Q-EA", "module", QUECTEL],
    ["RG501Q-EU", "module", QUECTEL],
    ["RG500Q-EA", "module", QUECTEL],
    ["RG500Q-CN", "module", QUECTEL],
    ["RG500U-CN", "module", QUECTEL],
    ["RG200U-CN", "module", QUECTEL],
    ["EM160R-GL", "module", QUECTEL],
    ["EM12-G", "module", QUECTEL],
    ["EC25", "module", QUECTEL],
    ["EC200U", "module", QUECTEL],
    ["FG370", "module", FIBOCOM],
    ["FG370-NA", "module", FIBOCOM],
    ["FM350-GL", "module", FIBOCOM],
    ["FM160-CN", "module", FIBOCOM],
    ["FM160-EAU", "module", FIBOCOM],
    ["FG160-EAU", "module", FIBOCOM],
    ["FM150-AE", "module", FIBOCOM],
    ["FG150-AE", "module", FIBOCOM],
    ["FM650-CN", "module", FIBOCOM],
    ["L860-GL", "module", FIBOCOM],
    ["L850-GL", "module", FIBOCOM],
    ["GL-X3000", "indoor", { maker: "GL.iNet" }],
    ["GL-XE3000", "mobile", { maker: "GL.iNet" }],
    ["GL-X750V2", "indoor", { maker: "GL.iNet" }],
    ["GL-XE300", "mobile", { maker: "GL.iNet" }],
    ["O1", "indoor", { maker: "Suncomm" }],
    ["O2", "indoor", { maker: "Suncomm" }],
    ["O8 Pro", "indoor", { maker: "Suncomm" }],
    ["CP520", "indoor", { maker: "Kunlun" }],
    ["OpenWrt 5G CPE", "indoor", { maker: "Kunlun" }],
    ["OpenWrt 5G CPE", "indoor", { maker: "Zhilian" }],
    ["OpenWrt 5G CPE", "indoor", { maker: "Trend-Link" }],
    ["RM520N", "indoor", { maker: "QWRT" }],
    ["5G", "indoor", { maker: "ROOter" }],
  ]),
  ...models("reference", ["tozed"], [
    ["V510 mgdb", "indoor", { maker: "UNISOC", aliases: ["V510"], families: ["pinsu"] }],
    ["SRT838", "indoor"],
    ["SRT853", "indoor"],
    ["CPE905", "indoor"],
    ["FNR310", "indoor"],
    ["A50", "indoor"],
    ["H80", "indoor"],
    ["T1", "indoor"],
  ]),
  ...models("dlink", [], [
    ["DWR-2000M", "indoor", { maker: "D-Link" }],
    ["DWR-2101", "mobile", { maker: "D-Link" }],
    ["DWR-953V2", "indoor", { maker: "D-Link" }],
    ["DWR-960", "indoor", { maker: "D-Link", families: ["dlink"] }],
    ["DWR-961", "indoor", { maker: "D-Link", families: ["dlink"] }],
  ]),
  ...models("tplink", [], [
    ["Archer NX200", "indoor", { families: ["tplink"] }],
    ["NX510v", "indoor", { families: ["tplink"], aliases: ["Archer NX510v"] }],
    ["NX540v", "indoor", { families: ["tplink"], aliases: ["Archer NX540v"] }],
    ["Archer NX205", "indoor", { families: ["tplink"] }],
    ["Archer NX505", "indoor", { families: ["tplink"] }],
    ["Archer NX600", "indoor", { families: ["tplink"] }],
    ["Archer NX200-Outdoor", "outdoor", { families: ["tplink"] }],
    ["NE200-Outdoor", "outdoor", { families: ["tplink"] }],
    ["Archer MX1500", "indoor", { families: ["tplink"] }],
    ["Archer MX700", "indoor", { families: ["tplink"] }],
    ["MX515v", "indoor", { families: ["tplink"] }],
    ["Archer MR550", "indoor", { families: ["tplink"] }],
    ["Archer MR500-Outdoor", "outdoor", { families: ["tplink"] }],
    ["M8550", "mobile", { families: ["tplink"] }],
    ["Deco X50-5G", "indoor", { families: ["tplink"], aliases: ["X50-5G"] }],
    ["TL-TR961 5G", "mobile", { aliases: ["TL-TR961"] }],
    ["TL-XDR3020 5G", "indoor", { aliases: ["TL-XDR3020"] }],
    ["Archer MR600", "indoor", { families: ["tplink"] }],
    ["Archer MR402", "indoor", { families: ["tplink"] }],
    ["Archer MR402-Outdoor", "outdoor", { families: ["tplink"] }],
    ["Archer MR202", "indoor", { families: ["tplink"] }],
    ["TL-MR100-Outdoor", "outdoor", { families: ["tplink"] }],
    ["TL-MR110-Outdoor", "outdoor", { families: ["tplink"] }],
    ["TL-MR101", "indoor", { families: ["tplink"] }],
    ["TL-MR108", "indoor", { families: ["tplink"] }],
    ["Archer MR400", "indoor", { families: ["tplink"] }],
    ["TL-MR100", "indoor", { families: ["tplink"] }],
    ["TL-MR105", "indoor", { families: ["tplink"] }],
    ["TL-MR150", "indoor", { families: ["tplink"] }],
    ["TL-MR6400", "indoor", { families: ["tplink"] }],
    ["TL-MR6500v", "indoor", { families: ["tplink"] }],
  ]),
];

/**
 * What is particular to some models (or every model of an interface): a condition (the cells of its
 * features show △), something they do not have (—), or, with no features, a note under the brand's
 * table. The generator writes each one under the table where it applies; nothing model-specific is
 * written into the generator itself.
 */
export interface ModelFact {
  family: RouterFamily;
  /** Only these models (their name, code or an alias); none: every model connecting through `family`. */
  models?: ReadonlyArray<string>;
  /**
   * Only routers speaking this form of the family's interface (`ROUTER_FAMILY_FACTS[family].variants`),
   * or with `null` only those speaking the family's own form.
   */
  variant?: string | null;
  /** Only models of these forms. */
  forms?: ReadonlyArray<DeviceForm>;
  features: ReadonlyArray<DeviceFeature>;
  /** `condition` (the default) marks the features △, `absent` marks them —. */
  effect?: "condition" | "absent";
  zh: string;
  en: string;
}

/** The models on record with ZTE's interface in its `reqproc` spelling (the ZXIC 4G firmware). */
export const ZTE_REQPROC_MODELS: ReadonlyArray<string> = ["ZLT T10D MAX", "ZLT M30S"];

/** The ZTE goform models that open their developer options before a lock (the driver's branches 2 and 3: `zteBranch`). */
export const ZTE_DEVELOPER_OPTION_MODELS: ReadonlyArray<string> = ["MC8020", "MC888", "MC888 Pro", "MC888S", "MC888 Ultra", "MC888D", "MC8830", "F50", "F50 Pro", "MF79U"];

/** The forms that have no battery (only a mobile router carries one). */
const NO_BATTERY_FORMS: ReadonlyArray<DeviceForm> = ["indoor", "outdoor", "usb", "module", "gateway"];

/** One fact per brand that reads a battery: the forms without one show — there. */
const NO_BATTERY_FACTS: ReadonlyArray<ModelFact> = (["huawei", "zte-goform", "zte-zwrt"] as const).map((family) => ({
  family,
  forms: NO_BATTERY_FORMS,
  features: ["battery"],
  effect: "absent",
  zh: "只有随身路由器有电池",
  en: "only a mobile router has a battery",
}));

/** How FengSui signs in to the Archer routers, in both forms of their interface (the Deco line shows none of this before a login). */
const TPLINK_ARCHER_SESSION: ReadonlyArray<ModelFact> = ([null, "ex"] as const).map((variant) => ({
  family: "tplink",
  variant,
  features: [],
  zh: "登录和每个请求都按路由器管理页自己的方式加密。固件用的是哪一代加密，烽燧在发送密码之前从路由器给出的密钥和页面脚本里读出来，认不出时不发送密码。路由器同一时间只让一个人登录管理页：你登录着的时候烽燧会让位，登录页显示已锁定时烽燧不登录，每次读完也会注销",
  en: "The login and every request are encrypted the way the router's own page does it. Which generation of it a firmware uses is read off the key the router hands out and its page's script before the password is sent; where FengSui cannot tell, it sends no password. The router lets one person into its page at a time: FengSui yields while you are signed in, stays away while the login page shows a lock, and signs out after every read",
}));

export const MODEL_FACTS: ReadonlyArray<ModelFact> = [
  ...NO_BATTERY_FACTS,
  {
    family: "openwrt",
    features: ["simCard"],
    zh: "PIN 和 PUK 的剩余次数只有移远模组报告（`AT+QPINC`）；广和通模组只报告卡是否可用",
    en: "only a Quectel module reports the PIN and PUK tries left (`AT+QPINC`); a Fibocom one reports whether the card is usable",
  },
  {
    family: "huawei",
    features: ["bandLock"],
    zh: "只锁 4G 频段，5G 频段烽燧只在验证过的型号上锁",
    en: "locks 4G (LTE) bands only; FengSui locks 5G bands on a verified model only",
  },
  {
    family: "huawei",
    features: ["neighbors"],
    zh: "烽燧读的是 H168-383 的附近基站接口，路由器没有这个接口时这一项是空的",
    en: "FengSui reads the H168-383's nearby-cells endpoint; a router without it leaves this empty",
  },
  { family: "huawei", forms: ["usb"], features: [], zh: "USB 上网卡要在 HiLink 模式（有网页管理界面）下才能连", en: "A USB modem connects only in HiLink mode, with its web interface" },
  {
    family: "zte-goform",
    features: [],
    zh: "锁小区要重启路由器后才生效，解除也一样；烽燧不会替你重启，所以重启前读回的是设置，断网 3 分钟后的自动解锁同样要等重启",
    en: "A cell lock takes effect once the router restarts, and so does its removal; FengSui does not restart it for you, so until then the lock reads back as set, and the 3-minute rollback's unlock waits for a restart too",
  },
  {
    family: "zte-zwrt",
    features: [],
    zh: "解除锁小区之后，要切换一次网络制式或重启路由器，才会回到原来的小区；烽燧不会替你做",
    en: "After a cell lock is removed, the router goes back to the cell it would choose once the network mode is switched or it restarts; FengSui does neither for you",
  },
  {
    family: "zte-zwrt",
    models: ["G5TS"],
    features: ["cellLock"],
    zh: "4G 小区可能锁不上：有项目实测它的接口不接受 4G 小区锁定；5G 小区可以锁",
    en: "a 4G cell lock may be refused: a project found its interface takes none; 5G cells lock",
  },
  {
    family: "zte-goform",
    features: [],
    zh: "短信读写的是路由器自己的存储，存在 SIM 卡上的短信不显示",
    en: "SMS is read from and written to the router's own storage; messages kept on the SIM card are not shown",
  },
  {
    family: "zte-goform",
    models: ZTE_REQPROC_MODELS,
    features: ["bandLock", "cellLock"],
    zh: "这类 4G 固件的接口资料里没有锁频段和锁小区的指令，烽燧发的是中兴 goform 页面的写法，路由器不一定接受；网络制式只能设成自动或仅 4G",
    en: "the notes on this 4G firmware name no band lock or cell lock, so FengSui sends the forms of ZTE's goform pages, which the router may not take; the network mode can be automatic or 4G only",
  },
  {
    family: "zte-goform",
    models: ZTE_REQPROC_MODELS,
    features: [],
    zh: "这是中兴芯片平台的 4G 路由器，用的是中兴接口的另一种写法（`/reqproc/`），连接时烽燧会自己认出来",
    en: "A 4G router on ZTE's chip platform: it uses another spelling of ZTE's interface (`/reqproc/`), which FengSui recognises when it connects",
  },
  {
    family: "zte-zwrt",
    features: [],
    zh: "短信读写的是路由器自己的存储，存在 SIM 卡上的短信不显示",
    en: "SMS is read from and written to the router's own storage; messages kept on the SIM card are not shown",
  },
  {
    family: "zte-goform",
    models: ZTE_DEVELOPER_OPTION_MODELS,
    features: ["bandLock", "cellLock"],
    zh: "锁定前，烽燧会先用同一个管理密码打开路由器的开发者选项，并在这次写入的记录里写明",
    en: "before the lock FengSui opens the router's developer options with the same admin password, and names it in the write's record",
  },
  {
    family: "nradio",
    features: ["bandLock"],
    zh: "锁 5G 频段要路由器的蜂窝模组报告它的 5G 频段设置，不报告的型号只能锁 4G 频段",
    en: "locking 5G bands needs the cellular module to report its 5G band setting; a model that does not locks 4G bands only",
  },
  {
    family: "fiberhome",
    variant: null,
    features: ["smsRead"],
    zh: "短信走的是路由器网页自己的加密接口，烽燧用它已经登录的会话去读；路由器要求另外登录网页才给读时，这一项是空的",
    en: "SMS is on the encrypted interface of the router's own web page, which FengSui asks in the session it is signed in with; a router that wants a separate web sign-in for it leaves this empty",
  },
  {
    family: "fiberhome",
    variant: null,
    features: ["smsWrite"],
    zh: "发送只接受英文字母、数字和常用标点（接口资料里只有这一种编码），并且不发送含 ` $ \" \\ 的正文：路由器会把正文交给命令行；删除只能整段对话一起删",
    en: "sends plain English text only (letters, digits and common punctuation: the one encoding on record), and never text with a backquote, a dollar sign, a double quote or a backslash, because the router hands the text to a command line; deletes a whole conversation at a time",
  },
  {
    family: "fiberhome",
    variant: "pro",
    features: [],
    zh: "这是烽火的 Pro 系列：同一套网页接口换了路径（`/fh_api/`）和加密密钥，连接时烽燧会自己认出来。烽燧在它上面读信号（只有一个服务小区）、本月流量和短信，能把短信标为已读；附近的基站、锁频段、锁小区和重启在它的接口资料里没有，烽燧在这里不做",
    en: "FiberHome's Pro series: the same web interface under another path (`/fh_api/`) with another encryption key, which FengSui recognises when it connects. FengSui reads its signal (one serving cell), this month's traffic and SMS there, and can mark messages read; nearby cells, band lock, cell lock and reboot are not in its interface notes, so FengSui does not do them here",
  },
  {
    family: "fiberhome",
    variant: "pro",
    features: ["smsWrite"],
    zh: "只能标为已读：这类固件的接口资料里没有发送和删除短信的写法",
    en: "marks messages read only: this firmware's interface notes have no way to send or delete one",
  },
  {
    family: "fiberhome",
    variant: "pro",
    features: ["telemetry"],
    zh: "烽燧用路由器下发的令牌（用这个系列固件里固定的私钥解开）或资料里记的令牌打开路由器的加密应答；两者都打不开时，烽燧不发送密码，信号这一项是空的",
    en: "FengSui opens the router's encrypted answers with the token the router hands out (unsealed with the key fixed in this series' firmware) or the token on record; where neither opens them, FengSui sends no password and this stays empty",
  },
  {
    family: "tozed",
    features: ["smsWrite"],
    zh: "能发送短信；路由器的接口资料里没有删除短信和标为已读的指令，这两项烽燧在这里不能做",
    en: "sends messages; the router's interface has no command on record to delete a message or to mark one read, so FengSui can do neither here",
  },
  {
    family: "tozed",
    features: [],
    zh: "哪些短信没读过由烽燧自己记（路由器上的未读标记烽燧改不了）",
    en: "FengSui keeps track of what you have not read (it cannot change the router's own unread mark)",
  },
  { family: "openwrt", features: ["reboot"], zh: "「重启」只重启蜂窝模组，不重启整台路由器", en: "\"Reboot\" restarts the cellular module, not the whole router" },
  {
    family: "openwrt",
    features: ["reconnect", "mobileData"],
    zh: "重拨和移动数据开关用的是 QModem 自己的拨号接口，要路由器装有 QModem；没有装的固件上烽燧不发任何拨号指令",
    en: "redial and the mobile data switch use QModem's own dial calls, so they need QModem on the router; on firmware without it FengSui sends no dial command",
  },
  {
    family: "openwrt",
    features: ["smsWrite"],
    zh: "发送短信要路由器装有 QModem；没有装的固件上，烽燧能读取和删除短信，不能发送",
    en: "sending needs QModem on the router; on firmware without it FengSui reads and deletes messages but cannot send",
  },
  {
    family: "openwrt",
    features: [],
    zh: "短信读的是蜂窝模组当前选用的存储（SIM 卡或模组自身）。模组一列出短信就把它记成已读，所以哪些短信没读过由烽燧自己记；模组不保存发出的短信，发件只留在烽燧里",
    en: "SMS is read from the storage the cellular module is set to (the SIM card or the module's own). The module marks a message read as soon as it lists it, so FengSui keeps track of what you have not read; the module keeps no copy of what it sends, so sent messages are kept by FengSui only",
  },
  {
    family: "openwrt",
    models: ["FG370", "FG370-NA", "FM350-GL", "FM160-CN", "FM160-EAU", "FG160-EAU", "FM150-AE", "FG150-AE", "FM650-CN", "L860-GL", "L850-GL"],
    features: ["bandLock"],
    zh: "广和通模组的网络制式只能设成自动或仅 5G 独立组网（SA）",
    en: "a Fibocom module's network mode can be set to automatic or 5G standalone (SA) only",
  },
  {
    family: "openwrt",
    features: [],
    zh: "烽燧通过路由器的 ubus 接口给模组发 AT 指令，自己分辨移远和广和通",
    en: "FengSui sends AT commands to the module through the router's ubus interface and tells Quectel from Fibocom itself",
  },
  { family: "tozed", features: [], zh: "有些运营商定制固件给接口加了一层加密，烽燧连不上这样的固件", en: "Some operator builds wrap the interface in a layer of encryption; FengSui cannot connect to those" },
  {
    family: "tplink",
    variant: null,
    features: ["telemetry"],
    zh: "读得到服务小区的信号和频段。频点、PCI 和小区号只在带「锁小区」页面的固件上、注册在 4G 时读得到（路由器自己的状态页也是这样）；载波聚合时第二个载波只报告频段",
    en: "reads the serving cell's signal and band. Its channel, PCI and cell identity are read only on firmware whose page has a cell lock, while registered on 4G (as the router's own status page does); under carrier aggregation the second carrier is named by its band alone",
  },
  {
    family: "tplink",
    variant: null,
    features: ["bandLock"],
    zh: "只能选 4G 频段。路由器的管理页只列出它搜到的频段；烽燧不做这次搜索，直接写入你选的频段",
    en: "selects 4G bands only. The router's page lists the bands a search of its own found; FengSui does not run that search and writes the bands you choose",
  },
  {
    family: "tplink",
    variant: null,
    features: ["cellLock"],
    zh: "只有管理页带「锁小区」的固件才有（TP-Link 官方模拟器里 Archer MR600 v5 有、v3 没有），只能锁 4G 小区；没有的固件上烽燧会拒绝并说明，不发送任何请求",
    en: "only on firmware whose page has a cell lock (in TP-Link's own emulators the Archer MR600 v5 has one, the v3 has none), and for 4G cells only; on firmware without it FengSui refuses and says so, sending nothing",
  },
  {
    family: "tplink",
    variant: "ex",
    features: ["bandLock"],
    zh: "频段从路由器列出的支持频段里选（4G，5G 机型还有 5G），一起写入",
    en: "bands are chosen from the ones the router lists (4G, and 5G on a 5G model), written together",
  },
  {
    family: "tplink",
    variant: "ex",
    features: ["cellLock"],
    zh: "只有管理页带「锁小区」的固件才有（路由器管理页自己的脚本写明了有没有：TP-Link 官方模拟器里 NX540v 有）；4G 小区和 5G 独立组网（SA）小区各有一把锁，5G 非独立组网下不能锁小区；没有的固件上烽燧会拒绝并说明，不发送任何请求",
    en: "only on firmware whose page has a cell lock (the router's own page script says whether: in TP-Link's emulators the NX540v has one); a 4G cell and a 5G standalone cell each have a lock of their own, and a 5G cell cannot be locked in non-standalone mode; on firmware without it FengSui refuses and says so, sending nothing",
  },
  ...([null, "ex"] as const).map(
    (variant): ModelFact => ({
      family: "tplink",
      variant,
      features: ["antenna"],
      zh: "只在固件带天线切换时提供（路由器管理页自己的脚本写明了有没有：官方模拟器里 NX540v 有、Archer MR600 没有），只有内置和外置两种；管理页要重启路由器才能切换的机型上，烽燧不切换",
      en: "only where the firmware has the antenna switch (the router's own page script says whether: in TP-Link's emulators the NX540v has it, the Archer MR600 has not), between internal and external only; on a model whose page restarts the router to switch, FengSui does not switch",
    })
  ),
  ...([null, "ex"] as const).map(
    (variant): ModelFact => ({
      family: "tplink",
      variant,
      features: ["operatorSelect"],
      zh: "只能选路由器最近一次搜网列出的运营商：先搜网，再选",
      en: "only an operator the router's last search listed can be chosen: search first, then choose",
    })
  ),
  {
    family: "tplink",
    variant: null,
    features: ["networkMode"],
    zh: "有三种：4G 优先（自动）、仅 4G、仅 3G；管理页只在 SIM 卡可用时才改，烽燧也一样",
    en: "three modes: 4G preferred (automatic), 4G only, 3G only; the page changes it only with a usable SIM card, and so does FengSui",
  },
  {
    family: "tplink",
    features: ["simCard"],
    zh: "轮询里只报告 SIM 卡的状态（在不在、要不要 PIN）；PIN 的剩余次数在写入 PIN 之前当场读取",
    en: "the poll reports the SIM card's state only (whether it is there, whether it wants its PIN); the tries a PIN has left are read right before a PIN is written",
  },
  {
    family: "tplink",
    variant: "ex",
    features: ["smsRead"],
    zh: "只读收件箱：这种写法的接口资料里没有已发短信的读法，烽燧发出的短信留在烽燧里",
    en: "reads the inbox only: the notes on this form have no read for sent messages, so what FengSui sends is kept by FengSui",
  },
  {
    family: "tplink",
    variant: "deco",
    features: ["telemetry"],
    zh: "只读得到蜂窝模组的信号（RSRP、RSRQ、SINR、RSSI）、网络制式和已用流量：这套接口不报告频段、频点和小区，也不报告运营商名",
    en: "reads the modem's signal (RSRP, RSRQ, SINR, RSSI), the network type and the data used only: this interface reports no band, channel or cell, and no operator name",
  },
  {
    family: "tplink",
    variant: "deco",
    features: [],
    zh: "这是 Deco 系列自己的接口，连接时烽燧会自己认出来。它的管理页里没有短信；重启只重启带蜂窝模组的那一台主机。登录前路由器不说有没有人登录着，所以烽燧在这里没法让位",
    en: "The Deco line's own interface, which FengSui recognises when it connects. Its page has no SMS; a restart restarts the main unit, the one with the modem. The router does not say before a login whether someone is signed in, so FengSui cannot yield here",
  },
  {
    family: "tplink",
    variant: "ex",
    features: [],
    zh: "这是 TP-Link 较新的机型用的写法（每个请求一条 JSON），连接时烽燧会自己认出来",
    en: "The form TP-Link's newer models use (one JSON action per request), which FengSui recognises when it connects",
  },
  ...TPLINK_ARCHER_SESSION,
  {
    family: "pinsu",
    features: [],
    zh: "管理页的接口里没有型号，烽燧里它们都叫「Pinsu」：设备报告和「设置 → 设备」里的型号都是这个名字",
    en: "Their page's interface names no model, so FengSui calls each of them \"Pinsu\": that is the model in the device report and under Settings → Device",
  },
  {
    family: "pinsu",
    features: [],
    zh: "管理页的接口不报告是否联网：锁频段、锁小区或改网络制式之后断网，烽燧看不出来，不会在 3 分钟后自动改回，自愈也没法重拨；断网了请在烽燧里手动改回",
    en: "Their page's interface does not report whether the router is connected: if a band or cell lock or a change of network mode cuts the internet, FengSui cannot tell, so it does not put the setting back after 3 minutes and self-healing cannot redial; undo it in FengSui by hand",
  },
  {
    family: "tplink",
    models: ["TL-MR6400"],
    features: [],
    zh: "v7 的管理页登录时不加密（用户名和密码用路由器的 RSA 公钥加密，请求不加密），烽燧还不会这种登录：连接时会说明原因，不发送密码；v5 和其他 MR 型号一样",
    en: "The v7's page signs in without the encryption (the user name and the password under the router's RSA key, every request in plain text), a login FengSui does not speak yet: it says so when connecting and sends no password; the v5 signs in as the other MR models do",
  },
  {
    family: "dlink",
    features: ["telemetry"],
    zh: "只读得到 4G 服务小区的频段、频点和信号，路由器的接口不报告 PCI，也没有载波聚合的读数",
    en: "reads the 4G serving cell's band, channel and signal only; the router's interface reports no PCI and no carrier aggregation",
  },
  {
    family: "dlink",
    features: ["simCard"],
    zh: "只报告 SIM 卡在不在，不报告 PIN 的状态和剩余次数",
    en: "reports whether a SIM card is there, not the state of its PIN or the tries left",
  },
  {
    family: "dlink",
    features: ["smsRead"],
    zh: "只读收件箱：路由器存的已发短信在接口资料里没有读法，烽燧发出的短信留在烽燧里",
    en: "reads the inbox only: the notes have no read for the messages the router keeps of what it sent, so what FengSui sends is kept by FengSui",
  },
  {
    family: "dlink",
    features: ["reconnect", "mobileData"],
    zh: "用的是管理页的「连接 / 断开」按钮：路由器设成自动拨号时，断开之后它可能自己重新连上",
    en: "uses the page's connect and disconnect button: a router set to dial by itself may connect again after a disconnect",
  },
  {
    family: "dlink",
    features: ["apn"],
    zh: "改的是路由器正在用的那一个接入点；IP 类型保持路由器原来的设置",
    en: "changes the one access point the router uses; the IP type stays as the router has it",
  },
  {
    family: "dlink",
    features: [],
    zh: "路由器同一时间只让一个人登录管理页：你登录着的时候烽燧会让位，烽燧每次读完也会注销。登录密码按路由器登录页自己的写法发送，烽燧认不出登录页的写法时不发送密码",
    en: "The router lets one person into its page at a time: FengSui yields while you are signed in, and signs out after every read. The password is sent in the form the router's own login page writes it; where FengSui does not know the page's form it sends no password",
  },
  {
    family: "tozed",
    models: ["SRT838", "SRT853", "CPE905", "FNR310", "A50", "H80", "T1"],
    features: [],
    zh: "资料说这些机型用通则康威那套 `/cgi-bin/http.cgi` 接口，或者 `/cgi-bin/lua.cgi` 的变体；烽燧只实现了前一种",
    en: "The notes say these use Tozed's `/cgi-bin/http.cgi` interface or a `/cgi-bin/lua.cgi` variant of it; FengSui implements the first only",
  },
];

const FORM_LABELS: Readonly<Record<DeviceForm, { zh: string; en: string }>> = {
  indoor: { zh: "室内 CPE", en: "Indoor CPE" },
  outdoor: { zh: "室外 CPE", en: "Outdoor CPE" },
  mobile: { zh: "随身路由器", en: "Mobile router" },
  usb: { zh: "USB 上网卡", en: "USB modem" },
  module: { zh: "模组", en: "Module" },
  gateway: { zh: "工业网关", en: "Industrial gateway" },
};

/** The interface a model connects through, as the table's Interface column names it. */
const INTERFACE_LABELS: Readonly<Record<RouterFamily, { zh: string; en: string }>> = {
  huawei: { zh: "HiLink", en: "HiLink" },
  "zte-goform": { zh: "goform", en: "goform" },
  "zte-zwrt": { zh: "zWRT", en: "zWRT" },
  pinsu: { zh: "品速", en: "Pinsu" },
  tozed: { zh: "通则康威", en: "Tozed" },
  fiberhome: { zh: "烽火", en: "FiberHome" },
  nradio: { zh: "NROS", en: "NROS" },
  dlink: { zh: "D-Link 网页接口", en: "D-Link web interface" },
  tplink: { zh: "TP-Link 网页接口", en: "TP-Link web interface" },
  openwrt: { zh: "ubus + AT", en: "ubus + AT" },
};

// ── Names ────────────────────────────────────────────────────────────────────

/** How a model is matched: case, spaces and the maker's name before it aside. */
function normalize(name: string): string {
  return name.toUpperCase().replace(/\s+/g, "");
}

/** The model as the table shows it: maker, name and, in brackets, what the router reports itself as. */
export function displayName(entry: Pick<CatalogModel, "maker" | "model" | "code">): string {
  return `${entry.maker ? `${entry.maker} ` : ""}${entry.model}${entry.code ? ` (${entry.code})` : ""}`;
}

function namesOf(entry: CatalogModel): string[] {
  return [entry.model, displayName(entry), ...(entry.code ? [entry.code] : []), ...(entry.aliases ?? [])];
}

/** The model goes by this name (its name, maker and name, code or an alias). */
export function catalogMatches(entry: CatalogModel, name: string): boolean {
  const wanted = normalize(name);
  return wanted !== "" && namesOf(entry).some((known) => normalize(known) === wanted);
}

/** The interface brand detection connects the model through: the first of its interfaces in `DETECTION_ORDER`. */
export function primaryFamily(entry: Pick<CatalogModel, "families">): RouterFamily | null {
  return DETECTION_ORDER.find((family) => entry.families.includes(family)) ?? null;
}

/** The catalog's entry for a router of `family` that reports `model` (its own interface first), or `null`. */
export function findCatalogModel(family: RouterFamily, model: string | null | undefined): CatalogModel | null {
  if (!model?.trim()) return null;
  const candidates = DEVICE_CATALOG.filter((entry) => catalogMatches(entry, model));
  return candidates.find((entry) => entry.families.includes(family)) ?? null;
}

// ── Marks ────────────────────────────────────────────────────────────────────

/** The model (or a router not in the list) a mark is worked out for. */
interface Subject {
  family: RouterFamily | null;
  /** The catalog entry, or `null` for a router the list does not have. */
  entry: CatalogModel | null;
  /** Names a report may give it (a router not in the list: what it reports). */
  names: ReadonlyArray<string>;
  form: DeviceForm | null;
  /** The form of its family's interface it speaks (`null`: the family's own). */
  variant: string | null;
}

/**
 * A model as the marks see it through `family`: in the form of the interface its driver reported
 * (`reported`), else the one any of its names is on record with.
 */
function subjectOf(family: RouterFamily | null, entry: CatalogModel | null, names: ReadonlyArray<string>, form: DeviceForm | null, reported?: string | null): Subject {
  const variant = family === null ? null : reported !== undefined ? routerVariant(family, reported) : (names.map((name) => routerVariant(family, undefined, name)).find((v) => v !== null) ?? null);
  return { family, entry, names, form, variant };
}

interface Records {
  verified: ReadonlyArray<VerifiedFeature>;
  unsupported: ReadonlyArray<UnsupportedFeature>;
}

function named(subject: Subject, name: string): boolean {
  return subject.entry ? catalogMatches(subject.entry, name) : subject.names.some((known) => normalize(known) === normalize(name));
}

/** The facts that apply to the subject (on its interface, its model and form). */
function factsFor(subject: Subject): ModelFact[] {
  return MODEL_FACTS.filter(
    (fact) =>
      fact.family === subject.family &&
      (!fact.models || fact.models.some((name) => named(subject, name))) &&
      (fact.variant === undefined || fact.variant === subject.variant) &&
      (!fact.forms || (subject.form !== null && fact.forms.includes(subject.form)))
  );
}

interface FeatureMark {
  mark: SupportMark;
  /** The facts behind a △ or —. */
  facts: ModelFact[];
}

function featureMark(subject: Subject, feature: DeviceFeature, records: Records): FeatureMark {
  // The verified model's verification covers what FengSui read and wrote then; the status reads came
  // later (marked from the facts), and so did the cellular settings: the ones checked on it are filed
  // (✓, or — where it lacks one), the rest it has no write for
  const verifiedModel = subject.names.some((name) => isVerifiedModel(name));
  if (verifiedModel && !isCellularWriteFeature(feature) && !isStatusReadFeature(feature)) return { mark: "✓", facts: [] };
  const family = subject.family;
  if (family === null) return { mark: "", facts: [] };
  const access = featureAccess(feature);
  if (records.unsupported.some((e) => e.family === family && e.feature === feature && named(subject, e.model))) return { mark: "—", facts: [] };
  if (records.verified.some((e) => e.family === family && e.feature === feature && e.access === access && named(subject, e.model))) return { mark: "✓", facts: [] };
  if (verifiedModel && isCellularWriteFeature(feature)) return { mark: "", facts: [] };
  const facts = factsFor(subject).filter((fact) => fact.features.includes(feature));
  const absent = facts.filter((fact) => fact.effect === "absent");
  if (absent.length > 0) return { mark: "—", facts: absent };
  if (!familyImplements(family, feature, subject.variant)) return { mark: "", facts: [] };
  return facts.length > 0 ? { mark: "△", facts } : { mark: "?", facts: [] };
}

/** A note under a table: a condition of some cells, or something said of the models it names. */
interface Note {
  zh: string;
  en: string;
}

interface ModuleCell {
  mark: SupportMark;
  /** Why the cell is △ or —: the facts, and a module done in part. */
  notes: Note[];
  /** Its features' marks differ (all of them set): the cell lists them in order. */
  mixed: boolean;
}

/**
 * A module's cell: one mark when its features agree; △ when FengSui does some of them and nothing yet
 * for the others (a note names which); else each feature's mark in order (`✓/?`).
 */
function moduleCell(module: FeatureColumn, marks: ReadonlyArray<FeatureMark>): ModuleCell {
  const notes: Note[] = [];
  for (const { facts } of marks) for (const fact of facts) if (!notes.some((n) => n.zh === fact.zh)) notes.push({ zh: fact.zh, en: fact.en });
  const set = [...new Set(marks.map((m) => m.mark))];
  if (set.length === 1) return { mark: set[0] ?? "", notes, mixed: false };
  if (marks.some((m) => m.mark === "")) {
    const done = module.features.map((_, i) => i).filter((i) => marks[i]?.mark !== "");
    const missing = module.features.map((_, i) => i).filter((i) => marks[i]?.mark === "");
    const part = (lang: "zh" | "en", list: number[]): string => joinAll(list.map((i) => module.parts?.[lang][i] ?? ""), lang === "en");
    notes.push({
      zh: `只有${part("zh", done)}，${part("zh", missing)}烽燧在这里还没有做`,
      en: `${part("en", done)} only; FengSui does not do ${part("en", missing)} here yet`,
    });
    return { mark: "△", notes, mixed: false };
  }
  return { mark: marks.map((m) => m.mark).join("/") as SupportMark, notes, mixed: true };
}

/** `a, b and c` / `a、b和c` (a space between 和 and a Latin word, as the Chinese guide writes it). */
function joinAll(items: ReadonlyArray<string>, en: boolean): string {
  if (items.length < 2) return items.join("");
  const head = items.slice(0, -1).join(en ? ", " : "、");
  const last = items.at(-1) ?? "";
  if (en) return `${head} and ${last}`;
  return `${head}${/[ -~]$/.test(head) ? " " : ""}和${/^[ -~]/.test(last) ? " " : ""}${last}`;
}

interface Row {
  subject: Subject;
  display: string;
  cells: ModuleCell[];
  /** Notes about the model that change no mark. */
  general: Note[];
}

function rowOf(subject: Subject, display: string, records: Records): Row {
  const cells = FEATURE_COLUMNS.map((module) =>
    moduleCell(
      module,
      module.features.map((feature) => featureMark(subject, feature, records))
    )
  );
  const verifiedModel = subject.names.some((name) => isVerifiedModel(name));
  const general = verifiedModel ? [] : factsFor(subject).filter((fact) => fact.features.length === 0);
  return { subject, display, cells, general: general.map(({ zh, en }) => ({ zh, en })) };
}

/** A catalog model through `family` (by default the interface brand detection picks for it). */
function catalogSubject(entry: CatalogModel, family: RouterFamily | null = primaryFamily(entry), reported?: string | null): Subject {
  return subjectOf(family, entry, namesOf(entry), entry.form, reported);
}

/**
 * A feature's mark on a catalog model (by its name as the table shows it, or a name the router reports),
 * through the interface brand detection picks; a model the list lacks gets its brand's defaults.
 */
export function supportMark(
  family: RouterFamily,
  model: string,
  feature: DeviceFeature,
  verified: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES,
  unsupported: ReadonlyArray<UnsupportedFeature> = UNSUPPORTED_FEATURES
): SupportMark {
  const entry = DEVICE_CATALOG.find((e) => e.families.includes(family) && (displayName(e) === model || catalogMatches(e, model))) ?? null;
  const subject = entry ? catalogSubject(entry, family) : subjectOf(family, null, [model], null);
  return featureMark(subject, feature, { verified, unsupported }).mark;
}

// ── The row the console shows ────────────────────────────────────────────────

/** One router's row, as the daemon hands it to Settings → Device (`GET /api/device/profile`). */
export interface DeviceSupportRow {
  family: RouterFamily;
  /** The model as the table names it; `null` when the list does not have it (the brand's defaults apply). */
  model: string | null;
  /** The page's section, `brand-<section>` its anchor. */
  section: CatalogSectionId;
  modules: Array<{ zh: string; en: string; mark: SupportMark }>;
  /** The conditions of its △ and — cells, then what else the list says of it. */
  notes: Note[];
}

/**
 * The row of the router in use: by its brand and model, in the form of the brand's interface its driver
 * reported (`variant`; left out: the one the model is on record with).
 */
export function deviceSupportRow(
  family: RouterFamily,
  model: string | null,
  options: { variant?: string | null; verified?: ReadonlyArray<VerifiedFeature>; unsupported?: ReadonlyArray<UnsupportedFeature> } = {}
): DeviceSupportRow {
  const verified = options.verified ?? VERIFIED_FEATURES;
  const unsupported = options.unsupported ?? UNSUPPORTED_FEATURES;
  const entry = findCatalogModel(family, model);
  // Marks follow the interface the router connected through, which may be the model's second one
  const subject = entry ? catalogSubject(entry, family, options.variant) : subjectOf(family, null, model?.trim() ? [model.trim()] : [], null, options.variant);
  const row = rowOf(subject, entry ? displayName(entry) : (model ?? ""), { verified, unsupported });
  const notes: Note[] = [];
  row.cells.forEach((cell, i) => {
    const module = FEATURE_COLUMNS[i];
    if (!module || (cell.mark !== "△" && cell.mark !== "—" && !cell.mixed)) return;
    for (const note of cell.notes) notes.push({ zh: `${module.zh}：${note.zh}`, en: `${module.en}: ${note.en}` });
  });
  notes.push(...row.general);
  return {
    family,
    model: entry ? displayName(entry) : null,
    section: entry?.section ?? FAMILY_SECTION[family],
    modules: FEATURE_COLUMNS.map((module, i) => ({ zh: module.zh, en: module.en, mark: row.cells[i]?.mark ?? "" })),
    notes,
  };
}

// ── The page ─────────────────────────────────────────────────────────────────

type Lang = "zh" | "en";

/** How the section's routers are reached: their usual address, how to sign in, the brand to choose. */
function sectionIntro(section: CatalogSection, families: ReadonlyArray<RouterFamily>, lang: Lang): string {
  if (families.length === 0) {
    const about = section.about ? ` ${section.about[lang]}` : "";
    return lang === "zh"
      ? `烽燧还没有这个品牌的实现：「设置 → 路由器」里选不到它，自动识别也认不出来，所以表里整行留空。${about.trim()}有这里的路由器，也欢迎提交实测报告。`
      : `FengSui has no implementation for this brand yet: you cannot choose it under Settings → Router and detection does not recognise it, so its rows are empty.${about} If you have one of these routers, a report still helps.`;
  }
  const address = [...new Set(families.map((f) => ROUTER_FAMILY_FACTS[f].defaultAddress))];
  const users = [...new Set(families.map((f) => ROUTER_FAMILY_FACTS[f].defaultUsername))];
  const labels = families.map((f) => `「${ROUTER_FAMILY_LABELS[f]["zh-CN"]}」`);
  const labelsEn = families.map((f) => `"${ROUTER_FAMILY_LABELS[f].en}"`);
  const where = address.map((a) => `\`${a}\``);
  if (lang === "zh") {
    const login = users.length === 1 && users[0] === "" ? "只用管理密码登录（没有用户名）" : users.length === 1 ? `用管理页的用户名 \`${users[0]}\` 和密码登录` : "用管理页的用户名和密码登录";
    return `常见地址 ${where.join(" 或 ")}，${login}。在「设置 → 路由器」把品牌留在「自动识别」，或者选${labels.join("或")}。`;
  }
  const login = users.length === 1 && users[0] === "" ? "sign in with the admin password (there is no user name)" : users.length === 1 ? `sign in with the user name \`${users[0]}\` and the admin password` : "sign in with the user name and password of the router's page";
  return `Usually at ${where.join(" or ")}; ${login}. Leave the brand on "Detect automatically" under Settings → Router, or choose ${labelsEn.join(" or ")}.`;
}

function rowsOfSection(section: CatalogSectionId, records: Records): Row[] {
  const rows = DEVICE_CATALOG.filter((entry) => entry.section === section).map((entry) => rowOf(catalogSubject(entry), displayName(entry), records));
  // A model only a report names (verified or not working) gets a row under its brand
  for (const record of [...VERIFIED_FIRMWARE.map((e) => ({ family: "huawei" as const, model: e.model })), ...records.verified, ...records.unsupported]) {
    if (FAMILY_SECTION[record.family] !== section) continue;
    if (DEVICE_CATALOG.some((entry) => entry.families.includes(record.family) && catalogMatches(entry, record.model))) continue;
    if (rows.some((row) => row.subject.entry === null && row.subject.family === record.family && named(row.subject, record.model))) continue;
    rows.push(rowOf(subjectOf(record.family, null, [record.model], null), record.model, records));
  }
  return rows;
}

/** `a, b` or `every model but a` / `every model in this table`, for a note that applies to some of the rows. */
function appliesTo(all: ReadonlyArray<Row>, rows: ReadonlyArray<Row>, lang: Lang): string {
  if (rows.length === all.length) return lang === "zh" ? "这一节的全部型号" : "every model in this table";
  const others = all.filter((row) => !rows.includes(row));
  if (rows.length > others.length && others.length <= 5) {
    const list = joinAll(others.map((row) => row.display), lang === "en");
    return lang === "zh" ? `除 ${list} 外的全部型号` : `every model but the ${list}`;
  }
  return joinAll(rows.map((row) => row.display), lang === "en");
}

/** The notes under a section's table, each once with the models (and columns) it applies to. */
function sectionNotes(rows: ReadonlyArray<Row>, lang: Lang): string[] {
  const groups = new Map<string, { note: Note; modules: string[]; rows: Row[]; mark: "△" | "—" | null }>();
  const add = (note: Note, row: Row, module: string | null, mark: "△" | "—" | null): void => {
    const key = `${mark ?? ""}|${note.zh}`;
    const group = groups.get(key) ?? { note, modules: [], rows: [], mark };
    if (module && !group.modules.includes(module)) group.modules.push(module);
    if (!group.rows.includes(row)) group.rows.push(row);
    groups.set(key, group);
  };
  for (const row of rows) {
    row.cells.forEach((cell, i) => {
      const module = FEATURE_COLUMNS[i];
      if (!module || (cell.mark !== "△" && cell.mark !== "—" && !cell.mixed)) return;
      for (const note of cell.notes) add(note, row, lang === "zh" ? module.zh : module.en, cell.mark === "—" ? "—" : "△");
    });
    for (const note of row.general) add(note, row, null, null);
  }
  return [...groups.values()].map(({ note, modules, rows: applied, mark }) => {
    const scope = appliesTo(rows, applied, lang);
    if (mark === null) return lang === "zh" ? `- ${note.zh}（${scope}）。` : `- ${note.en} (${scope}).`;
    const columns = modules.map((m) => (lang === "zh" ? `「${m}」` : m)).join(lang === "zh" ? "、" : ", ");
    return lang === "zh" ? `- ${mark} ${columns}：${note.zh}（${scope}）。` : `- ${mark} ${columns}: ${note.en} (${scope}).`;
  });
}

function sectionTable(section: CatalogSection, records: Records, lang: Lang): { text: string; mixed: boolean; twoInterfaces: boolean; unsupported: boolean } {
  const rows = rowsOfSection(section.id, records);
  const families = DETECTION_ORDER.filter((family) => rows.some((row) => (row.subject.entry ? row.subject.entry.families.includes(family) : row.subject.family === family)));
  const interfaces = (row: Row): ReadonlyArray<RouterFamily> => (row.subject.entry ? DETECTION_ORDER.filter((f) => row.subject.entry?.families.includes(f)) : row.subject.family ? [row.subject.family] : []);
  const showInterface = new Set(rows.map((row) => interfaces(row).join(","))).size > 1;
  const twoInterfaces = rows.some((row) => interfaces(row).length > 1);
  let mixed = false;
  const header = [
    lang === "zh" ? "型号" : "Model",
    lang === "zh" ? "形态" : "Form",
    ...(showInterface ? [lang === "zh" ? "接口" : "Interface"] : []),
    ...FEATURE_COLUMNS.map((module) => module[lang]),
    lang === "zh" ? "实测反馈" : "Your results",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| :--- | :--- |${showInterface ? " :--- |" : ""} ${FEATURE_COLUMNS.map(() => ":---:").join(" | ")} | :--- |`];
  for (const row of rows) {
    if (row.cells.some((cell) => cell.mixed)) mixed = true;
    const form = row.subject.form ? FORM_LABELS[row.subject.form][lang] : "";
    const iface = interfaces(row)
      .map((f) => INTERFACE_LABELS[f][lang])
      .join(" · ");
    // Nothing left to report on a verified model, or on one reports verified
    const verified = row.subject.names.some((name) => isVerifiedModel(name)) || (row.subject.family !== null && row.subject.names.some((name) => isReportVerifiedModel(row.subject.family as RouterFamily, name, records.verified, records.unsupported, row.subject.variant)));
    const report = verified ? "" : `[${lang === "zh" ? "提交报告" : "Report"}](${deviceIssueUrl({ model: row.display, softwareVersion: null })})`;
    lines.push(`| ${[row.display, form, ...(showInterface ? [iface] : []), ...row.cells.map((cell) => cell.mark), report].join(" | ")} |`);
  }
  const notes = sectionNotes(rows, lang);
  // The rows left empty next to implemented ones: what the notes say of those models
  const unbuilt = rows.filter((row) => interfaces(row).length === 0);
  if (section.about && families.length > 0 && unbuilt.length > 0) notes.push(lang === "zh" ? `- ${section.about.zh}（${appliesTo(rows, unbuilt, lang)}）。` : `- ${section.about.en} (${appliesTo(rows, unbuilt, lang)}).`);
  const parts = [`<a id="brand-${section.id}"></a>`, "", `## ${section[lang]}`, "", sectionIntro(section, families, lang), "", lines.join("\n")];
  if (notes.length > 0) parts.push("", lang === "zh" ? "这一节的说明：" : "Notes for this table:", "", notes.join("\n"));
  if (section.id === "zte") parts.unshift('<a id="brands"></a>', "");
  return { text: parts.join("\n"), mixed, twoInterfaces, unsupported: rows.some((row) => row.cells.some((cell) => cell.mark.includes("—"))) };
}

/**
 * The page's generated part: what the marks mean, the brands, then one section per brand (how its routers
 * are reached, a row per model with a mark per console module and where to report it, and the notes behind
 * its △ and — cells).
 */
export function supportedDevicesSection(
  locale: SupportedLocale,
  verified: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES,
  unsupported: ReadonlyArray<UnsupportedFeature> = UNSUPPORTED_FEATURES
): string {
  const lang: Lang = locale === "en" ? "en" : "zh";
  const en = lang === "en";
  const records: Records = { verified, unsupported };
  const tables = CATALOG_SECTIONS.map((section) => sectionTable(section, records, lang));
  const mixed = tables.some((table) => table.mixed);
  const twoInterfaces = tables.some((table) => table.twoInterfaces);
  const verifiedModels = joinAll([...new Set(VERIFIED_FIRMWARE.map((entry) => entry.model))], en);
  const byReports = reportVerifiedModels(verified, unsupported).map((entry) => {
    const found = DEVICE_CATALOG.find((e) => e.families.includes(entry.family) && catalogMatches(e, entry.model));
    return found ? displayName(found) : entry.model;
  });
  const reportSentence = byReports.length === 0 ? "" : en ? ` Reports confirmed every feature FengSui does on the ${joinAll(byReports, true)}, which therefore count as verified too.` : `${joinAll(byReports, false)} 上烽燧做的每项功能都有真机报告确认过，也算验证过的型号。`;
  const switches = FEATURE_COLUMNS.find((module) => module.features.includes("securitySwitches"))?.parts;
  const split = FEATURE_COLUMNS.filter((module) => module.features.length > 1);
  const anyUnsupported = tables.some((table) => table.unsupported);
  // The columns of the status reads and the cellular settings, which the verified model's verification does not cover
  const later = FEATURE_COLUMNS.filter((module) => module.features.every((feature) => isStatusReadFeature(feature) || isCellularWriteFeature(feature)));
  const laterZh = later.map((module) => `「${module.zh}」`).join("、");
  const laterEn = joinAll(later.map((module) => module.en), true);
  const legend = en
    ? [
        "What the marks mean:",
        "",
        `- **✓ Verified**: someone confirmed it on a real router, and it is recorded in the code (\`VERIFIED_FEATURES\`). Everything is verified on the ${verifiedModels} but the ${laterEn} columns (added later: readings are marked from the facts like any other model, and a write only once it was checked on a real one and recorded; FengSui does not do the others there yet); it also works as usual on another firmware build and warns once with \`FIRMWARE_UNVERIFIED\`.${reportSentence}`,
        "- **? Waiting for a report**: FengSui implements it from the interface notes and it is on by default; nobody has confirmed it on a real router yet. Each write is sent once and read back, and you can turn each one off under Settings → Device.",
        "- **△ Partly, or with a condition**: the conditions are under each brand's table.",
        `- **— Not available**: the router or its interface does not have the feature (a CPE has no battery), or someone tested it and it did not work${anyUnsupported ? "" : " (no such report in the table yet)"}.`,
        "- An empty cell: FengSui does not do this there yet.",
        ...(mixed ? [`- Where a cell has more than one mark, they follow the column's parts in order: ${split.map((module) => `${module.en} is ${(module.parts?.en ?? []).join(" / ")}`).join("; ")}.`] : []),
        `- "Router switches" are ${joinAll(switches?.en ?? [], true)}, where the router has them (Wi-Fi 7, for one, takes a Wi-Fi 7 router).`,
        ...(twoInterfaces ? ["- Where the Interface column names two, detection connects through the first; you can choose the other under Settings → Router."] : []),
      ]
    : [
        "表里的符号：",
        "",
        `- **✓ 已验证**：有人在真机上确认过，并已登记进代码（\`VERIFIED_FEATURES\`）。${verifiedModels} 上除了${laterZh}这几列（后来加的：读数和其他型号一样按事实标；写入只标在它上面真机核对过、登记过的，其余烽燧在它上面还没有做），全部功能都验证过；它换了别的固件也照常工作，只发一次 \`FIRMWARE_UNVERIFIED\` 提醒。${reportSentence}`,
        "- **? 等待回报**：烽燧按接口资料实现了，默认开启，还没有人在真机上确认。写入每次只发一次，写后回读核对，可以在「设置 → 设备」逐项关闭。",
        "- **△ 部分支持或有条件**：条件写在各品牌的表下面。",
        `- **— 不支持**：路由器或它的接口没有这项功能（比如室内 CPE 没有电池），或者有人实测过不能用${anyUnsupported ? "" : "（实测不能用的，表里暂时还没有）"}。`,
        "- 空白：烽燧还没有做。",
        ...(mixed ? [`- 一格里有几个符号时，依次对应这一列包含的功能：${split.map((module) => `「${module.zh}」是${(module.parts?.zh ?? []).join(" / ")}`).join("，")}。`] : []),
        `- 「路由器开关」指${joinAll(switches?.zh ?? [], false)}，路由器本身有这些功能才谈得上（比如 Wi-Fi 7 要路由器支持 Wi-Fi 7）。`,
        ...(twoInterfaces ? ["- 「接口」一列有两套时，自动识别选第一套；你也可以在「设置 → 路由器」手动选另一套。"] : []),
      ];
  const contents = `${en ? "Brands: " : "按品牌查看："}${CATALOG_SECTIONS.map((section) => `[${section[lang]}](#brand-${section.id})`).join(" · ")}`;
  return [legend.join("\n"), contents, ...tables.map((table) => table.text)].join("\n\n");
}
