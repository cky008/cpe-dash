/**
 * The router families FengSui can talk to, chosen with the router connection (Settings → Router).
 * `huawei` is the HiLink stack (the H168-383 is the verified model); every other family has its own
 * driver in `src/drivers/` and counts as a model nobody verified: it reads, and writes what FengSui
 * implements for the family (`writes` below), each as an experimental write (the write gate,
 * `src/device-access.ts`).
 *
 * Zero dependencies: the daemon, the web console and the docs build share these facts.
 */

import type { NetworkMode } from "./cellular.ts";

export const ROUTER_FAMILIES = ["huawei", "zte-goform", "zte-zwrt", "pinsu", "tozed", "fiberhome", "nradio", "openwrt"] as const;

export type RouterFamily = (typeof ROUTER_FAMILIES)[number];

/** Every family but Huawei's: the ones a driver in `src/drivers/` speaks. */
export type DriverFamily = Exclude<RouterFamily, "huawei">;

export const DRIVER_FAMILIES = ROUTER_FAMILIES.filter((f): f is DriverFamily => f !== "huawei");

/**
 * The order brand detection names a router in when it answers more than one family's signature
 * (`src/drivers/detect.ts`). NROS and ZTE's zWRT are OpenWrt underneath (they answer `/ubus` as well),
 * and NROS' module bridge answers HiLink-style paths: the family with pages or objects of its own goes
 * first, plain OpenWrt and HiLink last. A model whose notes name two families connects through the
 * first of them here unless its owner picks the other.
 */
export const DETECTION_ORDER: ReadonlyArray<RouterFamily> = ["nradio", "zte-zwrt", "fiberhome", "tozed", "pinsu", "zte-goform", "openwrt", "huawei"];

/** The brand left to FengSui in a connection test or save: told from the router's login-free answers, then stored as a family. */
export const FAMILY_AUTO = "auto";

/** What the console's brand field holds: a family, or "detect it". */
export type RouterFamilyChoice = RouterFamily | typeof FAMILY_AUTO;

export function isRouterFamily(value: unknown): value is RouterFamily {
  return typeof value === "string" && (ROUTER_FAMILIES as ReadonlyArray<string>).includes(value);
}

export function isDriverFamily(value: unknown): value is DriverFamily {
  return isRouterFamily(value) && value !== "huawei";
}

/**
 * The cellular settings FengSui writes besides the locks, each its own feature (`src/cellular.ts`).
 * They came after the H168-383 was verified, so that model's verification does not cover them: a
 * router gets one only where its family's list below names it.
 */
export const CELLULAR_WRITE_FEATURES = ["networkMode", "operatorSelect", "simSlot", "simPin", "airplaneSwitch", "roaming", "apn", "dataLimit", "trafficReset", "ussd"] as const;

export type CellularWriteFeature = (typeof CELLULAR_WRITE_FEATURES)[number];

export function isCellularWriteFeature(feature: string): feature is CellularWriteFeature {
  return (CELLULAR_WRITE_FEATURES as ReadonlyArray<string>).includes(feature);
}

/** Every write some family implements for a router nobody verified (an experimental write: sent once, read back after). */
export const FAMILY_WRITE_FEATURES = ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "antenna", "smsWrite", ...CELLULAR_WRITE_FEATURES] as const;

export type FamilyWriteFeature = (typeof FAMILY_WRITE_FEATURES)[number];

/** What a family reads and writes, and how its owner signs in. */
export interface RouterFamilyFacts {
  /** The user name the router's own login page uses (`""`: the page asks for a password only). */
  defaultUsername: string;
  /** The router's usual address, a hint for the connection form. */
  defaultAddress: string;
  /**
   * What the family reads: the read sections it implements (the others are not available on it) and
   * the status the 5 s poll reads besides the signal (`battery`, the `simCard`, `airplaneMode`).
   */
  reads: ReadonlyArray<"telemetry" | "neighbors" | "topology" | "sms" | "battery" | "simCard" | "airplaneMode">;
  /**
   * The writes FengSui implements for a router of this family that nobody verified: a driver family's
   * are what its driver sends, Huawei's are the generic HiLink writes (appendix A.11 of the protocol
   * spec, each only where the identification probe found what it reads back). A verified model
   * writes everything FengSui does.
   */
  writes: ReadonlyArray<FamilyWriteFeature>;
  /**
   * Who keeps a message's read state on this family (it reads SMS when `reads` names `sms`). Left
   * out: the router does, and FengSui follows it. `fengsui`: the family's interface cannot mark a
   * message read, or marks every message it lists, so FengSui keeps the state itself and writes none.
   */
  smsReadState?: "fengsui";
  /** Network modes the driver can switch to with a band lock. */
  networkModes: ReadonlyArray<"auto" | "lte" | "nr_sa" | "nr_nsa">;
  /** The driver can lock 5G NR bands (every driver locks LTE bands). */
  nrBandLock: boolean;
  /**
   * The network modes the family's `networkMode` write can switch a router to (`src/cellular.ts`), in
   * the order the console lists them; a router that reports its own list is offered that instead.
   */
  selectableModes?: ReadonlyArray<NetworkMode>;
  /**
   * Other forms of the family's interface, by the name the driver reports for a router that speaks
   * one (its identification's `variant`): what such a router reads and writes instead of `reads` and
   * `writes` above.
   */
  variants?: Readonly<Record<string, RouterFamilyVariant>>;
}

/**
 * A form of a family's interface some of its routers speak, with fewer of the family's features on
 * record (FiberHome's Pro series). The driver says which form a router speaks; until it has, a model on
 * record with the form (`models`) counts as speaking it.
 */
export interface RouterFamilyVariant {
  /** The models on record with this form (their name as the router reports it). */
  models: ReadonlyArray<string>;
  reads: RouterFamilyFacts["reads"];
  writes: ReadonlyArray<FamilyWriteFeature>;
}

/**
 * Connected devices (`topology`) and SMS are read where a family's interface for them is on record
 * (`docs/dev/sources.md` §18.3 and §18.4 name each source).
 */
export const ROUTER_FAMILY_FACTS: Readonly<Record<RouterFamily, RouterFamilyFacts>> = {
  huawei: { defaultUsername: "admin", defaultAddress: "192.168.8.1", reads: ["telemetry", "neighbors", "topology", "sms", "battery"], writes: ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  "zte-goform": {
    defaultUsername: "",
    defaultAddress: "192.168.0.1",
    reads: ["telemetry", "neighbors", "topology", "sms", "battery", "simCard"],
    writes: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "simSlot", "simPin", "roaming", "dataLimit", "ussd"],
    networkModes: ["auto", "lte", "nr_sa", "nr_nsa"],
    nrBandLock: true,
    selectableModes: ["auto", "nr_sa", "nr_nsa", "lte", "lte_wcdma", "wcdma"],
  },
  "zte-zwrt": {
    defaultUsername: "",
    defaultAddress: "192.168.0.1",
    reads: ["telemetry", "sms", "battery", "simCard"],
    writes: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite", "networkMode", "simSlot", "simPin", "roaming", "dataLimit"],
    networkModes: ["auto", "lte", "nr_sa", "nr_nsa"],
    nrBandLock: true,
    selectableModes: ["auto", "nr_sa", "nr_nsa", "lte", "lte_wcdma", "wcdma"],
  },
  pinsu: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry"], writes: ["bandLock", "cellLock", "reboot"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  tozed: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry", "neighbors", "sms"], writes: ["bandLock", "cellLock", "reboot", "smsWrite"], smsReadState: "fengsui", networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  fiberhome: {
    defaultUsername: "admin",
    defaultAddress: "192.168.8.1",
    reads: ["telemetry", "neighbors", "sms", "airplaneMode"],
    writes: ["bandLock", "cellLock", "reboot", "smsWrite", "networkMode", "airplaneSwitch"],
    networkModes: ["auto", "lte", "nr_sa", "nr_nsa"],
    nrBandLock: true,
    selectableModes: ["auto", "nr_sa", "nr_nsa", "lte"],
    // The Pro series (`/fh_api/`): its notes have the signal nodes, the SMS listing and marking a message read, nothing else
    variants: { pro: { models: ["LG6851F"], reads: ["telemetry", "sms"], writes: ["smsWrite"] } },
  },
  nradio: { defaultUsername: "root", defaultAddress: "192.168.66.1", reads: ["telemetry", "neighbors", "topology"], writes: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "antenna"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  openwrt: { defaultUsername: "root", defaultAddress: "192.168.1.1", reads: ["telemetry", "neighbors", "topology", "sms", "simCard", "airplaneMode"], writes: ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite"], smsReadState: "fengsui", networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
};

/**
 * The status the 5 s poll reads besides the signal (`GlobalTelemetrySnapshot.status`). They came after
 * the H168-383 was verified, and some routers lack the hardware (a CPE has no battery), so neither the
 * verified model's verification nor a model's verification by reports covers them: each is ✓ only
 * from a report of its own (`VERIFIED_FEATURES`).
 */
export const STATUS_READ_FEATURES = ["battery", "simCard", "airplaneMode"] as const;

export type StatusReadFeature = (typeof STATUS_READ_FEATURES)[number];

export function isStatusReadFeature(feature: string): feature is StatusReadFeature {
  return (STATUS_READ_FEATURES as ReadonlyArray<string>).includes(feature);
}

/** The read features and what each one is read as (a read section, or a status of the 5 s poll). */
const READ_FEATURE_SECTIONS = { telemetry: "telemetry", neighbors: "neighbors", topology: "topology", smsRead: "sms", battery: "battery", simCard: "simCard", airplaneMode: "airplaneMode" } as const;

/**
 * The form of the family's interface a router speaks (`null`: the family's own): the one its driver
 * reported (`reported`; `null` for the family's own), else, nothing reported yet, the one its model is
 * on record with. A name the family does not have counts as its own form.
 */
export function routerVariant(family: RouterFamily, reported: string | null | undefined, model?: string | null): string | null {
  const variants = ROUTER_FAMILY_FACTS[family].variants ?? {};
  if (reported !== undefined) return reported !== null && Object.keys(variants).includes(reported) ? reported : null;
  const name = model?.trim().toLowerCase();
  if (!name) return null;
  return Object.entries(variants).find(([, form]) => form.models.some((known) => known.toLowerCase() === name))?.[0] ?? null;
}

/** What a router of the family reads and writes in the form it speaks (`null`: the family's own). */
export function familyCapabilities(family: RouterFamily, variant: string | null = null): Pick<RouterFamilyFacts, "reads" | "writes"> {
  const facts = ROUTER_FAMILY_FACTS[family];
  return (variant !== null ? facts.variants?.[variant] : undefined) ?? facts;
}

/**
 * Every feature FengSui implements for a router of this family that nobody verified (in the form of
 * its interface it speaks): the reads its interface provides (signal, nearby cells, connected devices,
 * SMS) and its writes. A model is verified by reports once each of these is confirmed on a real one of
 * it (`isReportVerifiedModel`, firmware.ts).
 */
export function familyFeatures(family: RouterFamily, variant: string | null = null): Array<{ feature: keyof typeof READ_FEATURE_SECTIONS | FamilyWriteFeature; access: "read" | "write" }> {
  const facts = familyCapabilities(family, variant);
  const reads = (Object.keys(READ_FEATURE_SECTIONS) as Array<keyof typeof READ_FEATURE_SECTIONS>).filter((feature) => (facts.reads as ReadonlyArray<string>).includes(READ_FEATURE_SECTIONS[feature]));
  return [...reads.map((feature) => ({ feature, access: "read" as const })), ...facts.writes.map((feature) => ({ feature, access: "write" as const }))];
}

/** FengSui implements the feature for routers of this family (in that form of its interface; nobody verified it on a real one). */
export function familyImplements(family: RouterFamily, feature: string, variant: string | null = null): boolean {
  return familyFeatures(family, variant).some((entry) => entry.feature === feature);
}

/** The family's name as the console and the docs show it. */
export const ROUTER_FAMILY_LABELS: Readonly<Record<RouterFamily, { "zh-CN": string; en: string }>> = {
  huawei: { "zh-CN": "华为（HiLink，含博纬、鼎桥、源 Link）", en: "Huawei (HiLink, also Brovi, TD Tech, SoyeaLink)" },
  "zte-goform": { "zh-CN": "中兴（goform 网页接口）", en: "ZTE (goform web interface)" },
  "zte-zwrt": { "zh-CN": "中兴（zWRT 接口，G5 / U60 / U50 系列）", en: "ZTE (zWRT interface: G5, U60, U50 series)" },
  pinsu: { "zh-CN": "品速", en: "Pinsu" },
  tozed: { "zh-CN": "通则康威 / ZLT（含联通 VN007）", en: "Tozed / ZLT (also China Unicom VN007)" },
  fiberhome: { "zh-CN": "烽火", en: "FiberHome" },
  nradio: { "zh-CN": "鲲鹏无限（NRadio）", en: "NRadio" },
  openwrt: { "zh-CN": "OpenWrt + 移远 / 广和通模组", en: "OpenWrt with a Quectel or Fibocom module" },
};

/** Map a family hint of the stored settings (absent before 1.8.3: Huawei). */
export function routerFamilyOf(value: unknown): RouterFamily {
  return isRouterFamily(value) ? value : "huawei";
}
