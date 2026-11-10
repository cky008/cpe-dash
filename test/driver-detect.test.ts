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
    assert.equal(mock.requests.length, DETECTION_ORDER.length, "one request per family");
    for (const req of mock.requests) {
      assert.equal(req.headers["cookie"], undefined, `${req.method} ${req.path}`);
      assert.ok(!/passw|luci_password|"password"/i.test(`${req.body} ${[...req.query.values()].join(" ")}`), `${req.method} ${req.path} carries no password`);
    }
    // Every POST is one of the families' own login-free calls (a token, a status, an anonymous ubus read)
    assert.deepEqual(mock.requests.filter((r) => r.method === "POST").map((r) => r.path).sort(), ["/cgi-bin/http.cgi", "/goform/get_login_info", "/ubus", "/ubus/"]);
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
