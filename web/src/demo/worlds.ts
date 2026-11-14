import type { OperatorChoice } from "../../../src/cellular.ts";
import { maskToBands } from "../../../src/device-profile.ts";
import { getXmlBlocks, getXmlTag } from "../../../src/protocols/hilink/xml.ts";
import { H168_383_LTE_BANDS } from "../../../src/rf-bounds.ts";
import { type FamilySms, createCpeFamily } from "../../../test/helpers/cpe-family.ts";
import { type StrictCpe, createStrictCpe } from "../../../test/helpers/strict-cpe.ts";
import { zteApnProfile, zteRouter, zteSms } from "../../../test/helpers/zte-goform-router.ts";
import { HOUSEHOLD_LTE, HOUSEHOLD_NR, type RatLock, type Serving, UNLOCKED, dbm, servingFor } from "./radio.ts";
import { type SignalBase, type WorldSample, worldSample } from "./world.ts";

/**
 * The demo's three routers, each a mock from test/helpers dressed as a household's router: the
 * verified H168-383, an LTE-only Huawei B535-232 FengSui was not verified on (`?router=other`) and a
 * ZTE MU5001 mobile router (`?router=zte`). The real daemon talks to them: in the live demo's page
 * (./runtime.ts), in `npm run demo`, the screenshots and the browser tests (scripts/demo-router.ts).
 *
 * What a router does that the protocol mocks leave out is modelled here, on the router's side: the
 * household's rhythm (./world.ts) in its signal and traffic, its serving cells moving under a band or
 * cell lock (./radio.ts), no traffic while mobile data is off, a reboot that takes it off the network
 * for a while, and (in the live demo) a reply to a message it sends. No request leaves the process and
 * every identifier is an RFC / reserved placeholder (AGENTS.md 铁律二).
 */

export const DEMO_CPE_PASSWORD = "demo-router-password";
/** Where the ZTE world's router answers (ZTE's usual address). */
export const ZTE_DEMO_URL = "http://192.168.0.1";
/** How long a rebooting demo router is gone from the network. */
export const REBOOT_OFFLINE_MS = 45_000;
/** How soon a demo contact answers a message (when the world replies at all). */
export const AUTO_REPLY_MS = 6_000;

/** What a search for networks finds around the demo household. */
export const DEMO_OPERATORS: ReadonlyArray<OperatorChoice> = [
  { plmn: "27201", name: "Carrier-Lab", rat: "4G", state: "current" },
  { plmn: "27202", name: "DemoNet", rat: "4G", state: "available" },
  { plmn: "27203", name: "OtherNet", rat: "3G", state: "forbidden" },
];

/** What the demo operator answers any USSD code with. */
export const DEMO_USSD_ANSWER = "Carrier-Lab: your balance is 12.50 EUR. 37.4 GB of data left this month.";

/** Fictional contacts on reserved numbers, so the SMS centre shows names and a new conversation. */
export const DEMO_CONTACTS = [
  { phone: "+353830000001", name: "Sam Demo", note: "Dinner club" },
  { phone: "+447700900123", name: "Parcel Depot", note: "Demo courier" },
  { phone: "+353830000002", name: "Robin Demo" },
] as const;

export interface DemoWorldOptions {
  /** The household's clock (the page's or the process's). */
  now?: () => number;
  random?: () => number;
  /** A contact answers a message the router sends (the live demo; off for tests that count messages). */
  autoReply?: boolean;
  /** How soon the answer comes (`AUTO_REPLY_MS` unless a test wants it sooner). */
  replyAfterMs?: number;
}

/** A router's own default for its answer times: the H168-383 world always had them, the others answered at once. */
interface HouseholdDefaults {
  latencyScale: number;
}

export interface DemoRouter {
  /** The strict H168-383 model (`null` in the other worlds). */
  cpe: StrictCpe | null;
  /** A person on the router's own web page (the avoidance banner). */
  human: { loginSameIp(): void; logout(): void };
  /** The router's answers to the daemon: the mock, with the household around it. */
  fetchImpl: typeof fetch;
  /** The radio values the household's rhythm moves around: the 24 h history follows the same curve. */
  base: SignalBase;
  /** One 5 s step of the household. */
  advance(): void;
  /** Deliver a fresh DemoBank one-time code. */
  pushOtp(): void;
  /**
   * Scale the router's answer times (a LAN router's few milliseconds a request at 1). The live demo sets 0
   * while the page starts, so the console has data at once, then 1 on every router.
   */
  setLatencyScale(scale: number): void;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const CJK = /[㐀-鿿]/;
const replyFor = (content: string): string =>
  CJK.test(content) ? "收到 👍（演示页自动回复，号码与内容均为虚构）" : "Got it 👍 (automatic demo reply; every number here is fictional)";

function urlOf(input: Parameters<typeof fetch>[0]): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function sleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/** What every demo router shares around its mock: answer times, the reboot's absence, its clock. */
function household(opts: DemoWorldOptions, defaults: HouseholdDefaults = { latencyScale: 1 }) {
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  let latencyScale = defaults.latencyScale;
  let offlineUntil = 0;
  return {
    now,
    random,
    autoReply: opts.autoReply ?? false,
    replyAfterMs: opts.replyAfterMs ?? AUTO_REPLY_MS,
    setLatencyScale: (scale: number): void => {
      latencyScale = Math.max(0, scale);
    },
    /** Wait as a router on the LAN would, then refuse while it is rebooting. */
    async arrive(init: RequestInit | undefined): Promise<void> {
      await sleep(Math.round((6 + random() * 20) * latencyScale), init?.signal);
      if (now() < offlineUntil) throw new TypeError("fetch failed (connect EHOSTUNREACH)");
    },
    goOffline: (): void => {
      offlineUntil = now() + REBOOT_OFFLINE_MS;
    },
    /** A contact's answer, a little later. */
    later(ms: number, fn: () => void): void {
      setTimeout(fn, ms);
    },
  };
}

/** A walk for the values the household's rhythm does not set (transmit power, MCS). */
function walker(random: () => number) {
  let tick = 0;
  return {
    step: (): void => {
      tick += 1;
    },
    tick: (): number => tick,
    walk: (base: number, spread: number, period: number): number => Math.round((base + Math.sin(tick / period) * spread + (random() - 0.5) * spread * 0.6) * 10) / 10,
  };
}

/** The serving cells' radio values: the household's rhythm, moved by each cell's own strength. */
function signalOf(sample: WorldSample, serving: Serving): { lte: { rsrp: number; rsrq: number; sinr: number; rssi: number }; nr: { rsrp: number; rsrq: number; sinr: number } | null } {
  const lteOffset = serving.lte.offsetDb;
  const nrOffset = serving.nr?.offsetDb ?? 0;
  return {
    lte: { rsrp: sample.lteRsrpDbm + lteOffset, rsrq: sample.lteRsrqDb + lteOffset / 6, sinr: sample.lteSinrDb + lteOffset / 2, rssi: sample.lteRssiDbm + lteOffset },
    nr: serving.nr && sample.nrRsrpDbm !== null ? { rsrp: sample.nrRsrpDbm + nrOffset, rsrq: (sample.nrRsrqDb ?? -10) + nrOffset / 6, sinr: (sample.nrSinrDb ?? 9) + nrOffset / 2 } : null,
  };
}

/** A HiLink `lock-freq` radio's lock: off (`0`), a channel (`1`), a cell (`2`) or bands (`3`). */
function lockFreqOf(block: string): RatLock | null {
  const mode = getXmlTag(block, "lock_mode");
  if (mode === "0") return UNLOCKED;
  const infos = getXmlBlocks(block, "freq_info");
  if (mode === "3") return { kind: "bands", bands: infos.map((info) => Number(getXmlTag(info, "band"))).filter(Number.isFinite) };
  const info = infos[0] ?? "";
  if (mode === "1" || mode === "2") {
    const pci = getXmlTag(info, "pci");
    return { kind: "cell", band: Number(getXmlTag(info, "band")), arfcn: Number(getXmlTag(info, "freq")), pci: mode === "2" && pci !== null ? Number(pci) : null };
  }
  return null;
}

/** An LTE mask as a lock: every band the H168-383 has (or the auto mask) is no lock at all. */
function lteMaskLock(hex: string): RatLock {
  const bands = maskToBands(hex) ?? [];
  return H168_383_LTE_BANDS.every((band) => bands.includes(band)) ? UNLOCKED : { kind: "bands", bands };
}

/**
 * The H168-383 household (the verified model): the strict mock of test/helpers with a signal and
 * traffic that follow the household, six LAN devices, a Wi-Fi blacklist entry, a time rule and a
 * mailbox; band and cell locks move its serving cells, mobile data and the antenna switch hold.
 */
export function createDemoRouter(opts: DemoWorldOptions = {}): DemoRouter {
  const home = household(opts);
  const w = walker(home.random);
  const base: SignalBase = { lteRsrpDbm: -87, lteRsrqDb: -7, lteSinrDb: 13, lteRssiDbm: -70, nr: { rsrpDbm: -95, rsrqDb: -10.5, sinrDb: 9 }, temperatureCelsius: null };
  let sample = worldSample(home.now(), base, home.random);
  let monthDown = 1_160_491_161_608;
  let monthUp = 87_430_687_669;
  let dayUsed = 11_888_746_002;
  let connected = 346_909;
  let mobileData = true;
  let antenna = "0";
  let upnp = "1";
  let lteMask: RatLock = UNLOCKED;
  let lteCell: RatLock | null = null;
  let nrLock: RatLock = UNLOCKED;
  let serving = servingFor(UNLOCKED, UNLOCKED);
  const reserve = (): void => {
    serving = servingFor(lteCell ?? lteMask, nrLock);
  };

  function signalXml(): string {
    const { lte, nr } = signalOf(sample, serving);
    const pcc = serving.lte;
    const carriers = [pcc, ...serving.lteScc].map((cell) => `20MHz@${cell.arfcn}(B${cell.band})`);
    if (serving.nr) carriers.push(`100MHz@${serving.nr.arfcn}(N${serving.nr.band})`);
    const nrTags = nr && serving.nr
      ? `<nrulbandwidth>100MHz</nrulbandwidth><nrdlbandwidth>100MHz</nrdlbandwidth><nrulmcs>NRmcsUpCarrier1:20@256QAM</nrulmcs><nrdlmcs>NRmcsDownCarrier1Code0:${15 + (w.tick() % 7)}@64QAM NRmcsDownCarrier1Code1:0</nrdlmcs><nrtxpower>PPusch:${w.walk(21, 2, 6)}dBm PPucch:${w.walk(18, 3, 4)}dBm PSrs:0dBm PPrach:5dBm</nrtxpower><nrearfcn>${serving.nr.arfcn}</nrearfcn><nrsinr>${dbm(nr.sinr)}dB</nrsinr><nrrsrp>${dbm(nr.rsrp)}dBm</nrrsrp><nrrsrq>${dbm(nr.rsrq)}dB</nrrsrq><nrrssi>-72dBm</nrrssi><nrrank>2</nrrank><nrcqi0>12</nrcqi0><nrcqi1>11</nrcqi1>`
      : "";
    return `<response><pci>${pcc.pci}</pci><cell_id>134217758</cell_id><rsrq>${dbm(lte.rsrq)}dB</rsrq><rsrp>${dbm(lte.rsrp)}dBm</rsrp><rssi>${dbm(lte.rssi)}dBm</rssi><sinr>${dbm(lte.sinr)}dB</sinr><mode>7</mode><ulbandwidth>20MHz</ulbandwidth><dlbandwidth>20MHz</dlbandwidth><txpower>PPusch:${w.walk(12, 4, 4)}dBm PPucch:${w.walk(-9, 3, 5)}dBm PSrs:0dBm PPrach:-3dBm</txpower><ul_mcs>mcsUpCarrier1:27@256QAM</ul_mcs><dl_mcs>mcsDownCarrier1Code0:${20 + (w.tick() % 5)}@256QAM mcsDownCarrier1Code1:18@64QAM</dl_mcs><earfcn>DL:${pcc.arfcn} UL:${pcc.arfcn + 18000}</earfcn><tac>10001</tac><band>${carriers.join(" + ")}</band><plmn>27201</plmn><transmode>TM[4]</transmode><enodeb_id>0524288</enodeb_id><cqi0>12</cqi0><cqi1>11</cqi1>${nrTags}</response>`;
  }

  function secondaryXml(): string {
    const { lte, nr } = signalOf(sample, serving);
    const lteList = serving.lteScc.map((cell) => `${cell.arfcn},B${cell.band},20MHz,${cell.pci},${dbm(lte.rsrp + cell.offsetDb + 3)}dBm,-6dB,-70dBm,14dB;`).join("");
    const nrList = serving.nr && nr ? `${serving.nr.arfcn},N${serving.nr.band},100MHz,${serving.nr.pci},${dbm(nr.rsrp)}dBm,-10dB,-72dBm,${dbm(nr.sinr)}dB;` : "";
    return `<response><lteseccell_list>${lteList}</lteseccell_list><nrseccell_list>${nrList}</nrseccell_list></response>`;
  }

  function trafficXml(): string {
    const down = mobileData ? sample.downloadBytesPerSec : 0;
    const up = mobileData ? sample.uploadBytesPerSec : 0;
    return `<response><CurrentConnectTime>${connected}</CurrentConnectTime><CurrentUpload>80240562176</CurrentUpload><CurrentDownload>191780421632</CurrentDownload><CurrentDownloadRate>${down}</CurrentDownloadRate><CurrentUploadRate>${up}</CurrentUploadRate><TotalUpload>2418923415594</TotalUpload><TotalDownload>5541561494560</TotalDownload><TotalConnectTime>12193610</TotalConnectTime></response>`;
  }

  const HOSTS = [
    // The daemon's own host: the router marks the client that asks for HostInfo
    { MACAddress: "02:00:5E:10:00:01", HostName: "nas-ds923", IPAddress: "192.168.8.10", InterfaceType: "Ethernet", Layer2Interface: "LAN1", Frequency: "", EthernetSpeed: 1000, rate: 0, rssi: 0, AddressSource: "STATIC", LeaseTime: 0, IsLocalDevice: true },
    { MACAddress: "02:00:5E:10:00:02", HostName: "studio-mac", IPAddress: "192.168.8.21", InterfaceType: "Ethernet", Layer2Interface: "LAN2", Frequency: "", EthernetSpeed: 1000, rate: 0, rssi: 0, AddressSource: "DHCP", LeaseTime: 81_234 },
    { MACAddress: "02:00:5E:10:00:03", HostName: "living-room-tv", IPAddress: "192.168.8.33", InterfaceType: "Wireless", Layer2Interface: "SSID1", Frequency: "5GHz", EthernetSpeed: 0, rate: 1201, rssi: 38, AddressSource: "DHCP", LeaseTime: 64_002 },
    { MACAddress: "02:00:5E:10:00:04", HostName: "phone-wifi7", IPAddress: "192.168.8.44", InterfaceType: "Wireless", Layer2Interface: "SSID7", Frequency: "5GHz_1", EthernetSpeed: 0, rate: 2882, rssi: 31, AddressSource: "DHCP", LeaseTime: 72_302 },
    { MACAddress: "02:00:5E:10:00:05", HostName: "smart-plug", IPAddress: "192.168.8.51", InterfaceType: "Wireless", Layer2Interface: "SSID2", Frequency: "2.4GHz", EthernetSpeed: 0, rate: 72, rssi: 22, AddressSource: "DHCP", LeaseTime: 3_480 },
    { MACAddress: "02:00:5E:10:00:06", HostName: "e-reader", IPAddress: "192.168.8.62", InterfaceType: "Wireless", Layer2Interface: "SSID2", Frequency: "2.4GHz", EthernetSpeed: 0, rate: 144, rssi: 27, AddressSource: "DHCP", LeaseTime: 41_900, Active: false },
  ];

  function hostInfoJson(): string {
    return JSON.stringify(
      HOSTS.map((host, i) => {
        // A device the Wi-Fi MAC filter keeps out drops off the network, as on the real router
        const cutOff = host.InterfaceType === "Wireless" && cpe.isWifiBlocked(host.MACAddress);
        return {
          ID: `InternetGatewayDevice.LANDevice.1.Hosts.Host.${i + 1}.`,
          ActualName: host.HostName,
          IPv6Address: `fe80::${i + 1};2001:db8::${(i + 1) * 10}`,
          V6Active: true,
          PhyType: host.EthernetSpeed,
          AssociatedTime: 7200 + i * 900,
          IsLocalDevice: false,
          ...host,
          Active: cutOff ? false : (host.Active ?? true),
          WlanActive: host.InterfaceType === "Wireless" && !cutOff && (host.Active ?? true),
        };
      })
    );
  }

  const neighbourXml = (): string =>
    `<response><nbrcell_ltelist>${HOUSEHOLD_LTE.map((cell) => `${cell.arfcn},B${cell.band},${cell.pci},${dbm(base.lteRsrpDbm + cell.offsetDb)}dBm,-9dB,-70dBm,${cell.offsetDb < -10 ? "--" : "12dB"};`).join("")}</nbrcell_ltelist><nbrcell_nrlist>${HOUSEHOLD_NR.map((cell) => `${cell.arfcn},N${cell.band},${cell.pci},${dbm((base.nr?.rsrpDbm ?? -95) + cell.offsetDb)}dBm,-11dB,-73dBm,${cell.offsetDb < 0 ? "2dB" : "8dB"};`).join("")}</nbrcell_nrlist></response>`;

  const STATIC_BODIES: Readonly<Record<string, string>> = {
    "/api/device/information":
      "<response><DeviceName>H168-383</DeviceName><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi><Msisdn>+353830000000</Msisdn><MacAddress1>02:00:5E:10:00:FE</MacAddress1><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion><uptime>86400</uptime><WanIPAddress>198.51.100.42</WanIPAddress><wan_dns_address>203.0.113.53,198.51.100.53</wan_dns_address><WanIPv6Address>2001:db8::42</WanIPv6Address><wan_ipv6_dns_address>2001:db8::53</wan_ipv6_dns_address><workmode>LTE</workmode></response>",
    "/api/monitoring/start_date": "<response><StartDay>1</StartDay><DataLimit>2000GB</DataLimit><MonthThreshold>90</MonthThreshold></response>",
    // What the identification probe reads (docs/dev/protocol.md 3.4 and 4.1)
    "/api/net/net-feature-switch":
      "<response><net_premode_switch>2</net_premode_switch><lteband_switch>0</lteband_switch><select_band_switch>1</select_band_switch><lock_freq_switch>3</lock_freq_switch><antenna_select_switch>0</antenna_select_switch><reconnect_switch>1</reconnect_switch><net_mode_enable>1</net_mode_enable></response>",
    "/api/net/net-mode-list":
      "<response><LTEBandList><LTEBand><Name>LTE BC1/BC3/BC5/BC7/BC8/BC20/BC28/BC32/BC38/BC40/BC41/BC42/BC43/BC71</Name><Value>40000007a0880800d5</Value></LTEBand></LTEBandList></response>",
  };

  const cpe = createStrictCpe({
    password: DEMO_CPE_PASSWORD,
    // The cellular settings checked on the real H168-383 (issue #3), answered as it did
    cellular: true,
    fault: (p, method, headers) => {
      if (method !== "GET") return undefined;
      if (p === "/api/device/signal") return { body: signalXml() };
      if (p === "/api/device/seccellinfo") return { body: secondaryXml() };
      if (p === "/api/device/nbrcellinfo") return { body: neighbourXml() };
      if (p === "/api/monitoring/traffic-statistics") return { body: trafficXml() };
      // The session bootstrap (with Update-Cookie) is the mock's: it hands out the SessionID
      if (p === "/api/monitoring/status" && !headers.get("update-cookie")) return { body: `<response><ConnectionStatus>${mobileData ? "901" : "902"}</ConnectionStatus><SignalIcon>4</SignalIcon><SimStatus>1</SimStatus></response>` };
      if (p === "/api/dialup/mobile-dataswitch") return { body: `<response><dataswitch>${mobileData ? "1" : "0"}</dataswitch></response>` };
      if (p === "/api/device/antenna_set_type") return { body: `<response><antennasettype>${antenna}</antennasettype></response>` };
      if (p === "/api/security/upnp") return { body: `<response><UpnpStatus>${upnp}</UpnpStatus></response>` };
      if (p === "/api/system/HostInfo") return { body: hostInfoJson() };
      if (p === "/api/monitoring/month_statistics") {
        return {
          body: `<response><CurrentMonthDownload>${monthDown}</CurrentMonthDownload><CurrentMonthUpload>${monthUp}</CurrentMonthUpload><MonthDuration>2511543</MonthDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime><CurrentDayUsed>${dayUsed}</CurrentDayUsed><CurrentDayDuration>13250</CurrentDayDuration></response>`,
        };
      }
      const fixed = STATIC_BODIES[p];
      return fixed === undefined ? undefined : { body: fixed };
    },
  });

  // Access control: the smart plug sits on the Wi-Fi blacklist, the Wi-Fi 7 phone has school-night hours
  cpe.router.macFilter.enable = "1";
  cpe.router.macFilter.status = "2";
  cpe.router.macFilter.ssids[0]?.deny.push(["02:00:5E:10:00:05", "smart-plug"]);
  cpe.router.timeRules.rules.push({
    ID: `InternetGatewayDevice.X_FireWall.TimeRule.${cpe.router.timeRules.nextId++}.`,
    Enable: "1",
    TimeMode: "1",
    WeekEnable: "1111100",
    StartTime: "07:00",
    EndTime: "21:30",
    macs: ["02:00:5E:10:00:04"],
    names: ["phone-wifi7"],
  });

  const routerDate = (offsetMin: number): string => {
    const d = new Date(home.now() - offsetMin * 60_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  /** What the router did with a write the strict mock accepted (it only acknowledges most of them). */
  const applied = (path: string, body: string): void => {
    if (path === "/api/sms/set-read" || path === "/api/sms/delete-sms") {
      const indexes = new Set([...body.matchAll(/<Index>(\d+)<\/Index>/g)].map((m) => Number(m[1])));
      for (const box of [cpe.inbox, cpe.outbox]) {
        for (let i = box.length - 1; i >= 0; i--) {
          const msg = box[i];
          if (!msg || !indexes.has(msg.index)) continue;
          if (path === "/api/sms/delete-sms") box.splice(i, 1);
          else msg.smstat = "1";
        }
      }
    } else if (path === "/api/net/net-mode") {
      const lte = getXmlTag(body, "LTEBand");
      if (lte !== null && cpe.cellular) {
        cpe.cellular.netMode["LTEBand"] = lte;
        cpe.cellular.netMode["NetworkBand"] = getXmlTag(body, "NetworkBand") ?? cpe.cellular.netMode["NetworkBand"] ?? "";
        lteMask = lteMaskLock(lte);
      }
    } else if (path === "/api/net/lock-freq") {
      const lte = lockFreqOf(getXmlBlocks(body, "lte_info")[0] ?? "");
      const nr = lockFreqOf(getXmlBlocks(body, "nr_info")[0] ?? "");
      if (lte) lteCell = lte.kind === "all" ? null : lte;
      if (nr) nrLock = nr;
    } else if (path === "/api/dialup/mobile-dataswitch") {
      mobileData = getXmlTag(body, "dataswitch") !== "0";
    } else if (path === "/api/device/antenna_set_type") {
      antenna = getXmlTag(body, "antennasettype") ?? antenna;
    } else if (path === "/api/security/upnp") {
      upnp = getXmlTag(body, "UpnpStatus") ?? upnp;
    } else if (path === "/api/device/control" && getXmlTag(body, "Control") === "1") {
      home.goOffline();
      connected = 0;
    } else if (path === "/api/net/reconnect") {
      connected = 0;
    } else if (path === "/api/sms/send-sms" && home.autoReply) {
      const phone = getXmlTag(body, "Phone");
      const content = getXmlTag(body, "Content") ?? "";
      if (phone) home.later(home.replyAfterMs, () => cpe.pushIncoming({ phone, content: replyFor(content), date: routerDate(0) }));
    }
    reserve();
  };

  const demoFetch: typeof fetch = async (input, init) => {
    await home.arrive(init);
    const path = urlOf(input).pathname;
    const res = await cpe.fetchImpl(input, init);
    if ((init?.method ?? "GET").toUpperCase() === "POST" && res.ok && !(await res.clone().text()).includes("<error>")) {
      // The strict router recorded what it took in plain text (an encrypted body included)
      const write = [...cpe.stats.writes].reverse().find((entry) => entry.path === path);
      if (write) applied(path, write.body);
    }
    return res;
  };

  // Seed a mailbox with reserved numbers and fictional senders only
  cpe.pushIncoming({ phone: "DemoBank", content: "Your DemoBank verification code is 482913. It expires in 10 minutes. Never share it.", date: routerDate(4) });
  cpe.pushIncoming({ phone: "+353830000001", content: "Dinner at 7? I booked the table by the window 🍜", date: routerDate(38) });
  cpe.outbox.push({ index: 39_001, phone: "+353830000001", content: "Perfect, see you there!", date: routerDate(35), smstat: "3" });
  cpe.pushIncoming({ phone: "Three", content: "You've used 80% of your monthly data allowance. Details: https://cpe.example.com/usage", date: routerDate(60 * 20) });
  cpe.pushIncoming({ phone: "+447700900123", content: "Parcel for you is waiting at the depot, reference 7781. Collect within 5 days.", date: routerDate(60 * 30) });
  cpe.pushIncoming({ phone: "+8613000000000", content: "【云服务】您的验证码为 715026，5 分钟内有效，请勿泄露。", date: routerDate(60 * 50) });
  cpe.outbox.push({ index: 39_002, phone: "+447700900123", content: "Thanks, I'll pick it up tomorrow.", date: routerDate(60 * 29), smstat: "3" });
  for (const msg of cpe.inbox) {
    if (msg.phone !== "DemoBank" && msg.phone !== "+353830000001") msg.smstat = "1";
  }

  return {
    cpe,
    human: cpe.human,
    fetchImpl: demoFetch,
    base,
    advance: () => {
      w.step();
      sample = worldSample(home.now(), base, home.random);
      if (!mobileData) return;
      connected += 5;
      monthDown += sample.downloadBytesPerSec * 5;
      monthUp += sample.uploadBytesPerSec * 5;
      dayUsed += (sample.downloadBytesPerSec + sample.uploadBytesPerSec) * 5;
    },
    pushOtp: () => {
      const code = String(100_000 + Math.floor(home.random() * 899_999));
      cpe.pushIncoming({ phone: "DemoBank", content: `Your DemoBank verification code is ${code}. It expires in 10 minutes.`, date: routerDate(0) });
    },
    setLatencyScale: home.setLatencyScale,
  };
}

/**
 * The unverified-model world (multi-model phase 2): an LTE-only router of another Huawei model from
 * the phase-1 mock family, with a legacy SHA-256 login, the HiLink basics (signal, status, traffic,
 * month statistics, an XML device list, plaintext SMS) and nothing else. FengSui reads what it
 * provides and writes what it implements for such a model, each write on until its owner turns it
 * off: the router takes the generic writes of appendix A.11 (band mask, mobile data, redial, reboot,
 * plaintext SMS), a redial or reboot starts the connection again and mobile data off takes the WAN down. Facts and
 * placeholders only (docs/dev/protocol.md A.10, A.11).
 */
export function createUnverifiedDemoRouter(opts: DemoWorldOptions = {}): DemoRouter {
  const home = household(opts, { latencyScale: 0 });
  const base: SignalBase = { lteRsrpDbm: -96, lteRsrqDb: -9, lteSinrDb: 11, lteRssiDbm: -69, nr: null, temperatureCelsius: null };
  let sample = worldSample(home.now(), base, home.random);
  let connected = 86_400;
  let monthDown = 412_000_000_000;
  let dayUsed = 3_200_000_000;
  const hosts = [
    { mac: "02:00:5E:10:00:01", ip: "192.168.8.10", name: "nas-ds923", type: "Ethernet", frequency: "" },
    { mac: "02:00:5E:10:00:03", ip: "192.168.8.33", name: "living-room-tv", type: "802.11", frequency: "5GHz" },
    { mac: "02:00:5E:10:00:05", ip: "192.168.8.51", name: "smart-plug", type: "802.11", frequency: "2.4GHz" },
  ];
  const endpoints: Record<string, string> = {
    "/api/net/current-plmn": "<response><State>0</State><FullName>Carrier-Lab</FullName><ShortName>CARRIER</ShortName><Numeric>27201</Numeric><Rat>7</Rat></response>",
    "/api/net/net-mode": "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>800800C5</LTEBand></response>",
    "/api/net/net-mode-list": "<response><AccessList><Access>00</Access><Access>03</Access><Access>02</Access></AccessList><LTEBandList><LTEBand><Name>LTE BC1/BC3/BC7/BC8/BC20/BC32</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
    "/api/monitoring/start_date": "<response><StartDay>1</StartDay><DataLimit>500GB</DataLimit><MonthThreshold>90</MonthThreshold></response>",
    "/api/lan/HostInfo": `<response><Hosts>${hosts
      .map((host, i) => `<Host><ID>${i + 1}</ID><MacAddress>${host.mac}</MacAddress><IpAddress>${host.ip}</IpAddress><HostName>${host.name}</HostName><Active>1</Active><InterfaceType>${host.type}</InterfaceType>${host.frequency ? `<Frequency>${host.frequency}</Frequency>` : ""}</Host>`)
      .join("")}</Hosts></response>`,
  };
  let dataOn = (): boolean => true;
  const step = (): void => {
    const down = dataOn() ? sample.downloadBytesPerSec : 0;
    const up = dataOn() ? sample.uploadBytesPerSec : 0;
    endpoints["/api/device/signal"] = `<response><pci>25</pci><cell_id>134217758</cell_id><rsrq>${dbm(sample.lteRsrqDb)}dB</rsrq><rsrp>${dbm(sample.lteRsrpDbm)}dBm</rsrp><rssi>${dbm(sample.lteRssiDbm)}dBm</rssi><sinr>${dbm(sample.lteSinrDb)}dB</sinr><mode>7</mode><dlbandwidth>20MHz</dlbandwidth><ulbandwidth>20MHz</ulbandwidth><tac>10001</tac><plmn>27201</plmn></response>`;
    endpoints["/api/monitoring/traffic-statistics"] = `<response><CurrentConnectTime>${connected}</CurrentConnectTime><CurrentUpload>52428800</CurrentUpload><CurrentDownload>524288000</CurrentDownload><CurrentDownloadRate>${down}</CurrentDownloadRate><CurrentUploadRate>${up}</CurrentUploadRate><TotalUpload>48318382080</TotalUpload><TotalDownload>412316860416</TotalDownload><TotalConnectTime>9000000</TotalConnectTime></response>`;
    endpoints["/api/monitoring/month_statistics"] = `<response><CurrentMonthDownload>${monthDown}</CurrentMonthDownload><CurrentMonthUpload>41000000000</CurrentMonthUpload><MonthDuration>2400000</MonthDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime><CurrentDayUsed>${dayUsed}</CurrentDayUsed><CurrentDayDuration>40000</CurrentDayDuration></response>`;
  };
  step();
  const routerDate = (offsetMin: number): string => {
    const d = new Date(home.now() - offsetMin * 60_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const mailbox: FamilySms[] = [
    { index: 40011, phone: "DemoBank", content: "Your DemoBank verification code is 315902. It expires in 10 minutes.", date: routerDate(6), smstat: "0", box: 1 },
    { index: 40010, phone: "+353830000001", content: "Back home by 8, see you then", date: routerDate(90), smstat: "1", box: 1 },
    { index: 39010, phone: "+353830000001", content: "Great, dinner is on me", date: routerDate(85), smstat: "3", box: 2 },
  ];
  // No marketing name: a 4G router should not show the family's "5G CPE" one, and the model says enough
  const cpe = createCpeFamily({
    login: "sha256",
    tokenFlow: "token",
    password: DEMO_CPE_PASSWORD,
    model: "B535-232",
    firmware: "11.0.1.2(H7SP2C00)",
    marketingName: null,
    endpoints,
    sms: mailbox,
    writes: { cellular: { networks: hilinkNetworks(), connection: { RoamAutoConnectEnable: "0", MaxIdelTime: "0", ConnectMode: "0", MTU: "1500", auto_dial_switch: "1", pdp_always_on: "0" } } },
  });
  dataOn = () => cpe.settings.mobileData() === "1";
  let nextIndex = 40_012;
  // What a generic write does to the household: a new connection, no WAN without mobile data, a reply to a message
  const demoFetch: typeof fetch = async (input, init) => {
    await home.arrive(init);
    const res = await cpe.fetchImpl(input, init);
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return res;
    const path = urlOf(input).pathname;
    if ((await res.clone().text()).includes("<error>")) return res;
    if (path === "/api/net/reconnect" || path === "/api/device/control") connected = 0;
    if (path === "/api/device/control") home.goOffline();
    if (path === "/api/dialup/mobile-dataswitch") cpe.setConnectionStatus(dataOn() ? "901" : "902");
    if (path === "/api/sms/send-sms" && home.autoReply) {
      const body = typeof init?.body === "string" ? init.body : "";
      const phone = getXmlTag(body, "Phone");
      const content = getXmlTag(body, "Content") ?? "";
      if (phone) home.later(home.replyAfterMs, () => cpe.smsStore?.push({ index: nextIndex++, phone, content: replyFor(content), date: routerDate(0), smstat: "0", box: 1 }));
    }
    step();
    return res;
  };
  return {
    cpe: null,
    human: cpe.human,
    fetchImpl: demoFetch,
    base,
    advance: () => {
      sample = worldSample(home.now(), base, home.random);
      if (dataOn()) {
        connected += 5;
        monthDown += sample.downloadBytesPerSec * 5;
        dayUsed += (sample.downloadBytesPerSec + sample.uploadBytesPerSec) * 5;
      }
      step();
    },
    pushOtp: () => {
      const code = String(100_000 + Math.floor(home.random() * 899_999));
      cpe.smsStore?.push({ index: nextIndex++, phone: "DemoBank", content: `Your DemoBank verification code is ${code}. It expires in 10 minutes.`, date: routerDate(0), smstat: "0", box: 1 });
    },
    setLatencyScale: home.setLatencyScale,
  };
}

/** The demo's search result (`DEMO_OPERATORS`) as each demo router lists it: ZTE's scan rows, HiLink's `<Network>` blocks. */
const SCAN_STATE = { unknown: 0, available: 1, current: 2, forbidden: 3 } as const;
const SCAN_ACT = { "2G": "0", "3G": "2", "4G": "7", "5G": "12" } as const;
const zteScan = (): string => DEMO_OPERATORS.map((row) => `${SCAN_STATE[row.state]},"${row.name ?? ""}","${row.plmn}",${SCAN_ACT[row.rat ?? "4G"]}${row.rat === "4G" ? ",1" : ""}`).join(";");
function hilinkNetworks(): string {
  return DEMO_OPERATORS.map((row) => `<Network><State>${SCAN_STATE[row.state]}</State><FullName>${row.name ?? ""}</FullName><ShortName>${row.name ?? ""}</ShortName><Numeric>${row.plmn}</Numeric><Rat>${SCAN_ACT[row.rat ?? "4G"]}</Rat></Network>`).join("");
}

/** A ZTE goform router's locks, as its own settings hold them. */
function zteLocks(values: Record<string, string>): { lte: RatLock; nr: RatLock } {
  const lteCell = Number(values["lte_earfcn_lock"] ?? "0");
  const ltePci = Number(values["lte_pci_lock"] ?? "0");
  const lteMaskHex = (values["lte_band_lock"] ?? "").replace(/^0x/i, "");
  const lteBands = maskToBands(lteMaskHex) ?? [];
  const lte: RatLock =
    lteCell > 0
      ? { kind: "cell", band: HOUSEHOLD_LTE.find((cell) => cell.arfcn === lteCell)?.band ?? 1, arfcn: lteCell, pci: Number.isFinite(ltePci) ? ltePci : null }
      : lteBands.length === 0 || [1, 3, 20, 7].every((band) => lteBands.includes(band))
        ? UNLOCKED
        : { kind: "bands", bands: lteBands };
  const [pci, arfcn, band] = (values["nr5g_cell_lock"] ?? "").split(",").map(Number);
  const nrBands = (values["nr5g_band_mask"] ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const nr: RatLock =
    arfcn !== undefined && arfcn > 0 && band !== undefined && band > 0
      ? { kind: "cell", band, arfcn, pci: pci !== undefined && Number.isFinite(pci) && pci > 0 ? pci : null }
      : nrBands.length === 0 || nrBands.includes(78) && nrBands.length > 3
        ? UNLOCKED
        : { kind: "bands", bands: nrBands };
  return { lte, nr };
}

/**
 * The ZTE world (`?router=zte`): a 5G mobile router with ZTE's goform pages (MU5001), from the
 * test/helpers mock of that interface, with a battery that runs down and charges, a SIM card in its
 * tray, neighbour cells, connected devices and a mailbox. FengSui reads it and writes it through its
 * ZTE driver, every write on until its owner turns it off. Facts and placeholders only.
 */
export function createZteDemoRouter(opts: DemoWorldOptions = {}): DemoRouter {
  const home = household(opts, { latencyScale: 0 });
  const w = walker(home.random);
  const base: SignalBase = { lteRsrpDbm: -88, lteRsrqDb: -9, lteSinrDb: 13, lteRssiDbm: -62, nr: { rsrpDbm: -97, rsrqDb: -11, sinrDb: 9 }, temperatureCelsius: null };
  let sample = worldSample(home.now(), base, home.random);
  let charge = 64;
  let charging = false;
  let monthDown = 86_000_000_000;
  let monthUp = 5_400_000_000;
  let connected = 35_000;
  // ZTE's own date fields: yy,MM,dd,HH,mm,ss,+zone
  const routerDate = (offsetMin: number): string => {
    const d = new Date(home.now() - offsetMin * 60_000);
    return `${pad(d.getFullYear() % 100)},${pad(d.getMonth() + 1)},${pad(d.getDate())},${pad(d.getHours())},${pad(d.getMinutes())},${pad(d.getSeconds())},+0`;
  };
  const zte = zteRouter({
    password: DEMO_CPE_PASSWORD,
    url: ZTE_DEMO_URL,
    model: "MU5001",
    hw: "MU5001_HW1.0",
    // The cellular settings: a search, a registration that takes, one profile of the router's own, and an operator that answers USSD
    operators: { scan: zteScan(), register: "manual_success" },
    apn: { profiles: [zteApnProfile("Default", "internet", "IPv4v6")] },
    ussd: { text: DEMO_USSD_ANSWER },
    sms: [
      zteSms(12, "DemoBank", "Your DemoBank verification code is 315902. It expires in 10 minutes.", "1", routerDate(6)),
      zteSms(11, "+353830000001", "Back home by 8, see you then", "0", routerDate(90)),
      zteSms(10, "+353830000001", "Great, dinner is on me", "2", routerDate(85)),
    ],
    stations: {
      lan: [{ mac_addr: "02:00:5E:10:00:01", hostname: "nas-ds923", ip_addr: "192.168.0.10", connect_time: "86400" }],
      wifi: [
        { mac_addr: "02:00:5E:10:00:03", hostname: "living-room-tv", ip_addr: "192.168.0.33" },
        { mac_addr: "02:00:5E:10:00:05", hostname: "demo-phone", ip_addr: "192.168.0.51" },
      ],
    },
  });
  const values = zte.state.values;
  Object.assign(values, {
    network_provider: "Carrier-Lab",
    rmcc: "272",
    rmnc: "01",
    wan_ipaddr: "198.51.100.42",
    ipv6_wan_ipaddr: "2001:db8::42",
    signalbar: "4",
    lac_code: "2711",
    cell_id: "0800001e",
    lte_ca_pcell_bandwidth: "20.0",
    nr5g_dl_bandwidth: "100",
    nr_rank: "4",
    lte_rank: "2",
    neighbour_cell_list: `${HOUSEHOLD_LTE.slice(0, 2).map((cell) => `LTE,${cell.band},${cell.arfcn},${cell.pci},${base.lteRsrpDbm + cell.offsetDb},-9,12`).join(";")};NR,78,650000,142,-97,-11,8;`,
    battery_charging: "0",
    battery_temp: "34",
    modem_main_state: "modem_init_complete",
    pin_status: "0",
    pinnumber: "3",
    puknumber: "10",
    sim_slot: "0",
    simcard_roam: "Home",
    data_volume_limit_switch: "1",
    data_volume_limit_unit: "data",
    data_volume_limit_size: "200_1024",
    data_volume_alert_percent: "90",
    fota_new_version_state: "has_optional",
    wifi_cur_state: "1",
    m_ssid_enable: "0",
    imei: "860000000000000",
    imsi: "272010000000000",
    sim_iccid: "8935301000000000000",
    pm_sensor_mdm: "41",
    pm_modem_5g: "44",
    pm_sensor_pa1: "39",
    wifi_chip_temp: "47",
    cpu_usage: "18",
    mem_usage: "46",
  });
  let nextId = 13;
  const dataOn = (): boolean => values["ppp_status"] !== "ppp_disconnected";
  /** The router's serving cells, from its own lock settings. */
  const reserve = (): void => {
    const locks = zteLocks(values);
    const serving = servingFor(locks.lte, locks.nr);
    const hex = (n: number): string => n.toString(16);
    Object.assign(values, {
      network_type: serving.nr ? "ENDC" : "LTE",
      wan_active_band: `LTE BAND ${serving.lte.band}`,
      wan_active_channel: String(serving.lte.arfcn),
      lte_pci: hex(serving.lte.pci),
      wan_lte_ca: serving.lteScc.length > 0 ? "ca_activated" : "ca_deactivated",
      lte_multi_ca_scell_info: serving.lteScc.map((cell) => `1,${cell.pci},1,${cell.band},${cell.arfcn},20.0;`).join(""),
      nr5g_action_band: serving.nr ? `n${serving.nr.band}` : "",
      nr5g_action_channel: serving.nr ? String(serving.nr.arfcn) : "",
      nr5g_pci: serving.nr ? hex(serving.nr.pci) : "",
    });
    const { lte, nr } = signalOf(sample, serving);
    Object.assign(values, {
      lte_rsrp: dbm(lte.rsrp),
      lte_rsrq: dbm(lte.rsrq),
      lte_snr: dbm(lte.sinr),
      lte_rssi: dbm(lte.rssi),
      Z5g_rsrp: nr ? dbm(nr.rsrp) : "",
      Z5g_rsrq: nr ? dbm(nr.rsrq) : "",
      Z5g_SINR: nr ? dbm(nr.sinr) : "",
    });
  };
  const step = (): void => {
    // The battery runs down to 18 %, then the charger goes in until 95 %
    if (charging) charge = Math.min(95, charge + 1);
    else charge = Math.max(18, charge - 0.25);
    if (charge <= 18) charging = true;
    if (charge >= 95) charging = false;
    const down = dataOn() ? sample.downloadBytesPerSec : 0;
    const up = dataOn() ? sample.uploadBytesPerSec : 0;
    Object.assign(values, {
      battery_vol_percent: String(Math.round(charge)),
      battery_charging: charging ? "1" : "0",
      battery_temp: String(charging ? 37 : 34),
      lte_cqi0: String(11 + (w.tick() % 3)),
      nr_cqi0: String(10 + (w.tick() % 4)),
      lte_dl_mcs: String(18 + (w.tick() % 6)),
      nr_dl_mcs: String(16 + (w.tick() % 7)),
      lte_tx_power: String(Math.round(w.walk(9, 4, 6))),
      realtime_rx_thrpt: String(down),
      realtime_tx_thrpt: String(up),
      realtime_time: String(connected),
      monthly_rx_bytes: String(monthDown),
      monthly_tx_bytes: String(monthUp),
    });
    reserve();
  };
  step();
  const fetchImpl: typeof fetch = async (input, init) => {
    await home.arrive(init);
    const res = await zte.mock.fetchImpl(input, init);
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return res;
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const goformId = form.get("goformId");
    // What a write does to the household: a new connection after a redial or a reboot, cells under a lock, a reply
    if (goformId === "REBOOT_DEVICE") {
      connected = 0;
      home.goOffline();
    }
    if (goformId === "CONNECT_NETWORK") connected = 0;
    if (goformId === "SEND_SMS" && home.autoReply) {
      const phone = (form.get("Number") ?? "").split(";")[0] ?? "";
      const hexBody = form.get("MessageBody") ?? "";
      const content = String.fromCharCode(...(hexBody.match(/.{4}/g) ?? []).map((unit) => Number.parseInt(unit, 16)));
      if (phone) home.later(home.replyAfterMs, () => zte.state.sms.push(zteSms(nextId++, phone, replyFor(content), "1", routerDate(0))));
    }
    step();
    return res;
  };
  return {
    cpe: null,
    // The goform pages have no "someone is signed in" flag FengSui reads: nothing to yield to
    human: { loginSameIp: () => undefined, logout: () => undefined },
    fetchImpl,
    base,
    advance: () => {
      w.step();
      sample = worldSample(home.now(), base, home.random);
      if (dataOn()) {
        connected += 5;
        monthDown += sample.downloadBytesPerSec * 5;
        monthUp += sample.uploadBytesPerSec * 5;
      }
      step();
    },
    pushOtp: () => {
      const code = String(100_000 + Math.floor(home.random() * 899_999));
      zte.state.sms.push(zteSms(nextId++, "DemoBank", `Your DemoBank verification code is ${code}. It expires in 10 minutes.`, "1", routerDate(0)));
    },
    setLatencyScale: home.setLatencyScale,
  };
}

/** A token of BotFather's shape that no bot has: the demo's bot only ever talks to `offlineTelegram()`. */
export const DEMO_BOT_TOKEN = "123456:DEMO_TOKEN_abcdefghijklmnopqrstuv";

/** The Bot API as far as the bot uses it, in this process: every send accepted, long polls that bring nothing. */
export function offlineTelegram(): typeof fetch {
  let messageId = 0;
  return async (input, init) => {
    const method = urlOf(input).pathname.split("/").pop() ?? "";
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (method === "getMe") return ok({ id: 1, is_bot: true, username: "FengSuiDemoBot" });
    if (method === "sendMessage") return ok({ message_id: ++messageId });
    if (method === "getUpdates") {
      await sleep(1000, init?.signal);
      return ok([]);
    }
    return ok(true);
  };
}
