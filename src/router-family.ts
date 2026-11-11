/**
 * The router families FengSui can talk to, chosen with the router connection (Settings → Router).
 * `huawei` is the HiLink stack (the H168-383 is the verified model); every other family has its own
 * driver in `src/drivers/` and counts as a model nobody verified: it reads, and writes what FengSui
 * implements for the family (`writes` below), each as an experimental write (the write gate,
 * `src/device-access.ts`).
 *
 * Zero dependencies: the daemon, the web console and the docs build share these facts.
 */

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

/** Every write some family implements for a router nobody verified (an experimental write: sent once, read back after). */
export const FAMILY_WRITE_FEATURES = ["bandLock", "cellLock", "reboot", "reconnect", "mobileData", "smsWrite"] as const;

export type FamilyWriteFeature = (typeof FAMILY_WRITE_FEATURES)[number];

/** What a family reads and writes, and how its owner signs in. */
export interface RouterFamilyFacts {
  /** The user name the router's own login page uses (`""`: the page asks for a password only). */
  defaultUsername: string;
  /** The router's usual address, a hint for the connection form. */
  defaultAddress: string;
  /** Read sections the family implements (the others are not available on it). */
  reads: ReadonlyArray<"telemetry" | "neighbors" | "topology" | "sms">;
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
}

/**
 * Connected devices (`topology`) stay the HiLink stack's: no other family documents its device list
 * in a format FengSui could read without guessing. SMS is read and written where a family's interface
 * for it is on record (`docs/PHASE2_ARCHITECTURE_REPORT.md` §18.3 names each source).
 */
export const ROUTER_FAMILY_FACTS: Readonly<Record<RouterFamily, RouterFamilyFacts>> = {
  huawei: { defaultUsername: "admin", defaultAddress: "192.168.8.1", reads: ["telemetry", "neighbors", "topology", "sms"], writes: ["bandLock", "reboot", "reconnect", "mobileData", "smsWrite"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  "zte-goform": { defaultUsername: "", defaultAddress: "192.168.0.1", reads: ["telemetry", "neighbors", "sms"], writes: ["bandLock", "cellLock", "reboot", "smsWrite"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  "zte-zwrt": { defaultUsername: "", defaultAddress: "192.168.0.1", reads: ["telemetry", "sms"], writes: ["bandLock", "cellLock", "reboot", "smsWrite"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  pinsu: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry"], writes: ["bandLock", "cellLock", "reboot"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  tozed: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry", "neighbors", "sms"], writes: ["bandLock", "cellLock", "reboot", "smsWrite"], smsReadState: "fengsui", networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  fiberhome: { defaultUsername: "admin", defaultAddress: "192.168.8.1", reads: ["telemetry", "neighbors"], writes: ["bandLock", "cellLock", "reboot"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  nradio: { defaultUsername: "root", defaultAddress: "192.168.66.1", reads: ["telemetry", "neighbors"], writes: ["bandLock", "cellLock", "reboot"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  openwrt: { defaultUsername: "root", defaultAddress: "192.168.1.1", reads: ["telemetry", "neighbors", "sms"], writes: ["bandLock", "cellLock", "reboot", "smsWrite"], smsReadState: "fengsui", networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
};

/** The read features and the read section each one is read in. */
const READ_FEATURE_SECTIONS = { telemetry: "telemetry", neighbors: "neighbors", topology: "topology", smsRead: "sms" } as const;

/**
 * Every feature FengSui implements for a router of this family that nobody verified: the reads its
 * interface provides (signal, nearby cells, connected devices, SMS) and its writes. A model is verified
 * by reports once each of these is confirmed on a real one of it (`isReportVerifiedModel`, firmware.ts).
 */
export function familyFeatures(family: RouterFamily): Array<{ feature: keyof typeof READ_FEATURE_SECTIONS | FamilyWriteFeature; access: "read" | "write" }> {
  const facts = ROUTER_FAMILY_FACTS[family];
  const reads = (Object.keys(READ_FEATURE_SECTIONS) as Array<keyof typeof READ_FEATURE_SECTIONS>).filter((feature) => (facts.reads as ReadonlyArray<string>).includes(READ_FEATURE_SECTIONS[feature]));
  return [...reads.map((feature) => ({ feature, access: "read" as const })), ...facts.writes.map((feature) => ({ feature, access: "write" as const }))];
}

/** FengSui implements the feature for routers of this family (nobody verified it on a real one). */
export function familyImplements(family: RouterFamily, feature: string): boolean {
  return familyFeatures(family).some((entry) => entry.feature === feature);
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
