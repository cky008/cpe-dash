import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ConsoleSettings } from "../src/console-settings.ts";
import { CpeControlValidationError } from "../src/control-error.ts";
import { createFengSuiCore, stopFengSuiCore } from "../src/core.ts";
import { StorageCipher } from "../src/encrypted-file.ts";
import { SettingsHttpRoutes } from "../src/http-settings.ts";
import { CERTIFICATE_CHANGED } from "../src/pinned-fetch.ts";
import type { RouterCertificate } from "../src/router-trust.ts";
import { EncryptedStateStore } from "../src/state-store.ts";
import { TimeSeriesRingBuffer } from "../src/timeseries.ts";
import { mockConnection } from "./helpers/connection.ts";
import { behindOwnCertificate } from "./helpers/https-router.ts";
import { OPENWRT_PASSWORD, openwrtRouter } from "./helpers/openwrt-router.ts";
import { removeTempDir, tempDir } from "./helpers/temp-dir.ts";

/**
 * A router whose page is HTTPS with a certificate of its own, through `/api/console/cpe` and
 * `/api/console/cpe/test`: FengSui shows its owner the certificate, sends the router nothing until
 * they trust it, and from then on talks to the router only while it presents that one. The TLS itself
 * is tested in pinned-fetch.test.ts; here a mock router stands behind a request function that
 * refuses, like the real one, whenever the certificate it "presents" is not the trusted one.
 */

const URL_HTTPS = "https://192.168.1.1";
const FIRST = "A1".repeat(32);
const SECOND = "B2".repeat(32);

function fixture(opts: { vouched?: boolean } = {}) {
  const dir = tempDir("fengsui-certificate-routes-");
  const router = openwrtRouter();
  const ubus = router.mock.handler;
  router.mock.handler = (req) => (req.method === "POST" && req.path === "/ubus" ? ubus(req) : { status: 404, text: "<html>404</html>" });
  // What the daemon's request function does: an HTTPS request goes out only to the certificate trusted for its origin
  const { trust, presented, peeks, fetchImpl, peekCertificate } = behindOwnCertificate(router.mock.fetchImpl, { fingerprint: FIRST, ...(opts.vouched ? { vouched: true } : {}) });
  const core = createFengSuiCore({
    connection: { ...mockConnection({ password: "", fetchImpl }, { cpeUrl: "http://192.168.8.1", requestTimeoutMs: 1000 }), certificateTrust: trust, peekCertificate },
    stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "certificate_key" }),
    timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
    pollIntervalMs: 600_000,
    neighborScanIntervalMs: 600_000,
  });
  const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: new StorageCipher("certificate_key"), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
  const audits: string[] = [];
  const routes = new SettingsHttpRoutes({
    settings,
    scheduler: core.scheduler,
    audit: { record: (entry: { action: string; outcome: string; detail?: string | null }) => void audits.push(`${entry.action} ${entry.outcome} ${entry.detail ?? ""}`) } as never,
    metricsFromEnv: false,
    telegramConfigured: false,
    onConnectionReady: () => undefined,
    revokeSessions: () => undefined,
    disconnectToken: () => undefined,
    unlinkTelegram: () => 0,
  });
  const call = async (pathname: string, body: Record<string, unknown> = {}) => {
    let status = 0;
    let payload: unknown = null;
    await routes.handle(
      { method: "POST", pathname, query: Object.create(null) as Record<string, string>, readJsonBody: async () => body, sendJson: (code, json) => ((status = code), (payload = json)) },
      "session-1",
      async () => ({ ok: true })
    );
    return { status, payload: payload as Record<string, unknown> };
  };
  return {
    core,
    settings,
    routes,
    router,
    trust,
    presented,
    peeks,
    audits,
    call,
    cleanup: async () => {
      await stopFengSuiCore(core);
      await settings.flush();
      removeTempDir(dir);
    },
  };
}

type Failure = { ok: false; reason: string; certificate?: RouterCertificate };

describe("console routes: an HTTPS router with a certificate of its own", () => {
  it("shows the certificate and sends the router nothing until its owner trusts it", async () => {
    const fx = fixture();
    try {
      const test = await fx.call("/api/console/cpe/test", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "auto" });
      const result = test.payload["result"] as Failure;
      assert.deepEqual([test.status, result.ok, result.reason, result.certificate?.fingerprint256, result.certificate?.subject], [200, false, "untrusted_certificate", FIRST, "CN=OpenWrt"]);
      const saved = await fx.call("/api/console/cpe", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "openwrt" });
      assert.deepEqual([saved.status, saved.payload["errorCode"], (saved.payload["connectionTest"] as Failure).reason], [400, "CPE_TEST_FAILED", "untrusted_certificate"]);
      assert.deepEqual(fx.router.mock.requests, [], "not one request reached the router");
      assert.equal(fx.settings.cpe, null);
      assert.deepEqual(fx.audits, ["settings.cpe refused test failed: untrusted_certificate"]);
      // A fingerprint that is none is refused as input, and one that is not this router's changes nothing
      await assert.rejects(fx.call("/api/console/cpe/test", { url: URL_HTTPS, password: OPENWRT_PASSWORD, certFingerprint: "abcd" }), CpeControlValidationError);
      const wrong = await fx.call("/api/console/cpe/test", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "openwrt", certFingerprint: SECOND });
      assert.equal((wrong.payload["result"] as Failure).reason, "certificate_changed");
      assert.deepEqual(fx.router.mock.requests, []);
    } finally {
      await fx.cleanup();
    }
  });

  it("tests and saves with the fingerprint its owner trusted, keeps it with the connection, and uses it from then on", async () => {
    const fx = fixture();
    try {
      // As a person pastes it from a browser: lower case, in pairs
      const typed = (FIRST.toLowerCase().match(/.{2}/g) ?? []).join(":");
      const test = await fx.call("/api/console/cpe/test", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "auto", certFingerprint: typed });
      assert.deepEqual([(test.payload["result"] as { ok: boolean }).ok, test.payload["family"]], [true, "openwrt"], "brand detection went through the trusted certificate as well");
      assert.equal(fx.trust.fingerprintFor(URL_HTTPS), null, "a test's trust ends with the test");
      const saved = await fx.call("/api/console/cpe", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "openwrt", certFingerprint: typed });
      assert.equal(saved.status, 200, JSON.stringify(saved.payload));
      assert.deepEqual(fx.settings.cpe, { url: URL_HTTPS, username: "root", password: OPENWRT_PASSWORD, family: "openwrt", certFingerprint: FIRST });
      assert.equal((fx.routes.summary().cpe as { certFingerprint?: string }).certFingerprint, FIRST);
      assert.equal(fx.trust.fingerprintFor(URL_HTTPS), FIRST, "the router in use is trusted by this certificate");
      assert.match(fx.audits.at(-1) ?? "", /settings\.cpe applied router 192\.168\.1\.1 as root \(openwrt, its certificate trusted by fingerprint\)/);
      assert.ok(await fx.core.monitor.refreshTelemetry(), "the poll reaches the router");
      // Nothing typed: the stored fingerprint counts for the stored address
      const again = await fx.call("/api/console/cpe/test", {});
      assert.equal((again.payload["result"] as { ok: boolean }).ok, true);
    } finally {
      await fx.cleanup();
    }
  });

  it("stops talking to a router that presents another certificate, until its owner trusts the new one", async () => {
    const fx = fixture();
    try {
      await fx.call("/api/console/cpe", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "openwrt", certFingerprint: FIRST });
      fx.presented.fingerprint = SECOND;
      const before = fx.router.mock.requests.length;
      assert.equal(await fx.core.monitor.refreshTelemetry().catch(() => null), null, "the poll fails");
      assert.match(fx.core.scheduler.getStatus().lastError ?? "", new RegExp(CERTIFICATE_CHANGED));
      const test = await fx.call("/api/console/cpe/test", {});
      const result = test.payload["result"] as Failure;
      assert.deepEqual([result.reason, result.certificate?.fingerprint256], ["certificate_changed", SECOND]);
      assert.equal(fx.router.mock.requests.length, before, "nothing reached the router that presents another certificate");
      const saved = await fx.call("/api/console/cpe", { certFingerprint: SECOND });
      assert.equal(saved.status, 200, JSON.stringify(saved.payload));
      assert.equal(fx.settings.cpe?.certFingerprint, SECOND);
      assert.ok(await fx.core.monitor.refreshTelemetry());
    } finally {
      await fx.cleanup();
    }
  });

  it("needs no fingerprint for a certificate this machine already vouches for, and looks at none on plain HTTP", async () => {
    const fx = fixture({ vouched: true });
    try {
      const saved = await fx.call("/api/console/cpe", { url: URL_HTTPS, password: OPENWRT_PASSWORD, family: "openwrt" });
      assert.equal(saved.status, 200, JSON.stringify(saved.payload));
      assert.deepEqual(fx.settings.cpe, { url: URL_HTTPS, username: "root", password: OPENWRT_PASSWORD, family: "openwrt" });
      assert.equal(fx.trust.fingerprintFor(URL_HTTPS), null);
      const plain = await fx.call("/api/console/cpe/test", { url: "http://192.168.1.1", password: OPENWRT_PASSWORD, family: "openwrt" });
      assert.equal((plain.payload["result"] as { ok: boolean }).ok, true);
      assert.equal(await fx.core.scheduler.routerCertificate("ftp://192.168.1.1"), null, "an address FengSui would refuse is not looked at");
      assert.deepEqual(fx.peeks.filter((url) => !url.startsWith("https:")), [], "no certificate to look at on plain HTTP");
      // A fingerprint typed for a plain HTTP address is not kept: there is no certificate it could be of
      const typed = await fx.call("/api/console/cpe", { url: "http://192.168.1.1", password: OPENWRT_PASSWORD, family: "openwrt", certFingerprint: FIRST });
      assert.equal(typed.status, 200, JSON.stringify(typed.payload));
      assert.deepEqual(fx.settings.cpe, { url: "http://192.168.1.1", username: "root", password: OPENWRT_PASSWORD, family: "openwrt" });
    } finally {
      await fx.cleanup();
    }
  });

  it("drops a stored fingerprint that is not one, and offers no look where the process cannot look", async () => {
    const dir = tempDir("fengsui-certificate-store-");
    try {
      const settings = new ConsoleSettings({ filePath: path.join(dir, "settings.json"), cipher: new StorageCipher("certificate_key"), scryptCost: { N: 2 ** 10, r: 8, p: 1 } });
      settings.setCpe({ url: URL_HTTPS, username: "root", password: "x", family: "openwrt", certFingerprint: "not a fingerprint" });
      assert.deepEqual(settings.cpe, { url: URL_HTTPS, username: "root", password: "x", family: "openwrt" });
      await settings.flush();
      const core = createFengSuiCore({
        connection: mockConnection({ password: "", fetchImpl: openwrtRouter().mock.fetchImpl }, { requestTimeoutMs: 1000 }),
        stateStore: new EncryptedStateStore({ filePath: path.join(dir, "state.json"), encryptionKey: "certificate_key" }),
        timeseries: new TimeSeriesRingBuffer({ retentionHours: 1 }),
        pollIntervalMs: 600_000,
        neighborScanIntervalMs: 600_000,
      });
      assert.equal(await core.scheduler.routerCertificate(URL_HTTPS), null);
      await stopFengSuiCore(core);
    } finally {
      removeTempDir(dir);
    }
  });
});
