import type { DeviceFeature } from "./device-profile.ts";
import { deviceIssueUrl } from "./feedback.ts";
import { UNSUPPORTED_FEATURES, type UnsupportedFeature, VERIFIED_FEATURES, VERIFIED_FIRMWARE, type VerifiedFeature, isReportVerifiedModel, isVerifiedModel, reportVerifiedModels } from "./firmware.ts";
import { DETECTION_ORDER, ROUTER_FAMILY_FACTS, ROUTER_FAMILY_LABELS, type RouterFamily, familyImplements } from "./router-family.ts";

export { UNSUPPORTED_FEATURES, type UnsupportedFeature, familyImplements };
import type { SupportedLocale } from "./types.ts";

/**
 * Every router model FengSui's interface notes record, by brand, and what FengSui does on each: the one
 * list of models (the "Supported devices" guide page is written from it, between `<!-- devices:begin -->`
 * and `<!-- devices:end -->` in docs/guide/{zh,en}/supported-devices.md; test/device-catalog.test.ts keeps
 * the pages identical to `supportedDevicesSection`, and every model of SUPPORTED_DEVICES_DOCS.md in the list).
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
  /** What the notes say of a brand FengSui has no implementation for. */
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
      zh: "资料记载这些路由器用 OpenWrt 的 LuCI RPC（`/cgi-bin/luci/rpc`）或厂商自己的网页 JSON 接口，和烽燧已有的 OpenWrt 实现（ubus + AT 指令）不是同一套。",
      en: "The notes say these routers use OpenWrt's LuCI RPC (`/cgi-bin/luci/rpc`) or the maker's own web JSON interface, not the ubus and AT commands of FengSui's OpenWrt implementation.",
    },
  },
  {
    id: "tplink",
    zh: "TP-Link",
    en: "TP-Link",
    about: {
      zh: "资料记载这些路由器用厂商自己的网页 JSON 接口（新固件带 RSA + AES 签名），烽燧还没有对应的实现。",
      en: "The notes say these routers use the maker's own web JSON interface (signed with RSA and AES on newer firmware), which FengSui has no implementation of yet.",
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

/** The models, by section, as the interface notes (cpe-specs, cpe-protocal) and SUPPORTED_DEVICES_DOCS.md list them. */
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
    ["ZLT M30S", "mobile"],
    ["ZLT M60", "mobile"],
  ]),
  ...models("fiberhome", ["fiberhome"], [
    ["LG6121F", "indoor"],
    ["LG6151M", "indoor"],
    ["LG6121", "indoor"],
    ["LG522", "indoor"],
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
    ["DWR-960", "indoor", { maker: "D-Link" }],
    ["DWR-921", "indoor", { maker: "D-Link" }],
  ]),
  ...models("tplink", [], [
    ["Archer NX200", "indoor"],
    ["NX510v", "indoor"],
    ["Deco X50-5G", "indoor"],
    ["TL-TR961 5G", "mobile", { aliases: ["TL-TR961"] }],
    ["TL-XDR3020 5G", "indoor", { aliases: ["TL-XDR3020"] }],
    ["Archer MR600", "indoor"],
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
  /** Only models of these forms. */
  forms?: ReadonlyArray<DeviceForm>;
  features: ReadonlyArray<DeviceFeature>;
  /** `condition` (the default) marks the features △, `absent` marks them —. */
  effect?: "condition" | "absent";
  zh: string;
  en: string;
}

/** The ZTE goform models that open their developer options before a lock (the driver's branches 2 and 3: `zteBranch`). */
export const ZTE_DEVELOPER_OPTION_MODELS: ReadonlyArray<string> = ["MC8020", "MC888", "MC888 Pro", "MC888S", "MC888 Ultra", "MC888D", "MC8830", "F50", "F50 Pro", "MF79U"];

export const MODEL_FACTS: ReadonlyArray<ModelFact> = [
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
  { family: "zte-zwrt", features: ["cellLock"], zh: "只能锁 5G 小区，不能锁 4G 小区", en: "locks 5G cells only, not 4G cells" },
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
  { family: "openwrt", features: ["reboot"], zh: "「重启」只重启蜂窝模组，不重启整台路由器", en: "\"Reboot\" restarts the cellular module, not the whole router" },
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
    family: "tozed",
    models: ["SRT838", "SRT853", "CPE905", "FNR310", "A50", "H80", "T1"],
    features: [],
    zh: "资料说这些机型用通则康威那套 `/cgi-bin/http.cgi` 接口，或者 `/cgi-bin/lua.cgi` 的变体；烽燧只实现了前一种",
    en: "The notes say these use Tozed's `/cgi-bin/http.cgi` interface or a `/cgi-bin/lua.cgi` variant of it; FengSui implements the first only",
  },
];

/** Features read rather than written: a verified read of one makes it ✓. */
export const READ_FEATURES: ReadonlySet<DeviceFeature> = new Set<DeviceFeature>(["telemetry", "neighbors", "topology", "smsRead"]);

interface Module {
  zh: string;
  en: string;
  features: ReadonlyArray<DeviceFeature>;
  /** How a note names each feature of a module of more than one. */
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
      (!fact.forms || (subject.form !== null && fact.forms.includes(subject.form)))
  );
}

interface FeatureMark {
  mark: SupportMark;
  /** The facts behind a △ or —. */
  facts: ModelFact[];
}

function featureMark(subject: Subject, feature: DeviceFeature, records: Records): FeatureMark {
  if (subject.names.some((name) => isVerifiedModel(name))) return { mark: "✓", facts: [] };
  const family = subject.family;
  if (family === null) return { mark: "", facts: [] };
  const access = READ_FEATURES.has(feature) ? "read" : "write";
  if (records.unsupported.some((e) => e.family === family && e.feature === feature && named(subject, e.model))) return { mark: "—", facts: [] };
  if (records.verified.some((e) => e.family === family && e.feature === feature && e.access === access && named(subject, e.model))) return { mark: "✓", facts: [] };
  const facts = factsFor(subject).filter((fact) => fact.features.includes(feature));
  const absent = facts.filter((fact) => fact.effect === "absent");
  if (absent.length > 0) return { mark: "—", facts: absent };
  if (!familyImplements(family, feature)) return { mark: "", facts: [] };
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
function moduleCell(module: Module, marks: ReadonlyArray<FeatureMark>): ModuleCell {
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
  const cells = MODULES.map((module) =>
    moduleCell(
      module,
      module.features.map((feature) => featureMark(subject, feature, records))
    )
  );
  const verifiedModel = subject.names.some((name) => isVerifiedModel(name));
  const general = verifiedModel ? [] : factsFor(subject).filter((fact) => fact.features.length === 0);
  return { subject, display, cells, general: general.map(({ zh, en }) => ({ zh, en })) };
}

function catalogSubject(entry: CatalogModel): Subject {
  return { family: primaryFamily(entry), entry, names: namesOf(entry), form: entry.form };
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
  const subject: Subject = entry ? { ...catalogSubject(entry), family } : { family, entry: null, names: [model], form: null };
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

export function deviceSupportRow(
  family: RouterFamily,
  model: string | null,
  verified: ReadonlyArray<VerifiedFeature> = VERIFIED_FEATURES,
  unsupported: ReadonlyArray<UnsupportedFeature> = UNSUPPORTED_FEATURES
): DeviceSupportRow {
  const entry = findCatalogModel(family, model);
  // Marks follow the interface the router connected through, which may be the model's second one
  const subject: Subject = entry ? { ...catalogSubject(entry), family } : { family, entry: null, names: model?.trim() ? [model.trim()] : [], form: null };
  const row = rowOf(subject, entry ? displayName(entry) : (model ?? ""), { verified, unsupported });
  const notes: Note[] = [];
  row.cells.forEach((cell, i) => {
    const module = MODULES[i];
    if (!module || (cell.mark !== "△" && cell.mark !== "—" && !cell.mixed)) return;
    for (const note of cell.notes) notes.push({ zh: `${module.zh}：${note.zh}`, en: `${module.en}: ${note.en}` });
  });
  notes.push(...row.general);
  return {
    family,
    model: entry ? displayName(entry) : null,
    section: entry?.section ?? FAMILY_SECTION[family],
    modules: MODULES.map((module, i) => ({ zh: module.zh, en: module.en, mark: row.cells[i]?.mark ?? "" })),
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
    rows.push(rowOf({ family: record.family, entry: null, names: [record.model], form: null }, record.model, records));
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
      const module = MODULES[i];
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
    ...MODULES.map((module) => module[lang]),
    lang === "zh" ? "实测反馈" : "Your results",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| :--- | :--- |${showInterface ? " :--- |" : ""} ${MODULES.map(() => ":---:").join(" | ")} | :--- |`];
  for (const row of rows) {
    if (row.cells.some((cell) => cell.mixed)) mixed = true;
    const form = row.subject.form ? FORM_LABELS[row.subject.form][lang] : "";
    const iface = interfaces(row)
      .map((f) => INTERFACE_LABELS[f][lang])
      .join(" · ");
    // Nothing left to report on a verified model, or on one reports verified
    const verified = row.subject.names.some((name) => isVerifiedModel(name)) || (row.subject.family !== null && row.subject.names.some((name) => isReportVerifiedModel(row.subject.family as RouterFamily, name, records.verified, records.unsupported)));
    const report = verified ? "" : `[${lang === "zh" ? "提交报告" : "Report"}](${deviceIssueUrl({ model: row.display, softwareVersion: null })})`;
    lines.push(`| ${[row.display, form, ...(showInterface ? [iface] : []), ...row.cells.map((cell) => cell.mark), report].join(" | ")} |`);
  }
  const notes = sectionNotes(rows, lang);
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
  const switches = MODULES.find((module) => module.features.includes("securitySwitches"))?.parts;
  const split = MODULES.filter((module) => module.features.length > 1);
  const anyUnsupported = tables.some((table) => table.unsupported);
  const legend = en
    ? [
        "What the marks mean:",
        "",
        `- **✓ Verified**: someone confirmed it on a real router, and it is recorded in the code (\`VERIFIED_FEATURES\`). Everything is verified on the ${verifiedModels}, which also works as usual on another firmware build and warns once with \`FIRMWARE_UNVERIFIED\`.${reportSentence}`,
        "- **? Waiting for a report**: FengSui implements it from the interface notes and it is on by default; nobody has confirmed it on a real router yet. Each write is sent once and read back, and you can turn each one off under Settings → Device.",
        "- **△ Partly, or with a condition**: the conditions are under each brand's table.",
        `- **— Not available**: the router or its interface does not have the feature, or someone tested it and it did not work${anyUnsupported ? "" : " (none in the table yet)"}.`,
        "- An empty cell: FengSui does not do this there yet.",
        ...(mixed ? [`- Where a cell has more than one mark, they follow the column's parts in order: ${split.map((module) => `${module.en} is ${(module.parts?.en ?? []).join(" / ")}`).join("; ")}.`] : []),
        `- "Router switches" are ${joinAll(switches?.en ?? [], true)}, where the router has them (Wi-Fi 7, for one, takes a Wi-Fi 7 router).`,
        ...(twoInterfaces ? ["- Where the Interface column names two, detection connects through the first; you can choose the other under Settings → Router."] : []),
      ]
    : [
        "表里的符号：",
        "",
        `- **✓ 已验证**：有人在真机上确认过，并已登记进代码（\`VERIFIED_FEATURES\`）。${verifiedModels} 的全部功能都验证过；它换了别的固件也照常工作，只发一次 \`FIRMWARE_UNVERIFIED\` 提醒。${reportSentence}`,
        "- **? 等待回报**：烽燧按接口资料实现了，默认开启，还没有人在真机上确认。写入每次只发一次，写后回读核对，可以在「设置 → 设备」逐项关闭。",
        "- **△ 部分支持或有条件**：条件写在各品牌的表下面。",
        `- **— 不支持**：路由器或它的接口没有这项功能，或者有人实测过不能用${anyUnsupported ? "" : "（表里暂时还没有）"}。`,
        "- 空白：烽燧还没有做。",
        ...(mixed ? [`- 一格里有几个符号时，依次对应这一列包含的功能：${split.map((module) => `「${module.zh}」是${(module.parts?.zh ?? []).join(" / ")}`).join("，")}。`] : []),
        `- 「路由器开关」指${joinAll(switches?.zh ?? [], false)}，路由器本身有这些功能才谈得上（比如 Wi-Fi 7 要路由器支持 Wi-Fi 7）。`,
        ...(twoInterfaces ? ["- 「接口」一列有两套时，自动识别选第一套；你也可以在「设置 → 路由器」手动选另一套。"] : []),
      ];
  const contents = `${en ? "Brands: " : "按品牌查看："}${CATALOG_SECTIONS.map((section) => `[${section[lang]}](#brand-${section.id})`).join(" · ")}`;
  return [legend.join("\n"), contents, ...tables.map((table) => table.text)].join("\n\n");
}
