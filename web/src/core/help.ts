/**
 * The console's term help: for each technical word on screen, a one-line explanation (shown on hover or
 * focus) and the place in the user guide that explains it properly (docs/guide/{zh,en}, published on the
 * documentation site). Zero dependencies; the "?" marks themselves are drawn by ui/help.ts and can be
 * switched off in Settings → Appearance.
 */
import type { Locale } from "./i18n.ts";

/** The documentation site; GitHub redirects it to the custom domain once one is set. */
export const DOCS_SITE = "https://cky008.github.io/cpe-dash/";

export interface HelpTopic {
  /** Guide page (docs/guide/<lang>/<page>.md). */
  page: string;
  /** Its `<a id="…"></a>` anchor. */
  anchor: string;
  /** The term as shown, for the "?" mark's accessible name. */
  term: Readonly<Record<Locale, string>>;
  tip: Readonly<Record<Locale, string>>;
}

export const HELP_TOPICS = {
  rsrp: { page: "signal", anchor: "rsrp", term: { "zh-CN": "RSRP", en: "RSRP" }, tip: { "zh-CN": "信号强度，越接近 0 越强：-80 很好，-110 以下就弱了", en: "Signal strength. Closer to 0 is stronger: −80 is good, below −110 is weak" } },
  rsrq: { page: "signal", anchor: "rsrq", term: { "zh-CN": "RSRQ", en: "RSRQ" }, tip: { "zh-CN": "信号质量，越接近 0 越好：-10 良好，-15 以下差", en: "Signal quality. Closer to 0 is better: −10 is good, below −15 is poor" } },
  sinr: { page: "signal", anchor: "sinr", term: { "zh-CN": "SINR", en: "SINR" }, tip: { "zh-CN": "信号有多干净，越大越好，和速度关系最大：20 以上很好", en: "How clean the signal is. Higher is better and matters most for speed: 20 or more is great" } },
  rssi: { page: "signal", anchor: "rssi", term: { "zh-CN": "RSSI", en: "RSSI" }, tip: { "zh-CN": "频道里收到的总功率，含干扰和噪声，单独看意义不大", en: "Total power received on the channel, interference and noise included" } },
  cqi: { page: "signal", anchor: "cqi", term: { "zh-CN": "CQI", en: "CQI" }, tip: { "zh-CN": "路由器给信道打的分（0 到 15），越高基站给的速度越快", en: "The router's score for the channel (0 to 15). Higher means faster" } },
  mcs: { page: "signal", anchor: "mcs", term: { "zh-CN": "调制方式", en: "modulation" }, tip: { "zh-CN": "每次传多少数据：256QAM 最快，但需要很干净的信号", en: "How much data each transmission carries. 256QAM is fastest and needs a clean signal" } },
  mimo: { page: "signal", anchor: "mimo", term: { "zh-CN": "MIMO", en: "MIMO" }, tip: { "zh-CN": "同时传几路数据，层数越多越快", en: "How many data streams travel at once. More layers, more speed" } },
  "tx-power": { page: "signal", anchor: "tx-power", term: { "zh-CN": "发射功率", en: "transmit power" }, tip: { "zh-CN": "路由器的发射功率，接近 23 dBm 说明离基站远、上传吃力", en: "The router's transmit power. Near 23 dBm means the cell is far away" } },
  band: { page: "bands-and-cells", anchor: "band", term: { "zh-CN": "频段", en: "band" }, tip: { "zh-CN": "运营商的频率段编号，例如 4G 的 B3、5G 的 n78", en: "A numbered frequency range, such as B3 (4G) or n78 (5G)" } },
  bandwidth: { page: "bands-and-cells", anchor: "bandwidth", term: { "zh-CN": "带宽", en: "bandwidth" }, tip: { "zh-CN": "一个载波占用的频率宽度，越宽速度上限越高", en: "How wide a carrier is. Wider means a higher speed limit" } },
  ca: { page: "bands-and-cells", anchor: "ca", term: { "zh-CN": "载波聚合", en: "carrier aggregation" }, tip: { "zh-CN": "同时使用几个载波，把速度叠加起来", en: "Several carriers used at once, their speeds added up" } },
  "pcc-scc": { page: "bands-and-cells", anchor: "pcc-scc", term: { "zh-CN": "辅载波", en: "secondary carriers" }, tip: { "zh-CN": "主载波之外、额外用来加速的载波", en: "Extra carriers added to the primary one for speed" } },
  anchor: { page: "bands-and-cells", anchor: "anchor", term: { "zh-CN": "锚点", en: "anchor" }, tip: { "zh-CN": "5G NSA 下负责控制连接的那个 4G 小区", en: "The 4G cell that controls the connection in 5G NSA" } },
  "nsa-sa": { page: "bands-and-cells", anchor: "nsa-sa", term: { "zh-CN": "NSA / SA", en: "NSA / SA" }, tip: { "zh-CN": "NSA：5G 借 4G 工作；SA：5G 独立工作", en: "NSA: 5G works alongside 4G. SA: 5G works on its own" } },
  arfcn: { page: "bands-and-cells", anchor: "arfcn", term: { "zh-CN": "频点", en: "frequency (ARFCN)" }, tip: { "zh-CN": "载波所在频率的编号，锁小区时会用到", en: "The number of the carrier's exact frequency, used for cell locks" } },
  pci: { page: "bands-and-cells", anchor: "pci", term: { "zh-CN": "PCI", en: "PCI" }, tip: { "zh-CN": "附近小区的编号，和频点一起确定一个小区", en: "A nearby cell's number. With the frequency it identifies one cell" } },
  "cell-id": { page: "bands-and-cells", anchor: "cell-id", term: { "zh-CN": "TAC / Cell ID / eNodeB", en: "TAC / Cell ID / eNodeB" }, tip: { "zh-CN": "基站和小区在运营商网络里的编号，能查到位置，所以默认打码", en: "Network IDs of the cell and its base station. They reveal a location, so they are masked" } },
  neighbors: { page: "bands-and-cells", anchor: "neighbors", term: { "zh-CN": "附近的基站", en: "nearby cells" }, tip: { "zh-CN": "路由器能听到的周围小区，可以锁到其中一个", en: "Cells the router can hear nearby. You can lock to one of them" } },
  "lock-band": { page: "locking", anchor: "lock-band", term: { "zh-CN": "锁频段", en: "band lock" }, tip: { "zh-CN": "只让路由器使用你勾选的频段", en: "Let the router use only the bands you choose" } },
  "lock-cell": { page: "locking", anchor: "lock-cell", term: { "zh-CN": "锁小区", en: "cell lock" }, tip: { "zh-CN": "把路由器固定在一个小区上", en: "Keep the router on one cell" } },
  "self-heal": { page: "locking", anchor: "self-heal", term: { "zh-CN": "WAN 自愈", en: "WAN self-healing" }, tip: { "zh-CN": "锁定导致断网时自动解锁，断网时自动重拨；默认关闭", en: "Undoes a lock that cut the internet and redials when it drops. Off by default" } },
  upnp: { page: "router-switches", anchor: "upnp", term: { "zh-CN": "UPnP", en: "UPnP" }, tip: { "zh-CN": "让设备自己在路由器上开端口；用不到就关", en: "Lets devices open ports on the router by themselves. Turn it off if you don't need it" } },
  dmz: { page: "router-switches", anchor: "dmz", term: { "zh-CN": "DMZ", en: "DMZ" }, tip: { "zh-CN": "把外部连接全转给一台设备，等于把它暴露到公网", en: "Sends every incoming connection to one device, exposing it to the internet" } },
  firewall: { page: "router-switches", anchor: "firewall", term: { "zh-CN": "防火墙", en: "firewall" }, tip: { "zh-CN": "路由器的基础防护，保持开启", en: "The router's basic protection. Keep it on" } },
  "wan-ping": { page: "router-switches", anchor: "wan-ping", term: { "zh-CN": "WAN 口 Ping", en: "WAN ping" }, tip: { "zh-CN": "是否回应来自公网的 Ping；屏蔽后更不容易被扫描到", en: "Whether to answer pings from the internet. Blocking them hides the router from scanners" } },
  "fw-mac": { page: "router-switches", anchor: "fw-mac", term: { "zh-CN": "MAC 过滤", en: "MAC filter" }, tip: { "zh-CN": "防火墙的 MAC 名单，对有线和无线设备都生效", en: "The firewall's MAC list. It applies to wired and Wi-Fi devices" } },
  mlo: { page: "router-switches", anchor: "mlo", term: { "zh-CN": "MLO", en: "MLO" }, tip: { "zh-CN": "Wi-Fi 7 设备同时用几个频段连接，更快更稳", en: "Wi-Fi 7 devices use several bands at once, for speed and stability" } },
  dbho: { page: "router-switches", anchor: "dbho", term: { "zh-CN": "双频优选", en: "dual-band" }, tip: { "zh-CN": "2.4G 和 5G 合成一个 Wi-Fi 名称，由路由器选频段", en: "One Wi-Fi name for 2.4 and 5 GHz. The router picks the band" } },
  antenna: { page: "router-switches", anchor: "antenna", term: { "zh-CN": "天线", en: "antenna" }, tip: { "zh-CN": "选择内置或外置天线；没接外置天线就保持自动", en: "Choose internal or external antennas. Keep Auto when none are connected" } },
  "mobile-data": { page: "router-switches", anchor: "mobile-data", term: { "zh-CN": "移动数据", en: "mobile data" }, tip: { "zh-CN": "关闭后路由器不再用 SIM 卡上网，局域网照常", en: "When off, the router stops using the SIM for internet. The local network keeps working" } },
  "mac-filter": { page: "devices", anchor: "mac-filter", term: { "zh-CN": "Wi-Fi MAC 过滤", en: "Wi-Fi MAC filter" }, tip: { "zh-CN": "按设备的 MAC 地址决定能不能连 Wi-Fi", en: "Allows or blocks Wi-Fi devices by their MAC address" } },
  "time-rule": { page: "devices", anchor: "time-rule", term: { "zh-CN": "上网时段", en: "internet schedule" }, tip: { "zh-CN": "只允许设备在设定的时间段上网", en: "Lets a device go online only in the hours you set" } },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP_TOPICS;

/** Where the guide explains `id`, in the reader's language. */
export function helpUrl(id: HelpTopicId, locale: Locale): string {
  const topic = HELP_TOPICS[id];
  return `${DOCS_SITE}${locale === "en" ? "en/" : ""}docs/${topic.page}/#${topic.anchor}`;
}

/** The "?" mark's accessible name: what it explains. */
export function helpLabel(id: HelpTopicId, locale: Locale): string {
  const term = HELP_TOPICS[id].term[locale];
  return locale === "en" ? `What is ${term}?` : `什么是${term}？`;
}
