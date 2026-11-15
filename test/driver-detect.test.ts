import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DETECTION_ORDER, detectRouterFamily } from "../src/drivers/detect.ts";
import { ROUTER_FAMILIES, type RouterFamily } from "../src/router-family.ts";
import { type LanHandler, type LanReply, LanRouterMock } from "./helpers/lan-router.ts";

/**
 * Telling a router's brand from what it answers without a login. Each stand-in answers only its own
 * family's login-free request (and the ones a real router of that family would answer as well);
 * everything else gets what an embedded web server gives an unknown path. Mocks only, no network.
 */

const NOT_FOUND: LanReply = { status: 404, text: "<html><body>404 Not Found</body></html>" };
const ubus = (result: unknown): LanReply => ({ json: { jsonrpc: "2.0", id: 1, result } });
const ubusParams = (body: string): unknown[] => (JSON.parse(body) as { params: unknown[] }).params;

/** What each family's router answers to its own login-free request. */
const SIGNATURES: Readonly<Record<RouterFamily, LanHandler>> = {
  huawei: (req) => (req.method === "GET" && req.path === "/api/user/state-login" ? { text: "<response><State>-1</State><password_type>4</password_type></response>" } : NOT_FOUND),
  "zte-goform": (req) =>
    req.method === "GET" && req.path === "/goform/goform_get_cmd_process" ? { json: { model_name: "MC801A", hardware_version: "MC801A_HW1.0", wa_inner_version: "BD_ZTE_MC801AV1.0.0B05", cr_version: "" } } : NOT_FOUND,
  "zte-zwrt": (req) => {
    if (req.method !== "POST" || req.path !== "/ubus/") return NOT_FOUND;
    const [, object, method] = ubusParams(req.body);
    return object === "zwrt_web" && method === "web_language_get" ? ubus([0, { Language: "cn" }]) : { json: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Access denied" } } };
  },
  pinsu: (req) => (req.method === "POST" && req.path === "/goform/get_login_info" ? { json: { retcode: "0", loginStatus: "0" } } : NOT_FOUND),
  tozed: (req) => (req.method === "POST" && req.path === "/cgi-bin/http.cgi" ? { json: { success: true, cmd: 232, token: "a1b2c3d4e5f60718293a4b5c6d7e8f90" } } : NOT_FOUND),
  fiberhome: (req) => (req.method === "GET" && req.path === "/api/tmp/FHNCAPIS" ? { json: { sessionid: "0123456789abcdef0123456789abcdef" } } : NOT_FOUND),
  nradio: (req) => {
    if (req.method === "GET" && req.path === "/cgi-bin/luci") return { text: '<html><head><link rel="stylesheet" href="/luci-static/nradio/cascade.css"></head><form action="/cgi-bin/luci"></form></html>' };
    // NROS is OpenWrt underneath: its ubus refuses an anonymous caller like any other
    if (req.method === "POST" && (req.path === "/ubus" || req.path === "/ubus/")) return { json: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Access denied" } } };
    return NOT_FOUND;
  },
  // The DWR web interface: `data.ria` says "not signed in" in its own words
  dlink: (req) => (req.method === "GET" && req.path === "/data.ria" ? { json: { login_fail: "timeout" } } : NOT_FOUND),
  // The page's key request: an RSA modulus, an exponent and the number its signatures count from
  tplink: (req) => (req.method === "POST" && req.path === "/cgi/getParm" ? { text: `var ee="010001";\nvar nn="c${"0".repeat(126)}1";\nvar seq="266656725";\n$.ret=0;\n` } : NOT_FOUND),
  openwrt: (req) => (req.method === "POST" && (req.path === "/ubus" || req.path === "/ubus/") ? { json: { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Access denied" } } } : NOT_FOUND),
};

const detect = (mock: LanRouterMock, url = "http://192.168.8.1") => detectRouterFamily({ cpeUrl: url, fetchImpl: mock.fetchImpl, requestTimeoutMs: 500 });

describe("drivers: telling the brand before any login", () => {
  it("names every family from its own login-free answer", async () => {
    assert.deepEqual([...DETECTION_ORDER].sort(), [...ROUTER_FAMILIES].sort(), "every family has a signature");
    for (const family of ROUTER_FAMILIES) {
      const mock = new LanRouterMock(SIGNATURES[family]);
      assert.equal(await detect(mock), family, family);
    }
  });

  it("sends no password, no cookie and no write: only the families' first reads", async () => {
    const mock = new LanRouterMock(SIGNATURES.huawei);
    await detect(mock);
    // One request per family, and one more each where a family has a second form the first did not find:
    // ZTE's other spelling of the same read, FiberHome's Pro path, D-Link's two login pages, TP-Link's other form
    assert.equal(mock.requests.length, DETECTION_ORDER.length + 5, "the families' first reads");
    assert.deepEqual(mock.requests.filter((r) => /^\/(data\.ria|login\.html|index\.html)$/.test(r.path)).map((r) => `${r.method} ${r.path}?${r.query.toString()}`), ["GET /data.ria?token=1", "GET /login.html?", "GET /index.html?"]);
    assert.deepEqual(mock.requests.filter((r) => /FHNCAPIS$/.test(r.path)).map((r) => r.path).sort(), ["/api/tmp/FHNCAPIS", "/fh_api/tmp/FHNCAPIS"]);
    assert.deepEqual(mock.requests.filter((r) => /^\/(goform|reqproc)\//.test(r.path) && r.method === "GET").map((r) => r.path).sort(), ["/goform/goform_get_cmd_process", "/reqproc/proc_get"]);
    for (const req of mock.requests) {
      assert.equal(req.headers["cookie"], undefined, `${req.method} ${req.path}`);
      assert.ok(!/passw|luci_password|"password"/i.test(`${req.body} ${[...req.query.values()].join(" ")}`), `${req.method} ${req.path} carries no password`);
    }
    // Every POST is one of the families' own login-free calls (a token, a status, an anonymous ubus read)
    assert.deepEqual(mock.requests.filter((r) => r.method === "POST").map((r) => r.path).sort(), ["/cgi-bin/http.cgi", "/cgi/getGDPRParm", "/cgi/getParm", "/goform/get_login_info", "/ubus", "/ubus/"]);
    for (const r of mock.requests.filter((r) => r.path.startsWith("/cgi/get"))) assert.equal(r.body, "", "TP-Link's key request carries nothing");
    assert.deepEqual(JSON.parse(mock.requests.find((r) => r.path === "/cgi-bin/http.cgi")?.body ?? "{}"), { cmd: 232, method: "GET", language: "CN", sessionId: "" });
    for (const r of mock.requests.filter((r) => r.path === "/ubus" || r.path === "/ubus/")) assert.equal(ubusParams(r.body)[0], "0".repeat(32), "the anonymous ubus session");
  });

  it("prefers the family with pages of its own when a router answers more than one signature", async () => {
    // A ZTE zWRT router is OpenWrt underneath and may keep the goform reads for older apps
    const zwrt = new LanRouterMock((req) => {
      const own = SIGNATURES["zte-zwrt"](req) as LanReply;
      return own.status === 404 ? (SIGNATURES["zte-goform"](req) as LanReply) : own;
    });
    assert.equal(await detect(zwrt), "zte-zwrt");
    // NROS answers ubus too, and its module bridge HiLink-style paths
    const nros = new LanRouterMock((req) => {
      const own = SIGNATURES.nradio(req) as LanReply;
      return own.status === 404 ? (SIGNATURES.huawei(req) as LanReply) : own;
    });
    assert.equal(await detect(nros), "nradio");
  });

  it("tells a D-Link router from an OpenWrt one, both ways", async () => {
    // The DWR web interface by its login page alone (a firmware whose `data.ria` answers a page when signed out)
    const byPage = new LanRouterMock((req) => (req.method === "GET" && req.path === "/login.html" ? { text: '<script>function encode_passwd(p){} $.post("login.cgi")</script>' } : { text: "<html>Login</html>" }));
    assert.equal(await detect(byPage), "dlink");
    const olderPage = new LanRouterMock((req) => (req.method === "GET" && req.path === "/index.html" ? { text: '<script>$.post("login.cgi"); setCookie("DWRLOGGEDID", id)</script>' } : NOT_FOUND));
    assert.equal(await detect(olderPage), "dlink");
    // A plain OpenWrt router has LuCI's login page and ubus, none of D-Link's paths: it stays OpenWrt
    const openwrt = new LanRouterMock((req) => {
      if (req.method === "GET" && (req.path === "/cgi-bin/luci" || req.path === "/index.html")) return { text: '<html><title>OpenWrt - LuCI</title><form action="/cgi-bin/luci"><input name="luci_password"></form></html>' };
      return SIGNATURES.openwrt(req) as LanReply;
    });
    assert.equal(await detect(openwrt), "openwrt");
    // A D-Link router that runs OpenWrt (LuCI and ubus under D-Link's name) is named for its interface, OpenWrt's
    const dlinkOnOpenwrt = new LanRouterMock((req) => {
      if (req.method === "GET" && (req.path === "/login.html" || req.path === "/index.html")) return { text: '<html><title>D-Link</title><meta http-equiv="refresh" content="0; url=/cgi-bin/luci/"></html>' };
      return SIGNATURES.openwrt(req) as LanReply;
    });
    assert.equal(await detect(dlinkOnOpenwrt), "openwrt");
    // The DWR web interface has no ubus: a router that answered both would still be named by its own pages
    const both = new LanRouterMock((req) => {
      const own = SIGNATURES.dlink(req) as LanReply;
      return own.status === 404 ? (SIGNATURES.openwrt(req) as LanReply) : own;
    });
    assert.equal(await detect(both), "dlink");
    // A login page that only posts to `login.cgi`, as many embedded pages do, names nobody
    const generic = new LanRouterMock((req) => (req.path === "/login.html" ? { text: '<form action="login.cgi"></form>' } : NOT_FOUND));
    assert.equal(await detect(generic), null);
  });

  it("places nothing it cannot tell: a web server that answers every path, wrong shapes, silence", async () => {
    const catchAll = new LanRouterMock(() => ({ text: "<html><body>Login</body></html>" }));
    assert.equal(await detect(catchAll), null);
    const shapes = new LanRouterMock((req) => {
      if (req.path === "/api/user/state-login") return { text: "<error><code>100002</code></error>" };
      if (req.path === "/goform/goform_get_cmd_process") return { json: { hardware_version: "", wa_inner_version: "" } };
      if (req.path === "/goform/get_login_info") return { json: { retcode: "300" } };
      if (req.path === "/cgi-bin/http.cgi") return { json: { success: false, token: "" } };
      if (req.path === "/api/tmp/FHNCAPIS") return { json: { sessionid: "" } };
      if (req.path === "/cgi-bin/luci") return { text: "<html><title>OpenWrt - LuCI</title></html>" };
      if (req.path.startsWith("/ubus")) return { json: { ok: true } };
      if (req.path === "/data.ria") return { json: { cmd_status: "Done" } };
      if (req.path.startsWith("/cgi/get")) return { text: 'var ee="010001";\nvar nn="zz";\nvar seq="1";\n' };
      return NOT_FOUND;
    });
    assert.equal(await detect(shapes), null);
    const dead = new LanRouterMock(() => {
      throw new TypeError("fetch failed");
    });
    assert.equal(await detect(dead), null);
    const slow = new LanRouterMock(() => new Promise<LanReply>(() => undefined));
    assert.equal(await detectRouterFamily({ cpeUrl: "http://192.168.8.1", fetchImpl: slow.fetchImpl, requestTimeoutMs: 30 }), null, "a router that never answers is not waited for");
  });

  it("talks to LAN addresses only", async () => {
    const mock = new LanRouterMock(SIGNATURES.huawei);
    await assert.rejects(detect(mock, "http://203.0.113.10"));
    await assert.rejects(detect(mock, "http://admin:pw@192.168.8.1"));
    assert.equal(mock.requests.length, 0);
    assert.equal(await detect(mock, "192.168.8.1/"), "huawei", "the address is normalized like every other");
  });
});
