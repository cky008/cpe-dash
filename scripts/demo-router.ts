import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FengSuiRuntimeStack, createFengSuiRuntime, startServeDaemon } from "../src/cli.ts";
import { loadConfig } from "../src/config.ts";
import { type FamilySms, createCpeFamily } from "../test/helpers/cpe-family.ts";
import { type StrictCpe, createStrictCpe } from "../test/helpers/strict-cpe.ts";

/**
 * The offline demo world shared by `npm run demo`, the static GitHub Pages demo's seed capture
 * (scripts/capture-demo-seed.ts) and its contract test: the in-process strict H168-383 model from
 * test/helpers, dressed with a believable household (signal walk, traffic, LAN hosts, a Wi-Fi
 * blacklist entry, a time rule and a mailbox), and the real daemon in front of it. No request ever
 * leaves the process, the project's .env is never read, and every identifier is an RFC / reserved
 * placeholder (AGENTS.md 铁律二).
 */

export const DEMO_CPE_PASSWORD = "demo-router-password";

export interface DemoRouter {
  /** The strict H168-383 model (`null` in the unverified-model world). */
  cpe: StrictCpe | null;
  /** A person on the router's own web page (the avoidance banner). */
  human: { loginSameIp(): void; logout(): void };
  /** The model's fetch, with set-read / delete-sms mirrored onto its mailbox. */
  fetchImpl: typeof fetch;
  /** Advance the signal and traffic walk by one 5 s step. */
  advance(): void;
  /** Deliver a fresh DemoBank one-time code. */
  pushOtp(): void;
}

export function createDemoRouter(): DemoRouter {
  let tick = 0;
  const walk = (base: number, spread: number, period: number): number =>
    Math.round((base + Math.sin(tick / period) * spread + (Math.random() - 0.5) * spread * 0.6) * 10) / 10;

  let monthDown = 1_160_491_161_608;
  let monthUp = 87_430_687_669;
  let dayUsed = 11_888_746_002;
  let dlRate = 0;
  let ulRate = 0;

  function signalXml(): string {
    const lteRsrp = walk(-87, 3, 9);
    const nrRsrp = walk(-95, 5, 7);
    return `<response><pci>211</pci><cell_id>134217758</cell_id><rsrq>${walk(-7, 1.5, 6)}dB</rsrq><rsrp>${lteRsrp}dBm</rsrp><rssi>${walk(-70, 2, 8)}dBm</rssi><sinr>${walk(13, 3, 5)}dB</sinr><mode>7</mode><ulbandwidth>20MHz</ulbandwidth><dlbandwidth>20MHz</dlbandwidth><txpower>PPusch:${walk(12, 4, 4)}dBm PPucch:${walk(-9, 3, 5)}dBm PSrs:0dBm PPrach:-3dBm</txpower><ul_mcs>mcsUpCarrier1:27@256QAM</ul_mcs><dl_mcs>mcsDownCarrier1Code0:${20 + (tick % 5)}@256QAM mcsDownCarrier1Code1:18@64QAM</dl_mcs><earfcn>DL:300 UL:18300</earfcn><tac>10001</tac><band>20MHz@300(B1) + 20MHz@1850(B3) + 100MHz@650000(N78)</band><plmn>27201</plmn><transmode>TM[4]</transmode><enodeb_id>0524288</enodeb_id><cqi0>12</cqi0><cqi1>11</cqi1><nrulbandwidth>100MHz</nrulbandwidth><nrdlbandwidth>100MHz</nrdlbandwidth><nrulmcs>NRmcsUpCarrier1:20@256QAM</nrulmcs><nrdlmcs>NRmcsDownCarrier1Code0:${15 + (tick % 7)}@64QAM NRmcsDownCarrier1Code1:0</nrdlmcs><nrtxpower>PPusch:${walk(21, 2, 6)}dBm PPucch:${walk(18, 3, 4)}dBm PSrs:0dBm PPrach:5dBm</nrtxpower><nrearfcn>650000</nrearfcn><nrsinr>${walk(9, 4, 5)}dB</nrsinr><nrrsrp>${nrRsrp}dBm</nrrsrp><nrrsrq>${walk(-10.5, 1.5, 6)}dB</nrrsrq><nrrssi>-72dBm</nrrssi><nrrank>2</nrrank><nrcqi0>12</nrcqi0><nrcqi1>11</nrcqi1></response>`;
  }

  function trafficXml(): string {
    // A slow wave of downloads with bursts, in bytes per second like the router reports
    const wave = Math.max(0, Math.sin(tick / 12)) * 9_000_000 + Math.max(0, Math.sin(tick / 3.3)) * 2_500_000;
    dlRate = Math.round(wave + 180_000 + Math.random() * 400_000);
    ulRate = Math.round(dlRate * (0.08 + Math.random() * 0.06) + 60_000);
    monthDown += dlRate * 5;
    monthUp += ulRate * 5;
    dayUsed += (dlRate + ulRate) * 5;
    return `<response><CurrentConnectTime>${346_909 + tick * 5}</CurrentConnectTime><CurrentUpload>80240562176</CurrentUpload><CurrentDownload>191780421632</CurrentDownload><CurrentDownloadRate>${dlRate}</CurrentDownloadRate><CurrentUploadRate>${ulRate}</CurrentUploadRate><TotalUpload>2418923415594</TotalUpload><TotalDownload>5541561494560</TotalDownload><TotalConnectTime>12193610</TotalConnectTime></response>`;
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

  const STATIC_BODIES: Readonly<Record<string, string>> = {
    "/api/device/information":
      "<response><DeviceName>H168-383</DeviceName><Imei>860000000000000</Imei><Imsi>272010000000000</Imsi><Msisdn>+353830000000</Msisdn><MacAddress1>02:00:5E:10:00:FE</MacAddress1><HardwareVersion>WL1H168M</HardwareVersion><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion><WebUIVersion>WEBUI 4.4.0.1(W2SP24C03)</WebUIVersion><uptime>86400</uptime><WanIPAddress>198.51.100.42</WanIPAddress><wan_dns_address>203.0.113.53,198.51.100.53</wan_dns_address><WanIPv6Address>2001:db8::42</WanIPv6Address><wan_ipv6_dns_address>2001:db8::53</wan_ipv6_dns_address><workmode>LTE</workmode></response>",
    "/api/device/seccellinfo":
      "<response><lteseccell_list>1850,B3,20MHz,142,-84dBm,-6dB,-70dBm,14dB;</lteseccell_list><nrseccell_list>650000,N78,100MHz,211,-95dBm,-10dB,-72dBm,8dB;</nrseccell_list></response>",
    "/api/device/nbrcellinfo":
      "<response><nbrcell_ltelist>1850,B3,142,-84dBm,-6dB,-69dBm,14dB;1850,B3,211,-87dBm,-10dB,-69dBm,--;300,B1,211,-88dBm,-8dB,-70dBm,12dB;300,B1,142,-96dBm,-12dB,-70dBm,--;6300,B20,133,-101dBm,-13dB,-75dBm,4dB;3050,B7,288,-108dBm,-16dB,-80dBm,-1dB;</nbrcell_ltelist><nbrcell_nrlist>650000,N78,211,-95dBm,-10dB,-72dBm,8dB;650000,N78,412,-99dBm,-12dB,-74dBm,5dB;636666,N78,88,-104dBm,-14dB,-79dBm,2dB;</nbrcell_nrlist></response>",
    "/api/monitoring/start_date": "<response><StartDay>1</StartDay><DataLimit>2000GB</DataLimit><MonthThreshold>90</MonthThreshold></response>",
    // What the identification probe reads (docs/PHASE1_PROTOCOL_SPEC.md 3.4 and 4.1)
    "/api/net/net-feature-switch":
      "<response><net_premode_switch>2</net_premode_switch><lteband_switch>0</lteband_switch><select_band_switch>1</select_band_switch><lock_freq_switch>3</lock_freq_switch><antenna_select_switch>0</antenna_select_switch><reconnect_switch>1</reconnect_switch><net_mode_enable>1</net_mode_enable></response>",
    "/api/net/net-mode-list":
      "<response><LTEBandList><LTEBand><Name>LTE BC1/BC3/BC5/BC7/BC8/BC20/BC28/BC32/BC38/BC40/BC41/BC42/BC43/BC71</Name><Value>40000007a0880800d5</Value></LTEBand></LTEBandList></response>",
  };

  const cpe = createStrictCpe({
    password: DEMO_CPE_PASSWORD,
    latencyMs: () => 6 + Math.random() * 20,
    fault: (p, method) => {
      if (method !== "GET") return undefined;
      if (p === "/api/device/signal") return { body: signalXml() };
      if (p === "/api/monitoring/traffic-statistics") return { body: trafficXml() };
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

  /** Mirror set-read / delete-sms onto the model (the strict router only acknowledges them). */
  const demoFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === "string" ? init.body : "";
    const res = await cpe.fetchImpl(input, init);
    if ((url.pathname === "/api/sms/set-read" || url.pathname === "/api/sms/delete-sms") && res.ok) {
      const indexes = new Set([...body.matchAll(/<Index>(\d+)<\/Index>/g)].map((m) => Number(m[1])));
      for (const box of [cpe.inbox, cpe.outbox]) {
        for (let i = box.length - 1; i >= 0; i--) {
          const msg = box[i];
          if (!msg || !indexes.has(msg.index)) continue;
          if (url.pathname === "/api/sms/delete-sms") box.splice(i, 1);
          else msg.smstat = "1";
        }
      }
    }
    return res;
  };

  function routerDate(offsetMin: number): string {
    const d = new Date(Date.now() - offsetMin * 60_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

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
    advance: () => {
      tick += 1;
    },
    pushOtp: () => {
      const code = String(100_000 + Math.floor(Math.random() * 899_999));
      cpe.pushIncoming({ phone: "DemoBank", content: `Your DemoBank verification code is ${code}. It expires in 10 minutes.`, date: routerDate(0) });
    },
  };
}

/**
 * The unverified-model world (multi-model phase 2): an LTE-only router of another Huawei model from
 * the phase-1 mock family, with a legacy SHA-256 login, the HiLink basics (signal, status, traffic,
 * month statistics, an XML device list, plaintext SMS) and nothing else. FengSui reads what it
 * provides and writes what it implements for such a model, each write on until its owner turns it
 * off: the router takes the generic writes of appendix A.11 (band mask, mobile data, redial, reboot,
 * plaintext SMS), a redial or reboot starts the connection again and mobile data off takes the WAN down. Facts and
 * placeholders only (docs/PHASE1_PROTOCOL_SPEC.md A.10, A.11).
 */
export function createUnverifiedDemoRouter(): DemoRouter {
  let tick = 0;
  /** The connection's age at `connectedAt` ticks: a redial or reboot starts it again. */
  let connectBase = 86_400;
  let connectedAt = 0;
  const walk = (base: number, spread: number, period: number): number => Math.round((base + Math.sin(tick / period) * spread) * 10) / 10;
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
    "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE BC1/BC3/BC7/BC8/BC20/BC32</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
    "/api/monitoring/start_date": "<response><StartDay>1</StartDay><DataLimit>500GB</DataLimit><MonthThreshold>90</MonthThreshold></response>",
    "/api/lan/HostInfo": `<response><Hosts>${hosts
      .map((host, i) => `<Host><ID>${i + 1}</ID><MacAddress>${host.mac}</MacAddress><IpAddress>${host.ip}</IpAddress><HostName>${host.name}</HostName><Active>1</Active><InterfaceType>${host.type}</InterfaceType>${host.frequency ? `<Frequency>${host.frequency}</Frequency>` : ""}</Host>`)
      .join("")}</Hosts></response>`,
  };
  const step = (): void => {
    const dl = Math.round(Math.max(0, Math.sin(tick / 10)) * 4_000_000 + 120_000);
    monthDown += dl * 5;
    dayUsed += dl * 6;
    endpoints["/api/device/signal"] = `<response><pci>25</pci><cell_id>134217758</cell_id><rsrq>${walk(-9, 1.5, 6)}dB</rsrq><rsrp>${walk(-96, 3, 9)}dBm</rsrp><rssi>${walk(-69, 2, 8)}dBm</rssi><sinr>${walk(11, 3, 5)}dB</sinr><mode>7</mode><dlbandwidth>20MHz</dlbandwidth><ulbandwidth>20MHz</ulbandwidth><tac>10001</tac><plmn>27201</plmn></response>`;
    endpoints["/api/monitoring/traffic-statistics"] = `<response><CurrentConnectTime>${connectBase + (tick - connectedAt) * 5}</CurrentConnectTime><CurrentUpload>52428800</CurrentUpload><CurrentDownload>524288000</CurrentDownload><CurrentDownloadRate>${dl}</CurrentDownloadRate><CurrentUploadRate>${Math.round(dl / 9)}</CurrentUploadRate><TotalUpload>48318382080</TotalUpload><TotalDownload>412316860416</TotalDownload><TotalConnectTime>9000000</TotalConnectTime></response>`;
    endpoints["/api/monitoring/month_statistics"] = `<response><CurrentMonthDownload>${monthDown}</CurrentMonthDownload><CurrentMonthUpload>41000000000</CurrentMonthUpload><MonthDuration>2400000</MonthDuration><MonthLastClearTime>2026-10-01</MonthLastClearTime><CurrentDayUsed>${dayUsed}</CurrentDayUsed><CurrentDayDuration>40000</CurrentDayDuration></response>`;
  };
  step();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const routerDate = (offsetMin: number): string => {
    const d = new Date(Date.now() - offsetMin * 60_000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const mailbox: FamilySms[] = [
    { index: 40011, phone: "DemoBank", content: "Your DemoBank verification code is 315902. It expires in 10 minutes.", date: routerDate(6), smstat: "0", box: 1 },
    { index: 40010, phone: "+353830000001", content: "Back home by 8, see you then", date: routerDate(90), smstat: "1", box: 1 },
    { index: 39010, phone: "+353830000001", content: "Great, dinner is on me", date: routerDate(85), smstat: "3", box: 2 },
  ];
  // No marketing name: a 4G router should not show the family's "5G CPE" one, and the model says enough
  const cpe = createCpeFamily({ login: "sha256", tokenFlow: "token", password: DEMO_CPE_PASSWORD, model: "B535-232", firmware: "11.0.1.2(H7SP2C00)", marketingName: null, endpoints, sms: mailbox, writes: {} });
  let nextIndex = 40_012;
  // What a generic write does to the household: a new connection, or no WAN without mobile data
  const demoFetch: typeof fetch = async (input, init) => {
    const res = await cpe.fetchImpl(input, init);
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return res;
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if ((await res.clone().text()).includes("<error>")) return res;
    if (path === "/api/net/reconnect" || path === "/api/device/control") {
      connectBase = 0;
      connectedAt = tick;
      step();
    }
    if (path === "/api/dialup/mobile-dataswitch") cpe.setConnectionStatus(cpe.settings.mobileData() === "1" ? "901" : "902");
    return res;
  };
  return {
    cpe: null,
    human: cpe.human,
    fetchImpl: demoFetch,
    advance: () => {
      tick += 1;
      step();
    },
    pushOtp: () => {
      const code = String(100_000 + Math.floor(Math.random() * 899_999));
      cpe.smsStore?.push({ index: nextIndex++, phone: "DemoBank", content: `Your DemoBank verification code is ${code}. It expires in 10 minutes.`, date: routerDate(0), smstat: "0", box: 1 });
    },
  };
}

export interface DemoDaemonOptions {
  /** `0` picks a free port. */
  port: number;
  token: string;
  /** `breaker`: a wrong CPE password, so the anti-lockout breaker trips; `unverified`: another model, with experimental writes. */
  scenario?: "normal" | "yield" | "breaker" | "unverified";
  /**
   * Run the Telegram bot against an in-process stand-in for the Bot API (nothing leaves the process),
   * with `TELEGRAM_CHAT_IDS=1003`: Settings → Telegram can then link, list and unlink chats.
   */
  telegram?: boolean;
  log?: (line: string) => void;
}

export interface DemoDaemon {
  router: DemoRouter;
  stack: FengSuiRuntimeStack;
  baseUrl: string;
  dataDir: string;
  close(): Promise<void>;
}

/** A token of BotFather's shape that no bot has: the demo's bot only ever talks to `offlineTelegram()`. */
const DEMO_BOT_TOKEN = "123456:DEMO_TOKEN_abcdefghijklmnopqrstuv";

/** The Bot API as far as the bot uses it, in this process: every send accepted, long polls that bring nothing. */
function offlineTelegram(): typeof fetch {
  let messageId = 0;
  return async (input, init) => {
    const method = new URL(String(input)).pathname.split("/").pop() ?? "";
    const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
    if (method === "getMe") return ok({ id: 1, is_bot: true, username: "FengSuiDemoBot" });
    if (method === "sendMessage") return ok({ message_id: ++messageId });
    if (method === "getUpdates") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 1000);
        init?.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
          },
          { once: true }
        );
      });
      return ok([]);
    }
    return ok(true);
  };
}

/** The real daemon (scheduler, monitor, SMS, SSE, REST, MCP, web UI) against the demo router. */
export async function startDemoDaemon(opts: DemoDaemonOptions): Promise<DemoDaemon> {
  const router = opts.scenario === "unverified" ? createUnverifiedDemoRouter() : createDemoRouter();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fengsui-demo-"));
  const envFile = path.join(dataDir, "demo.env");
  fs.writeFileSync(envFile, "# generated by scripts/demo-router.ts\n", { mode: 0o600 });
  const config = loadConfig({
    envPath: envFile,
    ignoreProcessEnv: true,
    overrides: {
      CPE_URL: "http://192.168.8.1",
      CPE_PASSWORD: opts.scenario === "breaker" ? "not-the-router-password" : DEMO_CPE_PASSWORD,
      DATA_ENCRYPTION_KEY: crypto.randomBytes(24).toString("hex"),
      API_TOKEN: opts.token,
      WEB_HOST: "127.0.0.1",
      WEB_PORT: String(opts.port),
      STATE_FILE: path.join(dataDir, "state.json"),
      POLL_INTERVAL_MS: "5000",
      NEIGHBOR_SCAN_INTERVAL_MS: "60000",
      SMS_SEND_STATUS_TIMEOUT_MS: "8000",
      // The household runs self-healing (the static demo shows the same): its WAN never drops, so it never writes
      LOCK_ROLLBACK_AFTER_MIN: "10",
      WAN_AUTO_RECONNECT_AFTER_MIN: "3",
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
  // Belt and braces: nothing in this process may notify or announce itself (a bot, if asked for, talks to a stand-in)
  const demoConfig = {
    ...config,
    telegramBotToken: opts.telegram ? DEMO_BOT_TOKEN : "",
    telegramChatIds: opts.telegram ? ["1003"] : [],
    webhookUrl: "",
    webhookSecret: "",
    peerDiscoveryEnabled: false,
  };

  const stack = createFengSuiRuntime({
    config: demoConfig,
    envPath: envFile,
    fetchImpl: router.fetchImpl,
    ...(opts.telegram ? { notifyFetchImpl: offlineTelegram() } : {}),
    log: opts.log ?? (() => undefined),
  });
  // The household is set up already: no first-run review over the dashboard
  stack.settings.markReviewed();
  let address: { host: string; port: number } | null;
  try {
    address = await startServeDaemon(stack);
  } catch (err) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
  return {
    router,
    stack,
    baseUrl: `http://${address?.host ?? "127.0.0.1"}:${address?.port ?? opts.port}`,
    dataDir,
    close: async () => {
      await stack.close().catch(() => undefined);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
