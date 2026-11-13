import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { CpeControlValidationError } from "../src/control-error.ts";
import { HuaweiCpeClient } from "../src/protocols/hilink/client.ts";
import {
  DISCOVERY_MAX_PATHS,
  type DiscoverySession,
  FENGSUI_ROUTER_ENDPOINTS,
  discoverEndpoints,
  discoveryRefusal,
  readDiscoveryPaths,
} from "../src/endpoint-discovery.ts";
import { blockNetwork, createCpeFamily } from "./helpers/cpe-family.ts";

/**
 * Read-only discovery for AI agents testing a router: GETs of endpoints FengSui does not use,
 * through FengSui's own session, never a login of the agent's own. What comes back is structure
 * only (tag paths and value shapes), as in the device report. Placeholders only, no network.
 */

let restore: () => void;
before(() => {
  restore = blockNetwork();
});
after(() => restore());

const ENDPOINTS = {
  "/api/device/autorun-version": "<response><Version>9.9.9-placeholder</Version></response>",
  "/api/wlan/multi-basic-settings":
    "<response><Ssids><Ssid><WifiSsid>Placeholder-Home</WifiSsid><WifiWpapsk>placeholder-passphrase</WifiWpapsk></Ssid><Ssid><WifiSsid>Placeholder-Guest</WifiSsid><WifiWpapsk>other-passphrase</WifiWpapsk></Ssid></Ssids></response>",
  "/api/pin/status": { cpeError: "100003" },
  "/api/net/net-mode-list": "<response><LTEBandList><LTEBand><Name>LTE</Name><Value>800800C5</Value></LTEBand></LTEBandList></response>",
};

function family(endpoints: Readonly<Record<string, string | { cpeError: string }>> = ENDPOINTS) {
  return createCpeFamily({ login: "sha256", tokenFlow: "token", model: "B535-232", endpoints });
}

describe("endpoint discovery: what may be read", () => {
  it("takes 1–12 API paths, each once, and nothing that is not one", () => {
    assert.deepEqual(readDiscoveryPaths(["/api/device/autorun-version", "/api/lan/HostInfo", "/api/device/autorun-version"]), [
      "/api/device/autorun-version",
      "/api/lan/HostInfo",
    ]);
    const tooMany = Array.from({ length: DISCOVERY_MAX_PATHS + 1 }, (_, i) => `/api/device/p${i}`);
    for (const bad of [undefined, "/api/device/signal", [], [42], ["api/device/signal"], ["/api/device"], ["/api/device/signal?x=1"], ["/api/../device/signal"], ["/api/device/sig nal"], [`/api/${"a".repeat(40)}/${"b".repeat(60)}`], tooMany]) {
      assert.throws(() => readDiscoveryPaths(bad), CpeControlValidationError, JSON.stringify(bad));
    }
  });

  it("refuses the session's own endpoints and GETs that act on some firmware, before anything is sent", () => {
    for (const path of ["/api/user/remind", "/api/webserver/token", "/api/webserver/SesTokInfo", "/api/stk/stk-get-main-menu", "/api/ussd/get", "/api/filemanager/upload"]) {
      assert.equal(discoveryRefusal(path), "session", path);
    }
    const acting = [
      "/api/net/plmn-list",
      "/api/device/control",
      "/api/sms/send-sms",
      "/api/sms/delete-sms",
      "/api/sms/set-read",
      "/api/net/reconnect",
      "/api/dialup/dial",
      "/api/monitoring/clear-traffic",
      "/api/online-update/check-new-version",
      "/api/online-update/ack-newversion",
      "/api/wlan/wps-pbc",
      "/api/pin/operate",
      "/api/device/compressed-logs",
      "/api/wlan/wifi-scan",
      "/api/sms/deleteSms",
    ];
    for (const path of acting) assert.equal(discoveryRefusal(path), "acts", path);
    for (const path of ["/api/online-update/status", "/api/pin/status", "/api/device/autorun-version", "/api/wlan/basic-settings", "/api/net/register", "/api/dialup/connection", "/api/monitoring/check-notifications", "/api/lan/HostInfo"]) {
      assert.equal(discoveryRefusal(path), null, path);
    }
  });

  it("knows exactly the router endpoints the protocol modules use", () => {
    const used = new Set<string>();
    // Everything that speaks HiLink: the protocol parts, the Huawei request sequences, the identification probe and the login-free read
    const hilink = readdirSync("src/protocols/hilink").map((name) => `src/protocols/hilink/${name}`);
    for (const file of [...hilink, "src/cpe-domain.ts", "src/access-control.ts", "src/sms/protocol.ts", "src/device-profile.ts", "src/scheduler.ts"]) {
      for (const match of readFileSync(file, "utf8").matchAll(/"(\/api\/[A-Za-z0-9_/-]+)"/g)) used.add(match[1] ?? "");
    }
    assert.ok(used.size >= 50, `found ${used.size}`);
    assert.deepEqual([...FENGSUI_ROUTER_ENDPOINTS].sort(), [...used].sort());
  });
});

describe("endpoint discovery: one session, structure only", () => {
  it("reads each endpoint once in FengSui's session and keeps only tag paths and value shapes", async () => {
    const cpe = family();
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl: cpe.fetchImpl, requestTimeoutMs: 2000 });
    const paths = ["/api/device/autorun-version", "/api/wlan/multi-basic-settings", "/api/pin/status", "/api/device/vendorname", "/api/net/plmn-list", "/api/net/net-mode-list"];
    const result = await discoverEndpoints(paths, (probe) => client.withSession(probe));
    assert.ok(result);
    assert.deepEqual(
      result.map((r) => [r.path, r.state, r.code, r.known]),
      [
        ["/api/device/autorun-version", "supported", null, false],
        ["/api/wlan/multi-basic-settings", "supported", null, false],
        ["/api/pin/status", "restricted", "100003", false],
        ["/api/device/vendorname", "unsupported", "100002", false],
        ["/api/net/plmn-list", "refused", null, true],
        ["/api/net/net-mode-list", "supported", null, true],
      ]
    );
    assert.equal(result[4]?.refused, "acts");
    assert.deepEqual(result[1]?.fields, [
      { tag: "Ssids.Ssid.WifiSsid", shape: "text(16)|text(17)", count: 2 },
      { tag: "Ssids.Ssid.WifiWpapsk", shape: "text(22)|text(16)", count: 2 },
    ]);
    const text = JSON.stringify(result);
    for (const value of ["9.9.9-placeholder", "Placeholder-Home", "placeholder-passphrase", "Placeholder-Guest", "other-passphrase", "800800C5"]) {
      assert.ok(!text.includes(value), value);
    }
    assert.equal(cpe.count("/api/net/plmn-list"), 0, "a refused path is never sent");
    assert.equal(cpe.stats.logins, 1, "one session for the whole call");
  });

  it("never lets an answer replace the session cookie or count in the router's error tally", async () => {
    const cpe = family({ "/api/device/odd": "<response><Odd>1</Odd></response>", "/api/device/after": "<response><After>2</After></response>" });
    const fetchImpl: typeof fetch = async (input, init) => {
      const res = await cpe.fetchImpl(input, init);
      if (!String(input).includes("/api/device/odd")) return res;
      const headers = new Headers(res.headers);
      headers.append("Set-Cookie", "SessionID=stray-placeholder; Path=/");
      return new Response(await res.text(), { status: res.status, headers });
    };
    const client = new HuaweiCpeClient({ cpeUrl: "http://192.168.8.1", cpePassword: cpe.password, fetchImpl, requestTimeoutMs: 2000 });
    const result = await discoverEndpoints(["/api/device/odd", "/api/device/after", "/api/device/missing"], (probe) => client.withSession(probe));
    assert.deepEqual(result?.map((r) => r.state), ["supported", "supported", "unsupported"]);
    assert.equal(cpe.stats.staleSessionRequests, 0);
    assert.equal(cpe.isSlotTaken(), false, "logged out with the session's own cookie: the admin slot is free");
    assert.deepEqual(client.apiErrors.snapshot().entries.filter((entry) => entry.method === "GET"), [], "an unknown endpoint's 100002 is not FengSui's own error");
  });

  it("opens no session when every path is refused, passes on a skipped session, and stops once the session is over", async () => {
    let opened = 0;
    const refused = await discoverEndpoints(["/api/net/plmn-list", "/api/webserver/token"], async () => {
      opened += 1;
      return null;
    });
    assert.equal(opened, 0);
    assert.deepEqual(refused?.map((r) => r.refused), ["acts", "session"]);
    assert.equal(await discoverEndpoints(["/api/device/odd"], async () => null), null, "yielded to a human or the breaker: nothing read");

    const answers: Record<string, string> = { "/api/device/page": "<!DOCTYPE html><html><body>WebUI</body></html>", "/api/device/json": '{"a":1}' };
    const fake = (open: boolean): DiscoverySession => ({
      open,
      peek: async (apiPath) => {
        const body = answers[apiPath];
        if (body === undefined) throw new Error("socket hang up");
        return body;
      },
    });
    const odd = await discoverEndpoints(["/api/device/page", "/api/device/json", "/api/device/gone"], (probe) => probe(fake(true)));
    assert.deepEqual(
      odd?.map((r) => [r.state, r.format]),
      [
        ["unknown", "xml"],
        ["supported", "json"],
        ["unknown", null],
      ]
    );
    await assert.rejects(discoverEndpoints(["/api/device/gone"], (probe) => probe(fake(false))), /socket hang up/);
  });
});
