/**
 * The router families FengSui can talk to, chosen with the router connection (Settings → Router).
 * `huawei` is the HiLink stack (the H168-383 is the verified model); every other family has its own
 * driver in `src/drivers/` and counts as a model nobody verified: it reads, and writes only what its
 * owner turned on as an experimental write (the write gate, `src/device-access.ts`).
 *
 * Zero dependencies: the daemon, the web console and the docs build share these facts.
 */

export const ROUTER_FAMILIES = ["huawei", "zte-goform", "zte-zwrt", "pinsu", "tozed", "fiberhome", "nradio", "openwrt"] as const;

export type RouterFamily = (typeof ROUTER_FAMILIES)[number];

/** Every family but Huawei's: the ones a driver in `src/drivers/` speaks. */
export type DriverFamily = Exclude<RouterFamily, "huawei">;

export const DRIVER_FAMILIES = ROUTER_FAMILIES.filter((f): f is DriverFamily => f !== "huawei");

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

/** The writes a driver implements (all of them experimental: consent per model, read back after). */
export const DRIVER_WRITE_FEATURES = ["bandLock", "cellLock", "reboot"] as const;

export type DriverWriteFeature = (typeof DRIVER_WRITE_FEATURES)[number];

/** What a family reads and writes, and how its owner signs in. */
export interface RouterFamilyFacts {
  /** The user name the router's own login page uses (`""`: the page asks for a password only). */
  defaultUsername: string;
  /** The router's usual address, a hint for the connection form. */
  defaultAddress: string;
  /** Read sections the family implements (the others are not available on it). */
  reads: ReadonlyArray<"telemetry" | "neighbors" | "topology">;
  /** Network modes the driver can switch to with a band lock. */
  networkModes: ReadonlyArray<"auto" | "lte" | "nr_sa" | "nr_nsa">;
  /** The driver can lock 5G NR bands (every driver locks LTE bands). */
  nrBandLock: boolean;
}

/**
 * Connected devices (`topology`) stay the HiLink stack's: no other family documents its device list
 * in a format FengSui could read without guessing.
 */
export const ROUTER_FAMILY_FACTS: Readonly<Record<RouterFamily, RouterFamilyFacts>> = {
  huawei: { defaultUsername: "admin", defaultAddress: "192.168.8.1", reads: ["telemetry", "neighbors", "topology"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  "zte-goform": { defaultUsername: "", defaultAddress: "192.168.0.1", reads: ["telemetry", "neighbors"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  "zte-zwrt": { defaultUsername: "", defaultAddress: "192.168.0.1", reads: ["telemetry"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  pinsu: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry"], networkModes: ["auto", "lte", "nr_sa"], nrBandLock: true },
  tozed: { defaultUsername: "admin", defaultAddress: "192.168.0.1", reads: ["telemetry", "neighbors"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  fiberhome: { defaultUsername: "admin", defaultAddress: "192.168.8.1", reads: ["telemetry", "neighbors"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  nradio: { defaultUsername: "root", defaultAddress: "192.168.66.1", reads: ["telemetry", "neighbors"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
  openwrt: { defaultUsername: "root", defaultAddress: "192.168.1.1", reads: ["telemetry", "neighbors"], networkModes: ["auto", "lte", "nr_sa", "nr_nsa"], nrBandLock: true },
};

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
