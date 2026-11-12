import { DriverCpeClient } from "../../src/drivers/client.ts";
import { nradioProtocol } from "../../src/drivers/nradio.ts";
import { getXmlTag } from "../../src/xml.ts";
import { LanRouterMock } from "./lan-router.ts";

/**
 * A stand-in for an NRadio (NROS) router as a whole: LuCI's login and pages (overview, runtime, the
 * neighbour scan, the client list) and the module's HiLink-style bridge (network mode, band and cell
 * locks, the data switch, the antenna). Placeholder values only; nothing here talks to a real router.
 */

export const NRADIO_PASSWORD = "test-password";
export const NRADIO_URL = "http://192.168.66.1";
const OVERVIEW_HTML = `<html><body><div>设备型号: C2000 MAX</div><div>系统版本:1.9.2.n6</div><script>var a={};a['token']='a8f5f167f44f4964e6c998dee827110c';</script></body></html>`;

export interface NradioRouterState {
  dataswitch: "0" | "1";
  /** The module bridge's antenna code (`0` automatic, `1` external, `2` internal). */
  antenna: string;
  netMode: string;
  posts: Array<{ path: string; body: string; token: string | null }>;
}

export function nradioRouter(opts: { password?: string; accessList?: ReadonlyArray<string> } = {}) {
  const password = opts.password ?? NRADIO_PASSWORD;
  const state: NradioRouterState = {
    dataswitch: "1",
    antenna: "0",
    netMode: "<response><NetworkMode>00</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>7FFFFFFFFFFFFFFF</LTEBand><NR5GBand>7FFFFFFFFFFFFFFF</NR5GBand></response>",
    posts: [],
  };
  const ok = { text: `<?xml version="1.0" encoding="UTF-8"?><response>OK</response>` };
  const mock = new LanRouterMock((req) => {
    if (req.method === "POST" && req.path === "/cgi-bin/luci") {
      const form = LanRouterMock.form(req);
      if (form.get("luci_username") !== "root" || form.get("luci_password") !== password) return { status: 200, text: "<p>密码错误</p>" };
      return { status: 302, headers: { location: "/cgi-bin/luci" }, setCookie: ["sysauth=0123456789abcdef0123456789abcdef; path=/cgi-bin/luci"] };
    }
    if (!req.headers["cookie"]?.includes("sysauth=")) return { status: 403, text: "" };
    if (req.path === "/cgi-bin/luci/nradio/system/overview") return { text: OVERVIEW_HTML };
    if (req.path === "/cgi-bin/luci/nradio/system/overview_status") return { json: { system: { uptime: 86425, cpu_usage: "9%", mem_usage: "38%" }, modem: { imei: "860000000000000", imsi: "272010000000000", iccid: "8935301000000000000" } } };
    if (req.path === "/cgi-bin/luci/nradio/status/runtime/wan,cpe_4") {
      const up = state.dataswitch === "1";
      return { json: { wan: { up: false, download: "0", upload: "0" }, cpe_4: { up, uptime: 86425, isp: "Carrier-Lab", mode: "NR", ipaddr: up ? "198.51.100.42" : "", rsrp: "-79 dBm", rsrq: "-10 dB", sinr: "26 dB", pci: "0x8e", tac: "0x2711", cell: "134217758", earfcn: "650000", band: "78", download: "15849203712", upload: "2194810368" } } };
    }
    if (req.path === "/cgi-bin/luci/nradioadv/cellular/cpestatus/scaninfo") return { json: { code: 0, result: { neighbour: [[{ BAND: "78", EARFCN: "650000", PCI: "211", RSRP: "-88", RSRQ: "-13" }, { BAND: "1", EARFCN: "300", PCI: "0xd3", RSRP: "-95", RSRQ: "-12" }]] } } };
    if (req.path === "/cgi-bin/luci/nradio/client/all_list") {
      return {
        json: {
          result: {
            client: [
              { mac: "02:00:5E:10:00:01", hostname: "nas-ds923", type: "wired", exsit: 1 },
              { mac: "02:00:5E:10:00:03", hostname: "living-room-tv", type: "wireless", frequency: "5.8G", rssi: "-55", exsit: "1" },
            ],
          },
        },
      };
    }
    if (req.path === "/api/net/net-mode" && req.method === "GET") return { text: state.netMode };
    // The modes the module offers (left out: a bridge without the list)
    if (req.path === "/api/net/net-mode-list" && req.method === "GET") {
      return opts.accessList ? { text: `<response><AccessList>${opts.accessList.map((code) => `<Access>${code}</Access>`).join("")}</AccessList><BandList></BandList><LTEBandList></LTEBandList></response>` } : { status: 404, text: "" };
    }
    if (req.path === "/api/device/information" && req.method === "GET") return { text: "<response><DeviceName>module</DeviceName><HardwareVersion>HW1.0</HardwareVersion></response>" };
    if (req.path === "/api/dialup/mobile-dataswitch" && req.method === "GET") return { text: `<response><dataswitch>${state.dataswitch}</dataswitch></response>` };
    if (req.path === "/api/device/antenna_set_type" && req.method === "GET") return { text: `<response><antennasettype>${state.antenna}</antennasettype></response>` };
    if (req.path === "/cgi-bin/luci/nradio/logout") return { status: 302, headers: { location: "/" } };
    state.posts.push({ path: req.path, body: req.body, token: req.query.get("token") });
    if (req.path === "/api/net/net-mode") {
      state.netMode = `<response><NetworkMode>${getXmlTag(req.body, "NetworkMode") ?? ""}</NetworkMode><NetworkBand>3FFFFFFF</NetworkBand><LTEBand>${getXmlTag(req.body, "LTEBand") ?? ""}</LTEBand><NR5GBand>${getXmlTag(req.body, "NR5GBand") ?? ""}</NR5GBand></response>`;
      return ok;
    }
    if (req.path === "/api/dialup/mobile-dataswitch") {
      state.dataswitch = req.body.includes("<dataswitch>1</dataswitch>") ? "1" : "0";
      return ok;
    }
    if (req.path === "/api/device/antenna_set_type") {
      state.antenna = /<antennasettype>(\d)<\/antennasettype>/.exec(req.body)?.[1] ?? "?";
      return ok;
    }
    if (req.path === "/api/net/lock-freq") return ok;
    if (req.path === "/cgi-bin/luci/admin/system/reboot/call") return { status: 200, text: "" };
    return { status: 404, text: "" };
  });
  const client = new DriverCpeClient({ protocol: nradioProtocol, cpeUrl: NRADIO_URL, cpeUsername: "root", cpePassword: password, fetchImpl: mock.fetchImpl, requestTimeoutMs: 2000 });
  return { mock, state, client };
}
